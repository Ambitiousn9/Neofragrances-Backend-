// Shared isolation helper for the database-backed suites (T04). TEST-ONLY; never loaded by
// the app. Generalises the hand-written guard block of admin-api-tests.js so every suite
// gets the same checks in the same order:
//
//   const iso = require("./support/isolated-suite");
//   iso.requireIsolation("my-suite.js");          // BEFORE dotenv / db.js are required
//   ...require dotenv, db.js...
//   await iso.verifyParentIdentity(pool, "my-suite.js");   // before any query or fixture
//   const srv = await iso.startGuardedServer({ suite, port, env: { JWT_SECRET, ... } });
//   ...
//   iso.stopServer(srv);
//
// Children that must run WITHOUT a database (fail-open / 503 tests) use startNoDbServer(),
// which swaps the guard preload for tests/support/no-db-preload.js and forces
// DB_HOST=127.0.0.1, DB_PORT=1.
//
// How to run a converted suite: see tests/README.md ("Isolated test database").
"use strict";
const path = require("path");
const { spawn } = require("child_process");

const SERVER_DIR = path.resolve(__dirname, "..", "..");
const GUARD_PRELOAD = path.join(SERVER_DIR, "tests", "support", "isolated-db-guard-preload.js");
const NODB_PRELOAD = path.join(SERVER_DIR, "tests", "support", "no-db-preload.js");
const guard = require("./isolated-db-guard");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const GUARD_ABORT = /\[(?:isolated-db-guard|no-db-guard) pid \d+\] ABORT:/;
// Keys a suite may never override for a child: they decide which database it reaches.
const PROTECTED_KEYS = ["NODE_OPTIONS", "NF_TEST_MODE", "NF_TEST_DB_NAME", "NF_TEST_DB_SERVER_HOSTNAME", "DB_HOST", "DB_PORT", "DB_NAME", "DB_USER", "DB_PASSWORD", "DB_SSL"];

function refuse(suite, problems) {
  console.error(`Refusing to run ${suite}:\n  - ${problems.join("\n  - ")}`);
  process.exit(1);
}

// NODE_OPTIONS is whitespace-separated; double quotes keep a value with spaces together.
function requiredPreloads(nodeOptions) {
  const tokens = (String(nodeOptions || "").match(/(?:[^\s"]+|"[^"]*")+/g) || []).map(t => t.replace(/"/g, ""));
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const m = /^(?:--require=(.+)|--require|-r)$/.exec(tokens[i]);
    if (m) out.push(m[1] !== undefined ? m[1] : tokens[++i] || "");
  }
  return out;
}
const samePath = (a, b) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
const requiresPreload = (nodeOptions, preload) => requiredPreloads(nodeOptions).some(p => path.isAbsolute(p) && samePath(path.resolve(p), preload));

// 1. Process-level check. Must run before dotenv and db.js: without the guard nothing
//    reads .env and no pool is created. (A preload with an invalid config already exited.)
function requireIsolation(suite) {
  const g = globalThis.__NF_ISOLATED_DB_GUARD__;
  const e = process.env;
  const problems = [];
  if (!g) problems.push("the isolated-database guard preload is not active (NODE_OPTIONS --require=\"<backend>/tests/support/isolated-db-guard-preload.js\")");
  if (e.NF_TEST_MODE !== "isolated") problems.push("NF_TEST_MODE must be \"isolated\"");
  if (!e.NF_TEST_DB_NAME || e.DB_NAME !== e.NF_TEST_DB_NAME) problems.push("DB_NAME must equal NF_TEST_DB_NAME");
  if (g && g.db !== e.NF_TEST_DB_NAME) problems.push("the guard's database is not NF_TEST_DB_NAME");
  if (e.DB_HOST !== "127.0.0.1") problems.push("DB_HOST must be 127.0.0.1");
  if (String(e.DB_PORT) !== String(guard.EXPECTED_PORT)) problems.push(`DB_PORT must be ${guard.EXPECTED_PORT}`);
  if (!requiresPreload(e.NODE_OPTIONS, GUARD_PRELOAD)) problems.push(`NODE_OPTIONS must --require the guard preload by absolute path (${GUARD_PRELOAD}) so spawned servers are guarded too`);
  if (path.resolve(process.cwd()) !== SERVER_DIR && !samePath(path.resolve(process.cwd()), SERVER_DIR)) problems.push(`working directory must be the backend repo (${SERVER_DIR})`);
  if (problems.length) refuse(suite, problems);
  return { db: e.NF_TEST_DB_NAME, host: e.NF_TEST_DB_SERVER_HOSTNAME, port: Number(e.DB_PORT) };
}

// 2. The guard's identity gate (SELECT DATABASE(), @@hostname, @@port) must match before
//    ANY query of the suite runs. Invoked explicitly so a failure stops before fixtures.
async function verifyParentIdentity(pool, suite) {
  let identity = null;
  try { identity = typeof pool.__nfIdentityGate === "function" ? await pool.__nfIdentityGate() : null; } catch (e) { identity = null; }
  if (typeof identity !== "string" || !identity.startsWith(`${process.env.NF_TEST_DB_NAME}@`)) {
    console.error(`Refusing to run ${suite}: the database identity check did not pass.`);
    await pool.end().catch(() => {});
    process.exit(1);
  }
  console.log(`database identity verified: ${identity}`);
  return identity;
}

function childEnvFor(suite, overrides) {
  const bad = Object.keys(overrides || {}).filter(k => PROTECTED_KEYS.includes(k));
  if (bad.length) throw new Error(`${suite}: a child server may not override ${bad.join(", ")}`);
  const env = { ...process.env, ...overrides };
  const problems = [];
  if (!requiresPreload(env.NODE_OPTIONS, GUARD_PRELOAD)) problems.push("the child's NODE_OPTIONS does not --require the guard preload");
  const cfg = guard.validateTestConfig(env);
  if (!cfg.ok) problems.push(`the child's isolation settings are invalid: ${cfg.reason}`);
  if (problems.length) refuse(`${suite} (the child server would not be guarded)`, problems);
  return env;
}

function launch(env, port) {
  const proc = spawn(process.execPath, ["server.js"], { cwd: SERVER_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  const srv = { proc, port, base: `http://127.0.0.1:${port}`, out: "", spawnError: null };
  proc.stdout.on("data", d => { srv.out += d; });
  proc.stderr.on("data", d => { srv.out += d; });
  proc.once("error", e => { srv.spawnError = e; });
  srv.gone = () => proc.exitCode !== null || proc.signalCode !== null;
  srv.log = () => srv.out;
  return srv;
}

function startupError(srv, reason, startedAt, extra = "") {
  const tail = srv.out.split(/\r?\n/).filter(l => l.trim()).slice(-10).join("\n") || "(none)";
  return new Error(`child server :${srv.port} not ready (${reason}) after ${Date.now() - startedAt} ms\n` +
    `pid=${srv.proc.pid} exitCode=${srv.proc.exitCode} signal=${srv.proc.signalCode}${srv.spawnError ? ` spawnError=${srv.spawnError.code || srv.spawnError.message}` : ""}${extra}\n` +
    `last child output:\n${tail}`);
}

// Waits passively (no requests) for server.js's own listening line; startup can take ~17 s
// on this machine, so a short probe loop is not used. Fails closed on guard abort, spawn
// error, early exit or timeout.
async function waitListening(srv, deadlineMs) {
  const startedAt = Date.now();
  const line = `NeoFragrances API running at http://localhost:${srv.port}`;
  while (!srv.out.includes(line) && !GUARD_ABORT.test(srv.out) && !srv.spawnError && !srv.gone() && Date.now() - startedAt < deadlineMs) await sleep(100);
  if (GUARD_ABORT.test(srv.out)) throw startupError(srv, "guard violation", startedAt);
  if (srv.spawnError) throw startupError(srv, "spawn error", startedAt);
  if (srv.gone()) throw startupError(srv, "child exited during startup", startedAt);
  if (!srv.out.includes(line)) throw startupError(srv, `no listening signal within ${deadlineMs} ms`, startedAt);
  return startedAt;
}

// 3. A guarded server.js child on 127.0.0.1:<port>. Before returning, exactly ONE
//    /api/health makes the child's guarded pool run its identity gate; the child's preload
//    must then print "identity verified <db>@<host>:3308".
async function startGuardedServer({ suite, port, env = {}, deadlineMs = 60000 }) {
  const childEnv = childEnvFor(suite, { ...env, PORT: String(port) });
  const srv = launch(childEnv, port);
  const startedAt = await waitListening(srv, deadlineMs);
  let health;
  try { const res = await fetch(`${srv.base}/api/health`); health = { status: res.status, body: await res.text() }; }
  catch (e) { health = { error: (e && e.cause && e.cause.code) || (e && e.message) || "unknown" }; }
  const marker = `identity verified ${process.env.NF_TEST_DB_NAME}@${process.env.NF_TEST_DB_SERVER_HOSTNAME}:${process.env.DB_PORT}`;
  for (let i = 0; i < 50 && !srv.out.includes(marker) && !GUARD_ABORT.test(srv.out) && !srv.gone(); i++) await sleep(100);
  if (GUARD_ABORT.test(srv.out)) { stopServer(srv); throw startupError(srv, "guard violation during identity check", startedAt); }
  if (!health || health.status !== 200 || !srv.out.includes(marker) || srv.gone()) {
    stopServer(srv);
    throw startupError(srv, "database identity not confirmed", startedAt, `\nhealth=${JSON.stringify(health)} expected="${marker}"`);
  }
  console.log(`child server :${port} ready after ${Date.now() - startedAt} ms; database identity verified`);
  return srv;
}

// 4. A server.js child with NO database (127.0.0.1:1, nothing listens there): the guard
//    preload is replaced by the no-db preload, which blocks .env/dotenv and refuses any
//    MySQL pool except 127.0.0.1:1. The isolation variables are removed so nothing in the
//    child can name the test database.
async function startNoDbServer({ suite, port, env = {}, deadlineMs = 60000 }) {
  const bad = Object.keys(env).filter(k => PROTECTED_KEYS.includes(k));
  if (bad.length) throw new Error(`${suite}: a no-database child may not override ${bad.join(", ")}`);
  const base = { ...process.env, ...env };
  for (const k of ["NF_TEST_MODE", "NF_TEST_DB_NAME", "NF_TEST_DB_SERVER_HOSTNAME", "DB_USER", "DB_PASSWORD"]) delete base[k];
  const others = requiredPreloads(base.NODE_OPTIONS).filter(p => !(path.isAbsolute(p) && samePath(path.resolve(p), GUARD_PRELOAD)));
  if (others.length) throw new Error(`${suite}: unexpected extra preloads in NODE_OPTIONS (${others.join(", ")})`);
  const childEnv = { ...base, NODE_OPTIONS: `--require="${NODB_PRELOAD.replace(/\\/g, "/")}"`, NF_NODB_MODE: "nodb",
    DB_HOST: "127.0.0.1", DB_PORT: "1", DB_NAME: "nf_nodb_unreachable", DB_SSL: "false", PORT: String(port) };
  const srv = launch(childEnv, port);
  const startedAt = await waitListening(srv, deadlineMs);
  console.log(`no-database child server :${port} ready after ${Date.now() - startedAt} ms`);
  return srv;
}

function stopServer(srv) {
  if (srv && srv.proc && !srv.gone()) { try { srv.proc.kill(); } catch (e) { /* already gone */ } }
}

module.exports = { requireIsolation, verifyParentIdentity, startGuardedServer, startNoDbServer, stopServer, SERVER_DIR, GUARD_PRELOAD, NODB_PRELOAD, PROTECTED_KEYS };
