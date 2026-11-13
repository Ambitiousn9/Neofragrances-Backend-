// Scent families admin page (Stage B) — the real admin page (:5500/admin/scent-families.html) +
// the real server.js (:5076, random JWT secret, LOCAL db) + headless Edge. Browser calls to
// :5000 are rerouted to :5076.
//
// WHAT IT COVERS
//   nav registration and render; the five tiles against real database counts; search, family,
//   unassigned and stock filters together; pagination; single assign / reassign / unassign with
//   Undo, the in-flight "Saving…" state and no duplicate submission; an archived-elsewhere
//   product; bulk assign through the confirmation dialog (exact ids + family on the wire),
//   cancel, the 100-product cap, a refused bulk request with no false success; an expired
//   session mid-action and a non-admin; the existing product editor keeping the family; and
//   390px / 1366px layouts.
//
// WHAT IT NEVER TOUCHES
//   any real product. Every action is scoped to 104 + 1 throwaway products whose names carry a
//   unique run token; the whole database (minus updated_at) is hashed before and after and must
//   match, and the real products are also hashed WITH updated_at.
//
// Ports: API 5076, CDP 9346 (5055-5075, 5099 and CDP 9336-9345 are taken).
const path = require("path"), fs = require("fs"), os = require("os"), crypto = require("crypto");
const { spawn } = require("child_process");
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
// T04: runs ONLY under the isolated-database guard (nf_test_* on 127.0.0.1:3308; see
// tests/README.md, "Isolated test database"). Checked before dotenv and db.js load.
const iso = require("./support/isolated-suite");
iso.requireIsolation("scent-family-admin-e2e.js");
require(path.join(process.cwd(), "node_modules/dotenv")).config({ quiet: true });
const jwt = require(path.join(process.cwd(), "node_modules/jsonwebtoken"));
const pool = require(path.join(process.cwd(), "db"));
// Safety gate — never weaken this.
if (!["localhost", "127.0.0.1"].includes(process.env.DB_HOST)) { console.error("not local"); process.exit(1); }
const FRONT = "http://127.0.0.1:5500", ADM = `${FRONT}/admin`, API = "http://127.0.0.1:5076";
const SECRET = crypto.randomBytes(32).toString("hex");
const SHOTS = path.join(os.tmpdir(), "nf-sf-admin-shots"); fs.mkdirSync(SHOTS, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = async (s, p) => (await pool.query(s, p))[0];
const js = v => JSON.stringify(v);
const results = []; const check = (n, c, x = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"} ${n}${x !== "" ? "  [" + String(x).slice(0, 190) + "]" : ""}`); };

const SNAP_TABLES = ["products", "users", "coupons", "orders", "order_items", "reviews", "offers", "offer_products", "app_settings", "wishlist", "addresses", "order_status_history"];
async function snapshot() {
  const out = {};
  for (const t of SNAP_TABLES) {
    const rows = await q(`SELECT * FROM ${t}`); rows.forEach(r => delete r.updated_at);
    rows.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    out[t] = `${rows.length}:${crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16)}`;
  }
  out.triggers = (await q("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()")).map(r => r.TRIGGER_NAME).join(",");
  return out;
}
const realHash = async exclude => crypto.createHash("sha256").update(JSON.stringify(await q(exclude && exclude.length ? "SELECT * FROM products WHERE id NOT IN (?) ORDER BY id" : "SELECT * FROM products ORDER BY id", exclude && exclude.length ? [exclude] : []))).digest("hex").slice(0, 16);

(async () => {
  await iso.verifyParentIdentity(pool, "scent-family-admin-e2e.js");
  const stamp = Date.now(), TOKEN = `SFX${stamp}`;
  const fx = { users: [], products: [] };
  const before = await snapshot();
  const realBefore = await realHash();
  let server, edge, ws;
  try {
    /* ---------- fixtures: 104 live (stock 0 / 3 / 25 in turn) + 1 archived ---------- */
    const F = [];
    for (let i = 0; i < 104; i++) {
      const stock = i % 5 === 0 ? 0 : i % 5 === 1 ? 3 : 25;
      const id = (await q("INSERT INTO products (name, brand, category, price, stock_qty, image) VALUES (?, 'NF SF Admin', 'unisex', ?, ?, 'images/perfumes/velvet-oud.jpg')", [`${TOKEN} Fixture ${String(i).padStart(3, "0")}`, 100 + i, stock])).insertId;
      F.push(id); fx.products.push(id);
    }
    const FA = (await q("INSERT INTO products (name, brand, category, price, stock_qty, deleted_at) VALUES (?, 'NF SF Admin', 'unisex', 90, 5, NOW())", [`${TOKEN} Archived`])).insertId;
    fx.products.push(FA);
    const mkUser = async (name, role) => { const id = (await q("INSERT INTO users (full_name, email, phone, password_hash, role, email_verified_at, auth_provider) VALUES (?, ?, '0244123456', 'x', ?, NOW(), 'local')", [name, `nf-sfadm-${name.toLowerCase().replace(/\s/g, "")}-${stamp}@gmail.com`, role])).insertId; fx.users.push(id); return id; };
    const ADMIN = await mkUser("Sf Admin", "admin"), CUST = await mkUser("Sf Customer", "customer");
    const tok = (id, role) => jwt.sign({ id, role }, SECRET, { expiresIn: "1h" });
    const famOf = async id => (await q("SELECT scent_family FROM products WHERE id = ?", [id]))[0]?.scent_family ?? null;
    const famsOf = async ids => (await q("SELECT scent_family FROM products WHERE id IN (?) ORDER BY id", [ids])).map(r => r.scent_family);

    /* ---------- server + browser ---------- */
    server = await iso.startGuardedServer({ suite: "scent-family-admin-e2e.js", port: 5076, env: { JWT_SECRET: SECRET, DEV_EMAIL_LOG: "true", SENDGRID_API_KEY: "", PAYSTACK_SECRET_KEY: "", GOOGLE_CLIENT_ID: "", FRONTEND_URL: FRONT, NODE_ENV: "" } });
    const profile = path.join(os.tmpdir(), "nf-edge-sf"); fs.rmSync(profile, { recursive: true, force: true });
    edge = spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", ["--headless=new", "--remote-debugging-port=9346", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
    let wsUrl; for (let i = 0; i < 150 && !wsUrl; i++) { try { wsUrl = (await (await fetch("http://127.0.0.1:9346/json/list")).json()).find(t => t.type === "page")?.webSocketDebuggerUrl; } catch (e) {} if (!wsUrl) await sleep(200); }
    ws = new WebSocket(wsUrl); await new Promise(r => ws.addEventListener("open", r, { once: true }));
    let id = 0, loads = 0; const pending = new Map(); const patches = []; const exceptions = [];
    ws.addEventListener("message", ev => {
      const m = JSON.parse(ev.data); const p = m.params || {};
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === "Fetch.requestPaused") send("Fetch.continueRequest", { requestId: p.requestId, url: p.request.url.replace("http://localhost:5000", API) });
      if (m.method === "Page.loadEventFired") loads++;
      if (m.method === "Network.requestWillBeSent" && p.request.method === "PATCH" && /\/scent-family/.test(p.request.url)) {
        let body = null; try { body = JSON.parse(p.request.postData || "null"); } catch (e) {}
        patches.push({ path: p.request.url.replace(/^.*\/api/, "/api"), body });
      }
      if (m.method === "Runtime.exceptionThrown") exceptions.push(p.exceptionDetails.exception?.description?.split("\n")[0]);
    });
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Fetch.enable", { patterns: [{ urlPattern: "http://localhost:5000/*" }] });
    const viewport = (w, h, mobile) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
    await viewport(1366, 900, false);
    const ev = async e => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description?.slice(0, 200) }; return r.result?.result?.value; };
    const go = async url => { const b = loads; await send("Page.navigate", { url }); for (let i = 0; i < 150 && loads === b; i++) await sleep(100); await sleep(700); };
    const waitFor = async (e, ms = 9000) => { for (let t = 0; t < ms; t += 150) { const v = await ev(e); if (v && !v.__err) return true; await sleep(150); } return false; };
    const shot = async name => { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(SHOTS, name + ".png"), Buffer.from(r.result.data, "base64")); };
    const setAuth = (token, user) => ev(`localStorage.setItem("neofragrances_auth", ${js(js({ token, user }))}); true`);
    const click = sel => ev(`(()=>{const e=document.querySelector(${js(sel)}); if(!e) return false; e.scrollIntoView({block:"center"}); e.click(); return true;})()`);
    const setVal = (sel, value) => ev(`(()=>{const e=document.querySelector(${js(sel)}); if(!e) return false; e.value=${js(value)}; e.dispatchEvent(new Event("input",{bubbles:true})); e.dispatchEvent(new Event("change",{bubbles:true})); return true;})()`);
    const text = sel => ev(`document.querySelector(${js(sel)})?.innerText || ""`);
    const live = () => ev(`document.getElementById("sf-live").textContent`);
    const toasts = () => ev(`[...document.querySelectorAll(".toast")].map(t=>t.innerText).join(" | ")`);
    const rowIds = () => ev(`[...document.querySelectorAll("#sf-body tr[data-row]")].map(r=>Number(r.dataset.row))`);
    const search = async term => { await setVal("#sf-search", term); await sleep(450); };
    const tiles = () => ev(`Object.fromEntries([...document.querySelectorAll("[data-family-tile]")].map(t=>[t.dataset.familyTile,{n:Number(t.querySelector(".adm-kpi-value").textContent.replace(/,/g,"")),inStock:Number(t.querySelector(".adm-kpi-meta").textContent.replace(/[^0-9]/g,""))}]))`);
    const dbTiles = async () => {
      const r = await q(`SELECT COALESCE(scent_family,'unassigned') k, COUNT(*) n, SUM(stock_qty > 0) s FROM products WHERE deleted_at IS NULL GROUP BY k`);
      const out = { floral: { n: 0, inStock: 0 }, amber: { n: 0, inStock: 0 }, fresh: { n: 0, inStock: 0 }, woody: { n: 0, inStock: 0 }, unassigned: { n: 0, inStock: 0 } };
      r.forEach(x => { out[x.k] = { n: Number(x.n), inStock: Number(x.s) }; });
      return out;
    };
    const confirmDialog = async ok => { if (!(await waitFor(`!!document.querySelector(".adm-dialog-wrap")`, 4000))) return null; const title = await text("#adm-dlg-title"), body = await text("#adm-dlg-text"); await click(`[data-dlg="${ok ? "ok" : "cancel"}"]`); return { title, body }; };
    const a11y = () => ev(`(()=>{
      const inputs=[...document.querySelectorAll("#adm-main input, #adm-main select")].filter(i=>i.type!=="hidden");
      const unlabeled=inputs.filter(i=>!(i.labels&&i.labels.length)&&!i.getAttribute("aria-label")&&!i.closest("label")).map(i=>i.id||i.className);
      const nameless=[...document.querySelectorAll("button, a[href]")].filter(b=>b.offsetParent!==null && !(b.textContent.trim()||b.getAttribute("aria-label"))).map(b=>b.outerHTML.slice(0,60));
      return {h1:document.querySelectorAll("h1").length, unlabeled, nameless, current: document.querySelector('.adm-nav a[aria-current="page"]')?.textContent.trim()||null, live: document.getElementById("sf-live")?.getAttribute("role")};
    })()`);

    /* ================= 1. render, nav, loading ================= */
    const htmlSrc = await (await fetch(`${ADM}/scent-families.html`)).text();
    check("R1. the page's initial markup is a busy loading state (aria-busy=true + skeleton)", /id="page-root" aria-busy="true"/.test(htmlSrc) && /adm-skel/.test(htmlSrc));
    await go(`${FRONT}/index.html`);
    await setAuth(tok(ADMIN, "admin"), { id: ADMIN, full_name: "Sf Admin", role: "admin" });
    await go(`${ADM}/scent-families.html`);
    check("R2. page loads: tiles rendered and aria-busy cleared", await waitFor(`document.querySelectorAll("[data-family-tile]").length === 5 && document.getElementById("page-root").getAttribute("aria-busy") === "false"`));
    // Compare link targets, not text: nav items can carry live count badges (e.g. "Inventory 91").
    const nav = await ev(`[...document.querySelectorAll('.adm-nav a')].map(a=>a.getAttribute("href"))`);
    const ax = await a11y();
    check("R3. 'Scent families' is registered in the admin nav (Catalog group, after Inventory) and is the current page",
      Array.isArray(nav) && nav.indexOf("scent-families.html") === nav.indexOf("inventory.html") + 1 && ax.current === "Scent families", js(nav));
    check("R4. accessibility basics: one h1, every control labelled, every button named, a polite status region", ax.h1 === 1 && ax.unlabeled.length === 0 && ax.nameless.length === 0 && ax.live === "status", js(ax));
    check("R5. the page explains that families are owner-managed, not automatic", /classifications you choose/i.test(await text("#page-sub")) && /nothing here identifies a fragrance automatically/i.test(await text("#page-sub")));
    check("R6. the five tiles match the database (assigned and in-stock counts per family + unassigned)", js(await tiles()) === js(await dbTiles()), js(await tiles()));
    await shot("01-desktop");

    /* ================= 2. search, filters, pagination ================= */
    await search(TOKEN);
    check("F1. search by name token → the 104 live fixtures (archived one excluded)", (await text("#sf-count")) === "104 products", await text("#sf-count"));
    check("F2. pagination: 30 per page, page 1 of 4", (await rowIds()).length === 30 && /Page 1 of 4/.test(await text("#sf-pager")), await text("#sf-pager"));
    await click('#sf-pager [data-page="2"]');
    const p2 = await rowIds();
    check("F3. next page shows fixtures 031-060 (name order)", p2.length === 30 && p2[0] === F[30] && p2[29] === F[59] && /Page 2 of 4/.test(await text("#sf-pager")));
    await setVal("#sf-stock", "out");
    check("F4. stock filter 'Out of stock' + search → 21 fixtures, page reset to 1, every row out of stock",
      (await text("#sf-count")) === "21 products" && /Page 1 of 1/.test(await text("#sf-pager")) && await ev(`[...document.querySelectorAll("#sf-body tr[data-row]")].every(r=>r.innerText.includes("Out of stock"))`), await text("#sf-count"));
    await setVal("#sf-stock", "low");
    check("F5. stock filter 'Low stock' + search → 21 fixtures with 3 units", (await text("#sf-count")) === "21 products" && await ev(`[...document.querySelectorAll("#sf-body tr[data-row]")].every(r=>r.innerText.includes("3 units"))`));
    await setVal("#sf-stock", "available");
    check("F6. stock filter 'Available (1+ units)' + search → 83 fixtures", (await text("#sf-count")) === "83 products");
    await setVal("#sf-stock", "all");
    check("F7. filters are kept in the URL", (await ev(`location.search`)).includes(`q=${TOKEN}`));

    /* ================= 3. single product ================= */
    await search(`${TOKEN} Fixture 000`);
    const A = F[0];
    check("S0. one product isolated; shown as Unassigned (neutral badge, not an error)", js(await rowIds()) === js([A]) && /Unassigned/.test(await text(`[data-family-cell="${A}"]`)) && !(await ev(`!!document.querySelector(".adm-sf-row-error")`)));
    await setVal(`[data-set="${A}"]`, "amber");
    check("S1. choosing a family reveals Save and Undo", await ev(`!document.querySelector('[data-save="${A}"]').hidden && !document.querySelector('[data-undo="${A}"]').hidden`));
    const nBefore = patches.length;
    const inflight = await ev(`(()=>{document.querySelector('[data-save="${A}"]').click(); const b=document.querySelector('[data-save="${A}"]'); const s=document.querySelector('[data-set="${A}"]'); b.click(); return {disabled:b.disabled, text:b.textContent.trim(), sel:s.disabled, busy:document.querySelector('[data-row="${A}"]').getAttribute("aria-busy")};})()`);
    check("S2. while saving: button disabled and reads 'Saving…', select disabled, row aria-busy", inflight.disabled && inflight.text === "Saving…" && inflight.sel && inflight.busy === "true", js(inflight));
    await waitFor(`/Amber/.test(document.querySelector('[data-family-cell="${A}"]')?.innerText || "")`);
    check("S3. assign → saved as amber in the database, badge shows Amber", (await famOf(A)) === "amber" && /Amber/.test(await text(`[data-family-cell="${A}"]`)));
    check("S4. a second click during the save sent no duplicate request (exactly one PATCH)", patches.length - nBefore === 1 && patches[patches.length - 1].path === `/api/admin/products/${A}/scent-family` && js(patches[patches.length - 1].body) === js({ scent_family: "amber" }), js(patches.slice(nBefore)));
    check("S5. success is announced (status region) and the tiles update to match the database", /Saved\..*Amber/.test(await live()) && js(await tiles()) === js(await dbTiles()), await live());
    await setVal(`[data-set="${A}"]`, "fresh"); await click(`[data-save="${A}"]`);
    check("S6. reassign amber → fresh", await waitFor(`/Fresh/.test(document.querySelector('[data-family-cell="${A}"]')?.innerText || "")`) && (await famOf(A)) === "fresh");
    await setVal(`[data-set="${A}"]`, ""); await click(`[data-save="${A}"]`);
    check("S7. return to Unassigned → NULL in the database, neutral Unassigned badge", await waitFor(`/Unassigned/.test(document.querySelector('[data-family-cell="${A}"]')?.innerText || "")`) && (await famOf(A)) === null && /returned to Unassigned/.test(await live()));
    const nU = patches.length;
    await setVal(`[data-set="${A}"]`, "woody"); await click(`[data-undo="${A}"]`);
    check("S8. Undo restores the saved value without sending anything", (await ev(`document.querySelector('[data-set="${A}"]').value`)) === "" && patches.length === nU && (await famOf(A)) === null);
    // archived elsewhere while the page is open
    const B = F[1];
    await search(`${TOKEN} Fixture 001`);
    await q("UPDATE products SET deleted_at = NOW() WHERE id = ?", [B]);
    await setVal(`[data-set="${B}"]`, "floral"); await click(`[data-save="${B}"]`);
    // The page announces the refusal and then reloads the list: load() sets #page-root
    // aria-busy="true" in the same task and render() clears it once the list is re-rendered.
    // Waiting for both is the completion condition (#sf-live sits outside #page-root).
    const s9Settled = await waitFor(`/archived/i.test(document.getElementById("sf-live").textContent) && document.getElementById("page-root").getAttribute("aria-busy") === "false"`);
    check("S9. product archived elsewhere → clear error (not a success), list refreshed without it, database unchanged",
      s9Settled && /Not saved.*archived/i.test(await live()) && !(await ev(`!!document.querySelector('[data-row="${B}"]')`)) && (await famOf(B)) === null && !/Saved\./.test(await live()), await live());

    /* ================= 4. bulk ================= */
    await search(TOKEN);
    const sel3 = [F[2], F[3], F[4]];
    for (const x of sel3) await click(`[data-select="${x}"]`);
    check("B1. selecting 3 shows the bulk bar with the count", (await text("#sf-selected-count")) === "3 products selected" && !(await ev(`document.getElementById("sf-bulk").hidden`)));
    await setVal("#sf-bulk-family", "woody");
    const nB = patches.length;
    await click("#sf-bulk-apply");
    const dlg = await confirmDialog(true);
    check("B2. confirmation names the count and destination family, and warns it's all-or-nothing", dlg && dlg.title === "Assign 3 products to Woody?" && /all or nothing/i.test(dlg.body), js(dlg));
    await waitFor(`/assigned to Woody/.test(document.getElementById("sf-live").textContent)`);
    const bulkReq = patches.slice(nB);
    check("B3. ONE bulk request with exactly the selected ids and the family", bulkReq.length === 1 && bulkReq[0].path === "/api/admin/products/scent-family" && js(bulkReq[0].body) === js({ product_ids: sel3, scent_family: "woody" }), js(bulkReq));
    check("B4. all three saved as woody; selection cleared; success announced; tiles match the database",
      js(await famsOf(sel3)) === js(["woody", "woody", "woody"]) && (await ev(`document.getElementById("sf-bulk").hidden`)) && /3 products assigned to Woody/.test(await live()) && js(await tiles()) === js(await dbTiles()), await live());
    await click(`[data-select="${F[5]}"]`); await setVal("#sf-bulk-family", "amber");
    const nC = patches.length;
    await click("#sf-bulk-apply"); await confirmDialog(false);
    check("B5. cancelling the confirmation sends nothing and changes nothing (selection kept)", patches.length === nC && (await famOf(F[5])) === null && (await text("#sf-selected-count")) === "1 product selected");
    await click("#sf-bulk-clear");
    check("B6. 'Clear selection' empties it and hides the bar", await ev(`document.getElementById("sf-bulk").hidden`));
    await setVal("#sf-family", "woody");
    check("B7. family filter + search together → exactly the three woody fixtures", js(await rowIds()) === js(sel3) && (await text("#sf-count")) === "3 products");
    await setVal("#sf-family", "unassigned");
    check("B8. 'Unassigned only' + search → the other 100 live fixtures", (await text("#sf-count")) === "100 products");
    await setVal("#sf-family", "all");
    // the 100 cap: select every page (103 live fixtures now — #001 was archived)
    await click("#sf-check-page");
    for (const pg of [2, 3, 4]) { await click(`#sf-pager [data-page="${pg}"]`); await click("#sf-check-page"); }
    const capState = await ev(`({count: document.getElementById("sf-selected-count").innerText, note: document.querySelector(".adm-sf-bulk-info .adm-note").innerText, disabled: document.querySelectorAll("#sf-body [data-select]:disabled").length, checked: document.querySelectorAll("#sf-body [data-select]:checked").length})`);
    check("B9. the selection stops at 100 (the 101st+ can't be ticked), with the limit explained", capState.count === "100 products selected" && /Limit reached/.test(capState.note) && capState.disabled === 3 && capState.checked === 10, js(capState));
    await setVal("#sf-bulk-family", "floral");
    const nD = patches.length;
    await click("#sf-bulk-apply");
    const dlg100 = await confirmDialog(true);
    await waitFor(`/100 products assigned to Floral/.test(document.getElementById("sf-live").textContent)`, 12000);
    const req100 = patches.slice(nD);
    const live103 = F.filter(x => x !== B);
    check("B10. 100-product bulk: one request with 100 ids (all fixtures), confirmed, saved", dlg100 && dlg100.title === "Assign 100 products to Floral?" && req100.length === 1 && req100[0].body.product_ids.length === 100 && req100[0].body.product_ids.every(x => live103.includes(x)) && (await famsOf(req100[0].body.product_ids)).every(f => f === "floral"), js(dlg100));
    // a refused bulk request must not claim success
    await search(`${TOKEN} Fixture 01`);
    const [X, Y] = [F[10], F[11]];
    await click(`[data-select="${X}"]`); await click(`[data-select="${Y}"]`);
    await setVal("#sf-bulk-family", "amber");
    await q("UPDATE products SET deleted_at = NOW() WHERE id = ?", [Y]);
    const nE = patches.length;
    await click("#sf-bulk-apply"); await confirmDialog(true);
    await waitFor(`/Nothing was changed/.test(document.getElementById("sf-live").textContent)`);
    const failLive = await live(), failToasts = await toasts();
    check("B11. refused bulk (one product archived meanwhile) → 'Nothing was changed', names the removed product, no success message",
      patches.length - nE === 1 && /Nothing was changed/.test(failLive) && failLive.includes(`#${Y}`) && !/assigned to/.test(failLive) && !/assigned to Amber/.test(failToasts), failLive);
    check("B12. nothing was written: both products keep their family", (await famOf(X)) === "floral" && (await famOf(Y)) === "floral");
    check("B13. the archived product left the selection; the other stays selected for review", (await text("#sf-selected-count")) === "1 product selected" && (await ev(`document.querySelector('[data-select="${X}"]')?.checked`)) === true);
    await click("#sf-bulk-clear");

    /* ================= 5. existing product editor keeps the family ================= */
    const E = F[12];
    const eBefore = (await q("SELECT price, stock_qty, image, scent_family FROM products WHERE id = ?", [E]))[0];
    await go(`${ADM}/products.html?edit=${E}`);
    await waitFor(`!!document.querySelector("#product-form #pf-name")`);
    await setVal("#pf-name", `${TOKEN} Fixture 012 (edited)`);
    await click("[data-drawer-save]");
    await waitFor(`!document.querySelector(".adm-drawer")`);
    const eAfter = (await q("SELECT name, price, stock_qty, image, scent_family FROM products WHERE id = ?", [E]))[0];
    check("E1. editing a product's name in the existing editor keeps its scent family (and price, stock, image)",
      eAfter.name.endsWith("(edited)") && eAfter.scent_family === "floral" && js([eAfter.price, eAfter.stock_qty, eAfter.image]) === js([eBefore.price, eBefore.stock_qty, eBefore.image]), js(eAfter));

    /* ================= 6. sessions ================= */
    await go(`${ADM}/scent-families.html?q=${encodeURIComponent(TOKEN + " Fixture 013")}`);
    await waitFor(`document.querySelectorAll("#sf-body tr[data-row]").length === 1`);
    await setVal(`[data-set="${F[13]}"]`, "woody");
    await setAuth(jwt.sign({ id: ADMIN, role: "admin" }, "not-the-secret"), { id: ADMIN, full_name: "Sf Admin", role: "admin" });
    await click(`[data-save="${F[13]}"]`);
    check("A1. session expired mid-action → sent to admin login with 'expired', nothing saved",
      await waitFor(`location.pathname.endsWith("/admin/login.html") && location.search.includes("expired=1")`) && (await famOf(F[13])) === "floral", await ev(`location.href`));
    await setAuth(tok(CUST, "customer"), { id: CUST, full_name: "Sf Customer", role: "admin" });
    await go(`${ADM}/scent-families.html`);
    check("A2. a customer (even claiming admin in the browser) is turned away", await waitFor(`location.pathname.endsWith("/admin/login.html") && location.search.includes("denied=1")`));

    /* ================= 7. layouts ================= */
    await setAuth(tok(ADMIN, "admin"), { id: ADMIN, full_name: "Sf Admin", role: "admin" });
    await viewport(390, 844, true);
    await go(`${ADM}/scent-families.html?q=${encodeURIComponent(TOKEN)}`);
    await waitFor(`document.querySelectorAll("#sf-body tr[data-row]").length > 0`);
    await click(`[data-select="${F[20]}"]`);
    const mob = await ev(`(()=>{const t=[...document.querySelectorAll("[data-family-tile]")].map(x=>x.getBoundingClientRect()); return {
      overflow: document.documentElement.scrollWidth <= innerWidth + 1,
      twoCols: Math.abs(t[0].top - t[1].top) < 2 && t[2].top > t[0].top + 10,
      cards: getComputedStyle(document.querySelector(".adm-sf-table thead")).position === "absolute",
      bulkFits: document.getElementById("sf-bulk").getBoundingClientRect().right <= innerWidth + 1,
      selectFits: [...document.querySelectorAll("#sf-body .adm-sf-assign select")].every(s => s.getBoundingClientRect().right <= innerWidth + 1),
      targets: [...document.querySelectorAll("#sf-body .adm-sf-check")].every(c => c.getBoundingClientRect().width >= 18)
    };})()`);
    await shot("02-mobile-390");
    check("L1. 390px: no horizontal scroll, tiles in two columns, rows become cards, bulk bar and selects fit", Object.values(mob).every(Boolean), js(mob));
    await viewport(1366, 900, false);
    await go(`${ADM}/scent-families.html?q=${encodeURIComponent(TOKEN)}`);
    await waitFor(`document.querySelectorAll("#sf-body tr[data-row]").length > 0`);
    check("L2. 1366px: no horizontal scroll; table layout (header row visible)", await ev(`document.documentElement.scrollWidth <= innerWidth + 1 && getComputedStyle(document.querySelector(".adm-sf-table thead")).position !== "absolute"`));
    check("L3. keyboard: the first tile, search and a row's family select are focusable and show a focus ring",
      await ev(`(()=>{const els=[document.querySelector("[data-family-tile]"), document.getElementById("sf-search"), document.querySelector("#sf-body [data-set]")]; return els.every(e=>{e.focus(); return document.activeElement===e;});})()`));
    check("L4. no uncaught JavaScript exceptions", exceptions.length === 0, exceptions.join(" | "));
    check("L5. no real product was touched (real catalogue hashed with updated_at, minus fixtures)", (await realHash(fx.products)) === realBefore);
    console.log(`screenshots: ${SHOTS}`);
  } catch (e) {
    console.error("HARNESS ERROR:", e); results.push(false);
  } finally {
    try {
      if (fx.products.length) { await q("DELETE FROM offer_products WHERE product_id IN (?)", [fx.products]); await q("DELETE FROM products WHERE id IN (?)", [fx.products]); }
      await q("DELETE FROM products WHERE name LIKE ?", [`SFX${stamp}%`]);
      if (fx.users.length) await q("DELETE FROM users WHERE id IN (?)", [fx.users]);
      const after = await snapshot();
      console.log("\nbefore:", js(before), "\nafter: ", js(after));
      check("Z1. database identical to before (every table hashed, no triggers)", js(before) === js(after));
      check("Z2. real products byte-identical to before, including updated_at", (await realHash()) === realBefore);
      const left = (await q("SELECT (SELECT COUNT(*) FROM products WHERE brand = 'NF SF Admin') p, (SELECT COUNT(*) FROM users WHERE email LIKE 'nf-sfadm-%') u"))[0];
      console.log(`cleanup: fixture products=${left.p} fixture users=${left.u}`);
      check("Z3. no fixture rows left behind", Number(left.p) === 0 && Number(left.u) === 0, js(left));
    } catch (e) { console.error("CLEANUP ERROR", e.message); results.push(false); }
    try { ws && ws.close(); } catch (e) {}
    if (edge) edge.kill();
    iso.stopServer(server);
    await pool.end();
    const failed = results.filter(x => !x).length;
    console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ""}`);
    process.exit(failed ? 1 : 0);
  }
})();
