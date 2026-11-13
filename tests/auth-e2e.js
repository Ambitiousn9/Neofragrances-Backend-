// Auth E2E after E1/E2b/E4: real pages (:5500) + updated server.js (:5055, DEV_EMAIL_LOG=true,
// no Paystack/Google/SendGrid keys) + headless Edge. Browser calls to :5000 are rerouted to :5055.
const path = require("path"), fs = require("fs"), os = require("os"), crypto = require("crypto");
const { spawn } = require("child_process");
// Throwaway signing secret for the child server. The suite used to rely on JWT_SECRET from
// .env; the isolation guard blocks .env, so the child must be given its own (T04).
const SECRET = crypto.randomBytes(32).toString("hex");
// This file lives in <repo>/tests, so default to the repo root above it: the suite then
// runs as `node tests/<file>` with nothing set. An explicit SERVER_DIR still wins.
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
// T04: runs ONLY under the isolated-database guard (nf_test_* on 127.0.0.1:3308; see
// tests/README.md, "Isolated test database"). Checked before dotenv and db.js load.
const iso = require("./support/isolated-suite");
iso.requireIsolation("auth-e2e.js");
require(path.join(process.cwd(), "node_modules/dotenv")).config({ quiet: true });
const pool = require(path.join(process.cwd(), "db"));
if (!["localhost", "127.0.0.1"].includes(process.env.DB_HOST)) { console.error("not local"); process.exit(1); }
const FRONT = "http://127.0.0.1:5500";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = async (s, p) => (await pool.query(s, p))[0];
const results = []; const check = (n, c, x = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"} ${n}${x ? "  [" + String(x).slice(0, 140) + "]" : ""}`); };

(async () => {
  await iso.verifyParentIdentity(pool, "auth-e2e.js");
  const stamp = Date.now();
  const email = `nf-auth-e2e-${stamp}@gmail.com`;
  const pass1 = "Secret123", pass2 = "NewSecret456";
  let server, edge, ws, serverLog = "";
  try {
    server = await iso.startGuardedServer({ suite: "auth-e2e.js", port: 5055, env: { JWT_SECRET: SECRET, DEV_EMAIL_LOG: "true", PAYSTACK_SECRET_KEY: "", GOOGLE_CLIENT_ID: "", SENDGRID_API_KEY: "", SENDGRID_FROM_EMAIL: "", FRONTEND_URL: FRONT, NODE_ENV: "" } });
    server.proc.stdout.on("data", d => serverLog += d); server.proc.stderr.on("data", d => serverLog += d); serverLog += server.log();
    check("server start notice shows DEV_EMAIL_LOG mode", /DEV_EMAIL_LOG is ON/.test(serverLog));

    const profile = path.join(os.tmpdir(), "nf-edge-auth2"); fs.rmSync(profile, { recursive: true, force: true });
    edge = spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", ["--headless=new", "--remote-debugging-port=9336", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
    let wsUrl; for (let i = 0; i < 150 && !wsUrl; i++) { try { wsUrl = (await (await fetch("http://127.0.0.1:9336/json/list")).json()).find(t => t.type === "page")?.webSocketDebuggerUrl; } catch (e) {} if (!wsUrl) await sleep(200); }
    ws = new WebSocket(wsUrl); await new Promise(r => ws.addEventListener("open", r, { once: true }));
    let id = 0, loads = 0; const pending = new Map(); const reqs = new Map(); const net = []; const exceptions = [];
    ws.addEventListener("message", ev => {
      const m = JSON.parse(ev.data); const p = m.params || {};
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === "Fetch.requestPaused") send("Fetch.continueRequest", { requestId: p.requestId, url: p.request.url.replace("http://localhost:5000", "http://127.0.0.1:5055") });
      if (m.method === "Page.loadEventFired") loads++;
      if (m.method === "Network.requestWillBeSent" && /:50(00|55)\/api\//.test(p.request.url)) reqs.set(p.requestId, { path: p.request.url.replace(/^.*\/api/, "/api"), method: p.request.method, bearer: !!(p.request.headers.Authorization || p.request.headers.authorization) });
      if (m.method === "Network.responseReceived" && reqs.has(p.requestId)) net.push({ ...reqs.get(p.requestId), status: p.response.status });
      if (m.method === "Runtime.exceptionThrown") exceptions.push(p.exceptionDetails.exception?.description?.split("\n")[0]);
    });
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Fetch.enable", { patterns: [{ urlPattern: "http://localhost:5000/*" }] });
    await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
    const ev = async e => (await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value;
    const go = async url => { const b = loads; await send("Page.navigate", { url }); for (let i = 0; i < 150 && loads === b; i++) await sleep(100); await sleep(1500); };
    const waitFor = async (e, ms = 8000) => { for (let t = 0; t < ms; t += 200) { if (await ev(e)) return true; await sleep(200); } return false; };
    const lastNet = (pathPart, method) => [...net].reverse().find(n => n.path.startsWith(pathPart) && (!method || n.method === method));
    const fill = (pairs) => `(()=>{${pairs.map(([i, v]) => `{const e=document.getElementById("${i}"); e.value=${JSON.stringify(v)}; e.dispatchEvent(new Event("input",{bubbles:true}));}`).join("")} return true;})()`;
    const submitRegister = () => ev(`document.getElementById("fullname").closest("form").querySelector("button[type=submit]").click(); true`);
    const submitLogin = () => ev(`document.getElementById("email").closest("form").querySelector("button[type=submit]").click(); true`);
    const regMsg = () => ev(`[...document.querySelectorAll(".field-error,.form-notice,.form-success")].map(e=>e.textContent.trim()).filter(Boolean).join(" | ")`);

    /* 17. Google UI hidden (checked first, on clean pages) */
    await go(`${FRONT}/login.html`);
    const gLogin = await ev(`({ hidden: document.getElementById("google-auth-block").hidden, dividerVisible: !!document.querySelector(".auth-divider") && document.querySelector(".auth-divider").offsetParent !== null })`);
    await go(`${FRONT}/register.html`);
    const gReg = await ev(`({ hidden: document.getElementById("google-auth-block").hidden, dividerVisible: document.querySelector(".auth-divider").offsetParent !== null })`);
    check("17. Google block + 'OR' divider hidden (login & register)", gLogin.hidden && !gLogin.dividerVisible && gReg.hidden && !gReg.dividerVisible, JSON.stringify({ gLogin, gReg }));

    /* 13/14. Front-end validation */
    await ev(fill([["fullname", "Auth E2E"], ["reg-email", "not-an-email@"], ["phone", "0200000000"], ["reg-password", "123"], ["confirm-password", "123"]]));
    const native = await ev(`({ blocked: !document.getElementById("fullname").closest("form").checkValidity(), msg: document.getElementById("reg-email").validationMessage })`);
    check("13. invalid email blocked by the form (browser validation message)", native.blocked && native.msg.length > 0, native.msg);
    await ev(fill([["reg-email", `valid-${stamp}@gmail.com`]]));
    await submitRegister(); await sleep(500);
    const v1 = await regMsg();
    check("14. short password rejected in the form (custom message)", /at least 6/i.test(v1) && !net.some(n => n.path === "/api/register"), v1);
    const apiShort = await (await fetch("http://127.0.0.1:5055/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ fullName: "X", email: `x${stamp}@gmail.com`, password: "123" }) })).json();
    check("14b. short password rejected by the API", /at least 6/.test(apiShort.error), apiShort.error);

    /* 1–3. Register a Gmail account via the form */
    await ev(fill([["fullname", "Auth E2E"], ["reg-email", email], ["phone", "0200000000"], ["reg-password", pass1], ["confirm-password", pass1]]));
    await submitRegister();
    await waitFor(`/Account created|check your email/i.test(document.body.innerText)`, 10000);
    const r1 = lastNet("/api/register", "POST");
    check("1. registration request reaches POST /api/register → 201", r1 && r1.status === 201, r1 && `${r1.method} ${r1.path} ${r1.status}`);
    check("1b. MX resolver failure on this PC logged as a warning, not a rejection", /MX lookup for "gmail\.com" could not be completed/.test(serverLog));
    const u = (await q("SELECT id, password_hash, email_verified_at FROM users WHERE email=?", [email]))[0];
    check("2. user created with bcrypt hash ($2b$10$…), unverified", u && /^\$2[aby]\$10\$/.test(u.password_hash) && u.password_hash.length === 60 && u.email_verified_at === null, u && u.password_hash.slice(0, 7));
    const verifyUrl = (serverLog.match(/Verification link \(valid 24 hours\): (\S+)/) || [])[1];
    check("3. verification link printed to the backend console", !!verifyUrl && verifyUrl.startsWith(`${FRONT}/verify-email.html?token=`), verifyUrl && verifyUrl.replace(/token=.*/, "token=…"));
    check("3b. token not exposed to the browser (register response)", !(r1 && JSON.stringify(net).includes("token=")));

    /* 12. Duplicate email */
    await go(`${FRONT}/register.html`);
    await ev(fill([["fullname", "Auth E2E"], ["reg-email", email], ["phone", "0200000000"], ["reg-password", pass1], ["confirm-password", pass1]]));
    await submitRegister(); await waitFor(`/already exists/i.test(document.body.innerText)`, 8000);
    check("12. duplicate email → 409 + message", (lastNet("/api/register", "POST") || {}).status === 409 && /already exists/i.test(await regMsg()), await regMsg());

    /* login before verification */
    await go(`${FRONT}/login.html`);
    await ev(fill([["email", email], ["password", pass1]])); await submitLogin(); await sleep(1500);
    check("unverified login blocked (403) with resend option", (lastNet("/api/login", "POST") || {}).status === 403 && /verify your email/i.test(await ev(`document.body.innerText`)));

    /* 4. Use the verification link */
    await go(verifyUrl);
    await waitFor(`document.getElementById("verify-state-success")?.style.display === "block"`, 8000);
    const verifiedAt = (await q("SELECT email_verified_at FROM users WHERE id=?", [u.id]))[0].email_verified_at;
    check("4. verification link verifies the account (success state shown)", !!verifiedAt && (await ev(`document.getElementById("verify-state-success").style.display`)) === "block", await ev(`document.querySelector("#verify-state-success h1")?.textContent`));

    /* 5–8. Login with existing cart */
    await ev(`localStorage.setItem("neofragrances_cart", JSON.stringify([{id:20,qty:1,offerId:null}])); true`);
    await go(`${FRONT}/login.html?redirect=cart.html`);
    await ev(fill([["email", email], ["password", pass1]]));
    const b = loads; await submitLogin(); for (let i = 0; i < 100 && loads === b; i++) await sleep(100); await sleep(2000);
    check("5. login → 200 and redirected to the bag", (lastNet("/api/login", "POST") || {}).status === 200 && (await ev(`location.pathname.endsWith("cart.html")`)));
    const auth = JSON.parse(await ev(`localStorage.getItem("neofragrances_auth")`) || "null");
    const payload = auth?.token ? JSON.parse(Buffer.from(auth.token.split(".")[1], "base64url").toString()) : null;
    check("6. JWT stored and identifies the user", payload && payload.id === u.id && payload.role === "customer", payload && JSON.stringify(payload));
    check("7. header account icon → My Account", await ev(`!!document.querySelector('.nav-icons a[href="my-account.html"]')`));
    check("8. cart survived login", await ev(`localStorage.getItem("neofragrances_cart")`) === '[{"id":20,"qty":1,"offerId":null}]');

    /* 9–11. Delivery + payment */
    await waitFor(`!!document.getElementById("address-form")`);
    check("6b. authenticated request sends the JWT (GET /api/addresses)", !!net.find(n => n.path === "/api/addresses" && n.method === "GET" && n.bearer && n.status === 200));
    await ev(fill([["addr-name", "Auth E2E"], ["addr-line1", "5 Test Lane"], ["addr-city", "Kumasi"]]));
    await ev(`document.getElementById("save-address-btn").click(); true`);
    await waitFor(`!!document.querySelector(".nf-address.is-selected")`);
    check("9. delivery address added and selected", await ev(`!!document.querySelector(".nf-address.is-selected")`) && (lastNet("/api/addresses", "POST") || {}).status === 201);
    await waitFor(`document.querySelector("#steps-bar [aria-current=step]")?.dataset.step === "payment"`);
    check("10. Bag → Delivery → Payment reached, Pay enabled", (await ev(`document.querySelector("#steps-bar [aria-current=step]")?.dataset.step`)) === "payment" && !(await ev(`document.getElementById("checkout-btn").disabled`)), await ev(`document.getElementById("checkout-btn-label").textContent`));
    await ev(`document.getElementById("checkout-btn").click(); true`);
    await waitFor(`!document.getElementById("summary-alert").hidden`);
    const init = lastNet("/api/payments/initialize", "POST");
    check("11. only remaining blocker: Paystack not configured (503)", init && init.status === 503 && init.bearer && /Payments are not available/.test(await ev(`document.getElementById("summary-alert").textContent`)), init && `${init.status} — ${await ev(`document.getElementById("summary-alert").textContent`)}`);
    check("11b. still logged in after the payment attempt", await ev(`!!localStorage.getItem("neofragrances_auth")`));

    /* 16. Logout */
    await ev(`logoutUser(); true`); await sleep(1500);
    check("16. logout clears the session, cart kept", (await ev(`localStorage.getItem("neofragrances_auth")`)) === null && (await ev(`localStorage.getItem("neofragrances_cart")`)) === '[{"id":20,"qty":1,"offerId":null}]');

    /* 15. Forgot password → printed link → reset → login with new password */
    await go(`${FRONT}/forgot-password.html`);
    await ev(`(()=>{const i=document.querySelector("input[type=email]"); i.value=${JSON.stringify(email)}; i.closest("form").querySelector("button[type=submit]").click(); return true;})()`);
    await waitFor(`/If an account exists/.test(document.body.innerText)`, 8000);
    await sleep(800);
    const resetUrl = (serverLog.match(/Reset link \(valid 1 hour\): (\S+)/) || [])[1];
    check("15. forgot-password: generic message + reset link printed to console", !!resetUrl && /If an account exists/.test(await ev(`document.body.innerText`)), resetUrl && resetUrl.replace(/token=.*/, "token=…"));
    check("15b. reset token not exposed to the browser", !(await ev(`document.body.innerText.includes("token=")`)));
    await go(resetUrl);
    const pwInputs = await ev(`[...document.querySelectorAll("input[type=password]")].map(i=>i.id)`);
    await ev(`(()=>{const ins=[...document.querySelectorAll("input[type=password]")]; ins.forEach(i=>{i.value=${JSON.stringify(pass2)}; i.dispatchEvent(new Event("input",{bubbles:true}));}); ins[0].closest("form").querySelector("button[type=submit]").click(); return true;})()`);
    await sleep(2500);
    check("15c. reset page accepts a new password", (lastNet("/api/reset-password", "POST") || {}).status === 200, `inputs ${JSON.stringify(pwInputs)}`);
    const oldLogin = await (await fetch("http://127.0.0.1:5055/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: pass1 }) })).status;
    const newLogin = await (await fetch("http://127.0.0.1:5055/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: pass2 }) })).status;
    check("15d. old password rejected, new password works", oldLogin === 401 && newLogin === 200, `old ${oldLogin}, new ${newLogin}`);

    check("no JavaScript exceptions during the flow", exceptions.length === 0, exceptions.slice(0, 2).join(" | "));
  } catch (e) {
    console.error("HARNESS ERROR:", e); results.push(false);
  } finally {
    try {
      const ids = (await q("SELECT id FROM users WHERE email LIKE ?", [`nf-auth-e2e-${stamp}%`])).map(r => r.id);
      if (ids.length) {
        for (const t of ["addresses", "email_verifications", "password_resets", "wishlist", "reviews"]) await q(`DELETE FROM ${t} WHERE user_id IN (?)`, [ids]);
        await q("DELETE FROM users WHERE id IN (?)", [ids]);
      }
      const c = (await q("SELECT (SELECT COUNT(*) FROM users) u,(SELECT COUNT(*) FROM addresses) a,(SELECT COUNT(*) FROM orders) o,(SELECT COUNT(*) FROM email_verifications) ev,(SELECT COUNT(*) FROM password_resets) pr"))[0];
      console.log("\ncleanup:", JSON.stringify(c));
    } catch (e) { console.error("CLEANUP ERROR", e.message); }
    try { ws && ws.close(); } catch (e) {}
    if (edge) edge.kill(); iso.stopServer(server); await pool.end();
    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ""}`);
    process.exit(failed ? 1 : 0);
  }
})();
