// Stage 1 Phase 7 — verify the application against the restored catalog.
// Public API: the user's running backend (:5000), GET only. Admin views: a second instance of the
// same server.js (:5060, random JWT secret) with a temporary admin user that is deleted afterwards.
// Browser: headless Edge on the real pages (:5500), API calls rerouted to :5060. No catalog writes.
//
// Catalog baseline re-pointed 2026-10-02 to the current APPROVED local catalog. The
// original restoration baseline (168 products / 165 active / 52 out of stock / 113 in
// stock / 9 on the last page) was superseded when product #270038 was added and three
// previously out-of-stock products were given stock during local admin work. Current
// baseline: 169 total, 166 active, 3 archived, 49 out of stock, 117 in stock, stock sum
// 2613, 14 pages of 12 with 10 on the last. Expected values stay hardcoded here on
// purpose — deriving them from the database would compare it to itself and detect no
// drift. One assertion is a known standing failure: product-details.html renders
// PRODUCTS[0] for an unknown or soft-deleted id instead of a not-found state.
const path = require("path"), fs = require("fs"), os = require("os"), crypto = require("crypto");
const { spawn } = require("child_process");
// This file lives in <repo>/tests, so default to the repo root above it: the suite then
// runs as `node tests/<file>` with nothing set. An explicit SERVER_DIR still wins.
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
require(path.join(process.cwd(), "node_modules/dotenv")).config({ quiet: true });
const jwt = require(path.join(process.cwd(), "node_modules/jsonwebtoken"));
const pool = require(path.join(process.cwd(), "db"));
if (!["localhost", "127.0.0.1"].includes(process.env.DB_HOST)) { console.error("not local"); process.exit(1); }
const FRONT = "http://127.0.0.1:5500", MAIN = "http://localhost:5000", API = "http://127.0.0.1:5070";
const SECRET = crypto.randomBytes(32).toString("hex");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = async (s, p) => (await pool.query(s, p))[0];
const results = []; const check = (n, c, x = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"} ${n}${x !== "" ? "  [" + String(x).slice(0, 190) + "]" : ""}`); };
const SHOTS = path.join(__dirname, "restore-shots"); fs.mkdirSync(SHOTS, { recursive: true });
const CATALOG_SQL = "SELECT (SELECT COUNT(*) FROM products) p, (SELECT COUNT(*) FROM products WHERE deleted_at IS NULL) a, (SELECT COUNT(*) FROM offers) f, (SELECT COUNT(*) FROM offer_products) fp, (SELECT SUM(stock_qty) FROM products) s, (SELECT MAX(updated_at) FROM products) u, (SELECT COUNT(*) FROM users) users";
const MOJI = /Ã|Â|â€|ΓÇ|â‚µ|ï¿½|\uFFFD/;

(async () => {
  const before = (await q(CATALOG_SQL))[0];
  let server, edge, ws, adminId;
  try {
    /* ---------- public API on the running backend (:5000) ---------- */
    const products = await (await fetch(`${MAIN}/api/products`)).json();
    const ids = new Set(products.map(p => p.id));
    check("GET /api/products → 166 active products", products.length === 166, products.length);
    check("soft-deleted #30002, #120017, #150006 not served", ![30002, 120017, 150006].some(id => ids.has(id)));
    // Absolute catalog baseline, pinned on purpose rather than read back from the DB.
    check("DB catalog matches the approved baseline: 169 products (166 active + 3 archived), stock 2613, 2 offers, 2 offer_products",
      Number(before.p) === 169 && Number(before.a) === 166 && Number(before.p) - Number(before.a) === 3
      && Number(before.s) === 2613 && Number(before.f) === 2 && Number(before.fp) === 2,
      `p=${before.p} a=${before.a} stock=${before.s} offers=${before.f} offer_products=${before.fp}`);
    const p16 = products.find(p => p.id === 16);
    check("names exact over the API (UTF-8 intact): #16 'Mancera Cedrat Bois??', em-dash notes", p16?.name === "Mancera Cedrat Bois??" && products.filter(p => p.top_notes === "—").length === 145 && !products.some(p => MOJI.test(JSON.stringify(p))), `${p16?.name}; em-dash top notes on ${products.filter(p => p.top_notes === "—").length} active`);
    check("real NULLs arrive as JSON null (no 'NULL' strings)", products.filter(p => p.description === null).length === 164 && !JSON.stringify(products).includes('"NULL"'), `${products.filter(p => p.description === null).length} null descriptions`);
    // Restored offer rows are pinned by their STORED values, never by whether they happen
    // to be live right now. Liveness depends on the calendar, so every live/expired/
    // scheduled/disabled behaviour — and the storefront sale-price rendering that follows
    // from it — is proven deterministically in tests/offers-behaviour.js with its own
    // DB-clock-relative fixtures. Dates are formatted in SQL so no JS timezone conversion
    // can shift them.
    const EXPECTED_OFFERS = [
      { id: 1, product_id: 60004, original: 260, sale: 200, start: "2026-09-29 05:40:00", end: "2026-10-03 17:00:00" },
      { id: 30002, product_id: 49, original: 350, sale: 270, start: "2026-09-29 11:33:00", end: "2026-10-03 11:33:00" },
    ];
    const offerRows = await q(`
      SELECT o.id, o.active, op.product_id, op.original_price, op.sale_price,
             p.name AS product_name, (p.deleted_at IS NULL) AS product_active,
             DATE_FORMAT(o.start_at, '%Y-%m-%d %H:%i:%s') AS start_s,
             DATE_FORMAT(o.end_at,   '%Y-%m-%d %H:%i:%s') AS end_s
        FROM offers o
        JOIN offer_products op ON op.offer_id = o.id
        JOIN products p ON p.id = op.product_id
       ORDER BY o.id`);
    const offerPin = e => offerRows.find(r => Number(r.id) === e.id);
    check("restored offers: exact offer→product links and stored prices",
      offerRows.length === 2 && EXPECTED_OFFERS.every(e => {
        const r = offerPin(e);
        return r && Number(r.product_id) === e.product_id
          && Number(r.original_price) === e.original && Number(r.sale_price) === e.sale;
      }), JSON.stringify(offerRows.map(r => [r.id, r.product_id, r.original_price, r.sale_price])));
    check("restored offers: exact stored windows, active flags and resolvable product names",
      EXPECTED_OFFERS.every(e => {
        const r = offerPin(e);
        return r && r.start_s === e.start && r.end_s === e.end
          && Number(r.active) === 1 && !!r.product_name && Number(r.product_active) === 1;
      }), JSON.stringify(offerRows.map(r => [r.id, r.start_s, r.end_s, r.active, r.product_name])));

    /* ---------- admin API (second instance, temporary admin) ---------- */
    adminId = (await q("INSERT INTO users (full_name, email, password_hash, role, email_verified_at, auth_provider) VALUES ('Restore Check Admin', ?, NULL, 'admin', NOW(), 'local')", [`nf-restore-admin-${Date.now()}@example.invalid`])).insertId;
    const tok = jwt.sign({ id: adminId, role: "admin" }, SECRET, { expiresIn: "1h" });
    server = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: 5070, JWT_SECRET: SECRET, DEV_EMAIL_LOG: "true", PAYSTACK_SECRET_KEY: "", GOOGLE_CLIENT_ID: "", FRONTEND_URL: FRONT, NODE_ENV: "" }, stdio: "ignore" });
    for (let i = 0; i < 60; i++) { try { await fetch(API + "/"); break; } catch (e) { await sleep(200); } }
    const adm = async p => (await fetch(API + p, { headers: { Authorization: `Bearer ${tok}` } })).json();
    const ap = await adm("/api/admin/products");
    const archived = ap.filter(p => p.deleted_at);
    check("admin product list: 169 incl. the 3 archived (soft-deleted) products", ap.length === 169 && archived.map(p => p.id).sort((a, b) => a - b).join() === "30002,120017,150006", archived.map(p => `${p.id} ${p.name}`).join("; "));
    const ao = await adm("/api/admin/offers");
    check("admin offers: the 2 restored offers are listed, linked to active products with resolvable names (computed status is time-dependent — proven in offers-behaviour.js)", ao.length === 2 && ao.every(o => o.product_archived === false && !!o.product_name), JSON.stringify(ao.map(o => [o.id, o.title, o.status, o.product_name])));
    const sum = await adm("/api/admin/summary");
    check("admin summary reflects production catalog (166 active, 3 archived, 49 out of stock)", sum.products.active === 166 && sum.products.archived === 3 && sum.products.out_of_stock === 49, JSON.stringify(sum.products));

    /* ---------- browser ---------- */
    const profile = path.join(os.tmpdir(), "nf-edge-restore"); fs.rmSync(profile, { recursive: true, force: true });
    edge = spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", ["--headless=new", "--remote-debugging-port=9340", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
    let wsUrl; for (let i = 0; i < 150 && !wsUrl; i++) { try { wsUrl = (await (await fetch("http://127.0.0.1:9340/json/list")).json()).find(t => t.type === "page")?.webSocketDebuggerUrl; } catch (e) {} if (!wsUrl) await sleep(200); }
    ws = new WebSocket(wsUrl); await new Promise(r => ws.addEventListener("open", r, { once: true }));
    let id = 0, loads = 0; const pending = new Map(); const exceptions = [];
    ws.addEventListener("message", ev => {
      const m = JSON.parse(ev.data); const p = m.params || {};
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === "Fetch.requestPaused") send("Fetch.continueRequest", { requestId: p.requestId, url: p.request.url.replace("http://localhost:5000", API) });
      if (m.method === "Page.loadEventFired") loads++;
      if (m.method === "Runtime.exceptionThrown") exceptions.push(p.exceptionDetails.exception?.description?.split("\n")[0]);
    });
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Fetch.enable", { patterns: [{ urlPattern: "http://localhost:5000/*" }] });
    await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    const ev = async e => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); return r.result?.exceptionDetails ? { __err: r.result.exceptionDetails.exception?.description } : r.result?.result?.value; };
    const go = async url => { const b = loads; await send("Page.navigate", { url }); for (let i = 0; i < 150 && loads === b; i++) await sleep(100); await sleep(1500); };
    const waitFor = async (e, ms = 10000) => { for (let t = 0; t < ms; t += 150) { const v = await ev(e); if (v && !v.__err) return true; await sleep(150); } return false; };
    const shot = async name => { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(SHOTS, name + ".png"), Buffer.from(r.result.data, "base64")); };
    const brokenImgs = () => ev(`[...document.images].filter(i => i.complete && i.naturalWidth === 0 && !i.src.startsWith("data:")).map(i => i.getAttribute("src"))`);
    const pageText = () => ev(`document.body.innerText`);

    // products page
    await go(`${FRONT}/products.html`);
    await waitFor(`document.querySelectorAll(".product-card").length >= 12`);
    const countText = await ev(`document.body.innerText.match(/\\b166\\b[^\\n]{0,40}/)?.[0] || ""`);
    check("products page: grid loads, 12 per page, total 166", (await ev(`document.querySelectorAll(".product-card").length`)) === 12 && !!countText, countText);
    const pager = await ev(`[...document.querySelectorAll("[data-page], .nf-pagination a, .nf-pagination button")].map(b=>b.textContent.trim()).filter(t=>/^\\d+$/.test(t)).map(Number)`);
    check("pagination: 14 pages (166 / 12)", Array.isArray(pager) && Math.max(...pager) === 14, JSON.stringify(pager));
    let txt = await pageText();
    check("cards show GH₵ prices, badges and stock states", /GH₵\s?\d/.test(txt) && /Bestseller|New/.test(txt) && /Out of stock|Sold out|In stock/i.test(txt));
    check("no mojibake on the products page", !MOJI.test(txt));
    await sleep(1500);
    let broken = await brokenImgs();
    check("missing images fall back to the bottle placeholder (no broken <img>)", Array.isArray(broken) && broken.length === 0, JSON.stringify(broken));
    await shot("01-products");
    await go(`${FRONT}/products.html?page=14`);
    await waitFor(`document.querySelectorAll(".product-card").length > 0`);
    check("last page (14) has the remaining 10 products", (await ev(`document.querySelectorAll(".product-card").length`)) === 10, await ev(`document.querySelectorAll(".product-card").length`));
    await sleep(1500);
    broken = await brokenImgs();
    check("last page: missing-image products show placeholders, not broken images", broken.length === 0, JSON.stringify(broken));
    // search
    await go(`${FRONT}/products.html?q=mancera`);
    await waitFor(`document.querySelectorAll(".product-card").length > 0`);
    txt = await pageText();
    check("search 'mancera' → 'Mancera Cedrat Bois??' rendered exactly", txt.includes("Mancera Cedrat Bois??"));
    await go(`${FRONT}/products.html?q=onyx%20khadlaj`);
    await sleep(1200);
    check("search for a soft-deleted product ('Onyx Khadlaj') finds nothing", !(await pageText()).includes("Onyx Khadlaj") || (await ev(`document.querySelectorAll(".product-card").length`)) === 0);
    // filters
    const dbWomen = (await q("SELECT COUNT(*) n FROM products WHERE deleted_at IS NULL AND category = 'women'"))[0].n;
    const dbInStock = (await q("SELECT COUNT(*) n FROM products WHERE deleted_at IS NULL AND stock_qty > 0"))[0].n;
    await go(`${FRONT}/products.html?category=women`);
    await waitFor(`document.querySelectorAll(".product-card").length > 0`);
    check(`category filter 'women' → ${dbWomen} products (DB)`, new RegExp(`\\b${dbWomen}\\b`).test(await pageText()));
    await go(`${FRONT}/products.html?stock=in`);
    await waitFor(`document.querySelectorAll(".product-card").length > 0`);
    check(`'in stock' filter → ${dbInStock} products (166 − 49 out of stock)`, new RegExp(`\\b${dbInStock}\\b`).test(await pageText()) && Number(dbInStock) === 117);
    await go(`${FRONT}/products.html?brand=Dior`);
    await waitFor(`document.querySelectorAll(".product-card").length > 0`);
    check("brand filter 'Dior' works (production has 'Dior' and 'Christian Dior' as separate brands — not merged)", (await ev(`document.querySelectorAll(".product-card").length`)) >= 2, await ev(`[...document.querySelectorAll(".product-card")].map(c=>c.innerText.split("\\n").slice(0,2).join(" ")).join(" | ")`));
    // Storefront sale-price rendering on the product card and the product-detail page
    // depends on an offer being live at this instant, so both moved to
    // tests/offers-behaviour.js, which creates its own DB-clock-relative fixtures.
    await go(`${FRONT}/product-details.html?id=120036`);
    await waitFor(`!!document.querySelector(".pd-title")`);
    await sleep(1200);
    check("product detail with a missing image file (#120036 → placeholder.jpg) shows the fallback, not a broken image", (await brokenImgs()).length === 0 && await ev(`!!document.querySelector("#pd-content svg")`));
    // Regression (bug fixed 2026-10-02): an unknown, malformed or soft-deleted id must
    // render the not-found state and must NEVER fall back to PRODUCTS[0] — the first
    // product in the catalog, which this page used to show for any unresolved id.
    const firstName = products[0].name;
    for (const [label, qs] of [["soft-deleted #30002", "?id=30002"], ["unknown id", "?id=99999999"],
                               ["non-numeric id", "?id=abc"], ["id=0", "?id=0"],
                               ["negative id", "?id=-5"], ["missing id", ""]]) {
      await go(`${FRONT}/product-details.html${qs}`);
      // wait for the catalog itself, then for whichever state the page settles into —
      // otherwise a slow catalog fetch is indistinguishable from a missing not-found state
      await waitFor(`Array.isArray(window.PRODUCTS) && PRODUCTS.length > 0`, 20000);
      await waitFor(`!!document.querySelector("#pd-content .nf-empty") || !!document.querySelector(".pd-title")`, 20000);
      const pdTxt = await pageText();
      const pdHasTitle = await ev(`!!document.querySelector(".pd-title")`);
      check(`product-details (${label}): not-found state, no PRODUCTS[0] fallback`,
        !pdHasTitle && /not (be )?found|no longer|unavailable/i.test(pdTxt) && !pdTxt.includes(firstName),
        `pd-title=${pdHasTitle} firstProductRendered=${pdTxt.includes(firstName)}`);
    }
    // home
    await go(`${FRONT}/index.html`);
    await sleep(1500);
    txt = await pageText();
    check("homepage loads products with GH₵ prices, no mojibake", /GH₵\s?\d/.test(txt) && !MOJI.test(txt));
    // The special-offers page lists only CURRENTLY live offers, so it moved to
    // tests/offers-behaviour.js (live fixture shown, non-live fixture excluded).
    // admin (temporary admin session)
    await ev(`localStorage.setItem("neofragrances_auth", ${JSON.stringify(JSON.stringify({ token: tok, user: { id: adminId, full_name: "Restore Check Admin", role: "admin" } }))}); true`);
    await go(`${FRONT}/admin/products.html?status=archived`);
    await waitFor(`document.querySelectorAll("#p-body tr").length === 3`);
    txt = await ev(`document.getElementById("p-body").innerText`);
    check("admin Products › Archived tab lists the 3 soft-deleted products with Restore (not restored)", ["9pm", "Ish Al Shuyukh", "Onyx Khadlaj"].every(n => txt.includes(n)) && (await ev(`document.querySelectorAll('[data-action="restore"]').length`)) === 3);
    await shot("04-admin-archived");
    // Admin status badges (Live / Expired / Scheduled / Inactive) are computed from the
    // clock, so they moved to tests/offers-behaviour.js, where all four render at once.
    await go(`${FRONT}/admin/dashboard.html`);
    await waitFor(`document.querySelectorAll(".adm-kpi").length >= 8`);
    check("admin dashboard renders with restored data", (await ev(`document.querySelector(".adm-kpis").innerText`)).includes("166"));
    check("no uncaught JS exceptions", exceptions.length === 0, exceptions.join(" | "));
  } catch (e) {
    console.error("HARNESS ERROR:", e); results.push(false);
  } finally {
    try { ws && ws.close(); } catch (e) {}
    if (edge) edge.kill(); if (server) server.kill();
    if (adminId) await q("DELETE FROM users WHERE id = ?", [adminId]);
    const after = (await q(CATALOG_SQL))[0];
    check("catalog unchanged by verification + temporary admin removed", JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));
    await pool.end();
    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} application checks passed`);
    process.exit(failed ? 1 : 0);
  }
})();
