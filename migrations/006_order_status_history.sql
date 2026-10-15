-- ============================================================
-- 006  order_status_history — one row per order status change
--      Order Status History (Milestone 6 — Phase 5): a durable,
--      attributed record of every admin status transition.
-- ============================================================
-- Backlog: #15 (admin portal, Milestone 6 — Phase 5 audit + order history)
--          and 16c (order status history).
-- Status: applied LOCAL ONLY on 2026-10-08. NOT applied to production.
--
-- WHY
--   `orders` stores only the CURRENT status plus `updated_at`, and
--   `updated_at` moves on every write to the row. So today nobody can answer
--   "when did this order ship?", "who cancelled it?" or "why was it moved
--   back to Processing?". The admin PATCH /api/admin/orders/:id/status
--   overwrites the previous status and the information is gone.
--
--   This table is append-only. `orders.status` stays the single source of
--   truth for the CURRENT status; history only records how it got there.
--
-- COLUMNS
--   order_id     the order. ON DELETE CASCADE: history has no meaning
--                without its order, and orders themselves already cascade
--                from users (users -> orders -> order_items).
--   from_status  the status before the change. NULL only for the backfill
--                baseline row, where the previous status is NOT KNOWN.
--   to_status    the status after the change.
--   changed_by   the admin who made the change. NULL for the backfill row.
--                ON DELETE SET NULL, so deleting an admin account keeps the
--                order's history (the transition still happened) and only
--                loses the attribution.
--   source       'admin'    — PATCH /api/admin/orders/:id/status
--                'backfill' — the baseline row written by this migration
--                Validated in application code, never a CHECK constraint
--                (TiDB's CHECK enforcement is version-gated; same rule as the
--                coupon discount columns).
--   note         free text. Required by the application for cancellations
--                and backward corrections; optional for forward moves.
--                500 characters, enforced in the application BEFORE the
--                insert — the local MariaDB runs without STRICT_TRANS_TABLES
--                and would otherwise silently truncate a longer value.
--   created_at   when the change was recorded, from the database clock.
--
--   The status columns are VARCHAR(20) to match `orders.status`.
--
-- WHAT IS DELIBERATELY NOT RECORDED HERE
--   - Payment settlement. Orders are created by settlePayment() in
--     server.js, which is deliberately NOT changed to write a row: a paid
--     order must never be rolled back because status history could not be
--     written. A new order therefore has no history row until an admin
--     first changes its status; the order's own created_at remains the
--     authoritative "order placed" time.
--   - Restock quantities, refunds and payment states. Under the Phase 5
--     rules an admin cancellation (only possible from Pending or
--     Processing) always restocks in the same transaction, so a
--     source = 'admin', to_status = 'Cancelled' row is itself the evidence.
--   - The broader admin audit log. That is a separate, later migration.
--
-- INDEXES
--   idx_osh_order_id (order_id, id) — every read is "this order's history
--   in recorded order", which this serves directly; it also satisfies the
--   index InnoDB/TiDB need for the order_id foreign key.
--   idx_osh_changed_by (changed_by) — named explicitly for the changed_by
--   foreign key instead of relying on an engine-generated name.
--
-- PRE-CHECK (run before applying, on every database)
--   -- the table must not exist yet (expect 0)
--   SELECT COUNT(*) AS osh_tables
--     FROM information_schema.TABLES
--    WHERE TABLE_SCHEMA = DATABASE()
--      AND TABLE_NAME   = 'order_status_history';
--
--   -- record the order count: the BACKFILL must create exactly this many rows
--   SELECT COUNT(*) AS total_orders FROM orders;
--
--   -- the parent keys the foreign keys point at must be INT (signed), as
--   -- order_status_history.order_id / changed_by are (expect 'int' twice)
--   SELECT TABLE_NAME, DATA_TYPE, COLUMN_TYPE
--     FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE()
--      AND ((TABLE_NAME = 'orders' AND COLUMN_NAME = 'id')
--        OR (TABLE_NAME = 'users'  AND COLUMN_NAME = 'id'));
--
-- APPLY
CREATE TABLE order_status_history (
  id          INT          NOT NULL AUTO_INCREMENT,
  order_id    INT          NOT NULL,
  from_status VARCHAR(20)  NULL DEFAULT NULL,
  to_status   VARCHAR(20)  NOT NULL,
  changed_by  INT          NULL DEFAULT NULL,
  source      VARCHAR(20)  NOT NULL,
  note        VARCHAR(500) NULL DEFAULT NULL,
  created_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_osh_order_id (order_id, id),
  KEY idx_osh_changed_by (changed_by),
  CONSTRAINT fk_osh_order FOREIGN KEY (order_id) REFERENCES orders (id) ON DELETE CASCADE,
  CONSTRAINT fk_osh_changed_by FOREIGN KEY (changed_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- BACKFILL
--   Exactly one baseline row per existing order, recording ONLY what is
--   known: the order's current status at the moment tracking begins.
--
--     from_status = NULL                    previous status is unknown
--     to_status   = orders.status           the current status
--     changed_by  = NULL                    no admin is known
--     source      = 'backfill'
--     note        = 'Status tracking began'
--     created_at  = now (column default)    when tracking began — NOT when
--                                           the order reached that status
--
--   Nothing else is invented: no historical transition dates, previous
--   statuses, admin identities, cancellation reasons, payment states or
--   restock facts. The application presents this row as "status tracking
--   began", never as the date of the original transition.
--
--   The NOT EXISTS guard makes the statement safe to run again: a second run
--   adds a baseline only for orders that still have no history at all (for
--   example orders placed between applying this migration and deploying the
--   application), and never duplicates one.
INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, source, note)
SELECT o.id, NULL, o.status, NULL, 'backfill', 'Status tracking began'
  FROM orders o
 WHERE NOT EXISTS (SELECT 1 FROM order_status_history h WHERE h.order_id = o.id)
 ORDER BY o.id;

-- VERIFY
--   SHOW CREATE TABLE order_status_history;
--   -- expect the eight columns above, PRIMARY KEY (id), idx_osh_order_id
--   -- (order_id, id), idx_osh_changed_by, fk_osh_order ON DELETE CASCADE and
--   -- fk_osh_changed_by ON DELETE SET NULL
--
--   SELECT (SELECT COUNT(*) FROM orders) AS total_orders,
--          COUNT(*)                      AS backfill_rows,
--          COUNT(DISTINCT order_id)      AS orders_covered
--     FROM order_status_history
--    WHERE source = 'backfill';
--   -- all three must be equal (0 / 0 / 0 on a database with no orders)
--
--   SELECT COUNT(*) AS mismatched
--     FROM order_status_history h JOIN orders o ON o.id = h.order_id
--    WHERE h.source = 'backfill' AND (h.to_status <> o.status
--       OR h.from_status IS NOT NULL OR h.changed_by IS NOT NULL);
--   -- expect 0
--
-- ROLLBACK
--   DROP TABLE order_status_history;
--   -- Roll the APPLICATION back first. The new admin status endpoint inserts
--   -- into this table inside the status-change transaction, so without the
--   -- table every admin status change fails (and, correctly, rolls back —
--   -- the order is left unchanged). The order detail pages also read it.
--   -- Payment settlement never touches the table and is unaffected either way.
--   -- Dropping the table discards all recorded history permanently.
--
-- RELEASE CHECKLIST (production / TiDB Cloud — not done)
--   1. No pre-check can fail on data: the table is new and the backfill reads
--      `orders` only. Record total_orders first; the VERIFY counts must match.
--   2. Deliberately plain SQL — no "IF NOT EXISTS" on the CREATE — so it is
--      portable across MariaDB 10.4 (local) and TiDB (production). Re-running
--      the CREATE fails safely with "Table already exists"; the backfill is
--      guarded by NOT EXISTS (see BACKFILL).
--   3. Foreign keys: TiDB enforces them only from v6.6 onwards; older
--      versions accept and silently ignore them. The production TiDB version
--      is still unconfirmed (as for migrations 002, 004 and 005). If FKs are
--      not enforced there, deleting an order or a user would leave orphaned
--      history rows rather than cascading / nulling. The application never
--      deletes orders, so the practical exposure is user deletion — confirm
--      the version before relying on the cascade.
--   4. TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP is written explicitly so
--      the column does not depend on explicit_defaults_for_timestamp (OFF on
--      the local MariaDB). It mirrors orders.created_at.
--   5. Deploy the migration BEFORE the application. The table is inert until
--      the new code reads and writes it, but the new admin status endpoint
--      cannot change a status without it.
--   6. Run the BACKFILL as part of the same release, after the CREATE. If the
--      application is deployed some time after the migration, re-running the
--      BACKFILL statement once afterwards gives orders placed in between their
--      baseline too (it never duplicates).
-- ============================================================
