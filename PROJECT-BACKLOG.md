# NeoFragrances — Project Backlog

## 1. Project overview

Master backlog for the rebuild. Covers both repositories:

- `neofragrances-frontend` — static storefront + admin portal (Netlify).
- `neofragrances-server` — Express 5 API + MariaDB/TiDB (Render, TiDB Cloud). This file lives here.

**Last updated: 2026-11-14**, from the read-only project audit of 14 November 2026. Every status below
cites the evidence that audit found (commit, file:line, test name and result, or database query). Where the
evidence was not sufficient, the task says **NEEDS VERIFICATION** rather than guessing. The previous version
of this file (last edited 2026-10-02, commit `4cc0ef6`) is summarised in the archive at the end.

---

## 2. Current deployment position

| | Frontend | Backend |
|---|---|---|
| **Rebuild (all work below)** | `rebuild` remote, branch `feature/neofragrances-project-baseline` @ `8234289` (2026-11-14) | `rebuild` remote, branch `feature/neofragrances-project-baseline` @ `660176a` (2026-11-14) |
| **Production (what Netlify / Render deploy)** | `origin/main` @ `d673a6c` (2026-09-30) | `origin/main` @ `ec3f18b` (2026-09-30) |
| Rebuild commits not on `origin/main` | 8 | 15 |
| Remotes | `origin` = github.com/Ambitiousn9/neofragrances-frontend · `rebuild` = github.com/Ambitiousn9/NeoFragrances-frontend-rebuild- | `origin` = github.com/Ambitiousn9/neofragrances-server · `rebuild` = github.com/Ambitiousn9/Neofragrances-Backend- |

- **Production has none of the rebuild work** and only **migration 001** (see the ledger, section 5).
- There is **no staging environment**.
- There is no `netlify.toml` or `render.yaml` in either repository, so hosting settings live only in the
  Netlify and Render dashboards.
- Local development runs against MariaDB on `127.0.0.1:3308`. The old XAMPP datadir on 3306 is frozen and must never be started.
  Procedure: `C:\Users\Ambitous\NeoFragrances-DB-Validation\RUNBOOK-LOCAL-DEV-3308.md` (outside both repos).
- **Local email:** email verification works locally, but **no real email is delivered**.
  - `.env` has `DEV_EMAIL_LOG=true` and SendGrid is not configured locally, so verification and reset links
    are printed to the API console (`mailer.js:34–66`; the API logs "DEV_EMAIL_LOG is ON: verification/reset
    links are printed to this console, not emailed.").
  - `DEV_EMAIL_LOG` is ignored in production, which needs SendGrid configured (P7.2). Owner-confirmed 2026-11-14.

---

## 3. Status and environment definitions

**Task status** (exactly one per task):

| Status | Meaning |
|---|---|
| **COMPLETE** | Implemented and supported by verification evidence. |
| **PARTIALLY COMPLETE** | Some work exists, but requirements remain. |
| **IN PROGRESS** | Actively being worked on now. |
| **NOT STARTED** | No implementation evidence. |
| **BLOCKED** | Cannot proceed because of a named dependency. |
| **NEEDS VERIFICATION** | Implementation may exist, but the evidence is insufficient. |

**Environment** (where the work exists — always stated next to COMPLETE):

| Environment | Meaning |
|---|---|
| **Local** | Implemented and verified on the development machine; pushed to the `rebuild` remotes at most. |
| **Staging** | Deployed to and verified on a staging environment. *(None exists yet.)* |
| **Production** | Deployed to and verified on the live Netlify / Render / TiDB services. |

A task marked **COMPLETE (Local)** is **not** production-ready. Nothing in this backlog is COMPLETE
(Staging) or COMPLETE (Production) except migration 001 and the original pre-rebuild site.

---

## 4. Roadmap — the original nine phases

Task format: **ID — Title** · *Status (Environment)*, then Required / Exists / Remains / Evidence /
Dependencies & risks / Next action.

### Phase 0 — Preserve and stabilise
*Objective: make sure no work or data can be lost, and that the local environment is safe to use.*

**P0.1 — Commit and push all rebuild work** · *COMPLETE (Local → `rebuild` remotes)*
- Required: every change committed and on GitHub, without touching `origin`.
- Exists: both working trees clean; both `rebuild` remotes at the commits in section 2.
- Remains: nothing for preservation. Getting this work to production is P6.6.
- Evidence: frontend `8234289`, backend `660176a`; `origin/main` unchanged (`d673a6c`, `ec3f18b`).
- Dependencies & risks: none.
- Next action: none.

**P0.2 — Preservation copies, git bundles and database backups** · *COMPLETE (Local — same disk)*
- Required: verified copies of both repositories and of the 3306 and 3308 datadirs, plus logical dumps that
  restore correctly.
- Exists:
  - working-tree copies (0B-1) and full-history git bundles (0B-1B), in `C:\Users\Ambitous\NeoFragrances-Repo-Preservation\`;
  - cold copies of the 3308 and 3306 datadirs (0B-4, 0B-5), plus 3308 logical dumps (0B-8) that were
    restore-tested into a scratch instance (0B-8b), all in `C:\Users\Ambitous\NeoFragrances-DB-Backups\`.
- Remains: nothing for the copies themselves. **All of them are on the single C: drive** (see P0.3).
- Evidence: manifests and SHA-256 files in each folder, all hashes verified; restore-test re-dumps identical.
- Dependencies & risks: a single-disk failure loses every copy.
- Next action: P0.3.

**P0.3 — Off-machine copy of the database backups** · *NOT STARTED*
- Required: a copy of the database backup folders somewhere other than this PC's only disk.
- Exists: code is off-machine (GitHub). Database backups are not.
- Remains: choose a destination; copy; verify hashes there.
- Evidence: P0.2 folders all on `C:`.
- Dependencies & risks: owner chooses the destination (see section 7). The backups include personal data
  from the catalogue and customer tables, so the destination must be private.
- Next action: owner decision, then copy with hash verification.

**P0.4 — Protect the frozen 3306 database** · *COMPLETE (Local)*
- Required: the damaged XAMPP datadir on 3306 must never be started again.
- Exists:
  - the XAMPP Control Panel's MySQL module is disabled (0B-10, `xampp-control.ini` hash `fd2f3877…`);
  - the runbook forbids starting 3306, `mysql_start.bat`, aria repair and `innodb_force_recovery`.
- Remains: discipline. On 2026-11-14 the XAMPP panel was opened (MySQL not started), and a guarded test
  run correctly refused to start until it was quit from the tray.
- Evidence: 0B-10; every guarded run since reports "frozen 3306 datadir files written: 0 of 273".
- Dependencies & risks: the panel minimises to the tray when closed, so it must be **quit**.
- Next action: keep the runbook rule.

**P0.5 — Local database on 3308 and the start/stop runbook** · *COMPLETE (Local)*
- Required: one documented, safe way to start, verify and stop the local database and API.
- Exists:
  - backend `.env` has `DB_PORT=3308` (0B-9);
  - `RUNBOOK-LOCAL-DEV-3308.md` (pinned launcher hashes, identity checks, clean shutdown).
- Remains: move or copy the runbook into the backend repo (P6.4).
- Evidence: 0B-9, 0B-11; every guarded run on 2026-11-14 started and stopped 3308 cleanly.
- Dependencies & risks: the runbook lives outside the repos.
- Next action: P6.4.

**P0.6 — Local LAN / iPhone development access** · *PARTIALLY COMPLETE (Local)*
- Required: the site, opened from another device on the same network (e.g. `http://172.20.10.3:5500`),
  loads products and offers.
- Exists:
  - the frontend routes private-LAN hosts to `http://<LAN-IP>:5000` (`js/main.js:29–40`, commit `b583c9c`);
  - runbook §2.7 documents starting the API with `CORS_ORIGINS='http://<LAN-IP>:5500'`;
  - **the API is currently running with the LAN origin allowed** (restarted 2026-11-14 09:19, after the diagnosis).
- Remains:
  - confirm in a browser, on the laptop and on the iPhone, that products and offers display (the API side is
    verified; the page-level check has not been recorded);
  - the API must be restarted with `CORS_ORIGINS` in each new session, and the LAN IP changes with the network;
  - checkout cannot complete on a phone, because Paystack callbacks and email links use `FRONTEND_URL`
    (127.0.0.1); see P2.6.
- Evidence:
  - diagnosis (2026-11-14 morning): the CORS allowlist (`server.js:58–74`) is `CORS_ORIGINS` + `FRONTEND_URL`
    + `http://127.0.0.1:5500` and `http://localhost:5500` outside production. The API then running answered
    `Origin: http://172.20.10.3:5500` with 200 but no `Access-Control-Allow-Origin`.
  - **latest confirmed check (2026-11-14 11:43, read-only):**
    - the API process started at 09:19:21;
    - `GET /api/health` → 200 `{"status":"ok","database":"ok"}` on both `127.0.0.1:5000` and `172.20.10.3:5000`;
    - `Origin: http://172.20.10.3:5500` and `http://127.0.0.1:5500` both receive `Access-Control-Allow-Origin`;
      `http://evil.example` does not;
    - the API holds 6 connections to 3308 and none to 3306.
- Dependencies & risks: never widen CORS to `*`; the setting is per session unless added to `.env`.
- Next action: browser check on laptop and iPhone. Optionally add a `CORS_ORIGINS` line to `.env` (owner decision).

### Phase 1 — Backend security and reliability
*Objective: close the security and correctness gaps found by the audits before anything is deployed.*

**P1.1 — G-1: password change/reset ends existing sessions** · *COMPLETE (Local)*
- Required: changing or resetting a password invalidates every other token for that account.
- Exists:
  - `/api/me/password` and `/api/reset-password` bump `token_version` in a locked transaction and seed the account cache;
  - a reset link is single-use;
  - the account page keeps its own session by adopting the new token.
- Remains: production needs migration 005 (`users.token_version`).
- Evidence: backend `77f01b4`, frontend `03262ee`. Tests: password-session-tests 33/33 (2026-11-13), account-api-tests
  50/50 and account-e2e 61/61 (guarded, 2026-11-13).
- Dependencies & risks: migration 005 in production.
- Next action: Phase 5.

**P1.2 — G-6 / G-7: startup configuration checks and JSON error responses** · *COMPLETE (Local)*
- Required:
  - refuse to start with an unsafe configuration;
  - never send HTML stack traces.
- Exists:
  - `config-check.js`:
    - `JWT_SECRET` is always required;
    - in production, `JWT_SECRET` must be 32+ characters, and `PAYMENT_SIGNING_SECRET` must be set, 32+ characters and different from it;
    - on Render, `NODE_ENV` must be `production`;
  - a final JSON error handler in `server.js`.
- Remains: the Render environment must satisfy these rules (P7.2).
- Evidence: `2751520`. Tests: startup-config-tests 46/46, platform-tests 19/19 (guarded, 2026-11-14),
  security-headers-tests 43/43.
- Dependencies & risks: a Render deploy without these variables will refuse to start (by design).
- Next action: P7.2.

**P1.3 — G-2: storefront security headers and CSP** · *PARTIALLY COMPLETE (Local)*
- Required: a strict CSP (hashed inline scripts, no `unsafe-inline` scripts) and security headers on every
  storefront page, without breaking the admin rule.
- Exists:
  - `_headers` has 50 exact storefront path rules plus asset rules; the `/admin/*` rule is unchanged;
  - inline handlers have been replaced by listeners;
  - the maintenance-page hash was updated for R4.
- Remains: **verification on Netlify** (it has only been verified locally).
- Evidence: frontend `bac4433`, `8234289`. Headless Edge: 50/50 paths, 0 CSP violations (local). Tests:
  storefront-security-headers-tests 34/34, admin-security-headers-tests 29/29.
- Dependencies & risks: Netlify deploy preview (P7.1). Any edit to an inline `<script>` changes its hash; the
  storefront test prints the new hash.
- Next action: P7.1.

**P1.4 — T08: two-decimal price and coupon validation** · *COMPLETE (Local)*
- Required: valid prices such as 289.15 are accepted (floating-point bug, audit E5).
- Exists: the shared `hasAtMost2dp` in `pricing.js`, used by the product, coupon and offer validators.
- Remains: nothing.
- Evidence: `e45479b`. Tests: money-validation-tests 11/11; admin-api-tests 112/112 (guarded, 2026-11-14).
- Dependencies & risks: none.
- Next action: none.

**P1.5 — CORS restriction (old backlog #3)** · *COMPLETE (Local)*
- Required: an explicit origin allowlist, never `*`.
- Exists: `server.js:53–74` (`CORS_ORIGINS`, `FRONTEND_URL`, dev origins only outside production).
- Remains: production must set `CORS_ORIGINS` and/or `FRONTEND_URL` to the Netlify origin (P7.2).
- Evidence: code; security-headers-tests I5/I6/I21 (CORS kept on success, refusal, 429).
- Dependencies & risks: a wrong production origin would block the whole storefront.
- Next action: P7.2.

**P1.6 — Rate limiting and API security headers (old backlog #4)** · *COMPLETE (Local)*
- Required: login and registration rate limits, plus API security headers.
- Exists: `rate-limit.js` (login Tier A/B, registration 10 per IP per hour, track-order, password change);
  `security-headers.js`.
- Remains: behaviour behind Render's proxy is unverified (P1.13).
- Evidence: `622ed9a`, `b5623b5`. Tests: auth-rate-limit-tests 51/51 (README date 2026-10-17; re-run 51/51
  on 2026-11-14), security-headers-tests 43/43.
- Dependencies & risks: limits are in memory per process (P1.13).
- Next action: P1.13 at staging.

**P1.7 — Payment hardening, webhook and payment-issue register** · *COMPLETE (Local)*
- Required:
  - server-side pricing;
  - verified amount, currency and reference;
  - one settlement path;
  - idempotency;
  - a durable record of payments that could not be settled.
- Exists:
  - `pricing.js` (integer pesewas);
  - HMAC-signed order snapshot;
  - `settlePayment()` shared by callback and webhook;
  - `GET_LOCK` plus the unique `payment_reference` (001);
  - `POST /api/payments/webhook` (HMAC-SHA512 over the raw body);
  - `payment-issues.js` plus admin page `admin/payment-issues.html`.
- Remains:
  - **the webhook is not registered with Paystack** (P7.3);
  - TiDB support for `GET_LOCK` is unverified (P5.2);
  - migration 009 is needed in production.
- Evidence: `c0240e9`, `4db3db6`. Tests: payment-reliability-tests 71/71 (2026-11-14), payment-issues-tests
  84/84.
- Dependencies & risks: P5.2, P7.3.
- Next action: Phase 5 and Phase 7.

**P1.8 — Delivery address required to start payment** · *COMPLETE (Local)*
- Required: `/api/payments/initialize` refuses a missing or invalid address before pricing or Paystack.
- Exists: 400 `ADDRESS_REQUIRED` / `INVALID_ADDRESS` (2026-10-30).
- Remains: `tests/README.md` still shows payment-tests at 68/68 (P2.4).
- Evidence: session notes record payment-tests 74/74 (guarded, 2026-10-30), and the DB-free suites
  passing after the change. The README row has not been updated.
- Dependencies & risks: none.
- Next action: P2.4.

**P1.9 — Maintenance mode (guard, admin configuration, public page)** · *COMPLETE (Local)*
- Required:
  - admin ON/OFF, progress 0–100 and a message, saved atomically;
  - a safe public status endpoint;
  - fail-open behaviour;
  - admin bypass, plus login, payment-verification and webhook exceptions.
- Exists:
  - `settings.js`, `POST /api/admin/maintenance`, `admin/maintenance.html`, `maintenance.html`;
  - Phase 2 fixes:
    - a mixed-case `/API/…` path no longer bypasses the guard;
    - `HEAD /api/health` is now bypassed (R3);
    - the maintenance page returns a redirected customer to their page when maintenance ends (R4).
- Remains: production needs migration 003; the new maintenance-page CSP hash must be verified on Netlify.
- Evidence: backend `1143177`, `afbbe8a`, `660176a`; frontend `8234289`. Tests:
  - maintenance-tests 85/85 (guarded, 2026-11-14);
  - maintenance-guard-tests 22/22;
  - frontend maintenance-page-tests 22/22;
  - admin-maintenance-tests 30/30;
  - R4 real-browser check under the real CSP 8/8 (scratch tool, local).
- Dependencies & risks: migration 003 (P5.1); P7.1.
- Next action: Phase 5.

**P1.10 — Token revocation and admin session controls (old backlog #5 item)** · *COMPLETE (Local)*
- Required: role changes and logouts take effect without waiting for token expiry.
- Exists:
  - `users.token_version` (migration 005), checked on every request;
  - admin tokens last 12 hours;
  - `POST /api/admin/logout` revokes the account's tokens;
  - `requireAdmin` re-reads the role from the database.
- Remains: migration 005 in production.
- Evidence: admin-session-tests 23/23; account-controls-tests 87/87 (guarded, 2026-11-13).
- Dependencies & risks: P5.1.
- Next action: Phase 5.

**P1.11 — G-8: normalise email at registration and login** · *NOT STARTED*
- Required: emails trimmed and lower-cased consistently on every path.
- Exists: only the Google sign-in path normalises (`server.js:464`).
- Remains: `/api/register` stores the email as typed (`server.js:323–345`); login needs to match the same way.
- Evidence: code reading, 2026-11-14 audit.
- Dependencies & risks: existing accounts with mixed-case emails need a duplicate check before changing lookups.
- Next action: small fix plus a check for existing duplicates (read-only first).

**P1.12 — G-9: raise the minimum password length** · *NOT STARTED*
- Required: a minimum of 8 or more characters, applied the same way at registration, reset and change, on frontend and backend.
- Exists: 6 characters (`server.js:328`, `:2244`).
- Remains: the change on both sides, plus tests.
- Evidence: code reading, 2026-11-14.
- Dependencies & risks: messages and validation in `js/validation.js` and the account pages.
- Next action: owner confirms the new minimum.

**P1.13 — G-4: rate limits and `trust proxy` behind Render** · *NEEDS VERIFICATION*
- Required: client IPs are read correctly behind Render's proxy; limits behave on the real host.
- Exists: `app.set("trust proxy", 1)` (`server.js:45`); in-memory limiters.
- Remains: verify the hop count on Render. Limits are not shared across instances.
- Evidence: none on Render (no staging).
- Dependencies & risks: P7.
- Next action: test on staging.

**P1.14 — G-5: account-status cache fails open when the database is down** · *NOT STARTED*
- Required: a deliberate, documented choice.
- Exists: `accounts.js` fails open (a revoked token may pass briefly during an outage).
- Remains: decide whether to accept and document, or fail closed for some routes.
- Evidence: audit G-5.
- Dependencies & risks: failing closed turns a database blip into an outage.
- Next action: owner decision.

**P1.15 — G-10: registration reveals whether an email has an account** · *NOT STARTED*
- Required: a deliberate choice about account enumeration.
- Exists: `/api/register` returns 409 "An account with this email already exists." (`server.js:340`).
- Remains: accept it, or make the response generic.
- Evidence: code reading, 2026-11-14.
- Dependencies & risks: a generic response worsens the experience for real users.
- Next action: owner decision.

**P1.16 — Offer expiry is evaluated by three different clocks** · *NOT STARTED*
- Required: one authority for whether an offer is live.
- Exists:
  - SQL `NOW()` in `/api/offers/active` (database clock);
  - `computeOfferStatus()` (`server.js:2877`, Node clock);
  - a browser re-filter in `js/main.js:148` (the customer's device clock).
- Remains: decide whether to remove the browser filter and trust the server's response.
- Evidence: found 2026-10-03; re-confirmed in code 2026-11-14.
- Dependencies & risks: a customer device with a wrong date sees stale or missing sale prices.
- Next action: owner decision, then a small fix.

**P1.17 — Production database reliability (old backlog #1)** · *NEEDS VERIFICATION*
- Required: understand the HTTP 500s that production database endpoints returned on 2026-10-01.
- Exists: they recovered without any change; the root cause is unconfirmed. `GET /api/health` (`SELECT 1`) exists.
- Remains: check Render logs and TiDB events, connection limits and spending limits; consider pool keep-alive and an uptime monitor.
- Evidence: old backlog #1.
- Dependencies & risks: access to the Render and TiDB consoles.
- Next action: inspect at staging or production readiness (P8.4).

**P1.18 — Order breakdown and delivery-address snapshot** · *NOT STARTED*
- Required: store subtotal, discount and shipping per order; snapshot the delivery address on the order.
- Exists: orders store only the total paid and reference live address rows (addresses used by orders are locked).
- Remains: decide whether it is needed for launch; then migrations.
- Evidence: old backlog #2 and 16c.
- Dependencies & risks: new migrations (010+); production data backfill.
- Next action: owner decision.

**P1.19 — Duplicate-review prevention and verified-purchase marking** · *NEEDS VERIFICATION*
- Required: one review per customer per product; verified-purchase reviews marked.
- Exists: `reviews.is_verified_purchase` is used by admin-api-tests fixtures. Uniqueness was not checked in the 2026-11-14 audit.
- Remains: inspect the review endpoints and schema.
- Evidence: insufficient.
- Dependencies & risks: a uniqueness constraint needs a migration and a production duplicate check.
- Next action: read-only inspection.

**P1.20 — Email change with re-verification** · *NOT STARTED*
- Required: customers can change their email, with the new address verified.
- Exists: `PATCH /api/me` rejects `email` (out of scope since Milestone 4).
- Remains: design and implementation, if wanted for launch.
- Evidence: old backlog #5.
- Dependencies & risks: SendGrid in production (P7.2).
- Next action: owner decision (likely post-launch).

### Phase 2 — Testing and regression
*Objective: a trustworthy, isolated regression suite, run in full before every release.*

**P2.1 — Isolated test-database guard (T04)** · *COMPLETE (Local)*
- Required: no database-backed suite can touch the working database.
- Exists:
  - all 17 database-backed suites refuse to run without the guard (`NF_TEST_MODE=isolated`, `nf_test_*`, 127.0.0.1:3308);
  - a plain run refuses before loading `.env` or `db.js`.
- Remains: nothing.
- Evidence: `0d3d706`, `98bbaa5`. Full guarded pass 817/817 on `nf_test_phase1_20261029` (2026-11-13);
  isolated-db-guard-tests 29/29.
- Dependencies & risks: none.
- Next action: none.

**P2.2 — Full regression after the 2026-11-13 → 11-14 changes** · *NOT STARTED*
- Required: every suite run once against the current code.
- Exists:
  - **last full guarded regression: 2026-11-13** (817/817);
  - since then, T08, G-2, the maintenance fixes, R3 and R4 landed;
  - only admin-api-tests 112/112, maintenance-tests 85/85, the nine database-free suites and the six frontend suites were re-run.
- Remains: a complete guarded pass of all 17 database-backed suites, one at a time.
- Evidence: `tests/README.md` rows; section 8 of this file.
- Dependencies & risks: the machine has little free RAM; run suites one at a time per the runbook.
- Next action: owner approval for one full guarded pass.

**P2.3 — `e2e-checkout.js` positive run** · *NEEDS VERIFICATION*
- Required: a full browser checkout end to end against the current harness.
- Exists: the harness and refusal checks (Group 1, all passing 2026-10-24).
- Remains: a positive run. The README says it was "not run against the current harness"; the last recorded
  result, 26/29 (2026-10-30), predates the address-validation change.
- Evidence: `tests/README.md`; session notes.
- Dependencies & risks: separate approval; uses the Paystack test key.
- Next action: owner approval.

**P2.4 — Stale rows in `tests/README.md`** · *PARTIALLY COMPLETE*
- Required: every suite row shows its latest result.
- Exists: most rows were updated on 2026-11-13 and 11-14.
- Remains:
  - payment-tests shows 68/68 (session notes: 74/74 on 10-30);
  - payment-reliability-tests shows 66/66 (actual 71/71, 2026-11-14);
  - auth-rate-limit-tests is dated 2026-10-17.
- Evidence: 2026-11-14 audit.
- Dependencies & risks: none.
- Next action: a documentation pass (separate approval; this task only changes PROJECT-BACKLOG.md).

**P2.5 — Staging and Netlify tests** · *BLOCKED*
- Required: header, CORS, OAuth, webhook and time-zone checks on a real deployment.
- Exists: nothing.
- Remains: everything.
- Evidence: there is no staging environment.
- Dependencies & risks: P7.
- Next action: after P7.1/P7.2.

**P2.6 — QA-001: Paystack test checkout completed, but the callback page did not appear** · *NEEDS VERIFICATION*
- Required: after a Paystack test payment, the customer returns to `payment-callback.html` and sees the result
  of their order.
- Exists:
  - Paystack's return address is built from `FRONTEND_URL` (`server.js:2456`), which is
    `http://127.0.0.1:5500` locally;
  - `payment-callback.html` exists and is exempt from the maintenance redirect (P1.9).
- Remains:
  - reproduce it and record the device and address the checkout was started from, the URL Paystack returned
    to, and whether an order (or a payment issue) was created for that reference;
  - find the root cause and fix it.
  - **Not yet confirmed (hypothesis only):** if the checkout was started from another device or address
    (e.g. the iPhone on `http://172.20.10.3:5500`), Paystack returns the browser to `127.0.0.1:5500`, which that
    device cannot reach. Runbook §2.7 already notes that checkout cannot complete on a phone.
- Evidence: reported by the owner on 2026-11-14; `server.js:2456`; `.env` `FRONTEND_URL=http://127.0.0.1:5500`.
- Dependencies & risks:
  - **locally the Paystack webhook is not registered (P7.3)**, so the browser callback is the only local path that
    settles a payment. If the callback never ran, a paid test transaction may have no local order;
  - P0.6; P2.3; P8.5.
- Next action: owner states how the test was run, then a read-only check of `orders` / `payment_issues` for that
  reference, then a reproduction from `http://127.0.0.1:5500` on the laptop (separate approval).

### Phase 3 — Storefront improvements
*Objective: a complete, honest, accessible storefront and admin experience.*

**P3.1 — Fragrance Education: integrate `learn.html` into the storefront** · *PARTIALLY COMPLETE (Local)*
- Required: customers can find and use the Fragrance Guide from the storefront; product pages link to
  relevant guide terms; the guide covers maceration.
- Exists:
  - `learn.html` (542 lines, approved British-English copy, sections: notes, concentrations, families,
    wear-care, glossary);
  - `css/learn.css` (313 lines);
  - licensed images in `images/guide/` with `CREDITS.md`;
  - committed since `4632f0d` (also `18403c2`).
- Remains:
  - **links from the storefront nav, footer and mobile drawer: none exist** (no other page references `learn.html`);
  - **glossary links from product pages: none exist**;
  - **maceration section: not present** (zero mentions in `learn.html`);
  - a browser and CSP check after integration (the `learn.html` inline-script hash is in `_headers`).
- Evidence: 2026-11-14 grep across all pages and JS (0 references); `learn.html` content check.
- Dependencies & risks:
  - approved maceration copy (section 7);
  - nav label and placement decision;
  - any edit to the inline script needs a new CSP hash.
- Next action: owner approves placement and maceration copy, then implement.
- **Not complete. Do not mark it complete until it is linked, checked and the maceration section is added.**

**P3.2 — Fragrance Education CMS (old backlog 15a)** · *NOT STARTED (deferred, not cancelled)*
- Required: admin-managed, database-driven articles (draft/publish, categories, featured, sanitised
  content); public API returning published content only.
- Exists: nothing in the backend (no routes, no table). The static page (P3.1) was the approved first release (2026-10-09).
- Remains: everything:
  - proposed table `learn_articles` (id, slug UNIQUE, title ≤150, excerpt ≤300, content MEDIUMTEXT,
    category, cover_image, featured, status draft/published, published_at, created_by/updated_by,
    timestamps; indexes on (status, category) and (featured));
  - endpoints `GET /api/learn`, `GET /api/learn/:slug`, and admin `/api/admin/learn` CRUD plus status.
- Evidence: `server.js` has no learn routes; there is no migration for it.
- Dependencies & risks: a new migration; content sanitising; the image-storage decision.
- Next action: post-launch unless the owner decides otherwise.

**P3.3 — Whole-site dark mode (storefront and admin)** · *NOT STARTED*
- Required:
  - a light/dark theme across the **entire storefront and the admin dashboard**;
  - a user-accessible toggle;
  - consistent behaviour in both areas (same preference, same tokens, no flash of the wrong theme);
  - contrast meeting WCAG AA in both themes.
- Exists: **no theme implementation anywhere**: no `prefers-color-scheme`, no `data-theme`, no toggle, no
  stored preference. Foundation:
  - one shared `css/tokens.css` (77 custom properties) loaded by all 38 real pages, storefront and admin
    (the 2 others are redirect stubs).
- Remains:
  - **colours outside tokens:** about 128 hex and 163 `rgba` values bypass the tokens, mostly in `style.css`,
    `admin.css`, `home.css`, `layout.css` and `maintenance.css`. Convert them to tokens.
  - **theme mechanism:** define dark values; add the toggle (storefront header and admin shell); persist the
    choice and respect the system preference.
  - **assets and accessibility:** handle images, the bottle-SVG fallback, focus rings and charts; check contrast.
  - **CSP:** a no-flash theme script in `<head>` would need a new CSP hash on every page, or must load as a
    file before CSS.
- Evidence: 2026-11-14 grep of all CSS, HTML and JS; per-file colour counts.
- Dependencies & risks:
  - design decision (palette, toggle placement, default);
  - G-2 CSP (P1.3);
  - large surface for visual regressions.
- Next action: owner design decision, then a token-mapping plan covering storefront and admin together.

**P3.4 — Product-details page shows `???` notes** · *NOT STARTED*
- Required: placeholder notes are never shown as if they were real.
- Exists: the notes check excludes only `—` (`product-details.html:116–117`), so the 15 products with `???` notes
  render "built around ???" copy and `???` note cards.
- Remains: treat `???` (and empty values) as missing.
- Evidence: code; read-only `SELECT` (2026-11-14): 15 active products have `???` notes.
- Dependencies & risks: none.
- Next action: small fix (needs approval).

**P3.5 — Generated product descriptions are not verified information** · *NOT STARTED*
- Required: no invented product claims on the product page.
- Exists: when a product has no description (164 of 166 active), the page generates one
  (`product-details.html:118–122`). It says "A distinctive … fragrance from …, crafted for lasting impact and
  everyday sophistication." or, from notes, "… Long-lasting and instantly recognizable.". **This generated text is not verified product information.**
- Remains: decide what to show instead (nothing, a neutral line, or owner-written copy).
- Evidence: code; `SELECT`: 2 of 166 active products have descriptions.
- Dependencies & risks: conflicts with the project's no-fabrication rule.
- Next action: owner decision.

**P3.6 — Missing product images** · *BLOCKED (owner photos)*
- Required: every active product has a real, licensed image.
- Exists:
  - **25 active products point at image files that do not exist**: 20 use `images/perfumes/placeholder.jpg`
    (120003, 120004, 120036–120039, 180002–180004, 210002–210011, 240003); the others are 120011
    `Ish Al Shuyukh Silver.png`, 120013 `Atheeri` (no extension), 120016 `Art of universe.png`,
    120020 `Fire on Ice.png`, 120024 `Haya.png`;
  - **#270038 has no image path**;
  - all 26 fall back to the bottle SVG;
  - `product_images` has 0 rows;
  - case-only renames (`Ameer Al Oud Intense.png`, `Love In Paris.png`, `mawah.JPG`) are correct in git and on disk.
- Remains:
  - owner-supplied photos;
  - two proposed database path fixes awaiting review (#120013 → `images/perfumes/Atheeri.png`,
    #240003 → `images/perfumes/Tropical Vibe.png`);
  - admin "Add Product" defaulting a missing image to the non-existent `placeholder.jpg` (old backlog #7)
    still needs verification.
- Evidence: read-only `SELECT` plus a file-existence check (2026-11-14).
- Dependencies & risks: owner photos and licensing (P3.7).
- Next action: owner supplies photos; approve or reject the two path fixes.

**P3.7 — Photo licensing** · *NEEDS VERIFICATION*
- Required: every image used is licensed for this site.
- Exists: guide images have Unsplash-licence evidence (`images/guide/CREDITS.md`).
  `images/hero/hero-banner.jpg` is owner-supplied, shows other brands' bottles and has no licence record.
- Remains: owner confirmation for the hero image and the product photos.
- Evidence: 2026-10-13 notes; `CREDITS.md`.
- Dependencies & risks: legal exposure.
- Next action: owner confirmation.

**P3.8 — Shop by Scent Family** · *COMPLETE (Local)*
- Required: four primary families (floral, amber, fresh, woody), admin-controlled classification, an honest
  empty state, and no mechanical auto-classification.
- Exists:
  - `products.scent_family` (migration 008);
  - admin page `admin/scent-families.html` and bulk endpoint;
  - storefront family cards and filters;
  - 32 products classified: amber 10, woody 9, fresh 7, floral 6, which meets the launch rule of 5 or more per family.
- Remains: migration 008 plus the classification data in production (P5.5); classification of the remaining
  products (P4.4).
- Evidence: scent-family-tests 77/77, scent-family-admin-e2e 47/47, scent-family-storefront-e2e 62/62
  (guarded, 2026-11-13); `SELECT` counts 2026-11-14.
- Dependencies & risks: P5.1, P5.5.
- Next action: Phase 5.

**P3.9 — Homepage, About, Contact, account pages, storefront polish** · *COMPLETE (Local)*
- Required: the Milestone 1, 3 and 4 storefront work, plus footer, toast and cart-reliability polish.
- Exists: the redesigned homepage (owner rule: enhance, never redesign or add sections without asking), About,
  Contact, My Account (overview, profile, orders, addresses, wishlist, security), `order.html`, track order,
  footer, toast and add-to-cart reliability.
- Remains: nothing known.
- Evidence: `4632f0d`, `18403c2`, `b583c9c`. Tests: account-e2e 61/61, restore-app-verify 34/34, offers-behaviour
  44/44 (guarded, 2026-11-13).
- Dependencies & risks: none.
- Next action: none.

**P3.10 — Product discovery (Milestone 2)** · *NEEDS VERIFICATION*
- Required: search, sorting, price, availability and category filters, URL-persisted filters, search
  suggestions, mobile filtering, pagination.
- Exists: `js/catalog.js`, `js/search.js`, `js/search-suggest.js`.
- Remains: verify each listed feature; this was not done in the 2026-11-14 audit.
- Evidence: insufficient.
- Dependencies & risks: none.
- Next action: feature-by-feature check.

**P3.11 — Every page downloads the full catalogue** · *NOT STARTED*
- Required: only pages that need the product list fetch it.
- Exists: admin pages opt out (`data-catalog="off"`). **23 storefront pages** load `js/main.js` without
  opting out, including about, contact, FAQ, privacy, terms, shipping, returns and auth pages.
- Remains: apply the opt-out where the catalogue is not used.
- Evidence: 2026-11-14 grep.
- Dependencies & risks: pages that use the cart or wishlist may still need product data.
- Next action: include in P8.2.

**P3.12 — Currency shown as GH₵ everywhere** · *COMPLETE (Local)*
- Required: no `$` prices.
- Exists: GH₵ across storefront, admin and the order email (Milestone 3, admin `money()`).
- Remains: a visual spot-check in P8.3.
- Evidence: the 2026-11-14 grep found no `$`-price strings in frontend code.
- Dependencies & risks: none.
- Next action: P8.3.

**P3.13 — Admin portal (Milestones 5–6)** · *PARTIALLY COMPLETE (Local)*
- Required: a working admin portal for the catalogue, stock, orders, customers, reviews, offers, coupons,
  scent families, maintenance and payment issues; plus image upload, bulk operations and an audit log
  (old backlog #15).
- Exists:
  - 15 admin pages: dashboard, reports, products, inventory, orders/order, customers/customer, reviews,
    special offers, coupons, scent families, maintenance, payment issues, login;
  - admin API groups: products, offers, coupons, orders, customers, reviews, payment issues, maintenance,
    system, reports, summary, logout.
- Evidence: admin-e2e 98/98, admin-api-tests 112/112, offers-multi-product-tests 127/127,
  order-status-history-tests 92/92, account-controls-tests 87/87.
- Remains: (each NOT STARTED)
  - image upload (needs a package and external storage; Render's disk is ephemeral);
  - other bulk operations;
  - an admin audit log.
- Dependencies & risks: migrations 002, 004, 005, 006, 007 and 009 in production.
- Next action: Phase 5; owner decision on the remaining items.

**P3.14 — SF-REV-01: continuously scrolling customer reviews (right to left)** · *NOT STARTED*
- Required:
  - customer reviews scroll continuously from right to left;
  - responsive at all widths;
  - reduced-motion support (no automatic movement when the visitor asks for reduced motion);
  - pause on hover and keyboard focus, and duplicated copies hidden from assistive technology;
  - **genuine reviews only**.
- Exists:
  - a homepage "Customer Reviews" section that shows up to 3 genuine reviews in a static grid and stays hidden
    when there are none (`index.html:158–167`, `js/home.js:22–23` and `:323+`, data from `GET /api/products/:id/reviews`);
  - a working right-to-left marquee pattern with reduced-motion handling, used by the brand strip
    (`js/home.js:80–110`, `css/home.css:436–456`).
- Remains:
  - the scrolling version;
  - a rule for how many reviews are needed before it scrolls. Locally there is **1 visible review** (read-only
    `SELECT`, 2026-11-14), and a marquee would repeat it;
  - placement (homepage only, or also product pages).
- Evidence: code references above; `SELECT COUNT(*)` on `reviews` (1 total, 1 visible).
- Dependencies & risks:
  - the owner's rule that the homepage is enhanced, never redesigned;
  - no invented or placeholder reviews;
  - the CSP (styles in CSS files, no inline scripts);
  - P3.3 dark mode.
- Next action: owner decides the minimum review count and placement, then implement.

**P3.15 — ACCT-AV-01: customer profile-picture upload** · *NOT STARTED*
- Required:
  - customers can upload, preview, replace and remove a profile picture from My Account;
  - **secure validation**: allowed image types checked by content, not just extension; size and dimension
    limits; re-encoding or metadata stripping; owner-only access;
  - **durable storage**.
- Exists:
  - nothing for uploads: the `users` table has no picture column (columns: id, full_name, email, google_id,
    auth_provider, phone, password_hash, role, created_at, updated_at, email_verified_at, disabled_at,
    disabled_reason, token_version);
  - there is no upload package among the backend dependencies;
  - Google sign-in returns the Google `picture` to the browser (`server.js:453`, `:537`) but it is not stored;
  - there is no avatar code in `js/account.js` / `my-account.html`.
- Remains: everything:
  - the storage decision;
  - a migration (010+);
  - upload, replace and delete endpoints;
  - the account-page UI;
  - CSP `img-src` changes if images are served from an external host;
  - a privacy-policy update (P4.2).
- Evidence: read-only `information_schema` query and code search (2026-11-14).
- Dependencies & risks:
  - **image storage**, shared with admin image upload (P3.13): Render's disk is ephemeral (decision D14);
  - upload endpoints are a new attack surface;
  - personal data;
  - P4.2.
- Next action: owner decision D14, then a design for review.

### Phase 4 — Content completion
*Objective: every customer-facing page carries real, owner-approved information.*

**P4.1 — Shipping, Returns and FAQ pages** · *BLOCKED (owner facts)* — NOT STARTED
- Required: real shipping, delivery, returns and FAQ information.
- Exists: "Coming soon" stubs of about 36 words each (`shipping.html`, `returns.html`, `FAQ.html`).
- Remains: all the content.
- Evidence: page text check (2026-11-14).
- Dependencies & risks: owner-supplied facts only (section 7).
- Next action: owner supplies the facts.

**P4.2 — Privacy Policy and Terms of Service** · *PARTIALLY COMPLETE — BLOCKED (owner/legal)*
- Required: complete policies covering what the site actually does.
- Exists: one short paragraph each (`privacy.html` 69 words, `terms.html` 61 words), mostly about Google Sign-In.
- Remains: cover payments (Paystack), email delivery, browser storage (`localStorage`/`sessionStorage`),
  order and account data, retention, the customer's rights and contact.
- Evidence: page text check (2026-11-14).
- Dependencies & risks: owner or legal review.
- Next action: owner supplies or approves policy text.

**P4.3 — Product descriptions and fragrance notes** · *BLOCKED (owner / research)*
- Required: real descriptions and notes for the catalogue.
- Exists: (read-only `SELECT`, 2026-11-14, 166 active products)
  - 2 have descriptions;
  - notes: 5 real, 145 `—`, 15 `???`, 1 empty;
  - 1 product name contains `??` ("Mancera Cedrat Bois??").
- Remains: owner-written or verified content. **Generated text is not a substitute** (P3.5).
- Evidence: the `SELECT` above.
- Dependencies & risks: owner time; research sources (Fragrantica, Parfumo and Basenotes block automated access).
- Next action: owner prioritises the products to complete first.

**P4.4 — Scent-family classification of the remaining products** · *PARTIALLY COMPLETE (Local)*
- Required: classify products only on verified evidence, under the owner's rules (gourmand/vanilla-led
  products stay unclassified; search summaries never count as verified).
- Exists: 32 of 166 classified.
- Remains: 134 products; batch 2 proposal awaiting approval.
- Evidence: `SELECT` counts; the Phase B/C decisions recorded 2026-10-09/10.
- Dependencies & risks: owner browser checks of reference sites.
- Next action: owner approves the next batch.

**P4.5 — Fragrance Guide maceration section** · *NOT STARTED*
- Required: an owner-approved maceration section in `learn.html`.
- Exists: nothing (zero mentions).
- Remains: copy, then implementation (part of P3.1).
- Evidence: 2026-11-14 grep.
- Dependencies & risks: owner copy; CSP hash if the inline script changes.
- Next action: owner supplies or approves the copy.

**P4.6 — Brand-name normalisation** · *NOT STARTED*
- Required: one spelling per brand.
- Exists: both "Dior" and "Christian Dior" are in use.
- Remains: choose one; change it through the admin (never by hand in production).
- Evidence: `SELECT` (2026-11-14).
- Dependencies & risks: brand filter and marquee counts change.
- Next action: owner decision.

**P4.7 — Catalogue data artefacts from the old damaged import** · *NEEDS VERIFICATION*
- Required: no artefacts such as badge text `"NULL"`, or an image path without an extension.
- Exists: the local catalogue was restored on 2026-10-02 from a faithful production dump, which carries
  production's own artefacts (e.g. #120013 `images/perfumes/Atheeri`).
- Remains: re-check which artefacts remain; fix via admin or approved data change.
- Evidence: old backlog #15; P3.6.
- Dependencies & risks: never hand-repair production.
- Next action: read-only inventory.

### Phase 5 — Database release preparation
*Objective: production TiDB can receive the rebuild safely and reversibly.*

**P5.1 — Apply migrations 002–009 to production** · *BLOCKED (P5.2, P5.3, P6.6)* — NOT STARTED
- Required: the rebuild's schema in production, in order, each verified.
- Exists: all eight applied and verified **locally only**; each file carries pre-checks, verification and rollback.
- Remains: everything in production. See the ledger (section 5).
- Evidence: each file's `Status:` header; local `information_schema` check (2026-11-14) found all eight present.
- Dependencies & risks: TiDB compatibility (P5.2); production backup (P5.3); the release path (P6.6).
  Features from P1.1, P1.7, P1.9, P1.10, P3.8 and P3.13 depend on these.
- Next action: P5.2.

**P5.2 — Production TiDB capability check** · *NEEDS VERIFICATION*
- Required: confirm the production TiDB version supports what the migrations and code rely on:
  - foreign-key enforcement (TiDB enforces it only from v6.6; used by 006, 008, 009);
  - `GET_LOCK`/`RELEASE_LOCK` (payment idempotency);
  - `CHECK`-constraint behaviour (deliberately not used);
  - time zone for offer windows (P5.6).
- Exists: release checklists inside the migration files.
- Remains: a read-only version query against production.
- Evidence: none yet.
- Dependencies & risks: needs explicit approval to contact production.
- Next action: owner approval for a read-only check.

**P5.3 — Production backup before any production change** · *NOT STARTED*
- Required: a verified production backup taken immediately before migrations.
- Exists: nothing.
- Remains: everything.
- Evidence: —
- Dependencies & risks: TiDB Cloud access.
- Next action: plan as part of P7/P8.

**P5.4 — Migration tracking** · *NOT STARTED*
- Required: a reliable record of which migrations are applied where.
- Exists: status is recorded only in each file's header comments; there is no tracking table. 001's header has no status line.
- Remains: decide on a ledger table or documented procedure.
- Evidence: 2026-11-14 audit.
- Dependencies & risks: a ledger table would itself be a migration.
- Next action: owner decision.

**P5.5 — Production data release** · *NOT STARTED*
- Required: a plan for data that exists only locally.
- Exists:
  - 32 local scent-family classifications;
  - local-only product #270038 (the local catalogue has 166 active products; production had 165 on 2026-10-01).
- Remains: decide what goes to production and how (admin, or a reviewed script), never by hand.
- Evidence: `SELECT`; 2026-10-15 audit notes.
- Dependencies & risks: P5.1.
- Next action: owner decision.

**P5.6 — Offer time zone** · *NEEDS VERIFICATION*
- Required: offer start/end times mean the same thing on Render, TiDB and in the browser.
- Exists: offer dates are stored as entered and compared with the database's `NOW()`.
- Remains: confirm the production time zones, or store UTC.
- Evidence: old backlog #15.
- Dependencies & risks: P1.16; staging.
- Next action: check at staging.

### Phase 6 — Documentation and GitHub
*Objective: the repositories explain themselves and have one clear path to production.*

**P6.1 — Project backlog** · *COMPLETE (this document, 2026-11-14)*
- Required: one accurate source of truth.
- Exists: this rewrite, from the 2026-11-14 audit.
- Remains: keep it current after each task.
- Evidence: this file.
- Dependencies & risks: drifts quickly if not updated.
- Next action: update after every completed task.

**P6.2 — Repository READMEs** · *NOT STARTED*
- Required: a top-level README in each repository (purpose, setup, scripts, tests, deployment).
- Exists: neither repository has one; only `tests/README.md` (backend).
- Remains: both READMEs.
- Evidence: directory listing (2026-11-14).
- Dependencies & risks: none.
- Next action: write both.

**P6.3 — `tests/README.md` accuracy** · *PARTIALLY COMPLETE*
- Required: the test documentation matches the latest results (same requirement as P2.4).
- Exists: per-suite rows, isolation and launch instructions; most rows were updated on 2026-11-13 and 11-14.
- Remains: the stale rows listed in P2.4 (payment-tests, payment-reliability-tests, auth-rate-limit-tests).
- Evidence: 2026-11-14 audit of the README's last-result column.
- Dependencies & risks: none; tracked once, under P2.4.
- Next action: as P2.4.

**P6.4 — Runbook in the repository** · *PARTIALLY COMPLETE*
- Required: the local start/stop procedure versioned with the code.
- Exists: `RUNBOOK-LOCAL-DEV-3308.md` outside both repos.
- Remains: copy it into the backend repo (minus any machine-only paths, if preferred).
- Evidence: runbook location.
- Dependencies & risks: none.
- Next action: owner approval.

**P6.5 — Environment-variable documentation** · *PARTIALLY COMPLETE*
- Required: every Render and Netlify setting documented with its rules (never values).
- Exists:
  - `.env.example` lists 18 keys (DB_*, PORT, NODE_ENV, FRONTEND_URL, GOOGLE_CLIENT_ID, JWT_SECRET,
    PAYSTACK_SECRET_KEY, SENDGRID_API_KEY, SENDGRID_FROM_EMAIL, CORS_ORIGINS, PAYMENT_SIGNING_SECRET,
    PAYSTACK_API_BASE, DEV_EMAIL_LOG);
  - `config-check.js` enforces the production rules.
- Remains: a deployment document for Render and Netlify (the known Render rules are listed in P7.2).
- Evidence: `.env.example`, `config-check.js`.
- Dependencies & risks: none.
- Next action: write it.

**P6.6 — Release path from `rebuild` to production** · *NOT STARTED*
- Required: a decided, reviewed way for the rebuild to become what Netlify and Render deploy.
- Exists:
  - Netlify and Render deploy from `origin`;
  - the rebuild lives on separate `rebuild` repositories;
  - older branches `feature/neofragrances-storefront-pr` (frontend) and `feature/payment-reliability-stage-b`
    (both repos) are still open.
- Remains: decide the route (e.g. a pull request into `origin`, or re-pointing the hosts); clean up the old branches.
- Evidence: `git branch -a` (2026-11-14).
- Dependencies & risks: blocks all of Phase 7.
- Next action: owner decision.

**P6.7 — Stale code comments** · *NOT STARTED*
- Required: comments match reality.
- Exists: `server.js:3369` and `payment-issues.js:2` say migration 009 is "PROPOSED, not applied anywhere",
  but it was applied locally on 2026-10-17.
- Remains: correct them.
- Evidence: grep (2026-11-14).
- Dependencies & risks: none.
- Next action: small fix (needs approval).

### Phase 7 — Staging deployment
*Objective: the rebuild runs on real hosting, against a real (non-production) database, before launch.*

**P7.1 — Staging environment and Netlify deploy preview** · *NOT STARTED*
- Required: a staging frontend and API; `_headers` (G-2, G-3, the maintenance hash) verified on Netlify.
- Exists: nothing; no `netlify.toml` or `render.yaml`.
- Remains: everything.
- Evidence: —
- Dependencies & risks: P6.6.
- Next action: owner decision on staging hosts.

**P7.2 — Render and Netlify environment configuration** · *NOT STARTED*
- Required: on Render —
  - `NODE_ENV=production`;
  - `JWT_SECRET` (32+ characters), and a different `PAYMENT_SIGNING_SECRET` (32+);
  - `CORS_ORIGINS` and/or `FRONTEND_URL` set to the Netlify origin;
  - `SENDGRID_API_KEY` / `SENDGRID_FROM_EMAIL`, `GOOGLE_CLIENT_ID`, `PAYSTACK_SECRET_KEY`;
  - `PAYSTACK_API_BASE` left unset.
- Exists:
  - the rules are enforced by `config-check.js` (P1.2);
  - locally, email runs with `DEV_EMAIL_LOG=true` and no SendGrid: verification works, but links are printed
    to the API console and no email is delivered (section 2).
- Remains: set and verify them on staging, then production, including a real verification email delivered
  through SendGrid.
- Evidence: `config-check.js`, `.env.example`, `mailer.js:34–66`.
- Dependencies & risks: a missing or weak secret stops the server starting (by design); without SendGrid,
  production customers cannot verify their email.
- Next action: at staging.

**P7.3 — Paystack webhook registration** · *NOT STARTED*
- Required: the webhook URL registered in the Paystack dashboard (test mode on staging first).
- Exists: the endpoint (P1.7).
- Remains: registration and a signed test event.
- Evidence: old backlog #2.
- Dependencies & risks: P7.1.
- Next action: at staging.

**P7.4 — Google Sign-In authorised origins** · *NEEDS VERIFICATION*
- Required: OAuth origins configured per environment.
- Exists: Google Sign-In is hidden unless `GOOGLE_CLIENT_ID` is set (locally it is not).
- Remains: configure and test on staging.
- Evidence: old backlog #5, #16b.
- Dependencies & risks: P7.1.
- Next action: at staging.

**P7.5 — Staging verification pass** · *BLOCKED (P7.1–P7.4)*
- Required: P1.13, P1.17, P5.6, the CORS origins and the security headers verified on staging.
- Exists: nothing; there is no staging environment.
- Remains: the whole pass.
- Evidence: —
- Dependencies & risks: P7.1–P7.4; findings may send work back to Phases 1, 3 or 5.
- Next action: after P7.1–P7.4.

### Phase 8 — Final QA and launch
*Objective: launch only after the site is verified end to end on staging, with a rollback plan.*

**P8.1 — Accessibility audit (old backlog #17)** · *NOT STARTED*
- Required: keyboard use, focus visibility, colour contrast (both themes once P3.3 exists), labels and
  landmarks, reduced motion, on storefront and admin.
- Exists: some checks done during individual tasks (e.g. maintenance progress bar ARIA, reduced motion in
  maintenance-tests M73/M76/M77; guide-page contrast choices). No site-wide audit.
- Remains: the full audit and fixes.
- Evidence: no site-wide audit record exists.
- Dependencies & risks: P3.3 changes every colour, so audit contrast after it.
- Next action: schedule after P3.3.

**P8.2 — Performance audit (old backlog #18)** · *NOT STARTED*
- Required: acceptable load times on mobile networks.
- Exists: admin pages skip the catalogue download (`data-catalog="off"`).
- Remains: the audit; P3.11 (23 storefront pages fetch the full catalogue); image sizes (product images
  200–800 px lifestyle shots, old backlog #9).
- Evidence: 2026-11-14 grep (P3.11).
- Dependencies & risks: P3.6 (new photos change image weight).
- Next action: after P3.11 and P3.6.

**P8.3 — Full browser / console / API / link audit (old backlog #19)** · *NOT STARTED*
- Required: every page loads without console errors, broken links or failed API calls, across browsers and phone widths.
- Exists: per-task checks only (e.g. the G-2 run: 50 storefront paths, 0 CSP violations, local).
- Remains: the full audit on staging.
- Evidence: no full audit record exists.
- Dependencies & risks: P7.1.
- Next action: on staging.

**P8.4 — Deployment-readiness audit (old backlog #20)** · *NOT STARTED*
- Required: Netlify, Render, TiDB, Paystack, Google, SendGrid, environment variables and migrations all
  confirmed ready.
- Exists: the pieces are tracked in P5.x, P6.5 and P7.x.
- Remains: a final read-through and sign-off.
- Evidence: —
- Dependencies & risks: everything in Phases 5–7.
- Next action: after P7.5.

**P8.5 — Real end-to-end payment on staging** · *NOT STARTED*
- Required: a full checkout with Paystack (test mode) on staging, settling through both callback and webhook.
- Exists: a full local test payment completed on 2026-10-02 (before the address-validation change).
- Remains: the staging run.
- Evidence: old backlog #16b; no staging evidence.
- Dependencies & risks: P7.3, P2.3, and the local callback problem QA-001 (P2.6).
- Next action: after P7.3 and P2.6.

**P8.6 — Rollback plan** · *NOT STARTED*
- Required: a written way back for code and database.
- Exists: previous `origin` commits; each migration file has a ROLLBACK section.
- Remains: the written plan, including the P5.3 backup and the order to reverse migrations.
- Evidence: migration files.
- Dependencies & risks: P5.3.
- Next action: write before launch.

**P8.7 — Launch** · *BLOCKED*
- Required: production deployment of the verified rebuild.
- Exists: nothing; production runs the pre-rebuild site.
- Remains: everything above.
- Evidence: section 2.
- Dependencies & risks: all of Phases 5–8.
- Next action: none until P8.1–P8.6 are done.

---

## 5. Migration status ledger

| # | File | What it adds | Local | Staging | Production |
|---|---|---|---|---|---|
| 001 | `001_orders_payment_reference_unique.sql` | UNIQUE `orders.payment_reference` | Applied 2026-10-02 | — (no staging) | **Applied and verified** (per the 2026-10-02 backlog; the file itself has no status line) |
| 002 | `002_coupons_active.sql` | `coupons.active` | Applied 2026-10-03 | — | **Not applied** |
| 003 | `003_app_settings.sql` | `app_settings` (maintenance mode) | Applied (date not recorded) | — | **Not applied** |
| 004 | `004_reviews_hidden.sql` | `reviews.hidden` | Applied 2026-10-04 | — | **Not applied** |
| 005 | `005_account_controls.sql` | `users.disabled_at`, `disabled_reason`, `token_version` | Applied 2026-10-07 | — | **Not applied** |
| 006 | `006_order_status_history.sql` | `order_status_history` + backfill | Applied 2026-10-08 | — | **Not applied** (needs TiDB ≥ 6.6 for FK enforcement) |
| 007 | `007_offer_products_unique.sql` | unique offer/product pairs | Applied 2026-10-08 | — | **Not applied** |
| 008 | `008_products_scent_family.sql` | `products.scent_family` | Applied 2026-10-10 | — | **Not applied** |
| 009 | `009_payment_issues.sql` | `payment_issues` | Applied 2026-10-17 | — | **Not applied** |

- **Local check (2026-11-14):** `information_schema` on the working database has every object from 002–009.
- **Production:** none of 002–009 is applied, so **no feature that depends on them is production-ready**:
  coupons, maintenance mode, review moderation, account controls and token revocation, order history,
  scent families, payment issues.
- **Not yet written** (candidates; each needs a decision first): `learn_articles` (P3.2), order
  subtotal/discount/shipping and an address snapshot (P1.18), review uniqueness (P1.19), a migration
  ledger (P5.4), a customer profile-picture column (P3.15). The next free number is 010.

---

## 6. Outstanding decisions and blockers

| # | Decision or blocker | Blocks | Owner |
|---|---|---|---|
| D1 | Release path from `rebuild` to production (P6.6) | All of Phase 7 and 8 | Owner |
| D2 | Read-only production TiDB version check (P5.2) | P5.1 migrations | Owner approval |
| D3 | Staging hosts (P7.1) | P2.5, P7.x, P8.5 | Owner |
| D4 | Dark-mode design: palette, toggle placement, default, CSP approach (P3.3) | P3.3 | Owner |
| D5 | Fragrance Guide placement and nav label (P3.1) | P3.1 | Owner |
| D6 | What to show instead of generated descriptions (P3.5) | P3.5 | Owner |
| D7 | Off-machine backup destination (P0.3) | P0.3 | Owner |
| D8 | Security choices: G-5 fail-open (P1.14), G-10 enumeration (P1.15), password minimum (P1.12) | Those tasks | Owner |
| D9 | Offer clock authority (P1.16) | P1.16 | Owner |
| D10 | Order breakdown / address snapshot for launch? (P1.18) | P1.18 | Owner |
| D11 | Production data release for local-only data (P5.5) | P5.5 | Owner |
| D12 | Migration ledger approach (P5.4) | P5.4 | Owner |
| D13 | Brand-name spelling (P4.6) | P4.6 | Owner |
| B1 | Owner content (section 7) | P4.x, P3.1, P3.6 | Owner |
| B2 | Single-disk backups (P0.3) | Data safety | — |
| D14 | Image storage for uploads (admin product images P3.13, customer profile pictures P3.15) | P3.13 image upload, P3.15 | Owner |
| D15 | Scrolling reviews: minimum genuine-review count and placement (P3.14) | P3.14 | Owner |
| D16 | How the QA-001 test checkout was run (device and address) (P2.6) | P2.6 | Owner |
| B3 | ~~Running local API can't be restarted from a non-elevated session (P0.6)~~ — **resolved**: the API was restarted with the LAN origin at 09:19 on 2026-11-14 and confirmed healthy at 11:43 | — | — |

---

## 7. Owner-supplied information and content dependencies

Nothing here may be invented; each item waits for the owner.

- **Shipping and delivery facts** — areas, fees (the site charges a GH₵8 flat fee), timescales, couriers (P4.1).
- **Returns policy** — conditions, window, process (P4.1).
- **FAQ** — questions and answers (P4.1).
- **Privacy Policy and Terms** — full text or approval (P4.2).
- **Product photos** for the 26 products without an image, plus licence confirmation (P3.6, P3.7).
- **Hero image licence** (`images/hero/hero-banner.jpg`) (P3.7).
- **Product descriptions and fragrance notes** (P4.3).
- **Scent-family research** — owner browser checks of reference sites; batch 2 approval (P4.4).
- **Maceration copy** for the Fragrance Guide (P4.5).
- **Dark-mode design choices** (D4).
- **Scrolling-reviews rules** — minimum genuine-review count and placement (D15, P3.14).
- **Image-storage choice** for admin and customer uploads (D14, P3.13, P3.15).
- **QA-001 details** — device, address and Paystack reference of the test checkout (D16, P2.6).
- **Production environment values** — set by the owner in Render/Netlify; never shared in documents (P7.2).

---

## 8. Test status

**Last full guarded regression: 2026-11-13** — 817/817 across all 17 database-backed suites (816/817 in the first pass; the one failure was a test expectation, corrected in `98bbaa5` and re-run 62/62), one at a time, on
`nf_test_phase1_20261029` at 127.0.0.1:3308. The working database was unchanged.

**Changes since then still need a full pass (P2.2):** T08 (`e45479b`), G-2 (`bac4433`), the maintenance fixes
(`1143177`, `afbbe8a`, `660176a`) and R4 (`8234289`).

Re-run since the full pass:

| Suite | Result | Date |
|---|---|---|
| admin-api-tests | 112/112 (guarded) | 2026-11-14 |
| maintenance-tests | 85/85 (guarded) | 2026-11-14 |
| platform-tests | 19/19 (guarded) | 2026-11-14 |
| Database-free (backend): admin-session 23, auth-rate-limit 51, security-headers 43, payment-reliability 71, payment-issues 84, password-session 33, startup-config 46, money-validation 11, maintenance-guard 22; isolated-db-guard 29 | all pass | 2026-11-14 |
| Frontend: maintenance-page 22, storefront-security-headers 34, admin-security-headers 29, admin-maintenance 30, admin-logout 14, admin-payment-issues 30 (one long-standing review observation) | all pass | 2026-11-14 |

Not run in their current form: `e2e-checkout.js` (P2.3). Per-suite detail: `tests/README.md` (some rows
stale — P2.4).

---

## 9. Prioritised next actions

1. **Local hygiene:**
   - browser check of LAN access on laptop and iPhone (P0.6; the API side was confirmed at 11:43 on 2026-11-14);
   - **copy the database backups off this machine** (P0.3);
   - **investigate QA-001**, the missing payment callback page (P2.6), starting with read-only checks.
2. **Small, safe code fixes** (each needs approval):
   - the product-details `???` notes bug (P3.4);
   - email normalisation, G-8 (P1.11);
   - the password minimum, G-9 (P1.12);
   - stale 009 comments (P6.7).
3. **Fragrance Education integration (P3.1):** nav, footer, drawer and product-page links, plus the maceration
   section once the copy is approved.
4. **Dark mode (P3.3):** design decision, then a token-mapping plan for storefront and admin together, then implementation.
5. **One full guarded regression pass (P2.2)** and the `tests/README.md` clean-up (P2.4).
6. **Documentation (Phase 6):** READMEs (P6.2), runbook into the repo (P6.4), environment document (P6.5).
7. **Release decisions:** release path (P6.6), then the TiDB check (P5.2), then staging (P7.1–P7.4), then
   migrations on staging, then a production backup (P5.3), then Phase 8.
8. **Owner content (section 7)** in parallel throughout.

---

## 10. Archive — completed milestones (Local unless stated)

- **Original site (pre-rebuild)** — what production runs today: `origin/main` frontend `d673a6c`, backend
  `ec3f18b` (2026-09-30), plus migration 001 (Production).
- **Milestone 1 — Homepage, About, Contact (2026-10-01/02):** premium hero, integrated Special Offers, best
  sellers / new arrivals, editorial content; About and Contact pages (0505731824 · Ambitiousn9@icloud.com ·
  WhatsApp `wa.me/233505731824`). Scent discovery on the homepage followed later via P3.8.
- **Catalogue restoration (2026-10-02):** the local catalogue was restored from a faithful read-only production
  dump: 165 active + 3 soft-deleted products, 2 offers, 2 offer_products; real NULLs, UTF-8 intact. The
  old `products-import.sql` / `offers-import.sql` / `offer_products-import.sql` Desktop files are the damaged
  originals and must never be imported. Production data is never edited by hand.
- **Milestone 3 — Payments (2026-10-02):** server-side pricing (`pricing.js`, integer pesewas), signed order
  snapshot, stock never negative, stored total = amount paid, `/api/checkout` disabled (410), Paystack
  webhook with a shared `settlePayment()`, GH₵ everywhere; a full local test payment completed 2026-10-02.
- **Local authentication fixes (2026-10-02):** registration MX check rejects only a definitive "no mail
  server"; `DEV_EMAIL_LOG` (local only); Google block hidden without `GOOGLE_CLIENT_ID`; open-redirect fix
  (`safeRedirectTarget`). Production still needs SendGrid confirmed (P7.2).
- **Milestone 4 — Customer accounts (2026-10-02):** `GET/PATCH /api/me`, password change, address management,
  richer My Orders, `my-account.html`, `order.html`, track order; `my-orders.html` / `wishlist.html` became
  redirects.
- **Milestone 5 — Admin redesign (2026-10-02):** `requireAdmin` re-reads the role; summary, reports, products
  (archive/restore), stock adjust (atomic, never below 0), orders (cancel restocks and is final), customers,
  reviews; `npm run create-local-admin` (local only). Low stock = 5 or fewer.
- **Offer-expiry tests split (2026-10-03):** `restore-app-verify.js` pins calendar-independent restoration
  facts; time-sensitive behaviour moved to `offers-behaviour.js` with relative windows.
- **Milestone 6 — Admin features (2026-10-03 → 10-17):** coupons (002), maintenance mode (003), review
  hide/unhide (004), account controls (005), order status history (006), multi-product offers (007), scent
  families (008), payment-issue register (009). Fragrance Guide static page (2026-10-09, P3.1).
- **Address validation at payment start (2026-10-30)** — P1.8.
- **Phase 0B — Preserve and stabilise (2026-11-13):** preservation copies and bundles, cold database copies, dumps and
  restore test, `DB_PORT=3308`, 3306 panel lock, runbook, backlog moved into the backend repo, first commits
  and pushes to the `rebuild` remotes.
- **Phase 1 — Security (2026-11-13/14):** G-1 (`77f01b4`, `03262ee`), T04 (`0d3d706`, `98bbaa5`), G-6/G-7
  (`2751520`), G-2 (`bac4433`), T08 (`e45479b`).
- **Phase 2 maintenance work (2026-11-14):** guard case fix (`1143177`), harness fix (`afbbe8a`), R4 maintenance
  auto-return (`8234289`), R3 `HEAD /api/health` (`660176a`).
