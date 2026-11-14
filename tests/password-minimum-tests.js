// Password minimum of 8 characters (G-9, 2026-11-14).
//
// Every route that sets a NEW password — registration, password reset and password
// change — refuses fewer than MIN_PASSWORD_LENGTH (8) characters before touching the
// database, and accepts exactly 8. Registration also refuses a password that is not text
// (before G-9 a number such as 12345678 slipped past `.length`). Login never applies the
// minimum, so an account whose password was set under the old 6-character rule still
// signs in.
//
// DATABASE-FREE AND NETWORK-ISOLATED BY CONSTRUCTION, same method as
// password-session-tests.js: ./db is replaced in the require cache by an in-memory fake
// that answers only the statements these routes use (transactions keep an undo log) and
// records every statement; DB_PORT is 1; outbound fetch is refused; MX lookups are
// answered by a stub. No real account, database or mail server is used.
//
// Run: node tests/password-minimum-tests.js
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
const SERVER = process.cwd();

const PORT = 5092;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail === undefined ? "" : `  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`}`); }
}

// ---------- environment: set BEFORE server.js loads (dotenv never overrides) ----------
Object.assign(process.env, {
  PORT: String(PORT),
  DB_HOST: "127.0.0.1", DB_PORT: "1", DB_NAME: "nf-password-minimum-no-db",
  JWT_SECRET: crypto.randomBytes(32).toString("hex"),
  PAYMENT_SIGNING_SECRET: "", PAYSTACK_SECRET_KEY: "", PAYSTACK_API_BASE: "",
  SENDGRID_API_KEY: "", SENDGRID_FROM_EMAIL: "", GOOGLE_CLIENT_ID: "",
  DEV_EMAIL_LOG: "true", NODE_ENV: "", CORS_ORIGINS: "", FRONTEND_URL: "http://127.0.0.1:5500",
});

// ---------- in-memory users and reset links ----------
const bcrypt = require(path.join(SERVER, "node_modules/bcrypt"));
const PASSWORD = "Correct-Horse-1";
const OLD_SIX = "old6pw";             // set under the old 6-character rule
const VERIFIED = new Date("2026-10-01T00:00:00Z");
const mk = (id, email, password) => ({ id, full_name: `Min ${id}`, email, phone: null, role: "customer", password_hash: bcrypt.hashSync(password, 4),
  email_verified_at: VERIFIED, disabled_at: null, token_version: 0, auth_provider: "local", google_id: null, created_at: VERIFIED });
const CHANGER = 991001, RESETTER = 991002, LEGACY = 991003;
const users = {
  [CHANGER]: mk(CHANGER, "min-changer@example.invalid", PASSWORD),
  [RESETTER]: mk(RESETTER, "min-resetter@example.invalid", PASSWORD),
  [LEGACY]: mk(LEGACY, "min-legacy@example.invalid", OLD_SIX),
};
let nextId = 991100;
const byLower = v => Object.values(users).find(u => u.email.toLowerCase() === v);
const sha = s => crypto.createHash("sha256").update(s).digest("hex");
const resets = [];
let nextResetId = 1;
function addReset(userId) {
  const raw = crypto.randomBytes(32).toString("hex");
  resets.push({ id: nextResetId++, user_id: userId, token_hash: sha(raw), used_at: null, expires_at: new Date(Date.now() + 3600000) });
  return raw;
}
const liveReset = h => resets.find(r => r.token_hash === h && r.used_at === null && r.expires_at.getTime() > Date.now());

const log = [];            // every statement, outside and inside transactions
const unexpected = [];
let connections = 0;
async function fakeQuery(sql, params = [], tx) {
  const s = String(sql).replace(/\s+/g, " ").trim();
  log.push(s);
  const inTx = () => { if (!tx || !tx.open) throw new Error(`fake db: outside a transaction: ${s}`); };
  const user = () => users[Number(params[params.length - 1])];
  if (/FROM app_settings/.test(s)) return [[], []];
  // ---- login and authentication ----
  if (s === "SELECT * FROM users WHERE LOWER(email) = ?") { const u = byLower(params[0]); return [u ? [{ ...u }] : [], []]; }
  if (s === "SELECT disabled_at, token_version FROM users WHERE id = ?") { const u = user(); return [u ? [{ disabled_at: u.disabled_at, token_version: u.token_version }] : [], []]; }
  // ---- POST /api/register ----
  if (s === "SELECT id FROM users WHERE LOWER(email) = ?") { const u = byLower(params[0]); return [u ? [{ id: u.id }] : [], []]; }
  if (/^INSERT INTO users \(full_name, email, phone, password_hash, role\)/.test(s)) {
    const id = nextId++; users[id] = { ...mk(id, params[1], "unused-placeholder"), full_name: params[0], password_hash: params[3], email_verified_at: null };
    return [{ insertId: id, affectedRows: 1 }, []];
  }
  if (/^(DELETE FROM|INSERT INTO|UPDATE) email_verifications\b/.test(s)) return [{ insertId: 1, affectedRows: 1 }, []];
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
  unexpected.push(s);
  throw new Error("fake db: unexpected query");
}
const fakePool = {
  query: (sql, params) => fakeQuery(sql, params, null),
  async getConnection() {
    connections++;
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
const mxDomains = [];
require("dns").promises.Resolver.prototype.resolveMx = async function (domain) { mxDomains.push(domain); return [{ exchange: "mx.example.invalid", priority: 10 }]; };
const realFetch = globalThis.fetch;
const outbound = [];
globalThis.fetch = async url => { outbound.push(String(url)); throw new Error("outbound fetch refused in tests"); };

// ---------- helpers ----------
let ipN = 1;
async function http_(method, pathname, { token, body } = {}) {
  const res = await realFetch(BASE + pathname, {
    method,
    headers: { "X-Forwarded-For": `203.0.113.${ipN++}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text(); let data = {}; try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: res.status, data };
}
const register = (email, password) => http_("POST", "/api/register", { body: { fullName: "Min Person", email, password } });
const login = (id, password = PASSWORD) => http_("POST", "/api/login", { body: { email: users[id].email, password } });
const change = (token, currentPassword, newPassword) => http_("POST", "/api/me/password", { token, body: { currentPassword, newPassword } });
const reset = (token, password) => http_("POST", "/api/reset-password", { body: { token, password } });
const SEVEN = "Abcdef1", EIGHT = "Abcdef12";
const says8 = r => typeof (r.data && r.data.error) === "string" && /at least 8 characters/.test(r.data.error);

(async () => {
  try {
    require(path.join(SERVER, "server.js"));
    check("P0 server.js is using the in-memory fake database", require(path.join(SERVER, "db.js")) === fakePool);
    for (let i = 0; i < 50; i++) { try { await realFetch(BASE + "/"); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); } }
    const appQueries = () => log.filter(s => !/FROM app_settings/.test(s)).length;

    // ---------- registration ----------
    let n = appQueries(), mx = mxDomains.length;
    let r = await register("min-seven@example.com", SEVEN);
    check("RG1 register with 7 characters → 400 'at least 8 characters', before any query or MX lookup", r.status === 400 && says8(r) && appQueries() === n && mxDomains.length === mx, r);
    n = appQueries();
    r = await register("min-six@example.com", "Abcde1");
    check("RG2 register with 6 characters (the old minimum) → 400", r.status === 400 && says8(r) && appQueries() === n, r);
    r = await register("min-eight@example.com", EIGHT);
    const created = byLower("min-eight@example.com");
    check("RG3 register with exactly 8 characters → 201 and the account is stored with that password", r.status === 201 && !!created && bcrypt.compareSync(EIGHT, created.password_hash), r);
    const rg4 = [];
    for (const bad of [12345678, 123456789012, ["Abcdef12"], { p: "Abcdef12" }, true]) {
      n = appQueries();
      r = await register("min-badtype@example.com", bad);
      if (!(r.status === 400 && appQueries() === n)) rg4.push(`${JSON.stringify(bad)} -> ${r.status}, ${appQueries() - n} queries`);
    }
    check("RG4 a password that is not text (number, array, object, boolean) → 400 before any query, never 500", rg4.length === 0, rg4);

    // ---------- password change ----------
    const t = (await login(CHANGER)).data.token;
    check("CH0 the changer signs in", typeof t === "string");
    const conns = connections, v0 = users[CHANGER].token_version, h0 = users[CHANGER].password_hash;
    r = await change(t, PASSWORD, SEVEN);
    check("CH1 change to 7 characters → 400 on the newPassword field, 'at least 8 characters'", r.status === 400 && r.data.field === "newPassword" && says8(r), r);
    check("CH2 ...refused before any transaction: hash and version unchanged", connections === conns && users[CHANGER].token_version === v0 && users[CHANGER].password_hash === h0);
    r = await change(t, PASSWORD, EIGHT);
    check("CH3 change to exactly 8 characters → 200 with a fresh token; the new password is stored", r.status === 200 && r.data.success === true && bcrypt.compareSync(EIGHT, users[CHANGER].password_hash), { status: r.status });

    // ---------- password reset ----------
    const link = addReset(RESETTER);
    n = appQueries();
    r = await reset(link, SEVEN);
    check("RS1 reset to 7 characters → 400 'at least 8 characters', before any query", r.status === 400 && says8(r) && appQueries() === n, r);
    check("RS2 ...the link is still unused and the password unchanged", !!liveReset(sha(link)) && bcrypt.compareSync(PASSWORD, users[RESETTER].password_hash));
    r = await reset(link, EIGHT);
    check("RS3 reset to exactly 8 characters with the same link → 200; the new password is stored", r.status === 200 && r.data.success === true && bcrypt.compareSync(EIGHT, users[RESETTER].password_hash), r);

    // ---------- login keeps older, shorter passwords working ----------
    r = await login(LEGACY, OLD_SIX);
    check("LG1 an account whose password was set under the old 6-character rule still signs in (200)", r.status === 200 && typeof r.data.token === "string", r.status);
    r = await login(LEGACY, "wrong1");
    check("LG2 a wrong short password is still refused (401), not a length error", r.status === 401 && !says8(r), r);

    // ---------- the same rule everywhere ----------
    const src = require("fs").readFileSync(path.join(SERVER, "server.js"), "utf8");
    check("K1 server.js defines MIN_PASSWORD_LENGTH = 8 exactly once and has no literal 6-character password check left",
      (src.match(/const MIN_PASSWORD_LENGTH = 8;/g) || []).length === 1 && !/MIN_PASSWORD_LENGTH = 6/.test(src) && !/\.length < 6\b/.test(src) && !/at least 6 characters/.test(src));

    // ---------- isolation ----------
    check("H1 no unexpected database statement", unexpected.length === 0, unexpected);
    check("H2 no outbound request", outbound.length === 0, outbound);
  } catch (err) {
    failed++; console.log(`FAIL harness error: ${err && err.message}`);
  } finally {
    console.log(`\n${passed}/${passed + failed} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
