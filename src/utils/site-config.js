'use strict';

var config = require('./config');

// ─── In-process TTL cache (mirrors config.get() pattern) ───────────────────
// Key format: "siteId:configKey"  →  { value, expires }
var _cache = new Map();
var _CACHE_TTL_MS = 5000;
var _db = null;

// Lazy-init prepared statements
var _stmtGet = null;
var _stmtGetAll = null;
var _stmtUpsert = null;
var _stmtDelete = null;
var _stmtGetSite = null;
var _stmtGetAllSites = null;

function _initDb(db) {
  if (db) _db = db;
  if (!_db) throw new Error('site-config: no database. Call init(db) first.');
  return _db;
}

function _invalidate(siteId, key) {
  if (siteId && key) _cache.delete(siteId + ':' + key);
  else if (siteId) {
    // Invalidate all keys for this site
    _cache.forEach(function (_v, k) {
      if (k.indexOf(siteId + ':') === 0) _cache.delete(k);
    });
  } else {
    _cache.clear();
  }
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Initialise with a database reference. Call once after DB is ready.
 * @param {import('better-sqlite3').Database} db
 */
function init(db) {
  _db = db;
  _stmtGet = null;
  _stmtGetAll = null;
  _stmtUpsert = null;
  _stmtDelete = null;
  _stmtGetSite = null;
  _stmtGetAllSites = null;
  _cache.clear();
}

/**
 * Get a single per-site config value.
 *
 * Resolution chain (first non-empty wins):
 *   site_config[siteId][key]  →  global settings[key]  →  DEFAULTS[key]
 *
 * Uses a 5 s TTL cache to avoid hitting SQLite on every pipeline tick.
 *
 * @param {number} siteId
 * @param {string} key
 * @returns {*}
 */
function getSiteConfig(siteId, key) {
  var cacheKey = siteId + ':' + key;
  var cached = _cache.get(cacheKey);
  var now = Date.now();
  if (cached && cached.expires > now) return cached.value;

  var value;
  var db = _initDb();

  // 1. site_config table
  try {
    if (!_stmtGet) _stmtGet = db.prepare('SELECT value FROM site_config WHERE site_id = ? AND key = ?');
    var row = _stmtGet.get(siteId, key);
    if (row) value = row.value;
  } catch (_e) { /* fall through */ }

  // 2. Global config (settings table → env → DEFAULTS)
  if (value === undefined || value === null) {
    value = config.get(key);
  }

  _cache.set(cacheKey, { value: value, expires: now + _CACHE_TTL_MS });
  return value;
}

/**
 * Write a per-site config value.
 *
 * @param {number} siteId
 * @param {string} key
 * @param {*} value
 */
function setSiteConfig(siteId, key, value) {
  var db = _initDb();
  if (!_stmtUpsert) {
    _stmtUpsert = db.prepare(
      "INSERT INTO site_config (site_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now')) " +
      "ON CONFLICT(site_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
    );
  }
  _stmtUpsert.run(siteId, key, String(value));
  _invalidate(siteId, key);
}

/**
 * Delete a per-site config key (falls back to global).
 *
 * @param {number} siteId
 * @param {string} key
 */
function deleteSiteConfig(siteId, key) {
  var db = _initDb();
  if (!_stmtDelete) {
    _stmtDelete = db.prepare('DELETE FROM site_config WHERE site_id = ? AND key = ?');
  }
  _stmtDelete.run(siteId, key);
  _invalidate(siteId, key);
}

/**
 * Get ALL per-site config rows (for dashboard rendering).
 * Returns a plain object { key: value, ... }.
 *
 * @param {number} siteId
 * @returns {Record<string, string>}
 */
function getAllSiteConfig(siteId) {
  var db = _initDb();
  if (!_stmtGetAll) _stmtGetAll = db.prepare('SELECT key, value FROM site_config WHERE site_id = ?');
  var rows = _stmtGetAll.all(siteId);
  var result = {};
  for (var i = 0; i < rows.length; i++) {
    result[rows[i].key] = rows[i].value;
  }
  return result;
}

/**
 * Bulk upsert per-site config (used by dashboard save).
 *
 * @param {number} siteId
 * @param {Record<string, string>} kvPairs
 */
function bulkSetSiteConfig(siteId, kvPairs) {
  var db = _initDb();
  if (!_stmtUpsert) {
    _stmtUpsert = db.prepare(
      "INSERT INTO site_config (site_id, key, value, updated_at) VALUES (?, ?, ?, datetime('now')) " +
      "ON CONFLICT(site_id, key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
    );
  }
  var keys = Object.keys(kvPairs);
  var txn = db.transaction(function () {
    for (var i = 0; i < keys.length; i++) {
      _stmtUpsert.run(siteId, keys[i], String(kvPairs[keys[i]]));
    }
  });
  txn();
  _invalidate(siteId);
}

/**
 * Boolean helper (mirrors config.isEnabled).
 *
 * @param {number} siteId
 * @param {string} key
 * @returns {boolean}
 */
function isSiteConfigEnabled(siteId, key) {
  var val = getSiteConfig(siteId, key);
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string') return val.toLowerCase() === 'true' || val === '1';
  return !!val;
}

// ─── Site CRUD helpers ─────────────────────────────────────────────────────

/**
 * Get a site row by id.
 *
 * @param {number} siteId
 * @returns {object|undefined}
 */
function getSite(siteId) {
  var db = _initDb();
  if (!_stmtGetSite) _stmtGetSite = db.prepare('SELECT * FROM sites WHERE id = ?');
  return _stmtGetSite.get(siteId);
}

/**
 * Get all active sites.
 *
 * @returns {object[]}
 */
function getAllActiveSites() {
  var db = _initDb();
  if (!_stmtGetAllSites) _stmtGetAllSites = db.prepare('SELECT * FROM sites WHERE is_active = 1 ORDER BY id');
  return _stmtGetAllSites.all();
}

/**
 * Get all sites (including inactive).
 *
 * @returns {object[]}
 */
function getAllSites() {
  var db = _initDb();
  return db.prepare('SELECT * FROM sites ORDER BY id').all();
}

/**
 * Create a new site. Returns the new site row.
 *
 * @param {object} data - { name, slug, color?, firehose_token?, wp_url?, wp_username?, wp_app_password? }
 * @returns {object}
 */
function createSite(data) {
  var db = _initDb();
  var result = db.prepare(
    'INSERT INTO sites (name, slug, color, firehose_token, wp_url, wp_username, wp_app_password) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(
    data.name, data.slug, data.color || '#3b82f6',
    data.firehose_token || null,
    data.wp_url || null, data.wp_username || null, data.wp_app_password || null
  );
  // Reset cached statement so it picks up new rows
  _stmtGetAllSites = null;
  return getSite(result.lastInsertRowid);
}

/**
 * Update a site. Only updates provided fields.
 *
 * @param {number} siteId
 * @param {object} data
 * @returns {object}
 */
function updateSite(siteId, data) {
  var db = _initDb();
  var fields = [];
  var values = [];
  var allowed = ['name', 'slug', 'color', 'is_active', 'firehose_token', 'wp_url', 'wp_username', 'wp_app_password'];
  for (var i = 0; i < allowed.length; i++) {
    if (data[allowed[i]] !== undefined) {
      fields.push(allowed[i] + ' = ?');
      values.push(data[allowed[i]]);
    }
  }
  if (fields.length === 0) return getSite(siteId);
  fields.push("updated_at = datetime('now')");
  values.push(siteId);
  var stmt = db.prepare('UPDATE sites SET ' + fields.join(', ') + ' WHERE id = ?');
  stmt.run.apply(stmt, values);
  _stmtGetSite = null;
  _stmtGetAllSites = null;
  return getSite(siteId);
}

/**
 * Soft-delete a site (set is_active = 0).
 *
 * @param {number} siteId
 */
function deactivateSite(siteId) {
  var db = _initDb();
  db.prepare("UPDATE sites SET is_active = 0, updated_at = datetime('now') WHERE id = ?").run(siteId);
  _stmtGetSite = null;
  _stmtGetAllSites = null;
  _invalidate(siteId);
}

module.exports = {
  init: init,
  getSiteConfig: getSiteConfig,
  setSiteConfig: setSiteConfig,
  deleteSiteConfig: deleteSiteConfig,
  getAllSiteConfig: getAllSiteConfig,
  bulkSetSiteConfig: bulkSetSiteConfig,
  isSiteConfigEnabled: isSiteConfigEnabled,
  getSite: getSite,
  getAllActiveSites: getAllActiveSites,
  getAllSites: getAllSites,
  createSite: createSite,
  updateSite: updateSite,
  deactivateSite: deactivateSite,
};
