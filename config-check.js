// config-check.js — startup configuration checks (security findings G-6 / G-7).
//
// Pure: reads only the object it is given (process.env in server.js) and returns messages.
// Messages name variables but never contain their values, so they are safe to log.
//
// Errors stop the server before it loads anything else or listens:
//   * JWT_SECRET missing or blank (always) — without it every sign-in fails with a 500.
//   * On Render (RENDER is set) NODE_ENV must be "production" — otherwise Express and this app
//     keep development behaviour (development error pages, dev CORS origins, DEV_EMAIL_LOG).
//   * In production (NODE_ENV=production, or on Render):
//       - JWT_SECRET at least MIN_SECRET_LENGTH characters;
//       - PAYMENT_SIGNING_SECRET set, at least MIN_SECRET_LENGTH characters, and different from
//         JWT_SECRET (pricing.js falls back to JWT_SECRET when it is empty; production must not).
// Warnings never stop the server:
//   * outside production, PAYMENT_SIGNING_SECRET missing (the JWT_SECRET fallback is used —
//     the payment test suites rely on exactly that).
"use strict";

const MIN_SECRET_LENGTH = 32;
const isBlank = v => typeof v !== "string" || v.trim() === "";

function checkStartupConfig(env) {
  const e = env || {};
  const errors = [];
  const warnings = [];
  const onRender = !isBlank(e.RENDER);
  const production = e.NODE_ENV === "production" || onRender;

  if (onRender && e.NODE_ENV !== "production") {
    errors.push('NODE_ENV must be "production" on Render (RENDER is set). Set NODE_ENV=production in the Render environment.');
  }

  if (isBlank(e.JWT_SECRET)) {
    errors.push("JWT_SECRET is not set. Sign-in tokens cannot be issued or verified without it.");
  } else if (production && e.JWT_SECRET.length < MIN_SECRET_LENGTH) {
    errors.push(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters in production.`);
  }

  if (production) {
    if (isBlank(e.PAYMENT_SIGNING_SECRET)) {
      errors.push("PAYMENT_SIGNING_SECRET must be set in production (it signs the payment snapshot; the JWT_SECRET fallback is for local development only).");
    } else {
      if (e.PAYMENT_SIGNING_SECRET.length < MIN_SECRET_LENGTH) {
        errors.push(`PAYMENT_SIGNING_SECRET must be at least ${MIN_SECRET_LENGTH} characters in production.`);
      }
      if (!isBlank(e.JWT_SECRET) && e.PAYMENT_SIGNING_SECRET === e.JWT_SECRET) {
        errors.push("PAYMENT_SIGNING_SECRET must be different from JWT_SECRET.");
      }
    }
  } else if (isBlank(e.PAYMENT_SIGNING_SECRET) && !isBlank(e.JWT_SECRET)) {
    warnings.push("PAYMENT_SIGNING_SECRET is not set; payment snapshots are signed with JWT_SECRET (allowed outside production only).");
  }

  return { production, errors, warnings };
}

module.exports = { checkStartupConfig, MIN_SECRET_LENGTH };
