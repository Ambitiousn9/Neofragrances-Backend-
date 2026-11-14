// Email normalisation (G-8, 2026-11-14).
//
// Every route that receives an email (register, login, resend verification, forgot
// password; Google sign-in already lower-cased) now trims and lower-cases it once with
// normalizeEmail(), compares it with LOWER(email) so an account stored with capitals by
// older code still matches whatever the column's collation, and stores new registrations
// in the normalised form. This suite proves what each route actually sends to the
// database and to the MX lookup, and that a change of letter case can no longer dodge
// the per-email cooldowns.
//
// DATABASE-FREE AND NETWORK-ISOLATED BY CONSTRUCTION, same method as
// auth-rate-limit-tests.js: ./db is replaced in the require cache by an in-memory fake
// that answers only the statements these routes use and records every statement with its
// parameters; DB_PORT is 1; outbound fetch is refused; MX lookups are answered by a stub
// that records the domain asked for. No real account, database or mail server is used.
//
// Run: node tests/email-normalisation-tests.js
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
const SERVER = process.cwd();

const PORT = 5091;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail === undefined ? "" : `  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`}`); }
}

// ---------- environment: set BEFORE server.js loads (dotenv never overrides) ----------
Object.assign(process.env, {
  PORT: String(PORT),
  DB_HOST: "127.0.0.1", DB_PORT: "1", DB_NAME: "nf-email-normalisation-no-db",
  JWT_SECRET: crypto.randomBytes(32).toString("hex"),
  PAYMENT_SIGNING_SECRET: "", PAYSTACK_SECRET_KEY: "", PAYSTACK_API_BASE: "",
  SENDGRID_API_KEY: "", SENDGRID_FROM_EMAIL: "", GOOGLE_CLIENT_ID: "",
  DEV_EMAIL_LOG: "true", NODE_ENV: "", CORS_ORIGINS: "", FRONTEND_URL: "http://127.0.0.1:5500",
});

// ---------- in-memory fake database ----------
const bcrypt = require(path.join(SERVER, "node_modules/bcrypt"));
const PASSWORD = "Correct-Horse-1";
const HASH = bcrypt.hashSync(PASSWORD, 4);
// Stored WITH CAPITALS, as the old register route kept whatever the customer typed.
const users = [
  { id: 990501, full_name: "Old Capitals", email: "Old.Capitals@Example.com", role: "customer", password_hash: HASH, email_verified_at: new Date(), disabled_at: null, token_version: 0, auth_provider: "local", google_id: null, phone: null, created_at: new Date() },
  { id: 990502, full_name: "Unverified Person", email: "unverified.person@example.com", role: "customer", password_hash: HASH, email_verified_at: null, disabled_at: null, token_version: 0, auth_provider: "local", google_id: null, phone: null, created_at: new Date() },
];
let nextId = 990600;
const log = [];          // every statement: { s, params }
const unexpected = [];
const byLower = v => users.find(u => u.email.toLowerCase() === v);
const fakePool = {
  async query(sql, params = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    log.push({ s, params });
    if (s === "SELECT id FROM users WHERE LOWER(email) = ?") { const u = byLower(params[0]); return [u ? [{ id: u.id }] : [], []]; }
    if (s === "SELECT * FROM users WHERE LOWER(email) = ?") { const u = byLower(params[0]); return [u ? [{ ...u }] : [], []]; }
    if (s === "SELECT id, full_name, email_verified_at FROM users WHERE LOWER(email) = ?") { const u = byLower(params[0]); return [u ? [{ id: u.id, full_name: u.full_name, email_verified_at: u.email_verified_at }] : [], []]; }
    if (s === "SELECT id, full_name, disabled_at FROM users WHERE LOWER(email) = ?") { const u = byLower(params[0]); return [u ? [{ id: u.id, full_name: u.full_name, disabled_at: u.disabled_at }] : [], []]; }
    if (/^INSERT INTO users \(full_name, email, phone, password_hash, role\)/.test(s)) {
      const id = nextId++; users.push({ id, full_name: params[0], email: params[1], role: "customer", password_hash: params[3], email_verified_at: null, disabled_at: null, token_version: 0 });
      return [{ insertId: id, affectedRows: 1 }, []];
    }
    if (/^(DELETE FROM|INSERT INTO|UPDATE) (email_verifications|password_resets)\b/.test(s)) return [{ insertId: 1, affectedRows: 1 }, []];
    if (/FROM app_settings WHERE setting_key IN/.test(s)) return [[], []];
    unexpected.push(s); throw new Error("fake pool: unexpected query");
  },
  async getConnection() { unexpected.push("getConnection"); throw new Error("fake pool: connections refused"); },
};
const dbPath = require.resolve(path.join(SERVER, "db.js"));
const dbModule = new Module(dbPath);
dbModule.filename = dbPath; dbModule.loaded = true; dbModule.exports = fakePool;
require.cache[dbPath] = dbModule;

const mxDomains = [];
require("dns").promises.Resolver.prototype.resolveMx = async function (domain) { mxDomains.push(domain); return [{ exchange: "mx.example.invalid", priority: 10 }]; };
const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = async (url) => { outbound.push(String(url)); throw new Error("outbound fetch refused in tests"); };

// ---------- helpers ----------
let ipN = 1;
async function post(pathname, body, ip = `198.51.100.${ipN++}`) {
  const res = await realFetch(BASE + pathname, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": ip }, body: JSON.stringify(body) });
  const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: res.status, data };
}
const since = n => log.slice(n);
const emailParams = entries => entries.flatMap(e => e.params).filter(p => typeof p === "string" && p.includes("@"));

(async () => {
  try {
    require(path.join(SERVER, "server.js"));
    check("G0 server.js is using the in-memory fake pool, not the database", require(path.join(SERVER, "db.js")) === fakePool);
    for (let i = 0; i < 50; i++) { try { await realFetch(BASE + "/"); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }

    // ---------- register ----------
    let n = log.length; let mx = mxDomains.length;
    let r = await post("/api/register", { fullName: "New Person", email: "  Foo.Bar@Example.COM  ", password: "Secret-123" });
    let q = since(n);
    const dup = q.find(e => e.s.startsWith("SELECT id FROM users"));
    const ins = q.find(e => e.s.startsWith("INSERT INTO users"));
    check("R1 register with spaces and capitals → 201", r.status === 201, r);
    check("R2 the MX lookup is for the normalised domain (example.com)", JSON.stringify(mxDomains.slice(mx)) === JSON.stringify(["example.com"]), mxDomains.slice(mx));
    check("R3 the duplicate check compares LOWER(email) with the normalised address", !!dup && dup.params[0] === "foo.bar@example.com", dup);
    check("R4 the new account is STORED normalised (trimmed, lower-case)", !!ins && ins.params[1] === "foo.bar@example.com", ins && ins.params[1]);
    r = await post("/api/register", { fullName: "Copy Cat", email: "OLD.capitals@example.COM ", password: "Secret-123" });
    check("R5 an address that differs only in case or spaces from an account stored with capitals → 409 (no duplicate)", r.status === 409, r);
    const r6bad = [];
    for (const bad of [123, { a: 1 }, ["x@y.z"], "   ", null]) {
      n = log.length;
      r = await post("/api/register", { fullName: "Bad", email: bad, password: "Secret-123" });
      if (!(r.status === 400 && since(n).length === 0)) r6bad.push(`${JSON.stringify(bad)} -> ${r.status}, ${since(n).length} queries`);
    }
    check("R6 non-text or blank emails (number, object, array, spaces, null) → 400 before any database query", r6bad.length === 0, r6bad);

    // ---------- login ----------
    n = log.length;
    r = await post("/api/login", { email: "  OLD.Capitals@EXAMPLE.COM ", password: PASSWORD });
    check("L1 login with different case and spaces finds the account stored with capitals → 200 with a token", r.status === 200 && !!(r.data && r.data.token), r.status);
    check("L2 the login lookup compares LOWER(email) with the normalised address", since(n).some(e => e.s === "SELECT * FROM users WHERE LOWER(email) = ?" && e.params[0] === "old.capitals@example.com"));
    r = await post("/api/login", { email: "old.capitals@example.com", password: "wrong-password" });
    check("L3 a wrong password is still refused (401)", r.status === 401, r.status);
    n = log.length;
    r = await post("/api/login", { email: 42, password: PASSWORD });
    check("L4 a non-text email at login → 400 before any query", r.status === 400 && since(n).length === 0, r.status);

    // ---------- resend verification: normalised lookup and case-proof cooldown ----------
    n = log.length;
    r = await post("/api/resend-verification", { email: "  Unverified.Person@Example.com " });
    let lookups = since(n).filter(e => e.s.startsWith("SELECT id, full_name, email_verified_at FROM users"));
    check("V1 resend verification → generic 200, lookup with LOWER(email) and the normalised address", r.status === 200 && lookups.length === 1 && lookups[0].params[0] === "unverified.person@example.com", { status: r.status, lookups });
    n = log.length;
    r = await post("/api/resend-verification", { email: "UNVERIFIED.PERSON@example.com" });
    check("V2 the same address in other capitals is inside the cooldown: generic 200 and NO second lookup", r.status === 200 && since(n).filter(e => e.s.includes("FROM users")).length === 0, since(n).map(e => e.s));

    // ---------- forgot password: normalised lookup and case-proof cooldown ----------
    n = log.length;
    r = await post("/api/forgot-password", { email: " Old.Capitals@Example.COM" });
    lookups = since(n).filter(e => e.s.startsWith("SELECT id, full_name, disabled_at FROM users"));
    check("F1 forgot password → generic 200, lookup with LOWER(email) and the normalised address", r.status === 200 && lookups.length === 1 && lookups[0].params[0] === "old.capitals@example.com", { status: r.status, lookups });
    n = log.length;
    r = await post("/api/forgot-password", { email: "old.capitals@EXAMPLE.com  " });
    check("F2 the same address in other capitals is inside the cooldown: generic 200 and NO second lookup", r.status === 200 && since(n).filter(e => e.s.includes("FROM users")).length === 0, since(n).map(e => e.s));

    // ---------- whole-run guarantees ----------
    const byEmailSql = log.filter(e => /FROM users WHERE .*email/i.test(e.s));
    check("S1 every users-by-email lookup in the run used LOWER(email)", byEmailSql.length > 0 && byEmailSql.every(e => /WHERE LOWER\(email\) = \?/.test(e.s)), byEmailSql.filter(e => !/LOWER/.test(e.s)).map(e => e.s));
    const notNormal = emailParams(log).filter(p => p !== p.trim().toLowerCase());
    check("S2 no email reached the database un-normalised", notNormal.length === 0, notNormal);
    check("S3 no unexpected statement, connection or outbound request", unexpected.length === 0 && outbound.length === 0, { unexpected, outbound });
  } catch (err) {
    failed++;
    console.log("FAIL suite crashed:", err && err.stack || err);
  }
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})();
