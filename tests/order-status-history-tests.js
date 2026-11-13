// Order Status History (Milestone 6 Phase 5) — migration 006, the admin status
// transition rules, and the customer / admin history views.
//
// WHAT THIS PROVES, and why each case exists
//   - The schema matches migration 006 exactly (columns, FKs, indexes), and the
//     backfill writes one honest baseline per order — nothing invented — and is
//     safe to run twice.
//   - Every genuine admin status change writes exactly one history row with the
//     right from/to, actor, source and note; rejected and no-op requests write
//     none and change nothing.
//   - The Phase 5 rules: Shipped/Delivered can no longer be cancelled (it used to
//     restock a parcel that had already left), Cancelled is final, cancellation
//     and backward corrections need a note.
//   - The status change, the restock and the history row are ONE transaction: a
//     forced history-insert failure leaves the order and the stock untouched.
//   - Customers see statuses and times only — never the admin, the note or the
//     raw source — and only for their own orders.
//   - Payment settlement is not coupled to the history table.
//
// SAFETY
//   Creates 4 users, 2 products, ~10 orders and their history rows, and removes
//   them all (history goes with its order through ON DELETE CASCADE, which is
//   itself asserted). The atomicity case installs ONE temporary trigger, scoped
//   to a single fixture order id, and drops it straight away and again in
//   `finally`. Real catalog, offer, coupon, review and wishlist rows are never
//   written; the end-of-run check compares them to the start.
//
// Ports: API 5073, CDP 9344. 5055-5061, 5063-5068, 5070-5072, 5099 and CDP
// 9334/9336/9337/9339-9343 are taken by other suites. Needs the frontend on
// http://127.0.0.1:5500 and Microsoft Edge for the browser part.
const path = require("path"), fs = require("fs"), os = require("os"), crypto = require("crypto");
const { spawn } = require("child_process");
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
// T04: runs ONLY under the isolated-database guard (nf_test_* on 127.0.0.1:3308; see
// tests/README.md, "Isolated test database"). Checked before dotenv and db.js load.
const iso = require("./support/isolated-suite");
iso.requireIsolation("order-status-history-tests.js");
require(path.join(process.cwd(), "node_modules/dotenv")).config({ quiet: true });
const jwt = require(path.join(process.cwd(), "node_modules/jsonwebtoken"));
const bcrypt = require(path.join(process.cwd(), "node_modules/bcrypt"));
const pool = require(path.join(process.cwd(), "db"));
// Safety gate: replaced by the isolated-database guard above (T04), which is stricter — it
// refuses everything except an nf_test_* database on 127.0.0.1:3308 and checks its identity.

const PORT = 5073, CDP_PORT = 9344;
const API = `http://127.0.0.1:${PORT}`;
const FRONT = "http://127.0.0.1:5500";
const SECRET = crypto.randomBytes(32).toString("hex");
const NOTE_MAX = 500; // mirrors ORDER_NOTE_MAX in server.js / VARCHAR(500) in migration 006
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = async (s, p) => (await pool.query(s, p))[0];
const results = []; const check = (n, c, x = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"} ${n}${x !== "" ? "  [" + String(x).slice(0, 190) + "]" : ""}`); };
// Screenshots go to the OS temp dir, not tests/, so no new gitignored folder is needed.
const SHOTS = path.join(os.tmpdir(), "nf-history-shots"); fs.mkdirSync(SHOTS, { recursive: true });
const call = async (method, url, token, body) => {
  const res = await fetch(API + url, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch (e) {}
  return { status: res.status, data, text };
};

// Everything this suite must leave exactly as it found it (updated_at excluded:
// a stock change that is later reversed still moves it).
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

(async () => {
  await iso.verifyParentIdentity(pool, "order-status-history-tests.js");
  const stamp = Date.now();
  const TRIGGER = `nf_test_osh_fail_${stamp}`;
  const userIds = [], productIds = [], orderIds = [];
  let server, edge, ws;
  const before = await snapshot();
  try {
    /* ================= migration 006: schema ================= */
    const cols = await q(`SELECT COLUMN_NAME c, DATA_TYPE t, CHARACTER_MAXIMUM_LENGTH len, IS_NULLABLE n, COLUMN_DEFAULT d, EXTRA x
                            FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_status_history' ORDER BY ORDINAL_POSITION`);
    check("S1. order_status_history exists", cols.length > 0);
    const col = name => cols.find(c => c.c === name) || {};
    check("S2. exactly the eight columns, in order", cols.map(c => c.c).join() === "id,order_id,from_status,to_status,changed_by,source,note,created_at", cols.map(c => c.c).join());
    check("S3. id INT NOT NULL AUTO_INCREMENT; order_id INT NOT NULL",
      col("id").t === "int" && col("id").n === "NO" && /auto_increment/i.test(col("id").x) && col("order_id").t === "int" && col("order_id").n === "NO");
    check("S4. from_status VARCHAR(20) NULL; to_status VARCHAR(20) NOT NULL",
      col("from_status").t === "varchar" && Number(col("from_status").len) === 20 && col("from_status").n === "YES" && col("to_status").t === "varchar" && Number(col("to_status").len) === 20 && col("to_status").n === "NO");
    check("S5. changed_by INT NULL; source VARCHAR(20) NOT NULL; note VARCHAR(500) NULL",
      col("changed_by").t === "int" && col("changed_by").n === "YES" && col("source").t === "varchar" && Number(col("source").len) === 20 && col("source").n === "NO" && col("note").t === "varchar" && Number(col("note").len) === 500 && col("note").n === "YES");
    check("S6. created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP",
      col("created_at").t === "timestamp" && col("created_at").n === "NO" && /current_timestamp/i.test(String(col("created_at").d)), JSON.stringify(col("created_at")));
    const fks = await q(`SELECT rc.CONSTRAINT_NAME name, k.COLUMN_NAME c, k.REFERENCED_TABLE_NAME rt, k.REFERENCED_COLUMN_NAME rc2, rc.DELETE_RULE del
                           FROM information_schema.REFERENTIAL_CONSTRAINTS rc
                           JOIN information_schema.KEY_COLUMN_USAGE k ON k.CONSTRAINT_SCHEMA = rc.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = rc.CONSTRAINT_NAME AND k.TABLE_NAME = rc.TABLE_NAME
                          WHERE rc.CONSTRAINT_SCHEMA = DATABASE() AND rc.TABLE_NAME = 'order_status_history' ORDER BY rc.CONSTRAINT_NAME`);
    const fk = name => fks.find(f => f.name === name) || {};
    check("S7. FK order_id → orders(id) ON DELETE CASCADE", fk("fk_osh_order").c === "order_id" && fk("fk_osh_order").rt === "orders" && fk("fk_osh_order").rc2 === "id" && fk("fk_osh_order").del === "CASCADE", JSON.stringify(fks));
    check("S8. FK changed_by → users(id) ON DELETE SET NULL", fk("fk_osh_changed_by").c === "changed_by" && fk("fk_osh_changed_by").rt === "users" && fk("fk_osh_changed_by").rc2 === "id" && fk("fk_osh_changed_by").del === "SET NULL");
    check("S9. no other foreign keys", fks.length === 2);
    const idx = await q(`SELECT INDEX_NAME i, SEQ_IN_INDEX s, COLUMN_NAME c, NON_UNIQUE nu FROM information_schema.STATISTICS
                          WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'order_status_history' ORDER BY INDEX_NAME, SEQ_IN_INDEX`);
    const idxCols = name => idx.filter(r => r.i === name).map(r => r.c).join();
    check("S10. index idx_osh_order_id is (order_id, id), in that order", idxCols("idx_osh_order_id") === "order_id,id", JSON.stringify(idx));
    check("S11. index idx_osh_changed_by (changed_by); primary key (id)", idxCols("idx_osh_changed_by") === "changed_by" && idxCols("PRIMARY") === "id");

    /* ================= migration 006: the file + the backfill ================= */
    const migDir = path.join(process.cwd(), "migrations");
    const six = fs.readdirSync(migDir).filter(f => /^006_/.test(f));
    check("M1. exactly one migration numbered 006", six.length === 1 && six[0] === "006_order_status_history.sql", six.join());
    const migSql = fs.readFileSync(path.join(migDir, six[0] || "missing"), "utf8").split(/\r?\n/).filter(l => !l.trim().startsWith("--")).join("\n");
    const stmts = migSql.split(";").map(s => s.trim()).filter(Boolean);
    check("M2. the migration is two statements: CREATE TABLE, then the backfill INSERT", stmts.length === 2 && /^CREATE TABLE order_status_history/.test(stmts[0]) && /^INSERT INTO order_status_history/.test(stmts[1]));
    check("M3. the migration declares the index and both FKs it is verified against",
      /KEY idx_osh_order_id \(order_id, id\)/.test(stmts[0]) && /FOREIGN KEY \(order_id\) REFERENCES orders \(id\) ON DELETE CASCADE/.test(stmts[0]) && /FOREIGN KEY \(changed_by\) REFERENCES users \(id\) ON DELETE SET NULL/.test(stmts[0]));
    const preOrders = Number((await q("SELECT COUNT(*) n FROM orders"))[0].n);
    const preBackfill = await q("SELECT order_id, COUNT(*) n FROM order_status_history WHERE source = 'backfill' GROUP BY order_id");
    check("M4. local backfill: one baseline per pre-existing order (here: 0 orders → 0 rows)",
      preBackfill.length === preOrders && preBackfill.every(r => Number(r.n) === 1), `orders=${preOrders} backfilled=${preBackfill.length}`);

    /* ================= fixtures ================= */
    const hash = await bcrypt.hash("Secret123", 10);
    const mkUser = async (name, role) => { const id = (await q("INSERT INTO users (full_name, email, phone, password_hash, role, email_verified_at, auth_provider) VALUES (?, ?, '0244000000', ?, ?, NOW(), 'local')", [name, `nf-osh-${name.toLowerCase().replace(/\s/g, "")}-${stamp}@example.invalid`, hash, role])).insertId; userIds.push(id); return id; };
    const ADMIN = await mkUser("Osh Admin", "admin"), ADMIN2 = await mkUser("Osh Second", "admin"), CUST = await mkUser("Osh Customer", "customer"), CUST2 = await mkUser("Osh Other", "customer");
    const tok = (id, role) => jwt.sign({ id, role }, SECRET, { expiresIn: "1h" });
    const tA = tok(ADMIN, "admin"), tA2 = tok(ADMIN2, "admin"), tC = tok(CUST, "customer"), tC2 = tok(CUST2, "customer");
    const mkProduct = async (name, stock) => { const id = (await q("INSERT INTO products (name, brand, category, price, stock_qty, image) VALUES (?, 'OSH Test House', 'unisex', 100, ?, 'images/perfumes/velvet-oud.jpg')", [name, stock])).insertId; productIds.push(id); return id; };
    const P1 = await mkProduct(`OSH Amber ${stamp}`, 10), P2 = await mkProduct(`OSH Musk ${stamp}`, 10);
    const mkOrder = async (uid, status, items, ref) => {
      const id = (await q("INSERT INTO orders (user_id, total, status, payment_reference) VALUES (?, 250.00, ?, ?)", [uid, status, `NF-OSH-${stamp}-${ref}`])).insertId; orderIds.push(id);
      for (const [pid, qty] of items) await q("INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES (?, ?, ?, 100)", [id, pid, qty]);
      return id;
    };
    const stock = async () => Object.fromEntries((await q("SELECT id, stock_qty FROM products WHERE id IN (?, ?)", [P1, P2])).map(r => [r.id, r.stock_qty]));
    const hist = id => q("SELECT * FROM order_status_history WHERE order_id = ? ORDER BY id", [id]);
    const statusOf = async id => (await q("SELECT status FROM orders WHERE id = ?", [id]))[0].status;
    const patch = (id, token, body) => call("PATCH", `/api/admin/orders/${id}/status`, token, body);

    const OA = await mkOrder(CUST, "Pending", [[P1, 2], [P2, 1]], "A");     // the full forward journey
    const OB = await mkOrder(CUST, "Shipped", [[P1, 1]], "B");              // Shipped → Cancelled blocked
    const OC = await mkOrder(CUST, "Pending", [[P1, 1]], "C");              // cancel from Pending
    const OD = await mkOrder(CUST, "Processing", [[P2, 2]], "D");           // cancel from Processing
    const OE = await mkOrder(CUST, "Pending", [[P2, 1]], "E");              // atomicity
    const OF = await mkOrder(CUST, "Processing", [[P1, 1]], "F");           // Processing → Pending correction
    const OG = await mkOrder(CUST, "Processing", [[P2, 1]], "G");           // backfill-only order (customer view)
    const OH = await mkOrder(CUST, "Cancelled", [[P2, 1]], "H");            // cancelled before tracking began

    /* ---- the backfill statement itself, run for real and rolled back ---- */
    {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [[{ n: missing }]] = await conn.query("SELECT COUNT(*) n FROM orders o WHERE NOT EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id = o.id)");
        const [first] = await conn.query(stmts[1]);
        const [rows] = await conn.query("SELECT h.*, o.status AS order_status FROM order_status_history h JOIN orders o ON o.id = h.order_id WHERE h.order_id IN (?) ORDER BY h.order_id", [orderIds]);
        const [second] = await conn.query(stmts[1]);
        check("M5. backfill writes one row per order that has no history", first.affectedRows === Number(missing) && rows.length === orderIds.length, `affected=${first.affectedRows} missing=${missing}`);
        check("M6. backfill rows record only the known current state (NULL from, current to, no actor, 'backfill', 'Status tracking began')",
          rows.every(r => r.from_status === null && r.to_status === r.order_status && r.changed_by === null && r.source === "backfill" && r.note === "Status tracking began" && r.created_at instanceof Date));
        check("M7. running the backfill again adds nothing (NOT EXISTS guard)", second.affectedRows === 0, second.affectedRows);
      } finally { await conn.rollback(); conn.release(); }
      check("M8. (rolled back) the dry run left no rows behind", Number((await q("SELECT COUNT(*) n FROM order_status_history WHERE order_id IN (?)", [orderIds]))[0].n) === 0);
    }
    // OG and OH get the real baseline a migrated production order would have.
    for (const id of [OG, OH]) await q("INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, source, note) SELECT id, NULL, status, NULL, 'backfill', 'Status tracking began' FROM orders WHERE id = ?", [id]);

    /* ================= server ================= */
    server = await iso.startGuardedServer({ suite: "order-status-history-tests.js", port: PORT, env: { JWT_SECRET: SECRET, DEV_EMAIL_LOG: "true", PAYSTACK_SECRET_KEY: "", GOOGLE_CLIENT_ID: "", FRONTEND_URL: FRONT, NODE_ENV: "" } });
    const up = !server.gone();
    check("T0. test server started", up);

    /* ================= admin transitions: forward ================= */
    let r = await patch(OA, tA, { status: "Processing" });
    let h = await hist(OA);
    check("T1. Pending → Processing (no note needed) → 200", r.status === 200 && r.data.status === "Processing" && r.data.restocked === 0 && (await statusOf(OA)) === "Processing", JSON.stringify(r.data));
    check("T2. ...writes exactly one history row: Pending → Processing, by this admin, source admin, no note",
      h.length === 1 && h[0].from_status === "Pending" && h[0].to_status === "Processing" && h[0].changed_by === ADMIN && h[0].source === "admin" && h[0].note === null, JSON.stringify(h));
    r = await patch(OA, tA2, { status: "Shipped", note: "  DHL 4471  " });
    h = await hist(OA);
    check("T3. Processing → Shipped → 200, optional note stored (trimmed), actor = the second admin",
      r.status === 200 && h.length === 2 && h[1].from_status === "Processing" && h[1].to_status === "Shipped" && h[1].changed_by === ADMIN2 && h[1].note === "DHL 4471", JSON.stringify(h[1]));
    r = await patch(OA, tA, { status: "Delivered" });
    h = await hist(OA);
    check("T4. Shipped → Delivered → 200, third row", r.status === 200 && h.length === 3 && h[2].from_status === "Shipped" && h[2].to_status === "Delivered" && h[2].changed_by === ADMIN);
    check("T5. history ids and times are in the order the changes happened", h[0].id < h[1].id && h[1].id < h[2].id && h[0].created_at <= h[1].created_at && h[1].created_at <= h[2].created_at);

    /* ================= no-op ================= */
    let s0 = await stock();
    r = await patch(OA, tA, { status: "Delivered" });
    check("T6. same status → existing 200 no-op, no history row, no restock", r.status === 200 && r.data.restocked === 0 && (await hist(OA)).length === 3 && JSON.stringify(await stock()) === JSON.stringify(s0));

    /* ================= cancellation blocked after shipping ================= */
    s0 = await stock();
    r = await patch(OA, tA, { status: "Cancelled", note: "Customer changed their mind" });
    check("T7. Delivered → Cancelled → 409 ORDER_NOT_CANCELLABLE", r.status === 409 && r.data.code === "ORDER_NOT_CANCELLABLE", `${r.status} ${JSON.stringify(r.data)}`);
    check("T8. ...status unchanged, no restock, no history row", (await statusOf(OA)) === "Delivered" && JSON.stringify(await stock()) === JSON.stringify(s0) && (await hist(OA)).length === 3);
    r = await patch(OB, tA, { status: "Cancelled", note: "Parcel lost" });
    check("T9. Shipped → Cancelled → 409 ORDER_NOT_CANCELLABLE", r.status === 409 && r.data.code === "ORDER_NOT_CANCELLABLE", `${r.status} ${JSON.stringify(r.data)}`);
    check("T10. ...status unchanged, no restock, no history row", (await statusOf(OB)) === "Shipped" && JSON.stringify(await stock()) === JSON.stringify(s0) && (await hist(OB)).length === 0);

    /* ================= backward corrections ================= */
    r = await patch(OA, tA, { status: "Shipped" });
    check("T11. backward correction without a note → 400 NOTE_REQUIRED (field note)", r.status === 400 && r.data.code === "NOTE_REQUIRED" && r.data.field === "note", `${r.status} ${JSON.stringify(r.data)}`);
    r = await patch(OA, tA, { status: "Shipped", note: "   " });
    check("T12. a whitespace-only note counts as no note → 400", r.status === 400 && r.data.code === "NOTE_REQUIRED");
    check("T13. ...rejected corrections changed nothing and wrote no history", (await statusOf(OA)) === "Delivered" && (await hist(OA)).length === 3);
    r = await patch(OA, tA2, { status: "Shipped", note: "Marked delivered by mistake" });
    h = await hist(OA);
    check("T14. Delivered → Shipped with a note → 200; row has the note and the actor",
      r.status === 200 && (await statusOf(OA)) === "Shipped" && h.length === 4 && h[3].from_status === "Delivered" && h[3].to_status === "Shipped" && h[3].note === "Marked delivered by mistake" && h[3].changed_by === ADMIN2 && h[3].source === "admin");
    r = await patch(OF, tA, { status: "Pending", note: "Payment query — on hold" });
    check("T15. Processing → Pending with a note → 200", r.status === 200 && (await statusOf(OF)) === "Pending" && (await hist(OF)).length === 1);

    /* ================= cancellation from Pending / Processing ================= */
    s0 = await stock();
    r = await patch(OC, tA, { status: "Cancelled" });
    check("T16. cancelling without a note → 400 NOTE_REQUIRED; still Pending, no restock, no history",
      r.status === 400 && r.data.code === "NOTE_REQUIRED" && (await statusOf(OC)) === "Pending" && JSON.stringify(await stock()) === JSON.stringify(s0) && (await hist(OC)).length === 0);
    r = await patch(OC, tA, { status: "Cancelled", note: "Customer asked to cancel by phone" });
    let s1 = await stock();
    h = await hist(OC);
    check("T17. Pending → Cancelled with a note → 200, restocked (+1 of P1)", r.status === 200 && r.data.restocked === 1 && s1[P1] - s0[P1] === 1 && s1[P2] === s0[P2], JSON.stringify({ r: r.data, s0, s1 }));
    check("T18. ...one history row: Pending → Cancelled, actor, source admin, the cancellation note",
      h.length === 1 && h[0].from_status === "Pending" && h[0].to_status === "Cancelled" && h[0].changed_by === ADMIN && h[0].source === "admin" && h[0].note === "Customer asked to cancel by phone");
    s0 = await stock();
    r = await patch(OD, tA2, { status: "Cancelled", note: "Out of the bottle size ordered" });
    s1 = await stock();
    h = await hist(OD);
    check("T19. Processing → Cancelled with a note → 200, restocked (+2 of P2)", r.status === 200 && s1[P2] - s0[P2] === 2 && s1[P1] === s0[P1]);
    check("T20. ...history row Processing → Cancelled by the second admin", h.length === 1 && h[0].from_status === "Processing" && h[0].to_status === "Cancelled" && h[0].changed_by === ADMIN2);

    /* ================= cancelled is final ================= */
    s0 = await stock();
    const finalCodes = [];
    for (const target of ["Pending", "Processing", "Shipped", "Delivered"]) {
      const x = await patch(OC, tA, { status: target, note: "Reopening" });
      finalCodes.push(`${target}:${x.status}:${x.data && x.data.code}`);
    }
    check("T21. Cancelled → Pending / Processing / Shipped / Delivered all → 409 ORDER_FINAL", finalCodes.every(c => /:409:ORDER_FINAL$/.test(c)), finalCodes.join(" "));
    check("T22. ...still Cancelled, no restock, no new history", (await statusOf(OC)) === "Cancelled" && JSON.stringify(await stock()) === JSON.stringify(s0) && (await hist(OC)).length === 1);
    r = await patch(OC, tA, { status: "Cancelled", note: "again" });
    check("T23. Cancelled → Cancelled is the no-op: 200, no double restock, no history", r.status === 200 && r.data.restocked === 0 && JSON.stringify(await stock()) === JSON.stringify(s0) && (await hist(OC)).length === 1);

    /* ================= input validation ================= */
    const preE = (await hist(OE)).length;
    r = await patch(OE, tA, { status: "Processing", note: "x".repeat(NOTE_MAX + 1) });
    check("T24. note over 500 characters → 400 (field note), nothing saved", r.status === 400 && r.data.field === "note" && (await statusOf(OE)) === "Pending" && (await hist(OE)).length === preE);
    r = await patch(OE, tA, { status: "Processing", note: 12345 });
    check("T25. non-text note → 400 (field note)", r.status === 400 && r.data.field === "note");
    r = await patch(OE, tA, { status: "Lost" });
    check("T26. unknown status → 400, no history", r.status === 400 && (await hist(OE)).length === preE);
    check("T27. unknown order → 404; malformed id → 404", (await patch(999999999, tA, { status: "Shipped" })).status === 404 && (await patch("abc", tA, { status: "Shipped" })).status === 404);
    const authCodes = [(await patch(OE, null, { status: "Processing" })).status, (await patch(OE, tC, { status: "Processing" })).status];
    check("T28. unauthenticated → 401, customer → 403, and neither wrote history", authCodes.join() === "401,403" && (await hist(OE)).length === preE && (await statusOf(OE)) === "Pending", authCodes.join());

    /* ================= atomicity: a failing history insert rolls everything back ================= */
    await pool.query(`CREATE TRIGGER ${TRIGGER} BEFORE INSERT ON order_status_history FOR EACH ROW
                      BEGIN IF NEW.order_id = ${Number(OE)} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced history failure (test)'; END IF; END`);
    s0 = await stock();
    r = await patch(OE, tA, { status: "Cancelled", note: "Atomicity probe" });
    const atomStatus = await statusOf(OE), atomStock = await stock(), atomHist = (await hist(OE)).length;
    const r2 = await patch(OE, tA, { status: "Processing" });
    const atomStatus2 = await statusOf(OE);
    await pool.query(`DROP TRIGGER IF EXISTS ${TRIGGER}`);
    check("T29. history insert fails during a cancellation → 500, order still Pending, stock NOT restocked, no row",
      r.status === 500 && atomStatus === "Pending" && JSON.stringify(atomStock) === JSON.stringify(s0) && atomHist === 0, `${r.status} ${atomStatus} ${JSON.stringify({ s0, atomStock })}`);
    check("T30. history insert fails on a forward move → 500, status unchanged", r2.status === 500 && atomStatus2 === "Pending");
    r = await patch(OE, tA, { status: "Processing", note: "y".repeat(NOTE_MAX) });
    h = await hist(OE);
    check("T31. with the failure gone the same change commits, and a 500-character note is stored whole", r.status === 200 && (await statusOf(OE)) === "Processing" && h.length === 1 && h[0].note.length === NOTE_MAX);

    /* ================= admin views ================= */
    r = await call("GET", `/api/admin/orders/${OA}`, tA);
    const ah = (r.data && r.data.status_history) || [];
    check("A1. admin order detail includes status_history, oldest first", r.status === 200 && ah.length === 4 && ah.every((x, i) => i === 0 || x.id > ah[i - 1].id) && ah.map(x => x.to_status).join() === "Processing,Shipped,Delivered,Shipped", ah.map(x => x.to_status).join());
    check("A2. admin sees from/to, actor id + name, source, note and time",
      ah[3].from_status === "Delivered" && ah[3].changed_by === ADMIN2 && ah[3].changed_by_name === "Osh Second" && ah[3].source === "admin" && ah[3].note === "Marked delivered by mistake" && !!ah[3].created_at && ah[1].changed_by_name === "Osh Second" && ah[0].changed_by_name === "Osh Admin");
    check("A3. no password or hash data in the admin payload", !/password|\$2b\$|token_version/.test(r.text));
    check("A4. allowed + note-required statuses: Shipped can't be cancelled; going back needs a note",
      r.data.allowed_statuses.join() === "Pending,Processing,Delivered" && r.data.note_required_statuses.join() === "Pending,Processing", `${r.data.allowed_statuses} | ${r.data.note_required_statuses}`);
    const pend = await call("GET", `/api/admin/orders/${OF}`, tA);
    check("A5. a Pending order offers every status incl. Cancelled, and only Cancelled needs a note",
      pend.data.allowed_statuses.join() === "Processing,Shipped,Delivered,Cancelled" && pend.data.note_required_statuses.join() === "Cancelled", `${pend.data.allowed_statuses} | ${pend.data.note_required_statuses}`);
    check("A6. a cancelled order offers nothing", (await call("GET", `/api/admin/orders/${OC}`, tA)).data.allowed_statuses.length === 0);
    const bf = (await call("GET", `/api/admin/orders/${OG}`, tA)).data.status_history;
    check("A7. a backfilled order shows its baseline row to the admin (source backfill, no actor)", bf.length === 1 && bf[0].source === "backfill" && bf[0].changed_by === null && bf[0].from_status === null);

    /* ================= customer view ================= */
    r = await call("GET", `/api/my-orders/${OA}/history`, tC);
    const ch = (r.data && r.data.history) || [];
    check("C1. customer gets their own order's history → 200, oldest first", r.status === 200 && r.data.order_id === OA && r.data.status === "Shipped" && ch.map(x => x.status).join() === "Processing,Shipped,Delivered,Shipped", JSON.stringify(r.data).slice(0, 190));
    check("C2. each entry carries the recorded time, in non-decreasing order", ch.every((x, i) => !isNaN(Date.parse(x.at)) && (i === 0 || Date.parse(x.at) >= Date.parse(ch[i - 1].at))));
    check("C3. entries expose only type / from_status / status / at", ch.every(x => Object.keys(x).sort().join() === "at,from_status,status,type"));
    check("C4. no admin identity, actor id, note or source anywhere in the response",
      !/changed_by|Osh Admin|Osh Second|DHL 4471|Marked delivered by mistake|"source"|"note"|admin/i.test(r.text), r.text.slice(0, 190));
    const cg = (await call("GET", `/api/my-orders/${OG}/history`, tC)).data;
    check("C5. a backfilled order shows one 'tracking_started' entry with no previous status", cg.history.length === 1 && cg.history[0].type === "tracking_started" && cg.history[0].from_status === null && cg.history[0].status === "Processing");
    check("C6. another customer's order → 404 (not 403: existence isn't revealed)", (await call("GET", `/api/my-orders/${OA}/history`, tC2)).status === 404);
    check("C7. nonexistent order → 404; malformed id → 404", (await call("GET", "/api/my-orders/999999999/history", tC)).status === 404 && (await call("GET", "/api/my-orders/abc/history", tC)).status === 404);
    check("C8. unauthenticated → 401", (await call("GET", `/api/my-orders/${OA}/history`)).status === 401);
    const list = await call("GET", "/api/my-orders", tC);
    check("C9. GET /api/my-orders unchanged: still lists the orders with items, and carries no history arrays",
      list.status === 200 && Array.isArray(list.data) && list.data.length === orderIds.length && list.data.every(o => Array.isArray(o.items) && !("history" in o) && !("status_history" in o)));

    /* ================= payment settlement stays decoupled ================= */
    const src = fs.readFileSync(path.join(process.cwd(), "server.js"), "utf8");
    const start = src.indexOf("async function settlePayment(");
    const body = start === -1 ? "" : src.slice(start, src.indexOf("\n}\n", start));
    check("P1. settlePayment() exists and never touches order_status_history", body.length > 500 && !/order_status_history/.test(body), `len=${body.length}`);
    check("P2. the only server.js writes to order_status_history are in the admin status route",
      (src.match(/INSERT INTO order_status_history/g) || []).length === 1 && src.indexOf("INSERT INTO order_status_history") > src.indexOf('app.patch("/api/admin/orders/:id/status"'));

    /* ================= FK behaviour ================= */
    const ADMIN3 = await mkUser("Osh Temp", "admin");
    await patch(OF, tok(ADMIN3, "admin"), { status: "Processing" });
    const rowId = (await hist(OF)).slice(-1)[0].id;
    await q("DELETE FROM users WHERE id = ?", [ADMIN3]); userIds.splice(userIds.indexOf(ADMIN3), 1);
    const kept = (await q("SELECT changed_by, to_status FROM order_status_history WHERE id = ?", [rowId]))[0];
    check("F1. deleting an admin keeps their history rows and nulls changed_by (ON DELETE SET NULL)", kept && kept.changed_by === null && kept.to_status === "Processing", JSON.stringify(kept));
    const lastAdminView = (await call("GET", `/api/admin/orders/${OF}`, tA)).data.status_history.slice(-1)[0];
    check("F2. the admin view still shows that change, without a name", lastAdminView.changed_by === null && lastAdminView.changed_by_name === null && lastAdminView.source === "admin");

    /* ================= browser: admin order page ================= */
    const profile = path.join(os.tmpdir(), "nf-edge-history"); fs.rmSync(profile, { recursive: true, force: true });
    edge = spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
    let wsUrl; for (let i = 0; i < 150 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find(t => t.type === "page")?.webSocketDebuggerUrl; } catch (e) {} if (!wsUrl) await sleep(200); }
    ws = new WebSocket(wsUrl); await new Promise(res => ws.addEventListener("open", res, { once: true }));
    let id = 0, loads = 0; const pending = new Map(); const exceptions = [];
    ws.addEventListener("message", msg => {
      const m = JSON.parse(msg.data); const p = m.params || {};
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === "Fetch.requestPaused") send("Fetch.continueRequest", { requestId: p.requestId, url: p.request.url.replace("http://localhost:5000", API) });
      if (m.method === "Page.loadEventFired") loads++;
      if (m.method === "Runtime.exceptionThrown") exceptions.push(p.exceptionDetails.exception?.description?.split("\n")[0]);
    });
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Fetch.enable", { patterns: [{ urlPattern: "http://localhost:5000/*" }] });
    await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    const ev = async e => { const res = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); return res.result?.result?.value; };
    const go = async url => { const b = loads; await send("Page.navigate", { url }); for (let i = 0; i < 150 && loads === b; i++) await sleep(100); await sleep(600); };
    const waitFor = async (expr, ms = 10000) => { for (let i = 0; i < ms / 100; i++) { if (await ev(expr)) return true; await sleep(100); } return false; };
    const shot = async name => { const res = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true }); fs.writeFileSync(path.join(SHOTS, name + ".png"), Buffer.from(res.result.data, "base64")); };
    const setAuth = (token, user) => ev(`localStorage.setItem("neofragrances_auth", ${JSON.stringify(JSON.stringify({ token, user }))}); true`);
    const panelText = `document.getElementById("h-history")?.closest(".adm-panel")?.innerText || ""`;

    await go(`${FRONT}/admin/login.html`);
    await setAuth(tA, { id: ADMIN, full_name: "Osh Admin", role: "admin" });
    await go(`${FRONT}/admin/order.html?id=${OA}`);
    check("U1. admin order page shows a Status history panel", await waitFor(`!!document.getElementById("h-history")`));
    let t = await ev(panelText);
    check("U2. ...with every change, its admin and its note", (t.match(/by Osh Admin/g) || []).length === 2 && (t.match(/by Osh Second/g) || []).length === 2 && t.includes("Marked delivered by mistake") && t.includes("DHL 4471"), t.slice(0, 190).replace(/\n/g, " | "));
    check("U3. Shipped order: Cancelled is not offered and the page says it can't be cancelled",
      await ev(`![...document.querySelectorAll("#status-select option")].some(o => o.value === "Cancelled") && /Shipped orders can't be cancelled/.test(document.getElementById("status-form").innerText)`));
    await ev(`const s = document.getElementById("status-select"); s.value = "Processing"; s.dispatchEvent(new Event("change", { bubbles: true })); true`);
    check("U4. choosing a backward status marks the note as required", (await ev(`document.getElementById("status-note-req").textContent`)) === "(required)" && await ev(`document.getElementById("status-note").required`));
    await ev(`document.querySelector("#status-form [type=submit]").click(); true`);
    check("U5. submitting it without a note shows the error inline and opens no dialog",
      await waitFor(`/note explaining why/.test(document.querySelector('[data-error-for="note"]').textContent)`) && !(await ev(`!!document.querySelector(".adm-dialog-wrap")`)) && (await statusOf(OA)) === "Shipped");
    await shot("01-admin-history");
    await go(`${FRONT}/admin/order.html?id=${OC}`);
    await waitFor(`!!document.getElementById("h-history")`);
    check("U6. admin-cancelled order: says its items were returned to stock, and shows the cancellation note",
      /returned to stock when it was cancelled/.test(await ev(`document.getElementById("page-root").innerText`)) && (await ev(panelText)).includes("Customer asked to cancel by phone"));
    await go(`${FRONT}/admin/order.html?id=${OH}`);
    await waitFor(`!!document.getElementById("h-history")`);
    const ohText = await ev(`document.getElementById("page-root").innerText`);
    check("U7. order cancelled before tracking began: does NOT claim a restock it can't prove", /can't confirm whether its items were returned to stock/.test(ohText) && !/returned to stock when it was cancelled/.test(ohText));
    check("U8. its baseline row is labelled as tracking start, not as the cancellation date", /Status tracking began/.test(ohText) && /not when it reached that status/.test(ohText));
    await go(`${FRONT}/admin/order.html?id=${OB}`);
    await waitFor(`!!document.getElementById("h-history")`);
    check("U9. order with no recorded changes: honest empty state", /No status changes have been recorded/.test(await ev(panelText)));

    /* ================= browser: customer order page ================= */
    await go(`${FRONT}/index.html`);
    await ev(`localStorage.clear(); true`);
    await setAuth(tC, { id: CUST, full_name: "Osh Customer", email: `nf-osh-oshcustomer-${stamp}@example.invalid`, role: "customer" });
    await go(`${FRONT}/order.html?id=${OA}`);
    check("U10. customer order page renders with a Status updates list", await waitFor(`!!document.querySelector(".nf-history-list")`));
    const cText = await ev(`document.getElementById("order-root").innerText`);
    const items = await ev(`[...document.querySelectorAll(".nf-history-item")].map(li => li.innerText.replace(/\\s+/g, " ").trim())`);
    check("U11. one update per recorded change, oldest first, worded for customers (the correction says 'corrected')",
      items.length === 4 && /Marked as Processing/.test(items[0]) && /Marked as Shipped/.test(items[1]) && /Marked as Delivered/.test(items[2]) && /Status corrected to Shipped/.test(items[3]), JSON.stringify(items));
    check("U12. the timeline dates the placed step, Processing and Shipped from real records — not Delivered (undone by the correction)",
      await ev(`(() => { const s = [...document.querySelectorAll(".nf-timeline-step")]; return s.length === 4 && s[0].querySelector(".nf-timeline-date") && s[1].querySelector(".nf-timeline-date") && s[2].querySelector(".nf-timeline-date") && !s[3].querySelector(".nf-timeline-date"); })()`));
    check("U13. no admin name, note text or internal wording on the customer page", !/Osh Admin|Osh Second|DHL 4471|Marked delivered by mistake|changed_by|backfill/i.test(cText));
    await shot("02-customer-timeline");
    await go(`${FRONT}/order.html?id=${OG}`);
    await waitFor(`!!document.querySelector(".nf-history-list")`);
    check("U14. backfilled order: 'Status tracking began', and no step is dated by it (only the placed date)",
      /Status tracking began — your order was Processing/.test(await ev(`document.getElementById("order-root").innerText`)) && (await ev(`document.querySelectorAll(".nf-timeline-date").length`)) === 1);
    await go(`${FRONT}/order.html?id=${OC}`);
    await waitFor(`!!document.querySelector(".nf-timeline-cancelled")`);
    const cancelText = await ev(`document.querySelector(".nf-timeline-cancelled").innerText`);
    check("U15. cancelled order states the recorded cancellation time, and makes no stock claim", /This order was cancelled on \d/.test(cancelText) && !/stock/i.test(await ev(`document.getElementById("order-root").innerText`)), cancelText);
    await go(`${FRONT}/order.html?id=${OB}`);
    await waitFor(`!!document.querySelector(".nf-timeline")`);
    check("U16. order with no history: timeline as before (placed date only), no empty updates box", (await ev(`document.querySelectorAll(".nf-timeline-date").length`)) === 1 && !(await ev(`!!document.querySelector(".nf-history")`)));
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await go(`${FRONT}/order.html?id=${OA}`);
    await waitFor(`!!document.querySelector(".nf-history-list")`);
    check("U17. mobile (390px): no horizontal overflow on the customer order page", await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`));
    await shot("03-customer-mobile");
    check("U18. no uncaught JS exceptions", exceptions.length === 0, exceptions.join(" | "));
    check("U19. the test server is still running", server.proc.exitCode === null);
  } catch (err) {
    console.error("TEST HARNESS ERROR:", err);
    results.push(false);
  } finally {
    try {
      await pool.query(`DROP TRIGGER IF EXISTS ${TRIGGER}`);
      if (orderIds.length) {
        const histBefore = Number((await q("SELECT COUNT(*) n FROM order_status_history WHERE order_id IN (?)", [orderIds]))[0].n);
        await q("DELETE FROM order_items WHERE order_id IN (?)", [orderIds]);
        await q("DELETE FROM orders WHERE id IN (?)", [orderIds]);
        const leftHist = Number((await q("SELECT COUNT(*) n FROM order_status_history WHERE order_id IN (?)", [orderIds]))[0].n);
        check("F3. deleting the fixture orders removed their history rows (ON DELETE CASCADE)", histBefore > 0 && leftHist === 0, `before=${histBefore} after=${leftHist}`);
      }
      if (productIds.length) await q("DELETE FROM products WHERE id IN (?)", [productIds]);
      if (userIds.length) { for (const tb of ["addresses", "wishlist", "reviews", "password_resets", "email_verifications"]) await q(`DELETE FROM ${tb} WHERE user_id IN (?)`, [userIds]); await q("DELETE FROM users WHERE id IN (?)", [userIds]); }
      const after = await snapshot();
      console.log("\nbefore:", JSON.stringify(before), "\nafter: ", JSON.stringify(after));
      check("Z. database identical to the start (every table's rows, no triggers left)", JSON.stringify(before) === JSON.stringify(after));
    } catch (e) { console.error("CLEANUP ERROR:", e.message); results.push(false); }
    try { ws && ws.close(); } catch (e) {}
    if (edge) edge.kill();
    iso.stopServer(server);
    await pool.end();
    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ""}`);
    process.exit(failed ? 1 : 0);
  }
})();
