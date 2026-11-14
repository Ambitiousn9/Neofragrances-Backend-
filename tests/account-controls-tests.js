// Account Controls (Milestone 6 Phase 4) — disable / re-enable a customer.
//
// WHAT THIS PROVES, and why each case exists
//   Disabling an account is a security control, so the dangerous failures are
//   not "it didn't block" but "it blocked the wrong thing" or "it only looked
//   blocked":
//     - a JWT lives 7 days and requireAuth used to make NO database call, so
//       without the status check a disabled customer would keep full access,
//       including checkout, for a week;
//     - re-enabling must not resurrect the tokens the customer was holding
//       when they were disabled — that is what token_version is for;
//     - blocking GET /api/payments/verify/:reference would take money from a
//       customer who was already charged and give them no order;
//     - a token minted before migration 005 carries no `v` claim, so reading
//       an absent claim as anything but 0 would log out every existing
//       customer and break all eleven other suites;
//     - failing CLOSED when the status lookup errors would turn a database
//       blip into a site-wide lockout.
//   Every one of those has a test below.
//
// SAFETY
//   Creates one temporary admin and two temporary customers and deletes them,
//   plus the email_verifications / password_resets rows that belong to them.
//   Touches no catalog, order, coupon, offer, review or wishlist data. Paystack
//   is never called: the payment cases assert the GUARD's decision by checking
//   the response is (or is not) a maintenance/disabled rejection, which happens
//   before any outbound call.
//
// Ports: 5071 healthy, 5072 same code with an unreachable database (DB_PORT=1).
// CDP 9343. 5055-5060, 5063-5068, 5070, 5099 and CDP 9334/9336/9337/9339-9342
// are taken by other suites.
const path = require("path"), fs = require("fs"), os = require("os"), crypto = require("crypto");
const { spawn } = require("child_process");
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
// T04: runs ONLY under the isolated-database guard (nf_test_* on 127.0.0.1:3308; see
// tests/README.md, "Isolated test database"). Checked before dotenv and db.js load.
const iso = require("./support/isolated-suite");
iso.requireIsolation("account-controls-tests.js");
require(path.join(process.cwd(), "node_modules/dotenv")).config({ quiet: true });
const jwt = require(path.join(process.cwd(), "node_modules/jsonwebtoken"));
const bcrypt = require(path.join(process.cwd(), "node_modules/bcrypt"));
// Small bound so the eviction case does not need five thousand users. Set
// BEFORE accounts.js is required, and deliberately NOT passed to the spawned
// servers, which run with the production default.
process.env.ACCOUNT_CACHE_MAX = "3";
const pool = require(path.join(process.cwd(), "db"));
const accounts = require(path.join(process.cwd(), "accounts"));
// Safety gate — never weaken this.

const OK_PORT = 5071, DEAD_DB_PORT = 5072, CDP_PORT = 9343;
const API = `http://127.0.0.1:${OK_PORT}`;
const DEAD = `http://127.0.0.1:${DEAD_DB_PORT}`;
const FRONT = "http://127.0.0.1:5500";
const SECRET = crypto.randomBytes(32).toString("hex");
const TTL_MS = 7000;        // mirrors accounts.js TTL_MS
const REASON_MAX = 200;     // mirrors ACCOUNT_REASON_MAX in server.js
const PASSWORD = "Secret123";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = async (s, p) => (await pool.query(s, p))[0];
const results = []; const check = (n, c, x = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"} ${n}${x !== "" ? "  [" + String(x).slice(0, 190) + "]" : ""}`); };
const SHOTS = path.join(__dirname, "account-shots"); fs.mkdirSync(SHOTS, { recursive: true });

const call = async (base, method, url, token, body) => {
  const res = await fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch (e) {}
  return { status: res.status, data, text };
};

// A guarded child on the nf_test_* database, or (noDb) a child with no database at all
// (127.0.0.1:1, no-database preload) for the unreachable-database cases.
const startServer = (port, { noDb = false } = {}) => (noDb ? iso.startNoDbServer : iso.startGuardedServer)({
  suite: "account-controls-tests.js", port,
  env: { JWT_SECRET: SECRET, SENDGRID_API_KEY: "", PAYSTACK_SECRET_KEY: "", GOOGLE_CLIENT_ID: "", DEV_EMAIL_LOG: "true", FRONTEND_URL: FRONT, NODE_ENV: "", ACCOUNT_CACHE_MAX: "" },
});
const waitUp = async (base) => { for (let i = 0; i < 80; i++) { try { await fetch(base + "/"); return true; } catch (e) { await sleep(200); } } return false; };

(async () => {
  await iso.verifyParentIdentity(pool, "account-controls-tests.js");
  let okServer, deadServer, edge, ws, adminId, custId, otherId, productId, productName;
  try {
    const stamp = Date.now();
    const hash = await bcrypt.hash(PASSWORD, 10);
    const emailAdmin = `nf-ac-admin-${stamp}@example.invalid`;
    const emailCust = `nf-ac-cust-${stamp}@example.invalid`;
    const emailOther = `nf-ac-other-${stamp}@example.invalid`;
    const mk = async (name, email, role) => (await q(
      "INSERT INTO users (full_name, email, phone, password_hash, role, email_verified_at, auth_provider) VALUES (?, ?, '0200000000', ?, ?, NOW(), 'local')",
      [name, email, hash, role])).insertId;
    adminId = await mk("AC Admin", emailAdmin, "admin");
    custId = await mk("AC Customer", emailCust, "customer");
    otherId = await mk("AC Other", emailOther, "customer");
    const prod = (await q("SELECT id, name FROM products WHERE deleted_at IS NULL ORDER BY id LIMIT 1"))[0];
    productId = prod.id; productName = prod.name;

    const tAdmin = jwt.sign({ id: adminId, role: "admin" }, SECRET, { expiresIn: "1h" });
    const tCust = jwt.sign({ id: custId, role: "customer" }, SECRET, { expiresIn: "1h" });
    const forged = jwt.sign({ id: custId, role: "admin" }, SECRET);

    okServer = await startServer(OK_PORT);
    check("A1. healthy test instance started", await waitUp(API));

    /* ================= migration 005 schema ================= */
    const cols = new Map((await q(
      `SELECT COLUMN_NAME n, COLUMN_TYPE t, IS_NULLABLE nul, COLUMN_DEFAULT d
         FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'
          AND COLUMN_NAME IN ('disabled_at','disabled_reason','token_version')`)).map(r => [r.n, r]));
    // MariaDB 10.2+ reports a DEFAULT NULL in information_schema as the STRING
    // "NULL", not as SQL NULL, so both spellings are accepted here. What
    // matters is that there is no non-null default: a new user must be active.
    const noDefault = v => v === null || String(v).toUpperCase() === "NULL";
    check("A2. users.disabled_at is a nullable TIMESTAMP with no non-null default",
      !!cols.get("disabled_at") && cols.get("disabled_at").t === "timestamp" && cols.get("disabled_at").nul === "YES" && noDefault(cols.get("disabled_at").d),
      JSON.stringify(cols.get("disabled_at")));
    check("A3. users.disabled_reason is a nullable VARCHAR(200) with no non-null default",
      !!cols.get("disabled_reason") && cols.get("disabled_reason").t === "varchar(200)" && cols.get("disabled_reason").nul === "YES" && noDefault(cols.get("disabled_reason").d),
      JSON.stringify(cols.get("disabled_reason")));
    check("A4. users.token_version is UNSIGNED NOT NULL DEFAULT 0",
      !!cols.get("token_version") && /unsigned/i.test(cols.get("token_version").t) && cols.get("token_version").nul === "NO" && Number(cols.get("token_version").d) === 0,
      JSON.stringify(cols.get("token_version")));

    /* ================= tokens ================= */
    let r = await call(API, "POST", "/api/login", null, { email: emailCust, password: PASSWORD });
    check("A5. an enabled customer can log in", r.status === 200 && !!r.data.token, `${r.status}`);
    const liveCust = r.data && r.data.token;
    const claims = jwt.decode(liveCust);
    check("A6. the issued JWT carries a version claim", claims && typeof claims.v === "number", JSON.stringify(claims));
    check("A7. a brand new account starts at version 0", claims && claims.v === 0, `v=${claims && claims.v}`);
    r = await call(API, "GET", "/api/me", tCust);
    check("A8. a token WITHOUT a version claim is accepted (absent reads as 0, so pre-migration tokens keep working)", r.status === 200 && !!r.data.email, `${r.status}`);
    r = await call(API, "GET", "/api/me", jwt.sign({ id: custId, role: "customer", v: 7 }, SECRET, { expiresIn: "1h" }));
    check("A9. a token whose version does not match is rejected 401 ACCOUNT_DISABLED", r.status === 401 && r.data.code === "ACCOUNT_DISABLED", `${r.status} ${r.data && r.data.code}`);

    /* ================= authorization on the control ================= */
    const path405 = `/api/admin/customers/${custId}/disabled`;
    check("A10. unauthenticated cannot change account status (401)", (await call(API, "PATCH", path405, null, { disabled: true })).status === 401);
    check("A11. a customer cannot change account status (403)", (await call(API, "PATCH", path405, tCust, { disabled: true })).status === 403);
    check("A12. a customer token claiming admin is rejected (403, role read from DB)", (await call(API, "PATCH", path405, forged, { disabled: true })).status === 403);

    /* ================= validation ================= */
    const bad = [
      ['disabled as the string "true"', { disabled: "true" }, "disabled"],
      ["disabled as 1", { disabled: 1 }, "disabled"],
      ["disabled omitted", { reason: "x" }, "disabled"],
      ["reason as a number", { disabled: true, reason: 5 }, "reason"],
      ["reason one character over the limit", { disabled: true, reason: "x".repeat(REASON_MAX + 1) }, "reason"],
    ];
    let bad400 = 0, badField = 0, badAuthShaped = 0;
    for (const [, body, field] of bad) {
      const x = await call(API, "PATCH", path405, tAdmin, body);
      if (x.status === 400) bad400++;
      if (x.data && x.data.field === field) badField++;
      if (x.status === 401 || x.status === 403) badAuthShaped++;
    }
    check(`A13. all ${bad.length} malformed requests are rejected with 400`, bad400 === bad.length, `400s: ${bad400}/${bad.length}`);
    check("A14. every rejection names the offending field", badField === bad.length, `named: ${badField}/${bad.length}`);
    check("A15. no validation failure answers 401/403 (that would eject the operator to the login page)", badAuthShaped === 0, `auth-shaped: ${badAuthShaped}`);
    check("A16. a nonexistent customer id is 404", (await call(API, "PATCH", "/api/admin/customers/999999999/disabled", tAdmin, { disabled: true })).status === 404);
    check("A17. a non-numeric customer id is 404", (await call(API, "PATCH", "/api/admin/customers/abc/disabled", tAdmin, { disabled: true })).status === 404);
    r = await call(API, "PATCH", `/api/admin/customers/${adminId}/disabled`, tAdmin, { disabled: true });
    check("A18. an admin cannot disable their OWN account (409)", r.status === 409 && r.data.code === "CANNOT_DISABLE_SELF", `${r.status} ${r.data && r.data.code}`);
    const otherAdmin = (await q("INSERT INTO users (full_name, email, phone, password_hash, role, email_verified_at, auth_provider) VALUES ('AC Admin Two', ?, '0200000000', ?, 'admin', NOW(), 'local')", [`nf-ac-admin2-${stamp}@example.invalid`, hash])).insertId;
    r = await call(API, "PATCH", `/api/admin/customers/${otherAdmin}/disabled`, tAdmin, { disabled: true });
    check("A19. an administrator account cannot be disabled through the customer control (409)", r.status === 409 && r.data.code === "CANNOT_DISABLE_ADMIN", `${r.status} ${r.data && r.data.code}`);
    check("A20. the refused attempts left both admins enabled",
      (await q("SELECT COUNT(*) c FROM users WHERE role='admin' AND disabled_at IS NOT NULL"))[0].c === 0);
    await q("DELETE FROM users WHERE id = ?", [otherAdmin]);
    check("A21. none of the rejected writes disabled the customer", (await q("SELECT disabled_at FROM users WHERE id = ?", [custId]))[0].disabled_at === null);

    /* ================= disable ================= */
    const REASON = "Chargeback under investigation";
    r = await call(API, "PATCH", path405, tAdmin, { disabled: true, reason: REASON });
    check("A22. an admin can disable a customer (200, saved state returned)", r.status === 200 && r.data.disabled === true && r.data.disabled_reason === REASON, JSON.stringify(r.data));
    const row = (await q("SELECT disabled_at, disabled_reason, token_version FROM users WHERE id = ?", [custId]))[0];
    check("A23. disable writes all three columns atomically and increments the version 0 -> 1",
      row.disabled_at !== null && row.disabled_reason === REASON && Number(row.token_version) === 1, JSON.stringify(row));
    check("A24. the customer row still exists (disable is not delete)", (await q("SELECT COUNT(*) c FROM users WHERE id = ?", [custId]))[0].c === 1);

    /* ================= what a disabled account can no longer do ================= */
    const blocked = [
      ["GET", "/api/me"], ["GET", "/api/my-orders"], ["GET", "/api/addresses"],
      ["GET", "/api/wishlist"], ["POST", "/api/wishlist"], ["PATCH", "/api/me"],
      ["POST", `/api/products/${productId}/reviews`], ["POST", "/api/payments/initialize"],
    ];
    let b401 = 0, bCode = 0;
    for (const [m, u] of blocked) {
      const x = await call(API, m, u, liveCust, m === "GET" ? undefined : {});
      if (x.status === 401) b401++;
      if (x.data && x.data.code === "ACCOUNT_DISABLED") bCode++;
    }
    check(`A25. all ${blocked.length} authenticated customer routes return 401 for a disabled account`, b401 === blocked.length, `401s: ${b401}/${blocked.length}`);
    check(`A26. every rejection carries code ACCOUNT_DISABLED`, bCode === blocked.length, `coded: ${bCode}/${blocked.length}`);
    check("A27. cache invalidated on disable — the block is effective immediately, without waiting for the TTL",
      (await call(API, "GET", "/api/me", liveCust)).status === 401);
    // Payment settlement is the single exemption: this customer may already
    // have been charged. PAYSTACK_SECRET_KEY is blank here, so the route
    // answers PAYMENTS_NOT_CONFIGURED — which proves the guard let it through.
    r = await call(API, "GET", "/api/payments/verify/NF-ac-probe-0000", liveCust);
    check("A28. payment VERIFICATION stays reachable for a disabled account (already charged, must still get the order)",
      !(r.status === 401 && r.data && r.data.code === "ACCOUNT_DISABLED"), `${r.status} ${r.data && r.data.code}`);
    r = await call(API, "GET", "/api/payments/verify/NF-ac-probe-0000", jwt.sign({ id: custId, role: "customer", v: 0 }, SECRET, { expiresIn: "1h" }));
    check("A29. payment VERIFICATION also accepts the stale token the customer held when they paid",
      !(r.status === 401 && r.data && r.data.code === "ACCOUNT_DISABLED"), `${r.status} ${r.data && r.data.code}`);
    r = await call(API, "GET", "/api/me", jwt.sign({ id: otherId, role: "customer" }, SECRET, { expiresIn: "1h" }));
    check("A30. an unrelated customer is unaffected", r.status === 200, `${r.status}`);

    /* ================= login, reset and verification while disabled ================= */
    r = await call(API, "POST", "/api/login", null, { email: emailCust, password: PASSWORD });
    check("A31. disabled local login is refused 403 ACCOUNT_DISABLED and issues no token",
      r.status === 403 && r.data.code === "ACCOUNT_DISABLED" && !r.data.token, `${r.status} ${r.data && r.data.code}`);
    await q("DELETE FROM password_resets WHERE user_id = ?", [custId]);
    r = await call(API, "POST", "/api/forgot-password", null, { email: emailCust });
    const resets = (await q("SELECT COUNT(*) c FROM password_resets WHERE user_id = ?", [custId]))[0].c;
    check("A32. forgot-password returns the SAME generic response for a disabled account (no enumeration)",
      r.status === 200 && /if an account exists/i.test(JSON.stringify(r.data)), JSON.stringify(r.data));
    check("A33. ...but creates no reset token and therefore sends no email", Number(resets) === 0, `reset rows: ${resets}`);
    check("A34. the disabled account's auth_provider was not mutated", (await q("SELECT auth_provider FROM users WHERE id = ?", [custId]))[0].auth_provider === "local");
    r = await call(API, "POST", "/api/forgot-password", null, { email: emailOther });
    check("A35. an enabled account still gets a reset token (existing behaviour intact)",
      Number((await q("SELECT COUNT(*) c FROM password_resets WHERE user_id = ?", [otherId]))[0].c) === 1, JSON.stringify(r.data));
    await q("DELETE FROM password_resets WHERE user_id = ?", [otherId]);
    // Email verification: an old link must still work, and must not re-enable.
    await q("UPDATE users SET email_verified_at = NULL WHERE id = ?", [custId]);
    const rawVerify = crypto.randomBytes(32).toString("hex");
    await q("INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))",
      [custId, crypto.createHash("sha256").update(rawVerify).digest("hex")]);
    r = await call(API, "GET", `/api/verify-email?token=${rawVerify}`);
    const afterVerify = (await q("SELECT email_verified_at, disabled_at FROM users WHERE id = ?", [custId]))[0];
    check("A36. a disabled account can still complete email verification", r.status === 200 && afterVerify.email_verified_at !== null, `${r.status}`);
    check("A37. verifying the email does NOT re-enable the account", afterVerify.disabled_at !== null, JSON.stringify(afterVerify));

    /* ================= re-enable ================= */
    r = await call(API, "PATCH", path405, tAdmin, { disabled: false });
    check("A38. an admin can re-enable a customer", r.status === 200 && r.data.disabled === false, JSON.stringify(r.data));
    const reRow = (await q("SELECT disabled_at, disabled_reason, token_version FROM users WHERE id = ?", [custId]))[0];
    check("A39. re-enable clears disabled_at and the reason", reRow.disabled_at === null && reRow.disabled_reason === null, JSON.stringify(reRow));
    check("A40. re-enable does NOT reset token_version (it stays at 1)", Number(reRow.token_version) === 1, `v=${reRow.token_version}`);
    r = await call(API, "GET", "/api/me", liveCust);
    check("A41. the pre-disable token is STILL rejected after re-enable — a fresh login is required",
      r.status === 401 && r.data.code === "ACCOUNT_DISABLED", `${r.status} ${r.data && r.data.code}`);
    r = await call(API, "GET", "/api/me", tCust);
    check("A42. a token with no version claim is also rejected now (version moved to 1)", r.status === 401, `${r.status}`);
    r = await call(API, "POST", "/api/login", null, { email: emailCust, password: PASSWORD });
    const freshCust = r.data && r.data.token;
    check("A43. the customer can log in again after re-enable", r.status === 200 && !!freshCust, `${r.status}`);
    check("A44. the fresh token carries the CURRENT version (1)", jwt.decode(freshCust).v === 1, `v=${jwt.decode(freshCust).v}`);
    r = await call(API, "GET", "/api/me", freshCust);
    check("A45. the fresh token works and cache invalidation on enable was immediate", r.status === 200 && !!r.data.email, `${r.status}`);
    r = await call(API, "PATCH", path405, tAdmin, { disabled: true, reason: "second" });
    check("A46. disabling a second time increments the version again (1 -> 2)",
      Number((await q("SELECT token_version FROM users WHERE id = ?", [custId]))[0].token_version) === 2);
    r = await call(API, "GET", "/api/me", freshCust);
    check("A47. the token issued between the two disables is dead", r.status === 401 && r.data.code === "ACCOUNT_DISABLED", `${r.status}`);
    await call(API, "PATCH", path405, tAdmin, { disabled: false });
    check("A48. customer left enabled for the browser checks", (await q("SELECT disabled_at FROM users WHERE id = ?", [custId]))[0].disabled_at === null);

    /* ================= ordinary token failures are unchanged ================= */
    r = await call(API, "GET", "/api/me", jwt.sign({ id: custId, role: "customer" }, SECRET, { expiresIn: -10 }));
    check("A49. an EXPIRED token is still a plain 401 and is NOT reported as ACCOUNT_DISABLED",
      r.status === 401 && (!r.data || r.data.code !== "ACCOUNT_DISABLED"), `${r.status} ${r.data && r.data.code}`);
    r = await call(API, "GET", "/api/me", jwt.sign({ id: custId, role: "customer" }, "wrong-secret"));
    check("A50. a bad signature is still a plain 401", r.status === 401 && (!r.data || r.data.code !== "ACCOUNT_DISABLED"), `${r.status}`);
    check("A51. no auth header is still a plain 401", (await call(API, "GET", "/api/me")).status === 401);
    r = await call(API, "GET", "/api/admin/summary", tAdmin);
    check("A52. admin authorization is unchanged (role still read from the database)", r.status === 200 && !!r.data.products, `${r.status}`);

    /* ================= admin reads expose status, customers never see the reason ================= */
    await call(API, "PATCH", path405, tAdmin, { disabled: true, reason: REASON });
    r = await call(API, "GET", "/api/admin/customers", tAdmin);
    const listed = r.data.find(c => c.id === custId);
    check("A53. the admin list reports the disabled flag", !!listed && listed.disabled === true, JSON.stringify(listed && { id: listed.id, disabled: listed.disabled }));
    check("A54. the admin list does NOT carry the reason (it belongs beside the account)", !!listed && !("disabled_reason" in listed), Object.keys(listed || {}).join(","));
    r = await call(API, "GET", `/api/admin/customers/${custId}`, tAdmin);
    check("A55. the admin detail reports the flag, the timestamp and the reason",
      r.data.disabled === true && !!r.data.disabled_at && r.data.disabled_reason === REASON, JSON.stringify({ d: r.data.disabled, r: r.data.disabled_reason }));
    // Nothing customer-facing may leak it. The public product reviews endpoint
    // joins users, so it is the realistic place for a leak to appear.
    const pub = await call(API, "GET", `/api/products/${productId}/reviews`);
    check("A56. no customer-facing response exposes disabled_reason, disabled_at or token_version",
      !/disabled_reason|disabled_at|token_version/.test(pub.text), pub.text.slice(0, 120));

    /* ================= the cache, in process ================= */
    accounts.clearAccountStatusCache();
    const s1 = await accounts.readAccountStatus(custId);
    check("A57. the status lookup returns the disabled flag and the token version together, from one entry",
      s1.disabled === true && s1.tokenVersion === 3 && s1.known === true, JSON.stringify(s1));
    await q("UPDATE users SET disabled_at = NULL WHERE id = ?", [custId]);
    const s2 = await accounts.readAccountStatus(custId);
    check("A58. the cache holds the previous value after an out-of-band database change", s2.disabled === true, JSON.stringify(s2));
    await sleep(TTL_MS + 400);
    const s3 = await accounts.readAccountStatus(custId);
    check("A59. the cache expires after the 7s TTL and the new value is picked up", s3.disabled === false, JSON.stringify(s3));
    accounts.invalidateAccountStatus(custId, { disabled: true, tokenVersion: 9 });
    const s4 = await accounts.readAccountStatus(custId);
    check("A60. invalidation can seed the authoritative post-commit state", s4.disabled === true && s4.tokenVersion === 9, JSON.stringify(s4));
    accounts.clearAccountStatusCache();

    // Eviction: ACCOUNT_CACHE_MAX is 3 in this process.
    for (const id of [900001, 900002, 900003, 900004, 900005]) await accounts.readAccountStatus(id);
    check("A61. the cache is bounded — it never grows past ACCOUNT_CACHE_MAX", accounts._cacheSize() <= 3, `size=${accounts._cacheSize()}`);

    // A slow read must not overwrite an invalidation that happened after it started.
    accounts.clearAccountStatusCache();
    const realQuery = pool.query.bind(pool);
    pool.query = async (...args) => { await sleep(300); return realQuery(...args); };
    const slow = accounts.readAccountStatus(custId);
    await sleep(80);
    accounts.invalidateAccountStatus(custId); // newer knowledge arrives mid-read
    await slow;
    pool.query = realQuery;
    check("A62. a stale concurrent read cannot overwrite a newer invalidation", accounts._cacheSize() === 0, `size=${accounts._cacheSize()}`);

    // Database failure: last known state wins; with nothing known, fail OPEN.
    accounts.clearAccountStatusCache();
    await q("UPDATE users SET disabled_at = NOW() WHERE id = ?", [custId]);
    const known = await accounts.readAccountStatus(custId);
    pool.query = async () => { throw Object.assign(new Error("simulated outage"), { code: "ECONNREFUSED" }); };
    await sleep(TTL_MS + 400);
    const stale = await accounts.readAccountStatus(custId);
    check("A63. DB failure WITH a cached entry serves the last known state — a disabled user stays disabled",
      known.disabled === true && stale.disabled === true && stale.stale === true, JSON.stringify(stale));
    accounts.clearAccountStatusCache();
    const blind = await accounts.readAccountStatus(custId);
    check("A64. DB failure with NOTHING cached fails OPEN rather than locking out every customer",
      blind.disabled === false && blind.known === false, JSON.stringify(blind));
    check("A65. ...and reports a null version so the version check is skipped, not failed closed", blind.tokenVersion === null, `v=${blind.tokenVersion}`);
    pool.query = realQuery;
    accounts.clearAccountStatusCache();
    await q("UPDATE users SET disabled_at = NULL WHERE id = ?", [custId]);

    /* ================= fail open, end to end ================= */
    deadServer = await startServer(DEAD_DB_PORT, { noDb: true });
    check("A66. instance with an unreachable database started", await waitUp(DEAD));
    r = await call(DEAD, "GET", "/api/me", tCust);
    check("A67. FAIL OPEN: a status read failure does not produce ACCOUNT_DISABLED for everyone",
      !(r.data && r.data.code === "ACCOUNT_DISABLED"), `${r.status} ${r.data && r.data.code}`);

    /* ================= the admin UI, in a real browser ================= */
    const profile = path.join(os.tmpdir(), "nf-edge-account"); fs.rmSync(profile, { recursive: true, force: true });
    edge = spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
    let wsUrl; for (let i = 0; i < 150 && !wsUrl; i++) { try { wsUrl = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find(t => t.type === "page")?.webSocketDebuggerUrl; } catch (e) {} if (!wsUrl) await sleep(200); }
    ws = new WebSocket(wsUrl); await new Promise(res => ws.addEventListener("open", res, { once: true }));
    let id = 0, loads = 0; const pending = new Map();
    ws.addEventListener("message", msg => {
      const m = JSON.parse(msg.data); const p = m.params || {};
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === "Fetch.requestPaused") send("Fetch.continueRequest", { requestId: p.requestId, url: p.request.url.replace("http://localhost:5000", API) });
      if (m.method === "Page.loadEventFired") loads++;
    });
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Fetch.enable", { patterns: [{ urlPattern: "http://localhost:5000/*" }] });
    const ev = async e => { const res = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); return res.result?.result?.value; };
    const go = async url => { const b = loads; await send("Page.navigate", { url }); for (let i = 0; i < 150 && loads === b; i++) await sleep(100); await sleep(2200); };
    // Waits for a condition instead of guessing a sleep. The admin pages render
    // only after NFA.ready resolves /api/me AND the record loads, so a fixed
    // delay is a race under load.
    const waitFor = async (expr, ms = 8000) => {
      for (let i = 0; i < ms / 100; i++) { if (await ev(expr)) return true; await sleep(100); }
      return false;
    };
    const shot = async name => { const res = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(SHOTS, name + ".png"), Buffer.from(res.result.data, "base64")); };

    const adminAuth = JSON.stringify({ token: tAdmin, user: { id: adminId, full_name: "AC Admin", role: "admin" } });
    await go(`${FRONT}/admin/login.html`);
    await ev(`localStorage.setItem("neofragrances_auth", ${JSON.stringify(adminAuth)}); true`);

    // Render waits (2026-11-14): a run under load checked A68 while the page
    // still showed its loading skeleton, and A69-A77 cascaded. The detail page
    // is rendered once it is no longer aria-busy and an account action (either
    // one) exists; the list once it is no longer aria-busy and #c-count has
    // text. The waits never require the state the checks below assert.
    const ADMIN_RENDER_MS = 20000;
    const detailRendered = `!document.querySelector('[aria-busy="true"]') && !!document.querySelector('[data-account]')`;
    const listRendered = `!document.querySelector('[aria-busy="true"]') && !!(document.getElementById("c-count") || {}).textContent`;

    await go(`${FRONT}/admin/customer.html?id=${custId}`);
    await waitFor(detailRendered, ADMIN_RENDER_MS);
    check("A68. the detail page offers a Disable action for an active account",
      await ev(`!!document.querySelector('[data-account="disable"]')`), await ev(`document.getElementById("page-actions").innerText`));
    check("A69. an active account shows the Active badge", await ev(`document.body.innerText.includes("Active")`));
    await ev(`document.querySelector('[data-account="disable"]').click(); true`);
    await waitFor(`!!document.getElementById("d-reason")`);
    check("A70. disabling asks for confirmation first, in a drawer, rather than acting immediately",
      await ev(`!!document.querySelector(".adm-drawer") && !!document.getElementById("d-reason")`));
    await shot("01-disable-confirmation");
    await ev(`document.getElementById("d-reason").value = "Chargeback review"; document.getElementById("d-confirm").click(); true`);
    await waitFor(`!!document.querySelector('[data-account="enable"]')`);
    const dbRow = (await q("SELECT disabled_at, disabled_reason FROM users WHERE id = ?", [custId]))[0];
    check("A71. confirming disables the account and stores the reason", dbRow.disabled_at !== null && dbRow.disabled_reason === "Chargeback review", JSON.stringify(dbRow));
    check("A72. the page updates without a reload and now offers Enable", await ev(`!!document.querySelector('[data-account="enable"]')`));
    check("A73. the reason is shown to the administrator", await ev(`document.body.innerText.includes("Chargeback review")`), (await ev("document.body.innerText")).slice(0, 120).replace(/\n/g, " | "));
    await shot("02-detail-disabled");

    await go(`${FRONT}/admin/customers.html`);
    await waitFor(listRendered, ADMIN_RENDER_MS);
    check("A74. the customers list marks the account Disabled", await ev(`document.body.innerText.includes("Disabled")`));
    check("A75. the list offers a status filter", await ev(`!!document.getElementById("c-status")`));
    await ev(`const s=document.getElementById("c-status"); s.value="disabled"; s.dispatchEvent(new Event("change",{bubbles:true})); true`);
    await sleep(800);
    check("A76. filtering by Disabled shows the disabled customer and hides the enabled one",
      await ev(`document.body.innerText.includes("AC Customer") && !document.body.innerText.includes("AC Other")`),
      (await ev(`document.getElementById("c-count").textContent`)));
    await shot("03-list-filtered");

    await go(`${FRONT}/admin/customer.html?id=${custId}`);
    const enableReady = await waitFor(`!!document.querySelector('[data-account="enable"]')`);
    await ev(`document.querySelector('[data-account="enable"]').click(); true`);
    await waitFor(`!!document.querySelector('[data-account="disable"]')`);
    check("A77. the Enable action restores the account from the detail page",
      enableReady && (await q("SELECT disabled_at FROM users WHERE id = ?", [custId]))[0].disabled_at === null, `controlReady=${enableReady}`);
    check("A78. enabling clears the reason from the page", await ev(`!document.body.innerText.includes("Chargeback review")`));

    /* ================= the storefront reacts to a disabled session ================= */
    // reviews.js previously showed the raw server message inline and left the
    // page looking signed in. It must now clear the session and redirect.
    // The order here matters, and the first attempt at this test got it wrong.
    // Loading the product page while ALREADY disabled is unreachable: wishlist.js
    // fires its own authenticated request during page load, takes the 401 and
    // clears the session, so the review form never renders at all.
    //
    // The real scenario is the one below - the customer is sitting on the page
    // when an administrator disables them, and only finds out when they act.
    // A CURRENT token: several disables have moved token_version on since
    // `freshCust` was issued, so that one is dead and wishlist.js would clear
    // the session during page load before the review form ever rendered.
    const relogin = await call(API, "POST", "/api/login", null, { email: emailCust, password: PASSWORD });
    check("A79. the customer can log in for the storefront checks", relogin.status === 200 && !!relogin.data.token, `${relogin.status}`);
    const custAuth = JSON.stringify({ token: relogin.data.token, user: { id: custId, full_name: "AC Customer", role: "customer" } });
    await go(`${FRONT}/index.html`);
    await ev(`localStorage.setItem("neofragrances_auth", ${JSON.stringify(custAuth)}); true`);
    await go(`${FRONT}/product-details.html?id=${productId}`);
    // PRECONDITION 1 - the page rendered the REAL baseline product, not the
    // not-found state. product-details.html hides the reviews section but
    // leaves #review-form-wrap in the DOM when the id is unknown, so "the wrap
    // exists" proves nothing on its own; the product must be matched by name.
    await waitFor(`typeof PRODUCTS !== "undefined" && PRODUCTS.length > 0`);
    const pageState = await ev(`JSON.stringify({
      catalog: typeof PRODUCTS !== "undefined" ? PRODUCTS.length : -1,
      wantId: new URLSearchParams(location.search).get("id"),
      inCatalog: typeof PRODUCTS !== "undefined" && !!PRODUCTS.find(x => x.id === Number(new URLSearchParams(location.search).get("id"))),
      title: (document.getElementById("pd-content").innerText || "").slice(0, 60),
      reviewsHidden: (document.getElementById("reviews-section") || {}).style ? document.getElementById("reviews-section").style.display === "none" : null
    })`);
    const page = JSON.parse(pageState);
    check("A80. the product page rendered the real baseline catalogue product (not the not-found state)",
      page.inCatalog === true && page.reviewsHidden === false && page.title.includes(productName.slice(0, 12)),
      `${pageState} expectedName=${productName}`);

    // PRECONDITION 2 - the form really is on the page.
    const hadForm = await waitFor(`!!document.getElementById("submit-review-btn")`);
    check("A81. the review form is rendered for this logged-in customer", hadForm,
      await ev(`document.getElementById("review-form-wrap").innerHTML.slice(0, 80)`));

    // PRECONDITION 3 - the session is genuinely live right now, in the browser
    // AND at the server. Without this the redirect below could be explained by
    // an already-dead token rather than by the disable.
    const liveInBrowser = await ev(`typeof isLoggedIn === "function" && isLoggedIn()`);
    const liveAtServer = (await call(API, "GET", "/api/me", relogin.data.token)).status === 200;
    check("A82. the customer is authenticated immediately BEFORE the disable (browser session and server both agree)",
      liveInBrowser === true && liveAtServer === true, `browser=${liveInBrowser} server=${liveAtServer}`);

    // Only now: the administrator disables the customer mid-session, with the
    // page still open and the form still on screen.
    await call(API, "PATCH", path405, tAdmin, { disabled: true, reason: "e2e" });
    check("A83. the server now rejects that same token with 401 ACCOUNT_DISABLED",
      (await call(API, "GET", "/api/me", relogin.data.token)).status === 401);
    if (hadForm) {
      await ev(`document.getElementById("submit-review-btn").click(); true`);
      await waitFor(`location.pathname.endsWith("/login.html")`);
    }
    check("A84. submitting a review after being disabled mid-session redirects to login, instead of showing a raw error",
      hadForm && (await ev("location.pathname")).endsWith("/login.html"), `path=${await ev("location.pathname")}`);
    check("A85. the stale login was removed from storage", hadForm && (await ev(`localStorage.getItem("neofragrances_auth")`)) === null);
    await shot("04-storefront-session-cleared");
    await call(API, "PATCH", path405, tAdmin, { disabled: false });

    check("A86. neither test server crashed", okServer.proc.exitCode === null && deadServer.proc.exitCode === null, `ok=${okServer.proc.exitCode} dead=${deadServer.proc.exitCode}`);
  } catch (err) {
    console.error("TEST HARNESS ERROR:", err);
    results.push(false);
  } finally {
    try {
      for (const uid of [adminId, custId, otherId]) {
        if (!uid) continue;
        await q("DELETE FROM email_verifications WHERE user_id = ?", [uid]);
        await q("DELETE FROM password_resets WHERE user_id = ?", [uid]);
      }
      await q("DELETE FROM users WHERE email LIKE 'nf-ac-%@example.invalid'");
      const left = (await q(`SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM products) p,
                                    (SELECT COUNT(*) FROM orders) o, (SELECT SUM(stock_qty) FROM products) st,
                                    (SELECT COUNT(*) FROM wishlist) w, (SELECT COUNT(*) FROM reviews) rv,
                                    (SELECT COUNT(*) FROM email_verifications) ev, (SELECT COUNT(*) FROM password_resets) pr`))[0];
      console.log(`\ncleanup: users=${left.u} products=${left.p} orders=${left.o} stock=${left.st} wishlist=${left.w} reviews=${left.rv} verifications=${left.ev} resets=${left.pr}`);
      check("A87. fixtures removed and the baseline restored",
        Number(left.u) === 1 && Number(left.o) === 0 && Number(left.ev) === 0 && Number(left.pr) === 0 && Number(left.w) === 0 && Number(left.rv) === 1,
        JSON.stringify(left));
    } catch (e) { console.error("CLEANUP ERROR:", e.message); results.push(false); }
    try { ws && ws.close(); } catch (e) {}
    if (edge) edge.kill();
    iso.stopServer(okServer);
    iso.stopServer(deadServer);
    await pool.end();
    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ""}`);
    process.exit(failed ? 1 : 0);
  }
})();
