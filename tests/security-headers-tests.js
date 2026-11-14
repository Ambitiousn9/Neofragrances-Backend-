// Security headers on API responses (Roadmap Task 4, backend Phase A).
//
// DATABASE-FREE BY CONSTRUCTION, exactly like auth-rate-limit-tests.js: ./db is
// replaced in the require cache by an in-memory fake pool before server.js loads.
// The fake answers only the read queries the requests below make; any write, any
// other query and any transaction connection is refused, recorded and fails the run.
// DB_PORT is forced to 1 so even a bypassed stub could not reach the real database.
// The server's outbound fetch and MX lookups are refused and recorded, and the
// Paystack / SendGrid / Google keys are blank. No account is created or used: the
// one signed-in request uses a throwaway JWT for a user that exists only in the
// fake pool's memory.
//
// Run: node tests/security-headers-tests.js
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
const SERVER = process.cwd();

const PORT = 5080;
const BASE = `http://127.0.0.1:${PORT}`;
const ALLOWED_ORIGIN = "http://127.0.0.1:5500"; // a dev origin, allowed outside production

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail === undefined ? "" : `  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`}`); }
}

// ---------- environment: set BEFORE server.js loads (dotenv never overrides) ----------
const JWT_SECRET = crypto.randomBytes(32).toString("hex");
Object.assign(process.env, {
  PORT: String(PORT),
  DB_HOST: "127.0.0.1", DB_PORT: "1", DB_NAME: "nf-security-headers-no-db",
  JWT_SECRET, PAYMENT_SIGNING_SECRET: "", PAYSTACK_SECRET_KEY: "", PAYSTACK_API_BASE: "",
  SENDGRID_API_KEY: "", SENDGRID_FROM_EMAIL: "", GOOGLE_CLIENT_ID: "",
  DEV_EMAIL_LOG: "true", NODE_ENV: "", CORS_ORIGINS: "", FRONTEND_URL: "http://127.0.0.1:5500",
});

// ---------- instrumentation: fake pool, no outbound network ----------
const FAKE_USER = { id: 990101, full_name: "Headers Test", email: "sh-user@example.invalid", phone: null, role: "customer", created_at: new Date(), email_verified_at: new Date(), auth_provider: "local", google_id: null, disabled_at: null, token_version: 0 };
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
    if (/FROM reviews JOIN users ON reviews\.user_id = users\.id WHERE reviews\.product_id = \?/.test(s)) return [[], []];
    if (s === "SELECT * FROM users WHERE email = ?") return [[], []];
    if (s === "SELECT disabled_at, token_version FROM users WHERE id = ?") {
      return [Number(params[0]) === FAKE_USER.id ? [{ disabled_at: null, token_version: 0 }] : [], []];
    }
    if (/^SELECT id, full_name, email, phone, role, created_at, email_verified_at, auth_provider, google_id FROM users WHERE id = \?$/.test(s)) {
      return [Number(params[0]) === FAKE_USER.id ? [{ ...FAKE_USER }] : [], []];
    }
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
async function call(method, pathname, { headers = {}, body, raw } = {}) {
  const init = { method, headers: { ...headers } };
  if (raw !== undefined) { init.body = raw; init.headers["Content-Type"] = "application/json"; }
  else if (body !== undefined) { init.body = JSON.stringify(body); init.headers["Content-Type"] = "application/json"; }
  const res = await realFetch(BASE + pathname, init);
  const text = await res.text();
  return { status: res.status, h: res.headers, text };
}

const API_CSP = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
// Express's default 404 / error handler (finalhandler) sets its own, also strict,
// CSP on the HTML error page it writes; every other header survives.
const FINALHANDLER_CSP = "default-src 'none'";
function baseHeadersOk(r, csp = API_CSP) {
  const h = r.h;
  const problems = [];
  const want = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "content-security-policy": csp,
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-resource-policy": "same-origin",
    "x-dns-prefetch-control": "off",
  };
  for (const [k, v] of Object.entries(want)) if (h.get(k) !== v) problems.push(`${k}=${h.get(k)}`);
  if (h.get("x-powered-by") !== null) problems.push(`x-powered-by=${h.get("x-powered-by")}`);
  return { ok: problems.length === 0, problems };
}
function headerCheck(name, r, { csp, noStore, status } = {}) {
  const b = baseHeadersOk(r, csp);
  const cc = r.h.get("cache-control");
  const storeOk = noStore === undefined ? true : noStore ? cc === "no-store" : cc !== "no-store";
  const statusOk = status === undefined ? true : r.status === status;
  check(name, b.ok && storeOk && statusOk, { status: r.status, problems: b.problems, cacheControl: cc });
}

// ======================================================================
// Unit: the private-route matcher
// ======================================================================
function unitTests() {
  const { isNoStorePath, BASE_HEADERS, HSTS_VALUE } = require(path.join(SERVER, "security-headers.js"));
  const yes = ["/api/me", "/api/me/password", "/api/me/", "/API/ME", "/api/my-orders", "/api/my-orders/12/history",
    "/api/addresses", "/api/addresses/5/default", "/api/wishlist", "/api/wishlist/7",
    "/api/admin/summary", "/api/admin/products/1/stock", "/Api/Admin/Orders",
    "/api/payments/initialize", "/api/payments/verify/NF-1234567890", "/api/payments/webhook"];
  const no = ["/api/products", "/api/products/1/reviews", "/api/offers/active", "/api/health", "/api/system/status",
    "/api/cart/quote", "/api/login", "/api/register", "/", "/api/media", "/api/mein", "/api/my-ordersx",
    "/api/addresses-old", "/api/wishlisted", "/api/administrator", "/api/admin", "/api/paymentsx/verify", "/api/payment/x"];
  const wrongYes = yes.filter(p => !isNoStorePath(p));
  const wrongNo = no.filter(p => isNoStorePath(p));
  check("U1 no-store matches every private route group (whole segments, case-insensitive)", wrongYes.length === 0, wrongYes);
  check("U2 no-store never matches public catalogue, auth, health or look-alike paths", wrongNo.length === 0, wrongNo);
  check("U3 header values are exactly the approved ones",
    BASE_HEADERS["Content-Security-Policy"] === API_CSP && BASE_HEADERS["X-Frame-Options"] === "DENY"
    && BASE_HEADERS["Referrer-Policy"] === "no-referrer" && BASE_HEADERS["X-Content-Type-Options"] === "nosniff"
    && BASE_HEADERS["Cross-Origin-Opener-Policy"] === "same-origin" && BASE_HEADERS["Cross-Origin-Resource-Policy"] === "same-origin"
    && BASE_HEADERS["X-DNS-Prefetch-Control"] === "off" && HSTS_VALUE === "max-age=86400");
  check("U4 HSTS has no includeSubDomains and no preload", !/includesubdomains|preload/i.test(HSTS_VALUE));
}

// ======================================================================
// Integration: real server.js, fake pool
// ======================================================================
async function integrationTests() {
  require(path.join(SERVER, "server.js"));
  const settings = require(path.join(SERVER, "settings.js"));
  check("I0 server.js is using the in-memory fake pool, not the database", require(path.join(SERVER, "db.js")) === fakePool);
  for (let i = 0; i < 50; i++) {
    try { await realFetch(BASE + "/"); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); }
  }

  // Successful public responses
  const root = await call("GET", "/");
  headerCheck("I1 GET / (plain text): all headers, no X-Powered-By, not no-store", root, { status: 200, noStore: false });
  const health = await call("GET", "/api/health");
  headerCheck("I2 GET /api/health: all headers, not no-store", health, { status: 200, noStore: false });
  const products = await call("GET", "/api/products", { headers: { Origin: ALLOWED_ORIGIN } });
  headerCheck("I3 GET /api/products (public catalogue): all headers, NOT no-store", products, { status: 200, noStore: false });
  check("I4 public catalogue keeps its previous caching headers (no Cache-Control at all)", products.h.get("cache-control") === null, products.h.get("cache-control"));
  check("I5 CORS still allows the configured origin on a normal response", products.h.get("access-control-allow-origin") === ALLOWED_ORIGIN, products.h.get("access-control-allow-origin"));
  const badOrigin = await call("GET", "/api/products", { headers: { Origin: "https://evil.example" } });
  check("I6 CORS still refuses an unknown origin (no allow-origin header)", badOrigin.status === 200 && badOrigin.h.get("access-control-allow-origin") === null);
  const offers = await call("GET", "/api/offers/active");
  headerCheck("I7 GET /api/offers/active (public): all headers, NOT no-store", offers, { status: 200, noStore: false });
  const reviews = await call("GET", "/api/products/1/reviews");
  headerCheck("I8 GET /api/products/1/reviews (public): all headers, NOT no-store", reviews, { status: 200, noStore: false });

  // Private responses
  const token = require(path.join(SERVER, "node_modules/jsonwebtoken")).sign({ id: FAKE_USER.id, role: "customer", v: 0 }, JWT_SECRET, { expiresIn: "5m" });
  const me = await call("GET", "/api/me", { headers: { Authorization: `Bearer ${token}`, Origin: ALLOWED_ORIGIN } });
  headerCheck("I9 GET /api/me signed in (200, in-memory user): all headers + no-store", me, { status: 200, noStore: true });
  check("I10 the private 200 still carries CORS for the allowed origin", me.h.get("access-control-allow-origin") === ALLOWED_ORIGIN);
  const privateUnauth = [
    ["GET", "/api/me"], ["GET", "/api/my-orders"], ["GET", "/api/my-orders/1/history"], ["GET", "/api/addresses"],
    ["GET", "/api/wishlist"], ["GET", "/api/admin/summary"], ["GET", "/api/admin/orders"], ["POST", "/api/payments/initialize"],
    ["GET", "/api/payments/verify/NF-1234567890-1-abcd"], ["GET", "/API/ME"], ["GET", "/api/me/"],
  ];
  const results = [];
  for (const [m, p] of privateUnauth) results.push([m, p, await call(m, p, { body: m === "POST" ? {} : undefined })]);
  const bad = results.filter(([, , r]) => !(r.status === 401 && r.h.get("cache-control") === "no-store" && baseHeadersOk(r).ok));
  check("I11 every private route group answers 401 unauthenticated with all headers + no-store (incl. /API/ME and trailing slash)", bad.length === 0, bad.map(([m, p, r]) => `${m} ${p} ${r.status} ${r.h.get("cache-control")}`));

  // CORS preflight
  const pre = await call("OPTIONS", "/api/me", { headers: { Origin: ALLOWED_ORIGIN, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization,content-type" } });
  headerCheck("I12 CORS preflight (OPTIONS /api/me): all headers + no-store", pre, { status: 204, noStore: true });
  check("I13 preflight still approves the allowed origin and the Authorization header", pre.h.get("access-control-allow-origin") === ALLOWED_ORIGIN && /authorization/i.test(pre.h.get("access-control-allow-headers") || ""), [pre.h.get("access-control-allow-origin"), pre.h.get("access-control-allow-headers")]);
  const prePublic = await call("OPTIONS", "/api/products", { headers: { Origin: ALLOWED_ORIGIN, "Access-Control-Request-Method": "GET" } });
  headerCheck("I14 CORS preflight on a public route: all headers, not no-store", prePublic, { status: 204, noStore: false });

  // Malformed JSON is answered by the app's JSON error handler (G-7), so the response keeps the
  // API's own headers; 404 is still written by Express's default handler (finalhandler).
  const jsonError = (r, code) => { try { const b = JSON.parse(r.text); return b.code === code && typeof b.error === "string" && !/\bat\s|SyntaxError|node_modules/.test(r.text); } catch (e) { return false; } };
  const malformed = await call("POST", "/api/login", { raw: "{not json" });
  headerCheck("I15 malformed JSON body → 400 with every header (the API's own CSP)", malformed, { status: 400, noStore: false });
  check("I15b malformed JSON → JSON body INVALID_JSON, no stack trace", jsonError(malformed, "INVALID_JSON"), malformed.text.slice(0, 120));
  const malformedPrivate = await call("POST", "/api/me/password", { raw: "{not json" });
  headerCheck("I16 malformed JSON on a private route → 400 with every header + no-store", malformedPrivate, { status: 400, noStore: true });
  check("I16b malformed JSON on a private route → JSON body INVALID_JSON, no stack trace", jsonError(malformedPrivate, "INVALID_JSON"), malformedPrivate.text.slice(0, 120));
  const notFound = await call("GET", "/api/does-not-exist");
  headerCheck("I17 unknown route → 404 with every header (finalhandler's strict CSP)", notFound, { status: 404, csp: FINALHANDLER_CSP, noStore: false });
  const lookalike = await call("GET", "/api/media");
  headerCheck("I18 a look-alike path (/api/media) is not treated as private", lookalike, { status: 404, csp: FINALHANDLER_CSP, noStore: false });

  // Rate limiting still works and carries the headers
  const IP = "203.0.113.20";
  const fails = [];
  for (let i = 0; i < 5; i++) fails.push(await call("POST", "/api/login", { headers: { "X-Forwarded-For": IP }, body: { email: "sh-nobody@example.invalid", password: "wrong" } }));
  const limited = await call("POST", "/api/login", { headers: { "X-Forwarded-For": IP, Origin: ALLOWED_ORIGIN }, body: { email: "sh-nobody@example.invalid", password: "wrong" } });
  let limitedBody = null; try { limitedBody = JSON.parse(limited.text); } catch (e) { /* not JSON */ }
  check("I19 login rate limit unchanged: five 401s then 429 RATE_LIMITED with Retry-After", fails.every(r => r.status === 401) && limited.status === 429 && limitedBody && limitedBody.code === "RATE_LIMITED" && /^\d+$/.test(limited.h.get("retry-after") || ""), fails.map(r => r.status).join(",") + "|" + limited.status);
  headerCheck("I20 the 429 carries every security header", limited, { status: 429, noStore: false });
  check("I21 the 429 still carries CORS for the allowed origin", limited.h.get("access-control-allow-origin") === ALLOWED_ORIGIN);
  const regs = [];
  for (let i = 0; i < 10; i++) regs.push(await call("POST", "/api/register", { headers: { "X-Forwarded-For": "203.0.113.21" }, body: { fullName: "X", email: `sh-reg-${i}@example.invalid`, password: "123" } }));
  const reg11 = await call("POST", "/api/register", { headers: { "X-Forwarded-For": "203.0.113.21" }, body: { fullName: "X", email: "sh-reg-x@example.invalid", password: "123" } });
  check("I22 registration rate limit unchanged: ten 400s then 429", regs.every(r => r.status === 400) && reg11.status === 429, regs.map(r => r.status).join(",") + "|" + reg11.status);
  headerCheck("I23 the registration 429 carries every security header", reg11, { status: 429, noStore: false });

  // Maintenance 503 (the fake settings row is switched on, the 7 s cache invalidated)
  maintenanceOn = true; settings.invalidateMaintenanceCache();
  const maint = await call("GET", "/api/products");
  headerCheck("I24 maintenance 503 carries every security header", maint, { status: 503, noStore: false });
  check("I25 maintenance 503 keeps its Retry-After and MAINTENANCE_MODE code", maint.h.get("retry-after") === "600" && /MAINTENANCE_MODE/.test(maint.text), [maint.h.get("retry-after"), maint.text.slice(0, 80)]);
  const maintPrivate = await call("GET", "/api/my-orders");
  headerCheck("I26 maintenance 503 on a private route also gets no-store", maintPrivate, { status: 503, noStore: true });
  maintenanceOn = false; settings.invalidateMaintenanceCache();
  const after = await call("GET", "/api/products");
  check("I27 maintenance switched back off: public route answers 200 again", after.status === 200, after.status);

  // HSTS only over (simulated) HTTPS
  const httpsReq = await call("GET", "/api/health", { headers: { "X-Forwarded-Proto": "https" } });
  check("I28 HSTS sent when the proxy reports HTTPS: exactly max-age=86400", httpsReq.h.get("strict-transport-security") === "max-age=86400", httpsReq.h.get("strict-transport-security"));
  const plain = await call("GET", "/api/health");
  check("I29 no HSTS on a plain HTTP request", plain.h.get("strict-transport-security") === null, plain.h.get("strict-transport-security"));
  const httpProto = await call("GET", "/api/health", { headers: { "X-Forwarded-Proto": "http" } });
  check("I30 no HSTS when the proxy reports HTTP", httpProto.h.get("strict-transport-security") === null);
  const httpsPrivate = await call("GET", "/api/me", { headers: { "X-Forwarded-Proto": "https" } });
  check("I31 HSTS also reaches private and error responses over HTTPS", httpsPrivate.h.get("strict-transport-security") === "max-age=86400" && httpsPrivate.status === 401);

  // Safety net
  check("S1 no write statement was attempted against the (fake) database", stats.writes.length === 0, stats.writes);
  check("S2 no unexpected query was made", stats.unexpected.length === 0, stats.unexpected);
  check("S3 no transaction connection was requested", stats.connections === 0, stats.connections);
  check("S4 no outbound HTTP request was made by the server", stats.externalFetch.length === 0, stats.externalFetch);
  check("S5 no MX/DNS lookup was made", stats.mx === 0, stats.mx);
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
