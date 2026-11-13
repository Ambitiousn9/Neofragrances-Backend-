// Milestone 5 admin browser suite: real admin pages (:5500/admin) + updated server.js (:5059,
// random JWT secret, LOCAL db) + headless Edge. Browser calls to :5000 are rerouted to :5059.
// All fixtures are removed and stock restored afterwards; the DB must return to its baseline.
const path = require("path"), fs = require("fs"), os = require("os"), crypto = require("crypto");
const { spawn } = require("child_process");
// This file lives in <repo>/tests, so default to the repo root above it: the suite then
// runs as `node tests/<file>` with nothing set. An explicit SERVER_DIR still wins.
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
// T04: runs ONLY under the isolated-database guard (nf_test_* on 127.0.0.1:3308; see
// tests/README.md, "Isolated test database"). Checked before dotenv and db.js load.
const iso = require("./support/isolated-suite");
iso.requireIsolation("admin-e2e.js");
require(path.join(process.cwd(), "node_modules/dotenv")).config({ quiet: true });
const jwt = require(path.join(process.cwd(), "node_modules/jsonwebtoken"));
const bcrypt = require(path.join(process.cwd(), "node_modules/bcrypt"));
const pool = require(path.join(process.cwd(), "db"));
if (!["localhost", "127.0.0.1"].includes(process.env.DB_HOST)) { console.error("not local"); process.exit(1); }
const FRONT = "http://127.0.0.1:5500", ADM = `${FRONT}/admin`, API = "http://127.0.0.1:5059";
const SECRET = crypto.randomBytes(32).toString("hex");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = async (s, p) => (await pool.query(s, p))[0];
const results = []; const check = (n, c, x = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"} ${n}${x !== "" ? "  [" + String(x).slice(0, 170) + "]" : ""}`); };
const SHOTS = path.join(__dirname, "m5-shots"); fs.mkdirSync(SHOTS, { recursive: true });
const BASE_SQL = "SELECT (SELECT COUNT(*) FROM users) u,(SELECT COUNT(*) FROM products) p,(SELECT COUNT(*) FROM orders) o,(SELECT COUNT(*) FROM order_items) oi,(SELECT COUNT(*) FROM addresses) a,(SELECT COUNT(*) FROM reviews) r,(SELECT COUNT(*) FROM offers) f,(SELECT COUNT(*) FROM offer_products) fp,(SELECT COUNT(*) FROM coupons) c,(SELECT SUM(stock_qty) FROM products) s";

(async () => {
  await iso.verifyParentIdentity(pool, "admin-e2e.js");
  const stamp = Date.now(); const userIds = [], productIds = [], orderIds = [];
  let server, edge, ws;
  const baseline = (await q(BASE_SQL))[0];
  try {
    /* ---------- seed ---------- */
    const adminPass = "AdminPass-" + stamp;
    const mkUser = async (name, role, pass) => { const id = (await q("INSERT INTO users (full_name, email, phone, password_hash, role, email_verified_at, auth_provider) VALUES (?, ?, '0244123456', ?, ?, NOW(), 'local')", [name, `nf-m5-${name.toLowerCase().replace(/\s/g, "")}-${stamp}@gmail.com`, await bcrypt.hash(pass || "Secret123", 10), role])).insertId; userIds.push(id); return id; };
    const ADMIN = await mkUser("Ama Admin", "admin", adminPass), CUST = await mkUser("Yaw Mensah", "customer");
    const adminEmail = `nf-m5-amaadmin-${stamp}@gmail.com`;
    const mkProduct = async (name, stock, price) => { const id = (await q("INSERT INTO products (name, brand, category, price, stock_qty, image) VALUES (?, 'M5 Test House', 'unisex', ?, ?, 'images/perfumes/velvet-oud.jpg')", [name, price, stock])).insertId; productIds.push(id); return id; };
    const P_LOW = await mkProduct(`M5 Low Amber ${stamp}`, 3, 300), P_OK = await mkProduct(`M5 Rich Oud ${stamp}`, 40, 500);
    const addr = (await q("INSERT INTO addresses (user_id, label, full_name, phone, address_line1, city, region, country, is_default) VALUES (?, 'Home', 'Yaw Mensah', '0244123456', '7 Admin Test Lane', 'Accra', 'Greater Accra', 'Ghana', 1)", [CUST])).insertId;
    const mkOrder = async (status, items, ref) => {
      const total = items.reduce((s, [, qn, pr]) => s + qn * pr, 0) + 25;
      const id = (await q("INSERT INTO orders (user_id, address_id, total, status, payment_reference) VALUES (?, ?, ?, ?, ?)", [CUST, addr, total, status, ref])).insertId; orderIds.push(id);
      for (const [pid, qn, pr] of items) await q("INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES (?, ?, ?, ?)", [id, pid, qn, pr]);
      return id;
    };
    const O1 = await mkOrder("Pending", [[P_OK, 2, 500], [P_LOW, 1, 300]], `NF-M5-${stamp}-A`);
    const O2 = await mkOrder("Delivered", [[P_OK, 1, 500]], `NF-M5-${stamp}-B`);
    const REV = (await q("INSERT INTO reviews (product_id, user_id, rating, comment, is_verified_purchase) VALUES (?, ?, 4, 'Lovely amber, M5 test', 1)", [P_LOW, CUST])).insertId;
    await q("UPDATE products SET avg_rating = 4.0, review_count = 1 WHERE id = ?", [P_LOW]);
    const tok = (id, role, exp = "1h") => jwt.sign({ id, role }, SECRET, { expiresIn: exp });

    /* ---------- server + browser ---------- */
    server = await iso.startGuardedServer({ suite: "admin-e2e.js", port: 5059, env: { JWT_SECRET: SECRET, DEV_EMAIL_LOG: "true", PAYSTACK_SECRET_KEY: "", GOOGLE_CLIENT_ID: "", FRONTEND_URL: FRONT, NODE_ENV: "" } });
    const profile = path.join(os.tmpdir(), "nf-edge-m5"); fs.rmSync(profile, { recursive: true, force: true });
    edge = spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", ["--headless=new", "--remote-debugging-port=9339", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
    let wsUrl; for (let i = 0; i < 150 && !wsUrl; i++) { try { wsUrl = (await (await fetch("http://127.0.0.1:9339/json/list")).json()).find(t => t.type === "page")?.webSocketDebuggerUrl; } catch (e) {} if (!wsUrl) await sleep(200); }
    ws = new WebSocket(wsUrl); await new Promise(r => ws.addEventListener("open", r, { once: true }));
    let id = 0, loads = 0; const pending = new Map(); const reqs = new Map(); const net = []; const exceptions = []; const consoleErrors = [];
    ws.addEventListener("message", ev => {
      const m = JSON.parse(ev.data); const p = m.params || {};
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === "Fetch.requestPaused") send("Fetch.continueRequest", { requestId: p.requestId, url: p.request.url.replace("http://localhost:5000", API) });
      if (m.method === "Page.loadEventFired") loads++;
      if (m.method === "Network.requestWillBeSent" && /:50(00|59)\/api\//.test(p.request.url)) reqs.set(p.requestId, { path: p.request.url.replace(/^.*\/api/, "/api"), method: p.request.method, doc: p.documentURL || "" });
      if (m.method === "Network.responseReceived" && reqs.has(p.requestId)) net.push({ ...reqs.get(p.requestId), status: p.response.status });
      if (m.method === "Runtime.exceptionThrown") exceptions.push(p.exceptionDetails.exception?.description?.split("\n")[0]);
      if (m.method === "Runtime.consoleAPICalled" && p.type === "error") consoleErrors.push(p.args.map(a => a.value || a.description).join(" ").slice(0, 120));
    });
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Fetch.enable", { patterns: [{ urlPattern: "http://localhost:5000/*" }] });
    const viewport = (w, h, mobile) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
    await viewport(1366, 900, false);
    const ev = async e => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description?.slice(0, 200) }; return r.result?.result?.value; };
    const go = async url => { const b = loads; await send("Page.navigate", { url }); for (let i = 0; i < 150 && loads === b; i++) await sleep(100); await sleep(900); };
    const waitFor = async (e, ms = 8000) => { for (let t = 0; t < ms; t += 150) { const v = await ev(e); if (v && !v.__err) return true; await sleep(150); } return false; };
    const lastNet = (pathPart, method) => [...net].reverse().find(n => n.path.startsWith(pathPart) && (!method || n.method === method));
    const shot = async name => { const r = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(SHOTS, name + ".png"), Buffer.from(r.result.data, "base64")); };
    const setAuth = (token, user) => ev(`localStorage.setItem("neofragrances_auth", ${JSON.stringify(JSON.stringify({ token, user }))}); true`);
    const click = sel => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.scrollIntoView({block:"center"}); e.click(); return true;})()`);
    const key = async (k, code, vk, mods = 0) => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers: mods }); };
    const typeInto = (sel, value) => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); e.value=${JSON.stringify(value)}; e.dispatchEvent(new Event("input",{bubbles:true})); e.dispatchEvent(new Event("change",{bubbles:true})); return true;})()`);
    const dialogOpen = () => waitFor(`!!document.querySelector(".adm-dialog-wrap")`, 4000);
    const a11y = () => ev(`(()=>{
      const inputs=[...document.querySelectorAll("#adm-main input, #adm-main select, #adm-main textarea, .adm-drawer input, .adm-drawer select, .adm-drawer textarea")].filter(i=>i.type!=="hidden" && i.type!=="submit");
      const unlabeled=inputs.filter(i=>!(i.labels&&i.labels.length)&&!i.getAttribute("aria-label")&&!i.closest("label")).map(i=>i.id||i.name);
      const nameless=[...document.querySelectorAll("button, a[href]")].filter(b=>b.offsetParent!==null && !(b.textContent.trim()||b.getAttribute("aria-label"))).map(b=>b.outerHTML.slice(0,60));
      return {h1:document.querySelectorAll("h1").length, unlabeled, nameless, current: document.querySelector('.adm-nav a[aria-current="page"]')?.textContent.trim()||null, skip: !!document.querySelector(".adm-skip")};
    })()`);
    const pageChecks = {};

    /* ---------- 1. access control ---------- */
    await go(`${FRONT}/index.html`); await ev(`localStorage.clear(); true`);
    await go(`${ADM}/orders.html`);
    await waitFor(`location.pathname.endsWith("/admin/login.html")`);
    check("1. logged out → admin page redirects to admin login with return path", (await ev(`location.search`)).includes("redirect=orders.html"), await ev(`location.search`));
    check("1b. fake 'Remember me' removed from admin login", !(await ev(`document.body.innerText.includes("Remember me")`)));
    // a customer whose stored user claims role=admin: server says customer → denied
    await setAuth(tok(CUST, "customer"), { id: CUST, full_name: "Yaw", role: "admin" });
    await go(`${ADM}/dashboard.html`);
    await waitFor(`location.pathname.endsWith("/admin/login.html")`);
    check("1c. tampered client role (customer) → bounced to login with 'no admin access'", (await ev(`location.search`)).includes("denied=1") && (await ev(`document.getElementById("login-notice").hidden`)) === false && (await ev(`localStorage.getItem("neofragrances_auth")`)) === null);
    // customer credentials in the admin login form
    await typeInto("#admin-email", `nf-m5-yawmensah-${stamp}@gmail.com`); await typeInto("#admin-password", "Secret123");
    await click("#admin-login-form [type=submit]");
    check("1d. customer credentials rejected by admin login", await waitFor(`/doesn't have admin access/.test(document.getElementById("admin-login-msg").textContent)`) && (await ev(`localStorage.getItem("neofragrances_auth")`)) === null);

    /* ---------- 2. admin login + dashboard ---------- */
    await go(`${ADM}/login.html?redirect=dashboard.html`);
    await typeInto("#admin-email", adminEmail); await typeInto("#admin-password", adminPass);
    await click("#admin-login-form [type=submit]");
    await waitFor(`location.pathname.endsWith("/admin/dashboard.html") && !!document.querySelector(".adm-kpi")`, 10000);
    check("2. admin signs in through the login form → dashboard", (await ev(`location.pathname`)).endsWith("/admin/dashboard.html"));
    await waitFor(`document.querySelectorAll(".adm-kpi").length >= 8`);
    const summary = await (await fetch(API + "/api/admin/summary", { headers: { Authorization: `Bearer ${tok(ADMIN, "admin")}` } })).json();
    const kpiText = await ev(`document.querySelector(".adm-kpis").innerText`);
    check("2b. dashboard KPIs show real summary numbers", kpiText.includes(String(summary.products.active)) && kpiText.replace(/,/g, "").includes(summary.orders.revenue.toFixed(2)), kpiText.replace(/\n/g, " | ").slice(0, 160));
    check("2c. 'needs attention' alert for pending orders + low stock list has the test product", (await ev(`document.querySelector(".adm-alerts")?.innerText || ""`)).includes("waiting") && (await ev(`document.body.innerText`)).includes(`M5 Low Amber ${stamp}`));
    check("2d. recent orders link to admin order page", await ev(`!!document.querySelector('a[href="order.html?id=${O1}"]')`));
    check("2e. sidebar badges (pending orders, low/out stock) filled from the server", await waitFor(`document.querySelector('[data-nav-count="pending"]').textContent.length > 0 && document.querySelector('[data-nav-count="low_stock"]').textContent.length > 0`));
    pageChecks.dashboard = await a11y();
    check("2f. no 'Couldn't load' state on dashboard", !(await ev(`document.body.innerText.includes("Couldn't load")`)));
    await shot("01-dashboard");

    /* ---------- 3. products ---------- */
    await go(`${ADM}/products.html`);
    await waitFor(`document.querySelectorAll("#p-body tr").length > 1`);
    await typeInto("#p-search", `M5 Low Amber ${stamp}`);
    check("3. product search (debounced) finds the test product", await waitFor(`document.querySelectorAll("#p-body tr").length === 1 && document.getElementById("p-body").innerText.includes("M5 Low Amber")`));
    check("3b. search is kept in the URL", (await ev(`location.search`)).includes("q="));
    await typeInto("#p-search", "");
    await waitFor(`document.querySelectorAll("#p-body tr").length > 2`);
    await click('[data-sort="price"]');
    check("3c. sortable header sets aria-sort", await waitFor(`document.querySelector('th[aria-sort] [data-sort="price"]') !== null`));
    await typeInto("#p-stock", "low");
    check("3d. stock filter 'low' shows only 1–5 unit products", await waitFor(`[...document.querySelectorAll("#p-body tr")].every(r => r.innerText.includes("Low stock"))`));
    await typeInto("#p-stock", "all");
    pageChecks.products = await a11y();
    await click("#add-product");
    await waitFor(`!!document.querySelector(".adm-drawer #product-form")`);
    check("3e. add drawer opens with focus inside", await ev(`!!document.activeElement.closest(".adm-drawer")`));
    pageChecks.productDrawer = await a11y();
    await click("[data-drawer-save]");
    check("3f. empty form → inline error on name, no request", await waitFor(`document.getElementById("pf-name").getAttribute("aria-invalid") === "true"`) && !lastNet("/api/admin/products", "POST"));
    await typeInto("#pf-name", `M5 Created Musk ${stamp}`); await typeInto("#pf-brand", "M5 Test House"); await typeInto("#pf-category", "women");
    await typeInto("#pf-price", "250"); await typeInto("#pf-stock", "12"); await typeInto("#pf-image", "javascript:alert(1)");
    await click("[data-drawer-save]");
    check("3g. server rejects unsafe image path → error on image field", await waitFor(`document.getElementById("pf-image").getAttribute("aria-invalid") === "true"`) && (lastNet("/api/admin/products", "POST") || {}).status === 400);
    await typeInto("#pf-image", "images/perfumes/velvet-oud.jpg");
    await click("[data-drawer-save]");
    await waitFor(`!document.querySelector(".adm-drawer")`);
    const created = (await q("SELECT id, price, stock_qty, category FROM products WHERE name = ?", [`M5 Created Musk ${stamp}`]))[0];
    if (created) productIds.push(created.id);
    check("3h. product created (201) with the entered values", created && Number(created.price) === 250 && created.stock_qty === 12 && created.category === "women", JSON.stringify(created));
    await go(`${ADM}/products.html?q=${encodeURIComponent("M5 Created Musk " + stamp)}`);
    await waitFor(`document.querySelectorAll("#p-body tr").length === 1`);
    await click(`[data-action="edit"][data-id="${created.id}"]`);
    await waitFor(`document.getElementById("pf-price")?.value === "250.00" || document.getElementById("pf-price")?.value === "250"`);
    await typeInto("#pf-price", "275.50");
    await key("Escape", "Escape", 27);
    check("3i. closing a drawer with unsaved changes asks to discard", await dialogOpen());
    await click('[data-dlg="cancel"]');
    await sleep(200);
    check("3j. cancelling the discard keeps the drawer open", await ev(`!!document.querySelector(".adm-drawer")`));
    await click("[data-drawer-save]");
    await waitFor(`!document.querySelector(".adm-drawer")`);
    const edited = (await q("SELECT price, stock_qty FROM products WHERE id = ?", [created.id]))[0];
    check("3k. product edited (price saved, stock untouched)", Number(edited.price) === 275.5 && edited.stock_qty === 12, JSON.stringify(edited));
    await waitFor(`!!document.querySelector('[data-action="archive"][data-id="${created.id}"]')`);
    await click(`[data-action="archive"][data-id="${created.id}"]`);
    await dialogOpen();
    check("3l. archive asks for confirmation (focus on Cancel)", await ev(`document.activeElement?.dataset.dlg === "cancel"`));
    await key("Tab", "Tab", 9); await key("Tab", "Tab", 9); await key("Tab", "Tab", 9);
    check("3m. focus is trapped inside the dialog", await ev(`!!document.activeElement.closest(".adm-dialog")`));
    await key("Escape", "Escape", 27); await sleep(200);
    check("3n. Escape cancels — product not archived", !(await q("SELECT deleted_at FROM products WHERE id = ?", [created.id]))[0].deleted_at);
    await click(`[data-action="archive"][data-id="${created.id}"]`);
    await dialogOpen(); await click('[data-dlg="ok"]');
    await waitFor(`!document.querySelector('[data-action="archive"][data-id="${created.id}"]')`);
    check("3o. confirmed archive soft-deletes the product", !!(await q("SELECT deleted_at FROM products WHERE id = ?", [created.id]))[0].deleted_at);
    await click('[data-status="archived"]');
    await waitFor(`!!document.querySelector('[data-action="restore"][data-id="${created.id}"]')`);
    await click(`[data-action="restore"][data-id="${created.id}"]`);
    await waitFor(`!document.querySelector('[data-action="restore"][data-id="${created.id}"]')`);
    check("3p. archived tab → restore brings it back", (await q("SELECT deleted_at FROM products WHERE id = ?", [created.id]))[0].deleted_at === null);
    await shot("02-products");

    /* ---------- 4. inventory ---------- */
    await go(`${ADM}/inventory.html?stock=low`);
    await waitFor(`!!document.querySelector('[data-stock-input="${P_LOW}"]')`);
    check("4. low-stock tab lists the 3-unit product", await ev(`document.querySelector('[data-stock="low"]').getAttribute("aria-pressed") === "true"`));
    await click(`[data-row="${P_LOW}"] [data-step="1"]`); await click(`[data-row="${P_LOW}"] [data-step="1"]`);
    check("4b. stepper shows Save + Undo once changed", await ev(`!document.querySelector('[data-save="${P_LOW}"]').hidden && !document.querySelector('[data-reset="${P_LOW}"]').hidden`));
    await click(`[data-save="${P_LOW}"]`);
    await waitFor(`document.querySelector('[data-save="${P_LOW}"]')?.hidden === true`);
    check("4c. save sends an adjustment (+2) and persists", (await q("SELECT stock_qty FROM products WHERE id = ?", [P_LOW]))[0].stock_qty === 5 && (lastNet(`/api/admin/products/${P_LOW}/stock`, "PATCH") || {}).status === 200);
    await q("UPDATE products SET stock_qty = 1 WHERE id = ?", [P_LOW]); // a sale happened elsewhere
    await typeInto(`[data-stock-input="${P_LOW}"]`, "0");
    await click(`[data-save="${P_LOW}"]`);
    await sleep(1200);
    check("4d. adjustment that would go below 0 is refused and the real value reloaded", (await q("SELECT stock_qty FROM products WHERE id = ?", [P_LOW]))[0].stock_qty === 1 && (lastNet(`/api/admin/products/${P_LOW}/stock`, "PATCH") || {}).status === 400);
    await q("UPDATE products SET stock_qty = 3 WHERE id = ?", [P_LOW]);
    pageChecks.inventory = await a11y();

    /* ---------- 5. orders ---------- */
    await go(`${ADM}/orders.html`);
    await typeInto("#o-search", `NF-M5-${stamp}`);
    check("5. order search by payment reference (server-side)", await waitFor(`document.querySelectorAll("#o-body tr").length === 2 && document.getElementById("o-count").textContent.startsWith("2 ")`));
    await click('[data-status="Delivered"]');
    check("5b. status tab filters", await waitFor(`document.querySelectorAll("#o-body tr").length === 1 && document.getElementById("o-body").innerText.includes("#${O2}")`));
    check("5c. filters kept in the URL", (await ev(`location.search`)).includes("status=Delivered"));
    pageChecks.orders = await a11y();
    await go(`${ADM}/order.html?id=${O1}`);
    await waitFor(`!!document.getElementById("status-form")`);
    const otext = await ev(`document.getElementById("page-root").innerText`);
    check("5d. order details: items, totals, customer, address, payment reference", otext.includes(`M5 Rich Oud ${stamp}`) && otext.includes("7 Admin Test Lane") && otext.includes(`NF-M5-${stamp}-A`) && otext.includes("Yaw Mensah") && /Total paid/.test(otext));
    check("5e. contact links (email, call, WhatsApp 233…)", await ev(`!!document.querySelector('a[href^="mailto:"]') && !!document.querySelector('a[href^="tel:"]') && !!document.querySelector('a[href="https://wa.me/233244123456"]')`));
    pageChecks.order = await a11y();
    await typeInto("#status-select", "Shipped");
    await click("#status-form [type=submit]");
    await dialogOpen(); await click('[data-dlg="ok"]');
    await waitFor(`document.getElementById("page-title").innerText.includes("Shipped")`);
    check("5f. status updated to Shipped (after confirmation)", (await q("SELECT status FROM orders WHERE id = ?", [O1]))[0].status === "Shipped");
    // Phase 5: a shipped order can no longer be cancelled (it used to be, with a restock).
    const stockShipped = await q("SELECT id, stock_qty FROM products WHERE id IN (?, ?) ORDER BY id", [P_LOW, P_OK]);
    check("5f2. shipped order: Cancelled is not offered, and the page says why", await waitFor(`![...document.querySelectorAll("#status-select option")].some(o => o.value === "Cancelled") && /Shipped orders can't be cancelled/.test(document.getElementById("status-form").innerText)`));
    const blocked = await fetch(`${API}/api/admin/orders/${O1}/status`, { method: "PATCH", headers: { "Content-Type": "application/json", Authorization: `Bearer ${tok(ADMIN, "admin")}` }, body: JSON.stringify({ status: "Cancelled", note: "Trying to cancel after dispatch" }) });
    const blockedBody = await blocked.json().catch(() => ({}));
    const stockShippedAfter = await q("SELECT id, stock_qty FROM products WHERE id IN (?, ?) ORDER BY id", [P_LOW, P_OK]);
    check("5f3. Shipped → Cancelled refused (409 ORDER_NOT_CANCELLABLE): still Shipped, no restock", blocked.status === 409 && blockedBody.code === "ORDER_NOT_CANCELLABLE" && (await q("SELECT status FROM orders WHERE id = ?", [O1]))[0].status === "Shipped" && JSON.stringify(stockShipped) === JSON.stringify(stockShippedAfter), `${blocked.status} ${JSON.stringify(blockedBody)}`);
    // Moving back to Processing is a correction: it needs a note.
    await typeInto("#status-select", "Processing");
    await click("#status-form [type=submit]");
    check("5f4. moving back without a note: inline note error, no dialog, nothing saved", await waitFor(`/note explaining why/.test(document.querySelector('[data-error-for="note"]').textContent)`) && !(await ev(`!!document.querySelector(".adm-dialog-wrap")`)) && (await q("SELECT status FROM orders WHERE id = ?", [O1]))[0].status === "Shipped");
    await typeInto("#status-note", "Sent to the wrong courier — repacking");
    await click("#status-form [type=submit]");
    await dialogOpen(); await click('[data-dlg="ok"]');
    await waitFor(`document.getElementById("page-title").innerText.includes("Processing")`);
    check("5f5. correction Shipped → Processing saved with its note", (await q("SELECT status FROM orders WHERE id = ?", [O1]))[0].status === "Processing" && (await q("SELECT note FROM order_status_history WHERE order_id = ? ORDER BY id DESC LIMIT 1", [O1]))[0]?.note === "Sent to the wrong courier — repacking");
    const stockBefore = await q("SELECT id, stock_qty FROM products WHERE id IN (?, ?) ORDER BY id", [P_LOW, P_OK]);
    await typeInto("#status-select", "Cancelled");
    check("5g. choosing Cancelled turns the button into a danger 'Cancel order'", await ev(`document.querySelector("#status-form [type=submit]").classList.contains("adm-btn--danger")`));
    await typeInto("#status-note", "Customer cancelled before dispatch");
    await click("#status-form [type=submit]");
    await dialogOpen();
    check("5h. cancel confirmation explains restock + finality", /returned to stock/.test(await ev(`document.getElementById("adm-dlg-text").textContent`)));
    await click('[data-dlg="ok"]');
    await waitFor(`!document.getElementById("status-form")`);
    const stockAfter = await q("SELECT id, stock_qty FROM products WHERE id IN (?, ?) ORDER BY id", [P_LOW, P_OK]);
    const diff = pid => stockAfter.find(s => s.id === pid).stock_qty - stockBefore.find(s => s.id === pid).stock_qty;
    check("5i. cancelled → items returned to stock (+1, +2) and order shown as final", diff(P_LOW) === 1 && diff(P_OK) === 2 && /cancelled orders are final/i.test(await ev(`document.getElementById("page-root").innerText`)));
    const htext = await ev(`document.getElementById("h-history")?.closest(".adm-panel")?.innerText || ""`);
    check("5i2. status history panel: every change, with its note and the admin's name", (htext.match(/by Ama Admin/g) || []).length === 3 && htext.includes("Sent to the wrong courier — repacking") && htext.includes("Customer cancelled before dispatch"), htext.slice(0, 200));
    await go(`${ADM}/order.html?id=999999999`);
    check("5j. unknown order → not-found state", await waitFor(`/doesn't exist/.test(document.getElementById("page-root").innerText)`));
    await shot("03-order");

    /* ---------- 6. customers ---------- */
    await go(`${ADM}/customers.html`);
    await typeInto("#c-search", `nf-m5-yawmensah-${stamp}`);
    check("6. customer search", await waitFor(`document.querySelectorAll("#c-body tr").length === 1`));
    check("6b. customer list shows no password data", !(await ev(`document.body.innerHTML`)).match(/password_hash|\$2b\$/));
    pageChecks.customers = await a11y();
    await click(`a[href="customer.html?id=${CUST}"]`);
    await waitFor(`location.pathname.endsWith("customer.html") && document.getElementById("page-title").textContent.includes("Yaw")`);
    const ctext = await ev(`document.getElementById("page-root").innerText`);
    check("6c. customer page: order history + saved address", ctext.includes(`#${O1}`) && ctext.includes(`#${O2}`) && ctext.includes("7 Admin Test Lane"));
    pageChecks.customer = await a11y();

    /* ---------- 7. reviews ---------- */
    await go(`${ADM}/reviews.html`);
    await typeInto("#r-search", "M5 test");
    await waitFor(`!!document.querySelector('[data-delete="${REV}"]')`);
    pageChecks.reviews = await a11y();

    /* ---------- 7h. hide / unhide (Milestone 6 Phase 3) ---------- */
    const revBadge = () => ev(`(()=>{const b=document.querySelector('[data-visibility="${REV}"]'); if(!b) return null; const tr=b.closest("tr"); return tr&&tr.querySelector(".adm-badge--live, .adm-badge--disabled") ? tr.querySelector(".adm-badge--live, .adm-badge--disabled").textContent.trim() : null;})()`);
    check("7h. a visible review shows a 'Visible' badge and a Hide action", (await revBadge()) === "Visible" && (await ev(`document.querySelector('[data-visibility="${REV}"]').textContent.trim()`)) === "Hide", await revBadge());
    await click(`[data-visibility="${REV}"]`);
    await waitFor(`document.querySelector('[data-visibility="${REV}"]')?.textContent.trim() === "Unhide"`);
    check("7i. Hide updates the row without a reload (badge Hidden, action Unhide)", (await revBadge()) === "Hidden", await revBadge());
    const hiddenRow = (await q("SELECT hidden FROM reviews WHERE id = ?", [REV]))[0];
    const prHidden = (await q("SELECT avg_rating, review_count FROM products WHERE id = ?", [P_LOW]))[0];
    check("7j. hidden = 1 persisted and the product aggregate dropped to 0 / 0", Number(hiddenRow.hidden) === 1 && prHidden.review_count === 0 && Number(prHidden.avg_rating) === 0, JSON.stringify(prHidden));
    const pubHidden = await (await fetch(`${API}/api/products/${P_LOW}/reviews`)).json();
    check("7k. the storefront review endpoint no longer returns the hidden review or its text", !pubHidden.some(x => x.id === REV) && !JSON.stringify(pubHidden).includes("Lovely amber, M5 test"), JSON.stringify(pubHidden.map(x => x.id)));
    await typeInto("#r-visibility", "hidden");
    await waitFor(`!!document.querySelector('[data-visibility="${REV}"]')`);
    check("7l. the Hidden visibility filter still lists the hidden review for the admin", await ev(`document.getElementById("r-body").innerText.includes("Hidden")`));
    await typeInto("#r-visibility", "visible");
    await waitFor(`!document.querySelector('[data-visibility="${REV}"]')`);
    check("7m. the Visible filter excludes the hidden review", true);
    await typeInto("#r-visibility", "all");
    await waitFor(`!!document.querySelector('[data-visibility="${REV}"]')`);
    await click(`[data-visibility="${REV}"]`);
    await waitFor(`document.querySelector('[data-visibility="${REV}"]')?.textContent.trim() === "Hide"`);
    const prBack = (await q("SELECT avg_rating, review_count FROM products WHERE id = ?", [P_LOW]))[0];
    check("7n. Unhide restores the badge and the product aggregate (4.0 / 1)", (await revBadge()) === "Visible" && prBack.review_count === 1 && Number(prBack.avg_rating) === 4, JSON.stringify(prBack));

    await click(`[data-delete="${REV}"]`);
    await dialogOpen();
    check("7. delete review asks for confirmation (danger)", await ev(`document.querySelector('[data-dlg="ok"]').classList.contains("adm-btn--danger")`));
    await click('[data-dlg="ok"]');
    await waitFor(`!document.querySelector('[data-delete="${REV}"]')`);
    const pr = (await q("SELECT avg_rating, review_count FROM products WHERE id = ?", [P_LOW]))[0];
    check("7b. review deleted and product rating/count recalculated", (await q("SELECT COUNT(*) n FROM reviews WHERE id = ?", [REV]))[0].n === 0 && pr.review_count === 0 && Number(pr.avg_rating) === 0);

    /* ---------- 8. offers ---------- */
    await go(`${ADM}/special-offers.html`);
    await waitFor(`!!document.getElementById("f-body")`);
    await click("#new-offer");
    await waitFor(`!!document.getElementById("offer-form")`);
    pageChecks.offerDrawer = await a11y();
    await typeInto("#of-title", `M5 Test Offer ${stamp}`);
    // Multi-product editor (M6 Phase 6C): search by product ID, arrow to it, Enter adds a row.
    await typeInto("#of-product-search", `#${P_OK}`);
    await ev(`(()=>{const s=document.getElementById("of-product-search"); for (const k of ["ArrowDown","Enter"]) s.dispatchEvent(new KeyboardEvent("keydown",{key:k,bubbles:true,cancelable:true})); return true;})()`);
    const ofRow = `#of-items > .adm-op-row[data-pid="${P_OK}"]`;
    check("8. choosing a product pre-fills its current price", (await ev(`document.querySelector('${ofRow} [data-k="original_price"]')?.value`)) === "500.00");
    await typeInto(`${ofRow} [data-k="sale_price"]`, "600");
    check("8b. live discount hint warns when sale > original", /higher than the original/.test(await ev(`document.querySelector('${ofRow} [data-op-off]').textContent`)));
    await click("[data-drawer-save]");
    check("8c. client blocks sale > original before sending", await waitFor(`document.querySelector('${ofRow} [data-k="sale_price"]').getAttribute("aria-invalid") === "true"`) && !lastNet("/api/admin/offers", "POST"));
    await typeInto(`${ofRow} [data-k="sale_price"]`, "420");
    await click("[data-drawer-save]");
    await waitFor(`!document.querySelector(".adm-drawer")`);
    const offer = (await q("SELECT o.id, o.active, op.sale_price FROM offers o JOIN offer_products op ON op.offer_id = o.id WHERE o.title = ?", [`M5 Test Offer ${stamp}`]))[0];
    check("8d. offer created and listed as Live", offer && Number(offer.sale_price) === 420 && await waitFor(`document.getElementById("f-body").innerText.includes("M5 Test Offer") && document.getElementById("f-body").innerText.includes("Live")`));
    const pub = await (await fetch(API + "/api/offers/active")).json();
    check("8e. live offer is served to the store", pub.some(o => o.id === offer.id));
    await click(`[data-action="toggle"][data-id="${offer.id}"]`);
    await waitFor(`!!document.querySelector('[data-action="toggle"][data-id="${offer.id}"]') && document.querySelector('[data-action="toggle"][data-id="${offer.id}"]').textContent === "Activate"`);
    const pub2 = await (await fetch(API + "/api/offers/active")).json();
    check("8f. deactivate → Inactive and hidden from the store", !pub2.some(o => o.id === offer.id));
    await click(`[data-action="feature"][data-id="${offer.id}"]`);
    await waitFor(`document.querySelector('[data-action="feature"][data-id="${offer.id}"]')?.textContent === "Unfeature"`);
    check("8g. feature toggle persists", (await q("SELECT featured FROM offers WHERE id = ?", [offer.id]))[0].featured === 1);
    pageChecks.offers = await a11y();
    await click(`[data-action="delete"][data-id="${offer.id}"]`);
    await dialogOpen(); await click('[data-dlg="ok"]');
    await waitFor(`!document.querySelector('[data-action="delete"][data-id="${offer.id}"]')`);
    check("8h. confirmed delete removes the offer", (await q("SELECT COUNT(*) n FROM offers WHERE id = ?", [offer.id]))[0].n === 0);
    await shot("04-offers");

    /* ---------- 8i. coupons (Milestone 6, migration 002) ---------- */
    await go(`${ADM}/coupons.html`);
    await waitFor(`!!document.getElementById("f-body")`);
    check("8i. Coupons sits under Catalog, directly after Special offers", await ev(`(()=>{const g=[...document.querySelectorAll(".adm-nav-group")].find(x=>x.querySelector(".adm-nav-title")?.textContent.trim()==="Catalog"); if(!g) return false; const items=[...g.querySelectorAll(".adm-nav a")].map(a=>a.textContent.trim()); return items.indexOf("Coupons") === items.indexOf("Special offers")+1;})()`));

    await click("#new-coupon");
    await waitFor(`!!document.getElementById("coupon-form")`);
    pageChecks.couponDrawer = await a11y();
    const CODE = `M5TEST${stamp}`;
    await typeInto("#cp-code", CODE.toLowerCase());
    await typeInto("#cp-percent", "15");
    await click("[data-drawer-save]");
    await waitFor(`!document.querySelector(".adm-drawer")`);
    const made = (await q("SELECT id, code, discount_percent, active FROM coupons WHERE code = ?", [CODE]))[0];
    check("8j. coupon created, code stored uppercase, active by default", !!made && Number(made.discount_percent) === 15 && Number(made.active) === 1, JSON.stringify(made));
    check("8j2. the list shows the real row from the API (code, discount, usage, status)", await waitFor(`document.getElementById("f-body").innerText.includes(${JSON.stringify(CODE)}) && document.getElementById("f-body").innerText.includes("15% off") && document.getElementById("f-body").innerText.includes("0 used") && document.getElementById("f-body").innerText.includes("Active")`), await ev(`document.getElementById("f-body").innerText.slice(0,120)`));

    await click("#new-coupon");
    await waitFor(`!!document.getElementById("coupon-form")`);
    await typeInto("#cp-code", CODE);
    await typeInto("#cp-percent", "5");
    await click("[data-drawer-save]");
    check("8k. duplicate code: the 409 is shown inline on the code field", await waitFor(`document.querySelector('[data-error-for="code"]')?.textContent.includes("already exists")`), await ev(`document.querySelector('[data-error-for="code"]')?.textContent`));
    check("8k2. the 409 did NOT sign the admin out — still on coupons.html with the drawer open", !(await ev(`location.pathname`)).includes("login") && await ev(`!!document.querySelector(".adm-drawer")`), await ev(`location.pathname + location.search`));
    check("8k3. the duplicate created no second row", Number((await q("SELECT COUNT(*) n FROM coupons WHERE code = ?", [CODE]))[0].n) === 1);
    await click("[data-drawer-cancel]");
    await dialogOpen(); await click('[data-dlg="ok"]');
    await waitFor(`!document.querySelector(".adm-drawer")`);

    await click(`[data-action="edit"][data-id="${made.id}"]`);
    await waitFor(`!!document.getElementById("coupon-form")`);
    await typeInto("#cp-kind", "amount");
    check("8l. switching discount type swaps the visible field", await waitFor(`document.getElementById("cp-amount-field").hidden === false && document.getElementById("cp-percent-field").hidden === true`));
    await typeInto("#cp-amount", "30");
    await typeInto("#cp-limit", "2");
    await click("[data-drawer-save]");
    await waitFor(`!document.querySelector(".adm-drawer")`);
    const couponEdited = (await q("SELECT discount_percent, discount_amount, usage_limit FROM coupons WHERE id = ?", [made.id]))[0];
    check("8l2. edit persists (percentage → fixed amount, usage limit set)", couponEdited.discount_percent === null && Number(couponEdited.discount_amount) === 30 && Number(couponEdited.usage_limit) === 2, JSON.stringify(couponEdited));

    await click(`[data-action="toggle"][data-id="${made.id}"]`);
    await waitFor(`document.querySelector('[data-action="toggle"][data-id="${made.id}"]')?.textContent === "Activate"`);
    check("8m. deactivate → Inactive in the list and active=0 in the database", Number((await q("SELECT active FROM coupons WHERE id = ?", [made.id]))[0].active) === 0 && await ev(`document.getElementById("f-body").innerText.includes("Inactive")`));
    await click(`[data-action="toggle"][data-id="${made.id}"]`);
    await waitFor(`document.querySelector('[data-action="toggle"][data-id="${made.id}"]')?.textContent === "Deactivate"`);
    check("8m2. reactivate restores Active", Number((await q("SELECT active FROM coupons WHERE id = ?", [made.id]))[0].active) === 1);

    await typeInto("#f-search", "zzz-no-such-code");
    check("8n. search filters the list to nothing", await waitFor(`document.getElementById("f-count").textContent.startsWith("0 ")`));
    await typeInto("#f-search", CODE);
    check("8n2. search by code finds the coupon", await waitFor(`document.getElementById("f-count").textContent.startsWith("1 ")`));
    await typeInto("#f-search", "");
    await waitFor(`!document.getElementById("f-count").textContent.startsWith("0 ")`);
    await click(`[data-tab="inactive"]`);
    await waitFor(`document.querySelector('[data-tab="inactive"]')?.getAttribute("aria-pressed") === "true"`);
    check("8n3. the Inactive tab excludes the active coupon", await ev(`!document.getElementById("f-body").innerText.includes(${JSON.stringify(CODE)})`));
    await click(`[data-tab="all"]`);
    await waitFor(`document.querySelector('[data-tab="all"]')?.getAttribute("aria-pressed") === "true"`);

    const usedCode = `M5USED${stamp}`;
    const usedId = (await q("INSERT INTO coupons (code, discount_percent) VALUES (?, 10)", [usedCode])).insertId;
    const usedOrder = (await q("INSERT INTO orders (user_id, coupon_id, total, status, payment_reference) VALUES (?, ?, 50.00, 'Processing', ?)", [CUST, usedId, `M5-COUPON-${stamp}`])).insertId;
    orderIds.push(usedOrder);
    await go(`${ADM}/coupons.html`);
    await waitFor(`!!document.querySelector('[data-action="delete"][data-id="${usedId}"]')`);
    pageChecks.coupons = await a11y();
    await click(`[data-action="delete"][data-id="${usedId}"]`);
    await dialogOpen(); await click('[data-dlg="ok"]');
    // Asserted on the error toast specifically, not document.body: the page's own
    // explanatory note also contains "cannot be deleted", which would pass vacuously.
    check("8o. deleting a coupon used on an order shows the blocked message in an error toast", await waitFor(`!!document.querySelector("#toast-container .toast-error span") && document.querySelector("#toast-container .toast-error span").textContent.includes("cannot be deleted")`), await ev(`document.querySelector("#toast-container .toast-error span")?.textContent`));
    check("8o2. the coupon and the order's coupon_id both survive the blocked delete", Number((await q("SELECT COUNT(*) n FROM coupons WHERE id = ?", [usedId]))[0].n) === 1 && (await q("SELECT coupon_id FROM orders WHERE id = ?", [usedOrder]))[0].coupon_id === usedId);
    check("8o3. the blocked delete did not sign the admin out", !(await ev(`location.pathname`)).includes("login"));

    await click(`[data-action="delete"][data-id="${made.id}"]`);
    await dialogOpen(); await click('[data-dlg="ok"]');
    await waitFor(`!document.querySelector('[data-action="delete"][data-id="${made.id}"]')`);
    check("8p. confirmed delete removes an unused coupon", Number((await q("SELECT COUNT(*) n FROM coupons WHERE id = ?", [made.id]))[0].n) === 0);
    await shot("04b-coupons");

    /* ---------- 9. reports ---------- */
    await go(`${ADM}/reports.html`);
    await waitFor(`!!document.querySelector(".adm-kpis")`);
    const rtext = await ev(`document.getElementById("page-root").innerText`);
    check("9. reports: real sales chart + best sellers from today's orders (cancelled excluded)", await ev(`!!document.querySelector("svg.adm-chart rect.bar")`) && rtext.includes(`M5 Rich Oud ${stamp}`));
    await typeInto("#range", "7");
    await waitFor(`location.search.includes("days=7")`);
    for (let t = 0; t < 40 && !lastNet("/api/admin/reports?days=7", "GET"); t++) await sleep(150);
    check("9b. range change reloads (days=7 in URL + request)", (await ev(`location.search`)).includes("days=7") && (lastNet("/api/admin/reports?days=7", "GET") || {}).status === 200);
    pageChecks.reports = await a11y();
    await shot("05-reports");

    /* ---------- 10. expired session mid-use ---------- */
    await setAuth(tok(ADMIN, "admin", -10), { id: ADMIN, full_name: "Ama Admin", role: "admin" });
    await go(`${ADM}/inventory.html`);
    await waitFor(`location.pathname.endsWith("/admin/login.html")`);
    check("10. expired admin token → admin login with 'session expired' + return path", (await ev(`location.search`)).includes("expired=1") && (await ev(`location.search`)).includes("redirect=inventory.html") && (await ev(`document.getElementById("login-notice").textContent`)).includes("expired"));

    /* ---------- 11. mobile ---------- */
    await setAuth(tok(ADMIN, "admin"), { id: ADMIN, full_name: "Ama Admin", role: "admin" });
    await viewport(390, 844, true);
    const overflow = {};
    for (const [k, u] of Object.entries({ dashboard: "dashboard.html", products: "products.html", inventory: "inventory.html", orders: "orders.html", order: `order.html?id=${O2}`, customers: "customers.html", customer: `customer.html?id=${CUST}`, reviews: "reviews.html", offers: "special-offers.html", coupons: "coupons.html", reports: "reports.html", login: "login.html?expired=1" })) {
      await go(`${ADM}/${u}`); await sleep(500);
      overflow[k] = await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`);
      if (["dashboard", "orders", "order"].includes(k)) await shot(`06-mobile-${k}`);
    }
    check("11. mobile 390px: no horizontal overflow on any admin page", Object.values(overflow).every(Boolean), JSON.stringify(overflow));
    await go(`${ADM}/orders.html`);
    await waitFor(`document.querySelectorAll("#o-body tr").length > 0`);
    check("11b. mobile: tables become cards (header hidden, labelled cells)", await ev(`getComputedStyle(document.querySelector(".adm-table--cards thead")).position === "absolute" && getComputedStyle(document.querySelector("#o-body td[data-label]")).display === "grid"`));
    check("11c. mobile: sidebar hidden until the menu button is used", await ev(`getComputedStyle(document.querySelector(".adm-sidebar")).visibility === "hidden"`));
    await click(".adm-menu-btn");
    await sleep(400);
    check("11d. menu opens the sidebar (aria-expanded=true, focus moves in)", await ev(`document.querySelector(".adm-menu-btn").getAttribute("aria-expanded") === "true" && !!document.activeElement.closest(".adm-sidebar")`));
    await key("Escape", "Escape", 27); await sleep(400);
    check("11e. Escape closes the sidebar and returns focus to the menu button", await ev(`document.querySelector(".adm-menu-btn").getAttribute("aria-expanded") === "false" && document.activeElement === document.querySelector(".adm-menu-btn")`));
    check("11f. mobile touch targets: nav links ≥ 40px", await ev(`[...document.querySelectorAll(".adm-nav a")].every(a => a.getBoundingClientRect().height >= 40)`));
    await viewport(1366, 900, false);

    /* ---------- 12. accessibility summary ---------- */
    const bad = Object.entries(pageChecks).filter(([, v]) => v.h1 !== 1 || v.unlabeled.length || v.nameless.length || !v.skip);
    check("12. a11y on every admin page/drawer: one h1, labelled inputs, named buttons/links, skip link", bad.length === 0, JSON.stringify(bad).slice(0, 200));
    check("12b. sidebar marks the current page (aria-current)", Object.entries(pageChecks).filter(([k]) => !k.endsWith("Drawer")).every(([, v]) => !!v.current), JSON.stringify(Object.fromEntries(Object.entries(pageChecks).map(([k, v]) => [k, v.current]))));
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await go(`${ADM}/products.html`); await waitFor(`!!document.getElementById("add-product")`); await click("#add-product"); await waitFor(`!!document.querySelector(".adm-drawer")`);
    check("12c. reduced motion: drawer doesn't animate", (await ev(`getComputedStyle(document.querySelector(".adm-drawer")).animationName`)) === "none");
    await send("Emulation.setEmulatedMedia", { features: [] });

    check("13. admin pages don't download the public catalog (data-catalog=off)", !net.some(n => n.path === "/api/products" && n.doc.includes("/admin/")), net.filter(n => n.path === "/api/products").map(n => n.doc).join(","));
    check("14. no uncaught JS exceptions", exceptions.length === 0, exceptions.join(" | "));
    check("14b. no console errors", consoleErrors.filter(e => !/Failed to load resource/.test(e)).length === 0, consoleErrors.join(" | "));
  } catch (e) {
    console.error("HARNESS ERROR:", e); results.push(false);
  } finally {
    try {
      await q("DELETE FROM offer_products WHERE offer_id IN (SELECT id FROM offers WHERE title LIKE ?)", [`M5 Test Offer ${stamp}%`]);
      await q("DELETE FROM offers WHERE title LIKE ?", [`M5 Test Offer ${stamp}%`]);
      if (orderIds.length) { await q("DELETE FROM order_items WHERE order_id IN (?)", [orderIds]); await q("DELETE FROM orders WHERE id IN (?)", [orderIds]); }
      await q("DELETE FROM coupons WHERE code LIKE ?", [`M5TEST${stamp}%`]);
      await q("DELETE FROM coupons WHERE code LIKE ?", [`M5USED${stamp}%`]);
      const extraP = (await q("SELECT id FROM products WHERE name LIKE ?", [`M5 % ${stamp}`])).map(r => r.id);
      const allP = [...new Set([...productIds, ...extraP])];
      if (allP.length) { await q("DELETE FROM offer_products WHERE product_id IN (?)", [allP]); await q("DELETE FROM reviews WHERE product_id IN (?)", [allP]); await q("DELETE FROM wishlist WHERE product_id IN (?)", [allP]); await q("DELETE FROM products WHERE id IN (?)", [allP]); }
      if (userIds.length) { for (const t of ["addresses", "wishlist", "reviews", "password_resets", "email_verifications"]) await q(`DELETE FROM ${t} WHERE user_id IN (?)`, [userIds]); await q("DELETE FROM users WHERE id IN (?)", [userIds]); }
      const now = (await q(BASE_SQL))[0];
      console.log("\nbaseline:", JSON.stringify(baseline), "\nafter:   ", JSON.stringify(now));
      check("database back to baseline", JSON.stringify(baseline) === JSON.stringify(now));
    } catch (e) { console.error("CLEANUP ERROR", e.message); results.push(false); }
    try { ws && ws.close(); } catch (e) {}
    if (edge) edge.kill(); iso.stopServer(server); await pool.end();
    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ""}`);
    process.exit(failed ? 1 : 0);
  }
})();
