// mailer.js — sends order confirmation and password-reset emails via SendGrid
//
// Uses SendGrid's Single Sender Verification (one verified email address,
// no domain purchase/DNS required) rather than domain authentication.
// This means real customers at any email provider can receive mail — the
// earlier Resend sandbox restriction (recipient must match the Resend
// signup email) does not apply here.
//
// Note: without full domain authentication (SPF/DKIM tied to a domain
// you own), deliverability is solid but slightly more likely to land in
// spam/junk on some providers than a fully authenticated domain would.
// That's a SendGrid-documented tradeoff of single sender verification,
// not a bug — fine for this project's current scale.
//
// No new npm dependency — this uses the same global `fetch()` already
// used elsewhere in this project (see the Paystack calls in server.js).

const SENDGRID_API_URL = "https://api.sendgrid.com/v3/mail/send";
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL;
const FROM_NAME = "NeoFragrances";

// Escapes user-controlled values (names, product names, links) before
// they are interpolated into email HTML.
function escapeHtml(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ---------- Local development email log (DEV_EMAIL_LOG) ----------
   For local development without SendGrid: when DEV_EMAIL_LOG=true, emails are
   printed to this server's console instead of being sent, so verification and
   password-reset links can be followed locally. Links are never returned to the
   browser. It can never activate in production: it is ignored when
   NODE_ENV=production or on Render (which sets RENDER=true), and it only takes
   over when SendGrid is not configured. */
function devEmailLogRequested() {
  return process.env.DEV_EMAIL_LOG === "true";
}

function devEmailLogEnabled() {
  if (!devEmailLogRequested()) return false;
  if (process.env.NODE_ENV === "production" || process.env.RENDER) return false;
  return true;
}

function sendgridConfigured() {
  return !!(process.env.SENDGRID_API_KEY && FROM_EMAIL);
}

function shouldLogInsteadOfSend() {
  return devEmailLogEnabled() && !sendgridConfigured();
}

function logDevEmail(kind, to, lines) {
  console.log(`\n[DEV_EMAIL_LOG] ${kind} email for ${to} (not sent — local development)\n  ${lines.join("\n  ")}\n`);
}

// One-line startup notice so it's obvious which email mode is active.
function emailModeNotice() {
  if (devEmailLogRequested() && !devEmailLogEnabled()) return "DEV_EMAIL_LOG is set but ignored in production.";
  if (shouldLogInsteadOfSend()) return "DEV_EMAIL_LOG is ON: verification/reset links are printed to this console, not emailed.";
  if (!sendgridConfigured()) return "SendGrid is not configured: emails will not be sent.";
  return null;
}

async function sendViaSendGrid({ to, subject, html }) {
  if (!process.env.SENDGRID_API_KEY) {
    throw new Error("SENDGRID_API_KEY is not configured.");
  }
  if (!FROM_EMAIL) {
    throw new Error("SENDGRID_FROM_EMAIL is not configured — set it to your verified Single Sender address.");
  }

  const res = await fetch(SENDGRID_API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject,
      content: [{ type: "text/html", value: html }],
    }),
  });

  // SendGrid returns 202 with an empty body on success — no res.json() to parse.
  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`SendGrid API error (${res.status}): ${errorBody}`);
  }
}

// Formats an amount in Ghana cedis for emails, e.g. GH₵1,250.00
const ghs = amount => `GH₵${Number(amount).toLocaleString("en-GH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function sendOrderConfirmation({ to, customerName, orderId, items, subtotal, discount, shipping, total }) {
  if (shouldLogInsteadOfSend()) {
    logDevEmail("Order confirmation", to, [`Order #${orderId}`, ...items.map(i => `${i.qty} × ${i.name}`), `Total paid: ${ghs(total)}`]);
    return;
  }
  const itemRows = items.map(item => `
    <tr>
      <td style="padding:10px 0; border-bottom:1px solid #E4DAD0;">${escapeHtml(item.name)} &times; ${escapeHtml(item.qty)}</td>
      <td style="padding:10px 0; border-bottom:1px solid #E4DAD0; text-align:right;">${ghs(item.price * item.qty)}</td>
    </tr>`).join("");

  const html = `
  <div style="font-family: Arial, sans-serif; max-width:520px; margin:0 auto; color:#2B1B2E;">
    <div style="background:#2B1B2E; padding:24px; text-align:center;">
      <span style="font-size:22px; font-weight:bold; color:#fff;">Neo<span style="color:#B8935F;">Fragrances</span></span>
    </div>
    <div style="padding:30px 24px;">
      <h2 style="margin-top:0;">Thank you, ${escapeHtml(customerName)}!</h2>
      <p style="color:#5C4A5E;">Your order has been confirmed and is now being processed.</p>
      <p style="font-weight:bold; margin-top:20px;">Order #${escapeHtml(orderId)}</p>
      <table style="width:100%; border-collapse:collapse; margin-top:10px;">
        ${itemRows}
      </table>
      <table style="width:100%; padding-top:16px; font-size:14px; color:#5C4A5E;">
        ${subtotal !== undefined ? `<tr><td style="padding:3px 0;">Subtotal</td><td style="padding:3px 0; text-align:right;">${ghs(subtotal)}</td></tr>` : ""}
        ${discount ? `<tr><td style="padding:3px 0;">Discount</td><td style="padding:3px 0; text-align:right;">−${ghs(discount)}</td></tr>` : ""}
        ${shipping !== undefined ? `<tr><td style="padding:3px 0;">Shipping</td><td style="padding:3px 0; text-align:right;">${ghs(shipping)}</td></tr>` : ""}
        <tr>
          <td style="font-weight:bold; font-size:16px; color:#2B1B2E; padding-top:8px;">Total paid</td>
          <td style="font-weight:bold; font-size:16px; color:#2B1B2E; padding-top:8px; text-align:right;">${ghs(total)}</td>
        </tr>
      </table>
      <p style="color:#5C4A5E; margin-top:30px; font-size:13px;">You can track this order anytime from your account under "My Orders."</p>
    </div>
    <div style="background:#FAF6F0; padding:16px; text-align:center; font-size:12px; color:#5C4A5E;">
      &copy; 2026 NeoFragrances. All rights reserved.
    </div>
  </div>`;

  await sendViaSendGrid({
    to,
    subject: `Order Confirmation — #${orderId}`,
    html,
  });
}

/**
 * Sends the password-reset email. The reset link is only ever sent here —
 * it is never returned in an API response or rendered in the frontend.
 */
async function sendPasswordResetEmail({ to, customerName, resetUrl }) {
  if (shouldLogInsteadOfSend()) {
    logDevEmail("Password reset", to, [`Reset link (valid 1 hour): ${resetUrl}`]);
    return;
  }
  const html = `
  <div style="font-family: Arial, sans-serif; max-width:520px; margin:0 auto; color:#2B1B2E;">
    <div style="background:#2B1B2E; padding:24px; text-align:center;">
      <span style="font-size:22px; font-weight:bold; color:#fff;">Neo<span style="color:#B8935F;">Fragrances</span></span>
    </div>
    <div style="padding:32px 28px;">
      <h2 style="margin-top:0; font-family: Georgia, serif;">Reset Your Password</h2>
      <p style="color:#5C4A5E; line-height:1.6;">
        Hi ${escapeHtml(customerName || "there")}, we received a request to reset the password for your NeoFragrances
        account. Click the button below to choose a new password. This link will expire in
        <strong>1 hour</strong>.
      </p>
      <div style="text-align:center; margin:32px 0;">
        <a href="${escapeHtml(resetUrl)}"
           style="background:#6B2737; color:#ffffff; text-decoration:none; font-weight:bold; font-size:15px; padding:14px 34px; border-radius:6px; display:inline-block;">
          Reset Password
        </a>
      </div>
      <p style="color:#5C4A5E; font-size:13px; line-height:1.6;">
        If the button above doesn't work, copy and paste this link into your browser:<br>
        <a href="${escapeHtml(resetUrl)}" style="color:#6B2737; word-break:break-all;">${escapeHtml(resetUrl)}</a>
      </p>
      <p style="color:#5C4A5E; font-size:13px; margin-top:28px; padding-top:20px; border-top:1px solid #E4DAD0;">
        If you didn't request a password reset, you can safely ignore this email — your password will
        remain unchanged.
      </p>
    </div>
    <div style="background:#FAF6F0; padding:16px; text-align:center; font-size:12px; color:#5C4A5E;">
      &copy; 2026 NeoFragrances. All rights reserved.
    </div>
  </div>`;

  await sendViaSendGrid({
    to,
    subject: "Reset Your NeoFragrances Password",
    html,
  });
}

/**
 * Sends the "verify your email" link shown right after registration.
 * Like the password-reset email, the link is only ever sent here — never
 * returned in an API response or rendered on screen.
 */
async function sendVerificationEmail({ to, customerName, verifyUrl }) {
  if (shouldLogInsteadOfSend()) {
    logDevEmail("Email verification", to, [`Verification link (valid 24 hours): ${verifyUrl}`]);
    return;
  }
  const html = `
  <div style="font-family: Arial, sans-serif; max-width:520px; margin:0 auto; color:#2B1B2E;">
    <div style="background:#2B1B2E; padding:24px; text-align:center;">
      <span style="font-size:22px; font-weight:bold; color:#fff;">Neo<span style="color:#B8935F;">Fragrances</span></span>
    </div>
    <div style="padding:32px 28px;">
      <h2 style="margin-top:0; font-family: Georgia, serif;">Verify Your Email</h2>
      <p style="color:#5C4A5E; line-height:1.6;">
        Hi ${escapeHtml(customerName || "there")}, thanks for creating a NeoFragrances account! Please confirm this is your
        email address by clicking the button below. This link will expire in <strong>24 hours</strong>.
      </p>
      <div style="text-align:center; margin:32px 0;">
        <a href="${escapeHtml(verifyUrl)}"
           style="background:#6B2737; color:#ffffff; text-decoration:none; font-weight:bold; font-size:15px; padding:14px 34px; border-radius:6px; display:inline-block;">
          Verify Email
        </a>
      </div>
      <p style="color:#5C4A5E; font-size:13px; line-height:1.6;">
        If the button above doesn't work, copy and paste this link into your browser:<br>
        <a href="${escapeHtml(verifyUrl)}" style="color:#6B2737; word-break:break-all;">${escapeHtml(verifyUrl)}</a>
      </p>
      <p style="color:#5C4A5E; font-size:13px; margin-top:28px; padding-top:20px; border-top:1px solid #E4DAD0;">
        If you didn't create a NeoFragrances account, you can safely ignore this email.
      </p>
    </div>
    <div style="background:#FAF6F0; padding:16px; text-align:center; font-size:12px; color:#5C4A5E;">
      &copy; 2026 NeoFragrances. All rights reserved.
    </div>
  </div>`;

  await sendViaSendGrid({
    to,
    subject: "Verify Your NeoFragrances Email",
    html,
  });
}

module.exports = { sendOrderConfirmation, sendPasswordResetEmail, sendVerificationEmail, emailModeNotice };
