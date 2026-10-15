// rate-limit.js — small in-memory rate limiters, shared by server.js.
//
// createRateLimiter is the limiter server.js has always used (password change,
// track order, invalid Paystack webhooks), moved here unchanged so it can be
// unit tested without starting the server. Three additions, all optional and
// inert for the existing callers:
//   - clear(key) and retryAfterSeconds(key), used by the login throttle;
//   - an injectable clock (`now`), used only by tests;
//   - a key cap (`maxKeys`, default unlimited) that evicts the least recently
//     recorded key, so a limiter fed by user input cannot grow without bound.
//
// Every limiter lives in this process's memory: counts reset on restart and are
// not shared between instances (see PROJECT-BACKLOG.md item 4).

const crypto = require("crypto");

function createRateLimiter({ windowMs, max, now = Date.now, maxKeys = Infinity }) {
  const hits = new Map();
  setInterval(() => {
    const t = now();
    for (const [key, list] of hits) {
      const fresh = list.filter(ts => t - ts < windowMs);
      if (fresh.length) hits.set(key, fresh); else hits.delete(key);
    }
  }, windowMs).unref();
  const recent = key => (hits.get(key) || []).filter(ts => now() - ts < windowMs);
  return {
    // True if the key has already used up its allowance (records nothing).
    isLimited(key) { return recent(key).length >= max; },
    // Records one attempt for the key.
    record(key) {
      const list = recent(key);
      list.push(now());
      hits.delete(key); // re-insert so Map order tracks the most recent use
      hits.set(key, list);
      while (hits.size > maxKeys) hits.delete(hits.keys().next().value);
    },
    // Records an attempt and returns true when the key is over the limit.
    limited(key) { this.record(key); return recent(key).length > max; },
    // Forgets every attempt recorded for the key.
    clear(key) { hits.delete(key); },
    // Whole seconds until the key is no longer limited; 0 when it is not limited now.
    retryAfterSeconds(key) {
      const list = recent(key);
      if (list.length < max) return 0;
      // The key frees up once enough of its oldest attempts leave the window.
      const freeAt = list[list.length - max] + windowMs;
      return Math.max(1, Math.ceil((freeAt - now()) / 1000));
    },
    // Number of keys currently held (for tests and the key cap).
    size() { return hits.size; },
  };
}

// Login throttle: two tiers, counting FAILED logins only.
//   Tier A — one IP + one normalised email. Cleared by a successful login, so a
//            customer who mistypes and then gets it right starts afresh.
//   Tier B — one IP across every email. Never cleared by a success, otherwise one
//            valid account would let an attacker reset it at will.
// There is deliberately no account-wide tier (any IP): that would let anyone lock
// a victim out of their own account.
const LOGIN_KEY_IP_MAX = 64;

function loginKeys(ip, email) {
  const ipKey = String(ip || "unknown").slice(0, LOGIN_KEY_IP_MAX);
  // Trimmed + lower-cased, then hashed: case or whitespace changes share one key,
  // and the key length is fixed however long the submitted email is.
  const normalised = String(email === undefined || email === null ? "" : email).trim().toLowerCase();
  const emailKey = crypto.createHash("sha256").update(normalised).digest("hex");
  return { a: `${ipKey}|${emailKey}`, b: ipKey };
}

function createLoginThrottle({ windowMs, perAccountMax, perIpMax, now = Date.now, maxKeys = Infinity }) {
  const tierA = createRateLimiter({ windowMs, max: perAccountMax, now, maxKeys });
  const tierB = createRateLimiter({ windowMs, max: perIpMax, now, maxKeys });
  return {
    tierA, tierB,
    // Read-only: is this IP + email blocked, and for how long?
    check(ip, email) {
      const k = loginKeys(ip, email);
      const limited = tierA.isLimited(k.a) || tierB.isLimited(k.b);
      const retryAfter = limited ? Math.max(tierA.retryAfterSeconds(k.a), tierB.retryAfterSeconds(k.b)) : 0;
      return { limited, retryAfter };
    },
    // One failed login (HTTP 401) counts once in each tier.
    recordFailure(ip, email) {
      const k = loginKeys(ip, email);
      tierA.record(k.a);
      tierB.record(k.b);
    },
    // A successful login clears Tier A for this IP + email only.
    recordSuccess(ip, email) {
      tierA.clear(loginKeys(ip, email).a);
    },
  };
}

module.exports = { createRateLimiter, createLoginThrottle, loginKeys };
