// security-headers.js — response security headers for the JSON API (Roadmap Task 4,
// backend Phase A). Hand-written on purpose: a fixed header set needs no dependency.
//
// This server only ever returns JSON (plus a plain-text "/"), so the policy is the
// strictest one possible: nothing may be loaded, framed or submitted from an API
// response. The storefront is a separate static host (Netlify) and gets its own,
// different policy there — never reuse this CSP for pages.
//
// Registered FIRST in server.js, before CORS and the JSON body parser, so the headers
// are already on the response when CORS answers a preflight, when a malformed JSON
// body is rejected, and when the maintenance guard, a rate limiter or the default
// 404 handler responds.

const BASE_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  // Applies to no-cors loads (<img>, <script>) only; the storefront's fetch() calls
  // are CORS requests, which CORS governs, so they are unaffected.
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-DNS-Prefetch-Control": "off",
});

// One day to start with, so a mistake is cheap to undo; raise it once HTTPS is
// confirmed on staging. No includeSubDomains, no preload (an onrender.com subdomain
// cannot be preloaded by us).
const HSTS_VALUE = "max-age=86400";

// Responses that carry personal, account, admin or payment data. Matched on the
// path only, case-insensitively (Express routing is case-insensitive by default),
// and on whole segments, so "/api/me" covers "/api/me" and "/api/me/password" but
// not a hypothetical "/api/media". Public catalogue routes (/api/products,
// /api/offers/active, /api/products/:id/reviews) are deliberately NOT listed.
const NO_STORE_EXACT_OR_PREFIX = ["/api/me", "/api/my-orders", "/api/addresses", "/api/wishlist"];
const NO_STORE_PREFIX_ONLY = ["/api/admin/", "/api/payments/"];

function isNoStorePath(pathname) {
  const p = String(pathname || "").toLowerCase();
  if (NO_STORE_EXACT_OR_PREFIX.some(base => p === base || p.startsWith(base + "/"))) return true;
  return NO_STORE_PREFIX_ONLY.some(prefix => p.startsWith(prefix));
}

function securityHeaders(req, res, next) {
  res.set(BASE_HEADERS);
  // req.secure comes from Express's "trust proxy" setting (1 hop in server.js): the
  // proxy's X-Forwarded-Proto. Browsers ignore HSTS received over plain HTTP, so a
  // client spoofing that header locally gains nothing.
  if (req.secure) res.set("Strict-Transport-Security", HSTS_VALUE);
  if (isNoStorePath(req.path)) res.set("Cache-Control", "no-store");
  next();
}

module.exports = { securityHeaders, isNoStorePath, BASE_HEADERS, HSTS_VALUE };
