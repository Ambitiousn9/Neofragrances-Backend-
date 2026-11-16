// server.js — the main Express app
require("dotenv").config();

// Startup configuration checks (G-6 / G-7, config-check.js) — before anything else loads or
// listens. A missing JWT_SECRET, weak or shared production secrets, or a Render deployment
// without NODE_ENV=production stop the process here with a clear message (variable names only,
// never values) instead of surfacing later as 500s or development behaviour in production.
{
  const { errors, warnings } = require("./config-check").checkStartupConfig(process.env);
  for (const w of warnings) console.warn(`WARNING: ${w}`);
  if (errors.length) {
    for (const e of errors) console.error(`CONFIGURATION ERROR: ${e}`);
    console.error("NeoFragrances API not started.");
    process.exit(1);
  }
}

const express = require("express");
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { OAuth2Client } = require("google-auth-library");
const dns = require("dns").promises;
const pool = require("./db");
const { CURRENCY, PricingError, toCedis, hasAtMost2dp, priceCart, signSnapshot, readSignedSnapshot, quoteForClient } = require("./pricing");
const maintenanceSettings = require("./settings");
const accounts = require("./accounts");
const { createRateLimiter, createLoginThrottle } = require("./rate-limit");
const { securityHeaders } = require("./security-headers");
const paymentIssues = require("./payment-issues");
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;

if (!GOOGLE_CLIENT_ID) {
  console.warn("WARNING: GOOGLE_CLIENT_ID is not configured.");
}

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);
const { sendOrderConfirmation, sendPasswordResetEmail, sendVerificationEmail, emailModeNotice } = require("./mailer");
const app = express();

// Render (and most PaaS hosts) sit behind a reverse proxy — trust the
// X-Forwarded-For header so req.ip reflects the real client IP. This
// matters for the password-reset rate limiter below.
app.set("trust proxy", 1);

// Security headers (security-headers.js) go on before anything else can respond:
// CORS preflights, malformed-JSON rejections, the maintenance guard, rate limits,
// routes and the default 404 handler all inherit them.
app.disable("x-powered-by");
app.use(securityHeaders);

// Explicit origin allowlist — never "*", because these APIs carry bearer tokens and
// payment calls. CORS_ORIGINS holds a comma-separated list (the production Netlify
// origin belongs there), and FRONTEND_URL is honoured too since it is already the
// canonical frontend origin, so production needs no second variable to stay working.
// The local dev origins are added only outside production.
const IS_PRODUCTION = process.env.NODE_ENV === "production" || !!process.env.RENDER;
const DEV_ORIGINS = ["http://127.0.0.1:5500", "http://localhost:5500"];
const stripSlash = o => String(o).trim().replace(/\/+$/, "");
const ALLOWED_ORIGINS = new Set([
  ...String(process.env.CORS_ORIGINS || "").split(",").map(stripSlash).filter(Boolean),
  ...(process.env.FRONTEND_URL ? [stripSlash(process.env.FRONTEND_URL)] : []),
  ...(IS_PRODUCTION ? [] : DEV_ORIGINS),
]);

app.use(cors({
  origin(origin, callback) {
    // No Origin header means this is not a browser cross-origin request: the Paystack
    // webhook, a health check, curl. CORS has nothing to protect there, so allow it.
    if (!origin) return callback(null, true);
    callback(null, ALLOWED_ORIGINS.has(stripSlash(origin)));
  },
}));

// Where Paystack sends the customer back after paying (QA-001). The page that started the
// checkout is the right place to return to: a phone on the LAN must come back to the LAN
// address it is using, not to FRONTEND_URL's 127.0.0.1, which on the phone is the phone itself.
// The request's Origin is used only when it is EXACTLY one of the allowed origins above (the
// same set CORS uses, so production allows only CORS_ORIGINS and FRONTEND_URL). Anything else,
// including no Origin at all, gets FRONTEND_URL exactly as before. Host, Referer and
// X-Forwarded-* are never consulted, so no request can steer the redirect elsewhere.
function paymentCallbackUrl(req) {
  const origin = req.get("Origin");
  const base = origin && ALLOWED_ORIGINS.has(stripSlash(origin)) ? stripSlash(origin) : process.env.FRONTEND_URL;
  return `${base}/payment-callback.html`;
}

const PAYMENT_WEBHOOK_PATH = "/api/payments/webhook";

// Paystack signs the exact bytes it sends, so the webhook needs the body as received:
// a re-serialised req.body would not reproduce the signature. Only that one path keeps
// a copy, so every other request is parsed exactly as before with nothing extra retained.
app.use(express.json({
  verify: (req, res, buf) => {
    if (req.originalUrl.split("?")[0] === PAYMENT_WEBHOOK_PATH) req.rawBody = buf;
  },
}));

/* ---------- Maintenance mode (Milestone 6 Phase 2) ----------
   Placed here deliberately: after express.json so the webhook's rawBody capture
   above is untouched, and before the first route so it is the single gate for
   /api/*. Express serves no HTML at all, so this guard governs the API only —
   the customer-facing page swap is client-side (js/main.js) and is UX, not
   enforcement. This is the authoritative layer.

   DEFAULT-DENY for /api/*: anything not on the bypass list is blocked while
   maintenance is on, so a route added later is safely blocked rather than
   accidentally left open. Paths outside /api/ are never touched.

   Every bypass below was verified against real usage before being added:
     /api/admin/*                  all 27 routes carry requireAdmin, so bypassing
                                   adds no exposure — and the admin must be able
                                   to turn maintenance back off.
     POST /api/login               the ONLY auth path for admins
                                   (admin/login.html -> loginUser -> /api/login).
                                   Blocking it is an unrecoverable lockout.
     GET  /api/health              Render's health check. A 503 here reads as
                                   "service down" and can trigger a restart.
     HEAD /api/health              the same check for monitors that probe with
                                   HEAD (Express answers it with the GET handler,
                                   headers only), so they see the real status too.
     GET  /api/me                  admin-core.js awaits this during boot; on
                                   failure its ready promise never resolves and
                                   EVERY admin page stays dead. GET only —
                                   PATCH /api/me is a profile edit and is blocked.
     GET  /api/payments/verify/:ref the customer has already been charged.
     POST /api/payments/webhook    Paystack treats 5xx as "retry" and eventually
                                   gives up, which would lose real orders. It is
                                   signature-authenticated and independently rate
                                   limited, so leaving it open costs nothing.
     GET  /api/system/status       the maintenance probe itself.

   The bypass check runs BEFORE the settings read, so a bypassed route — health
   above all — never depends on the settings query succeeding.

   The path is lower-cased before both checks because Express matches routes
   case-insensitively: "/API/payments/initialize" reaches the same handler as
   "/api/payments/initialize", so the guard must treat it as an /api/ path too.
   (security-headers.js lower-cases for the same reason.) A differently-cased
   bypass path is still bypassed, which adds nothing: /api/admin/* keeps
   requireAdmin and the other bypasses are open to everyone anyway. */
const MAINTENANCE_BYPASS_PREFIXES = ["/api/admin/"];
const MAINTENANCE_BYPASS_EXACT = new Set([
  "POST /api/login",
  "GET /api/health",
  "HEAD /api/health",
  "GET /api/me",
  "POST " + PAYMENT_WEBHOOK_PATH,
  "GET /api/system/status",
]);
const MAINTENANCE_BYPASS_PATTERNS = [/^GET \/api\/payments\/verify\/[^/]+$/];

function maintenanceBypassed(method, routePath) {
  const key = `${method} ${routePath}`;
  if (MAINTENANCE_BYPASS_EXACT.has(key)) return true;
  if (MAINTENANCE_BYPASS_PREFIXES.some(p => routePath.startsWith(p))) return true;
  return MAINTENANCE_BYPASS_PATTERNS.some(re => re.test(key));
}

app.use(async (req, res, next) => {
  const routePath = req.path.toLowerCase();
  if (!routePath.startsWith("/api/")) return next();
  if (maintenanceBypassed(req.method, routePath)) return next();
  let on = false;
  try {
    on = await maintenanceSettings.isMaintenanceMode();
  } catch (err) {
    // isMaintenanceMode already fails open; this is belt and braces so a bug in
    // the settings layer can never 500 every request.
    console.error("maintenance guard read failed — failing OPEN:", err.code || err.message);
    return next();
  }
  if (!on) return next();
  res.set("Retry-After", "600");
  return res.status(503).json({
    error: "NeoFragrances is briefly down for maintenance. Please try again shortly.",
    code: "MAINTENANCE_MODE",
  });
});

// Public, deliberately tiny, and on the bypass list: the storefront polls this
// to decide whether to show the maintenance page.
// Returns ONLY what the storefront needs to render the maintenance page:
// the flag, the progress percentage and the plain-text message. The audit
// fields (updated_by, updated_by_name, updated_at) stay on the admin endpoint
// and are never served here, and no other app_settings key is exposed.
// Fails open via readMaintenanceConfig(), so a settings read error reports
// maintenance: false rather than taking the site down.
app.get("/api/system/status", async (req, res) => {
  const { maintenance, progress, message } = await maintenanceSettings.readMaintenanceConfig();
  res.json({ maintenance, progress, message });
});

app.get("/", (req, res) => {
  res.send("NeoFragrances API is running.");
});

// Liveness + database check for Render's health check. No authentication, and the
// response carries no connection, credential or driver detail — just whether the
// database answered. A failure is a 503 so the platform can act on it.
app.get("/api/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "ok" });
  } catch (err) {
    console.error("Health check failed:", err.code || err.message);
    res.status(503).json({ status: "unavailable", database: "unavailable" });
  }
});
// ---------- Google OAuth Configuration ----------
app.get("/api/config/google-client-id", (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(503).json({
      error: "Google Sign-In is not configured.",
    });
  }

  res.json({
    clientId: process.env.GOOGLE_CLIENT_ID,
  });
});

// ---------- Auth middleware: checks the login token on protected routes ----------
// Account Controls (Phase 4). A valid signature is no longer sufficient: a
// token lives for 7 days and an account can be disabled inside that window, so
// the account behind the token is checked too (cached, see accounts.js).
//
// Two rejections, one code. ACCOUNT_DISABLED covers both "this account is
// disabled" and "this token was invalidated by a disable", because to a client
// they are the same event: the session is over and a fresh login is required.
// The messages differ so the customer is told something true in each case.
const ACCOUNT_DISABLED_MESSAGE = "Your account has been disabled. Please contact support if you think this is a mistake.";
const SESSION_INVALIDATED_MESSAGE = "Your session is no longer valid. Please log in again.";

// Session lifetimes (ADMIN-3). Picked from the DATABASE role at sign-in, so an
// administrator gets a working-day session on every sign-in path (password and
// Google); every other account keeps the 7-day session it always had. The claims
// are unchanged: { id, role, v } — v is users.token_version, checked by authenticate().
const ADMIN_TOKEN_TTL = "12h";
const CUSTOMER_TOKEN_TTL = "7d";
function signSessionToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, v: Number(user.token_version) || 0 },
    process.env.JWT_SECRET,
    { expiresIn: user.role === "admin" ? ADMIN_TOKEN_TTL : CUSTOMER_TOKEN_TTL }
  );
}

// `allowDisabled` is used by exactly ONE route: settling a payment the customer
// has already been charged for. Nothing else may opt out.
function authenticate({ allowDisabled }) {
  return async function (req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ error: "You must be logged in." });
    }
    const token = authHeader.split(" ")[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: "Your session has expired. Please log in again." });
    }
    req.user = decoded; // { id, role, v? } - only .id is ever trusted for authorization
    if (allowDisabled) return next();

    const status = await accounts.readAccountStatus(decoded.id);
    if (status.disabled) {
      return res.status(401).json({ error: ACCOUNT_DISABLED_MESSAGE, code: "ACCOUNT_DISABLED" });
    }
    // token_version is incremented on disable and never reset, so a token
    // minted before the account was last disabled stays dead even after it is
    // re-enabled - that is what forces a fresh login.
    //
    // An ABSENT claim reads as 0. Tokens issued before migration 005 carry no
    // `v`, and every user starts at token_version 0, so they still match and
    // nobody is logged out by the upgrade.
    //
    // tokenVersion === null means the status lookup failed with nothing cached
    // (accounts.js fail-open). Comparing against it would reject every token
    // with a non-zero version, which would be failing closed by accident.
    if (status.tokenVersion !== null && Number(decoded.v ?? 0) !== status.tokenVersion) {
      return res.status(401).json({ error: SESSION_INVALIDATED_MESSAGE, code: "ACCOUNT_DISABLED" });
    }
    next();
  };
}

const requireAuth = authenticate({ allowDisabled: false });
const requireAuthAllowDisabled = authenticate({ allowDisabled: true });

// ---------- Products ----------
app.get("/api/products", async (req, res) => {
  try {
    const [rows] = await pool.query(
      "SELECT * FROM products WHERE deleted_at IS NULL"
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong fetching products." });
  }
});

// ---------- Login + registration rate limits ----------
// In-memory and per process (rate-limit.js). Keyed on req.ip, which Express derives
// using the "trust proxy" setting above: with 1 trusted hop it is the last
// X-Forwarded-For entry added by the proxy in front of us. That is only correct if
// Render really adds exactly one hop — verify on staging before production. Locally,
// with no proxy in front, a client can choose its own X-Forwarded-For value.
//
// Login counts FAILED attempts only (HTTP 401: unknown email or wrong password):
//   Tier A: 5 per 15 minutes per IP + normalised email, cleared by a successful login;
//   Tier B: 30 per 15 minutes per IP across all emails, never cleared by a success.
// Registration counts every attempt that reaches it: 10 per hour per IP, checked
// before validation, the MX lookup, the database and the verification email.
// maxKeys bounds memory: once full, the least recently used key is dropped.
const RATE_LIMIT_MAX_KEYS = 50000;
const RATE_LIMITED_MESSAGE = "Too many attempts. Please wait a few minutes and try again.";
const loginThrottle = createLoginThrottle({ windowMs: 15 * 60 * 1000, perAccountMax: 5, perIpMax: 30, maxKeys: RATE_LIMIT_MAX_KEYS });
const registerLimiter = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 10, maxKeys: RATE_LIMIT_MAX_KEYS });

function sendRateLimited(res, retryAfterSeconds) {
  res.set("Retry-After", String(Math.max(1, retryAfterSeconds)));
  return res.status(429).json({ error: RATE_LIMITED_MESSAGE, code: "RATE_LIMITED" });
}

// One canonical form for every email the API receives (G-8): surrounding spaces removed and
// lower-cased; anything that is not text becomes "" and fails the usual "required" check.
// Lookups compare LOWER(email), so accounts stored with capitals by older code still match
// whatever the column's collation is (production TiDB's has not been verified).
const normalizeEmail = v => (typeof v === "string" ? v.trim().toLowerCase() : "");

// G-9 (2026-11-14): one minimum for every NEW password — registration, password reset
// and password change. Login never checks it, so existing accounts whose passwords were
// set under the old 6-character rule keep signing in.
const MIN_PASSWORD_LENGTH = 8;

// ---------- Register ----------
app.post("/api/register", async (req, res) => {
  // Before anything else: every attempt that gets past this line counts, valid or not.
  const registerKey = String(req.ip || "unknown").slice(0, 64);
  if (registerLimiter.isLimited(registerKey)) return sendRateLimited(res, registerLimiter.retryAfterSeconds(registerKey));
  registerLimiter.record(registerKey);

  const { fullName, phone, password } = req.body;
  const email = normalizeEmail(req.body.email);

  if (!fullName || !email || !password) {
    return res.status(400).json({ error: "Full name, email, and password are required." });
  }
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }

  const mailServerOk = await domainHasMailServer(email);
  if (!mailServerOk) {
    return res.status(400).json({ error: "We couldn't find a mail server for that email address. Please check it and try again." });
  }

  try {
    const [existing] = await pool.query("SELECT id FROM users WHERE LOWER(email) = ?", [email]);
    if (existing.length > 0) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const [result] = await pool.query(
      "INSERT INTO users (full_name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, 'customer')",
      [fullName, email, phone || null, passwordHash]
    );

    const userId = result.insertId;

    // Account is created but NOT logged in yet — email must be verified first.
    await sendNewVerificationEmail({ userId, email, fullName });

    res.status(201).json({
      message: "Account created! Please check your email to verify your address before logging in.",
      requiresVerification: true,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong creating your account." });
  }
});

// ---------- Login ----------
app.post("/api/login", async (req, res) => {
  const { password } = req.body;
  const email = normalizeEmail(req.body.email);

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  // Both tiers are checked before the account lookup and the password check, so a
  // blocked request costs nothing and reveals nothing about the account.
  const throttle = loginThrottle.check(req.ip, email);
  if (throttle.limited) return sendRateLimited(res, throttle.retryAfter);

  try {
    const [rows] = await pool.query("SELECT * FROM users WHERE LOWER(email) = ?", [email]);
    if (rows.length === 0) {
      loginThrottle.recordFailure(req.ip, email);
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      loginThrottle.recordFailure(req.ip, email);
      return res.status(401).json({ error: "Invalid email or password." });
    }

    if (!user.email_verified_at) {
      return res.status(403).json({
        error: "Please verify your email before logging in. Check your inbox for the verification link.",
        requiresVerification: true,
      });
    }

    // Account Controls: refuse before a token is minted. 403 mirrors the
    // unverified-email case above, which is the established shape for "your
    // credentials were right but you may not sign in".
    if (user.disabled_at) {
      return res.status(403).json({ error: ACCOUNT_DISABLED_MESSAGE, code: "ACCOUNT_DISABLED" });
    }

    const token = signSessionToken(user);

    // Success clears Tier A for this IP + email only; Tier B is left to expire.
    loginThrottle.recordSuccess(req.ip, email);
    res.json({
      token,
      user: { id: user.id, full_name: user.full_name, email: user.email, role: user.role },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong logging you in." });
  }
});
// ---------- Google Login ----------
app.post("/api/auth/google", async (req, res) => {
  const { credential } = req.body;

  if (!credential) {
    return res.status(400).json({
      error: "Google credential is required.",
    });
  }

  if (!GOOGLE_CLIENT_ID) {
    return res.status(500).json({
      error: "Google Sign-In is not configured on the server.",
    });
  }

  try {
    // Verify the Google ID token
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();

    if (!payload) {
      return res.status(401).json({
        error: "Invalid Google account information.",
      });
    }

    const {
      sub: googleId,
      email,
      name,
      picture,
      email_verified,
    } = payload;

    // Make sure Google verified the email
    if (!email || !email_verified) {
      return res.status(401).json({
        error: "Your Google email could not be verified.",
      });
    }

    const normalizedEmail = normalizeEmail(email);

    // Check if this email already has a NeoFragrances account
    const [existingUsers] = await pool.query(
      "SELECT * FROM users WHERE LOWER(email) = ?",
      [normalizedEmail]
    );

    let user;

    if (existingUsers.length > 0) {
      // Existing NeoFragrances account
      user = existingUsers[0];

      // Account Controls: same refusal as local login. The lookup above is by
      // email, which is UNIQUE, so a disabled account is always found here and
      // can never fall through to the branch below and be recreated.
      if (user.disabled_at) {
        return res.status(403).json({ error: ACCOUNT_DISABLED_MESSAGE, code: "ACCOUNT_DISABLED" });
      }

      console.log(
        `Google login: existing user ${user.email}`
      );
    } else {
      // Create a new NeoFragrances customer account
      //
      // Google accounts don't need a local password.
      // We generate a random password hash because your
      // current users table expects password_hash.
      const randomPassword = crypto.randomBytes(32).toString("hex");
      const passwordHash = await bcrypt.hash(randomPassword, 10);

      // Google has already verified this email address (checked above via
      // email_verified from the ID token), so this account skips the
      // email-verification-link flow entirely.
      const [result] = await pool.query(
        `INSERT INTO users
          (full_name, email, phone, password_hash, role, email_verified_at, auth_provider, google_id)
         VALUES (?, ?, ?, ?, 'customer', NOW(), 'google', ?)`,
        [
          name || "NeoFragrances Customer",
          normalizedEmail,
          null,
          passwordHash,
          googleId || null,
        ]
      );

      user = {
        id: result.insertId,
        full_name: name || "NeoFragrances Customer",
        email: normalizedEmail,
        role: "customer",
      };

      console.log(
        `Google login: created new user ${normalizedEmail}`
      );
    }

    // Same JWT as normal NeoFragrances login, including its role-based lifetime.
    // A user created moments ago has no token_version property on the literal
    // built above; signSessionToken reads it as 0, the column default.
    const token = signSessionToken(user);

    res.json({
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        role: user.role,
        picture: picture || null,
      },
    });
  } catch (err) {
    console.error("Google authentication error:", err);

    res.status(401).json({
      error: "Google sign-in failed. Please try again.",
    });
  }
});
// ---------- Checkout ----------
// Disabled: this endpoint created orders without any payment. All orders are
// now created only by /api/payments/verify after Paystack confirms payment.
app.post("/api/checkout", requireAuth, (req, res) => {
  res.status(410).json({ error: "Checkout now happens through secure payment.", code: "CHECKOUT_DISABLED" });
});

// ---------- A logged-in customer's own order history ----------
app.get("/api/my-orders", requireAuth, async (req, res) => {
  try {
    // Only this customer's orders; the delivery address is joined on the same user.
    const [orders] = await pool.query(
      `SELECT o.id, o.total, o.status, o.payment_reference, o.created_at, o.updated_at, o.address_id,
              a.label AS address_label, a.full_name AS address_full_name, a.phone AS address_phone,
              a.address_line1, a.address_line2, a.city AS address_city, a.region AS address_region, a.country AS address_country
         FROM orders o
         LEFT JOIN addresses a ON a.id = o.address_id AND a.user_id = o.user_id
        WHERE o.user_id = ?
        ORDER BY o.created_at DESC, o.id DESC`,
      [req.user.id]
    );
    if (orders.length === 0) return res.json([]);

    const orderIds = orders.map(o => o.id);
    const [items] = await pool.query(
      `SELECT order_items.order_id, order_items.product_id, order_items.quantity, order_items.price_at_purchase,
              products.name, products.brand, products.image, (products.deleted_at IS NULL) AS available
       FROM order_items
       JOIN products ON order_items.product_id = products.id
       WHERE order_items.order_id IN (?)
       ORDER BY order_items.id`,
      [orderIds]
    );

    const itemsByOrder = {};
    items.forEach(item => {
      if (!itemsByOrder[item.order_id]) itemsByOrder[item.order_id] = [];
      itemsByOrder[item.order_id].push(item);
    });

    res.json(orders.map(o => ({ ...o, items: itemsByOrder[o.id] || [] })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not fetch your orders." });
  }
});

// ---------- A customer's own order: status history ----------
// Customer-safe view of order_status_history: statuses and times only. Who made a
// change, the internal note and the raw source are admin-only and never leave here.
// A "tracking_started" entry is the migration-006 baseline: the status the order had
// when history began, recorded at that moment — not when the order reached it.
app.get("/api/my-orders/:id/history", requireAuth, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: "Order not found." });
  try {
    const [orders] = await pool.query("SELECT id, status, created_at FROM orders WHERE id = ? AND user_id = ?", [id, req.user.id]);
    if (!orders.length) return res.status(404).json({ error: "Order not found." });
    const [rows] = await pool.query(
      "SELECT from_status, to_status, source, created_at FROM order_status_history WHERE order_id = ? ORDER BY id", [id]);
    res.json({
      order_id: orders[0].id,
      status: orders[0].status,
      placed_at: orders[0].created_at,
      history: rows.map(r => ({
        type: r.source === "backfill" ? "tracking_started" : "status_change",
        from_status: r.source === "backfill" ? null : r.from_status,
        status: r.to_status,
        at: r.created_at,
      })),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not fetch this order's history." });
  }
});
// ---------- Track Order (guest/customer lookup) ----------
app.post("/api/track-order", async (req, res) => {
  // Order numbers are sequential, so limit lookups per IP to stop guessing.
  if (trackOrderLimiter.limited(`ip:${req.ip}`)) {
    return res.status(429).json({ error: "Too many tracking attempts. Please wait a few minutes and try again.", code: "RATE_LIMITED" });
  }
  const { orderId, email } = req.body || {};

  if (!orderId || !email) {
    return res.status(400).json({
      error: "Order number and email address are required."
    });
  }
  const cleanOrderId = String(orderId).trim().replace(/^#/, "");
  if (!isPositiveId(cleanOrderId) || typeof email !== "string" || email.length > 150) {
    return res.status(404).json({ error: "We could not find an order matching that order number and email address." });
  }

  try {
    // Find the order and verify that the supplied email
    // belongs to the customer who placed the order.
    const [orders] = await pool.query(
      `SELECT orders.id,
              orders.status,
              orders.total,
              orders.created_at,
              users.email
       FROM orders
       JOIN users ON orders.user_id = users.id
       WHERE orders.id = ?
         AND LOWER(users.email) = LOWER(?)`,
      [Number(cleanOrderId), email.trim()]
    );

    if (orders.length === 0) {
      return res.status(404).json({
        error: "We could not find an order matching that order number and email address."
      });
    }

    const order = orders[0];

    // Get the products/items belonging to this order
    const [items] = await pool.query(
      `SELECT order_items.quantity,
              order_items.price_at_purchase,
              products.name
       FROM order_items
       JOIN products ON order_items.product_id = products.id
       WHERE order_items.order_id = ?`,
      [order.id]
    );

    res.json({
      id: order.id,
      status: order.status,
      total: order.total,
      created_at: order.created_at,
      items
    });

  } catch (err) {
    console.error("Track order error:", err);

    res.status(500).json({
      error: "Something went wrong while tracking your order."
    });
  }
});
// ---------- Auth middleware: admin-only routes ----------
// The role is re-read from the database on every admin request, so a demoted or
// deleted account loses admin access immediately rather than when its token expires.
function requireAdmin(req, res, next) {
  requireAuth(req, res, async () => {
    try {
      const [rows] = await pool.query("SELECT role FROM users WHERE id = ?", [req.user.id]);
      if (!rows.length) return res.status(401).json({ error: "Your session has expired. Please log in again." });
      if (rows[0].role !== "admin") return res.status(403).json({ error: "Admin access only." });
      next();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: "Could not verify admin access." });
    }
  });
}

// ---------- Admin: shared rules ----------
const LOW_STOCK_THRESHOLD = 5;          // "low stock" = 1..5 units (0 = out of stock)
const MAX_STOCK_QTY = 100000;
const PRODUCT_CATEGORIES = ["men", "women", "unisex"];
// products.scent_family (migration 008). NULL = unassigned. Only the owner assigns a
// family, through the admin endpoints below; nothing infers one from a product's name.
const SCENT_FAMILIES = ["floral", "amber", "fresh", "woody"];
const MAX_SCENT_FAMILY_BATCH = 100;
const ORDER_STATUSES = ["Pending", "Processing", "Shipped", "Delivered", "Cancelled"];
const OFFER_TYPES = ["discount", "flash_sale", "new_arrival", "bestseller", "limited"];
// Images are served from the frontend's images/ folder; only plain relative paths are accepted.
const IMAGE_PATH_PATTERN = /^images\/[A-Za-z0-9 ._()\/-]{1,240}$/;

// Stock must be a whole number >= 0 (rejects "", null, "true", 2.5, -1).
function isValidStockQty(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return false;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= MAX_STOCK_QTY;
}

function adminText(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function isValidImagePath(value) {
  return IMAGE_PATH_PATTERN.test(value) && !value.includes("..") && !value.includes("//");
}

// Validates a full product body (create + edit). Returns { error, field } or { values }.
function validateProductBody(body) {
  const name = adminText(body.name), brand = adminText(body.brand), category = adminText(body.category).toLowerCase();
  const badge = adminText(body.badge), image = adminText(body.image), description = adminText(body.description);
  const notes = ["top_notes", "middle_notes", "base_notes"].map(k => adminText(body[k]));
  const price = Number(body.price);
  if (!name || name.length > 150) return { field: "name", error: "Name is required (up to 150 characters)." };
  if (!brand || brand.length > 100) return { field: "brand", error: "Brand is required (up to 100 characters)." };
  if (!PRODUCT_CATEGORIES.includes(category)) return { field: "category", error: "Category must be men, women or unisex." };
  if (body.price === "" || body.price === null || body.price === undefined || !Number.isFinite(price) || price <= 0 || price > 1000000 || !hasAtMost2dp(price)) {
    return { field: "price", error: "Price must be more than 0 with at most 2 decimal places." };
  }
  if (badge.length > 20) return { field: "badge", error: "Badge must be 20 characters or fewer." };
  if (image && !isValidImagePath(image)) return { field: "image", error: "Image must be a path inside images/, e.g. images/perfumes/name.jpg." };
  if (description.length > 5000) return { field: "description", error: "Description must be 5000 characters or fewer." };
  const longNote = notes.findIndex(n => n.length > 255);
  if (longNote !== -1) return { field: ["top_notes", "middle_notes", "base_notes"][longNote], error: "Notes must be 255 characters or fewer." };
  return { values: { name, brand, category, price, badge: badge || null, image: image || null, description: description || null, top_notes: notes[0] || null, middle_notes: notes[1] || null, base_notes: notes[2] || null } };
}

// Scent family writes. The body must name scent_family explicitly: one of SCENT_FAMILIES
// (case-insensitive) or null to unassign. A missing key, "", any other string, numbers,
// booleans, arrays and objects are rejected, so a family is never cleared by accident.
// Returns { error, field } or { value }.
function parseScentFamilyBody(body) {
  const error = { field: "scent_family", error: "Scent family must be floral, amber, fresh or woody, or null to unassign it." };
  if (!body || typeof body !== "object" || Array.isArray(body) || !("scent_family" in body)) return error;
  const v = body.scent_family;
  if (v === null) return { value: null };
  if (typeof v === "string" && SCENT_FAMILIES.includes(v.trim().toLowerCase())) return { value: v.trim().toLowerCase() };
  return error;
}

// Account Controls: matches users.disabled_reason VARCHAR(200) (migration 005).
const ACCOUNT_REASON_MAX = 200;

function positiveIdParam(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) { res.status(404).json({ error: "Not found." }); return null; }
  return id;
}

// LIKE pattern with user wildcards escaped.
function likePattern(term) {
  return `%${term.replace(/[\\%_]/g, ch => "\\" + ch)}%`;
}

// Order status rules (Phase 5). Moving forward along the fulfilment flow needs no note.
// Cancelling is only possible before the order ships, restocks, and needs a note.
// Moving backward (a correction) needs a note. A cancelled order is final.
const ORDER_FLOW = ["Pending", "Processing", "Shipped", "Delivered"];
const CANCELLABLE_STATUSES = ["Pending", "Processing"];
// Matches order_status_history.note VARCHAR(500) (migration 006).
const ORDER_NOTE_MAX = 500;

// Returns null when current -> next is allowed, else { status, code, error }.
// The same-status no-op is handled by the caller before this is consulted.
function orderTransitionError(current, next) {
  if (current === "Cancelled") return { status: 409, code: "ORDER_FINAL", error: "This order was cancelled and can't be changed." };
  if (next === "Cancelled" && !CANCELLABLE_STATUSES.includes(current)) {
    return { status: 409, code: "ORDER_NOT_CANCELLABLE", error: `This order is already ${current.toLowerCase()}, so it can't be cancelled.` };
  }
  return null;
}

function orderTransitionNeedsNote(current, next) {
  return next === "Cancelled" || ORDER_FLOW.indexOf(next) < ORDER_FLOW.indexOf(current);
}

function allowedNextStatuses(current) {
  return ORDER_STATUSES.filter(s => s !== current && !orderTransitionError(current, s));
}

// ---------- Admin: dashboard summary ----------
app.get("/api/admin/summary", requireAdmin, async (req, res) => {
  try {
    const [[products]] = await pool.query(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(deleted_at IS NULL), 0) AS active,
              COALESCE(SUM(deleted_at IS NOT NULL), 0) AS archived,
              COALESCE(SUM(deleted_at IS NULL AND stock_qty = 0), 0) AS out_of_stock,
              COALESCE(SUM(deleted_at IS NULL AND stock_qty BETWEEN 1 AND ?), 0) AS low_stock
         FROM products`, [LOW_STOCK_THRESHOLD]);
    const [statusRows] = await pool.query("SELECT status, COUNT(*) AS n, COALESCE(SUM(total), 0) AS amount FROM orders GROUP BY status");
    const [[recent30]] = await pool.query(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue
         FROM orders WHERE status <> 'Cancelled' AND created_at >= NOW() - INTERVAL 30 DAY`);
    const [[customers]] = await pool.query(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(email_verified_at IS NOT NULL), 0) AS verified,
              COALESCE(SUM(created_at >= NOW() - INTERVAL 30 DAY), 0) AS new_30d
         FROM users WHERE role = 'customer'`);
    const [offerRows] = await pool.query("SELECT start_at, end_at, active FROM offers");
    const [[reviews]] = await pool.query("SELECT COUNT(*) AS total, AVG(rating) AS avg_rating FROM reviews");
    // Open payment issues for the admin badge. payment_issues comes from migration 009,
    // which may not be applied yet: ONLY "table doesn't exist" is tolerated (reported as
    // null); every other error still fails the summary exactly as before.
    let openPaymentIssues = null;
    try {
      const [[pi]] = await pool.query("SELECT COUNT(*) AS n FROM payment_issues WHERE status = 'open'");
      openPaymentIssues = Number(pi.n) || 0;
    } catch (err) {
      if (!(err && (err.code === "ER_NO_SUCH_TABLE" || err.errno === 1146))) throw err;
    }
    const [recentOrders] = await pool.query(
      `SELECT o.id, o.total, o.status, o.created_at, u.full_name AS customer_name,
              (SELECT COALESCE(SUM(quantity), 0) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
         FROM orders o JOIN users u ON u.id = o.user_id
        ORDER BY o.created_at DESC, o.id DESC LIMIT 6`);
    const [lowStock] = await pool.query(
      `SELECT id, name, brand, image, stock_qty FROM products
        WHERE deleted_at IS NULL AND stock_qty BETWEEN 1 AND ?
        ORDER BY stock_qty ASC, name ASC LIMIT 8`, [LOW_STOCK_THRESHOLD]);
    const [recentReviews] = await pool.query(
      `SELECT r.id, r.rating, r.comment, r.created_at, r.is_verified_purchase,
              p.id AS product_id, p.name AS product_name, u.full_name AS customer_name
         FROM reviews r JOIN products p ON p.id = r.product_id JOIN users u ON u.id = r.user_id
        ORDER BY r.created_at DESC, r.id DESC LIMIT 5`);

    const byStatus = Object.fromEntries(ORDER_STATUSES.map(s => [s, 0]));
    let ordersTotal = 0, revenue = 0, paidOrders = 0;
    statusRows.forEach(r => {
      const n = Number(r.n);
      byStatus[r.status] = (byStatus[r.status] || 0) + n;
      ordersTotal += n;
      if (r.status !== "Cancelled") { revenue += Number(r.amount); paidOrders += n; }
    });
    const offerStatus = { Active: 0, Scheduled: 0, Expired: 0, Disabled: 0 };
    offerRows.forEach(o => { offerStatus[computeOfferStatus(o)]++; });
    const n = v => Number(v) || 0;

    res.json({
      low_stock_threshold: LOW_STOCK_THRESHOLD,
      products: { total: n(products.total), active: n(products.active), archived: n(products.archived), out_of_stock: n(products.out_of_stock), low_stock: n(products.low_stock) },
      orders: {
        total: ordersTotal, by_status: byStatus,
        revenue: Math.round(revenue * 100) / 100,
        average_order_value: paidOrders ? Math.round((revenue / paidOrders) * 100) / 100 : 0,
        last_30_days: { orders: n(recent30.orders), revenue: Math.round(Number(recent30.revenue) * 100) / 100 },
      },
      customers: { total: n(customers.total), verified: n(customers.verified), new_30d: n(customers.new_30d) },
      offers: { live: offerStatus.Active, scheduled: offerStatus.Scheduled, expired: offerStatus.Expired, disabled: offerStatus.Disabled },
      reviews: { total: n(reviews.total), average_rating: reviews.avg_rating === null ? null : Math.round(Number(reviews.avg_rating) * 10) / 10 },
      recent_orders: recentOrders.map(o => ({ ...o, item_count: n(o.item_count) })),
      low_stock_products: lowStock,
      recent_reviews: recentReviews,
      payment_issues: { open: openPaymentIssues },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load the dashboard." });
  }
});

// ---------- Admin: reports (real order data only) ----------
app.get("/api/admin/reports", requireAdmin, async (req, res) => {
  const days = [7, 30, 90, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  try {
    const [daily] = await pool.query(
      `SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS day, COUNT(*) AS orders, COALESCE(SUM(total), 0) AS revenue
         FROM orders WHERE status <> 'Cancelled' AND created_at >= CURDATE() - INTERVAL ? DAY
        GROUP BY day ORDER BY day`, [days - 1]);
    const itemsJoin = `FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
                       WHERE o.status <> 'Cancelled' AND o.created_at >= CURDATE() - INTERVAL ? DAY`;
    const [products] = await pool.query(
      `SELECT p.id, p.name, p.brand, p.image, (p.deleted_at IS NOT NULL) AS archived,
              SUM(oi.quantity) AS units, SUM(oi.quantity * oi.price_at_purchase) AS revenue
         ${itemsJoin} GROUP BY p.id ORDER BY units DESC, revenue DESC LIMIT 10`, [days - 1]);
    const [brands] = await pool.query(
      `SELECT p.brand, SUM(oi.quantity) AS units, SUM(oi.quantity * oi.price_at_purchase) AS revenue
         ${itemsJoin} GROUP BY p.brand ORDER BY revenue DESC LIMIT 10`, [days - 1]);
    const [categories] = await pool.query(
      `SELECT p.category, SUM(oi.quantity) AS units, SUM(oi.quantity * oi.price_at_purchase) AS revenue
         ${itemsJoin} GROUP BY p.category ORDER BY revenue DESC`, [days - 1]);
    const [statuses] = await pool.query(
      "SELECT status, COUNT(*) AS n FROM orders WHERE created_at >= CURDATE() - INTERVAL ? DAY GROUP BY status", [days - 1]);
    const [[custs]] = await pool.query(
      "SELECT COUNT(*) AS n FROM users WHERE role = 'customer' AND created_at >= CURDATE() - INTERVAL ? DAY", [days - 1]);
    const num = rows => rows.map(r => ({ ...r, units: Number(r.units) || 0, revenue: Math.round(Number(r.revenue) * 100) / 100, ...(r.orders !== undefined ? { orders: Number(r.orders) } : {}), ...(r.archived !== undefined ? { archived: !!Number(r.archived) } : {}) }));
    res.json({
      days,
      daily: daily.map(d => ({ day: d.day, orders: Number(d.orders), revenue: Math.round(Number(d.revenue) * 100) / 100 })),
      top_products: num(products), brands: num(brands), categories: num(categories),
      statuses: Object.fromEntries(statuses.map(s => [s.status, Number(s.n)])),
      new_customers: Number(custs.n) || 0,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load reports." });
  }
});

// ---------- Admin: products (incl. archived) ----------
app.get("/api/admin/products", requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT p.*, COALESCE(s.units, 0) AS units_sold
         FROM products p
         LEFT JOIN (SELECT oi.product_id, SUM(oi.quantity) AS units
                      FROM order_items oi JOIN orders o ON o.id = oi.order_id
                     WHERE o.status <> 'Cancelled' GROUP BY oi.product_id) s ON s.product_id = p.id
        ORDER BY p.deleted_at IS NOT NULL, p.name`);
    res.json(rows.map(p => ({ ...p, units_sold: Number(p.units_sold) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not fetch products." });
  }
});

// ---------- Admin: Create Product ----------
app.post("/api/admin/products", requireAdmin, async (req, res) => {
  const v = validateProductBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error, field: v.field });
  const { stock_qty } = req.body;
  if (stock_qty !== undefined && !isValidStockQty(stock_qty)) {
    return res.status(400).json({ error: `Stock quantity must be a whole number from 0 to ${MAX_STOCK_QTY}.`, field: "stock_qty" });
  }
  const p = v.values;
  try {
    const [result] = await pool.query(
      `INSERT INTO products (name, brand, category, price, stock_qty, badge, image, description, top_notes, middle_notes, base_notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [p.name, p.brand, p.category, p.price, stock_qty === undefined ? 0 : Number(stock_qty), p.badge, p.image, p.description, p.top_notes, p.middle_notes, p.base_notes]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not create product." });
  }
});

// ---------- Admin: Update Product ----------
app.put("/api/admin/products/:id", requireAdmin, async (req, res) => {
  const id = positiveIdParam(req, res); if (!id) return;
  const v = validateProductBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error, field: v.field });
  // stock_qty is only updated when sent (the admin form omits it unless changed),
  // so editing other fields can never overwrite or zero the current stock.
  const setStock = "stock_qty" in req.body;
  if (setStock && !isValidStockQty(req.body.stock_qty)) {
    return res.status(400).json({ error: `Stock quantity must be a whole number from 0 to ${MAX_STOCK_QTY}.`, field: "stock_qty" });
  }
  const p = v.values;
  try {
    const [result] = await pool.query(
      `UPDATE products SET name=?, brand=?, category=?, price=?, ${setStock ? "stock_qty=?, " : ""}badge=?, image=?, description=?, top_notes=?, middle_notes=?, base_notes=? WHERE id=?`,
      [p.name, p.brand, p.category, p.price, ...(setStock ? [Number(req.body.stock_qty)] : []), p.badge, p.image, p.description, p.top_notes, p.middle_notes, p.base_notes, id]
    );
    if (!result.affectedRows) return res.status(404).json({ error: "Product not found." });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update product." });
  }
});

// ---------- Admin: Archive Product (soft-delete) ----------
app.delete("/api/admin/products/:id", requireAdmin, async (req, res) => {
  const id = positiveIdParam(req, res); if (!id) return;
  try {
    const [result] = await pool.query("UPDATE products SET deleted_at = NOW() WHERE id = ? AND deleted_at IS NULL", [id]);
    if (!result.affectedRows) return res.status(404).json({ error: "Product not found or already archived." });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not archive product." });
  }
});

// ---------- Admin: Restore archived Product ----------
app.patch("/api/admin/products/:id/restore", requireAdmin, async (req, res) => {
  const id = positiveIdParam(req, res); if (!id) return;
  try {
    const [result] = await pool.query("UPDATE products SET deleted_at = NULL WHERE id = ? AND deleted_at IS NOT NULL", [id]);
    if (!result.affectedRows) return res.status(404).json({ error: "Product not found or not archived." });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not restore product." });
  }
});

// ---------- Admin: Update Stock (set a quantity, or adjust by +/- n) ----------
app.patch("/api/admin/products/:id/stock", requireAdmin, async (req, res) => {
  const id = positiveIdParam(req, res); if (!id) return;
  const { stock_qty, adjust } = req.body;
  try {
    let result;
    if (adjust !== undefined) {
      const delta = Number(adjust);
      if (typeof adjust === "boolean" || adjust === "" || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > MAX_STOCK_QTY) {
        return res.status(400).json({ error: "Adjustment must be a non-zero whole number." });
      }
      // Atomic: never lets stock drop below 0 or exceed the maximum.
      [result] = await pool.query(
        "UPDATE products SET stock_qty = stock_qty + ? WHERE id = ? AND stock_qty + ? BETWEEN 0 AND ?",
        [delta, id, delta, MAX_STOCK_QTY]);
      if (!result.affectedRows) {
        const [exists] = await pool.query("SELECT stock_qty FROM products WHERE id = ?", [id]);
        if (!exists.length) return res.status(404).json({ error: "Product not found." });
        return res.status(400).json({ error: `That would take stock below 0 (currently ${exists[0].stock_qty}).`, code: "NEGATIVE_STOCK" });
      }
    } else {
      if (!isValidStockQty(stock_qty)) {
        return res.status(400).json({ error: `Stock quantity must be a whole number from 0 to ${MAX_STOCK_QTY}.` });
      }
      [result] = await pool.query("UPDATE products SET stock_qty = ? WHERE id = ?", [Number(stock_qty), id]);
      if (!result.affectedRows) return res.status(404).json({ error: "Product not found." });
    }
    const [[row]] = await pool.query("SELECT stock_qty FROM products WHERE id = ?", [id]);
    res.json({ success: true, stock_qty: row.stock_qty });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update stock." });
  }
});

// ---------- Admin: Scent family (one product) ----------
// Writes products.scent_family only. "updated_at = updated_at" keeps the row's last-updated
// time as it was (the column has ON UPDATE CURRENT_TIMESTAMP): classifying a product is
// not an edit of its details. Archived products are refused, so restore one first.
app.patch("/api/admin/products/:id/scent-family", requireAdmin, async (req, res) => {
  const id = positiveIdParam(req, res); if (!id) return;
  const family = parseScentFamilyBody(req.body);
  if (family.error) return res.status(400).json({ error: family.error, field: family.field });
  try {
    const [rows] = await pool.query("SELECT id, deleted_at FROM products WHERE id = ?", [id]);
    if (!rows.length) return res.status(404).json({ error: "Product not found." });
    // 409 (well formed but refused), per the admin convention; never 403, which the admin
    // portal reads as an expired session.
    if (rows[0].deleted_at) return res.status(409).json({ error: "This product is archived. Restore it before changing its scent family.", code: "PRODUCT_ARCHIVED" });
    const [result] = await pool.query(
      "UPDATE products SET scent_family = ?, updated_at = updated_at WHERE id = ? AND deleted_at IS NULL",
      [family.value, id]);
    // Matched rows (mysql2 sets FOUND_ROWS), so re-saving the same family still counts as 1.
    if (!result.affectedRows) return res.status(404).json({ error: "Product not found." });
    res.json({ success: true, id, scent_family: family.value });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update the scent family." });
  }
});

// ---------- Admin: Scent family (bulk, all-or-nothing) ----------
// Body: { product_ids: [1..100 distinct positive ids], scent_family: "<family>" | null }.
// Every id is checked inside one transaction (rows locked) before anything is written; a
// missing or archived product (400, listed like offer items are), or any failure while
// writing (500), rolls the whole batch back.
app.patch("/api/admin/products/scent-family", requireAdmin, async (req, res) => {
  const body = req.body;
  const raw = body && typeof body === "object" ? body.product_ids : undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    return res.status(400).json({ error: "Choose at least one product.", field: "product_ids" });
  }
  if (raw.length > MAX_SCENT_FAMILY_BATCH) {
    return res.status(400).json({ error: `At most ${MAX_SCENT_FAMILY_BATCH} products can be updated at once.`, field: "product_ids" });
  }
  const ids = raw.map(v => (typeof v === "boolean" || v === null || v === "" ? NaN : Number(v)));
  if (!ids.every(n => Number.isInteger(n) && n > 0)) {
    return res.status(400).json({ error: "Product IDs must be positive whole numbers.", field: "product_ids" });
  }
  if (new Set(ids).size !== ids.length) {
    return res.status(400).json({ error: "Each product can only be listed once.", field: "product_ids" });
  }
  const family = parseScentFamilyBody(body);
  if (family.error) return res.status(400).json({ error: family.error, field: family.field });

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query("SELECT id, deleted_at FROM products WHERE id IN (?) FOR UPDATE", [ids]);
    const found = new Map(rows.map(r => [r.id, r]));
    const missing = ids.filter(n => !found.has(n));
    const archived = ids.filter(n => found.has(n) && found.get(n).deleted_at);
    if (missing.length || archived.length) {
      await connection.rollback();
      return res.status(400).json({
        error: "Nothing was changed: some products don't exist or are archived.",
        field: "product_ids", code: "INELIGIBLE_PRODUCTS", missing, archived,
      });
    }
    const [result] = await connection.query(
      "UPDATE products SET scent_family = ?, updated_at = updated_at WHERE id IN (?) AND deleted_at IS NULL",
      [family.value, ids]);
    if (result.affectedRows !== ids.length) throw new Error(`scent-family batch matched ${result.affectedRows} of ${ids.length} rows`);
    await connection.commit();
    res.json({ success: true, updated: ids.length, scent_family: family.value, product_ids: ids });
  } catch (err) {
    await connection.rollback().catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Could not update scent families. Nothing was changed." });
  } finally {
    connection.release();
  }
});

// ---------- Admin: orders (filtered + paginated) ----------
app.get("/api/admin/orders", requireAdmin, async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(1000, Math.max(1, parseInt(req.query.pageSize, 10) || 25));
  const where = [], params = [];
  const status = adminText(req.query.status);
  if (status && status !== "all") {
    if (!ORDER_STATUSES.includes(status)) return res.status(400).json({ error: "Invalid status filter." });
    where.push("o.status = ?"); params.push(status);
  }
  const q = adminText(req.query.q).replace(/^#/, "").slice(0, 100);
  if (q) {
    const like = likePattern(q);
    where.push("(o.id = ? OR u.full_name LIKE ? OR u.email LIKE ? OR o.payment_reference LIKE ?)");
    params.push(/^\d+$/.test(q) ? Number(q) : -1, like, like, like);
  }
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (datePattern.test(adminText(req.query.from))) { where.push("o.created_at >= ?"); params.push(`${req.query.from} 00:00:00`); }
  if (datePattern.test(adminText(req.query.to))) { where.push("o.created_at <= ?"); params.push(`${req.query.to} 23:59:59`); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  try {
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM orders o JOIN users u ON u.id = o.user_id ${whereSql}`, params);
    const [orders] = await pool.query(
      `SELECT o.id, o.total, o.status, o.payment_reference, o.created_at, o.updated_at,
              u.id AS customer_id, u.full_name AS customer_name, u.email AS customer_email, u.phone AS customer_phone,
              a.city, a.region,
              (SELECT COALESCE(SUM(quantity), 0) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
         FROM orders o
         JOIN users u ON u.id = o.user_id
         LEFT JOIN addresses a ON a.id = o.address_id
         ${whereSql}
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT ? OFFSET ?`, [...params, pageSize, (page - 1) * pageSize]);
    const [counts] = await pool.query("SELECT status, COUNT(*) AS n FROM orders GROUP BY status");
    res.json({
      orders: orders.map(o => ({ ...o, item_count: Number(o.item_count) })),
      total: Number(total), page, pageSize,
      status_counts: Object.fromEntries(ORDER_STATUSES.map(s => [s, Number((counts.find(c => c.status === s) || {}).n || 0)])),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not fetch orders." });
  }
});

// ---------- Admin: order details ----------
app.get("/api/admin/orders/:id", requireAdmin, async (req, res) => {
  const id = positiveIdParam(req, res); if (!id) return;
  try {
    const [rows] = await pool.query(
      `SELECT o.id, o.total, o.status, o.payment_reference, o.created_at, o.updated_at, o.address_id,
              u.id AS customer_id, u.full_name AS customer_name, u.email AS customer_email, u.phone AS customer_phone,
              u.created_at AS customer_since,
              a.full_name AS delivery_name, a.phone AS delivery_phone, a.address_line1, a.address_line2,
              a.city, a.region, a.country, a.label AS address_label
         FROM orders o
         JOIN users u ON u.id = o.user_id
         LEFT JOIN addresses a ON a.id = o.address_id
        WHERE o.id = ?`, [id]);
    if (!rows.length) return res.status(404).json({ error: "Order not found." });
    const [items] = await pool.query(
      `SELECT oi.product_id, oi.quantity, oi.price_at_purchase,
              p.name, p.brand, p.image, p.stock_qty, (p.deleted_at IS NOT NULL) AS archived
         FROM order_items oi LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ? ORDER BY oi.id`, [id]);
    const [[{ customer_orders }]] = await pool.query("SELECT COUNT(*) AS customer_orders FROM orders WHERE user_id = ?", [rows[0].customer_id]);
    const [history] = await pool.query(
      `SELECT h.id, h.from_status, h.to_status, h.changed_by, u.full_name AS changed_by_name,
              h.source, h.note, h.created_at
         FROM order_status_history h LEFT JOIN users u ON u.id = h.changed_by
        WHERE h.order_id = ? ORDER BY h.id`, [id]);
    const order = rows[0];
    const allowed = allowedNextStatuses(order.status);
    res.json({
      ...order,
      customer_orders: Number(customer_orders),
      items: items.map(i => ({ ...i, archived: !!Number(i.archived) })),
      items_subtotal: Math.round(items.reduce((s, i) => s + Number(i.price_at_purchase) * i.quantity, 0) * 100) / 100,
      allowed_statuses: allowed,
      note_required_statuses: allowed.filter(s => orderTransitionNeedsNote(order.status, s)),
      status_history: history,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not fetch the order." });
  }
});

// ---------- Admin: Update order status ----------
// Cancelling (Pending/Processing only) returns the order's items to stock in the same
// transaction, and is final. Every real change writes one order_status_history row in
// that transaction too, so the status, the restock and the history commit or roll back together.
app.patch("/api/admin/orders/:id/status", requireAdmin, async (req, res) => {
  const id = positiveIdParam(req, res); if (!id) return;
  const { status, note: rawNote } = req.body || {};
  if (!ORDER_STATUSES.includes(status)) {
    return res.status(400).json({ error: "Invalid status." });
  }
  if (rawNote !== undefined && rawNote !== null && typeof rawNote !== "string") {
    return res.status(400).json({ error: "Note must be text.", field: "note" });
  }
  const note = adminText(rawNote);
  if (note.length > ORDER_NOTE_MAX) {
    return res.status(400).json({ error: `Note must be ${ORDER_NOTE_MAX} characters or fewer.`, field: "note" });
  }
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query("SELECT status FROM orders WHERE id = ? FOR UPDATE", [id]);
    if (!rows.length) { await connection.rollback(); return res.status(404).json({ error: "Order not found." }); }
    const current = rows[0].status;
    if (current === status) { await connection.rollback(); return res.json({ success: true, status, restocked: 0 }); }
    const rejected = orderTransitionError(current, status);
    if (rejected) {
      await connection.rollback();
      return res.status(rejected.status).json({ error: rejected.error, code: rejected.code });
    }
    if (!note && orderTransitionNeedsNote(current, status)) {
      await connection.rollback();
      return res.status(400).json({
        error: status === "Cancelled" ? "Add a note explaining why this order is being cancelled." : `Add a note explaining why this order is moving back to ${status}.`,
        code: "NOTE_REQUIRED", field: "note",
      });
    }
    let restocked = 0;
    if (status === "Cancelled") {
      const [result] = await connection.query(
        `UPDATE products p
           JOIN (SELECT product_id, SUM(quantity) AS qty FROM order_items WHERE order_id = ? GROUP BY product_id) x
             ON x.product_id = p.id
            SET p.stock_qty = p.stock_qty + x.qty`, [id]);
      restocked = result.affectedRows;
    }
    await connection.query("UPDATE orders SET status = ? WHERE id = ?", [status, id]);
    await connection.query(
      `INSERT INTO order_status_history (order_id, from_status, to_status, changed_by, source, note)
       VALUES (?, ?, ?, ?, 'admin', ?)`, [id, current, status, req.user.id, note || null]);
    await connection.commit();
    res.json({ success: true, status, restocked });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ error: "Could not update order status." });
  } finally {
    connection.release();
  }
});

// ---------- Admin: customers ----------
app.get("/api/admin/customers", requireAdmin, async (req, res) => {
  try {
    const [customers] = await pool.query(`
      SELECT u.id, u.full_name, u.email, u.phone, u.created_at, u.auth_provider,
             u.disabled_at,
             (u.email_verified_at IS NOT NULL) AS email_verified,
             COUNT(o.id) AS order_count,
             COALESCE(SUM(CASE WHEN o.status <> 'Cancelled' THEN o.total ELSE 0 END), 0) AS total_spent,
             MAX(o.created_at) AS last_order_at
        FROM users u
        LEFT JOIN orders o ON o.user_id = u.id
       WHERE u.role = 'customer'
       GROUP BY u.id
       ORDER BY u.created_at DESC
    `);
    // disabled_reason is deliberately NOT in the list payload: the list is a
    // scanning view, and the reason belongs next to the account it explains.
    res.json(customers.map(c => ({ ...c, email_verified: !!Number(c.email_verified), disabled: !!c.disabled_at, order_count: Number(c.order_count), total_spent: Math.round(Number(c.total_spent) * 100) / 100 })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not fetch customers." });
  }
});

app.get("/api/admin/customers/:id", requireAdmin, async (req, res) => {
  const id = positiveIdParam(req, res); if (!id) return;
  try {
    const [rows] = await pool.query(
      `SELECT id, full_name, email, phone, created_at, auth_provider, disabled_at, disabled_reason,
              (email_verified_at IS NOT NULL) AS email_verified
         FROM users WHERE id = ? AND role = 'customer'`, [id]);
    if (!rows.length) return res.status(404).json({ error: "Customer not found." });
    const [orders] = await pool.query(
      `SELECT o.id, o.total, o.status, o.created_at,
              (SELECT COALESCE(SUM(quantity), 0) FROM order_items oi WHERE oi.order_id = o.id) AS item_count
         FROM orders o WHERE o.user_id = ? ORDER BY o.created_at DESC, o.id DESC`, [id]);
    const [addresses] = await pool.query(
      `SELECT id, label, full_name, phone, address_line1, address_line2, city, region, country, is_default
         FROM addresses WHERE user_id = ? ORDER BY is_default DESC, created_at DESC`, [id]);
    const [[counts]] = await pool.query(
      `SELECT (SELECT COUNT(*) FROM wishlist WHERE user_id = ?) AS wishlist_count,
              (SELECT COUNT(*) FROM reviews WHERE user_id = ?) AS review_count`, [id, id]);
    const paid = orders.filter(o => o.status !== "Cancelled");
    res.json({
      ...rows[0], email_verified: !!Number(rows[0].email_verified), disabled: !!rows[0].disabled_at,
      orders: orders.map(o => ({ ...o, item_count: Number(o.item_count) })),
      addresses,
      total_spent: Math.round(paid.reduce((s, o) => s + Number(o.total), 0) * 100) / 100,
      wishlist_count: Number(counts.wishlist_count), review_count: Number(counts.review_count),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not fetch the customer." });
  }
});

/* Account Controls (Milestone 6 - Phase 4). Disable or re-enable a customer.

   There is deliberately NO delete here. `users` is the target of ON DELETE
   CASCADE from `orders`, which cascades again to `order_items`, so deleting a
   customer would destroy their entire commercial history. Disabling is the
   reversible alternative and keeps every child row intact.

   The write does three things atomically, and the third is the one that
   matters: token_version is incremented ON DISABLE so every JWT issued before
   this moment is permanently dead. It is NOT touched on re-enable, which is
   what forces a re-enabled customer to log in again.

   Status codes follow the admin convention: 400 for a malformed body, 404 for
   a target that is not a customer, 409 for a request that is well formed but
   refused. Never 403 - the admin portal's apiFetch reads 401/403 as an expired
   session and would throw the operator out to the login page mid-action. */
app.patch("/api/admin/customers/:id/disabled", requireAdmin, async (req, res) => {
  const id = positiveIdParam(req, res); if (!id) return;
  const body = req.body || {};

  if (typeof body.disabled !== "boolean") {
    return res.status(400).json({ error: "disabled must be true or false.", field: "disabled" });
  }
  // Reason is optional and only meaningful when disabling. Plain text only:
  // it is rendered to administrators with textContent, never as markup.
  let reason = body.reason;
  if (reason === null || reason === undefined) reason = "";
  if (typeof reason !== "string") {
    return res.status(400).json({ error: "reason must be text.", field: "reason" });
  }
  reason = reason.replace(/\s+/g, " ").trim();
  if (reason.length > ACCOUNT_REASON_MAX) {
    return res.status(400).json({ error: `reason must be ${ACCOUNT_REASON_MAX} characters or fewer.`, field: "reason" });
  }

  // Checked before the row is read so the message names the real objection.
  if (id === Number(req.user.id)) {
    return res.status(409).json({ error: "You cannot disable your own account.", code: "CANNOT_DISABLE_SELF" });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query(
      "SELECT id, role, disabled_at, token_version FROM users WHERE id = ? FOR UPDATE", [id]);
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ error: "Customer not found." });
    }
    if (rows[0].role !== "customer") {
      await connection.rollback();
      return res.status(409).json({ error: "Administrator accounts cannot be disabled here.", code: "CANNOT_DISABLE_ADMIN" });
    }

    if (body.disabled) {
      // The version increment is the whole revocation mechanism. Same
      // statement, same transaction: a disable that failed to bump the version
      // would leave every outstanding token alive.
      await connection.query(
        "UPDATE users SET disabled_at = NOW(), disabled_reason = ?, token_version = token_version + 1 WHERE id = ?",
        [reason || null, id]
      );
    } else {
      // Re-enable CLEARS the reason. It describes why the account is currently
      // disabled, so keeping it beside an active account would be stale and
      // misleading; the next disable supplies its own. token_version is
      // deliberately left alone - that is what keeps pre-disable tokens dead.
      await connection.query(
        "UPDATE users SET disabled_at = NULL, disabled_reason = NULL WHERE id = ?", [id]);
    }

    const [after] = await connection.query(
      "SELECT disabled_at, disabled_reason, token_version FROM users WHERE id = ?", [id]);
    await connection.commit();

    const saved = after[0];
    const disabled = saved.disabled_at !== null && saved.disabled_at !== undefined;
    // Synchronous, post-commit, and seeded with the authoritative new state so
    // the change survives a database failure immediately afterwards.
    accounts.invalidateAccountStatus(id, { disabled, tokenVersion: Number(saved.token_version) || 0 });
    console.warn(`Customer ${id} ${disabled ? "DISABLED" : "ENABLED"} by admin id ${req.user.id}.`);

    res.json({
      success: true,
      id,
      disabled,
      disabled_at: saved.disabled_at,
      disabled_reason: saved.disabled_reason,
    });
  } catch (err) {
    await connection.rollback().catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Could not update the account." });
  } finally {
    connection.release();
  }
});

// ---------- Admin: logout (ADMIN-3) ----------
/* Server-side logout through the existing token_version mechanism: the version is
   bumped in one locked transaction, so EVERY token issued to this administrator
   before now fails authenticate()'s version check from the next request on — all
   devices, and the storefront session that shares the same stored login. There is
   no per-session revocation without a session table.

   Propagation: the account-status cache on THIS process is seeded with the new
   version right after commit. Other server instances keep their own cache and catch
   up within accounts.TTL_MS (7 s). If the database is unreachable and an instance
   has nothing cached, authenticate() skips the version check (accounts.js fails
   open by design), so a revoked token can pass there until the database is back.

   Under /api/admin/, so the maintenance guard bypasses it and logout keeps working
   while maintenance is on. Success is reported only after the increment commits. */
app.post("/api/admin/logout", requireAdmin, async (req, res) => {
  const id = Number(req.user.id);
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.query(
      "SELECT id, disabled_at, token_version FROM users WHERE id = ? FOR UPDATE", [id]);
    if (!rows.length) {
      await connection.rollback();
      return res.status(401).json({ error: "Your session has expired. Please log in again." });
    }
    const [result] = await connection.query(
      "UPDATE users SET token_version = token_version + 1 WHERE id = ?", [id]);
    if (result.affectedRows !== 1) throw new Error("token_version was not incremented");
    const [after] = await connection.query(
      "SELECT disabled_at, token_version FROM users WHERE id = ?", [id]);
    await connection.commit();

    // Committed: the revocation is durable. Seed this process's cache with the
    // authoritative new state; a failure here must not turn a committed logout
    // into an error response (the cache would catch up within its TTL anyway).
    try {
      const saved = after[0];
      accounts.invalidateAccountStatus(id, {
        disabled: saved.disabled_at !== null && saved.disabled_at !== undefined,
        tokenVersion: Number(saved.token_version) || 0,
      });
    } catch (cacheErr) {
      console.error("admin logout: account cache update failed:", cacheErr.message);
    }
    console.warn(`Admin id ${id} logged out; their sessions were revoked.`);
    res.json({ success: true });
  } catch (err) {
    if (connection) await connection.rollback().catch(() => {});
    console.error("admin logout failed:", err.code || err.message);
    res.status(500).json({ error: "Could not complete logout on the server." });
  } finally {
    if (connection) connection.release();
  }
});

// ---------- Admin: reviews ----------
/* Recalculates a product's stored rating + count from its VISIBLE reviews only
   (migration 004: hidden = 0).

   This is the single source of truth for every path that can change a product's
   rating, and it exists as one function on purpose: products.avg_rating and
   products.review_count are STORED, and GET /api/products returns them with
   SELECT *, so they reach every customer. If any one caller forgot the
   "hidden = 0" predicate, a hidden review would keep shaping the public rating
   with no visible symptom. Callers: customer review creation, admin delete,
   admin hide, admin unhide.

   Takes a connection so it can run inside the caller's transaction. */
async function recalculateProductRating(connection, productId) {
  const [[agg]] = await connection.query(
    "SELECT AVG(rating) AS avgRating, COUNT(*) AS count FROM reviews WHERE product_id = ? AND hidden = 0",
    [productId]
  );
  const avg = agg.avgRating === null ? 0 : Math.round(Number(agg.avgRating) * 10) / 10;
  const count = Number(agg.count);
  await connection.query("UPDATE products SET avg_rating = ?, review_count = ? WHERE id = ?", [avg, count, productId]);
  return { avg_rating: avg, review_count: count };
}

app.get("/api/admin/reviews", requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT r.id, r.rating, r.comment, r.is_verified_purchase, r.hidden, r.created_at,
              p.id AS product_id, p.name AS product_name, p.brand AS product_brand, p.image AS product_image,
              (p.deleted_at IS NOT NULL) AS product_archived,
              u.id AS customer_id, u.full_name AS customer_name, u.email AS customer_email
         FROM reviews r
         JOIN products p ON p.id = r.product_id
         JOIN users u ON u.id = r.user_id
        ORDER BY r.created_at DESC, r.id DESC`);
    // Admins see every review, hidden included — moderation needs the full list.
    res.json(rows.map(r => ({ ...r, is_verified_purchase: !!Number(r.is_verified_purchase), hidden: !!Number(r.hidden), product_archived: !!Number(r.product_archived) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not fetch reviews." });
  }
});

/* Hide or unhide a review. Reversible moderation, as opposed to the permanent
   delete below. Hiding changes what customers see AND the product's public
   rating, so the flag flip and the recalculation happen in one transaction with
   the row locked — the same shape the delete route uses. */
app.patch("/api/admin/reviews/:id/hidden", requireAdmin, async (req, res) => {
  const id = positiveIdParam(req, res); if (!id) return;
  const { hidden } = req.body || {};
  if (typeof hidden !== "boolean") return res.status(400).json({ error: "hidden must be true or false.", field: "hidden" });
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query("SELECT product_id FROM reviews WHERE id = ? FOR UPDATE", [id]);
    if (!rows.length) { await connection.rollback(); return res.status(404).json({ error: "Review not found." }); }
    const productId = rows[0].product_id;
    await connection.query("UPDATE reviews SET hidden = ? WHERE id = ?", [hidden ? 1 : 0, id]);
    const totals = await recalculateProductRating(connection, productId);
    await connection.commit();
    console.warn(`Review ${id} ${hidden ? "HIDDEN" : "UNHIDDEN"} by admin id ${req.user.id}.`);
    res.json({ success: true, id, hidden, product_id: productId, ...totals });
  } catch (err) {
    await connection.rollback().catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Could not update the review." });
  } finally {
    connection.release();
  }
});

// Permanently deletes a review and recalculates the product's rating + count.
app.delete("/api/admin/reviews/:id", requireAdmin, async (req, res) => {
  const id = positiveIdParam(req, res); if (!id) return;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query("SELECT product_id FROM reviews WHERE id = ? FOR UPDATE", [id]);
    if (!rows.length) { await connection.rollback(); return res.status(404).json({ error: "Review not found." }); }
    const productId = rows[0].product_id;
    await connection.query("DELETE FROM reviews WHERE id = ?", [id]);
    const totals = await recalculateProductRating(connection, productId);
    await connection.commit();
    res.json({ success: true, product_id: productId, ...totals });
  } catch (err) {
    await connection.rollback();
    console.error(err);
    res.status(500).json({ error: "Could not delete the review." });
  } finally {
    connection.release();
  }
});

// ---------- Wishlist ----------
app.get("/api/wishlist", requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT products.* FROM wishlist
       JOIN products ON wishlist.product_id = products.id
       WHERE wishlist.user_id = ? AND products.deleted_at IS NULL
       ORDER BY wishlist.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not fetch wishlist." });
  }
});

app.post("/api/wishlist", requireAuth, async (req, res) => {
  const { productId } = req.body;
  if (!productId) return res.status(400).json({ error: "productId is required." });
  try {
    await pool.query("INSERT IGNORE INTO wishlist (user_id, product_id) VALUES (?, ?)", [req.user.id, productId]);
    res.status(201).json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not add to wishlist." });
  }
});

app.delete("/api/wishlist/:productId", requireAuth, async (req, res) => {
  try {
    await pool.query("DELETE FROM wishlist WHERE user_id = ? AND product_id = ?", [req.user.id, req.params.productId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not remove from wishlist." });
  }
});

// ---------- Reviews ----------
app.get("/api/products/:id/reviews", async (req, res) => {
  try {
    // hidden = 0 keeps moderated reviews out of the storefront entirely —
    // neither the row nor its comment text reaches a customer (migration 004).
    const [rows] = await pool.query(
      `SELECT reviews.*, users.full_name FROM reviews
       JOIN users ON reviews.user_id = users.id
       WHERE reviews.product_id = ? AND reviews.hidden = 0
       ORDER BY reviews.created_at DESC`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not fetch reviews." });
  }
});

app.post("/api/products/:id/reviews", requireAuth, async (req, res) => {
  const { rating, comment } = req.body || {};
  const productId = req.params.id;
  // Only a JSON number that is a whole number from 1 to 5. Strings (even "4"), decimals, booleans,
  // null, NaN and missing values are refused here, before anything is read, inserted or
  // recalculated. (A non-numeric string used to slip past the old `rating < 1 || rating > 5`
  // check, because every comparison with NaN is false, and was stored as a 0-star review.)
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(400).json({ error: "Rating must be a whole number from 1 to 5." });
  }
  try {
    const [purchaseCheck] = await pool.query(
      `SELECT order_items.id FROM order_items
       JOIN orders ON order_items.order_id = orders.id
       WHERE orders.user_id = ? AND order_items.product_id = ? LIMIT 1`,
      [req.user.id, productId]
    );
    const isVerified = purchaseCheck.length > 0;

    // Columns are enumerated explicitly and `hidden` is NOT among them, so a
    // client-supplied hidden value can never be read or persisted here — only
    // an admin can change visibility, via PATCH /api/admin/reviews/:id/hidden.
    // Do not convert this to a spread or "SET ?" pattern.
    await pool.query(
      "INSERT INTO reviews (product_id, user_id, rating, comment, is_verified_purchase) VALUES (?, ?, ?, ?, ?)",
      [productId, req.user.id, rating, comment || null, isVerified]
    );

    await recalculateProductRating(pool, productId);

    res.status(201).json({ success: true, isVerified });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not submit review." });
  }
});

// ---------- Addresses ----------
app.get("/api/addresses", requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT a.*, EXISTS(SELECT 1 FROM orders o WHERE o.address_id = a.id) AS used_in_orders
         FROM addresses a WHERE a.user_id = ? ORDER BY a.is_default DESC, a.created_at DESC`,
      [req.user.id]
    );
    // locked: used by an order, so kept unchanged for order history (see PUT/DELETE below).
    res.json(rows.map(({ used_in_orders, ...a }) => ({ ...a, locked: !!Number(used_in_orders) })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not fetch addresses." });
  }
});

app.post("/api/addresses", requireAuth, async (req, res) => {
  const { label, fullName, phone, addressLine1, addressLine2, city, region, country, isDefault } = req.body;
  if (!fullName || !addressLine1 || !city || !country) {
    return res.status(400).json({ error: "Full name, address, city, and country are required." });
  }
  try {
    if (isDefault) {
      await pool.query("UPDATE addresses SET is_default = FALSE WHERE user_id = ?", [req.user.id]);
    }
    const [result] = await pool.query(
      `INSERT INTO addresses (user_id, label, full_name, phone, address_line1, address_line2, city, region, country, is_default)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, label || "Home", fullName, phone || null, addressLine1, addressLine2 || null, city, region || null, country, !!isDefault]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save address." });
  }
});

// ============================================================
// ---------- Customer account (Milestone 4) ------------------
// ============================================================
// Every query here is scoped to req.user.id from the verified JWT — never to an
// id supplied by the browser — so customers can only see and change their own data.

// createRateLimiter (small in-memory limiter) lives in rate-limit.js.
const passwordChangeLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 });
const trackOrderLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

const PHONE_PATTERN = /^[+0-9\s-]{7,20}$/;

function isPositiveId(value) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0;
}

function publicProfile(u) {
  return {
    id: u.id,
    full_name: u.full_name,
    email: u.email,
    phone: u.phone || null,
    role: u.role,
    email_verified: !!u.email_verified_at,
    member_since: u.created_at,
    // Google-created accounts have no password the customer knows; they set one by email.
    password_login: u.auth_provider !== "google",
    google_linked: !!u.google_id,
  };
}

async function loadProfile(userId) {
  const [rows] = await pool.query(
    "SELECT id, full_name, email, phone, role, created_at, email_verified_at, auth_provider, google_id FROM users WHERE id = ?",
    [userId]
  );
  return rows[0] || null;
}

app.get("/api/me", requireAuth, async (req, res) => {
  try {
    const user = await loadProfile(req.user.id);
    if (!user) return res.status(401).json({ error: "Your session has expired. Please log in again." });
    res.json(publicProfile(user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not load your profile." });
  }
});

// Name and phone only. Email changes need re-verification and are out of scope.
app.patch("/api/me", requireAuth, async (req, res) => {
  const body = req.body || {};
  const updates = [];
  const values = [];
  if ("fullName" in body) {
    const name = String(body.fullName || "").trim();
    if (name.length < 2 || name.length > 150) return res.status(400).json({ error: "Please enter your full name (2–150 characters).", field: "fullName" });
    updates.push("full_name = ?"); values.push(name);
  }
  if ("phone" in body) {
    const phone = String(body.phone || "").trim();
    if (phone && !PHONE_PATTERN.test(phone)) return res.status(400).json({ error: "Please enter a valid phone number.", field: "phone" });
    updates.push("phone = ?"); values.push(phone || null);
  }
  if ("email" in body) return res.status(400).json({ error: "Email addresses can't be changed here yet.", field: "email" });
  if (!updates.length) return res.status(400).json({ error: "Nothing to update." });
  try {
    await pool.query(`UPDATE users SET ${updates.join(", ")} WHERE id = ?`, [...values, req.user.id]);
    const user = await loadProfile(req.user.id);
    res.json(publicProfile(user));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update your profile." });
  }
});

app.post("/api/me/password", requireAuth, async (req, res) => {
  // Only wrong current-password attempts count, so typos in the new password never lock anyone out.
  if (passwordChangeLimiter.isLimited(`user:${req.user.id}`)) {
    return res.status(429).json({ error: "Too many attempts. Please wait a few minutes and try again.", code: "RATE_LIMITED" });
  }
  const { currentPassword, newPassword } = req.body || {};
  if (typeof newPassword !== "string" || newPassword.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Your new password must be at least ${MIN_PASSWORD_LENGTH} characters.`, field: "newPassword" });
  }
  if (newPassword.length > 200) return res.status(400).json({ error: "That password is too long.", field: "newPassword" });
  // A password change ends every existing session of this account (G-1): the new hash and
  // a token_version increment are written in one locked transaction, the same mechanism as
  // POST /api/admin/logout, so a token stolen before the change stops working. The caller
  // gets a fresh token carrying the new version, so the session that made the change stays
  // signed in. Outstanding password-reset links are withdrawn in the same transaction.
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.query(
      "SELECT id, role, password_hash, auth_provider, disabled_at, token_version FROM users WHERE id = ? FOR UPDATE", [req.user.id]);
    const user = rows[0];
    const refuse = async (status, body) => { await connection.rollback(); return res.status(status).json(body); };
    if (!user) return refuse(401, { error: "Your session has expired. Please log in again." });
    if (user.auth_provider === "google") {
      return refuse(400, { error: "Your account uses Google sign-in. Set a password using the emailed link instead.", code: "PASSWORD_NOT_SET" });
    }
    if (typeof currentPassword !== "string" || !currentPassword) {
      return refuse(400, { error: "Please enter your current password.", field: "currentPassword" });
    }
    const matches = await bcrypt.compare(currentPassword, user.password_hash);
    if (!matches) {
      passwordChangeLimiter.record(`user:${req.user.id}`);
      return refuse(400, { error: "Your current password is incorrect.", field: "currentPassword" });
    }
    if (await bcrypt.compare(newPassword, user.password_hash)) {
      return refuse(400, { error: "Choose a password you haven't used for this account.", field: "newPassword" });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    const [result] = await connection.query(
      "UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?", [hash, user.id]);
    if (result.affectedRows !== 1) throw new Error("password change did not update exactly one user");
    await connection.query("DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL", [user.id]);
    const [after] = await connection.query("SELECT disabled_at, token_version FROM users WHERE id = ?", [user.id]);
    await connection.commit();

    // Committed. Seed this process's account cache with the new version (other instances
    // catch up within accounts.TTL_MS); a cache failure must not turn a committed change
    // into an error.
    const tokenVersion = Number(after[0].token_version) || 0;
    try {
      accounts.invalidateAccountStatus(user.id, { disabled: after[0].disabled_at !== null && after[0].disabled_at !== undefined, tokenVersion });
    } catch (cacheErr) {
      console.error("password change: account cache update failed:", cacheErr.message);
    }
    res.json({ success: true, token: signSessionToken({ id: user.id, role: user.role, token_version: tokenVersion }) });
  } catch (err) {
    if (connection) await connection.rollback().catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Could not change your password." });
  } finally {
    if (connection) connection.release();
  }
});

/* ---------- Address management ----------
   Orders reference addresses by id (there is no copy of the address on the
   order, and deleting an address clears orders.address_id). To keep order
   history accurate, an address that has been used for an order is locked:
   it can still be set as default, but not edited or deleted. */
function validateAddressBody(b) {
  const v = k => String(b[k] || "").trim();
  const addr = {
    label: v("label").slice(0, 30) || "Home",
    fullName: v("fullName"), phone: v("phone"),
    addressLine1: v("addressLine1"), addressLine2: v("addressLine2"),
    city: v("city"), region: v("region"), country: v("country"),
  };
  if (!addr.fullName || !addr.addressLine1 || !addr.city || !addr.country) return { error: "Full name, address, city, and country are required." };
  if (addr.fullName.length > 150 || addr.addressLine1.length > 255 || addr.addressLine2.length > 255 || addr.city.length > 100 || addr.region.length > 100 || addr.country.length > 100) return { error: "One of the address fields is too long." };
  if (addr.phone && !PHONE_PATTERN.test(addr.phone)) return { error: "Please enter a valid phone number." };
  return { addr };
}

async function ownedAddress(addressId, userId) {
  if (!isPositiveId(addressId)) return null;
  const [rows] = await pool.query(
    `SELECT a.*, (SELECT COUNT(*) FROM orders o WHERE o.address_id = a.id) AS order_count
       FROM addresses a WHERE a.id = ? AND a.user_id = ?`,
    [Number(addressId), userId]
  );
  return rows[0] || null;
}

app.put("/api/addresses/:id", requireAuth, async (req, res) => {
  try {
    const existing = await ownedAddress(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: "Address not found." });
    if (Number(existing.order_count) > 0) {
      return res.status(409).json({ error: "This address was used for an order, so it's kept as it is for your records. Add a new address instead.", code: "ADDRESS_LOCKED" });
    }
    const { addr, error } = validateAddressBody(req.body || {});
    if (error) return res.status(400).json({ error });
    await pool.query(
      `UPDATE addresses SET label=?, full_name=?, phone=?, address_line1=?, address_line2=?, city=?, region=?, country=?
        WHERE id = ? AND user_id = ?`,
      [addr.label, addr.fullName, addr.phone || null, addr.addressLine1, addr.addressLine2 || null, addr.city, addr.region || null, addr.country, existing.id, req.user.id]
    );
    if (req.body && req.body.isDefault) {
      await pool.query("UPDATE addresses SET is_default = (id = ?) WHERE user_id = ?", [existing.id, req.user.id]);
    }
    res.json({ success: true, id: existing.id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update the address." });
  }
});

app.delete("/api/addresses/:id", requireAuth, async (req, res) => {
  try {
    const existing = await ownedAddress(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: "Address not found." });
    if (Number(existing.order_count) > 0) {
      return res.status(409).json({ error: "This address was used for an order, so it's kept for your records and can't be removed.", code: "ADDRESS_LOCKED" });
    }
    await pool.query("DELETE FROM addresses WHERE id = ? AND user_id = ?", [existing.id, req.user.id]);
    // If the default was removed, make the most recent remaining address the default.
    if (existing.is_default) {
      await pool.query(
        "UPDATE addresses SET is_default = TRUE WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1",
        [req.user.id]
      );
    }
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not remove the address." });
  }
});

app.patch("/api/addresses/:id/default", requireAuth, async (req, res) => {
  try {
    const existing = await ownedAddress(req.params.id, req.user.id);
    if (!existing) return res.status(404).json({ error: "Address not found." });
    await pool.query("UPDATE addresses SET is_default = (id = ?) WHERE user_id = ?", [existing.id, req.user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update your default address." });
  }
});

// ============================================================
// ---------- Email Verification (real, email-based flow) -----
// ============================================================

const VERIFY_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// Mail-server (MX) check at registration. Only a definitive DNS answer that the
// domain has no mail server rejects the address. If the lookup itself fails
// (resolver unreachable, timeout, temporary failure) the address is allowed and
// a warning is logged — the verification email is the real proof of ownership.
const MX_LOOKUP_TIMEOUT_MS = 3000;
const MX_DEFINITIVE_NO_MAIL = new Set(["ENOTFOUND", "ENODATA"]); // domain doesn't exist / has no MX records

async function domainHasMailServer(email) {
  const domain = (email || "").split("@")[1];
  if (!domain) return false;
  const resolver = new dns.Resolver({ timeout: MX_LOOKUP_TIMEOUT_MS, tries: 1 });
  let timer;
  try {
    const records = await Promise.race([
      resolver.resolveMx(domain),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error("MX lookup timed out"), { code: "ETIMEOUT" })), MX_LOOKUP_TIMEOUT_MS + 500);
      }),
    ]);
    return Array.isArray(records) && records.length > 0;
  } catch (err) {
    if (MX_DEFINITIVE_NO_MAIL.has(err.code)) return false;
    resolver.cancel();
    console.warn(`MX lookup for "${domain}" could not be completed (${err.code || err.message}); allowing registration — email verification still required.`);
    return true;
  } finally {
    clearTimeout(timer);
  }
}

function hashVerifyToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

async function sendNewVerificationEmail({ userId, email, fullName }) {
  await pool.query("DELETE FROM email_verifications WHERE user_id = ? AND used_at IS NULL", [userId]);

  const rawToken = crypto.randomBytes(32).toString("hex");
  const tokenHash = hashVerifyToken(rawToken);
  const expiresAt = new Date(Date.now() + VERIFY_TOKEN_EXPIRY_MS);

  await pool.query(
    "INSERT INTO email_verifications (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
    [userId, tokenHash, expiresAt]
  );

  const verifyUrl = `${process.env.FRONTEND_URL}/verify-email.html?token=${rawToken}`;

  try {
    await sendVerificationEmail({ to: email, customerName: fullName, verifyUrl });
  } catch (emailErr) {
    console.error("Verification email failed to send:", emailErr);
  }
}

const VERIFY_IP_WINDOW_MS = 15 * 60 * 1000;
const VERIFY_IP_MAX_REQUESTS = 5;
const VERIFY_EMAIL_COOLDOWN_MS = 60 * 1000;

const verifyIpHits = new Map();
const verifyEmailCooldowns = new Map();

function isVerifyIpRateLimited(ip) {
  const now = Date.now();
  const hits = (verifyIpHits.get(ip) || []).filter(t => now - t < VERIFY_IP_WINDOW_MS);
  verifyIpHits.set(ip, hits);
  return hits.length >= VERIFY_IP_MAX_REQUESTS;
}
function recordVerifyIpRequest(ip) {
  const hits = verifyIpHits.get(ip) || [];
  hits.push(Date.now());
  verifyIpHits.set(ip, hits);
}
function isVerifyEmailOnCooldown(email) {
  const last = verifyEmailCooldowns.get(email);
  return !!last && (Date.now() - last) < VERIFY_EMAIL_COOLDOWN_MS;
}
function recordVerifyEmailCooldown(email) {
  verifyEmailCooldowns.set(email, Date.now());
}
setInterval(() => {
  const now = Date.now();
  for (const [email, ts] of verifyEmailCooldowns) {
    if (now - ts > VERIFY_EMAIL_COOLDOWN_MS) verifyEmailCooldowns.delete(email);
  }
  for (const [ip, hits] of verifyIpHits) {
    const fresh = hits.filter(t => now - t < VERIFY_IP_WINDOW_MS);
    if (fresh.length === 0) verifyIpHits.delete(ip); else verifyIpHits.set(ip, fresh);
  }
}, 60 * 60 * 1000).unref();

// ---------- Verify Email (the link the customer clicks) ----------
app.get("/api/verify-email", async (req, res) => {
  const token = req.query?.token;
  if (!token) {
    return res.status(400).json({ error: "This verification link is invalid or has expired. Please request a new one." });
  }

  try {
    const tokenHash = hashVerifyToken(token);
    const [rows] = await pool.query(
      "SELECT * FROM email_verifications WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1",
      [tokenHash]
    );
    if (rows.length === 0) {
      return res.status(400).json({ error: "This verification link is invalid or has expired. Please request a new one." });
    }

    const record = rows[0];
    await pool.query("UPDATE users SET email_verified_at = NOW() WHERE id = ?", [record.user_id]);
    await pool.query("UPDATE email_verifications SET used_at = NOW() WHERE id = ?", [record.id]);
    await pool.query("DELETE FROM email_verifications WHERE user_id = ? AND used_at IS NULL", [record.user_id]);

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Something went wrong verifying your email." });
  }
});

// ---------- Resend Verification Email ----------
app.post("/api/resend-verification", async (req, res) => {
  const ip = req.ip;
  const GENERIC = { message: "If that email needs verifying, we've sent a new verification link." };

  if (isVerifyIpRateLimited(ip)) {
    return res.status(429).json({ error: "Too many requests. Please try again later." });
  }
  recordVerifyIpRequest(ip);

  const email = normalizeEmail(req.body?.email);
  if (!email) {
    return res.status(400).json({ error: "Email is required." });
  }

  if (isVerifyEmailOnCooldown(email)) {
    return res.json(GENERIC);
  }
  recordVerifyEmailCooldown(email);

  try {
    const [users] = await pool.query(
      "SELECT id, full_name, email_verified_at FROM users WHERE LOWER(email) = ?",
      [email]
    );
    if (users.length === 0 || users[0].email_verified_at) {
      return res.json(GENERIC);
    }

    const user = users[0];
    await sendNewVerificationEmail({ userId: user.id, email, fullName: user.full_name });

    return res.json(GENERIC);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ============================================================
// ---------- Password Reset (real, email-based flow) ---------
// ============================================================

const RESET_IP_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RESET_IP_MAX_REQUESTS = 5;           // per IP, per window
const RESET_EMAIL_COOLDOWN_MS = 60 * 1000; // 60 seconds between requests for the same email

const resetIpHits = new Map();         // ip -> [timestamps]
const resetEmailCooldowns = new Map(); // normalizedEmail -> last request timestamp

function isIpRateLimited(ip) {
  const now = Date.now();
  const hits = (resetIpHits.get(ip) || []).filter(t => now - t < RESET_IP_WINDOW_MS);
  resetIpHits.set(ip, hits);
  return hits.length >= RESET_IP_MAX_REQUESTS;
}
function recordIpRequest(ip) {
  const hits = resetIpHits.get(ip) || [];
  hits.push(Date.now());
  resetIpHits.set(ip, hits);
}
function isEmailOnCooldown(email) {
  const last = resetEmailCooldowns.get(email);
  return !!last && (Date.now() - last) < RESET_EMAIL_COOLDOWN_MS;
}
function recordEmailCooldown(email) {
  resetEmailCooldowns.set(email, Date.now());
}
setInterval(() => {
  const now = Date.now();
  for (const [email, ts] of resetEmailCooldowns) {
    if (now - ts > RESET_EMAIL_COOLDOWN_MS) resetEmailCooldowns.delete(email);
  }
  for (const [ip, hits] of resetIpHits) {
    const fresh = hits.filter(t => now - t < RESET_IP_WINDOW_MS);
    if (fresh.length === 0) resetIpHits.delete(ip); else resetIpHits.set(ip, fresh);
  }
}, 60 * 60 * 1000).unref();

function hashResetToken(rawToken) {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

// ---------- Forgot Password ----------
app.post("/api/forgot-password", async (req, res) => {
  const ip = req.ip;
  const GENERIC = { message: "If an account exists with that email, we've sent you a password reset link." };

  if (isIpRateLimited(ip)) {
    return res.status(429).json({ error: "Too many requests. Please try again later." });
  }
  recordIpRequest(ip);

  const email = normalizeEmail(req.body?.email);
  if (!email) {
    return res.status(400).json({ error: "Email is required." });
  }

  if (isEmailOnCooldown(email)) {
    return res.json(GENERIC);
  }
  recordEmailCooldown(email);

  try {
    const [users] = await pool.query("SELECT id, full_name, disabled_at FROM users WHERE LOWER(email) = ?", [email]);
    if (users.length === 0) {
      return res.json(GENERIC);
    }

    const user = users[0];

    // Account Controls: a disabled account gets the SAME generic response, so
    // this endpoint still cannot be used to discover whether an account exists
    // or what state it is in. It simply stops here: no reset row is written and
    // no email is sent. Completing a reset would be pointless (the customer
    // still cannot sign in) and not harmless - POST /api/reset-password also
    // rewrites auth_provider to 'local', which is a state change on a
    // suspended account.
    if (user.disabled_at) {
      return res.json(GENERIC);
    }

    await pool.query("DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL", [user.id]);

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashResetToken(rawToken);
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await pool.query(
      "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES (?, ?, ?)",
      [user.id, tokenHash, expiresAt]
    );

    const resetUrl = `${process.env.FRONTEND_URL}/reset-password.html?token=${rawToken}`;

    try {
      await sendPasswordResetEmail({ to: email, customerName: user.full_name, resetUrl });
    } catch (emailErr) {
      console.error("Password reset email failed to send:", emailErr);
    }

    return res.json(GENERIC);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ---------- Verify a reset token (used by reset-password.html on load) ----------
app.get("/api/reset-password/verify", async (req, res) => {
  const token = req.query?.token;
  if (!token) return res.json({ valid: false });

  try {
    const tokenHash = hashResetToken(token);
    const [rows] = await pool.query(
      "SELECT id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1",
      [tokenHash]
    );
    res.json({ valid: rows.length > 0 });
  } catch (err) {
    console.error(err);
    res.json({ valid: false });
  }
});

// ---------- Reset Password ----------
app.post("/api/reset-password", async (req, res) => {
  const { token, password } = req.body || {};
  if (typeof token !== "string" || typeof password !== "string" || !token || !password) {
    return res.status(400).json({ error: "Token and new password are required." });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }
  if (password.length > 200) {
    return res.status(400).json({ error: "That password is too long." });
  }

  const INVALID = { error: "This password reset link is invalid or has expired. Please request a new one." };
  const tokenHash = hashResetToken(token);

  let connection;
  try {
    // Cheap check first, so an unknown or expired link never costs a bcrypt hash. It is
    // repeated under a row lock below; this one only short-circuits.
    const [pre] = await pool.query(
      "SELECT id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1",
      [tokenHash]
    );
    if (pre.length === 0) {
      return res.status(400).json(INVALID);
    }
    const passwordHash = await bcrypt.hash(password, 10);

    // One transaction (G-1): the link is consumed exactly once (conditional UPDATE), a
    // disabled account is refused with the same generic answer as forgot-password, and the
    // new password plus a token_version increment end every existing session of the account.
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.query(
      "SELECT id, user_id FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > NOW() LIMIT 1 FOR UPDATE",
      [tokenHash]
    );
    const invalid = async () => { await connection.rollback(); return res.status(400).json(INVALID); };
    if (rows.length === 0) return invalid();
    const resetRecord = rows[0];
    const [users] = await connection.query("SELECT id, disabled_at FROM users WHERE id = ? FOR UPDATE", [resetRecord.user_id]);
    if (users.length === 0 || users[0].disabled_at) return invalid();
    const [used] = await connection.query(
      "UPDATE password_resets SET used_at = NOW() WHERE id = ? AND used_at IS NULL", [resetRecord.id]);
    if (used.affectedRows !== 1) return invalid();

    // After a reset the customer knows their password, so password sign-in (and changes) apply.
    const [updated] = await connection.query(
      "UPDATE users SET password_hash = ?, auth_provider = 'local', token_version = token_version + 1 WHERE id = ?",
      [passwordHash, resetRecord.user_id]);
    if (updated.affectedRows !== 1) throw new Error("password reset did not update exactly one user");
    await connection.query("DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL", [resetRecord.user_id]);
    const [after] = await connection.query("SELECT disabled_at, token_version FROM users WHERE id = ?", [resetRecord.user_id]);
    await connection.commit();

    try {
      accounts.invalidateAccountStatus(resetRecord.user_id, {
        disabled: after[0].disabled_at !== null && after[0].disabled_at !== undefined,
        tokenVersion: Number(after[0].token_version) || 0,
      });
    } catch (cacheErr) {
      console.error("password reset: account cache update failed:", cacheErr.message);
    }
    res.json({ success: true });
  } catch (err) {
    if (connection) await connection.rollback().catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Could not reset your password." });
  } finally {
    if (connection) connection.release();
  }
});

// ---------- Coupons ----------
// POST /api/coupons/validate was removed (Milestone 6, promo management). It had no
// caller in the frontend or the test suites, and its expiry check disagreed with the
// authoritative one: it compared against the Node process clock with "<", while
// pricing.js loadCoupon() compares against the database clock with "<=", so a coupon
// expiring at that instant was valid here and expired there. It also used SELECT *,
// which would have silently picked up the new `active` column without honouring it.
// POST /api/cart/quote is the single authoritative coupon path.

// ---------- Cart quote + Payments (Paystack) ----------
// Every amount comes from pricing.js (server-side, integer pesewas). Prices or
// totals sent by the browser are never trusted.
const PAYSTACK_API_BASE = process.env.PAYSTACK_API_BASE || "https://api.paystack.co";
const PAYMENT_REFERENCE_PATTERN = /^NF-[a-z0-9-]{8,80}$/;

// Outbound Paystack calls are bounded so a slow or hung Paystack can never hold a
// request open indefinitely (the runtime default would wait minutes). Paystack
// normally answers in well under a second.
//   initialize: 15 s — the customer is waiting on the checkout button; no money has
//               moved yet, so a timeout is safe to report as "try again".
//   verify:     10 s — used by the callback page and by the webhook. Keeping it short
//               leaves the webhook well inside the time a sender will wait for an
//               answer; a timeout is treated as TEMPORARY (retry), never as failure.
const PAYSTACK_INIT_TIMEOUT_MS = 15000;
const PAYSTACK_VERIFY_TIMEOUT_MS = 10000;

/* Classifies Paystack's answer to GET /transaction/verify/:reference.
   Returns one of:
     { kind: "success", tx }  Paystack confirms data.status === "success". The caller
                              still runs every integrity check before settling.
     { kind: "pending", status } a recognised non-final state; the payment may still
                              complete (e.g. Mobile Money awaiting approval).
     { kind: "failed",  status } a recognised definitive unsuccessful state.
     { kind: "temporary", reason } the outcome could not be established: timeout,
                              network error, non-2xx HTTP (incl. 429/5xx), unreadable
                              JSON, a false/missing response-level flag, no transaction
                              object, or a status value we do not recognise.
   Only the documented transaction status decides pending/failed; an HTTP error or a
   malformed body is never read as "the customer did not pay".

   "abandoned" is treated as FAILED: Paystack uses it for a checkout the customer did
   not complete. The customer-facing failed message therefore still tells anyone whose
   money did leave their account to contact us with the reference before paying again.
   Unknown status strings are TEMPORARY, the conservative choice. Logs carry the
   reference and a short reason only — never headers, keys or response bodies. */
const PAYSTACK_PENDING_STATUSES = new Set(["pending", "ongoing", "processing", "queued"]);
const PAYSTACK_FAILED_STATUSES = new Set(["failed", "abandoned", "reversed"]);

async function verifyWithPaystack(reference) {
  let res, text;
  try {
    res = await fetch(`${PAYSTACK_API_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      signal: AbortSignal.timeout(PAYSTACK_VERIFY_TIMEOUT_MS),
    });
    text = await res.text();
  } catch (err) {
    const reason = err && (err.name === "TimeoutError" || err.name === "AbortError") ? "timeout" : "network_error";
    return { kind: "temporary", reason };
  }
  if (!res.ok) return { kind: "temporary", reason: `http_${res.status}` };
  let data;
  try { data = JSON.parse(text); } catch (e) { return { kind: "temporary", reason: "invalid_json" }; }
  const tx = data && typeof data === "object" ? data.data : null;
  if (data.status !== true || !tx || typeof tx !== "object" || typeof tx.status !== "string") {
    return { kind: "temporary", reason: "unusable_response" };
  }
  const status = tx.status.toLowerCase();
  if (status === "success") return { kind: "success", tx };
  if (PAYSTACK_PENDING_STATUSES.has(status)) return { kind: "pending", status };
  if (PAYSTACK_FAILED_STATUSES.has(status)) return { kind: "failed", status };
  return { kind: "temporary", reason: "unrecognised_status" };
}

function sendPricingError(res, err) {
  if (!(err instanceof PricingError)) return false;
  res.status(err.status).json({ error: err.message, code: err.code, ...err.details });
  return true;
}

// Public, read-only: prices a cart so the storefront shows the server's numbers.
app.post("/api/cart/quote", async (req, res) => {
  try {
    const { items, couponId, couponCode } = req.body || {};
    const pricing = await priceCart(pool, { items, couponId, couponCode });
    res.json(quoteForClient(pricing));
  } catch (err) {
    if (sendPricingError(res, err)) return;
    console.error(err);
    res.status(500).json({ error: "Could not price your cart." });
  }
});

app.post("/api/payments/initialize", requireAuth, async (req, res) => {
  const { items, addressId, couponId } = req.body || {};
  try {
    if (!process.env.PAYSTACK_SECRET_KEY) {
      return res.status(503).json({ error: "Payments are not available right now.", code: "PAYMENTS_NOT_CONFIGURED" });
    }
    const [userRows] = await pool.query("SELECT email FROM users WHERE id = ?", [req.user.id]);
    if (userRows.length === 0) return res.status(404).json({ error: "User not found." });

    // Every new payment needs a delivery address, and it must belong to this customer.
    // Checked before pricing or Paystack, so nothing is started without one. Settlement
    // still accepts a snapshot without an address: such a payment was started before
    // this rule and has already been charged.
    if (addressId === undefined || addressId === null || addressId === "") {
      return res.status(400).json({ error: "Please add or choose a delivery address.", code: "ADDRESS_REQUIRED" });
    }
    const [addr] = await pool.query("SELECT id FROM addresses WHERE id = ? AND user_id = ?", [Number(addressId) || 0, req.user.id]);
    if (addr.length === 0) {
      return res.status(400).json({ error: "Please choose one of your saved delivery addresses.", code: "INVALID_ADDRESS" });
    }
    const validAddressId = addr[0].id;

    const pricing = await priceCart(pool, { items, couponId });
    const reference = `NF-${Date.now()}-${req.user.id}-${crypto.randomBytes(4).toString("hex")}`;

    // Signed snapshot of exactly what is being charged; verification creates the order from it.
    const snapshot = {
      v: 1,
      reference,
      userId: req.user.id,
      addressId: validAddressId,
      couponId: pricing.coupon ? pricing.coupon.id : null,
      currency: pricing.currency,
      subtotal: pricing.subtotal,
      discount: pricing.discount,
      shipping: pricing.shipping,
      total: pricing.total,
      lines: pricing.lines.map(l => ({ productId: l.productId, qty: l.qty, offerId: l.offerId, unitPrice: l.unitPrice, name: l.name })),
    };
    const { payload, sig } = signSnapshot(snapshot);

    let paystackRes, paystackData;
    try {
      paystackRes = await fetch(`${PAYSTACK_API_BASE}/transaction/initialize`, {
        method: "POST",
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          email: userRows[0].email,
          amount: pricing.total,              // integer pesewas, calculated by the server
          currency: pricing.currency,
          reference,
          callback_url: paymentCallbackUrl(req),
          metadata: { nf_order: payload, nf_sig: sig },
        }),
        signal: AbortSignal.timeout(PAYSTACK_INIT_TIMEOUT_MS),
      });
      paystackData = await paystackRes.json().catch(() => ({}));
    } catch (err) {
      // Timeout or network error. No customer has been sent to Paystack, so nothing
      // was charged: a plain "try again" is accurate.
      const reason = err && (err.name === "TimeoutError" || err.name === "AbortError") ? "timeout" : "network_error";
      console.error("Paystack initialize failed:", reason);
      return res.status(502).json({ error: "We couldn't start the payment. Please try again.", code: "PAYSTACK_INIT_FAILED" });
    }
    if (!paystackRes.ok || !paystackData.status || !paystackData.data?.authorization_url) {
      console.error("Paystack initialize failed:", paystackRes.status, paystackData.message);
      return res.status(502).json({ error: "We couldn't start the payment. Please try again.", code: "PAYSTACK_INIT_FAILED" });
    }

    res.json({ authorizationUrl: paystackData.data.authorization_url, reference, quote: quoteForClient(pricing) });
  } catch (err) {
    if (sendPricingError(res, err)) return;
    console.error(err);
    res.status(500).json({ error: "Could not initialize payment." });
  }
});

// A duplicate key on uq_orders_payment_reference (migration 001) means this payment
// reference has already been turned into an order. That is the one duplicate we expect
// here, and it is recoverable: the caller just needs the existing order. Any other
// duplicate-key error is unexpected and must keep its normal failure handling, so the
// index name is matched explicitly. TiDB reports the key as "orders.uq_..." and MariaDB
// as "uq_...", hence the substring test.
function isDuplicatePaymentReference(err) {
  return !!err
    && (err.code === "ER_DUP_ENTRY" || err.errno === 1062)
    && typeof err.sqlMessage === "string"
    && err.sqlMessage.includes("uq_orders_payment_reference");
}

/* ---------- Shared settlement path ----------
   Everything from "ask Paystack what actually happened" to "the order exists".
   The browser callback (/api/payments/verify) and the Paystack webhook both go
   through here, so the two cannot drift apart. It returns an outcome instead of
   throwing or writing a response, because the callers answer very differently:
   the callback speaks JSON to a browser, the webhook speaks status codes to
   Paystack. requireUserId is the one browser-only safeguard — the webhook has no
   session, and authenticates the payment through the signed snapshot plus the
   server-to-server verification below. */
async function settlePayment(reference, { requireUserId = null } = {}) {
  // Trusted evidence for the payment-issue register (payment-issues.js). It stays null
  // until Paystack's server-to-server verification says "success"; the snapshot-derived
  // fields are filled only after the snapshot's signature and reference checks pass.
  // It is attached to every later outcome but never sent to the browser or Paystack.
  let evidence = null;
  const reject = (status, code, error, details) => ({ outcome: "rejected", status, code, error, details, evidence });
  const lockName = `nf_pay_${reference}`.slice(0, 64);
  let connection = null;
  let lockHeld = false;

  try {
    if (!process.env.PAYSTACK_SECRET_KEY) return { outcome: "unavailable" };

    // 1. Ask Paystack directly (server-to-server) what was actually charged.
    //    Only a recognised definitive state counts as "not successful"; anything we
    //    cannot read reliably is TEMPORARY and nothing is settled (see verifyWithPaystack).
    const verified = await verifyWithPaystack(reference);
    if (verified.kind === "temporary") {
      console.error("Paystack verification unavailable:", reference, verified.reason);
      return { outcome: "temporary", reason: verified.reason };
    }
    if (verified.kind === "pending") return { outcome: "pending", status: verified.status };
    if (verified.kind === "failed") {
      return reject(400, "PAYMENT_NOT_SUCCESSFUL", "Payment was not successful.", { paystackStatus: verified.status });
    }
    const tx = verified.tx;
    // Amount and currency are attached only once Paystack's transaction is confirmed to
    // be THIS reference; on a reference mismatch they belong to some other transaction.
    evidence = { paystackVerified: true, amountPesewas: null, currency: null, snapshotValid: false, userId: null, expectedTotal: null };
    if (tx.reference !== reference) {
      return reject(400, "REFERENCE_MISMATCH", "Payment reference mismatch.");
    }
    evidence.amountPesewas = paymentIssues.parseAmountPesewas(tx.amount);
    evidence.currency = typeof tx.currency === "string" ? tx.currency : null;
    if (tx.currency !== CURRENCY) {
      console.error("Payment currency mismatch:", reference, tx.currency);
      return reject(400, "CURRENCY_MISMATCH", "Payment currency mismatch.");
    }

    // 2. The signed order snapshot created at initialization.
    let meta = tx.metadata;
    if (typeof meta === "string") { try { meta = JSON.parse(meta); } catch (e) { meta = null; } }
    const snapshot = meta ? readSignedSnapshot(meta.nf_order, meta.nf_sig) : null;
    if (!snapshot || snapshot.reference !== reference || !Array.isArray(snapshot.lines) || snapshot.lines.length === 0) {
      console.error("Payment metadata missing or tampered:", reference);
      return reject(400, "PAYMENT_METADATA_INVALID", "This payment could not be matched to an order.", { reference });
    }
    // Signature and reference verified: only now may snapshot values be trusted.
    evidence.snapshotValid = true;
    evidence.userId = Number.isInteger(Number(snapshot.userId)) ? Number(snapshot.userId) : null;
    evidence.expectedTotal = Number.isInteger(Number(snapshot.total)) ? Number(snapshot.total) : null;
    // Browser flow only: the signed-in customer must be the one who paid.
    if (requireUserId !== null && Number(snapshot.userId) !== Number(requireUserId)) {
      return reject(403, "PAYMENT_USER_MISMATCH", "This payment belongs to a different account.");
    }
    if (Number(tx.amount) !== Number(snapshot.total)) {
      console.error("PAYMENT AMOUNT MISMATCH:", reference, "charged", tx.amount, "expected", snapshot.total);
      return reject(400, "AMOUNT_MISMATCH", "The amount paid does not match your order. Please contact us with your payment reference.", { reference });
    }

    // 3. One order per reference: serialize concurrent settlements of the same payment.
    connection = await pool.getConnection();
    const [[lock]] = await connection.query("SELECT GET_LOCK(?, 10) AS got", [lockName]);
    if (Number(lock.got) !== 1) return { outcome: "busy" };
    lockHeld = true;

    const [existing] = await connection.query("SELECT id, total FROM orders WHERE payment_reference = ?", [reference]);
    if (existing.length > 0) {
      return { outcome: "already_processed", orderId: existing[0].id, total: Number(existing[0].total) };
    }

    // 4. Create the order from the snapshot. Stock is only decremented if enough remains.
    let orderId;
    await connection.beginTransaction();
    try {
      // PI-06: the delivery address chosen at checkout may have been deleted since
      // (unused addresses can be). Never substitute another one: stop with a clear code
      // instead of letting the orders.address_id foreign key fail as a generic error.
      if (snapshot.addressId !== null && snapshot.addressId !== undefined) {
        const [addr] = await connection.query("SELECT id FROM addresses WHERE id = ? AND user_id = ?", [snapshot.addressId, snapshot.userId]);
        if (!addr.length) {
          throw new PricingError(409, "PAID_ADDRESS_MISSING", "Your payment was received, but the delivery address chosen for it no longer exists. Please contact us with your payment reference and we'll resolve it.", { reference });
        }
      }
      for (const line of snapshot.lines) {
        const [result] = await connection.query(
          "UPDATE products SET stock_qty = stock_qty - ? WHERE id = ? AND deleted_at IS NULL AND stock_qty >= ?",
          [line.qty, line.productId, line.qty]
        );
        if (result.affectedRows !== 1) {
          // PI-06: tell an archived (or missing) product apart from a sold-out one.
          // Neither is substituted or re-priced; the order is simply not created.
          const [prodRows] = await connection.query("SELECT deleted_at FROM products WHERE id = ?", [line.productId]);
          if (!prodRows.length || prodRows[0].deleted_at) {
            throw new PricingError(409, "PAID_PRODUCT_UNAVAILABLE", "A product in this payment is no longer available.", { productId: line.productId });
          }
          throw new PricingError(409, "PAID_OUT_OF_STOCK", "Out of stock after payment.", { productId: line.productId });
        }
      }
      const [orderResult] = await connection.query(
        "INSERT INTO orders (user_id, address_id, coupon_id, total, status, payment_reference) VALUES (?, ?, ?, ?, 'Processing', ?)",
        [snapshot.userId, snapshot.addressId, snapshot.couponId, toCedis(snapshot.total), reference]
      );
      orderId = orderResult.insertId;
      for (const line of snapshot.lines) {
        await connection.query(
          "INSERT INTO order_items (order_id, product_id, quantity, price_at_purchase) VALUES (?, ?, ?, ?)",
          [orderId, line.productId, line.qty, toCedis(line.unitPrice)]
        );
      }
      if (snapshot.couponId) {
        // Conditional increment: the quote-time check in pricing.js loadCoupon() is a
        // read, and the advisory lock above is keyed per payment reference, so two
        // settlements using the SAME coupon under DIFFERENT references run concurrently.
        // An unconditional "+ 1" therefore let a 1-use coupon be redeemed twice. The
        // predicate makes the limit an atomic check-and-increment, exactly as the stock
        // decrement above does with "stock_qty >= ?".
        const [couponResult] = await connection.query(
          "UPDATE coupons SET times_used = times_used + 1 WHERE id = ? AND (usage_limit IS NULL OR times_used < usage_limit)",
          [snapshot.couponId]
        );
        if (couponResult.affectedRows !== 1) {
          throw new PricingError(409, "COUPON_USED_UP", "This coupon has reached its usage limit.");
        }
      }
      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    }

    // Confirmation email, best effort. Only the call that actually created the order
    // gets here, so a replay or a second delivery never emails the customer twice.
    try {
      const [userRows] = await pool.query("SELECT full_name, email FROM users WHERE id = ?", [snapshot.userId]);
      if (userRows.length > 0) {
        await sendOrderConfirmation({
          to: userRows[0].email,
          customerName: userRows[0].full_name,
          orderId,
          items: snapshot.lines.map(l => ({ name: l.name, qty: l.qty, price: toCedis(l.unitPrice) })),
          subtotal: toCedis(snapshot.subtotal),
          discount: toCedis(snapshot.discount),
          shipping: toCedis(snapshot.shipping),
          total: toCedis(snapshot.total),
        });
      }
    } catch (emailErr) {
      console.error("Order confirmation email failed to send:", emailErr);
    }

    return { outcome: "created", orderId, total: toCedis(snapshot.total) };
  } catch (err) {
    if (err instanceof PricingError && (err.code === "PAID_OUT_OF_STOCK" || err.code === "PAID_PRODUCT_UNAVAILABLE")) {
      console.error("PAID BUT NOT FULFILLABLE — needs manual resolution:", reference, err.code, err.details);
      return { outcome: "out_of_stock", code: err.code, details: err.details, evidence };
    }
    if (err instanceof PricingError) {
      return { outcome: "rejected", status: err.status, code: err.code, error: err.message, details: err.details, evidence };
    }
    // The UNIQUE index rejected a second order for this reference, so a concurrent
    // settlement won the race. The transaction above has already rolled back: no
    // stock was taken and no partial order remains. Answer exactly as the pre-insert
    // idempotency check does, so the loser of the race still sees the order.
    if (isDuplicatePaymentReference(err)) {
      console.error("Duplicate payment reference blocked by uq_orders_payment_reference — the advisory lock was bypassed:", reference);
      try {
        const [dupRows] = await pool.query("SELECT id, total FROM orders WHERE payment_reference = ?", [reference]);
        if (dupRows.length > 0) {
          return { outcome: "already_processed", orderId: dupRows[0].id, total: Number(dupRows[0].total) };
        }
      } catch (lookupErr) {
        console.error("Could not re-read the order after a duplicate reference:", lookupErr);
      }
      // No order to return — the competing transaction rolled back too, or the
      // re-read failed. Fall through to the transient failure below.
    }
    return { outcome: "error", err, evidence };
  } finally {
    if (connection) {
      if (lockHeld) await connection.query("SELECT RELEASE_LOCK(?)", [lockName]).catch(() => {});
      connection.release();
    }
  }
}

/* ---------- Settlement + payment-issue register (Stage B) ----------
   settlePayment() decides everything about money and orders. This wrapper only
   records what happened in payment_issues (payment-issues.js) AFTER settlement has
   finished — outside its transaction, after any rollback, after the lock is released.
   The issue write is best effort: any failure (including migration 009 not being
   applied yet) is caught and logged by code only, and the caller still answers from
   the untouched settlement result. No GET_LOCK is involved here; one row per
   reference is enforced by the table's UNIQUE key.
   signedWebhook must be true only after verifyPaystackSignature() passed. */
async function settleAndRecord(reference, { requireUserId = null, source, signedWebhook = false, resolvedBy = null } = {}) {
  const result = await settlePayment(reference, { requireUserId });
  try {
    await paymentIssues.recordFromSettlement(pool, reference, result, {
      source, signedWebhook, resolvedBy, referencePattern: PAYMENT_REFERENCE_PATTERN,
    });
  } catch (err) {
    console.error("Payment issue could not be recorded:", reference, (err && (err.code || err.message)) || "unknown error");
  }
  return result;
}

// Paystack signs the raw request body with HMAC-SHA512 keyed on the secret key and
// sends the hex digest as x-paystack-signature. The comparison is constant time and
// runs against the bytes as received: JSON.stringify(req.body) would reorder keys and
// drop whitespace, producing a different digest for a byte-identical payload.
function verifyPaystackSignature(req) {
  const header = req.get("x-paystack-signature");
  if (typeof header !== "string" || !/^[a-f0-9]{128}$/i.test(header)) return false;
  if (!Buffer.isBuffer(req.rawBody) || req.rawBody.length === 0) return false;
  const expected = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY).update(req.rawBody).digest();
  const given = Buffer.from(header, "hex");
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

// Only unsigned or forged calls count against this limit, so a flood of junk can
// never throttle a genuine Paystack delivery.
const paymentWebhookLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });

/* Account Controls: this is the ONE route that accepts a disabled account, and
   the only user of requireAuthAllowDisabled. The customer has already been
   charged by Paystack; refusing to settle would take their money and give them
   no order, no stock reservation and no confirmation email, leaving the
   reference stranded. Maintenance mode bypasses this route for the same reason.

   It also accepts a token whose version is stale, because the disable itself
   invalidated the token the customer was holding when they paid.

   Nothing is weakened by this. The JWT still establishes identity, and every
   other safeguard is untouched: settlePayment re-verifies the transaction with
   Paystack server-to-server, requires the HMAC-signed snapshot, requires
   snapshot.userId to equal this caller, matches the amount, and is idempotent
   per reference. A disabled customer can settle only a payment they personally
   made and were actually charged for. They still cannot INITIALIZE a new one -
   that route uses plain requireAuth. */
app.get("/api/payments/verify/:reference", requireAuthAllowDisabled, async (req, res) => {
  const { reference } = req.params;
  if (!PAYMENT_REFERENCE_PATTERN.test(reference)) {
    return res.status(400).json({ error: "Invalid payment reference.", code: "INVALID_REFERENCE" });
  }
  const result = await settleAndRecord(reference, { requireUserId: req.user.id, source: "callback" });
  switch (result.outcome) {
    case "created":
      return res.status(201).json({ orderId: result.orderId, total: result.total });
    case "already_processed":
      return res.json({ orderId: result.orderId, total: result.total, alreadyProcessed: true });
    case "rejected":
      return res.status(result.status).json({ error: result.error, code: result.code, ...(result.details || {}) });
    case "out_of_stock":
      return res.status(409).json({
        error: result.code === "PAID_PRODUCT_UNAVAILABLE"
          ? "Your payment was received, but an item is no longer available. Please contact us with your payment reference and we'll resolve it."
          : "Your payment was received, but an item sold out before we could reserve it. Please contact us with your payment reference and we'll resolve it.",
        code: result.code, reference,
      });
    case "pending":
      // 202: accepted, outcome not final. No order exists yet and none is claimed.
      return res.status(202).json({
        error: "Your payment is still being confirmed. Please don't pay again yet.",
        code: "PAYMENT_PENDING", reference,
      });
    case "temporary":
      return res.status(503).json({
        error: "We couldn't confirm your payment right now. Please don't pay again — try checking again in a moment.",
        code: "PAYMENT_VERIFY_UNAVAILABLE", reference,
      });
    case "busy":
      return res.status(503).json({ error: "Your payment is being confirmed. Please refresh in a moment.", code: "VERIFY_BUSY" });
    case "unavailable":
      return res.status(503).json({ error: "Payments are not available right now.", code: "PAYMENTS_NOT_CONFIGURED" });
    default:
      // Paystack confirmed the payment but the order could not be written (a database
      // error). Not a payment failure, and retrying may succeed: settlement is idempotent.
      console.error(result.err);
      return res.status(500).json({
        error: "Your payment was confirmed, but we couldn't finish creating your order yet. Please don't pay again — try again in a moment, or contact us with your payment reference.",
        code: "SETTLEMENT_ERROR", reference,
      });
  }
});

/* Paystack webhook. Public by necessity — Paystack holds no session with us — so the
   signature over the raw body is the only thing that authenticates a caller. The
   payload is treated as a notification and never as the source of truth: for
   charge.success we take only the reference, and settlePayment re-verifies the
   transaction with Paystack and builds the order from the signed snapshot.

   The status codes drive Paystack's retry behaviour, so they are deliberate: 2xx for
   "handled, or permanently unactionable", 5xx only for "try me again".
     200  order created; already processed (duplicate delivery); an unrelated event
          type; an unusable reference; a verified payment that can never settle as-is
          (out of stock, amount/currency/snapshot mismatch, coupon used up) — retrying
          those cannot help, they are logged for manual handling; Paystack reporting a
          definitive failed/abandoned/reversed state for a charge.success event.
     503  verification TEMPORARILY unavailable (timeout, network, HTTP 429/5xx,
          unreadable response); Paystack still reporting a pending state; the
          per-reference lock busy; payments not configured.
     500  the database failed while creating the order after Paystack confirmed it.
   Assumption (not verified against Paystack, deliberately conservative): any non-2xx
   makes Paystack redeliver the event later, and redelivery is safe because
   settlement is idempotent per reference. */
app.post(PAYMENT_WEBHOOK_PATH, async (req, res) => {
  const limiterKey = `webhook:${req.ip}`;
  if (paymentWebhookLimiter.isLimited(limiterKey)) return res.status(429).end();

  if (!process.env.PAYSTACK_SECRET_KEY) {
    // Nothing can be authenticated without the key; let a real event come back later.
    return res.status(503).json({ received: false, code: "PAYMENTS_NOT_CONFIGURED" });
  }
  if (!verifyPaystackSignature(req)) {
    paymentWebhookLimiter.record(limiterKey);
    console.error("Paystack webhook rejected: missing or invalid signature.");
    return res.status(401).json({ received: false });
  }

  const event = req.body && typeof req.body === "object" ? req.body : null;
  const type = event && typeof event.event === "string" ? event.event : "";
  if (type !== "charge.success") {
    return res.status(200).json({ received: true, ignored: type || "unknown_event" });
  }

  const reference = event.data && typeof event.data.reference === "string" ? event.data.reference.trim() : "";
  if (!PAYMENT_REFERENCE_PATTERN.test(reference)) {
    console.error("Paystack webhook: charge.success carried an unusable reference.");
    return res.status(200).json({ received: true, ignored: "invalid_reference" });
  }

  // The signature was verified above, so this is signed Paystack evidence.
  const result = await settleAndRecord(reference, { requireUserId: null, source: "webhook", signedWebhook: true });
  switch (result.outcome) {
    case "created":
      return res.status(200).json({ received: true, orderId: result.orderId });
    case "already_processed":
      return res.status(200).json({ received: true, orderId: result.orderId, alreadyProcessed: true });
    case "out_of_stock":
      console.error("WEBHOOK: paid but out of stock — needs manual resolution:", reference, result.details);
      return res.status(200).json({ received: true, unresolved: result.code });
    case "rejected":
      console.error("WEBHOOK: charge.success could not be settled:", reference, result.code);
      return res.status(200).json({ received: true, rejected: result.code });
    case "pending":
      console.error("WEBHOOK: charge.success but Paystack still reports", result.status, "for", reference, "— asking for redelivery");
      return res.status(503).json({ received: false, code: "PAYMENT_PENDING" });
    case "temporary":
      return res.status(503).json({ received: false, code: "PAYMENT_VERIFY_UNAVAILABLE" });
    case "busy":
      return res.status(503).json({ received: false, code: "VERIFY_BUSY" });
    case "unavailable":
      return res.status(503).json({ received: false, code: "PAYMENTS_NOT_CONFIGURED" });
    default:
      console.error("WEBHOOK: settlement failed for", reference, result.err);
      return res.status(500).json({ received: false, code: "SETTLEMENT_ERROR" });
  }
});

// ============================================================
// ---------- Special Offers ----------------------------------
// ============================================================
//
// Offers are the single source of truth for promotional pricing.
// Status (Scheduled / Active / Expired / Disabled) is NEVER stored —
// it's always derived from start_at/end_at/active at read time, so
// the Admin Portal and the customer-facing page can never disagree
// about whether an offer is currently live. This also means an
// offer expires automatically the instant its end_at passes, with
// no cron job or manual step required.

function computeOfferStatus(offer) {
  const now = new Date();
  const start = new Date(offer.start_at);
  const end = new Date(offer.end_at);
  if (now < start) return "Scheduled";
  if (now >= end) return "Expired";
  if (!offer.active) return "Disabled";
  return "Active";
}

function attachOfferPricing(offer) {
  const original = Number(offer.original_price);
  const sale = Number(offer.sale_price);
  const discount_percent = original > 0 ? Math.round(((original - sale) / original) * 100) : 0;
  return { ...offer, original_price: original, sale_price: sale, discount_percent };
}

// ---------- Public: currently-active offers, for special-offers.html ----------
app.get("/api/offers/active", async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT offers.id, offers.title, offers.description, offers.offer_type, offers.badge,
             offers.image, offers.start_at, offers.end_at, offers.featured, offers.display_order,
             offer_products.original_price, offer_products.sale_price,
             products.id AS product_id, products.name AS product_name, products.brand,
             products.category, products.image AS product_image, products.stock_qty,
             products.avg_rating, products.review_count
      FROM offers
      JOIN offer_products ON offer_products.offer_id = offers.id
      JOIN products ON offer_products.product_id = products.id
      WHERE offers.active = 1
        AND NOW() >= offers.start_at
        AND NOW() < offers.end_at
        AND products.deleted_at IS NULL
      ORDER BY offers.featured DESC, offers.display_order ASC, offers.created_at DESC
    `);
    res.json(rows.map(attachOfferPricing));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not fetch active offers." });
  }
});

// ---------- Admin: all offers (any status), for the management table ----------
// One entry per offer. Every product on it is in `products` (in the order the admin
// added them); the first one is also mirrored into the older top-level product_* /
// price fields so single-product consumers keep working.
app.get("/api/admin/offers", requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT offers.*,
             offer_products.original_price, offer_products.sale_price,
             products.id AS product_id, products.name AS product_name, products.image AS product_image,
             products.brand AS product_brand, products.price AS product_price, products.stock_qty AS product_stock,
             (products.deleted_at IS NOT NULL) AS product_archived
      FROM offers
      LEFT JOIN offer_products ON offer_products.offer_id = offers.id
      LEFT JOIN products ON offer_products.product_id = products.id
      ORDER BY offers.display_order ASC, offers.created_at DESC, offers.id ASC, offer_products.id ASC
    `);
    const byId = new Map();
    for (const row of rows) {
      let offer = byId.get(row.id);
      if (!offer) {
        offer = attachOfferPricing({ ...row, product_archived: !!Number(row.product_archived), status: computeOfferStatus(row) });
        offer.products = [];
        byId.set(row.id, offer);
      }
      if (row.product_id !== null) {
        offer.products.push(attachOfferPricing({
          product_id: row.product_id, product_name: row.product_name, product_image: row.product_image,
          product_brand: row.product_brand, product_price: row.product_price, product_stock: row.product_stock,
          product_archived: !!Number(row.product_archived), original_price: row.original_price, sale_price: row.sale_price,
        }));
      }
    }
    res.json([...byId.values()].map(o => ({ ...o, product_count: o.products.length })));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not fetch offers." });
  }
});

const MAX_OFFER_PRODUCTS = 50;

// The products on an offer arrive as items: [{ product_id, original_price, sale_price }].
// The older single-product body (top-level product_id / original_price / sale_price) is
// still accepted as a one-item list, and its errors keep their original field names.
function offerItemsFromBody(body) {
  if (body.items !== undefined) return { items: body.items, legacy: false };
  return { items: [{ product_id: body.product_id, original_price: body.original_price, sale_price: body.sale_price }], legacy: true };
}

// Validates a full offer body (create + edit) and checks every product, all before any
// write. existingProductIds: products already on the offer being edited — an archived
// product may stay on an offer, it just can't be newly added. Returns { error, field } or { values }.
async function validateOfferBody(body, existingProductIds = []) {
  const title = adminText(body.title), description = adminText(body.description), badge = adminText(body.badge), image = adminText(body.image);
  const offerType = adminText(body.offer_type) || "discount";
  const displayOrder = body.display_order === undefined || body.display_order === "" ? 0 : Number(body.display_order);
  const start = new Date(body.start_at), end = new Date(body.end_at);
  const num = v => (typeof v === "boolean" || v === null || v === "" ? NaN : Number(v));
  const money2 = n => n > 0 && n <= 1000000 && hasAtMost2dp(n);
  if (!title || title.length > 150) return { field: "title", error: "Title is required (up to 150 characters)." };
  if (description.length > 2000) return { field: "description", error: "Description must be 2000 characters or fewer." };
  if (!OFFER_TYPES.includes(offerType)) return { field: "offer_type", error: "Invalid offer type." };
  if (badge.length > 40) return { field: "badge", error: "Badge must be 40 characters or fewer." };
  if (image && !isValidImagePath(image)) return { field: "image", error: "Image must be a path inside images/." };
  if (!body.start_at || !body.end_at || isNaN(start) || isNaN(end)) return { field: "start_at", error: "Start and end dates are required." };
  if (end <= start) return { field: "end_at", error: "End date must be after the start date." };
  if (!Number.isInteger(displayOrder) || displayOrder < 0 || displayOrder > 9999) return { field: "display_order", error: "Display order must be a whole number from 0 to 9999." };

  const { items: raw, legacy } = offerItemsFromBody(body);
  if (!Array.isArray(raw) || raw.length === 0) return { field: "items", error: "Add at least one product to the offer." };
  if (raw.length > MAX_OFFER_PRODUCTS) return { field: "items", error: `An offer can include at most ${MAX_OFFER_PRODUCTS} products.` };
  const field = (i, k) => (legacy ? k : `items[${i}].${k}`);
  const items = [], seen = new Set();
  for (let i = 0; i < raw.length; i++) {
    const it = raw[i];
    if (!it || typeof it !== "object") return { field: `items[${i}]`, error: "Each product needs a product, an original price and a sale price." };
    const productId = num(it.product_id), original = num(it.original_price), sale = num(it.sale_price);
    if (!Number.isInteger(productId) || productId <= 0) return { field: field(i, "product_id"), error: "Choose a product." };
    if (seen.has(productId)) return { field: field(i, "product_id"), error: "That product is already in this offer." };
    seen.add(productId);
    if (!money2(original)) return { field: field(i, "original_price"), error: "Original price must be more than 0 with at most 2 decimal places." };
    if (!money2(sale)) return { field: field(i, "sale_price"), error: "Sale price must be more than 0 with at most 2 decimal places." };
    if (sale > original) return { field: field(i, "sale_price"), error: "Sale price cannot be higher than the original price." };
    items.push({ product_id: productId, original_price: original, sale_price: sale });
  }
  const [products] = await pool.query("SELECT id, deleted_at FROM products WHERE id IN (?)", [items.map(it => it.product_id)]);
  const productById = new Map(products.map(p => [Number(p.id), p]));
  const kept = new Set(existingProductIds.map(Number));
  for (let i = 0; i < items.length; i++) {
    const p = productById.get(items[i].product_id);
    if (!p) return { field: field(i, "product_id"), error: "That product doesn't exist." };
    if (p.deleted_at && !kept.has(items[i].product_id)) return { field: field(i, "product_id"), error: "That product is archived. Restore it before putting it on offer." };
  }
  return { values: {
    title, description: description || null, offer_type: offerType, badge: badge || null, image: image || null,
    start_at: body.start_at, end_at: body.end_at, active: body.active === false ? 0 : 1, featured: body.featured ? 1 : 0,
    display_order: displayOrder, items,
  } };
}

// Inserts an offer's whole product set in one statement (inside the caller's transaction).
function insertOfferProducts(connection, offerId, items) {
  return connection.query(
    `INSERT INTO offer_products (offer_id, product_id, original_price, sale_price) VALUES ?`,
    [items.map(it => [offerId, it.product_id, it.original_price, it.sale_price])]
  );
}

// Migration 007's UNIQUE (offer_id, product_id). Validation rejects duplicates first, so
// this only fires if that check is ever bypassed. Matched by index name, as for orders.
function isDuplicateOfferProduct(err) {
  return !!err
    && (err.code === "ER_DUP_ENTRY" || err.errno === 1062)
    && typeof err.sqlMessage === "string"
    && err.sqlMessage.includes("uq_offer_products_offer_product");
}

// ---------- Admin: create offer ----------
app.post("/api/admin/offers", requireAdmin, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    const v = await validateOfferBody(req.body);
    if (v.error) return res.status(400).json({ error: v.error, field: v.field });
    const o = v.values;
    await connection.beginTransaction();
    const [offerResult] = await connection.query(
      `INSERT INTO offers (title, description, offer_type, badge, image, start_at, end_at, active, featured, display_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [o.title, o.description, o.offer_type, o.badge, o.image, o.start_at, o.end_at, o.active, o.featured, o.display_order]
    );
    const offerId = offerResult.insertId;
    await insertOfferProducts(connection, offerId, o.items);
    await connection.commit();
    res.status(201).json({ id: offerId });
  } catch (err) {
    await connection.rollback().catch(() => {});
    if (isDuplicateOfferProduct(err)) return res.status(400).json({ error: "That product is already in this offer.", field: "items" });
    console.error(err);
    res.status(500).json({ error: "Could not create offer." });
  } finally {
    connection.release();
  }
});

// ---------- Admin: update offer ----------
app.put("/api/admin/offers/:id", requireAdmin, async (req, res) => {
  const id = positiveIdParam(req, res); if (!id) return;
  const connection = await pool.getConnection();
  try {
    const [current] = await pool.query("SELECT product_id FROM offer_products WHERE offer_id = ?", [id]);
    const v = await validateOfferBody(req.body, current.map(r => r.product_id));
    if (v.error) return res.status(400).json({ error: v.error, field: v.field });
    const o = v.values;
    await connection.beginTransaction();
    const [result] = await connection.query(
      `UPDATE offers SET title=?, description=?, offer_type=?, badge=?, image=?, start_at=?, end_at=?, active=?, featured=?, display_order=? WHERE id=?`,
      [o.title, o.description, o.offer_type, o.badge, o.image, o.start_at, o.end_at, o.active, o.featured, o.display_order, id]
    );
    if (!result.affectedRows) { await connection.rollback(); return res.status(404).json({ error: "Offer not found." }); }
    // Replace the offer's whole product set rather than diffing it. The incoming set was
    // fully validated above, and both statements share this transaction, so a failure
    // leaves the previous products and prices exactly as they were.
    await connection.query(`DELETE FROM offer_products WHERE offer_id = ?`, [id]);
    await insertOfferProducts(connection, id, o.items);
    await connection.commit();
    res.json({ success: true });
  } catch (err) {
    await connection.rollback().catch(() => {});
    if (isDuplicateOfferProduct(err)) return res.status(400).json({ error: "That product is already in this offer.", field: "items" });
    console.error(err);
    res.status(500).json({ error: "Could not update offer." });
  } finally {
    connection.release();
  }
});

// ---------- Admin: activate/deactivate (toggle the manual "active" flag) ----------
app.patch("/api/admin/offers/:id/toggle", requireAdmin, async (req, res) => {
  const id = positiveIdParam(req, res); if (!id) return;
  const { active } = req.body;
  if (typeof active !== "boolean") return res.status(400).json({ error: "active must be true or false." });
  try {
    const [result] = await pool.query(`UPDATE offers SET active = ? WHERE id = ?`, [active ? 1 : 0, id]);
    if (!result.affectedRows) return res.status(404).json({ error: "Offer not found." });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update offer status." });
  }
});

// ---------- Admin: feature/unfeature ----------
app.patch("/api/admin/offers/:id/featured", requireAdmin, async (req, res) => {
  const id = positiveIdParam(req, res); if (!id) return;
  const { featured } = req.body;
  if (typeof featured !== "boolean") return res.status(400).json({ error: "featured must be true or false." });
  try {
    const [result] = await pool.query(`UPDATE offers SET featured = ? WHERE id = ?`, [featured ? 1 : 0, id]);
    if (!result.affectedRows) return res.status(404).json({ error: "Offer not found." });
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update the offer." });
  }
});

// ---------- Admin: delete offer ----------
app.delete("/api/admin/offers/:id", requireAdmin, async (req, res) => {
  const id = positiveIdParam(req, res); if (!id) return;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query(`DELETE FROM offer_products WHERE offer_id = ?`, [id]);
    const [result] = await connection.query(`DELETE FROM offers WHERE id = ?`, [id]);
    if (!result.affectedRows) { await connection.rollback(); return res.status(404).json({ error: "Offer not found." }); }
    await connection.commit();
    res.json({ success: true });
  } catch (err) {
    await connection.rollback().catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Could not delete offer." });
  } finally {
    connection.release();
  }
});

// ---------- Admin: coupons (promo codes) ----------
// Status (Active / Inactive / Expired / Used up) is NEVER stored — it is derived at
// read time from active, expires_at and times_used vs usage_limit, exactly as offer
// status is. Expiry is evaluated in SQL ("expires_at <= NOW()") so it matches
// pricing.js loadCoupon() byte for byte: the database clock is authoritative, never
// the Node process clock. The precedence below is the same order loadCoupon() rejects
// in, so the admin list never shows a state the customer wouldn't be told.

const COUPON_CODE_PATTERN = /^[A-Z0-9_-]{1,50}$/;

// A duplicate key on coupons.code means the admin reused an existing code. Matched as
// a substring so TiDB (which reports "coupons.code") matches too, like the orders
// duplicate-reference predicate above.
function isDuplicateCouponCode(err) {
  return !!err
    && (err.code === "ER_DUP_ENTRY" || err.errno === 1062)
    && typeof err.sqlMessage === "string"
    && (err.sqlMessage.includes("coupons.code") || err.sqlMessage.includes("'code'"));
}

function computeCouponStatus(row) {
  if (!Number(row.active)) return "Inactive";
  if (Number(row.is_expired)) return "Expired";
  if (row.usage_limit !== null && Number(row.times_used) >= Number(row.usage_limit)) return "Used up";
  return "Active";
}

const COUPON_SELECT = `
  SELECT coupons.id, coupons.code, coupons.discount_percent, coupons.discount_amount,
         coupons.expires_at, coupons.usage_limit, coupons.times_used, coupons.active,
         coupons.created_at, coupons.updated_at,
         (coupons.expires_at IS NOT NULL AND coupons.expires_at <= NOW()) AS is_expired,
         (SELECT COUNT(*) FROM orders WHERE orders.coupon_id = coupons.id) AS orders_used
    FROM coupons`;

function shapeCoupon(row) {
  return {
    id: row.id,
    code: row.code,
    discount_percent: row.discount_percent,
    discount_amount: row.discount_amount,
    expires_at: row.expires_at,
    usage_limit: row.usage_limit === null ? null : Number(row.usage_limit),
    times_used: Number(row.times_used),
    active: !!Number(row.active),
    orders_used: Number(row.orders_used),
    created_at: row.created_at,
    updated_at: row.updated_at,
    status: computeCouponStatus(row),
  };
}

// Validates a full coupon body (create + edit). Returns { error, field } or { values }.
// Exactly one discount kind is enforced here because the table carries no CHECK
// constraint and TiDB's CHECK enforcement is version-gated.
function validateCouponBody(body) {
  const b = body || {};
  const code = adminText(b.code).toUpperCase();
  if (!code) return { field: "code", error: "A coupon code is required." };
  if (code.length > 50) return { field: "code", error: "Coupon code must be 50 characters or fewer." };
  if (!COUPON_CODE_PATTERN.test(code)) return { field: "code", error: "Use only letters, numbers, hyphens and underscores." };

  const given = v => v !== undefined && v !== null && String(v).trim() !== "";
  const hasPercent = given(b.discount_percent);
  const hasAmount = given(b.discount_amount);
  if (hasPercent && hasAmount) return { field: "discount_percent", error: "Choose either a percentage or a fixed amount, not both." };
  if (!hasPercent && !hasAmount) return { field: "discount_percent", error: "Enter either a percentage or a fixed amount." };

  const dec2 = hasAtMost2dp;
  let percent = null, amount = null;
  if (hasPercent) {
    percent = Number(b.discount_percent);
    if (!Number.isFinite(percent) || percent <= 0) return { field: "discount_percent", error: "Percentage must be more than 0." };
    if (percent > 100) return { field: "discount_percent", error: "Percentage cannot be more than 100." };
    if (!dec2(percent)) return { field: "discount_percent", error: "Percentage can have at most 2 decimal places." };
  } else {
    amount = Number(b.discount_amount);
    if (!Number.isFinite(amount) || amount <= 0) return { field: "discount_amount", error: "Amount must be more than 0." };
    if (amount > 1000000) return { field: "discount_amount", error: "Amount is too large." };
    if (!dec2(amount)) return { field: "discount_amount", error: "Amount can have at most 2 decimal places." };
  }

  let usageLimit = null;
  if (given(b.usage_limit)) {
    usageLimit = Number(b.usage_limit);
    if (!Number.isInteger(usageLimit)) return { field: "usage_limit", error: "Usage limit must be a whole number." };
    // 0 is rejected deliberately: it would make times_used >= usage_limit true at once,
    // telling customers the coupon is "used up" instead of withdrawn. Use active=false.
    if (usageLimit < 1) return { field: "usage_limit", error: "Usage limit must be at least 1 — deactivate the coupon instead." };
    if (usageLimit > 1000000) return { field: "usage_limit", error: "Usage limit is too large." };
  }

  let expiresAt = null;
  if (given(b.expires_at)) {
    const raw = adminText(b.expires_at);
    if (isNaN(new Date(raw).getTime())) return { field: "expires_at", error: "Enter a valid expiry date." };
    expiresAt = raw;
  }

  return { values: {
    code, discount_percent: percent, discount_amount: amount,
    usage_limit: usageLimit, expires_at: expiresAt,
    active: b.active === false ? 0 : 1,
  } };
}

app.get("/api/admin/coupons", requireAdmin, async (req, res) => {
  try {
    const [rows] = await pool.query(`${COUPON_SELECT} ORDER BY coupons.created_at DESC, coupons.id DESC`);
    res.json(rows.map(shapeCoupon));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not fetch coupons." });
  }
});

app.get("/api/admin/coupons/:id", requireAdmin, async (req, res) => {
  const id = positiveIdParam(req, res); if (!id) return;
  try {
    const [rows] = await pool.query(`${COUPON_SELECT} WHERE coupons.id = ?`, [id]);
    if (!rows.length) return res.status(404).json({ error: "Coupon not found." });
    res.json(shapeCoupon(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not fetch the coupon." });
  }
});

app.post("/api/admin/coupons", requireAdmin, async (req, res) => {
  const v = validateCouponBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error, field: v.field });
  const c = v.values;
  try {
    const [result] = await pool.query(
      `INSERT INTO coupons (code, discount_percent, discount_amount, expires_at, usage_limit, active)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [c.code, c.discount_percent, c.discount_amount, c.expires_at, c.usage_limit, c.active]
    );
    res.status(201).json({ id: result.insertId });
  } catch (err) {
    if (isDuplicateCouponCode(err)) {
      return res.status(409).json({ error: "That coupon code already exists.", field: "code", code: "COUPON_CODE_TAKEN" });
    }
    console.error(err);
    res.status(500).json({ error: "Could not create the coupon." });
  }
});

app.put("/api/admin/coupons/:id", requireAdmin, async (req, res) => {
  const id = positiveIdParam(req, res); if (!id) return;
  const v = validateCouponBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error, field: v.field });
  const c = v.values;
  try {
    const [result] = await pool.query(
      `UPDATE coupons SET code = ?, discount_percent = ?, discount_amount = ?,
              expires_at = ?, usage_limit = ?, active = ? WHERE id = ?`,
      [c.code, c.discount_percent, c.discount_amount, c.expires_at, c.usage_limit, c.active, id]
    );
    if (!result.affectedRows) {
      const [exists] = await pool.query("SELECT id FROM coupons WHERE id = ?", [id]);
      if (!exists.length) return res.status(404).json({ error: "Coupon not found." });
    }
    res.json({ success: true });
  } catch (err) {
    if (isDuplicateCouponCode(err)) {
      return res.status(409).json({ error: "That coupon code already exists.", field: "code", code: "COUPON_CODE_TAKEN" });
    }
    console.error(err);
    res.status(500).json({ error: "Could not update the coupon." });
  }
});

app.patch("/api/admin/coupons/:id/active", requireAdmin, async (req, res) => {
  const id = positiveIdParam(req, res); if (!id) return;
  const { active } = req.body || {};
  if (typeof active !== "boolean") return res.status(400).json({ error: "active must be true or false.", field: "active" });
  try {
    const [result] = await pool.query("UPDATE coupons SET active = ? WHERE id = ?", [active ? 1 : 0, id]);
    if (!result.affectedRows) {
      const [exists] = await pool.query("SELECT id FROM coupons WHERE id = ?", [id]);
      if (!exists.length) return res.status(404).json({ error: "Coupon not found." });
    }
    res.json({ success: true, active });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not update the coupon." });
  }
});

app.delete("/api/admin/coupons/:id", requireAdmin, async (req, res) => {
  const id = positiveIdParam(req, res); if (!id) return;
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    // orders.coupon_id is ON DELETE SET NULL, so deleting a redeemed coupon would
    // silently erase the link on historical orders with no error. Refuse instead, and
    // read the count inside the transaction so it cannot shift under us.
    const [refs] = await connection.query("SELECT COUNT(*) AS n FROM orders WHERE coupon_id = ?", [id]);
    const ordersUsed = Number(refs[0].n);
    if (ordersUsed > 0) {
      await connection.rollback();
      return res.status(409).json({
        error: `This coupon has been used on ${ordersUsed} order${ordersUsed === 1 ? "" : "s"} and cannot be deleted. Deactivate it instead.`,
        code: "COUPON_IN_USE",
        ordersUsed,
      });
    }
    const [result] = await connection.query("DELETE FROM coupons WHERE id = ?", [id]);
    if (!result.affectedRows) { await connection.rollback(); return res.status(404).json({ error: "Coupon not found." }); }
    await connection.commit();
    res.json({ success: true });
  } catch (err) {
    await connection.rollback().catch(() => {});
    console.error(err);
    res.status(500).json({ error: "Could not delete the coupon." });
  } finally {
    connection.release();
  }
});

// ---------- Admin: payment issues (Payment Reliability Stage B) ----------
// Reads and resolves payment_issues (migration 009 — applied LOCAL ONLY on 2026-10-17;
// NOT applied to production, there is no staging yet, and not verified on TiDB; see the
// Status header in migrations/009_payment_issues.sql). In any environment where 009 is
// not applied, these routes answer 500 and settlement is unaffected.
// Every route is requireAdmin. Errors follow the admin convention — 400 malformed,
// 404 unknown id, 409 well formed but refused — and never 403, which admin-core.js
// treats as an expired session.
// Nothing here creates an order or marks a payment paid: "Retry settlement" runs the
// normal settlePayment() path, which re-verifies with Paystack server-to-server.
const PAYMENT_ISSUE_COLUMNS = `pi.id, pi.payment_reference, pi.evidence, pi.category, pi.last_error_code,
  pi.first_source, pi.last_source, pi.status, pi.resolution, pi.user_id, pi.order_id, pi.amount_pesewas,
  pi.currency, pi.expected_total_pesewas, pi.detail_product_id, pi.attempt_count, pi.first_seen_at,
  pi.last_seen_at, pi.resolved_by, pi.resolved_at`;

// Per-process guards: a retry and a manual resolution of the SAME issue never run at
// the same time in this process (409 RETRY_IN_PROGRESS / RESOLVE_IN_PROGRESS), and a
// retry can't be double-submitted. They are NOT shared between server instances and
// cannot see a webhook or callback settlement that is committing elsewhere. What
// prevents a duplicate order is settlement's own idempotency (UNIQUE payment_reference
// + transaction); what keeps a late order visible after a manual resolution is
// resolveSettled() linking it and manual_resolution_conflict below.
const paymentIssueRetries = new Set();
const paymentIssueResolves = new Set();

function shapePaymentIssue(r) {
  const n = v => (v === null || v === undefined ? null : Number(v));
  const hasOrder = r.linked_order_id !== null && r.linked_order_id !== undefined;
  return {
    id: r.id, payment_reference: r.payment_reference, evidence: r.evidence, category: r.category,
    last_error_code: r.last_error_code, first_source: r.first_source, last_source: r.last_source,
    status: r.status, resolution: r.resolution,
    user_id: n(r.user_id), customer_name: r.customer_name || null,
    order_id: n(r.order_id), linked_order_id: n(r.linked_order_id),
    has_order: hasOrder,
    // Closed by a manual decision, yet an order exists for the same payment (e.g. a
    // settlement committed while or just after the decision was recorded). The
    // recorded decision is kept as-is; admins must review it. Nothing about money is
    // implied — this flag says only that both facts are true.
    manual_resolution_conflict: r.status === "resolved" && !!r.resolution && r.resolution !== "settled" && hasOrder,
    amount_pesewas: n(r.amount_pesewas), currency: r.currency, expected_total_pesewas: n(r.expected_total_pesewas),
    detail_product_id: n(r.detail_product_id), attempt_count: Number(r.attempt_count) || 0,
    first_seen_at: r.first_seen_at, last_seen_at: r.last_seen_at,
    resolved_by: n(r.resolved_by), resolved_at: r.resolved_at,
    retry_allowed: paymentIssues.isRetryable(r),
  };
}

async function loadPaymentIssue(id) {
  const [rows] = await pool.query(
    `SELECT ${PAYMENT_ISSUE_COLUMNS}, pi.resolution_note,
            u.full_name AS customer_name, rb.full_name AS resolved_by_name, p.name AS detail_product_name,
            o.id AS linked_order_id, o.status AS linked_order_status, o.total AS linked_order_total
       FROM payment_issues pi
       LEFT JOIN users u ON u.id = pi.user_id
       LEFT JOIN users rb ON rb.id = pi.resolved_by
       LEFT JOIN products p ON p.id = pi.detail_product_id
       LEFT JOIN orders o ON o.payment_reference = pi.payment_reference
      WHERE pi.id = ?`, [id]);
  if (!rows.length) return null;
  const r = rows[0];
  return {
    ...shapePaymentIssue(r),
    resolution_note: r.resolution_note || null,
    resolved_by_name: r.resolved_by_name || null,
    detail_product_name: r.detail_product_name || null,
    linked_order: r.linked_order_id ? { id: Number(r.linked_order_id), status: r.linked_order_status, total: Number(r.linked_order_total) } : null,
  };
}

app.get("/api/admin/payment-issues", requireAdmin, async (req, res) => {
  const f = paymentIssues.parseListQuery(req.query);
  if (f.error) return res.status(400).json({ error: f.error, field: f.field });
  try {
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM payment_issues pi ${f.where}`, f.params);
    const [rows] = await pool.query(
      `SELECT ${PAYMENT_ISSUE_COLUMNS}, u.full_name AS customer_name, o.id AS linked_order_id
         FROM payment_issues pi
         LEFT JOIN users u ON u.id = pi.user_id
         LEFT JOIN orders o ON o.payment_reference = pi.payment_reference
         ${f.where}
        ORDER BY pi.last_seen_at DESC, pi.id DESC
        LIMIT ? OFFSET ?`, [...f.params, f.pageSize, (f.page - 1) * f.pageSize]);
    const [counts] = await pool.query("SELECT status, COUNT(*) AS n FROM payment_issues GROUP BY status");
    const count = s => Number((counts.find(c => c.status === s) || {}).n || 0);
    res.json({
      issues: rows.map(shapePaymentIssue), total: Number(total), page: f.page, pageSize: f.pageSize,
      status_counts: { open: count("open"), resolved: count("resolved") },
    });
  } catch (err) {
    console.error("payment issues list failed:", err.code || err.message);
    res.status(500).json({ error: "Could not load payment issues." });
  }
});

app.get("/api/admin/payment-issues/:id", requireAdmin, async (req, res) => {
  const id = positiveIdParam(req, res); if (!id) return;
  try {
    const issue = await loadPaymentIssue(id);
    if (!issue) return res.status(404).json({ error: "Payment issue not found." });
    res.json(issue);
  } catch (err) {
    console.error("payment issue detail failed:", err.code || err.message);
    res.status(500).json({ error: "Could not load the payment issue." });
  }
});

app.post("/api/admin/payment-issues/:id/retry", requireAdmin, async (req, res) => {
  const id = positiveIdParam(req, res); if (!id) return;
  let row;
  try {
    const [rows] = await pool.query("SELECT id, payment_reference, status, category, last_error_code FROM payment_issues WHERE id = ?", [id]);
    row = rows[0];
  } catch (err) {
    console.error("payment issue retry lookup failed:", err.code || err.message);
    return res.status(500).json({ error: "Could not load the payment issue." });
  }
  if (!row) return res.status(404).json({ error: "Payment issue not found." });
  if (row.status !== "open") return res.status(409).json({ error: "This issue is already resolved.", code: "ALREADY_RESOLVED" });
  if (row.category === "integrity_mismatch") {
    return res.status(409).json({ error: "Integrity mismatches can't be retried — the payment didn't match its order. Investigate it in Paystack and record a manual decision.", code: "RETRY_NOT_ALLOWED" });
  }
  if (!paymentIssues.isRetryable(row)) {
    return res.status(409).json({ error: "This issue can't be settled automatically (the delivery address chosen at checkout was deleted). Contact the customer and record a manual decision.", code: "RETRY_NOT_ALLOWED" });
  }
  // Defence in depth: only a reference in the shape this server generates is ever
  // passed to settlement, even though rows are only written by the server itself.
  if (!PAYMENT_REFERENCE_PATTERN.test(row.payment_reference)) {
    return res.status(409).json({ error: "This issue's payment reference is not valid.", code: "RETRY_NOT_ALLOWED" });
  }
  if (paymentIssueRetries.has(id)) {
    return res.status(409).json({ error: "A retry for this issue is already in progress.", code: "RETRY_IN_PROGRESS" });
  }
  if (paymentIssueResolves.has(id)) {
    return res.status(409).json({ error: "This issue is being resolved right now. Reload it in a moment.", code: "RESOLVE_IN_PROGRESS" });
  }
  paymentIssueRetries.add(id);
  let result;
  try {
    result = await settleAndRecord(row.payment_reference, { requireUserId: null, source: "admin_retry", resolvedBy: req.user.id });
  } finally {
    paymentIssueRetries.delete(id);
  }
  console.warn(`Payment issue ${id} retried by admin id ${req.user.id}: ${result.outcome}${result.code ? ` ${result.code}` : ""}.`);
  if (result.outcome === "unavailable") {
    return res.status(503).json({ error: "Payments are not configured on this server.", code: "PAYMENTS_NOT_CONFIGURED" });
  }
  const settled = result.outcome === "created" || result.outcome === "already_processed";
  let issue = null;
  try { issue = await loadPaymentIssue(id); } catch (err) { console.error("payment issue reload failed:", err.code || err.message); }
  res.json({
    settled,
    outcome: result.outcome,
    code: result.code || null,
    order_id: settled ? result.orderId : null,
    message: paymentIssues.adminRetryMessage(result),
    issue,
  });
});

/* Manual resolution. One conditional UPDATE does the work: it only touches an OPEN
   issue that has NO order with the same payment reference, so "already resolved" and
   "an order exists" cannot slip in between a check and the write at the application
   level.
   Residual race (not eliminated, by design of this narrow fix): the NOT EXISTS
   subquery sees committed orders only, so a webhook/callback settlement — or a retry
   in ANOTHER server process — that commits its order a moment after this UPDATE is
   not seen. In this process, a running retry of the same issue is refused below. If
   an order does commit afterwards, resolveSettled() links it to this resolved issue
   without changing the recorded decision, and the admin API/UI flag the
   contradiction (manual_resolution_conflict). Exact isolation behaviour is still to
   be validated on MariaDB and TiDB staging. */
app.post("/api/admin/payment-issues/:id/resolve", requireAdmin, async (req, res) => {
  const id = positiveIdParam(req, res); if (!id) return;
  const v = paymentIssues.validateResolution(req.body);
  if (v.error) return res.status(400).json({ error: v.error, field: v.field });
  if (paymentIssueRetries.has(id)) {
    return res.status(409).json({ error: "A retry for this issue is in progress. Wait for it to finish, then review the issue again.", code: "RETRY_IN_PROGRESS" });
  }
  if (paymentIssueResolves.has(id)) {
    return res.status(409).json({ error: "This issue is already being resolved. Reload it in a moment.", code: "RESOLVE_IN_PROGRESS" });
  }
  paymentIssueResolves.add(id);
  try {
    const [result] = await pool.query(
      `UPDATE payment_issues pi
          SET pi.status = 'resolved', pi.resolution = ?, pi.resolution_note = ?, pi.resolved_by = ?, pi.resolved_at = CURRENT_TIMESTAMP
        WHERE pi.id = ? AND pi.status = 'open'
          AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.payment_reference = pi.payment_reference)`,
      [v.values.resolution, v.values.note, req.user.id, id]);
    if (result.affectedRows !== 1) {
      const issue = await loadPaymentIssue(id);
      if (!issue) return res.status(404).json({ error: "Payment issue not found." });
      if (issue.status !== "open") return res.status(409).json({ error: "This issue is already resolved.", code: "ALREADY_RESOLVED" });
      if (issue.has_order) return res.status(409).json({ error: "An order already exists for this payment. Use Retry settlement to link it, or handle the order itself.", code: "ORDER_EXISTS" });
      return res.status(409).json({ error: "The issue changed while you were resolving it. Reload and try again.", code: "ISSUE_CHANGED" });
    }
    console.warn(`Payment issue ${id} resolved as ${v.values.resolution} by admin id ${req.user.id}.`);
    res.json({ success: true, issue: await loadPaymentIssue(id) });
  } catch (err) {
    console.error("payment issue resolve failed:", err.code || err.message);
    res.status(500).json({ error: "Could not resolve the payment issue." });
  } finally {
    paymentIssueResolves.delete(id);
  }
});

// ---------- Admin: maintenance mode (Milestone 6 Phase 2) ----------
// Under /api/admin/ on purpose: the maintenance guard bypasses that prefix, so
// these stay reachable while maintenance is on — that is what makes turning it
// back off possible. requireAdmin still applies, and it re-reads the role from
// the database on every request, so the bypass grants no extra privilege.
// Separate on/off endpoints rather than a toggle: an operator retrying a request
// after a timeout must not flip the site back to the state they were leaving.

app.get("/api/admin/system/maintenance", requireAdmin, async (req, res) => {
  try {
    res.json(await maintenanceSettings.readMaintenanceDetail());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not read the maintenance setting." });
  }
});

app.post("/api/admin/system/maintenance/on", requireAdmin, async (req, res) => {
  try {
    await maintenanceSettings.setMaintenanceMode(true, req.user.id);
    console.warn(`Maintenance mode TURNED ON by admin id ${req.user.id}.`);
    res.json({ maintenance: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not enable maintenance mode." });
  }
});

app.post("/api/admin/system/maintenance/off", requireAdmin, async (req, res) => {
  try {
    await maintenanceSettings.setMaintenanceMode(false, req.user.id);
    console.warn(`Maintenance mode TURNED OFF by admin id ${req.user.id}.`);
    res.json({ maintenance: false });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not disable maintenance mode." });
  }
});

/* Saves mode, progress and message together. The dedicated on/off endpoints
   above are kept for the quick switch and for existing consumers; this is the
   full-configuration write used by the admin Maintenance page.

   Validation is strict and server-side: the browser's number input is a
   convenience, never the authority. Booleans must be real booleans (a string
   "true" or a 1 is rejected), progress must be a whole number 0-100, and the
   message must be text within MESSAGE_MAX.

   The message is stored and served as PLAIN TEXT. It is deliberately not
   HTML-escaped or tag-stripped here, because altering an administrator's words
   would be wrong — instead the public page renders it with textContent, so
   markup can never execute. */
function validateMaintenanceBody(body) {
  const b = body || {};

  if (typeof b.maintenance !== "boolean") {
    return { field: "maintenance", error: "maintenance must be true or false." };
  }

  // A strict integer, nothing else. Strings are rejected outright, INCLUDING
  // numeric ones like "60": the admin page converts the input value with
  // Number() before sending, so accepting "60" would only widen the API's
  // contract past the one its single client actually uses, and a looser rule
  // here is a rule that has to be re-proved every time something new calls it.
  // This one condition also covers null, undefined, "", true, false, NaN and
  // Infinity — each fails either the typeof or the isInteger half.
  const progress = b.progress;
  if (typeof progress !== "number" || !Number.isInteger(progress)) {
    return { field: "progress", error: "progress must be a whole number from 0 to 100." };
  }
  if (progress < 0 || progress > 100) {
    return { field: "progress", error: "progress must be between 0 and 100." };
  }

  let message = b.message;
  if (message === null || message === undefined) message = "";
  if (typeof message !== "string") return { field: "message", error: "message must be text." };
  message = message.replace(/\s+/g, " ").trim();
  if (message.length > maintenanceSettings.MESSAGE_MAX) {
    return { field: "message", error: `message must be ${maintenanceSettings.MESSAGE_MAX} characters or fewer.` };
  }

  return { values: { maintenance: b.maintenance, progress, message } };
}

app.post("/api/admin/maintenance", requireAdmin, async (req, res) => {
  const v = validateMaintenanceBody(req.body);
  if (v.error) return res.status(400).json({ error: v.error, field: v.field });
  try {
    const saved = await maintenanceSettings.saveMaintenanceConfig(v.values, req.user.id);
    console.warn(`Maintenance configuration saved by admin id ${req.user.id}: mode=${saved.maintenance} progress=${saved.progress}.`);
    res.json({ success: true, ...saved });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Could not save the maintenance configuration." });
  }
});

// ---------- JSON error responses (G-7) ----------
// Express's default error handler writes an HTML page that, outside production, includes the
// stack trace. Errors that get this far are request-parsing failures from express.json
// (malformed or oversized bodies — err.expose is set and the status is a 4xx) or something a
// route did not catch. Both are answered with JSON; the detail is logged here only. Unknown
// routes are not errors and keep Express's default 404. Registered after every route.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err && (err.status || err.statusCode));
  if (err && err.expose && status >= 400 && status < 500) {
    if (err.type === "entity.parse.failed") return res.status(400).json({ error: "The request body is not valid JSON.", code: "INVALID_JSON" });
    if (status === 413) return res.status(413).json({ error: "The request body is too large.", code: "PAYLOAD_TOO_LARGE" });
    return res.status(status).json({ error: "The request could not be processed.", code: "BAD_REQUEST" });
  }
  console.error("Unhandled error:", (err && err.stack) || err);
  res.status(500).json({ error: "Something went wrong. Please try again." });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`NeoFragrances API running at http://localhost:${PORT}`);
  const emailNotice = emailModeNotice();
  if (emailNotice) console.warn(emailNotice);
});