// settings.js — runtime settings read from app_settings (migration 003).
//
// Maintenance mode is the only consumer today, and it stores three keys in the
// existing key/value table — no schema change, no new table:
//
//   maintenance_mode      'true' | 'false'   (anything but exactly 'true' = OFF)
//   maintenance_progress  '0'..'100'         (stored as a short numeric string)
//   maintenance_message   plain text, <= MESSAGE_MAX chars
//
// Two rules matter more than anything else here, and both exist so an
// operational flag can never become an outage:
//
//   1. FAIL OPEN. Every failure path returns maintenance = OFF: a missing row,
//      a missing table, an unreachable database, a malformed value. The flag
//      decides whether to take the storefront down, so the one thing it must
//      never do is take the storefront down by accident. A transient DB blip
//      must look like "site up", not "site in maintenance".
//
//      This extends to the two new keys: a malformed or missing progress or
//      message can NEVER turn maintenance on. The mode is derived solely from
//      maintenance_mode; progress and message are presentation only and fall
//      back to 0 and "" without affecting it.
//
//   2. CACHE, because the guard runs ahead of every /api/* request. Without a
//      cache, turning maintenance on would add a query to every request —
//      including the ones still being served. The TTL is short so the flag is
//      responsive, and the admin writes invalidate synchronously so the
//      operator never waits for it.
//
// Multi-instance note: the cache is per process. On Render with more than one
// instance each holds its own copy, so a toggle can take up to TTL_MS to be
// seen everywhere. That is the same caveat the in-memory rate limiters already
// carry (see PROJECT-BACKLOG.md item 4).
const pool = require("./db");

const MAINTENANCE_KEY = "maintenance_mode";
const PROGRESS_KEY = "maintenance_progress";
const MESSAGE_KEY = "maintenance_message";
// 200 leaves headroom inside app_settings.setting_value VARCHAR(255).
const MESSAGE_MAX = 200;
const TTL_MS = 7000; // ~5-10s as designed: responsive, but not per-request

const DEFAULT_CONFIG = { maintenance: false, progress: 0, message: "" };

let cached = null;      // null = nothing cached yet
let cachedAt = 0;

// Coerces any stored or supplied value into 0..100. Never throws; anything
// unusable becomes 0 so a corrupt row cannot break the page or the guard.
function normalizeProgress(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, Math.round(n)));
}

// Collapses whitespace, trims, and hard-caps the length. Stored and served as
// PLAIN TEXT — the public page renders it with textContent, never innerHTML.
function normalizeMessage(raw) {
  if (raw === null || raw === undefined) return "";
  return String(raw).replace(/\s+/g, " ").trim().slice(0, MESSAGE_MAX);
}

// Reads all three keys in one query, preferring the cache.
// Never throws and never rejects.
async function readMaintenanceConfig() {
  const now = Date.now();
  if (cached !== null && now - cachedAt < TTL_MS) return cached;
  let config = { ...DEFAULT_CONFIG };
  try {
    const [rows] = await pool.query(
      "SELECT setting_key, setting_value FROM app_settings WHERE setting_key IN (?, ?, ?)",
      [MAINTENANCE_KEY, PROGRESS_KEY, MESSAGE_KEY]
    );
    const found = new Map(rows.map(r => [r.setting_key, r.setting_value]));
    // Absent row = OFF. Any value other than exactly 'true' = OFF.
    config.maintenance = found.has(MAINTENANCE_KEY)
      && String(found.get(MAINTENANCE_KEY)).trim().toLowerCase() === "true";
    config.progress = found.has(PROGRESS_KEY) ? normalizeProgress(found.get(PROGRESS_KEY)) : 0;
    config.message = found.has(MESSAGE_KEY) ? normalizeMessage(found.get(MESSAGE_KEY)) : "";
  } catch (err) {
    // Fail OPEN. Cached like a real answer so a sick database is not hammered
    // once per request; the next read after TTL_MS tries again.
    console.error("maintenance settings read failed — failing OPEN (site stays up):", err.code || err.message);
    config = { ...DEFAULT_CONFIG };
  }
  cached = config;
  cachedAt = now;
  return config;
}

// The guard's hot path: just the boolean. Kept as its own export so the
// middleware signature and behaviour are unchanged from Phase 2.
async function isMaintenanceMode() {
  return (await readMaintenanceConfig()).maintenance;
}

// Writes the flag and drops the cache in the same tick, so the very next
// request in this process already sees the new state. Used by the original
// dedicated on/off endpoints, which only ever change the mode.
async function setMaintenanceMode(on, adminId) {
  const stored = on ? "true" : "false";
  await pool.query(
    `INSERT INTO app_settings (setting_key, setting_value, updated_by)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
    [MAINTENANCE_KEY, stored, adminId || null]
  );
  invalidateMaintenanceCache();
  return !!on;
}

// Writes all three keys atomically: either every value lands or none does, so
// the public page can never show a new message against an old mode. The cache
// is dropped only after the commit succeeds.
async function saveMaintenanceConfig({ maintenance, progress, message }, adminId) {
  const by = adminId || null;
  const writes = [
    [MAINTENANCE_KEY, maintenance ? "true" : "false"],
    [PROGRESS_KEY, String(normalizeProgress(progress))],
    [MESSAGE_KEY, normalizeMessage(message)],
  ];
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    for (const [key, value] of writes) {
      await connection.query(
        `INSERT INTO app_settings (setting_key, setting_value, updated_by)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
        [key, value, by]
      );
    }
    await connection.commit();
  } catch (err) {
    await connection.rollback().catch(() => {});
    throw err;
  } finally {
    connection.release();
  }
  invalidateMaintenanceCache();
  return {
    maintenance: !!maintenance,
    progress: normalizeProgress(progress),
    message: normalizeMessage(message),
  };
}

function invalidateMaintenanceCache() {
  cached = null;
  cachedAt = 0;
}

// Admin-facing detail: the three values plus who last changed them and when.
// Returns nulls when the rows have never been written. Also fails open on a
// read error. These audit fields are admin-only and are deliberately NOT part
// of the public /api/system/status payload.
async function readMaintenanceDetail() {
  try {
    const [rows] = await pool.query(
      `SELECT s.setting_key, s.setting_value, s.updated_at, s.updated_by, u.full_name AS updated_by_name
         FROM app_settings s
         LEFT JOIN users u ON u.id = s.updated_by
        WHERE s.setting_key IN (?, ?, ?)`,
      [MAINTENANCE_KEY, PROGRESS_KEY, MESSAGE_KEY]
    );
    const byKey = new Map(rows.map(r => [r.setting_key, r]));
    const mode = byKey.get(MAINTENANCE_KEY);
    const progress = byKey.get(PROGRESS_KEY);
    const message = byKey.get(MESSAGE_KEY);
    // The mode row carries the audit fields the Phase 2 admin view reports.
    return {
      maintenance: !!mode && String(mode.setting_value).trim().toLowerCase() === "true",
      progress: progress ? normalizeProgress(progress.setting_value) : 0,
      message: message ? normalizeMessage(message.setting_value) : "",
      message_max: MESSAGE_MAX,
      updated_at: mode ? mode.updated_at : null,
      updated_by: mode ? mode.updated_by : null,
      updated_by_name: mode ? mode.updated_by_name : null,
    };
  } catch (err) {
    console.error("maintenance detail read failed — reporting OFF:", err.code || err.message);
    return { ...DEFAULT_CONFIG, message_max: MESSAGE_MAX, updated_at: null, updated_by: null, updated_by_name: null, unavailable: true };
  }
}

module.exports = {
  MAINTENANCE_KEY,
  PROGRESS_KEY,
  MESSAGE_KEY,
  MESSAGE_MAX,
  TTL_MS,
  normalizeProgress,
  normalizeMessage,
  readMaintenanceConfig,
  isMaintenanceMode,
  setMaintenanceMode,
  saveMaintenanceConfig,
  invalidateMaintenanceCache,
  readMaintenanceDetail,
};
