// Login + registration rate limiting (Roadmap Task 3).
//
// DATABASE-FREE BY CONSTRUCTION. Unlike the other suites this one never connects to
// MariaDB: before server.js is loaded, ./db is replaced in the require cache by an
// in-memory fake pool. The fake answers only the read queries these routes make
// (user lookup by email, the maintenance-settings read, the track-order lookup);
// any write statement, any other query and any transaction connection is refused
// and recorded, and the run fails. DB_PORT is also forced to 1, so even if the stub
// were bypassed nothing could reach the real database.
//
// It also never leaves the machine: the server's global fetch (Paystack, SendGrid)
// is replaced with a recorder that refuses every call, the MX lookup used by
// registration is replaced with a recorder, and the Paystack/SendGrid/Google keys
// are blanked. Registration payloads are deliberately invalid, or blocked by the
// limiter, so no account can ever be created. The "accounts" the login checks use
// are rows held in the fake pool's memory — no real user is created or used.
//
// The server runs in this process on port 5079 so its database calls can be
// counted. Distinct client IPs are simulated with X-Forwarded-For, which Express
// honours here because of `trust proxy 1` and because nothing sits in front of a
// local server. That is a property of local testing, not something that is safe to
// rely on in production — see the trust-proxy note in server.js.
//
// Run: node tests/auth-rate-limit-tests.js
const path = require("path");
const crypto = require("crypto");
const Module = require("module");
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
const SERVER = process.cwd();

const PORT = 5079;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail === undefined ? "" : `  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`}`); }
}

// ---------- environment: set BEFORE server.js loads (dotenv never overrides) ----------
Object.assign(process.env, {
  PORT: String(PORT),
  DB_HOST: "127.0.0.1", DB_PORT: "1", DB_NAME: "nf-rate-limit-no-db",
  JWT_SECRET: crypto.randomBytes(32).toString("hex"),
  PAYMENT_SIGNING_SECRET: "", PAYSTACK_SECRET_KEY: "", PAYSTACK_API_BASE: "",
  SENDGRID_API_KEY: "", SENDGRID_FROM_EMAIL: "", GOOGLE_CLIENT_ID: "",
  DEV_EMAIL_LOG: "true", NODE_ENV: "", CORS_ORIGINS: "", FRONTEND_URL: "http://127.0.0.1:5500",
});

// ---------- instrumentation ----------
const bcrypt = require(path.join(SERVER, "node_modules/bcrypt"));
const PASSWORD = "Correct-Horse-1";
const HASH = bcrypt.hashSync(PASSWORD, 4);
const FAKE_USERS = {
  "rl-unverified@example.invalid": { id: 990001, full_name: "RL Unverified", email: "rl-unverified@example.invalid", role: "customer", password_hash: HASH, email_verified_at: null, disabled_at: null, token_version: 0 },
  "rl-disabled@example.invalid": { id: 990002, full_name: "RL Disabled", email: "rl-disabled@example.invalid", role: "customer", password_hash: HASH, email_verified_at: new Date(), disabled_at: new Date(), token_version: 1 },
  "rl-verified@example.invalid": { id: 990003, full_name: "RL Verified", email: "rl-verified@example.invalid", role: "customer", password_hash: HASH, email_verified_at: new Date(), disabled_at: null, token_version: 0 },
};
const stats = { userLookups: 0, writes: [], unexpected: [], connections: 0, externalFetch: [], mx: 0 };
const fakePool = {
  async query(sql, params = []) {
    const s = String(sql).replace(/\s+/g, " ").trim();
    if (/^(INSERT|UPDATE|DELETE|REPLACE|ALTER|CREATE|DROP|TRUNCATE|RENAME|GRANT)\b/i.test(s)) {
      stats.writes.push(s); throw new Error("fake pool: write refused");
    }
    if (s === "SELECT * FROM users WHERE LOWER(email) = ?") {
      stats.userLookups++;
      const u = FAKE_USERS[params[0]];
      return [u ? [{ ...u }] : [], []];
    }
    if (/FROM app_settings WHERE setting_key IN/.test(s)) return [[], []];
    if (/FROM orders JOIN users ON orders\.user_id = users\.id/.test(s)) return [[], []];
    stats.unexpected.push(s); throw new Error("fake pool: unexpected query");
  },
  async getConnection() { stats.connections++; throw new Error("fake pool: connections refused"); },
};
const dbPath = require.resolve(path.join(SERVER, "db.js"));
const dbModule = new Module(dbPath);
dbModule.filename = dbPath; dbModule.loaded = true; dbModule.exports = fakePool;
require.cache[dbPath] = dbModule;

const dnsPromises = require("dns").promises;
dnsPromises.Resolver.prototype.resolveMx = async function () {
  stats.mx++; throw Object.assign(new Error("MX lookup refused in tests"), { code: "ENOTFOUND" });
};

const realFetch = globalThis.fetch; // the test client uses this; the server sees the recorder below
globalThis.fetch = async (url) => { stats.externalFetch.push(String(url)); throw new Error("outbound fetch refused in tests"); };

// ---------- helpers ----------
async function post(pathname, body, ip) {
  const res = await realFetch(BASE + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(ip ? { "X-Forwarded-For": ip } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
  return { status: res.status, data, text, retryAfter: res.headers.get("retry-after") };
}
const login = (email, password, ip) => post("/api/login", { email, password }, ip);
const register = (body, ip) => post("/api/register", body, ip);
const is429 = (r, maxRetry) => r.status === 429 && r.data && r.data.code === "RATE_LIMITED"
  && typeof r.data.error === "string" && /^\d+$/.test(r.retryAfter || "")
  && Number(r.retryAfter) >= 1 && Number(r.retryAfter) <= maxRetry;
const statuses = list => list.map(r => r.status).join(",");

// ======================================================================
// 1. Limiter unit tests (fake clock, no server)
// ======================================================================
function unitTests() {
  const { createRateLimiter, createLoginThrottle, loginKeys } = require(path.join(SERVER, "rate-limit.js"));
  let t = 1_000_000;
  const now = () => t;

  // createRateLimiter — threshold, retry, expiry, clear, existing modes
  const lim = createRateLimiter({ windowMs: 60_000, max: 3, now });
  const before = [lim.isLimited("k")];
  lim.record("k"); t += 10_000; lim.record("k"); before.push(lim.isLimited("k")); t += 10_000; lim.record("k");
  check("U1 isLimited stays false below max and turns true exactly at max", before.every(v => v === false) && lim.isLimited("k") === true, before);
  t += 5_000; // records at 0s, 10s, 20s; now 25s
  check("U2 retryAfterSeconds = time until the oldest attempt leaves the window (35s)", lim.retryAfterSeconds("k") === 35, lim.retryAfterSeconds("k"));
  check("U3 retryAfterSeconds is 0 for a key that is not limited", lim.retryAfterSeconds("other") === 0);
  t += 35_000; // the first attempt is now exactly windowMs old
  check("U4 an expired attempt stops blocking (60s after the first)", lim.isLimited("k") === false && lim.retryAfterSeconds("k") === 0);
  lim.record("k"); lim.record("other"); lim.record("other"); lim.record("other");
  lim.clear("k");
  check("U5 clear(key) forgets that key only", lim.isLimited("k") === false && lim.retryAfterSeconds("k") === 0 && lim.isLimited("other") === true);

  const legacy = createRateLimiter({ windowMs: 60_000, max: 2, now });
  const seq = [legacy.limited("x"), legacy.limited("x"), legacy.limited("x")];
  check("U6 existing limited() mode unchanged: records, then true only once over max", seq.join() === "false,false,true", seq);
  const legacy2 = createRateLimiter({ windowMs: 60_000, max: 2, now });
  legacy2.record("y");
  const mid = legacy2.isLimited("y");
  legacy2.record("y");
  check("U7 existing isLimited()/record() modes unchanged (record-only counts, check records nothing)", mid === false && legacy2.isLimited("y") === true && legacy2.isLimited("y") === true);
  const unbounded = createRateLimiter({ windowMs: 60_000, max: 5, now });
  for (let i = 0; i < 200; i++) unbounded.record("key" + i);
  check("U8 existing consumers stay unbounded by default (no maxKeys → no eviction)", unbounded.size() === 200, unbounded.size());
  const capped = createRateLimiter({ windowMs: 60_000, max: 1, now, maxKeys: 3 });
  for (let i = 0; i < 10; i++) capped.record("key" + i);
  check("U9 maxKeys bounds memory: 3 keys kept, the newest retained, the oldest evicted", capped.size() === 3 && capped.isLimited("key9") && capped.isLimited("key7") && !capped.isLimited("key0") && !capped.isLimited("key6"), capped.size());

  // loginKeys — normalisation and bounded keys
  const k1 = loginKeys("203.0.113.9", "Alice@Example.com"), k2 = loginKeys("203.0.113.9", "  alice@example.COM  ");
  check("U10 email case and surrounding whitespace map to the same Tier A key", k1.a === k2.a && k1.b === k2.b);
  const huge = loginKeys("x".repeat(5000), "a".repeat(20000) + "@example.com");
  check("U11 keys are bounded however long the IP or email input is", huge.a.length <= 64 + 1 + 64 && huge.b.length <= 64, [huge.a.length, huge.b.length]);
  check("U12 different IPs give different keys for the same email", loginKeys("203.0.113.1", "a@b.c").a !== loginKeys("203.0.113.2", "a@b.c").a);

  // createLoginThrottle — tiers, success reset (no database, no account)
  t = 5_000_000;
  const th = createLoginThrottle({ windowMs: 15 * 60_000, perAccountMax: 5, perIpMax: 30, now });
  const ip = "203.0.113.50", email = "unit@example.invalid";
  const progress = [];
  for (let i = 0; i < 5; i++) { progress.push(th.check(ip, email).limited); th.recordFailure(ip, email); }
  const after5 = th.check(ip, email);
  check("U13 Tier A: 5 failures allowed, then blocked", progress.every(v => v === false) && after5.limited === true, progress);
  check("U14 Tier A retryAfter is within the 15-minute window", after5.retryAfter >= 1 && after5.retryAfter <= 900, after5.retryAfter);
  check("U15 Tier A does not block a different email on the same IP", th.check(ip, "other@example.invalid").limited === false);

  t = 7_000_000;
  const th2 = createLoginThrottle({ windowMs: 15 * 60_000, perAccountMax: 5, perIpMax: 30, now });
  for (let i = 0; i < 4; i++) th2.recordFailure(ip, email);
  th2.recordSuccess(ip, email);
  check("U16 a successful login clears Tier A for that IP + email", th2.check(ip, email).limited === false && th2.tierA.isLimited(loginKeys(ip, email).a) === false);
  // Tier B still holds those 4 failures: 26 more across other emails reach 30.
  for (let i = 0; i < 25; i++) th2.recordFailure(ip, `spray${i}@example.invalid`);
  const at29 = th2.check(ip, "fresh@example.invalid").limited;
  th2.recordFailure(ip, "spray25@example.invalid");
  check("U17 Tier B keeps the failures recorded before the success (blocks at 4 + 26 = 30)", at29 === false && th2.check(ip, "fresh@example.invalid").limited === true);
  check("U18 Tier B blocks every email on that IP but not another IP", th2.check(ip, email).limited === true && th2.check("203.0.113.51", email).limited === false);
  th2.recordSuccess(ip, email);
  check("U19 a success does not clear Tier B", th2.check(ip, "fresh@example.invalid").limited === true);
  t += 15 * 60_000;
  check("U20 Tier B expires 15 minutes after the failures", th2.check(ip, "fresh@example.invalid").limited === false);
  t = 5_000_000 + 15 * 60_000 - 1;
  const stillA = th.check(ip, email).limited;
  t = 5_000_000 + 15 * 60_000;
  check("U21 Tier A blocks until exactly 15 minutes after the failures, then stops", stillA === true && th.check(ip, email).limited === false);
}

// ======================================================================
// 2 + 3. Login and registration integration tests (fake pool, no database)
// ======================================================================
async function integrationTests() {
  require(path.join(SERVER, "server.js"));
  check("I0 server.js is using the in-memory fake pool, not the database", require(path.join(SERVER, "db.js")) === fakePool);
  for (let i = 0; i < 50; i++) {
    try { await realFetch(BASE + "/"); break; } catch (e) { await new Promise(r => setTimeout(r, 100)); }
  }

  // --- Tier A ---
  const IP1 = "203.0.113.1";
  const e1 = "rl-nobody-1@example.invalid";
  const lookups0 = stats.userLookups;
  const five = [];
  for (let i = 0; i < 5; i++) five.push(await login(e1, "wrong-password", IP1));
  check("I1 five failed logins (unknown email) for one IP + email each get 401", five.every(r => r.status === 401 && r.data && r.data.error === "Invalid email or password."), statuses(five));
  check("I2 each of those five reached the account lookup once", stats.userLookups - lookups0 === 5, stats.userLookups - lookups0);
  const sixth = await login(e1, "wrong-password", IP1);
  check("I3 the sixth attempt is rate-limited: 429 JSON, code RATE_LIMITED, Retry-After 1..900", is429(sixth, 900), { status: sixth.status, data: sixth.data, ra: sixth.retryAfter });
  check("I4 the 429 message does not say whether the account exists", sixth.data && !/exist|unknown|not found|invalid email/i.test(sixth.data.error), sixth.data && sixth.data.error);
  check("I5 the blocked attempt did NOT reach the account lookup", stats.userLookups - lookups0 === 5, stats.userLookups - lookups0);
  const variant = await login(`   ${e1.toUpperCase()}  `, "wrong-password", IP1);
  check("I6 the same email with different case and whitespace shares the Tier A key (429)", is429(variant, 900), variant.status);
  const otherEmail = await login("rl-nobody-2@example.invalid", "wrong-password", IP1);
  check("I7 a different email on the same IP has its own Tier A counter (401)", otherEmail.status === 401, otherEmail.status);
  const otherIp = await login(e1, "wrong-password", "203.0.113.2");
  check("I8 the same email from a different IP has its own counters (401)", otherIp.status === 401, otherIp.status);

  // --- Tier B ---
  const IP3 = "203.0.113.3";
  const spray = [];
  for (let i = 0; i < 30; i++) spray.push(await login(`rl-spray-${i}@example.invalid`, "wrong-password", IP3));
  check("I9 thirty failed logins across thirty emails from one IP each get 401", spray.every(r => r.status === 401), statuses(spray));
  const lookupsB = stats.userLookups;
  const thirtyFirst = await login("rl-spray-new@example.invalid", "wrong-password", IP3);
  check("I10 Tier B: the 31st failure-candidate from that IP (a fresh email) is 429", is429(thirtyFirst, 900), thirtyFirst.status);
  check("I11 the Tier B block happened before the account lookup", stats.userLookups === lookupsB);
  const correctButBlocked = await login("rl-verified@example.invalid", PASSWORD, IP3);
  check("I12 while Tier B is tripped, even a correct password from that IP gets 429 (no lookup)", is429(correctButBlocked, 900) && stats.userLookups === lookupsB, correctButBlocked.status);

  // --- 400 is not counted ---
  const IP4 = "203.0.113.4";
  const bad = [];
  for (let i = 0; i < 12; i++) bad.push(await login(i % 2 ? "rl-nobody-4@example.invalid" : "", i % 2 ? "" : "pw", IP4));
  check("I13 missing credentials keep returning 400 (twelve times)", bad.every(r => r.status === 400), statuses(bad));
  const afterBad = [];
  for (let i = 0; i < 5; i++) afterBad.push(await login("rl-nobody-4@example.invalid", "wrong-password", IP4));
  const afterBad6 = await login("rl-nobody-4@example.invalid", "wrong-password", IP4);
  check("I14 400 responses did not count: five 401s still allowed afterwards, then 429", afterBad.every(r => r.status === 401) && is429(afterBad6, 900), statuses(afterBad) + "|" + afterBad6.status);

  // --- 403 is not counted (rows exist only in the fake pool's memory) ---
  const IP5 = "203.0.113.5";
  const forb = [];
  for (let i = 0; i < 6; i++) forb.push(await login("rl-unverified@example.invalid", PASSWORD, IP5));
  for (let i = 0; i < 6; i++) forb.push(await login("rl-disabled@example.invalid", PASSWORD, IP5));
  check("I15 unverified and disabled accounts keep returning 403 (six times each)", forb.slice(0, 6).every(r => r.status === 403 && r.data.requiresVerification === true) && forb.slice(6).every(r => r.status === 403 && r.data.code === "ACCOUNT_DISABLED"), statuses(forb));
  const afterForb = [];
  for (let i = 0; i < 5; i++) afterForb.push(await login("rl-unverified@example.invalid", "wrong-password", IP5));
  const afterForb6 = await login("rl-unverified@example.invalid", "wrong-password", IP5);
  check("I16 403 responses did not count: five wrong-password 401s still allowed, then 429", afterForb.every(r => r.status === 401) && is429(afterForb6, 900), statuses(afterForb) + "|" + afterForb6.status);

  // --- success clears Tier A (fake-pool row; the rule itself is proven in U16-U19) ---
  const IP6 = "203.0.113.6", ev = "rl-verified@example.invalid";
  const pre = [];
  for (let i = 0; i < 4; i++) pre.push(await login(ev, "wrong-password", IP6));
  const ok = await login(ev, PASSWORD, IP6);
  const post5 = [];
  for (let i = 0; i < 5; i++) post5.push(await login(ev, "wrong-password", IP6));
  const post6 = await login(ev, "wrong-password", IP6);
  check("I17 four failures, a success (200 + token), then five more 401s before 429", pre.every(r => r.status === 401) && ok.status === 200 && typeof (ok.data || {}).token === "string" && post5.every(r => r.status === 401) && is429(post6, 900), statuses(pre) + "|" + ok.status + "|" + statuses(post5) + "|" + post6.status);

  // --- registration ---
  const IP7 = "203.0.113.7";
  const mx0 = stats.mx;
  const regs = [];
  for (let i = 0; i < 10; i++) regs.push(await register({ fullName: "RL Test", email: `rl-reg-${i}@example.invalid`, password: "123" }, IP7));
  check("R1 ten invalid registrations get the existing 400 short-password response", regs.every(r => r.status === 400 && /at least 8/i.test((r.data || {}).error || "")), statuses(regs));
  const reg11 = await register({ fullName: "RL Test", email: "rl-reg-10@example.invalid", password: "123" }, IP7);
  check("R2 the eleventh registration attempt is 429 JSON, code RATE_LIMITED, Retry-After 1..3600", is429(reg11, 3600), { status: reg11.status, data: reg11.data, ra: reg11.retryAfter });
  const reg12 = await register({ fullName: "RL Test", email: "rl-reg-valid-shape@example.invalid", password: "a-long-enough-password" }, IP7);
  check("R3 an over-limit request with a fully valid-looking body is still 429 (blocked before validation)", is429(reg12, 3600), reg12.status);
  check("R4 no registration request reached the MX lookup", stats.mx === mx0, stats.mx - mx0);
  const reg13 = await register({}, IP7);
  check("R5 even an empty body is answered 429 once over the limit (before validation)", is429(reg13, 3600), reg13.status);
  const regOtherIp = await register({ fullName: "RL Test", email: "rl-reg-x@example.invalid", password: "123" }, "203.0.113.8");
  check("R6 another IP has its own registration counter (400)", regOtherIp.status === 400, regOtherIp.status);

  // --- an existing consumer, end to end: track-order is unchanged (10 then 429) ---
  const IP9 = "203.0.113.9";
  const tracks = [];
  for (let i = 0; i < 10; i++) tracks.push(await post("/api/track-order", { orderId: "12345", email: "rl-track@example.invalid" }, IP9));
  const track11 = await post("/api/track-order", { orderId: "12345", email: "rl-track@example.invalid" }, IP9);
  check("E1 track-order limiter unchanged: ten 404s then 429 RATE_LIMITED", tracks.every(r => r.status === 404) && track11.status === 429 && track11.data.code === "RATE_LIMITED", statuses(tracks) + "|" + track11.status);

  // --- the safety net held ---
  check("S1 no write statement was attempted against the (fake) database", stats.writes.length === 0, stats.writes);
  check("S2 no unexpected query was made", stats.unexpected.length === 0, stats.unexpected);
  check("S3 no transaction connection was requested", stats.connections === 0, stats.connections);
  check("S4 no outbound HTTP request was made by the server (no Paystack, SendGrid or Google)", stats.externalFetch.length === 0, stats.externalFetch);
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
