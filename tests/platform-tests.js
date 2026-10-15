// Platform tests: CORS allowlist and GET /api/health.
// Spawns the real server.js three times on private ports — normal, unreachable
// database, and NODE_ENV=production — and makes plain HTTP calls. No browser, no
// fixtures, no database writes: nothing here can change catalog or order data.
const path = require("path");
const { spawn } = require("child_process");
// This file lives in <repo>/tests, so default to the repo root above it: the suite then
// runs as `node tests/<file>` with nothing set. An explicit SERVER_DIR still wins.
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
require(path.join(process.cwd(), "node_modules/dotenv")).config({ quiet: true });

if (!["localhost", "127.0.0.1"].includes(process.env.DB_HOST) || process.env.DB_NAME !== "neofragrances") {
  console.error("Refusing to run: not the local database.");
  process.exit(1);
}

const OK_PORT = 5063;        // healthy instance
const DEAD_DB_PORT = 5064;   // same code, unreachable database
const PROD_PORT = 5065;      // NODE_ENV=production, to prove dev origins are dropped

const DEV_ORIGIN = "http://127.0.0.1:5500";
const ENV_ORIGIN = "http://nf-frontend.test";      // supplied via FRONTEND_URL
const LIST_ORIGIN = "https://nf-allowed.test";     // supplied via CORS_ORIGINS
const EVIL_ORIGIN = "https://evil.example";

const results = [];
const check = (name, cond, extra) => {
  results.push(!!cond);
  console.log((cond ? "PASS " : "FAIL ") + name + (extra ? "  [" + extra + "]" : ""));
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const servers = [];
async function startServer(port, extraEnv) {
  const proc = spawn(process.execPath, ["server.js"], {
    env: Object.assign({}, process.env, { PORT: String(port), SENDGRID_API_KEY: "" }, extraEnv),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  proc.stdout.on("data", d => (log += d));
  proc.stderr.on("data", d => (log += d));
  servers.push(proc);
  for (let i = 0; i < 100; i++) {
    try { await fetch("http://127.0.0.1:" + port + "/"); return { proc, log: () => log }; }
    catch (e) { await sleep(200); }
  }
  throw new Error("server on " + port + " never became reachable. log:\n" + log.slice(0, 600));
}

// Returns status plus the CORS headers we care about.
async function call(port, pathname, { origin, method = "GET", preflight = false } = {}) {
  const headers = {};
  if (origin) headers.Origin = origin;
  if (preflight) {
    headers["Access-Control-Request-Method"] = "POST";
    headers["Access-Control-Request-Headers"] = "authorization,content-type";
  }
  const res = await fetch("http://127.0.0.1:" + port + pathname, {
    method: preflight ? "OPTIONS" : method,
    headers,
  });
  let body = null;
  try { body = await res.json(); } catch (e) { /* not JSON */ }
  return {
    status: res.status,
    allowOrigin: res.headers.get("access-control-allow-origin"),
    allowHeaders: res.headers.get("access-control-allow-headers"),
    body,
  };
}

(async () => {
  try {
    const ok = await startServer(OK_PORT, {
      FRONTEND_URL: ENV_ORIGIN,
      CORS_ORIGINS: LIST_ORIGIN + ",  " + "https://nf-second.test/",   // padding + trailing slash on purpose
      NODE_ENV: "",
    });

    /* ---------------- GET /api/health ---------------- */
    // The pool connects lazily, so the very first SELECT 1 can land before the database
    // connection exists. Render polls its health check, so "healthy shortly after boot"
    // is the real contract; poll the same way instead of firing a single racy shot.
    const waitHealthy = async (port, ms = 10000) => {
      let last = null;
      for (let t = 0; t < ms; t += 250) {
        last = await call(port, "/api/health");
        if (last.status === 200) return last;
        await sleep(250);
      }
      return last;
    };
    let r = await waitHealthy(OK_PORT);
    if (r.status !== 200) console.log("ok-instance server log:" + String.fromCharCode(10) + ok.log().slice(0, 800));
    check("health: 200 with status ok when the database answers",
      r.status === 200 && r.body && r.body.status === "ok" && r.body.database === "ok",
      r.status + " " + JSON.stringify(r.body));

    check("health: needs no authentication", r.status === 200);

    const healthKeys = r.body ? Object.keys(r.body).sort().join(",") : "";
    check("health: response carries only status fields, no internals", healthKeys === "database,status", healthKeys);

    const leak = JSON.stringify(r.body || {}).toLowerCase();
    const secretish = [String(process.env.DB_NAME || "").toLowerCase(), String(process.env.DB_USER || "").toLowerCase(),
                       "127.0.0.1", "mysql", "mariadb", "password", "sql", "stack"];
    check("health: leaks no database, credential or driver detail",
      !secretish.some(s => s && leak.includes(s)), leak);

    // Same code, unreachable database: the check must fail loudly rather than lie.
    const dead = await startServer(DEAD_DB_PORT, { DB_HOST: "127.0.0.1", DB_PORT: "1", NODE_ENV: "" });
    r = await call(DEAD_DB_PORT, "/api/health");
    check("health: 503 when the database is unreachable",
      r.status === 503 && r.body && r.body.status === "unavailable",
      r.status + " " + JSON.stringify(r.body));
    const deadLeak = JSON.stringify(r.body || {}).toLowerCase();
    check("health: the failure response still leaks nothing",
      !["econnrefused", "mysql", "mariadb", "sql", "stack", "password"].some(s => deadLeak.includes(s)), deadLeak);

    /* ---------------- CORS allowlist ---------------- */
    r = await call(OK_PORT, "/api/products", { origin: DEV_ORIGIN });
    check("cors: local dev origin allowed outside production",
      r.allowOrigin === DEV_ORIGIN, String(r.allowOrigin));

    r = await call(OK_PORT, "/api/products", { origin: ENV_ORIGIN });
    check("cors: FRONTEND_URL origin allowed", r.allowOrigin === ENV_ORIGIN, String(r.allowOrigin));

    r = await call(OK_PORT, "/api/products", { origin: LIST_ORIGIN });
    check("cors: CORS_ORIGINS entry allowed", r.allowOrigin === LIST_ORIGIN, String(r.allowOrigin));

    r = await call(OK_PORT, "/api/products", { origin: "https://nf-second.test" });
    check("cors: CORS_ORIGINS tolerates padding and a trailing slash",
      r.allowOrigin === "https://nf-second.test", String(r.allowOrigin));

    r = await call(OK_PORT, "/api/products", { origin: EVIL_ORIGIN });
    check("cors: unknown origin gets no allow header",
      r.allowOrigin === null, String(r.allowOrigin));

    r = await call(OK_PORT, "/api/products", { origin: DEV_ORIGIN });
    check("cors: never answers with a wildcard", r.allowOrigin !== "*", String(r.allowOrigin));

    r = await call(OK_PORT, "/api/products");
    check("cors: request without an Origin still works (server-to-server, webhook, health)",
      r.status === 200, String(r.status));

    // Preflight, the part that actually gates a browser's authenticated request.
    r = await call(OK_PORT, "/api/payments/initialize", { origin: DEV_ORIGIN, preflight: true });
    check("cors: preflight from an allowed origin is approved and permits Authorization",
      r.status >= 200 && r.status < 300 && r.allowOrigin === DEV_ORIGIN
      && /authorization/i.test(r.allowHeaders || ""),
      r.status + " allow-origin=" + r.allowOrigin + " allow-headers=" + r.allowHeaders);

    r = await call(OK_PORT, "/api/payments/initialize", { origin: EVIL_ORIGIN, preflight: true });
    check("cors: preflight from an unknown origin gets no allow header",
      r.allowOrigin === null, String(r.allowOrigin));

    /* ---------------- production mode ---------------- */
    const prod = await startServer(PROD_PORT, {
      NODE_ENV: "production",
      CORS_ORIGINS: "https://nf-live.test",
      FRONTEND_URL: "https://nf-live.test",
      DEV_EMAIL_LOG: "",
    });

    r = await call(PROD_PORT, "/api/products", { origin: "https://nf-live.test" });
    check("cors (production): the configured production origin is allowed",
      r.allowOrigin === "https://nf-live.test", String(r.allowOrigin));

    r = await call(PROD_PORT, "/api/products", { origin: DEV_ORIGIN });
    check("cors (production): local dev origins are NOT allowed",
      r.allowOrigin === null, String(r.allowOrigin));

    r = await waitHealthy(PROD_PORT);
    check("health works in production mode too", r.status === 200 && r.body && r.body.status === "ok", String(r.status));
    if (r.status !== 200) console.log("prod-instance server log:" + String.fromCharCode(10) + prod.log().slice(0, 800));

    check("no server crashed", servers.every(s => s.exitCode === null));
    for (const s of [ok, dead, prod]) {
      if (/TypeError|ReferenceError/.test(s.log())) console.log("server log errors:\n" + s.log().slice(0, 500));
    }
  } catch (err) {
    console.error("HARNESS ERROR:", err.message);
    results.push(false);
  } finally {
    for (const s of servers) s.kill();
    const failed = results.filter(r => !r).length;
    console.log("\n" + (results.length - failed) + "/" + results.length + " passed" + (failed ? " — " + failed + " FAILED" : ""));
    process.exit(failed ? 1 : 0);
  }
})();
