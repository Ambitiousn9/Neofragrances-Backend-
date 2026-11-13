# NeoFragrances — Project Backlog

Local working document for the rebuild (covers both `neofragrances-frontend` and `neofragrances-server`).
Items are worked on only when the current milestone requires them.

Status key: ☐ open · ◐ partly done (local) · ☑ done locally (not deployed)

Last updated: 2026-10-02 (Milestone 4)

---

## Critical / pre-deployment

### 1. ☐ Production API / TiDB reliability
- Production database-backed endpoints returned HTTP 500 on 2026-10-01; non-DB endpoints were fine.
- **Currently resolved** (recovered without any change). **Root cause unconfirmed** — Render logs / TiDB console were not available to inspect.
- If it returns: check Render logs (the full error is logged by `server.js`) and TiDB cluster events, connection limits, RU/spending limits and IP allowlist **before** changing code.
- Consider: `GET /api/health` (runs `SELECT 1`) + uptime monitor; mysql2 pool keep-alive / connect timeout for dropped connections; storefront retry state.

### 2. ◐ Payment security hardening (Milestone 3 — done locally, tested)
- ☑ One server-side pricing function (`neofragrances-server/pricing.js`, integer pesewas) used by `POST /api/cart/quote` and payment initialization.
- ☑ Validation: product, positive-integer quantity (max 50/line), stock (across lines), live offer (DB clock), coupon expiry/usage limit, shipping (GH₵8 flat), address ownership.
- ☑ Paystack charged amount, currency (GHS), reference and user verified against an HMAC-signed order snapshot; tampered/unsigned metadata rejected.
- ☑ Stock decrement only if enough remains (never negative); duplicate verifications serialised with `GET_LOCK` + existing-order check.
- ☑ Stored order total = amount actually paid (includes shipping); `/api/checkout` disabled (410).
- ◐ **Deployment check:** confirm the production TiDB version supports `GET_LOCK`/`RELEASE_LOCK` — still open. The defence-in-depth UNIQUE index on `orders.payment_reference` (migration 001) is applied and verified in production. The matching `ER_DUP_ENTRY` handler in `/api/payments/verify`, which returns the normal `{ alreadyProcessed: true }` response when that index rejects a second insert (unrelated duplicate-key errors keep the previous rollback + 500), is done locally and not yet deployed.
- ◐ `PAYMENT_SIGNING_SECRET`: **set locally 2026-10-02** (48 random bytes from `crypto.randomBytes`, hex, distinct from `JWT_SECRET` and the Paystack key; `.env` only, gitignored). Verified by probe that `/api/payments/initialize` signs the order snapshot with it and not with the `JWT_SECRET` fallback. ☐ Still to set in Render — until then production signs snapshots with `JWT_SECRET`, which means rotating `JWT_SECRET` there would invalidate any in-flight payment snapshot. Note the regression suites spawn their server with `PAYMENT_SIGNING_SECRET=""` on purpose to keep covering the fallback path, so a green suite does not prove the variable is wired.
- ☐ "Paid but out of stock" (rare race) currently rolls back and asks the customer to contact support with the reference — there is no admin view of such payments yet; consider a payment-issues record + refund workflow (needs table).
- ☐ Orders don't store subtotal/discount/shipping separately (only the paid total) — needs columns (migration) if admin reporting needs the breakdown.
- ☑ **Paystack webhook (local, 2026-10-02):** `POST /api/payments/webhook` — public, authenticated solely by the `x-paystack-signature` HMAC-SHA512 over the **raw** request body (constant-time compare; `express.json({verify})` keeps the raw bytes for that one path). The payload is a notification only: for `charge.success` it takes the reference and re-verifies the transaction with Paystack. An order is now created even if the customer never returns to `payment-callback.html`.
- ☑ Callback and webhook share one settlement path (`settlePayment()` in `server.js`) so they cannot diverge; the authenticated-user check (`PAYMENT_USER_MISMATCH`) stays browser-only, the webhook authenticates via the signed snapshot + Paystack verification. Idempotency unchanged: `GET_LOCK` → existing-order check → UNIQUE `payment_reference` → `ER_DUP_ENTRY` handler. Retry contract: 2xx for handled or permanently unactionable, 5xx only for transient failures. Confirmation email is sent only by the call that created the order.
- ☐ **Not registered with Paystack yet** and not deployed: add the webhook URL in the Paystack dashboard as part of the deployment milestone. No live credentials have been used.
- ☐ Deferred: `payment_events` / payment-issues table for webhook observability (see the item below).

### 3. ☐ CORS restriction
- Currently `cors()` allows every origin. Restrict via a `CORS_ORIGINS` env var (already in `.env.example`); must include the Netlify domain(s) before deploying.

### 4. ☐ Rate limiting and security headers
- Rate limiting for login, register, reviews, admin login. In memory today: forgot-password, resend-verification, ☑ track-order (10 / 15 min per IP) and ☑ password change (5 wrong current-password attempts / 15 min per account) — Milestone 4. In-memory limits reset on restart and aren't shared across Render instances; move to a shared store if scaled.
- Helmet / security headers; CSP must allow the CDNs in use (Google Fonts, Font Awesome, Google Sign-In). Roll out CSP report-only first.

### 5. ☐ Authentication / security review
- JWT strategy (7-day tokens in `localStorage`, no revocation; role changes only apply on expiry).
- ☐ Token revocation / versioning (e.g. `users.token_version` checked in `requireAuth`) so a password change or reset signs out other devices. **Needs a migration — deferred from Milestone 4.**
- ☐ Review the 6-character minimum password length (register, reset and change all use 6).
- ☐ Email change with re-verification of the new address — **out of scope for Milestone 4** (`PATCH /api/me` rejects `email`).
- ☑ Consistent expired-session handling on account pages (`nfAuthFetch`: 401 → clear stored auth → `login.html?redirect=…&expired=1`).
- Google authentication configuration per environment (authorized origins).
- Redirect handling (◐ open redirect fixed locally via `safeRedirectTarget`).
- Production secrets supplied only via Render/Netlify env vars.

---

## High priority

### 6. ☐ Correct production catalog export / import
- Required local end state: **165 active + 3 soft-deleted products**, 2 offers, 2 offer_products.
- Use the read-only `mysqldump` procedure (utf8mb4, `--result-file`, `--single-transaction`, `--complete-insert`) — expected files `neofragrances-catalog-data.sql` and `neofragrances-catalog-schema.sql`.
- Validate before importing (encoding, real NULLs, `deleted_at`, row counts, field comparison vs production snapshot, schema match).
- The older `products-import.sql` / `offers-import.sql` / `offer_products-import.sql` files on the Desktop are the **damaged originals** (quoted `'NULL'` strings, `—` decoded as `ΓÇö`, `deleted_at` as text) — **do not import them**.
- Never manually modify production data.

### 7. ☐ Catalog content quality (production data itself)
- Descriptions: only 1 of 165 products has one.
- Fragrance notes: only 4 products have real notes; 145 use `—`, 15 use literal `???`.
- `Mancera Cedrat Bois??` product name.
- 26 products reference image files that don't exist (incl. `images/perfumes/placeholder.jpg`).
- Brand normalisation: "Dior" vs "Christian Dior".
- Admin "Add Product" defaults a missing image to the non-existent `placeholder.jpg`.

### 8. ☐ Admin-controlled scent-family classification
- No automatic classification — catalog data is insufficient.
- Design an admin-controlled system (proposed: `products.scent_family`, validated list, admin form field). **Requires a migration — not added yet** (an earlier local attempt was reverted on 2026-10-01).
- Storefront already supports display/filtering (`SCENT_FAMILIES` in `js/main.js`); all scent UI stays hidden until real assignments exist.

### 9. ☐ Better / larger, properly licensed product photography
- Product images are 200–800 px lifestyle shots; the original hero photo showed brands not in the catalog and was removed.

### 10. ◐ Remaining `$` → `GH₵` inconsistencies
- ☑ Storefront (account/order pages, `track-order.html`, `payment-callback.html`) and the order email now use GH₵ (Milestone 3).
- ☑ Admin uses `money()` (GH₵); the product form label was corrected to "Price (GH₵)". Re-check during the admin redesign.

---

## Product / customer experience

### 11. ◐ Product discovery (Milestone 2)
- Browser pagination, search, sorting, price filters, availability, category filters, URL-persisted filters, search suggestions, mobile filtering.

### 12. ◐ Homepage (Milestone 1)
- Done locally: premium hero, integrated Special Offers, best sellers / new arrivals, editorial content, real-reviews section (hidden without reviews), animations.
- Pending: scent discovery (depends on #8).

### 13. ☑ Professional About Us page (Milestone 1, local)

### 14. ☑ Professional Contact Us page (Milestone 1, local)
- 0505731824 · Ambitiousn9@icloud.com · WhatsApp `wa.me/233505731824`.

### 15. ◐ Major admin portal redesign and functionality improvements (Milestones 5–6)
- ☑ Stock-reset-on-edit bug fixed and tested locally (`admin/products.html`, `js/admin.js`, `server.js`).
- Milestone 5 decisions (2026-10-02): separate local-only admin created by a script (password typed by the user, never seen/stored by tooling); cancelling an order restocks its items in the same transaction and is final (no reopening); reviews: permanent delete with confirmation + rating/count recalculation (hide/unhide → Milestone 6); low stock = **5 or fewer**, one shared constant.
- Milestone 5 = admin redesign + shared admin architecture (existing schema only). Milestone 6 = admin features that need migrations/packages/storage decisions (incl. #15a).
- ☑ **Milestone 5 done locally (2026-10-02, tested, not deployed):**
  - Backend: `requireAdmin` re-reads the role from the DB on every request; new `GET /api/admin/summary`, `GET /api/admin/reports`, `GET /api/admin/products` (incl. archived + units sold), `PATCH /api/admin/products/:id/restore`, stock `adjust` (atomic, never < 0), filtered/paginated `GET /api/admin/orders`, `GET /api/admin/orders/:id`, cancel = restock + final, `GET /api/admin/customers/:id`, `GET/DELETE /api/admin/reviews`, `PATCH /api/admin/offers/:id/featured`; full validation on product/offer create + edit (image paths restricted to `images/`); 404s for unknown ids.
  - Frontend: new admin shell (`js/admin-core.js`, rewritten `css/admin.css`), dashboard, reports, products (drawer form, archive/restore), inventory (adjustments), orders + `admin/order.html`, customers + `admin/customer.html`, reviews (new), special offers, admin login (fake "Remember me" removed). Old `js/admin.js` removed. Admin pages skip the public catalog download (`<body data-catalog="off">`).
  - `npm run create-local-admin` (server repo, `scripts/create-local-admin.js`): local-only admin creation; refuses production/Render/non-local DB/non-interactive use.
- ☐ Remaining admin items for Milestone 6: image upload (needs a package + external storage — Render disk is ephemeral), bulk operations, multi-product offers UI, coupons admin, review hide/unhide (migration), customer account disable (migration), admin audit log + order status history (migrations), Fragrance Education (#15a).
- ☐ Offer dates are stored as entered (local time strings) and compared with the DB server's `NOW()`; confirm the TiDB/Render timezone matches before deploying (or store UTC).
- ☑ **Offer-expiry regression-testing fixed (2026-10-03, tests only — no production code changed).** `restore-app-verify.js` asserted that the two *restored production* offers were currently live, but those rows carry absolute windows copied from production (offer 1 ends `2026-10-03 17:00:00`, offer 30002 ends `2026-10-03 11:33:00`). Once the calendar passed them the application correctly expired them and **7 assertions went permanently red with no code defect**. Split along the right seam: `restore-app-verify.js` now pins only calendar-independent restoration fidelity (exact stored windows, prices, offer→product links, active flags, and the `offer_products` count), and the time-sensitive behaviour moved to the new `tests/offers-behaviour.js`, which builds its own offers with `NOW() ± INTERVAL` windows (2 throwaway products, 4 offers, 4 join rows, 1 temp admin, all removed afterwards). Offer 30002, offer 1 and every restored row are untouched — the suite asserts that explicitly. Coverage went **up**, not down: it now proves live / expired / scheduled / disabled, the just-before and just-after expiry boundary, mid-flight expiry, `Expired`-beats-`Disabled` precedence, and the negative case that a non-live offer must not discount a product card.
- ☐ **Expiry is implemented in THREE places with three different clocks** (found 2026-10-03; documentation only, no change made): `/api/offers/active` uses SQL `NOW() >= start_at AND NOW() < end_at` (**database** clock), `computeOfferStatus()` uses `now >= end` (**Node process** clock), and `js/main.js` re-filters with `new Date(o.end_at).getTime() > now` (**browser** clock). Locally all three are one machine and agree. In production the app and TiDB are separate hosts — the concern in the item above — and the storefront filter additionally trusts the *customer's device clock*, so a device with a wrong date sees stale or missing sale prices. Decide before deploying whether the browser-side filter should be removed in favour of trusting the server response.
- ☐ Local catalog still has data-quality artefacts from the damaged import (e.g. badge text `"NULL"`, one image path without extension) — fixed only by the faithful re-import (#6), never by hand.

### 15a. ☐ Fragrance Education / Learn content — **approved future requirement (Milestone 6: Admin Features)**
Admin-controlled, database-driven educational content. **Not implemented in Milestone 5; no table is created until Milestone 6 implementation begins.** Never hardcode articles into HTML.
- **Example content:** sillage, projection, longevity, dry down; top / heart (middle) / base notes; EDP, EDT, Parfum / Extrait, EDC; fragrance families (oud, gourmand, woody, fresh, floral, amber, musk); how to apply perfume; how to store perfume; beginner guides; other articles. (Content itself is written/approved by the business — not generated as fact claims about products.)
- **Admin (new "Fragrance Education" section):** create, edit, save as draft, publish / unpublish, delete with confirmation; title, excerpt, main content, category, featured flag, optional cover image; status + last-updated shown; search / filter by status, category, featured.
- **Customer site ("Learn" / Fragrance Guide):** browse published content, filter by category, search terms/articles, article page (e.g. `learn.html`, `article.html?slug=`), featured items where appropriate (e.g. homepage / PDP glossary links). Section hidden when nothing is published.
- **Security:** only authenticated admins (`requireAdmin`) can create/edit/delete/publish; public API returns **published content only** (drafts never exposed, including by slug/id lookup); validate lengths/category/slug; sanitize admin content — store as restricted Markdown or allow-listed HTML and escape/sanitize on render (no script/style/event attributes, safe links only); cover image path restricted like product images (upload depends on the Milestone 6 storage decision).
- **Proposed data model (future migration, not created):**
  - `learn_articles`: `id`, `slug` (UNIQUE), `title` (≤150), `excerpt` (≤300), `content` (MEDIUMTEXT), `category` (validated list, e.g. `terminology`, `concentrations`, `notes`, `families`, `guides`), `cover_image` (nullable), `featured` (bool), `status` (`draft` / `published`), `published_at` (nullable), `created_by` / `updated_by` (users.id), `created_at`, `updated_at`; indexes on (`status`, `category`), (`featured`).
  - Optional later: `learn_categories` table if categories must be admin-editable; product ↔ article links (e.g. notes/family glossary) after the scent-family work (#8).
- **Proposed endpoints:** public `GET /api/learn`, `GET /api/learn/:slug` (published only); admin `GET/POST /api/admin/learn`, `GET/PUT/DELETE /api/admin/learn/:id`, `PATCH /api/admin/learn/:id/status`.

### 16. ◐ Order-page UX / currency improvements
- ☑ Cart/checkout and payment result pages redesigned (Milestone 3).
- ☑ My Orders / order details / account pages (Milestone 4 — see 16c).

### 16b. ☑ Local authentication blockers (fixed locally, 2026-10-02)
- Registration MX check now only rejects a definitive "no mail server" DNS answer; resolver failures are logged and allowed (3 s timeout). On this PC Node's DNS resolves to 127.0.0.1 (phone-hotspot IPv6 DNS), which previously rejected every sign-up.
- `DEV_EMAIL_LOG=true` (local only; ignored when `NODE_ENV=production` or on Render, and only when SendGrid isn't configured) prints verification/reset links to the backend console.
- Google sign-in block (divider/button/terms) hidden unless `GOOGLE_CLIENT_ID` is configured.
- ☑ Local Paystack test key configured; a full local payment completed end-to-end on 2026-10-02 (test order 80, status `Processing` — since removed, with its throwaway account, in the local test-data cleanup).
- ☐ Production: confirm SendGrid is configured on Render so real verification emails send (DEV_EMAIL_LOG is never used there).

### 16a. ☑ Local backend restart
- The local backend (`npm run dev`, node --watch) is serving the current code, including the Milestone 4 endpoints.

### 16c. ◐ Customer account experience (Milestone 4 — done locally, tested, not deployed)
- ☑ Backend: `GET/PATCH /api/me`, `POST /api/me/password`, `PUT/DELETE /api/addresses/:id`, `PATCH /api/addresses/:id/default`, `locked` flag on `GET /api/addresses`, richer `GET /api/my-orders` (product_id, image, availability, delivery address), Google sign-ups record `auth_provider`/`google_id`, track-order rate limited and minimal.
- ☑ `my-account.html` (Overview, Profile, Orders, Addresses, Wishlist, Security), `order.html?id=` order details page, restyled Track Order, auth page polish (fake "Remember me" removed; session-expired notice).
- ☑ `my-orders.html` / `wishlist.html` are now redirects into My Account; `js/my-orders.js` and `css/my-orders.css` removed.
- ☐ Orders reference live address rows (`orders.address_id` → `ON DELETE SET NULL`). Addresses used by an order are therefore locked (no edit/delete). Proper fix: snapshot the delivery address onto the order (and/or soft-delete addresses). **Needs a migration.**
- ☐ Orders store only the total paid; the order page shows items subtotal plus one "Shipping, discounts & adjustments" line. Storing subtotal/discount/shipping/offer savings per order needs a migration (see #2).
- ☐ Order status timeline has no per-status timestamps (only the order date); a status-history table would allow real dates per step.
- ☐ Reviews: prevent duplicate reviews per product/user and mark verified-purchase reviews.

---

## Final quality

### 17. ☐ Accessibility
### 18. ☐ Performance optimisation
- Every storefront page currently fetches the full product list via `main.js`, including pages that don't need it. ☑ Admin pages opt out (`data-catalog="off"`); the same opt-out can be applied to storefront pages that don't use the catalog.
### 19. ☐ Full browser / console / API / link audit
### 20. ☐ Final deployment-readiness audit
- Netlify + Render + TiDB + Paystack + Google + SendGrid + environment variables + migrations.
- Document production env vars and any Netlify/Render settings in the repos.

---

## Migrations required before/at deployment
- Migration files live in `neofragrances-server/migrations/` (numbered, plain portable SQL — MariaDB 10.4 local + TiDB production).
- ☑ **001_orders_payment_reference_unique.sql** — UNIQUE `orders.payment_reference` (#2). Applied to the LOCAL database 2026-10-02; **applied and verified in production — complete.** Migrations 002–006 remain local only. NULL references stay legal (NULLs are distinct in a UNIQUE index on MariaDB/MySQL/TiDB).
- ☐ **002_coupons_active.sql** — `coupons.active` flag, the coupon active/inactive state the admin coupon feature needs (#15, Milestone 6). Applied to the LOCAL database 2026-10-03; **local only — production application still pending.**
- ☐ **003_app_settings.sql** — `app_settings` key/value table, the persistent runtime settings behind Maintenance Mode (#15, Milestone 6 Phase 2). Applied to the LOCAL database only; **production application still pending.**
- ☐ **004_reviews_hidden.sql** — `reviews.hidden` review-moderation flag (hide/unhide) (#15, Milestone 6 Phase 3). Applied to the LOCAL database 2026-10-04; **local only — production application still pending.**
- ☐ **005_account_controls.sql** — Account Controls columns `users.disabled_at`, `users.disabled_reason`, `users.token_version` (#15, Milestone 6 Phase 4). Applied to the LOCAL database 2026-10-07; **local only — production application still pending.**
- ☐ **006_order_status_history.sql** — `order_status_history` table: durable order status history recording every admin status transition (who, when, note), plus a backfill writing one honest baseline row per existing order ("Status tracking began" — current status only, nothing invented); backs the customer and admin order-history views (#15 / 16c, Milestone 6 Phase 5). Applied to the LOCAL database 2026-10-08; **local only — production application still pending.** Must be applied **before** the Phase 5 server/frontend release is deployed (the admin status change and order pages need the table). Not yet cleared for production: the production TiDB version check is still open (TiDB enforces foreign keys only from v6.6; see the file's release checklist).
- Remaining candidates: `products.scent_family` (#8), order subtotal/discount/shipping fields (#2), payment-issues table (#2), order delivery-address snapshot / address soft delete (16c), `learn_articles` (#15a, Milestone 6). Milestone 4 used existing columns only (`users.auth_provider`, `users.google_id`).

## New production environment variables (document in Render)
- `PAYMENT_SIGNING_SECRET` — set locally; **still required in Render** (falls back to `JWT_SECRET` when unset). `PAYSTACK_API_BASE` must be left unset in production.
