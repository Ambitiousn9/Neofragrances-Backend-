// Admin session lifetime + server-side logout (ADMIN-3).
//
// DATABASE-FREE AND NETWORK-ISOLATED BY CONSTRUCTION — same method as
// auth-rate-limit-tests.js and payment-issues-tests.js:
//   * ./db is replaced in the require cache, before server.js loads, by an in-memory
//     fake that implements only the statements these routes use (sign-in lookups, the
//     account-status read, requireAdmin's role read, the profile read, the maintenance
//     settings read and the logout transaction). Transactions keep an undo log, so a
//     failed commit really rolls back. Any other statement fails the run. DB_PORT is 1.
//   * Google's verifyIdToken is stubbed on google-auth-library's OAuth2Client before
//     server.js creates its client, so no request ever reaches Google.
//   * Outbound fetch and MX lookups are refused and recorded.
//   * No token or secret is printed: every console line is captured and checked.
//
// Run: node tests/admin-session-tests.js
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
const SERVER = process.cwd();

const PORT = 5086;
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = crypto.randomBytes(32).toString("hex");

// ---------- console capture (to prove no token is ever printed) ----------
const logLines = [];
for (const m of ["log", "warn", "error", "info"]) {
  const real = console[m].bind(console);
  console[m] = (...a) => { logLines.push(a.map(String).join(" ")); real(...a); };
}

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail === undefined ? "" : `  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`}`); }
}

// ---------- environment (before server.js loads; dotenv never overrides) ----------
Object.assign(process.env, {
  PORT: String(PORT),
  DB_HOST: "127.0.0.1", DB_PORT: "1", DB_NAME: "nf-admin-session-no-db",
  JWT_SECRET, PAYMENT_SIGNING_SECRET: "", PAYSTACK_SECRET_KEY: "", PAYSTACK_API_BASE: "",
  SENDGRID_API_KEY: "", SENDGRID_FROM_EMAIL: "", GOOGLE_CLIENT_ID: "nf-test-client.apps.googleusercontent.com",
  DEV_EMAIL_LOG: "true", NODE_ENV: "", CORS_ORIGINS: "", FRONTEND_URL: "http://127.0.0.1:5500",
});

// ---------- in-memory users ----------
const bcrypt = require(path.join(SERVER, "node_modules/bcrypt"));
const PASSWORD = "Correct-Horse-1";
const HASH = bcrypt.hashSync(PASSWORD, 4);
const VERIFIED = new Date("2026-10-01T00:00:00Z");
const mk = (id, email, role, extra = {}) => ({ id, full_name: `Session ${id}`, email, phone: null, role, password_hash: HASH, email_verified_at: VERIFIED,
  disabled_at: null, token_version: 0, auth_provider: "local", google_id: null, created_at: VERIFIED, ...extra });
const ADMIN = 990801, CUST = 990802, DEMOTE = 990803, DISABLED = 990804, FAILER = 990805, GADMIN = 990806, GCUST = 990807;
const users = {
  [ADMIN]: mk(ADMIN, "sess-admin@example.invalid", "admin"),
  [CUST]: mk(CUST, "sess-cust@example.invalid", "customer"),
  [DEMOTE]: mk(DEMOTE, "sess-demote@example.invalid", "admin"),
  [DISABLED]: mk(DISABLED, "sess-disabled@example.invalid", "admin", { disabled_at: VERIFIED }),
  [FAILER]: mk(FAILER, "sess-failer@example.invalid", "admin"),
  [GADMIN]: mk(GADMIN, "sess-gadmin@example.invalid", "admin", { auth_provider: "google" }),
  [GCUST]: mk(GCUST, "sess-gcust@example.invalid", "customer", { auth_provider: "google" }),
};
const byEmail = email => Object.values(users).find(u => u.email === email);
const versions = () => Object.fromEntries(Object.values(users).map(u => [u.id, u.token_version]));

const fake = { unexpected: [], writes: [], statusReads: 0, failCommitFor: null };
async function fakeQuery(sql, params = [], tx) {
  const s = String(sql).replace(/\s+/g, " ").trim();
  if (s === "SELECT * FROM users WHERE LOWER(email) = ?") { const u = byEmail(params[0]); return [u ? [{ ...u }] : [], []]; }
  if (s === "SELECT disabled_at, token_version FROM users WHERE id = ?") {
    if (!tx) fake.statusReads++;
    const u = users[Number(params[0])]; return [u ? [{ disabled_at: u.disabled_at, token_version: u.token_version }] : [], []];
  }
  if (s === "SELECT role FROM users WHERE id = ?") { const u = users[Number(params[0])]; return [u ? [{ role: u.role }] : [], []]; }
  if (s === "SELECT id, full_name, email, phone, role, created_at, email_verified_at, auth_provider, google_id FROM users WHERE id = ?") {
    const u = users[Number(params[0])]; return [u ? [{ id: u.id, full_name: u.full_name, email: u.email, phone: u.phone, role: u.role, created_at: u.created_at, email_verified_at: u.email_verified_at, auth_provider: u.auth_provider, google_id: u.google_id }] : [], []];
  }
  if (/FROM app_settings/.test(s)) return [[], []];
  // ---- logout transaction (POST /api/admin/logout) ----
  if (s === "SELECT id, disabled_at, token_version FROM users WHERE id = ? FOR UPDATE") {
    if (!tx || !tx.open) throw new Error("fake db: FOR UPDATE outside a transaction");
    const u = users[Number(params[0])]; return [u ? [{ id: u.id, disabled_at: u.disabled_at, token_version: u.token_version }] : [], []];
  }
  if (s === "UPDATE users SET token_version = token_version + 1 WHERE id = ?") {
    if (!tx || !tx.open) throw new Error("fake db: token_version update outside a transaction");
    const u = users[Number(params[0])];
    fake.writes.push({ sql: s, id: Number(params[0]) });
    if (!u) return [{ affectedRows: 0 }, []];
    u.token_version++; tx.undo.push(() => { u.token_version--; });
    return [{ affectedRows: 1 }, []];
  }
  fake.unexpected.push(s);
  throw new Error("fake db: unexpected query");
}
const fakePool = {
  query: (sql, params) => fakeQuery(sql, params, null),
  async getConnection() {
    const tx = { open: false, undo: [], id: null };
    return {
      query: (sql, params) => { if (/FOR UPDATE$/.test(String(sql).trim())) tx.id = Number(params[0]); return fakeQuery(sql, params, tx); },
      async beginTransaction() { tx.open = true; tx.undo = []; },
      async commit() {
        if (fake.failCommitFor !== null && tx.id === fake.failCommitFor) throw Object.assign(new Error("simulated commit failure"), { code: "ER_LOCK_DEADLOCK" });
        tx.open = false; tx.undo = [];
      },
      async rollback() { while (tx.undo.length) tx.undo.pop()(); tx.open = false; },
      release() {},
    };
  },
};
const dbPath = require.resolve(path.join(SERVER, "db.js"));
const dbModule = new Module(dbPath);
dbModule.filename = dbPath; dbModule.loaded = true; dbModule.exports = fakePool;
require.cache[dbPath] = dbModule;

// ---------- Google stub (before server.js builds its OAuth2Client) ----------
const { OAuth2Client } = require(path.join(SERVER, "node_modules/google-auth-library"));
const googlePayloads = {
  "g-admin": { sub: "g-sub-admin", email: "sess-gadmin@example.invalid", name: "G Admin", email_verified: true },
  "g-cust": { sub: "g-sub-cust", email: "sess-gcust@example.invalid", name: "G Cust", email_verified: true },
};
let googleCalls = 0;
OAuth2Client.prototype.verifyIdToken = async function ({ idToken }) {
  googleCalls++;
  const p = googlePayloads[idToken];
  if (!p) throw new Error("stub: unknown credential");
  return { getPayload: () => p };
};

// ---------- network isolation ----------
const net = { refused: [], mx: 0 };
require("dns").promises.Resolver.prototype.resolveMx = async function () { net.mx++; throw Object.assign(new Error("MX refused"), { code: "ENOTFOUND" }); };
const realFetch = globalThis.fetch;
globalThis.fetch = async url => { net.refused.push(String(url)); throw new Error("outbound fetch refused in tests"); };

// ---------- helpers ----------
const issuedTokens = [];
async function http_(method, pathname, { token, body } = {}) {
  const res = await realFetch(BASE + pathname, {
    method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text(); let data = {}; try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: res.status, data };
}
const keep = t => { if (t) issuedTokens.push(t); return t; };
async function passwordLogin(email) { const r = await http_("POST", "/api/login", { body: { email, password: PASSWORD } }); return { ...r, token: keep(r.data.token) }; }
async function googleLogin(credential) { const r = await http_("POST", "/api/auth/google", { body: { credential } }); return { ...r, token: keep(r.data.token) }; }
const claims = t => JSON.parse(Buffer.from(String(t).split(".")[1], "base64url").toString("utf8"));
const lifetime = t => { const c = claims(t); return c.exp - c.iat; };
const H12 = 12 * 3600, D7 = 7 * 24 * 3600;
const ADMIN_PROBE = "/api/admin/system/maintenance"; // requireAdmin, reads only app_settings
const logout = token => http_("POST", "/api/admin/logout", { token });

(async () => {
  try {
    require(path.join(SERVER, "server.js"));
    const jwt = require(path.join(SERVER, "node_modules/jsonwebtoken"));
    const accounts = require(path.join(SERVER, "accounts.js"));
    check("I0 server.js is using the in-memory fake database", require(path.join(SERVER, "db.js")) === fakePool);
    for (let i = 0; i < 50; i++) { try { await realFetch(BASE + "/"); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }

    // ---- 1–4. lifetimes on both sign-in paths ----
    const a = await passwordLogin(users[ADMIN].email);
    check("L1 admin password login → 12-hour token (claims unchanged: id, role, v)", a.status === 200 && lifetime(a.token) === H12 && claims(a.token).id === ADMIN && claims(a.token).role === "admin" && claims(a.token).v === 0, { status: a.status, life: a.token && lifetime(a.token) });
    const ga = await googleLogin("g-admin");
    check("L2 admin Google sign-in → 12-hour token", ga.status === 200 && lifetime(ga.token) === H12 && claims(ga.token).role === "admin", { status: ga.status, life: ga.token && lifetime(ga.token) });
    const c = await passwordLogin(users[CUST].email);
    check("L3 customer password login → still a 7-day token", c.status === 200 && lifetime(c.token) === D7 && claims(c.token).role === "customer", { status: c.status, life: c.token && lifetime(c.token) });
    const gc = await googleLogin("g-cust");
    check("L4 customer Google sign-in → still a 7-day token", gc.status === 200 && lifetime(gc.token) === D7 && claims(gc.token).role === "customer", { status: gc.status, life: gc.token && lifetime(gc.token) });
    check("L5 Google was never contacted (stub served both sign-ins)", googleCalls === 2 && net.refused.length === 0, { googleCalls, refused: net.refused.length });

    // ---- 5–8, 14. logout revokes only this admin, immediately on this process ----
    const pre = [await http_("GET", ADMIN_PROBE, { token: a.token }), await http_("GET", "/api/me", { token: a.token }), await http_("GET", "/api/me", { token: c.token })];
    check("R0 before logout: admin token works on an admin route and /api/me; customer token works", pre.every(r => r.status === 200), pre.map(r => r.status));
    const before = versions();
    const lo = await logout(a.token);
    const after = versions();
    const changed = Object.keys(after).filter(id => after[id] !== before[id]);
    check("R1 logout → 200 { success: true }", lo.status === 200 && lo.data.success === true && Object.keys(lo.data).length === 1, lo);
    check("R2 only the authenticated admin's token_version was incremented (by exactly 1)", changed.length === 1 && Number(changed[0]) === ADMIN && after[ADMIN] === before[ADMIN] + 1, { changed });
    const reads0 = fake.statusReads;
    const st = await accounts.readAccountStatus(ADMIN);
    check("R3 the account-status cache already holds the committed version (no database read)", st.known === true && st.tokenVersion === after[ADMIN] && st.disabled === false && fake.statusReads === reads0, { st, reads: fake.statusReads - reads0 });
    const postA = [await http_("GET", ADMIN_PROBE, { token: a.token }), await http_("GET", "/api/me", { token: a.token })];
    check("R4 the same admin token is rejected right after logout (admin route and /api/me → 401)", postA.every(r => r.status === 401), postA.map(r => r.status));
    const sameAdminGoogle = await http_("GET", ADMIN_PROBE, { token: ga.token });
    check("R5 a token for ANOTHER admin account is unaffected (only that admin's sessions end)", sameAdminGoogle.status === 200, sameAdminGoogle.status);
    const postC = await http_("GET", "/api/me", { token: c.token });
    check("R6 the customer's token is unaffected by an admin's logout", postC.status === 200 && after[CUST] === before[CUST], postC.status);
    const again = await logout(a.token);
    check("R7 repeated logout with the old token → 401, and no second increment", again.status === 401 && versions()[ADMIN] === after[ADMIN], { status: again.status, v: versions()[ADMIN] });
    const a2 = await passwordLogin(users[ADMIN].email);
    const ok2 = await http_("GET", ADMIN_PROBE, { token: a2.token });
    check("R8 signing in again works: new token carries the new version and is accepted", a2.status === 200 && claims(a2.token).v === after[ADMIN] && ok2.status === 200, { status: ok2.status, v: a2.token && claims(a2.token).v });

    // ---- 9–13. existing protections still hold ----
    const disabledLogin = await passwordLogin(users[DISABLED].email);
    const disabledToken = keep(jwt.sign({ id: DISABLED, role: "admin", v: 0 }, JWT_SECRET, { expiresIn: "12h" }));
    const w0 = fake.writes.length;
    const dz = [await http_("GET", ADMIN_PROBE, { token: disabledToken }), await logout(disabledToken)];
    check("P1 disabled admin: login refused (403) and an existing token is rejected (401), logout cannot run", disabledLogin.status === 403 && dz.every(r => r.status === 401) && fake.writes.length === w0, { login: disabledLogin.status, statuses: dz.map(r => r.status) });
    const d = await passwordLogin(users[DEMOTE].email);
    users[DEMOTE].role = "customer";
    const dm = [await http_("GET", ADMIN_PROBE, { token: d.token }), await logout(d.token)];
    check("P2 demoted admin: requireAdmin re-reads the role → 403 on admin routes and on logout, no version change", dm.every(r => r.status === 403) && versions()[DEMOTE] === 0 && fake.writes.length === w0, dm.map(r => r.status));
    const expired = keep(jwt.sign({ id: ADMIN, role: "admin", v: versions()[ADMIN], exp: Math.floor(Date.now() / 1000) - 60 }, JWT_SECRET));
    const ex = [await http_("GET", ADMIN_PROBE, { token: expired }), await logout(expired)];
    check("P3 expired token → 401 on admin routes and on logout", ex.every(r => r.status === 401), ex.map(r => r.status));
    const none = await http_("POST", "/api/admin/logout");
    check("P4 no Authorization header → 401 and no write", none.status === 401 && fake.writes.length === w0, none.status);
    const f = await passwordLogin(users[FAILER].email);
    fake.failCommitFor = FAILER;
    const fv = versions()[FAILER];
    const fl = await logout(f.token);
    fake.failCommitFor = null;
    const stillOk = await http_("GET", ADMIN_PROBE, { token: f.token });
    check("P5 commit failure → 500 (no success claimed), version rolled back, the token still works",
      fl.status === 500 && fl.data.success !== true && versions()[FAILER] === fv && stillOk.status === 200, { status: fl.status, v: versions()[FAILER], probe: stillOk.status });

    // ---- hygiene ----
    check("S1 no unexpected database statement", fake.unexpected.length === 0, fake.unexpected);
    check("S2 no outbound request and no MX lookup", net.refused.length === 0 && net.mx === 0, net);
    const leaked = issuedTokens.filter(t => logLines.some(l => l.includes(t)) || logLines.some(l => l.includes(t.split(".")[2])));
    check("S3 no token (or token signature) and no JWT secret appears in any console output", leaked.length === 0 && !logLines.some(l => l.includes(JWT_SECRET)), { leaked: leaked.length });
  } catch (err) {
    failed++;
    console.log("FAIL suite crashed:", err && (err.stack || err.message) || err);
  }
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})();
