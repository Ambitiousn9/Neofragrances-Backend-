// Maintenance mode (Milestone 6 Phase 2) — the guard, the bypass list, the
// admin toggle, the cache, and fail-open behaviour.
//
// WHAT THIS PROVES, and why each case exists
//   The guard decides whether the storefront is reachable, so the dangerous
//   failures are not "it didn't block" but "it blocked the wrong thing":
//     - blocking POST /api/login would lock the administrator out permanently,
//       because that is the only auth path the admin portal has;
//     - blocking GET /api/me would brick every admin page, because
//       admin-core.js awaits it during boot and its ready promise never
//       resolves on failure;
//     - blocking the Paystack webhook would lose real orders, because Paystack
//       reads 5xx as "retry" and eventually gives up;
//     - blocking payment verification would strand a customer who has already
//       been charged;
//     - failing CLOSED on a settings read error would turn a database blip into
//       a full outage.
//   Every one of those has a test below.
//
// SAFETY
//   Writes exactly one table: app_settings, key 'maintenance_mode'. It records
//   that row's prior state and restores it (including deleting it again if it
//   did not exist). Creates one temporary admin and one temporary customer and
//   deletes both. Touches no catalog, order, coupon or offer data. Paystack is
//   never called: the webhook case asserts the guard lets the request through
//   by checking it is NOT a maintenance 503, which happens before any outbound
//   call would occur.
//
// Ports: 5067 healthy instance, 5068 same code with an unreachable database
// (DB_PORT=1, the pattern platform-tests.js already uses) for the fail-open
// case. CDP 9342 for the two client-side exemption checks. 5055-5060, 5063-5066,
// 5070, 5099 and CDP 9334/9336/9337/9339/9340/9341 are taken by other suites.
const path = require("path"), fs = require("fs"), os = require("os"), crypto = require("crypto");
const { spawn } = require("child_process");
// This file lives in <repo>/tests, so default to the repo root above it.
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
// T04: runs ONLY under the isolated-database guard (nf_test_* on 127.0.0.1:3308; see
// tests/README.md, "Isolated test database"). Checked before dotenv and db.js load.
const iso = require("./support/isolated-suite");
iso.requireIsolation("maintenance-tests.js");
require(path.join(process.cwd(), "node_modules/dotenv")).config({ quiet: true });
const jwt = require(path.join(process.cwd(), "node_modules/jsonwebtoken"));
const bcrypt = require(path.join(process.cwd(), "node_modules/bcrypt"));
const pool = require(path.join(process.cwd(), "db"));
// Safety gate — never weaken this.

const OK_PORT = 5067, DEAD_DB_PORT = 5068, CDP_PORT = 9342;
const API = `http://127.0.0.1:${OK_PORT}`;
const DEAD = `http://127.0.0.1:${DEAD_DB_PORT}`;
const FRONT = "http://127.0.0.1:5500";
const SECRET = crypto.randomBytes(32).toString("hex");
const TTL_MS = 7000; // must mirror settings.js TTL_MS
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = async (s, p) => (await pool.query(s, p))[0];
const results = []; const check = (n, c, x = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"} ${n}${x !== "" ? "  [" + String(x).slice(0, 190) + "]" : ""}`); };
const SHOTS = path.join(__dirname, "maintenance-shots"); fs.mkdirSync(SHOTS, { recursive: true });
// The three app_settings rows this suite writes. No other key is touched.
const MAINT_KEYS = ["maintenance_mode", "maintenance_progress", "maintenance_message"];
const MESSAGE_MAX = 200; // must mirror settings.js MESSAGE_MAX

// Raw call that also exposes the content type, so "JSON only, never HTML" is testable.
const call = async (base, method, url, token, body) => {
  const res = await fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const ctype = res.headers.get("content-type") || "";
  const retryAfter = res.headers.get("retry-after");
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch (e) {}
  return { status: res.status, data, text, ctype, retryAfter };
};

// A guarded child on the nf_test_* database, or (noDb) a child with no database at all
// (127.0.0.1:1, no-database preload) for the fail-open cases.
const startServer = (port, { noDb = false } = {}) => (noDb ? iso.startNoDbServer : iso.startGuardedServer)({
  suite: "maintenance-tests.js", port,
  env: { JWT_SECRET: SECRET, SENDGRID_API_KEY: "", PAYSTACK_SECRET_KEY: "", GOOGLE_CLIENT_ID: "", DEV_EMAIL_LOG: "true", FRONTEND_URL: FRONT, NODE_ENV: "" },
});
const waitUp = async (base) => { for (let i = 0; i < 80; i++) { try { await fetch(base + "/"); return true; } catch (e) { await sleep(200); } } return false; };

(async () => {
  await iso.verifyParentIdentity(pool, "maintenance-tests.js");
  let okServer, deadServer, edge, ws, adminId, custId;
  // Record the prior state of every row this suite writes, so they can be put
  // back. Phase 2 wrote only maintenance_mode; the progress and message keys are
  // written too now, and each has to be restored INCLUDING its absence.
  let priorRows = [], priorTotal = 0;
  try {
    priorRows = await q(`SELECT setting_key, setting_value, updated_by FROM app_settings
                          WHERE setting_key IN (?, ?, ?)`, MAINT_KEYS);
    priorTotal = Number((await q("SELECT COUNT(*) c FROM app_settings"))[0].c);
  } catch (e) {
    console.error("app_settings is not readable — has migration 003 been applied locally?", e.code || e.message);
    results.push(false);
  }

  try {
    const stamp = Date.now();
    const hash = await bcrypt.hash("Secret123", 10);
    adminId = (await q("INSERT INTO users (full_name, email, phone, password_hash, role, email_verified_at, auth_provider) VALUES ('Maint Admin', ?, '0200000000', ?, 'admin', NOW(), 'local')", [`nf-maint-admin-${stamp}@example.invalid`, hash])).insertId;
    custId = (await q("INSERT INTO users (full_name, email, phone, password_hash, role, email_verified_at, auth_provider) VALUES ('Maint Customer', ?, '0200000000', ?, 'customer', NOW(), 'local')", [`nf-maint-cust-${stamp}@example.invalid`, hash])).insertId;
    const tAdmin = jwt.sign({ id: adminId, role: "admin" }, SECRET, { expiresIn: "1h" });
    const tCust = jwt.sign({ id: custId, role: "customer" }, SECRET, { expiresIn: "1h" });

    okServer = await startServer(OK_PORT);
    check("M1. healthy test instance started", await waitUp(API));

    /* ---------- maintenance OFF baseline ---------- */
    await call(API, "POST", "/api/admin/system/maintenance/off", tAdmin);
    let r = await call(API, "GET", "/api/system/status");
    check("M2. OFF baseline: /api/system/status reports maintenance false", r.status === 200 && r.data.maintenance === false, JSON.stringify(r.data));
    r = await call(API, "GET", "/api/products");
    check("M3. OFF baseline: customer catalog API serves normally", r.status === 200 && Array.isArray(r.data), `${r.status}`);
    r = await call(API, "GET", "/api/health");
    check("M4. OFF baseline: health 200 while healthy", r.status === 200 && r.data.status === "ok", JSON.stringify(r.data));

    /* ---------- authorization on the toggle ---------- */
    check("M5. unauthenticated cannot enable maintenance (401)", (await call(API, "POST", "/api/admin/system/maintenance/on")).status === 401);
    check("M6. customer cannot enable maintenance (403)", (await call(API, "POST", "/api/admin/system/maintenance/on", tCust)).status === 403);
    const forged = jwt.sign({ id: custId, role: "admin" }, SECRET);
    check("M7. customer token claiming admin is rejected (403, role read from DB)", (await call(API, "POST", "/api/admin/system/maintenance/on", forged)).status === 403);
    check("M8. unauthenticated cannot read the admin maintenance detail (401)", (await call(API, "GET", "/api/admin/system/maintenance", null)).status === 401);
    r = await call(API, "GET", "/api/system/status");
    check("M9. the rejected attempts did not turn maintenance on", r.data.maintenance === false, JSON.stringify(r.data));

    /* ---------- admin enables maintenance ---------- */
    r = await call(API, "POST", "/api/admin/system/maintenance/on", tAdmin);
    check("M10. admin can enable maintenance (200)", r.status === 200 && r.data.maintenance === true, JSON.stringify(r.data));
    const row = (await q("SELECT setting_value, updated_by FROM app_settings WHERE setting_key='maintenance_mode'"))[0];
    check("M11. app_settings row written with the admin as updated_by", !!row && String(row.setting_value) === "true" && Number(row.updated_by) === adminId, JSON.stringify(row));
    r = await call(API, "GET", "/api/system/status");
    check("M12. cache invalidated immediately — status flips in the same process without waiting for the TTL", r.data.maintenance === true, JSON.stringify(r.data));

    /* ---------- blocked customer routes: 503, JSON, never HTML ---------- */
    const blocked = [
      ["GET", "/api/products"], ["GET", "/api/offers/active"], ["POST", "/api/cart/quote"],
      ["POST", "/api/register"], ["POST", "/api/track-order"], ["GET", "/api/products/1/reviews"],
      ["POST", "/api/forgot-password"], ["GET", "/api/config/google-client-id"],
    ];
    let b503 = 0, bJson = 0, bHtml = 0, bCode = 0, bRetry = 0;
    for (const [m, u] of blocked) {
      const x = await call(API, m, u, null, m === "POST" ? {} : undefined);
      if (x.status === 503) b503++;
      if (x.ctype.includes("application/json")) bJson++;
      if (/<html|<!DOCTYPE/i.test(x.text)) bHtml++;
      if (x.data && x.data.code === "MAINTENANCE_MODE") bCode++;
      if (x.retryAfter) bRetry++;
    }
    check(`M13. all ${blocked.length} customer routes return 503 while maintenance is on`, b503 === blocked.length, `503s: ${b503}/${blocked.length}`);
    check(`M14. all ${blocked.length} blocked responses are JSON with code MAINTENANCE_MODE`, bJson === blocked.length && bCode === blocked.length, `json ${bJson} code ${bCode}`);
    check("M15. no blocked response contains HTML", bHtml === 0, `html responses: ${bHtml}`);
    check(`M16. every blocked response carries Retry-After`, bRetry === blocked.length, `retry-after: ${bRetry}/${blocked.length}`);

    /* ---------- the bypass list ---------- */
    r = await call(API, "GET", "/api/health");
    check("M17. BYPASS health: still 200 while maintenance is on", r.status === 200 && r.data.status === "ok", JSON.stringify(r.data));
    r = await call(API, "POST", "/api/login", null, { email: `nf-maint-admin-${stamp}@example.invalid`, password: "Secret123" });
    check("M18. BYPASS login: admin can log in DURING maintenance (no lockout)", r.status === 200 && !!r.data.token, `${r.status} ${r.data && r.data.code ? r.data.code : ""}`);
    const liveToken = r.data && r.data.token;
    r = await call(API, "GET", "/api/me", tAdmin);
    check("M19. BYPASS GET /api/me: available, so admin-core.js can boot", r.status === 200 && !!r.data.email, `${r.status}`);
    r = await call(API, "PATCH", "/api/me", tAdmin, { full_name: "Should Not Apply" });
    check("M20. PATCH /api/me is NOT bypassed — blocked with 503", r.status === 503 && r.data.code === "MAINTENANCE_MODE", `${r.status} ${r.data && r.data.code}`);
    const unchanged = (await q("SELECT full_name FROM users WHERE id = ?", [adminId]))[0];
    check("M21. the blocked PATCH changed nothing", unchanged.full_name === "Maint Admin", unchanged.full_name);
    r = await call(API, "GET", "/api/admin/summary", tAdmin);
    check("M22. BYPASS /api/admin/*: admin API reachable during maintenance", r.status === 200 && !!r.data.products, `${r.status}`);
    r = await call(API, "GET", "/api/system/status");
    check("M23. BYPASS /api/system/status: the probe itself is reachable", r.status === 200, `${r.status}`);

    /* ---------- payment safety ---------- */
    r = await call(API, "POST", "/api/payments/initialize", tCust, { items: [] });
    check("M24. payment INITIALIZATION is blocked (no new money enters during maintenance)", r.status === 503 && r.data.code === "MAINTENANCE_MODE", `${r.status} ${r.data && r.data.code}`);
    r = await call(API, "GET", "/api/payments/verify/NF-maint-probe-0000", tCust);
    check("M25. payment VERIFICATION is reachable — not a maintenance 503 (customer already charged)", r.status !== 503 || (r.data && r.data.code !== "MAINTENANCE_MODE"), `${r.status} ${r.data && r.data.code}`);
    // Unsigned body: the route must get far enough to reject the SIGNATURE, which
    // proves the guard let it through. No Paystack call happens on this path.
    r = await call(API, "POST", "/api/payments/webhook", null, { event: "charge.success", data: { reference: "NF-maint-probe-0000" } });
    check("M26. Paystack WEBHOOK is reachable — not a maintenance 503 (a 5xx would make Paystack retry then give up)", !(r.status === 503 && r.data && r.data.code === "MAINTENANCE_MODE"), `${r.status} ${r.data && r.data.code}`);

    /* ---------- path casing (Phase 2 step 1): Express routes case-insensitively ---------- */
    const initCased = [];
    for (const u of ["/API/payments/initialize", "/Api/Payments/Initialize"]) {
      const x = await call(API, "POST", u, tCust, { items: [] });
      initCased.push(x.status === 503 && x.data && x.data.code === "MAINTENANCE_MODE" ? "503" : `${u} ${x.status}`);
    }
    check("M26a. payment INITIALIZATION in other casings is blocked too (/API/…, /Api/…)", initCased.every(s => s === "503"), initCased.join(","));
    const casedBlocked = [];
    for (const [m, u] of [["GET", "/API/products"], ["GET", "/Api/Offers/Active"], ["POST", "/aPi/register"], ["POST", "/API/TRACK-ORDER"]]) {
      const x = await call(API, m, u, null, m === "POST" ? {} : undefined);
      if (!(x.status === 503 && x.data && x.data.code === "MAINTENANCE_MODE")) casedBlocked.push(`${m} ${u} ${x.status}`);
    }
    check("M26b. customer routes in other casings return the maintenance 503", casedBlocked.length === 0, casedBlocked.join(","));
    r = await call(API, "PATCH", "/API/ME", tAdmin, { full_name: "Should Not Apply Either" });
    const stillUnchanged = (await q("SELECT full_name FROM users WHERE id = ?", [adminId]))[0];
    check("M26c. PATCH /API/ME is blocked (503) and changed nothing", r.status === 503 && r.data && r.data.code === "MAINTENANCE_MODE" && stillUnchanged.full_name === "Maint Admin", `${r.status} ${stillUnchanged.full_name}`);
    const casedBypass = [
      (await call(API, "GET", "/API/HEALTH")).status,
      (await call(API, "GET", "/API/ADMIN/SUMMARY", tAdmin)).status,
      (await call(API, "GET", "/Api/System/Status")).status,
    ];
    check("M26d. bypass routes in other casings still answer (health, admin API with an admin token, probe)", casedBypass.every(s => s === 200), JSON.stringify(casedBypass));

    /* ---------- client-side exemptions in a real browser ---------- */
    const profile = path.join(os.tmpdir(), "nf-edge-maint"); fs.rmSync(profile, { recursive: true, force: true });
    // Sync and background networking off (same flags as e2e-checkout.js): a fresh profile can
    // otherwise open edge://sync-confirmation-dialog, which backgrounds the test tab so a
    // screenshot never completes (seen 2026-11-14).
    edge = spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", ["--headless=new", `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, "--no-first-run",
      "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "about:blank"], { stdio: "ignore" });
    let wsUrl; for (let i = 0; i < 150 && !wsUrl; i++) { try { const ts = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).filter(t => t.type === "page"); wsUrl = (ts.find(t => t.url === "about:blank") || ts.find(t => !t.url.startsWith("edge://")))?.webSocketDebuggerUrl; } catch (e) {} if (!wsUrl) await sleep(200); }
    ws = new WebSocket(wsUrl); await new Promise(res => ws.addEventListener("open", res, { once: true }));
    let id = 0, loads = 0; const pending = new Map();
    ws.addEventListener("message", msg => {
      const m = JSON.parse(msg.data); const p = m.params || {};
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === "Fetch.requestPaused") send("Fetch.continueRequest", { requestId: p.requestId, url: p.request.url.replace("http://localhost:5000", API) }).catch(() => {});
      if (m.method === "Page.loadEventFired") loads++;
    });
    // Every CDP command is bounded: a command that never answers fails the run (and the
    // finally block still cleans up) instead of hanging it.
    const CDP_TIMEOUT_MS = 15000;
    const send = (method, params = {}) => new Promise((res, rej) => {
      const i = ++id;
      const t = setTimeout(() => { pending.delete(i); rej(new Error(`CDP ${method} gave no answer within ${CDP_TIMEOUT_MS} ms`)); }, CDP_TIMEOUT_MS);
      pending.set(i, m => { clearTimeout(t); res(m); });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Fetch.enable", { patterns: [{ urlPattern: "http://localhost:5000/*" }] });
    const ev = async e => { const res = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); return res.result?.result?.value; };
    // Page.navigate may get no answer when the page redirects itself while the navigation
    // is still in flight (js/main.js's maintenance redirect; seen 2026-11-14). That is not a
    // failure: carry on and let each check judge the page's actual location.
    const go = async url => {
      const b = loads;
      try { await send("Page.navigate", { url }); }
      catch (e) { if (!/^CDP Page\.navigate gave no answer/.test(e.message)) throw e; console.log(`(Page.navigate to ${url} got no answer; continuing)`); }
      for (let i = 0; i < 150 && loads === b; i++) await sleep(100); await sleep(2200);
    };
    // Screenshots are evidence, not assertions: one that fails is reported and skipped.
    const shot = async name => {
      try {
        await send("Page.bringToFront");
        const res = await send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(path.join(SHOTS, name + ".png"), Buffer.from(res.result.data, "base64"));
      } catch (e) { console.log(`(screenshot ${name} skipped: ${e.message})`); }
    };

    await go(`${FRONT}/index.html`);
    // The redirect follows an async status probe, so on a slow machine it can land after
    // go()'s fixed wait (seen 2026-11-14). Poll for it for up to 15 s instead.
    let p27 = String(await ev("location.pathname"));
    for (let i = 0; i < 30 && !p27.endsWith("/maintenance.html"); i++) { await sleep(500); p27 = String(await ev("location.pathname")); }
    if (p27.endsWith("/maintenance.html")) await sleep(1500); // let the maintenance page finish loading
    check("M27. a normal storefront page redirects to the maintenance page", p27.endsWith("/maintenance.html"), p27);
    await shot("01-maintenance-page");
    // Compared case-insensitively on purpose: innerText reflects CSS
    // text-transform, and .maint-brand / .maint-status are intentionally
    // uppercase, so a status of "Status: Back soon" renders as "STATUS: BACK
    // SOON". Asserting the content, not the casing, keeps this test from
    // breaking the next time the styling changes.
    //
    // The status line is operator-supplied now, so this asserts the parts that
    // are always present - the "Status:" label and the "n% done." line - and
    // leaves the wording of the message itself to M70 and M78, which set it
    // first and can therefore assert it exactly.
    check("M28. the maintenance page shows the branding, a status line, the percentage and the support contacts", await ev(`(()=>{const t=document.body.innerText.toLowerCase();return ["we’ll be back soon","status:","% done.","ambitiousn9@icloud.com","0505731824"].every(s=>t.includes(s));})()`), (await ev("document.body.innerText")).slice(0, 140).replace(/\n/g, " | "));
    check("M29. the maintenance page loads no storefront JS (no catalog/cart globals)", await ev(`typeof window.PRODUCTS === "undefined" && typeof window.loadProducts === "undefined"`));

    await go(`${FRONT}/payment-callback.html?reference=NF-maint-probe-0000`);
    check("M30. EXEMPT payment-callback.html is not trapped by the maintenance redirect", (await ev("location.pathname")).endsWith("/payment-callback.html"), await ev("location.pathname"));
    await shot("02-payment-callback-exempt");

    await ev(`localStorage.setItem("neofragrances_auth", ${JSON.stringify(JSON.stringify({ token: null, user: { id: 0, full_name: "x", role: "admin" } }))}); true`);
    await ev(`localStorage.setItem("neofragrances_auth", ${JSON.stringify(JSON.stringify({ token: liveToken, user: { id: adminId, full_name: "Maint Admin", role: "admin" } }))}); true`);
    await go(`${FRONT}/admin/dashboard.html`);
    check("M31. EXEMPT admin page is not redirected and is not locked out", (await ev("location.pathname")).includes("/admin/dashboard.html"), await ev("location.pathname"));
    await shot("03-admin-accessible");

    /* ---------- admin turns it back off ---------- */
    r = await call(API, "POST", "/api/admin/system/maintenance/off", tAdmin);
    check("M32. admin can DISABLE maintenance while it is on", r.status === 200 && r.data.maintenance === false, JSON.stringify(r.data));
    r = await call(API, "GET", "/api/products");
    check("M33. customer API recovers immediately after the toggle (cache invalidated)", r.status === 200 && Array.isArray(r.data), `${r.status}`);
    r = await call(API, "GET", "/api/admin/system/maintenance", tAdmin);
    check("M34. admin detail reports OFF with the last actor recorded", r.status === 200 && r.data.maintenance === false && Number(r.data.updated_by) === adminId, JSON.stringify(r.data));

    /* ---------- cache behaviour ---------- */
    // Flip the row underneath the server. The guard must keep serving the cached
    // value briefly, then pick the new one up after the TTL — proving a cache
    // exists at all, and that it expires rather than sticking forever.
    await q("UPDATE app_settings SET setting_value = 'true' WHERE setting_key = 'maintenance_mode'");
    r = await call(API, "GET", "/api/system/status");
    check("M35. cache holds the previous value for a moment after an out-of-band DB change", r.data.maintenance === false, JSON.stringify(r.data));
    await sleep(TTL_MS + 1200);
    r = await call(API, "GET", "/api/system/status");
    check("M36. cache expires after the TTL and the new value is picked up", r.data.maintenance === true, JSON.stringify(r.data));
    await call(API, "POST", "/api/admin/system/maintenance/off", tAdmin);
    check("M37. maintenance left OFF after the cache checks", (await call(API, "GET", "/api/system/status")).data.maintenance === false);

    /* ---------- fail OPEN on a settings read failure ---------- */
    // Same code, unreachable database: the settings SELECT cannot succeed. The
    // guard must treat that as OFF. A customer route will still fail on its own
    // database access, but it must NOT be a maintenance 503 — that is the
    // difference between "a query broke" and "we took the whole site down".
    deadServer = await startServer(DEAD_DB_PORT, { noDb: true });
    check("M38. instance with an unreachable database started", await waitUp(DEAD));
    r = await call(DEAD, "GET", "/api/products");
    check("M39. FAIL OPEN: settings read failure does not produce a maintenance 503", !(r.data && r.data.code === "MAINTENANCE_MODE"), `${r.status} ${r.data && r.data.code}`);
    r = await call(DEAD, "GET", "/api/system/status");
    check("M40. FAIL OPEN: the probe reports maintenance false when the settings read fails", r.status === 200 && r.data.maintenance === false, `${r.status} ${JSON.stringify(r.data)}`);
    r = await call(DEAD, "GET", "/api/health");
    check("M41. health still answers (503 unavailable) and is not hidden behind maintenance", r.status === 503 && r.data.database === "unavailable", JSON.stringify(r.data));

    check("M42. neither test server crashed", okServer.proc.exitCode === null && deadServer.proc.exitCode === null, `ok=${okServer.proc.exitCode} dead=${deadServer.proc.exitCode}`);

    /* ================================================================
       PROGRESS + MESSAGE (the Phase 2 enhancement)

       Three keys are now written and read together. The failures worth
       catching here are not the guard's:
         - a malformed or missing progress/message must NEVER turn
           maintenance on, because those two are presentation only;
         - a validation rejection must be a 400, never a 403: the admin
           portal's apiFetch reads 401/403 as an expired session and
           redirects to the login page, so a 403 would throw the operator
           out of the portal instead of showing them the bad field;
         - the public probe must not leak who changed the setting;
         - the message must reach the page as TEXT, since an operator can
           type anything into it.

       Both servers from the sections above are still running and the
       browser is still attached, so this block reuses them.
       ================================================================ */
    const CFG_PATH = "/api/admin/maintenance";
    const cfg = (token, body) => call(API, "POST", CFG_PATH, token, body);
    const base = { maintenance: false, progress: 0, message: "" };

    /* ---------- authorization on the new endpoint ---------- */
    check("M43. unauthenticated cannot save the maintenance configuration (401)", (await cfg(null, base)).status === 401);
    check("M44. customer cannot save the maintenance configuration (403)", (await cfg(tCust, base)).status === 403);
    check("M45. customer token claiming admin cannot save it either (403, role read from DB)", (await cfg(forged, base)).status === 403);

    /* ---------- validation ---------- */
    const bad = [
      ['maintenance as the string "true"', { maintenance: "true", progress: 0, message: "" }, "maintenance"],
      ["maintenance as 1", { maintenance: 1, progress: 0, message: "" }, "maintenance"],
      ["maintenance omitted", { progress: 0, message: "" }, "maintenance"],
      ["progress 101", { maintenance: true, progress: 101, message: "" }, "progress"],
      ["progress -1", { maintenance: true, progress: -1, message: "" }, "progress"],
      ["progress 12.5", { maintenance: true, progress: 12.5, message: "" }, "progress"],
      ["progress as text", { maintenance: true, progress: "abc", message: "" }, "progress"],
      ["progress as a boolean true", { maintenance: true, progress: true, message: "" }, "progress"],
      ["progress as a boolean false", { maintenance: true, progress: false, message: "" }, "progress"],
      ["progress omitted", { maintenance: true, message: "" }, "progress"],
      // A NUMERIC string is rejected too. The rule is a strict integer, and the
      // admin page sends Number(input.value), so "60" is never a shape the API
      // has to accept - only one the contract would be looser for allowing.
      ['progress as the string "60"', { maintenance: true, progress: "60", message: "" }, "progress"],
      ['progress as the string "0"', { maintenance: true, progress: "0", message: "" }, "progress"],
      ['progress as the string "100"', { maintenance: true, progress: "100", message: "" }, "progress"],
      ["message one character over the limit", { maintenance: true, progress: 10, message: "x".repeat(MESSAGE_MAX + 1) }, "message"],
      ["message as a number", { maintenance: true, progress: 10, message: 5 }, "message"],
    ];
    let bad400 = 0, badField = 0, badAuthShaped = 0;
    const badDetail = [];
    for (const [label, body, field] of bad) {
      const x = await cfg(tAdmin, body);
      if (x.status === 400) bad400++; else badDetail.push(`${label}=${x.status}`);
      if (x.data && x.data.field === field) badField++;
      if (x.status === 401 || x.status === 403) badAuthShaped++;
    }
    check(`M46. all ${bad.length} malformed configurations are rejected with 400`, bad400 === bad.length, `400s: ${bad400}/${bad.length} ${badDetail.join(" ")}`);
    check("M47. every rejection names the offending field, so the portal can flag the right input", badField === bad.length, `named: ${badField}/${bad.length}`);
    check("M48. no validation failure answers 401/403 (that would log the operator out mid-edit)", badAuthShaped === 0, `auth-shaped: ${badAuthShaped}`);
    r = await call(API, "GET", "/api/system/status");
    check("M49. none of the rejected writes turned maintenance on", r.data.maintenance === false, JSON.stringify(r.data));

    /* ---------- the accepted boundaries ---------- */
    r = await cfg(tAdmin, { maintenance: true, progress: 0, message: "Starting the upgrade" });
    check("M50. progress 0 is accepted (lower boundary)", r.status === 200 && r.data.progress === 0, JSON.stringify(r.data));
    r = await cfg(tAdmin, { maintenance: true, progress: 100, message: "Final checks" });
    check("M51. progress 100 is accepted (upper boundary)", r.status === 200 && r.data.progress === 100, JSON.stringify(r.data));
    const maxMessage = "y".repeat(MESSAGE_MAX);
    r = await cfg(tAdmin, { maintenance: true, progress: 50, message: maxMessage });
    check(`M52. a ${MESSAGE_MAX}-character message is accepted (length boundary)`, r.status === 200 && r.data.message === maxMessage, `stored length ${r.data && typeof r.data.message === "string" ? r.data.message.length : "?"}`);

    /* ---------- the atomic save ---------- */
    const MSG = "Uploading the new autumn fragrances";
    r = await cfg(tAdmin, { maintenance: true, progress: 45, message: MSG });
    check("M53. all three values save together and the saved configuration is returned", r.status === 200 && r.data.maintenance === true && r.data.progress === 45 && r.data.message === MSG, JSON.stringify(r.data));
    const saved3 = await q("SELECT setting_key, setting_value, updated_by FROM app_settings WHERE setting_key IN (?, ?, ?)", MAINT_KEYS);
    const byKey = new Map(saved3.map(x => [x.setting_key, x]));
    check("M54. exactly one row per key, all three attributed to the admin who saved them", saved3.length === 3
      && byKey.get("maintenance_mode").setting_value === "true"
      && byKey.get("maintenance_progress").setting_value === "45"
      && byKey.get("maintenance_message").setting_value === MSG
      && saved3.every(x => Number(x.updated_by) === adminId), JSON.stringify(saved3));
    r = await call(API, "GET", "/api/system/status");
    check("M55. cache invalidated on save - all three new values are visible at once, without waiting for the TTL", r.data.maintenance === true && r.data.progress === 45 && r.data.message === MSG, JSON.stringify(r.data));

    /* ---------- what the public probe is allowed to say ---------- */
    check("M56. the public probe returns exactly maintenance, progress and message", JSON.stringify(Object.keys(r.data).sort()) === '["maintenance","message","progress"]', JSON.stringify(Object.keys(r.data)));
    const leaky = ["updated_by", "updated_by_name", "updated_at", "message_max", "setting_key", "setting_value", "unavailable", "success"];
    check("M57. the public probe exposes no admin, audit or internal field", leaky.every(k => !(k in r.data)) && !/updated_by|setting_value|app_settings|ECONN|mysql/i.test(r.text), `${leaky.filter(k => k in r.data).join(",") || "none present"} | ${r.text.slice(0, 120)}`);

    /* ---------- what the admin read reports ---------- */
    r = await call(API, "GET", "/api/admin/system/maintenance", tAdmin);
    check("M58. the admin read reports the progress and the message alongside the mode", r.status === 200 && r.data.maintenance === true && r.data.progress === 45 && r.data.message === MSG, JSON.stringify(r.data));
    check("M59. the admin read still carries the audit fields and the message limit", Number(r.data.updated_by) === adminId && !!r.data.updated_at && r.data.message_max === MESSAGE_MAX, JSON.stringify(r.data));

    /* ---------- a corrupt row stays a display problem ---------- */
    // Written straight into the table to simulate a bad or hand-edited value.
    // The on/off endpoints are used to drop the cache rather than sleeping out
    // the TTL: they rewrite only maintenance_mode, so the garbage below survives.
    await q("UPDATE app_settings SET setting_value = 'not-a-number' WHERE setting_key = 'maintenance_progress'");
    await call(API, "POST", "/api/admin/system/maintenance/on", tAdmin);
    r = await call(API, "GET", "/api/system/status");
    check("M60. a malformed stored progress reads as 0 and leaves the mode alone", r.data.maintenance === true && r.data.progress === 0, JSON.stringify(r.data));
    await q("UPDATE app_settings SET setting_value = '93' WHERE setting_key = 'maintenance_progress'");
    await call(API, "POST", "/api/admin/system/maintenance/off", tAdmin);
    r = await call(API, "GET", "/api/system/status");
    check("M61. progress and message can never turn maintenance ON - the mode comes from maintenance_mode alone", r.data.maintenance === false && r.data.progress === 93, JSON.stringify(r.data));
    await q("DELETE FROM app_settings WHERE setting_key IN (?, ?)", ["maintenance_progress", "maintenance_message"]);
    await call(API, "POST", "/api/admin/system/maintenance/off", tAdmin);
    r = await call(API, "GET", "/api/system/status");
    check("M62. missing progress and message rows default to 0 and empty, maintenance still OFF", r.data.maintenance === false && r.data.progress === 0 && r.data.message === "", JSON.stringify(r.data));
    r = await call(API, "GET", "/api/products");
    check("M63. the storefront is reachable throughout - a corrupt or absent presentation value is not an outage", r.status === 200 && Array.isArray(r.data), `${r.status}`);

    /* ---------- the original endpoints and the bypass list are untouched ---------- */
    r = await call(API, "POST", "/api/admin/system/maintenance/on", tAdmin);
    check("M64. the original ON endpoint still works alongside the new one", r.status === 200 && r.data.maintenance === true, JSON.stringify(r.data));
    r = await call(API, "GET", "/api/products");
    check("M65. the guard still blocks the storefront after the original ON endpoint (503)", r.status === 503 && r.data.code === "MAINTENANCE_MODE", `${r.status} ${r.data && r.data.code}`);
    const bypassStill = [
      (await call(API, "GET", "/api/health")).status === 200,
      (await call(API, "GET", "/api/me", tAdmin)).status === 200,
      (await call(API, "GET", "/api/admin/summary", tAdmin)).status === 200,
      (await call(API, "GET", "/api/system/status")).status === 200,
    ];
    check("M66. the bypass list is unchanged - health, /api/me, the admin API and the probe all still answer", bypassStill.every(Boolean), JSON.stringify(bypassStill));
    r = await call(API, "POST", "/api/admin/system/maintenance/off", tAdmin);
    check("M67. the original OFF endpoint still works alongside the new one", r.status === 200 && r.data.maintenance === false, JSON.stringify(r.data));

    /* ---------- fail OPEN, with the new fields ---------- */
    r = await call(DEAD, "GET", "/api/system/status");
    check("M68. FAIL OPEN still: an unreadable settings table reports maintenance false, progress 0, message empty", r.status === 200 && r.data.maintenance === false && r.data.progress === 0 && r.data.message === "", `${r.status} ${JSON.stringify(r.data)}`);
    r = await call(DEAD, "POST", CFG_PATH, tAdmin, { maintenance: true, progress: 10, message: "should not land" });
    check("M69. a save against an unreachable database fails loudly and never reports success", r.status >= 500 && !(r.data && r.data.success), `${r.status} ${JSON.stringify(r.data)}`);

    /* ---------- the public page, in the browser ---------- */
    await cfg(tAdmin, { maintenance: true, progress: 45, message: MSG });
    await go(`${FRONT}/maintenance.html`);
    await shot("04-maintenance-determinate");
    const shown = await ev(`(()=>{const t=document.querySelector(".maint-progress"),b=document.querySelector(".maint-progress-bar");return {status:document.querySelector(".maint-status").textContent,done:document.querySelector(".maint-done").textContent,pct:Math.round(b.getBoundingClientRect().width/t.getBoundingClientRect().width*100),aria:t.getAttribute("aria-valuenow"),role:t.getAttribute("role")};})()`);
    check("M70. the page shows the operator's message as the status line", shown.status === `Status: ${MSG}`, shown.status);
    check("M71. the page states the percentage in words", shown.done === "Maintenance is 45% done.", shown.done);
    check("M72. the bar's rendered width is exactly the reported percentage", shown.pct === 45, `${shown.pct}% of the track`);
    check("M73. the bar reports the same percentage to assistive technology", shown.role === "progressbar" && shown.aria === "45", JSON.stringify(shown));

    // An operator can type anything into the message box. It must arrive as text.
    const EVIL = `<img src=x onerror="document.title='XSS'">`;
    await cfg(tAdmin, { maintenance: true, progress: 10, message: EVIL });
    await go(`${FRONT}/maintenance.html`);
    const xss = await ev(`(()=>{const el=document.querySelector(".maint-status");return {kids:el.querySelectorAll("*").length,onlyLogo:document.querySelectorAll("img").length===document.querySelectorAll("img.maint-logo").length,title:document.title,text:el.textContent};})()`);
    check("M74. the message is rendered as TEXT - it creates no element and runs no script", xss.kids === 0 && xss.onlyLogo === true && !xss.title.includes("XSS"), JSON.stringify(xss).slice(0, 180));
    check("M75. the raw characters of the message survive verbatim as text", xss.text === `Status: ${EVIL}`, xss.text);

    // Reduced motion must remove the MOTION, not the information.
    await cfg(tAdmin, { maintenance: true, progress: 45, message: MSG });
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await go(`${FRONT}/maintenance.html`);
    await shot("05-maintenance-reduced-motion");
    const rm = await ev(`(()=>{const t=document.querySelector(".maint-progress"),b=document.querySelector(".maint-progress-bar");return {pct:Math.round(b.getBoundingClientRect().width/t.getBoundingClientRect().width*100),barAnim:getComputedStyle(b).animationName,overlayAnim:getComputedStyle(b,"::after").animationName};})()`);
    check("M76. with reduced motion the bar keeps the real percentage and is NOT forced to 100%", rm.pct === 45, `${rm.pct}%`);
    check("M77. with reduced motion no animation is left running", rm.barAnim === "none" && rm.overlayAnim === "none", JSON.stringify(rm));
    await send("Emulation.setEmulatedMedia", { features: [] });

    // An empty message is normal: the admin may only want to show progress.
    await cfg(tAdmin, { maintenance: true, progress: 0, message: "" });
    await go(`${FRONT}/maintenance.html`);
    const empty = await ev(`document.querySelector(".maint-status").textContent`);
    check("M78. an empty message falls back to the default copy, never a bare label", empty === "Status: NeoFragrances is currently undergoing maintenance.", empty);

    /* ---------- leave it off ---------- */
    await call(API, "POST", "/api/admin/system/maintenance/off", tAdmin);
    check("M79. maintenance left OFF after the configuration tests", (await call(API, "GET", "/api/system/status")).data.maintenance === false);
    check("M80. neither test server crashed during the configuration tests", okServer.proc.exitCode === null && deadServer.proc.exitCode === null, `ok=${okServer.proc.exitCode} dead=${deadServer.proc.exitCode}`);
  } catch (err) {
    console.error("TEST HARNESS ERROR:", err);
    results.push(false);
  } finally {
    try {
      // Restore app_settings to exactly its prior state, including absence.
      const had = new Map(priorRows.map(x => [x.setting_key, x]));
      for (const key of MAINT_KEYS) {
        const was = had.get(key);
        if (was) {
          await q("INSERT INTO app_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)", [key, was.setting_value, was.updated_by]);
        } else {
          const d = await q("DELETE FROM app_settings WHERE setting_key = ?", [key]);
          if (d.affectedRows > 1) console.error(`CLEANUP: deleted ${d.affectedRows} rows for ${key}, expected at most 1`);
        }
      }
      for (const uid of [adminId, custId]) {
        if (!uid) continue;
        const d = await q("DELETE FROM users WHERE id = ?", [uid]);
        if (d.affectedRows !== 1) console.error(`CLEANUP: user ${uid} deleted ${d.affectedRows}, expected 1`);
      }
      const left = (await q("SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM app_settings) s, (SELECT COUNT(*) FROM products) p, (SELECT COUNT(*) FROM orders) o, (SELECT SUM(stock_qty) FROM products) st"))[0];
      console.log(`\ncleanup: users=${left.u} app_settings=${left.s} products=${left.p} orders=${left.o} stock=${left.st}`);
      check("M81. fixtures removed and app_settings restored to its prior state", Number(left.u) === 1 && Number(left.s) === priorTotal, `${JSON.stringify(left)} priorTotal=${priorTotal}`);
    } catch (e) { console.error("CLEANUP ERROR:", e.message); results.push(false); }
    try { ws && ws.close(); } catch (e) {}
    if (edge) edge.kill();
    iso.stopServer(okServer);
    iso.stopServer(deadServer);
    await pool.end();
    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ""}`);
    process.exit(failed ? 1 : 0);
  }
})();
