// Payment issues register + admin recovery (Payment Reliability Stage B).
//
// DATABASE-FREE AND NETWORK-ISOLATED BY CONSTRUCTION — same method as
// payment-reliability-tests.js:
//   * ./db is replaced in the require cache, before server.js loads, by an in-memory
//     fake. It implements only the statements the payment, payment-issue, admin-auth
//     and summary paths use. Transactions keep a per-transaction undo log, so a
//     rolled-back settlement is undone even while another settlement is in flight.
//     Any other statement is refused, recorded and fails the run. DB_PORT is 1.
//   * Paystack is a mock on 127.0.0.1:5084 with a fake key. The server's fetch can
//     reach only that mock; everything else is refused and recorded. MX lookups are
//     refused. SendGrid/Google keys are blank.
//   * Users, products, addresses and issues exist only in the fake's memory.
//
// IMPORTANT: this proves the APPLICATION logic only. It does not prove migration 009
// against MariaDB/TiDB, real row-locking/isolation behaviour, or GET_LOCK support on
// TiDB — those need a local-database run (with approval) and staging validation.
//
// Run: node tests/payment-issues-tests.js
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const Module = require("module");
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
const SERVER = process.cwd();

const PORT = 5083, MOCK_PORT = 5084;
const BASE = `http://127.0.0.1:${PORT}`;
const MOCK_BASE = `http://127.0.0.1:${MOCK_PORT}`;
const FAKE_PAYSTACK_KEY = "sk_test_payment_issues_mock_not_a_real_key";

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail === undefined ? "" : `  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`}`); }
}

// ---------- environment (before server.js loads; dotenv never overrides) ----------
const JWT_SECRET = crypto.randomBytes(32).toString("hex");
Object.assign(process.env, {
  PORT: String(PORT),
  DB_HOST: "127.0.0.1", DB_PORT: "1", DB_NAME: "nf-payment-issues-no-db",
  JWT_SECRET, PAYMENT_SIGNING_SECRET: crypto.randomBytes(32).toString("hex"),
  PAYSTACK_SECRET_KEY: FAKE_PAYSTACK_KEY, PAYSTACK_API_BASE: MOCK_BASE,
  SENDGRID_API_KEY: "", SENDGRID_FROM_EMAIL: "", GOOGLE_CLIENT_ID: "",
  DEV_EMAIL_LOG: "true", NODE_ENV: "", CORS_ORIGINS: "", FRONTEND_URL: "http://127.0.0.1:5500",
});

// ---------- in-memory fake database ----------
const ADMIN = 990401, CUST_A = 990402, CUST_B = 990403;
const P1 = 990501, P2 = 990502, P3 = 990503;
const ADDR_A = 880001;
const store = {
  users: { [ADMIN]: { id: ADMIN, role: "admin", full_name: "Issues Admin" }, [CUST_A]: { id: CUST_A, role: "customer", full_name: "Customer A" }, [CUST_B]: { id: CUST_B, role: "customer", full_name: "Customer B" } },
  products: {
    [P1]: { id: P1, name: "Issues Test Scent", stock_qty: 50, deleted_at: null },
    [P2]: { id: P2, name: "Issues Sold Out", stock_qty: 0, deleted_at: null },
    [P3]: { id: P3, name: "Issues Archived", stock_qty: 10, deleted_at: new Date("2026-10-01T00:00:00Z") },
  },
  addresses: { [ADDR_A]: { id: ADDR_A, user_id: CUST_A } },
  orders: [], orderItems: [], nextOrderId: 8000001,
  issues: [], nextIssueId: 1,
};
const fake = {
  failOrderInsert: false, failIssueWrites: false, failResolveOnly: false, issuesTableMissing: false, summaryIssueError: false,
  unexpected: [], issueWrites: [], connections: 0, barrier: null, getLocks: 0, releaseLocks: 0,
};
const tableMissing = () => Object.assign(new Error("Table 'payment_issues' doesn't exist"), { code: "ER_NO_SUCH_TABLE", errno: 1146 });
const issueByRef = ref => store.issues.find(i => i.payment_reference === ref);
const orderByRef = ref => store.orders.find(o => o.payment_reference === ref);

function issueGuard(s, params) {
  if (!/\bpayment_issues\b/.test(s)) return;
  if (fake.issuesTableMissing) throw tableMissing();
  if (fake.failIssueWrites) throw Object.assign(new Error("simulated issue-store outage"), { code: "ER_LOCK_WAIT_TIMEOUT" });
  if (/^(INSERT|UPDATE)/.test(s)) fake.issueWrites.push({ sql: s, params: clone(params) });
}
const clone = v => JSON.parse(JSON.stringify(v === undefined ? null : v));

function listFilter(s, params) {
  let i = 0; const f = {};
  if (s.includes("pi.status = ?")) f.status = params[i++];
  if (s.includes("pi.category = ?")) f.category = params[i++];
  if (s.includes("pi.evidence = ?")) f.evidence = params[i++];
  if (s.includes("pi.last_seen_at >= ?")) f.from = new Date(params[i++].replace(" ", "T") + "Z");
  if (s.includes("pi.last_seen_at <= ?")) f.to = new Date(params[i++].replace(" ", "T") + "Z");
  if (s.includes("pi.payment_reference LIKE ?")) f.like = params[i++].replace(/%/g, "");
  const rows = store.issues.filter(r => (!f.status || r.status === f.status) && (!f.category || r.category === f.category)
    && (!f.evidence || r.evidence === f.evidence) && (!f.from || r.last_seen_at >= f.from) && (!f.to || r.last_seen_at <= f.to)
    && (!f.like || r.payment_reference.includes(f.like)));
  return { rows, used: i };
}
const joined = r => {
  const o = orderByRef(r.payment_reference);
  return { ...r, customer_name: r.user_id && store.users[r.user_id] ? store.users[r.user_id].full_name : null,
    resolved_by_name: r.resolved_by && store.users[r.resolved_by] ? store.users[r.resolved_by].full_name : null,
    detail_product_name: r.detail_product_id && store.products[r.detail_product_id] ? store.products[r.detail_product_id].name : null,
    linked_order_id: o ? o.id : null, linked_order_status: o ? o.status : null, linked_order_total: o ? o.total : null };
};

async function fakeQuery(sql, params = [], tx) {
  const s = String(sql).replace(/\s+/g, " ").trim();
  issueGuard(s, params);
  // --- auth ---
  if (s === "SELECT disabled_at, token_version FROM users WHERE id = ?") return [[{ disabled_at: null, token_version: 0 }], []];
  if (s === "SELECT role FROM users WHERE id = ?") { const u = store.users[Number(params[0])]; return [u ? [{ role: u.role }] : [], []]; }
  if (/FROM app_settings WHERE setting_key IN/.test(s)) return [[], []];
  // --- settlement ---
  if (s === "SELECT GET_LOCK(?, 10) AS got") { fake.getLocks++; return [[{ got: 1 }], []]; } // granted to everyone: no lock is assumed
  if (s === "SELECT RELEASE_LOCK(?)") { fake.releaseLocks++; return [[{ r: 1 }], []]; }
  if (s === "SELECT id, total FROM orders WHERE payment_reference = ?") {
    if (tx && fake.barrier && fake.barrier.active) {
      const b = fake.barrier;
      await new Promise(resolve => { b.waiting.push(resolve); if (b.waiting.length >= b.count) { b.active = false; b.releasedWith = b.waiting.length; b.waiting.forEach(r => r()); } });
    }
    return [store.orders.filter(o => o.payment_reference === params[0]).map(o => ({ id: o.id, total: o.total })), []];
  }
  if (s === "SELECT id FROM addresses WHERE id = ? AND user_id = ?") {
    const a = store.addresses[Number(params[0])];
    return [a && a.user_id === Number(params[1]) ? [{ id: a.id }] : [], []];
  }
  if (s === "UPDATE products SET stock_qty = stock_qty - ? WHERE id = ? AND deleted_at IS NULL AND stock_qty >= ?") {
    if (!tx || !tx.open) throw new Error("fake db: stock update outside a transaction");
    const p = store.products[Number(params[1])], q = Number(params[0]);
    if (p && !p.deleted_at && p.stock_qty >= Number(params[2])) { p.stock_qty -= q; tx.undo.push(() => { p.stock_qty += q; }); return [{ affectedRows: 1 }, []]; }
    return [{ affectedRows: 0 }, []];
  }
  if (s === "SELECT deleted_at FROM products WHERE id = ?") { const p = store.products[Number(params[0])]; return [p ? [{ deleted_at: p.deleted_at }] : [], []]; }
  if (s === "INSERT INTO orders (user_id, address_id, coupon_id, total, status, payment_reference) VALUES (?, ?, ?, ?, 'Processing', ?)") {
    if (!tx || !tx.open) throw new Error("fake db: order insert outside a transaction");
    if (fake.failOrderInsert) throw Object.assign(new Error("Deadlock found when trying to get lock; secret-ish details"), { code: "ER_LOCK_DEADLOCK", errno: 1213 });
    if (orderByRef(params[4])) throw Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY", errno: 1062, sqlMessage: `Duplicate entry '${params[4]}' for key 'uq_orders_payment_reference'` });
    const order = { id: store.nextOrderId++, user_id: params[0], address_id: params[1], coupon_id: params[2], total: params[3], status: "Processing", payment_reference: params[4] };
    store.orders.push(order); tx.undo.push(() => { store.orders.splice(store.orders.indexOf(order), 1); });
    return [{ insertId: order.id, affectedRows: 1 }, []];
  }
  if (s === "INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES (?, ?, ?, ?)") {
    const item = { order_id: params[0], product_id: params[1], quantity: params[2] };
    store.orderItems.push(item); tx.undo.push(() => { store.orderItems.splice(store.orderItems.indexOf(item), 1); });
    return [{ affectedRows: 1 }, []];
  }
  if (s === "SELECT full_name, email FROM users WHERE id = ?") return [[{ full_name: "Customer", email: "customer@example.invalid" }], []];
  // --- payment_issues (statements from payment-issues.js and the admin routes) ---
  if (s.startsWith("INSERT INTO payment_issues")) {
    if (!/FROM DUAL WHERE NOT EXISTS \(SELECT 1 FROM orders WHERE payment_reference = \?\)$/.test(s)) { fake.unexpected.push(s); throw new Error("fake db: unexpected issue insert shape"); }
    const [ref, evidence, category, code, firstSource, lastSource, userId, amount, currency, expected, productId, ref2] = params;
    if (ref !== ref2) throw new Error("fake db: guard reference differs");
    if (orderByRef(ref)) return [{ affectedRows: 0 }, []];
    if (issueByRef(ref)) throw Object.assign(new Error("Duplicate entry"), { code: "ER_DUP_ENTRY", errno: 1062, sqlMessage: `Duplicate entry '${ref}' for key 'uq_payment_issues_reference'` });
    const now = new Date();
    store.issues.push({ id: store.nextIssueId++, payment_reference: ref, evidence, category, last_error_code: code, first_source: firstSource, last_source: lastSource,
      status: "open", resolution: null, user_id: userId, order_id: null, amount_pesewas: amount, currency, expected_total_pesewas: expected, detail_product_id: productId,
      attempt_count: 1, first_seen_at: now, last_seen_at: now, resolved_by: null, resolved_at: null, resolution_note: null });
    return [{ insertId: store.nextIssueId - 1, affectedRows: 1 }, []];
  }
  if (s === "SELECT id, status, evidence, category FROM payment_issues WHERE payment_reference = ?") {
    const r = issueByRef(params[0]); return [r ? [{ id: r.id, status: r.status, evidence: r.evidence, category: r.category }] : [], []];
  }
  if (s === "UPDATE payment_issues SET attempt_count = attempt_count + 1, last_seen_at = CURRENT_TIMESTAMP, last_source = ? WHERE id = ?") {
    const r = store.issues.find(i => i.id === Number(params[1])); if (!r) return [{ affectedRows: 0 }, []];
    r.attempt_count++; r.last_seen_at = new Date(); r.last_source = params[0]; return [{ affectedRows: 1 }, []];
  }
  if (s.startsWith("UPDATE payment_issues SET attempt_count = attempt_count + 1, last_seen_at = CURRENT_TIMESTAMP, last_source = ?, evidence = ?")) {
    const [source, evidence, category, code, productId, userId, amount, currency, expected, id, evidenceRead] = params;
    const r = store.issues.find(i => i.id === Number(id));
    if (!r || r.status !== "open" || r.evidence !== evidenceRead) return [{ affectedRows: 0 }, []];
    Object.assign(r, { attempt_count: r.attempt_count + 1, last_seen_at: new Date(), last_source: source, evidence, category, last_error_code: code, detail_product_id: productId,
      user_id: userId ?? r.user_id, amount_pesewas: amount ?? r.amount_pesewas, currency: currency ?? r.currency, expected_total_pesewas: expected ?? r.expected_total_pesewas });
    return [{ affectedRows: 1 }, []];
  }
  if (s.startsWith("UPDATE payment_issues SET status = 'resolved', resolution = 'settled'")) {
    if (fake.failResolveOnly) throw Object.assign(new Error("simulated resolve failure"), { code: "ER_LOCK_WAIT_TIMEOUT" });
    const [orderId, resolvedBy, source, ref] = params;
    const r = issueByRef(ref);
    if (!r || r.status !== "open") return [{ affectedRows: 0 }, []];
    Object.assign(r, { status: "resolved", resolution: "settled", order_id: orderId, resolved_by: resolvedBy, resolved_at: new Date(), last_seen_at: new Date(), last_source: source });
    return [{ affectedRows: 1 }, []];
  }
  if (s === "UPDATE payment_issues SET attempt_count = attempt_count + 1, last_seen_at = CURRENT_TIMESTAMP, last_source = 'admin_retry' WHERE payment_reference = ?") {
    const r = issueByRef(params[0]); if (!r) return [{ affectedRows: 0 }, []];
    r.attempt_count++; r.last_seen_at = new Date(); r.last_source = "admin_retry"; return [{ affectedRows: 1 }, []];
  }
  if (s === "UPDATE payment_issues SET last_error_code = ? WHERE payment_reference = ? AND status = 'open' AND category <> 'settlement_blocked'") {
    const r = issueByRef(params[1]); if (!r || r.status !== "open" || r.category === "settlement_blocked") return [{ affectedRows: 0 }, []];
    r.last_error_code = params[0]; return [{ affectedRows: 1 }, []];
  }
  if (s === "UPDATE payment_issues SET order_id = ? WHERE payment_reference = ? AND status = 'resolved' AND order_id IS NULL") {
    const r = issueByRef(params[1]); if (!r || r.status !== "resolved" || r.order_id !== null) return [{ affectedRows: 0 }, []];
    r.order_id = params[0]; return [{ affectedRows: 1 }, []];
  }
  if (s.startsWith("UPDATE payment_issues pi SET pi.status = 'resolved'")) {
    if (!/AND NOT EXISTS \(SELECT 1 FROM orders o WHERE o\.payment_reference = pi\.payment_reference\)$/.test(s)) { fake.unexpected.push(s); throw new Error("fake db: unexpected resolve shape"); }
    const [resolution, note, resolvedBy, id] = params;
    const r = store.issues.find(i => i.id === Number(id));
    if (!r || r.status !== "open" || orderByRef(r.payment_reference)) return [{ affectedRows: 0 }, []];
    Object.assign(r, { status: "resolved", resolution, resolution_note: note, resolved_by: resolvedBy, resolved_at: new Date() });
    return [{ affectedRows: 1 }, []];
  }
  if (s === "SELECT id, payment_reference, status, category, last_error_code FROM payment_issues WHERE id = ?") {
    const r = store.issues.find(i => i.id === Number(params[0]));
    return [r ? [{ id: r.id, payment_reference: r.payment_reference, status: r.status, category: r.category, last_error_code: r.last_error_code }] : [], []];
  }
  if (s.startsWith("SELECT pi.id, pi.payment_reference") && s.endsWith("WHERE pi.id = ?")) {
    const r = store.issues.find(i => i.id === Number(params[0])); return [r ? [joined(r)] : [], []];
  }
  if (s.startsWith("SELECT COUNT(*) AS total FROM payment_issues pi")) return [[{ total: listFilter(s, params).rows.length }], []];
  if (s.startsWith("SELECT pi.id, pi.payment_reference") && s.endsWith("LIMIT ? OFFSET ?")) {
    const { rows, used } = listFilter(s, params);
    const [limit, offset] = params.slice(used);
    const sorted = [...rows].sort((a, b) => b.last_seen_at - a.last_seen_at || b.id - a.id);
    return [sorted.slice(offset, offset + limit).map(joined), []];
  }
  if (s === "SELECT status, COUNT(*) AS n FROM payment_issues GROUP BY status") {
    const counts = {}; store.issues.forEach(i => { counts[i.status] = (counts[i.status] || 0) + 1; });
    return [Object.entries(counts).map(([status, n]) => ({ status, n })), []];
  }
  // --- GET /api/admin/summary ---
  if (s === "SELECT COUNT(*) AS n FROM payment_issues WHERE status = 'open'") {
    if (fake.summaryIssueError) throw Object.assign(new Error("Access denied"), { code: "ER_TABLEACCESS_DENIED_ERROR", errno: 1142 });
    return [[{ n: store.issues.filter(i => i.status === "open").length }], []];
  }
  if (/^SELECT COUNT\(\*\) AS total, COALESCE\(SUM\(deleted_at IS NULL\), 0\) AS active/.test(s)) return [[{ total: 3, active: 2, archived: 1, out_of_stock: 1, low_stock: 0 }], []];
  if (s === "SELECT status, COUNT(*) AS n, COALESCE(SUM(total), 0) AS amount FROM orders GROUP BY status") return [[], []];
  if (/^SELECT COUNT\(\*\) AS orders, COALESCE\(SUM\(total\), 0\) AS revenue FROM orders/.test(s)) return [[{ orders: 0, revenue: 0 }], []];
  if (/^SELECT COUNT\(\*\) AS total, COALESCE\(SUM\(email_verified_at IS NOT NULL\), 0\) AS verified/.test(s)) return [[{ total: 2, verified: 2, new_30d: 0 }], []];
  if (s === "SELECT start_at, end_at, active FROM offers") return [[], []];
  if (s === "SELECT COUNT(*) AS total, AVG(rating) AS avg_rating FROM reviews") return [[{ total: 0, avg_rating: null }], []];
  if (/^SELECT o\.id, o\.total, o\.status, o\.created_at, u\.full_name AS customer_name/.test(s)) return [[], []];
  if (/^SELECT id, name, brand, image, stock_qty FROM products WHERE deleted_at IS NULL AND stock_qty BETWEEN 1 AND \?/.test(s)) return [[], []];
  if (/^SELECT r\.id, r\.rating, r\.comment/.test(s)) return [[], []];
  fake.unexpected.push(s);
  throw new Error("fake db: unexpected query");
}
const fakePool = {
  query: (sql, params) => fakeQuery(sql, params, null),
  async getConnection() {
    fake.connections++;
    const tx = { open: false, undo: [] };
    return {
      query: (sql, params) => fakeQuery(sql, params, tx),
      async beginTransaction() { tx.open = true; tx.undo = []; },
      async commit() { tx.open = false; tx.undo = []; },
      async rollback() { while (tx.undo.length) tx.undo.pop()(); tx.open = false; },
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
require("dns").promises.Resolver.prototype.resolveMx = async function () { net.mx++; throw Object.assign(new Error("MX refused"), { code: "ENOTFOUND" }); };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith(MOCK_BASE + "/")) { net.toMock++; return realFetch(url, init); }
  net.refused.push(u); throw new Error("outbound fetch refused in tests");
};

// ---------- mock Paystack ----------
const scenarios = new Map(), verifyHits = new Map(), held = [];
const mock = http.createServer((req, res) => {
  req.on("data", () => {});
  req.on("end", () => {
    const send = (code, obj) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.headers.authorization !== `Bearer ${FAKE_PAYSTACK_KEY}`) return send(401, { status: false });
    const m = req.url.match(/^\/transaction\/verify\/(.+)$/);
    if (req.method === "GET" && m) {
      const ref = decodeURIComponent(m[1]);
      verifyHits.set(ref, (verifyHits.get(ref) || 0) + 1);
      const sc = scenarios.get(ref);
      if (!sc) return send(404, { status: false, message: "not found" });
      if (sc.mode === "http") return send(sc.code, { status: false, message: "error" });
      if (sc.mode === "hold") { held.push(() => send(200, { status: true, data: sc.tx })); return; }
      return send(200, { status: true, data: sc.tx });
    }
    send(404, { status: false });
  });
});

// ---------- helpers ----------
let pricing, jwt, issuesModule;
let seq = 0;
const newRef = () => `NF-${Date.now()}-${CUST_A}-pi${String(++seq).padStart(4, "0")}`;
function makePayment({ userId = CUST_A, productId = P1, qty = 1, addressId = null, status = "success", txOverrides = {}, mode = "tx", reference } = {}) {
  const ref = reference || newRef();
  const unit = 12000, total = unit * qty + 800;
  const snapshot = { v: 1, reference: ref, userId, addressId, couponId: null, currency: "GHS", subtotal: unit * qty, discount: 0, shipping: 800, total, lines: [{ productId, qty, offerId: null, unitPrice: unit, name: "Issues Test Scent" }] };
  const { payload, sig } = pricing.signSnapshot(snapshot);
  // authorization + customer are included on purpose: they must never be persisted or returned.
  const tx = { id: 4099260516, reference: ref, amount: total, currency: "GHS", status, channel: "mobile_money",
    customer: { email: "payer@example.invalid" }, authorization: { authorization_code: "AUTH_mocksecret123", last4: "4081", bin: "408408" },
    metadata: { nf_order: payload, nf_sig: sig }, ...txOverrides };
  scenarios.set(ref, { mode, tx });
  return { ref, snapshot, payload, sig, total, tx };
}
const tokenFor = (id, role = "customer") => jwt.sign({ id, role, v: 0 }, JWT_SECRET, { expiresIn: "10m" });
async function http_(method, pathname, { token, body, headers = {} } = {}) {
  const res = await realFetch(BASE + pathname, {
    method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  });
  const text = await res.text(); let data = {}; try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: res.status, data, text };
}
const verify = (ref, userId = CUST_A) => http_("GET", `/api/payments/verify/${encodeURIComponent(ref)}`, { token: tokenFor(userId) });
const sign = raw => crypto.createHmac("sha512", FAKE_PAYSTACK_KEY).update(raw).digest("hex");
async function webhook(event, { badSignature = false } = {}) {
  const raw = JSON.stringify(event);
  return http_("POST", "/api/payments/webhook", { body: raw, headers: { "x-paystack-signature": badSignature ? sign(raw + "x") : sign(raw) } });
}
const ADMIN_TOKEN = () => tokenFor(ADMIN, "admin");
const admin = (method, pathname, body) => http_(method, pathname, { token: ADMIN_TOKEN(), body });
const issueCount = () => store.issues.length;
const FORBIDDEN = /authorization|AUTH_mocksecret|last4|408408|nf_sig|nf_order|payer@example|sk_test|[a-f0-9]{64}/i;

// ======================================================================
// Unit: payment-issues.js
// ======================================================================
function unitTests() {
  issuesModule = require(path.join(SERVER, "payment-issues.js"));
  const M = issuesModule;
  const ev = { paystackVerified: true, amountPesewas: 12800, currency: "GHS", snapshotValid: true, userId: CUST_A, expectedTotal: 12800 };
  const cls = (r, o) => M.classifySettlement(r, o);
  const kinds = [
    ["created → resolve", cls({ outcome: "created", orderId: 5 }, { source: "callback" }), d => d && d.kind === "resolve" && d.orderId === 5],
    ["out_of_stock → settlement_blocked", cls({ outcome: "out_of_stock", code: "PAID_OUT_OF_STOCK", details: { productId: P2 }, evidence: ev }, { source: "callback" }), d => d.spec.category === "settlement_blocked" && d.spec.detail_product_id === P2],
    ["archived product → settlement_blocked", cls({ outcome: "out_of_stock", code: "PAID_PRODUCT_UNAVAILABLE", details: { productId: P3 }, evidence: ev }, { source: "webhook" }), d => d.spec.category === "settlement_blocked" && d.spec.last_error_code === "PAID_PRODUCT_UNAVAILABLE"],
    ["COUPON_USED_UP → settlement_blocked", cls({ outcome: "rejected", code: "COUPON_USED_UP", evidence: ev }, { source: "callback" }), d => d.spec.category === "settlement_blocked"],
    ["PAID_ADDRESS_MISSING → settlement_blocked", cls({ outcome: "rejected", code: "PAID_ADDRESS_MISSING", evidence: ev }, { source: "callback" }), d => d.spec.category === "settlement_blocked"],
    ...["AMOUNT_MISMATCH", "CURRENCY_MISMATCH", "REFERENCE_MISMATCH", "PAYMENT_METADATA_INVALID"].map(c => [`${c} → integrity_mismatch`, cls({ outcome: "rejected", code: c, evidence: ev }, { source: "callback" }), d => d.spec.category === "integrity_mismatch" && d.spec.last_error_code === c]),
    ["database error → settlement_error (code only)", cls({ outcome: "error", err: Object.assign(new Error("SELECT * FROM secrets WHERE x='y'"), { code: "ER_LOCK_DEADLOCK" }), evidence: ev }, { source: "webhook" }), d => d.spec.category === "settlement_error" && d.spec.last_error_code === "ER_LOCK_DEADLOCK"],
    ["signed webhook temporary → unverified_charge", cls({ outcome: "temporary" }, { source: "webhook", signedWebhook: true }), d => d.spec.category === "unverified_charge" && d.spec.evidence === "signed_webhook" && d.spec.amount_pesewas === null],
    ["signed webhook pending → unverified_charge (PAYMENT_PENDING)", cls({ outcome: "pending" }, { source: "webhook", signedWebhook: true }), d => d.spec.last_error_code === "PAYMENT_PENDING"],
  ];
  const badKinds = kinds.filter(([, d, ok]) => !ok(d)).map(([n]) => n);
  check("U1 qualifying outcomes map to the approved categories", badKinds.length === 0, badKinds);
  const none = [
    ["callback temporary", cls({ outcome: "temporary" }, { source: "callback" })],
    ["callback pending", cls({ outcome: "pending" }, { source: "callback" })],
    ["webhook temporary WITHOUT a verified signature", cls({ outcome: "temporary" }, { source: "webhook", signedWebhook: false })],
    ["definitive failure (no verified evidence)", cls({ outcome: "rejected", code: "PAYMENT_NOT_SUCCESSFUL", evidence: null }, { source: "webhook", signedWebhook: true })],
    ["wrong user", cls({ outcome: "rejected", code: "PAYMENT_USER_MISMATCH", evidence: ev }, { source: "callback" })],
    ["busy", cls({ outcome: "busy" }, { source: "webhook", signedWebhook: true })],
    ["integrity code without Paystack-verified evidence", cls({ outcome: "rejected", code: "AMOUNT_MISMATCH", evidence: null }, { source: "callback" })],
    ["database error before verification", cls({ outcome: "error", err: new Error("x"), evidence: null }, { source: "webhook", signedWebhook: true })],
  ].filter(([, d]) => d !== null).map(([n]) => n);
  check("U2 non-qualifying outcomes record nothing", none.length === 0, none);
  check("U3 an admin retry that doesn't settle is only an observation", cls({ outcome: "temporary" }, { source: "admin_retry" }).kind === "observe");
  const forged = cls({ outcome: "rejected", code: "PAYMENT_METADATA_INVALID", evidence: { paystackVerified: true, amountPesewas: 500, currency: "GHS", snapshotValid: false, userId: CUST_B, expectedTotal: 1 } }, { source: "callback" });
  check("U4 an invalid snapshot never supplies user_id or expected_total", forged.spec.user_id === null && forged.spec.expected_total_pesewas === null && forged.spec.amount_pesewas === 500);
  check("U5 database errors are stored by code only, never their message", M.safeErrorCode({ code: "ER_DUP_ENTRY", message: "secret" }) === "ER_DUP_ENTRY" && M.safeErrorCode(new Error("boom")) === "DB_ERROR" && M.safeErrorCode({ code: "bad code; DROP" }) === "DB_ERROR");
  check("U6 evidence precedence: verified replaces anything open; webhook-only never replaces verified; resolved never changes",
    M.canUpgrade({ status: "open", evidence: "signed_webhook" }, { evidence: "paystack_verified" }) && M.canUpgrade({ status: "open", evidence: "signed_webhook" }, { evidence: "signed_webhook" })
    && !M.canUpgrade({ status: "open", evidence: "paystack_verified" }, { evidence: "signed_webhook" }) && !M.canUpgrade({ status: "resolved", evidence: "signed_webhook" }, { evidence: "paystack_verified" }));
  const lq = M.parseListQuery({ status: "all", category: "settlement_error", evidence: "paystack_verified", from: "2026-10-01", to: "2026-10-31", q: "NF-123", page: "2", pageSize: "500" });
  check("U7 list filters are validated and built in a fixed order (pageSize capped at 100)", lq.where === "WHERE pi.category = ? AND pi.evidence = ? AND pi.last_seen_at >= ? AND pi.last_seen_at <= ? AND pi.payment_reference LIKE ?" && lq.pageSize === 100 && lq.page === 2);
  const badQ = [{ status: "closed" }, { category: "x" }, { evidence: "callback" }, { from: "1/10/2026" }, { q: "NF-1' OR 1=1" }].filter(q => !M.parseListQuery(q).error);
  check("U8 invalid list filters are rejected", badQ.length === 0, badQ);
  const vr = M.validateResolution;
  check("U9 manual resolution: settled refused, unknown value refused, note required (1–500, trimmed)",
    vr({ resolution: "settled", note: "x" }).field === "resolution" && vr({ resolution: "paid", note: "x" }).field === "resolution"
    && vr({ resolution: "no_action_needed" }).field === "note" && vr({ resolution: "no_action_needed", note: "   " }).field === "note"
    && vr({ resolution: "no_action_needed", note: "x".repeat(501) }).field === "note" && vr({ resolution: "duplicate_payment", note: "  ok  " }).values.note === "ok");
  const pa = M.parseAmountPesewas;
  check("U10 amounts: integer numbers or digit strings only — booleans, decimals, negatives, empty and objects rejected",
    pa(12800) === 12800 && pa("12800") === 12800 && pa(0) === 0 && pa(true) === null && pa(false) === null && pa(1.5) === null
    && pa(-1) === null && pa("") === null && pa("12.5") === null && pa(null) === null && pa({}) === null && pa("1e3") === null);
  check("U11 retryability: open + retryable category only, never a deleted address or integrity mismatch",
    M.isRetryable({ status: "open", category: "settlement_blocked", last_error_code: "PAID_OUT_OF_STOCK" })
    && !M.isRetryable({ status: "open", category: "settlement_blocked", last_error_code: "PAID_ADDRESS_MISSING" })
    && !M.isRetryable({ status: "open", category: "integrity_mismatch", last_error_code: "AMOUNT_MISMATCH" })
    && !M.isRetryable({ status: "resolved", category: "settlement_error", last_error_code: "ER_X" }));
  check("U12 an open settlement_blocked issue is not replaced by a later settlement_error",
    !M.canUpgrade({ status: "open", evidence: "paystack_verified", category: "settlement_blocked" }, { evidence: "paystack_verified", category: "settlement_error" })
    && M.canUpgrade({ status: "open", evidence: "paystack_verified", category: "settlement_error" }, { evidence: "paystack_verified", category: "settlement_blocked" }));
  const msgs = [
    M.adminRetryMessage({ outcome: "out_of_stock", code: "PAID_OUT_OF_STOCK", error: "CUSTOMER TEXT" }),
    M.adminRetryMessage({ outcome: "out_of_stock", code: "PAID_PRODUCT_UNAVAILABLE" }),
    M.adminRetryMessage({ outcome: "rejected", code: "PAID_ADDRESS_MISSING", error: "Your payment was received… Please contact us" }),
    M.adminRetryMessage({ outcome: "rejected", code: "AMOUNT_MISMATCH", error: "The amount paid does not match your order. Please contact us" }),
    M.adminRetryMessage({ outcome: "rejected", code: "COUPON_USED_UP", error: "This coupon has reached its usage limit." }),
  ];
  check("U13 admin retry messages are admin-facing and never echo the customer wording",
    /enough stock/.test(msgs[0]) && /archived or no longer exists/.test(msgs[1]) && /address .*deleted/.test(msgs[2]) && /AMOUNT_MISMATCH/.test(msgs[3]) && /usage limit/.test(msgs[4])
    && msgs.every(m => !/CUSTOMER TEXT|Your payment was received|Please contact us/.test(m)), msgs);
}

// ======================================================================
// Integration: real server.js, fake pool, mock Paystack
// ======================================================================
async function integrationTests() {
  await new Promise(r => mock.listen(MOCK_PORT, "127.0.0.1", r));
  require(path.join(SERVER, "server.js"));
  pricing = require(path.join(SERVER, "pricing.js"));
  jwt = require(path.join(SERVER, "node_modules/jsonwebtoken"));
  check("I0 server.js is using the in-memory fake database", require(path.join(SERVER, "db.js")) === fakePool);
  for (let i = 0; i < 50; i++) { try { await realFetch(BASE + "/"); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }

  // ---- 1. qualifying outcomes ----
  const soldOut = makePayment({ productId: P2 });
  let r = await verify(soldOut.ref);
  let i = issueByRef(soldOut.ref);
  check("R1 sold out after payment: 409 unchanged; issue settlement_blocked / PAID_OUT_OF_STOCK with trusted fields",
    r.status === 409 && r.data.code === "PAID_OUT_OF_STOCK" && i && i.category === "settlement_blocked" && i.evidence === "paystack_verified" && i.last_error_code === "PAID_OUT_OF_STOCK"
    && i.detail_product_id === P2 && i.amount_pesewas === soldOut.total && i.currency === "GHS" && i.user_id === CUST_A && i.expected_total_pesewas === soldOut.total && i.first_source === "callback",
    { status: r.status, issue: i });

  const archived = makePayment({ productId: P3 });
  const p3Stock = store.products[P3].stock_qty;
  r = await verify(archived.ref);
  i = issueByRef(archived.ref);
  check("R2 PI-06 archived product: 409 PAID_PRODUCT_UNAVAILABLE (not 'sold out'), issue recorded, no order, stock untouched",
    r.status === 409 && r.data.code === "PAID_PRODUCT_UNAVAILABLE" && /no longer available/.test(r.data.error) && i && i.last_error_code === "PAID_PRODUCT_UNAVAILABLE" && i.detail_product_id === P3 && !orderByRef(archived.ref) && store.products[P3].stock_qty === p3Stock,
    { status: r.status, code: r.data.code });

  const noAddr = makePayment({ addressId: 880099 });
  const p1Before = store.products[P1].stock_qty;
  r = await verify(noAddr.ref);
  i = issueByRef(noAddr.ref);
  check("R3 PI-06 deleted delivery address: 409 PAID_ADDRESS_MISSING, no substitute address, no order, stock untouched, issue recorded",
    r.status === 409 && r.data.code === "PAID_ADDRESS_MISSING" && !orderByRef(noAddr.ref) && store.products[P1].stock_qty === p1Before && i && i.category === "settlement_blocked" && i.last_error_code === "PAID_ADDRESS_MISSING",
    { status: r.status, code: r.data.code });
  const noAddrHook = makePayment({ addressId: 880098 });
  r = await webhook({ event: "charge.success", data: { reference: noAddrHook.ref } });
  check("R4 …via the webhook: 200 rejected (retrying can't bring the address back), issue first_source webhook", r.status === 200 && r.data.rejected === "PAID_ADDRESS_MISSING" && issueByRef(noAddrHook.ref)?.first_source === "webhook", r.data);
  const withAddr = makePayment({ addressId: ADDR_A });
  r = await verify(withAddr.ref);
  check("R5 an existing address still settles normally (order keeps that address), no issue", r.status === 201 && orderByRef(withAddr.ref)?.address_id === ADDR_A && !issueByRef(withAddr.ref), r.status);

  const amountHook = makePayment({ txOverrides: { amount: 100 } });
  r = await webhook({ event: "charge.success", data: { reference: amountHook.ref } });
  i = issueByRef(amountHook.ref);
  check("R6 amount mismatch (webhook): 200 rejected; issue integrity_mismatch with Paystack's amount, user from the valid snapshot",
    r.status === 200 && r.data.rejected === "AMOUNT_MISMATCH" && i && i.category === "integrity_mismatch" && i.amount_pesewas === 100 && i.user_id === CUST_A && i.expected_total_pesewas === amountHook.total, i);

  const forged = makePayment();
  scenarios.get(forged.ref).tx.metadata = { nf_order: JSON.stringify({ ...forged.snapshot, userId: CUST_B, total: 1 }), nf_sig: forged.sig };
  r = await verify(forged.ref);
  i = issueByRef(forged.ref);
  check("R7 invalid snapshot: 400 PAYMENT_METADATA_INVALID; issue has NO user_id / expected total (never taken from a bad snapshot)",
    r.status === 400 && r.data.code === "PAYMENT_METADATA_INVALID" && i && i.category === "integrity_mismatch" && i.user_id === null && i.expected_total_pesewas === null && i.amount_pesewas === forged.total, i);

  const dbFail = makePayment();
  fake.failOrderInsert = true;
  r = await verify(dbFail.ref);
  fake.failOrderInsert = false;
  i = issueByRef(dbFail.ref);
  check("R8 database failure after Paystack confirmed: 500 SETTLEMENT_ERROR unchanged; issue settlement_error stores the code only",
    r.status === 500 && r.data.code === "SETTLEMENT_ERROR" && i && i.category === "settlement_error" && i.last_error_code === "ER_LOCK_DEADLOCK" && !/secret/.test(JSON.stringify(i)), i);

  const tempHook = makePayment();
  scenarios.set(tempHook.ref, { mode: "http", code: 500 });
  r = await webhook({ event: "charge.success", data: { reference: tempHook.ref } });
  i = issueByRef(tempHook.ref);
  check("R9 signed webhook, Paystack unreachable: 503 unchanged; issue unverified_charge / signed_webhook with no amounts",
    r.status === 503 && i && i.category === "unverified_charge" && i.evidence === "signed_webhook" && i.last_error_code === "PAYMENT_VERIFY_UNAVAILABLE" && i.amount_pesewas === null && i.user_id === null, i);
  const pendHook = makePayment({ status: "ongoing" });
  r = await webhook({ event: "charge.success", data: { reference: pendHook.ref } });
  check("R10 signed webhook, Paystack still pending: issue unverified_charge / PAYMENT_PENDING", r.status === 503 && issueByRef(pendHook.ref)?.last_error_code === "PAYMENT_PENDING");

  // ---- 2. non-qualifying outcomes create nothing ----
  const before = issueCount();
  const cTemp = makePayment(); scenarios.set(cTemp.ref, { mode: "http", code: 500 });
  const cPend = makePayment({ status: "pending" });
  const cFail = makePayment({ status: "failed" });
  const cWrongUser = makePayment();
  const hFail = makePayment({ status: "failed" });
  const results = [
    await verify(cTemp.ref), await verify(cPend.ref), await verify(cFail.ref),
    await verify(newRef()),                                   // arbitrary (unknown) reference
    await http_("GET", "/api/payments/verify/not-a-reference", { token: tokenFor(CUST_A) }),
    await verify(cWrongUser.ref, CUST_B),
    await webhook({ event: "charge.success", data: { reference: hFail.ref } }),
    await webhook({ event: "transfer.success", data: { reference: hFail.ref } }),
    await webhook({ event: "charge.success", data: { reference: "bad ref" } }),
    await webhook({ event: "charge.success", data: { reference: newRef() } }, { badSignature: true }),
  ];
  check("N1 callback temporary/pending/failed, unknown or invalid references, wrong user, webhook failure/unrelated/invalid/forged: no issue rows",
    issueCount() === before && results.map(x => x.status).join() === "503,202,400,503,400,403,200,200,200,401", { statuses: results.map(x => x.status), added: issueCount() - before });

  // ---- 3. evidence precedence ----
  const prec = makePayment();
  scenarios.set(prec.ref, { mode: "http", code: 502 });
  await webhook({ event: "charge.success", data: { reference: prec.ref } });
  const p0 = { ...issueByRef(prec.ref) };
  scenarios.set(prec.ref, { mode: "tx", tx: { ...prec.tx, amount: 1 } });
  await verify(prec.ref);
  const p1 = { ...issueByRef(prec.ref) };
  scenarios.set(prec.ref, { mode: "http", code: 503 });
  await webhook({ event: "charge.success", data: { reference: prec.ref } });
  const p2 = { ...issueByRef(prec.ref) };
  check("P1 webhook-only evidence is upgraded by later Paystack-verified evidence (one row)", p0.evidence === "signed_webhook" && p1.evidence === "paystack_verified" && p1.category === "integrity_mismatch" && p1.amount_pesewas === 1 && p1.attempt_count === 2 && store.issues.filter(x => x.payment_reference === prec.ref).length === 1, { p0, p1 });
  check("P2 …and a later webhook-only observation never downgrades it (only the counters move)", p2.evidence === "paystack_verified" && p2.category === "integrity_mismatch" && p2.amount_pesewas === 1 && p2.last_error_code === "AMOUNT_MISMATCH" && p2.attempt_count === 3 && p2.last_source === "webhook", p2);

  // ---- 5/6. existing-order guard + automatic resolution ----
  r = await verify(dbFail.ref); // the database has recovered
  i = issueByRef(dbFail.ref);
  check("A1 a later successful settlement resolves the open issue as settled, links the order, no new row",
    r.status === 201 && i.status === "resolved" && i.resolution === "settled" && i.order_id === r.data.orderId && i.resolved_by === null && store.issues.filter(x => x.payment_reference === dbFail.ref).length === 1, i);
  const guard = await issuesModule.recordIssue(fakePool, dbFail.ref, { evidence: "paystack_verified", category: "settlement_error", last_error_code: "ER_X", user_id: null, amount_pesewas: null, currency: null, expected_total_pesewas: null, detail_product_id: null }, "webhook", { referencePattern: /^NF-[A-Za-z0-9-]{8,80}$/ });
  const settledRef = withAddr.ref;
  const guard2 = await issuesModule.recordIssue(fakePool, settledRef, { evidence: "paystack_verified", category: "settlement_error", last_error_code: "ER_X", user_id: null, amount_pesewas: null, currency: null, expected_total_pesewas: null, detail_product_id: null }, "webhook", { referencePattern: /^NF-[A-Za-z0-9-]{8,80}$/ });
  const dbFailRow = issueByRef(dbFail.ref);
  check("A2 existing-order guard: a late failure for an already-settled reference creates no issue and leaves the resolved one untouched",
    guard2.action === "skipped_order_exists" && !issueByRef(settledRef) && guard.action === "skipped_order_exists" && dbFailRow.status === "resolved" && dbFailRow.last_error_code === "ER_LOCK_DEADLOCK" && dbFailRow.attempt_count === 1, { guard, guard2, dbFailRow });

  // ---- 7. issue-write failure never changes the payment response ----
  fake.failIssueWrites = true;
  const okWhileDown = makePayment();
  r = await verify(okWhileDown.ref);
  const soldWhileDown = makePayment({ productId: P2 });
  const r2 = await verify(soldWhileDown.ref);
  fake.failIssueWrites = false;
  check("W1 issue store failing: a successful settlement still answers 201 with its order; a blocked one still answers 409 PAID_OUT_OF_STOCK",
    r.status === 201 && r.data.orderId && orderByRef(okWhileDown.ref) && r2.status === 409 && r2.data.code === "PAID_OUT_OF_STOCK" && !issueByRef(soldWhileDown.ref), [r.status, r2.status]);

  // ---- 12. admin authorisation ----
  const noTok = await http_("GET", "/api/admin/payment-issues");
  const custTok = await http_("GET", "/api/admin/payment-issues", { token: tokenFor(CUST_A) });
  const custRetry = await http_("POST", "/api/admin/payment-issues/1/retry", { token: tokenFor(CUST_A), body: {} });
  const custResolve = await http_("POST", "/api/admin/payment-issues/1/resolve", { token: tokenFor(CUST_A), body: { resolution: "no_action_needed", note: "x" } });
  check("AD1 admin routes: 401 without a token, 403 for a customer (requireAdmin) — list, retry and resolve", noTok.status === 401 && custTok.status === 403 && custRetry.status === 403 && custResolve.status === 403, [noTok.status, custTok.status, custRetry.status, custResolve.status]);

  // ---- admin list + detail ----
  let list = await admin("GET", "/api/admin/payment-issues");
  check("AD2 list defaults to open issues, newest first, with counts and pagination fields", list.status === 200 && list.data.issues.every(x => x.status === "open") && list.data.status_counts.resolved >= 1 && list.data.total === list.data.status_counts.open && list.data.page === 1, { status: list.status, counts: list.data.status_counts });
  const blockedOnly = await admin("GET", "/api/admin/payment-issues?category=settlement_blocked&evidence=paystack_verified&status=all");
  const byRef = await admin("GET", `/api/admin/payment-issues?status=all&q=${encodeURIComponent(soldOut.ref.slice(-8))}`);
  const resolvedOnly = await admin("GET", "/api/admin/payment-issues?status=resolved");
  const page2 = await admin("GET", "/api/admin/payment-issues?status=all&pageSize=2&page=2");
  check("AD3 filters: category + evidence, reference search, resolved tab, page size", blockedOnly.data.issues.length >= 3 && blockedOnly.data.issues.every(x => x.category === "settlement_blocked")
    && byRef.data.issues.length === 1 && byRef.data.issues[0].payment_reference === soldOut.ref && resolvedOnly.data.issues.every(x => x.status === "resolved") && page2.data.issues.length === 2 && page2.data.page === 2);
  const badFilter = await admin("GET", "/api/admin/payment-issues?status=closed");
  check("AD4 an invalid filter is a 400 with its field", badFilter.status === 400 && badFilter.data.field === "status");
  const soldIssue = issueByRef(soldOut.ref);
  const detail = await admin("GET", `/api/admin/payment-issues/${soldIssue.id}`);
  check("AD5 detail: safe metadata, customer and product names, retry_allowed", detail.status === 200 && detail.data.payment_reference === soldOut.ref && detail.data.customer_name === "Customer A" && detail.data.detail_product_name === "Issues Sold Out" && detail.data.retry_allowed === true && detail.data.linked_order === null, detail.data);
  check("AD6 unknown issue id → 404; non-numeric id → 404", (await admin("GET", "/api/admin/payment-issues/999999")).status === 404 && (await admin("GET", "/api/admin/payment-issues/abc")).status === 404);

  // ---- 9/10. retry ----
  const integ = issueByRef(amountHook.ref);
  const hitsBefore = verifyHits.get(amountHook.ref) || 0;
  r = await admin("POST", `/api/admin/payment-issues/${integ.id}/retry`, {});
  check("RT1 integrity_mismatch can't be retried: 409 RETRY_NOT_ALLOWED and Paystack is not asked", r.status === 409 && r.data.code === "RETRY_NOT_ALLOWED" && (verifyHits.get(amountHook.ref) || 0) === hitsBefore, r.data);
  const resolvedIssue = issueByRef(dbFail.ref);
  r = await admin("POST", `/api/admin/payment-issues/${resolvedIssue.id}/retry`, {});
  check("RT2 a resolved issue can't be retried: 409 ALREADY_RESOLVED", r.status === 409 && r.data.code === "ALREADY_RESOLVED");
  const tempIssue = issueByRef(tempHook.ref);
  const ordersBefore = store.orders.length;
  r = await admin("POST", `/api/admin/payment-issues/${tempIssue.id}/retry`, {});
  check("RT3 retry while Paystack is still unreachable: re-verified, not settled, no order, issue still open with the attempt counted",
    r.status === 200 && r.data.settled === false && r.data.outcome === "temporary" && store.orders.length === ordersBefore && issueByRef(tempHook.ref).status === "open" && issueByRef(tempHook.ref).attempt_count === 2 && issueByRef(tempHook.ref).last_source === "admin_retry" && verifyHits.get(tempHook.ref) === 2, r.data);
  scenarios.set(tempHook.ref, { mode: "tx", tx: { ...tempHook.tx, status: "failed" } });
  r = await admin("POST", `/api/admin/payment-issues/${tempIssue.id}/retry`, {});
  check("RT4 retry when Paystack says the payment failed: no order is created and nothing is marked paid", r.status === 200 && r.data.settled === false && r.data.code === "PAYMENT_NOT_SUCCESSFUL" && store.orders.length === ordersBefore && issueByRef(tempHook.ref).status === "open", r.data);
  store.products[P2].stock_qty = 5; // restocked
  const p2Before = store.products[P2].stock_qty, soldHits = verifyHits.get(soldOut.ref);
  r = await admin("POST", `/api/admin/payment-issues/${soldIssue.id}/retry`, {});
  i = issueByRef(soldOut.ref);
  check("RT5 retry after a restock: Paystack re-verified, order created through settlement, issue resolved settled by this admin, stock taken once",
    r.status === 200 && r.data.settled === true && r.data.outcome === "created" && orderByRef(soldOut.ref)?.id === r.data.order_id && i.status === "resolved" && i.resolution === "settled" && i.resolved_by === ADMIN && i.order_id === r.data.order_id && store.products[P2].stock_qty === p2Before - 1 && verifyHits.get(soldOut.ref) === soldHits + 1, { data: r.data, issue: i });
  r = await admin("POST", `/api/admin/payment-issues/${soldIssue.id}/retry`, {});
  check("RT6 a second retry of the same (now resolved) issue is refused and creates nothing", r.status === 409 && r.data.code === "ALREADY_RESOLVED" && store.orders.filter(o => o.payment_reference === soldOut.ref).length === 1);
  check("RT7 there is no 'mark paid' route", (await admin("POST", `/api/admin/payment-issues/${tempIssue.id}/mark-paid`, {})).status === 404 && (await admin("POST", `/api/admin/payment-issues/${tempIssue.id}/resolve`, { resolution: "settled", note: "customer sent a screenshot" })).status === 400);

  // ---- 11. manual resolution ----
  const pendIssue = issueByRef(pendHook.ref);
  const v1 = await admin("POST", `/api/admin/payment-issues/${pendIssue.id}/resolve`, { resolution: "refund", note: "x" });
  const v2 = await admin("POST", `/api/admin/payment-issues/${pendIssue.id}/resolve`, { resolution: "no_action_needed" });
  const v3 = await admin("POST", `/api/admin/payment-issues/${pendIssue.id}/resolve`, { resolution: "no_action_needed", note: "x".repeat(501) });
  check("M1 invalid resolution, missing note and oversized note are 400s with their field", v1.status === 400 && v1.data.field === "resolution" && v2.status === 400 && v2.data.field === "note" && v3.status === 400 && v3.data.field === "note" && issueByRef(pendHook.ref).status === "open");
  r = await admin("POST", `/api/admin/payment-issues/${pendIssue.id}/resolve`, { resolution: "refunded_externally", note: "  Refunded in Paystack dashboard, ref RF-1.  " });
  i = issueByRef(pendHook.ref);
  check("M2 a valid resolution closes the issue with the trimmed note and this admin", r.status === 200 && i.status === "resolved" && i.resolution === "refunded_externally" && i.resolution_note === "Refunded in Paystack dashboard, ref RF-1." && i.resolved_by === ADMIN, i);
  r = await admin("POST", `/api/admin/payment-issues/${pendIssue.id}/resolve`, { resolution: "no_action_needed", note: "second try" });
  check("M3 resolving again is 409 ALREADY_RESOLVED and changes nothing", r.status === 409 && r.data.code === "ALREADY_RESOLVED" && issueByRef(pendHook.ref).resolution === "refunded_externally" && issueByRef(pendHook.ref).resolution_note === "Refunded in Paystack dashboard, ref RF-1.");
  const frozenBefore = { ...issueByRef(pendHook.ref) };
  await webhook({ event: "charge.success", data: { reference: pendHook.ref } }); // Paystack still "ongoing"
  const frozenAfter = { ...issueByRef(pendHook.ref) };
  check("M4 a later observation never reopens a resolved issue or touches its resolution", frozenAfter.status === "resolved" && frozenAfter.resolution === frozenBefore.resolution && frozenAfter.resolution_note === frozenBefore.resolution_note && frozenAfter.resolved_by === frozenBefore.resolved_by && String(frozenAfter.resolved_at) === String(frozenBefore.resolved_at) && frozenAfter.attempt_count === frozenBefore.attempt_count + 1, { frozenBefore, frozenAfter });

  // ORDER_EXISTS: settle a blocked issue while the automatic resolve fails, so the issue
  // stays open although its order exists.
  const oe = makePayment({ productId: P2 });
  store.products[P2].stock_qty = 0;
  await verify(oe.ref);
  const oeIssue = issueByRef(oe.ref);
  store.products[P2].stock_qty = 3;
  fake.failResolveOnly = true;
  r = await verify(oe.ref);
  fake.failResolveOnly = false;
  check("M5 setup: order created but the automatic resolve failed, so the issue is still open", r.status === 201 && issueByRef(oe.ref).status === "open" && !!orderByRef(oe.ref));
  r = await admin("POST", `/api/admin/payment-issues/${oeIssue.id}/resolve`, { resolution: "no_action_needed", note: "closing" });
  check("M6 manual resolution is refused with 409 ORDER_EXISTS while an order exists", r.status === 409 && r.data.code === "ORDER_EXISTS" && issueByRef(oe.ref).status === "open", r.data);
  const det = await admin("GET", `/api/admin/payment-issues/${oeIssue.id}`);
  check("M7 the detail shows the linked order (has_order) for the admin", det.data.has_order === true && det.data.linked_order && det.data.linked_order.id === orderByRef(oe.ref).id);
  r = await admin("POST", `/api/admin/payment-issues/${oeIssue.id}/retry`, {});
  check("M8 Retry settlement links the existing order (already processed) and resolves the issue — still exactly one order", r.data.settled === true && r.data.outcome === "already_processed" && issueByRef(oe.ref).status === "resolved" && issueByRef(oe.ref).order_id === orderByRef(oe.ref).id && store.orders.filter(o => o.payment_reference === oe.ref).length === 1, r.data);

  // ---- double-submitted retry ----
  const hold = makePayment(); fake.failOrderInsert = true; await verify(hold.ref); fake.failOrderInsert = false;
  const holdIssue = issueByRef(hold.ref);
  scenarios.set(hold.ref, { mode: "hold", tx: hold.tx });
  const first = admin("POST", `/api/admin/payment-issues/${holdIssue.id}/retry`, {});
  for (let k = 0; k < 50 && !held.length; k++) await new Promise(res => setTimeout(res, 20));
  const second = await admin("POST", `/api/admin/payment-issues/${holdIssue.id}/retry`, {});
  held.splice(0).forEach(fn => fn());
  const firstRes = await first;
  check("RT8 a double-submitted retry: the second is 409 RETRY_IN_PROGRESS, the first settles once", second.status === 409 && second.data.code === "RETRY_IN_PROGRESS" && firstRes.data.settled === true && store.orders.filter(o => o.payment_reference === hold.ref).length === 1, [second.status, firstRes.data]);

  // ---- 15. interleaving without a database lock ----
  const il = makePayment(); fake.failOrderInsert = true; await verify(il.ref); fake.failOrderInsert = false;
  const ilIssue = issueByRef(il.ref);
  const stockBefore = store.products[P1].stock_qty;
  const barrier = fake.barrier = { count: 2, waiting: [], active: true };
  const [ra, rb] = await Promise.all([
    admin("POST", `/api/admin/payment-issues/${ilIssue.id}/retry`, {}),
    webhook({ event: "charge.success", data: { reference: il.ref } }),
  ]);
  fake.barrier = null;
  i = issueByRef(il.ref);
  check("IL1 admin retry and webhook race past the existing-order check together (GET_LOCK granted to both): exactly one order, stock taken once",
    barrier.releasedWith === 2 && store.orders.filter(o => o.payment_reference === il.ref).length === 1 && store.products[P1].stock_qty === stockBefore - 1 && store.orderItems.filter(x => x.order_id === orderByRef(il.ref).id).length === 1, { stockBefore, now: store.products[P1].stock_qty, ra: ra.data, rb: rb.data });
  check("IL2 …both callers see the one order (created / already processed) and the issue is resolved once, linked to it",
    ra.data.settled === true && rb.status === 200 && rb.data.orderId === orderByRef(il.ref).id && i.status === "resolved" && i.resolution === "settled" && i.order_id === orderByRef(il.ref).id, { ra: ra.data, rb: rb.data, issue: i });

  // ---- review corrections ----
  const refMis = makePayment({ txOverrides: { reference: "NF-0000000000-1-otherref" } });
  r = await verify(refMis.ref);
  i = issueByRef(refMis.ref);
  check("RC1 reference mismatch: issue recorded with NO amount or currency (they belong to another transaction)",
    r.status === 400 && r.data.code === "REFERENCE_MISMATCH" && i && i.category === "integrity_mismatch" && i.amount_pesewas === null && i.currency === null, i);

  const addrIssue = issueByRef(noAddr.ref);
  const addrHits = verifyHits.get(noAddr.ref) || 0;
  r = await admin("POST", `/api/admin/payment-issues/${addrIssue.id}/retry`, {});
  const addrDetail = await admin("GET", `/api/admin/payment-issues/${addrIssue.id}`);
  check("RC2 deleted-address issues can't be retried: 409 RETRY_NOT_ALLOWED, Paystack not asked, retry_allowed false",
    r.status === 409 && r.data.code === "RETRY_NOT_ALLOWED" && (verifyHits.get(noAddr.ref) || 0) === addrHits && addrDetail.data.retry_allowed === false, r.data);

  store.products[P2].stock_qty = 0;
  const blocked = makePayment({ productId: P2 });
  await verify(blocked.ref);
  const blockedIssue = issueByRef(blocked.ref);
  r = await admin("POST", `/api/admin/payment-issues/${blockedIssue.id}/retry`, {});
  check("RC3 retry still out of stock: admin-facing message, no order, blocking code kept", r.status === 200 && r.data.settled === false && /enough stock/.test(r.data.message) && !/Please contact us/.test(r.data.message) && !orderByRef(blocked.ref) && issueByRef(blocked.ref).last_error_code === "PAID_OUT_OF_STOCK", r.data);
  scenarios.set(blocked.ref, { mode: "tx", tx: { ...blocked.tx, status: "ongoing" } });
  const attemptsBefore = issueByRef(blocked.ref).attempt_count;
  r = await admin("POST", `/api/admin/payment-issues/${blockedIssue.id}/retry`, {});
  check("RC4 a pending retry keeps the original blocking reason (PAID_OUT_OF_STOCK), counting the attempt only",
    r.data.outcome === "pending" && issueByRef(blocked.ref).last_error_code === "PAID_OUT_OF_STOCK" && issueByRef(blocked.ref).category === "settlement_blocked" && issueByRef(blocked.ref).attempt_count === attemptsBefore + 1, issueByRef(blocked.ref));
  scenarios.set(blocked.ref, { mode: "tx", tx: blocked.tx });
  store.products[P2].stock_qty = 5;
  fake.failOrderInsert = true;
  r = await admin("POST", `/api/admin/payment-issues/${blockedIssue.id}/retry`, {});
  fake.failOrderInsert = false;
  check("RC5 a database error on retry doesn't replace the blocking reason either", r.data.outcome === "error" && issueByRef(blocked.ref).category === "settlement_blocked" && issueByRef(blocked.ref).last_error_code === "PAID_OUT_OF_STOCK" && !orderByRef(blocked.ref), issueByRef(blocked.ref));

  // Manual resolution refused while a retry of the same issue is running (this process).
  const busyPay = makePayment(); fake.failOrderInsert = true; await verify(busyPay.ref); fake.failOrderInsert = false;
  const busyIssue = issueByRef(busyPay.ref);
  scenarios.set(busyPay.ref, { mode: "hold", tx: busyPay.tx });
  const runningRetry = admin("POST", `/api/admin/payment-issues/${busyIssue.id}/retry`, {});
  for (let k = 0; k < 50 && !held.length; k++) await new Promise(res => setTimeout(res, 20));
  const resolveDuring = await admin("POST", `/api/admin/payment-issues/${busyIssue.id}/resolve`, { resolution: "no_action_needed", note: "closing during retry" });
  held.splice(0).forEach(fn => fn());
  const retryDone = await runningRetry;
  check("RC6 manual resolution during a running retry of the same issue: 409 RETRY_IN_PROGRESS; the retry then settles it", resolveDuring.status === 409 && resolveDuring.data.code === "RETRY_IN_PROGRESS" && retryDone.data.settled === true && issueByRef(busyPay.ref).resolution === "settled", [resolveDuring.status, retryDone.data.outcome]);

  // A settlement that commits AFTER a manual decision: the decision is kept, the order linked, the conflict flagged.
  const late = makePayment();
  scenarios.set(late.ref, { mode: "http", code: 503 });
  await webhook({ event: "charge.success", data: { reference: late.ref } });
  const lateIssue = issueByRef(late.ref);
  r = await admin("POST", `/api/admin/payment-issues/${lateIssue.id}/resolve`, { resolution: "no_action_needed", note: "Paystack shows nothing yet" });
  makePayment({ reference: late.ref }); // Paystack later confirms the same reference
  const lateHook = await webhook({ event: "charge.success", data: { reference: late.ref } });
  i = issueByRef(late.ref);
  const lateDetail = await admin("GET", `/api/admin/payment-issues/${lateIssue.id}`);
  const lateList = await admin("GET", `/api/admin/payment-issues?status=resolved&q=${encodeURIComponent(late.ref.slice(-8))}`);
  check("RC7 order committed after a manual decision: resolution kept (not rewritten as settled), order linked, admin, note and time unchanged",
    r.status === 200 && lateHook.status === 200 && !!orderByRef(late.ref) && i.status === "resolved" && i.resolution === "no_action_needed" && i.resolution_note === "Paystack shows nothing yet" && i.resolved_by === ADMIN && i.order_id === orderByRef(late.ref).id, i);
  check("RC8 the conflict is flagged in detail and list (manual_resolution_conflict)", lateDetail.data.manual_resolution_conflict === true && lateDetail.data.linked_order && lateDetail.data.linked_order.id === orderByRef(late.ref).id && lateList.data.issues.length === 1 && lateList.data.issues[0].manual_resolution_conflict === true, { detail: lateDetail.data.manual_resolution_conflict });
  check("RC9 settled and ordinary issues are not flagged", (await admin("GET", `/api/admin/payment-issues/${issueByRef(soldOut.ref).id}`)).data.manual_resolution_conflict === false && (await admin("GET", `/api/admin/payment-issues/${issueByRef(pendHook.ref).id}`)).data.manual_resolution_conflict === false);

  // ---- 13. summary ----
  let sum = await admin("GET", "/api/admin/summary");
  check("SM1 summary reports the open payment-issue count", sum.status === 200 && sum.data.payment_issues && sum.data.payment_issues.open === store.issues.filter(x => x.status === "open").length, sum.data.payment_issues);
  fake.issuesTableMissing = true;
  sum = await admin("GET", "/api/admin/summary");
  const listMissing = await admin("GET", "/api/admin/payment-issues");
  fake.issuesTableMissing = false;
  check("SM2 migration 009 not applied: summary still 200 with payment_issues.open = null; the issues page reports an error", sum.status === 200 && sum.data.payment_issues.open === null && sum.data.products.total === 3 && listMissing.status === 500, [sum.status, sum.data.payment_issues, listMissing.status]);
  fake.summaryIssueError = true;
  sum = await admin("GET", "/api/admin/summary");
  fake.summaryIssueError = false;
  check("SM3 any other error on that query is NOT hidden: summary fails as before (500)", sum.status === 500);

  // ---- 13b. payment-reference boundaries (Phase 3B.2b) ----
  // The pattern is read from server.js and the column width from migration 009, so
  // widening either without the other fails here instead of truncating in a database.
  const fs = require("fs");
  const patSrc = fs.readFileSync(path.join(SERVER, "server.js"), "utf8").match(/^const PAYMENT_REFERENCE_PATTERN = \/(.+)\/([a-z]*);$/m);
  const colSrc = fs.readFileSync(path.join(SERVER, "migrations", "009_payment_issues.sql"), "utf8").match(/^\s*payment_reference\s+VARCHAR\((\d+)\)\s+NOT NULL,/mi);
  const REF_PATTERN = patSrc ? new RegExp(patSrc[1], patSrc[2]) : null;
  const COLUMN_MAX = colSrc ? Number(colSrc[1]) : null;
  const longestAccepted = () => {
    let max = 0;
    for (let k = 0; k <= 300; k++) for (const ch of ["a", "Z", "7", "-"]) { const s = "NF-" + ch.repeat(k); if (REF_PATTERN.test(s)) max = Math.max(max, s.length); }
    return max;
  };
  const patternMax = REF_PATTERN ? longestAccepted() : null;
  check("B1 the longest reference PAYMENT_REFERENCE_PATTERN accepts fits payment_issues.payment_reference",
    REF_PATTERN !== null && COLUMN_MAX !== null && patternMax > 0 && patternMax <= COLUMN_MAX, { patternMax, COLUMN_MAX });
  const refOfLength = n => { const head = `NF-${Date.now()}-q`; return head + "q".repeat(n - head.length); };
  const ref83 = refOfLength(patternMax), ref84 = refOfLength(patternMax + 1), ref100 = refOfLength(100), ref101 = refOfLength(101);
  check("B2 boundary references have the intended shape (allowed characters only; lengths max, max+1, 100, 101)",
    REF_PATTERN.test(ref83) && !REF_PATTERN.test(ref84) && /^[A-Za-z0-9-]+$/.test(ref84) && ref83.length === patternMax && ref84.length === patternMax + 1 && ref100.length === 100 && ref101.length === 101);

  const spec = { evidence: "paystack_verified", category: "settlement_error", last_error_code: "ER_X", user_id: null, amount_pesewas: null, currency: null, expected_total_pesewas: null, detail_product_id: null };
  const spyCalls = [];
  const spyPool = { query: async (sql, params) => { spyCalls.push(String(sql)); return [{ affectedRows: 1 }, []]; } };
  const rejection = async (ref, pattern) => {
    try { await issuesModule.recordIssue(spyPool, ref, spec, "webhook", { referencePattern: pattern }); return null; } catch (e) { return e.message; }
  };
  const permissive = /^NF-[A-Za-z0-9-]+$/; // isolates the length cap from the pattern
  const invalid = [["empty", "", REF_PATTERN], ["101 chars", ref101, REF_PATTERN], ["max+1 chars", ref84, REF_PATTERN], ["101 chars, permissive pattern", ref101, permissive]];
  const notRejected = [];
  for (const [name, ref, pattern] of invalid) if (await rejection(ref, pattern) !== "payment issue: invalid reference") notRejected.push(name);
  check("B3 recordIssue rejects empty, 101-character and over-pattern references before any database statement (length cap holds even with a permissive pattern)",
    notRejected.length === 0 && spyCalls.length === 0, { notRejected, statements: spyCalls.length });
  const at100 = await rejection(ref100, permissive);
  check("B4 the length cap is exactly 100: a 100-character reference passes validation and reaches the INSERT", at100 === null && spyCalls.length === 1 && /^\s*INSERT INTO payment_issues/.test(spyCalls[0]), { at100, statements: spyCalls.length });

  const conns = fake.connections, locks = fake.getLocks, writes = fake.issueWrites.length, issuesBefore = issueCount();
  r = await verify(ref84);
  check("B5 callback: a max+1-character reference → 400 INVALID_REFERENCE; no Paystack call, connection, lock or issue write",
    r.status === 400 && r.data.code === "INVALID_REFERENCE" && !verifyHits.has(ref84) && fake.connections === conns && fake.getLocks === locks && fake.issueWrites.length === writes && issueCount() === issuesBefore,
    { status: r.status, code: r.data.code });
  const hooks = [
    await webhook({ event: "charge.success", data: { reference: ref84 } }),
    await webhook({ event: "charge.success", data: { reference: "" } }),
    await webhook({ event: "charge.success", data: {} }),
  ];
  check("B6 webhook: max+1-character, empty and missing references → 200 ignored invalid_reference; no Paystack call, connection, lock or issue write",
    hooks.every(h => h.status === 200 && h.data.ignored === "invalid_reference") && !verifyHits.has(ref84) && fake.connections === conns && fake.getLocks === locks && fake.issueWrites.length === writes && issueCount() === issuesBefore,
    hooks.map(h => [h.status, h.data.ignored]));
  r = await verify(ref83);
  check("B7 callback: a maximum-length reference passes validation and reaches Paystack (unknown there, so not settled and no issue)",
    r.status !== 400 && verifyHits.get(ref83) === 1 && !orderByRef(ref83) && !issueByRef(ref83), { status: r.status, hits: verifyHits.get(ref83) });
  const rec = await issuesModule.recordIssue(fakePool, ref83, spec, "webhook", { referencePattern: REF_PATTERN });
  const stored = issueByRef(ref83);
  check("B8 a valid maximum-length reference is recorded through the normal path, stored in full (not shortened)",
    rec.action === "created" && stored && stored.payment_reference === ref83 && stored.payment_reference.length === patternMax, { rec, len: stored && stored.payment_reference.length });

  // ---- 13c. payment-reference letter case (Phase 3B.2e) ----
  // Generated references are "NF-" plus digits, hyphens and lowercase hex. A copy with an
  // uppercase letter would compare equal in the case-insensitive payment_issues column, so
  // it must be refused at the route, before Paystack, settlement or the register.
  const generatedRef = `NF-${Date.now()}-${CUST_A}-ab${crypto.randomBytes(3).toString("hex")}`; // shape of server.js initialize
  const legacyRef = `NF-${Date.now()}-${CUST_A}`;                                                  // shape of the older generator
  const caseVariant = generatedRef.replace(/[a-f]/, c => c.toUpperCase());
  check("C1 the server pattern accepts generated and older-format references, and refuses upper case after the prefix or a lowercase prefix",
    REF_PATTERN.test(generatedRef) && REF_PATTERN.test(legacyRef) && !REF_PATTERN.test(caseVariant) && !REF_PATTERN.test(generatedRef.replace(/^NF-/, "nf-")) && caseVariant !== generatedRef && caseVariant.toLowerCase() === generatedRef.toLowerCase(),
    { generatedRef, caseVariant });
  const genPay = makePayment({ reference: generatedRef });
  scenarios.set(caseVariant, { mode: "tx", tx: genPay.tx }); // were it let through, Paystack would answer with the lowercase reference
  const conns2 = fake.connections, locks2 = fake.getLocks, writes2 = fake.issueWrites.length, issues2 = issueCount(), orders2 = store.orders.length;
  r = await verify(caseVariant);
  check("C2 callback: a case-altered reference → 400 INVALID_REFERENCE; no Paystack call, connection, lock, order or issue write",
    r.status === 400 && r.data.code === "INVALID_REFERENCE" && !verifyHits.has(caseVariant) && fake.connections === conns2 && fake.getLocks === locks2
    && fake.issueWrites.length === writes2 && issueCount() === issues2 && store.orders.length === orders2, { status: r.status, code: r.data.code });
  const caseHook = await webhook({ event: "charge.success", data: { reference: caseVariant } });
  check("C3 webhook: a case-altered reference → 200 ignored invalid_reference; no Paystack call, connection, lock, order or issue write",
    caseHook.status === 200 && caseHook.data.ignored === "invalid_reference" && !verifyHits.has(caseVariant) && fake.connections === conns2 && fake.getLocks === locks2
    && fake.issueWrites.length === writes2 && issueCount() === issues2 && store.orders.length === orders2, [caseHook.status, caseHook.data.ignored]);
  r = await verify(generatedRef);
  check("C4 the correctly cased reference still settles normally (201, one order, no issue)",
    r.status === 201 && orderByRef(generatedRef)?.id === r.data.orderId && store.orders.filter(o => o.payment_reference.toLowerCase() === generatedRef.toLowerCase()).length === 1 && !issueByRef(generatedRef),
    { status: r.status });

  // ---- 14. nothing sensitive stored or returned ----
  const writeLeak = fake.issueWrites.filter(w => w.params.some(p => p !== null && typeof p === "object") || FORBIDDEN.test(JSON.stringify(w.params)));
  check("S1 no issue write carried card/authorization data, signatures, the snapshot, an email or a key", writeLeak.length === 0 && fake.issueWrites.length > 0, writeLeak.slice(0, 2));
  const allList = await admin("GET", "/api/admin/payment-issues?status=all&pageSize=100");
  const details = await Promise.all(store.issues.map(x => admin("GET", `/api/admin/payment-issues/${x.id}`)));
  const leaked = [allList, ...details].filter(x => FORBIDDEN.test(x.text));
  check("S2 no admin response contains authorization data, signatures, the snapshot, an email or a key", leaked.length === 0, leaked.slice(0, 1).map(x => x.text.slice(0, 200)));
  const storedKeys = new Set(store.issues.flatMap(x => Object.keys(x)));
  check("S3 stored issue fields are exactly the migration-009 columns", [...storedKeys].sort().join() === ["amount_pesewas", "attempt_count", "category", "currency", "detail_product_id", "evidence", "expected_total_pesewas", "first_seen_at", "first_source", "id", "last_error_code", "last_seen_at", "last_source", "order_id", "payment_reference", "resolution", "resolution_note", "resolved_at", "resolved_by", "status", "user_id"].sort().join(), [...storedKeys]);

  check("S4 no unexpected database statement", fake.unexpected.length === 0, fake.unexpected);
  check("S5 the server made no outbound request except to the local mock Paystack", net.refused.length === 0 && net.toMock > 0, net.refused);
  check("S6 no MX/DNS lookup", net.mx === 0);
}

(async () => {
  try {
    unitTests();
    await integrationTests();
  } catch (err) {
    failed++;
    console.log("FAIL suite crashed:", err && err.stack || err);
  }
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})();
