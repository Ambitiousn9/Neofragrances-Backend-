// Scent family (Stage A) — migration 008 + the admin scent-family API, against the real
// server.js and the LOCAL db.
//
// WHAT IT COVERS
//   migration 008 (products.scent_family: nullable, default NULL, index, CHECK constraint on
//   MariaDB, no backfill); PATCH /api/admin/products/:id/scent-family (each of the four
//   families, explicit null to unassign, case/whitespace normalisation, re-saving the same
//   value, every malformed / unknown value and payload rejected with the stored value left
//   alone, malformed ids, missing and archived products, auth); PATCH
//   /api/admin/products/scent-family (bulk: 1-100 products, >100 refused, malformed lists,
//   duplicates, missing / archived ids refused with nothing written, a forced failure mid-
//   UPDATE rolled back completely); that only scent_family changes (every other column,
//   including updated_at, is byte-identical); that PUT /api/admin/products/:id without a
//   scent_family keeps it; and that GET /api/products exposes the field.
//
// WHAT IT NEVER TOUCHES
//   any real product, offer, review, user or order. It creates 100 live + 1 archived
//   throwaway products and two temporary users, and deletes them all. The forced-failure
//   case uses a temporary trigger that fires for one fixture product only and is dropped
//   straight after. Every table (minus updated_at) is hashed before and after and must
//   match; the real products are also hashed WITH updated_at and must match.
//
// Ports: API 5075 (5055-5074 and 5099 are taken by the other suites).
const path = require("path"), crypto = require("crypto");
// This file lives in <repo>/tests, so default to the repo root above it.
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
// T04: runs ONLY under the isolated-database guard (nf_test_* on 127.0.0.1:3308); see
// tests/README.md, "Isolated test database". Checked before dotenv and db.js load.
const iso = require("./support/isolated-suite");
iso.requireIsolation("scent-family-tests.js");
require(path.join(process.cwd(), "node_modules/dotenv")).config({ quiet: true });
const jwt = require(path.join(process.cwd(), "node_modules/jsonwebtoken"));
const pool = require(path.join(process.cwd(), "db"));
// Safety gate — never weaken this.
if (!["localhost", "127.0.0.1"].includes(process.env.DB_HOST)) { console.error("not local"); process.exit(1); }
const API = "http://127.0.0.1:5075";
const SECRET = crypto.randomBytes(32).toString("hex");
const TRIGGER = "nf_test_scent_fail";
const FAMILIES = ["floral", "amber", "fresh", "woody"];
const FIXED_UPDATED_AT = "2026-01-01 00:00:00";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const q = async (s, p) => (await pool.query(s, p))[0];
const results = []; const check = (n, c, x = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"} ${n}${x !== "" ? "  [" + String(x).slice(0, 190) + "]" : ""}`); };
const js = v => JSON.stringify(v);
const call = async (method, url, token, body, raw) => {
  const headers = { ...(body !== undefined || raw !== undefined ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const r = await fetch(API + url, { method, headers, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let data = null; try { data = JSON.parse(text); } catch (e) {}
  return { status: r.status, data, text };
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
// The real catalogue, every column INCLUDING updated_at.
const realProductsHash = async () => crypto.createHash("sha256").update(JSON.stringify(await q("SELECT * FROM products ORDER BY id"))).digest("hex").slice(0, 16);

(async () => {
  await iso.verifyParentIdentity(pool, "scent-family-tests.js");
  const stamp = Date.now();
  const fx = { users: [], products: [] };
  const before = await snapshot();
  const realBefore = await realProductsHash();
  // The real catalogue may hold owner-assigned families; only their values are checked (M4).
  const realAssignedBefore = (await q("SELECT scent_family f, COUNT(*) n FROM products WHERE scent_family IS NOT NULL GROUP BY scent_family ORDER BY f"))
    .map(r => ({ f: r.f, n: Number(r.n) }));
  let server;
  try {
    /* ---------- fixtures: 100 live products + 1 archived, one admin, one customer ---------- */
    const P = [];
    for (let i = 0; i < 100; i++) {
      const id = (await q(`INSERT INTO products (name, brand, category, price, stock_qty, badge, image, top_notes, middle_notes, base_notes, description, updated_at)
                           VALUES (?, 'NF Scent Test', 'unisex', ?, ?, 'New', 'images/perfumes/placeholder.jpg', 'top', 'heart', 'base', 'fixture', ?)`,
        [`NF Scent ${stamp} #${i}`, 100 + i, 10 + i, FIXED_UPDATED_AT])).insertId;
      fx.products.push(id); P.push(id);
    }
    const PA = (await q("INSERT INTO products (name, brand, category, price, stock_qty, deleted_at, updated_at) VALUES (?, 'NF Scent Test', 'unisex', 90, 5, NOW(), ?)", [`NF Scent ${stamp} archived`, FIXED_UPDATED_AT])).insertId;
    fx.products.push(PA);
    const mkUser = async (name, role) => { const id = (await q("INSERT INTO users (full_name, email, phone, password_hash, role, email_verified_at, auth_provider) VALUES (?, ?, '0200000000', 'x', ?, NOW(), 'local')", [name, `nf-scent-${name.toLowerCase()}-${stamp}@gmail.com`, role])).insertId; fx.users.push(id); return id; };
    const ADMIN = await mkUser("Admin", "admin"), CUST = await mkUser("Customer", "customer");
    const tA = jwt.sign({ id: ADMIN, role: "admin" }, SECRET);
    const tC = jwt.sign({ id: CUST, role: "customer" }, SECRET);
    const tForged = jwt.sign({ id: CUST, role: "admin" }, SECRET);          // customer claiming admin
    const tBadSig = jwt.sign({ id: ADMIN, role: "admin" }, "not-the-secret");

    // Guarded child; on a startup failure the error carries its last output lines.
    server = await iso.startGuardedServer({ suite: "scent-family-tests.js", port: 5075, env: { JWT_SECRET: SECRET, DEV_EMAIL_LOG: "true", SENDGRID_API_KEY: "" } });

    const famOf = async id => (await q("SELECT scent_family FROM products WHERE id = ?", [id]))[0]?.scent_family ?? null;
    const famsOf = async ids => (await q("SELECT id, scent_family FROM products WHERE id IN (?) ORDER BY id", [ids])).map(r => r.scent_family);
    const setDirect = async (ids, fam) => q("UPDATE products SET scent_family = ?, updated_at = updated_at WHERE id IN (?)", [fam, ids]);
    // Every column except scent_family, as stored (updated_at included).
    const otherFields = async ids => js((await q("SELECT * FROM products WHERE id IN (?) ORDER BY id", [ids])).map(r => { const { scent_family, ...rest } = r; return rest; }));
    const single = (id, body, token = tA, raw) => call("PATCH", `/api/admin/products/${id}/scent-family`, token, body, raw);
    const bulk = (body, token = tA, raw) => call("PATCH", "/api/admin/products/scent-family", token, body, raw);
    const fixtureFieldsAtStart = await otherFields(fx.products);

    /* ================= migration 008 ================= */
    const col = (await q("SHOW COLUMNS FROM products LIKE 'scent_family'"))[0];
    check("M1. migration 008: products.scent_family is VARCHAR(20), nullable, default NULL",
      !!col && col.Type === "varchar(20)" && col.Null === "YES" && col.Default === null, js(col));
    const idx = await q("SHOW INDEX FROM products WHERE Key_name = 'idx_products_scent_family'");
    check("M2. index idx_products_scent_family on scent_family", idx.length === 1 && idx[0].Column_name === "scent_family", js(idx.map(i => i.Column_name)));
    const chk = await q("SELECT CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'chk_products_scent_family'");
    check("M3. CHECK chk_products_scent_family allows only NULL / floral / amber / fresh / woody",
      chk.length === 1 && FAMILIES.every(f => chk[0].CHECK_CLAUSE.includes(`'${f}'`)) && /is null/i.test(chk[0].CHECK_CLAUSE), chk[0] && chk[0].CHECK_CLAUSE);
    // No backfill is proven by M1 (default NULL) and M5 (a new row is NULL); the real catalogue
    // may hold owner-assigned families, so only their values are checked here.
    check("M4. real products hold only NULL or one of the four families (owner assignments, nothing else)",
      realAssignedBefore.every(r => FAMILIES.includes(r.f)), js(realAssignedBefore));
    check("M5. a product inserted without a family is unassigned (NULL)", (await famsOf(fx.products)).every(f => f === null));
    let dbErr = null;
    try { await q("UPDATE products SET scent_family = 'oriental' WHERE id = ?", [P[99]]); } catch (e) { dbErr = e; }
    check("M6. the database itself rejects a value outside the four (CHECK constraint)", !!dbErr && /constraint/i.test(dbErr.sqlMessage || "") && (await famOf(P[99])) === null, dbErr && dbErr.code);

    /* ================= single product: valid ================= */
    for (const [i, f] of FAMILIES.entries()) {
      const r = await single(P[0], { scent_family: f });
      check(`S${i + 1}. assign "${f}" → 200 { success, id, scent_family } and stored`,
        r.status === 200 && r.data.success === true && r.data.id === P[0] && r.data.scent_family === f && (await famOf(P[0])) === f, `${r.status} ${r.text}`);
    }
    let r = await single(P[0], { scent_family: "  AmBeR " });
    check("S5. case and surrounding spaces are normalised (\"  AmBeR \" → amber)", r.status === 200 && r.data.scent_family === "amber" && (await famOf(P[0])) === "amber", r.text);
    r = await single(P[0], { scent_family: "amber" });
    check("S6. re-saving the same family → 200 (not mistaken for a missing product)", r.status === 200 && (await famOf(P[0])) === "amber", r.text);
    r = await single(P[0], { scent_family: null });
    check("S7. explicit null unassigns → 200, stored NULL", r.status === 200 && r.data.scent_family === null && (await famOf(P[0])) === null, r.text);
    r = await single(P[0], { scent_family: "woody" });
    check("S8. assign again after unassigning", r.status === 200 && (await famOf(P[0])) === "woody", r.text);
    check("S9. only scent_family changed on that product: every other column, including updated_at, identical",
      (await otherFields([P[0]])) === js(JSON.parse(fixtureFieldsAtStart).filter(x => x.id === P[0])));

    /* ================= single product: rejected, stored value untouched ================= */
    await setDirect([P[1]], "fresh");
    const badBodies = [
      ["V1. unknown family \"oriental\"", { scent_family: "oriental" }],
      ["V2. one of the old 11 guide labels (\"citrus\")", { scent_family: "citrus" }],
      ["V3. empty string", { scent_family: "" }],
      ["V4. whitespace only", { scent_family: "   " }],
      ["V5. number", { scent_family: 1 }],
      ["V6. boolean true", { scent_family: true }],
      ["V7. boolean false", { scent_family: false }],
      ["V8. array", { scent_family: ["amber"] }],
      ["V9. object", { scent_family: { key: "amber" } }],
      ["V10. key missing (empty object)", {}],
      ["V11. key misspelled", { scentFamily: "amber" }],
      ["V12. body is an array", ["amber"]],
      ["V13. \"null\" as a string", { scent_family: "null" }],
    ];
    for (const [name, body] of badBodies) {
      r = await single(P[1], body);
      check(`${name} → 400 field "scent_family", stored value still "fresh"`, r.status === 400 && r.data?.field === "scent_family" && typeof r.data.error === "string" && (await famOf(P[1])) === "fresh", `${r.status} ${r.text}`);
    }
    r = await call("PATCH", `/api/admin/products/${P[1]}/scent-family`, tA);
    check("V14. no body at all → 400, unchanged", r.status === 400 && (await famOf(P[1])) === "fresh", `${r.status} ${r.text}`);
    r = await single(P[1], undefined, tA, "{\"scent_family\": \"amber\"");
    check("V15. malformed JSON → 400 (rejected by the JSON parser), unchanged", r.status === 400 && (await famOf(P[1])) === "fresh", `${r.status}`);

    /* ================= single product: ids ================= */
    for (const [name, id] of [["I1. id 0", "0"], ["I2. negative id", "-5"], ["I3. non-numeric id", "abc"], ["I4. decimal id", "1.5"], ["I5. product that doesn't exist", "999999999"]]) {
      r = await single(id, { scent_family: "amber" });
      check(`${name} → 404`, r.status === 404 && typeof r.data?.error === "string", `${r.status} ${r.text}`);
    }
    r = await single(PA, { scent_family: "amber" });
    check("I6. archived product → 409 code PRODUCT_ARCHIVED, still unassigned", r.status === 409 && r.data?.code === "PRODUCT_ARCHIVED" && (await famOf(PA)) === null, `${r.status} ${r.text}`);

    /* ================= auth (single + bulk) ================= */
    await setDirect([P[2]], "floral");
    const authCases = [["A1. no token", null, 401], ["A2. token with a bad signature", tBadSig, 401], ["A3. customer", tC, 403], ["A4. customer token claiming admin (role read from DB)", tForged, 403]];
    for (const [name, token, code] of authCases) {
      const s = await single(P[2], { scent_family: "woody" }, token);
      const b = await bulk({ product_ids: [P[2], P[3]], scent_family: "woody" }, token);
      check(`${name} → ${code} on both endpoints, nothing changed`, s.status === code && b.status === code && (await famOf(P[2])) === "floral" && (await famOf(P[3])) === null, `${s.status}/${b.status}`);
    }

    /* ================= bulk: valid ================= */
    const four = P.slice(10, 14);
    r = await bulk({ product_ids: four, scent_family: "amber" });
    check("B1. bulk assign 4 products → 200 { success, updated: 4, scent_family, product_ids }, all stored",
      r.status === 200 && r.data.success === true && r.data.updated === 4 && r.data.scent_family === "amber" && js(r.data.product_ids) === js(four) && (await famsOf(four)).every(f => f === "amber"), r.text);
    await setDirect([P[14]], "fresh");
    r = await bulk({ product_ids: [P[10], P[14], P[15]], scent_family: "FLORAL" });
    check("B2. bulk change across mixed current values (amber / fresh / unassigned) → all floral", r.status === 200 && (await famsOf([P[10], P[14], P[15]])).every(f => f === "floral"), r.text);
    r = await bulk({ product_ids: [P[10], P[11]], scent_family: null });
    check("B3. bulk explicit null unassigns", r.status === 200 && r.data.scent_family === null && (await famsOf([P[10], P[11]])).every(f => f === null), r.text);
    r = await bulk({ product_ids: P.map(String), scent_family: "woody" });
    check("B4. exactly 100 products (the limit), ids given as numeric strings → 200, updated 100", r.status === 200 && r.data.updated === 100 && (await famsOf(P)).every(f => f === "woody"), `${r.status} ${r.data && r.data.updated}`);
    r = await bulk({ product_ids: P, scent_family: "woody" });
    check("B5. re-saving the same family on 100 products → 200 (matched rows, not changed rows)", r.status === 200 && r.data.updated === 100, r.text.slice(0, 120));

    /* ================= bulk: rejected, nothing written ================= */
    await setDirect(P, null);
    await setDirect(P.slice(20, 30), "fresh");
    const stateBefore = js(await famsOf(P));
    const badBulk = [
      ["BV1. 101 products (over the limit)", { product_ids: [...P, PA], scent_family: "amber" }, "product_ids"],
      ["BV2. empty list", { product_ids: [], scent_family: "amber" }, "product_ids"],
      ["BV3. product_ids missing", { scent_family: "amber" }, "product_ids"],
      ["BV4. product_ids not a list", { product_ids: P[20], scent_family: "amber" }, "product_ids"],
      ["BV5. id 0 in the list", { product_ids: [P[20], 0], scent_family: "amber" }, "product_ids"],
      ["BV6. negative id", { product_ids: [P[20], -3], scent_family: "amber" }, "product_ids"],
      ["BV7. non-numeric id", { product_ids: [P[20], "abc"], scent_family: "amber" }, "product_ids"],
      ["BV8. decimal id", { product_ids: [P[20], 2.5], scent_family: "amber" }, "product_ids"],
      ["BV9. boolean id", { product_ids: [P[20], true], scent_family: "amber" }, "product_ids"],
      ["BV10. null id", { product_ids: [P[20], null], scent_family: "amber" }, "product_ids"],
      ["BV11. duplicate id", { product_ids: [P[20], P[21], P[20]], scent_family: "amber" }, "product_ids"],
      ["BV12. unknown family", { product_ids: [P[20], P[21]], scent_family: "oriental" }, "scent_family"],
      ["BV13. family key missing", { product_ids: [P[20], P[21]] }, "scent_family"],
      ["BV14. empty-string family", { product_ids: [P[20], P[21]], scent_family: "" }, "scent_family"],
    ];
    for (const [name, body, field] of badBulk) {
      r = await bulk(body);
      check(`${name} → 400 field "${field}"`, r.status === 400 && r.data?.field === field, `${r.status} ${r.text}`);
    }
    r = await bulk(undefined, tA, "[1, 2");
    check("BV15. malformed JSON → 400", r.status === 400, r.status);
    check("BV16. none of the rejected bulk requests changed any product", js(await famsOf(P)) === stateBefore);

    r = await bulk({ product_ids: [P[20], P[21], 999999999, P[22]], scent_family: "amber" });
    check("BR1. one missing id among valid ones → 400 INELIGIBLE_PRODUCTS listing it, nothing written",
      r.status === 400 && r.data?.code === "INELIGIBLE_PRODUCTS" && js(r.data.missing) === js([999999999]) && js(r.data.archived) === js([]) && js(await famsOf(P)) === stateBefore, r.text);
    r = await bulk({ product_ids: [P[40], P[41], PA], scent_family: "amber" });
    check("BR2. one archived id among valid ones → 400 listing it as archived, nothing written",
      r.status === 400 && r.data?.code === "INELIGIBLE_PRODUCTS" && js(r.data.archived) === js([PA]) && js(await famsOf(P)) === stateBefore && (await famOf(PA)) === null, r.text);

    /* ================= bulk: forced failure mid-write rolls everything back ================= */
    const victim = P[59], batch = P.slice(50, 60);
    await pool.query(`CREATE TRIGGER ${TRIGGER} BEFORE UPDATE ON products FOR EACH ROW
      BEGIN IF NEW.id = ${victim} AND NEW.scent_family <=> 'amber' THEN SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'nf test forced failure'; END IF; END`);
    try {
      r = await bulk({ product_ids: batch, scent_family: "amber" });
      check("BT1. a failure while writing (trigger on the 10th product) → 500 \"Nothing was changed\"",
        r.status === 500 && /nothing was changed/i.test(r.data?.error || ""), `${r.status} ${r.text}`);
      check("BT2. no partial update: none of the 10 products changed (all still unassigned)", (await famsOf(batch)).every(f => f === null));
      check("BT3. the 500 response leaks no database detail", !/signal|sql|trigger|nf test forced/i.test(r.text), r.text);
      r = await single(victim, { scent_family: "amber" });
      check("BT4. single endpoint: a write failure → 500 with a generic message, value unchanged", r.status === 500 && !/signal|sql|trigger/i.test(r.text) && (await famOf(victim)) === null, `${r.status} ${r.text}`);
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${TRIGGER}`);
    }
    check("BT5. the temporary trigger is gone", (await q("SELECT COUNT(*) n FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()"))[0].n === 0);
    r = await bulk({ product_ids: batch, scent_family: "amber" });
    check("BT6. the same batch succeeds once the failure is gone (connection released, nothing stuck)", r.status === 200 && (await famsOf(batch)).every(f => f === "amber"), r.text.slice(0, 120));

    /* ================= preservation ================= */
    check("P1. after every single and bulk operation, all other columns of every fixture (incl. updated_at) are identical",
      (await otherFields(fx.products)) === fixtureFieldsAtStart);
    await setDirect([P[70]], "woody");
    const p70 = (await q("SELECT * FROM products WHERE id = ?", [P[70]]))[0];
    r = await call("PUT", `/api/admin/products/${P[70]}`, tA, { name: p70.name + " (edited)", brand: p70.brand, category: p70.category, price: Number(p70.price), badge: p70.badge, image: p70.image, description: p70.description, top_notes: p70.top_notes, middle_notes: p70.middle_notes, base_notes: p70.base_notes });
    check("P2. editing a product with the existing PUT (no scent_family in the body) keeps its family", r.status === 200 && (await famOf(P[70])) === "woody", `${r.status} ${r.text}`);
    const pub = await call("GET", "/api/products");
    const pubRow = (pub.data || []).find(p => p.id === P[70]);
    check("P3. GET /api/products exposes scent_family (woody for the fixture, null for an unassigned one)",
      pub.status === 200 && pubRow && pubRow.scent_family === "woody" && (pub.data.find(p => p.id === P[71]) || {}).scent_family === null, pubRow && pubRow.scent_family);
    check("P4. the archived fixture is still excluded from GET /api/products", !(pub.data || []).some(p => p.id === PA));
    check("P5. no real product was touched (real catalogue hashed with updated_at, minus fixtures)",
      crypto.createHash("sha256").update(JSON.stringify(await q("SELECT * FROM products WHERE id NOT IN (?) ORDER BY id", [fx.products]))).digest("hex").slice(0, 16) === realBefore);
  } catch (e) {
    console.error("HARNESS ERROR:", e); results.push(false);
  } finally {
    try {
      await pool.query(`DROP TRIGGER IF EXISTS ${TRIGGER}`);
      if (fx.products.length) { await q("DELETE FROM offer_products WHERE product_id IN (?)", [fx.products]); await q("DELETE FROM products WHERE id IN (?)", [fx.products]); }
      await q("DELETE FROM products WHERE name LIKE ?", [`NF Scent ${stamp}%`]);
      if (fx.users.length) await q("DELETE FROM users WHERE id IN (?)", [fx.users]);
      const after = await snapshot();
      console.log("\nbefore:", js(before), "\nafter: ", js(after));
      check("Z1. database identical to before (every table hashed, no triggers)", js(before) === js(after));
      check("Z2. real products byte-identical to before, including updated_at", (await realProductsHash()) === realBefore);
      const left = (await q("SELECT (SELECT COUNT(*) FROM products WHERE brand = 'NF Scent Test') p, (SELECT COUNT(*) FROM users WHERE email LIKE 'nf-scent-%') u"))[0];
      console.log(`cleanup: fixture products=${left.p} fixture users=${left.u}`);
      check("Z3. no fixture rows left behind", Number(left.p) === 0 && Number(left.u) === 0, js(left));
    } catch (e) { console.error("CLEANUP ERROR", e.message); results.push(false); }
    iso.stopServer(server);
    await pool.end();
    const failed = results.filter(x => !x).length;
    console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ""}`);
    process.exit(failed ? 1 : 0);
  }
})();
