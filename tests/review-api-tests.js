// Customer review API (storefront roadmap R8): GET/POST /api/products/:id/reviews against the real
// server.js (:5093) and an isolated nf_test_* database on 127.0.0.1:3308. Runs ONLY under the
// isolated-database guard (see tests/README.md, "Isolated test database").
//
// Asserts today's behaviour: login required, rating validation, verified-purchase marking from real
// order history, client-supplied flags ignored, hidden reviews never served, the product's rating
// totals recalculated, no account data beyond the reviewer's name. The known gaps that the review-
// integrity task (R3) will change (a second review of the same product, no comment length limit,
// an unknown product id) are reported as OBSERVATION lines, never asserted, so R3 can change them
// without rewriting this suite.
//
// Fixtures: eight customers, one order, and three borrowed products whose avg_rating / review_count are
// recorded first and restored at the end. Everything the suite inserts is deleted in `finally`.
const path = require("path"), crypto = require("crypto");
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
const iso = require("./support/isolated-suite");
iso.requireIsolation("review-api-tests.js"); // before dotenv and db.js
require(path.join(process.cwd(), "node_modules/dotenv")).config({ quiet: true });
const jwt = require(path.join(process.cwd(), "node_modules/jsonwebtoken"));
const pool = require(path.join(process.cwd(), "db"));
if (!["localhost", "127.0.0.1"].includes(process.env.DB_HOST)) { console.error("not local"); process.exit(1); }

const SECRET = crypto.randomBytes(32).toString("hex");
const API = "http://127.0.0.1:5093";
const q = async (s, p) => (await pool.query(s, p))[0];
const results = [], observations = [];
const check = (n, c, x = "") => { results.push(!!c); console.log(`${c ? "PASS" : "FAIL"} ${n}${x !== "" ? "  [" + String(x).slice(0, 200) + "]" : ""}`); };
const observe = t => { observations.push(t); console.log(`OBSERVATION ${t}`); };
const call = async (method, url, token, body) => {
  const r = await fetch(API + url, { method, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data = null; try { data = await r.json(); } catch (e) {}
  return { status: r.status, data };
};

(async () => {
  await iso.verifyParentIdentity(pool, "review-api-tests.js");
  const stamp = Date.now(); const users = []; let server; let borrowed = [];
  try {
    const mk = async name => { const id = (await q("INSERT INTO users (full_name, email, phone, password_hash, role, email_verified_at, auth_provider) VALUES (?, ?, '0200000000', NULL, 'customer', NOW(), 'local')", [name, `nf-review-${name.toLowerCase().replace(/\W/g, "")}-${stamp}@gmail.com`])).insertId; users.push(id); return id; };
    const A = await mk("Ama Buyer"), B = await mk("Kofi Browser"), C = await mk("Esi Third");
    const tok = id => jwt.sign({ id, role: "customer" }, SECRET);
    const tA = tok(A), tB = tok(B), tC = tok(C);

    // Three active products with no review rows yet; their totals are restored at the end.
    borrowed = await q(`SELECT id, avg_rating, review_count FROM products
                         WHERE deleted_at IS NULL AND id NOT IN (SELECT product_id FROM reviews) ORDER BY id LIMIT 3`);
    if (borrowed.length < 3) throw new Error("need three active products without reviews in the test database");
    const [P1, P2, P3] = borrowed.map(p => p.id);
    const addr = (await q("INSERT INTO addresses (user_id, label, full_name, address_line1, city, country, is_default) VALUES (?, 'Home', 'Ama', '1 Road', 'Accra', 'Ghana', 1)", [A])).insertId;
    const order = (await q("INSERT INTO orders (user_id, address_id, total, status, payment_reference) VALUES (?, ?, 100.00, 'Processing', ?)", [A, addr, `NF-REVIEW-${stamp}`])).insertId;
    await q("INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES (?, ?, 1, 100.00)", [order, P1]);

    server = await iso.startGuardedServer({ suite: "review-api-tests.js", port: 5093, env: { JWT_SECRET: SECRET } });

    /* ---------- reading ---------- */
    let r = await call("GET", `/api/products/${P1}/reviews`);
    check("V1 GET reviews of a product with none → 200 []", r.status === 200 && Array.isArray(r.data) && r.data.length === 0, JSON.stringify(r.data));

    /* ---------- access and validation ---------- */
    r = await call("POST", `/api/products/${P1}/reviews`, null, { rating: 5, comment: "x" });
    check("V2 POST without a login → 401, nothing stored", r.status === 401 && (await q("SELECT COUNT(*) n FROM reviews WHERE product_id IN (?)", [[P1, P2]]))[0].n === 0, r.status);
    r = await call("POST", `/api/products/${P1}/reviews`, "not.a.jwt", { rating: 5 });
    check("V3 POST with a bad token → 401", r.status === 401, r.status);
    // Only a JSON number that is a whole number 1–5 is a rating. Each value below must be refused
    // with 400 before anything is stored or any total recalculated.
    const bad = [
      ["missing", {}], ["comment only", { comment: "no rating" }], ["null", { rating: null }],
      ["non-numeric string", { rating: "abc" }], ["empty string", { rating: "" }],
      ["numeric string \"4\"", { rating: "4" }], ["numeric string \"5\"", { rating: "5" }], ["numeric string \" 3 \"", { rating: " 3 " }],
      ["decimal 4.5", { rating: 4.5 }], ["decimal 0.5", { rating: 0.5 }], ["decimal 5.01", { rating: 5.01 }],
      ["zero", { rating: 0 }], ["negative -1", { rating: -1 }], ["six", { rating: 6 }], ["huge 1e9", { rating: 1e9 }],
      ["true", { rating: true }], ["false", { rating: false }], ["array [5]", { rating: [5] }], ["object", { rating: { value: 5 } }],
    ];
    const totalsBefore = await q("SELECT id, avg_rating, review_count FROM products WHERE id IN (?) ORDER BY id", [[P1, P2, P3]]);
    const accepted = [];
    for (const [label, body] of bad) {
      const s = (await call("POST", `/api/products/${P1}/reviews`, tB, body)).status;
      if (s !== 400) accepted.push(`${label}→${s}`);
    }
    const noBody = await fetch(`${API}/api/products/${P1}/reviews`, { method: "POST", headers: { Authorization: `Bearer ${tB}` } });
    if (noBody.status !== 400) accepted.push(`no request body→${noBody.status}`);
    check(`V4 ${bad.length + 1} invalid ratings (strings incl. "4", decimals, 0, >5, booleans, null, arrays, objects, missing, no body) → 400 each`, accepted.length === 0, accepted.join(", "));
    check("V4a nothing was stored and no product total changed after the invalid attempts",
      (await q("SELECT COUNT(*) n FROM reviews WHERE product_id IN (?)", [[P1, P2, P3]]))[0].n === 0 &&
      JSON.stringify(await q("SELECT id, avg_rating, review_count FROM products WHERE id IN (?) ORDER BY id", [[P1, P2, P3]])) === JSON.stringify(totalsBefore));

    // Each valid rating 1–5, from five different customers on a third product (no duplicates involved).
    const validStatuses = [];
    for (const n of [1, 2, 3, 4, 5]) {
      const uid = await mk(`Rater ${n}`);
      const res = await call("POST", `/api/products/${P3}/reviews`, tok(uid), { rating: n });
      validStatuses.push(`${n}→${res.status}`);
    }
    const p3Rows = (await q("SELECT rating FROM reviews WHERE product_id = ? ORDER BY rating", [P3])).map(x => x.rating);
    const p3Tot = (await q("SELECT avg_rating, review_count FROM products WHERE id = ?", [P3]))[0];
    check("V4b every whole number 1–5 is accepted and stored exactly; P3's totals become 3.0 from 5",
      validStatuses.every(s => s.endsWith("→201")) && JSON.stringify(p3Rows) === "[1,2,3,4,5]" && Number(p3Tot.avg_rating) === 3 && p3Tot.review_count === 5,
      `${validStatuses.join(",")} rows=${JSON.stringify(p3Rows)} totals=${JSON.stringify(p3Tot)}`);

    /* ---------- submitting ---------- */
    r = await call("POST", `/api/products/${P1}/reviews`, tB, { rating: 4, comment: "Lovely <b>evening</b> scent" });
    check("V5 a signed-in customer without a purchase can review → 201, isVerified false", r.status === 201 && r.data.success === true && r.data.isVerified === false, JSON.stringify(r.data));
    r = await call("POST", `/api/products/${P1}/reviews`, tA, { rating: 5, comment: "Bought it, love it" });
    check("V6 a customer who ordered the product → 201, isVerified true", r.status === 201 && r.data.isVerified === true, JSON.stringify(r.data));
    r = await call("POST", `/api/products/${P2}/reviews`, tC, { rating: 3, is_verified_purchase: true, isVerified: true, hidden: 1, user_id: A, product_id: P1 });
    const cRow = (await q("SELECT product_id, user_id, rating, comment, is_verified_purchase, hidden FROM reviews WHERE user_id = ?", [C]))[0];
    check("V7 client-supplied verified/hidden/user/product fields are ignored", r.status === 201 && r.data.isVerified === false && cRow && cRow.product_id === P2 && cRow.user_id === C && cRow.is_verified_purchase === 0 && cRow.hidden === 0, JSON.stringify(cRow));
    check("V8 an omitted comment is stored as NULL", cRow && cRow.comment === null);

    /* ---------- what the storefront receives ---------- */
    r = await call("GET", `/api/products/${P1}/reviews`);
    const list = r.data || [];
    const byUser = Object.fromEntries(list.map(x => [x.user_id, x]));
    check("V9 GET lists both reviews of P1, newest first, with the reviewer's name and verified flag",
      r.status === 200 && list.length === 2 && list[0].user_id === A && byUser[A].full_name === "Ama Buyer" && byUser[A].is_verified_purchase === 1 && byUser[B].is_verified_purchase === 0 && byUser[B].rating === 4,
      JSON.stringify(list.map(x => ({ u: x.user_id, n: x.full_name, v: x.is_verified_purchase }))));
    check("V10 the comment comes back exactly as written (the storefront escapes it when rendering)", byUser[B] && byUser[B].comment === "Lovely <b>evening</b> scent");
    const leaked = list.flatMap(x => Object.keys(x)).filter(k => /email|password|phone|token|role|disabled/i.test(k));
    check("V11 no account data beyond the reviewer's name is served", leaked.length === 0, leaked.join(","));

    let tot = (await q("SELECT avg_rating, review_count FROM products WHERE id = ?", [P1]))[0];
    check("V12 P1's totals recalculated from its reviews (4 and 5 → 4.5, 2)", Number(tot.avg_rating) === 4.5 && tot.review_count === 2, JSON.stringify(tot));
    tot = (await q("SELECT avg_rating, review_count FROM products WHERE id = ?", [P2]))[0];
    check("V13 P2's totals reflect only its own review (3.0, 1)", Number(tot.avg_rating) === 3 && tot.review_count === 1, JSON.stringify(tot));

    /* ---------- moderation ---------- */
    await q("UPDATE reviews SET hidden = 1 WHERE user_id = ? AND product_id = ?", [B, P1]);
    r = await call("GET", `/api/products/${P1}/reviews`);
    check("V14 a hidden review is never served (row and comment both absent)", r.status === 200 && r.data.length === 1 && r.data[0].user_id === A && !JSON.stringify(r.data).includes("Lovely"), JSON.stringify(r.data));
    r = await call("POST", `/api/products/${P1}/reviews`, tC, { rating: 1 });
    tot = (await q("SELECT avg_rating, review_count FROM products WHERE id = ?", [P1]))[0];
    check("V15 recalculation ignores hidden reviews (visible 5 and 1 → 3.0, 2)", r.status === 201 && Number(tot.avg_rating) === 3 && tot.review_count === 2, JSON.stringify(tot));

    /* ---------- known gaps, reported for R3 (review integrity), not asserted ---------- */
    r = await call("POST", `/api/products/${P1}/reviews`, tA, { rating: 2, comment: "second review" });
    const aCount = (await q("SELECT COUNT(*) n FROM reviews WHERE user_id = ? AND product_id = ?", [A, P1]))[0].n;
    observe(`R3: a second review of the same product by the same customer → ${r.status}, ${aCount} reviews stored for that pair`);
    r = await call("POST", `/api/products/${P2}/reviews`, tB, { rating: 4, comment: "x".repeat(20000) });
    observe(`R3: a 20,000-character comment → ${r.status}`);
    r = await call("POST", `/api/products/999999999/reviews`, tB, { rating: 4 });
    observe(`R3: a review of a product id that does not exist → ${r.status}`);
  } catch (e) {
    console.error("HARNESS ERROR:", e); results.push(false);
  } finally {
    try {
      if (users.length) {
        const oids = (await q("SELECT id FROM orders WHERE user_id IN (?)", [users])).map(r => r.id);
        if (oids.length) { await q("DELETE FROM order_items WHERE order_id IN (?)", [oids]); await q("DELETE FROM orders WHERE id IN (?)", [oids]); }
        for (const t of ["reviews", "addresses", "wishlist", "email_verifications", "password_resets"]) await q(`DELETE FROM ${t} WHERE user_id IN (?)`, [users]);
        await q("DELETE FROM users WHERE id IN (?)", [users]);
      }
      for (const p of borrowed) await q("UPDATE products SET avg_rating = ?, review_count = ? WHERE id = ?", [p.avg_rating, p.review_count, p.id]);
      const left = (await q("SELECT (SELECT COUNT(*) FROM reviews WHERE user_id IN (?)) r, (SELECT COUNT(*) FROM users WHERE id IN (?)) u", [users.length ? users : [0], users.length ? users : [0]]))[0];
      const restored = borrowed.length ? (await q("SELECT id, avg_rating, review_count FROM products WHERE id IN (?)", [borrowed.map(p => p.id)])) : [];
      console.log("\ncleanup:", JSON.stringify(left), "restored:", JSON.stringify(restored));
    } catch (e) { console.error("CLEANUP ERROR", e.message); results.push(false); }
    iso.stopServer(server); await pool.end();
    const failed = results.filter(r => !r).length;
    console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` — ${failed} FAILED` : ""}${observations.length ? `, ${observations.length} observation(s)` : ""}`);
    process.exit(failed ? 1 : 0);
  }
})();
