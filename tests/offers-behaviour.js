// Deterministic offer behaviour — live / expired / scheduled / disabled, the expiry
// boundary, status precedence, and storefront sale-price rendering.
//
// WHY THIS SUITE EXISTS
//   restore-app-verify.js used to assert that the two RESTORED production offers were
//   currently live. Those offers carry absolute windows copied from production
//   (offer 1 ends 2026-10-03 17:00:00, offer 30002 ends 2026-10-03 11:33:00), so once
//   the calendar passed them the application correctly expired them and 7 assertions
//   went permanently red with no code defect. This suite proves the same requirements
//   using its OWN fixtures whose windows are DB-clock relative (NOW() ± INTERVAL), so
//   the result is identical on any day, in any timezone, forever.
//
// WHAT IT NEVER TOUCHES
//   offer 30002, offer 1, any restored product, any restored offer_products row. It
//   creates 2 throwaway products, 4 throwaway offers, 4 join rows and 1 temporary admin,
//   mutates ONLY its own offers (every UPDATE is asserted to affect exactly 1 row), and
//   deletes everything again. A39-A41 prove the restored rows are untouched.
//
// THE PRODUCTION RULE UNDER TEST — unchanged by this suite:
//   an offer becomes Expired when end_at passes, per the authoritative clock. Expiry is
//   implemented three times and all three are exercised here:
//     public  /api/offers/active   SQL  NOW() >= start_at AND NOW() < end_at   (DB clock)
//     admin   computeOfferStatus()  JS  now >= end                            (Node clock)
//     storefront js/main.js:141     JS  new Date(end_at) > now                (browser clock)
//
// Ports: API 5066, CDP 9341. Node fetch rejects 5060/5061 outright, and 5055-5060,
// 5063-5065, 5070, 5099 plus CDP 9336/9337/9339/9340 are taken by other suites.
const path = require("path"), fs = require("fs"), os = require("os"), crypto = require("crypto");
const { spawn } = require("child_process");
// This file lives in <repo>/tests, so default to the repo root above it.
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
require(path.join(process.cwd(), "node_modules/dotenv")).config({ quiet: true });
const jwt = require(path.join(process.cwd(), "node_modules/jsonwebtoken"));
const pool = require(path.join(process.cwd(), "db"));
// Safety gate — never weaken this.
if (!["localhost", "127.0.0.1"].includes(process.env.DB_HOST)) { console.error("not local"); process.exit(1); }
const FRONT = "http://127.0.0.1:5500", API = "http://127.0.0.1:5066";
const SECRET = crypto.randomBytes(32).toString("hex");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = async (s, p) => (await pool.query(s, p))[0];
const results = []; const check = (n, c, x = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"} ${n}${x !== "" ? "  [" + String(x).slice(0, 190) + "]" : ""}`); };
const SHOTS = path.join(__dirname, "offers-shots"); fs.mkdirSync(SHOTS, { recursive: true });
const BASE_SQL = "SELECT (SELECT COUNT(*) FROM products) p, (SELECT COUNT(*) FROM offers) f, (SELECT COUNT(*) FROM offer_products) fp, (SELECT COUNT(*) FROM users) u, (SELECT SUM(stock_qty) FROM products) s, (SELECT MAX(updated_at) FROM products) mu";
// Offer status counts derived in SQL, mirroring computeOfferStatus()'s precedence
// (Scheduled beats Expired beats Disabled). Deliberately NOT read from the endpoint
// under test, and deliberately not computed with the Node implementation either.
const STATUS_SQL = `SELECT
    SUM(active = 1 AND NOW() >= start_at AND NOW() <  end_at) AS live,
    SUM(NOW() <  start_at)                                    AS scheduled,
    SUM(NOW() >= start_at AND NOW() >= end_at)                AS expired,
    SUM(active = 0 AND NOW() >= start_at AND NOW() <  end_at) AS disabled
  FROM offers`;
const RESTORED_SQL = `SELECT id, active,
    DATE_FORMAT(start_at,  '%Y-%m-%d %H:%i:%s') AS start_s,
    DATE_FORMAT(end_at,    '%Y-%m-%d %H:%i:%s') AS end_s,
    DATE_FORMAT(updated_at,'%Y-%m-%d %H:%i:%s') AS upd_s
  FROM offers WHERE id IN (1, 30002) ORDER BY id`;
const n = v => Number(v) || 0;

(async () => {
  const stamp = Date.now();
  const fx = { products: [], offers: [] };
  let server, edge, ws, adminId;
  const before = (await q(BASE_SQL))[0];
  const base = (await q(STATUS_SQL))[0];
  const restoredBefore = await q(RESTORED_SQL);
  console.log(`baseline: ${JSON.stringify(before)}\noffer status baseline (derived in SQL): ${JSON.stringify(base)}`);

  try {
    /* ---------- fixtures: 2 products, 4 offers, 4 offer_products ---------- */
    const PX_NAME = `NF Offer Fixture X ${stamp}`, PY_NAME = `NF Offer Fixture Y ${stamp}`;
    const mkProduct = async name => {
      const r = await q("INSERT INTO products (name, brand, category, price, stock_qty) VALUES (?, 'NF Fixture House', 'unisex', 500.00, 20)", [name]);
      fx.products.push(r.insertId); return r.insertId;
    };
    const PX = await mkProduct(PX_NAME), PY = await mkProduct(PY_NAME);
    const mkOffer = async (title, pid, startSql, endSql, active, featured) => {
      const r = await q(`INSERT INTO offers (title, offer_type, start_at, end_at, active, featured, display_order)
                         VALUES (?, 'discount', ${startSql}, ${endSql}, ?, ?, 0)`, [title, active, featured]);
      await q("INSERT INTO offer_products (offer_id, product_id, original_price, sale_price) VALUES (?, ?, 500.00, 400.00)", [r.insertId, pid]);
      fx.offers.push(r.insertId); return r.insertId;
    };
    const T_LIVE = `NF Fixture Live ${stamp}`;
    const oLive = await mkOffer(T_LIVE, PX, "NOW() - INTERVAL 1 HOUR", "NOW() + INTERVAL 2 DAY", 1, 1);
    const oExpired = await mkOffer(`NF Fixture Expired ${stamp}`, PY, "NOW() - INTERVAL 2 DAY", "NOW() - INTERVAL 1 HOUR", 1, 0);
    const oScheduled = await mkOffer(`NF Fixture Scheduled ${stamp}`, PY, "NOW() + INTERVAL 1 DAY", "NOW() + INTERVAL 2 DAY", 1, 0);
    const oDisabled = await mkOffer(`NF Fixture Disabled ${stamp}`, PY, "NOW() - INTERVAL 1 HOUR", "NOW() + INTERVAL 2 DAY", 0, 0);

    const afterFx = (await q(BASE_SQL))[0];
    const pxRow = (await q("SELECT price, stock_qty FROM products WHERE id = ?", [PX]))[0];
    const pyRow = (await q("SELECT price, stock_qty FROM products WHERE id = ?", [PY]))[0];
    check("A1. 2 temporary products created (500.00, stock 20)",
      n(afterFx.p) === n(before.p) + 2 && Number(pxRow.price) === 500 && pxRow.stock_qty === 20 && Number(pyRow.price) === 500 && pyRow.stock_qty === 20,
      `products ${before.p} -> ${afterFx.p}`);
    check("A2. 4 temporary offers created with distinct ids",
      n(afterFx.f) === n(before.f) + 4 && new Set(fx.offers).size === 4, `offers ${before.f} -> ${afterFx.f}`);
    const joins = await q("SELECT offer_id, product_id, original_price, sale_price FROM offer_products WHERE offer_id IN (?)", [fx.offers]);
    check("A3. 4 offer_products rows link the right offer→product at 500.00/400.00",
      n(afterFx.fp) === n(before.fp) + 4 && joins.length === 4
      && joins.every(j => Number(j.original_price) === 500 && Number(j.sale_price) === 400)
      && joins.find(j => j.offer_id === oLive).product_id === PX
      && joins.filter(j => j.product_id === PY).length === 3,
      JSON.stringify(joins.map(j => [j.offer_id, j.product_id])));

    /* ---------- temporary admin + test server ---------- */
    adminId = (await q("INSERT INTO users (full_name, email, password_hash, role, email_verified_at, auth_provider) VALUES ('Offers Check Admin', ?, NULL, 'admin', NOW(), 'local')", [`nf-offers-admin-${stamp}@example.invalid`])).insertId;
    const tok = jwt.sign({ id: adminId, role: "admin" }, SECRET, { expiresIn: "1h" });
    server = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: 5066, JWT_SECRET: SECRET, DEV_EMAIL_LOG: "true", PAYSTACK_SECRET_KEY: "", GOOGLE_CLIENT_ID: "", FRONTEND_URL: FRONT, NODE_ENV: "" }, stdio: "ignore" });
    for (let i = 0; i < 60; i++) { try { await fetch(API + "/"); break; } catch (e) { await sleep(200); } }
    const adm = async p => (await fetch(API + p, { headers: { Authorization: `Bearer ${tok}` } })).json();
    const activeOffers = async () => (await (await fetch(API + "/api/offers/active")).json());
    const statusOf = async id => ((await adm("/api/admin/offers")).find(o => o.id === id) || {}).status || null;

    /* ---------- A4-A8: public API, live state ---------- */
    let pub = await activeOffers();
    const live = pub.find(o => o.id === oLive);
    check("A4. /api/offers/active contains oLive", !!live, JSON.stringify(pub.map(o => o.id)));
    check("A5. oLive payload: sale 400, original 500, discount 20%, product PX",
      !!live && live.sale_price === 400 && live.original_price === 500 && live.discount_percent === 20 && live.product_id === PX,
      JSON.stringify(live && [live.sale_price, live.original_price, live.discount_percent, live.product_id]));
    check("A6. /api/offers/active excludes oExpired", !pub.some(o => o.id === oExpired));
    check("A7. /api/offers/active excludes oScheduled", !pub.some(o => o.id === oScheduled));
    check("A8. /api/offers/active excludes oDisabled", !pub.some(o => o.id === oDisabled));

    /* ---------- A9-A14: admin API statuses ---------- */
    let ao = await adm("/api/admin/offers");
    const mine = ao.filter(o => fx.offers.includes(o.id));
    check("A9. admin list contains exactly the 4 fixture offers", mine.length === 4, `${mine.length} of ${ao.length} rows`);
    check("A10. oLive status is Active", (mine.find(o => o.id === oLive) || {}).status === "Active", (mine.find(o => o.id === oLive) || {}).status);
    check("A11. oExpired status is Expired", (mine.find(o => o.id === oExpired) || {}).status === "Expired", (mine.find(o => o.id === oExpired) || {}).status);
    check("A12. oScheduled status is Scheduled", (mine.find(o => o.id === oScheduled) || {}).status === "Scheduled", (mine.find(o => o.id === oScheduled) || {}).status);
    check("A13. oDisabled status is Disabled", (mine.find(o => o.id === oDisabled) || {}).status === "Disabled", (mine.find(o => o.id === oDisabled) || {}).status);
    check("A14. all 4 fixture rows: product_name resolves, product not archived, discount 20%",
      mine.length === 4 && mine.every(o => !!o.product_name && o.product_archived === false && o.discount_percent === 20),
      JSON.stringify(mine.map(o => [o.id, o.product_name, o.product_archived, o.discount_percent])));

    /* ---------- A15-A18: summary counts, expected derived from the SQL baseline ---------- */
    let sum = await adm("/api/admin/summary");
    check("A15. summary offers.live === base.live + 1", sum.offers.live === n(base.live) + 1, `${sum.offers.live} vs ${n(base.live)}+1`);
    check("A16. summary offers.scheduled === base.scheduled + 1", sum.offers.scheduled === n(base.scheduled) + 1, `${sum.offers.scheduled} vs ${n(base.scheduled)}+1`);
    check("A17. summary offers.expired === base.expired + 1", sum.offers.expired === n(base.expired) + 1, `${sum.offers.expired} vs ${n(base.expired)}+1`);
    check("A18. summary offers.disabled === base.disabled + 1", sum.offers.disabled === n(base.disabled) + 1, `${sum.offers.disabled} vs ${n(base.disabled)}+1`);

    /* ---------- browser ---------- */
    const profile = path.join(os.tmpdir(), "nf-edge-offers"); fs.rmSync(profile, { recursive: true, force: true });
    edge = spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", ["--headless=new", "--remote-debugging-port=9341", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
    let wsUrl; for (let i = 0; i < 150 && !wsUrl; i++) { try { wsUrl = (await (await fetch("http://127.0.0.1:9341/json/list")).json()).find(t => t.type === "page")?.webSocketDebuggerUrl; } catch (e) {} if (!wsUrl) await sleep(200); }
    ws = new WebSocket(wsUrl); await new Promise(r => ws.addEventListener("open", r, { once: true }));
    let id = 0, loads = 0; const pending = new Map(); const exceptions = [];
    ws.addEventListener("message", msg => {
      const m = JSON.parse(msg.data); const p = m.params || {};
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
    const pageText = () => ev(`document.body.innerText`);
    // Reads the first product card once the page expression `ready` holds (polled, bounded by
    // timeoutMs) instead of after a fixed delay. { ready: false } means the state never appeared.
    const cardWhen = async (name, ready, timeoutMs = 10000) => {
      await go(`${FRONT}/products.html?q=${encodeURIComponent(name)}`);
      await waitFor(`document.querySelectorAll(".product-card").length > 0`);
      const ok = await waitFor(ready, timeoutMs);
      return { ready: ok, text: await ev(`document.querySelector('.product-card')?.innerText || ""`) };
    };
    const cardFor = async name => { await go(`${FRONT}/products.html?q=${encodeURIComponent(name)}`); await waitFor(`document.querySelectorAll(".product-card").length > 0`); await sleep(800); return ev(`document.querySelector('.product-card')?.innerText || ""`); };

    /* ---------- A19-A25: storefront, live state ---------- */
    await go(`${FRONT}/special-offers.html`);
    await sleep(2000);
    let txt = await pageText();
    check("A19. special-offers featured banner shows oLive's title", txt.includes(T_LIVE), txt.slice(0, 120).replace(/\n/g, " | "));
    check("A20. featured banner shows GH₵500.00, GH₵400.00 and SAVE 20%", txt.includes("GH₵500.00") && txt.includes("GH₵400.00") && /SAVE\s*20%/.test(txt));
    check("A21. special-offers page shows PX (the live offer's product)", txt.includes(PX_NAME));
    check("A22. special-offers page does NOT show PY (expired/scheduled/disabled only)", !txt.includes(PY_NAME));
    await shot("01-special-offers-live");
    // Offer prices reach the card after the catalogue's first paint, so wait for that state.
    const A23_SALE = "GH₵400.00";
    const pxCard = await cardWhen(PX_NAME, `(() => { const c = document.querySelector(".product-card"); return !!c && c.innerText.includes(${JSON.stringify(A23_SALE)}) && !!c.querySelector(".product-price-original"); })()`);
    let card = pxCard.text;
    check("A23. PX product card shows sale GH₵400.00 with Regular price GH₵500.00",
      pxCard.ready && card.includes(A23_SALE) && card.includes("GH₵500.00") && /Regular price/i.test(card),
      pxCard.ready ? card.replace(/\n/g, " | ") : `sale price ${A23_SALE} never appeared on the PX card within 10s; card read: ${card.replace(/\n/g, " | ")}`);
    await go(`${FRONT}/product-details.html?id=${PX}`);
    await waitFor(`!!document.querySelector(".pd-title")`);
    await sleep(800);
    const pdTxt = await ev(`document.getElementById("pd-content").innerText`);
    check("A24. PX detail page shows name, GH₵500.00, SAVE 20% and GH₵400.00",
      pdTxt.includes(PX_NAME) && pdTxt.includes("GH₵500.00") && /SAVE\s*20%/.test(pdTxt) && pdTxt.includes("GH₵400.00"),
      pdTxt.slice(0, 140).replace(/\n/g, " | "));
    await shot("02-detail-live");
    card = await cardFor(PY_NAME);
    check("A25. PY product card shows GH₵500.00 only — a non-live offer must not discount",
      card.includes("GH₵500.00") && !card.includes("GH₵400.00") && !/Regular price/i.test(card), card.replace(/\n/g, " | "));

    /* ---------- A26-A29: admin UI badges, one page load ---------- */
    await ev(`localStorage.setItem("neofragrances_auth", ${JSON.stringify(JSON.stringify({ token: tok, user: { id: adminId, full_name: "Offers Check Admin", role: "admin" } }))}); true`);
    await go(`${FRONT}/admin/special-offers.html`);
    await waitFor(`document.querySelectorAll("#f-body tr").length >= ${n(before.f) + 4}`);
    const badgeOf = oid => ev(`(()=>{const b=document.querySelector('[data-action="toggle"][data-id="${oid}"]'); if(!b) return null; const tr=b.closest("tr"); return tr && tr.querySelector(".adm-badge") ? tr.querySelector(".adm-badge").textContent.trim() : null;})()`);
    const badges = { live: await badgeOf(oLive), expired: await badgeOf(oExpired), scheduled: await badgeOf(oScheduled), disabled: await badgeOf(oDisabled) };
    check("A26. admin page renders oLive as 'Live'", badges.live === "Live", badges.live);
    check("A27. admin page renders oExpired as 'Expired'", badges.expired === "Expired", badges.expired);
    check("A28. admin page renders oScheduled as 'Scheduled'", badges.scheduled === "Scheduled", badges.scheduled);
    check("A29. admin page renders oDisabled as 'Inactive'", badges.disabled === "Inactive", badges.disabled);
    await shot("03-admin-four-statuses");

    /* ---------- A30-A31: boundary M1, oLive ends in 1 minute ---------- */
    const m1 = await q("UPDATE offers SET end_at = NOW() + INTERVAL 1 MINUTE WHERE id = ?", [oLive]);
    if (m1.affectedRows !== 1) throw new Error(`M1 affected ${m1.affectedRows} rows, expected exactly 1`);
    pub = await activeOffers();
    check("A30. just-before-expiry: oLive still served publicly", pub.some(o => o.id === oLive), JSON.stringify(pub.map(o => o.id)));
    check("A31. just-before-expiry: admin status still Active", (await statusOf(oLive)) === "Active", await statusOf(oLive));

    /* ---------- A32-A36: boundary M2, oLive ended 1 second ago ---------- */
    const m2 = await q("UPDATE offers SET end_at = NOW() - INTERVAL 1 SECOND WHERE id = ?", [oLive]);
    if (m2.affectedRows !== 1) throw new Error(`M2 affected ${m2.affectedRows} rows, expected exactly 1`);
    pub = await activeOffers();
    check("A32. just-after-expiry: oLive dropped from /api/offers/active (DB clock)", !pub.some(o => o.id === oLive), JSON.stringify(pub.map(o => o.id)));
    check("A33. just-after-expiry: admin status is Expired (Node clock)", (await statusOf(oLive)) === "Expired", await statusOf(oLive));
    sum = await adm("/api/admin/summary");
    check("A34. summary offers.live back to base.live", sum.offers.live === n(base.live), `${sum.offers.live} vs ${n(base.live)}`);
    await go(`${FRONT}/special-offers.html`);
    await sleep(2000);
    txt = await pageText();
    check("A35. expired offer's product no longer on the special-offers page (browser clock)", !txt.includes(PX_NAME));
    card = await cardFor(PX_NAME);
    check("A36. PX card back to GH₵500.00 with no sale price", card.includes("GH₵500.00") && !card.includes("GH₵400.00"), card.replace(/\n/g, " | "));

    /* ---------- A37-A38: precedence, expired beats disabled ---------- */
    const m3 = await q("UPDATE offers SET end_at = NOW() - INTERVAL 1 DAY WHERE id = ?", [oDisabled]);
    if (m3.affectedRows !== 1) throw new Error(`M3 affected ${m3.affectedRows} rows, expected exactly 1`);
    check("A37. an inactive AND past-end offer reports Expired, not Disabled", (await statusOf(oDisabled)) === "Expired", await statusOf(oDisabled));
    sum = await adm("/api/admin/summary");
    check("A38. summary: disabled back to base.disabled, expired is base.expired + 3",
      sum.offers.disabled === n(base.disabled) && sum.offers.expired === n(base.expired) + 3,
      `disabled ${sum.offers.disabled} vs ${n(base.disabled)}; expired ${sum.offers.expired} vs ${n(base.expired)}+3`);

    /* ---------- A39-A41: restored rows untouched ---------- */
    const restoredAfter = await q(RESTORED_SQL);
    const sameOffer = oid => {
      const b = restoredBefore.find(r => Number(r.id) === oid), a = restoredAfter.find(r => Number(r.id) === oid);
      return !!b && !!a && b.start_s === a.start_s && b.end_s === a.end_s && Number(b.active) === Number(a.active) && b.upd_s === a.upd_s;
    };
    check("A39. offer 30002 unchanged (window, active flag, updated_at)", sameOffer(30002), JSON.stringify(restoredAfter.find(r => Number(r.id) === 30002)));
    check("A40. offer 1 unchanged (window, active flag, updated_at)", sameOffer(1), JSON.stringify(restoredAfter.find(r => Number(r.id) === 1)));
    const restored = (await q("SELECT COUNT(*) c, SUM(stock_qty) s, MAX(updated_at) mu FROM products WHERE id NOT IN (?)", [fx.products]))[0];
    check("A41. restored products untouched: count, stock sum and MAX(updated_at) all unchanged",
      n(restored.c) === n(before.p) && n(restored.s) === n(before.s) && String(restored.mu) === String(before.mu),
      `count ${restored.c}/${before.p} stock ${restored.s}/${before.s}`);

    /* ---------- A42-A43 ---------- */
    check("A42. no uncaught JS exceptions in the browser", exceptions.length === 0, exceptions.join(" | "));
    check("A43. the test server did not crash", server.exitCode === null, `exitCode=${server.exitCode}`);
  } catch (err) {
    console.error("TEST HARNESS ERROR:", err);
    results.push(false);
  } finally {
    /* ---------- cleanup: strict order, each step asserting its row count ---------- */
    try {
      if (fx.offers.length) {
        const d1 = await q("DELETE FROM offer_products WHERE offer_id IN (?)", [fx.offers]);
        if (d1.affectedRows !== 4) console.error(`CLEANUP: offer_products deleted ${d1.affectedRows}, expected 4`);
        const d2 = await q("DELETE FROM offers WHERE id IN (?)", [fx.offers]);
        if (d2.affectedRows !== 4) console.error(`CLEANUP: offers deleted ${d2.affectedRows}, expected 4`);
      }
      if (fx.products.length) {
        const d3 = await q("DELETE FROM products WHERE id IN (?)", [fx.products]);
        if (d3.affectedRows !== 2) console.error(`CLEANUP: products deleted ${d3.affectedRows}, expected 2`);
      }
      if (adminId) {
        const d4 = await q("DELETE FROM users WHERE id = ?", [adminId]);
        if (d4.affectedRows !== 1) console.error(`CLEANUP: admin deleted ${d4.affectedRows}, expected 1`);
      }
      const after = (await q(BASE_SQL))[0];
      console.log("\nbaseline:", JSON.stringify(before), "\nafter:   ", JSON.stringify(after));
      check("A44. database back to the exact baseline after cleanup", JSON.stringify(before) === JSON.stringify(after), JSON.stringify(after));
    } catch (e) { console.error("CLEANUP ERROR:", e.message); results.push(false); }
    try { ws && ws.close(); } catch (e) {}
    if (edge) edge.kill(); if (server) server.kill(); await pool.end();
    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ""}`);
    process.exit(failed ? 1 : 0);
  }
})();
