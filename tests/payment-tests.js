// Local payment-integrity tests. Run from neofragrances-server:
//   node <this file>
// Starts a mock Paystack (5099) and the real server.js (5055) against the LOCAL db,
// creates temporary fixtures, runs the tests, then removes every fixture and restores stock.
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const crypto = require("crypto");
// This file lives in <repo>/tests, so default to the repo root above it: the suite then
// runs as `node tests/<file>` with nothing set. An explicit SERVER_DIR still wins.
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
require(path.join(process.cwd(), "node_modules/dotenv")).config({ quiet: true });
const jwt = require(path.join(process.cwd(), "node_modules/jsonwebtoken"));
const pool = require(path.join(process.cwd(), "db"));

if (!["localhost", "127.0.0.1"].includes(process.env.DB_HOST) || process.env.DB_NAME !== "neofragrances") {
  console.error("Refusing to run: not the local database."); process.exit(1);
}

const TEST_SECRET = crypto.randomBytes(32).toString("hex");
const MOCK_PORT = 5099, API_PORT = 5055;
const API = `http://127.0.0.1:${API_PORT}`;

/* ---------------- mock Paystack ---------------- */
const txs = new Map();
const overrides = new Map();
let lastInit = null;
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== "Bearer sk_test_mock") return send(401, { status: false, message: "bad key" });
    if (req.method === "POST" && req.url === "/transaction/initialize") {
      const b = JSON.parse(body); lastInit = b;
      txs.set(b.reference, { reference: b.reference, amount: b.amount, currency: b.currency, metadata: b.metadata, status: "success" });
      return send(200, { status: true, data: { authorization_url: `https://checkout.paystack.test/${b.reference}`, reference: b.reference } });
    }
    const m = req.url.match(/^\/transaction\/verify\/(.+)$/);
    if (req.method === "GET" && m) {
      const ref = decodeURIComponent(m[1]); const tx = txs.get(ref);
      if (!tx) return send(404, { status: false, message: "Transaction reference not found" });
      return send(200, { status: true, data: { ...tx, ...(overrides.get(ref) || {}) } });
    }
    send(404, { status: false });
  });
});

/* ---------------- helpers ---------------- */
const results = [];
const check = (name, cond, extra = "") => { results.push({ name, ok: !!cond }); console.log(`${cond ? "PASS" : "FAIL"} ${name}${extra ? "  [" + extra + "]" : ""}`); };
const call = async (method, url, { token, body } = {}) => {
  const r = await fetch(API + url, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
};
const q = async (sql, p) => (await pool.query(sql, p))[0];
const stockOf = async id => (await q("SELECT stock_qty FROM products WHERE id=?", [id]))[0].stock_qty;

/* Fixture stock ceiling. The over-stock assertions below deliberately ask for a
   quantity a few units ABOVE the product's stock. That quantity must still fall within
   pricing.js's MAX_QTY_PER_LINE, otherwise the server rejects it as an invalid
   QUANTITY and the stock check — the thing actually under test — never runs.
   Selecting the fixture by stock range instead of by a fixed product id keeps the
   suite immune to admin stock edits changing which product sorts first. */
const MAX_QTY_PER_LINE = 50;                                   // must match pricing.js
const OVER_STOCK_PROBE = 3;                                    // this suite only probes stock + 1; the
                                                               // stricter +3 bound is shared with e2e-checkout.js
                                                               // so both suites pick the same fixtures
const MAX_FIXTURE_STOCK = MAX_QTY_PER_LINE - OVER_STOCK_PROBE; // 47

(async () => {
  const fx = { users: [], addresses: [], coupons: [], offers: [], stock: new Map() };
  let server;
  try {
    /* ---------- fixtures ---------- */
    const inStock = await q(
      "SELECT id, name, price, stock_qty FROM products WHERE deleted_at IS NULL AND stock_qty BETWEEN 5 AND ? ORDER BY id LIMIT 3",
      [MAX_FIXTURE_STOCK]
    );
    if (inStock.length < 3) throw new Error(`fixture: need 3 active products with stock 5..${MAX_FIXTURE_STOCK}, found ${inStock.length}`);
    const [A, B, C] = inStock;
    const soldOut = (await q("SELECT id FROM products WHERE deleted_at IS NULL AND stock_qty = 0 LIMIT 1"))[0];
    for (const p of [A, B, C]) fx.stock.set(p.id, p.stock_qty);

    const mkUser = async email => { const r = await q("INSERT INTO users (full_name, email, password_hash, role, email_verified_at) VALUES ('Pay Test', ?, 'x', 'customer', NOW())", [email]); fx.users.push(r.insertId); return r.insertId; };
    const u1 = await mkUser(`nf-paytest-${Date.now()}@example.invalid`);
    const u2 = await mkUser(`nf-paytest2-${Date.now()}@example.invalid`);
    const mkAddr = async uid => { const r = await q("INSERT INTO addresses (user_id, full_name, address_line1, city, country) VALUES (?, 'Pay Test', '1 Test St', 'Accra', 'Ghana')", [uid]); fx.addresses.push(r.insertId); return r.insertId; };
    const addr1 = await mkAddr(u1), addr2 = await mkAddr(u2);
    const mkCoupon = async (code, pct, amt, expiresSql, limit, used) => { const r = await q(`INSERT INTO coupons (code, discount_percent, discount_amount, expires_at, usage_limit, times_used) VALUES (?, ?, ?, ${expiresSql}, ?, ?)`, [code, pct, amt, limit, used]); fx.coupons.push(r.insertId); return r.insertId; };
    const tag = crypto.randomBytes(3).toString("hex").toUpperCase();
    const cPct = await mkCoupon(`TEST10${tag}`, 10, null, "NULL", null, 0);
    const cExpired = await mkCoupon(`TESTEXP${tag}`, 10, null, "NOW() - INTERVAL 1 DAY", null, 0);
    const cUsedUp = await mkCoupon(`TESTUSED${tag}`, null, 5, "NULL", 1, 1);
    const cBig = await mkCoupon(`TESTBIG${tag}`, null, 100000, "NULL", null, 0);
    const mkOffer = async (pid, sale, startSql, endSql, active) => {
      const r = await q(`INSERT INTO offers (title, offer_type, start_at, end_at, active) VALUES ('Pay test offer', 'discount', ${startSql}, ${endSql}, ?)`, [active]);
      await q("INSERT INTO offer_products (offer_id, product_id, original_price, sale_price) VALUES (?, ?, ?, ?)", [r.insertId, pid, A.price, sale]);
      fx.offers.push(r.insertId); return r.insertId;
    };
    const saleA = Math.round(Number(A.price) * 0.8 * 100) / 100;
    const oLive = await mkOffer(A.id, saleA, "NOW() - INTERVAL 1 HOUR", "NOW() + INTERVAL 1 DAY", 1);
    const oExpired = await mkOffer(B.id, 1, "NOW() - INTERVAL 2 DAY", "NOW() - INTERVAL 1 DAY", 1);
    const oFuture = await mkOffer(B.id, 1, "NOW() + INTERVAL 1 DAY", "NOW() + INTERVAL 2 DAY", 1);
    const oDisabled = await mkOffer(B.id, 1, "NOW() - INTERVAL 1 HOUR", "NOW() + INTERVAL 1 DAY", 0);
    const t1 = jwt.sign({ id: u1, role: "customer" }, TEST_SECRET), t2 = jwt.sign({ id: u2, role: "customer" }, TEST_SECRET);
    const pes = v => Math.round(Number(v) * 100);

    /* ---------- servers ---------- */
    await new Promise(r => mock.listen(MOCK_PORT, r));
    server = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: API_PORT, JWT_SECRET: TEST_SECRET, PAYMENT_SIGNING_SECRET: "", PAYSTACK_SECRET_KEY: "sk_test_mock", PAYSTACK_API_BASE: `http://127.0.0.1:${MOCK_PORT}`, FRONTEND_URL: "http://127.0.0.1:5500", SENDGRID_API_KEY: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let serverLog = ""; server.stdout.on("data", d => serverLog += d); server.stderr.on("data", d => serverLog += d);
    for (let i = 0; i < 60; i++) { try { await fetch(API + "/"); break; } catch (e) { await new Promise(r => setTimeout(r, 200)); } }

    console.log(`fixtures: A=#${A.id} ${A.name} GH₵${A.price} (stock ${A.stock_qty}), B=#${B.id} GH₵${B.price}, sold-out=#${soldOut?.id}, live offer sale GH₵${saleA}`);

    /* ---------- quote: validation ---------- */
    let r = await call("POST", "/api/cart/quote", { body: { items: [{ productId: A.id, qty: 2 }] } });
    check("quote: regular price from DB", r.status === 200 && pes(r.data.subtotal) === pes(A.price) * 2 && r.data.shipping === 8 && pes(r.data.total) === pes(A.price) * 2 + 800, JSON.stringify(r.data && { subtotal: r.data.subtotal, shipping: r.data.shipping, total: r.data.total }));
    r = await call("POST", "/api/cart/quote", { body: { items: [{ productId: A.id, qty: 1, offerId: oLive, price: 0.01, unitPrice: 0.01 }], total: 0.01 } });
    check("quote: live offer price applied, client price ignored", r.status === 200 && r.data.lines[0].unitPrice === saleA && pes(r.data.total) === pes(saleA) + 800, `unit ${r.data?.lines?.[0]?.unitPrice}`);
    for (const [label, offerId] of [["expired", oExpired], ["not started", oFuture], ["disabled", oDisabled]]) {
      r = await call("POST", "/api/cart/quote", { body: { items: [{ productId: B.id, qty: 1, offerId }] } });
      check(`quote: ${label} offer rejected`, r.status === 409 && r.data.code === "OFFER_UNAVAILABLE", `${r.status} ${r.data?.code}`);
    }
    r = await call("POST", "/api/cart/quote", { body: { items: [{ productId: B.id, qty: 1, offerId: oLive }] } });
    check("quote: offer for a different product rejected", r.status === 409 && r.data.code === "OFFER_UNAVAILABLE");
    for (const qty of [0, -1, 1.5, "abc", true, null, 51]) {
      r = await call("POST", "/api/cart/quote", { body: { items: [{ productId: A.id, qty }] } });
      check(`quote: qty ${JSON.stringify(qty)} rejected`, r.status === 400 && r.data.code === "INVALID_QUANTITY", `${r.status}`);
    }
    r = await call("POST", "/api/cart/quote", { body: { items: [{ productId: A.id, qty: A.stock_qty + 1 }] } });
    check("quote: more than stock rejected", r.status === 409 && r.data.code === "INSUFFICIENT_STOCK" && r.data.available === A.stock_qty, r.data?.error);
    r = await call("POST", "/api/cart/quote", { body: { items: [{ productId: A.id, qty: A.stock_qty }, { productId: A.id, qty: 1, offerId: oLive }] } });
    check("quote: stock checked across lines of the same product", r.status === 409 && r.data.code === "INSUFFICIENT_STOCK");
    if (soldOut) { r = await call("POST", "/api/cart/quote", { body: { items: [{ productId: soldOut.id, qty: 1 }] } }); check("quote: sold-out product rejected", r.status === 409 && r.data.code === "INSUFFICIENT_STOCK"); }
    r = await call("POST", "/api/cart/quote", { body: { items: [{ productId: 999999999, qty: 1 }] } });
    check("quote: unknown product rejected", r.status === 409 && r.data.code === "PRODUCT_UNAVAILABLE");
    r = await call("POST", "/api/cart/quote", { body: { items: [] } }); check("quote: empty cart rejected", r.status === 400 && r.data.code === "CART_EMPTY");
    r = await call("POST", "/api/cart/quote", { body: { items: [{ productId: A.id, qty: 1 }], couponId: cPct } });
    check("quote: 10% coupon", r.status === 200 && pes(r.data.discount) === Math.round(pes(A.price) * 0.1), `discount ${r.data?.discount}`);
    r = await call("POST", "/api/cart/quote", { body: { items: [{ productId: A.id, qty: 1 }], couponId: cExpired } }); check("quote: expired coupon rejected", r.status === 400 && r.data.code === "COUPON_EXPIRED");
    r = await call("POST", "/api/cart/quote", { body: { items: [{ productId: A.id, qty: 1 }], couponId: cUsedUp } }); check("quote: used-up coupon rejected", r.status === 400 && r.data.code === "COUPON_USED_UP");
    r = await call("POST", "/api/cart/quote", { body: { items: [{ productId: A.id, qty: 1 }], couponId: cBig } });
    check("quote: fixed discount capped at subtotal (shipping still charged)", r.status === 200 && pes(r.data.discount) === pes(A.price) && r.data.total === 8, `total ${r.data?.total}`);

    /* ---------- initialize ---------- */
    r = await call("POST", "/api/payments/initialize", { body: { items: [{ productId: A.id, qty: 1 }] } });
    check("initialize: requires login", r.status === 401);
    r = await call("POST", "/api/payments/initialize", { token: t1, body: { items: [{ productId: A.id, qty: 1 }], addressId: addr2 } });
    check("initialize: another customer's address rejected", r.status === 400 && r.data.code === "INVALID_ADDRESS");
    r = await call("POST", "/api/payments/initialize", { token: t1, body: { items: [{ productId: A.id, qty: 2, offerId: oLive, price: 0.01 }, { productId: B.id, qty: 1 }], addressId: addr1, couponId: cPct, total: 1 } });
    const expectedSub = pes(saleA) * 2 + pes(B.price), expectedDisc = Math.round(expectedSub * 0.1), expectedTotal = expectedSub - expectedDisc + 800;
    check("initialize: Paystack charged the server-calculated amount (pesewas)", r.status === 200 && lastInit.amount === expectedTotal && Number.isInteger(lastInit.amount), `charged ${lastInit?.amount} expected ${expectedTotal}`);
    check("initialize: currency GHS + signed metadata", lastInit.currency === "GHS" && typeof lastInit.metadata.nf_order === "string" && /^[a-f0-9]{64}$/.test(lastInit.metadata.nf_sig));
    check("initialize: no price data trusted from client", !JSON.parse(lastInit.metadata.nf_order).lines.some(l => l.unitPrice === 1));
    const ref1 = r.data.reference;
    check("initialize: reference format", /^NF-\d+-\d+-[a-f0-9]{8}$/.test(ref1), ref1);

    /* ---------- verify ---------- */
    const stockA0 = await stockOf(A.id), stockB0 = await stockOf(B.id);
    r = await call("GET", `/api/payments/verify/${ref1}`, { token: t2 });
    check("verify: other customer cannot claim the payment", r.status === 403 && r.data.code === "PAYMENT_USER_MISMATCH");
    r = await call("GET", `/api/payments/verify/..%2F..%2Fadmin`, { token: t1 });
    check("verify: malformed reference rejected", r.status === 400 || r.status === 404);
    // Concurrent double verification → exactly one order.
    const [v1, v2] = await Promise.all([call("GET", `/api/payments/verify/${ref1}`, { token: t1 }), call("GET", `/api/payments/verify/${ref1}`, { token: t1 })]);
    const orders1 = await q("SELECT id, total, status, address_id, coupon_id FROM orders WHERE payment_reference=?", [ref1]);
    check("verify: concurrent double verify creates ONE order", orders1.length === 1 && [v1.status, v2.status].sort().join(",") === "200,201", `${v1.status}/${v2.status}, orders=${orders1.length}`);
    check("verify: stored total = amount paid (incl. shipping)", pes(orders1[0]?.total) === expectedTotal && orders1[0].status === "Processing", `total ${orders1[0]?.total}`);
    check("verify: address + coupon recorded", orders1[0]?.address_id === addr1 && orders1[0]?.coupon_id === cPct);
    const items1 = await q("SELECT product_id, quantity, price_at_purchase FROM order_items WHERE order_id=? ORDER BY product_id", [orders1[0]?.id]);
    check("verify: items priced at sale/regular price", items1.some(i => i.product_id === A.id && pes(i.price_at_purchase) === pes(saleA) && i.quantity === 2) && items1.some(i => i.product_id === B.id && pes(i.price_at_purchase) === pes(B.price)));
    check("verify: stock decremented exactly once", (await stockOf(A.id)) === stockA0 - 2 && (await stockOf(B.id)) === stockB0 - 1, `A ${stockA0}->${await stockOf(A.id)}`);
    check("verify: coupon usage incremented once", (await q("SELECT times_used FROM coupons WHERE id=?", [cPct]))[0].times_used === 1);
    r = await call("GET", `/api/payments/verify/${ref1}`, { token: t1 });
    check("verify: replay returns the same order", r.status === 200 && r.data.alreadyProcessed && r.data.orderId === orders1[0].id);

    // Tampering / mismatch cases (fresh payments).
    const freshPayment = async (items) => (await call("POST", "/api/payments/initialize", { token: t1, body: { items } })).data.reference;
    let ref = await freshPayment([{ productId: C.id, qty: 1 }]);
    overrides.set(ref, { amount: txs.get(ref).amount - 100 });
    r = await call("GET", `/api/payments/verify/${ref}`, { token: t1 });
    check("verify: underpayment (amount mismatch) rejected, no order", r.status === 400 && r.data.code === "AMOUNT_MISMATCH" && (await q("SELECT id FROM orders WHERE payment_reference=?", [ref])).length === 0);
    overrides.set(ref, { status: "failed" }); r = await call("GET", `/api/payments/verify/${ref}`, { token: t1 });
    check("verify: failed payment rejected", r.status === 400 && r.data.code === "PAYMENT_NOT_SUCCESSFUL");
    overrides.set(ref, { currency: "NGN" }); r = await call("GET", `/api/payments/verify/${ref}`, { token: t1 });
    check("verify: wrong currency rejected", r.status === 400 && r.data.code === "CURRENCY_MISMATCH");
    const meta = txs.get(ref).metadata; const forged = JSON.parse(meta.nf_order); forged.lines[0].unitPrice = 1; forged.total = 801;
    overrides.set(ref, { metadata: { nf_order: JSON.stringify(forged), nf_sig: meta.nf_sig }, amount: 801 }); r = await call("GET", `/api/payments/verify/${ref}`, { token: t1 });
    check("verify: tampered metadata (forged cheap price) rejected", r.status === 400 && r.data.code === "PAYMENT_METADATA_INVALID");
    overrides.set(ref, { metadata: { userId: u1, items: [{ productId: C.id, qty: 1 }] } }); r = await call("GET", `/api/payments/verify/${ref}`, { token: t1 });
    check("verify: old-style unsigned metadata rejected", r.status === 400 && r.data.code === "PAYMENT_METADATA_INVALID");
    overrides.delete(ref);

    // Stock sold out between initialize and verify → no negative stock, no order.
    ref = await freshPayment([{ productId: C.id, qty: 2 }]);
    const stockC = await stockOf(C.id);
    await q("UPDATE products SET stock_qty = 1 WHERE id=?", [C.id]);
    r = await call("GET", `/api/payments/verify/${ref}`, { token: t1 });
    check("verify: paid-but-out-of-stock handled, stock not negative", r.status === 409 && r.data.code === "PAID_OUT_OF_STOCK" && (await stockOf(C.id)) === 1 && (await q("SELECT id FROM orders WHERE payment_reference=?", [ref])).length === 0, r.data?.error?.slice(0, 60));
    await q("UPDATE products SET stock_qty = ? WHERE id=?", [stockC, C.id]);

    // Offer ends after initialize: customer is still charged/fulfilled at the signed price.
    ref = await freshPayment([{ productId: A.id, qty: 1, offerId: oLive }]);
    await q("UPDATE offers SET end_at = NOW() - INTERVAL 1 MINUTE WHERE id=?", [oLive]);
    r = await call("GET", `/api/payments/verify/${ref}`, { token: t1 });
    const o2 = (await q("SELECT total FROM orders WHERE payment_reference=?", [ref]))[0];
    check("verify: offer ending after payment still honours the price paid", r.status === 201 && pes(o2?.total) === pes(saleA) + 800, `total ${o2?.total}`);

    /* ---------- Paystack webhook ---------- */
    // Signed the way Paystack signs: HMAC-SHA512 over the raw body bytes, keyed on the
    // secret key this server was started with. postHook sends those exact bytes, so a
    // server that re-serialised req.body would fail every one of these.
    const HOOK = API + "/api/payments/webhook";
    const sign = raw => crypto.createHmac("sha512", "sk_test_mock").update(raw).digest("hex");
    const postHook = async (raw, { sig, omitSig = false } = {}) => {
      const headers = { "Content-Type": "application/json" };
      if (!omitSig) headers["x-paystack-signature"] = sig === undefined ? sign(raw) : sig;
      const res = await fetch(HOOK, { method: "POST", headers, body: raw });
      let data = null; try { data = await res.json(); } catch (e) {}
      return { status: res.status, data };
    };
    const chargeBody = (reference, extra = {}) =>
      JSON.stringify({ event: "charge.success", data: { reference, status: "success", ...extra } });
    const ordersFor = async reference => q("SELECT id FROM orders WHERE payment_reference=?", [reference]);

    // 1. Valid charge.success → exactly one order, one decrement.
    let wref = await freshPayment([{ productId: B.id, qty: 1 }]);
    let bStock = await stockOf(B.id);
    const wRaw = chargeBody(wref);
    let w = await postHook(wRaw);
    const wOrders = await ordersFor(wref);
    check("webhook: valid charge.success creates one order",
      w.status === 200 && w.data.received === true && wOrders.length === 1 && (await stockOf(B.id)) === bStock - 1,
      `${w.status} orders=${wOrders.length}`);

    // 2. Paystack re-delivers the identical event.
    w = await postHook(wRaw);
    check("webhook: duplicate delivery → still one order, one decrement",
      w.status === 200 && w.data.alreadyProcessed === true && (await ordersFor(wref)).length === 1 && (await stockOf(B.id)) === bStock - 1,
      `${w.status}`);

    // 3. Webhook won the race; the customer's browser arrives afterwards.
    let cb = await call("GET", `/api/payments/verify/${wref}`, { token: t1 });
    check("webhook first → callback returns alreadyProcessed",
      cb.status === 200 && cb.data.alreadyProcessed === true && cb.data.orderId === wOrders[0].id,
      `${cb.status}`);

    // 4-6. Signature failures must never reach the database.
    const bad = await freshPayment([{ productId: B.id, qty: 1 }]);
    bStock = await stockOf(B.id);
    const badRaw = chargeBody(bad);
    w = await postHook(badRaw, { sig: "a".repeat(128) });
    check("webhook: invalid signature rejected, no order",
      w.status === 401 && (await ordersFor(bad)).length === 0 && (await stockOf(B.id)) === bStock, `${w.status}`);
    w = await postHook(badRaw, { omitSig: true });
    check("webhook: missing signature rejected, no order",
      w.status === 401 && (await ordersFor(bad)).length === 0, `${w.status}`);
    w = await postHook(chargeBody(bad, { amount: 1 }), { sig: sign(badRaw) });
    check("webhook: tampered body (signature of other bytes) rejected, no order",
      w.status === 401 && (await ordersFor(bad)).length === 0 && (await stockOf(B.id)) === bStock, `${w.status}`);

    // 7. Callback won the race; the webhook arrives afterwards.
    const cref = await freshPayment([{ productId: B.id, qty: 1 }]);
    bStock = await stockOf(B.id);
    cb = await call("GET", `/api/payments/verify/${cref}`, { token: t1 });
    w = await postHook(chargeBody(cref));
    check("callback first → webhook does not duplicate",
      cb.status === 201 && w.status === 200 && w.data.alreadyProcessed === true &&
      (await ordersFor(cref)).length === 1 && (await stockOf(B.id)) === bStock - 1,
      `cb ${cb.status} / hook ${w.status}`);

    // 8. Both at once.
    const xref = await freshPayment([{ productId: B.id, qty: 1 }]);
    bStock = await stockOf(B.id);
    const [cx, wx] = await Promise.all([
      call("GET", `/api/payments/verify/${xref}`, { token: t1 }),
      postHook(chargeBody(xref)),
    ]);
    check("concurrent webhook + callback → ONE order, ONE decrement",
      (await ordersFor(xref)).length === 1 && (await stockOf(B.id)) === bStock - 1 &&
      [200, 201, 503].includes(cx.status) && [200, 503].includes(wx.status),
      `cb ${cx.status} / hook ${wx.status}`);

    // 9. Events that are not ours.
    const uref = await freshPayment([{ productId: B.id, qty: 1 }]);
    bStock = await stockOf(B.id);
    w = await postHook(JSON.stringify({ event: "transfer.success", data: { reference: uref } }));
    check("webhook: unrelated event → 200, no order",
      w.status === 200 && w.data.ignored === "transfer.success" &&
      (await ordersFor(uref)).length === 0 && (await stockOf(B.id)) === bStock, `${w.status}`);

    // 10. A reference we would never have issued.
    w = await postHook(JSON.stringify({ event: "charge.success", data: { reference: "../../etc/passwd" } }));
    check("webhook: invalid reference ignored, no order",
      w.status === 200 && w.data.ignored === "invalid_reference", `${w.status} ${w.data?.ignored}`);

    // 11. Snapshot missing entirely, then present but tampered.
    const mref = await freshPayment([{ productId: B.id, qty: 1 }]);
    bStock = await stockOf(B.id);
    overrides.set(mref, { metadata: { userId: u1 } });
    w = await postHook(chargeBody(mref));
    const unsignedBlocked = w.status === 200 && w.data.rejected === "PAYMENT_METADATA_INVALID" && (await ordersFor(mref)).length === 0;
    const mMeta = txs.get(mref).metadata;
    const mForged = JSON.parse(mMeta.nf_order); mForged.total = 1; mForged.lines[0].unitPrice = 1;
    overrides.set(mref, { metadata: { nf_order: JSON.stringify(mForged), nf_sig: mMeta.nf_sig }, amount: 1 });
    const w2 = await postHook(chargeBody(mref));
    check("webhook: missing or tampered snapshot → no order",
      unsignedBlocked && w2.status === 200 && w2.data.rejected === "PAYMENT_METADATA_INVALID" &&
      (await ordersFor(mref)).length === 0 && (await stockOf(B.id)) === bStock,
      `unsigned ${unsignedBlocked} forged ${w2.status}/${w2.data?.rejected}`);
    overrides.delete(mref);

    // 12. Paystack reports a different amount than the signed snapshot.
    const aref = await freshPayment([{ productId: B.id, qty: 1 }]);
    bStock = await stockOf(B.id);
    overrides.set(aref, { amount: txs.get(aref).amount - 100 });
    w = await postHook(chargeBody(aref));
    check("webhook: amount mismatch → no order",
      w.status === 200 && w.data.rejected === "AMOUNT_MISMATCH" &&
      (await ordersFor(aref)).length === 0 && (await stockOf(B.id)) === bStock,
      `${w.status} ${w.data?.rejected}`);
    overrides.delete(aref);

    // 13. Paid, but the stock went while the webhook was in flight.
    const sref = await freshPayment([{ productId: C.id, qty: 2 }]);
    const cStock = await stockOf(C.id);
    await q("UPDATE products SET stock_qty = 1 WHERE id=?", [C.id]);
    w = await postHook(chargeBody(sref));
    check("webhook: insufficient stock → no order, stock not negative",
      w.status === 200 && w.data.unresolved === "PAID_OUT_OF_STOCK" &&
      (await stockOf(C.id)) === 1 && (await ordersFor(sref)).length === 0,
      `${w.status} ${w.data?.unresolved}`);
    await q("UPDATE products SET stock_qty = ? WHERE id=?", [cStock, C.id]);

    // 14. The raw-body test: non-ASCII plus formatting no re-serialisation reproduces
    //     (newlines, padded colons, keys out of order). Signed over these exact bytes.
    const nref = await freshPayment([{ productId: B.id, qty: 1 }]);
    bStock = await stockOf(B.id);
    const weirdRaw = '{\n  "data" : { "customer" : { "name" : "Nana Yaa \u00d8 \u00fcn\u00efcode \u2728" },\n'
      + '     "reference"  :  ' + JSON.stringify(nref) + ' ,  "status" : "success" },\n'
      + '  "event":   "charge.success"\n}';
    w = await postHook(weirdRaw);
    check("webhook: raw-body signature holds with non-ASCII + odd JSON formatting",
      w.status === 200 && (await ordersFor(nref)).length === 1 && (await stockOf(B.id)) === bStock - 1,
      `${w.status} ${w.data?.received}`);

    /* ---------- coupons.active (migration 002) ---------- */
    const cOff = (await q("INSERT INTO coupons (code, discount_percent, active) VALUES (?, 10, 0)", [`TESTOFF${tag}`])).insertId;
    fx.coupons.push(cOff);
    r = await call("POST", "/api/cart/quote", { body: { items: [{ productId: A.id, qty: 1 }], couponId: cOff } });
    check("quote: inactive coupon rejected (COUPON_INACTIVE)", r.status === 400 && r.data.code === "COUPON_INACTIVE", `${r.status} ${r.data?.code}`);
    r = await call("POST", "/api/cart/quote", { body: { items: [{ productId: A.id, qty: 1 }], couponCode: `TESTOFF${tag}` } });
    check("quote: inactive coupon rejected by code as well as id", r.status === 400 && r.data.code === "COUPON_INACTIVE", `${r.status} ${r.data?.code}`);
    r = await call("POST", "/api/payments/initialize", { token: t1, body: { items: [{ productId: A.id, qty: 1 }], addressId: addr1, couponId: cOff } });
    check("initialize: inactive coupon rejected (COUPON_INACTIVE)", r.status === 400 && r.data.code === "COUPON_INACTIVE", `${r.status} ${r.data?.code}`);

    /* ---------- usage-limit race: one-use coupon, two different references ---------- */
    // The advisory lock is keyed per payment reference, so these two settlements are NOT
    // serialised against each other. Only the atomic conditional increment stops the
    // coupon being redeemed twice. Before that fix this block created two orders.
    const cOnce = await mkCoupon(`TESTONCE${tag}`, 10, null, "NULL", 1, 0);
    const bStock0 = await stockOf(B.id);
    const refOne = (await call("POST", "/api/payments/initialize", { token: t1, body: { items: [{ productId: B.id, qty: 1 }], addressId: addr1, couponId: cOnce } })).data.reference;
    const refTwo = (await call("POST", "/api/payments/initialize", { token: t1, body: { items: [{ productId: B.id, qty: 1 }], addressId: addr1, couponId: cOnce } })).data.reference;
    check("one-use coupon: both initializations succeed (the quote-time check is a read)", !!refOne && !!refTwo && refOne !== refTwo, `${refOne} / ${refTwo}`);
    const [vOne, vTwo] = await Promise.all([
      call("GET", `/api/payments/verify/${refOne}`, { token: t1 }),
      call("GET", `/api/payments/verify/${refTwo}`, { token: t1 }),
    ]);
    const raceOrders = await q("SELECT payment_reference FROM orders WHERE payment_reference IN (?, ?)", [refOne, refTwo]);
    const raceUsed = Number((await q("SELECT times_used FROM coupons WHERE id=?", [cOnce]))[0].times_used);
    check("one-use coupon: exactly ONE order across the two references", raceOrders.length === 1, `${raceOrders.length} orders, ${vOne.status}/${vTwo.status}`);
    check("one-use coupon: times_used = 1, never 2", raceUsed === 1, `times_used=${raceUsed}`);
    check("one-use coupon: the losing settlement returned 409 COUPON_USED_UP", [vOne, vTwo].some(x => x.status === 409 && x.data?.code === "COUPON_USED_UP"), `${vOne.status}:${vOne.data?.code} / ${vTwo.status}:${vTwo.data?.code}`);
    check("one-use coupon: stock decremented once (losing transaction rolled back)", (await stockOf(B.id)) === bStock0 - 1, `${bStock0} -> ${await stockOf(B.id)}`);

    r = await call("POST", "/api/checkout", { token: t1, body: { items: [{ productId: A.id, qty: 1 }] } });
    check("legacy /api/checkout disabled (410)", r.status === 410);
    check("server did not crash", server.exitCode === null);
    if (serverLog.includes("TypeError") || serverLog.includes("ReferenceError")) console.log("server log errors:\n" + serverLog.split("\n").filter(l => /Error/.test(l)).slice(0, 5).join("\n"));
  } catch (err) {
    console.error("TEST HARNESS ERROR:", err);
    results.push({ name: "harness", ok: false });
  } finally {
    /* ---------- cleanup: remove every fixture, restore stock ---------- */
    try {
      if (fx.users.length) {
        const orderIds = (await q("SELECT id FROM orders WHERE user_id IN (?)", [fx.users])).map(o => o.id);
        if (orderIds.length) { await q("DELETE FROM order_items WHERE order_id IN (?)", [orderIds]); await q("DELETE FROM orders WHERE id IN (?)", [orderIds]); }
        await q("DELETE FROM addresses WHERE user_id IN (?)", [fx.users]);
        await q("DELETE FROM users WHERE id IN (?)", [fx.users]);
      }
      if (fx.offers.length) { await q("DELETE FROM offer_products WHERE offer_id IN (?)", [fx.offers]); await q("DELETE FROM offers WHERE id IN (?)", [fx.offers]); }
      if (fx.coupons.length) await q("DELETE FROM coupons WHERE id IN (?)", [fx.coupons]);
      for (const [id, qty] of fx.stock) await q("UPDATE products SET stock_qty=? WHERE id=?", [qty, id]);
      const left = (await q("SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM orders) o, (SELECT COUNT(*) FROM coupons) c, (SELECT COUNT(*) FROM offers) f, (SELECT COUNT(*) FROM addresses) a"))[0];
      const stockOk = (await Promise.all([...fx.stock].map(async ([id, qty]) => (await stockOf(id)) === qty))).every(Boolean);
      console.log(`cleanup: users=${left.u} orders=${left.o} coupons=${left.c} offers=${left.f} addresses=${left.a} | stock restored: ${stockOk}`);
    } catch (e) { console.error("CLEANUP ERROR:", e.message); }
    if (server) server.kill();
    mock.close();
    await pool.end();
    const failed = results.filter(r => !r.ok).length;
    console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ""}`);
    process.exit(failed ? 1 : 0);
  }
})();
