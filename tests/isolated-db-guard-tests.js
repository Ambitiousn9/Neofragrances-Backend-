// Self-tests for the isolated-database test guard (ADMIN-5B):
//   tests/support/isolated-db-guard.js (library) and isolated-db-guard-preload.js.
//
// DATABASE-FREE: no real pool or connection is ever created. In-process checks use fake
// mysql2 / fs / net / dns / fetch objects. Child-process checks run only `node -e`
// snippets with a minimal environment (no DB_USER/DB_PASSWORD, cwd = the OS temp dir):
// no server, no socket, no network. No .env file is read — the blocked paths below are
// never opened (the guard throws before fs is touched). Nothing is written to disk.
//
// Run: node tests/isolated-db-guard-tests.js
const path = require("path");
const os = require("os");
const { execFileSync, spawnSync } = require("child_process");
const G = require("./support/isolated-db-guard");

const PRELOAD = path.join(__dirname, "support", "isolated-db-guard-preload.js");
let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail === undefined ? "" : `  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`}`); }
}
const threw = fn => { try { fn(); return null; } catch (e) { return e; } };
const isGuardErr = e => !!e && e.code === "NF_ISOLATION_GUARD";

const GOOD = { NF_TEST_MODE: "isolated", NF_TEST_DB_NAME: "nf_test_selftest", NF_TEST_DB_SERVER_HOSTNAME: "selftest-host", DB_NAME: "nf_test_selftest", DB_HOST: "127.0.0.1", DB_PORT: "3308" };
const EXPECTED = { db: "nf_test_selftest", host: "127.0.0.1", port: 3308, serverHostname: "selftest-host" };
const GOOD_CFG = { host: "127.0.0.1", port: "3308", database: "nf_test_selftest", user: "x" };

(async () => {
  try {
    // ---- 1–8, 17: configuration ----
    const v = env => G.validateTestConfig(env);
    check("G1 missing opt-in (no NF_TEST_MODE) is rejected", v({ ...GOOD, NF_TEST_MODE: undefined }).ok === false);
    const badModes = ["Isolated", "isolated ", "true", "1", "scratch", ""].filter(m => v({ ...GOOD, NF_TEST_MODE: m }).ok);
    check("G2 invalid opt-in values are rejected (case, whitespace, other words, empty)", badModes.length === 0, badModes);
    check("G3 missing NF_TEST_DB_NAME is rejected", v({ ...GOOD, NF_TEST_DB_NAME: undefined }).ok === false && v({ ...GOOD, NF_TEST_DB_NAME: "" }).ok === false);
    check("G4 the working database 'neofragrances' is rejected (as NF_TEST_DB_NAME and as DB_NAME)",
      v({ ...GOOD, NF_TEST_DB_NAME: "neofragrances", DB_NAME: "neofragrances" }).ok === false && v({ ...GOOD, DB_NAME: "neofragrances" }).ok === false);
    const unapproved = ["neofragrances_m009_scratch_20261017", "neofragrances_m009_scratch_nofk_20261017", "scratch", "nf_test_", "nf_test_Prod_copy", "nf_test_prodlike",
      "NF_TEST_X", "nf_test_a;drop", "nf_test_a b", "nf_test_" + "a".repeat(60), "mysql", "information_schema", "test", "nf_test__x"].filter(n => !G.validateDbName(n));
    check("G5 unapproved / malformed names are rejected — including both existing scratch databases, '*prod*', bad identifiers and overlong names", unapproved.length === 0, unapproved);
    const nameOnly = [{ ...GOOD, NF_TEST_MODE: undefined }, { ...GOOD, DB_HOST: "localhost" }, { ...GOOD, DB_NAME: "nf_test_other" }, { ...GOOD, NF_TEST_DB_SERVER_HOSTNAME: undefined }].filter(e => v(e).ok);
    check("G6 an approved-looking name alone does not pass: opt-in, DB_NAME match, host and server hostname are all still required", nameOnly.length === 0);
    check("G7 non-loopback DB_HOST is rejected (localhost, ::1, 0.0.0.0, a LAN or remote host)",
      ["localhost", "::1", "0.0.0.0", "192.168.1.10", "gateway01.tidbcloud.com", ""].every(h => v({ ...GOOD, DB_HOST: h }).ok === false));
    check("G8 unexpected DB_PORT is rejected, including 3306 (the frozen rollback server)", ["3306", "3307", "4000", "", "abc"].every(p => v({ ...GOOD, DB_PORT: p }).ok === false) && v({ ...GOOD, DB_SSL: "true" }).ok === false);
    const ok = v(GOOD);
    check("G0 the full valid configuration is accepted, and nothing else is added to it", ok.ok === true && JSON.stringify(ok.config) === JSON.stringify(EXPECTED), ok);

    // ---- 9: alternate connection paths ----
    const cc = cfg => G.checkConnectionConfig(cfg, EXPECTED);
    const alt = [
      ["socketPath", { ...GOOD_CFG, socketPath: "/tmp/mysql.sock" }], ["named pipe", { ...GOOD_CFG, socketPath: "\\\\.\\pipe\\MySQL" }],
      ["ssl", { ...GOOD_CFG, ssl: { rejectUnauthorized: true } }], ["uri string", "mysql://u:p@127.0.0.1:3308/nf_test_selftest"],
      ["uri property", { ...GOOD_CFG, uri: "mysql://127.0.0.1/nf_test_selftest" }], ["localhost", { ...GOOD_CFG, host: "localhost" }],
      ["port", { ...GOOD_CFG, port: 3307 }], ["rollback server port", { ...GOOD_CFG, port: 3306 }], ["other db", { ...GOOD_CFG, database: "nf_test_other" }], ["working db", { ...GOOD_CFG, database: "neofragrances" }], ["no config", undefined],
    ].filter(([, cfg]) => !isGuardErr(threw(() => cc(cfg)))).map(([n]) => n);
    check("G9 socket, named-pipe, SSL, URI and mismatched host/port/database connection configs are refused", alt.length === 0, alt);
    check("G9b the matching explicit config passes the config check", threw(() => cc(GOOD_CFG)) === null);

    // ---- 10, 11: interception with fake mysql2 modules ----
    const violations = [];
    const realCalls = { pool: 0, conn: 0, cluster: 0, cbPool: 0, cbConn: 0, cbCluster: 0 };
    const sqlSeen = [];
    let identityRow = { db: "nf_test_selftest", host: "selftest-host", port: 3308 };
    const fakePool = () => ({
      async query(sql) { sqlSeen.push(sql); return sql === G.IDENTITY_SQL ? [[identityRow]] : [[{ ok: 1 }]]; },
      async execute(sql) { sqlSeen.push(`EXEC ${sql}`); return [[{ ok: 1 }]]; },
      async getConnection() { sqlSeen.push("GETCONN"); return { release() {} }; },
    });
    const fakePromise = {
      createPool() { realCalls.pool++; return fakePool(); },
      async createConnection() { realCalls.conn++; return { async query(sql) { sqlSeen.push(`CONN ${sql}`); return [[identityRow]]; } }; },
      createPoolCluster() { realCalls.cluster++; },
    };
    G.wrapPromiseApi(fakePromise, EXPECTED, { onViolation: e => violations.push(e.message) });
    const bad = [{ ...GOOD_CFG, database: "neofragrances" }, { ...GOOD_CFG, host: "10.0.0.5" }, { ...GOOD_CFG, socketPath: "/x" }];
    const refusedPools = bad.filter(cfg => isGuardErr(threw(() => fakePromise.createPool(cfg)))).length;
    let refusedConn = 0; for (const cfg of bad) { try { await fakePromise.createConnection(cfg); } catch (e) { if (isGuardErr(e)) refusedConn++; } }
    check("G11 invalid configs never reach the real factory: createPool and createConnection refuse before any connection object exists",
      refusedPools === 3 && refusedConn === 3 && realCalls.pool === 0 && realCalls.conn === 0 && violations.length === 6, { realCalls, violations: violations.length });
    const fakeCallback = { createPool() { realCalls.cbPool++; }, createConnection() { realCalls.cbConn++; }, createPoolCluster() { realCalls.cbCluster++; } };
    G.wrapCallbackApi(fakeCallback, { onViolation: e => violations.push(e.message) });
    const bypass = [() => fakePromise.createPoolCluster({}), () => fakeCallback.createPool(GOOD_CFG), () => fakeCallback.createConnection(GOOD_CFG), () => fakeCallback.createPoolCluster()]
      .filter(fn => !isGuardErr(threw(fn))).length;
    check("G10 unsupported APIs cannot bypass the guard: promise createPoolCluster and the callback createPool/createConnection/createPoolCluster are refused, originals never run",
      bypass === 0 && realCalls.cluster === 0 && realCalls.cbPool === 0 && realCalls.cbConn === 0 && realCalls.cbCluster === 0);

    // ---- 12, 13: identity gate with fake pools ----
    identityRow = { db: "nf_test_selftest", host: "selftest-host", port: 3308 };
    sqlSeen.length = 0;
    const goodPool = fakePromise.createPool(GOOD_CFG);
    const r1 = await goodPool.query("INSERT INTO fixtures VALUES (1)");
    await goodPool.execute("UPDATE fixtures SET x = 1"); await goodPool.getConnection();
    check("G13 verified identity: the identity query runs first (once), then only the caller's own fake operations run, in order",
      realCalls.pool === 1 && sqlSeen[0] === G.IDENTITY_SQL && sqlSeen.filter(s => s === G.IDENTITY_SQL).length === 1
      && JSON.stringify(sqlSeen.slice(1)) === JSON.stringify(["INSERT INTO fixtures VALUES (1)", "EXEC UPDATE fixtures SET x = 1", "GETCONN"]) && r1[0][0].ok === 1, sqlSeen);
    for (const [label, row] of [["wrong database", { db: "neofragrances", host: "selftest-host", port: 3308 }], ["wrong server hostname", { db: "nf_test_selftest", host: "other-host", port: 3308 }], ["wrong port", { db: "nf_test_selftest", host: "selftest-host", port: 3307 }], ["rollback server port", { db: "nf_test_selftest", host: "selftest-host", port: 3306 }]]) {
      identityRow = row; sqlSeen.length = 0; const vBefore = violations.length;
      const p = fakePromise.createPool(GOOD_CFG);
      const outcomes = [];
      for (const op of [() => p.query("DELETE FROM fixtures"), () => p.execute("DROP TRIGGER t"), () => p.getConnection()]) { try { await op(); outcomes.push("ran"); } catch (e) { outcomes.push(isGuardErr(e) ? "refused" : "other"); } }
      check(`G12 identity ${label}: every query/execute/getConnection is refused, the caller's SQL never reaches the pool, the failure is sticky (one identity attempt)`,
        outcomes.every(o => o === "refused") && JSON.stringify(sqlSeen) === JSON.stringify([G.IDENTITY_SQL]) && violations.length === vBefore + 1, { outcomes, sqlSeen });
    }
    sqlSeen.length = 0;
    const errPool = G.gatePool({ async query() { throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); } }, EXPECTED, {});
    let errOutcome; try { await errPool.query("SELECT 1"); errOutcome = "ran"; } catch (e) { errOutcome = isGuardErr(e) && /identity query failed \(ECONNREFUSED\)/.test(e.message) ? "refused" : "other"; }
    check("G12b an identity query that errors denies the operation (fail closed), reporting only the error code", errOutcome === "refused");
    identityRow = { db: "nf_test_other", host: "selftest-host", port: 3308 };
    let connOutcome; try { await fakePromise.createConnection(GOOD_CFG); connOutcome = "ran"; } catch (e) { connOutcome = isGuardErr(e) ? "refused" : "other"; }
    check("G12c createConnection verifies identity before returning the connection, and refuses a mismatch", connOutcome === "refused" && realCalls.conn === 1);

    // ---- 14: .env blocking (fake fs; the path is never opened) ----
    const fsCalls = [];
    const fakeFs = {
      readFileSync: p => { fsCalls.push(["readFileSync", p]); return "content"; }, openSync: p => { fsCalls.push(["openSync", p]); return 3; },
      existsSync: p => { fsCalls.push(["existsSync", p]); return true; }, createReadStream: p => { fsCalls.push(["createReadStream", p]); return {}; },
      readFile: (p, cb) => { fsCalls.push(["readFile", p]); cb(null, "content"); }, open: (p, cb) => { fsCalls.push(["open", p]); cb(null, 3); },
      promises: { readFile: async p => { fsCalls.push(["p.readFile", p]); return "content"; }, open: async p => { fsCalls.push(["p.open", p]); return {}; } },
    };
    const envStats = G.blockEnvFileAccess(fakeFs, path);
    const envPaths = [".env", path.join(os.tmpdir(), "nf-guard-selftest", ".env"), "C:\\anything\\.env", new URL("file:///tmp/.env")];
    const results = [];
    for (const p of envPaths) {
      results.push(isGuardErr(threw(() => fakeFs.readFileSync(p))), isGuardErr(threw(() => fakeFs.openSync(p))), fakeFs.existsSync(p) === false, isGuardErr(threw(() => fakeFs.createReadStream(p))));
      results.push(await new Promise(r => fakeFs.readFile(p, e => r(isGuardErr(e)))), await new Promise(r => fakeFs.open(p, e => r(isGuardErr(e)))));
      results.push(await fakeFs.promises.readFile(p).then(() => false, isGuardErr), await fakeFs.promises.open(p).then(() => false, isGuardErr));
    }
    check("G14 .env (relative, absolute, Windows-style, file: URL) is refused by all 8 covered fs APIs before the underlying function runs",
      results.every(Boolean) && fsCalls.length === 0 && envStats.envFileBlocked === envPaths.length * 8, { blocked: results.filter(Boolean).length, fsCalls });
    const allowed = [fakeFs.readFileSync("package.json"), fakeFs.existsSync(".env.example"), fakeFs.readFileSync("x/.envrc")];
    check("G14b other files (package.json, .env.example, .envrc) pass straight through", allowed[0] === "content" && allowed[1] === true && allowed[2] === "content" && fsCalls.length === 3);
    const cache = {}; class FakeModule { constructor(id) { this.id = id; } }
    const dstats = G.stubDotenv(cache, FakeModule, "/x/node_modules/dotenv/lib/main.js");
    const parsed = cache["/x/node_modules/dotenv/lib/main.js"].exports.config({ path: ".env" });
    check("G14c dotenv is replaced in the module cache by a no-op that loads nothing", JSON.stringify(parsed) === JSON.stringify({ parsed: {} }) && dstats.dotenvStubbed === 1);

    // ---- 16: listener enforcement (fake net; nothing is bound) ----
    class FakeServer { listen(...a) { this.args = a; return this; } }
    const lv = [];
    G.enforceLoopbackListen({ Server: FakeServer }, { onViolation: e => lv.push(e.message) });
    const s1 = new FakeServer().listen(5055, () => {}); const s2 = new FakeServer().listen({ port: 5099 });
    const refusedListens = [() => new FakeServer().listen(5055, "0.0.0.0"), () => new FakeServer().listen(5055, "::"), () => new FakeServer().listen({ port: 1, host: "192.168.1.2" }),
      () => new FakeServer().listen("\\\\.\\pipe\\x"), () => new FakeServer().listen({ fd: 3 }), () => new FakeServer().listen({ path: "/tmp/s" })].filter(fn => isGuardErr(threw(fn))).length;
    check("G16 listeners: a bare port is pinned to 127.0.0.1; 0.0.0.0, ::, LAN hosts, pipes, fds and paths are refused (no socket bound)",
      s1.args[1] === "127.0.0.1" && s2.args[0].host === "127.0.0.1" && refusedListens === 6 && lv.length === 6, { s1: s1.args.slice(0, 2), s2: s2.args[0] });
    const fetched = []; const fakeGlobal = { fetch: async u => { fetched.push(u); return { ok: true }; } };
    const fstats = G.restrictFetch(fakeGlobal);
    await fakeGlobal.fetch("http://127.0.0.1:5099/transaction/verify/x");
    const extRefused = await Promise.all(["https://api.paystack.co/x", "http://localhost:5000/", "http://[::1]:5000/", "https://example.com/"].map(u => fakeGlobal.fetch(u).then(() => false, isGuardErr)));
    const fakeDns = { promises: { Resolver: class { async resolveMx() { return [{ exchange: "mx" }]; } } } };
    const mstats = G.refuseMx(fakeDns);
    // The MX refusal carries code ESERVFAIL (a temporary DNS failure, T04), so server.js takes
    // its "lookup could not be completed: allow and warn" path; it is identified by the
    // guard's error name.
    const mxRefused = await new fakeDns.promises.Resolver().resolveMx("example.com").then(() => false, e => e.name === "IsolatedDbGuardError" && e.code === "ESERVFAIL");
    check("G16b fetch is limited to http://127.0.0.1:<port>/ and MX lookups are refused (fakes; scope: fetch + dns.resolveMx only)",
      fetched.length === 1 && extRefused.every(Boolean) && fstats.fetchRefused === 4 && mxRefused && mstats.mxRefused === 1);

    // ---- 15: NODE_OPTIONS ----
    const spaced = "C:\\Users\\A B\\repo\\tests\\support\\isolated-db-guard-preload.js";
    const b1 = G.buildNodeOptions("--max-old-space-size=4096 --enable-source-maps", spaced);
    const b2 = G.buildNodeOptions(b1, spaced);
    const conflict = threw(() => G.buildNodeOptions('--require="D:/elsewhere/isolated-db-guard-preload.js"', spaced));
    check("G15 NODE_OPTIONS keeps existing options, adds one quoted forward-slash --require, is idempotent, and refuses a conflicting copy of the preload",
      b1 === '--max-old-space-size=4096 --enable-source-maps --require="C:/Users/A B/repo/tests/support/isolated-db-guard-preload.js"' && b2 === b1 && isGuardErr(conflict) && G.buildNodeOptions("", spaced).startsWith("--require="), { b1 });

    // ---- 15, 17: real child processes (node -e only; no server, socket or network) ----
    const baseEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir() };
    const nodeOptions = G.buildNodeOptions("", PRELOAD);
    const childCode = `
      const g = globalThis.__NF_ISOLATED_DB_GUARD__;
      let envBlocked = false; try { require("fs").readFileSync(".env"); } catch (e) { envBlocked = /isolation guard/.test(e.message); }
      const { spawnSync } = require("child_process");
      const gc = spawnSync(process.execPath, ["-e", "console.log(JSON.stringify({ g: !!globalThis.__NF_ISOLATED_DB_GUARD__, db: globalThis.__NF_ISOLATED_DB_GUARD__ && globalThis.__NF_ISOLATED_DB_GUARD__.db }))"], { env: { ...process.env }, encoding: "utf8" });
      process.stdout.write("RESULT " + JSON.stringify({ installed: !!g, db: g && g.db, envBlocked, grandchild: gc.stdout.split("\\n").find(l => l.startsWith("{")) || null, opts: process.env.NODE_OPTIONS }) + "\\n");`;
    const child = spawnSync(process.execPath, ["-e", childCode], { env: { ...baseEnv, ...GOOD, NODE_OPTIONS: nodeOptions }, cwd: os.tmpdir(), encoding: "utf8", timeout: 30000 });
    const line = (child.stdout || "").split("\n").find(l => l.startsWith("RESULT "));
    const safeParse = s => { try { return JSON.parse(s); } catch (e) { return {}; } };
    const res = line ? safeParse(line.slice(7)) : {};
    const grand = res.grandchild ? safeParse(res.grandchild) : {};
    check("G15b child process: the preload installs from NODE_OPTIONS (path with spaces), .env is blocked, and a grandchild spawned with { ...process.env } inherits the guard",
      child.status === 0 && res.installed === true && res.db === "nf_test_selftest" && res.envBlocked === true && grand.g === true && grand.db === "nf_test_selftest" && res.opts === nodeOptions,
      { status: child.status, res, stderr: (child.stderr || "").slice(0, 200) });
    const failing = [
      ["no opt-in", { ...GOOD, NF_TEST_MODE: undefined }], ["working database", { ...GOOD, NF_TEST_DB_NAME: "neofragrances", DB_NAME: "neofragrances" }],
      ["existing scratch name", { ...GOOD, NF_TEST_DB_NAME: "neofragrances_m009_scratch_20261017", DB_NAME: "neofragrances_m009_scratch_20261017" }], ["remote host", { ...GOOD, DB_HOST: "10.1.2.3" }],
    ].map(([label, env]) => {
      const clean = Object.fromEntries(Object.entries({ ...baseEnv, ...env, NODE_OPTIONS: nodeOptions }).filter(([, val]) => val !== undefined));
      const r = spawnSync(process.execPath, ["-e", "process.stdout.write('USER CODE RAN')"], { env: clean, cwd: os.tmpdir(), encoding: "utf8", timeout: 30000 });
      return { label, status: r.status, ran: /USER CODE RAN/.test(r.stdout || ""), abort: /\[isolated-db-guard pid \d+\] ABORT:/.test(r.stderr || "") };
    });
    check("G17 invalid configuration in a child process exits 97 before any user code runs (no fall-through to normal settings)",
      failing.every(f => f.status === 97 && !f.ran && f.abort), failing);
    const violateChild = spawnSync(process.execPath, ["-e", `
      const p = require(require.resolve("mysql2/promise", { paths: [${JSON.stringify(path.join(__dirname, ".."))}] }));
      p.createPool({ host: "127.0.0.1", port: 3308, database: "neofragrances", user: "x" });
      process.stdout.write("USER CODE CONTINUED");`], { env: { ...baseEnv, ...GOOD, NODE_OPTIONS: nodeOptions }, cwd: os.tmpdir(), encoding: "utf8", timeout: 30000 });
    check("G17b in a child, createPool for the working database exits 97 at the call — the pool is never created and the next statement never runs",
      violateChild.status === 97 && !/USER CODE CONTINUED/.test(violateChild.stdout || "") && /working database/.test(violateChild.stderr || ""), { status: violateChild.status });
  } catch (err) {
    failed++;
    console.log("FAIL suite crashed:", err && (err.stack || err.message) || err);
  }
  console.log(`\n${passed}/${passed + failed} passed`);
  process.exit(failed ? 1 : 0);
})();
