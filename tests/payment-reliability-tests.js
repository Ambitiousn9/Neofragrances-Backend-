// Payment reliability (Stage A: PI-01 transient verification + webhook retries,
// PI-02 customer-facing payment states, PI-07 Paystack timeouts).
//
// DATABASE-FREE AND NETWORK-ISOLATED BY CONSTRUCTION.
//   * ./db is replaced in the require cache by an in-memory fake BEFORE server.js
//     loads. The fake implements only the statements the payment routes use, against
//     a small in-memory store (two throwaway products, an orders list). Its
//     transactions snapshot and restore that store, so rollback is real. Any other
//     statement is refused, recorded and fails the run. DB_PORT is forced to 1 so a
//     bypassed stub could not reach MariaDB either.
//   * Paystack is a mock HTTP server on 127.0.0.1:5082. The server's global fetch is
//     wrapped: requests to the mock pass through, every other URL is refused and
//     recorded. The Paystack key is a fake string; no real key is read or needed
//     (dotenv never overrides variables that are already set).
//   * MX lookups are refused; SendGrid/Google keys are blank; email goes to the
//     DEV_EMAIL_LOG console path.
//   * The customer-facing script (neofragrances-frontend/js/payment-result.js) is run
//     in a Node vm sandbox with a minimal DOM stub, a fake fetch and fake timers — no
//     browser, no network.
//
// The timeout cases genuinely wait for the 10 s / 15 s Paystack timeouts, run in
// parallel, so the suite takes roughly 20 seconds.
//
// Run: node tests/payment-reliability-tests.js
const path = require("path");
const fs = require("fs");
const vm = require("vm");
const http = require("http");
const crypto = require("crypto");
const Module = require("module");
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
const SERVER = process.cwd();
const FRONT_SCRIPT = path.join(SERVER, "..", "neofragrances-frontend", "js", "payment-result.js");

const PORT = 5081, MOCK_PORT = 5082;
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const FAKE_PAYSTACK_KEY = "sk_test_reliability_mock_not_a_real_key";

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail === undefined ? "" : `  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`}`); }
}

// ---------- environment: set BEFORE server.js loads ----------
const JWT_SECRET = crypto.randomBytes(32).toString("hex");
const LAN_ORIGIN = "http://172.20.10.3:5500";
const PROD_ORIGIN = "https://nf-production-standin.netlify.app";
Object.assign(process.env, {
  PORT: String(PORT),
  DB_HOST: "127.0.0.1", DB_PORT: "1", DB_NAME: "nf-payment-reliability-no-db",
  JWT_SECRET, PAYMENT_SIGNING_SECRET: crypto.randomBytes(32).toString("hex"),
  PAYSTACK_SECRET_KEY: FAKE_PAYSTACK_KEY, PAYSTACK_API_BASE: MOCK_BASE,
  SENDGRID_API_KEY: "", SENDGRID_FROM_EMAIL: "", GOOGLE_CLIENT_ID: "",
  DEV_EMAIL_LOG: "true", NODE_ENV: "", FRONTEND_URL: "http://127.0.0.1:5500",
  // QA-001: the iPhone LAN origin and a stand-in for the production Netlify origin (the real value
  // lives only in Render), so the callback-URL checks CB1-CB8 can tell allowed from unapproved origins.
  CORS_ORIGINS: `${LAN_ORIGIN},${PROD_ORIGIN}`,
});

// ---------- in-memory fake database ----------
const USER_A = 990201, USER_B = 990202;
const P1 = 990301, P2 = 990302;
const ADDR_A = 990401, ADDR_B = 990402;   // delivery addresses of USER_A and USER_B
const addresses = { [ADDR_A]: USER_A, [ADDR_B]: USER_B };
let store = {
  products: { [P1]: { id: P1, name: "Reliability Test Scent", price: "100.00", stock_qty: 50, deleted_at: null },
              [P2]: { id: P2, name: "Reliability Sold Out", price: "100.00", stock_qty: 0, deleted_at: null } },
  orders: [], orderItems: [], nextOrderId: 7000001,
};
const clone = o => JSON.parse(JSON.stringify(o));
const fake = { lockGot: 1, failOrderInsert: false, getLocks: 0, releaseLocks: 0, unexpected: [], connections: 0 };

async function fakeQuery(sql, params = [], tx) {
  const s = String(sql).replace(/\s+/g, " ").trim();
  if (/FROM app_settings WHERE setting_key IN/.test(s)) return [[], []];
  if (s === "SELECT disabled_at, token_version FROM users WHERE id = ?") return [[{ disabled_at: null, token_version: 0 }], []];
  if (s === "SELECT email FROM users WHERE id = ?") return [[{ email: `rel-${params[0]}@example.invalid` }], []];
  if (s === "SELECT id FROM addresses WHERE id = ? AND user_id = ?") {
    const id = Number(params[0]);
    return [addresses[id] === Number(params[1]) ? [{ id }] : [], []];
  }
  if (s === "SELECT full_name, email FROM users WHERE id = ?") return [[{ full_name: "Reliability Test", email: `rel-${params[0]}@example.invalid` }], []];
  if (s === "SELECT id, name, price, stock_qty FROM products WHERE id IN (?) AND deleted_at IS NULL") {
    const ids = [].concat(params[0]).map(Number);
    return [ids.map(id => store.products[id]).filter(p => p && !p.deleted_at).map(p => ({ ...p })), []];
  }
  // getLocks counts locks actually ACQUIRED (got = 1); a refused lock needs no release.
  if (s === "SELECT GET_LOCK(?, 10) AS got") { if (fake.lockGot === 1) fake.getLocks++; return [[{ got: fake.lockGot }], []]; }
  if (s === "SELECT RELEASE_LOCK(?)") { fake.releaseLocks++; return [[{ r: 1 }], []]; }
  if (s === "SELECT id, total FROM orders WHERE payment_reference = ?") {
    return [store.orders.filter(o => o.payment_reference === params[0]).map(o => ({ id: o.id, total: o.total })), []];
  }
  if (s === "UPDATE products SET stock_qty = stock_qty - ? WHERE id = ? AND deleted_at IS NULL AND stock_qty >= ?") {
    if (!tx || !tx.open) throw new Error("fake db: stock update outside a transaction");
    const p = store.products[Number(params[1])];
    if (p && !p.deleted_at && p.stock_qty >= Number(params[2])) { p.stock_qty -= Number(params[0]); return [{ affectedRows: 1 }, []]; }
    return [{ affectedRows: 0 }, []];
  }
  if (s === "INSERT INTO orders (user_id, address_id, coupon_id, total, status, payment_reference) VALUES (?, ?, ?, ?, 'Processing', ?)") {
    if (!tx || !tx.open) throw new Error("fake db: order insert outside a transaction");
    if (fake.failOrderInsert) throw Object.assign(new Error("Deadlock found when trying to get lock (simulated)"), { code: "ER_LOCK_DEADLOCK", errno: 1213 });
    if (store.orders.some(o => o.payment_reference === params[4])) {
      throw Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY", errno: 1062, sqlMessage: `Duplicate entry '${params[4]}' for key 'uq_orders_payment_reference'` });
    }
    const id = store.nextOrderId++;
    store.orders.push({ id, user_id: params[0], address_id: params[1], coupon_id: params[2], total: params[3], status: "Processing", payment_reference: params[4] });
    return [{ insertId: id, affectedRows: 1 }, []];
  }
  if (s === "INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES (?, ?, ?, ?)") {
    if (!tx || !tx.open) throw new Error("fake db: item insert outside a transaction");
    store.orderItems.push({ order_id: params[0], product_id: params[1], quantity: params[2], price_at_purchase: params[3] });
    return [{ insertId: store.orderItems.length, affectedRows: 1 }, []];
  }
  // PI-06: settlement asks why a stock update matched no row (archived vs sold out).
  if (s === "SELECT deleted_at FROM products WHERE id = ?") {
    const p = store.products[Number(params[0])];
    return [p ? [{ deleted_at: p.deleted_at }] : [], []];
  }
  // Stage B: this suite simulates migration 009 NOT being applied. Every issue write
  // fails as "table doesn't exist" — which must never change a payment response.
  if (/\bpayment_issues\b/.test(s)) {
    fake.issueTableMissing = (fake.issueTableMissing || 0) + 1;
    throw Object.assign(new Error("Table 'payment_issues' doesn't exist"), { code: "ER_NO_SUCH_TABLE", errno: 1146 });
  }
  fake.unexpected.push(s);
  throw new Error("fake db: unexpected query");
}
const fakePool = {
  query: (sql, params) => fakeQuery(sql, params, null),
  async getConnection() {
    fake.connections++;
    const tx = { open: false, saved: null };
    return {
      query: (sql, params) => fakeQuery(sql, params, tx),
      async beginTransaction() { tx.open = true; tx.saved = clone(store); },
      async commit() { tx.open = false; tx.saved = null; },
      async rollback() { if (tx.saved) store = tx.saved; tx.open = false; tx.saved = null; },
      release() {},
    };
  },
};
const dbPath = require.resolve(path.join(SERVER, "db.js"));
const dbModule = new Module(dbPath);
dbModule.filename = dbPath; dbModule.loaded = true; dbModule.exports = fakePool;
require.cache[dbPath] = dbModule;

// ---------- network isolation ----------
const net = { refused: [], toMock: 0, mx: 0 };
require("dns").promises.Resolver.prototype.resolveMx = async function () {
  net.mx++; throw Object.assign(new Error("MX lookup refused in tests"), { code: "ENOTFOUND" });
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith(MOCK_BASE + "/")) { net.toMock++; return realFetch(url, init); }
  net.refused.push(u);
  throw new Error("outbound fetch refused in tests");
};

// ---------- mock Paystack ----------
const scenarios = new Map();   // reference -> { mode, status, code, body, tx }
const verifyHits = new Map();  // reference -> count
let initMode = "ok", lastInitBody = null;
const hanging = new Set();
const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", c => { body += c; });
  req.on("end", () => {
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(typeof obj === "string" ? obj : JSON.stringify(obj)); };
    if (req.headers.authorization !== `Bearer ${FAKE_PAYSTACK_KEY}`) return send(401, { status: false, message: "bad key" });
    if (req.method === "POST" && req.url === "/transaction/initialize") {
      lastInitBody = JSON.parse(body || "{}");
      if (initMode === "hang") { hanging.add(res); return; }
      if (initMode === "reset") return req.socket.destroy();
      if (initMode === "http500") return send(500, { status: false, message: "Internal error" });
      return send(200, { status: true, data: { authorization_url: "https://checkout.example.invalid/pay", reference: lastInitBody.reference } });
    }
    const m = req.url.match(/^\/transaction\/verify\/(.+)$/);
    if (req.method === "GET" && m) {
      const ref = decodeURIComponent(m[1]);
      verifyHits.set(ref, (verifyHits.get(ref) || 0) + 1);
      const sc = scenarios.get(ref);
      if (!sc) return send(404, { status: false, message: "Transaction reference not found" });
      if (sc.mode === "hang") { hanging.add(res); return; }
      if (sc.mode === "reset") return req.socket.destroy();
      if (sc.mode === "http") return send(sc.code, sc.body !== undefined ? sc.body : { status: false, message: "error" });
      if (sc.mode === "raw") { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(sc.body); }
      if (sc.mode === "json") return send(200, sc.body);
      return send(200, { status: true, message: "Verification successful", data: sc.tx });
    }
    send(404, { status: false });
  });
});

// ---------- helpers ----------
let pricing, jwt;
let refSeq = 0;
function newRef() { refSeq++; return `NF-${Date.now()}-${USER_A}-rel${String(refSeq).padStart(4, "0")}`; }
function makePayment({ userId = USER_A, productId = P1, qty = 1, status = "success", txOverrides = {}, mode = "tx", reference } = {}) {
  const ref = reference || newRef();
  const unit = 10000, total = unit * qty + 800;
  const snapshot = { v: 1, reference: ref, userId, addressId: null, couponId: null, currency: "GHS", subtotal: unit * qty, discount: 0, shipping: 800, total, lines: [{ productId, qty, offerId: null, unitPrice: unit, name: "Reliability Test Scent" }] };
  const { payload, sig } = pricing.signSnapshot(snapshot);
  const tx = { reference: ref, amount: total, currency: "GHS", status, metadata: { nf_order: payload, nf_sig: sig }, ...txOverrides };
  scenarios.set(ref, { mode, tx });
  return { ref, snapshot, payload, sig, total };
}
const tokenFor = id => jwt.sign({ id, role: "customer", v: 0 }, JWT_SECRET, { expiresIn: "10m" });
async function verify(ref, userId = USER_A) {
  const res = await realFetch(`${BASE}/api/payments/verify/${encodeURIComponent(ref)}`, { headers: { Authorization: `Bearer ${tokenFor(userId)}` } });
  const text = await res.text(); let data = {}; try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: res.status, data };
}
function signBody(raw, key = FAKE_PAYSTACK_KEY) { return crypto.createHmac("sha512", key).update(raw).digest("hex"); }
async function webhook(event, { badSignature = false } = {}) {
  const raw = JSON.stringify(event);
  const res = await realFetch(`${BASE}/api/payments/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-paystack-signature": badSignature ? signBody(raw, "wrong-key") : signBody(raw) },
    body: raw,
  });
  const text = await res.text(); let data = {}; try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: res.status, data };
}
const ordersFor = ref => store.orders.filter(o => o.payment_reference === ref);
const stockOf = id => store.products[id].stock_qty;
async function initialize(extra = { addressId: ADDR_A }, headers = {}) {
  const res = await realFetch(`${BASE}/api/payments/initialize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${tokenFor(USER_A)}`, ...headers },
    body: JSON.stringify({ items: [{ productId: P1, qty: 1 }], ...extra }),
  });
  const text = await res.text(); let data = {}; try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: res.status, data };
}

// ======================================================================
// Backend: callback, webhook, initialize
// ======================================================================
async function backendTests() {
  await new Promise(r => mock.listen(MOCK_PORT, "127.0.0.1", r));
  require(path.join(SERVER, "server.js"));
  pricing = require(path.join(SERVER, "pricing.js"));
  jwt = require(path.join(SERVER, "node_modules/jsonwebtoken"));
  check("B0 server.js is using the in-memory fake database", require(path.join(SERVER, "db.js")) === fakePool);
  for (let i = 0; i < 50; i++) { try { await realFetch(BASE + "/"); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }

  // Start the slow timeout cases first; they run while everything else is checked.
  const tVerify = makePayment({ mode: "hang" });
  const tHook = makePayment({ mode: "hang" });
  const started = Date.now();
  const timeoutCalls = Promise.all([
    verify(tVerify.ref).then(r => ({ r, ms: Date.now() - started })),
    webhook({ event: "charge.success", data: { reference: tHook.ref } }).then(r => ({ r, ms: Date.now() - started })),
    (async () => { initMode = "hang"; const r = await initialize(); return { r, ms: Date.now() - started }; })(),
  ]);
  await new Promise(r => setTimeout(r, 300)); // let the hanging initialize reach the mock before initMode changes

  // --- callback: success + idempotent replay ---
  const ok = makePayment();
  const stock0 = stockOf(P1);
  let r = await verify(ok.ref);
  check("C1 verified success creates exactly one order (201) and takes stock once", r.status === 201 && r.data.orderId && ordersFor(ok.ref).length === 1 && stockOf(P1) === stock0 - 1, { status: r.status, data: r.data });
  const firstOrder = r.data.orderId;
  r = await verify(ok.ref);
  check("C2 replay returns the same order (200 alreadyProcessed) with no second stock change", r.status === 200 && r.data.alreadyProcessed === true && r.data.orderId === firstOrder && stockOf(P1) === stock0 - 1, r.data);

  // --- callback: pending states ---
  for (const st of ["pending", "ongoing", "processing", "queued"]) {
    const p = makePayment({ status: st });
    const before = stockOf(P1);
    r = await verify(p.ref);
    check(`C3 Paystack '${st}' → 202 PAYMENT_PENDING, no order, no stock change`, r.status === 202 && r.data.code === "PAYMENT_PENDING" && ordersFor(p.ref).length === 0 && stockOf(P1) === before, { status: r.status, code: r.data.code });
  }

  // --- callback: definitive failures ---
  for (const st of ["failed", "abandoned", "reversed"]) {
    const f = makePayment({ status: st });
    r = await verify(f.ref);
    check(`C4 Paystack '${st}' → 400 PAYMENT_NOT_SUCCESSFUL, no order`, r.status === 400 && r.data.code === "PAYMENT_NOT_SUCCESSFUL" && ordersFor(f.ref).length === 0, { status: r.status, code: r.data.code });
  }

  // --- callback: temporary errors (never "not successful") ---
  const temporaryCases = [
    ["HTTP 429", { mode: "http", code: 429, body: { status: false, message: "Too many requests" } }],
    ["HTTP 500", { mode: "http", code: 500, body: { status: false, message: "Server error" } }],
    ["HTTP 502 with a non-JSON body", { mode: "http", code: 502, body: "<html>Bad gateway</html>" }],
    ["network failure (connection reset)", { mode: "reset" }],
    ["invalid JSON (200)", { mode: "raw", body: "{not json" }],
    ["malformed: data null", { mode: "json", body: { status: true, data: null } }],
    ["malformed: response flag false even though data says failed", { mode: "json", body: { status: false, data: { status: "failed" } } }],
    ["malformed: transaction without a status", { mode: "json", body: { status: true, data: { reference: "x" } } }],
    ["unrecognised transaction status", { mode: "tx", txStatus: "mystery_state" }],
  ];
  for (const [label, sc] of temporaryCases) {
    const t = makePayment(sc.txStatus ? { status: sc.txStatus } : {});
    if (!sc.txStatus) scenarios.set(t.ref, { ...sc });
    r = await verify(t.ref);
    check(`C5 ${label} → 503 PAYMENT_VERIFY_UNAVAILABLE, no order`, r.status === 503 && r.data.code === "PAYMENT_VERIFY_UNAVAILABLE" && ordersFor(t.ref).length === 0, { status: r.status, code: r.data.code });
  }
  const unknownRef = newRef(); // Paystack answers 404 "not found"
  r = await verify(unknownRef);
  check("C6 Paystack HTTP 404 for the reference → treated as temporary (503), not as a failed payment", r.status === 503 && r.data.code === "PAYMENT_VERIFY_UNAVAILABLE", { status: r.status, code: r.data.code });

  // --- callback: integrity checks still enforced ---
  const integrity = [
    ["wrong reference in Paystack's answer", { txOverrides: { reference: "NF-0000000000-1-other" } }, 400, "REFERENCE_MISMATCH"],
    ["wrong currency", { txOverrides: { currency: "NGN" } }, 400, "CURRENCY_MISMATCH"],
    ["underpaid amount", { txOverrides: { amount: 100 } }, 400, "AMOUNT_MISMATCH"],
  ];
  for (const [label, opts, st, code] of integrity) {
    const x = makePayment(opts);
    r = await verify(x.ref);
    check(`C7 ${label} → ${st} ${code}, no order`, r.status === st && r.data.code === code && ordersFor(x.ref).length === 0, { status: r.status, code: r.data.code });
  }
  const forged = makePayment();
  const forgedSnap = { ...forged.snapshot, total: 100, lines: [{ ...forged.snapshot.lines[0], unitPrice: 1 }] };
  scenarios.get(forged.ref).tx.metadata = { nf_order: JSON.stringify(forgedSnap), nf_sig: forged.sig };
  scenarios.get(forged.ref).tx.amount = 100;
  r = await verify(forged.ref);
  check("C8 tampered snapshot (forged cheap price, old signature) → 400 PAYMENT_METADATA_INVALID, no order", r.status === 400 && r.data.code === "PAYMENT_METADATA_INVALID" && ordersFor(forged.ref).length === 0, { status: r.status, code: r.data.code });
  const otherUser = makePayment();
  r = await verify(otherUser.ref, USER_B);
  check("C9 another customer cannot settle the payment → 403 PAYMENT_USER_MISMATCH, no order", r.status === 403 && r.data.code === "PAYMENT_USER_MISMATCH" && ordersFor(otherUser.ref).length === 0, { status: r.status, code: r.data.code });

  // --- callback: verified, but cannot become an order ---
  const sold = makePayment({ productId: P2 });
  r = await verify(sold.ref);
  check("C10 verified payment, product sold out → 409 PAID_OUT_OF_STOCK, no order, stock not negative", r.status === 409 && r.data.code === "PAID_OUT_OF_STOCK" && ordersFor(sold.ref).length === 0 && stockOf(P2) === 0, { status: r.status, code: r.data.code });
  const dbFail = makePayment();
  const beforeDb = stockOf(P1), locksBefore = [fake.getLocks, fake.releaseLocks];
  fake.failOrderInsert = true;
  r = await verify(dbFail.ref);
  fake.failOrderInsert = false;
  check("C11 database failure after Paystack confirmed → 500 SETTLEMENT_ERROR (not a payment failure)", r.status === 500 && r.data.code === "SETTLEMENT_ERROR" && r.data.reference === dbFail.ref, { status: r.status, data: r.data });
  check("C12 …the transaction rolled back: no order, stock restored, lock released", ordersFor(dbFail.ref).length === 0 && stockOf(P1) === beforeDb && fake.getLocks - locksBefore[0] === 1 && fake.releaseLocks - locksBefore[1] === 1);
  r = await verify(dbFail.ref);
  check("C13 …and a later retry of the same reference settles it exactly once", r.status === 201 && ordersFor(dbFail.ref).length === 1 && stockOf(P1) === beforeDb - 1, { status: r.status });
  const busy = makePayment();
  fake.lockGot = 0;
  r = await verify(busy.ref);
  fake.lockGot = 1;
  check("C14 lock busy → 503 VERIFY_BUSY, no order", r.status === 503 && r.data.code === "VERIFY_BUSY" && ordersFor(busy.ref).length === 0, { status: r.status, code: r.data.code });

  // --- webhook ---
  const w1 = makePayment();
  const hits0 = verifyHits.get(w1.ref) || 0;
  r = await webhook({ event: "charge.success", data: { reference: w1.ref } });
  check("W1 charge.success, verified → 200 and exactly one order", r.status === 200 && r.data.orderId && ordersFor(w1.ref).length === 1, { status: r.status, data: r.data });
  r = await webhook({ event: "charge.success", data: { reference: w1.ref } });
  check("W2 duplicate delivery → 200 alreadyProcessed, still one order", r.status === 200 && r.data.alreadyProcessed === true && ordersFor(w1.ref).length === 1, r.data);
  check("W3 both deliveries re-verified with Paystack (the webhook body is never trusted)", (verifyHits.get(w1.ref) || 0) - hits0 === 2);
  const wp = makePayment({ status: "ongoing" });
  r = await webhook({ event: "charge.success", data: { reference: wp.ref } });
  check("W4 Paystack still pending → 503 (redelivery requested), no order", r.status === 503 && r.data.code === "PAYMENT_PENDING" && ordersFor(wp.ref).length === 0, { status: r.status, data: r.data });
  const wt = makePayment();
  scenarios.set(wt.ref, { mode: "http", code: 500 });
  r = await webhook({ event: "charge.success", data: { reference: wt.ref } });
  check("W5 Paystack verification HTTP 500 → 503 (retryable), verification attempted, no order", r.status === 503 && r.data.code === "PAYMENT_VERIFY_UNAVAILABLE" && verifyHits.get(wt.ref) === 1 && ordersFor(wt.ref).length === 0, { status: r.status, data: r.data });
  makePayment({ reference: wt.ref }); // Paystack recovers: the same reference now verifies as success
  r = await webhook({ event: "charge.success", data: { reference: wt.ref } });
  check("W6 the redelivery after Paystack recovers settles it: 200, exactly one order", r.status === 200 && ordersFor(wt.ref).length === 1, { status: r.status, data: r.data });
  const wd = makePayment();
  fake.failOrderInsert = true;
  r = await webhook({ event: "charge.success", data: { reference: wd.ref } });
  fake.failOrderInsert = false;
  check("W7 database failure after verification → 500 SETTLEMENT_ERROR (retryable), no order", r.status === 500 && r.data.code === "SETTLEMENT_ERROR" && ordersFor(wd.ref).length === 0, { status: r.status, data: r.data });
  const wf = makePayment({ status: "failed" });
  r = await webhook({ event: "charge.success", data: { reference: wf.ref } });
  check("W8 Paystack reports a definitive failure → 200 (no pointless retries), no order", r.status === 200 && r.data.rejected === "PAYMENT_NOT_SUCCESSFUL" && ordersFor(wf.ref).length === 0, { status: r.status, data: r.data });
  const wm = makePayment({ txOverrides: { amount: 1 } });
  r = await webhook({ event: "charge.success", data: { reference: wm.ref } });
  check("W9 verified but amount mismatch → 200 rejected (permanent), no order", r.status === 200 && r.data.rejected === "AMOUNT_MISMATCH" && ordersFor(wm.ref).length === 0, r.data);
  const ws = makePayment();
  r = await webhook({ event: "charge.success", data: { reference: ws.ref } }, { badSignature: true });
  check("W10 invalid signature → 401, Paystack never asked, no order", r.status === 401 && !verifyHits.has(ws.ref) && ordersFor(ws.ref).length === 0, { status: r.status });
  r = await webhook({ event: "transfer.success", data: { reference: ws.ref } });
  check("W11 unsupported event type → 200 ignored, Paystack never asked, no order", r.status === 200 && r.data.ignored === "transfer.success" && !verifyHits.has(ws.ref) && ordersFor(ws.ref).length === 0, r.data);
  r = await webhook({ event: "charge.success", data: { reference: "not-a-reference" } });
  check("W12 unusable reference → 200 ignored (no retry storm)", r.status === 200 && r.data.ignored === "invalid_reference", r.data);

  // --- initialize ---
  initMode = "ok";
  r = await initialize();
  check("I1 initialize: 200 with the Paystack URL; Paystack asked for the server-calculated amount", r.status === 200 && r.data.authorizationUrl && lastInitBody && lastInitBody.amount === 10800 && lastInitBody.currency === "GHS", { status: r.status, amount: lastInitBody && lastInitBody.amount });
  initMode = "http500";
  r = await initialize();
  check("I2 initialize: Paystack HTTP 500 → 502 PAYSTACK_INIT_FAILED", r.status === 502 && r.data.code === "PAYSTACK_INIT_FAILED", { status: r.status, code: r.data.code });
  initMode = "reset";
  r = await initialize();
  check("I3 initialize: network failure → 502 PAYSTACK_INIT_FAILED", r.status === 502 && r.data.code === "PAYSTACK_INIT_FAILED", { status: r.status, code: r.data.code });
  initMode = "ok";
  for (const [label, extra] of [["missing", {}], ["null", { addressId: null }], ["empty string", { addressId: "" }]]) {
    lastInitBody = null;
    r = await initialize(extra);
    check(`I4 initialize: ${label} delivery address → 400 ADDRESS_REQUIRED, Paystack never asked`, r.status === 400 && r.data.code === "ADDRESS_REQUIRED" && lastInitBody === null, { status: r.status, code: r.data.code });
  }
  lastInitBody = null;
  r = await initialize({ addressId: ADDR_B });
  check("I5 initialize: another customer's address → 400 INVALID_ADDRESS, Paystack never asked", r.status === 400 && r.data.code === "INVALID_ADDRESS" && lastInitBody === null, { status: r.status, code: r.data.code });
  r = await initialize();
  check("I6 initialize: own address → 200, signed snapshot carries it", r.status === 200 && lastInitBody && JSON.parse(lastInitBody.metadata.nf_order).addressId === ADDR_A, { status: r.status });

  // --- QA-001: where Paystack sends the customer back (callback_url sent to Paystack) ---
  const callbackFor = async headers => { lastInitBody = null; const x = await initialize(undefined, headers); return { status: x.status, cb: lastInitBody && lastInitBody.callback_url }; };
  let c = await callbackFor({ Origin: "http://127.0.0.1:5500" });
  check("CB1 laptop origin 127.0.0.1:5500 → callback http://127.0.0.1:5500/payment-callback.html", c.status === 200 && c.cb === "http://127.0.0.1:5500/payment-callback.html", c);
  c = await callbackFor({ Origin: LAN_ORIGIN });
  check("CB2 iPhone LAN origin (allowed via CORS_ORIGINS) → callback returns to the LAN address, not 127.0.0.1", c.status === 200 && c.cb === `${LAN_ORIGIN}/payment-callback.html`, c);
  c = await callbackFor({ Origin: PROD_ORIGIN });
  check("CB3 production-style frontend origin (allowed via CORS_ORIGINS) → callback on that origin", c.status === 200 && c.cb === `${PROD_ORIGIN}/payment-callback.html`, c);
  const unapproved = ["https://evil.example", "http://172.20.10.3:5501", "http://172.20.10.3:5500.evil.example", "https://evil.example/172.20.10.3:5500", "null", "http://172.20.10.4:5500"];
  const leaked = [];
  for (const o of unapproved) { const x = await callbackFor({ Origin: o }); if (x.cb !== "http://127.0.0.1:5500/payment-callback.html") leaked.push(`${o} -> ${x.cb}`); }
  check(`CB4 ${unapproved.length} unapproved or look-alike origins fall back to FRONTEND_URL (never used as the callback)`, leaked.length === 0, leaked);
  c = await callbackFor({});
  check("CB5 no Origin header → FRONTEND_URL, exactly as before", c.status === 200 && c.cb === "http://127.0.0.1:5500/payment-callback.html", c);
  c = await callbackFor({ "X-Forwarded-Host": "evil.example", "X-Forwarded-Proto": "https", Referer: "https://evil.example/cart.html" });
  check("CB6 forwarded-host, forwarded-proto and Referer headers are ignored (no Origin → FRONTEND_URL)", c.status === 200 && c.cb === "http://127.0.0.1:5500/payment-callback.html", c);
  c = await callbackFor({ Origin: `${LAN_ORIGIN}/` });
  check("CB7 the path is always exactly /payment-callback.html (a trailing slash never doubles it)", c.cb === `${LAN_ORIGIN}/payment-callback.html`, c);
  // Production composition: the helper must use the CORS allowlist itself (which drops the dev
  // origins in production) and read no header but Origin.
  const serverSrc = require("fs").readFileSync(path.join(SERVER, "server.js"), "utf8");
  const helper = serverSrc.slice(serverSrc.indexOf("function paymentCallbackUrl("), serverSrc.indexOf("\n}\n", serverSrc.indexOf("function paymentCallbackUrl(")));
  check("CB8 the callback helper uses the same ALLOWED_ORIGINS set as CORS, falls back to FRONTEND_URL, and reads no Host/Referer/forwarded header; initialize uses it",
    /ALLOWED_ORIGINS\.has\(stripSlash\(origin\)\)/.test(helper) && /process\.env\.FRONTEND_URL/.test(helper) && !/host|referer|forwarded/i.test(helper.replace(/^\s*\/\/.*$/gm, ""))
    && /callback_url: paymentCallbackUrl\(req\),/.test(serverSrc) && !/callback_url: `\$\{process\.env\.FRONTEND_URL\}/.test(serverSrc));

  // --- the timeout cases started at the top ---
  const [tv, tw, ti] = await timeoutCalls;
  check("T1 verification timeout (callback) → 503 PAYMENT_VERIFY_UNAVAILABLE after ~10 s, no order", tv.r.status === 503 && tv.r.data.code === "PAYMENT_VERIFY_UNAVAILABLE" && tv.ms >= 9500 && tv.ms < 13500 && ordersFor(tVerify.ref).length === 0, { status: tv.r.status, ms: tv.ms });
  check("T2 verification timeout (webhook) → 503 retryable after ~10 s, no order", tw.r.status === 503 && tw.r.data.code === "PAYMENT_VERIFY_UNAVAILABLE" && tw.ms >= 9500 && tw.ms < 13500 && ordersFor(tHook.ref).length === 0, { status: tw.r.status, ms: tw.ms });
  check("T3 initialize timeout → 502 PAYSTACK_INIT_FAILED after ~15 s", ti.r.status === 502 && ti.r.data.code === "PAYSTACK_INIT_FAILED" && ti.ms >= 14500 && ti.ms < 18500, { status: ti.r.status, ms: ti.ms });
  for (const res of hanging) { try { res.destroy(); } catch (e) { /* ignore */ } }

  check("B1 every acquired GET_LOCK was matched by a RELEASE_LOCK", fake.getLocks > 0 && fake.getLocks === fake.releaseLocks, [fake.getLocks, fake.releaseLocks]);
  check("S1 no unexpected database statement", fake.unexpected.length === 0, fake.unexpected);
  check("B2 with migration 009 absent, issue writes failed quietly and every payment response above was unaffected", (fake.issueTableMissing || 0) > 0, fake.issueTableMissing);
  check("S2 the server made no outbound request except to the local mock Paystack", net.refused.length === 0 && net.toMock > 0, { refused: net.refused, toMock: net.toMock });
  check("S3 no MX/DNS lookup", net.mx === 0);
}

// ======================================================================
// Frontend: js/payment-result.js in a vm sandbox
// ======================================================================
function loadPaymentResult(responses) {
  const src = fs.readFileSync(FRONT_SCRIPT, "utf8");
  const state = { cartCleared: 0, fetches: 0, timers: [], html: "", listeners: {}, authCleared: 0 };
  const stubEl = id => ({
    id, textContent: "", setAttribute() {}, focus() {},
    addEventListener(type, fn) { state.listeners[id] = fn; },
  });
  let registry = {};
  const card = {
    setAttribute() {}, querySelector: () => ({ setAttribute() {}, focus() {} }),
    get innerHTML() { return state.html; },
    set innerHTML(v) { state.html = v; registry = {}; state.listeners = {}; },
  };
  const document = {
    title: "",
    getElementById: id => (id === "callback-content" ? card : (registry[id] = registry[id] || stubEl(id))),
    addEventListener() {},
  };
  let seq = 0;
  const ctx = {
    document, console,
    window: { location: { search: "", href: "" } },
    sessionStorage: { removeItem() {} },
    navigator: { clipboard: { writeText: async () => {} } },
    URLSearchParams,
    getAuth: () => ({ token: "test-token" }),
    clearAuth: () => { state.authCleared++; },
    clearCart: () => { state.cartCleared++; },
    escapeHtml: s => String(s == null ? "" : s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`),
    money: n => `GH₵${Number(n).toFixed(2)}`,
    nfWhatsAppLink: m => `https://wa.me/233505731824?text=${encodeURIComponent(m)}`,
    NF_CONTACT: { email: "help@example.invalid" },
    API_BASE: "http://api.test.invalid",
    encodeURIComponent, encodeURI,
    setTimeout: (fn, ms) => { const t = { id: ++seq, fn, ms, cancelled: false }; state.timers.push(t); return t.id; },
    clearTimeout: id => { const t = state.timers.find(x => x.id === id); if (t) t.cancelled = true; },
    fetch: async () => {
      state.fetches++;
      const next = typeof responses === "function" ? responses(state.fetches) : responses;
      if (next === "throw") throw new TypeError("Failed to fetch");
      return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body || {} };
    },
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: "payment-result.js" });
  const pending = () => state.timers.filter(t => !t.cancelled && !t.ran);
  async function runNextTimer() {
    const t = pending()[0];
    if (!t) return false;
    t.ran = true;
    await t.fn();
    return true;
  }
  return { ctx, state, runNextTimer, pending };
}
const has = (html, re) => re.test(html.replace(/<[^>]+>/g, " "));
const PAY_AGAIN_INVITE = /no order was placed|try again whenever|return to your bag/i;

async function frontendTests() {
  if (!fs.existsSync(FRONT_SCRIPT)) { check("F0 frontend payment-result.js found next to the server repo", false, FRONT_SCRIPT); return; }
  const REF = "NF-1760000000000-990201-abcd1234";

  let f = loadPaymentResult({ status: 201, body: { orderId: 7001, total: 108 } });
  await f.ctx.verifyPayment(REF, 0);
  check("F1 confirmed order (201 + orderId): success shown, bag cleared exactly once", f.state.cartCleared === 1 && has(f.state.html, /order is confirmed/i), f.state.cartCleared);

  f = loadPaymentResult({ status: 202, body: { code: "PAYMENT_PENDING", reference: REF } });
  await f.ctx.verifyPayment(REF, 0);
  check("F2 pending: 'still being confirmed', 'don't pay again', a Check again button, bag NOT cleared",
    f.state.cartCleared === 0 && has(f.state.html, /still being confirmed/i) && has(f.state.html, /don.t pay again/i) && /id="check-again"/.test(f.state.html) && !has(f.state.html, PAY_AGAIN_INVITE));
  // Bounded automatic re-checks: keep answering "pending" and drain every timer.
  let guard = 0;
  while (await f.runNextTimer()) { if (++guard > 20) break; }
  check("F3 pending re-checks are bounded: 1 initial + 3 automatic, then no timer left", f.state.fetches === 4 && f.pending().length === 0 && guard === 3, { fetches: f.state.fetches, rounds: guard });
  const beforeManual = f.state.fetches;
  await f.state.listeners["check-again"]();
  check("F4 after the automatic checks, 'Check again' asks exactly once and schedules nothing", f.state.fetches === beforeManual + 1 && f.pending().length === 0 && f.state.cartCleared === 0);

  f = loadPaymentResult(n => (n === 1 ? { status: 202, body: { code: "PAYMENT_PENDING" } } : { status: 200, body: { orderId: 7002, total: 108, alreadyProcessed: true } }));
  await f.ctx.verifyPayment(REF, 0);
  await f.runNextTimer();
  check("F5 pending that later confirms (e.g. via the webhook): success shown, bag cleared once", f.state.cartCleared === 1 && has(f.state.html, /order is confirmed/i));

  f = loadPaymentResult({ status: 503, body: { code: "PAYMENT_VERIFY_UNAVAILABLE", error: "We couldn't confirm your payment right now.", reference: REF } });
  await f.ctx.verifyPayment(REF, 0);
  check("F6 temporary error: 'couldn't confirm yet', 'don't pay again', retry button, bag NOT cleared, no auto-polling",
    f.state.cartCleared === 0 && has(f.state.html, /couldn.t confirm your payment yet/i) && has(f.state.html, /don.t pay again/i) && /id="retry-verify"/.test(f.state.html) && !has(f.state.html, PAY_AGAIN_INVITE) && f.pending().length === 0);
  await f.state.listeners["retry-verify"]();
  check("F7 the retry button asks the server once more", f.state.fetches === 2);

  f = loadPaymentResult({ status: 400, body: { code: "PAYMENT_NOT_SUCCESSFUL", error: "Payment was not successful." } });
  await f.ctx.verifyPayment(REF, 0);
  check("F8 definitive failure: 'wasn't completed' (existing page), bag NOT cleared, reference + contact-first advice shown",
    f.state.cartCleared === 0 && has(f.state.html, /wasn.t completed/i) && has(f.state.html, /before paying again/i) && f.state.html.includes(REF));

  f = loadPaymentResult({ status: 409, body: { code: "PAID_OUT_OF_STOCK", reference: REF, error: "Your payment was received, but an item sold out before we could reserve it." } });
  await f.ctx.verifyPayment(REF, 0);
  check("F9 verified but blocked (sold out): needs-attention page, not success, bag NOT cleared, not invited to pay again",
    f.state.cartCleared === 0 && has(f.state.html, /need to check this payment/i) && !has(f.state.html, /order is confirmed/i) && !has(f.state.html, PAY_AGAIN_INVITE));

  f = loadPaymentResult({ status: 500, body: { code: "SETTLEMENT_ERROR", reference: REF, error: "Your payment was confirmed, but we couldn't finish creating your order yet. Please don't pay again — try again in a moment, or contact us with your payment reference." } });
  await f.ctx.verifyPayment(REF, 0);
  check("F10 order not yet written (500 SETTLEMENT_ERROR): unconfirmed page with retry, not success, bag NOT cleared",
    f.state.cartCleared === 0 && has(f.state.html, /couldn.t confirm your payment yet/i) && /id="retry-verify"/.test(f.state.html) && !has(f.state.html, /order is confirmed/i));

  f = loadPaymentResult({ status: 503, body: { code: "VERIFY_BUSY", error: "Your payment is being confirmed." } });
  await f.ctx.verifyPayment(REF, 0);
  guard = 0;
  while (await f.runNextTimer()) { if (++guard > 20) break; }
  check("F11 busy server: 4 bounded retries, then the unconfirmed page (never success, never 'no order')",
    f.state.fetches === 5 && guard === 4 && f.state.cartCleared === 0 && has(f.state.html, /couldn.t confirm your payment yet/i) && !has(f.state.html, PAY_AGAIN_INVITE), { fetches: f.state.fetches, rounds: guard });

  f = loadPaymentResult({ status: 200, body: {} });
  await f.ctx.verifyPayment(REF, 0);
  check("F12 a 200 without an orderId is never treated as success (bag NOT cleared)", f.state.cartCleared === 0 && !has(f.state.html, /order is confirmed/i));

  f = loadPaymentResult("throw");
  await f.ctx.verifyPayment(REF, 0);
  check("F13 network error reaching our server: 'may have gone through', try again, bag NOT cleared", f.state.cartCleared === 0 && has(f.state.html, /may have gone through/i) && !has(f.state.html, PAY_AGAIN_INVITE));
}

(async () => {
  try {
    await backendTests();
    await frontendTests();
  } catch (err) {
    failed++;
    console.log("FAIL suite crashed:", err && err.stack || err);
  }
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})();
