// payment-issues.js — durable record of payments that could not be settled
// (Payment Reliability Stage B, migration 009 — PROPOSED, not yet applied anywhere).
//
// This is NOT a payment ledger. A row exists only when Paystack has confirmed a
// payment (server-to-server) or a correctly signed charge.success webhook arrived,
// and NeoFragrances still could not create the order. One row per payment reference.
//
// Every write here is best effort: the caller (settleAndRecord in server.js) catches
// and logs any failure, and the customer/Paystack response is always computed from
// the settlement result alone. Nothing in this module can create an order, change
// stock or mark anything paid — only settlePayment() does that.

const CATEGORIES = ["settlement_blocked", "integrity_mismatch", "settlement_error", "unverified_charge"];
const EVIDENCE = ["signed_webhook", "paystack_verified"];
const SOURCES = ["callback", "webhook", "admin_retry"];
const STATUSES = ["open", "resolved"];
const RESOLUTIONS = ["settled", "refunded_externally", "no_action_needed", "duplicate_payment"];
// "settled" is set only by a successful settlement, never by hand.
const MANUAL_RESOLUTIONS = ["refunded_externally", "no_action_needed", "duplicate_payment"];
// integrity_mismatch is never retried: it would fail identically and may mean tampering.
const RETRYABLE_CATEGORIES = ["settlement_error", "unverified_charge", "settlement_blocked"];
const NOTE_MAX = 500;
const ERROR_CODE_MAX = 40;
// payment_issues.payment_reference is VARCHAR(100) (migration 009). Checked in code
// because the local MariaDB runs without strict mode and would truncate silently.
const REFERENCE_MAX = 100;

// Settlement codes that mean "Paystack confirmed the money, but this order cannot be
// created as paid for". Anything not listed here never creates an issue.
const BLOCKED_CODES = new Set(["PAID_OUT_OF_STOCK", "PAID_PRODUCT_UNAVAILABLE", "PAID_ADDRESS_MISSING", "COUPON_USED_UP"]);
const INTEGRITY_CODES = new Set(["AMOUNT_MISMATCH", "CURRENCY_MISMATCH", "REFERENCE_MISMATCH", "PAYMENT_METADATA_INVALID"]);

// Codes whose underlying condition the shop cannot undo, so a retry could never
// succeed: a deleted address cannot be restored, and the order must not be sent
// anywhere else. These issues are closed by a recorded manual decision only.
const NON_RETRYABLE_CODES = new Set(["PAID_ADDRESS_MISSING"]);

const isPositiveInt = v => Number.isInteger(v) && v > 0;
const isNonNegInt = v => Number.isInteger(v) && v >= 0;

// Paystack reports amounts as integer minor units (pesewas). Accept only a
// non-negative safe integer number, or a string of digits; reject booleans, decimals,
// negatives, empty strings and anything else (Number(true) would otherwise be 1).
function parseAmountPesewas(v) {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  if (typeof v === "string" && /^\d{1,15}$/.test(v)) { const n = Number(v); return Number.isSafeInteger(n) ? n : null; }
  return null;
}

// May an admin retry this issue? Open, a retryable category, and not a condition the
// shop cannot undo. Takes a row with status, category and last_error_code.
function isRetryable(row) {
  return !!row && row.status === "open" && RETRYABLE_CATEGORIES.includes(row.category) && !NON_RETRYABLE_CODES.has(row.last_error_code);
}

// A database error is recorded by its code only (e.g. ER_LOCK_DEADLOCK) — never its
// message, which can contain SQL and data values.
function safeErrorCode(err) {
  const code = err && typeof err.code === "string" ? err.code : "";
  return /^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? code : "DB_ERROR";
}

/* Decides what, if anything, a settlement result means for the register.
   Returns one of:
     { kind: "resolve", orderId }   the order exists: close any open issue as settled
     { kind: "record", spec }       create or update the issue for this reference
     { kind: "observe", code }      admin retry that did not settle: count the attempt
     null                           nothing to record
   `signedWebhook` must be true only when the caller verified the Paystack signature. */
function classifySettlement(result, { source, signedWebhook = false } = {}) {
  if (!result || typeof result !== "object") return null;
  const outcome = result.outcome;
  if (outcome === "created" || outcome === "already_processed") {
    return isPositiveInt(Number(result.orderId)) ? { kind: "resolve", orderId: Number(result.orderId) } : null;
  }

  const ev = result.evidence && result.evidence.paystackVerified === true ? result.evidence : null;
  const verifiedFields = () => ({
    evidence: "paystack_verified",
    amount_pesewas: isNonNegInt(ev.amountPesewas) ? ev.amountPesewas : null,
    currency: typeof ev.currency === "string" && /^[A-Z]{3}$/.test(ev.currency) ? ev.currency : null,
    // Only from a signed snapshot whose signature AND reference were valid.
    user_id: ev.snapshotValid === true && isPositiveInt(ev.userId) ? ev.userId : null,
    expected_total_pesewas: ev.snapshotValid === true && isNonNegInt(ev.expectedTotal) ? ev.expectedTotal : null,
  });

  if (ev && (outcome === "out_of_stock" || outcome === "rejected") && BLOCKED_CODES.has(result.code)) {
    const productId = result.details && isPositiveInt(Number(result.details.productId)) ? Number(result.details.productId) : null;
    return { kind: "record", spec: { ...verifiedFields(), category: "settlement_blocked", last_error_code: result.code, detail_product_id: productId } };
  }
  if (ev && outcome === "rejected" && INTEGRITY_CODES.has(result.code)) {
    return { kind: "record", spec: { ...verifiedFields(), category: "integrity_mismatch", last_error_code: result.code, detail_product_id: null } };
  }
  if (ev && outcome === "error") {
    return { kind: "record", spec: { ...verifiedFields(), category: "settlement_error", last_error_code: safeErrorCode(result.err), detail_product_id: null } };
  }
  if ((outcome === "temporary" || outcome === "pending") && source === "webhook" && signedWebhook === true) {
    return {
      kind: "record",
      spec: {
        evidence: "signed_webhook", category: "unverified_charge",
        last_error_code: outcome === "pending" ? "PAYMENT_PENDING" : "PAYMENT_VERIFY_UNAVAILABLE",
        amount_pesewas: null, currency: null, user_id: null, expected_total_pesewas: null, detail_product_id: null,
      },
    };
  }
  if (source === "admin_retry") {
    // Counted on the existing row only; an admin retry never creates an issue by itself.
    const code = outcome === "pending" ? "PAYMENT_PENDING" : outcome === "temporary" ? "PAYMENT_VERIFY_UNAVAILABLE"
      : typeof result.code === "string" && /^[A-Z][A-Z0-9_]{0,39}$/.test(result.code) ? result.code : null;
    return { kind: "observe", code };
  }
  return null;
}

function validateSpec(reference, spec, source, referencePattern) {
  if (typeof reference !== "string" || reference.length > REFERENCE_MAX || !referencePattern.test(reference)) throw new Error("payment issue: invalid reference");
  if (!SOURCES.includes(source)) throw new Error("payment issue: invalid source");
  if (!EVIDENCE.includes(spec.evidence) || !CATEGORIES.includes(spec.category)) throw new Error("payment issue: invalid evidence/category");
  if (spec.last_error_code !== null && (typeof spec.last_error_code !== "string" || spec.last_error_code.length > ERROR_CODE_MAX)) throw new Error("payment issue: invalid error code");
  for (const k of ["user_id", "detail_product_id"]) if (spec[k] !== null && !isPositiveInt(spec[k])) throw new Error(`payment issue: invalid ${k}`);
  for (const k of ["amount_pesewas", "expected_total_pesewas"]) if (spec[k] !== null && !isNonNegInt(spec[k])) throw new Error(`payment issue: invalid ${k}`);
  if (spec.currency !== null && !/^[A-Z]{3}$/.test(spec.currency)) throw new Error("payment issue: invalid currency");
}

const isDuplicateIssue = err => !!err && (err.code === "ER_DUP_ENTRY" || err.errno === 1062)
  && typeof err.sqlMessage === "string" && err.sqlMessage.includes("uq_payment_issues_reference");

// May the incoming observation replace the row's category/code/evidence fields?
// Open rows only; verified evidence replaces anything, webhook-only evidence replaces
// only webhook-only evidence. So paystack_verified is never downgraded.
// One more rule: an open settlement_blocked issue keeps its blocking reason (e.g.
// PAID_OUT_OF_STOCK) when a later attempt merely hits a transient database error —
// the blocking condition is the more specific, persistent diagnosis. There is no
// retry-history table, so such attempts are visible only through attempt_count,
// last_seen_at, last_source and the retry's own API response.
function canUpgrade(row, spec) {
  if (row.status !== "open") return false;
  if (row.category === "settlement_blocked" && spec.category === "settlement_error") return false;
  return spec.evidence === "paystack_verified" || row.evidence === "signed_webhook";
}

/* Creates the issue for `reference`, or updates the existing one.
   1. INSERT ... SELECT ... FROM DUAL WHERE NOT EXISTS (an order with this reference):
      a late failure can never open an issue for a reference that already settled.
      Assumption: INSERT ... SELECT ... FROM DUAL WHERE NOT EXISTS (...) behaves the same
      on MariaDB 10.4 and TiDB (to validate on staging). The NOT EXISTS reads committed
      orders; an order committing at the same instant can still race it, which is why
      a successful settlement also resolves any open issue afterwards.
   2. The UNIQUE key rejects a second row (ER_DUP_ENTRY); we then read the row and
      apply a compare-and-set UPDATE (WHERE evidence = <value read>), retried once.
   Returns { action: "created" | "updated" | "observed" | "skipped_order_exists" | "skipped_race" }. */
async function recordIssue(db, reference, spec, source, { referencePattern }) {
  validateSpec(reference, spec, source, referencePattern);
  try {
    const [ins] = await db.query(
      `INSERT INTO payment_issues (payment_reference, evidence, category, last_error_code, first_source, last_source,
                                   user_id, amount_pesewas, currency, expected_total_pesewas, detail_product_id)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM DUAL
        WHERE NOT EXISTS (SELECT 1 FROM orders WHERE payment_reference = ?)`,
      [reference, spec.evidence, spec.category, spec.last_error_code, source, source,
        spec.user_id, spec.amount_pesewas, spec.currency, spec.expected_total_pesewas, spec.detail_product_id, reference]);
    if (ins.affectedRows === 1) return { action: "created" };
    return { action: "skipped_order_exists" };
  } catch (err) {
    if (!isDuplicateIssue(err)) throw err;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const [rows] = await db.query("SELECT id, status, evidence, category FROM payment_issues WHERE payment_reference = ?", [reference]);
    if (!rows.length) return { action: "skipped_race" };
    const row = rows[0];
    if (!canUpgrade(row, spec)) {
      // Resolved, or weaker evidence: keep every field, count the observation only.
      await db.query("UPDATE payment_issues SET attempt_count = attempt_count + 1, last_seen_at = CURRENT_TIMESTAMP, last_source = ? WHERE id = ?", [source, row.id]);
      return { action: "observed" };
    }
    const [upd] = await db.query(
      `UPDATE payment_issues
          SET attempt_count = attempt_count + 1, last_seen_at = CURRENT_TIMESTAMP, last_source = ?,
              evidence = ?, category = ?, last_error_code = ?, detail_product_id = ?,
              user_id = COALESCE(?, user_id), amount_pesewas = COALESCE(?, amount_pesewas),
              currency = COALESCE(?, currency), expected_total_pesewas = COALESCE(?, expected_total_pesewas)
        WHERE id = ? AND status = 'open' AND evidence = ?`,
      [source, spec.evidence, spec.category, spec.last_error_code, spec.detail_product_id,
        spec.user_id, spec.amount_pesewas, spec.currency, spec.expected_total_pesewas, row.id, row.evidence]);
    if (upd.affectedRows === 1) return { action: "updated" };
    // The row changed under us (resolved or upgraded concurrently): read it again.
  }
  return { action: "skipped_race" };
}

// A successful settlement closes the open issue for its reference and links the order.
// resolvedBy is the admin for an admin retry, NULL when it happened automatically.
//
// If the issue was already closed by a MANUAL decision (refunded_externally,
// no_action_needed, duplicate_payment) — e.g. an admin resolved it while a settlement
// was still committing — the decision is kept exactly as recorded and only the order
// is linked (order_id), so the contradiction is durable and visible to admins
// (manual_resolution_conflict in the admin API). Nothing about money is implied or
// changed. Returns "resolved" | "linked" | "none".
async function resolveSettled(db, reference, orderId, { source, resolvedBy = null }) {
  if (!SOURCES.includes(source)) throw new Error("payment issue: invalid source");
  const [r] = await db.query(
    `UPDATE payment_issues
        SET status = 'resolved', resolution = 'settled', order_id = ?, resolved_by = ?, resolved_at = CURRENT_TIMESTAMP,
            last_seen_at = CURRENT_TIMESTAMP, last_source = ?
      WHERE payment_reference = ? AND status = 'open'`,
    [orderId, resolvedBy, source, reference]);
  if (r.affectedRows === 1) return "resolved";
  const [l] = await db.query(
    "UPDATE payment_issues SET order_id = ? WHERE payment_reference = ? AND status = 'resolved' AND order_id IS NULL",
    [orderId, reference]);
  return l.affectedRows === 1 ? "linked" : "none";
}

// An admin retry that did not settle: count it on the existing row (never creates one).
// last_error_code follows the latest non-settling outcome EXCEPT on an open
// settlement_blocked issue, whose blocking reason (e.g. PAID_OUT_OF_STOCK) is kept:
// a pending or temporary retry result must not erase why the order was blocked.
async function observeRetry(db, reference, code) {
  await db.query("UPDATE payment_issues SET attempt_count = attempt_count + 1, last_seen_at = CURRENT_TIMESTAMP, last_source = 'admin_retry' WHERE payment_reference = ?", [reference]);
  if (code) await db.query("UPDATE payment_issues SET last_error_code = ? WHERE payment_reference = ? AND status = 'open' AND category <> 'settlement_blocked'", [code.slice(0, ERROR_CODE_MAX), reference]);
}

// Administrator-facing explanation of an admin retry result. The customer-facing
// wording settlement returns (result.error) is deliberately never used here.
function adminRetryMessage(result) {
  const outcome = result && result.outcome;
  const code = result && typeof result.code === "string" ? result.code : "";
  if (outcome === "created") return "Paystack confirmed the payment and the order was created through normal settlement.";
  if (outcome === "already_processed") return "An order already exists for this payment, so nothing new was created. The issue is linked to it.";
  if (outcome === "pending") return "Paystack still reports this payment as pending. No order was created. Retry later.";
  if (outcome === "temporary") return "Paystack couldn't be reached or gave an unusable answer. No order was created. Retry in a few minutes.";
  if (outcome === "busy") return "This payment is being settled by another request right now. Reload in a moment.";
  if (outcome === "error") return "Paystack confirmed the payment, but the order still couldn't be written (database error). No order was created. Retry later.";
  if (outcome === "out_of_stock" && code === "PAID_PRODUCT_UNAVAILABLE") return "Paystack confirmed the payment, but a product in it is archived or no longer exists. Restore the product before retrying, or record a manual decision.";
  if (outcome === "out_of_stock") return "Paystack confirmed the payment, but there still isn't enough stock to create the order. Restock the product before retrying, or record a manual decision.";
  if (code === "PAID_ADDRESS_MISSING") return "Paystack confirmed the payment, but the delivery address chosen at checkout was deleted. This can't be settled automatically — contact the customer and record a manual decision.";
  if (code === "COUPON_USED_UP") return "Paystack confirmed the payment, but the coupon used has reached its usage limit. Raise the limit before retrying, or record a manual decision.";
  if (INTEGRITY_CODES.has(code)) return `Paystack's record doesn't match this order (${code}). It can't be settled automatically — investigate it in the Paystack dashboard and record a manual decision.`;
  if (code === "PAYMENT_NOT_SUCCESSFUL") return "Paystack now reports this payment as not successful (failed, abandoned or reversed). No order was created.";
  return code ? `The payment could not be settled (${code}). No order was created.` : "The payment could not be settled. No order was created.";
}

// Entry point used by settleAndRecord in server.js.
async function recordFromSettlement(db, reference, result, { source, signedWebhook = false, resolvedBy = null, referencePattern }) {
  const decision = classifySettlement(result, { source, signedWebhook });
  if (!decision) return { action: "none" };
  if (decision.kind === "resolve") {
    return { action: await resolveSettled(db, reference, decision.orderId, { source, resolvedBy }) };
  }
  if (decision.kind === "observe") {
    await observeRetry(db, reference, decision.code);
    return { action: "observed" };
  }
  return recordIssue(db, reference, decision.spec, source, { referencePattern });
}

/* ---------- admin list filters ---------- */
// Returns { error, field } or { where: "...", params: [...], page, pageSize, status }.
// Conditions are always appended in this fixed order: status, category, evidence,
// from, to, reference search.
function parseListQuery(query = {}) {
  const q = query || {};
  const str = v => (v === undefined || v === null ? "" : String(v).trim());
  const page = Math.max(1, parseInt(q.page, 10) || 1);
  const pageSize = Math.min(100, Math.max(1, parseInt(q.pageSize, 10) || 25));
  const where = [], params = [];
  const status = str(q.status) || "open";
  if (status !== "all") {
    if (!STATUSES.includes(status)) return { error: "Invalid status filter.", field: "status" };
    where.push("pi.status = ?"); params.push(status);
  }
  const category = str(q.category);
  if (category) {
    if (!CATEGORIES.includes(category)) return { error: "Invalid category filter.", field: "category" };
    where.push("pi.category = ?"); params.push(category);
  }
  const evidence = str(q.evidence);
  if (evidence) {
    if (!EVIDENCE.includes(evidence)) return { error: "Invalid evidence filter.", field: "evidence" };
    where.push("pi.evidence = ?"); params.push(evidence);
  }
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  const from = str(q.from), to = str(q.to);
  if (from) {
    if (!datePattern.test(from)) return { error: "From date must be YYYY-MM-DD.", field: "from" };
    where.push("pi.last_seen_at >= ?"); params.push(`${from} 00:00:00`);
  }
  if (to) {
    if (!datePattern.test(to)) return { error: "To date must be YYYY-MM-DD.", field: "to" };
    where.push("pi.last_seen_at <= ?"); params.push(`${to} 23:59:59`);
  }
  const ref = str(q.q);
  if (ref) {
    if (ref.length > 100 || !/^[A-Za-z0-9-]+$/.test(ref)) return { error: "Search by payment reference (letters, numbers and hyphens).", field: "q" };
    where.push("pi.payment_reference LIKE ?"); params.push(`%${ref}%`);
  }
  return { where: where.length ? `WHERE ${where.join(" AND ")}` : "", params, page, pageSize, status };
}

// Manual resolution body: { resolution, note }. Returns { error, field } or { values }.
function validateResolution(body) {
  const b = body && typeof body === "object" ? body : {};
  if (b.resolution === "settled") return { field: "resolution", error: "An issue is marked settled only when Paystack-verified settlement creates the order. Use Retry settlement instead." };
  if (!MANUAL_RESOLUTIONS.includes(b.resolution)) return { field: "resolution", error: "Choose refunded externally, no action needed or duplicate payment." };
  if (typeof b.note !== "string") return { field: "note", error: "Add a note explaining the resolution." };
  const note = b.note.trim();
  if (!note) return { field: "note", error: "Add a note explaining the resolution." };
  if (note.length > NOTE_MAX) return { field: "note", error: `The note must be ${NOTE_MAX} characters or fewer.` };
  return { values: { resolution: b.resolution, note } };
}

module.exports = {
  CATEGORIES, EVIDENCE, SOURCES, STATUSES, RESOLUTIONS, MANUAL_RESOLUTIONS, RETRYABLE_CATEGORIES, NON_RETRYABLE_CODES, NOTE_MAX,
  safeErrorCode, parseAmountPesewas, isRetryable, classifySettlement, canUpgrade, recordIssue, resolveSettled, observeRetry,
  recordFromSettlement, adminRetryMessage, parseListQuery, validateResolution,
};
