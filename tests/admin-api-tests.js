// Milestone 5 admin API tests against the real server.js (:5058, random JWT secret) and an ISOLATED db.
// All fixtures (users, products, orders, reviews, offers) are removed and stock restored afterwards.
//
// ADMIN-5C: runs ONLY under the isolated-database guard (tests/support/isolated-db-guard.js),
// against a dedicated nf_test_* database — never the working database. Example (all on one
// line; the local DB account is supplied explicitly because the guard blocks .env):
//   NF_TEST_MODE=isolated NF_TEST_DB_NAME=nf_test_<name> NF_TEST_DB_SERVER_HOSTNAME=<@@hostname>
//   DB_NAME=nf_test_<name> DB_HOST=127.0.0.1 DB_PORT=3308 DB_USER=<local account> DB_PASSWORD=
//   NODE_OPTIONS=--require="<backend>/tests/support/isolated-db-guard-preload.js"
//   node tests/admin-api-tests.js
// The spawned server.js inherits NODE_OPTIONS and DB_* through { ...process.env }.
const path = require("path"), crypto = require("crypto");
const { spawn } = require("child_process");
// This file lives in <repo>/tests, so default to the repo root above it: the suite then
// runs as `node tests/<file>` with nothing set. An explicit SERVER_DIR still wins.
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
// Isolation is checked BEFORE dotenv and db.js load: without the guard nothing reads .env
// and no pool is ever created. (A preload with an invalid configuration has already exited.)
{
  const g = globalThis.__NF_ISOLATED_DB_GUARD__;
  const e = process.env;
  const problems = [];
  if (!g) problems.push("the isolated-database guard preload is not active (NODE_OPTIONS --require=\"<backend>/tests/support/isolated-db-guard-preload.js\")");
  if (e.NF_TEST_MODE !== "isolated") problems.push("NF_TEST_MODE must be \"isolated\"");
  if (!e.NF_TEST_DB_NAME || e.DB_NAME !== e.NF_TEST_DB_NAME) problems.push("DB_NAME must equal NF_TEST_DB_NAME");
  if (g && g.db !== e.NF_TEST_DB_NAME) problems.push("the guard's database is not NF_TEST_DB_NAME");
  if (e.DB_HOST !== "127.0.0.1") problems.push("DB_HOST must be 127.0.0.1");
  if (String(e.DB_PORT) !== "3308") problems.push("DB_PORT must be 3308");
  if (problems.length) { console.error("Refusing to run admin-api-tests.js:\n  - " + problems.join("\n  - ")); process.exit(1); }
}
const SECRET = crypto.randomBytes(32).toString("hex");
const API = "http://127.0.0.1:5058";
// ADMIN-5E-DIAG 2B: the spawned server.js must load the guard too, or it would read .env
// and connect unguarded. Build the child's environment once, here, and check THAT object
// before any database access or spawn: its NODE_OPTIONS must --require, by absolute path,
// the preload of the repo the child runs from (its cwd, so the guard wraps the same
// mysql2 that server.js loads), and its isolation settings must still validate.
const CHILD_ENV = { ...process.env, PORT: 5058, JWT_SECRET: SECRET, DEV_EMAIL_LOG: "true" };
{
  const preload = path.resolve(process.cwd(), "tests", "support", "isolated-db-guard-preload.js");
  const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  // NODE_OPTIONS is whitespace-separated; double quotes keep a value with spaces together.
  const tokens = (String(CHILD_ENV.NODE_OPTIONS || "").match(/(?:[^\s"]+|"[^"]*")+/g) || []).map(t => t.replace(/"/g, ""));
  const required = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(?:--require=(.+)|--require|-r)$/.exec(tokens[i]);
    if (m) required.push(m[1] !== undefined ? m[1] : tokens[++i] || "");
  }
  const problems = [];
  if (!required.some(p => path.isAbsolute(p) && samePath(path.resolve(p), preload))) {
    problems.push(`the child's NODE_OPTIONS does not --require the guard preload by absolute path (expected ${preload}; NODE_OPTIONS ${CHILD_ENV.NODE_OPTIONS ? "is set without it" : "is not set"})`);
  }
  const childConfig = require(path.join(process.cwd(), "tests", "support", "isolated-db-guard")).validateTestConfig(CHILD_ENV);
  if (!childConfig.ok) problems.push(`the child's isolation settings are invalid: ${childConfig.reason}`);
  if (problems.length) { console.error("Refusing to run admin-api-tests.js (the child server would not be guarded):\n  - " + problems.join("\n  - ")); process.exit(1); }
}
require(path.join(process.cwd(), "node_modules/dotenv")).config({ quiet: true });
const jwt = require(path.join(process.cwd(), "node_modules/jsonwebtoken"));
const bcrypt = require(path.join(process.cwd(), "node_modules/bcrypt"));
const pool = require(path.join(process.cwd(), "db"));
if (!["localhost", "127.0.0.1"].includes(process.env.DB_HOST)) { console.error("not local"); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = async (s, p) => (await pool.query(s, p))[0];
const results = []; const check = (n, c, x = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"} ${n}${x !== "" ? "  [" + String(x).slice(0, 160) + "]" : ""}`); };
const call = async (method, url, token, body) => {
  const r = await fetch(API + url, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
};

(async () => {
  // The guard's identity gate (gatePool → pool.__nfIdentityGate): SELECT DATABASE(), @@hostname,
  // @@port must match before ANY query runs. Invoked explicitly so the order is visible and a
  // failure stops here, before the baseline read and before any fixture.
  let identity = null;
  try { identity = typeof pool.__nfIdentityGate === "function" ? await pool.__nfIdentityGate() : null; } catch (e) { identity = null; }
  if (typeof identity !== "string" || !identity.startsWith(`${process.env.NF_TEST_DB_NAME}@`)) {
    console.error("Refusing to run admin-api-tests.js: the database identity check did not pass.");
    await pool.end().catch(() => {});
    process.exit(1);
  }
  console.log(`database identity verified: ${identity}`);

  const stamp = Date.now(); const userIds = [], productIds = [], orderIds = [], offerIds = [], couponIds = [];
  let server;
  const baseline = (await q("SELECT (SELECT COUNT(*) FROM users) u,(SELECT COUNT(*) FROM products) p,(SELECT COUNT(*) FROM orders) o,(SELECT COUNT(*) FROM reviews) r,(SELECT COUNT(*) FROM offers) f,(SELECT COUNT(*) FROM offer_products) fp,(SELECT COUNT(*) FROM coupons) c,(SELECT SUM(stock_qty) FROM products) s"))[0];
  try {
    const hash = await bcrypt.hash("Secret123", 10);
    const mkUser = async (name, role) => { const id = (await q("INSERT INTO users (full_name, email, phone, password_hash, role, email_verified_at, auth_provider) VALUES (?, ?, '0200000000', ?, ?, NOW(), 'local')", [name, `nf-adm-${name.toLowerCase()}-${stamp}@example.invalid`, hash, role])).insertId; userIds.push(id); return id; };
    const ADMIN = await mkUser("Ada", "admin"), CUST = await mkUser("Kofi", "customer"), CUST2 = await mkUser("Esi", "customer");
    const tok = id => jwt.sign({ id, role: id === ADMIN ? "admin" : "customer" }, SECRET);
    const tA = tok(ADMIN), tC = tok(CUST);
    const forged = jwt.sign({ id: CUST, role: "admin" }, SECRET); // customer with a token claiming admin

    server = spawn(process.execPath, ["server.js"], { env: CHILD_ENV, stdio: ["ignore", "pipe", "pipe"] });
    let serverLog = "";
    server.stdout.on("data", d => { serverLog += d; });
    server.stderr.on("data", d => { serverLog += d; });
    // ADMIN-5E: startup is not fast on every machine — Stage 3 measured ~17 s spent loading
    // express / jsonwebtoken / google-auth-library before listen(). So instead of a fixed ~12 s
    // probe loop, wait (passively, no requests) for the child's own listening line, which
    // server.js prints from its app.listen callback once the socket is bound — bounded by a
    // hard 60 s deadline. Any guard abort, spawn error, early exit or timeout fails closed.
    const STARTUP_DEADLINE_MS = 60000;
    const startupAt = Date.now();
    const listeningLine = "NeoFragrances API running at http://localhost:5058";
    const guardAbort = /\[isolated-db-guard pid \d+\] ABORT:/;
    let spawnError = null;
    server.once("error", e => { spawnError = e; });
    const childGone = () => server.exitCode !== null || server.signalCode !== null;
    while (!serverLog.includes(listeningLine) && !guardAbort.test(serverLog) && !spawnError && !childGone() && Date.now() - startupAt < STARTUP_DEADLINE_MS) await sleep(100);
    const startupFailure = (reason, extra = "") => new Error(
      `child server not ready (${reason}) after ${Date.now() - startupAt} ms; no API requests were sent\n` +
      `pid=${server.pid} exitCode=${server.exitCode} signal=${server.signalCode}${spawnError ? ` spawnError=${spawnError.code || spawnError.message}` : ""}${extra}\n` +
      `last child output:\n${serverLog.split(/\r?\n/).filter(l => l.trim()).slice(-10).join("\n") || "(none)"}`);
    if (guardAbort.test(serverLog)) throw startupFailure("isolated-db-guard violation");
    if (spawnError) throw startupFailure("spawn error");
    if (childGone()) throw startupFailure("child exited during startup");
    if (!serverLog.includes(listeningLine)) throw startupFailure(`no listening signal within ${STARTUP_DEADLINE_MS} ms`);
    // The child must pass its OWN identity check before any API request that can change
    // data: exactly ONE /api/health runs SELECT 1 through the child's guarded pool, which
    // triggers its gate; the child's preload then prints "identity verified <db>@<host>:<port>".
    let health;
    try { const res = await fetch(API + "/api/health"); health = { status: res.status, body: await res.text() }; }
    catch (e) { health = { error: (e && e.cause && e.cause.code) || (e && e.message) || "unknown" }; }
    const childMarker = `identity verified ${process.env.NF_TEST_DB_NAME}@${process.env.NF_TEST_DB_SERVER_HOSTNAME}:${process.env.DB_PORT}`;
    for (let i = 0; i < 50 && !serverLog.includes(childMarker) && !guardAbort.test(serverLog) && !childGone(); i++) await sleep(100);
    if (guardAbort.test(serverLog)) throw startupFailure("isolated-db-guard violation during identity check");
    if (!health || health.status !== 200 || !serverLog.includes(childMarker) || childGone()) {
      throw startupFailure("database identity not confirmed", `\nhealth=${JSON.stringify(health)} expected="${childMarker}"`);
    }
    console.log(`child server ready after ${Date.now() - startupAt} ms; database identity verified (${childMarker.replace("identity verified ", "")})`);

    /* ---------- access control on every admin route ---------- */
    const routes = [["GET", "/api/admin/summary"], ["GET", "/api/admin/reports"], ["GET", "/api/admin/products"], ["POST", "/api/admin/products"], ["PUT", "/api/admin/products/1"], ["DELETE", "/api/admin/products/1"], ["PATCH", "/api/admin/products/1/restore"], ["PATCH", "/api/admin/products/1/stock"], ["GET", "/api/admin/orders"], ["GET", "/api/admin/orders/1"], ["PATCH", "/api/admin/orders/1/status"], ["GET", "/api/admin/customers"], ["GET", "/api/admin/customers/1"], ["GET", "/api/admin/reviews"], ["PATCH", "/api/admin/reviews/1/hidden"], ["DELETE", "/api/admin/reviews/1"], ["GET", "/api/admin/offers"], ["POST", "/api/admin/offers"], ["PUT", "/api/admin/offers/1"], ["PATCH", "/api/admin/offers/1/toggle"], ["PATCH", "/api/admin/offers/1/featured"], ["DELETE", "/api/admin/offers/1"], ["GET", "/api/admin/coupons"], ["POST", "/api/admin/coupons"], ["GET", "/api/admin/coupons/1"], ["PUT", "/api/admin/coupons/1"], ["PATCH", "/api/admin/coupons/1/active"], ["DELETE", "/api/admin/coupons/1"]];
    let anon = 0, cust = 0, forgedOk = 0;
    for (const [m, u] of routes) {
      if ((await call(m, u)).status === 401) anon++;
      if ((await call(m, u, tC)).status === 403) cust++;
      if ((await call(m, u, forged)).status === 403) forgedOk++;
    }
    check(`all ${routes.length} admin routes: logged out → 401`, anon === routes.length, anon);
    check(`all ${routes.length} admin routes: customer → 403`, cust === routes.length, cust);
    check("token claiming admin for a customer account → 403 (role read from DB)", forgedOk === routes.length, forgedOk);
    const ghost = jwt.sign({ id: 999999999, role: "admin" }, SECRET);
    check("admin token for a deleted user → 401", (await call("GET", "/api/admin/summary", ghost)).status === 401);

    /* ---------- products ---------- */
    const good = { name: `NF Test Oud ${stamp}`, brand: "Test House", category: "unisex", price: 450, stock_qty: 7, badge: "New", image: "images/perfumes/test.jpg", description: "Test", top_notes: "Bergamot", middle_notes: "Rose", base_notes: "Oud" };
    let r = await call("POST", "/api/admin/products", tA, good);
    check("create product (201)", r.status === 201 && r.data.id, JSON.stringify(r.data));
    const P1 = r.data.id; productIds.push(P1);
    r = await call("POST", "/api/admin/products", tA, { ...good, name: `NF Test Musk ${stamp}`, stock_qty: 3 }); const P2 = r.data.id; productIds.push(P2);
    const bad = [
      [{ ...good, name: "" }, "name"], [{ ...good, brand: "x".repeat(101) }, "brand"], [{ ...good, category: "kids" }, "category"],
      [{ ...good, price: -5 }, "price"], [{ ...good, price: 0 }, "price"], [{ ...good, price: "abc" }, "price"], [{ ...good, price: 10.555 }, "price"],
      [{ ...good, image: "javascript:alert(1)" }, "image"], [{ ...good, image: "images/../server.js" }, "image"], [{ ...good, image: "https://evil.example/x.jpg" }, "image"],
      [{ ...good, image: "images/a\" onerror=\"x.jpg" }, "image"], [{ ...good, badge: "x".repeat(21) }, "badge"], [{ ...good, stock_qty: -1 }, "stock_qty"], [{ ...good, stock_qty: 2.5 }, "stock_qty"],
    ];
    let badOk = 0; const badFail = [];
    for (const [body, field] of bad) { const x = await call("POST", "/api/admin/products", tA, body); if (x.status === 400 && x.data.field === field) badOk++; else badFail.push(field + ":" + x.status); }
    check(`product validation rejects ${bad.length} bad inputs with the right field`, badOk === bad.length, badFail.join(","));
    r = await call("PUT", `/api/admin/products/${P1}`, tA, { ...good, stock_qty: undefined, price: 480, name: `NF Test Oud ${stamp} EDP` });
    const p1row = (await q("SELECT price, stock_qty, name FROM products WHERE id = ?", [P1]))[0];
    check("edit product without stock keeps stock (no reset)", r.status === 200 && Number(p1row.price) === 480 && p1row.stock_qty === 7, JSON.stringify(p1row));
    check("edit with invalid price → 400", (await call("PUT", `/api/admin/products/${P1}`, tA, { ...good, price: -1 })).status === 400);
    check("edit unknown product → 404", (await call("PUT", "/api/admin/products/999999999", tA, good)).status === 404);
    const existingOdd = (await q("SELECT id FROM products WHERE image = 'images/perfumes/Atheeri'"))[0];
    check("existing extension-less image path still passes validation", !existingOdd || (await call("POST", "/api/admin/products", tA, { ...good, name: "probe", image: "images/perfumes/Atheeri", price: 1 }).then(async x => { if (x.data?.id) { productIds.push(x.data.id); } return x.status === 201; })));

    // stock
    r = await call("PATCH", `/api/admin/products/${P1}/stock`, tA, { adjust: 5 });
    check("stock adjust +5 → 12", r.status === 200 && r.data.stock_qty === 12, JSON.stringify(r.data));
    r = await call("PATCH", `/api/admin/products/${P1}/stock`, tA, { adjust: -20 });
    check("stock adjust below 0 refused (400 NEGATIVE_STOCK), stock unchanged", r.status === 400 && r.data.code === "NEGATIVE_STOCK" && (await q("SELECT stock_qty FROM products WHERE id = ?", [P1]))[0].stock_qty === 12);
    r = await call("PATCH", `/api/admin/products/${P1}/stock`, tA, { stock_qty: 9 });
    check("stock set to 9", r.status === 200 && r.data.stock_qty === 9);
    let stockBad = 0; for (const b of [{ stock_qty: -1 }, { stock_qty: "true" }, { stock_qty: true }, { stock_qty: "" }, { adjust: 0 }, { adjust: 1.5 }, { adjust: true }]) if ((await call("PATCH", `/api/admin/products/${P1}/stock`, tA, b)).status === 400) stockBad++;
    check("invalid stock bodies rejected (7/7)", stockBad === 7, stockBad);
    check("stock on unknown product → 404", (await call("PATCH", "/api/admin/products/999999999/stock", tA, { stock_qty: 1 })).status === 404);

    // archive / restore / list
    r = await call("DELETE", `/api/admin/products/${P2}`, tA);
    check("archive product (soft delete)", r.status === 200 && !!(await q("SELECT deleted_at FROM products WHERE id = ?", [P2]))[0].deleted_at);
    check("archive again → 404", (await call("DELETE", `/api/admin/products/${P2}`, tA)).status === 404);
    const pub = await (await fetch(API + "/api/products")).json();
    check("archived product hidden from public /api/products", !pub.some(p => p.id === P2));
    r = await call("GET", "/api/admin/products", tA);
    check("admin product list includes archived products + units_sold", r.status === 200 && r.data.some(p => p.id === P2 && p.deleted_at) && r.data.every(p => typeof p.units_sold === "number"));
    r = await call("PATCH", `/api/admin/products/${P2}/restore`, tA);
    check("restore archived product", r.status === 200 && (await q("SELECT deleted_at FROM products WHERE id = ?", [P2]))[0].deleted_at === null);
    check("restore an active product → 404", (await call("PATCH", `/api/admin/products/${P2}/restore`, tA)).status === 404);

    /* ---------- orders ---------- */
    const addr = (await q("INSERT INTO addresses (user_id, label, full_name, phone, address_line1, city, region, country, is_default) VALUES (?, 'Home', 'Kofi Test', '0240000000', '1 Test Road', 'Kumasi', 'Ashanti', 'Ghana', 1)", [CUST])).insertId;
    const mkOrder = async (uid, status, items, ref) => {
      const total = items.reduce((s, [, qty, price]) => s + qty * price, 0) + 20;
      const id = (await q("INSERT INTO orders (user_id, address_id, total, status, payment_reference) VALUES (?, ?, ?, ?, ?)", [uid, uid === CUST ? addr : null, total, status, ref])).insertId; orderIds.push(id);
      for (const [pid, qty, price] of items) await q("INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES (?, ?, ?, ?)", [id, pid, qty, price]);
      return id;
    };
    const O1 = await mkOrder(CUST, "Pending", [[P1, 2, 480], [P2, 1, 450]], `NF-ADM-${stamp}-1`);
    const O2 = await mkOrder(CUST, "Delivered", [[P2, 1, 450]], `NF-ADM-${stamp}-2`);
    const O3 = await mkOrder(CUST2, "Processing", [[P1, 1, 480]], `NF-ADM-${stamp}-3`);
    r = await call("GET", `/api/admin/orders?q=NF-ADM-${stamp}`, tA);
    check("order search by payment reference", r.status === 200 && r.data.total === 3 && r.data.orders.length === 3, JSON.stringify({ total: r.data?.total }));
    r = await call("GET", `/api/admin/orders?q=${encodeURIComponent("nf-adm-esi-" + stamp)}`, tA);
    check("order search by customer email", r.data.total === 1 && r.data.orders[0].id === O3);
    r = await call("GET", `/api/admin/orders?q=%23${O2}`, tA);
    check("order search by #number", r.data.orders.some(o => o.id === O2));
    r = await call("GET", `/api/admin/orders?q=${encodeURIComponent("%")}`, tA);
    check("LIKE wildcards in search are escaped", r.status === 200 && r.data.total === 0, r.data?.total);
    r = await call("GET", `/api/admin/orders?status=Processing&q=NF-ADM-${stamp}`, tA);
    check("status filter", r.data.total === 1 && r.data.orders[0].id === O3);
    check("invalid status filter → 400", (await call("GET", "/api/admin/orders?status=Lost", tA)).status === 400);
    r = await call("GET", `/api/admin/orders?q=NF-ADM-${stamp}&page=2&pageSize=2`, tA);
    check("pagination (page 2 of size 2 → 1 order)", r.data.orders.length === 1 && r.data.page === 2 && r.data.pageSize === 2);
    const today = new Date().toISOString().slice(0, 10);
    r = await call("GET", `/api/admin/orders?q=NF-ADM-${stamp}&from=2000-01-01&to=2000-01-02`, tA);
    check("date range filter", r.data.total === 0);
    r = await call("GET", "/api/admin/orders", tA);
    check("order list: status_counts + no password data", r.data.status_counts && typeof r.data.status_counts.Pending === "number" && !JSON.stringify(r.data).match(/password|\$2b\$/));
    r = await call("GET", `/api/admin/orders/${O1}`, tA);
    check("order details: items, customer, address, payment ref, allowed statuses", r.status === 200 && r.data.items.length === 2 && r.data.items[0].name && r.data.customer_email && r.data.address_line1 === "1 Test Road" && r.data.payment_reference === `NF-ADM-${stamp}-1` && r.data.items_subtotal === 1410 && r.data.allowed_statuses.includes("Cancelled"), JSON.stringify(r.data).slice(0, 150));
    check("order details unknown / malformed id → 404", (await call("GET", "/api/admin/orders/999999999", tA)).status === 404 && (await call("GET", "/api/admin/orders/abc", tA)).status === 404);

    // status transitions + restock
    r = await call("PATCH", `/api/admin/orders/${O1}/status`, tA, { status: "Processing" });
    check("status Pending → Processing", r.status === 200 && (await q("SELECT status FROM orders WHERE id = ?", [O1]))[0].status === "Processing");
    check("invalid status → 400", (await call("PATCH", `/api/admin/orders/${O1}/status`, tA, { status: "Lost" })).status === 400);
    const before = await q("SELECT id, stock_qty FROM products WHERE id IN (?, ?) ORDER BY id", [P1, P2]);
    // Phase 5: cancelling requires a note (covered in depth by order-status-history-tests.js).
    r = await call("PATCH", `/api/admin/orders/${O1}/status`, tA, { status: "Cancelled", note: "Customer asked to cancel" });
    const after =await q("SELECT id, stock_qty FROM products WHERE id IN (?, ?) ORDER BY id", [P1, P2]);
    const d = id => after.find(a => a.id === id).stock_qty - before.find(b => b.id === id).stock_qty;
    check("cancel restocks items in the same transaction (+2, +1)", r.status === 200 && d(P1) === 2 && d(P2) === 1 && r.data.restocked === 2, JSON.stringify(r.data));
    r = await call("PATCH", `/api/admin/orders/${O1}/status`, tA, { status: "Pending" });
    check("cancelled order is final (409 ORDER_FINAL)", r.status === 409 && r.data.code === "ORDER_FINAL");
    const again = await q("SELECT stock_qty FROM products WHERE id = ?", [P1]);
    check("re-cancelling is a no-op (no double restock)", (await call("PATCH", `/api/admin/orders/${O1}/status`, tA, { status: "Cancelled" })).status === 200 && (await q("SELECT stock_qty FROM products WHERE id = ?", [P1]))[0].stock_qty === again[0].stock_qty);
    r = await call("GET", `/api/admin/orders/${O1}`, tA);
    check("cancelled order offers no further statuses", r.data.allowed_statuses.length === 0);
    check("status on unknown order → 404", (await call("PATCH", "/api/admin/orders/999999999/status", tA, { status: "Shipped" })).status === 404);

    /* ---------- customers ---------- */
    r = await call("GET", "/api/admin/customers", tA);
    const kofi = (r.data || []).find(c => c.id === CUST);
    check("customer list: verification, provider, order count, total spent (excl. cancelled), last order", r.status === 200 && kofi && kofi.email_verified === true && kofi.auth_provider === "local" && kofi.order_count === 2 && kofi.total_spent === 470 && !!kofi.last_order_at, JSON.stringify(kofi));
    check("customer list excludes admins + has no password data", !r.data.some(c => c.id === ADMIN) && !JSON.stringify(r.data).match(/password|\$2b\$/));
    r = await call("GET", `/api/admin/customers/${CUST}`, tA);
    check("customer details: orders + addresses + counts", r.status === 200 && r.data.orders.length === 2 && r.data.addresses.length === 1 && r.data.total_spent === 470 && !JSON.stringify(r.data).match(/password|\$2b\$/));
    check("customer details for an admin id → 404", (await call("GET", `/api/admin/customers/${ADMIN}`, tA)).status === 404);

    /* ---------- reviews ---------- */
    const rv1 = (await q("INSERT INTO reviews (product_id, user_id, rating, comment, is_verified_purchase) VALUES (?, ?, 5, 'Lovely', 1)", [P2, CUST])).insertId;
    const rv2 = (await q("INSERT INTO reviews (product_id, user_id, rating, comment, is_verified_purchase) VALUES (?, ?, 2, 'Not for me', 0)", [P2, CUST2])).insertId;
    await q("UPDATE products SET avg_rating = 3.5, review_count = 2 WHERE id = ?", [P2]);
    r = await call("GET", "/api/admin/reviews", tA);
    check("review list with product + customer context", r.status === 200 && r.data.some(x => x.id === rv1 && x.product_name && x.customer_name && x.is_verified_purchase === true));
    check("review list exposes the hidden flag (false by default after migration 004)", r.status === 200 && r.data.find(x => x.id === rv1).hidden === false, JSON.stringify(r.data.find(x => x.id === rv1)?.hidden));

    /* ---------- hide / unhide (Milestone 6 Phase 3) ----------
       Fixtures: rv1 = 5 stars, rv2 = 2 stars, both on product P2, so the
       aggregate after hiding one is unambiguous. */
    r = await call("PATCH", `/api/admin/reviews/${rv2}/hidden`, tA, { hidden: true });
    let prow = (await q("SELECT avg_rating, review_count FROM products WHERE id = ?", [P2]))[0];
    const rv2row = (await q("SELECT hidden FROM reviews WHERE id = ?", [rv2]))[0];
    check("hide review → 200 and hidden = 1 in the database", r.status === 200 && r.data.hidden === true && Number(rv2row.hidden) === 1, `${r.status} ${JSON.stringify(r.data)}`);
    check("hiding recalculates the product aggregate from VISIBLE reviews only (5.0 / 1)", Number(prow.avg_rating) === 5 && prow.review_count === 1, JSON.stringify(prow));
    r = await call("GET", `/api/products/${P2}/reviews`);
    check("public review list excludes the hidden review", r.status === 200 && !r.data.some(x => x.id === rv2) && r.data.some(x => x.id === rv1), JSON.stringify(r.data.map(x => x.id)));
    check("the hidden review's comment text is absent from the public response", !JSON.stringify(r.data).includes("Not for me"), JSON.stringify(r.data).slice(0, 120));
    r = await call("GET", "/api/products");
    const pubP2 = (r.data || []).find(p => p.id === P2);
    check("public product aggregate reflects visible reviews only (5.0 / 1)", !!pubP2 && Number(pubP2.avg_rating) === 5 && Number(pubP2.review_count) === 1, JSON.stringify(pubP2 && [pubP2.avg_rating, pubP2.review_count]));
    r = await call("GET", "/api/admin/reviews", tA);
    check("admin list still returns the hidden review, flagged hidden: true", r.data.some(x => x.id === rv2 && x.hidden === true), JSON.stringify(r.data.filter(x => x.id === rv2).map(x => x.hidden)));

    r = await call("PATCH", `/api/admin/reviews/${rv2}/hidden`, tA, { hidden: false });
    prow = (await q("SELECT avg_rating, review_count FROM products WHERE id = ?", [P2]))[0];
    check("unhide review → 200 and the aggregate is restored (3.5 / 2)", r.status === 200 && r.data.hidden === false && Number(prow.avg_rating) === 3.5 && prow.review_count === 2, `${r.status} ${JSON.stringify(prow)}`);
    r = await call("GET", `/api/products/${P2}/reviews`);
    check("public review list includes the review again after unhiding", r.data.some(x => x.id === rv2));

    // Hide BOTH: no visible reviews left, so the product must read 0 / 0.
    await call("PATCH", `/api/admin/reviews/${rv1}/hidden`, tA, { hidden: true });
    await call("PATCH", `/api/admin/reviews/${rv2}/hidden`, tA, { hidden: true });
    prow = (await q("SELECT avg_rating, review_count FROM products WHERE id = ?", [P2]))[0];
    check("hiding the last visible review gives rating 0 and count 0", Number(prow.avg_rating) === 0 && prow.review_count === 0, JSON.stringify(prow));
    check("public review list is empty when every review is hidden", ((await call("GET", `/api/products/${P2}/reviews`)).data || []).length === 0);
    // Restore rv1 so the delete assertions below start from the original state.
    await call("PATCH", `/api/admin/reviews/${rv1}/hidden`, tA, { hidden: false });

    let hb = 0; const hbFail = [];
    for (const body of [{ hidden: "yes" }, { hidden: 1 }, { hidden: 0 }, { hidden: null }, {}]) {
      const x = await call("PATCH", `/api/admin/reviews/${rv1}/hidden`, tA, body);
      if (x.status === 400 && x.data.field === "hidden") hb++; else hbFail.push(`${JSON.stringify(body)}:${x.status}`);
    }
    check("non-boolean hidden → 400 for all 5 bad bodies", hb === 5, hbFail.join(","));
    check("hide on a nonexistent review id → 404", (await call("PATCH", "/api/admin/reviews/999999999/hidden", tA, { hidden: true })).status === 404);
    check("hide on an invalid (non-numeric) review id → 404", (await call("PATCH", "/api/admin/reviews/abc/hidden", tA, { hidden: true })).status === 404);
    check("hide unauthenticated → 401", (await call("PATCH", `/api/admin/reviews/${rv1}/hidden`, null, { hidden: true })).status === 401);
    check("hide as customer → 403", (await call("PATCH", `/api/admin/reviews/${rv1}/hidden`, tC, { hidden: true })).status === 403);
    check("hide with a forged admin token → 403 (role read from DB)", (await call("PATCH", `/api/admin/reviews/${rv1}/hidden`, forged, { hidden: true })).status === 403);
    const stillVisible = (await q("SELECT hidden FROM reviews WHERE id = ?", [rv1]))[0];
    check("none of the rejected attempts changed the hidden flag", Number(stillVisible.hidden) === 0, JSON.stringify(stillVisible));

    // A customer must not be able to set hidden through review creation.
    const cReview = await call("POST", `/api/products/${P1}/reviews`, tC, { rating: 4, comment: "Customer tries hidden", hidden: 1 });
    const planted = (await q("SELECT id, hidden FROM reviews WHERE product_id = ? AND user_id = ? ORDER BY id DESC LIMIT 1", [P1, CUST]))[0];
    check("customer review creation ignores a client-supplied hidden value (stored 0)", cReview.status === 201 && !!planted && Number(planted.hidden) === 0, JSON.stringify(planted));
    if (planted) await q("DELETE FROM reviews WHERE id = ?", [planted.id]);
    await q("UPDATE products SET avg_rating = 0, review_count = 0 WHERE id = ?", [P1]);

    // Deleting a hidden review must still work and recalculate correctly.
    await call("PATCH", `/api/admin/reviews/${rv2}/hidden`, tA, { hidden: true });
    r = await call("DELETE", `/api/admin/reviews/${rv2}`, tA);
    prow = (await q("SELECT avg_rating, review_count FROM products WHERE id = ?", [P2]))[0];
    check("deleting a HIDDEN review works and leaves the aggregate correct (5.0 / 1)", r.status === 200 && Number(prow.avg_rating) === 5 && prow.review_count === 1, `${r.status} ${JSON.stringify(prow)}`);
    check("delete review recalculates rating (5.0) and count (1)", r.status === 200 && Number(prow.avg_rating) === 5 && prow.review_count === 1, JSON.stringify(prow));
    await call("DELETE", `/api/admin/reviews/${rv1}`, tA);
    prow = (await q("SELECT avg_rating, review_count FROM products WHERE id = ?", [P2]))[0];
    check("deleting the last review resets rating to 0 and count to 0", Number(prow.avg_rating) === 0 && prow.review_count === 0);
    check("delete unknown review → 404", (await call("DELETE", `/api/admin/reviews/${rv1}`, tA)).status === 404);

    /* ---------- offers ---------- */
    const start = new Date(Date.now() - 3600e3).toISOString().slice(0, 19).replace("T", " ");
    const end = new Date(Date.now() + 86400e3).toISOString().slice(0, 19).replace("T", " ");
    const offer = { title: `NF Test Offer ${stamp}`, offer_type: "discount", start_at: start, end_at: end, product_id: P1, original_price: 480, sale_price: 400, display_order: 1 };
    r = await call("POST", "/api/admin/offers", tA, offer);
    check("create offer (201)", r.status === 201, JSON.stringify(r.data)); const F1 = r.data?.id; if (F1) offerIds.push(F1);
    const offerBad = [[{ ...offer, title: "" }, "title"], [{ ...offer, sale_price: 500 }, "sale_price"], [{ ...offer, end_at: start, start_at: end }, "end_at"], [{ ...offer, offer_type: "bogus" }, "offer_type"], [{ ...offer, product_id: 999999999 }, "product_id"], [{ ...offer, original_price: -1 }, "original_price"], [{ ...offer, image: "javascript:x" }, "image"], [{ ...offer, display_order: -2 }, "display_order"]];
    let obOk = 0; const obFail = [];
    for (const [b, f] of offerBad) { const x = await call("POST", "/api/admin/offers", tA, b); if (x.status === 400 && x.data.field === f) obOk++; else obFail.push(f + ":" + x.status); }
    check(`offer validation rejects ${offerBad.length} bad inputs`, obOk === offerBad.length, obFail.join(","));
    check("offer update now validated too (PUT without title → 400)", (await call("PUT", `/api/admin/offers/${F1}`, tA, { ...offer, title: "" })).status === 400);
    await call("DELETE", `/api/admin/products/${P2}`, tA);
    r = await call("PUT", `/api/admin/offers/${F1}`, tA, { ...offer, product_id: P2, original_price: 450, sale_price: 400 });
    check("offer can't target an archived product", r.status === 400 && r.data.field === "product_id");
    await call("PATCH", `/api/admin/products/${P2}/restore`, tA);
    r = await call("PUT", `/api/admin/offers/${F1}`, tA, { ...offer, sale_price: 390 });
    check("update offer (200)", r.status === 200 && Number((await q("SELECT sale_price FROM offer_products WHERE offer_id = ?", [F1]))[0].sale_price) === 390);
    r = await call("GET", "/api/admin/offers", tA);
    const f1 = r.data.find(o => o.id === F1);
    check("offer list: status Active, product context, discount %", f1 && f1.status === "Active" && f1.product_name && f1.product_archived === false && f1.discount_percent === 19, JSON.stringify(f1).slice(0, 140));
    check("toggle requires boolean", (await call("PATCH", `/api/admin/offers/${F1}/toggle`, tA, { active: "no" })).status === 400);
    r = await call("PATCH", `/api/admin/offers/${F1}/toggle`, tA, { active: false });
    const activeList = await (await fetch(API + "/api/offers/active")).json();
    check("deactivated offer disappears from public active offers", r.status === 200 && !activeList.some(o => o.id === F1));
    r = await call("PATCH", `/api/admin/offers/${F1}/featured`, tA, { featured: true });
    check("feature offer", r.status === 200 && (await q("SELECT featured FROM offers WHERE id = ?", [F1]))[0].featured === 1);
    check("toggle unknown offer → 404", (await call("PATCH", "/api/admin/offers/999999999/toggle", tA, { active: true })).status === 404);
    r = await call("DELETE", `/api/admin/offers/${F1}`, tA);
    check("delete offer removes offer + its product row", r.status === 200 && (await q("SELECT COUNT(*) n FROM offer_products WHERE offer_id = ?", [F1]))[0].n === 0);
    check("delete unknown offer → 404", (await call("DELETE", `/api/admin/offers/${F1}`, tA)).status === 404);

    /* ---------- summary + reports ---------- */
    r = await call("GET", "/api/admin/summary", tA);
    const s = r.data || {};
    const realActive = (await q("SELECT COUNT(*) n FROM products WHERE deleted_at IS NULL"))[0].n;
    const realRevenue = Number((await q("SELECT COALESCE(SUM(total),0) t FROM orders WHERE status <> 'Cancelled'"))[0].t);
    check("summary matches the database (active products, revenue excl. cancelled, threshold 5)", r.status === 200 && s.products.active === realActive && Math.abs(s.orders.revenue - realRevenue) < 0.01 && s.low_stock_threshold === 5 && s.orders.by_status.Cancelled >= 1, JSON.stringify({ a: s.products?.active, rev: s.orders?.revenue }));
    check("summary low-stock list only contains 1–5 unit products", s.low_stock_products.every(p => p.stock_qty >= 1 && p.stock_qty <= 5));
    check("summary has recent orders + customer counts, no password data", s.recent_orders.some(o => o.id === O3) && s.customers.total >= 2 && !JSON.stringify(s).match(/password|\$2b\$/));
    r = await call("GET", "/api/admin/reports?days=30", tA);
    const top = (r.data?.top_products || []).find(p => p.id === P2);
    check("reports: real daily series + top products (cancelled excluded)", r.status === 200 && r.data.days === 30 && r.data.daily.some(d => d.day === today) && top && top.units === 1, JSON.stringify(r.data?.top_products?.slice(0, 2)));
    check("reports: unsupported range falls back to 30 days", (await call("GET", "/api/admin/reports?days=13", tA)).data.days === 30);

    /* ---------- coupons (Milestone 6, migration 002) ---------- */
    const cCode = `NFTEST${stamp}`;
    r = await call("POST", "/api/admin/coupons", tA, { code: cCode.toLowerCase(), discount_percent: 10 });
    check("coupon create (201)", r.status === 201 && !!r.data.id, JSON.stringify(r.data));
    const C1 = r.data.id; if (C1) couponIds.push(C1);
    r = await call("GET", "/api/admin/coupons", tA);
    const listed = (r.data || []).find(x => x.id === C1);
    check("created coupon appears in the list, code normalized to uppercase", r.status === 200 && !!listed && listed.code === cCode, JSON.stringify(listed));
    check("list carries discount, usage, orders_used and computed status Active", !!listed && Number(listed.discount_percent) === 10 && listed.usage_limit === null && listed.times_used === 0 && listed.orders_used === 0 && listed.active === true && listed.status === "Active", JSON.stringify(listed));
    check("coupon detail (200)", (await call("GET", `/api/admin/coupons/${C1}`, tA)).data.code === cCode);
    check("coupon detail unknown id → 404", (await call("GET", "/api/admin/coupons/999999999", tA)).status === 404);

    r = await call("POST", "/api/admin/coupons", tA, { code: cCode, discount_percent: 5 });
    check("duplicate exact code → 409 COUPON_CODE_TAKEN on field code", r.status === 409 && r.data.field === "code" && r.data.code === "COUPON_CODE_TAKEN", `${r.status} ${JSON.stringify(r.data)}`);
    r = await call("POST", "/api/admin/coupons", tA, { code: cCode.toLowerCase(), discount_percent: 5 });
    check("duplicate case variant → 409 (never a raw 500)", r.status === 409 && r.data.code === "COUPON_CODE_TAKEN", `${r.status} ${JSON.stringify(r.data)}`);

    const badC = [
      [{ code: `A${stamp}`, discount_percent: 10, discount_amount: 5 }, "discount_percent"],
      [{ code: `B${stamp}` }, "discount_percent"],
      [{ code: `C${stamp}`, discount_percent: 0 }, "discount_percent"],
      [{ code: `D${stamp}`, discount_percent: 101 }, "discount_percent"],
      [{ code: `E${stamp}`, discount_percent: 10.123 }, "discount_percent"],
      [{ code: `F${stamp}`, discount_amount: -5 }, "discount_amount"],
      [{ code: `G${stamp}`, discount_amount: 0 }, "discount_amount"],
      [{ code: `H${stamp}`, discount_amount: 5.005 }, "discount_amount"],
      [{ code: `I${stamp}`, discount_percent: 10, usage_limit: 0 }, "usage_limit"],
      [{ code: `J${stamp}`, discount_percent: 10, usage_limit: -3 }, "usage_limit"],
      [{ code: `K${stamp}`, discount_percent: 10, usage_limit: 2.5 }, "usage_limit"],
      [{ code: "", discount_percent: 10 }, "code"],
      [{ code: "BAD CODE!", discount_percent: 10 }, "code"],
      [{ code: "X".repeat(51), discount_percent: 10 }, "code"],
      [{ code: `L${stamp}`, discount_percent: 10, expires_at: "not-a-date" }, "expires_at"],
    ];
    let bcOk = 0; const bcFail = [];
    for (const [body, field] of badC) { const x = await call("POST", "/api/admin/coupons", tA, body); if (x.status === 400 && x.data.field === field) bcOk++; else bcFail.push(`${field}:${x.status}:${x.data && x.data.field}`); }
    check(`coupon validation rejects ${badC.length} bad inputs with the right field`, bcOk === badC.length, bcFail.join(","));
    check("no rows were created by the rejected inputs", (await q("SELECT COUNT(*) n FROM coupons WHERE code LIKE ?", [`%${stamp}%`]))[0].n === 1, (await q("SELECT COUNT(*) n FROM coupons WHERE code LIKE ?", [`%${stamp}%`]))[0].n);

    r = await call("PUT", `/api/admin/coupons/${C1}`, tA, { code: cCode, discount_amount: 25, usage_limit: 3, active: true });
    const c1row = (await q("SELECT code, discount_percent, discount_amount, usage_limit, active FROM coupons WHERE id = ?", [C1]))[0];
    check("PUT persists changes (percent → fixed amount, usage limit set)", r.status === 200 && c1row.discount_percent === null && Number(c1row.discount_amount) === 25 && Number(c1row.usage_limit) === 3 && Number(c1row.active) === 1, JSON.stringify(c1row));
    check("PUT unknown id → 404", (await call("PUT", "/api/admin/coupons/999999999", tA, { code: `ZZ${stamp}`, discount_percent: 5 })).status === 404);

    check("PATCH active false → computed status Inactive", (await call("PATCH", `/api/admin/coupons/${C1}/active`, tA, { active: false })).status === 200 && (await call("GET", `/api/admin/coupons/${C1}`, tA)).data.status === "Inactive");
    check("PATCH active true → computed status Active again", (await call("PATCH", `/api/admin/coupons/${C1}/active`, tA, { active: true })).status === 200 && (await call("GET", `/api/admin/coupons/${C1}`, tA)).data.status === "Active");
    check("PATCH active with a non-boolean → 400", (await call("PATCH", `/api/admin/coupons/${C1}/active`, tA, { active: "yes" })).status === 400);
    check("PATCH active unknown id → 404", (await call("PATCH", "/api/admin/coupons/999999999/active", tA, { active: true })).status === 404);

    await q("UPDATE coupons SET expires_at = DATE_SUB(NOW(), INTERVAL 1 DAY) WHERE id = ?", [C1]);
    check("computed status Expired once expires_at has passed (DB clock)", (await call("GET", `/api/admin/coupons/${C1}`, tA)).data.status === "Expired");
    await q("UPDATE coupons SET expires_at = NULL, times_used = usage_limit WHERE id = ?", [C1]);
    check("computed status 'Used up' once times_used reaches usage_limit", (await call("GET", `/api/admin/coupons/${C1}`, tA)).data.status === "Used up");
    await q("UPDATE coupons SET times_used = 0 WHERE id = ?", [C1]);

    r = await call("POST", "/api/admin/coupons", tA, { code: `NFDEL${stamp}`, discount_percent: 5 });
    const C2 = r.data.id; if (C2) couponIds.push(C2);
    check("delete an unreferenced coupon (200)", (await call("DELETE", `/api/admin/coupons/${C2}`, tA)).status === 200 && Number((await q("SELECT COUNT(*) n FROM coupons WHERE id = ?", [C2]))[0].n) === 0);
    check("delete unknown id → 404", (await call("DELETE", "/api/admin/coupons/999999999", tA)).status === 404);

    const cOrder = (await q("INSERT INTO orders (user_id, coupon_id, total, status, payment_reference) VALUES (?, ?, 100.00, 'Processing', ?)", [CUST, C1, `NF-COUPON-${stamp}`])).insertId;
    orderIds.push(cOrder);
    r = await call("DELETE", `/api/admin/coupons/${C1}`, tA);
    check("delete a coupon used on an order → 409 COUPON_IN_USE", r.status === 409 && r.data.code === "COUPON_IN_USE" && r.data.ordersUsed === 1, `${r.status} ${JSON.stringify(r.data)}`);
    check("the blocked delete left the coupon in place", Number((await q("SELECT COUNT(*) n FROM coupons WHERE id = ?", [C1]))[0].n) === 1);
    const keptRef = (await q("SELECT coupon_id FROM orders WHERE id = ?", [cOrder]))[0];
    check("the referenced order still retains coupon_id (never SET NULL)", keptRef.coupon_id === C1, JSON.stringify(keptRef));
    check("detail reports orders_used for the referenced coupon", (await call("GET", `/api/admin/coupons/${C1}`, tA)).data.orders_used === 1);
  } catch (e) {
    console.error("HARNESS ERROR:", e); results.push(false);
  } finally {
    try {
      if (offerIds.length) { await q("DELETE FROM offer_products WHERE offer_id IN (?)", [offerIds]); await q("DELETE FROM offers WHERE id IN (?)", [offerIds]); }
      await q("DELETE FROM offer_products WHERE offer_id IN (SELECT id FROM offers WHERE title LIKE ?)", [`NF Test Offer ${stamp}%`]);
      await q("DELETE FROM offers WHERE title LIKE ?", [`NF Test Offer ${stamp}%`]);
      if (orderIds.length) { await q("DELETE FROM order_items WHERE order_id IN (?)", [orderIds]); await q("DELETE FROM orders WHERE id IN (?)", [orderIds]); }
      // Coupons must go after the orders that reference them, or the FK blocks the delete.
      if (couponIds.length) await q("DELETE FROM coupons WHERE id IN (?)", [couponIds]);
      await q("DELETE FROM coupons WHERE code LIKE ?", [`%${stamp}%`]);
      if (productIds.length) { await q("DELETE FROM reviews WHERE product_id IN (?)", [productIds]); await q("DELETE FROM products WHERE id IN (?)", [productIds]); }
      if (userIds.length) { for (const t of ["addresses", "wishlist", "reviews", "password_resets", "email_verifications"]) await q(`DELETE FROM ${t} WHERE user_id IN (?)`, [userIds]); await q("DELETE FROM users WHERE id IN (?)", [userIds]); }
      const now = (await q("SELECT (SELECT COUNT(*) FROM users) u,(SELECT COUNT(*) FROM products) p,(SELECT COUNT(*) FROM orders) o,(SELECT COUNT(*) FROM reviews) r,(SELECT COUNT(*) FROM offers) f,(SELECT COUNT(*) FROM offer_products) fp,(SELECT COUNT(*) FROM coupons) c,(SELECT SUM(stock_qty) FROM products) s"))[0];
      console.log("\nbaseline:", JSON.stringify(baseline), "\nafter:   ", JSON.stringify(now));
      check("database back to baseline", JSON.stringify(baseline) === JSON.stringify(now));
    } catch (e) { console.error("CLEANUP ERROR", e.message); results.push(false); }
    if (server) server.kill(); await pool.end();
    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ""}`);
    process.exit(failed ? 1 : 0);
  }
})();
