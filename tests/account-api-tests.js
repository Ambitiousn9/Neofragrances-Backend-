// Milestone 4 API + access-control tests against the real server.js (:5056) and the LOCAL db.
const path = require("path"), crypto = require("crypto");
const { spawn } = require("child_process");
// This file lives in <repo>/tests, so default to the repo root above it: the suite then
// runs as `node tests/<file>` with nothing set. An explicit SERVER_DIR still wins.
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
require(path.join(process.cwd(), "node_modules/dotenv")).config({ quiet: true });
const jwt = require(path.join(process.cwd(), "node_modules/jsonwebtoken"));
const bcrypt = require(path.join(process.cwd(), "node_modules/bcrypt"));
const pool = require(path.join(process.cwd(), "db"));
if (!["localhost", "127.0.0.1"].includes(process.env.DB_HOST)) { console.error("not local"); process.exit(1); }
const SECRET = crypto.randomBytes(32).toString("hex");
const API = "http://127.0.0.1:5056";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = async (s, p) => (await pool.query(s, p))[0];
const results = []; const check = (n, c, x = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"} ${n}${x !== "" ? "  [" + String(x).slice(0, 150) + "]" : ""}`); };
const call = async (method, url, token, body) => {
  const r = await fetch(API + url, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
};

(async () => {
  const stamp = Date.now(); const ids = [];
  let server;
  try {
    const hash = await bcrypt.hash("Secret123", 10);
    const mk = async (name, provider) => { const id = (await q("INSERT INTO users (full_name, email, phone, password_hash, role, email_verified_at, auth_provider) VALUES (?, ?, '0200000000', ?, 'customer', NOW(), ?)", [name, `nf-acct-${name.toLowerCase()}-${stamp}@gmail.com`, hash, provider])).insertId; ids.push(id); return id; };
    const A = await mk("Alice", "local"), B = await mk("Bob", "local"), G = await mk("Gina", "google");
    const tok = id => jwt.sign({ id, role: "customer" }, SECRET);
    let tA = tok(A); const tB = tok(B), tG = tok(G);
    const emailA = `nf-acct-alice-${stamp}@gmail.com`;
    const addr = async (uid, label, def) => (await q("INSERT INTO addresses (user_id, label, full_name, address_line1, city, country, is_default) VALUES (?, ?, 'Test', '1 Road', 'Accra', 'Ghana', ?)", [uid, label, def])).insertId;
    const a1 = await addr(A, "Home", 1), a2 = await addr(A, "Work", 0), a3 = await addr(A, "Spare", 0), b1 = await addr(B, "BobHome", 1);
    const [p1, p2] = await q("SELECT id, image FROM products WHERE deleted_at IS NULL ORDER BY id LIMIT 2");
    const order = (await q("INSERT INTO orders (user_id, address_id, total, status, payment_reference) VALUES (?, ?, 488.00, 'Processing', ?)", [A, a1, `NF-TEST-${stamp}`])).insertId;
    await q("INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES (?, ?, 1, 480.00)", [order, p1.id]);
    const orderB = (await q("INSERT INTO orders (user_id, address_id, total, status) VALUES (?, ?, 100.00, 'Pending')", [B, b1])).insertId;

    server = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: 5056, JWT_SECRET: SECRET, DEV_EMAIL_LOG: "true" }, stdio: "ignore" });
    for (let i = 0; i < 60; i++) { try { await fetch(API + "/"); break; } catch (e) { await sleep(200); } }

    /* ---------- profile ---------- */
    let r = await call("GET", "/api/me");
    check("GET /api/me requires login", r.status === 401);
    r = await call("GET", "/api/me", "not.a.jwt");
    check("GET /api/me rejects a bad token", r.status === 401);
    r = await call("GET", "/api/me", tA);
    check("GET /api/me returns own profile", r.status === 200 && r.data.id === A && r.data.email === emailA && r.data.email_verified === true && !!r.data.member_since && r.data.password_login === true, JSON.stringify(r.data));
    check("profile never includes password data", !JSON.stringify(r.data).match(/password_hash|\$2b\$/));
    r = await call("GET", "/api/me", tG);
    check("Google account: password_login false", r.status === 200 && r.data.password_login === false);
    const deleted = jwt.sign({ id: 999999999, role: "customer" }, SECRET);
    r = await call("GET", "/api/me", deleted);
    check("token for a deleted user → 401", r.status === 401);
    r = await call("PATCH", "/api/me", tA, { fullName: "Alice Mensah", phone: "+233 20 000 0000" });
    check("PATCH /api/me updates name + phone", r.status === 200 && r.data.full_name === "Alice Mensah" && r.data.phone === "+233 20 000 0000");
    r = await call("PATCH", "/api/me", tA, { fullName: "A" }); check("name too short rejected", r.status === 400 && r.data.field === "fullName");
    r = await call("PATCH", "/api/me", tA, { phone: "call me maybe" }); check("invalid phone rejected", r.status === 400 && r.data.field === "phone");
    r = await call("PATCH", "/api/me", tA, { phone: "" }); check("empty phone clears it", r.status === 200 && r.data.phone === null);
    r = await call("PATCH", "/api/me", tA, { email: "new@gmail.com" }); check("email change refused (out of scope)", r.status === 400 && r.data.field === "email");
    r = await call("PATCH", "/api/me", tA, { id: B, role: "admin" }); check("can't set id/role (nothing to update)", r.status === 400);
    check("role unchanged + Bob untouched", (await q("SELECT role FROM users WHERE id=?", [A]))[0].role === "customer" && (await q("SELECT full_name FROM users WHERE id=?", [B]))[0].full_name === "Bob");

    /* ---------- password ---------- */
    r = await call("POST", "/api/me/password", tA, { newPassword: "NewPass789" }); check("password: current required", r.status === 400 && r.data.field === "currentPassword");
    r = await call("POST", "/api/me/password", tA, { currentPassword: "WrongOne1", newPassword: "NewPass789" }); check("password: wrong current rejected", r.status === 400 && r.data.field === "currentPassword");
    r = await call("POST", "/api/me/password", tA, { currentPassword: "Secret123", newPassword: "123" }); check("password: too short rejected", r.status === 400 && r.data.field === "newPassword");
    r = await call("POST", "/api/me/password", tA, { currentPassword: "Secret123", newPassword: "Secret123" }); check("password: same as current rejected", r.status === 400);
    r = await call("POST", "/api/me/password", tA, { currentPassword: "Secret123", newPassword: "NewPass789" }); check("password: change succeeds", r.status === 200 && r.data.success); const tAold = tA; tA = r.data.token; check("password: change revokes earlier sessions (old token 401), returned token works", (await call("GET", "/api/me", tAold)).status === 401 && (await call("GET", "/api/me", tA)).status === 200);
    const loginOld = await call("POST", "/api/login", null, { email: emailA, password: "Secret123" });
    const loginNew = await call("POST", "/api/login", null, { email: emailA, password: "NewPass789" });
    check("password: old rejected, new accepted at login", loginOld.status === 401 && loginNew.status === 200, `${loginOld.status}/${loginNew.status}`);
    check("password: stored as bcrypt", /^\$2b\$10\$/.test((await q("SELECT password_hash FROM users WHERE id=?", [A]))[0].password_hash));
    r = await call("POST", "/api/me/password", tG, { currentPassword: "x", newPassword: "Whatever99" }); check("Google account → set-password path (PASSWORD_NOT_SET)", r.status === 400 && r.data.code === "PASSWORD_NOT_SET");
    let rl = null; for (let i = 0; i < 6; i++) rl = await call("POST", "/api/me/password", tB, { currentPassword: "nope", newPassword: "Whatever99" });
    check("password change: 5 wrong current passwords → 6th attempt 429", rl.status === 429 && rl.data.code === "RATE_LIMITED");
    r = await call("POST", "/api/me/password", tA, { currentPassword: "NewPass789", newPassword: "NewPass789x" }); check("rate limit is per account; new-password typos don't count (Alice unaffected)", r.status === 200, r.status);

    /* ---------- addresses ---------- */
    r = await call("GET", "/api/addresses", tA);
    const lockedA1 = r.data.find(a => a.id === a1);
    check("GET addresses: own only + locked flag on address used by an order", r.status === 200 && r.data.length === 3 && r.data.every(a => a.user_id === A) && lockedA1.locked === true && r.data.find(a => a.id === a2).locked === false);
    r = await call("PUT", `/api/addresses/${a2}`, tA, { label: "Office", fullName: "Alice M", addressLine1: "2 New St", city: "Tema", country: "Ghana", phone: "0244000000" });
    check("PUT own unused address", r.status === 200 && (await q("SELECT city, label FROM addresses WHERE id=?", [a2]))[0].city === "Tema");
    r = await call("PUT", `/api/addresses/${a1}`, tA, { fullName: "X", addressLine1: "Y", city: "Z", country: "Ghana" });
    check("PUT address used by an order → 409 locked (order history kept)", r.status === 409 && r.data.code === "ADDRESS_LOCKED" && (await q("SELECT city FROM addresses WHERE id=?", [a1]))[0].city === "Accra");
    r = await call("PUT", `/api/addresses/${b1}`, tA, { fullName: "Hacked", addressLine1: "x", city: "x", country: "x" });
    check("PUT another customer's address → 404, unchanged", r.status === 404 && (await q("SELECT full_name FROM addresses WHERE id=?", [b1]))[0].full_name === "Test");
    r = await call("PUT", `/api/addresses/${a2}`, tA, { fullName: "", addressLine1: "", city: "", country: "" }); check("PUT validation", r.status === 400);
    r = await call("PUT", `/api/addresses/abc`, tA, { fullName: "a", addressLine1: "b", city: "c", country: "d" }); check("PUT invalid id → 404", r.status === 404);
    r = await call("PATCH", `/api/addresses/${a3}/default`, tA);
    const defs = await q("SELECT id FROM addresses WHERE user_id=? AND is_default=1", [A]);
    check("PATCH default → exactly one default", r.status === 200 && defs.length === 1 && defs[0].id === a3);
    r = await call("PATCH", `/api/addresses/${b1}/default`, tA); check("PATCH default on another customer's address → 404", r.status === 404 && (await q("SELECT is_default FROM addresses WHERE id=?", [b1]))[0].is_default === 1);
    r = await call("DELETE", `/api/addresses/${b1}`, tA); check("DELETE another customer's address → 404, still exists", r.status === 404 && (await q("SELECT id FROM addresses WHERE id=?", [b1])).length === 1);
    r = await call("DELETE", `/api/addresses/${a1}`, tA); check("DELETE address used by an order → 409 locked", r.status === 409 && (await q("SELECT id FROM addresses WHERE id=?", [a1])).length === 1);
    r = await call("DELETE", `/api/addresses/${a3}`, tA);
    const defsAfter = await q("SELECT id FROM addresses WHERE user_id=? AND is_default=1", [A]);
    check("DELETE default address → another becomes default", r.status === 200 && defsAfter.length === 1 && defsAfter[0].id !== a3, `new default ${defsAfter[0]?.id}`);
    r = await call("POST", "/api/addresses", tA, { fullName: "Alice", addressLine1: "9 St", city: "Accra", country: "Ghana" }); check("existing POST /api/addresses still works", r.status === 201);
    r = await call("DELETE", `/api/addresses/${a2}`); check("address endpoints require login", r.status === 401);

    /* ---------- orders ---------- */
    r = await call("GET", "/api/my-orders", tA);
    const o = r.data && r.data[0];
    check("my-orders: own orders only", r.status === 200 && r.data.length === 1 && o.id === order);
    check("my-orders: items carry product_id + image (no name matching needed)", o.items[0].product_id === p1.id && o.items[0].image === p1.image && "available" in o.items[0]);
    check("my-orders: delivery address + payment reference included", o.address_city === "Accra" && o.address_line1 === "1 Road" && o.payment_reference === `NF-TEST-${stamp}`);
    check("my-orders: no user/coupon internals leaked", !("user_id" in o) && !("coupon_id" in o));
    r = await call("GET", "/api/my-orders", tB);
    check("my-orders: Bob never sees Alice's order", r.status === 200 && r.data.every(x => x.id !== order) && r.data.length === 1);

    /* ---------- wishlist ownership ---------- */
    await call("POST", "/api/wishlist", tA, { productId: p2.id });
    r = await call("GET", "/api/wishlist", tB); check("wishlist: Bob can't see Alice's wishlist", r.status === 200 && !r.data.some(p => p.id === p2.id));
    await call("DELETE", `/api/wishlist/${p2.id}`, tB);
    check("wishlist: Bob's delete doesn't remove Alice's item", (await q("SELECT id FROM wishlist WHERE user_id=? AND product_id=?", [A, p2.id])).length === 1);

    /* ---------- track order ---------- */
    r = await call("POST", "/api/track-order", null, { orderId: order, email: emailA });
    check("track: correct number + email", r.status === 200 && r.data.id === order && r.data.items.length === 1);
    check("track: minimal data (no address/reference/email)", !("payment_reference" in r.data) && !("address_line1" in r.data) && !("email" in r.data), Object.keys(r.data).join(","));
    r = await call("POST", "/api/track-order", null, { orderId: `#${order}`, email: emailA.toUpperCase() }); check("track: '#' prefix + email case-insensitive", r.status === 200);
    r = await call("POST", "/api/track-order", null, { orderId: orderB, email: emailA }); check("track: another customer's order with my email → 404", r.status === 404);
    r = await call("POST", "/api/track-order", null, { orderId: "1 OR 1=1", email: emailA }); check("track: malformed order number → 404", r.status === 404);
    let last; for (let i = 0; i < 8; i++) last = await call("POST", "/api/track-order", null, { orderId: order, email: emailA });
    check("track: rate-limited after 10 lookups (→ 429)", last.status === 429 && last.data.code === "RATE_LIMITED");
  } catch (e) {
    console.error("HARNESS ERROR:", e); results.push(false);
  } finally {
    try {
      if (ids.length) {
        const oids = (await q("SELECT id FROM orders WHERE user_id IN (?)", [ids])).map(r => r.id);
        if (oids.length) { await q("DELETE FROM order_items WHERE order_id IN (?)", [oids]); await q("DELETE FROM orders WHERE id IN (?)", [oids]); }
        for (const t of ["addresses", "wishlist", "email_verifications", "password_resets", "reviews"]) await q(`DELETE FROM ${t} WHERE user_id IN (?)`, [ids]);
        await q("DELETE FROM users WHERE id IN (?)", [ids]);
      }
      const c = (await q("SELECT (SELECT COUNT(*) FROM users) u,(SELECT COUNT(*) FROM addresses) a,(SELECT COUNT(*) FROM orders) o,(SELECT COUNT(*) FROM order_items) oi,(SELECT COUNT(*) FROM wishlist) w"))[0];
      console.log("\ncleanup:", JSON.stringify(c));
    } catch (e) { console.error("CLEANUP ERROR", e.message); }
    if (server) server.kill(); await pool.end();
    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ""}`);
    process.exit(failed ? 1 : 0);
  }
})();
