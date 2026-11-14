// Startup configuration checks and JSON error responses (security findings G-6 / G-7).
//
// DATABASE-FREE AND NETWORK-ISOLATED:
//   * Part A unit-tests config-check.js (a pure function).
//   * Part B spawns the real server.js under tests/support/no-db-preload.js, which stubs dotenv
//     and blocks .env (so the child sees ONLY the variables set here), refuses any MySQL target
//     except 127.0.0.1:1 (nothing listens there), allows loopback-only listen and fetch, and
//     refuses MX lookups. No database is contacted; /api/health answers 503.
//   * No secret value may appear in any child output (checked).
//
// Run: node tests/startup-config-tests.js
const path = require("path");
const crypto = require("crypto");
const net = require("net");
const { spawn } = require("child_process");
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
const SERVER = process.cwd();
const NODB_PRELOAD = path.join(SERVER, "tests", "support", "no-db-preload.js").replace(/\\/g, "/");

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail === undefined ? "" : `  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hex = n => crypto.randomBytes(n).toString("hex");

// ---------------- Part A: config-check.js ----------------
function unitTests() {
  const { checkStartupConfig, MIN_SECRET_LENGTH } = require(path.join(SERVER, "config-check.js"));
  const J = hex(32), P = hex(32); // 64 characters each
  const run = env => checkStartupConfig(env);
  const has = (r, re) => r.errors.some(e => re.test(e));
  check("A0 minimum secret length is 32", MIN_SECRET_LENGTH === 32);
  let r = run({ JWT_SECRET: J });
  check("A1 development with JWT_SECRET only → no errors, one warning (PAYMENT_SIGNING_SECRET fallback)", r.errors.length === 0 && r.warnings.length === 1 && /PAYMENT_SIGNING_SECRET/.test(r.warnings[0]) && r.production === false, r);
  r = run({ JWT_SECRET: J, PAYMENT_SIGNING_SECRET: P });
  check("A2 development with both secrets → no errors, no warnings", r.errors.length === 0 && r.warnings.length === 0, r);
  for (const [label, v] of [["missing", undefined], ["empty", ""], ["blank", "   "]]) {
    r = run({ JWT_SECRET: v, PAYMENT_SIGNING_SECRET: P });
    check(`A3 JWT_SECRET ${label} → error (development too)`, has(r, /JWT_SECRET is not set/), r);
  }
  r = run({ JWT_SECRET: "short", NODE_ENV: "" });
  check("A4 a short JWT_SECRET is accepted outside production", r.errors.length === 0, r);
  r = run({ NODE_ENV: "production", JWT_SECRET: J, PAYMENT_SIGNING_SECRET: P });
  check("A5 production with two distinct 64-char secrets → no errors, production=true", r.errors.length === 0 && r.warnings.length === 0 && r.production === true, r);
  r = run({ NODE_ENV: "production", JWT_SECRET: "x".repeat(31), PAYMENT_SIGNING_SECRET: P });
  check("A6 production JWT_SECRET of 31 characters → error", has(r, /JWT_SECRET must be at least 32/), r);
  r = run({ NODE_ENV: "production", JWT_SECRET: "x".repeat(32), PAYMENT_SIGNING_SECRET: "y".repeat(32) });
  check("A7 production secrets of exactly 32 characters → accepted", r.errors.length === 0, r);
  r = run({ NODE_ENV: "production", JWT_SECRET: J });
  check("A8 production without PAYMENT_SIGNING_SECRET → error (no fallback in production)", has(r, /PAYMENT_SIGNING_SECRET must be set in production/), r);
  r = run({ NODE_ENV: "production", JWT_SECRET: J, PAYMENT_SIGNING_SECRET: "z".repeat(10) });
  check("A9 production PAYMENT_SIGNING_SECRET too short → error", has(r, /PAYMENT_SIGNING_SECRET must be at least 32/), r);
  r = run({ NODE_ENV: "production", JWT_SECRET: J, PAYMENT_SIGNING_SECRET: J });
  check("A10 production PAYMENT_SIGNING_SECRET equal to JWT_SECRET → error", has(r, /must be different from JWT_SECRET/), r);
  r = run({ RENDER: "true", JWT_SECRET: J, PAYMENT_SIGNING_SECRET: P });
  check("A11 on Render without NODE_ENV → error naming NODE_ENV; production rules apply", has(r, /NODE_ENV must be "production" on Render/) && r.production === true, r);
  r = run({ RENDER: "true", NODE_ENV: "development", JWT_SECRET: J, PAYMENT_SIGNING_SECRET: P });
  check("A12 on Render with NODE_ENV=development → error", has(r, /NODE_ENV must be "production" on Render/), r);
  r = run({ RENDER: "true", NODE_ENV: "production", JWT_SECRET: J, PAYMENT_SIGNING_SECRET: P });
  check("A13 on Render with NODE_ENV=production and good secrets → no errors", r.errors.length === 0, r);
  r = run({ RENDER: "true", JWT_SECRET: J });
  check("A14 several problems are all reported at once", r.errors.length === 2, r.errors);
  const all = [run({}), run({ NODE_ENV: "production", JWT_SECRET: J, PAYMENT_SIGNING_SECRET: J }), run({ NODE_ENV: "production", JWT_SECRET: "abc" })];
  check("A15 no message ever contains a secret value", all.every(x => [...x.errors, ...x.warnings].every(m => !m.includes(J) && !m.includes("abc"))));
  check("A16 the function does not read process.env (pure)", (() => { const before = process.env.JWT_SECRET; process.env.JWT_SECRET = "from-process-env-should-be-ignored"; const x = run({}); if (before === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = before; return has(x, /JWT_SECRET is not set/); })());
}

// ---------------- Part B: the real server.js ----------------
function childEnv(port, vars) {
  const env = { ...process.env };
  for (const k of ["JWT_SECRET", "PAYMENT_SIGNING_SECRET", "NODE_ENV", "RENDER", "NODE_OPTIONS", "NF_TEST_MODE", "NF_TEST_DB_NAME",
    "NF_TEST_DB_SERVER_HOSTNAME", "DB_USER", "DB_PASSWORD", "DB_NAME", "CORS_ORIGINS", "FRONTEND_URL", "PAYSTACK_SECRET_KEY",
    "PAYSTACK_API_BASE", "SENDGRID_API_KEY", "SENDGRID_FROM_EMAIL", "GOOGLE_CLIENT_ID", "DEV_EMAIL_LOG"]) delete env[k];
  return { ...env, NODE_OPTIONS: `--require="${NODB_PRELOAD}"`, NF_NODB_MODE: "nodb", DB_HOST: "127.0.0.1", DB_PORT: "1",
    DB_NAME: "nf_nodb_unreachable", DB_SSL: "false", PORT: String(port), ...vars };
}
function launch(port, vars) {
  const proc = spawn(process.execPath, ["server.js"], { cwd: SERVER, env: childEnv(port, vars), stdio: ["ignore", "pipe", "pipe"] });
  // exit code is null when the child is ended by kill(), so "has exited" is tracked separately.
  const c = { proc, port, out: "", exit: null, exited: false };
  proc.stdout.on("data", d => { c.out += d; });
  proc.stderr.on("data", d => { c.out += d; });
  proc.on("exit", code => { c.exit = code; c.exited = true; });
  return c;
}
const listening = c => c.out.includes(`NeoFragrances API running at http://localhost:${c.port}`);
async function waitFor(c, ms) { const t = Date.now(); while (!c.exited && !listening(c) && Date.now() - t < ms) await sleep(100); }
const portOpen = port => new Promise(res => { const s = net.connect(port, "127.0.0.1"); s.once("connect", () => { s.destroy(); res(true); }); s.once("error", () => res(false)); });
async function stop(c) { if (!c.exited) { c.proc.kill(); for (let i = 0; i < 50 && !c.exited; i++) await sleep(100); } }
async function call(port, method, pathname, { raw, headers = {} } = {}) {
  const init = { method, headers: { ...headers } };
  if (raw !== undefined) { init.body = raw; init.headers["Content-Type"] = "application/json"; }
  const r = await fetch(`http://127.0.0.1:${port}${pathname}`, init);
  return { status: r.status, type: r.headers.get("content-type") || "", text: await r.text() };
}
const noStack = t => !/\bat\s+\S+\s*\(|SyntaxError|node_modules|<pre>|<!DOCTYPE/i.test(t);
const jsonCode = (r, code) => { try { return JSON.parse(r.text).code === code; } catch (e) { return false; } };

async function refusalCase(name, port, vars, expect, secrets) {
  const c = launch(port, vars);
  await waitFor(c, 60000);
  const open = await portOpen(port);
  await stop(c);
  check(`${name} → exit code 1 before listening`, c.exit === 1 && !listening(c) && !open, { exit: c.exit, listening: listening(c), open });
  check(`${name} → names the problem ("${expect.source}") and "not started"`, expect.test(c.out) && /NeoFragrances API not started\./.test(c.out), c.out.split(/\r?\n/).filter(l => /CONFIGURATION|not started/.test(l)));
  check(`${name} → no secret value in the output`, secrets.every(s => !c.out.includes(s)));
}

async function serverTests() {
  const J = hex(32), P = hex(32);
  await refusalCase("S1 no JWT_SECRET", 5088, {}, /CONFIGURATION ERROR: JWT_SECRET is not set/, []);
  await refusalCase("S2 on Render without NODE_ENV=production", 5088, { RENDER: "true", JWT_SECRET: J, PAYMENT_SIGNING_SECRET: P }, /NODE_ENV must be "production" on Render/, [J, P]);
  await refusalCase("S3 production without PAYMENT_SIGNING_SECRET", 5088, { NODE_ENV: "production", JWT_SECRET: J }, /PAYMENT_SIGNING_SECRET must be set in production/, [J]);
  await refusalCase("S4 production with PAYMENT_SIGNING_SECRET equal to JWT_SECRET", 5088, { NODE_ENV: "production", JWT_SECRET: J, PAYMENT_SIGNING_SECRET: J }, /must be different from JWT_SECRET/, [J]);
  await refusalCase("S5 production with a short JWT_SECRET", 5088, { NODE_ENV: "production", JWT_SECRET: "short-secret", PAYMENT_SIGNING_SECRET: P }, /JWT_SECRET must be at least 32/, ["short-secret", P]);

  // Development, JWT_SECRET only: starts, warns about the fallback, answers errors with JSON.
  const dev = launch(5088, { JWT_SECRET: J, DEV_EMAIL_LOG: "true" });
  await waitFor(dev, 60000);
  check("S6 development with JWT_SECRET only → starts and listens", listening(dev) && dev.exit === null, dev.out.split(/\r?\n/).slice(-5));
  check("S6b … and warns that PAYMENT_SIGNING_SECRET falls back to JWT_SECRET", /WARNING: PAYMENT_SIGNING_SECRET is not set/.test(dev.out));
  if (listening(dev)) {
    let r = await call(5088, "POST", "/api/login", { raw: "{not json" });
    check("S7 malformed JSON → 400 JSON INVALID_JSON, no stack trace or HTML (development mode)", r.status === 400 && /application\/json/.test(r.type) && jsonCode(r, "INVALID_JSON") && noStack(r.text), { status: r.status, type: r.type, body: r.text.slice(0, 120) });
    r = await call(5088, "POST", "/api/login", { raw: JSON.stringify({ email: "x@example.invalid", pad: "a".repeat(150 * 1024) }) });
    check("S8 body over the 100 kB limit → 413 JSON PAYLOAD_TOO_LARGE, no stack trace", r.status === 413 && /application\/json/.test(r.type) && jsonCode(r, "PAYLOAD_TOO_LARGE") && noStack(r.text), { status: r.status, body: r.text.slice(0, 120) });
    // A Content-Encoding the body parser does not support (it rejects it with 415, encoding.unsupported).
    r = await call(5088, "POST", "/api/login", { raw: '{"email":"x"}', headers: { "Content-Encoding": "x-nf-unknown" } });
    check("S9 unsupported Content-Encoding → 4xx JSON BAD_REQUEST, no stack trace", r.status >= 400 && r.status < 500 && /application\/json/.test(r.type) && jsonCode(r, "BAD_REQUEST") && noStack(r.text), { status: r.status, body: r.text.slice(0, 120) });
    r = await call(5088, "GET", "/api/health");
    const health = (() => { try { return JSON.parse(r.text); } catch (e) { return {}; } })();
    check("S10 /api/health still answers JSON 503 without a database (unchanged)", r.status === 503 && health.status === "unavailable", r.text);
    r = await call(5088, "GET", "/api/does-not-exist");
    check("S11 unknown route → still Express's default 404 (not turned into a 500)", r.status === 404, r.status);
    check("S12 no secret value in the development server's output", !dev.out.includes(J));
  }
  await stop(dev);

  // Production (as on Render): starts with valid secrets, errors are JSON.
  const prod = launch(5089, { RENDER: "true", NODE_ENV: "production", JWT_SECRET: J, PAYMENT_SIGNING_SECRET: P, FRONTEND_URL: "https://nf-live.test" });
  await waitFor(prod, 60000);
  check("S13 production on Render with distinct 32+ character secrets → starts, no configuration warnings", listening(prod) && prod.exit === null && !/CONFIGURATION ERROR|WARNING: PAYMENT_SIGNING_SECRET/.test(prod.out), prod.out.split(/\r?\n/).slice(-5));
  if (listening(prod)) {
    const r = await call(5089, "POST", "/api/login", { raw: "{not json" });
    check("S14 production: malformed JSON → 400 JSON INVALID_JSON, no stack trace", r.status === 400 && jsonCode(r, "INVALID_JSON") && noStack(r.text), r.text.slice(0, 120));
    check("S15 no secret value in the production server's output", !prod.out.includes(J) && !prod.out.includes(P));
  }
  await stop(prod);
  check("S16 every child server has exited", [dev, prod].every(c => c.exited));
}

(async () => {
  try {
    unitTests();
    await serverTests();
  } catch (err) {
    failed++; console.log(`FAIL harness error: ${err && err.message}`);
  } finally {
    console.log(`\n${passed}/${passed + failed} passed`);
    process.exit(failed ? 1 : 0);
  }
})();
