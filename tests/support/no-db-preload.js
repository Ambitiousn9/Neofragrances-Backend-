// No-database preload (T04). TEST-ONLY. For server.js children that must run WITHOUT a
// database — the fail-open / 503 cases in account-controls, maintenance and platform tests.
// Loaded instead of isolated-db-guard-preload.js by tests/support/isolated-suite.js
// (startNoDbServer). Requirements, else the process exits with code 97 before app code:
//   NF_NODB_MODE  exactly "nodb"
//   DB_HOST       exactly 127.0.0.1;  DB_PORT exactly 1 (nothing listens there)
// Installed protections (reusing isolated-db-guard.js): dotenv is a no-op and .env cannot be
// opened; mysql2/promise pools and connections are refused unless they target
// 127.0.0.1:1 (the callback API and pool clusters are refused); listen is loopback-only;
// fetch only reaches http://127.0.0.1:<port>/; MX lookups are refused.
"use strict";
const fs = require("fs");
const path = require("path");
const net = require("net");
const dns = require("dns");
const Module = require("module");
const guard = require("./isolated-db-guard");

const tag = `[no-db-guard pid ${process.pid}]`;
const die = err => {
  try { process.stderr.write(`${tag} ABORT: ${(err && err.message) || err}\n`); } finally { process.exit(97); }
};

if (!globalThis.__NF_NODB_GUARD__) {
  try {
    const e = process.env;
    if (e.NF_NODB_MODE !== "nodb") throw new guard.GuardError("NF_NODB_MODE must be \"nodb\"");
    if (e.DB_HOST !== "127.0.0.1" || String(e.DB_PORT) !== "1") throw new guard.GuardError("a no-database child needs DB_HOST=127.0.0.1 and DB_PORT=1");
    if (globalThis.__NF_ISOLATED_DB_GUARD__) throw new guard.GuardError("the isolated-database guard must not be loaded together with the no-database guard");
    const SERVER = path.resolve(__dirname, "..", "..");
    const stats = { dotenvStubbed: 0, envFileBlocked: 0, fetchAllowed: 0, fetchRefused: 0, mxRefused: 0, poolsRefused: 0 };

    guard.stubDotenv(require.cache, Module, require.resolve("dotenv", { paths: [SERVER] }), stats);
    guard.blockEnvFileAccess(fs, path, stats);
    const mysqlPromise = require(require.resolve("mysql2/promise", { paths: [SERVER] }));
    const onlyUnreachable = cfg => {
      const c = cfg && typeof cfg === "object" && !cfg.uri ? cfg : null;
      if (!c || c.host !== "127.0.0.1" || String(c.port) !== "1" || c.socketPath) { stats.poolsRefused++; die(new guard.GuardError("no-database child: only 127.0.0.1:1 may be configured")); }
    };
    const realCreatePool = mysqlPromise.createPool, realCreateConnection = mysqlPromise.createConnection;
    mysqlPromise.createPool = function (cfg, ...rest) { onlyUnreachable(cfg); return realCreatePool.call(this, cfg, ...rest); };
    mysqlPromise.createConnection = function (cfg, ...rest) { onlyUnreachable(cfg); return realCreateConnection.call(this, cfg, ...rest); };
    mysqlPromise.createPoolCluster = () => die(new guard.GuardError("no-database child: createPoolCluster is not allowed"));
    guard.wrapCallbackApi(require(require.resolve("mysql2", { paths: [SERVER] })), { onViolation: die });
    guard.enforceLoopbackListen(net, { onViolation: die });
    if (typeof globalThis.fetch === "function") guard.restrictFetch(globalThis, stats);
    guard.refuseMx(dns, stats);

    globalThis.__NF_NODB_GUARD__ = Object.freeze({ pid: process.pid, stats });
    process.on("exit", () => {
      try { process.stdout.write(`${tag} exit: dotenvStubbed=${stats.dotenvStubbed} envFileBlocked=${stats.envFileBlocked} poolsRefused=${stats.poolsRefused} fetchRefused=${stats.fetchRefused} mxRefused=${stats.mxRefused}\n`); } catch (e) { /* ignore */ }
    });
  } catch (err) {
    die(err);
  }
}
