// Customer review API (storefront roadmap R8, extended for R3 review integrity): GET/POST
// /api/products/:id/reviews and GET/PUT /api/products/:id/reviews/mine against the real server.js
// (:5093) and an isolated nf_test_* database on 127.0.0.1:3308. Runs ONLY under the isolated-database
// guard (see tests/README.md, "Isolated test database"). Needs migration 010 applied to that database.
//
// Asserts: login required; only a JSON whole number 1–5 is a rating; verified purchase from real
// orders, ignoring cancelled ones; client-supplied flags ignored; hidden reviews never served; no
// account data beyond the reviewer's name; totals recalculated. R3: one review per customer per
// product (409 REVIEW_EXISTS, also for a hidden review; migration 010's UNIQUE index refuses a
// duplicate pair in the database itself); comments are text of at most 1,000 characters, trimmed;
// unknown, malformed and archived product ids → 404; a customer reads and edits their own review,
// edits re-check verified purchase and never change moderation.
//
// R11 (2026-11-16): GET /api/reviews/highlights — public; visible reviews with text of active products,
// any rating; short reviewer names only; newest first; at most 24, a random set when more are eligible.
//
// Fixtures: thirteen customers, two orders (one cancelled), and three borrowed products whose
// avg_rating / review_count are recorded first and restored at the end; one archived product (never
// written itself; R11 attaches one fixture review to it). Everything the suite inserts is deleted in `finally`.
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

    /* ---------- R3: one review per customer per product ---------- */
    const pairCount = async (u, p) => (await q("SELECT COUNT(*) n FROM reviews WHERE user_id = ? AND product_id = ?", [u, p]))[0].n;
    const p1Before = (await q("SELECT avg_rating, review_count FROM products WHERE id = ?", [P1]))[0];
    r = await call("POST", `/api/products/${P1}/reviews`, tA, { rating: 2, comment: "second review" });
    check("D1 a second review of the same product by the same customer → 409 REVIEW_EXISTS, still one row, totals unchanged",
      r.status === 409 && r.data.code === "REVIEW_EXISTS" && Number.isInteger(r.data.reviewId) && await pairCount(A, P1) === 1 &&
      JSON.stringify((await q("SELECT avg_rating, review_count FROM products WHERE id = ?", [P1]))[0]) === JSON.stringify(p1Before), `${r.status} ${JSON.stringify(r.data)}`);
    r = await call("POST", `/api/products/${P1}/reviews`, tB, { rating: 5, comment: "fresh start" });
    check("D2 a customer whose review was hidden cannot post a fresh one (409), so moderation can't be bypassed", r.status === 409 && await pairCount(B, P1) === 1, r.status);
    const uq = await q(`SELECT COLUMN_NAME c, SEQ_IN_INDEX s, NON_UNIQUE nu FROM information_schema.STATISTICS
                         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'reviews' AND INDEX_NAME = 'uq_reviews_product_user' ORDER BY SEQ_IN_INDEX`);
    check("D3 migration 010 is applied: UNIQUE uq_reviews_product_user (product_id, user_id)", JSON.stringify(uq.map(x => [x.c, x.s, Number(x.nu)])) === '[["product_id",1,0],["user_id",2,0]]', JSON.stringify(uq));
    let dupErr = null;
    try { await q("INSERT INTO reviews (product_id, user_id, rating) VALUES (?, ?, 3)", [P1, A]); } catch (err) { dupErr = err.code; }
    check("D4 the database itself refuses a duplicate pair (ER_DUP_ENTRY), so simultaneous submissions can't both succeed", dupErr === "ER_DUP_ENTRY" && await pairCount(A, P1) === 1, dupErr);

    /* ---------- R3: comments ---------- */
    const D = await mk("Dede Commenter"), tD = tok(D);
    r = await call("POST", `/api/products/${P2}/reviews`, tD, { rating: 4, comment: "x".repeat(1001) });
    check("C1 a 1,001-character comment → 400 (field comment), nothing stored", r.status === 400 && r.data.field === "comment" && await pairCount(D, P2) === 0, `${r.status} ${JSON.stringify(r.data)}`);
    r = await call("POST", `/api/products/${P2}/reviews`, tD, { rating: 4, comment: 12345 });
    check("C2 a comment that isn't text → 400", r.status === 400 && r.data.field === "comment" && await pairCount(D, P2) === 0, r.status);
    r = await call("POST", `/api/products/${P2}/reviews`, tD, { rating: 4, comment: `   ${"y".repeat(1000)}   ` });
    const dRow = (await q("SELECT comment FROM reviews WHERE user_id = ? AND product_id = ?", [D, P2]))[0];
    check("C3 exactly 1,000 characters (after trimming surrounding spaces) → 201, stored trimmed", r.status === 201 && dRow && dRow.comment === "y".repeat(1000), r.status);
    const E = await mk("Efua Spaces"), tE = tok(E);
    r = await call("POST", `/api/products/${P2}/reviews`, tE, { rating: 5, comment: "    " });
    check("C4 a whitespace-only comment is stored as NULL", r.status === 201 && (await q("SELECT comment FROM reviews WHERE user_id = ?", [E]))[0].comment === null);

    /* ---------- R3: which product ---------- */
    const archived = (await q("SELECT id FROM products WHERE deleted_at IS NOT NULL ORDER BY id LIMIT 1"))[0];
    const statuses = [];
    for (const pid of ["999999999", "abc", "0", "-1", "1.5", archived ? String(archived.id) : "999999998"]) {
      const x = await call("POST", `/api/products/${pid}/reviews`, tD, { rating: 4 });
      statuses.push(`${pid}→${x.status}${x.data && x.data.code ? ":" + x.data.code : ""}`);
    }
    check(`P1 unknown, malformed and archived product ids → 404 PRODUCT_NOT_FOUND (archived #${archived ? archived.id : "none"})`,
      statuses.every(x => /→404:PRODUCT_NOT_FOUND$/.test(x)) && (await q("SELECT COUNT(*) n FROM reviews WHERE user_id = ?", [D]))[0].n === 1, statuses.join(", "));

    /* ---------- R3: verified purchase ignores cancelled orders ---------- */
    const F = await mk("Fiifi Cancelled"), tF = tok(F);
    const fAddr = (await q("INSERT INTO addresses (user_id, label, full_name, address_line1, city, country, is_default) VALUES (?, 'Home', 'Fiifi', '2 Road', 'Accra', 'Ghana', 1)", [F])).insertId;
    const fOrder = (await q("INSERT INTO orders (user_id, address_id, total, status, payment_reference) VALUES (?, ?, 100.00, 'Cancelled', ?)", [F, fAddr, `NF-REVIEW-C-${stamp}`])).insertId;
    await q("INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES (?, ?, 1, 100.00)", [fOrder, P2]);
    r = await call("POST", `/api/products/${P2}/reviews`, tF, { rating: 3 });
    check("B1 a customer whose only order of the product was cancelled → not a verified purchase", r.status === 201 && r.data.isVerified === false && (await q("SELECT is_verified_purchase v FROM reviews WHERE user_id = ?", [F]))[0].v === 0, JSON.stringify(r.data));

    /* ---------- R3: the customer's own review ---------- */
    r = await call("GET", `/api/products/${P1}/reviews/mine`);
    check("M1 GET .../reviews/mine needs a login → 401", r.status === 401);
    r = await call("GET", `/api/products/${P1}/reviews/mine`, tA);
    const mineKeys = r.data && r.data.review ? Object.keys(r.data.review).sort().join(",") : "";
    check("M2 returns the customer's own review with only review fields", r.status === 200 && r.data.review && r.data.review.rating === 5 && r.data.review.comment === "Bought it, love it" && r.data.review.is_verified_purchase === 1 &&
      mineKeys === "comment,created_at,hidden,id,is_verified_purchase,product_id,rating,updated_at", mineKeys);
    r = await call("GET", `/api/products/${P1}/reviews/mine`, tD);
    check("M3 no review of this product yet → { review: null }", r.status === 200 && r.data.review === null, JSON.stringify(r.data));
    r = await call("GET", `/api/products/${P1}/reviews/mine`, tB);
    check("M4 a hidden review is returned to its author, marked hidden", r.status === 200 && r.data.review && r.data.review.hidden === 1, JSON.stringify(r.data));
    r = await call("GET", `/api/products/999999999/reviews/mine`, tA);
    check("M5 unknown product → 404", r.status === 404 && r.data.code === "PRODUCT_NOT_FOUND");

    /* ---------- R3: editing ---------- */
    r = await call("PUT", `/api/products/${P1}/reviews/mine`, null, { rating: 2 });
    check("U1 PUT .../reviews/mine needs a login → 401", r.status === 401);
    const aBefore = (await q("SELECT rating, comment FROM reviews WHERE user_id = ? AND product_id = ?", [A, P1]))[0];
    const badEdits = [{ rating: 0 }, { rating: "4" }, { rating: 4.5 }, { rating: 3, comment: "z".repeat(1001) }, {}];
    const badEditStatuses = [];
    for (const b of badEdits) badEditStatuses.push((await call("PUT", `/api/products/${P1}/reviews/mine`, tA, b)).status);
    check("U2 an edit with an invalid rating or an over-long comment → 400, review unchanged", badEditStatuses.every(x => x === 400) &&
      JSON.stringify((await q("SELECT rating, comment FROM reviews WHERE user_id = ? AND product_id = ?", [A, P1]))[0]) === JSON.stringify(aBefore), badEditStatuses.join(","));
    r = await call("PUT", `/api/products/${P1}/reviews/mine`, tD, { rating: 4 });
    check("U3 editing a review that doesn't exist → 404 REVIEW_NOT_FOUND, nothing created", r.status === 404 && r.data.code === "REVIEW_NOT_FOUND" && await pairCount(D, P1) === 0, r.status);
    r = await call("PUT", `/api/products/${P1}/reviews/mine`, tA, { rating: 2, comment: "  Grew on me less  ", hidden: 1, is_verified_purchase: false, user_id: B });
    const aAfter = (await q("SELECT rating, comment, hidden, is_verified_purchase v, user_id FROM reviews WHERE id = ?", [r.data && r.data.review ? r.data.review.id : 0]))[0];
    check("U4 own edit → 200 with the updated review; rating and trimmed comment saved; client flags ignored",
      r.status === 200 && r.data.review.rating === 2 && aAfter && aAfter.comment === "Grew on me less" && aAfter.hidden === 0 && aAfter.v === 1 && aAfter.user_id === A && await pairCount(A, P1) === 1, JSON.stringify(aAfter));
    tot = (await q("SELECT avg_rating, review_count FROM products WHERE id = ?", [P1]))[0];
    check("U5 the edit recalculates P1's totals (visible 2 and 1 → 1.5, 2)", Number(tot.avg_rating) === 1.5 && tot.review_count === 2, JSON.stringify(tot));
    await q("UPDATE orders SET status = 'Cancelled' WHERE id = ?", [order]);
    r = await call("PUT", `/api/products/${P1}/reviews/mine`, tA, { rating: 2, comment: "Grew on me less" });
    check("U6 an edit re-checks verified purchase: after the order is cancelled it is no longer verified", r.status === 200 && r.data.isVerified === false && (await q("SELECT is_verified_purchase v FROM reviews WHERE user_id = ? AND product_id = ?", [A, P1]))[0].v === 0, JSON.stringify(r.data));
    r = await call("PUT", `/api/products/${P1}/reviews/mine`, tB, { rating: 5, comment: "edited while hidden" });
    const bRow = (await q("SELECT rating, comment, hidden FROM reviews WHERE user_id = ? AND product_id = ?", [B, P1]))[0];
    const pubAfter = (await call("GET", `/api/products/${P1}/reviews`)).data || [];
    tot = (await q("SELECT avg_rating, review_count FROM products WHERE id = ?", [P1]))[0];
    check("U7 editing a hidden review keeps it hidden: saved, still not served, still not counted",
      r.status === 200 && bRow.hidden === 1 && bRow.rating === 5 && !pubAfter.some(x => x.user_id === B) && Number(tot.avg_rating) === 1.5 && tot.review_count === 2, JSON.stringify({ bRow, tot }));

    /* ---------- R11: GET /api/reviews/highlights (homepage strip, owner decisions D15) ---------- */
    // Extra fixtures: a one-word name (through the API), a review of an archived product and a
    // whitespace-only comment (both inserted directly — the API would refuse them — and deleted at the end).
    const K = await mk("Kwame"), tK = tok(K);
    r = await call("POST", `/api/products/${P3}/reviews`, tK, { rating: 4, comment: "Single-name reviewer" });
    if (archived) await q("INSERT INTO reviews (product_id, user_id, rating, comment) VALUES (?, ?, 5, 'Review of an archived product')", [archived.id, K]);
    await q("INSERT INTO reviews (product_id, user_id, rating, comment) VALUES (?, ?, 5, '   ')", [P1, E]);
    const eligibleSql = `SELECT r.id FROM reviews r JOIN products p ON p.id = r.product_id AND p.deleted_at IS NULL
                          WHERE r.hidden = 0 AND r.comment IS NOT NULL AND TRIM(r.comment) <> ''`;
    let eligible = (await q(eligibleSql)).map(x => x.id);
    r = await call("GET", "/api/reviews/highlights");
    let hl = (r.data && r.data.reviews) || [];
    const byId = Object.fromEntries(hl.map(x => [x.id, x]));
    const aId = (await q("SELECT id FROM reviews WHERE user_id = ? AND product_id = ?", [A, P1]))[0].id;
    const kId = (await q("SELECT id FROM reviews WHERE user_id = ? AND product_id = ?", [K, P3]))[0].id;
    check("H1 public (no login) → 200 { total, reviews }; total = every eligible review", r.status === 200 && r.data.total === eligible.length && hl.length === Math.min(eligible.length, 24), `${r.status} total=${r.data && r.data.total} eligible=${eligible.length} returned=${hl.length}`);
    check("H2 a 2-star review is included (no rating filter), with its short name, product and verified flag",
      byId[aId] && byId[aId].rating === 2 && byId[aId].comment === "Grew on me less" && byId[aId].reviewer === "Ama B." && byId[aId].product.id === P1 && typeof byId[aId].product.name === "string" && byId[aId].verified === false, JSON.stringify(byId[aId]));
    check("H3 a one-word name is shown as it is", byId[kId] && byId[kId].reviewer === "Kwame", JSON.stringify(byId[kId]));
    const hiddenId = (await q("SELECT id FROM reviews WHERE user_id = ? AND product_id = ?", [B, P1]))[0].id;
    const archivedId = archived ? (await q("SELECT id FROM reviews WHERE user_id = ? AND product_id = ?", [K, archived.id]))[0].id : -1;
    const blankId = (await q("SELECT id FROM reviews WHERE user_id = ? AND product_id = ?", [E, P1]))[0].id;
    const ratingOnly = (await q("SELECT id FROM reviews WHERE user_id IN (?) AND comment IS NULL", [users])).map(x => x.id);
    check("H4 excluded: a hidden review, a review of an archived product, a whitespace-only comment, rating-only reviews",
      !byId[hiddenId] && !byId[archivedId] && !byId[blankId] && ratingOnly.length >= 5 && ratingOnly.every(id => !byId[id]) && !eligible.includes(hiddenId) && !eligible.includes(archivedId),
      JSON.stringify({ hidden: !!byId[hiddenId], archived: !!byId[archivedId], blank: !!byId[blankId], ratingOnly: ratingOnly.filter(id => byId[id]) }));
    const keys = [...new Set(hl.flatMap(x => Object.keys(x)))].sort().join(",");
    const productKeys = [...new Set(hl.flatMap(x => Object.keys(x.product || {})))].sort().join(",");
    const json = JSON.stringify(r.data);
    check("H5 only review fields: id, rating, comment, verified, short reviewer name, product {id, name}, created_at — no full names or account data",
      keys === "comment,created_at,id,product,rating,reviewer,verified" && productKeys === "id,name" && !/Buyer|Browser|Commenter|Spaces|full_name|user_id|email|phone|hidden/i.test(json), `${keys} | ${productKeys}`);
    check("H6 newest first", hl.every((x, i) => i === 0 || new Date(hl[i - 1].created_at) >= new Date(x.created_at)));

    // Cap: 25 more reviews with text (one customer, 25 different active products) → at most 24 returned.
    const G = await mk("Gloria Many");
    const capProducts = await q("SELECT id FROM products WHERE deleted_at IS NULL AND id NOT IN (?) ORDER BY id LIMIT 25", [[P1, P2, P3]]);
    for (const p of capProducts) await q("INSERT INTO reviews (product_id, user_id, rating, comment) VALUES (?, ?, 4, ?)", [p.id, G, `Cap fixture ${p.id}`]);
    eligible = (await q(eligibleSql)).map(x => x.id);
    r = await call("GET", "/api/reviews/highlights");
    hl = (r.data && r.data.reviews) || [];
    check(`H7 more than 24 eligible (${eligible.length}) → total says so, 24 returned, all eligible, no repeats, newest first`,
      r.data.total === eligible.length && eligible.length > 24 && hl.length === 24 && hl.every(x => eligible.includes(x.id)) && new Set(hl.map(x => x.id)).size === 24 &&
      hl.every((x, i) => i === 0 || new Date(hl[i - 1].created_at) >= new Date(x.created_at)), `total=${r.data.total} returned=${hl.length}`);
    const seen = new Set(); for (let i = 0; i < 6; i++) ((await call("GET", "/api/reviews/highlights")).data.reviews || []).forEach(x => seen.add(x.id));
    check("H8 with more than 24 eligible, repeated requests draw different sets (every review can appear over time)", seen.size > 24, `distinct ids over 7 requests: ${seen.size}`);
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
