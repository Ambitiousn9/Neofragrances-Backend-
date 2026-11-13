-- ============================================================
-- 009  payment_issues — durable record of payments that could not be settled
-- ============================================================
-- Backlog: Payment Reliability Stage B (PI-03, PI-06).
-- Status: applied LOCAL ONLY on 2026-10-17 to the local MariaDB 10.4.32 working
--         database (neofragrances), after validation on a restored scratch copy.
--         Pre-apply backup (kept outside the repos):
--         neofragrances-local-db-neofragrances-full-pre-m009-20261017-181634.sql.
--         NOT applied to TiDB staging or production, and NOT verified on TiDB —
--         production application pending (see RELEASE CHECKLIST).
--
-- WHY
--   When Paystack confirms a payment (server-to-server verification) but the
--   order cannot be created — sold out after payment, the delivery address was
--   deleted, a product was archived, a coupon ran out, an integrity check failed,
--   or the database failed mid-settlement — the only trace used to be a console
--   log line. A signed charge.success webhook that could not be verified (Paystack
--   unreachable or still pending) left no trace at all once Paystack stopped
--   retrying. This table makes those cases durable and reviewable by an admin.
--
--   It is NOT a payment ledger: rows exist only for exceptions. Paystack remains
--   the record of every transaction; orders remain the record of every sale.
--
-- ROWS AND KEYS
--   One row per payment reference (UNIQUE). Repeated failures for the same
--   reference update that row (attempt_count, last_seen_at, last_source); the
--   application never creates a second row. A row is never deleted by the app.
--
-- EVIDENCE (application-validated, never a CHECK constraint)
--   paystack_verified  Paystack's server-to-server verify said "success". amount,
--                      currency come from that answer; user_id and
--                      expected_total_pesewas are filled ONLY from a signed order
--                      snapshot whose signature and reference were valid.
--   signed_webhook     a charge.success webhook with a valid Paystack signature
--                      whose verification was temporarily unavailable or pending.
--                      No amounts are recorded for it.
--   Verified evidence is never downgraded by a later webhook-only observation.
--
-- VALUES (validated in payment-issues.js; TiDB ignores CHECK by default and the
-- local MariaDB runs without strict mode, so lengths are enforced in code too)
--   category       settlement_blocked | integrity_mismatch | settlement_error | unverified_charge
--   first_source,
--   last_source    callback | webhook | admin_retry
--   status         open | resolved
--   resolution     settled | refunded_externally | no_action_needed | duplicate_payment
--   payment_reference matches PAYMENT_REFERENCE_PATTERN in server.js (≤ 83 chars).
--
-- FOREIGN KEYS — evidence must survive deletions
--   user_id, order_id, resolved_by are nullable and ON DELETE SET NULL. Never
--   CASCADE: users -> orders already cascades (orders_ibfk_1), so a cascading key
--   here could silently delete payment evidence. TiDB enforces foreign keys from
--   v6.6; production was TiDB v8.5.3 per the 2026-10-02 export audit (unverified now).
--
-- NOT STORED, by design: card data, Paystack authorization objects, secret keys,
--   signatures, raw webhook bodies, the signed snapshot, request headers, IP
--   addresses, customer email.
--
-- PRE-CHECK (run before applying, on every database)
--   SELECT COUNT(*) AS payment_issues_exists
--     FROM information_schema.TABLES
--    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payment_issues';
--   -- expect 0
--
-- APPLY
CREATE TABLE payment_issues (
  id                      INT          NOT NULL AUTO_INCREMENT,
  payment_reference       VARCHAR(100) NOT NULL,
  evidence                VARCHAR(20)  NOT NULL,
  category                VARCHAR(30)  NOT NULL,
  last_error_code         VARCHAR(40)  NULL DEFAULT NULL,
  first_source            VARCHAR(20)  NOT NULL,
  last_source             VARCHAR(20)  NOT NULL,
  status                  VARCHAR(20)  NOT NULL DEFAULT 'open',
  resolution              VARCHAR(30)  NULL DEFAULT NULL,
  user_id                 INT          NULL DEFAULT NULL,
  order_id                INT          NULL DEFAULT NULL,
  amount_pesewas          INT          NULL DEFAULT NULL,
  currency                CHAR(3)      NULL DEFAULT NULL,
  expected_total_pesewas  INT          NULL DEFAULT NULL,
  detail_product_id       INT          NULL DEFAULT NULL,
  attempt_count           INT          NOT NULL DEFAULT 1,
  first_seen_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  resolved_by             INT          NULL DEFAULT NULL,
  resolved_at             TIMESTAMP    NULL DEFAULT NULL,
  resolution_note         VARCHAR(500) NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_issues_reference (payment_reference),
  KEY idx_payment_issues_status_seen (status, last_seen_at),
  KEY idx_payment_issues_user (user_id),
  KEY idx_payment_issues_order (order_id),
  KEY idx_payment_issues_resolved_by (resolved_by),
  CONSTRAINT fk_payment_issues_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_payment_issues_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE SET NULL,
  CONSTRAINT fk_payment_issues_resolved_by FOREIGN KEY (resolved_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;
-- VERIFY
--   SHOW CREATE TABLE payment_issues;
--   SHOW INDEX FROM payment_issues;
--   -- expect the UNIQUE key on payment_reference and the four secondary keys
--   SELECT COUNT(*) FROM payment_issues;
--   -- expect 0: nothing is backfilled
--
-- ROLLBACK
--   DROP TABLE payment_issues;
--   -- Discards every recorded issue and its resolution notes; export first:
--   --   SELECT * FROM payment_issues;
--
-- RELEASE CHECKLIST (staging / production — NOT done, NOT authorised)
--   1. Apply BEFORE the server release that writes and reads this table. Until it
--      exists, settlement still works (issue writes are best effort and only
--      logged on failure) and GET /api/admin/summary reports
--      payment_issues.open = null, but the /api/admin/payment-issues routes fail.
--   2. Validate on a TiDB staging branch first: the CREATE TABLE as written, the
--      INSERT ... SELECT ... FROM DUAL WHERE NOT EXISTS used by payment-issues.js,
--      and the conditional UPDATE ... WHERE NOT EXISTS (SELECT ... FROM orders).
--   3. Deliberately plain SQL — no "IF NOT EXISTS". Re-running fails safely with
--      "Table 'payment_issues' already exists"; it changes nothing.
--   4. Migrations 002–009 are still local only; agree the production order for the
--      whole backlog before applying this one.
--   5. Unrelated but still open: GET_LOCK / RELEASE_LOCK support on the production
--      TiDB is unverified (settlePayment relies on it today).
-- ============================================================
