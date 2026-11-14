// pricing.js — the single authoritative price calculation for carts and payments.
//
// Every amount is computed by the server from the database in integer pesewas
// (GH₵1 = 100 pesewas). Prices, totals or discounts sent by the browser are
// never used. The same function prices the cart preview (/api/cart/quote) and
// Paystack initialization; payment verification then checks Paystack's charged
// amount against the signed snapshot produced here.

const crypto = require("crypto");

const CURRENCY = "GHS";
const SHIPPING_FLAT_PESEWAS = 800;   // GH₵8.00 flat shipping (existing business rule)
const MAX_CART_LINES = 50;
const MAX_QTY_PER_LINE = 50;

class PricingError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const toPesewas = value => Math.round(Number(value) * 100);
const toCedis = pesewas => Math.round(pesewas) / 100;
// True when n has at most 2 decimal places. n * 100 is compared with a small tolerance
// because floats can't hold most 2-dp values exactly (289.15 * 100 === 28914.999999999996).
const hasAtMost2dp = n => Number.isFinite(n) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;

function isPositiveInt(v) {
  if (typeof v === "boolean" || v === null || v === undefined || v === "") return false;
  const n = Number(v);
  return Number.isInteger(n) && n > 0;
}

// Validates the raw cart from the client and returns clean lines.
function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw new PricingError(400, "CART_EMPTY", "Your cart is empty.");
  }
  if (items.length > MAX_CART_LINES) {
    throw new PricingError(400, "CART_TOO_LARGE", "Your cart has too many items.");
  }
  return items.map(item => {
    if (!item || !isPositiveInt(item.productId)) {
      throw new PricingError(400, "INVALID_PRODUCT", "One of the items in your cart is not valid.");
    }
    if (!isPositiveInt(item.qty) || Number(item.qty) > MAX_QTY_PER_LINE) {
      throw new PricingError(400, "INVALID_QUANTITY", `Quantities must be whole numbers between 1 and ${MAX_QTY_PER_LINE}.`, { productId: Number(item.productId) });
    }
    const hasOffer = item.offerId !== undefined && item.offerId !== null && item.offerId !== "";
    if (hasOffer && !isPositiveInt(item.offerId)) {
      throw new PricingError(400, "INVALID_OFFER", "One of the offers in your cart is not valid.", { productId: Number(item.productId) });
    }
    return { productId: Number(item.productId), qty: Number(item.qty), offerId: hasOffer ? Number(item.offerId) : null };
  });
}

// Looks up and validates a coupon (by id or code). Returns null when none was given.
async function loadCoupon(db, { couponId, couponCode }) {
  const hasId = couponId !== undefined && couponId !== null && couponId !== "";
  const hasCode = typeof couponCode === "string" && couponCode.trim() !== "";
  if (!hasId && !hasCode) return null;
  if (hasId && !isPositiveInt(couponId)) throw new PricingError(400, "COUPON_INVALID", "That coupon is not valid.");

  const [rows] = await db.query(
    `SELECT id, code, discount_percent, discount_amount, usage_limit, times_used, active,
            (expires_at IS NOT NULL AND expires_at <= NOW()) AS is_expired
       FROM coupons WHERE ${hasId ? "id = ?" : "code = ?"}`,
    [hasId ? Number(couponId) : couponCode.trim().toUpperCase()]
  );
  const coupon = rows[0];
  if (!coupon) throw new PricingError(400, "COUPON_INVALID", "That coupon is not valid.");
  // Deactivated by an admin (migration 002). Kept distinct from COUPON_USED_UP so the
  // customer is not told a limit was reached when the code was simply withdrawn.
  if (!Number(coupon.active)) throw new PricingError(400, "COUPON_INACTIVE", "That coupon is not available.");
  if (Number(coupon.is_expired)) throw new PricingError(400, "COUPON_EXPIRED", "This coupon has expired.");
  if (coupon.usage_limit !== null && coupon.times_used >= coupon.usage_limit) {
    throw new PricingError(400, "COUPON_USED_UP", "This coupon has reached its usage limit.");
  }
  return coupon;
}

/**
 * Prices a cart from the database. Throws PricingError for anything that
 * cannot be charged as requested (unknown product, invalid quantity, not
 * enough stock, ended offer, invalid coupon).
 *
 * Returns amounts in pesewas:
 * { currency, lines: [{ productId, name, qty, offerId, unitPrice, regularUnitPrice, lineTotal }],
 *   subtotal, discount, shipping, total, coupon: { id, code } | null }
 */
async function priceCart(db, { items, couponId = null, couponCode = null }) {
  const lines = normalizeItems(items);
  const productIds = [...new Set(lines.map(l => l.productId))];
  const offerIds = [...new Set(lines.filter(l => l.offerId).map(l => l.offerId))];

  const [products] = await db.query(
    "SELECT id, name, price, stock_qty FROM products WHERE id IN (?) AND deleted_at IS NULL",
    [productIds]
  );
  const productById = new Map(products.map(p => [Number(p.id), p]));

  // Offer validity is evaluated by the database clock, exactly like /api/offers/active.
  let offerRows = [];
  if (offerIds.length) {
    [offerRows] = await db.query(
      `SELECT o.id AS offer_id, op.product_id, op.original_price, op.sale_price,
              (o.active = 1 AND NOW() >= o.start_at AND NOW() < o.end_at) AS is_live
         FROM offers o JOIN offer_products op ON op.offer_id = o.id
        WHERE o.id IN (?)`,
      [offerIds]
    );
  }

  const qtyByProduct = new Map();
  const priced = lines.map(line => {
    const product = productById.get(line.productId);
    if (!product) {
      throw new PricingError(409, "PRODUCT_UNAVAILABLE", "One of the items in your cart is no longer available.", { productId: line.productId });
    }
    let unitPrice = toPesewas(product.price);
    if (line.offerId) {
      const offer = offerRows.find(o => Number(o.offer_id) === line.offerId && Number(o.product_id) === line.productId);
      if (!offer || !Number(offer.is_live)) {
        throw new PricingError(409, "OFFER_UNAVAILABLE", `The offer on "${product.name}" has ended or is no longer available.`, { productId: line.productId, offerId: line.offerId });
      }
      unitPrice = toPesewas(offer.sale_price);
    }
    qtyByProduct.set(line.productId, (qtyByProduct.get(line.productId) || 0) + line.qty);
    return {
      productId: line.productId,
      name: product.name,
      qty: line.qty,
      offerId: line.offerId,
      unitPrice,
      regularUnitPrice: toPesewas(product.price),
      lineTotal: unitPrice * line.qty,
    };
  });

  // Stock is checked per product across all of its lines.
  for (const [productId, qty] of qtyByProduct) {
    const product = productById.get(productId);
    if (qty > product.stock_qty) {
      throw new PricingError(409, "INSUFFICIENT_STOCK",
        product.stock_qty > 0 ? `Only ${product.stock_qty} of "${product.name}" left in stock.` : `"${product.name}" is out of stock.`,
        { productId, available: product.stock_qty });
    }
  }

  const subtotal = priced.reduce((sum, l) => sum + l.lineTotal, 0);

  const coupon = await loadCoupon(db, { couponId, couponCode });
  let discount = 0;
  if (coupon) {
    if (Number(coupon.discount_percent)) discount = Math.round(subtotal * Number(coupon.discount_percent) / 100);
    else if (Number(coupon.discount_amount)) discount = toPesewas(coupon.discount_amount);
    discount = Math.max(0, Math.min(discount, subtotal));
  }

  const shipping = subtotal > 0 ? SHIPPING_FLAT_PESEWAS : 0;
  const total = subtotal - discount + shipping;

  return {
    currency: CURRENCY,
    lines: priced,
    subtotal,
    discount,
    shipping,
    total,
    coupon: coupon ? { id: Number(coupon.id), code: coupon.code } : null,
  };
}

/* ---------- Signed payment snapshot ----------
   The priced order is sent to Paystack as metadata at initialization and comes
   back at verification. The HMAC signature makes it tamper-evident, so the
   order is created from exactly what was priced and charged. */
function snapshotSecret() {
  const secret = process.env.PAYMENT_SIGNING_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error("PAYMENT_SIGNING_SECRET (or JWT_SECRET) must be configured.");
  return secret;
}

function signSnapshot(snapshot) {
  const payload = JSON.stringify(snapshot);
  const sig = crypto.createHmac("sha256", snapshotSecret()).update(payload).digest("hex");
  return { payload, sig };
}

function readSignedSnapshot(payload, sig) {
  if (typeof payload !== "string" || typeof sig !== "string" || !/^[a-f0-9]{64}$/.test(sig)) return null;
  const expected = crypto.createHmac("sha256", snapshotSecret()).update(payload).digest();
  const given = Buffer.from(sig, "hex");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try { return JSON.parse(payload); } catch (err) { return null; }
}

// Shape returned to the browser for display (cedis, two decimals).
function quoteForClient(pricing) {
  return {
    currency: pricing.currency,
    lines: pricing.lines.map(l => ({
      productId: l.productId, offerId: l.offerId, qty: l.qty, name: l.name,
      unitPrice: toCedis(l.unitPrice), regularUnitPrice: toCedis(l.regularUnitPrice), lineTotal: toCedis(l.lineTotal),
    })),
    subtotal: toCedis(pricing.subtotal),
    discount: toCedis(pricing.discount),
    shipping: toCedis(pricing.shipping),
    total: toCedis(pricing.total),
    coupon: pricing.coupon,
  };
}

module.exports = {
  CURRENCY, SHIPPING_FLAT_PESEWAS, PricingError,
  toPesewas, toCedis, hasAtMost2dp, priceCart, signSnapshot, readSignedSnapshot, quoteForClient,
};
