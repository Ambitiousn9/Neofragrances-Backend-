// Shop by Scent Family (Stage C2) — the real storefront (:5500 index.html + products.html) +
// the real server.js (:5077, LOCAL db) + headless Edge. Browser calls to :5000 are rerouted
// to :5077; /api/products can be made to fail or return [] to test the data-failure paths.
//
// WHAT IT COVERS
//   catalogue: each valid family (only matching products), case normalisation, URL kept,
//   family + stock combination, the facet listing only the four families, switching family;
//   invalid / legacy / empty / space-padded values (never the full catalogue, never echoed,
//   kept across a refresh), the "Unknown scent family" chip and the empty-state links;
//   a family with no products; the unfiltered catalogue and search still reaching
//   unclassified products. Homepage: hidden while any family is below 5 active in-stock
//   classified products (stock, archive and missing-family edges), shown with exactly four
//   photo cards once all four qualify; failed and empty product data; the existing sections
//   still rendering; 1366 / 820 / 390 layouts, keyboard focus and reduced motion.
//
// REAL CATALOGUE vs FIXTURE SCENARIOS
//   The local catalogue may hold owner-assigned families. Section 0 checks the storefront
//   against it exactly as stored (every family page and the homepage are compared with
//   counts read from the database at run time, so they hold for any data). The fixture
//   scenarios that follow run in the "isolated" product-data mode: the browser receives the
//   real /api/products response with every non-fixture product's family hidden, so only the
//   fixtures decide the counts and thresholds. The database is never changed for this.
//
// WHAT IT NEVER TOUCHES
//   any real product, offer or image. Every classification and stock change is made on
//   throwaway products (brand 'NF SF Store'); the whole database (minus updated_at) is hashed
//   before and after, the real products are hashed WITH updated_at, and the four scent-family
//   images are checksummed before and after.
//
// Ports: API 5077, CDP 9347 (5055-5076, 5099 and CDP 9336-9346 are taken).
const path = require("path"), fs = require("fs"), os = require("os"), crypto = require("crypto");
const { spawn } = require("child_process");
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
require(path.join(process.cwd(), "node_modules/dotenv")).config({ quiet: true });
const pool = require(path.join(process.cwd(), "db"));
// Safety gate — never weaken this.
if (!["localhost", "127.0.0.1"].includes(process.env.DB_HOST)) { console.error("not local"); process.exit(1); }
const FRONT = "http://127.0.0.1:5500", API = "http://127.0.0.1:5077";
const FRONT_DIR = path.join(process.cwd(), "..", "neofragrances-frontend");
const IMG_DIR = path.join(FRONT_DIR, "images", "scent family");
const SECRET = crypto.randomBytes(32).toString("hex");
const SHOTS = path.join(os.tmpdir(), "nf-sf-store-shots"); fs.mkdirSync(SHOTS, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = async (s, p) => (await pool.query(s, p))[0];
const js = v => JSON.stringify(v);
const results = []; const check = (n, c, x = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"} ${n}${x !== "" ? "  [" + String(x).slice(0, 200) + "]" : ""}`); };

const SNAP_TABLES = ["products", "users", "coupons", "orders", "order_items", "reviews", "offers", "offer_products", "app_settings", "wishlist", "addresses", "order_status_history"];
async function snapshot() {
  const out = {};
  for (const t of SNAP_TABLES) {
    const rows = await q(`SELECT * FROM ${t}`); rows.forEach(r => delete r.updated_at);
    rows.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    out[t] = `${rows.length}:${crypto.createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 16)}`;
  }
  out.triggers = (await q("SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()")).map(r => r.TRIGGER_NAME).join(",");
  return out;
}
const realHash = async exclude => crypto.createHash("sha256").update(JSON.stringify(await q(exclude && exclude.length ? "SELECT * FROM products WHERE id NOT IN (?) ORDER BY id" : "SELECT * FROM products ORDER BY id", exclude && exclude.length ? [exclude] : []))).digest("hex").slice(0, 16);
const imageSums = () => Object.fromEntries(fs.readdirSync(IMG_DIR).sort().map(f => [f, crypto.createHash("sha1").update(fs.readFileSync(path.join(IMG_DIR, f))).digest("hex")]));

(async () => {
  const stamp = Date.now(), TOKEN = `SFS${stamp}`;
  const fx = [];
  const before = await snapshot();
  const realBefore = await realHash();
  const imagesBefore = imageSums();
  let server, edge, ws;
  try {
    /* ---------- fixtures (phase 1: Fresh has none; Woody has 4 in stock + 1 out) ---------- */
    const mk = async (label, fam, stock) => {
      const id = (await q("INSERT INTO products (name, brand, category, price, stock_qty, image, scent_family) VALUES (?, 'NF SF Store', 'unisex', 150, ?, 'images/perfumes/velvet-oud.jpg', ?)", [`${TOKEN} ${label}`, stock, fam])).insertId;
      fx.push(id); return id;
    };
    const FL = [], AM = [], WO = [], FR = [];
    for (let i = 0; i < 5; i++) FL.push(await mk(`Floral ${i}`, "floral", 10));
    const FL_OUT = await mk("Floral out", "floral", 0);
    for (let i = 0; i < 5; i++) AM.push(await mk(`Amber ${i}`, "amber", 10));
    for (let i = 0; i < 4; i++) WO.push(await mk(`Woody ${i}`, "woody", 10));
    const WO_OUT = await mk("Woody out", "woody", 0);
    const UN = [await mk("Unclassified 0", null, 10), await mk("Unclassified 1", null, 10)];

    /* ---------- server + browser ---------- */
    server = spawn(process.execPath, ["server.js"], { env: { ...process.env, PORT: "5077", JWT_SECRET: SECRET, DEV_EMAIL_LOG: "true", SENDGRID_API_KEY: "", PAYSTACK_SECRET_KEY: "", GOOGLE_CLIENT_ID: "", FRONTEND_URL: FRONT, NODE_ENV: "" }, stdio: "ignore" });
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { try { await fetch(API + "/"); up = true; } catch (e) { await sleep(200); } }
    if (!up) throw new Error("the test server on port 5077 did not start");
    const profile = path.join(os.tmpdir(), "nf-edge-sfstore"); fs.rmSync(profile, { recursive: true, force: true });
    edge = spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", ["--headless=new", "--remote-debugging-port=9347", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
    let wsUrl; for (let i = 0; i < 150 && !wsUrl; i++) { try { wsUrl = (await (await fetch("http://127.0.0.1:9347/json/list")).json()).find(t => t.type === "page")?.webSocketDebuggerUrl; } catch (e) {} if (!wsUrl) await sleep(200); }
    ws = new WebSocket(wsUrl); await new Promise(r => ws.addEventListener("open", r, { once: true }));
    let id = 0, loads = 0; const pending = new Map(); const exceptions = [];
    let productsMode = "normal"; // normal | fail | empty | isolated
    ws.addEventListener("message", ev => {
      const m = JSON.parse(ev.data); const p = m.params || {};
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === "Fetch.requestPaused") {
        const isProducts = /\/api\/products(\?|$)/.test(p.request.url) && p.request.method === "GET";
        if (isProducts && productsMode === "fail") send("Fetch.failRequest", { requestId: p.requestId, errorReason: "Failed" });
        else if (isProducts && productsMode === "empty") send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Access-Control-Allow-Origin", value: "*" }], body: Buffer.from("[]").toString("base64") });
        else if (isProducts && productsMode === "isolated") isolate(p);
        else send("Fetch.continueRequest", { requestId: p.requestId, url: p.request.url.replace("http://localhost:5000", API) });
      }
      if (m.method === "Page.loadEventFired") loads++;
      if (m.method === "Runtime.exceptionThrown") exceptions.push(p.exceptionDetails.exception?.description?.split("\n")[0]);
    });
    const send = (method, params = {}) => new Promise(r => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
    // "isolated": the real /api/products response with every non-fixture product's family hidden
    // (in the browser only; the database is untouched), so the fixture scenarios decide alone.
    const isolate = async p => {
      try {
        const r = await fetch(p.request.url.replace("http://localhost:5000", API));
        const data = await r.json();
        const own = new Set(fx);
        const body = Array.isArray(data) ? data.map(x => (own.has(x.id) ? x : { ...x, scent_family: null })) : data;
        send("Fetch.fulfillRequest", { requestId: p.requestId, responseCode: r.status, responseHeaders: [{ name: "Content-Type", value: "application/json" }, { name: "Access-Control-Allow-Origin", value: "*" }], body: Buffer.from(JSON.stringify(body)).toString("base64") });
      } catch (e) { send("Fetch.failRequest", { requestId: p.requestId, errorReason: "Failed" }); }
    };
    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Fetch.enable", { patterns: [{ urlPattern: "http://localhost:5000/*" }] });
    const viewport = (w, h, mobile) => send("Emulation.setDeviceMetricsOverride", { width: w, height: h, deviceScaleFactor: 1, mobile });
    await viewport(1366, 900, false);
    const ev = async e => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) return { __err: r.result.exceptionDetails.exception?.description?.slice(0, 200) }; return r.result?.result?.value; };
    const go = async url => { const b = loads; await send("Page.navigate", { url }); for (let i = 0; i < 150 && loads === b; i++) await sleep(100); await sleep(500); };
    const waitFor = async (e, ms = 9000) => { for (let t = 0; t < ms; t += 150) { const v = await ev(e); if (v && !v.__err) return true; await sleep(150); } return false; };
    const shot = async name => { const r = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false }); fs.writeFileSync(path.join(SHOTS, name + ".png"), Buffer.from(r.result.data, "base64")); };
    const click = sel => ev(`(()=>{const e=document.querySelector(${js(sel)}); if(!e) return false; e.scrollIntoView({block:"center"}); e.click(); return true;})()`);
    const activeCount = async () => Number((await q("SELECT COUNT(*) n FROM products WHERE deleted_at IS NULL"))[0].n);

    // catalogue helpers
    const shopReady = () => waitFor(`!!document.getElementById("results-count") && !/Loading/.test(document.getElementById("results-count").textContent) && !document.querySelector("#product-grid .skeleton, #product-grid [aria-hidden='true'].nf-skel")`);
    const openShop = async qs => { await go(`${FRONT}/products.html${qs}`); await shopReady(); await sleep(300); };
    const shopView = () => ev(`(()=>({
      title: document.getElementById("shop-title").textContent,
      crumb: document.getElementById("breadcrumb-current").textContent,
      count: document.getElementById("results-count").textContent,
      search: location.search,
      cards: [...document.querySelectorAll("#product-grid .product-card")].map(c=>c.innerText.split("\\n").find(l=>l.includes(${js(TOKEN)}))||c.querySelector("h3,.product-name")?.textContent||""),
      nCards: document.querySelectorAll("#product-grid .product-card").length,
      cardIds: [...document.querySelectorAll("#product-grid .product-card")].map(c=>Number(c.dataset.id)),
      state: document.querySelector("#product-grid [data-scent-state]")?.dataset.scentState || null,
      emptyH2: document.querySelector("#product-grid .nf-empty h2")?.textContent || "",
      chips: [...document.querySelectorAll("#active-filters .nf-chip")].map(c=>c.textContent.replace("— remove filter","").trim()),
      facet: [...document.querySelectorAll("#filters-body fieldset")].filter(f=>f.querySelector("legend")?.textContent==="Scent family").flatMap(f=>[...f.querySelectorAll(".nf-filter-label")].map(l=>l.textContent)),
      visibleText: [document.getElementById("shop-title").textContent, document.querySelector("#product-grid .nf-empty")?.innerText||"", document.getElementById("active-filters").innerText].join(" | ")
    }))()`);
    const totalFrom = count => Number((count.match(/of ([\d,]+) fragrance/) || [, "0"])[1].replace(/,/g, ""));

    // homepage helpers
    const openHome = async () => { await go(`${FRONT}/index.html`); await waitFor(`!document.getElementById("hero-stats").hidden || /trouble loading/.test(document.getElementById("picks-grid").innerText)`, 10000); await sleep(400); };
    const homeView = () => ev(`(()=>{const s=document.getElementById("scent-families"); return {
      hidden: s.hidden, cards: [...document.querySelectorAll("#scent-grid .nf-scent-card")].map(a=>({href:a.getAttribute("href"), h3:a.querySelector("h3")?.textContent, p:a.querySelector("p")?.textContent, alt:a.querySelector("img")?.getAttribute("alt"), src:a.querySelector("img")?.getAttribute("src"), text:a.innerText})),
      eyebrow: s.querySelector(".nf-eyebrow")?.innerText, h2: s.querySelector("h2")?.textContent, intro: s.querySelector(".nf-section-head p")?.textContent || null };})()`);
    const homeIntegrity = () => ev(`(()=>({
      sections: [...document.querySelectorAll("section")].map(s=>s.id||s.className.split(" ").pop()),
      heroTitle: document.getElementById("hero-title")?.textContent.trim(),
      heroStats: !document.getElementById("hero-stats").hidden && Number(document.getElementById("stat-products").textContent) > 0,
      brands: !document.getElementById("brands").hidden && document.querySelectorAll("#brands-track a").length > 0,
      picks: document.querySelectorAll("#picks-grid .product-card").length > 0,
      collections: !document.getElementById("collections").hidden && [...document.querySelectorAll("#collection-grid a")].map(a=>a.getAttribute("href")).join(","),
      header: !!document.querySelector("header"), footer: !!document.querySelector("footer"),
      offersHidden: document.getElementById("offers").hidden
    }))()`);
    const setStock = (ids, n) => q("UPDATE products SET stock_qty = ? WHERE id IN (?)", [n, ids]);

    /* ================= 0. real catalogue (classified + unclassified), as stored ================= */
    // Expectations are read from the database at run time (owner-assigned families + fixtures),
    // so these hold whatever the local catalogue contains.
    const FAMS = ["floral", "amber", "fresh", "woody"];
    const famTotals = {};
    for (const f of FAMS) {
      const ids = (await q("SELECT id FROM products WHERE deleted_at IS NULL AND scent_family = ? ORDER BY id", [f])).map(r => r.id);
      famTotals[f] = ids.length;
      await openShop(`?scent=${f}`); const rv = await shopView();
      check(`R-${f}. ?scent=${f} lists exactly the database's active ${f} products (${ids.length}, real + fixtures) and nothing else`,
        totalFrom(rv.count) === ids.length && rv.nCards === Math.min(12, ids.length) && rv.cardIds.every(i => ids.includes(i)) && rv.title === `${f[0].toUpperCase()}${f.slice(1)} Family`,
        js({ count: rv.count, n: rv.nCards, notInFamily: rv.cardIds.filter(i => !ids.includes(i)) }));
    }
    const unclassified = Number((await q("SELECT COUNT(*) n FROM products WHERE deleted_at IS NULL AND scent_family IS NULL"))[0].n);
    await openShop(""); const allView = await shopView();
    check(`R-unclassified. the four family totals + ${unclassified} unclassified = every active product; unclassified products stay in the full catalogue`,
      unclassified > 0 && FAMS.reduce((s, f) => s + famTotals[f], 0) + unclassified === totalFrom(allView.count) && totalFrom(allView.count) === await activeCount(),
      js({ famTotals, unclassified, all: allView.count }));
    const inStock = Object.fromEntries(FAMS.map(f => [f, 0]));
    for (const r of await q("SELECT scent_family f, COUNT(*) n FROM products WHERE deleted_at IS NULL AND stock_qty > 0 AND scent_family IS NOT NULL GROUP BY scent_family")) inStock[r.f] = Number(r.n);
    const expectShown = FAMS.every(f => inStock[f] >= 5);
    await openHome(); const realHome = await homeView();
    check(`R-home. with the real catalogue the section is ${expectShown ? "shown" : "hidden"}, as the database counts require (active in stock: ${js(inStock)})`,
      realHome.hidden === !expectShown && realHome.cards.length === (expectShown ? 4 : 0), js({ hidden: realHome.hidden, cards: realHome.cards.length }));
    // From here on the browser sees only the fixtures' families (see "isolated" above).
    productsMode = "isolated";

    /* ================= 1. catalogue (phase 1) ================= */
    await openShop("?scent=floral");
    let v = await shopView();
    check("C1. ?scent=floral → only the 6 Floral products (5 in stock + 1 out), heading 'Floral Family', URL kept, chip 'Floral'",
      v.nCards === 6 && v.cards.every(t => t.includes(`${TOKEN} Floral`)) && v.title === "Floral Family" && v.search === "?scent=floral" && js(v.chips) === js(["Floral"]), js(v));
    check("C2. the family facet lists only canonical families (no legacy labels)", v.facet.length > 0 && v.facet.every(l => ["All families", "Floral", "Amber", "Fresh", "Woody"].includes(l)) && !v.facet.some(l => /Citrus|Oud|Vanilla|Musk|Sweet|Spicy|Fruity/.test(l)), js(v.facet));
    await openShop("?scent=amber"); v = await shopView();
    check("C3. ?scent=amber → only the 5 Amber products", v.nCards === 5 && v.cards.every(t => t.includes(`${TOKEN} Amber`)) && v.title === "Amber Family", js(v.cards));
    await openShop("?scent=woody"); v = await shopView();
    check("C4. ?scent=woody → only the 5 Woody products (4 in stock + 1 out)", v.nCards === 5 && v.cards.every(t => t.includes(`${TOKEN} Woody`)) && v.title === "Woody Family");
    await openShop("?scent=FLORAL"); v = await shopView();
    check("C5. ?scent=FLORAL → normalised to floral (URL rewritten), same 6 products", v.search === "?scent=floral" && v.nCards === 6, js([v.search, v.nCards]));
    await openShop("?scent=floral&stock=in"); v = await shopView();
    check("C6. family + 'in stock' combine → the 5 in-stock Floral products", v.nCards === 5 && v.cards.every(t => t.includes(`${TOKEN} Floral`) && !t.includes("Floral out")), js(v.cards));
    await openShop("?scent=floral");
    await ev(`(()=>{const r=document.querySelector('#filters-body input[name="scent"][value="amber"]'); r.click(); return true;})()`);
    await waitFor(`document.getElementById("shop-title").textContent === "Amber Family"`);
    v = await shopView();
    check("C7. switching family in the facet → URL ?scent=amber, 5 Amber products", v.search === "?scent=amber" && v.nCards === 5, js([v.search, v.nCards]));
    await openShop("?scent=fresh"); v = await shopView();
    check("C8. a family with no products → Fresh-specific empty state, heading 'Fresh Family', no products listed",
      v.state === "empty" && v.emptyH2 === "No fragrances in the Fresh family yet" && v.title === "Fresh Family" && v.nCards === 0 && v.count === "No fragrances found", js(v));
    await click(`#product-grid .nf-empty a[href="products.html"]`); await shopReady(); await sleep(300); v = await shopView();
    const nActive = await activeCount();
    check("C9. 'Browse all fragrances' from the empty state → the full catalogue", v.title === "All Fragrances" && totalFrom(v.count) === nActive && v.search === "", js([v.title, v.count]));

    for (const [label, raw] of [["oriental", "oriental"], ["citrus (legacy)", "citrus"], ["zzz", "zzz"], ["empty", ""], ["space-padded", "%20amber%20"], ["Florals", "Florals"], ["oud (legacy)", "oud"]]) {
      await openShop(`?scent=${raw}`); v = await shopView();
      const shownRaw = raw && !/amber/i.test(raw) ? v.visibleText.toLowerCase().includes(raw.toLowerCase()) : false;
      check(`I-${label}. ?scent=${raw || "(empty)"} → 'not found' state, 0 products, never the catalogue, value not echoed, kept in the URL`,
        v.state === "invalid" && v.nCards === 0 && v.title === "Scent family not found" && v.count === "No fragrances found" && js(v.chips) === js(["Unknown scent family"]) && !shownRaw && v.search.startsWith("?scent="), js({ t: v.title, n: v.nCards, s: v.search, chips: v.chips }));
    }
    await openShop("?scent=zzz");
    await send("Page.reload", {}); await sleep(800); await shopReady(); await sleep(300); v = await shopView();
    check("I-refresh. reloading an invalid family page keeps the 'not found' state", v.state === "invalid" && v.nCards === 0 && v.search === "?scent=zzz", js([v.state, v.search]));
    await click("#active-filters .nf-chip"); await waitFor(`document.getElementById("shop-title").textContent === "All Fragrances"`); v = await shopView();
    check("I-chip. removing the 'Unknown scent family' chip restores normal browsing (full catalogue, no ?scent)", v.title === "All Fragrances" && totalFrom(v.count) === nActive && v.search === "", js([v.title, v.count, v.search]));
    await openShop("?scent=oriental");
    await click(`#product-grid .nf-empty a[href="products.html?scent=floral"]`); await shopReady(); await sleep(300); v = await shopView();
    check("I-links. the 'not found' state links to the families (Floral link → 6 Floral products)", v.title === "Floral Family" && v.nCards === 6);
    await openShop("?scent=zzz&category=women"); v = await shopView();
    check("I-combo. invalid family with another filter still shows no products", v.nCards === 0 && v.state === "invalid");
    await openShop(""); v = await shopView();
    check("U1. the unfiltered catalogue is unchanged: 'All Fragrances', every active product, paginated", v.title === "All Fragrances" && totalFrom(v.count) === nActive && v.nCards === 12 && !!(await ev(`document.querySelector("#pagination button, #pagination a")`)), js([v.title, v.count, v.nCards]));
    await openShop(`?q=${TOKEN}%20Unclassified`); v = await shopView();
    check("U2. unclassified products stay reachable through normal search", v.nCards === 2 && v.cards.every(t => t.includes("Unclassified")), js(v.cards));

    /* ================= 2. homepage visibility ================= */
    await openHome();
    let h = await homeView(); const integrity1 = await homeIntegrity();
    const unclassifiedInStock = Number((await q("SELECT COUNT(*) n FROM products WHERE deleted_at IS NULL AND scent_family IS NULL AND stock_qty > 0"))[0].n);
    check("H1. hidden while Fresh has 0 and Woody 4 in stock (unclassified in-stock products, " + unclassifiedInStock + ", never count)", h.hidden === true && h.cards.length === 0 && unclassifiedInStock > 20, js(h));
    const expectedSections = (fs.readFileSync(path.join(FRONT_DIR, "index.html"), "utf8").match(/<section\b/g) || []).length;
    // Each existing homepage element is reported on its own so a failure names exactly what broke.
    check("H2a. all " + expectedSections + " homepage sections are present, in source order", integrity1.sections.length === expectedSections, js(integrity1.sections));
    check("H2b. hero title and live product stats render", !!integrity1.heroTitle && integrity1.heroStats, js([integrity1.heroTitle, integrity1.heroStats]));
    check("H2c. brand strip renders with links", integrity1.brands === true);
    check("H2d. bestseller / new-arrival picks render product cards", integrity1.picks === true);
    check("H2e. collections section with its three category links", integrity1.collections === "products.html?category=men,products.html?category=women,products.html?category=unisex", integrity1.collections);
    check("H2f. site header and footer present", integrity1.header && integrity1.footer, js([integrity1.header, integrity1.footer]));
    check("H2g. no JavaScript exceptions so far", exceptions.length === 0, exceptions.join(" | "));
    for (let i = 0; i < 5; i++) FR.push(await mk(`Fresh ${i}`, "fresh", 10));
    await openHome(); h = await homeView();
    check("H3. still hidden when three families qualify but Woody has only 4 in stock (out-of-stock not counted)", h.hidden === true);
    await setStock([WO_OUT], 3);
    await openHome(); h = await homeView();
    check("H4. all four families at ≥ 5 active in-stock → the section is shown", h.hidden === false && h.cards.length === 4);
    check("H5. exactly four cards, in order, with the specified names, notes and links",
      js(h.cards.map(c => [c.h3, c.p, c.href])) === js([["Floral", "Rose · Jasmine · Peony", "products.html?scent=floral"], ["Amber", "Oud · Amber · Musk", "products.html?scent=amber"], ["Fresh", "Citrus · Aqua · Green", "products.html?scent=fresh"], ["Woody", "Sandalwood · Cedar", "products.html?scent=woody"]]), js(h.cards.map(c => [c.h3, c.p, c.href])));
    check("H6. heading hierarchy: eyebrow DISCOVER, H2 'Shop by Scent Family', no old intro line", h.eyebrow === "DISCOVER" && h.h2 === "Shop by Scent Family" && h.intro === null, js([h.eyebrow, h.h2, h.intro]));
    check("H7. no product counts on the cards; decorative images use alt=\"\" and the supplied files", h.cards.every(c => !/\d/.test(c.text) && c.alt === "") && js(h.cards.map(c => decodeURIComponent(c.src))) === js(["images/scent family/Floral.jpeg", "images/scent family/Amber.jpeg", "images/scent family/fresh.jpeg", "images/scent family/Woody.jpeg"]));
    await ev(`document.getElementById("scent-families").scrollIntoView({block:"center"}); true`);
    check("H8. all four photos load (lazy images in view)", await waitFor(`[...document.querySelectorAll("#scent-grid img")].every(i=>i.complete && i.naturalWidth>0)`, 10000));
    const integrity2 = await homeIntegrity();
    check("H9. the other homepage sections are unchanged by the new section (same order and state as before)", js({ ...integrity2 }) === js({ ...integrity1 }), js(integrity2));
    // Layout positions (offsetTop), not on-screen rects: the cards' staggered reveal animation
    // briefly offsets them vertically, which would make a rect-based column count flaky.
    const lay = async () => ev(`(()=>{const r=[...document.querySelectorAll("#scent-grid .nf-scent-card")].map(c=>c.offsetTop); return {overflow: document.documentElement.scrollWidth <= innerWidth + 1, cols: r.filter(t=>Math.abs(t-r[0])<2).length, rounded: getComputedStyle(document.querySelector(".nf-scent-card")).borderTopLeftRadius};})()`);
    let L = await lay(); await shot("01-home-1366");
    check("L1. 1366px: 2 × 2 grid, rounded cards, no horizontal scroll", L.overflow && L.cols === 2 && L.rounded !== "0px", js(L));
    await viewport(820, 1180, true); await openHome(); await ev(`document.getElementById("scent-families").scrollIntoView({block:"start"}); true`); await sleep(300);
    L = await lay(); await shot("02-home-820");
    check("L2. 820px: two columns, no horizontal scroll", L.overflow && L.cols === 2, js(L));
    await viewport(390, 844, true); await openHome(); await ev(`document.getElementById("scent-families").scrollIntoView({block:"start"}); true`); await sleep(300);
    L = await lay(); await shot("03-home-390");
    check("L3. 390px: one column, no horizontal scroll", L.overflow && L.cols === 1, js(L));
    await openShop("?scent=zzz"); const mobShop = await ev(`document.documentElement.scrollWidth <= innerWidth + 1`);
    await openShop("?scent=floral"); const mobShop2 = await ev(`document.documentElement.scrollWidth <= innerWidth + 1`);
    check("L4. 390px catalogue: family page and 'not found' page have no horizontal scroll", mobShop && mobShop2);
    await viewport(1366, 900, false);
    await openHome();
    // Real Tab key presses (a scripted .focus() doesn't trigger :focus-visible in Chromium).
    await ev(`document.querySelector("#scent-grid .nf-scent-card").focus(); true`);
    const tabKey = async shift => { await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, modifiers: shift ? 8 : 0 }); await sleep(120); };
    const focusInfo = () => ev(`(()=>{const a=document.activeElement; return {card: a?.dataset?.scentCard || null, outline: getComputedStyle(a).outlineStyle, ring: a.matches(":focus-visible")};})()`);
    const kb = [];
    for (let i = 0; i < 3; i++) { await tabKey(false); kb.push(await focusInfo()); }
    await tabKey(true); kb.push(await focusInfo());
    check("K1. keyboard: Tab moves Floral → Amber → Fresh → Woody, Shift+Tab goes back, each with a visible focus ring",
      js(kb.map(k => k.card)) === js(["amber", "fresh", "woody", "fresh"]) && kb.every(k => k.ring && k.outline !== "none"), js(kb));
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] });
    await openHome();
    const rm = await ev(`(()=>{const i=document.querySelector("#scent-grid img"); return {dur: getComputedStyle(i).transitionDuration};})()`);
    check("K2. reduced motion: the card image has no transition", rm && parseFloat(rm.dur) < 0.001, js(rm));
    await send("Emulation.setEmulatedMedia", { features: [] });
    await openHome(); await click(`#scent-grid a[href="products.html?scent=floral"]`); await shopReady(); await sleep(300); v = await shopView();
    check("H10. clicking the Floral card opens the Floral family page with only Floral products", v.title === "Floral Family" && v.nCards === 6 && v.search === "?scent=floral");

    /* threshold edges */
    await setStock([AM[0]], 0); await openHome(); h = await homeView();
    check("T1. one family drops to 4 in stock → the whole section hides (never 3 cards)", h.hidden === true && h.cards.length === 0);
    await setStock([AM[0]], 10);
    await q("UPDATE products SET deleted_at = NOW() WHERE id = ?", [FL[0]]); await openHome(); h = await homeView();
    check("T2. an archived product doesn't count (Floral back to 4 active in stock → hidden)", h.hidden === true);
    await q("UPDATE products SET deleted_at = NULL WHERE id = ?", [FL[0]]);
    await q("UPDATE products SET scent_family = NULL WHERE id = ?", [WO[0]]); await openHome(); h = await homeView();
    check("T3. a product with no family doesn't count (Woody back to 4 → hidden)", h.hidden === true);
    await q("UPDATE products SET scent_family = 'woody' WHERE id = ?", [WO[0]]);
    await openHome(); h = await homeView();
    check("T4. restored to all four ≥ 5 → shown again", h.hidden === false && h.cards.length === 4);

    /* data failure */
    productsMode = "fail"; await openHome(); h = await homeView();
    const failText = await ev(`document.getElementById("picks-grid").innerText`);
    check("D1. product API failure → the section stays hidden (existing error message shown in picks)", h.hidden === true && h.cards.length === 0 && /trouble loading/i.test(failText), failText);
    productsMode = "empty"; await openHome(); h = await homeView();
    check("D2. empty product data → the section stays hidden", h.hidden === true && h.cards.length === 0);
    productsMode = "normal";
    check("D3. no uncaught JavaScript exceptions on the storefront pages", exceptions.length === 0, exceptions.join(" | "));
    check("P1. no real product was touched (real catalogue hashed with updated_at, minus fixtures)", (await realHash(fx)) === realBefore);
    console.log(`screenshots: ${SHOTS}`);
  } catch (e) {
    console.error("HARNESS ERROR:", e); results.push(false);
  } finally {
    try {
      if (fx.length) { await q("DELETE FROM offer_products WHERE product_id IN (?)", [fx]); await q("DELETE FROM products WHERE id IN (?)", [fx]); }
      await q("DELETE FROM products WHERE name LIKE ?", [`SFS${stamp}%`]);
      const after = await snapshot();
      console.log("\nbefore:", js(before), "\nafter: ", js(after));
      check("Z1. database identical to before (every table hashed, no triggers)", js(before) === js(after));
      check("Z2. real products byte-identical to before, including updated_at", (await realHash()) === realBefore);
      check("Z3. the four scent-family images are byte-identical", js(imageSums()) === js(imagesBefore), js(Object.keys(imagesBefore)));
      const left = (await q("SELECT COUNT(*) n FROM products WHERE brand = 'NF SF Store'"))[0].n;
      console.log(`cleanup: fixture products=${left}`);
      check("Z4. no fixture rows left behind", Number(left) === 0);
    } catch (e) { console.error("CLEANUP ERROR", e.message); results.push(false); }
    try { ws && ws.close(); } catch (e) {}
    if (edge) edge.kill();
    if (server) server.kill();
    await pool.end();
    const failed = results.filter(x => !x).length;
    console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ""}`);
    process.exit(failed ? 1 : 0);
  }
})();
