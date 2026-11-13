// Isolated-database test guard — library (ADMIN-5B). TEST-ONLY; never loaded by the app.
//
// Generalises the reviewed Phase 3B.9 scratchpad preload (scratch-guard.js) into reusable,
// side-effect-free functions. Nothing here runs on require: tests/support/
// isolated-db-guard-preload.js calls install() when a future, separately authorised
// database run loads it with NODE_OPTIONS=--require=<preload>. The self-tests
// (tests/isolated-db-guard-tests.js) exercise every function with fakes.
//
// CONTRACT — all of these must hold, or the guard refuses (fail closed):
//   NF_TEST_MODE                 exactly "isolated" (explicit opt-in; nothing else accepted)
//   NF_TEST_DB_NAME              the one scratch database the run may touch. Must match
//                                ^nf_test_[a-z0-9]+(_[a-z0-9]+)*$ (max 64 chars). The working
//                                database "neofragrances", system schemas and anything
//                                containing "prod" are refused. No existing database is
//                                pre-approved: the name rule is a format check, not proof
//                                the database is disposable — a future provisioning phase
//                                creates nf_test_* databases on purpose.
//   NF_TEST_DB_SERVER_HOSTNAME   the expected @@hostname of the local MariaDB server
//   DB_NAME                      must equal NF_TEST_DB_NAME (db.js builds its pool from DB_*)
//   DB_HOST                      exactly 127.0.0.1 (not "localhost", which may resolve to ::1)
//   DB_PORT                      exactly 3308 (the replacement MariaDB; 3306 is the frozen
//                                rollback server and is refused)
//   DB_SSL                       not "true" (local scratch only)
//
// INSTALLED PROTECTIONS (see install()):
//   * dotenv is replaced by a no-op in the module cache, and opening a file whose basename
//     is ".env" throws through: fs.readFileSync, openSync, existsSync (returns false),
//     readFile, open, createReadStream, fs.promises.readFile, fs.promises.open. Other fs
//     APIs (e.g. statSync, readdirSync) are NOT covered — this is a guard against dotenv
//     and ordinary reads, not a filesystem sandbox.
//   * mysql2/promise createPool / createConnection: the config is checked BEFORE the real
//     factory runs (database, 127.0.0.1, 3308, no SSL, no socketPath); createPoolCluster
//     is refused. Every pool query / execute / getConnection waits for a one-time identity
//     check — SELECT DATABASE(), @@hostname, @@port — and is rejected unless it matches.
//     A failure is sticky. The callback API (mysql2) createPool / createConnection /
//     createPoolCluster are refused outright.
//   * net.Server#listen: a port with no host gets 127.0.0.1; any other host, a pipe/path,
//     fd or handle is refused.
//   * fetch is limited to http://127.0.0.1:<port>/ and dns resolveMx is refused. Raw
//     http/https/net client sockets are NOT covered.
// Violations call onViolation(error); the preload's handler exits the process (code 97).
"use strict";

const NAME_RULE = /^nf_test_[a-z0-9]+(?:_[a-z0-9]+)*$/;
const NAME_MAX = 64;
const FORBIDDEN_NAMES = new Set(["neofragrances", "mysql", "information_schema", "performance_schema", "sys", "phpmyadmin", "test"]);
const HOSTNAME_RULE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;
const EXPECTED_HOST = "127.0.0.1";
const EXPECTED_PORT = 3308;
const PRELOAD_BASENAME = "isolated-db-guard-preload.js";

class GuardError extends Error {
  constructor(message) { super(message); this.name = "IsolatedDbGuardError"; this.code = "NF_ISOLATION_GUARD"; }
}

// ---- 1. configuration (pure; reads only the object it is given) ----
function validateDbName(name) {
  if (typeof name !== "string" || name === "") return "NF_TEST_DB_NAME is required";
  if (name.length > NAME_MAX) return `NF_TEST_DB_NAME is longer than ${NAME_MAX} characters`;
  if (FORBIDDEN_NAMES.has(name.toLowerCase())) return `NF_TEST_DB_NAME "${name}" is a protected database`;
  if (/prod/i.test(name)) return "NF_TEST_DB_NAME must not contain \"prod\"";
  if (!NAME_RULE.test(name)) return "NF_TEST_DB_NAME must match ^nf_test_[a-z0-9]+(_[a-z0-9]+)*$";
  return null;
}

function validateTestConfig(env) {
  const e = env && typeof env === "object" ? env : {};
  const fail = reason => ({ ok: false, reason });
  if (e.NF_TEST_MODE !== "isolated") return fail(`NF_TEST_MODE must be exactly "isolated" (got ${e.NF_TEST_MODE === undefined ? "nothing" : JSON.stringify(String(e.NF_TEST_MODE))})`);
  const nameError = validateDbName(e.NF_TEST_DB_NAME);
  if (nameError) return fail(nameError);
  if (e.DB_NAME === "neofragrances") return fail("DB_NAME is the working database");
  if (e.DB_NAME !== e.NF_TEST_DB_NAME) return fail("DB_NAME must equal NF_TEST_DB_NAME");
  if (e.DB_HOST !== EXPECTED_HOST) return fail(`DB_HOST must be exactly ${EXPECTED_HOST}`);
  if (String(e.DB_PORT) !== String(EXPECTED_PORT)) return fail(`DB_PORT must be exactly ${EXPECTED_PORT}`);
  if (e.DB_SSL === "true") return fail("DB_SSL must not be \"true\" for a local scratch database");
  if (typeof e.NF_TEST_DB_SERVER_HOSTNAME !== "string" || !HOSTNAME_RULE.test(e.NF_TEST_DB_SERVER_HOSTNAME)) {
    return fail("NF_TEST_DB_SERVER_HOSTNAME (the expected @@hostname) is required");
  }
  return { ok: true, config: { db: e.NF_TEST_DB_NAME, host: EXPECTED_HOST, port: EXPECTED_PORT, serverHostname: e.NF_TEST_DB_SERVER_HOSTNAME } };
}

// ---- 2. connection config and identity (pure) ----
function checkConnectionConfig(cfg, expected) {
  if (typeof cfg === "string" || (cfg && typeof cfg === "object" && cfg.uri)) throw new GuardError("connection URIs are not allowed; pass an explicit config object");
  const c = cfg && typeof cfg === "object" ? cfg : {};
  if (c.database === "neofragrances") throw new GuardError("connection config names the working database");
  if (c.database !== expected.db) throw new GuardError(`connection database must be ${expected.db}`);
  if (c.host !== expected.host) throw new GuardError(`connection host must be ${expected.host}`);
  if (String(c.port) !== String(expected.port)) throw new GuardError(`connection port must be ${expected.port}`);
  if (c.socketPath) throw new GuardError("socketPath/named-pipe connections are not allowed");
  if (c.ssl) throw new GuardError("SSL connections are not expected for the local scratch database");
}

function verifyIdentityRow(row, expected) {
  const r = row && typeof row === "object" ? row : {};
  if (r.db === "neofragrances") throw new GuardError("connected to the working database");
  if (r.db !== expected.db || r.host !== expected.serverHostname || Number(r.port) !== expected.port) {
    throw new GuardError(`identity mismatch: got ${r.db}@${r.host}:${r.port}, expected ${expected.db}@${expected.serverHostname}:${expected.port}`);
  }
  return `${r.db}@${r.host}:${r.port}`;
}
const IDENTITY_SQL = "SELECT DATABASE() AS db, @@hostname AS host, @@port AS port";

// Wraps a pool so query/execute/getConnection wait for a one-time identity check run on
// the RAW pool. Until it succeeds nothing else runs; a failure is sticky.
function gatePool(pool, expected, { onViolation, onVerified } = {}) {
  const rawQuery = pool.query.bind(pool);
  let verified = null;
  const gate = () => {
    if (!verified) {
      verified = (async () => {
        let rows;
        try { [rows] = await rawQuery(IDENTITY_SQL); }
        catch (e) { throw new GuardError(`identity query failed (${(e && e.code) || "error"})`); }
        const id = verifyIdentityRow(rows && rows[0], expected);
        if (onVerified) onVerified(id);
        return id;
      })().catch(err => { if (onViolation) onViolation(err); throw err; });
    }
    return verified;
  };
  for (const name of ["query", "execute", "getConnection"]) {
    if (typeof pool[name] !== "function") continue;
    const real = pool[name].bind(pool);
    pool[name] = async (...args) => { await gate(); return real(...args); };
  }
  pool.__nfIdentityGate = gate;
  return pool;
}

// ---- 3. mysql2 interception (mutates the module objects it is given) ----
function wrapPromiseApi(mysqlPromise, expected, { onViolation, onVerified } = {}) {
  const violate = err => { if (onViolation) onViolation(err); throw err; };
  const realCreatePool = mysqlPromise.createPool;
  const realCreateConnection = mysqlPromise.createConnection;
  mysqlPromise.createPool = function (cfg, ...rest) {
    try { checkConnectionConfig(cfg, expected); } catch (e) { return violate(e); }
    return gatePool(realCreatePool.call(this, cfg, ...rest), expected, { onViolation, onVerified });
  };
  mysqlPromise.createConnection = async function (cfg, ...rest) {
    try { checkConnectionConfig(cfg, expected); } catch (e) { return violate(e); }
    const conn = await realCreateConnection.call(this, cfg, ...rest);
    let rows;
    try { [rows] = await conn.query(IDENTITY_SQL); } catch (e) { return violate(new GuardError(`identity query failed (${(e && e.code) || "error"})`)); }
    try { const id = verifyIdentityRow(rows && rows[0], expected); if (onVerified) onVerified(id); } catch (e) { return violate(e); }
    return conn;
  };
  mysqlPromise.createPoolCluster = () => violate(new GuardError("mysql2/promise createPoolCluster is not allowed under the isolation guard"));
  return mysqlPromise;
}

function wrapCallbackApi(mysqlCallback, { onViolation } = {}) {
  for (const name of ["createPool", "createConnection", "createPoolCluster"]) {
    mysqlCallback[name] = () => { const err = new GuardError(`mysql2 callback API ${name} is not allowed under the isolation guard`); if (onViolation) onViolation(err); throw err; };
  }
  return mysqlCallback;
}

// ---- 4. .env and dotenv ----
function isEnvFile(p, pathModule) {
  if (typeof p !== "string" && !(p instanceof URL) && !Buffer.isBuffer(p)) return false;
  return pathModule.basename(String(p instanceof URL ? p.pathname : p)) === ".env";
}

function blockEnvFileAccess(fsModule, pathModule, stats = { envFileBlocked: 0 }) {
  const blocked = () => { stats.envFileBlocked++; return new GuardError(".env access blocked by the isolation guard"); };
  for (const name of ["readFileSync", "openSync", "existsSync", "createReadStream"]) {
    const real = fsModule[name];
    if (typeof real !== "function") continue;
    fsModule[name] = function (p, ...rest) {
      if (isEnvFile(p, pathModule)) { const err = blocked(); if (name === "existsSync") return false; throw err; }
      return real.call(this, p, ...rest);
    };
  }
  for (const name of ["readFile", "open"]) {
    const real = fsModule[name];
    if (typeof real !== "function") continue;
    fsModule[name] = function (p, ...rest) {
      if (isEnvFile(p, pathModule)) { const err = blocked(); const cb = rest[rest.length - 1]; if (typeof cb === "function") return process.nextTick(cb, err); throw err; }
      return real.call(this, p, ...rest);
    };
  }
  if (fsModule.promises) {
    for (const name of ["readFile", "open"]) {
      const real = fsModule.promises[name];
      if (typeof real !== "function") continue;
      fsModule.promises[name] = function (p, ...rest) { if (isEnvFile(p, pathModule)) return Promise.reject(blocked()); return real.call(this, p, ...rest); };
    }
  }
  return stats;
}

function stubDotenv(moduleCache, ModuleCtor, resolvedPath, stats = { dotenvStubbed: 0 }) {
  const m = new ModuleCtor(resolvedPath);
  m.filename = resolvedPath; m.loaded = true;
  m.exports = { config: () => { stats.dotenvStubbed++; return { parsed: {} }; }, configDotenv: () => { stats.dotenvStubbed++; return { parsed: {} }; }, parse: () => ({}) };
  moduleCache[resolvedPath] = m;
  return stats;
}

// ---- 5. listeners, fetch, DNS ----
function enforceLoopbackListen(netModule, { onViolation } = {}) {
  const proto = netModule.Server.prototype;
  const realListen = proto.listen;
  const violate = msg => { const err = new GuardError(msg); if (onViolation) onViolation(err); throw err; };
  const isPort = v => typeof v === "number" || (typeof v === "string" && /^\d+$/.test(v));
  proto.listen = function (...args) {
    const a0 = args[0];
    if (isPort(a0)) {
      if (typeof args[1] === "string") { if (args[1] !== EXPECTED_HOST) return violate(`listen on host ${args[1]} refused (loopback ${EXPECTED_HOST} only)`); }
      else args.splice(1, 0, EXPECTED_HOST);
    } else if (a0 && typeof a0 === "object" && !Array.isArray(a0) && isPort(a0.port) && !a0.path && a0.fd === undefined && !a0.handle) {
      if (a0.host !== undefined && a0.host !== EXPECTED_HOST) return violate(`listen on host ${a0.host} refused (loopback ${EXPECTED_HOST} only)`);
      args[0] = { ...a0, host: EXPECTED_HOST };
    } else {
      return violate("listen form not allowed under the isolation guard (port-based loopback only)");
    }
    return realListen.apply(this, args);
  };
}

function restrictFetch(globalObj, stats = { fetchAllowed: 0, fetchRefused: 0 }) {
  const realFetch = globalObj.fetch;
  globalObj.fetch = async (url, init) => {
    const u = String(url && url.url ? url.url : url);
    if (/^http:\/\/127\.0\.0\.1:\d+\//.test(u)) { stats.fetchAllowed++; return realFetch(url, init); }
    stats.fetchRefused++;
    throw new GuardError("outbound fetch refused by the isolation guard (loopback only)");
  };
  return stats;
}

function refuseMx(dnsModule, stats = { mxRefused: 0 }) {
  const refusal = () => { stats.mxRefused++; return Object.assign(new GuardError("MX lookup refused by the isolation guard"), { code: "ENOTFOUND" }); };
  if (dnsModule.promises && dnsModule.promises.Resolver) {
    dnsModule.promises.Resolver.prototype.resolveMx = async () => { throw refusal(); };
    dnsModule.promises.resolveMx = async () => { throw refusal(); };
  }
  dnsModule.resolveMx = (host, cb) => process.nextTick(cb, refusal());
  return stats;
}

// ---- 6. child processes ----
// Adds `--require="<preload>"` to NODE_OPTIONS, keeping every existing option. Forward
// slashes avoid NODE_OPTIONS treating backslashes inside quotes as escapes; quotes allow
// spaces in the path. A different preload with the same basename is a conflict.
function buildNodeOptions(existing, preloadPath) {
  if (typeof preloadPath !== "string" || !preloadPath) throw new GuardError("preload path is required");
  const target = preloadPath.replace(/\\/g, "/");
  const current = typeof existing === "string" ? existing.trim() : "";
  const requires = [...current.matchAll(/(?:--require|-r)(?:=|\s+)(?:"([^"]+)"|(\S+))/g)].map(m => (m[1] || m[2]).replace(/\\/g, "/"));
  const same = requires.filter(r => r.toLowerCase() === target.toLowerCase());
  const conflicting = requires.filter(r => r.toLowerCase() !== target.toLowerCase() && r.split("/").pop() === PRELOAD_BASENAME);
  if (conflicting.length) throw new GuardError(`NODE_OPTIONS already preloads a different ${PRELOAD_BASENAME}: ${conflicting[0]}`);
  if (same.length) return current;
  return [current, `--require="${target}"`].filter(Boolean).join(" ");
}

module.exports = {
  GuardError, NAME_RULE, EXPECTED_HOST, EXPECTED_PORT, IDENTITY_SQL, PRELOAD_BASENAME,
  validateDbName, validateTestConfig, checkConnectionConfig, verifyIdentityRow, gatePool,
  wrapPromiseApi, wrapCallbackApi, blockEnvFileAccess, stubDotenv, isEnvFile,
  enforceLoopbackListen, restrictFetch, refuseMx, buildNodeOptions,
};
