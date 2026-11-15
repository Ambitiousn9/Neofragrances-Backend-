// End-to-end checkout test: real frontend (http-server :5500) + real server.js (:5055, test env)
// + mock Paystack (:5099) + headless Edge. Browser calls to localhost:5000 are rewritten to
// :5055; every other non-local browser request is blocked and reported. Three exactly-listed
// stylesheets (two Google Fonts URLs, Font Awesome) are expected blocks; any other block fails the run.
//
// FUNCTIONAL-ONLY: with those stylesheets blocked the pages render in fallback fonts and
// without icons. Screenshots and the mobile overflow check do not establish visual fidelity.
//
// Runs ONLY under the isolated-database guard (tests/support/isolated-db-guard.js), against a
// dedicated nf_test_* database — never the working database. Same launch pattern as
// admin-api-tests.js and payment-tests.js (all on one line; the local DB account is given
// explicitly because the guard blocks .env), plus two REQUIRED artefact locations:
//   NF_TEST_MODE=isolated NF_TEST_DB_NAME=nf_test_<name> NF_TEST_DB_SERVER_HOSTNAME=<@@hostname>
//   DB_NAME=nf_test_<name> DB_HOST=127.0.0.1 DB_PORT=3308 DB_USER=<local account> DB_PASSWORD=
//   OUT_DIR=<absolute existing dir> EDGE_PROFILE_PARENT=<absolute existing dir>
//   NODE_OPTIONS=--require="<backend>/tests/support/isolated-db-guard-preload.js"
//   node tests/e2e-checkout.js
// OUT_DIR and EDGE_PROFILE_PARENT must already exist as real directories, be absolute, lie
// outside both repositories, and not be the bare system temp folder; nothing falls back to a
// default. The run creates a NEW e2e-checkout-<run id> folder in OUT_DIR (screenshots; kept) and
// a NEW nf-edge-e2e-<run id> profile in EDGE_PROFILE_PARENT (deleted at the end — only that
// folder, and only because this run created it).
//
// What protects what:
//   * The guard covers the two Node processes (this one and the spawned server.js): database
//     identity, .env/dotenv, loopback-only listeners, loopback-only fetch, no MX lookups.
//   * Headless Edge is a separate, non-Node process. Its PAGE requests are intercepted over CDP
//     (Fetch domain, enabled before the first navigation): localhost:5000 is rewritten to the
//     isolated API, the frontend and isolated API origins are allowed, everything else is
//     blocked (see EXPECTED_BLOCKED_STYLESHEETS for the only blocks that do not fail the run).
//     Fixtures are written only after the API server, Edge and interception are all verified.
//     Browser-process traffic (component updates, telemetry, preconnect sockets, DNS)
//     is NOT visible to page interception; it is only reduced by Edge flags and host-resolver
//     rules, and this file cannot prove that reduction complete.
//
// Failure handling:
//   * Caught errors, timeouts, the overall run deadline, an unexpected exit or error of the API
//     server, Edge or the CDP connection, and uncaught exceptions while JavaScript still runs:
//     the run stops at its next await and the normal teardown runs (browser and server stopped
//     first, then ID-keyed database cleanup, then this run's Edge profile removed).
//   * NOT covered — no cleanup runs at all: a forced kill, Ctrl+C / console close (no signal
//     handler is installed), an OS-level termination, a crash of Node itself, or the guard's own
//     exit 97. A hung database call is not interruptible by the deadline.
const path = require("path"), http = require("http"), fs = require("fs"), os = require("os"), crypto = require("crypto"), net = require("net");
const { spawn, execFile } = require("child_process");
// Isolation is checked BEFORE chdir, dotenv, jsonwebtoken and db.js load (ADMIN-5C, as in
// payment-tests.js): without the guard nothing reads .env and no pool is ever created. The
// suite always runs from the repo that contains it; a SERVER_DIR naming any other directory
// is refused rather than followed. (A preload with an invalid configuration has already exited.)
const REPO_ROOT = path.resolve(__dirname, "..");
const PRELOAD = path.join(REPO_ROOT, "tests", "support", "isolated-db-guard-preload.js");
const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
// Paths a NODE_OPTIONS string --require's. Whitespace-separated; double quotes keep a value
// with spaces together.
const requiredBy = nodeOptions => {
  const tokens = (String(nodeOptions || "").match(/(?:[^\s"]+|"[^"]*")+/g) || []).map(t => t.replace(/"/g, ""));
  const required = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(?:--require=(.+)|--require|-r)$/.exec(tokens[i]);
    if (m) required.push(m[1] !== undefined ? m[1] : tokens[++i] || "");
  }
  return required;
};
const preloadsThisRepo = nodeOptions => requiredBy(nodeOptions).some(p => path.isAbsolute(p) && samePath(path.resolve(p), PRELOAD));
{
  const g = globalThis.__NF_ISOLATED_DB_GUARD__;
  const e = process.env;
  const problems = [];
  if (e.SERVER_DIR !== undefined && !samePath(path.resolve(e.SERVER_DIR), REPO_ROOT)) problems.push(`SERVER_DIR must be unset or this repo (${REPO_ROOT})`);
  if (!g) problems.push("the isolated-database guard preload is not active (NODE_OPTIONS --require=\"<backend>/tests/support/isolated-db-guard-preload.js\")");
  if (!preloadsThisRepo(e.NODE_OPTIONS)) problems.push(`NODE_OPTIONS must --require this repo's guard preload by absolute path (${PRELOAD})`);
  if (e.NF_TEST_MODE !== "isolated") problems.push("NF_TEST_MODE must be \"isolated\"");
  if (!e.NF_TEST_DB_NAME || e.DB_NAME !== e.NF_TEST_DB_NAME) problems.push("DB_NAME must equal NF_TEST_DB_NAME");
  if (e.DB_NAME === "neofragrances") problems.push("DB_NAME must not be the working database");
  if (g && g.db !== e.NF_TEST_DB_NAME) problems.push("the guard's database is not NF_TEST_DB_NAME");
  if (e.DB_HOST !== "127.0.0.1") problems.push("DB_HOST must be 127.0.0.1");
  if (String(e.DB_PORT) !== "3308") problems.push("DB_PORT must be 3308");
  if (problems.length) { console.error("Refusing to run e2e-checkout.js:\n  - " + problems.join("\n  - ")); process.exit(1); }
}
const guardLib = require(path.join(REPO_ROOT, "tests", "support", "isolated-db-guard"));
const SECRET = crypto.randomBytes(32).toString("hex");
const FRONT = "http://127.0.0.1:5500";
const MOCK_PORT = 5099, API_PORT = 5055;
// Option 2B: the spawned server.js must load the guard too, or it would read .env and connect
// unguarded. Its environment is built from an explicit allowlist — never a copy of this
// process's environment — so nothing from the shell (DB_SSL, NODE_ENV, RENDER, live keys)
// reaches it: only what Node needs on this OS, the isolated database settings, a NODE_OPTIONS
// that preloads exactly this repo's guard, and test values that pin every outside service to
// the mock or to "unconfigured". THAT object is checked before any database access or spawn.
const CHILD_ENV = {};
for (const k of ["SystemRoot", "windir", "PATH", "PATHEXT", "TEMP", "TMP", "ComSpec"]) if (process.env[k] !== undefined) CHILD_ENV[k] = process.env[k];
for (const k of ["NF_TEST_MODE", "NF_TEST_DB_NAME", "NF_TEST_DB_SERVER_HOSTNAME", "DB_NAME", "DB_HOST", "DB_PORT", "DB_USER", "DB_PASSWORD"]) if (process.env[k] !== undefined) CHILD_ENV[k] = process.env[k];
Object.assign(CHILD_ENV, {
  NODE_OPTIONS: guardLib.buildNodeOptions("", PRELOAD), PORT: String(API_PORT), JWT_SECRET: SECRET, PAYMENT_SIGNING_SECRET: "",
  PAYSTACK_SECRET_KEY: "sk_test_mock", PAYSTACK_API_BASE: `http://127.0.0.1:${MOCK_PORT}`, FRONTEND_URL: FRONT,
  SENDGRID_API_KEY: "", SENDGRID_FROM_EMAIL: "", DEV_EMAIL_LOG: "", GOOGLE_CLIENT_ID: "", CORS_ORIGINS: "",
});
{
  const problems = [];
  if (!preloadsThisRepo(CHILD_ENV.NODE_OPTIONS)) problems.push(`the child's NODE_OPTIONS does not --require the guard preload by absolute path (expected ${PRELOAD})`);
  const childConfig = guardLib.validateTestConfig(CHILD_ENV);
  if (!childConfig.ok) problems.push(`the child's isolation settings are invalid: ${childConfig.reason}`);
  for (const k of ["DB_SSL", "NODE_ENV", "RENDER", "SERVER_DIR"]) if (k in CHILD_ENV) problems.push(`the child's environment must not contain ${k}`);
  if (problems.length) { console.error("Refusing to run e2e-checkout.js (the child server would not be guarded):\n  - " + problems.join("\n  - ")); process.exit(1); }
}
// The active guard must be THIS repo's, installed in THIS process: dotenv and mysql2 are resolved
// from this repo, so check the exact module-cache entries db.js will receive. Proven by comparing
// each function's source with the guard library's own source. Nothing is executed and nothing
// new is loaded (require.resolve only resolves a path; an absent cache entry fails the check).
{
  const problems = [];
  const cached = request => { try { return require.cache[require.resolve(request, { paths: [REPO_ROOT] })]; } catch (e) { return undefined; } };
  const fromGuard = (fn, factory) => typeof fn === "function" && factory.toString().includes(fn.toString());
  const dotenv = cached("dotenv");
  if (!dotenv || !dotenv.exports || Object.keys(dotenv.exports).sort().join(",") !== "config,configDotenv,parse" || !fromGuard(dotenv.exports.config, guardLib.stubDotenv)) {
    problems.push("this repo's dotenv module-cache entry is not the isolation guard's stub");
  }
  const mysqlPromise = cached("mysql2/promise");
  if (!mysqlPromise || !mysqlPromise.exports || !fromGuard(mysqlPromise.exports.createPool, guardLib.wrapPromiseApi) || !fromGuard(mysqlPromise.exports.createConnection, guardLib.wrapPromiseApi)) {
    problems.push("this repo's mysql2/promise createPool/createConnection are not wrapped by the isolation guard");
  }
  if (!fromGuard(globalThis.fetch, guardLib.restrictFetch)) problems.push("global fetch is not restricted by the isolation guard");
  if (!fromGuard(net.Server.prototype.listen, guardLib.enforceLoopbackListen)) problems.push("net.Server listen is not limited to loopback by the isolation guard");
  if (problems.length) { console.error("Refusing to run e2e-checkout.js (the isolation guard is not installed for this repo):\n  - " + problems.join("\n  - ")); process.exit(1); }
}
// Artefact locations: explicit, absolute, existing real directories, outside both repositories,
// not a filesystem root and not the bare system temp folder. Validated here with read-only fs
// calls, before anything is created or deleted; nothing is created to validate them.
const FRONTEND_ROOT = path.resolve(REPO_ROOT, "..", "neofragrances-frontend");
const realOr = p => { try { return fs.realpathSync.native(p); } catch (e) { return path.resolve(p); } };
const isInside = (child, parent) => { const rel = path.relative(parent, child); return rel === "" || (rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel)); };
function artefactParent(name) {
  const value = process.env[name];
  if (!value) return [null, `${name} is required: an absolute path to an existing directory outside the repositories`];
  if (!path.isAbsolute(value)) return [null, `${name} must be an absolute path`];
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) return [null, `${name} must not be a filesystem root`];
  let st, real;
  try { st = fs.lstatSync(resolved); } catch (e) { return [null, `${name} does not exist (${e.code || e.message}); it is never created for you`]; }
  if (st.isSymbolicLink() || !st.isDirectory()) return [null, `${name} must be a real directory (not a file, link or junction)`];
  try { real = fs.realpathSync.native(resolved); } catch (e) { return [null, `${name} could not be resolved (${e.code || e.message})`]; }
  if (samePath(real, realOr(os.tmpdir()))) return [null, `${name} must not be the bare system temp folder`];
  for (const root of [REPO_ROOT, FRONTEND_ROOT]) if (isInside(real, realOr(root))) return [null, `${name} must be outside ${root}`];
  return [real, null];
}
const [OUT_PARENT, outProblem] = artefactParent("OUT_DIR");
const [PROFILE_PARENT, profileProblem] = artefactParent("EDGE_PROFILE_PARENT");
if (outProblem || profileProblem) { console.error("Refusing to run e2e-checkout.js:\n  - " + [outProblem, profileProblem].filter(Boolean).join("\n  - ")); process.exit(1); }
const RUN_ID = `${new Date().toISOString().replace(/[:.]/g, "-")}-${crypto.randomBytes(3).toString("hex")}`;
const OUT = path.join(OUT_PARENT, `e2e-checkout-${RUN_ID}`);          // created in the run, kept
const PROFILE = path.join(PROFILE_PARENT, `nf-edge-e2e-${RUN_ID}`);   // created in the run, deleted in teardown
process.chdir(REPO_ROOT);
// Under the guard, dotenv is a stubbed no-op and .env reads are blocked.
require(path.join(process.cwd(), "node_modules/dotenv")).config({ quiet: true });
const jwt = require(path.join(process.cwd(), "node_modules/jsonwebtoken"));
const pool = require(path.join(process.cwd(), "db"));

const CDP_PORT = 9334;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
// The storefront served from 127.0.0.1 calls its API at http://localhost:5000 (frontend
// js/main.js, LOCAL_HOSTNAMES). That is the one origin rewritten; the only origins a page may
// reach are the storefront itself and the isolated API.
const DEV_API_ORIGIN = "http://localhost:5000";
const BROWSER_ALLOWED_ORIGINS = new Set([FRONT, API_ORIGIN]);
// The outside stylesheets every tested storefront page (index, about, cart, payment-callback)
// loads, copied from their <link> tags. Since frontend R6 there is one Google Fonts URL (it now
// includes Inter 700); the separate @import that css/style.css used to add is gone. They stay
// BLOCKED like every other
// outside request; a request matching one exactly — full URL, GET, resource type Stylesheet —
// is only counted as expected instead of failing the run. Another path or query on the same
// hosts, another method or another resource type is still an unexpected block. Compared as
// WHATWG-serialised URLs (new URL().href) on both sides.
const EXPECTED_BLOCKED_STYLESHEETS = new Set([
  "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;1,9..144,400;1,9..144,500&family=Inter:wght@400;500;600;700&display=swap",
  "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css",
].map(u => new URL(u).href));
const FUNCTIONAL_ONLY_NOTICE = "FUNCTIONAL-ONLY RUN: the Google Fonts and Font Awesome stylesheets are blocked on purpose, so pages render in fallback fonts without icons. Screenshots and the mobile overflow check do not establish visual fidelity.";
const EDGE_EXE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const TIMEOUTS = { portCheck: 3000, frontend: 5000, serverStart: 60000, health: 5000, identityLine: 5000, devtools: 30000, processQuery: 60000, edgeIdentify: 90000, wsOpen: 10000, cdpSend: 15000, teardownStep: 5000, run: 10 * 60 * 1000 };
const GUARD_TAG = pid => `[isolated-db-guard pid ${pid}]`;   // the preload's output prefix
// NF_E2E_DIAGNOSE_EDGE=1: diagnostic run. Everything up to and including Edge identification and
// endpoint verification runs as normal (guard, identity, mock, API server, Edge); the run then
// stops before the page connection, interception and fixtures, and the normal teardown runs.
const DIAGNOSE_EDGE_ONLY = process.env.NF_E2E_DIAGNOSE_EDGE === "1";
const EXPECTED_IDENTITY = `${process.env.NF_TEST_DB_NAME}@${process.env.NF_TEST_DB_SERVER_HOSTNAME}:3308`;

/* Run-level failure. Anything that must stop the run — a timeout, the run deadline, an unexpected
   exit or error of a spawned process, the CDP connection dropping, an uncaught exception — calls
   failRun(). Every await in the flow goes through guarded() (sleep, q, send, fetch), so the flow
   throws at its next await and falls into the normal catch/finally. Fixture INSERTs deliberately
   do NOT (qRaw), so an insert that completes always has its id recorded for cleanup. */
let tearingDown = false, fatalError = null, rejectRun;
const runFailure = new Promise((_, reject) => { rejectRun = reject; });
runFailure.catch(() => {});
const lateErrors = [];
function failRun(err) {
  const e = err instanceof Error ? err : new Error(String(err));
  if (tearingDown) { lateErrors.push(e.message); console.error("ERROR during teardown:", e.message); return; }
  if (fatalError) return;
  fatalError = e;
  console.error("FATAL:", e.message);
  rejectRun(e);
}
process.on("uncaughtException", err => failRun(new Error(`uncaught exception: ${(err && err.stack) || err}`)));
process.on("unhandledRejection", err => failRun(new Error(`unhandled rejection: ${(err && err.message) || err}`)));
const guarded = p => Promise.race([p, runFailure]);
const pause = ms => new Promise(r => setTimeout(r, ms));        // teardown: never interrupted
const sleep = ms => guarded(pause(ms));                          // flow: stops when the run fails
const qRaw = async (sql, p) => (await pool.query(sql, p))[0];    // fixture inserts and teardown
const q = (sql, p) => guarded(qRaw(sql, p));                     // flow reads
const results = []; const check = (n, c, x = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"} ${n}${x ? "  [" + x + "]" : ""}`); };
// Rejects if `promise` has not settled within ms. Teardown uses it so no step can hang the run.
const within = (promise, ms, what) => Promise.race([promise, pause(ms).then(() => { throw new Error(`${what} did not finish within ${ms} ms`); })]);
// A spawned process that exits or errors before teardown asked it to stop is fatal.
function watchChild(child, label) {
  child.on("error", err => failRun(new Error(`${label} process error: ${err.code || err.message}`)));
  child.on("exit", (code, signal) => { if (!child.nfStopping) failRun(new Error(`${label} exited unexpectedly (code ${code}, signal ${signal})`)); });
}
// Stops a spawned process and waits (bounded) for it to exit. For Edge this is only the launcher
// (a no-op once it has handed off and exited); the browser and its helpers are stopped by profile.
async function stopChild(child, label, timeoutMs = TIMEOUTS.teardownStep) {
  if (!child) return;
  child.nfStopping = true;
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(r => child.once("exit", r));
  child.kill();
  await within(exited, timeoutMs, `${label} exit`);
}
/* Edge (155+) may hand off at start-up: the launcher starts the real browser as its child and
   exits with code 0, and the browser does not write its DevTools line to the launcher's stderr.
   The browser is therefore identified from the operating system: the one main msedge.exe process
   (no --type=) whose --user-data-dir is THIS run's freshly created profile, started by this
   run's launcher (or the launcher itself when there is no hand-off), carrying this run's
   --remote-debugging-port, and the sole owner of 127.0.0.1:CDP_PORT. Queries run through
   PowerShell (process and socket tables only; no network, no database). */
// Every query is logged with an "[edge-diag]" line: purpose, start/end time, duration, PowerShell
// pid and exit code, signal, killed/timed-out, whether that PowerShell is still alive afterwards,
// valid JSON or not, row count and stderr. Query output itself is never logged (it holds the
// command lines of every msedge.exe on the machine); the queries carry no credentials.
let psQuerySeq = 0;
function psJson(script, purpose = "process query", timeoutMs = TIMEOUTS.processQuery) {
  const n = ++psQuerySeq, t0 = Date.now(), startedAt = new Date(t0).toISOString();
  return new Promise((resolve, reject) => {
    const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 << 20 }, (err, out, errOut) => {
        const ms = Date.now() - t0, endedAt = new Date().toISOString();
        const exitCode = err ? (typeof err.code === "number" ? err.code : (err.code || null)) : 0;
        const killed = !!(err && err.killed), signal = (err && err.signal) || null, timedOut = killed && ms >= timeoutMs - 100;
        const stderrText = String(errOut || "").trim();
        let v = null, json = false;
        if (!err) { try { v = JSON.parse(String(out).trim() || "[]"); json = true; } catch (e) { /* reported below */ } }
        const rows = json ? (Array.isArray(v) ? v.length : 1) : null;
        console.log(`[edge-diag] query #${n} ${purpose}: start ${startedAt} end ${endedAt} duration ${ms} ms | powershell pid ${child.pid} exit ${exitCode} signal ${signal} killed ${killed} timedOut ${timedOut} | still alive afterwards ${child.pid ? isRunning(child.pid) : "n/a"} | valid JSON ${json}${json ? ` rows ${rows}` : ""} | stdout ${String(out || "").length} bytes${stderrText ? ` | stderr ${JSON.stringify(stderrText.slice(0, 1000))}` : " | stderr empty"}${err && !killed ? ` | error ${JSON.stringify(String(err.message).split("\n")[0].replace(/-EncodedCommand \S+/, "-EncodedCommand <query>").slice(0, 200))}` : ""}`);
        if (err) return reject(new Error(`process query #${n} (${purpose}) failed after ${ms} ms: ${killed ? `killed by ${signal}${timedOut ? " (timeout)" : ""}` : `exit ${exitCode}`}${stderrText ? `: ${stderrText.slice(0, 300)}` : ""}`));
        if (!json) return reject(new Error(`process query #${n} (${purpose}) returned unreadable output (${String(out || "").length} bytes)`));
        resolve(Array.isArray(v) ? v : [v]);
      });
    console.log(`[edge-diag] query #${n} ${purpose}: started ${startedAt} (powershell pid ${child.pid}, timeout ${timeoutMs} ms)`);
  });
}
const listEdgeProcesses = (purpose = "all msedge.exe (profile filter)") => psJson(`@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Select-Object ProcessId,ParentProcessId,CommandLine) | ConvertTo-Json -Compress -Depth 3`, purpose);
// Narrow query used for identification: only this run's launcher and the processes it started.
const listLauncherFamily = launcherPid => psJson(`@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' AND (ProcessId=${Number(launcherPid)} OR ParentProcessId=${Number(launcherPid)})" | Select-Object ProcessId,ParentProcessId,CommandLine) | ConvertTo-Json -Compress -Depth 3`, `launcher family of pid ${Number(launcherPid)} (identification)`);
// Last-resort stop of an already-verified browser and the helper processes it started (taskkill
// /T walks that pid's own descendants). Used only when the profile-based stop could not run.
function killProcessTree(pid, timeoutMs = TIMEOUTS.teardownStep * 3) {
  return new Promise((resolve, reject) => {
    execFile("taskkill.exe", ["/PID", String(Number(pid)), "/T", "/F"], { timeout: timeoutMs, windowsHide: true }, (err, out, errOut) =>
      err ? reject(new Error(`taskkill of pid ${pid} failed: ${String(errOut || err.message).trim().slice(0, 200)}`)) : resolve());
  });
}
const isRunning = pid => { try { process.kill(Number(pid), 0); return true; } catch (e) { return false; } };
const listListeners = (port, purpose = `listeners on port ${Number(port)}`) => psJson(`@(Get-NetTCPConnection -State Listen -LocalPort ${Number(port)} -ErrorAction SilentlyContinue | Select-Object LocalAddress,OwningProcess) | ConvertTo-Json -Compress`, purpose);
// True when the command line's --user-data-dir (quoted or not) is exactly this profile directory.
function namesProfile(commandLine, profile) {
  const m = /--user-data-dir=(?:"([^"]+)"|(\S+))/.exec(commandLine || "");
  return !!m && samePath(path.resolve(m[1] || m[2]), path.resolve(profile));
}
// Stops every msedge.exe whose --user-data-dir is this run's profile (browser and helpers) and
// waits (bounded) until none is left. Never touches a process with any other profile.
async function stopEdgeForProfile(profile, timeoutMs = TIMEOUTS.teardownStep * 2) {
  const ours = async () => (await within(listEdgeProcesses("all msedge.exe (teardown, profile filter)"), TIMEOUTS.processQuery, "Edge process query")).filter(p => namesProfile(p.CommandLine, profile));
  for (const p of await ours()) { try { process.kill(Number(p.ProcessId)); } catch (e) { /* already gone */ } }
  const end = Date.now() + timeoutMs;
  for (let left = await ours(); left.length; left = await ours()) {
    if (Date.now() > end) throw new Error(`Edge processes for this run's profile still running: ${left.map(p => p.ProcessId).join(", ")}`);
    await pause(300);
  }
}
// Calls fn for each complete line written to a readable stream.
function onLines(stream, fn) {
  let buf = "";
  stream.setEncoding("utf8");
  stream.on("data", chunk => { buf += chunk; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ""); buf = buf.slice(i + 1); fn(line); } });
}
// Polls cond() until it is true; fails after ms, or as soon as the run fails.
async function waitUntil(cond, ms, what) {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error(`${what} (timed out after ${ms} ms)`); await sleep(100); }
}

/* Port preflight: bind each port on 127.0.0.1, then release it at once. This proves only that the
   port was free at that moment — another process can still take it before the API server, the
   mock or Edge binds it (a check-then-use race that no bind-and-release check can remove). Those
   later binds fail loudly (fatal), and the API server and Edge must additionally prove that they
   are the ones listening (see the startup sequence). */
async function assertPortFree(port, label) {
  const srv = net.createServer();
  try {
    await within(new Promise((resolve, reject) => {
      srv.once("error", err => reject(new Error(`port ${port} (${label}) is not available: ${err.code || err.message}`)));
      srv.listen(port, "127.0.0.1", () => srv.close(err => (err ? reject(new Error(`port ${port} (${label}): the check listener did not close: ${err.message}`)) : resolve())));
    }), TIMEOUTS.portCheck, `port ${port} (${label}) check`);
  } finally {
    if (srv.listening) srv.close();
  }
}
// The storefront must already be served at FRONT; this suite does not start it.
async function assertFrontend() {
  let res, body;
  try { res = await fetch(`${FRONT}/cart.html`, { signal: AbortSignal.timeout(TIMEOUTS.frontend) }); body = await res.text(); }
  catch (e) { throw new Error(`frontend ${FRONT} did not respond (${e && e.name === "TimeoutError" ? "timeout" : (e && e.message) || e})`); }
  if (res.status !== 200 || !body.includes('id="checkout-btn"')) throw new Error(`${FRONT}/cart.html is not the expected storefront cart page (status ${res.status})`);
}

/* mock Paystack: authorization_url sends the browser straight back to the callback (simulated payment) */
const txs = new Map(); let nextStatus = "success";
const mock = http.createServer((req, res) => {
  const send = (c, o) => { res.writeHead(c, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
  let body = ""; req.on("data", c => body += c); req.on("end", () => {
    try {
      if (req.method === "POST" && req.url === "/transaction/initialize") {
        const b = JSON.parse(body); txs.set(b.reference, { ...b, status: nextStatus });
        return send(200, { status: true, data: { authorization_url: `${FRONT}/payment-callback.html?trxref=${b.reference}&reference=${b.reference}`, reference: b.reference } });
      }
      const m = req.url.match(/^\/transaction\/verify\/(.+)$/);
      if (m) { const t = txs.get(decodeURIComponent(m[1])); return t ? send(200, { status: true, data: { reference: t.reference, amount: t.amount, currency: t.currency, metadata: t.metadata, status: t.status } }) : send(404, { status: false }); }
      send(404, {});
    } catch (err) {
      failRun(new Error(`mock Paystack could not handle ${req.method} ${req.url}: ${err.message}`));
      try { send(500, { status: false }); } catch (e) { /* response already started */ }
    }
  });
});

/* Fixture stock ceiling. The over-stock assertions below deliberately ask for a
   quantity a few units ABOVE the product's stock. That quantity must still fall within
   pricing.js's MAX_QTY_PER_LINE, otherwise the server rejects it as an invalid
   QUANTITY and the stock check — the thing actually under test — never runs.
   Selecting the fixture by stock range instead of by a fixed product id keeps the
   suite immune to admin stock edits changing which product sorts first. */
const MAX_QTY_PER_LINE = 50;                                   // must match pricing.js
const OVER_STOCK_PROBE = 3;                                    // largest "stock + n" these tests ask for
const MAX_FIXTURE_STOCK = MAX_QTY_PER_LINE - OVER_STOCK_PROBE; // 47

(async () => {
  const fx = { users: [], stock: new Map(), coupons: [], offers: [] };
  const createdPaths = [];   // every directory this run created, in order
  // blockedCount / blocked / blockedHosts: UNEXPECTED blocks only. expectedBlocked: url -> count.
  const netLog = { rewritten: 0, allowed: 0, expectedBlocked: new Map(), blockedCount: 0, blocked: [], blockedHosts: new Set(), violations: [], cdpErrors: [] };
  let server, edge, ws, wsClosing = false, harnessError = null;
  let serverListening = false, serverIdentity = null, createdProfile = null, profileDeleted = false;
  let edgeBrowserPid = null, edgeCandidatePid = null, edgeWatch = null, edgeStopping = false, edgeBrowserGone = false, edgeDiagnosisPassed = false;
  if (DIAGNOSE_EDGE_ONLY) console.log("[edge-diag] DIAGNOSTIC MODE (NF_E2E_DIAGNOSE_EDGE=1): stops after Edge identification; no page connection, interception, fixtures or checkout actions");
  const deadline = setTimeout(() => failRun(new Error(`run deadline of ${TIMEOUTS.run} ms exceeded`)), TIMEOUTS.run);
  try {
    /* ---- Preflight: nothing exists yet. Ports, storefront, this process's database identity,
       the fixture products (read only), then this run's output folder. ---- */
    console.log(FUNCTIONAL_ONLY_NOTICE);
    for (const [port, label] of [[API_PORT, "API server"], [MOCK_PORT, "mock Paystack"], [CDP_PORT, "Edge DevTools"]]) await assertPortFree(port, label);
    await assertFrontend();
    // The guard's identity gate (gatePool → pool.__nfIdentityGate), invoked explicitly as in
    // payment-tests.js so a mismatch stops the run here, before anything is spawned or written.
    let parentIdentity = null;
    try { parentIdentity = typeof pool.__nfIdentityGate === "function" ? await guarded(pool.__nfIdentityGate()) : null; } catch (e) { if (fatalError) throw e; parentIdentity = null; }
    if (parentIdentity !== EXPECTED_IDENTITY) throw new Error(`the database identity check did not pass (expected ${EXPECTED_IDENTITY})`);
    console.log(`database identity verified: ${parentIdentity}`);
    // Fixture products are chosen now (a read), so a database without enough of them fails
    // before anything is started. Nothing is written until Edge and interception are ready.
    const inStock = await q(
      "SELECT id, name, price, stock_qty FROM products WHERE deleted_at IS NULL AND stock_qty BETWEEN 5 AND ? ORDER BY id LIMIT 2",
      [MAX_FIXTURE_STOCK]
    );
    if (inStock.length < 2) throw new Error(`fixture: need 2 active products with stock 5..${MAX_FIXTURE_STOCK}, found ${inStock.length}`);
    const [A, B] = inStock;
    [A, B].forEach(p => fx.stock.set(p.id, p.stock_qty));
    fs.mkdirSync(OUT); createdPaths.push(OUT);   // not recursive: fails if it already exists

    /* ---- mock Paystack: a failed listen rejects into the normal failure path ---- */
    await guarded(new Promise((resolve, reject) => {
      const onError = err => reject(new Error(`mock Paystack could not listen on 127.0.0.1:${MOCK_PORT}: ${err.code || err.message}`));
      mock.once("error", onError);
      mock.listen(MOCK_PORT, "127.0.0.1", () => { mock.off("error", onError); mock.on("error", err => failRun(new Error(`mock Paystack error: ${err.code || err.message}`))); resolve(); });
    }));

    /* ---- API server: CHILD_ENV (guarded), output captured. Before Edge starts it must
       (1) report that IT is listening on API_PORT (its bind succeeded; a port conflict makes it
       exit, which is fatal), (2) answer /api/health with status ok / database ok, (3) have
       printed its own guard's "identity verified" line for the expected database — the line
       carries the child's pid, so it cannot come from another process — and (4) still be
       running. An HTTP answer on API_PORT alone is never accepted. ---- */
    server = spawn(process.execPath, ["server.js"], { cwd: REPO_ROOT, env: CHILD_ENV, stdio: ["ignore", "pipe", "pipe"] });
    watchChild(server, "API server");
    const serverTag = GUARD_TAG(server.pid);
    const onServerLine = stream => line => {
      console.log(`[api ${stream}] ${line}`);
      if (line === `${serverTag} identity verified ${EXPECTED_IDENTITY}`) serverIdentity = EXPECTED_IDENTITY;
      else if (line.startsWith(`${serverTag} identity verified`)) failRun(new Error(`API server verified an unexpected database identity: ${line}`));
      if (line.startsWith(`${serverTag} ABORT`)) failRun(new Error(`API server guard refused: ${line}`));
      if (line === `NeoFragrances API running at http://localhost:${API_PORT}`) serverListening = true;
    };
    onLines(server.stdout, onServerLine("out"));
    onLines(server.stderr, onServerLine("err"));
    await waitUntil(() => serverListening, TIMEOUTS.serverStart, `API server did not report listening on port ${API_PORT}`);
    let health;
    try {
      const res = await guarded(fetch(`${API_ORIGIN}/api/health`, { signal: AbortSignal.timeout(TIMEOUTS.health) }));
      health = { status: res.status, body: await guarded(res.text()) };
    } catch (e) {
      if (fatalError) throw e;
      throw new Error(`API /api/health did not answer (${e && e.name === "TimeoutError" ? "timeout" : (e && e.message) || e})`);
    }
    let healthJson = null; try { healthJson = JSON.parse(health.body); } catch (e) { /* checked below */ }
    if (health.status !== 200 || !healthJson || healthJson.status !== "ok" || healthJson.database !== "ok") throw new Error(`API /api/health is not healthy (status ${health.status})`);
    await waitUntil(() => serverIdentity, TIMEOUTS.identityLine, `API server guard did not report the verified identity ${EXPECTED_IDENTITY}`);
    if (server.exitCode !== null || server.signalCode !== null) throw new Error("API server is no longer running");
    console.log(`API server pid ${server.pid}: listening on ${API_PORT}, /api/health ok, guard identity ${serverIdentity}`);

    /* ---- headless Edge over CDP. Own profile (created here, deleted in teardown); a deliberately
       minimal environment (no shell or database variables; its temp files stay inside the
       profile); background networking reduced; every host name except localhost made
       unresolvable, as a second layer behind page-request interception. ---- */
    fs.mkdirSync(PROFILE); createdPaths.push(PROFILE); createdProfile = PROFILE;   // not recursive: fails if it exists
    const edgeTmp = path.join(PROFILE, "tmp"); fs.mkdirSync(edgeTmp);
    const EDGE_ENV = { TEMP: edgeTmp, TMP: edgeTmp };
    for (const k of ["SystemRoot", "windir", "PATH", "PATHEXT"]) if (process.env[k] !== undefined) EDGE_ENV[k] = process.env[k];
    let devtoolsBrowserUrl = null;
    edge = spawn(EDGE_EXE, [
      "--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, "--no-first-run",
      "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync",
      "--no-pings", "--disable-domain-reliability", "--disable-extensions",
      "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1", "about:blank",
    ], { env: EDGE_ENV, stdio: ["ignore", "ignore", "pipe"] });
    // The launcher may hand off (see psJson above): its exit with code 0 is accepted; any other
    // exit, or a launch error, is fatal. The browser it started is watched separately below.
    edge.on("error", err => failRun(new Error(`Edge process error: ${err.code || err.message}`)));
    console.log(`[edge-diag] Edge launcher spawned: pid ${edge.pid} at ${new Date().toISOString()}`);
    edge.on("exit", (code, signal) => {
      console.log(`[edge-diag] Edge launcher pid ${edge.pid} exited at ${new Date().toISOString()} (code ${code}, signal ${signal})`);
      if (!edge.nfStopping && !(code === 0 && signal === null)) failRun(new Error(`Edge launcher exited unexpectedly (code ${code}, signal ${signal})`));
    });
    // Without a hand-off the launched process is the browser and still announces its endpoint;
    // when it does, the announcement must match the identified browser's endpoint below.
    onLines(edge.stderr, line => {
      const m = /^DevTools listening on (ws:\/\/127\.0\.0\.1:(\d+)\/devtools\/browser\/\S+)$/.exec(line.trim());
      if (m && Number(m[2]) === CDP_PORT) devtoolsBrowserUrl = m[1];
    });
    // Identify THIS run's browser before anything is driven over CDP_PORT (see psJson above).
    // Returns null while it is not (yet) listening; throws on anything ambiguous or foreign.
    // Only this run's launcher and its direct children are queried (fast); the profile is fresh
    // and unique to this run, and the port check below proves the endpoint belongs to the match.
    const identifyEdge = async () => {
      const ours = (await guarded(listLauncherFamily(edge.pid))).filter(p => namesProfile(p.CommandLine, PROFILE));
      const browsers = ours.filter(p => !/\s--type=/.test(p.CommandLine || ""));
      if (browsers.length === 0) return null;
      // Mid hand-off: the launcher (still running) and the one browser it started both look like
      // main processes with this profile. Not settled yet: query again once the launcher is gone.
      const launcherRunning = edge.exitCode === null && edge.signalCode === null;
      if (browsers.length === 2 && launcherRunning) {
        const launcher = browsers.find(p => Number(p.ProcessId) === edge.pid);
        const child = browsers.find(p => Number(p.ProcessId) !== edge.pid);
        if (launcher && child && Number(child.ParentProcessId) === edge.pid) {
          console.log(`[edge-diag] hand-off in progress: launcher pid ${edge.pid} still running beside its browser pid ${child.ProcessId}; querying again`);
          return null;
        }
      }
      if (browsers.length > 1) throw new Error(`more than one Edge browser process uses this run's profile (pids ${browsers.map(p => p.ProcessId).join(", ")})`);
      const b = browsers[0], pid = Number(b.ProcessId);
      if (pid !== edge.pid && Number(b.ParentProcessId) !== edge.pid) throw new Error(`the Edge browser using this run's profile (pid ${pid}) was not started by this run's launcher (pid ${edge.pid})`);
      edgeCandidatePid = pid;   // this run's browser (launcher + profile verified): a cleanup target from now on
      if (!String(b.CommandLine).includes(`--remote-debugging-port=${CDP_PORT}`)) throw new Error(`the Edge browser using this run's profile (pid ${pid}) does not carry --remote-debugging-port=${CDP_PORT}`);
      const listeners = await guarded(listListeners(CDP_PORT));
      if (listeners.length === 0) return null;
      if (listeners.length !== 1 || Number(listeners[0].OwningProcess) !== pid || listeners[0].LocalAddress !== "127.0.0.1") {
        throw new Error(`127.0.0.1:${CDP_PORT} is not owned solely by this run's Edge browser (pid ${pid}): ${JSON.stringify(listeners)}`);
      }
      return { pid, handedOff: pid !== edge.pid };
    };
    let browser = null;
    for (const end = Date.now() + TIMEOUTS.edgeIdentify; !browser;) {
      browser = await identifyEdge();
      if (!browser) { if (Date.now() > end) throw new Error(`no Edge browser for this run's profile was listening on 127.0.0.1:${CDP_PORT} (timed out after ${TIMEOUTS.edgeIdentify} ms)`); await sleep(250); }
    }
    edgeBrowserPid = browser.pid;
    // From here on the identified browser must stay alive until teardown stops it.
    edgeWatch = setInterval(() => {
      if (isRunning(edgeBrowserPid)) return;
      edgeBrowserGone = true;
      if (!edgeStopping) failRun(new Error(`Edge browser (pid ${edgeBrowserPid}) exited unexpectedly`));
    }, 1000);
    // The endpoint answering on CDP_PORT must be that browser: a browser-level DevTools URL on
    // this port, matching the launcher's announcement if there was one, and the port still owned
    // solely by the identified browser after the answer.
    const cdpJson = async p => { const r = await guarded(fetch(`http://127.0.0.1:${CDP_PORT}${p}`, { signal: AbortSignal.timeout(TIMEOUTS.health) })); return guarded(r.json()); };
    const browserUrl = (await cdpJson("/json/version")).webSocketDebuggerUrl;
    if (typeof browserUrl !== "string" || !browserUrl.startsWith(`ws://127.0.0.1:${CDP_PORT}/devtools/browser/`)) throw new Error(`unexpected DevTools browser URL on port ${CDP_PORT}: ${browserUrl}`);
    if (devtoolsBrowserUrl && devtoolsBrowserUrl !== browserUrl) throw new Error(`the DevTools endpoint on port ${CDP_PORT} is not the Edge this run started`);
    const ownerAfter = await guarded(listListeners(CDP_PORT));
    if (ownerAfter.length !== 1 || Number(ownerAfter[0].OwningProcess) !== edgeBrowserPid) throw new Error(`127.0.0.1:${CDP_PORT} changed owner while the endpoint was verified: ${JSON.stringify(ownerAfter)}`);
    console.log(`Edge browser pid ${edgeBrowserPid} (${browser.handedOff ? `started by launcher pid ${edge.pid}, which handed off` : "the launched process"}): sole owner of 127.0.0.1:${CDP_PORT}, profile ${PROFILE}, ${browserUrl}`);
    if (DIAGNOSE_EDGE_ONLY) {
      edgeDiagnosisPassed = true;
      console.log("[edge-diag] DIAGNOSTIC MODE: Edge identified (profile, launcher relationship, port ownership) and endpoint verified; stopping before page connection and fixtures");
      return;   // finally: normal teardown
    }
    let wsUrl;
    for (const end = Date.now() + TIMEOUTS.devtools; !wsUrl;) {
      try { wsUrl = (await cdpJson("/json/list")).find(t => t.type === "page")?.webSocketDebuggerUrl; } catch (e) { if (fatalError) throw e; }
      if (!wsUrl) { if (Date.now() > end) throw new Error(`Edge exposed no page target (timed out after ${TIMEOUTS.devtools} ms)`); await sleep(200); }
    }
    if (!wsUrl.startsWith(`ws://127.0.0.1:${CDP_PORT}/devtools/page/`)) throw new Error(`unexpected page target URL ${wsUrl}`);
    ws = new WebSocket(wsUrl);
    await guarded(within(new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP WebSocket failed to open")), { once: true });
    }), TIMEOUTS.wsOpen, "CDP WebSocket open"));
    ws.addEventListener("close", () => { if (!wsClosing) failRun(new Error("CDP connection closed unexpectedly")); });
    ws.addEventListener("error", () => { if (!wsClosing) failRun(new Error("CDP connection error")); });
    let id = 0; const pending = new Map(); const errors = []; let loads = 0;
    // A routing command that is rejected, times out or is answered with a CDP error is recorded;
    // any recorded routing error fails the run at the end.
    const cdpFire = (method, params) => send(method, params).then(
      r => { if (r && r.error) netLog.cdpErrors.push(`${method}: ${r.error.message}`); },
      e => netLog.cdpErrors.push(`${method}: ${e.message}`)
    );
    // Every page request pauses here (pattern "*"). Only data:/blob: (no network), the storefront
    // and the isolated API continue; localhost:5000 is rewritten to the isolated API; anything else
    // is failed in the browser. An exact EXPECTED_BLOCKED_STYLESHEETS match (URL + GET +
    // Stylesheet) is counted as expected; every other block is recorded as unexpected, and
    // unexpected blocks fail the run at the end.
    const routeRequest = ({ requestId, request, resourceType }) => {
      let u = null; try { u = new URL(request.url); } catch (e) { /* unparsable: blocked below */ }
      if (u && (u.protocol === "data:" || u.protocol === "blob:")) { netLog.allowed++; return cdpFire("Fetch.continueRequest", { requestId }); }
      if (u && u.origin === DEV_API_ORIGIN) { netLog.rewritten++; return cdpFire("Fetch.continueRequest", { requestId, url: API_ORIGIN + u.pathname + u.search }); }
      if (u && BROWSER_ALLOWED_ORIGINS.has(u.origin)) { netLog.allowed++; return cdpFire("Fetch.continueRequest", { requestId }); }
      if (u && request.method === "GET" && resourceType === "Stylesheet" && EXPECTED_BLOCKED_STYLESHEETS.has(u.href)) {
        netLog.expectedBlocked.set(u.href, (netLog.expectedBlocked.get(u.href) || 0) + 1);
        return cdpFire("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
      }
      const host = u ? u.host : "(unparsable URL)";
      if (!netLog.blockedHosts.has(host)) console.error(`BLOCKED browser request to ${host}`);
      netLog.blockedHosts.add(host); netLog.blockedCount++;
      if (netLog.blocked.length < 100) netLog.blocked.push(String(request.url).slice(0, 200));
      if (u && u.port === "5000") netLog.violations.push(`un-rewritten request to port 5000 (blocked): ${String(request.url).slice(0, 200)}`);
      return cdpFire("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
    };
    // Second check, on what actually answered: a response from port 5000 (the dev server, wired to
    // the working database) or from a non-loopback address means a request escaped the routing.
    const checkResponse = r => {
      const port = Number(r.remotePort), ip = String(r.remoteIPAddress || "").replace(/^\[|\]$/g, "");
      let problem = null;
      if (port === 5000) problem = `a response came from port 5000 (not rewritten): ${String(r.url).slice(0, 200)}`;
      else if (ip && ip !== "127.0.0.1" && ip !== "::1") problem = `a response came from outside address ${ip}: ${String(r.url).slice(0, 200)}`;
      if (problem) { netLog.violations.push(problem); failRun(new Error(`browser isolation breached: ${problem}`)); }
    };
    ws.addEventListener("message", ev => {
      const m = JSON.parse(ev.data);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === "Fetch.requestPaused") routeRequest(m.params);
      if (m.method === "Network.responseReceived") checkResponse(m.params.response || {});
      if (m.method === "Page.loadEventFired") loads++;
      if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description?.split("\n")[0]);
      if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") errors.push("console.error " + m.params.args.map(a => a.value ?? a.description).join(" "));
    });
    // Every command has a bounded wait and stops as soon as the run fails.
    const send = (method, params = {}) => guarded(new Promise((resolve, reject) => {
      const i = ++id;
      const timer = setTimeout(() => { pending.delete(i); reject(new Error(`CDP ${method} timed out after ${TIMEOUTS.cdpSend} ms`)); }, TIMEOUTS.cdpSend);
      pending.set(i, m => { clearTimeout(timer); resolve(m); });
      try { ws.send(JSON.stringify({ id: i, method, params })); } catch (e) { clearTimeout(timer); pending.delete(i); reject(e); }
    }));
    const required = async (method, params) => { const r = await send(method, params); if (r.error) throw new Error(`CDP ${method} failed: ${r.error.message}`); return r; };
    // Interception first, before any navigation (the target is still on about:blank).
    await required("Page.enable"); await required("Runtime.enable");
    await required("Fetch.enable", { patterns: [{ urlPattern: "*" }] });
    await required("Network.enable"); await required("Network.setCacheDisabled", { cacheDisabled: true });
    await required("Network.setBypassServiceWorker", { bypass: true });

    /* ---- Fixtures. Written only now, after every startup check has passed: this process's
       guard and database identity (preflight); the API server listening, healthy, reporting
       the expected identity and still running; Edge's own DevTools endpoint and page
       connection; request interception enabled. qRaw: never cut short by a run failure, so
       each completed insert has its id recorded for the cleanup in finally. ---- */
    if (fatalError) throw fatalError;
    if (server.exitCode !== null || server.signalCode !== null) throw new Error("API server is no longer running");
    const u = (await qRaw("INSERT INTO users (full_name, email, password_hash, role, email_verified_at) VALUES ('E2E Shopper', ?, 'x', 'customer', NOW())", [`nf-e2e-${Date.now()}@example.invalid`])).insertId; fx.users.push(u);
    const code = `E2E${crypto.randomBytes(2).toString("hex").toUpperCase()}`;
    fx.coupons.push((await qRaw("INSERT INTO coupons (code, discount_percent) VALUES (?, 10)", [code])).insertId);
    const off = (await qRaw("INSERT INTO offers (title, offer_type, start_at, end_at, active) VALUES ('E2E offer','discount', NOW() - INTERVAL 1 HOUR, NOW() + INTERVAL 1 DAY, 1)")).insertId; fx.offers.push(off);
    const sale = Math.round(Number(B.price) * 0.75 * 100) / 100;
    await qRaw("INSERT INTO offer_products (offer_id, product_id, original_price, sale_price) VALUES (?,?,?,?)", [off, B.id, B.price, sale]);
    const token = jwt.sign({ id: u, role: "customer" }, SECRET);
    const auth = JSON.stringify({ token, user: { id: u, full_name: "E2E Shopper", email: "e2e@example.invalid", role: "customer" } });
    const ev = async expr => { const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };
    const go = async url => { const before = loads; await send("Page.navigate", { url }); for (let i = 0; i < 150 && loads === before; i++) await sleep(100); await sleep(1800); };
    const waitFor = async (expr, ms = 8000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr)) return true; await sleep(200); } return false; };
    const viewport = (w, h) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile: w < 800 });
    const shot = async name => { const m = await send("Page.getLayoutMetrics"); const h = Math.min(Math.ceil(m.result.cssContentSize.height), 8000); const w = Math.ceil(m.result.cssLayoutViewport.clientWidth); const s = await send("Page.captureScreenshot", { format: "jpeg", quality: 72, captureBeyondViewport: true, clip: { x: 0, y: 0, width: w, height: h, scale: 1 } }); fs.writeFileSync(path.join(OUT, name), Buffer.from(s.result.data, "base64")); };
    const setStorage = async (cart, withAuth = true) => { await ev(`localStorage.setItem("neofragrances_cart", ${JSON.stringify(JSON.stringify(cart))}); ${withAuth ? `localStorage.setItem("neofragrances_auth", ${JSON.stringify(auth)});` : `localStorage.removeItem("neofragrances_auth");`} sessionStorage.clear(); true`); };

    await viewport(1440, 900);
    await go(`${FRONT}/index.html`);
    check("header cart badge shows count on page load", await (async () => { await setStorage([{ id: A.id, qty: 2, offerId: null }]); await go(`${FRONT}/about.html`); return (await ev(`document.querySelector(".cart-count").textContent`)) === "2"; })());

    /* 1. Logged out */
    await setStorage([{ id: A.id, qty: 1, offerId: null }], false);
    await go(`${FRONT}/cart.html`);
    await waitFor(`document.getElementById("summary-total").textContent.includes("GH₵")`);
    check("logged out: sign-in prompt in delivery step", await ev(`!!document.querySelector(".nf-signin-prompt")`));
    check("logged out: pay button asks to log in", /Log in/.test(await ev(`document.getElementById("checkout-btn-label").textContent`)));
    check("logged out: server total shown", await ev(`document.getElementById("summary-total").textContent`) === `GH₵${(Number(A.price) + 8).toFixed(2)}`, await ev(`document.getElementById("summary-total").textContent`));

    /* 2. Low stock issue */
    await setStorage([{ id: A.id, qty: A.stock_qty + 3, offerId: null }]);
    await go(`${FRONT}/cart.html`);
    check("over-stock line flagged + pay disabled", await ev(`!!document.querySelector(".nf-line-issue") && document.getElementById("checkout-btn").disabled`), await ev(`document.querySelector(".nf-line-issue")?.textContent.trim()`));
    await ev(`document.querySelector("[data-action=cap]").click(); true`); await sleep(1200);
    check("'Update to N' fixes the line", await ev(`!document.querySelector(".nf-line-issue") && JSON.parse(localStorage.getItem("neofragrances_cart"))[0].qty === ${A.stock_qty}`));

    /* 3. Happy path: regular + offer line, address form, promo, pay */
    await setStorage([{ id: A.id, qty: 1, offerId: null }, { id: B.id, qty: 2, offerId: off }]);
    await go(`${FRONT}/cart.html`);
    await waitFor(`document.getElementById("summary-total").textContent.includes("GH₵")`);
    const expSub = Math.round(Number(A.price) * 100) + Math.round(sale * 100) * 2;
    check("offer line shows sale price + Offer tag", await ev(`!!document.querySelector(".nf-line-sale") && !!document.querySelector(".nf-line-tag")`));
    check("summary subtotal = server price incl. offer", await ev(`document.getElementById("summary-subtotal").textContent`) === `GH₵${(expSub / 100).toFixed(2)}`, await ev(`document.getElementById("summary-subtotal").textContent`));
    check("offer savings row shown", await ev(`!document.getElementById("summary-offer-row").hidden`), await ev(`document.getElementById("summary-offer-savings").textContent`));
    check("no address yet: form shown, pay disabled with reason", await ev(`!!document.getElementById("address-form") && document.getElementById("checkout-btn").disabled`), await ev(`document.getElementById("pay-hint").textContent`));
    await ev(`document.getElementById("save-address-btn").click(); true`); await sleep(300);
    check("address validation: required fields flagged", await ev(`document.querySelectorAll("#address-form [aria-invalid=true]").length >= 3`));
    await ev(`(()=>{const s=(i,v)=>{document.getElementById(i).value=v}; s("addr-name","E2E Shopper"); s("addr-line1","12 Test Avenue"); s("addr-city","Accra"); s("addr-phone","0200000000"); document.getElementById("save-address-btn").click(); return true;})()`);
    await waitFor(`!!document.querySelector(".nf-address.is-selected")`);
    check("address saved + selected", await ev(`!!document.querySelector(".nf-address.is-selected")`));
    await ev(`document.getElementById("promo").open = true; document.getElementById("coupon-input").value = "nopecode"; document.getElementById("apply-coupon-btn").click(); true`);
    await waitFor(`document.getElementById("coupon-msg").textContent.length > 0`);
    check("invalid promo code shows error", /not valid/i.test(await ev(`document.getElementById("coupon-msg").textContent`)), await ev(`document.getElementById("coupon-msg").textContent`));
    await ev(`document.getElementById("coupon-input").value = "${code.toLowerCase()}"; document.getElementById("apply-coupon-btn").click(); true`);
    await waitFor(`!document.getElementById("summary-discount-row").hidden`);
    const expDisc = Math.round(expSub * 0.1), expTotal = expSub - expDisc + 800;
    check("promo applied (case-insensitive), discount from server", await ev(`document.getElementById("summary-discount").textContent`) === `−GH₵${(expDisc / 100).toFixed(2)}`, await ev(`document.getElementById("summary-discount").textContent`));
    check("pay button shows exact server total", await ev(`document.getElementById("checkout-btn-label").textContent`) === `Pay GH₵${(expTotal / 100).toFixed(2)}` && !(await ev(`document.getElementById("checkout-btn").disabled`)), await ev(`document.getElementById("checkout-btn-label").textContent`));
    check("steps bar: payment step current", await ev(`document.querySelector("#steps-bar [aria-current=step]")?.dataset.step`) === "payment");
    await shot("cart-desktop.jpg");
    await viewport(390, 844); await sleep(600);
    check("mobile: pay bar visible with total", await ev(`getComputedStyle(document.getElementById("paybar")).display !== "none" && document.getElementById("paybar-total").textContent.includes("GH₵")`));
    check("mobile: no horizontal overflow (functional only: fallback fonts, no icons)",await ev(`document.documentElement.scrollWidth <= innerWidth`));
    await shot("cart-mobile.jpg");
    await viewport(1440, 900); await sleep(300);

    const before = loads;
    await ev(`document.getElementById("checkout-btn").click(); true`);
    for (let i = 0; i < 100 && loads === before; i++) await sleep(100);
    await waitFor(`document.querySelector(".nf-result-card h1")?.textContent.includes("confirmed")`, 10000);
    const paidTx = [...txs.values()].pop();
    check("Paystack initialized with server total", paidTx && paidTx.amount === expTotal, `${paidTx?.amount} vs ${expTotal}`);
    check("callback: success state", (await ev(`document.querySelector(".nf-result-card h1")?.textContent`) || "").includes("confirmed"), await ev(`document.querySelector(".nf-result-card h1")?.textContent`));
    check("callback: total paid in GH₵", (await ev(`document.querySelector(".nf-result-facts")?.textContent`) || "").includes(`GH₵${(expTotal / 100).toFixed(2)}`));
    check("cart cleared after success", await ev(`localStorage.getItem("neofragrances_cart") === null && document.querySelector(".cart-count").textContent === "0"`));
    const ord = (await q("SELECT total, status FROM orders WHERE payment_reference=?", [paidTx.reference]))[0];
    check("DB order: total = amount charged", ord && Math.round(Number(ord.total) * 100) === expTotal && ord.status === "Processing", `${ord?.total}`);
    await shot("callback-success.jpg");
    await go(`${FRONT}/payment-callback.html?reference=${paidTx.reference}`);
    check("callback reload is idempotent (same order, still success)", (await ev(`document.querySelector(".nf-result-card")?.textContent`) || "").includes("confirmed") && (await q("SELECT COUNT(*) n FROM orders WHERE payment_reference=?", [paidTx.reference]))[0].n === 1);

    /* 4. Failed payment */
    nextStatus = "failed";
    await setStorage([{ id: A.id, qty: 1, offerId: null }]);
    await go(`${FRONT}/cart.html`);
    await waitFor(`!document.getElementById("checkout-btn").disabled`);
    const b2 = loads; await ev(`document.getElementById("checkout-btn").click(); true`);
    for (let i = 0; i < 100 && loads === b2; i++) await sleep(100);
    await waitFor(`document.querySelector(".nf-result-card h1")?.textContent.includes("wasn")`, 10000);
    check("failed payment: 'wasn't completed' + bag kept", (await ev(`document.querySelector(".nf-result-card h1")?.textContent`) || "").includes("wasn") && (await ev(`JSON.parse(localStorage.getItem("neofragrances_cart")||"[]").length`)) === 1);
    nextStatus = "success";

    /* 5. Logged out on callback → login with return path */
    await ev(`localStorage.removeItem("neofragrances_auth"); true`);
    await go(`${FRONT}/payment-callback.html?reference=NF-123-1-abcdef12`);
    const loginHref = await ev(`document.querySelector(".nf-result-actions a")?.getAttribute("href")`);
    check("logged-out callback keeps reference through login", /redirect=payment-callback\.html%3Freference%3DNF-123-1-abcdef12/.test(loginHref || ""), loginHref);
    await go(`${FRONT}/payment-callback.html`);
    check("callback without reference handled", (await ev(`document.querySelector(".nf-result-card h1")?.textContent`) || "").includes("No payment"));

    /* 6. Empty bag */
    await ev(`localStorage.removeItem("neofragrances_cart"); true`);
    await go(`${FRONT}/cart.html`);
    check("empty bag state + suggestions", await ev(`!document.getElementById("bag-empty").hidden && document.getElementById("checkout-layout").hidden`), (await ev(`document.querySelectorAll("#bag-suggest-grid .product-card").length`)) + " suggestions");

    check("no JS exceptions during the flow", errors.filter(e => !/Failed to load resource|google|GSI/i.test(e)).length === 0, errors.slice(0, 3).join(" | "));
  } catch (e) {
    harnessError = (e && e.message) || String(e);
    console.error("E2E HARNESS ERROR:", e); results.push(false);
  } finally {
    // Teardown. Every step runs on its own: a failure is recorded and the next step still runs.
    // Any failure makes the run exit 1 with CLEANUP FAILED, alongside (never instead of) the
    // test result and any harness error above. Nothing here runs if the process is killed.
    // From here on failRun() only records (lateErrors); it no longer interrupts anything.
    tearingDown = true;
    clearTimeout(deadline);
    const cleanupFailures = [];
    const step = async (name, fn) => { try { await fn(); } catch (e) { cleanupFailures.push(`${name}: ${(e && e.message) || e}`); } };

    // 1. Stop everything that could still write: browser first (it drives the server), then
    //    the API server, then the mock. Database cleanup starts only after these.
    await step("close browser connection", async () => { wsClosing = true; if (ws) ws.close(); });
    // Edge: (a) the launcher, then every process whose --user-data-dir is this run's profile;
    // (b) if (a) failed or the verified browser is still running, that browser's own process tree,
    // by the pid verified earlier (skipped if the watch saw it exit, so a reused pid is never hit).
    // Each part runs whatever happened before it; any failure is still reported.
    edgeStopping = true;
    if (edgeWatch) clearInterval(edgeWatch);
    let profileStopFailed = false;
    await step("stop Edge launcher", () => stopChild(edge, "Edge launcher"));
    if (createdProfile) await step("stop Edge processes of this run's profile", async () => {
      try { await stopEdgeForProfile(createdProfile); } catch (e) { profileStopFailed = true; throw e; }
    });
    const verifiedPid = edgeBrowserPid || edgeCandidatePid;
    if (verifiedPid && !edgeBrowserGone && (profileStopFailed || isRunning(verifiedPid))) await step(`stop verified Edge browser pid ${verifiedPid} (fallback)`, async () => {
      await killProcessTree(verifiedPid);
      const end = Date.now() + TIMEOUTS.teardownStep * 2;
      while (isRunning(verifiedPid)) { if (Date.now() > end) throw new Error(`Edge browser pid ${verifiedPid} still running after taskkill`); await pause(300); }
      console.log(`Edge browser pid ${verifiedPid} stopped by the fallback (taskkill /T)`);
    });
    await step("stop API server", () => stopChild(server, "API server"));
    await step("close mock Paystack", async () => {
      if (!mock.listening) return;
      if (mock.closeAllConnections) mock.closeAllConnections();
      await within(new Promise((res, rej) => mock.close(err => (err ? rej(err) : res()))), TIMEOUTS.teardownStep, "mock Paystack close");
    });
    // Only the profile folder this run created (unique name, validated parent, mkdir'd above).
    if (createdProfile) await step("delete this run's Edge profile", async () => {
      if (!samePath(path.dirname(createdProfile), PROFILE_PARENT) || !path.basename(createdProfile).startsWith(`nf-edge-e2e-${RUN_ID}`)) throw new Error(`refusing to delete ${createdProfile}: not this run's profile`);
      fs.rmSync(createdProfile, { recursive: true, maxRetries: 20, retryDelay: 500 });   // Edge releases file locks shortly after it exits
      profileDeleted = true;
    });

    // 2. Database cleanup, keyed only by this run's own ids and payment references.
    //    The stock this run's orders took is read first, while the order lines still exist,
    //    so the restore below can check the stock is exactly what this run left behind.
    const fixtureRefs = [...txs.keys()];
    let consumed = fx.users.length ? null : new Map();   // productId -> units taken by this run's orders
    if (fx.users.length) await step("read this run's order lines", async () => {
      const rows = await qRaw("SELECT oi.product_id AS pid, SUM(oi.quantity) AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.user_id IN (?) GROUP BY oi.product_id", [fx.users]);
      consumed = new Map(rows.map(r => [Number(r.pid), Number(r.n)]));
    });
    let hasIssues = false;
    if (fixtureRefs.length) await step("check for the payment_issues table", async () => {
      const [{ n }] = await qRaw("SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_issues'");
      hasIssues = Number(n) > 0;
    });
    // Stage B (migration 009): remove payment_issues rows for exactly the references this run
    // initialized (recorded by the mock Paystack in txs), only if the table exists — a no-op on
    // a pre-009 database. Done before orders/users, whose deletion would only SET NULL the links.
    if (fixtureRefs.length && hasIssues) await step("delete payment_issues for this run's references", () => qRaw("DELETE FROM payment_issues WHERE payment_reference IN (?)", [fixtureRefs]));
    if (fx.users.length) {
      await step("delete this run's order_items", async () => {
        const oids = (await qRaw("SELECT id FROM orders WHERE user_id IN (?)", [fx.users])).map(o => o.id);
        if (oids.length) await qRaw("DELETE FROM order_items WHERE order_id IN (?)", [oids]);
      });
      await step("delete this run's orders", () => qRaw("DELETE FROM orders WHERE user_id IN (?)", [fx.users]));
      await step("delete this run's addresses", () => qRaw("DELETE FROM addresses WHERE user_id IN (?)", [fx.users]));
      await step("delete this run's users", () => qRaw("DELETE FROM users WHERE id IN (?)", [fx.users]));
    }
    if (fx.offers.length) {
      await step("delete this run's offer_products", () => qRaw("DELETE FROM offer_products WHERE offer_id IN (?)", [fx.offers]));
      await step("delete this run's offers", () => qRaw("DELETE FROM offers WHERE id IN (?)", [fx.offers]));
    }
    if (fx.coupons.length) await step("delete this run's coupons", () => qRaw("DELETE FROM coupons WHERE id IN (?)", [fx.coupons]));
    // Stock: put back exactly what this run's orders took, and only if the product still holds
    // the value that leaves. Any other value means something else changed it; it is reported
    // and left alone, never overwritten.
    for (const [pid, start] of fx.stock) await step(`restore stock of product ${pid}`, async () => {
      if (!consumed) throw new Error("not attempted: this run's order lines could not be read, so the expected stock is unknown");
      const took = consumed.get(pid) || 0;
      if (took === 0) return;
      const r = await qRaw("UPDATE products SET stock_qty = ? WHERE id = ? AND stock_qty = ?", [start, pid, start - took]);
      if (r.affectedRows !== 1) {
        const row = (await qRaw("SELECT stock_qty FROM products WHERE id = ?", [pid]))[0];
        throw new Error(`not restored: expected ${start - took} after this run's order(s), found ${row ? row.stock_qty : "no row"}; left unchanged`);
      }
    });
    if (consumed) for (const pid of consumed.keys()) if (!fx.stock.has(pid)) cleanupFailures.push(`restore stock of product ${pid}: this run's orders took stock from a non-fixture product; not restored`);

    // 3. Verify against this run's ids and the stock captured at the start.
    await step("verify nothing from this run remains", async () => {
      const left = [];
      const count = async (label, sql, params) => { const n = Number((await qRaw(sql, params))[0].n); if (n) left.push(`${label}=${n}`); };
      if (fx.users.length) {
        await count("users", "SELECT COUNT(*) AS n FROM users WHERE id IN (?)", [fx.users]);
        await count("orders", "SELECT COUNT(*) AS n FROM orders WHERE user_id IN (?)", [fx.users]);
        await count("addresses", "SELECT COUNT(*) AS n FROM addresses WHERE user_id IN (?)", [fx.users]);
      }
      if (fx.offers.length) {
        await count("offers", "SELECT COUNT(*) AS n FROM offers WHERE id IN (?)", [fx.offers]);
        await count("offer_products", "SELECT COUNT(*) AS n FROM offer_products WHERE offer_id IN (?)", [fx.offers]);
      }
      if (fx.coupons.length) await count("coupons", "SELECT COUNT(*) AS n FROM coupons WHERE id IN (?)", [fx.coupons]);
      if (fixtureRefs.length && hasIssues) await count("payment_issues", "SELECT COUNT(*) AS n FROM payment_issues WHERE payment_reference IN (?)", [fixtureRefs]);
      for (const [pid, start] of fx.stock) {
        const row = (await qRaw("SELECT stock_qty FROM products WHERE id = ?", [pid]))[0];
        if (!row || Number(row.stock_qty) !== Number(start)) left.push(`product ${pid} stock ${row ? row.stock_qty : "missing"} (started at ${start})`);
      }
      if (left.length) throw new Error("remaining: " + left.join(", "));
    });
    await step("close database pool", () => within(pool.end(), TIMEOUTS.teardownStep, "pool.end"));
    for (const message of lateErrors) cleanupFailures.push(`error during teardown: ${message}`);

    if (DIAGNOSE_EDGE_ONLY) {
      console.log(`[edge-diag] DIAGNOSTIC RESULT: identification ${edgeDiagnosisPassed ? `PASSED (browser pid ${edgeBrowserPid})` : "NOT completed"}; ${psQuerySeq} process queries; teardown ${cleanupFailures.length ? `had ${cleanupFailures.length} failure(s)` : "completed"}; Edge profile ${createdProfile ? (profileDeleted ? "deleted" : "NOT deleted") : "never created"}`);
      if (!edgeDiagnosisPassed) results.push(false);   // a diagnostic that did not identify Edge exits 1
    }
    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ""}`);
    if (harnessError) console.error(`Harness error (reported above, before cleanup): ${harnessError}`);
    console.log(`API server identity: ${serverIdentity ? `${serverIdentity} (pid ${server.pid})` : "not verified"}`);
    const expectedBlockedCount = [...netLog.expectedBlocked.values()].reduce((a, b) => a + b, 0);
    console.log(FUNCTIONAL_ONLY_NOTICE);
    console.log(`Browser requests: ${netLog.rewritten} rewritten ${DEV_API_ORIGIN} -> ${API_ORIGIN}, ${netLog.allowed} allowed (${[...BROWSER_ALLOWED_ORIGINS].join(", ")}, data:, blob:), ${expectedBlockedCount} expected blocks (listed stylesheets), ${netLog.blockedCount} unexpected blocks`);
    for (const [url, n] of netLog.expectedBlocked) console.log(`  expected block x${n}: ${url}`);
    if (netLog.blockedCount) console.error(`BROWSER ISOLATION: ${netLog.blockedCount} unexpected request(s) to outside hosts were blocked (${[...netLog.blockedHosts].join(", ")}):\n  - ${netLog.blocked.join("\n  - ")}`);
    if (netLog.violations.length) console.error(`BROWSER ISOLATION VIOLATIONS:\n  - ${netLog.violations.join("\n  - ")}`);
    if (netLog.cdpErrors.length) console.error(`CDP routing errors: ${netLog.cdpErrors.length} (fail the run; requests may have stalled):\n  - ${netLog.cdpErrors.slice(0, 20).join("\n  - ")}`);
    console.log(`Created by this run: ${createdPaths.length ? createdPaths.join(", ") : "nothing"}${createdProfile ? ` (Edge profile ${profileDeleted ? "deleted" : "NOT deleted"})` : ""}`);
    if (cleanupFailures.length) {
      console.error(`CLEANUP FAILED (${cleanupFailures.length} step${cleanupFailures.length === 1 ? "" : "s"}) — fixtures or stock may remain in ${process.env.NF_TEST_DB_NAME}, or files in the paths above:\n  - ${cleanupFailures.join("\n  - ")}`);
    }
    // Expected stylesheet blocks never count here; unexpected blocks, violations and CDP routing
    // errors each fail the run on their own, whatever the assertions say.
    const isolationFailures = netLog.blockedCount + netLog.violations.length;
    process.exit(failed || cleanupFailures.length || isolationFailures || netLog.cdpErrors.length ? 1 : 0);
  }
})();
