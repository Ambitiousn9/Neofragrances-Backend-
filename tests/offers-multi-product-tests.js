// Multi-product offers (Milestone 6 Phase 6) — backend/API against the real server.js and the LOCAL db.
//
// WHAT IT COVERS
//   migration 007's UNIQUE (offer_id, product_id); POST / PUT /api/admin/offers with an
//   items[] list (1–50 products) and the older single-product body; per-item validation
//   with nothing written on failure; atomic create / update (a forced insert failure rolls
//   the whole change back); archived products may stay on an offer but not be newly added;
//   the grouped GET /api/admin/offers (one entry per offer, products[], legacy top-level
//   fields); the public N-row /api/offers/active; and cart pricing of two products from
//   one offer.
//   Phase 6B, in headless Edge: the offers page shows one card per product at its lowest
//   live price; product details, catalogue cards and Add to Cart agree on that price; the
//   cart matches offer rows by (offer id, product id), moves a line on a dearer or
//   non-covering offer to the lowest live one, and falls back to the regular price (with
//   the server refusing the old price) when an offer expires or drops the product.
//   Phase 6C, in headless Edge: the admin list shows one row per offer with its product
//   count and sale-price range; the editor searches products (archived ones excluded),
//   adds / removes rows, blocks duplicates and a 51st product, applies an optional
//   "same % off" per product in whole pesewas, validates prices in the browser, shows
//   server errors on the right row, keeps the saved offer on a failed update, and keeps
//   activate / feature / delete working. Checks mobile overflow and accessibility.
//   Phase 6D: the offers-page banner and homepage spotlight show the offer's product plus
//   "+N more in this offer" (linking to the offers grid, where the banner link highlights
//   that offer's products); inactive / scheduled / expired offers never show as discounts.
//   Also covers the 2-decimal price check accepting values like 289.15 (V22-V25).
//
// WHAT IT NEVER TOUCHES
//   offer 1, offer 30002, their offer_products rows, or any real product. It creates
//   51 + 1 throwaway products, its own offers and one temporary admin, and removes them
//   all. The atomicity cases use a temporary trigger that fires only for one fixture
//   product and is dropped straight after. The whole database (minus updated_at) is
//   hashed before and after and must match, and the restored offers are compared
//   field by field including updated_at.
//
// Ports: API 5074, CDP 9345 (5055-5066, 5070-5073, 5099 and CDP 9336-9344 are taken).
const path = require("path"), fs = require("fs"), os = require("os"), crypto = require("crypto");
const { spawn } = require("child_process");
// This file lives in <repo>/tests, so default to the repo root above it.
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
// T04: runs ONLY under the isolated-database guard (nf_test_* on 127.0.0.1:3308; see
// tests/README.md, "Isolated test database"). Checked before dotenv and db.js load.
const iso = require("./support/isolated-suite");
iso.requireIsolation("offers-multi-product-tests.js");
require(path.join(process.cwd(), "node_modules/dotenv")).config({ quiet: true });
const jwt = require(path.join(process.cwd(), "node_modules/jsonwebtoken"));
const pool = require(path.join(process.cwd(), "db"));
// Safety gate — never weaken this.
if (!["localhost", "127.0.0.1"].includes(process.env.DB_HOST)) { console.error("not local"); process.exit(1); }
const FRONT = "http://127.0.0.1:5500", API = "http://127.0.0.1:5074";
const SECRET = crypto.randomBytes(32).toString("hex");
const TRIGGER = "nf_test_mpo_fail";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = async (s, p) => (await pool.query(s, p))[0];
const results = []; const check = (n, c, x = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"} ${n}${x !== "" ? "  [" + String(x).slice(0, 190) + "]" : ""}`); };
const call = async (method, url, token, body) => {
  const r = await fetch(API + url, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let data = null; try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
};

// Everything this suite must leave exactly as it found it (updated_at excluded).
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
const RESTORED_SQL = `SELECT o.*, op.id AS op_id, op.product_id, op.original_price, op.sale_price
  FROM offers o JOIN offer_products op ON op.offer_id = o.id WHERE o.id IN (1, 30002) ORDER BY o.id`;

(async () => {
  await iso.verifyParentIdentity(pool, "offers-multi-product-tests.js");
  const stamp = Date.now();
  const fx = { users: [], products: [], offers: [] };
  const before = await snapshot();
  const restoredBefore = JSON.stringify(await q(RESTORED_SQL));
  let server, edge, ws;
  try {
    /* ---------- fixtures: 51 live products + 1 archived, one admin ---------- */
    const P = [];
    for (let i = 0; i < 51; i++) {
      const id = (await q("INSERT INTO products (name, brand, category, price, stock_qty) VALUES (?, 'NF MPO Test', 'unisex', ?, 10)", [`NF MPO ${stamp} #${i}`, 100 + i])).insertId;
      fx.products.push(id); P.push(id);
    }
    const PA = (await q("INSERT INTO products (name, brand, category, price, stock_qty, deleted_at) VALUES (?, 'NF MPO Test', 'unisex', 90, 10, NOW())", [`NF MPO ${stamp} archived`])).insertId;
    fx.products.push(PA);
    const ADMIN = (await q("INSERT INTO users (full_name, email, phone, password_hash, role, email_verified_at, auth_provider) VALUES ('MPO Admin', ?, '0200000000', 'x', 'admin', NOW(), 'local')", [`nf-mpo-admin-${stamp}@gmail.com`])).insertId;
    fx.users.push(ADMIN);
    const tA = jwt.sign({ id: ADMIN, role: "admin" }, SECRET);

    server = await iso.startGuardedServer({ suite: "offers-multi-product-tests.js", port: 5074, env: { JWT_SECRET: SECRET, DEV_EMAIL_LOG: "true" } });

    const start = new Date(Date.now() - 3600e3).toISOString().slice(0, 19).replace("T", " ");
    const end = new Date(Date.now() + 86400e3).toISOString().slice(0, 19).replace("T", " ");
    const base = (title, extra = {}) => ({ title: `NF MPO Offer ${stamp} ${title}`, offer_type: "discount", start_at: start, end_at: end, display_order: 5, ...extra });
    const item = (pid, original, sale) => ({ product_id: pid, original_price: original, sale_price: sale });
    const rowsOf = async id => q("SELECT id, product_id, original_price, sale_price FROM offer_products WHERE offer_id = ? ORDER BY id", [id]);
    const pairs = rows => rows.map(r => [r.product_id, Number(r.original_price), Number(r.sale_price)]);
    const counts = async () => (await q("SELECT (SELECT COUNT(*) FROM offers) f, (SELECT COUNT(*) FROM offer_products) fp"))[0];
    const create = async (title, extra) => { const r = await call("POST", "/api/admin/offers", tA, base(title, extra)); if (r.data?.id) fx.offers.push(r.data.id); return r; };

    /* ================= migration 007 ================= */
    const idx = await q("SHOW INDEX FROM offer_products WHERE Key_name = 'uq_offer_products_offer_product'");
    check("M1. migration 007: UNIQUE (offer_id, product_id) present",
      idx.length === 2 && idx.every(i => Number(i.Non_unique) === 0) && idx[0].Column_name === "offer_id" && idx[1].Column_name === "product_id",
      JSON.stringify(idx.map(i => [i.Seq_in_index, i.Column_name, i.Non_unique])));

    /* ================= create ================= */
    let r = await create("multi", { items: [item(P[0], 100, 80), item(P[1], 101, 90.5), item(P[2], 102, 102)] });
    const FM = r.data?.id;
    check("C1. create with 3 products → 201 and exactly 3 rows with each product's own prices, in order",
      r.status === 201 && JSON.stringify(pairs(await rowsOf(FM))) === JSON.stringify([[P[0], 100, 80], [P[1], 101, 90.5], [P[2], 102, 102]]), `${r.status} ${JSON.stringify(r.data)}`);

    r = await create("legacy", { product_id: P[3], original_price: 103, sale_price: 70 });
    const FL = r.data?.id;
    check("C2. legacy single-product body still accepted → one row",
      r.status === 201 && JSON.stringify(pairs(await rowsOf(FL))) === JSON.stringify([[P[3], 103, 70]]), `${r.status} ${JSON.stringify(r.data)}`);

    r = await create("dupkey", { items: [item(P[4], 104, 100)] });
    const FD = r.data?.id;
    let dupErr = null;
    try { await q("INSERT INTO offer_products (offer_id, product_id, original_price, sale_price) VALUES (?, ?, 104, 99)", [FD, P[4]]); } catch (e) { dupErr = e; }
    check("M2. the database itself rejects a duplicate (offer, product) pair (ER_DUP_ENTRY on the 007 index)",
      !!dupErr && dupErr.code === "ER_DUP_ENTRY" && /uq_offer_products_offer_product/.test(dupErr.sqlMessage) && (await rowsOf(FD)).length === 1, dupErr && dupErr.sqlMessage);

    /* ================= validation: nothing is written on any failure ================= */
    const c0 = await counts();
    const many = n => Array.from({ length: n }, (_, i) => item(P[i], 100 + i, 50));
    const bad = [
      ["V1. empty items", { items: [] }, "items"],
      ["V2. items not a list", { items: "P1" }, "items"],
      ["V3. 51 products (over the 50 cap)", { items: many(51) }, "items"],
      ["V4. duplicate product", { items: [item(P[0], 100, 80), item(P[0], 100, 70)] }, "items[1].product_id"],
      ["V5. product that doesn't exist", { items: [item(P[0], 100, 80), item(999999999, 100, 80)] }, "items[1].product_id"],
      ["V6. archived product", { items: [item(P[0], 100, 80), item(P[1], 100, 80), item(PA, 90, 80)] }, "items[2].product_id"],
      ["V7. product id 0", { items: [item(0, 100, 80)] }, "items[0].product_id"],
      ["V8. product id true", { items: [item(true, 100, 80)] }, "items[0].product_id"],
      ["V9. original price 0", { items: [item(P[0], 0, 0)] }, "items[0].original_price"],
      ["V10. negative sale price", { items: [item(P[0], 100, -5)] }, "items[0].sale_price"],
      ["V11. sale price with 3 decimals", { items: [item(P[0], 100, 1.234)] }, "items[0].sale_price"],
      ["V12. original price over 1,000,000", { items: [item(P[0], 1000001, 80)] }, "items[0].original_price"],
      ["V13. sale above original on item 3", { items: [item(P[0], 100, 80), item(P[1], 100, 80), item(P[2], 100, 100.01)] }, "items[2].sale_price"],
      ["V14. null item", { items: [null] }, "items[0]"],
      ["V15. sale price missing", { items: [{ product_id: P[0], original_price: 100 }] }, "items[0].sale_price"],
      ["V16. legacy body: no product", { original_price: 100, sale_price: 80 }, "product_id"],
      ["V17. legacy body: sale above original", { product_id: P[0], original_price: 100, sale_price: 120 }, "sale_price"],
      ["V18. legacy body: archived product", { product_id: PA, original_price: 90, sale_price: 80 }, "product_id"],
      ["V19. offer fields still validated first (no title)", { title: "", items: [] }, "title"],
      ["V20. offer fields still validated first (end before start)", { end_at: start, start_at: end, items: [item(P[0], 100, 80)] }, "end_at"],
    ];
    for (const [name, extra, field] of bad) {
      const body = { ...base("bad"), ...extra };
      const x = await call("POST", "/api/admin/offers", tA, body);
      if (x.data?.id) fx.offers.push(x.data.id);
      check(`${name} → 400 field "${field}"`, x.status === 400 && x.data.field === field, `${x.status} ${JSON.stringify(x.data)}`);
    }
    const c1 = await counts();
    check("V21. none of the rejected creates wrote an offer or an offer_products row", JSON.stringify(c0) === JSON.stringify(c1), `${JSON.stringify(c0)} → ${JSON.stringify(c1)}`);

    // Prices whose x100 isn't an exact float (289.15 * 100 === 28914.999999999996) are still valid 2-dp prices.
    r = await create("float-prices", { items: [item(P[13], 300, 289.15), item(P[14], 1.15, 1.15), item(P[15], 0.57, 0.29)] });
    check("V22. 2-decimal prices that aren't exact floats (289.15, 1.15, 0.57, 0.29) are accepted and stored exactly",
      r.status === 201 && JSON.stringify(pairs(await rowsOf(r.data.id))) === JSON.stringify([[P[13], 300, 289.15], [P[14], 1.15, 1.15], [P[15], 0.57, 0.29]]), `${r.status} ${JSON.stringify(r.data)}`);
    if (r.data?.id) await call("DELETE", `/api/admin/offers/${r.data.id}`, tA);
    for (const [name, it, field] of [
      ["V23. 289.155 (3 decimals) is still rejected", item(P[13], 300, 289.155), "items[0].sale_price"],
      ["V24. 12.345 original (3 decimals) is still rejected", item(P[13], 12.345, 10), "items[0].original_price"],
      ["V25. 0.001 is still rejected", item(P[13], 1, 0.001), "items[0].sale_price"],
    ]) {
      const x = await call("POST", "/api/admin/offers", tA, base("bad", { items: [it] }));
      if (x.data?.id) fx.offers.push(x.data.id);
      check(`${name} → 400 field "${field}"`, x.status === 400 && x.data.field === field, `${x.status} ${JSON.stringify(x.data)}`);
    }

    /* ================= the 50-product maximum ================= */
    r = await create("fifty", { items: many(50) });
    const F50 = r.data?.id;
    check("L1. exactly 50 products → 201 with 50 rows", r.status === 201 && (await rowsOf(F50)).length === 50, `${r.status} ${JSON.stringify(r.data)}`);
    r = await call("PUT", `/api/admin/offers/${FL}`, tA, base("legacy", { items: many(51) }));
    check("L2. updating to 51 products → 400 and the offer keeps its 1 product", r.status === 400 && r.data.field === "items" && JSON.stringify(pairs(await rowsOf(FL))) === JSON.stringify([[P[3], 103, 70]]), `${r.status} ${JSON.stringify(r.data)}`);

    /* ================= update ================= */
    r = await call("PUT", `/api/admin/offers/${FL}`, tA, base("legacy", { items: [item(P[3], 103, 60), item(P[5], 105, 99), item(P[6], 106, 50)] }));
    check("U1. update a one-product offer to 3 products → 200, set replaced exactly",
      r.status === 200 && JSON.stringify(pairs(await rowsOf(FL))) === JSON.stringify([[P[3], 103, 60], [P[5], 105, 99], [P[6], 106, 50]]), `${r.status} ${JSON.stringify(pairs(await rowsOf(FL)))}`);

    r = await call("PUT", `/api/admin/offers/${FL}`, tA, { product_id: P[7], original_price: 107, sale_price: 77, ...base("legacy") });
    check("U2. legacy single-product PUT replaces the set with that one product", r.status === 200 && JSON.stringify(pairs(await rowsOf(FL))) === JSON.stringify([[P[7], 107, 77]]));

    const offerRow = async id => (await q("SELECT title, offer_type, display_order, active, featured FROM offers WHERE id = ?", [id]))[0];
    const mBefore = JSON.stringify([await offerRow(FM), await rowsOf(FM)]);
    for (const [name, extra, field] of [
      ["U3. invalid item 2 of 3", { items: [item(P[0], 100, 80), item(P[8], 100, 200), item(P[9], 100, 80)] }, "items[1].sale_price"],
      ["U4. duplicate product", { items: [item(P[0], 100, 80), item(P[0], 100, 80)] }, "items[1].product_id"],
      ["U5. archived product newly added", { items: [item(P[0], 100, 80), item(PA, 90, 80)] }, "items[1].product_id"],
      ["U6. empty set", { items: [] }, "items"],
    ]) {
      const x = await call("PUT", `/api/admin/offers/${FM}`, tA, base("multi RENAMED", { offer_type: "limited", ...extra }));
      check(`${name} → 400 "${field}", offer and its products unchanged`, x.status === 400 && x.data.field === field && JSON.stringify([await offerRow(FM), await rowsOf(FM)]) === mBefore, `${x.status} ${JSON.stringify(x.data)}`);
    }

    // An archived product may STAY on an offer it is already part of; it just can't be newly added.
    await q("UPDATE products SET deleted_at = NOW() WHERE id = ?", [P[2]]);
    r = await call("PUT", `/api/admin/offers/${FM}`, tA, base("multi", { items: [item(P[0], 100, 75), item(P[1], 101, 90.5), item(P[2], 102, 99)] }));
    check("U7. a product archived after it joined the offer can be kept when the offer is edited", r.status === 200 && Number((await rowsOf(FM))[0].sale_price) === 75, `${r.status} ${JSON.stringify(r.data)}`);
    r = await call("PUT", `/api/admin/offers/${FD}`, tA, base("dupkey", { items: [item(P[4], 104, 100), item(P[2], 102, 99)] }));
    check("U8. …but that archived product can't be added to a different offer", r.status === 400 && r.data.field === "items[1].product_id", `${r.status} ${JSON.stringify(r.data)}`);

    r = await call("PUT", "/api/admin/offers/999999999", tA, base("ghost", { items: [item(P[0], 100, 80)] }));
    check("U9. PUT to an unknown offer → 404 and nothing written", r.status === 404 && (await q("SELECT COUNT(*) n FROM offer_products WHERE offer_id = 999999999"))[0].n === 0);

    /* ================= atomicity (temporary trigger, fixture product P[45] only) ================= */
    await pool.query(`CREATE TRIGGER ${TRIGGER} BEFORE INSERT ON offer_products FOR EACH ROW
                      BEGIN IF NEW.product_id = ${Number(P[45])} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced offer_products failure (test)'; END IF; END`);
    try {
      const cA = await counts();
      const x = await call("POST", "/api/admin/offers", tA, base("atomic-create", { items: [item(P[10], 100, 80), item(P[45], 100, 80)] }));
      if (x.data?.id) fx.offers.push(x.data.id);
      const leftover = (await q("SELECT COUNT(*) n FROM offers WHERE title = ?", [`NF MPO Offer ${stamp} atomic-create`]))[0].n;
      check("A1. create fails on the 2nd product's insert → 500, no offer and no product rows left behind",
        x.status === 500 && Number(leftover) === 0 && JSON.stringify(await counts()) === JSON.stringify(cA), `${x.status} leftover=${leftover}`);

      const before2 = JSON.stringify([await offerRow(FM), await rowsOf(FM)]);
      const y = await call("PUT", `/api/admin/offers/${FM}`, tA, base("multi RENAMED", { offer_type: "limited", items: [item(P[11], 100, 80), item(P[45], 100, 80)] }));
      check("A2. update fails mid-replace → 500, offer fields AND the previous product set (same row ids) restored",
        y.status === 500 && JSON.stringify([await offerRow(FM), await rowsOf(FM)]) === before2, `${y.status}`);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${TRIGGER}`);
    }
    check("A3. the temporary trigger is gone", (await q("SELECT COUNT(*) n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()"))[0].n === 0);

    /* ================= grouped admin listing ================= */
    r = await call("GET", "/api/admin/offers", tA);
    const list = r.data || [];
    const totalOffers = (await q("SELECT COUNT(*) n FROM offers"))[0].n;
    check("G1. one entry per offer (list length = offers table, no repeated ids)",
      r.status === 200 && list.length === Number(totalOffers) && new Set(list.map(o => o.id)).size === list.length, `${list.length} vs ${totalOffers}`);
    const gm = list.find(o => o.id === FM);
    check("G2. multi-product offer: products[] holds all 3 in order with their own prices and discount %",
      gm && gm.product_count === 3 && JSON.stringify(gm.products.map(p => [p.product_id, p.original_price, p.sale_price, p.discount_percent])) === JSON.stringify([[P[0], 100, 75, 25], [P[1], 101, 90.5, 10], [P[2], 102, 99, 3]]),
      gm && JSON.stringify(gm.products.map(p => [p.product_id, p.original_price, p.sale_price, p.discount_percent])));
    check("G3. per-product context: name, brand, current price, stock, archived flag",
      gm && gm.products[0].product_name === `NF MPO ${stamp} #0` && gm.products[0].product_brand === "NF MPO Test" && Number(gm.products[0].product_price) === 100 && gm.products[0].product_stock === 10 && gm.products[0].product_archived === false && gm.products[2].product_archived === true);
    check("G4. legacy top-level fields mirror the FIRST product (product_id, name, prices, discount %), status computed",
      gm && gm.product_id === P[0] && gm.product_name === `NF MPO ${stamp} #0` && gm.original_price === 100 && gm.sale_price === 75 && gm.discount_percent === 25 && gm.product_archived === false && gm.status === "Active");
    const g50 = list.find(o => o.id === F50);
    check("G5. the 50-product offer is ONE entry with 50 products", g50 && g50.product_count === 50 && g50.products.length === 50);
    const restored = list.filter(o => o.id === 1 || o.id === 30002).sort((a, b) => a.id - b.id);
    check("G6. restored offers 1 and 30002 are listed once each, 1 product each, exact prices",
      restored.length === 2 && restored[0].product_count === 1 && restored[0].products[0].product_id === 60004 && restored[0].products[0].original_price === 260 && restored[0].products[0].sale_price === 200
        && restored[1].product_count === 1 && restored[1].products[0].product_id === 49 && restored[1].products[0].original_price === 350 && restored[1].products[0].sale_price === 270,
      JSON.stringify(restored.map(o => [o.id, o.product_count, o.products.map(p => [p.product_id, p.original_price, p.sale_price])])));

    /* ================= public endpoint (unchanged: one row per offer product) ================= */
    const pub = await (await fetch(API + "/api/offers/active")).json();
    const pubM = pub.filter(o => o.id === FM);
    check("P1. /api/offers/active returns one row per live product of the offer, archived product excluded",
      pubM.length === 2 && JSON.stringify(pubM.map(o => [o.product_id, o.sale_price]).sort((a, b) => a[0] - b[0])) === JSON.stringify([[P[0], 75], [P[1], 90.5]]),
      JSON.stringify(pubM.map(o => [o.product_id, o.sale_price])));
    // P[2] is one of the 50 and was archived at U7, so exactly that one row drops out.
    const pub50 = pub.filter(o => o.id === F50);
    check("P2. the 50-product offer is served as 49 rows — only the archived product is hidden",
      pub50.length === 49 && !pub50.some(o => o.product_id === P[2]), `${pub50.length}`);

    /* ================= pricing (pricing.js unchanged) ================= */
    r = await call("POST", "/api/cart/quote", null, { items: [{ productId: P[0], qty: 1, offerId: FM }, { productId: P[1], qty: 2, offerId: FM }] });
    check("Q1. two products from the same offer in one cart → each at its own sale price",
      r.status === 200 && r.data.lines.find(l => l.productId === P[0]).unitPrice === 75 && r.data.lines.find(l => l.productId === P[1]).unitPrice === 90.5 && r.data.subtotal === 256, `${r.status} ${JSON.stringify(r.data).slice(0, 180)}`);
    r = await call("POST", "/api/cart/quote", null, { items: [{ productId: P[12], qty: 1, offerId: FM }] });
    check("Q2. an offer id used on a product that isn't in that offer → 409 OFFER_UNAVAILABLE", r.status === 409 && r.data.code === "OFFER_UNAVAILABLE", `${r.status} ${JSON.stringify(r.data)}`);

    /* ================= existing per-offer actions on a multi-product offer ================= */
    r = await call("PATCH", `/api/admin/offers/${FM}/toggle`, tA, { active: false });
    const pubOff = await (await fetch(API + "/api/offers/active")).json();
    check("X1. deactivating hides every product of the offer from the store", r.status === 200 && !pubOff.some(o => o.id === FM));
    r = await call("DELETE", `/api/admin/offers/${F50}`, tA);
    check("X2. deleting removes the offer and all 50 of its product rows", r.status === 200 && (await rowsOf(F50)).length === 0 && (await q("SELECT COUNT(*) n FROM offers WHERE id = ?", [F50]))[0].n === 0);

    /* ================= Phase 6B: customer side, in headless Edge ================= */
    // Offer windows are set by the DATABASE clock (NOW() ± INTERVAL), as in offers-behaviour.js.
    // Products P[20..27] are on no other live offer at this point (F50 was deleted above).
    const mkOffer = async (tag, rows, startSql = "NOW() - INTERVAL 1 HOUR", endSql = "NOW() + INTERVAL 2 DAY") => {
      const id = (await q(`INSERT INTO offers (title, offer_type, start_at, end_at, active, featured, display_order) VALUES (?, 'discount', ${startSql}, ${endSql}, 1, 0, 0)`, [`NF MPO Offer ${stamp} ${tag}`])).insertId;
      fx.offers.push(id);
      await q("INSERT INTO offer_products (offer_id, product_id, original_price, sale_price) VALUES ?", [rows.map(([pid, o, s]) => [id, pid, o, s])]);
      return id;
    };
    const [PA1, PA2, PB2, PE, PX, PS, PR, PN] = P.slice(20, 28);
    const name = pid => `NF MPO ${stamp} #${P.indexOf(pid)}`;
    // MA: two products. MB: PA1 again, cheaper (95 < 100), plus PB2. MC: PA1 again, dearer.
    const MA = await mkOffer("MA", [[PA1, 120, 100], [PA2, 121, 90], [PR, 126, 60]]);
    const MB = await mkOffer("MB", [[PA1, 120, 95], [PB2, 122, 80]]);
    const MC = await mkOffer("MC", [[PA1, 120, 110]]);
    const ME = await mkOffer("ME-expired", [[PE, 123, 50]], "NOW() - INTERVAL 2 DAY", "NOW() - INTERVAL 1 HOUR");
    const MX = await mkOffer("MX-expires-mid-test", [[PX, 124, 70]]);
    const MS = await mkOffer("MS-single", [[PS, 125, 99]]);

    const profile = path.join(os.tmpdir(), "nf-edge-mpo"); fs.rmSync(profile, { recursive: true, force: true });
    edge = spawn("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", ["--headless=new", "--remote-debugging-port=9345", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
    let wsUrl; for (let i = 0; i < 150 && !wsUrl; i++) { try { wsUrl = (await (await fetch("http://127.0.0.1:9345/json/list")).json()).find(t => t.type === "page")?.webSocketDebuggerUrl; } catch (e) {} if (!wsUrl) await sleep(200); }
    ws = new WebSocket(wsUrl); await new Promise(res => ws.addEventListener("open", res, { once: true }));
    let id = 0, loads = 0; const pending = new Map(); const exceptions = []; const consoleErrors = [];
    ws.addEventListener("message", msg => {
      const m = JSON.parse(msg.data); const p = m.params || {};
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
      if (m.method === "Fetch.requestPaused") send("Fetch.continueRequest", { requestId: p.requestId, url: p.request.url.replace("http://localhost:5000", API) });
      if (m.method === "Page.loadEventFired") loads++;
      if (m.method === "Runtime.exceptionThrown") exceptions.push(p.exceptionDetails.exception?.description?.split("\n")[0]);
      if (m.method === "Runtime.consoleAPICalled" && p.type === "error") consoleErrors.push(p.args.map(a => a.value || a.description).join(" ").slice(0, 160));
    });
    const send = (method, params = {}) => new Promise(res => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
    await send("Page.enable"); await send("Runtime.enable"); await send("Network.enable"); await send("Network.setCacheDisabled", { cacheDisabled: true });
    await send("Fetch.enable", { patterns: [{ urlPattern: "http://localhost:5000/*" }] });
    await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    const ev = async e => { const x = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); return x.result?.exceptionDetails ? { __err: x.result.exceptionDetails.exception?.description } : x.result?.result?.value; };
    const go = async url => { const b = loads; await send("Page.navigate", { url }); for (let i = 0; i < 150 && loads === b; i++) await sleep(100); await sleep(1200); };
    const waitFor = async (e, ms = 10000) => { for (let t = 0; t < ms; t += 150) { const v = await ev(e); if (v && !v.__err) return true; await sleep(150); } return false; };
    const getCartLS = async () => JSON.parse(await ev(`localStorage.getItem("neofragrances_cart") || "[]"`));
    const setCartLS = async items => { await go(`${FRONT}/about.html`); await ev(`localStorage.setItem("neofragrances_cart", ${JSON.stringify(JSON.stringify(items))}); true`); };
    // Opens the bag and waits for the server quote (or its error) to settle.
    const openCart = async () => {
      await go(`${FRONT}/cart.html`);
      await waitFor(`document.querySelectorAll(".nf-line").length > 0`);
      await waitFor(`/GH₵/.test(document.getElementById("summary-subtotal")?.textContent || "") || !!document.querySelector(".nf-line-issue")`);
      await sleep(600);
    };
    const lineInfo = () => ev(`[...document.querySelectorAll(".nf-line")].map(l => ({ id: Number(l.dataset.id), offerId: l.dataset.offerId ? Number(l.dataset.offerId) : null,
      sale: l.querySelector(".nf-line-sale")?.textContent || null, issue: l.querySelector(".nf-line-issue")?.textContent.trim() || null }))`);
    const quote = items => call("POST", "/api/cart/quote", null, { items });

    // --- offers page: one card per product, at the lowest price ---
    await go(`${FRONT}/special-offers.html`);
    await waitFor(`document.querySelectorAll("#offers-grid .offer-card").length > 0`);
    const cards = await ev(`[...document.querySelectorAll("#offers-grid .offer-card")].map(c => ({ name: c.querySelector(".product-name").textContent.trim(),
      sale: c.querySelector(".offer-price-sale").textContent.trim(), offerId: Number(c.querySelector(".add-to-cart").dataset.offerId) }))`);
    const cardsFor = pid => cards.filter(c => c.name === name(pid));
    check("B1. offers page: PA1 (in 3 live offers) has exactly ONE card, at the lowest price GH₵95.00 from offer MB",
      cardsFor(PA1).length === 1 && cardsFor(PA1)[0].sale === "GH₵95.00" && cardsFor(PA1)[0].offerId === MB, JSON.stringify(cardsFor(PA1)));
    check("B2. offers page: both other products of the two-product offer MA are shown, each at its own price",
      cardsFor(PA2).length === 1 && cardsFor(PA2)[0].sale === "GH₵90.00" && cardsFor(PR).length === 1 && cardsFor(PR)[0].sale === "GH₵60.00", JSON.stringify([cardsFor(PA2), cardsFor(PR)]));
    check("B3. offers page: no product appears twice; the expired offer's product is absent; the single-product offer still shows",
      new Set(cards.map(c => c.name)).size === cards.length && cardsFor(PE).length === 0 && cardsFor(PS).length === 1 && cardsFor(PS)[0].sale === "GH₵99.00", `${cards.length} cards`);

    // --- product details and product cards agree on the lowest price ---
    await go(`${FRONT}/product-details.html?id=${PA1}`);
    await waitFor(`!!document.querySelector(".pd-price")`);
    check("B4. product details for PA1 shows the lowest live offer (GH₵95.00, was GH₵120.00), not the first matching offer",
      (await ev(`document.querySelector(".pd-price").textContent.trim()`)) === "GH₵95.00" && (await ev(`document.querySelector(".pd-price-stock-row .offer-price-original")?.textContent.trim()`)) === "GH₵120.00");
    await ev(`localStorage.removeItem("neofragrances_cart"); true`);
    await ev(`document.getElementById("pd-add-cart").click(); true`);
    check("B5. Add to Cart on product details carries the lowest offer (MB)", JSON.stringify(await getCartLS()) === JSON.stringify([{ id: PA1, qty: 1, offerId: MB }]), JSON.stringify(await getCartLS()));
    await go(`${FRONT}/products.html?q=${encodeURIComponent(name(PA1))}`);
    await waitFor(`[...document.querySelectorAll(".product-card")].some(c => c.innerText.includes(${JSON.stringify(name(PA1))}))`);
    await sleep(800);
    const card = await ev(`(() => { const c = [...document.querySelectorAll(".product-card")].find(c => c.querySelector(".product-name")?.textContent.trim() === ${JSON.stringify(name(PA1))});
      return c ? { sale: c.querySelector(".product-price--sale")?.textContent.trim(), offerId: Number(c.querySelector(".add-to-cart")?.dataset.offerId) } : null; })()`);
    check("B6. catalogue product card for PA1 shows the same GH₵95.00 and carries offer MB", card && card.sale === "GH₵95.00" && card.offerId === MB, JSON.stringify(card));
    const pdS = await (async () => { await go(`${FRONT}/product-details.html?id=${PS}`); await waitFor(`!!document.querySelector(".pd-price")`); return ev(`document.querySelector(".pd-price").textContent.trim()`); })();
    check("B7. single-product offer unchanged: its product details show GH₵99.00", pdS === "GH₵99.00", pdS);

    // --- cart: offer rows are matched by (offer id, product id) ---
    await setCartLS([{ id: PA2, qty: 1, offerId: MA }, { id: PR, qty: 2, offerId: MA }]);
    await openCart();
    let li = await lineInfo();
    const lPA2 = li.find(l => l.id === PA2), lPR = li.find(l => l.id === PR);
    check("B8. two products from the same offer in one cart: both at their own sale price, neither flagged as ended",
      lPA2 && lPR && lPA2.sale === "GH₵90.00" && lPR.sale === "GH₵60.00" && !lPA2.issue && !lPR.issue, JSON.stringify(li));
    check("B9. …and the server-quoted subtotal shown is 90 + 2 × 60 = GH₵210.00",
      (await ev(`document.getElementById("summary-subtotal").textContent.trim()`)) === "GH₵210.00", await ev(`document.getElementById("summary-subtotal").textContent`));

    // --- cart: a line on a dearer offer moves to the product's lowest live offer ---
    await setCartLS([{ id: PA1, qty: 1, offerId: MA }, { id: PA1, qty: 2, offerId: MC }]);
    await openCart();
    li = await lineInfo();
    check("B10. PA1 lines on MA (100) and MC (110) both move to MB (95) and merge into one line of 3",
      JSON.stringify(await getCartLS()) === JSON.stringify([{ id: PA1, qty: 3, offerId: MB }]) && li.length === 1 && li[0].sale === "GH₵95.00", JSON.stringify(await getCartLS()));
    check("B11. …and the server quote prices it at 3 × 95 = GH₵285.00", (await ev(`document.getElementById("summary-subtotal").textContent.trim()`)) === "GH₵285.00");

    // --- invalid offer/product combinations ---
    await setCartLS([{ id: PA2, qty: 1, offerId: ME }]);
    await openCart();
    check("B12. a line carrying an offer that doesn't cover the product moves to that product's live offer (PA2 → MA, GH₵90.00)",
      JSON.stringify(await getCartLS()) === JSON.stringify([{ id: PA2, qty: 1, offerId: MA }]), JSON.stringify(await getCartLS()));
    await setCartLS([{ id: PN, qty: 1, offerId: MA }]);
    await openCart();
    li = await lineInfo();
    r = await quote([{ productId: PN, qty: 1, offerId: MA }]);
    check("B13. offer used on a product it doesn't cover, with no live offer for that product → 'offer has ended' prompt at the regular price, server 409",
      li.length === 1 && /offer on this item has ended/i.test(li[0].issue || "") && /GH₵127\.00/.test(li[0].issue || "") && !li[0].sale && r.status === 409 && r.data.code === "OFFER_UNAVAILABLE", JSON.stringify(li));

    // --- an offer that expires while its product is in the cart ---
    await setCartLS([{ id: PX, qty: 1, offerId: MX }]);
    await openCart();
    li = await lineInfo();
    check("B14. while MX is live, the line shows its sale price GH₵70.00", li[0]?.sale === "GH₵70.00" && !li[0].issue, JSON.stringify(li));
    await q("UPDATE offers SET end_at = NOW() - INTERVAL 1 SECOND WHERE id = ?", [MX]);
    await openCart();
    li = await lineInfo();
    r = await quote([{ productId: PX, qty: 1, offerId: MX }]);
    check("B15. after MX expires (DB clock): the line says the offer ended, shows the regular GH₵124.00, and the server refuses the old price (409)",
      /offer on this item has ended/i.test(li[0]?.issue || "") && /GH₵124\.00/.test(li[0]?.issue || "") && !li[0].sale && r.status === 409 && r.data.code === "OFFER_UNAVAILABLE", JSON.stringify(li));
    await ev(`document.querySelector('.nf-line [data-action="drop-offer"]').click(); true`);
    await waitFor(`(document.getElementById("summary-subtotal")?.textContent || "").includes("124.00")`);
    check("B16. 'Keep it at GH₵124.00' moves the line to the regular price and the server quote is GH₵124.00",
      JSON.stringify(await getCartLS()) === JSON.stringify([{ id: PX, qty: 1, offerId: null }]) && (await ev(`document.getElementById("summary-subtotal").textContent.trim()`)) === "GH₵124.00", JSON.stringify(await getCartLS()));

    // --- a product removed from an offer while it is in the cart ---
    await setCartLS([{ id: PR, qty: 1, offerId: MA }]);
    r = await call("PUT", `/api/admin/offers/${MA}`, tA, base("MA", { items: [item(PA1, 120, 100), item(PA2, 121, 90)], start_at: start, end_at: end }));
    await openCart();
    li = await lineInfo();
    const rq = await quote([{ productId: PR, qty: 1, offerId: MA }]);
    check("B17. product removed from its offer (admin edit): cart shows the 'offer ended' prompt at the regular GH₵126.00 and the server refuses the offer (409)",
      r.status === 200 && /offer on this item has ended/i.test(li[0]?.issue || "") && /GH₵126\.00/.test(li[0]?.issue || "") && rq.status === 409 && rq.data.code === "OFFER_UNAVAILABLE", `${r.status} ${JSON.stringify(li)}`);
    r = await quote([{ productId: PA2, qty: 1, offerId: MA }]);
    check("B18. …while the products still on that offer keep their price (PA2 at 90)", r.status === 200 && r.data.lines[0].unitPrice === 90, JSON.stringify(r.data).slice(0, 120));

    // --- homepage offers: no product twice ---
    await go(`${FRONT}/index.html`);
    await waitFor(`!document.getElementById("offers")?.hidden`);
    await sleep(800);
    const homeIds = await ev(`[...document.querySelectorAll("#offers .add-to-cart")].map(b => Number(b.dataset.id))`);
    const homePA1 = await ev(`(() => { const b = document.querySelector('#offers .add-to-cart[data-id="${PA1}"]'); return b ? Number(b.dataset.offerId) : null; })()`);
    check("B19. homepage offers: no product shown twice, and PA1 (if shown) carries its lowest offer MB",
      Array.isArray(homeIds) && homeIds.length > 0 && new Set(homeIds).size === homeIds.length && (homePA1 === null || homePA1 === MB), JSON.stringify({ homeIds, homePA1 }));

    check("B20. no uncaught JavaScript exceptions on any customer page", exceptions.length === 0, exceptions.join(" | "));

    /* ================= Phase 6D: customer presentation of multi-product offers ================= */
    // MF: featured flash sale on 3 fixture products + PA1, which MB already prices lower (95 < 99).
    // MI (inactive) and MSc (scheduled) must never show as discounts; ME (expired) is from 6B.
    const [PF1, PF2, PF3, PI, PSc] = [P[16], P[17], P[18], P[19], P[28]];
    const MF = await mkOffer("MF-featured-flash", [[PF1, 200, 150], [PF2, 201, 160], [PF3, 202, 170], [PA1, 120, 99]]);
    await q("UPDATE offers SET featured = 1, offer_type = 'flash_sale' WHERE id = ?", [MF]);
    const MI = await mkOffer("MI-inactive", [[PI, 119, 50]]);
    await q("UPDATE offers SET active = 0 WHERE id = ?", [MI]);
    const MSc = await mkOffer("MSc-scheduled", [[PSc, 128, 60]], "NOW() + INTERVAL 1 DAY", "NOW() + INTERVAL 3 DAY");
    const MF_IDS = [PF1, PF2, PF3, PA1];
    const j6 = v => JSON.stringify(v);
    const exD = exceptions.length, ceD = consoleErrors.length;
    const noOverflow = () => ev("document.documentElement.scrollWidth <= window.innerWidth + 1");
    const SHOTS6D = path.join(os.tmpdir(), "nf-mpo-shots"); fs.mkdirSync(SHOTS6D, { recursive: true });
    const shot6d = async n => { const x = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(SHOTS6D, n + ".png"), Buffer.from(x.result.data, "base64")); };
    const offersPageCards = () => ev(`[...document.querySelectorAll("#offers-grid .offer-card")].map(c => ({ id: Number(c.dataset.id), sale: c.querySelector(".offer-price-sale").textContent.trim(),
      orig: c.querySelector(".offer-price-original").textContent.trim(), save: c.querySelector(".offer-save-badge").textContent.trim(), offerId: Number(c.querySelector(".add-to-cart").dataset.offerId),
      href: c.querySelector(".view-details-link").getAttribute("href"), hi: c.classList.contains("offer-card--in-offer") }))`);

    await go(`${FRONT}/special-offers.html`);
    await waitFor(`document.querySelectorAll("#offers-grid .offer-card").length > 0 && !!document.querySelector(".featured-offer-banner")`);
    let oc = await offersPageCards();
    const card6 = pid => oc.filter(c => c.id === pid);
    check("E1. offers page: one card per product (no product twice), each linking to its own product page",
      oc.length > 0 && new Set(oc.map(c => c.id)).size === oc.length && oc.every(c => c.href === `product-details.html?id=${c.id}`), `${oc.length} cards`);
    check("E2. multi-product offer MF: each product's own original, sale and SAVE % (200→150 25%, 201→160 20%, 202→170 16%)",
      j6([PF1, PF2, PF3].map(pid => card6(pid).map(c => [c.orig, c.sale, c.save, c.offerId === MF]))) === j6([[["GH₵200.00", "GH₵150.00", "SAVE 25%", true]], [["GH₵201.00", "GH₵160.00", "SAVE 20%", true]], [["GH₵202.00", "GH₵170.00", "SAVE 16%", true]]]),
      j6([PF1, PF2, PF3].map(card6)));
    check("E3. overlap: PA1 is in MF at 99 but shown once at its lowest live price, GH₵95.00 from MB",
      card6(PA1).length === 1 && card6(PA1)[0].sale === "GH₵95.00" && card6(PA1)[0].offerId === MB, j6(card6(PA1)));
    check("E4. inactive (MI), scheduled (MSc) and expired (ME) offers' products have no discount card",
      card6(PI).length === 0 && card6(PSc).length === 0 && card6(PE).length === 0);
    const banner = await ev(`(()=>{const b=document.querySelector(".featured-offer-banner"); const m=b.querySelector(".featured-offer-more"); return { product: b.querySelector(".featured-offer-product").textContent.trim(), sale: b.querySelector(".offer-price-sale").textContent.trim(),
      more: m ? m.textContent.trim() : null, href: m ? m.getAttribute("href") : null, label: m ? m.getAttribute("aria-label") : null, cta: b.querySelector(".featured-offer-cta").getAttribute("href") };})()`);
    const bannerPid = [PF1, PF2, PF3].find(pid => banner.product.endsWith(name(pid)));
    check("E5. offers-page banner: the featured offer's product at its MF price, plus '+3 more in this offer' linking to the grid",
      !!bannerPid && banner.sale === card6(bannerPid)[0].sale && banner.more === "+3 more in this offer" && banner.href === "#offers-grid" && /See 3 more products in/.test(banner.label) && banner.cta === `product-details.html?id=${bannerPid}`, j6(banner));
    await shot6d("d6-offers-desktop");
    // Narrow the grid to a type that hides MF's cards, then use the banner link.
    await ev(`document.querySelector('#offer-chips .chip[data-filter="discount"]').click(); true`);
    const hiddenBefore = (await offersPageCards()).filter(c => MF_IDS.includes(c.id)).length;
    await ev(`document.querySelector(".featured-offer-more").click(); true`);
    await sleep(400);
    oc = await offersPageCards();
    check("E6. banner link: resets the type filter, then highlights exactly that offer's products in the grid (incl. PA1)",
      hiddenBefore < 4 && (await ev(`document.querySelector("#offer-chips .chip.active").dataset.filter`)) === "all"
        && j6(oc.filter(c => c.hi).map(c => c.id).sort((a, b) => a - b)) === j6([...MF_IDS].sort((a, b) => a - b)), j6({ hiddenBefore, hi: oc.filter(c => c.hi).map(c => c.id) }));
    await ev(`document.querySelector('#offers-grid .offer-card[data-id="${PF2}"] .view-details-link').click(); true`);
    await waitFor(`location.pathname.endsWith("/product-details.html") && !!document.querySelector(".pd-price")`);
    check("E7. a card's 'View details' opens that product, at the same price (PF2 GH₵160.00)",
      (await ev("location.search")) === `?id=${PF2}` && (await ev(`document.querySelector(".pd-price").textContent.trim()`)) === "GH₵160.00");
    await go(`${FRONT}/product-details.html?id=${PI}`);
    await waitFor(`!!document.querySelector(".pd-price")`);
    check("E8. the inactive offer's product shows its regular price, no strike-through (GH₵119.00)",
      (await ev(`document.querySelector(".pd-price").textContent.trim()`)) === "GH₵119.00" && !(await ev(`!!document.querySelector(".pd-price-stock-row .offer-price-original")`)));

    // --- homepage spotlight ---
    await go(`${FRONT}/index.html`);
    await waitFor(`!document.getElementById("offers")?.hidden && !!document.querySelector(".nf-spotlight")`);
    await sleep(600);
    const spot = await ev(`(()=>{const s=document.querySelector(".nf-spotlight"); const m=s.querySelector(".nf-spotlight-more"); return { pid: Number(s.querySelector(".add-to-cart").dataset.id), offerId: Number(s.querySelector(".add-to-cart").dataset.offerId),
      sale: s.querySelector(".nf-price-sale").textContent.trim(), orig: s.querySelector(".nf-price-original").textContent.trim(), more: m ? m.textContent.trim() : null, href: m ? m.getAttribute("href") : null,
      gridIds: [...document.querySelectorAll("#offer-grid .add-to-cart")].map(b => Number(b.dataset.id)) };})()`);
    const expectSale = { [PF1]: ["GH₵150.00", "GH₵200.00"], [PF2]: ["GH₵160.00", "GH₵201.00"], [PF3]: ["GH₵170.00", "GH₵202.00"] }[spot.pid];
    check("E9. homepage spotlight: MF's primary product at its sale and original price, with '+3 more in this offer'",
      spot.offerId === MF && !!expectSale && spot.sale === expectSale[0] && spot.orig === expectSale[1] && spot.more === "+3 more in this offer" && spot.href === "special-offers.html#offers-grid", j6(spot));
    check("E10. homepage: no product appears twice across the spotlight and the offer cards", ![spot.pid, ...spot.gridIds].some((x, i, a) => a.indexOf(x) !== i), j6(spot.gridIds));
    await shot6d("d6-home-desktop");
    const homeDesktop = await noOverflow();
    await ev(`document.querySelector(".nf-spotlight-more").click(); true`);
    await waitFor(`location.pathname.endsWith("/special-offers.html") && document.querySelectorAll("#offers-grid .offer-card").length > 0`);
    check("E11. '+3 more' opens the offers page at the grid, where all 4 of MF's products are listed",
      (await ev("location.hash")) === "#offers-grid" && (await offersPageCards()).filter(c => MF_IDS.includes(c.id)).length === 4);
    const offersDesktop = await noOverflow();

    // --- narrow screens ---
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await go(`${FRONT}/index.html`);
    await waitFor(`!!document.querySelector(".nf-spotlight-more")`); await sleep(600);
    await ev(`document.querySelector(".nf-spotlight").scrollIntoView(); true`); await sleep(500);
    const homeMobile = await noOverflow();
    await shot6d("d6-home-mobile");
    await go(`${FRONT}/special-offers.html`);
    await waitFor(`!!document.querySelector(".featured-offer-more")`); await sleep(400);
    await ev(`document.querySelector(".featured-offer-banner").scrollIntoView(); true`); await sleep(300);
    const offersMobile = await noOverflow();
    await shot6d("d6-offers-mobile");
    await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    check("E12. no horizontal overflow: homepage and offers page at 1366px and 390px", homeDesktop && offersDesktop && homeMobile && offersMobile, j6({ homeDesktop, offersDesktop, homeMobile, offersMobile }));

    // --- a single-product offer shows no "+N more" ---
    await q("DELETE FROM offer_products WHERE offer_id = ? AND product_id <> ?", [MF, spot.pid]);
    await go(`${FRONT}/index.html`);
    await waitFor(`!!document.querySelector(".nf-spotlight")`); await sleep(600);
    const spot1 = await ev(`({ pid: Number(document.querySelector(".nf-spotlight .add-to-cart").dataset.id), more: !!document.querySelector(".nf-spotlight-more") })`);
    await go(`${FRONT}/special-offers.html`);
    await waitFor(`!!document.querySelector(".featured-offer-banner")`);
    check("E13. once MF covers one product, neither the spotlight nor the banner shows '+N more'",
      spot1.pid === spot.pid && !spot1.more && !(await ev(`!!document.querySelector(".featured-offer-more")`)), j6(spot1));
    check("E14. no uncaught exceptions or console errors on the 6D pages", exceptions.length === exD && consoleErrors.length === ceD, [...exceptions.slice(exD), ...consoleErrors.slice(ceD)].join(" | "));
    // Remove the 6D offers so the admin section below starts from the 6B state.
    await q("DELETE FROM offer_products WHERE offer_id IN (?)", [[MF, MI, MSc]]);
    await q("DELETE FROM offers WHERE id IN (?)", [[MF, MI, MSc]]);

    /* ================= Phase 6C: admin offer editor + list, in headless Edge ================= */
    // Uses fixture products P[30..50] (on no offer at this point) plus the offers built above.
    // Screenshots go to the OS temp folder, not the repo.
    const SHOTS = path.join(os.tmpdir(), "nf-mpo-shots"); fs.mkdirSync(SHOTS, { recursive: true });
    const shot = async name => { const x = await send("Page.captureScreenshot", { format: "png" }); fs.writeFileSync(path.join(SHOTS, name + ".png"), Buffer.from(x.result.data, "base64")); };
    const exBefore = exceptions.length;
    const ADM = `${FRONT}/admin/special-offers.html`;
    const js = v => JSON.stringify(v);
    const click = sel => ev(`(()=>{const e=document.querySelector(${js(sel)}); if(!e) return false; e.scrollIntoView({block:"center"}); e.click(); return true;})()`);
    const setVal = (sel, value) => ev(`(()=>{const e=document.querySelector(${js(sel)}); e.value=${js(value)}; e.dispatchEvent(new Event("input",{bubbles:true})); return true;})()`);
    const keyOn = (sel, key) => ev(`(()=>{const e=document.querySelector(${js(sel)}); e.focus(); e.dispatchEvent(new KeyboardEvent("keydown",{key:${js(key)},bubbles:true,cancelable:true})); return true;})()`);
    // Adds a product the way an admin would: type its ID in the search, arrow to it, press Enter.
    const addViaUI = async pid => { await setVal("#of-product-search", `#${pid}`); await keyOn("#of-product-search", "ArrowDown"); await keyOn("#of-product-search", "Enter"); };
    const editorRows = () => ev(`[...document.querySelectorAll("#of-items > .adm-op-row")].map(r => ({ pid: Number(r.dataset.pid), o: r.querySelector('[data-k="original_price"]').value, s: r.querySelector('[data-k="sale_price"]').value,
      off: r.querySelector("[data-op-off]").textContent.trim(), err: r.querySelector("[data-op-error]").textContent.trim(), invalid: r.classList.contains("is-invalid") }))`);
    const rowSel = pid => `#of-items > .adm-op-row[data-pid="${pid}"]`;
    const setPrice = (pid, k, v) => setVal(`${rowSel(pid)} [data-k="${k}"]`, v);
    const drawerStatus = () => ev(`document.querySelector(".adm-drawer .adm-form-status")?.textContent.trim() || ""`);
    const listRow = oid => ev(`(()=>{const tr=document.querySelector('#f-body tr[data-offer-id="${oid}"]'); return tr ? { text: tr.innerText.replace(/\\s+/g," "), range: tr.querySelector("[data-price-range]")?.textContent.trim() || null, status: tr.querySelector(".adm-badge")?.textContent.trim(), toggle: tr.querySelector('[data-action="toggle"]').textContent, feature: tr.querySelector('[data-action="feature"]').textContent } : null;})()`);
    const openAdmin = async () => { await go(ADM); await waitFor(`!!document.getElementById("f-body") && document.querySelectorAll("#f-body tr[data-offer-id]").length > 0`); };
    const openNew = async () => { await click("#new-offer"); await waitFor(`!!document.getElementById("offer-form")`); };
    const saveDrawer = async () => { await click("[data-drawer-save]"); };
    const drawerClosed = () => waitFor(`!document.querySelector(".adm-drawer")`);
    const newestFixtureOffer = async title => (await q("SELECT id FROM offers WHERE title = ? ORDER BY id DESC LIMIT 1", [`NF MPO Offer ${stamp} ${title}`]))[0]?.id;
    const C6 = P.slice(30, 51);
    await ev(`localStorage.setItem("neofragrances_auth", ${js(js({ token: tA, user: { id: ADMIN, full_name: "MPO Admin", role: "admin" } }))}); true`);

    // --- the list: one row per offer ---
    await openAdmin();
    const listIds = await ev(`[...document.querySelectorAll("#f-body tr[data-offer-id]")].map(tr => Number(tr.dataset.offerId))`);
    const offerCount = Number((await q("SELECT COUNT(*) n FROM offers"))[0].n);
    check("D1. admin list: exactly one row per offer (rows = offers table, no repeated ids, restored offers 1 and 30002 once each)",
      listIds.length === offerCount && new Set(listIds).size === listIds.length && listIds.filter(x => x === 1).length === 1 && listIds.filter(x => x === 30002).length === 1, `${listIds.length} rows vs ${offerCount} offers`);
    const rMB = await listRow(MB), rR1 = await listRow(1);
    check("D2. multi-product row shows its product count and sale-price range (MB: 2 products, GH₵80.00 – GH₵95.00)",
      rMB && /\b2 products\b/.test(rMB.text) && rMB.range === "GH₵80.00 – GH₵95.00", js(rMB));
    check("D3. single-product row unchanged: restored offer 1 shows its product and GH₵200.00, no product count",
      rR1 && /GH₵200\.00/.test(rR1.text) && /GH₵260\.00/.test(rR1.text) && !/\d products\b/.test(rR1.text), js(rR1));
    const rFM = await listRow(FM);
    check("D4. warnings: FM's archived product is named, and FM (deactivated) shows Inactive",
      rFM && rFM.text.includes(`NF MPO ${stamp} #2 is archived and won't show in the store`) && rFM.status === "Inactive", js(rFM));
    const allPrices = await ev(`(()=>{const tr=document.querySelector('#f-body tr[data-offer-id="${MA}"]'); const d=tr.querySelector("details"); d.open=true; return [...d.querySelectorAll("li")].map(li=>li.innerText.replace(/\\s+/g," ").trim());})()`);
    check("D5. 'All N prices' lists every product of the offer with its own sale and original price (MA)",
      allPrices.length === 2 && allPrices[0].includes(name(PA1)) && allPrices[0].includes("GH₵100.00") && allPrices[0].includes("GH₵120.00") && allPrices[1].includes("GH₵90.00"), js(allPrices));
    await shot("c6-list-desktop");

    // --- create: empty, search, add, duplicate, remove, bulk %, manual edit ---
    await openNew();
    check("D6. new offer: empty state, '0 of 50', bulk helper hidden",
      await ev(`!document.getElementById("of-items-empty").hidden && document.getElementById("of-items-count").textContent === "0 of 50" && document.getElementById("of-bulk-group").hidden`));
    await setVal("#of-title", `NF MPO Offer ${stamp} UI-create`);
    const cBefore = await counts();
    await saveDrawer(); await sleep(500);
    check("D7. saving with no products is blocked in the browser ('Add at least one product'), nothing sent, form kept",
      /Add at least one product/.test(await ev(`document.querySelector('[data-error-for="items"]').textContent`)) && JSON.stringify(await counts()) === JSON.stringify(cBefore)
        && (await ev(`document.getElementById("of-title").value`)) === `NF MPO Offer ${stamp} UI-create`);
    await setVal("#of-product-search", `NF MPO ${stamp}`);
    const note = await ev(`document.getElementById("of-product-note").textContent`);
    const optCount = await ev(`document.querySelectorAll("#of-product-results .adm-op-opt").length`);
    await setVal("#of-product-search", `NF MPO ${stamp} archived`);
    const archivedOpts = await ev(`document.querySelectorAll("#of-product-results .adm-op-opt").length`);
    check("D8. product search: shows 8 at a time of the 50 live fixtures, and archived products are not offered",
      optCount === 8 && /Showing 8 of 50/.test(note) && archivedOpts === 0, `${optCount} ${note} archived=${archivedOpts}`);
    await setVal("#of-product-search", `#${C6[0]}`);
    const opt = await ev(`document.querySelector("#of-product-results .adm-op-opt")?.innerText.replace(/\\s+/g," ")`);
    check("D9. each result shows name, brand, product ID, price and stock", opt && opt.includes(name(C6[0])) && opt.includes("NF MPO Test") && opt.includes(`#${C6[0]}`) && opt.includes("GH₵130.00") && opt.includes("10 in stock"), opt);
    for (const pid of C6.slice(0, 4)) await addViaUI(pid);
    let er = await editorRows();
    check("D10. four products added from the keyboard: rows in order, originals pre-filled from store prices, '4 of 50', focus stays in the search",
      js(er.map(r => [r.pid, r.o, r.s])) === js(C6.slice(0, 4).map((pid, i) => [pid, (130 + i).toFixed(2), ""])) && (await ev(`document.getElementById("of-items-count").textContent`)) === "4 of 50"
        && (await ev(`document.activeElement.id`)) === "of-product-search", js(er));
    await addViaUI(C6[0]);
    const dupOpt = await ev(`(()=>{const o=document.querySelector('#of-opt-${C6[0]}'); return o ? o.getAttribute("aria-disabled") + "|" + o.innerText.trim() : null;})()`);
    check("D11. duplicate prevention: an added product shows 'Added', is disabled, and Enter doesn't add it again",
      (await editorRows()).length === 4 && dupOpt && dupOpt.startsWith("true|") && /Added/.test(dupOpt), dupOpt);
    await click(`${rowSel(C6[1])} [data-op-remove]`);
    er = await editorRows();
    check("D12. remove a row: it disappears, numbering and count update ('3 of 50'), focus moves to the next row's remove button",
      js(er.map(r => r.pid)) === js([C6[0], C6[2], C6[3]]) && (await ev(`document.getElementById("of-items-count").textContent`)) === "3 of 50"
        && (await ev(`document.activeElement.closest(".adm-op-row")?.dataset.pid`)) === String(C6[2]) && (await ev(`document.getElementById("of-product-note").textContent`)) === `${name(C6[1])} removed.`, js(er.map(r => r.pid)));
    await setPrice(C6[2], "original_price", "300");
    await setVal("#of-bulk", "20"); await click("[data-op-bulk]");
    er = await editorRows();
    check("D13. bulk 20% off sets each sale price from that product's own original (130→104.00, 300→240.00, 133→106.40)",
      js(er.map(r => r.s)) === js(["104.00", "240.00", "106.40"]) && er[0].off.startsWith("−20%") && /applied to 3 products/.test(await ev(`document.getElementById("of-bulk-status").textContent`)), js(er.map(r => [r.s, r.off])));
    await setVal("#of-bulk", "33.33"); await click("[data-op-bulk]");
    check("D14. bulk rounds to the nearest pesewa per product (33.33% off 130.00 → 86.67, 300.00 → 200.01, 133.00 → 88.67)",
      js((await editorRows()).map(r => r.s)) === js(["86.67", "200.01", "88.67"]), js((await editorRows()).map(r => r.s)));
    await setVal("#of-bulk", "150"); await click("[data-op-bulk]");
    check("D15. bulk rejects an impossible percentage and leaves the prices alone",
      /0\.01 to 99\.99/.test(await ev(`document.getElementById("of-bulk-error").textContent`)) && js((await editorRows()).map(r => r.s)) === js(["86.67", "200.01", "88.67"]));
    await setPrice(C6[0], "sale_price", "99.99");
    await setPrice(C6[2], "sale_price", "289.15");
    await setPrice(C6[3], "sale_price", "200");
    await saveDrawer(); await sleep(500);
    er = await editorRows();
    check("D16. sale above original is blocked in the browser on the right row, with a clear message; nothing sent; values kept",
      er[2].invalid && /cannot be higher than the original/.test(er[2].err) && /^Product 3/.test(await drawerStatus()) && JSON.stringify(await counts()) === JSON.stringify(cBefore) && er[0].s === "99.99" && er[1].s === "289.15", js(er));
    await setPrice(C6[3], "sale_price", "abc");
    await setPrice(C6[3], "sale_price", "");
    await saveDrawer(); await sleep(300);
    check("D17. an empty sale price is caught ('Enter the sale price')", /Enter the sale price/.test((await editorRows())[2].err), js(await editorRows()));
    await setPrice(C6[3], "sale_price", "120");
    // The server stays authoritative: archive a product after it was picked, then save.
    await q("UPDATE products SET deleted_at = NOW() WHERE id = ?", [C6[3]]);
    await saveDrawer();
    await waitFor(`!!document.querySelector("#of-items > .adm-op-row.is-invalid")`);
    er = await editorRows();
    check("D18. a server rejection (product archived meanwhile) is shown on that row with the API's message; the form keeps every value; nothing written",
      er[2].invalid && /archived/.test(er[2].err) && !!(await ev(`document.querySelector(".adm-drawer")`)) && js(er.map(r => [r.pid, r.s])) === js([[C6[0], "99.99"], [C6[2], "289.15"], [C6[3], "120"]]) && JSON.stringify(await counts()) === JSON.stringify(cBefore), js(er));
    await q("UPDATE products SET deleted_at = NULL WHERE id = ?", [C6[3]]);
    await click(`${rowSel(C6[3])} [data-op-remove]`);
    await shot("c6-editor-desktop");
    await saveDrawer(); await drawerClosed();
    const NEW = await newestFixtureOffer("UI-create");
    if (NEW) fx.offers.push(NEW);
    check("D19. create succeeds with exactly the intended set and per-product prices (incl. 289.15) in order",
      NEW && js(pairs(await rowsOf(NEW))) === js([[C6[0], 130, 99.99], [C6[2], 300, 289.15]]), NEW && js(pairs(await rowsOf(NEW))));
    await waitFor(`!!document.querySelector('#f-body tr[data-offer-id="${NEW}"]')`);
    const rNEW = await listRow(NEW);
    check("D20. the new offer appears once in the list: '2 products', GH₵99.99 – GH₵289.15, Live",
      (await ev(`document.querySelectorAll('#f-body tr[data-offer-id="${NEW}"]').length`)) === 1 && /\b2 products\b/.test(rNEW.text) && rNEW.range === "GH₵99.99 – GH₵289.15" && rNEW.status === "Live", js(rNEW));

    // --- edit: stored pairs load, unchanged pairs are preserved ---
    await click(`#f-body tr[data-offer-id="${NEW}"] [data-action="edit"].adm-cell-title`);
    await waitFor(`document.querySelectorAll("#of-items > .adm-op-row").length === 2`);
    er = await editorRows();
    check("D21. edit loads the offer's own stored prices (not store prices) and flags drift (300.00 vs store 132.00)",
      js(er.map(r => [r.pid, r.o, r.s])) === js([[C6[0], "130.00", "99.99"], [C6[2], "300.00", "289.15"]]) && /Store price is GH₵132\.00/.test(er[1].off) && !/Store price/.test(er[0].off), js(er));
    await addViaUI(C6[4]); await setPrice(C6[4], "sale_price", "120");
    await setVal("#of-title", `NF MPO Offer ${stamp} UI-create`);
    await saveDrawer(); await drawerClosed();
    check("D22. edit adds a product and keeps the existing product-price pairs exactly",
      js(pairs(await rowsOf(NEW))) === js([[C6[0], 130, 99.99], [C6[2], 300, 289.15], [C6[4], 134, 120]]), js(pairs(await rowsOf(NEW))));

    // --- a failed update leaves the saved offer as it was; removal only applies on success ---
    const savedNew = js([await offerRow(NEW), await rowsOf(NEW)]);
    await openAdmin();
    await click(`#f-body tr[data-offer-id="${NEW}"] [data-action="edit"].adm-cell-title`);
    await waitFor(`document.querySelectorAll("#of-items > .adm-op-row").length === 3`);
    await click(`${rowSel(C6[0])} [data-op-remove]`);
    const savedRemovalNote = await ev(`document.getElementById("of-product-note").textContent`);
    await addViaUI(P[45]); await setPrice(P[45], "sale_price", "100");
    await setVal("#of-title", `NF MPO Offer ${stamp} UI-create RENAMED`);
    await pool.query(`CREATE TRIGGER ${TRIGGER} BEFORE INSERT ON offer_products FOR EACH ROW
                      BEGIN IF NEW.product_id = ${Number(P[45])} THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'forced offer_products failure (test)'; END IF; END`);
    try {
      await saveDrawer();
      await waitFor(`/Could not update offer/.test(document.querySelector(".adm-drawer .adm-form-status")?.textContent || "")`);
      check("D23. a failed update (server 500) shows the API message, keeps the drawer and its edits, and the saved offer is untouched (removed product still on it)",
        /Could not update offer/.test(await drawerStatus()) && js((await editorRows()).map(r => r.pid)) === js([C6[2], C6[4], P[45]]) && js([await offerRow(NEW), await rowsOf(NEW)]) === savedNew
          && /comes off the offer when you save/.test(savedRemovalNote), `${await drawerStatus()} | ${savedRemovalNote}`);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${TRIGGER}`);
    }
    await click("[data-drawer-cancel]");
    const discardAsked = await waitFor(`!!document.querySelector(".adm-dialog-wrap")`, 4000);
    await click('[data-dlg="ok"]'); await drawerClosed();
    check("D24. closing with unsaved edits asks to discard; after discarding the offer is still exactly as saved", discardAsked && js([await offerRow(NEW), await rowsOf(NEW)]) === savedNew);

    // --- active / featured / delete still work on a multi-product offer ---
    await click(`[data-action="toggle"][data-id="${NEW}"]`);
    await waitFor(`document.querySelector('[data-action="toggle"][data-id="${NEW}"]')?.textContent === "Activate"`);
    await click(`[data-action="feature"][data-id="${NEW}"]`);
    await waitFor(`document.querySelector('[data-action="feature"][data-id="${NEW}"]')?.textContent === "Unfeature"`);
    const flags = await offerRow(NEW), rFlags = await listRow(NEW);
    check("D25. Deactivate and Feature still work: DB active=0 featured=1, row shows Inactive + Activate / Unfeature, all 3 products kept",
      flags.active === 0 && flags.featured === 1 && rFlags.status === "Inactive" && rFlags.toggle === "Activate" && rFlags.feature === "Unfeature" && (await rowsOf(NEW)).length === 3, js([flags, rFlags]));
    await click(`[data-action="toggle"][data-id="${NEW}"]`);
    await waitFor(`document.querySelector('[data-action="toggle"][data-id="${NEW}"]')?.textContent === "Deactivate"`);
    check("D26. Activate brings it back to Live", (await offerRow(NEW)).active === 1 && (await listRow(NEW)).status === "Live");

    // --- the 1- and 50-product boundaries (51 can't be reached) ---
    await openNew();
    await setVal("#of-title", `NF MPO Offer ${stamp} UI-one`);
    await addViaUI(C6[5]); await setPrice(C6[5], "sale_price", "100");
    await saveDrawer(); await drawerClosed();
    const ONE = await newestFixtureOffer("UI-one"); if (ONE) fx.offers.push(ONE);
    await waitFor(`!!document.querySelector('#f-body tr[data-offer-id="${ONE}"]')`);
    const rONE = await listRow(ONE);
    check("D27. 1-product boundary: saved with one row, listed in the single-product layout",
      ONE && js(pairs(await rowsOf(ONE))) === js([[C6[5], 135, 100]]) && rONE.text.includes(name(C6[5])) && !/\d products\b/.test(rONE.text) && /GH₵100\.00/.test(rONE.text), js(rONE));

    await openNew();
    await setVal("#of-title", `NF MPO Offer ${stamp} UI-fifty`);
    const live50 = P.filter(pid => pid !== P[2]);
    for (const pid of live50) await addViaUI(pid);
    await setVal("#of-bulk", "10"); await click("[data-op-bulk]");
    check("D28. 50-product boundary: 50 rows, '50 of 50', search disabled with the maximum message, focus moved to the last row",
      (await editorRows()).length === 50 && (await ev(`document.getElementById("of-items-count").textContent`)) === "50 of 50"
        && (await ev(`document.getElementById("of-product-search").disabled && /maximum of 50/.test(document.getElementById("of-product-search").placeholder)`)));
    await ev(`document.getElementById("of-product-search").disabled = false; true`); // force the box open to try a 51st
    // Any live product not on this offer will do; it is only picked in the browser, never saved.
    const extra = (await q("SELECT id FROM products WHERE deleted_at IS NULL AND id NOT IN (?) ORDER BY id LIMIT 1", [live50]))[0].id;
    await addViaUI(extra);
    check("D29. 51st product: refused even if the disabled search is forced open ('at most 50'), still 50 rows",
      (await editorRows()).length === 50 && /at most 50/.test(await ev(`document.getElementById("of-product-note").textContent`)), await ev(`document.getElementById("of-product-note").textContent`));
    await click(`${rowSel(live50[49])} [data-op-remove]`);
    check("D30. removing one re-enables the search ('49 of 50')", (await ev(`!document.getElementById("of-product-search").disabled && document.getElementById("of-items-count").textContent === "49 of 50"`)));
    await addViaUI(live50[49]); await setPrice(live50[49], "sale_price", "135.00");
    await saveDrawer(); await drawerClosed();
    const FIFTY = await newestFixtureOffer("UI-fifty"); if (FIFTY) fx.offers.push(FIFTY);
    const f50 = FIFTY ? pairs(await rowsOf(FIFTY)) : [];
    await waitFor(`!!document.querySelector('#f-body tr[data-offer-id="${FIFTY}"]')`);
    check("D31. the 50-product offer saves with 50 rows, each at 10% off its own price, and is listed once as '50 products'",
      f50.length === 50 && f50[0][2] === 90 && f50[1][2] === 90.9 && (await ev(`document.querySelectorAll('#f-body tr[data-offer-id="${FIFTY}"]').length`)) === 1 && /\b50 products\b/.test((await listRow(FIFTY)).text), js(f50.slice(0, 3)));

    // --- delete asks first; cancel keeps it, confirm removes the offer and every product row ---
    await click(`[data-action="delete"][data-id="${NEW}"]`);
    await waitFor(`!!document.querySelector(".adm-dialog-wrap")`, 4000);
    const dlgText = await ev(`document.querySelector(".adm-dialog-wrap").innerText`);
    await click('[data-dlg="cancel"]'); await sleep(400);
    const keptAfterCancel = (await rowsOf(NEW)).length === 3;
    await click(`[data-action="delete"][data-id="${NEW}"]`);
    await waitFor(`!!document.querySelector(".adm-dialog-wrap")`, 4000);
    await click('[data-dlg="ok"]');
    await waitFor(`!document.querySelector('#f-body tr[data-offer-id="${NEW}"]')`);
    check("D32. delete confirms first (mentions its 3 product prices); Cancel keeps it; confirming removes the offer and all its rows",
      /3 product prices/.test(dlgText) && keptAfterCancel && (await rowsOf(NEW)).length === 0 && Number((await q("SELECT COUNT(*) n FROM offers WHERE id = ?", [NEW]))[0].n) === 0, dlgText);

    // --- accessibility + narrow screens ---
    await openAdmin();
    await click(`#f-body tr[data-offer-id="${FIFTY}"] [data-action="edit"].adm-cell-title`);
    await waitFor(`document.querySelectorAll("#of-items > .adm-op-row").length === 50`);
    const a11y = await ev(`(()=>{
      const inputs=[...document.querySelectorAll(".adm-drawer input, .adm-drawer select, .adm-drawer textarea")].filter(i=>i.type!=="hidden");
      const unlabeled=inputs.filter(i=>!(i.labels&&i.labels.length)&&!i.getAttribute("aria-label")&&!i.closest("label")).map(i=>i.id||i.name);
      const nameless=[...document.querySelectorAll(".adm-drawer button, #f-body button")].filter(b=>b.offsetParent!==null && !(b.textContent.trim()||b.getAttribute("aria-label"))).length;
      const s=document.getElementById("of-product-search");
      return { unlabeled, nameless, combo: s.getAttribute("role")==="combobox" && s.getAttribute("aria-controls")==="of-product-results" };
    })()`);
    check("D33. accessibility: every editor field has a label, every button a name, the search is an ARIA combobox", a11y.unlabeled.length === 0 && a11y.nameless === 0 && a11y.combo, js(a11y));
    // A real Tab keypress from row 1's sale price lands on row 2's remove button, which must show the gold focus ring.
    await ev(`document.querySelector('${rowSel(live50[0])} [data-k="sale_price"]').focus(); true`);
    await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 }); await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
    const focusRing = await ev(`(()=>{const b=document.activeElement; return (b.matches('${rowSel(live50[1])} [data-op-remove]') ? "row2-remove " : "elsewhere ") + getComputedStyle(b).outlineStyle + " " + getComputedStyle(b).outlineColor;})()`);
    check("D34. keyboard: Tab moves through the rows in order, and focus is visible (gold focus ring on the remove button)", /^row2-remove solid/.test(focusRing) && /184, 147, 95/.test(focusRing), focusRing);
    await click("[data-drawer-close]"); await drawerClosed();

    const overflow = {};
    await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await openAdmin();
    overflow.list = await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`);
    await ev(`(()=>{const d=document.querySelector('#f-body tr[data-offer-id="${MA}"] details'); d.open=true; return true;})()`);
    overflow.listOpen = await ev(`document.documentElement.scrollWidth <= window.innerWidth + 1`);
    await shot("c6-list-mobile");
    await click(`#f-body tr[data-offer-id="${FIFTY}"] [data-action="edit"].adm-cell-title`);
    await waitFor(`document.querySelectorAll("#of-items > .adm-op-row").length === 50`);
    await setVal("#of-product-search", `NF MPO ${stamp}`);
    await sleep(500); // let the drawer finish sliding in
    overflow.drawer = await ev(`(()=>{const b=document.querySelector(".adm-drawer-body"); return b.scrollWidth <= b.clientWidth + 1 && document.querySelector(".adm-drawer").getBoundingClientRect().width <= window.innerWidth;})()`);
    overflow.rows = await ev(`[...document.querySelectorAll(".adm-op-row, .adm-op-results, .adm-op-bulk")].every(r => r.getBoundingClientRect().right <= window.innerWidth + 1)`);
    await shot("c6-editor-mobile");
    check("D35. 390px mobile: no horizontal overflow on the list (also with a product list expanded) or in the 50-product editor with search open", Object.values(overflow).every(Boolean), js(overflow));
    await click("[data-drawer-close]"); await drawerClosed();
    await send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });

    check("D36. no uncaught JavaScript exceptions on the admin offers page", exceptions.length === exBefore, exceptions.slice(exBefore).join(" | "));
    console.log(`screenshots: ${SHOTS}`);
  } catch (e) {
    console.error("HARNESS ERROR:", e); results.push(false);
  } finally {
    try {
      await pool.query(`DROP TRIGGER IF EXISTS ${TRIGGER}`);
      await q("DELETE FROM offer_products WHERE offer_id IN (SELECT id FROM offers WHERE title LIKE ?)", [`NF MPO Offer ${stamp}%`]);
      await q("DELETE FROM offers WHERE title LIKE ?", [`NF MPO Offer ${stamp}%`]);
      if (fx.offers.length) { await q("DELETE FROM offer_products WHERE offer_id IN (?)", [fx.offers]); await q("DELETE FROM offers WHERE id IN (?)", [fx.offers]); }
      if (fx.products.length) { await q("DELETE FROM offer_products WHERE product_id IN (?)", [fx.products]); await q("DELETE FROM products WHERE id IN (?)", [fx.products]); }
      if (fx.users.length) await q("DELETE FROM users WHERE id IN (?)", [fx.users]);
      const after = await snapshot();
      console.log("\nbefore:", JSON.stringify(before), "\nafter: ", JSON.stringify(after));
      check("Z1. database identical to before (every table hashed, no triggers)", JSON.stringify(before) === JSON.stringify(after));
      check("Z2. restored offers 1 and 30002 byte-identical, including updated_at", JSON.stringify(await q(RESTORED_SQL)) === restoredBefore);
    } catch (e) { console.error("CLEANUP ERROR", e.message); results.push(false); }
    try { ws && ws.close(); } catch (e) {}
    if (edge) edge.kill();
    iso.stopServer(server); await pool.end();
    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ""}`);
    process.exit(failed ? 1 : 0);
  }
})();
