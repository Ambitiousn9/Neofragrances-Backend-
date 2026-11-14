// Maintenance guard: path case and spelling (Phase 2, step 1).
//
// Express matches routes case-insensitively, so "/API/payments/initialize" reaches the
// same handler as "/api/payments/initialize". Before this fix the guard tested
// req.path.startsWith("/api/") case-sensitively, so any other casing of "/api" walked
// past maintenance — payment initialization included. This suite proves that every
// spelling of a blocked route is refused while maintenance is on, that every bypass
// still answers in any casing, and that nothing changes while maintenance is off.
//
// DATABASE-FREE BY CONSTRUCTION, same method as security-headers-tests.js: ./db is
// replaced in the require cache by an in-memory fake pool before server.js loads. The
// fake answers only the read queries these requests make; any write, any other query
// and any transaction connection is refused, recorded and fails the run. DB_PORT is
// forced to 1. Outbound fetch and MX lookups are refused and recorded; the Paystack,
// SendGrid and Google keys are blank.
//
// Run: node tests/maintenance-guard-tests.js
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
const SERVER = process.cwd();

const PORT = 5090;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail === undefined ? "" : `  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`}`); }
}

// ---------- environment: set BEFORE server.js loads (dotenv never overrides) ----------
Object.assign(process.env, {
  PORT: String(PORT),
  DB_HOST: "127.0.0.1", DB_PORT: "1", DB_NAME: "nf-maintenance-guard-no-db",
  JWT_SECRET: crypto.randomBytes(32).toString("hex"), PAYMENT_SIGNING_SECRET: "", PAYSTACK_SECRET_KEY: "", PAYSTACK_API_BASE: "",
  SENDGRID_API_KEY: "", SENDGRID_FROM_EMAIL: "", GOOGLE_CLIENT_ID: "",
  DEV_EMAIL_LOG: "true", NODE_ENV: "", CORS_ORIGINS: "", FRONTEND_URL: "http://127.0.0.1:5500",
});

// ---------- instrumentation: fake pool, no outbound network ----------
let maintenanceOn = false;
const stats = { writes: [], unexpected: [], connections: 0, externalFetch: [], mx: 0 };
const fakePool = {
  async query(sql, params = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^(INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP|TRUNCATE|RENAME|GRANT)\b/i.test(s)) {
      stats.writes.push(s); throw new Error("fake pool: write refused");
    }
    if (s === "SELECT 1") return [[{ 1: 1 }], []];
    if (/FROM app_settings WHERE setting_key IN/.test(s)) {
      return [maintenanceOn ? [{ setting_key: "maintenance_mode", setting_value: "true" }] : [], []];
    }
    if (s === "SELECT * FROM products WHERE deleted_at IS NULL") return [[], []];
    if (/FROM offers JOIN offer_products ON offer_products\.offer_id = offers\.id/.test(s)) return [[], []];
    if (s === "SELECT * FROM users WHERE email = ?") return [[], []];
    stats.unexpected.push(s); throw new Error("fake pool: unexpected query");
  },
  async getConnection() { stats.connections++; throw new Error("fake pool: connections refused"); },
};
const dbPath = require.resolve(path.join(SERVER, "db.js"));
const dbModule = new Module(dbPath);
dbModule.filename = dbPath; dbModule.loaded = true; dbModule.exports = fakePool;
require.cache[dbPath] = dbModule;

require("dns").promises.Resolver.prototype.resolveMx = async function () {
  stats.mx++; throw Object.assign(new Error("MX lookup refused in tests"), { code: "ENOTFOUND" });
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => { stats.externalFetch.push(String(url)); throw new Error("outbound fetch refused in tests"); };

// ---------- helpers ----------
async function call(method, pathname, body) {
  const init = { method, headers: {} };
  if (body !== undefined) { init.body = JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
  const res = await realFetch(BASE + pathname, init);
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: res.status, data, retryAfter: res.headers.get("retry-after") };
}
const isMaint = r => r.status === 503 && !!r.data && r.data.code === "MAINTENANCE_MODE" && r.retryAfter === "600";
const show = (m, p, r) => `${m} ${p} -> ${r.status}${r.data && r.data.code ? " " + r.data.code : ""}`;

// Blocked routes: the lowercase spelling plus other casings of the same route.
const BLOCKED = [
  ["POST", "/api/payments/initialize"], ["POST", "/API/payments/initialize"], ["POST", "/Api/Payments/Initialize"], ["POST", "/api/PAYMENTS/INITIALIZE"],
  ["GET", "/api/products"], ["GET", "/API/products"], ["GET", "/Api/Products"],
  ["GET", "/api/offers/active"], ["GET", "/API/OFFERS/ACTIVE"],
  ["POST", "/api/register"], ["POST", "/aPi/register"],
  ["POST", "/api/cart/quote"], ["POST", "/API/CART/QUOTE"],
  ["PATCH", "/api/me"], ["PATCH", "/API/ME"],
  ["POST", "/api/me/password"], ["POST", "/API/Me/Password"],
  ["GET", "/api/my-orders"], ["GET", "/API/MY-ORDERS"],
  ["POST", "/api/track-order"], ["POST", "/API/TRACK-ORDER"],
];
// Other spellings that must never reach a route while maintenance is on: either the
// guard refuses them (503) or no route matches them (404). Never a handler's answer.
const ODD = [
  ["GET", "/api/products/"], ["GET", "/API/products/"], ["GET", "//api/products"], ["GET", "/%61pi/products"],
  ["GET", "/api/%70roducts"], ["POST", "/API/payments/initialize/"],
];
// Bypassed routes in other casings: must still answer, i.e. never the maintenance 503.
const BYPASS = [
  ["GET", "/api/health"], ["GET", "/API/HEALTH"], ["GET", "/Api/Health"],
  ["GET", "/api/system/status"], ["GET", "/API/SYSTEM/STATUS"],
  ["POST", "/api/login"], ["POST", "/API/LOGIN"],
  ["GET", "/api/me"], ["GET", "/API/ME"],
  ["GET", "/api/admin/summary"], ["GET", "/API/ADMIN/SUMMARY"], ["POST", "/Api/Admin/Maintenance"],
  ["GET", "/api/payments/verify/nf-1234567890-1-abcd"], ["GET", "/API/PAYMENTS/VERIFY/nf-1234567890-1-abcd"],
  ["POST", "/api/payments/webhook"], ["POST", "/API/PAYMENTS/WEBHOOK"],
];
const bodyFor = m => (m === "GET" ? undefined : {});

(async () => {
  try {
    require(path.join(SERVER, "server.js"));
    const settings = require(path.join(SERVER, "settings.js"));
    check("G0 server.js is using the in-memory fake pool, not the database", require(path.join(SERVER, "db.js")) === fakePool);
    for (let i = 0; i < 50; i++) {
      try { await realFetch(BASE + "/"); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); }
    }

    // ---------- maintenance OFF: other casings still route normally ----------
    let r = await call("GET", "/API/products");
    check("G1 maintenance OFF: GET /API/products still reaches the catalogue (200) — routing unchanged", r.status === 200 && Array.isArray(r.data), r.status);
    r = await call("GET", "/Api/Offers/Active");
    check("G2 maintenance OFF: GET /Api/Offers/Active still reaches the route (200)", r.status === 200, r.status);
    r = await call("GET", "/API/SYSTEM/STATUS");
    check("G3 maintenance OFF: the probe reports maintenance false", r.status === 200 && r.data && r.data.maintenance === false, r.data);

    // ---------- maintenance ON ----------
    maintenanceOn = true; settings.invalidateMaintenanceCache();
    r = await call("GET", "/api/system/status");
    check("G4 maintenance ON: the probe reports maintenance true", r.status === 200 && r.data && r.data.maintenance === true, r.data);

    const blockedBad = [];
    for (const [m, p] of BLOCKED) { const x = await call(m, p, bodyFor(m)); if (!isMaint(x)) blockedBad.push(show(m, p, x)); }
    check(`G5 all ${BLOCKED.length} blocked routes, in every casing, answer 503 MAINTENANCE_MODE with Retry-After 600`, blockedBad.length === 0, blockedBad);
    const initVariants = BLOCKED.filter(([, p]) => /initialize/i.test(p)).length;
    check(`G6 payment initialization is refused in all ${initVariants} spellings tried (no new payment starts during maintenance)`, !blockedBad.some(s => /initialize/i.test(s)) && initVariants === 4);

    const oddBad = [];
    for (const [m, p] of ODD) { const x = await call(m, p, bodyFor(m)); if (!(isMaint(x) || x.status === 404)) oddBad.push(show(m, p, x)); }
    check(`G7 ${ODD.length} other spellings (trailing slash, double slash, percent-encoding) are refused or unrouted — never served`, oddBad.length === 0, oddBad);

    const bypassBad = [];
    for (const [m, p] of BYPASS) { const x = await call(m, p, bodyFor(m)); if (isMaint(x) || (x.data && x.data.code === "MAINTENANCE_MODE")) bypassBad.push(show(m, p, x)); }
    check(`G8 all ${BYPASS.length} bypass routes, in every casing, still answer during maintenance (no lockout)`, bypassBad.length === 0, bypassBad);
    r = await call("GET", "/API/HEALTH");
    check("G9 GET /API/HEALTH answers 200 ok during maintenance", r.status === 200 && r.data && r.data.status === "ok", r.data);
    r = await call("POST", "/API/LOGIN", { email: "mg-nobody@example.invalid", password: "wrong" });
    check("G10 POST /API/LOGIN reaches the login handler during maintenance (401 for an unknown account)", r.status === 401, show("POST", "/API/LOGIN", r));
    r = await call("GET", "/API/ADMIN/SUMMARY");
    check("G11 an uppercase admin path is still protected by requireAdmin (401, not served)", r.status === 401, r.status);
    r = await call("POST", "/Api/Admin/Maintenance", { maintenance: false, progress: 0, message: "" });
    check("G12 the admin maintenance save in another casing still needs an admin (401)", r.status === 401, r.status);

    // ---------- maintenance OFF again ----------
    maintenanceOn = false; settings.invalidateMaintenanceCache();
    r = await call("POST", "/API/payments/initialize", {});
    check("G13 maintenance OFF again: POST /API/payments/initialize is no longer a maintenance 503 (reaches auth: 401)", r.status === 401, show("POST", "/API/payments/initialize", r));
    r = await call("GET", "/API/products");
    check("G14 maintenance OFF again: GET /API/products answers 200", r.status === 200, r.status);

    // ---------- safety net ----------
    check("S1 no write statement was attempted against the (fake) database", stats.writes.length === 0, stats.writes);
    check("S2 no unexpected query was made", stats.unexpected.length === 0, stats.unexpected);
    check("S3 no transaction connection was requested", stats.connections === 0, stats.connections);
    check("S4 no outbound HTTP request was made by the server", stats.externalFetch.length === 0, stats.externalFetch);
    check("S5 no MX/DNS lookup was made", stats.mx === 0, stats.mx);
  } catch (err) {
    failed++;
    console.log("FAIL suite crashed:", err && err.stack || err);
  }
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})();
