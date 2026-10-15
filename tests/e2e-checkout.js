// End-to-end checkout test: real frontend (http-server :5500) + real server.js (:5055, test env)
// + mock Paystack (:5099) + headless Edge. Browser calls to localhost:5000 are transparently
// rerouted to :5055. All fixtures are removed and stock restored afterwards.
const path = require("path"), http = require("http"), fs = require("fs"), os = require("os"), crypto = require("crypto");
const { spawn } = require("child_process");
// This file lives in <repo>/tests, so default to the repo root above it: the suite then
// runs as `node tests/<file>` with nothing set. An explicit SERVER_DIR still wins.
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
require(path.join(process.cwd(), "node_modules/dotenv")).config({ quiet: true });
const jwt = require(path.join(process.cwd(), "node_modules/jsonwebtoken"));
const pool = require(path.join(process.cwd(), "db"));
if (!["localhost", "127.0.0.1"].includes(process.env.DB_HOST) || process.env.DB_NAME !== "neofragrances") { console.error("not local db"); process.exit(1); }

// Screenshots. Defaults to a temp folder so a run never writes artefacts into the repo.
const OUT = process.env.OUT_DIR || path.join(os.tmpdir(), "nf-checkout-shots");
fs.mkdirSync(OUT, { recursive: true });
const SECRET = crypto.randomBytes(32).toString("hex");
const FRONT = "http://127.0.0.1:5500";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = async (sql, p) => (await pool.query(sql, p))[0];
const results = []; const check = (n, c, x = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"} ${n}${x ? "  [" + x + "]" : ""}`); };

/* mock Paystack: authorization_url sends the browser straight back to the callback (simulated payment) */
const txs = new Map(); let nextStatus = "success";
const mock = http.createServer((req, res) => {
  let body = ""; req.on("data", c => body += c); req.on("end", () => {
    const send = (c, o) => { res.writeHead(c, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
    if (req.method === "POST" && req.url === "/transaction/initialize") {
      const b = JSON.parse(body); txs.set(b.reference, { ...b, status: nextStatus });
      return send(200, { status: true, data: { authorization_url: `${FRONT}/payment-callback.html?trxref=${b.reference}&reference=${b.reference}`, reference: b.reference } });
    }
    const m = req.url.match(/^\/transaction\/verify\/(.+)$/);
    if (m) { const t = txs.get(decodeURIComponent(m[1])); return t ? send(200, { status: true, data: { reference: t.reference, amount: t.amount, currency: t.currency, metadata: t.metadata, status: t.status } }) : send(404, { status: false }); }
    send(404, {});
  });
});

/* Fixture stock ceiling. The over-stock assertions below deliberately ask for a
   quantity a few units ABOVE the product's stock. That quantity must still fall within
   pricing.js's MAX_QTY_PER_LINE, otherwise the server rejects it as an invalid
   QUANTITY and the stock check — the thing actually under test — never runs.
   Selecting the fixture by stock range instead of by a fixed product id keeps the
   suite immune to admin stock edits changing which product sorts first. */
const MAX_QTY_PER_LINE = 50;                                   // must match pricing.js
const OVER_STOCK_PROBE = 3;                                    // largest "stock + n" these tests ask for
const MAX_FIXTURE_STOCK = MAX_QTY_PER_LINE - OVER_STOCK_PROBE; // 47

(async () => {
  const fx = { users: [], stock: new Map(), coupons: [], offers: [] };
  let server, edge, ws;
  try {
    const inStock = await q(
      "SELECT id, name, price, stock_qty FROM products WHERE deleted_at IS NULL AND stock_qty BETWEEN 5 AND ? ORDER BY id LIMIT 2",
      [MAX_FIXTURE_STOCK]
    );
    if (inStock.length < 2) throw new Error(`fixture: need 2 active products with stock 5..${MAX_FIXTURE_STOCK}, found ${inStock.length}`);
    const [A, B] = inStock;
    [A, B].forEach(p => fx.stock.set(p.id, p.stock_qty));
    const u = (await q("INSERT INTO users (full_name, email, password_hash, role, email_verified_at) VALUES ('E2E Shopper', ?, 'x', 'customer', NOW())", [`nf-e2e-${Date.now()}@example.invalid`])).insertId; fx.users.push(u);
    const code = `E2E${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    fx.coupons.push((await q("INSERT INTO coupons (code, discount_percent) VALUES (?, 10)", [code])).insertId);
    const off = (await q("INSERT INTO offers (title, offer_type, start_at, end_at, active) VALUES ('E2E offer','discount', NOW() - INTERVAL 1 HOUR, NOW() + INTERVAL 1 DAY, 1)")).insertId; fx.offers.push(off);
    const sale = Math.round(Number(B.price) * 0.75 * 100) / 100;
    await q("INSERT INTO offer_products (offer_id, product_id, original_price, sale_price) VALUES (?,?,?,?)", [off, B.id, B.price, sale]);
    const token = jwt.sign({ id: u, role: "customer" }, SECRET);
    const auth = JSON.stringify({ token, user: { id: u, full_name: "E2E Shopper", email: "e2e@example.invalid", role: "customer" } });

    await new Promise(r => mock.listen(5099, r));
    server = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: 5055, JWT_SECRET: SECRET, PAYSTACK_SECRET_KEY: "sk_test_mock", PAYSTACK_API_BASE: "http://127.0.0.1:5099", FRONTEND_URL: FRONT, SENDGRID_API_KEY: "" }, stdio: "ignore" });
    for (let i = 0; i < 60; i++) { try { await fetch("http://127.0.0.1:5055/"); break; } catch (e) { await sleep(200); } }

    /* headless Edge over CDP */
    const profile = path.join(os.tmpdir(), "nf-edge-e2e"); fs.rmSync(profile, { recursive: true, force: true });
    edge = spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", ["--headless=new", "--remote-debugging-port=9334", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
    let wsUrl; for (let i = 0; i < 150 && !wsUrl; i++) { try { wsUrl = (await (await fetch("http://127.0.0.1:9334/json/list")).json()).find(t => t.type === "page")?.webSocketDebuggerUrl; } catch (e) {} if (!wsUrl) await sleep(200); }
    ws = new WebSocket(wsUrl); await new Promise(r => ws.addEventListener("open", r, { once: true }));
    let id = 0; const pending = new Map(); const errors = []; let loads = 0;
    ws.addEventListener("message", ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === "Fetch.requestPaused") send("Fetch.continueRequest", { requestId: m.params.requestId, url: m.params.request.url.replace("http://localhost:5000", "http://127.0.0.1:5055") });
      if (m.method === "Page.loadEventFired") loads++;
      if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description?.split("\n")[0]);
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push("console.error " + m.params.args.map(a => a.value ?? a.description).join(" "));
    });
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Fetch.enable", { patterns: [{ urlPattern: "http://localhost:5000/*" }] });
    const ev = async expr => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };
    const go = async url => { const before = loads; await send("Page.navigate", { url }); for (let i = 0; i < 150 && loads === before; i++) await sleep(100); await sleep(1800); };
    const waitFor = async (expr, ms = 8000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr)) return true; await sleep(200); } return false; };
    const viewport = (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 800 });
    const shot = async name => { const m = await send("Page.getLayoutMetrics"); const h = Math.min(Math.ceil(m.result.cssContentSize.height), 8000); const w = Math.ceil(m.result.cssLayoutViewport.clientWidth); const s = await send("Page.captureScreenshot", { format: "jpeg", quality: 72, captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } }); fs.writeFileSync(path.join(OUT, name), Buffer.from(s.result.data, "base64")); };
    const setStorage = async (cart, withAuth = true) => { await ev(`localStorage.setItem("neofragrances_cart", ${JSON.stringify(JSON.stringify(cart))}); ${withAuth ? `localStorage.setItem("neofragrances_auth", ${JSON.stringify(auth)});` : `localStorage.removeItem("neofragrances_auth");`} sessionStorage.clear(); true`); };

    await viewport(1440, 900);
    await go(`${FRONT}/index.html`);
    check("header cart badge shows count on page load", await (async () => { await setStorage([{ id: A.id, qty: 2, offerId: null }]); await go(`${FRONT}/about.html`); return (await ev(`document.querySelector(".cart-count").textContent`)) === "2"; })());

    /* 1. Logged out */
    await setStorage([{ id: A.id, qty: 1, offerId: null }], false);
    await go(`${FRONT}/cart.html`);
    await waitFor(`document.getElementById("summary-total").textContent.includes("GH₵")`);
    check("logged out: sign-in prompt in delivery step", await ev(`!!document.querySelector(".nf-signin-prompt")`));
    check("logged out: pay button asks to log in", /Log in/.test(await ev(`document.getElementById("checkout-btn-label").textContent`)));
    check("logged out: server total shown", await ev(`document.getElementById("summary-total").textContent`) === `GH₵${(Number(A.price) + 8).toFixed(2)}`, await ev(`document.getElementById("summary-total").textContent`));

    /* 2. Low stock issue */
    await setStorage([{ id: A.id, qty: A.stock_qty + 3, offerId: null }]);
    await go(`${FRONT}/cart.html`);
    check("over-stock line flagged + pay disabled", await ev(`!!document.querySelector(".nf-line-issue") && document.getElementById("checkout-btn").disabled`), await ev(`document.querySelector(".nf-line-issue")?.textContent.trim()`));
    await ev(`document.querySelector("[data-action=cap]").click(); true`); await sleep(1200);
    check("'Update to N' fixes the line", await ev(`!document.querySelector(".nf-line-issue") && JSON.parse(localStorage.getItem("neofragrances_cart"))[0].qty === ${A.stock_qty}`));

    /* 3. Happy path: regular + offer line, address form, promo, pay */
    await setStorage([{ id: A.id, qty: 1, offerId: null }, { id: B.id, qty: 2, offerId: off }]);
    await go(`${FRONT}/cart.html`);
    await waitFor(`document.getElementById("summary-total").textContent.includes("GH₵")`);
    const expSub = Math.round(Number(A.price) * 100) + Math.round(sale * 100) * 2;
    check("offer line shows sale price + Offer tag", await ev(`!!document.querySelector(".nf-line-sale") && !!document.querySelector(".nf-line-tag")`));
    check("summary subtotal = server price incl. offer", await ev(`document.getElementById("summary-subtotal").textContent`) === `GH₵${(expSub / 100).toFixed(2)}`, await ev(`document.getElementById("summary-subtotal").textContent`));
    check("offer savings row shown", await ev(`!document.getElementById("summary-offer-row").hidden`), await ev(`document.getElementById("summary-offer-savings").textContent`));
    check("no address yet: form shown, pay disabled with reason", await ev(`!!document.getElementById("address-form") && document.getElementById("checkout-btn").disabled`), await ev(`document.getElementById("pay-hint").textContent`));
    await ev(`document.getElementById("save-address-btn").click(); true`); await sleep(300);
    check("address validation: required fields flagged", await ev(`document.querySelectorAll("#address-form [aria-invalid=true]").length >= 3`));
    await ev(`(()=>{const s=(i,v)=>{document.getElementById(i).value=v}; s("addr-name","E2E Shopper"); s("addr-line1","12 Test Avenue"); s("addr-city","Accra"); s("addr-phone","0200000000"); document.getElementById("save-address-btn").click(); return true;})()`);
    await waitFor(`!!document.querySelector(".nf-address.is-selected")`);
    check("address saved + selected", await ev(`!!document.querySelector(".nf-address.is-selected")`));
    await ev(`document.getElementById("promo").open = true; document.getElementById("coupon-input").value = "nopecode"; document.getElementById("apply-coupon-btn").click(); true`);
    await waitFor(`document.getElementById("coupon-msg").textContent.length > 0`);
    check("invalid promo code shows error", /not valid/i.test(await ev(`document.getElementById("coupon-msg").textContent`)), await ev(`document.getElementById("coupon-msg").textContent`));
    await ev(`document.getElementById("coupon-input").value = "${code.toLowerCase()}"; document.getElementById("apply-coupon-btn").click(); true`);
    await waitFor(`!document.getElementById("summary-discount-row").hidden`);
    const expDisc = Math.round(expSub * 0.1), expTotal = expSub - expDisc + 800;
    check("promo applied (case-insensitive), discount from server", await ev(`document.getElementById("summary-discount").textContent`) === `−GH₵${(expDisc / 100).toFixed(2)}`, await ev(`document.getElementById("summary-discount").textContent`));
    check("pay button shows exact server total", await ev(`document.getElementById("checkout-btn-label").textContent`) === `Pay GH₵${(expTotal / 100).toFixed(2)}` && !(await ev(`document.getElementById("checkout-btn").disabled`)), await ev(`document.getElementById("checkout-btn-label").textContent`));
    check("steps bar: payment step current", await ev(`document.querySelector("#steps-bar [aria-current=step]")?.dataset.step`) === "payment");
    await shot("cart-desktop.jpg");
    await viewport(390, 844); await sleep(600);
    check("mobile: pay bar visible with total", await ev(`getComputedStyle(document.getElementById("paybar")).display !== "none" && document.getElementById("paybar-total").textContent.includes("GH₵")`));
    check("mobile: no horizontal overflow", await ev(`document.documentElement.scrollWidth <= innerWidth`));
    await shot("cart-mobile.jpg");
    await viewport(1440, 900); await sleep(300);

    const before = loads;
    await ev(`document.getElementById("checkout-btn").click(); true`);
    for (let i = 0; i < 100 && loads === before; i++) await sleep(100);
    await waitFor(`document.querySelector(".nf-result-card h1")?.textContent.includes("confirmed")`, 10000);
    const paidTx = [...txs.values()].pop();
    check("Paystack initialized with server total", paidTx && paidTx.amount === expTotal, `${paidTx?.amount} vs ${expTotal}`);
    check("callback: success state", (await ev(`document.querySelector(".nf-result-card h1")?.textContent`) || "").includes("confirmed"), await ev(`document.querySelector(".nf-result-card h1")?.textContent`));
    check("callback: total paid in GH₵", (await ev(`document.querySelector(".nf-result-facts")?.textContent`) || "").includes(`GH₵${(expTotal / 100).toFixed(2)}`));
    check("cart cleared after success", await ev(`localStorage.getItem("neofragrances_cart") === null && document.querySelector(".cart-count").textContent === "0"`));
    const ord = (await q("SELECT total, status FROM orders WHERE payment_reference=?", [paidTx.reference]))[0];
    check("DB order: total = amount charged", ord && Math.round(Number(ord.total) * 100) === expTotal && ord.status === "Processing", `${ord?.total}`);
    await shot("callback-success.jpg");
    await go(`${FRONT}/payment-callback.html?reference=${paidTx.reference}`);
    check("callback reload is idempotent (same order, still success)", (await ev(`document.querySelector(".nf-result-card")?.textContent`) || "").includes("confirmed") && (await q("SELECT COUNT(*) n FROM orders WHERE payment_reference=?", [paidTx.reference]))[0].n === 1);

    /* 4. Failed payment */
    nextStatus = "failed";
    await setStorage([{ id: A.id, qty: 1, offerId: null }]);
    await go(`${FRONT}/cart.html`);
    await waitFor(`!document.getElementById("checkout-btn").disabled`);
    const b2 = loads; await ev(`document.getElementById("checkout-btn").click(); true`);
    for (let i = 0; i < 100 && loads === b2; i++) await sleep(100);
    await waitFor(`document.querySelector(".nf-result-card h1")?.textContent.includes("wasn")`, 10000);
    check("failed payment: 'wasn't completed' + bag kept", (await ev(`document.querySelector(".nf-result-card h1")?.textContent`) || "").includes("wasn") && (await ev(`JSON.parse(localStorage.getItem("neofragrances_cart")||"[]").length`)) === 1);
    nextStatus = "success";

    /* 5. Logged out on callback → login with return path */
    await ev(`localStorage.removeItem("neofragrances_auth"); true`);
    await go(`${FRONT}/payment-callback.html?reference=NF-123-1-abcdef12`);
    const loginHref = await ev(`document.querySelector(".nf-result-actions a")?.getAttribute("href")`);
    check("logged-out callback keeps reference through login", /redirect=payment-callback\.html%3Freference%3DNF-123-1-abcdef12/.test(loginHref || ""), loginHref);
    await go(`${FRONT}/payment-callback.html`);
    check("callback without reference handled", (await ev(`document.querySelector(".nf-result-card h1")?.textContent`) || "").includes("No payment"));

    /* 6. Empty bag */
    await ev(`localStorage.removeItem("neofragrances_cart"); true`);
    await go(`${FRONT}/cart.html`);
    check("empty bag state + suggestions", await ev(`!document.getElementById("bag-empty").hidden && document.getElementById("checkout-layout").hidden`), (await ev(`document.querySelectorAll("#bag-suggest-grid .product-card").length`)) + " suggestions");

    check("no JS exceptions during the flow", errors.filter(e => !/Failed to load resource|google|GSI/i.test(e)).length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    console.error("E2E HARNESS ERROR:", e); results.push(false);
  } finally {
    try {
      if (fx.users.length) {
        const oids = (await q("SELECT id FROM orders WHERE user_id IN (?)", [fx.users])).map(o => o.id);
        if (oids.length) { await q("DELETE FROM order_items WHERE order_id IN (?)", [oids]); await q("DELETE FROM orders WHERE id IN (?)", [oids]); }
        await q("DELETE FROM addresses WHERE user_id IN (?)", [fx.users]); await q("DELETE FROM users WHERE id IN (?)", [fx.users]);
      }
      if (fx.offers.length) { await q("DELETE FROM offer_products WHERE offer_id IN (?)", [fx.offers]); await q("DELETE FROM offers WHERE id IN (?)", [fx.offers]); }
      if (fx.coupons.length) await q("DELETE FROM coupons WHERE id IN (?)", [fx.coupons]);
      for (const [pid, qty] of fx.stock) await q("UPDATE products SET stock_qty=? WHERE id=?", [qty, pid]);
      const c = (await q("SELECT (SELECT COUNT(*) FROM users) u,(SELECT COUNT(*) FROM orders) o,(SELECT COUNT(*) FROM coupons) c,(SELECT COUNT(*) FROM offers) f,(SELECT COUNT(*) FROM addresses) a,(SELECT SUM(stock_qty) FROM products) s"))[0];
      console.log("cleanup:", JSON.stringify(c));
    } catch (e) { console.error("CLEANUP ERROR", e.message); }
    try { ws && ws.close(); } catch (e) {}
    if (edge) edge.kill(); if (server) server.kill(); mock.close(); await pool.end();
    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ""}`);
    process.exit(failed ? 1 : 0);
  }
})();
