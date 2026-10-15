// Milestone 4 browser suite: real pages (:5500) + updated server.js (:5057, random JWT secret,
// LOCAL db) + headless Edge. Browser calls to :5000 are rerouted to :5057. Test users are removed afterwards.
const path = require("path"), fs = require("fs"), os = require("os"), crypto = require("crypto");
const { spawn } = require("child_process");
// This file lives in <repo>/tests, so default to the repo root above it: the suite then
// runs as `node tests/<file>` with nothing set. An explicit SERVER_DIR still wins.
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
require(path.join(process.cwd(), "node_modules/dotenv")).config({ quiet: true });
const jwt = require(path.join(process.cwd(), "node_modules/jsonwebtoken"));
const bcrypt = require(path.join(process.cwd(), "node_modules/bcrypt"));
const pool = require(path.join(process.cwd(), "db"));
if (!["localhost", "127.0.0.1"].includes(process.env.DB_HOST)) { console.error("not local"); process.exit(1); }
const FRONT = "http://127.0.0.1:5500", API = "http://127.0.0.1:5057";
const SECRET = crypto.randomBytes(32).toString("hex");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = async (s, p) => (await pool.query(s, p))[0];
const results = []; const check = (n, c, x = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"} ${n}${x !== "" ? "  [" + String(x).slice(0, 160) + "]" : ""}`); };
const SHOTS = path.join(__dirname, "m4-shots"); fs.mkdirSync(SHOTS, { recursive: true });

(async () => {
  const stamp = Date.now(); const ids = []; const orderIds = [];
  let server, edge, ws;
  try {
    /* ---------- seed (local db only) ---------- */
    const hash = await bcrypt.hash("Secret123", 10);
    const mk = async (name, provider) => { const id = (await q("INSERT INTO users (full_name, email, phone, password_hash, role, email_verified_at, auth_provider) VALUES (?, ?, '0200000000', ?, 'customer', NOW(), ?)", [name, `nf-m4e2e-${name.toLowerCase()}-${stamp}@gmail.com`, hash, provider])).insertId; ids.push(id); return id; };
    const A = await mk("Akosua Mensah", "local"), B = await mk("Bob", "local"), G = await mk("Gina", "google");
    const emailA = `nf-m4e2e-akosua mensah-${stamp}@gmail.com`.replace(" ", "");
    await q("UPDATE users SET email = ? WHERE id = ?", [emailA, A]);
    const addr = async (uid, label, def, line) => (await q("INSERT INTO addresses (user_id, label, full_name, phone, address_line1, city, region, country, is_default) VALUES (?, ?, 'Akosua Mensah', '0244000000', ?, 'Accra', 'Greater Accra', 'Ghana', ?)", [uid, label, line, def])).insertId;
    const aHome = await addr(A, "Home", 1, "12 Oxford Street"), aWork = await addr(A, "Work", 0, "5 Ring Road");
    const bHome = await addr(B, "BobHome", 1, "9 Bob Lane");
    const prods = await q("SELECT id, name, image, price, stock_qty FROM products WHERE deleted_at IS NULL AND stock_qty >= 3 ORDER BY id LIMIT 4");
    const [p1, p2, p3, p4] = prods;
    const order = (await q("INSERT INTO orders (user_id, address_id, total, status, payment_reference) VALUES (?, ?, ?, 'Processing', ?)", [A, aHome, Number(p1.price) * 2 + Number(p2.price) + 30, `NF-E2E-${stamp}`])).insertId; orderIds.push(order);
    await q("INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES (?, ?, 2, ?), (?, ?, 1, ?)", [order, p1.id, p1.price, order, p2.id, p2.price]);
    const order2 = (await q("INSERT INTO orders (user_id, address_id, total, status, payment_reference) VALUES (?, ?, ?, 'Delivered', ?)", [A, aHome, p3.price, `NF-E2E2-${stamp}`])).insertId; orderIds.push(order2);
    await q("INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES (?, ?, 1, ?)", [order2, p3.id, p3.price]);
    const orderB = (await q("INSERT INTO orders (user_id, address_id, total, status) VALUES (?, ?, 100.00, 'Pending')", [B, bHome])).insertId; orderIds.push(orderB);
    await q("INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES (?, ?, 1, 100.00)", [orderB, p4.id]);
    await q("INSERT INTO wishlist (user_id, product_id) VALUES (?, ?), (?, ?)", [A, p3.id, A, p4.id]);
    const tok = id => jwt.sign({ id, role: "customer" }, SECRET, { expiresIn: "1h" });

    /* ---------- server + browser ---------- */
    server = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: 5057, JWT_SECRET: SECRET, DEV_EMAIL_LOG: "true", PAYSTACK_SECRET_KEY: "", GOOGLE_CLIENT_ID: "", SENDGRID_API_KEY: "", FRONTEND_URL: FRONT, NODE_ENV: "" }, stdio: "ignore" });
    for (let i = 0; i < 60; i++) { try { await fetch(API + "/"); break; } catch (e) { await sleep(200); } }
    const profile = path.join(os.tmpdir(), "nf-edge-m4"); fs.rmSync(profile, { recursive: true, force: true });
    edge = spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", ["--headless=new", "--remote-debugging-port=9337", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
    let wsUrl; for (let i = 0; i < 150 && !wsUrl; i++) { try { wsUrl = (await (await fetch("http://127.0.0.1:9337/json/list")).json()).find(t => t.type === "page")?.webSocketDebuggerUrl; } catch (e) {} if (!wsUrl) await sleep(200); }
    ws = new WebSocket(wsUrl); await new Promise(r => ws.addEventListener("open", r, { once: true }));
    let id = 0, loads = 0; const pending = new Map(); const reqs = new Map(); const net = []; const exceptions = [];
    ws.addEventListener("message", ev => {
      const m = JSON.parse(ev.data); const p = m.params || {};
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === "Fetch.requestPaused") send("Fetch.continueRequest", { requestId: p.requestId, url: p.request.url.replace("http://localhost:5000", API) });
      if (m.method === "Page.loadEventFired") loads++;
      if (m.method === "Network.requestWillBeSent" && /:50(00|57)\/api\//.test(p.request.url)) reqs.set(p.requestId, { path: p.request.url.replace(/^.*\/api/, "/api"), method: p.request.method });
      if (m.method === "Network.responseReceived" && reqs.has(p.requestId)) net.push({ ...reqs.get(p.requestId), status: p.response.status });
      if (m.method === "Runtime.exceptionThrown") exceptions.push(p.exceptionDetails.exception?.description?.split("\n")[0]);
    });
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Fetch.enable", { patterns: [{ urlPattern: "http://localhost:5000/*" }] });
    const viewport = (w, h, mobile) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
    await viewport(1280, 900, false);
    const ev = async e => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description }; return r.result?.result?.value; };
    const go = async url => { const b = loads; await send("Page.navigate", { url }); for (let i = 0; i < 150 && loads === b; i++) await sleep(100); await sleep(1200); };
    const waitFor = async (e, ms = 8000) => { for (let t = 0; t < ms; t += 150) { if (await ev(e)) return true; await sleep(150); } return false; };
    const lastNet = (pathPart, method) => [...net].reverse().find(n => n.path.startsWith(pathPart) && (!method || n.method === method));
    const shot = async name => { const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); fs.writeFileSync(path.join(SHOTS, name + ".png"), Buffer.from(r.result.data, "base64")); };
    const loginAs = async (uid, user) => { await go(`${FRONT}/index.html`); await ev(`localStorage.setItem("neofragrances_auth", ${JSON.stringify(JSON.stringify({ token: tok(uid), user }))}); localStorage.removeItem("neofragrances_cart"); true`); };
    const click = sel => ev(`(()=>{const e=document.querySelector(${JSON.stringify(sel)}); if(!e) return false; e.click(); return true;})()`);
    const noOverflow = () => ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`);

    /* ---------- 1. access control ---------- */
    await go(`${FRONT}/index.html`); await ev(`localStorage.clear(); true`);
    await go(`${FRONT}/my-account.html#orders`);
    await waitFor(`location.pathname.endsWith("login.html")`);
    check("1. logged out → My Account redirects to login with return path", (await ev(`location.pathname + location.search`)).includes("login.html?redirect=my-account.html"), await ev(`location.search`));
    check("1b. plain logged-out redirect shows no 'session expired' notice", await ev(`document.getElementById("auth-notice").hidden === true`));

    /* ---------- 2. overview ---------- */
    await loginAs(A, { id: A, full_name: "Akosua Mensah", email: emailA, role: "customer" });
    await go(`${FRONT}/my-account.html`);
    await waitFor(`document.querySelectorAll(".nf-tile-num").length === 3 && document.querySelector(".nf-tile-num").textContent.trim() === "2"`);
    const tiles = await ev(`[...document.querySelectorAll(".nf-tile-num")].map(e=>e.textContent.trim())`);
    check("2. overview: greeting + real counts (orders, addresses, wishlist)", JSON.stringify(tiles) === '["2","2","2"]' && /Welcome back, Akosua/.test(await ev(`document.getElementById("account-greeting").textContent`)), JSON.stringify(tiles));
    check("2b. overview: recent orders link to order.html?id", await ev(`!!document.querySelector('#overview-body a[href="order.html?id=${order}"]')`));
    check("2c. nav marks current section (aria-current)", await ev(`document.querySelector('.nf-account-nav a[aria-current="page"]')?.dataset.section === "overview"`));
    await shot("01-overview-desktop");

    /* ---------- 3. profile ---------- */
    await go(`${FRONT}/my-account.html#profile`);
    await waitFor(`!!document.querySelector("[data-action=edit-profile]")`);
    check("3. profile shows real data; email read-only note", (await ev(`document.getElementById("profile-body").textContent`)).includes(emailA));
    await click("[data-action=edit-profile]");
    await waitFor(`!!document.getElementById("profile-form")`);
    check("3b. email field is read-only in the edit form", await ev(`document.getElementById("pf-email").readOnly === true`));
    await ev(`(()=>{const f=document.getElementById("profile-form"); f.fullName.value="Akosua A. Mensah"; f.phone.value="call me"; f.querySelector("[type=submit]").click(); return true;})()`);
    await waitFor(`document.querySelector("#profile-form .nf-form-status")?.textContent.length > 0`);
    check("3c. invalid phone → inline error, field marked invalid", await ev(`document.getElementById("pf-phone").getAttribute("aria-invalid") === "true"`), await ev(`document.querySelector("#profile-form .nf-form-status").textContent`));
    await ev(`(()=>{const f=document.getElementById("profile-form"); f.phone.value="+233 24 111 2222"; f.querySelector("[type=submit]").click(); return true;})()`);
    await waitFor(`!document.getElementById("profile-form")`);
    const dbUser = (await q("SELECT full_name, phone FROM users WHERE id = ?", [A]))[0];
    check("3d. profile saved (PATCH 200) and persisted", (lastNet("/api/me", "PATCH") || {}).status === 200 && dbUser.full_name === "Akosua A. Mensah" && dbUser.phone === "+233 24 111 2222", JSON.stringify(dbUser));
    check("3e. saved user in localStorage updated (header name)", (await ev(`JSON.parse(localStorage.getItem("neofragrances_auth")).user.full_name`)) === "Akosua A. Mensah");

    /* ---------- 4. addresses ---------- */
    await go(`${FRONT}/my-account.html#addresses`);
    await waitFor(`document.querySelectorAll(".nf-addr-card").length === 2`);
    check("4. addresses listed; default badge on Home", await ev(`document.querySelector(".nf-addr-card.is-default .nf-addr-label").textContent === "Home"`));
    check("4b. address used by an order is locked (no edit/delete)", await ev(`(()=>{const c=[...document.querySelectorAll(".nf-addr-card")].find(c=>c.textContent.includes("Oxford")); return !!c.querySelector(".nf-addr-locked") && !c.querySelector("[data-action=delete-address]") && !c.querySelector("[data-action=edit-address]");})()`));
    await click("[data-action=add-address]");
    await waitFor(`!!document.getElementById("address-form")`);
    check("4c. add form: every input has a label", await ev(`[...document.querySelectorAll("#address-form input:not([type=checkbox])")].every(i => document.querySelector('label[for="'+i.id+'"]'))`));
    await ev(`document.querySelector("#address-form [type=submit]").click(); true`);
    check("4d. required-field validation shown before any request", await waitFor(`document.getElementById("ad-name").getAttribute("aria-invalid") === "true"`) && !lastNet("/api/addresses", "POST"));
    await ev(`(()=>{const f=document.getElementById("address-form"); f.fullName.value="Akosua Mensah"; f.addressLine1.value="77 Spintex Road"; f.city.value="Tema"; f.label.value="Parents"; f.querySelector("[type=submit]").click(); return true;})()`);
    await waitFor(`document.querySelectorAll(".nf-addr-card").length === 3`);
    check("4e. address added (POST 201)", (lastNet("/api/addresses", "POST") || {}).status === 201);
    const newId = (await q("SELECT id FROM addresses WHERE user_id = ? AND address_line1 = '77 Spintex Road'", [A]))[0]?.id;
    await click(`[data-action=edit-address][data-id="${newId}"]`);
    await waitFor(`document.getElementById("ad-line1")?.value === "77 Spintex Road"`);
    await ev(`(()=>{const f=document.getElementById("address-form"); f.addressLine1.value="78 Spintex Road"; f.querySelector("[type=submit]").click(); return true;})()`);
    await waitFor(`document.getElementById("addresses-body").textContent.includes("78 Spintex Road")`);
    check("4f. address edited (PUT 200)", (lastNet(`/api/addresses/${newId}`, "PUT") || {}).status === 200);
    await click(`[data-action=default-address][data-id="${newId}"]`);
    await waitFor(`document.querySelector(".nf-addr-card.is-default")?.textContent.includes("78 Spintex")`);
    const defaults = await q("SELECT id FROM addresses WHERE user_id = ? AND is_default = 1", [A]);
    check("4g. set default (PATCH) — exactly one default", defaults.length === 1 && defaults[0].id === newId);
    await click(`[data-action=delete-address][data-id="${newId}"]`);
    await waitFor(`!document.getElementById("confirm-dialog").hidden`);
    check("4h. delete asks for confirmation; focus moves into dialog", await ev(`document.activeElement.id === "confirm-cancel" && document.querySelector("#confirm-dialog [role=alertdialog]") !== null`));
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    check("4i. focus stays trapped in the dialog", await ev(`["confirm-cancel","confirm-ok"].includes(document.activeElement.id)`));
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(400);
    check("4j. Escape cancels — nothing deleted", await ev(`document.getElementById("confirm-dialog").hidden`) && !lastNet(`/api/addresses/${newId}`, "DELETE"));
    await click(`[data-action=delete-address][data-id="${newId}"]`);
    await waitFor(`!document.getElementById("confirm-dialog").hidden`);
    await click("#confirm-ok");
    await waitFor(`document.querySelectorAll(".nf-addr-card").length === 2`);
    const afterDel = await q("SELECT id, is_default FROM addresses WHERE user_id = ?", [A]);
    check("4k. confirmed delete (200); a remaining address promoted to default", (lastNet(`/api/addresses/${newId}`, "DELETE") || {}).status === 200 && afterDel.length === 2 && afterDel.filter(a => a.is_default).length === 1);
    await shot("02-addresses-desktop");

    /* ---------- 5. orders ---------- */
    await go(`${FRONT}/my-account.html#orders`);
    await waitFor(`document.querySelectorAll("#orders-body .nf-order-row").length === 2`);
    check("5. order history lists only this customer's orders", (await ev(`document.querySelectorAll("#orders-body .nf-order-row").length`)) === 2 && !(await ev(`!!document.querySelector('a[href="order.html?id=${orderB}"]')`)));
    check("5b. totals shown in GH₵", (await ev(`document.querySelector(".nf-order-total").textContent`)).includes("GH₵"));
    await click(`.nf-chip-filter[data-status="delivered"]`);
    check("5c. status filter", await waitFor(`document.querySelectorAll("#orders-body .nf-order-row").length === 1 && document.querySelector('.nf-chip-filter[data-status="delivered"]').getAttribute("aria-pressed") === "true"`));
    await click(`.nf-chip-filter[data-status="all"]`);
    await ev(`(()=>{const s=document.getElementById("orders-search"); s.value="zzzz-no-match"; s.dispatchEvent(new Event("input",{bubbles:true})); return true;})()`);
    check("5d. search with no match → empty state with clear action", await waitFor(`!!document.querySelector("[data-action=clear-order-filters]")`));
    await click("[data-action=clear-order-filters]");
    await waitFor(`document.querySelectorAll("#orders-body .nf-order-row").length === 2`);
    await click(`a[href="order.html?id=${order}"]`);
    await waitFor(`location.pathname.endsWith("order.html") && !!document.querySelector(".nf-order-header")`, 10000);
    check("5e. order opens as a dedicated page (order.html?id=)", (await ev(`location.search`)) === `?id=${order}` && /Order #/.test(await ev(`document.querySelector("h1").textContent`)));
    check("5f. timeline: Processing is the current step", await ev(`document.querySelector(".nf-timeline-step[aria-current=step] .nf-timeline-label").textContent.startsWith("Processing")`));
    const imgs = await ev(`[...document.querySelectorAll(".nf-order-item img")].map(i=>i.getAttribute("src"))`);
    check("5g. item images resolved by product_id (match DB images)", imgs.length === 2 && imgs.some(s => s.includes(path.basename(p1.image || "x"))) && imgs.some(s => s.includes(path.basename(p2.image || "x"))), JSON.stringify(imgs));
    const orderText = await ev(`document.getElementById("order-root").innerText`);
    check("5h. delivery address, payment reference, GH₵ total paid", orderText.includes("12 Oxford Street") && orderText.includes(`NF-E2E-${stamp}`) && /Total paid\s*GH₵/.test(orderText.replace(/\n/g, " ")) && orderText.includes("Shipping, discounts"));
    check("5i. Track this order link prefilled", await ev(`document.querySelector('a[href="track-order.html?order=${order}"]') !== null`));
    await click("#buy-again");
    await sleep(500);
    const cart = await ev(`JSON.parse(localStorage.getItem("neofragrances_cart") || "[]")`);
    check("5j. Buy again adds items to the existing bag", Array.isArray(cart) && cart.some(c => Number(c.id ?? c.productId) === p1.id) && cart.some(c => Number(c.id ?? c.productId) === p2.id), JSON.stringify(cart).slice(0, 120));
    await shot("03-order-desktop");
    await go(`${FRONT}/order.html?id=${orderB}`);
    check("5k. another customer's order id → not found (no data leak)", await waitFor(`/couldn't find that order/i.test(document.getElementById("order-root").innerText)`) && !(await ev(`document.body.innerText.includes("9 Bob Lane")`)));
    await go(`${FRONT}/order.html?id=abc`);
    check("5l. malformed order id → not found", await waitFor(`/couldn't find that order/i.test(document.getElementById("order-root").innerText)`));

    /* ---------- 6. wishlist ---------- */
    await ev(`localStorage.removeItem("neofragrances_cart"); true`);
    await go(`${FRONT}/my-account.html#wishlist`);
    await waitFor(`document.querySelectorAll(".nf-wish-item").length === 2`);
    check("6. wishlist items rendered with GH₵ price + stock", (await ev(`document.querySelector(".nf-wish-price").textContent`)).includes("GH₵") && await ev(`!!document.querySelector(".nf-wish-item .stock-yes")`));
    await click(`[data-action=move-to-bag][data-id="${p3.id}"]`);
    await waitFor(`document.querySelectorAll(".nf-wish-item").length === 1`);
    const cart2 = await ev(`JSON.parse(localStorage.getItem("neofragrances_cart") || "[]")`);
    const wl = await q("SELECT product_id FROM wishlist WHERE user_id = ?", [A]);
    check("6b. Move to bag → in bag and removed from wishlist", cart2.some(c => Number(c.id ?? c.productId) === p3.id) && !wl.some(w => w.product_id === p3.id), JSON.stringify(cart2).slice(0, 100));
    await click(`[data-action=remove-wish][data-id="${p4.id}"]`);
    check("6c. remove → empty state", await waitFor(`/wishlist is empty/i.test(document.getElementById("wishlist-body").innerText)`));

    /* ---------- 7. security ---------- */
    await go(`${FRONT}/my-account.html#security`);
    await waitFor(`!!document.getElementById("password-form")`);
    const fillPw = (c, n, k) => ev(`(()=>{const f=document.getElementById("password-form"); f.currentPassword.value=${JSON.stringify(c)}; f.newPassword.value=${JSON.stringify(n)}; f.confirmPassword.value=${JSON.stringify(k)}; f.querySelector("[type=submit]").click(); return true;})()`);
    await fillPw("Secret123", "NewPass789", "Different1");
    check("7. mismatched confirmation caught client-side", await waitFor(`document.getElementById("pw-confirm").getAttribute("aria-invalid") === "true"`) && !lastNet("/api/me/password"));
    await fillPw("WrongPass1", "NewPass789", "NewPass789");
    await waitFor(`document.getElementById("pw-current").getAttribute("aria-invalid") === "true"`);
    check("7b. wrong current password → 400 on current field", (lastNet("/api/me/password", "POST") || {}).status === 400);
    await fillPw("Secret123", "NewPass789", "NewPass789");
    await waitFor(`/password has been updated/i.test(document.getElementById("security-body").innerText)`);
    const loginNew = await fetch(API + "/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: emailA, password: "NewPass789" }) });
    check("7c. password changed (200) and new password works", (lastNet("/api/me/password", "POST") || {}).status === 200 && loginNew.status === 200);
    check("7d. show/hide toggle has accessible state", await ev(`(()=>{const b=document.querySelector("[data-action=toggle-pw]"); b.click(); const ok=b.getAttribute("aria-pressed")==="true" && document.getElementById("pw-current").type==="text"; b.click(); return ok;})()`));

    await loginAs(G, { id: G, full_name: "Gina", email: `nf-m4e2e-gina-${stamp}@gmail.com`, role: "customer" });
    await go(`${FRONT}/my-account.html#security`);
    await waitFor(`!!document.querySelector("[data-action=send-set-password]")`);
    check("7e. Google account: set-a-password path, no change-password form", !(await ev(`!!document.getElementById("password-form")`)));
    await click("[data-action=send-set-password]");
    check("7f. set-password link request → generic confirmation", await waitFor(`/link has been sent/i.test(document.getElementById("setpw-status").textContent)`));

    /* ---------- 8. expired session ---------- */
    const expired = jwt.sign({ id: A, role: "customer" }, SECRET, { expiresIn: -10 });
    await go(`${FRONT}/index.html`);
    await ev(`localStorage.setItem("neofragrances_auth", ${JSON.stringify(JSON.stringify({ token: expired, user: { id: A, full_name: "Akosua", email: emailA } }))}); true`);
    await go(`${FRONT}/my-account.html#orders`);
    await waitFor(`location.pathname.endsWith("login.html")`);
    check("8. expired JWT → redirected to login with expired=1 + return path", /redirect=my-account\.html%23orders&expired=1/.test(await ev(`location.search`)), await ev(`location.search`));
    check("8b. stale auth cleared; 'session expired' notice shown", await ev(`localStorage.getItem("neofragrances_auth") === null && document.getElementById("auth-notice").hidden === false`));
    check("8c. token never appears in the URL", !(await ev(`location.href`)).includes(expired.slice(0, 20)));

    /* ---------- 9. auth UI ---------- */
    check("9. Google block hidden when not configured (login)", await ev(`document.getElementById("google-auth-block").hidden === true`));
    check("9b. fake 'Remember me' removed", !(await ev(`document.body.innerText.includes("Remember me")`)));
    await go(`${FRONT}/register.html`);
    check("9c. register: Google hidden, password hint present", await ev(`document.getElementById("google-auth-block").hidden === true && !!document.getElementById("reg-password-hint")`));

    /* ---------- 10. track order ---------- */
    await go(`${FRONT}/index.html`); await ev(`localStorage.clear(); true`);
    await go(`${FRONT}/track-order.html?order=${order}`);
    check("10. track page prefilled from ?order=", (await ev(`document.getElementById("track-order-id").value`)) === String(order));
    const track = async (email) => { await ev(`(()=>{document.getElementById("track-order-email").value=${JSON.stringify(email)}; document.getElementById("track-order-form").querySelector("[type=submit]").click(); return true;})()`); await waitFor(`!document.getElementById("track-order-result").hasAttribute("aria-busy") && document.getElementById("track-order-result").innerHTML.length > 0`); await sleep(200); };
    await track(emailA);
    const tr = await ev(`document.getElementById("track-order-result").innerText`);
    check("10b. valid lookup → status, timeline, GH₵ total; no address/reference leaked", /Processing/.test(tr) && tr.includes("GH₵") && !tr.includes("Oxford") && !tr.includes("NF-E2E") && await ev(`!!document.querySelector("#track-order-result .nf-timeline")`));
    await track("someone-else@gmail.com");
    check("10c. wrong email → generic not-found", /could not find an order/i.test(await ev(`document.getElementById("track-order-result").innerText`)));
    let saw429 = false;
    for (let i = 0; i < 12 && !saw429; i++) { await track("someone-else@gmail.com"); saw429 = /Too many tracking attempts/.test(await ev(`document.getElementById("track-order-result").innerText`)); }
    check("10d. rate limit → friendly 429 message", saw429 && (lastNet("/api/track-order", "POST") || {}).status === 429);
    await shot("04-track-desktop");

    /* ---------- 11. old URLs ---------- */
    await go(`${FRONT}/my-orders.html`); await sleep(600);
    check("11. my-orders.html → my-account.html#orders", (await ev(`location.pathname + location.hash`)).endsWith("my-account.html#orders") || (await ev(`location.pathname`)).endsWith("login.html"));
    await go(`${FRONT}/wishlist.html`); await sleep(600);
    check("11b. wishlist.html → my-account.html#wishlist (via login when signed out)", decodeURIComponent(await ev(`location.href`)).includes("my-account.html#wishlist"));

    /* ---------- 12. mobile + accessibility ---------- */
    await loginAs(A, { id: A, full_name: "Akosua A. Mensah", email: emailA, role: "customer" });
    await viewport(390, 844, true);
    const overflow = {};
    for (const s of ["overview", "profile", "orders", "addresses", "wishlist", "security"]) {
      await go(`${FRONT}/my-account.html#${s}`); await sleep(500);
      overflow[s] = await noOverflow();
      if (s === "overview" || s === "orders") await shot(`05-mobile-${s}`);
    }
    check("12. mobile 390px: no horizontal overflow on any account section", Object.values(overflow).every(Boolean), JSON.stringify(overflow));
    check("12b. mobile nav is a horizontal scroller with the current item visible", await ev(`(()=>{const n=document.querySelector(".nf-account-nav"); const a=n.querySelector("[aria-current]").getBoundingClientRect(); return getComputedStyle(n).overflowX==="auto" && a.right <= innerWidth + 1;})()`));
    check("12c. mobile nav targets ≥ 44px tall", await ev(`[...document.querySelectorAll(".nf-account-nav a")].every(a => a.getBoundingClientRect().height >= 44)`));
    const pages = { order: `order.html?id=${order}`, track: "track-order.html", login: "login.html", register: "register.html", forgot: "forgot-password.html" };
    const pageOverflow = {};
    for (const [k, u] of Object.entries(pages)) { await go(`${FRONT}/${u}`); await sleep(400); pageOverflow[k] = await noOverflow(); if (k === "order") await shot("06-mobile-order"); }
    check("12d. mobile 390px: order, track, login, register, forgot — no overflow", Object.values(pageOverflow).every(Boolean), JSON.stringify(pageOverflow));
    await viewport(1280, 900, false);
    await go(`${FRONT}/my-account.html#security`); await sleep(600);
    const a11y = await ev(`(()=>{
      const unlabeled = [...document.querySelectorAll(".nf-account-content input")].filter(i => !(i.labels && i.labels.length) && !i.getAttribute("aria-label")).map(i=>i.id||i.name);
      const nameless = [...document.querySelectorAll(".nf-account-content button, .nf-account-nav a, .nf-account-nav button")].filter(b => !(b.textContent.trim() || b.getAttribute("aria-label"))).length;
      return { h1: document.querySelectorAll("h1").length, unlabeled, nameless, live: !!document.querySelector("#account-greeting[aria-live]") };
    })()`);
    check("12e. a11y: one h1, labelled inputs, named buttons, live region", a11y.h1 === 1 && !a11y.unlabeled.length && !a11y.nameless && a11y.live, JSON.stringify(a11y));
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await go(`${FRONT}/my-account.html#orders`); await sleep(500);
    check("12f. reduced motion: panels don't animate", (await ev(`getComputedStyle(document.getElementById("panel-orders")).animationName`)) === "none");
    await send("Emulation.setEmulatedMedia", { features: [] });

    check("13. no uncaught JS exceptions across the suite", exceptions.length === 0, exceptions.join(" | "));
  } catch (e) {
    console.error("HARNESS ERROR:", e); results.push(false);
  } finally {
    try {
      if (orderIds.length) { await q("DELETE FROM order_items WHERE order_id IN (?)", [orderIds]); await q("DELETE FROM orders WHERE id IN (?)", [orderIds]); }
      const extra = (await q("SELECT id FROM users WHERE email LIKE ?", [`nf-m4e2e-%-${stamp}@gmail.com`])).map(r => r.id);
      const all = [...new Set([...ids, ...extra])];
      if (all.length) {
        for (const t of ["addresses", "email_verifications", "password_resets", "wishlist", "reviews"]) await q(`DELETE FROM ${t} WHERE user_id IN (?)`, [all]);
        await q("DELETE FROM users WHERE id IN (?)", [all]);
      }
      const c = (await q("SELECT (SELECT COUNT(*) FROM users) u,(SELECT COUNT(*) FROM addresses) a,(SELECT COUNT(*) FROM orders) o,(SELECT COUNT(*) FROM order_items) oi,(SELECT COUNT(*) FROM wishlist) w,(SELECT COUNT(*) FROM password_resets) pr"))[0];
      console.log("\ncleanup:", JSON.stringify(c));
    } catch (e) { console.error("CLEANUP ERROR", e.message); }
    try { ws && ws.close(); } catch (e) {}
    if (edge) edge.kill(); if (server) server.kill(); await pool.end();
    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ""}`);
    process.exit(failed ? 1 : 0);
  }
})();
