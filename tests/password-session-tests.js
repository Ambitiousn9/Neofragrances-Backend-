// Password change / reset end existing sessions (G-1).
//
// DATABASE-FREE AND NETWORK-ISOLATED BY CONSTRUCTION — same method as
// admin-session-tests.js:
//   * ./db is replaced in the require cache, before server.js loads, by an in-memory
//     fake that implements only the statements these routes use. Transactions keep an
//     undo log, so a failed commit really rolls back. Any other statement fails the run.
//     DB_PORT is 1.
//   * Outbound fetch and MX lookups are refused and recorded.
//   * No token, password hash or reset link is printed: every console line is captured
//     and checked.
// It proves the application logic only — not MariaDB/TiDB row locking.
//
// Run: node tests/password-session-tests.js
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
const SERVER = process.cwd();

const PORT = 5087;
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = crypto.randomBytes(32).toString("hex");

// ---------- console capture (to prove no secret is ever printed) ----------
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
  DB_HOST: "127.0.0.1", DB_PORT: "1", DB_NAME: "nf-password-session-no-db",
  JWT_SECRET, PAYMENT_SIGNING_SECRET: "", PAYSTACK_SECRET_KEY: "", PAYSTACK_API_BASE: "",
  SENDGRID_API_KEY: "", SENDGRID_FROM_EMAIL: "", GOOGLE_CLIENT_ID: "nf-test-client.apps.googleusercontent.com",
  DEV_EMAIL_LOG: "true", NODE_ENV: "", CORS_ORIGINS: "", FRONTEND_URL: "http://127.0.0.1:5500",
});

// ---------- in-memory users and reset links ----------
const bcrypt = require(path.join(SERVER, "node_modules/bcrypt"));
const PASSWORD = "Correct-Horse-1";
const HASH = bcrypt.hashSync(PASSWORD, 4);
const VERIFIED = new Date("2026-10-01T00:00:00Z");
const mk = (id, email, role, extra = {}) => ({ id, full_name: `Pw ${id}`, email, phone: null, role, password_hash: HASH, email_verified_at: VERIFIED,
  disabled_at: null, token_version: 0, auth_provider: "local", google_id: null, created_at: VERIFIED, ...extra });
const CHANGER = 990901, OTHER = 990902, GUSER = 990903, ADMIN = 990904, FAILCH = 990905, RESETTER = 990906, RACER = 990907, DIS = 990908, FAILRS = 990909, GRESET = 990910;
const users = {
  [CHANGER]: mk(CHANGER, "pw-changer@example.invalid", "customer"),
  [OTHER]: mk(OTHER, "pw-other@example.invalid", "customer"),
  [GUSER]: mk(GUSER, "pw-google@example.invalid", "customer", { auth_provider: "google", google_id: "g-sub" }),
  [ADMIN]: mk(ADMIN, "pw-admin@example.invalid", "admin"),
  [FAILCH]: mk(FAILCH, "pw-failch@example.invalid", "customer"),
  [RESETTER]: mk(RESETTER, "pw-resetter@example.invalid", "customer"),
  [RACER]: mk(RACER, "pw-racer@example.invalid", "customer"),
  [DIS]: mk(DIS, "pw-disabled@example.invalid", "customer"),
  [FAILRS]: mk(FAILRS, "pw-failrs@example.invalid", "customer"),
  [GRESET]: mk(GRESET, "pw-greset@example.invalid", "customer", { auth_provider: "google", google_id: "g-sub-2" }),
};
const byEmail = email => Object.values(users).find(u => u.email === email);
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const resets = [];
let nextResetId = 1;
function addReset(userId, { expired = false } = {}) {
  const raw = crypto.randomBytes(32).toString("hex");
  resets.push({ id: nextResetId++, user_id: userId, token_hash: sha(raw), used_at: null, expires_at: new Date(Date.now() + (expired ? -60000 : 3600000)) });
  return raw;
}
const liveReset = h => resets.find(r => r.token_hash === h && r.used_at === null && r.expires_at.getTime() > Date.now());
const openResets = id => resets.filter(r => r.user_id === id && r.used_at === null).length;

const fake = { unexpected: [], failNextCommit: false };
async function fakeQuery(sql, params = [], tx) {
  const s = String(sql).replace(/\s+/g, " ").trim();
  const inTx = () => { if (!tx || !tx.open) throw new Error(`fake db: outside a transaction: ${s}`); };
  const user = () => users[Number(params[params.length - 1])];
  if (s === "SELECT * FROM users WHERE LOWER(email) = ?") { const u = byEmail(params[0]); return [u ? [{ ...u }] : [], []]; }
  if (s === "SELECT disabled_at, token_version FROM users WHERE id = ?") {
    const u = user(); return [u ? [{ disabled_at: u.disabled_at, token_version: u.token_version }] : [], []];
  }
  if (s === "SELECT id, full_name, email, phone, role, created_at, email_verified_at, auth_provider, google_id FROM users WHERE id = ?") {
    const u = user(); return [u ? [{ id: u.id, full_name: u.full_name, email: u.email, phone: u.phone, role: u.role, created_at: u.created_at, email_verified_at: u.email_verified_at, auth_provider: u.auth_provider, google_id: u.google_id }] : [], []];
  }
  if (/FROM app_settings/.test(s)) return [[], []];
  // ---- POST /api/me/password ----
  if (s === "SELECT id, role, password_hash, auth_provider, disabled_at, token_version FROM users WHERE id = ? FOR UPDATE") {
    inTx(); const u = user(); return [u ? [{ id: u.id, role: u.role, password_hash: u.password_hash, auth_provider: u.auth_provider, disabled_at: u.disabled_at, token_version: u.token_version }] : [], []];
  }
  if (s === "UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?") {
    inTx(); const u = user(); if (!u) return [{ affectedRows: 0 }, []];
    const old = { h: u.password_hash, v: u.token_version };
    u.password_hash = params[0]; u.token_version++; tx.undo.push(() => { u.password_hash = old.h; u.token_version = old.v; });
    return [{ affectedRows: 1 }, []];
  }
  if (s === "DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL") {
    inTx(); const removed = [];
    for (let i = resets.length - 1; i >= 0; i--) if (resets[i].user_id === Number(params[0]) && resets[i].used_at === null) removed.push(...resets.splice(i, 1));
    tx.undo.push(() => { resets.push(...removed); });
    return [{ affectedRows: removed.length }, []];
  }
  // ---- POST /api/reset-password ----
  if (s === "SELECT id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1") {
    const r = liveReset(params[0]); return [r ? [{ id: r.id }] : [], []];
  }
  if (s === "SELECT id, user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1 FOR UPDATE") {
    inTx(); const r = liveReset(params[0]); return [r ? [{ id: r.id, user_id: r.user_id }] : [], []];
  }
  if (s === "SELECT id, disabled_at FROM users WHERE id = ? FOR UPDATE") {
    inTx(); const u = user(); return [u ? [{ id: u.id, disabled_at: u.disabled_at }] : [], []];
  }
  if (s === "UPDATE password_resets SET used_at = NOW() WHERE id = ? AND used_at IS NULL") {
    inTx(); const r = resets.find(x => x.id === Number(params[0]) && x.used_at === null);
    if (!r) return [{ affectedRows: 0 }, []];
    r.used_at = new Date(); tx.undo.push(() => { r.used_at = null; });
    return [{ affectedRows: 1 }, []];
  }
  if (s === "UPDATE users SET password_hash = ?, auth_provider = 'local', token_version = token_version + 1 WHERE id = ?") {
    inTx(); const u = user(); if (!u) return [{ affectedRows: 0 }, []];
    const old = { h: u.password_hash, p: u.auth_provider, v: u.token_version };
    u.password_hash = params[0]; u.auth_provider = "local"; u.token_version++;
    tx.undo.push(() => { u.password_hash = old.h; u.auth_provider = old.p; u.token_version = old.v; });
    return [{ affectedRows: 1 }, []];
  }
  fake.unexpected.push(s);
  throw new Error("fake db: unexpected query");
}
const fakePool = {
  query: (sql, params) => fakeQuery(sql, params, null),
  async getConnection() {
    const tx = { open: false, undo: [] };
    return {
      query: (sql, params) => fakeQuery(sql, params, tx),
      async beginTransaction() { tx.open = true; tx.undo = []; },
      async commit() {
        if (fake.failNextCommit) { fake.failNextCommit = false; throw Object.assign(new Error("simulated commit failure"), { code: "ER_LOCK_DEADLOCK" }); }
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

// ---------- network isolation ----------
const net = { refused: [], mx: 0 };
require("dns").promises.Resolver.prototype.resolveMx = async function () { net.mx++; throw Object.assign(new Error("MX refused"), { code: "ENOTFOUND" }); };
const realFetch = globalThis.fetch;
globalThis.fetch = async url => { net.refused.push(String(url)); throw new Error("outbound fetch refused in tests"); };

// ---------- helpers ----------
const secrets = [];
async function http_(method, pathname, { token, body } = {}) {
  const res = await realFetch(BASE + pathname, {
    method, headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text(); let data = {}; try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
  if (data && data.token) secrets.push(data.token);
  return { status: res.status, data };
}
const login = (id, password = PASSWORD) => http_("POST", "/api/login", { body: { email: users[id].email, password } });
const me = token => http_("GET", "/api/me", { token });
const change = (token, currentPassword, newPassword) => http_("POST", "/api/me/password", { token, body: { currentPassword, newPassword } });
const reset = (token, password) => http_("POST", "/api/reset-password", { body: { token, password } });
const claims = t => JSON.parse(Buffer.from(String(t).split(".")[1], "base64url").toString("utf8"));
const lifetime = t => { const c = claims(t); return c.exp - c.iat; };
const tok = (id, v = 0) => { const jwt = require(path.join(SERVER, "node_modules/jsonwebtoken")); const t = jwt.sign({ id, role: users[id].role, v }, JWT_SECRET, { expiresIn: "7d" }); secrets.push(t); return t; };

(async () => {
  try {
    require(path.join(SERVER, "server.js"));
    check("I0 server.js is using the in-memory fake database", require(path.join(SERVER, "db.js")) === fakePool);
    for (let i = 0; i < 50; i++) { try { await realFetch(BASE + "/"); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }

    // ---------- password change ----------
    const a1 = (await login(CHANGER)).data.token, a2 = (await login(CHANGER)).data.token, o1 = (await login(OTHER)).data.token;
    check("C0 two sessions of the same customer (and one of another) all work", (await me(a1)).status === 200 && (await me(a2)).status === 200 && (await me(o1)).status === 200);
    const outstanding = addReset(CHANGER); secrets.push(outstanding);
    let r = await change(a1, "wrong-current", "New-Password-2");
    check("C1 wrong current password → 400, nothing revoked", r.status === 400 && r.data.field === "currentPassword" && users[CHANGER].token_version === 0 && (await me(a2)).status === 200, r);
    r = await change(a1, PASSWORD, PASSWORD);
    check("C2 same password → 400, nothing revoked", r.status === 400 && r.data.field === "newPassword" && users[CHANGER].token_version === 0, r);
    r = await change(a1, PASSWORD, "New-Password-2");
    check("C3 change → 200 with success and a fresh token", r.status === 200 && r.data.success === true && typeof r.data.token === "string", { status: r.status, keys: Object.keys(r.data) });
    const fresh = r.data.token;
    check("C4 token_version incremented exactly once; new hash stored", users[CHANGER].token_version === 1 && bcrypt.compareSync("New-Password-2", users[CHANGER].password_hash), users[CHANGER].token_version);
    check("C5 the fresh token carries the new version, same id/role, customer lifetime (7 days)", claims(fresh).v === 1 && claims(fresh).id === CHANGER && claims(fresh).role === "customer" && lifetime(fresh) === 7 * 24 * 3600, claims(fresh));
    const after = [await me(a1), await me(a2)];
    check("C6 BOTH earlier sessions (incl. the one that made the change) are rejected immediately (401)", after.every(x => x.status === 401), after.map(x => x.status));
    check("C7 the fresh token works", (await me(fresh)).status === 200);
    check("C8 another customer's session is unaffected", (await me(o1)).status === 200 && users[OTHER].token_version === 0);
    check("C9 old password no longer signs in; new one does", (await login(CHANGER)).status === 401 && (await login(CHANGER, "New-Password-2")).status === 200);
    check("C10 outstanding reset links for that account were withdrawn", openResets(CHANGER) === 0 && (await reset(outstanding, "Another-Pass-3")).status === 400);

    const g = tok(GUSER);
    r = await change(g, "x", "Whatever-99");
    check("C11 Google-only account → 400 PASSWORD_NOT_SET, no version change", r.status === 400 && r.data.code === "PASSWORD_NOT_SET" && users[GUSER].token_version === 0 && (await me(g)).status === 200, r);

    const ad = (await login(ADMIN)).data.token;
    r = await change(ad, PASSWORD, "Admin-New-Pass-4");
    check("C12 an admin's change returns a 12-hour admin token and revokes the old one", r.status === 200 && claims(r.data.token).role === "admin" && lifetime(r.data.token) === 12 * 3600 && (await me(ad)).status === 401 && (await me(r.data.token)).status === 200, { status: r.status });

    const f1 = (await login(FAILCH)).data.token; const fHash = users[FAILCH].password_hash;
    fake.failNextCommit = true;
    r = await change(f1, PASSWORD, "Never-Saved-5");
    check("C13 commit failure → 500; hash and version rolled back; old session still valid", r.status === 500 && !r.data.token && users[FAILCH].token_version === 0 && users[FAILCH].password_hash === fHash && (await me(f1)).status === 200, { status: r.status, v: users[FAILCH].token_version });

    // ---------- password reset ----------
    const s1 = (await login(RESETTER)).data.token, s2 = (await login(RESETTER)).data.token;
    const link = addReset(RESETTER), spare = addReset(RESETTER); secrets.push(link, spare);
    r = await reset(link, "Reset-Pass-6");
    check("R1 reset with a valid link → 200 { success: true }", r.status === 200 && r.data.success === true && !r.data.token, r);
    check("R2 token_version incremented once; new password stored", users[RESETTER].token_version === 1 && bcrypt.compareSync("Reset-Pass-6", users[RESETTER].password_hash));
    const rs = [await me(s1), await me(s2)];
    check("R3 every existing session is rejected immediately (401)", rs.every(x => x.status === 401), rs.map(x => x.status));
    check("R4 the new password signs in and that session works", await (async () => { const l = await login(RESETTER, "Reset-Pass-6"); return l.status === 200 && claims(l.data.token).v === 1 && (await me(l.data.token)).status === 200; })());
    check("R5 the link is marked used and the account's other unused links are deleted", resets.some(x => x.token_hash === sha(link) && x.used_at) && openResets(RESETTER) === 0);
    r = await reset(link, "Reset-Pass-7");
    check("R6 reusing the same link → 400, no second increment", r.status === 400 && users[RESETTER].token_version === 1, r.status);
    r = await reset(spare, "Reset-Pass-8");
    check("R7 a sibling link issued before the reset no longer works", r.status === 400 && users[RESETTER].token_version === 1, r.status);

    const expired = addReset(OTHER, { expired: true }); secrets.push(expired);
    r = await reset(expired, "Reset-Pass-9");
    check("R8 expired link → 400, nothing changed", r.status === 400 && users[OTHER].token_version === 0, r.status);
    r = await reset(crypto.randomBytes(32).toString("hex"), "Reset-Pass-9");
    check("R9 unknown link → 400", r.status === 400, r.status);

    const raceLink = addReset(RACER); secrets.push(raceLink);
    const race = await Promise.all([reset(raceLink, "Race-Pass-10"), reset(raceLink, "Race-Pass-11")]);
    const wins = race.filter(x => x.status === 200).length;
    check("R10 two concurrent uses of one link → exactly one succeeds, version incremented once", wins === 1 && race.filter(x => x.status === 400).length === 1 && users[RACER].token_version === 1, race.map(x => x.status));

    const disToken = tok(DIS); users[DIS].disabled_at = VERIFIED; const disLink = addReset(DIS); secrets.push(disLink); const dHash = users[DIS].password_hash;
    r = await reset(disLink, "Disabled-Pass-12");
    check("R11 disabled account's link → same generic 400; password, version and link unchanged", r.status === 400 && users[DIS].password_hash === dHash && users[DIS].token_version === 0 && openResets(DIS) === 1, r.status);
    void disToken;

    const fr1 = (await login(FAILRS)).data.token; const frLink = addReset(FAILRS); secrets.push(frLink); const frHash = users[FAILRS].password_hash;
    fake.failNextCommit = true;
    r = await reset(frLink, "Fail-Reset-13");
    check("R12 commit failure → 500; link unused, hash/version rolled back, old session still valid", r.status === 500 && users[FAILRS].token_version === 0 && users[FAILRS].password_hash === frHash && openResets(FAILRS) === 1 && (await me(fr1)).status === 200, { status: r.status });
    r = await reset(frLink, "Fail-Reset-13");
    check("R13 the same link then works once the database is healthy", r.status === 200 && users[FAILRS].token_version === 1 && (await me(fr1)).status === 401, r.status);

    const gLink = addReset(GRESET); secrets.push(gLink);
    r = await reset(gLink, "Google-Set-14");
    check("R14 a Google-only account can set a password by link; it becomes 'local' and its sessions end", r.status === 200 && users[GRESET].auth_provider === "local" && users[GRESET].token_version === 1, r.status);

    const bad = [await reset(12345, "Whatever-15"), await reset("abc", 123456789), await reset("abc", ["Whatever-15"]), await reset("abc", "x".repeat(201)), await reset("abc", "short")];
    check("R15 malformed input → 400, never 500 (number token, non-string / array / too long / too short password)", bad.every(x => x.status === 400), bad.map(x => x.status));

    // ---------- isolation and hygiene ----------
    check("H1 no unexpected database statement", fake.unexpected.length === 0, fake.unexpected);
    check("H2 no outbound request or MX lookup", net.refused.length === 0 && net.mx === 0, net);
    const leaked = logLines.filter(l => secrets.some(sv => sv && l.includes(sv)) || Object.values(users).some(u => l.includes(u.password_hash)));
    check("H3 no token, reset link or password hash was printed", leaked.length === 0, leaked.length);
  } catch (err) {
    failed++; console.log(`FAIL harness error: ${err && err.message}`);
  } finally {
    console.log(`\n${passed}/${passed + failed} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
