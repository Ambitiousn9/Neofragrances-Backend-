// accounts.js — per-user account status, read on every authenticated request.
//
// Milestone 6 Phase 4 (Account Controls). Two facts come out of `users` here:
//
//   disabled      disabled_at IS NOT NULL  -> the account cannot authenticate
//   tokenVersion  users.token_version      -> every JWT issued before the last
//                                             disable is permanently dead
//
// Both come from ONE row read, cached under ONE key, invalidated by ONE call.
// There is deliberately no second cache for token versions: a token version
// without its disabled flag (or the reverse) could be refreshed independently
// and the two would disagree about the same account.
//
// WHY A CACHE AT ALL
//   requireAuth previously made zero queries — it verified the JWT signature
//   and nothing else. Checking account status turns the hottest path in the
//   application into a database read. The TTL is the same 7s settings.js uses,
//   for the same reason: responsive enough that an operator does not notice,
//   cheap enough that it is not a per-request query.
//
//   The cost is a bounded staleness window. "Disabled" means "within ~7s on
//   this process", not "instantly", and on Render with more than one instance
//   each holds its own copy (same caveat as the maintenance cache — see
//   PROJECT-BACKLOG.md item 4).
//
// FAILURE BEHAVIOUR — hybrid last-known-state
//   This is the part that needed the most thought, because the two obvious
//   strategies are both wrong:
//
//     fail closed  a database blip logs out EVERY customer on the site. It
//                  turns a transient fault into a total outage.
//     fail open    a database blip hands access back to every disabled
//                  account for the duration.
//
//   So: on a read error, serve the last value known for THAT user if we have
//   one — a user already known to be disabled stays disabled through the blip.
//   Only when nothing at all is known do we fail OPEN, because the alternative
//   is locking out the entire customer base over a failed query. The admin
//   write path also seeds the cache with the authoritative post-commit state,
//   so a freshly disabled account is "known" immediately and does not depend
//   on a later read succeeding.
//
//   When nothing is known, tokenVersion is reported as null and the caller
//   SKIPS the version comparison. Failing open has to mean genuinely open; a
//   null version compared as 0 would reject every token with a non-zero
//   version, which is fail-closed wearing a disguise.
const pool = require("./db");

const TTL_MS = 7000;      // mirrors settings.js TTL_MS
// Bound: this map is keyed per user, unlike settings.js's single global entry.
// Overridable only so the eviction behaviour can be tested without creating
// five thousand users; nothing in the application sets it.
const MAX_ENTRIES = Number(process.env.ACCOUNT_CACHE_MAX) || 5000;

// userId -> { disabled, tokenVersion, at }
const cache = new Map();

// Guards against a slow read overwriting a newer invalidation. A read captures
// this counter before querying; if it has moved by the time the row comes back,
// an invalidation happened mid-flight, so the result is returned to the caller
// but NOT written to the cache - the row may have changed underneath it.
//
// A COUNTER, not a timestamp. A millisecond clock cannot separate an
// invalidation from a read that starts in the same millisecond, so a
// conservative comparison would refuse to cache and the cache would quietly
// never fill under rapid successive calls. A counter is exact.
//
// One global counter rather than one per user: disables are rare, so the
// occasional extra cache miss costs nothing, and a single number cannot itself
// go stale or need evicting.
let invalidationEpoch = 0;

function evictIfNeeded() {
  // Map preserves insertion order, so the front is the oldest entry. Entries
  // are deleted before being re-inserted on refresh, which keeps that true.
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function putEntry(userId, disabled, tokenVersion) {
  cache.delete(userId);
  cache.set(userId, { disabled, tokenVersion, at: Date.now() });
  evictIfNeeded();
}

// Never throws and never rejects. Returns { disabled, tokenVersion, known }:
//   known === false means the lookup failed with nothing cached -> fail OPEN,
//   and tokenVersion is null so the caller skips the version check.
async function readAccountStatus(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) {
    return { disabled: false, tokenVersion: null, known: false };
  }

  const cached = cache.get(id);
  const startedAt = Date.now();
  const epochAtStart = invalidationEpoch;
  if (cached && startedAt - cached.at < TTL_MS) {
    return { disabled: cached.disabled, tokenVersion: cached.tokenVersion, known: true };
  }

  try {
    const [rows] = await pool.query(
      "SELECT disabled_at, token_version FROM users WHERE id = ?",
      [id]
    );
    // No row: the account is gone. Not "disabled" — requireAuth leaves that to
    // the route (GET /api/me already 401s on a missing profile), and reporting
    // version 0 keeps a deleted id from being special-cased here.
    if (!rows.length) {
      const miss = { disabled: false, tokenVersion: 0 };
      if (invalidationEpoch === epochAtStart) putEntry(id, miss.disabled, miss.tokenVersion);
      return { ...miss, known: true };
    }
    const disabled = rows[0].disabled_at !== null && rows[0].disabled_at !== undefined;
    const tokenVersion = Number(rows[0].token_version) || 0;
    if (invalidationEpoch === epochAtStart) putEntry(id, disabled, tokenVersion);
    return { disabled, tokenVersion, known: true };
  } catch (err) {
    console.error("account status read failed for user", id, "-", err.code || err.message);
    // Last known state, however old: a user known to be disabled stays
    // disabled while the database is unreachable.
    if (cached) {
      return { disabled: cached.disabled, tokenVersion: cached.tokenVersion, known: true, stale: true };
    }
    // Nothing known: fail OPEN rather than lock out every customer at once.
    return { disabled: false, tokenVersion: null, known: false };
  }
}

// Called synchronously after a disable/enable transaction commits. `nextState`
// is the authoritative post-commit row; passing it seeds the cache so the new
// state survives an immediately following database failure, instead of leaving
// a hole where nothing is known and the user would fail open.
function invalidateAccountStatus(userId, nextState) {
  const id = Number(userId);
  invalidationEpoch++;
  cache.delete(id);
  if (nextState && typeof nextState.disabled === "boolean") {
    putEntry(id, nextState.disabled, Number(nextState.tokenVersion) || 0);
  }
}

// Test seam only: drop everything.
function clearAccountStatusCache() {
  cache.clear();
  invalidationEpoch++;
}

module.exports = {
  TTL_MS,
  MAX_ENTRIES,
  readAccountStatus,
  invalidateAccountStatus,
  clearAccountStatusCache,
  _cacheSize: () => cache.size,
};
