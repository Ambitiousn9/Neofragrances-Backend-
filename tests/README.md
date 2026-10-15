# Local regression suites

Nineteen standalone Node scripts (no test framework). Each starts its **own**
`server.js` on a private port, runs its checks, then deletes every fixture it
created and restores stock. They all refuse to run unless the database is local.
The exceptions are `auth-rate-limit-tests.js` and `security-headers-tests.js`, which
never touch a database at all (see their rows below).

**Run the whole set, not just the eight in the table's original form.** The table
below lists all nineteen; `platform-tests.js`, `offers-behaviour.js`,
`maintenance-tests.js`, `account-controls-tests.js`,
`order-status-history-tests.js`, `offers-multi-product-tests.js`,
`scent-family-tests.js`, `scent-family-admin-e2e.js`,
`scent-family-storefront-e2e.js`, `auth-rate-limit-tests.js` and
`security-headers-tests.js` were added after the original eight and are easy to miss.

Full regression, last complete run: **925/925** across all fourteen suites
(2026-10-09, Milestone 6 Phase 6E), with `offers-multi-product-tests.js` passing
127/127. The per-suite figures in the table below sum to that total.

`scent-family-tests.js` (the fifteenth, added 2026-10-10 with migration 008) has only had
focused runs so far (77/77). It is not part of the 925 total, and the full set has not
been re-run since migration 008 was applied.

`account-controls-tests.js` scored 86/87 in that run. A87 hard-coded the old local
wishlist count of 3, but the accepted baseline has been **0** since 2026-10-09. That one
expectation was corrected to 0, and a focused rerun of the suite passed 87/87. The other
thirteen figures come from the full run.

Previously: **798/798** (2026-10-08), across thirteen suites, before
`offers-multi-product-tests.js` existed.

Previously: **701/701** (2026-10-08), across twelve suites, before
`order-status-history-tests.js` existed.

Previously: **614/614** (2026-10-04), across eleven suites, before
`account-controls-tests.js` existed.

## The suites

| File | Covers | API port | CDP port | Last known green |
|---|---|---|---|---|
| `payment-tests.js` | Cart quote, Paystack initialize, `/api/payments/verify` integrity (amounts, signed metadata, idempotency, stock, coupons, offers), and the `POST /api/payments/webhook` signature + idempotency cases | 5055 | — | 68/68 |
| `e2e-checkout.js` | Cart → checkout → payment callback in headless Edge | 5055 | — | 29/29 |
| `auth-e2e.js` | Register / verify / login / password reset (`DEV_EMAIL_LOG=true`, no Paystack, Google or SendGrid keys) | 5055 | 9336 | 28/28 |
| `account-api-tests.js` | Milestone 4 account API + access control | 5056 | — | 49/49 |
| `account-e2e.js` | Milestone 4 My Account pages in headless Edge | 5057 | 9337 | 61/61 |
| `admin-api-tests.js` | Milestone 5 admin API + Milestone 6 coupons and review moderation (products, orders, reviews, offers, stock, coupon CRUD, review hide/unhide) | 5058 | — | 108/108 |
| `admin-e2e.js` | Milestone 5 admin pages + the Coupons page + review hide/unhide + the Phase 6 multi-product offer editor (section 8) in headless Edge | 5059 | 9339 | 98/98 |
| `restore-app-verify.js` | Catalog-restoration **fidelity** only: counts, prices, UTF-8, NULLs, exact offer rows. No time-sensitive offer liveness — see `offers-behaviour.js` | 5060, 5070 | 9340 | 34/34 |
| `offers-behaviour.js` | Offer **behaviour**: live / expired / scheduled / disabled, the expiry boundary, status precedence, storefront sale pricing. Own DB-clock-relative fixtures. A23 waits (up to 10 s) for the sale price to reach the catalogue card instead of reading it after a fixed 800 ms | 5066 | 9341 | 44/44 |
| `platform-tests.js` | CORS allowlist + `GET /api/health` (three server instances) | 5063, 5064, 5065 | — | 19/19 |
| `maintenance-tests.js` | Maintenance mode: the global guard, the bypass list, the admin toggle, the TTL cache, and fail-open on a settings read failure | 5067, 5068 | 9342 | 81/81 |
| `account-controls-tests.js` | Account Controls: customer disable / enable, token-version invalidation, the account-status cache, local + Google login and password-reset behaviour, the payment-settlement exception, the admin control, and disabled-session handling in the storefront | 5071, 5072 | 9343 | 87/87 |
| `order-status-history-tests.js` | Order Status History: the migration 006 schema and backfill, the admin status-transition rules (forward / cancel / backward-with-note / final), one history row per real change, atomicity with the restock, the customer and admin history views, and both order pages in headless Edge | 5073 | 9344 | 92/92 |
| `offers-multi-product-tests.js` | Multi-product offers (Phase 6A-6D): migration 007's UNIQUE (offer_id, product_id), `items[]` create / update (1-50 products, atomic, per-item validation), the grouped admin listing, the lowest-live-price rule on every storefront surface and in the cart, the admin offer editor, and the "+N more in this offer" banner / spotlight. Never touches offer 1, offer 30002 or real products | 5074 | 9345 | 127/127 |
| `scent-family-tests.js` | Scent family (Stage A, API only): migration 008's `products.scent_family` (nullable, CHECK, no backfill); `PATCH /api/admin/products/:id/scent-family` and the all-or-nothing bulk `PATCH /api/admin/products/scent-family` (1-100 products) — every family, explicit null, malformed values / ids / payloads, archived and missing products, auth, a forced mid-write failure rolled back, only `scent_family` changing (updated_at kept), PUT keeping the family. Never touches real products | 5075 | — | 77/77 (focused run, 2026-10-10) |
| `scent-family-admin-e2e.js` | Scent families admin page (Stage B), in headless Edge: nav registration, the five tiles against real counts, search + family / unassigned / stock filters, 30-per-page pagination, single assign / reassign / unassign with Undo and the in-flight state (no duplicate request), an archived-elsewhere product, bulk assign through the confirmation (exact ids + family on the wire), cancel, the 100-product cap, a refused bulk request with no false success, expired session and non-admin, the existing product editor keeping the family, 390px / 1366px. Never touches real products | 5076 | 9346 | 47/47 (focused run, 2026-10-10) |
| `scent-family-storefront-e2e.js` | Shop by Scent Family storefront (Stage C2), in headless Edge: each family filter returns only its products (case-normalised, URL kept, combined with stock, facet lists only the four families); invalid / legacy / empty / space-padded `?scent=` values show a "not found" state (never the full catalogue, never echoed, kept across a refresh) with a removable chip and family links; an empty family's own empty state; the unfiltered catalogue and search unchanged; the homepage section hidden until all four families have ≥ 5 active in-stock classified products (stock / archived / unclassified edges), exactly four photo cards once eligible, hidden on product-API failure or empty data; existing homepage sections intact; 1366 / 820 / 390 px, Tab focus ring, reduced motion. Never touches real products; image files checksummed | 5077 | 9347 | 56/56 (focused run, 2026-10-10) |
| `auth-rate-limit-tests.js` | Login + registration rate limiting (Roadmap Task 3). Unit tests of `rate-limit.js` with an injected clock (threshold, Retry-After, expiry, `clear`, the key cap, the unchanged existing modes; the login throttle's Tier A / Tier B rules, including "a success clears Tier A but never Tier B"), then the real `server.js` **in this process**: Tier A (5 failures per IP + normalised email), Tier B (30 failures per IP), 429 JSON + `Retry-After`, blocked requests never reaching the account lookup, 400 and 403 not counted, registration 10 per IP per hour enforced before validation / MX lookup, and the track-order limiter unchanged. **Database-free:** `./db` is replaced in the require cache by an in-memory fake that refuses writes and unknown queries, `DB_PORT` is forced to 1, and outbound `fetch` and MX lookups are refused and recorded. Client IPs are simulated with `X-Forwarded-For`, which only works because nothing sits in front of a local server | 5079 | — | 51/51 (2026-10-15) |
| `security-headers-tests.js` | API security headers (Roadmap Task 4, backend Phase A, `security-headers.js`): `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, the API CSP, COOP, CORP and `X-DNS-Prefetch-Control` on successful, private, CORS-preflight, malformed-JSON, 404, 429 and maintenance-503 responses; `X-Powered-By` absent; HSTS (`max-age=86400`) only when `X-Forwarded-Proto` says HTTPS; `Cache-Control: no-store` on the private route groups (`/api/me`, `/api/my-orders`, `/api/addresses`, `/api/wishlist`, `/api/admin/*`, `/api/payments/*`, case-insensitive, whole segments) and never on public catalogue routes; CORS and both rate limits unchanged. Express's default 404 / error handler replaces the CSP with its own `default-src 'none'` on the pages it writes; the suite asserts that real value. **Database-free**, same method as `auth-rate-limit-tests.js` (fake `./db`, `DB_PORT=1`, outbound `fetch` and MX lookups refused) | 5080 | — | 41/41 (2026-10-15) |

### Why offer behaviour has its own suite

`restore-app-verify.js` used to assert that the two **restored production** offers were
currently live. Those rows carry absolute windows copied from production (offer 1 ends
`2026-10-03 17:00:00`, offer 30002 ends `2026-10-03 11:33:00`), so once the calendar
passed them the application correctly expired them and 7 assertions went permanently red
with **no code defect**. Those requirements now live in `offers-behaviour.js`, which
creates its own offers with `NOW() ± INTERVAL` windows — same result on any day, in any
timezone. `restore-app-verify.js` keeps the calendar-independent half: the exact stored
offer windows, prices, links and flags.

Expiry is implemented in **three** places and all three are exercised there:

| Where | Rule | Clock |
|---|---|---|
| `/api/offers/active` | `NOW() >= start_at AND NOW() < end_at` | database |
| `computeOfferStatus()` | `now >= end` → Expired | Node process |
| `js/main.js` (storefront) | `new Date(end_at) > now` | **browser** |

Locally all three are the same machine. In production the app and TiDB are different
hosts, and the browser clock belongs to the customer's device — see
`PROJECT-BACKLOG.md` item 2 / #15 notes.

### Phase 3 review moderation (hide / unhide)

`reviews.hidden` (migration 004) lets an admin take a review out of the storefront
without deleting it. The cases live in the two admin suites rather than a new one,
because both already create review fixtures:

- `admin-api-tests.js` — 20 assertions: hide and unhide round-trip; the product
  aggregate recalculated from visible reviews only (5.0/1 ↔ 3.5/2); hiding every
  review gives rating 0 / count 0; the public listing excludes the hidden row **and
  its comment text**; `GET /api/products` reports the recalculated aggregate; the
  admin listing still returns hidden reviews flagged `hidden: true`; non-boolean
  `hidden` → 400; nonexistent and non-numeric ids → 404; unauthenticated → 401,
  customer → 403, forged-admin token → 403, with the flag unchanged after each;
  a customer cannot set `hidden` through review creation; deleting a hidden review
  still recalculates correctly.
- `admin-e2e.js` — 7 assertions (7h–7n): the Visible/Hidden badge and the
  Hide/Unhide action, the row updating without a reload, the flag and aggregate
  persisted, the storefront endpoint dropping the review and its text, and the
  Visible/Hidden filters.

The reason this is tested so heavily in both layers: `products.avg_rating` and
`products.review_count` are **stored**, and `GET /api/products` returns them with
`SELECT *`, so they reach every customer. All four rating-changing paths — customer
create, admin delete, admin hide, admin unhide — go through one helper,
`recalculateProductRating()` in `server.js`, which filters
`WHERE product_id = ? AND hidden = 0`. If any single caller lost that predicate a
hidden review would keep shaping the public rating with no visible symptom.

One deliberate exception: the global review average in `/api/admin/summary` still
counts hidden reviews. It is admin-only, never customer-facing, and was left outside
Phase 3's approved scope.

## Running

All nineteen locate the repo themselves — no environment variable needed:

```bash
cd neofragrances-server
node tests/payment-tests.js
node tests/auth-e2e.js
node tests/admin-e2e.js
# ...and so on, one at a time
```

Each one resolves the repo from its own location, identically:

```js
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
```

So they do not depend on the shell's working directory, and an explicit
`SERVER_DIR` still overrides the default if you need to point one elsewhere.

### Prerequisites

- **Database:** local MariaDB/MySQL, `DB_NAME=neofragrances`, reachable with the
  credentials in `.env`. Every suite exits if `DB_HOST` is not `localhost`/`127.0.0.1`.
- **Migrations applied locally.** Three suites fail at startup without them:
  `maintenance-tests.js` needs `app_settings` (migration **003**, Phase 2) and the
  admin suites need `reviews.hidden` (migration **004**, Phase 3 — `ALTER TABLE
  reviews ADD COLUMN hidden TINYINT(1) NOT NULL DEFAULT 0`, the reversible
  moderation flag; `DEFAULT 0` means every existing review stays visible).
  `account-controls-tests.js` needs `users.disabled_at` / `disabled_reason` /
  `token_version` (migration **005**, Phase 4 — the reversible account-disable
  columns; `token_version` defaults to 0, which is how JWTs issued before the
  migration keep working).
  `order-status-history-tests.js` and both admin suites need `order_status_history`
  (migration **006**, Phase 5 — one row per admin status change; its backfill writes
  one baseline row per existing order).
  `offers-multi-product-tests.js` needs the `UNIQUE (offer_id, product_id)` index on
  `offer_products` (migration **007**, Phase 6A).
  `scent-family-tests.js`, `scent-family-admin-e2e.js` and `scent-family-storefront-e2e.js`
  need `products.scent_family` (migration **008**, scent family Stage A).
  Migration 001 is applied in production; **002, 003, 004, 005, 006, 007 and 008 are local only.**
- **Frontend on `http://127.0.0.1:5500`** for the browser suites (`e2e-checkout.js`,
  `auth-e2e.js`, `account-e2e.js`, `admin-e2e.js`, `restore-app-verify.js`,
  `scent-family-admin-e2e.js` and the other suites that drive Edge).
- **Microsoft Edge** for the browser suites (driven over CDP, headless).
- **The backend running on :5000** for `restore-app-verify.js` only — it checks the
  public API read-only against whatever is already serving.
- Node packages, all already in `package.json`: `mysql2` (via `db.js`), `dotenv`,
  `jsonwebtoken`, `bcrypt`.

### Environment variables

| Variable | Used by | Notes |
|---|---|---|
| `SERVER_DIR` | all | Optional for all nineteen — overrides the self-located repo root |
| `OUT_DIR` | `e2e-checkout.js` | Optional; defaults to `nf-checkout-shots` in the OS temp directory |
| `.env` values | all | Read from the repo's `.env` (`DB_*`); each suite injects its own throwaway `JWT_SECRET` |

**Run them one at a time.** `payment-tests.js`, `e2e-checkout.js` and `auth-e2e.js`
all use port **5055**, so starting one right after another fails with
`ECONNREFUSED 127.0.0.1:5055` while the previous server still holds it.

## Safety

- `auth-rate-limit-tests.js` and `security-headers-tests.js` open no database connection at all: each swaps `./db` for an
  in-memory fake before loading `server.js`, so it writes nothing and leaves nothing
  behind, and it refuses every outbound HTTP request and MX lookup the server attempts.
- Every other suite exits unless `DB_HOST` is `localhost`/`127.0.0.1`. `payment-tests.js` and
  `e2e-checkout.js` additionally require `DB_NAME` to be `neofragrances`. No suite can
  reach production or TiDB.
- Paystack is **mocked** on 127.0.0.1:5099 by `payment-tests.js` and `e2e-checkout.js`
  (`PAYSTACK_API_BASE` plus a fake `sk_test_mock` key are injected into the spawned
  server). The other twelve never touch Paystack. No real payment API call is made.
- **No email leaves the machine.** Seven suites blank `SENDGRID_API_KEY` in the server
  they spawn; the other seven run with `DEV_EMAIL_LOG=true`, and the local `.env` holds
  no `SENDGRID_API_KEY` either. `mailer.js` requires that key to send, so no outbound
  SendGrid request is possible from any suite.
- No secrets live in these files — each generates a random `JWT_SECRET` per run.
- They do write to the local database (temporary users, addresses, orders, coupons,
  offers, products, reviews, wishlist rows) and delete it again in a `finally` block
  that also restores stock. The last line of a run reports what was left, e.g.
  `cleanup: users=1 orders=0 coupons=0 offers=2 addresses=0 | stock restored: true`
  (`users=1` is the local admin, `offers=2` the real catalog offers).
- **Wishlist cleanup is scoped to the suite's own users, by design.**
  `account-api-tests.js` is the only suite that writes to `wishlist`, and it removes
  those rows with `DELETE FROM wishlist WHERE user_id IN (<its own temporary users>)`.
  It deliberately does **not** delete wishlist rows belonging to the local admin, so a
  non-zero `w` in its cleanup line is that real account's own data, not test leakage.
  Widening that `DELETE` to the whole table would destroy real user data. Don't.

## Webhook tests

`payment-tests.js` covers `POST /api/payments/webhook` end to end against the mock
Paystack: valid `charge.success`, duplicate delivery, webhook-before-callback,
callback-before-webhook, both concurrently, invalid signature, missing signature,
tampered body, unrelated event type, unusable reference, missing and tampered
snapshot, amount mismatch, insufficient stock, and a raw-body case whose JSON has
non-ASCII characters and deliberately odd formatting.

That last one is the only test that fails if the signature is ever computed over
`JSON.stringify(req.body)` instead of the bytes as received — verified by temporarily
making that change, at which point 13 of the 14 webhook tests still passed and only
that one failed. Keep it.

Test signatures are produced with the same fake key the spawned server is given
(`sk_test_mock`); no real Paystack key is involved.

## Gotchas

- **Never pipe a run through `head`/`grep -m`.** Closing the pipe kills the process
  with SIGPIPE before the cleanup block finishes and leaves fixture rows behind.
  Redirect to a log file and grep the file.
- The browser suites leave **~10–19 `msedge.exe` processes** alive per run (command
  line contains `nf-edge`). Kill them between runs; once dozens accumulate the machine
  starves and timing-sensitive checks fail spuriously.
- `admin-e2e.js`, `account-e2e.js` and `restore-app-verify.js` write screenshots into
  **this directory** (`m5-shots/`, `m4-shots/`, `restore-shots/`), which is gitignored
  here. Those paths were already `__dirname`-based and were left as they were.
- Fixture products in `payment-tests.js` / `e2e-checkout.js` are selected as
  `deleted_at IS NULL AND stock_qty BETWEEN 5 AND 47`. That ceiling is
  `MAX_QTY_PER_LINE - OVER_STOCK_PROBE`: the over-stock assertions ask for a quantity
  just above stock, which must stay under `pricing.js`'s `MAX_QTY_PER_LINE = 50` or the
  server rejects it as an invalid *quantity* and the stock check never runs. Keep that
  constant in step with `pricing.js`.
