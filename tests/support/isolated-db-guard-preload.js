// Isolated-database test guard — preload (ADMIN-5B). TEST-ONLY.
//
// Load with NODE_OPTIONS (built by buildNodeOptions in isolated-db-guard.js) so the test
// process AND every server.js it spawns ({ ...process.env } passes NODE_OPTIONS on) run
// this before any application code, dotenv or db.js:
//   NODE_OPTIONS=--require="<backend>/tests/support/isolated-db-guard-preload.js"
// Contract and coverage: see isolated-db-guard.js. Any failure — invalid configuration,
// a module that cannot be found, a later violation — exits the process with code 97
// before the caller's statement runs. Never prints credentials.
"use strict";
const fs = require("fs");
const path = require("path");
const net = require("net");
const dns = require("dns");
const Module = require("module");
const guard = require("./isolated-db-guard");

const tag = `[isolated-db-guard pid ${process.pid}]`;
const die = err => {
  try { process.stderr.write(`${tag} ABORT: ${(err && err.message) || err}\n`); } finally { process.exit(97); }
};

if (!globalThis.__NF_ISOLATED_DB_GUARD__) {
  try {
    const result = guard.validateTestConfig(process.env);
    if (!result.ok) throw new guard.GuardError(result.reason);
    const expected = result.config;
    const SERVER = path.resolve(__dirname, "..", "..");
    const stats = { dotenvStubbed: 0, envFileBlocked: 0, fetchAllowed: 0, fetchRefused: 0, mxRefused: 0, identity: "not verified" };

    guard.stubDotenv(require.cache, Module, require.resolve("dotenv", { paths: [SERVER] }), stats);
    guard.blockEnvFileAccess(fs, path, stats);
    guard.wrapPromiseApi(require(require.resolve("mysql2/promise", { paths: [SERVER] })), expected, {
      onViolation: die,
      onVerified: id => { stats.identity = id; process.stdout.write(`${tag} identity verified ${id}\n`); },
    });
    guard.wrapCallbackApi(require(require.resolve("mysql2", { paths: [SERVER] })), { onViolation: die });
    guard.enforceLoopbackListen(net, { onViolation: die });
    if (typeof globalThis.fetch === "function") guard.restrictFetch(globalThis, stats);
    guard.refuseMx(dns, stats);

    globalThis.__NF_ISOLATED_DB_GUARD__ = Object.freeze({ db: expected.db, pid: process.pid, stats });
    process.on("exit", () => {
      try { process.stdout.write(`${tag} exit: identity=${stats.identity} dotenvStubbed=${stats.dotenvStubbed} envFileBlocked=${stats.envFileBlocked} fetchAllowed=${stats.fetchAllowed} fetchRefused=${stats.fetchRefused} mxRefused=${stats.mxRefused}\n`); } catch (e) { /* ignore */ }
    });
  } catch (err) {
    die(err);
  }
}
