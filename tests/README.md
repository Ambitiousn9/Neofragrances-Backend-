# Local regression suites

Twenty-three standalone Node test files (no test framework, no shared runner; each
file is run on its own):

- **Seventeen database-backed suites.** Each starts its **own** `server.js` on a
  private port, runs its checks, then deletes every fixture it created and restores
  stock. They all refuse to run unless the database host is local. Fourteen use the
  working `neofragrances` database. Three are guarded and run only against an isolated
  `nf_test_*` test database: `admin-api-tests.js` (see "Isolated-database run of
  `admin-api-tests.js`"), `payment-tests.js` (see "Isolated-database run of
  `payment-tests.js`") and `e2e-checkout.js` (see "Isolated harness for
  `e2e-checkout.js`" — not yet run in that form).
- **Five database-free suites** that load the real `server.js` with an in-memory fake
  `./db`: `auth-rate-limit-tests.js`, `security-headers-tests.js`,
  `payment-reliability-tests.js`, `payment-issues-tests.js` and `admin-session-tests.js`
  (see their rows below).
- **One guard self-test**, `isolated-db-guard-tests.js`, which starts no `server.js`
  and opens no database connection.

**Run the whole set, not just the eight in the table's original form.** The table
below lists all twenty-three; `platform-tests.js`, `offers-behaviour.js`,
`maintenance-tests.js`, `account-controls-tests.js`,
`order-status-history-tests.js`, `offers-multi-product-tests.js`,
`scent-family-tests.js`, `scent-family-admin-e2e.js`,
`scent-family-storefront-e2e.js`, `auth-rate-limit-tests.js`,
`security-headers-tests.js`, `payment-reliability-tests.js`,
`payment-issues-tests.js`, `admin-session-tests.js` and `isolated-db-guard-tests.js`
were added after the original eight and are easy to miss.

**Aggregate status.** The last complete run recorded in this file is **925/925** across
the **fourteen** suites that existed on 2026-10-09 (Milestone 6 Phase 6E), with
`offers-multi-product-tests.js` passing 127/127. There are now **twenty-three** test
files. The nine added since — `scent-family-tests.js`, `scent-family-admin-e2e.js`,
`scent-family-storefront-e2e.js`, `auth-rate-limit-tests.js`, `security-headers-tests.js`,
`payment-reliability-tests.js`, `payment-issues-tests.js`, `admin-session-tests.js` and
`isolated-db-guard-tests.js` — have focused results only, shown per row in the table
below with their dates. No run of all twenty-three is recorded here, so the per-suite
figures must not be added up as if they were one run.

**Status against the current code.** Several changes landed after most of the
database-backed results were recorded: payment reliability Stage A and Stage B, login /
registration rate limiting, API security headers, ADMIN-3 (12-hour admin tokens and
server-side admin logout) and migration 009 (applied locally on 2026-10-17). The last
`server.js` change was on 2026-10-17. Against that code:

- **Passed:** `admin-api-tests.js` 108/108 (ADMIN-5F, isolated test database, saved run
  log), and 108/108 again on 2026-10-19 with the Option 2B pre-spawn check in place
  (see "Option 2B runtime verification" below). `payment-tests.js` 68/68 on 2026-10-19:
  one guarded run of the in-repo file against the isolated test database
  `nf_test_payment_20261019`, with Paystack mocked (see "Isolated-database run of
  `payment-tests.js`"). The five database-free suites passed on 2026-10-17 after the last `server.js`
  change (`payment-issues-tests.js` 84/84, `payment-reliability-tests.js` 66/66,
  `auth-rate-limit-tests.js` 51/51, `security-headers-tests.js` 41/41,
  `admin-session-tests.js` 23/23), with run logs saved outside the repo.
  `isolated-db-guard-tests.js` 28/28 is recorded in the session transcript only; no run
  log was saved.
- **Safely aborted:** the first controlled run of `admin-api-tests.js` (ADMIN-5E). See
  its section below.
- **Older-code results only:** the other fifteen database-backed suites. Their last
  passes predate some or all of the changes listed above, and they have **not all been
  re-run** since. Their figures in the table are not evidence for the current code.
- **Historical:** on 2026-10-17 (Phase 3B.9D) a modified copy of `payment-tests.js`, kept
  outside the repo and run under a separate scratchpad guard, passed 68/68 against a
  restored scratch database. That was before the ADMIN-3 `server.js` change and before
  the in-repo file itself was guarded; it is not evidence for the current file.
- **Not yet run:** no run of all twenty-three files. `e2e-checkout.js` has **not been
  run** in its current, isolated-database form (see "Isolated harness for
  `e2e-checkout.js`"), so its `payment_issues` cleanup has never been executed either.

**Test database server moved to port 3308 (2026-10-29).** Since 2026-10-27 the
application's local data lives on a replacement MariaDB instance at `127.0.0.1:3308`; the
old XAMPP server on `3306` is kept frozen as a rollback target and must not receive test
writes. The isolated-database guard (`EXPECTED_PORT`) and the pre-checks in
`admin-api-tests.js`, `payment-tests.js` and `e2e-checkout.js` now require
`DB_PORT=3308` and refuse `3306`. Isolated `nf_test_*` databases must be provisioned on
the 3308 instance. Earlier results below that name `:3306` were recorded on the old
server before the move. Database-free baseline re-run the same day (current code):
`auth-rate-limit-tests.js` 51/51, `security-headers-tests.js` 41/41,
`payment-reliability-tests.js` 66/66, `payment-issues-tests.js` 84/84,
`admin-session-tests.js` 23/23, `isolated-db-guard-tests.js` 28/28 before the port change
and 29/29 after it (one added case: an identity reporting port 3306 is refused); run
logs kept outside the repo.

`account-controls-tests.js` scored 86/87 in the 925/925 run. A87 hard-coded the old local
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
| `payment-tests.js` | Cart quote, Paystack initialize, `/api/payments/verify` integrity (amounts, signed metadata, idempotency, stock, coupons, offers), and the `POST /api/payments/webhook` signature + idempotency cases | 5055 | — | 68/68 (2026-10-19; 0 failed, exit code 0 — one guarded run of the in-repo file against the isolated test database `nf_test_payment_20261019`, Paystack mocked on 127.0.0.1:5099; see "Isolated-database run of `payment-tests.js`" below. Earlier 68/68 figures were older-code runs) |
| `e2e-checkout.js` | Cart → checkout → payment callback in headless Edge (functional only: the Google Fonts and Font Awesome stylesheets are blocked on purpose). Isolated test database only; see "Isolated harness for `e2e-checkout.js`" | 5055 (mock Paystack 5099) | 9334 | **Not run against the current harness.** 29/29 was recorded for the older version, which used the working database; it is not evidence for the current file |
| `auth-e2e.js` | Register / verify / login / password reset (`DEV_EMAIL_LOG=true`, no Paystack, Google or SendGrid keys) | 5055 | 9336 | 28/28 |
| `account-api-tests.js` | Milestone 4 account API + access control | 5056 | — | 49/49 |
| `account-e2e.js` | Milestone 4 My Account pages in headless Edge | 5057 | 9337 | 61/61 |
| `admin-api-tests.js` | Milestone 5 admin API + Milestone 6 coupons and review moderation (products, orders, reviews, offers, stock, coupon CRUD, review hide/unhide) | 5058 | — | 108/108 (2026-10-17, ADMIN-5F; 0 failed, exit code 0 — one controlled run against the isolated test database `nf_test_admin_api_20261017`, not the working `neofragrances` database; see "Isolated-database run of `admin-api-tests.js`" below). 108/108 again on 2026-10-19 (Option 2B runtime verification, same database, exit code 0) |
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
| `scent-family-storefront-e2e.js` | Shop by Scent Family storefront (Stage C2), in headless Edge: each family filter returns only its products (case-normalised, URL kept, combined with stock, facet lists only the four families); invalid / legacy / empty / space-padded `?scent=` values show a "not found" state (never the full catalogue, never echoed, kept across a refresh) with a removable chip and family links; an empty family's own empty state; the unfiltered catalogue and search unchanged; the homepage section hidden until all four families have ≥ 5 active in-stock classified products (stock / archived / unclassified edges), exactly four photo cards once eligible, hidden on product-API failure or empty data; existing homepage sections intact; 1366 / 820 / 390 px, Tab focus ring, reduced motion. Never touches real products; image files checksummed. Since 2026-10-13, after the owner's classifications were written to the local database, an isolated mode hides non-fixture families in the browser and six further checks compare against the real catalogue | 5077 | 9347 | 62/62 (focused run, 2026-10-13, after that test fix; recorded in the 2026-10-13 test-fix records kept outside the repo, not a saved log here. Earlier: 56/56 on 2026-10-10. Older code: predates Stage B, ADMIN-3 and migration 009) |
| `auth-rate-limit-tests.js` | Login + registration rate limiting (Roadmap Task 3). Unit tests of `rate-limit.js` with an injected clock (threshold, Retry-After, expiry, `clear`, the key cap, the unchanged existing modes; the login throttle's Tier A / Tier B rules, including "a success clears Tier A but never Tier B"), then the real `server.js` **in this process**: Tier A (5 failures per IP + normalised email), Tier B (30 failures per IP), 429 JSON + `Retry-After`, blocked requests never reaching the account lookup, 400 and 403 not counted, registration 10 per IP per hour enforced before validation / MX lookup, and the track-order limiter unchanged. **Database-free:** `./db` is replaced in the require cache by an in-memory fake that refuses writes and unknown queries, `DB_PORT` is forced to 1, and outbound `fetch` and MX lookups are refused and recorded. Client IPs are simulated with `X-Forwarded-For`, which only works because nothing sits in front of a local server | 5079 | — | 51/51 (2026-10-15; re-run 51/51 on 2026-10-17 after migration 009 was applied locally, with `.env` blocked — in-memory database mock) |
| `security-headers-tests.js` | API security headers (Roadmap Task 4, backend Phase A, `security-headers.js`): `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, the API CSP, COOP, CORP and `X-DNS-Prefetch-Control` on successful, private, CORS-preflight, malformed-JSON, 404, 429 and maintenance-503 responses; `X-Powered-By` absent; HSTS (`max-age=86400`) only when `X-Forwarded-Proto` says HTTPS; `Cache-Control: no-store` on the private route groups (`/api/me`, `/api/my-orders`, `/api/addresses`, `/api/wishlist`, `/api/admin/*`, `/api/payments/*`, case-insensitive, whole segments) and never on public catalogue routes; CORS and both rate limits unchanged. Express's default 404 / error handler replaces the CSP with its own `default-src 'none'` on the pages it writes; the suite asserts that real value. **Database-free**, same method as `auth-rate-limit-tests.js` (fake `./db`, `DB_PORT=1`, outbound `fetch` and MX lookups refused) | 5080 | — | 41/41 (2026-10-15; re-run 41/41 on 2026-10-17 after migration 009 was applied locally, with `.env` blocked — in-memory database mock) |
| `payment-reliability-tests.js` | Payment reliability, Stage A (PI-01 / PI-02 / PI-07): Paystack verification classified as success / pending (`pending`, `ongoing`, `processing`, `queued`) / failed (`failed`, `abandoned`, `reversed`) / temporary (timeout, network reset, HTTP 404 / 429 / 5xx, invalid JSON, malformed or unrecognised answers); the callback's 201 / 200 / 202 `PAYMENT_PENDING` / 400 / 503 `PAYMENT_VERIFY_UNAVAILABLE` / 409 / 500 `SETTLEMENT_ERROR` answers; the webhook's 200 vs 503 / 500 retry policy (duplicate, pending, outage then recovery, DB failure, definitive failure, bad signature, unrelated event); every integrity check (reference, currency, amount, signed snapshot, other customer); rollback + lock release on a DB failure; the 10 s verify and 15 s initialize timeouts (really waited, in parallel); and `neofragrances-frontend/js/payment-result.js` in a vm sandbox (bag cleared only on a confirmed order, bounded pending re-checks, never invited to pay again while uncertain). **Database-free and network-isolated:** an in-memory fake `./db` with real transaction rollback, `DB_PORT=1`, a mock Paystack on 127.0.0.1:5082 with a fake key, every other outbound request refused. Takes about 20 s. Since Stage B it also simulates migration 009 **not** being applied: every `payment_issues` statement fails as "table doesn't exist", and every payment response must stay unchanged (B2) | 5081, 5082 | — | 66/66 (2026-10-17; 0 failed, 0 skipped — first run after the Stage B review corrections, and again 66/66 the same day after the lowercase-only payment-reference pattern change, with `.env` blocked; in-memory database mock + local mock Paystack, so not evidence of MariaDB/TiDB behaviour) |
| `payment-issues-tests.js` | Payment-issue register + admin recovery (Stage B, `payment-issues.js`, migration 009 — applied LOCAL ONLY 2026-10-17): which settlement outcomes create an issue (sold out, archived product, deleted address, coupon used up, verified integrity mismatches, database error after verification, signed-webhook temporary/pending) and which never do (callback-only problems, unknown/invalid references, wrong user, definitive failures, unrelated/forged webhooks); evidence precedence (`paystack_verified` never downgraded); invalid snapshots never supply user/expected total; the existing-order guard; automatic resolution on settlement; resolved issues frozen; an issue-store outage never changing a payment response; PI-06 address/product codes; admin list/detail/retry/resolve (requireAdmin 401/403, filters, 409 RETRY_NOT_ALLOWED / ALREADY_RESOLVED / ORDER_EXISTS / RETRY_IN_PROGRESS, no manual "settled"); a promise-gated race of admin retry + webhook past the existing-order check with GET_LOCK granted to both (one order, stock once); the summary badge with the table missing; no card/authorization data, signatures, snapshot or email stored or returned. Review corrections (U10–U13, RC1–RC9): integer/digit-string amounts only, no amount/currency on a reference mismatch, deleted-address issues not retryable, admin-facing retry messages, the original blocking reason kept through pending/temporary/database-error retries, resolve refused during a running retry of the same issue (409 RETRY_IN_PROGRESS), and an order committed after a manual decision linked without rewriting the decision and flagged as `manual_resolution_conflict`. **Database-free and network-isolated** (fake `./db` with a per-transaction undo log, `DB_PORT=1`, mock Paystack on 127.0.0.1:5084). Proves application logic only — not migration 009, real isolation/locking or TiDB `GET_LOCK` | 5083, 5084 | — | 84/84 (2026-10-17; 0 failed, 0 skipped — corrected suite including U10–U13 and RC1–RC9, plus payment-reference boundary tests B1–B8 and case-validation tests C1–C4, confirmed 84/84 again after migration 009 was applied locally, with `.env` blocked; in-memory database mock + local mock Paystack, so not evidence of MariaDB/TiDB behaviour) |
| `admin-session-tests.js` | Admin session lifetime and server-side logout (ADMIN-3): admin tokens signed for 12 hours and customer tokens for 7 days (password and Google sign-in), and `POST /api/admin/logout` revoking the admin's existing tokens by bumping `token_version` in a transaction. **Database-free and network-isolated**, same method as `auth-rate-limit-tests.js`: fake `./db` with an undo log, `DB_PORT=1`, Google's token check stubbed, outbound `fetch` and MX lookups refused. Does not cover password change / reset revoking sessions (still open) | 5086 | — | 23/23 (2026-10-17, after the ADMIN-3 `server.js` change, with `.env` blocked; run log saved outside the repo; in-memory database mock, so not evidence of MariaDB/TiDB behaviour) |
| `isolated-db-guard-tests.js` | Self-test of the isolated-database guard (ADMIN-5B, `tests/support/isolated-db-guard.js` and its preload): the opt-in `NF_TEST_MODE`, the `nf_test_*` name rule, the required host / port / server hostname, refusal of non-local hosts, URI strings and SSL configs, the dotenv stub and `.env` block, the identity gate, and the preload reaching child processes through `NODE_OPTIONS` (including a path with spaces). Uses fakes and short `node -e` children; starts no `server.js` and opens no database connection | — | — | 29/29 (2026-10-29, after the port change to 3308, which added one case; run log kept outside the repo). Earlier: 28/28 (2026-10-17, ADMIN-5B, session transcript only; re-run 28/28 on 2026-10-29 before the change) |

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

### Isolated-database run of `admin-api-tests.js` (ADMIN-5F, 2026-10-17)

`admin-api-tests.js` now refuses to start unless the isolated-database guard
(`tests/support/isolated-db-guard.js`, loaded through
`tests/support/isolated-db-guard-preload.js`) is active with `NF_TEST_MODE=isolated`, and
`DB_NAME` equals an `nf_test_*` `NF_TEST_DB_NAME` on `127.0.0.1:3308`. Exact database
identity verification is mandatory, in the test process and in the spawned server,
before any business API assertion runs. The working-database prerequisites under
"Running" do not apply to this suite.

**ADMIN-5E (first controlled run, 2026-10-17).** It aborted before sending any API
request. The parent verified its own database identity, inserted three temporary test
users directly into the isolated test database, and then started the child `server.js`.
The child printed no output at all during the old readiness loop (60 `GET /` probes,
roughly 12–13 s), so it never became ready, and the harness reported this, misleadingly,
as a database-identity confirmation failure rather than a startup timeout. Cleanup
deleted the three users: the before/after snapshots of the isolated test database (row
counts and `CHECKSUM TABLE … EXTENDED`) matched, and the only trace was the `users`
auto-increment advancing by 3. The snapshot of the working `neofragrances` database was
also unchanged, and the run made no request outside 127.0.0.1. So ADMIN-5E sent no API
requests, but it did make those direct database writes.

**Why the child was silent.** Two later diagnostic reproductions with the same launch
method (Stage 2 and Stage 3, no test suite) explain it. Stage 2 saw the child stay silent
for about 18 s while every readiness probe was refused. Stage 3 measured about 16.9 s
from spawn to listening, spent almost entirely loading `express`, `jsonwebtoken` and
`google-auth-library`. These figures come from the reproductions, not from the ADMIN-5E
run itself, and why module loading is sometimes this slow is still unexplained (in
ADMIN-5F the child was ready in under 4 s).

**Readiness change.** The suite now:

1. waits passively for the child's listening line, with a hard **60 s** startup deadline.
   It fails closed on a guard abort, a spawn error, child exit or timeout.
2. sends exactly **one** `/api/health` request after the listening signal, which must
   return 200.
3. requires the child's exact identity line
   `identity verified <NF_TEST_DB_NAME>@<NF_TEST_DB_SERVER_HOSTNAME>:<DB_PORT>`.

This change was statically validated before the controlled run.

**ADMIN-5F result: 108/108 assertions passed, 0 failed, exit code 0.** Exactly one
run, with no retries or reruns.

- **Database:** `nf_test_admin_api_20261017`, a local copy of the working schema with
  migrations through 009. Identity verified in both processes as
  `nf_test_admin_api_20261017@AMBITIOUS:3306`.
- **Startup:** the child server was ready after 3,958 ms.
- **Database integrity:** row counts and `CHECKSUM TABLE … EXTENDED` matched before and
  after for all 16 tables of the test database.
- **Cleanup:** no leftover test records. The only trace is expected auto-increment
  advancement from fixtures created and then deleted: users +3, products +3,
  reviews +3, orders +4, order_items +4, order_status_history +2, coupons +4,
  offers +1, offer_products +2, addresses +1.
- **Process cleanup:** the child exited and port 5058 was released. The servers on
  :5000 and :5500 were not disturbed.
- **Safety:** the working `neofragrances` database and TiDB were not contacted. The
  guard reported no `.env` read, no refused requests and no MX lookups.

**Scope.** This is the result of this one suite only. It does not change the aggregate
status above: no complete run of the backend inventory is recorded since the change.
Apart from `payment-tests.js` (guarded since 2026-10-19, see its section below), the
other database-backed suites have not adopted the isolated-database guard or been run
against a test database.

**Pre-spawn guard check (ADMIN-5E-DIAG Option 2B, added after ADMIN-5F).** The suite
now builds the child's environment once (`CHILD_ENV`: `process.env` plus `PORT`,
`JWT_SECRET` and `DEV_EMAIL_LOG`) and validates that exact object at module load,
before any database access and before `server.js` is spawned:

- `NODE_OPTIONS` must contain a `--require=<path>`, `--require <path>` or `-r <path>`
  entry whose path is absolute and resolves to `tests/support/isolated-db-guard-preload.js`
  in the repository the child runs from (its working directory). On Windows the path
  comparison ignores case.
- The child's isolated-test configuration must pass the guard's own
  `validateTestConfig`.

If either is missing or invalid, the suite prints which one failed and exits with code 1
before the identity gate, any fixture write or the spawn. The diagnostic names the
expected preload path but does not print the contents of `NODE_OPTIONS`. The spawn then
uses the same validated `CHILD_ENV` object. The identity and readiness checks above are
unchanged.

`payment-tests.js` uses the same pre-spawn check (identical code; its `CHILD_ENV` adds the
mock-Paystack, empty-email and frontend overrides listed in its section).

**Where the check sits (both suites).** In both suites the pre-spawn check (with the
constants and `CHILD_ENV` it needs) runs immediately after the suite's own isolation
check (ADMIN-5C) and **before** the suite's `require("dotenv").config()` call, before
`jsonwebtoken` (and, in `admin-api-tests.js`, `bcrypt`) are loaded, and before `db.js`
creates the connection pool. It was moved there on 2026-10-19 as a pure relocation of
existing lines. Without the guard preload, the suite's own isolation check refuses
first. With the guard active but `NODE_OPTIONS` missing, the pre-spawn check refuses
before any of those suite steps, any query or connection, any fixture and any spawn.
The guard preload itself still runs before any suite code: it installs the `dotenv`
stub and loads `mysql2`, so those two steps happen in every case.

Evidence after the move (2026-10-19, both suites, V1–V3 with a passive tracer, no
database credentials): no preload → exit code 1 (the suite's own check); guard active
with `NODE_OPTIONS` missing → exit code 1 (the pre-spawn refusal), the guard reported
`identity=not verified` and `dotenvStubbed=0`, and the tracer saw no suite request for
`dotenv`, `jsonwebtoken`, `bcrypt` or `db`; `DB_NAME=neofragrances` → exit code 97 from
the guard preload. No socket, DNS, fetch, listener or child process was observed in any
case. Normal guarded runs afterwards still passed: `admin-api-tests.js` 108/108 and
`payment-tests.js` 68/68, each against its isolated test database, with the working
database unchanged. Before the move, the same negative case refused only after the
suite's `dotenv` call and `db.js` pool creation (`dotenvStubbed=2`). The tracer cannot
see the files read by Node's module loader, so its evidence is module requests, the
guard's counters and network hooks, not file reads.

**Option 2B runtime verification (2026-10-19).** The check, first verified only
statically, was exercised against the same isolated database,
`nf_test_admin_api_20261017` on local MariaDB at `127.0.0.1:3306`:

- **Negative check A** (no guard preload at all): exit code 1. The suite refused to run
  before loading the database module or starting the server.
- **Negative check B** (parent guarded, `NODE_OPTIONS` missing): exit code 1. The new
  pre-spawn check refused to run because the child server would not be guarded.
- **Normal guarded run:** 108/108 passed, exit code 0.
- **Database:** before/after row counts, `CHECKSUM TABLE … EXTENDED`, DDL, foreign-key
  structure and database identity all matched. Auto-increment advancement matched the
  ADMIN-5F run, and there were no unexplained changes. No production service was
  contacted. Run logs and snapshots are saved outside the repo.

**Open concern:** the child server took about 30.8 s to become ready, against about
4.0 s in ADMIN-5F. That is inside the 60 s startup deadline, but the cause of the slow
startup is still unresolved.

### Isolated-database run of `payment-tests.js` (2026-10-19)

`payment-tests.js` follows the same pattern as `admin-api-tests.js`. It refuses to start
unless the isolated-database guard preload is active with `NF_TEST_MODE=isolated`, and
`DB_NAME` equals an `nf_test_*` `NF_TEST_DB_NAME` on `127.0.0.1:3308`. That check runs
before `dotenv` and `db.js` are loaded. It no longer requires `DB_NAME=neofragrances`;
the guard rejects the working database outright. The header of `payment-tests.js` shows
the full launch line.

**Behaviour, as implemented in the source:**

- The test process's database identity (guard identity gate) is checked before the
  mock Paystack, the server or any fixture.
- Mock Paystack (127.0.0.1:5099): a port conflict or other listen error fails the run
  before `server.js` is spawned or any fixture is written.
- `server.js` is spawned with the checked `CHILD_ENV` (see "Pre-spawn guard check"):
  Paystack is pointed at the mock with the fake key `sk_test_mock`, `SENDGRID_API_KEY`
  and `GOOGLE_CLIENT_ID` are empty, and `FRONTEND_URL` is `http://127.0.0.1:5500`.
- Readiness: the suite waits for the server's listening line (60 s deadline), sends one
  `/api/health` request (15 s timeout, no retry) that must return 200, and requires the
  server's exact identity line. Any failure stops the run before fixtures are written.
- Cleanup (`finally`): the spawned server is stopped first (waiting at most 5 s), then
  each cleanup step runs on its own, so one failure does not skip the rest: this run's
  `payment_issues` rows, orders and order items, addresses, users, offer products,
  offers, coupons, each recorded product's stock, and a final check that stock matches.
  A failed step is listed as `CLEANUP FAILED` and makes the run exit 1. Not covered: a
  hard kill or Ctrl+C, or a guard exit during the run, skips cleanup (there is no signal
  handler), which could leave fixtures in the test database.

**Test database.** `nf_test_payment_20261019` was created on 2026-10-19 on the local
MariaDB (AMBITIOUS:3306), separate from `nf_test_admin_api_20261017`. It was restored
from the pre-009 backup of the working database (SHA-256 checked) behind a guard that
stops the restore unless the session is on that database, then brought to 009. It was
verified against the reference evidence: 16 tables, 21 foreign keys (each definition
compared), and enough fixture products (114 active with stock 5–47, 49 sold out).
The working database was unchanged before and after provisioning. This is local test
setup, not deployment configuration.

**Negative cases (2026-10-19):**

- No guard preload: exit code 1, refused by the suite's own check.
- Guard active, `DB_NAME=neofragrances`: exit code 97, `ABORT: DB_NAME is the working
  database` from the guard preload, before the suite runs.
- Guard active, `NODE_OPTIONS` missing (Option 2B): exit code 1, the pre-spawn refusal
  (see "Where the check sits").

**Result: 68/68 passed, 0 failed, exit code 0.** One run, no retries, about 28 s; the
server was ready after 5,167 ms. Identity was verified as
`nf_test_payment_20261019@AMBITIOUS:3306` in the test process and confirmed for the
server by the exact identity line. The guard reported 75 allowed requests (all to
127.0.0.1), none refused, and no `.env` read.

**Database after the run:**

- **Test database:** schema, all 21 foreign keys and every row count matched the
  pre-run snapshot, and no `payment_issues` rows or orders were left. Two kinds of
  change remain, both expected from the suite's code:
  - `products.updated_at` on the three fixture products (#14, #20, #21), whose stock was
    changed and restored; their stock and price match the pre-run values, so the
    `products` checksum differs.
  - Auto-increments: users +2, addresses +2, coupons +6, offers +4, offer_products +4,
    orders +8, order_items +9, payment_issues +10. Rolled-back inserts (the losing
    side of the one-use coupon race) and duplicate-key insert attempts on
    `payment_issues` also consume values.
- **Working `neofragrances` database:** row counts and `CHECKSUM TABLE … EXTENDED` for
  all 16 tables identical before and after.

**Scope.** This proves the suite against a **mocked** Paystack and an isolated copy of
the local data. It does not test the real Paystack integration, register or verify the
production webhook, or check production secrets, Render settings or TiDB migration
compatibility.

Evidence (outside the repo): `C:\Users\Ambitous\NeoFragrances-DB-Backups\payment-run-20261019\`
(run log, negative-case log, before/after snapshots, `SHA256SUMS.txt`) and
`…\payment-db-reference-20261019\` (provisioning evidence and baseline).

### Isolated harness for `e2e-checkout.js` (not yet run)

`e2e-checkout.js` now follows the same guard pattern as `payment-tests.js`. It has **not
been run** in this form: there is no result, no negative-case evidence and no test
database provisioned for it yet. Everything below describes the source, not observed
behaviour. The header of the file shows the full launch line.

- **Database.** It refuses to start unless the guard preload from this repo is active
  (`NODE_OPTIONS`, checked against the module cache), `NF_TEST_MODE=isolated`, `DB_NAME`
  equals an `nf_test_*` `NF_TEST_DB_NAME`, `DB_HOST=127.0.0.1` and `DB_PORT=3308`. It
  never accepts the working `neofragrances` database. `SERVER_DIR` must be unset or this
  repo. The spawned `server.js` gets an allowlisted environment that is checked before the
  spawn (Option 2B).
- **Artefact paths, both required, no defaults.** `OUT_DIR` (screenshots) and
  `EDGE_PROFILE_PARENT` (the Edge profile) must be absolute, existing real directories,
  outside both repositories and not the bare system temp folder. Each run creates a new
  `e2e-checkout-<run id>` folder in `OUT_DIR` (kept) and a new `nf-edge-e2e-<run id>`
  profile in `EDGE_PROFILE_PARENT` (deleted at the end, only because that run created it).
- **Order, as implemented.** Ports 5055 / 5099 / 9334 free, the storefront answering on
  :5500, this process's database identity, the fixture products (a read), then the mock
  Paystack; `server.js` must print its listening line (60 s), answer `/api/health` with
  `ok` / `ok` and print its own exact identity line; then Edge must announce its own
  DevTools endpoint and request interception must be enabled. **Fixtures are written only
  after all of that**, before the first page that needs them.
- **Browser isolation.** Every page request is intercepted. `localhost:5000` is rewritten
  to the isolated API, the storefront and the isolated API are allowed, and everything
  else is blocked. A response from port 5000 or a non-loopback address ends the run.
- **Expected blocked stylesheets.** The tested pages link two outside stylesheets: the
  Google Fonts `css2` URL for Fraunces + Inter and the cdnjs Font Awesome Free 6.5.1
  `all.min.css`. Both are still **blocked**; a request matching one of those two exact
  URLs, with `GET` and resource type `Stylesheet`, is counted as an expected block
  instead of failing the run. Any other outside request — another host, path, query,
  method or resource type — is an unexpected block and fails the run.
- **Functional only.** With those stylesheets blocked, the pages render in fallback fonts
  and without icons. The run says so in its output. Its screenshots and its mobile
  overflow check do **not** establish visual fidelity.
- **Exit code 1** on any failed assertion, harness error (including timeouts and the
  10-minute run deadline), cleanup failure, unexpected blocked request, isolation
  violation or recorded CDP routing error. Cleanup runs in `finally` for all of these;
  it does not run on a hard kill, Ctrl+C or a guard exit (97).

## Running

All twenty-three locate the repo themselves — no environment variable needed to find it.
The exceptions to "nothing to set" are `admin-api-tests.js`, `payment-tests.js` and
`e2e-checkout.js`, which refuse to start without the isolated-database configuration
described under "Prerequisites" (`e2e-checkout.js` also needs `OUT_DIR` and
`EDGE_PROFILE_PARENT`; each file's header shows the full launch line):

```bash
cd neofragrances-server
node tests/auth-e2e.js
node tests/admin-e2e.js
# ...and so on, one at a time
```

Twenty-one of them resolve the repo from their own location, identically:

```js
process.chdir(process.env.SERVER_DIR || path.join(__dirname, ".."));
```

So they do not depend on the shell's working directory, and an explicit
`SERVER_DIR` still overrides the default if you need to point one elsewhere.
`isolated-db-guard-tests.js` does not change directory; it resolves the guard files from
`__dirname` and ignores `SERVER_DIR`. `e2e-checkout.js` always runs from the repo that
contains it and refuses a `SERVER_DIR` that names any other directory.

### Prerequisites

- **Database:** local MariaDB/MySQL, `DB_NAME=neofragrances`, reachable with the
  credentials in `.env`, for the fourteen working-database suites. Every suite exits if
  `DB_HOST` is not `localhost`/`127.0.0.1`. The five database-free suites and
  `isolated-db-guard-tests.js` need no database. `admin-api-tests.js`,
  `payment-tests.js` and `e2e-checkout.js` need an isolated test database (below) instead.
- **Isolated test database (`admin-api-tests.js`, `payment-tests.js`, `e2e-checkout.js`).**
  - A dedicated database whose name matches `^nf_test_[a-z0-9]+(_[a-z0-9]+)*$` on
    `127.0.0.1:3308`, provisioned from a backup of the working schema and brought up to
    the current migrations. The earlier runs used their own databases on the old server at
    `127.0.0.1:3306`, before the move: `nf_test_admin_api_20261017` (2026-10-17) for
    `admin-api-tests.js` and `nf_test_payment_20261019` (2026-10-19) for `payment-tests.js`,
    both at 009. Since 2026-10-29 the guarded suites use `nf_test_phase1_20261029` on 3308,
    provisioned from the Gate A backup.
    The guard refuses any other name, including the working database and the
    `neofragrances_m009_scratch_*` copies.
  - Environment, set explicitly for that one run: `NF_TEST_MODE=isolated`,
    `NF_TEST_DB_NAME=<db>`, `DB_NAME=<same db>`, `DB_HOST=127.0.0.1`, `DB_PORT=3308`,
    `NF_TEST_DB_SERVER_HOSTNAME=<the server's @@hostname>`, `DB_USER` / `DB_PASSWORD`
    for the local account (the guard blocks `.env`), and
    `NODE_OPTIONS=--require="<backend>/tests/support/isolated-db-guard-preload.js"`. The
    headers of `admin-api-tests.js` and `payment-tests.js` show the full line.
  - The spawned `server.js` inherits the guard through `NODE_OPTIONS`, and both
    processes must print the exact identity line before any business API assertion runs.
    The suite checks the child's `NODE_OPTIONS` and isolation settings before spawning
    (see "Pre-spawn guard check" above).
  - **Never** point any of these suites at the working `neofragrances` database. The
    guard is the only thing that makes them safe to run, and the other database-backed
    suites do not use it yet.
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
  Migration **009** (`payment_issues`) is local only too (applied 2026-10-17). By
  inspection no suite needs it to start: `payment-tests.js` and `e2e-checkout.js` only
  clean up its rows when the table exists (see "Safety").
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
| `SERVER_DIR` | all except `isolated-db-guard-tests.js` | Optional — overrides the self-located repo root. `e2e-checkout.js` accepts only unset or its own repo |
| `OUT_DIR` | `e2e-checkout.js` | **Required**, no default: an absolute, existing directory outside both repositories and not the bare system temp folder; each run creates a new `e2e-checkout-<run id>` folder in it (kept) |
| `EDGE_PROFILE_PARENT` | `e2e-checkout.js` | **Required**, same rules as `OUT_DIR`; each run creates a new `nf-edge-e2e-<run id>` Edge profile in it and deletes only that folder at the end |
| `.env` values | the fourteen working-database suites (the database-free suites load it too unless dotenv is blocked) | Read from the repo's `.env` (`DB_*`); each suite injects its own throwaway `JWT_SECRET` |
| `NF_TEST_MODE`, `NF_TEST_DB_NAME`, `NF_TEST_DB_SERVER_HOSTNAME`, `NODE_OPTIONS`, `DB_*` | `admin-api-tests.js`, `payment-tests.js`, `e2e-checkout.js` | Required; see "Isolated test database" above. `.env` is blocked by the guard |

**Run them one at a time.** `payment-tests.js`, `e2e-checkout.js` and `auth-e2e.js`
all use port **5055**, so starting one right after another fails with
`ECONNREFUSED 127.0.0.1:5055` while the previous server still holds it.

## Safety

- `auth-rate-limit-tests.js`, `security-headers-tests.js`, `payment-reliability-tests.js`,
  `payment-issues-tests.js` and `admin-session-tests.js` open no database connection at
  all: each swaps `./db` for an in-memory fake before loading `server.js`, so it writes
  nothing and leaves nothing behind, and it refuses every outbound HTTP request and MX
  lookup the server attempts (the two payment suites allow only their own mock Paystack,
  on 127.0.0.1:5082 and 127.0.0.1:5084). Loading `server.js` still runs `dotenv.config()`,
  so these five read the repo's `.env` into the test process unless dotenv is blocked;
  the 2026-10-17 runs blocked it with a local preload kept outside the repo.
- `isolated-db-guard-tests.js` starts no `server.js`, opens no database connection and
  sends no network request; its child processes are short `node -e` scripts.
- Migration **009** (`payment_issues`) was **applied LOCAL ONLY on 2026-10-17** to the
  local `neofragrances` database. It is **not** applied to TiDB staging or production.
  The five database-free suites above never need it.
- **Now that 009 is applied locally**, `payment-tests.js` and `e2e-checkout.js` will create
  real `payment_issues` rows (sold out after payment, amount mismatch, tampered snapshot,
  …). Their cleanup deletes exactly the rows for the references that run initialized
  (the mock Paystack's `txs` map), first, and only when `information_schema` shows the
  table exists — so it is a no-op on a database without 009. The other database-writing
  suites never start a Paystack settlement — they either blank the Paystack key or never
  call a payment route (see the Paystack bullet below) — so they cannot create issue rows. The in-repo `payment-tests.js` executed this cleanup on 2026-10-19, against
  the isolated test database `nf_test_payment_20261019`: 6 `payment_issues` rows were
  created and all were removed (see its section). Earlier, a guarded copy kept outside
  the repo ran it once against a restored scratch database (Phase 3B.9D, 68/68). The
  `e2e-checkout.js` cleanup has never run.
- **Stage B changed two settlement responses** (deliberately; `server.js` `settlePayment`):
  a delivery address deleted after checkout used to fail the `orders.address_id` foreign
  key as a 500 `SETTLEMENT_ERROR` (and the webhook retried until Paystack gave up); it is
  now **409 `PAID_ADDRESS_MISSING`** on the callback and **200** (rejected, not retried) on
  the webhook. An archived product used to be reported as `PAID_OUT_OF_STOCK`; it is now
  **`PAID_PRODUCT_UNAVAILABLE`** (409 / webhook 200, as before). Both record a payment
  issue. By inspection, `payment-tests.js` and `e2e-checkout.js` do not exercise either
  case (they lower stock; they never archive products or delete a checkout address).
- Stage A changed how verification outcomes are classified. The expectations in
  `payment-tests.js` and `e2e-checkout.js` still hold by inspection (their "failed"
  cases use a definitive Paystack `failed` status). `payment-tests.js` has since been
  re-run on the current code (68/68, 2026-10-19, isolated test database);
  `e2e-checkout.js` now runs only against an isolated test database and has **not** been
  run in that form.
- Every suite checks that `DB_HOST` is `localhost`/`127.0.0.1` and exits otherwise.
  `account-controls-tests.js`, `maintenance-tests.js`,
  `order-status-history-tests.js` and `platform-tests.js` additionally require
  `DB_NAME` to be `neofragrances`. `admin-api-tests.js`, `payment-tests.js` and
  `e2e-checkout.js` instead require the isolated-database guard, an `nf_test_*` database, `DB_HOST=127.0.0.1` and
  `DB_PORT=3308`; the guard rejects `DB_NAME=neofragrances` (exit code 97, verified for
  `payment-tests.js` on 2026-10-19). No suite can reach production or TiDB.
- Paystack is **mocked** by four suites: on 127.0.0.1:5099 by `payment-tests.js` and
  `e2e-checkout.js` (`PAYSTACK_API_BASE` plus a fake `sk_test_mock` key are injected into
  the spawned server), and on 127.0.0.1:5082 / 5084 by `payment-reliability-tests.js` and
  `payment-issues-tests.js` (fake key). Thirteen suites blank `PAYSTACK_SECRET_KEY` in the
  server they start or load. `account-api-tests.js`, `admin-api-tests.js`,
  `offers-multi-product-tests.js`, `scent-family-tests.js` and `platform-tests.js` do not
  set it and never call a payment route that reaches Paystack (`platform-tests.js` sends
  only CORS preflights to `/api/payments/initialize`). `isolated-db-guard-tests.js`
  starts no server. No real payment API call is made.
- **No email leaves the machine.** Twenty-two files load `server.js`: fifteen blank
  `SENDGRID_API_KEY` in the server they start or load, and the other seven
  (`account-api-tests.js`, `admin-api-tests.js`, `admin-e2e.js`, `offers-behaviour.js`,
  `offers-multi-product-tests.js`, `order-status-history-tests.js`,
  `restore-app-verify.js`) run with `DEV_EMAIL_LOG=true`; the local `.env` holds no
  `SENDGRID_API_KEY` either. `mailer.js` requires that key to send, so no outbound
  SendGrid request is possible from any suite.
- No secrets live in these files — each generates a random `JWT_SECRET` per run. Fixture
  passwords and fake keys (`sk_test_mock`) are test values only.
- The seventeen database-backed suites do write to a local database — the working
  `neofragrances` database for fourteen of them, an isolated test database for
  `admin-api-tests.js`, `payment-tests.js` and `e2e-checkout.js` — (temporary users, addresses, orders, coupons,
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
