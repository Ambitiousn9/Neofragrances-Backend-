// Money validation accepts every 2-decimal value (T08 / audit E5).
//
// DATABASE-FREE AND NETWORK-FREE: loads only pricing.js (pure) and reads server.js as text.
// Before T08, product prices and coupon values were checked with
// Math.round(n * 100) === n * 100, which rejects valid prices such as 289.15 because
// 289.15 * 100 === 28914.999999999996. Offers already used a tolerance.
//
// Run: node tests/money-validation-tests.js
const fs = require("fs");
const path = require("path");
const SERVER = process.env.SERVER_DIR || path.join(__dirname, "..");
const { hasAtMost2dp, toPesewas } = require(path.join(SERVER, "pricing.js"));

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`PASS ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail === undefined ? "" : `  [${typeof detail === "string" ? detail : JSON.stringify(detail)}]`}`); }
}

// Values arrive from the admin forms as text or JSON numbers; both parse with Number().
const fromCents = c => Number(`${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`);

// ---------- M1-M3: every cent value is accepted and converts to the exact pesewas ----------
function sweep(fromC, toC) {
  const bad = [];
  for (let c = fromC; c <= toC; c++) {
    const v = fromCents(c);
    if (!hasAtMost2dp(v) || toPesewas(v) !== c) { bad.push(v); if (bad.length >= 5) break; }
  }
  return bad;
}
let bad = sweep(1, 10000000);
check("M1 every value 0.01 to 100,000.00 is accepted and toPesewas gives its exact cents", bad.length === 0, bad);
bad = sweep(99900000, 100000000);
check("M2 every value 999,000.00 to 1,000,000.00 is accepted (top of the allowed range)", bad.length === 0, bad);
const known = [289.15, 1.15, 4.35, 0.29, 0.07, 19.99, 450, 999999.99];
check("M3 the values the old check rejected are accepted", known.every(hasAtMost2dp), known.filter(v => !hasAtMost2dp(v)));
check("M3b ...and the old exact check really did reject some of them", [289.15, 1.15, 4.35, 0.29].every(v => Math.round(v * 100) !== v * 100));

// ---------- M4-M6: more than 2 decimals, and non-numbers, are still rejected ----------
const threeDp = [10.555, 5.005, 0.001, 289.151, 10.123, 999999.991, 0.0001, 1.0000001];
check("M4 values with more than 2 decimal places are rejected", threeDp.every(v => !hasAtMost2dp(v)), threeDp.filter(hasAtMost2dp));
let leak = [];
for (let c = 1; c <= 200000 && leak.length < 5; c++) {
  const v = Number(`${Math.floor(c / 1000)}.${String(c % 1000).padStart(3, "0")}`);
  if (c % 10 !== 0 && hasAtMost2dp(v)) leak.push(v);
}
check("M5 every 3-decimal value 0.001 to 200.000 with a non-zero 3rd decimal is rejected", leak.length === 0, leak);
const notNumbers = [NaN, Infinity, -Infinity, Number("abc"), Number(undefined)];
check("M6 NaN and infinities are rejected", notNumbers.every(v => !hasAtMost2dp(v)));

// ---------- S1-S4: server.js uses the shared helper everywhere ----------
const server = fs.readFileSync(path.join(SERVER, "server.js"), "utf8");
check("S1 server.js imports hasAtMost2dp from ./pricing", /const \{[^}]*\bhasAtMost2dp\b[^}]*\} = require\("\.\/pricing"\)/.test(server));
const exact = server.match(/Math\.round\(\s*(\w+)\s*\*\s*100\s*\)\s*[!=]==\s*\1\s*\*\s*100/g) || [];
check("S2 no exact float comparison Math.round(x * 100) === x * 100 is left in server.js", exact.length === 0, exact);
const fnBody = name => { const at = server.indexOf(`function ${name}(`); return at === -1 ? "" : server.slice(at, server.indexOf("\n}\n", at)); };
check("S3 validateProductBody checks the price with hasAtMost2dp", /!hasAtMost2dp\(price\)/.test(fnBody("validateProductBody")));
check("S4 validateOfferBody and the coupon validator use hasAtMost2dp", /hasAtMost2dp\(n\)/.test(fnBody("validateOfferBody")) && /const dec2 = hasAtMost2dp;/.test(server));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
