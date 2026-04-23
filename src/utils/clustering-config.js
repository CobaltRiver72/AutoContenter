'use strict';

// ─── Central per-feed clustering-config resolver ─────────────────────────────
// Each feed owns its own similarity threshold, minimum sources, buffer window,
// and same-domain toggle via feeds.quality_config (JSON). This module is the
// ONLY path any runtime code should take to learn those values. Direct reads
// of MIN_SOURCES_THRESHOLD / SIMILARITY_THRESHOLD / BUFFER_HOURS /
// ALLOW_SAME_DOMAIN_CLUSTERS from settings are a migration bug by the time
// this module ships.
//
// Resolution chain (first present wins):
//   feeds.quality_config[key]  →  config.get(globalKey)  →  hardcoded fallback
//
// The 5 s TTL cache mirrors config.js's get() cache so pipeline-tick reads
// stay cheap. Cache is invalidated on feed save (see invalidateClusteringCache
// called from PUT /api/feeds/:id).

var _cfg = require('./config');

var _db = null;
var _stmtGet = null;
var _cache = new Map();
var _CACHE_TTL_MS = 5000;

// Separate cache for getPrefilterFloor() — the SQL pre-filter floor used by
// the pipeline's readyClustersSql. Same TTL as the per-feed cache so there's
// one mental model for operators. Invalidated alongside the per-feed cache
// on any write to feeds.quality_config (create / update / delete).
var _floorCache = null;
var _floorCacheAt = 0;

/**
 * Initialise with a database reference. Call once at boot, after db is open.
 * Safe to call more than once (e.g. after a memory-watchdog db swap).
 * @param {import('better-sqlite3').Database} db
 */
function init(db) {
  _db = db;
  _stmtGet = null;
  _cache.clear();
  _floorCache = null;
  _floorCacheAt = 0;
}

function _toBool(v, fallback) {
  if (v === undefined || v === null || v === '') return !!fallback;
  if (typeof v === 'boolean') return v;
  var s = String(v).toLowerCase().trim();
  return s === 'true' || s === '1' || s === 'on' || s === 'yes';
}

function _globalDefaults() {
  return {
    min_sources:                parseInt(_cfg.get('MIN_SOURCES_THRESHOLD'), 10) || 2,
    similarity_threshold:       parseFloat(_cfg.get('SIMILARITY_THRESHOLD')) || 0.20,
    buffer_hours:               parseFloat(_cfg.get('BUFFER_HOURS')) || 2.5,
    allow_same_domain_clusters: _toBool(_cfg.get('ALLOW_SAME_DOMAIN_CLUSTERS'), true),
  };
}

/**
 * Resolve the clustering config for a feed. Returns a cached object; treat as
 * read-only.
 *
 * @param {number|null|undefined} feedId
 * @returns {{ min_sources:number, similarity_threshold:number, buffer_hours:number, allow_same_domain_clusters:boolean }}
 */
function resolveClusteringConfig(feedId) {
  // Legacy rows (no feed_id) stay on globals. Cached under the 'GLOBAL' key so
  // callers hitting 0/null repeatedly don't pay the _globalDefaults cost.
  if (!feedId) {
    var cachedG = _cache.get('GLOBAL');
    var nowG = Date.now();
    if (cachedG && cachedG.expires > nowG) return cachedG.value;
    var g = _globalDefaults();
    _cache.set('GLOBAL', { value: g, expires: nowG + _CACHE_TTL_MS });
    return g;
  }

  var cached = _cache.get(feedId);
  var now = Date.now();
  if (cached && cached.expires > now) return cached.value;

  var qc = {};
  if (_db) {
    try {
      if (!_stmtGet) _stmtGet = _db.prepare('SELECT quality_config FROM feeds WHERE id = ?');
      var row = _stmtGet.get(feedId);
      if (row && row.quality_config) {
        try { qc = JSON.parse(row.quality_config); } catch (_e) { qc = {}; }
      }
    } catch (_e) { /* fall through to globals */ }
  }

  var defaults = _globalDefaults();
  var resolved = {
    min_sources:                (typeof qc.min_sources === 'number') ? qc.min_sources : defaults.min_sources,
    similarity_threshold:       (typeof qc.similarity_threshold === 'number') ? qc.similarity_threshold : defaults.similarity_threshold,
    buffer_hours:               (typeof qc.buffer_hours === 'number') ? qc.buffer_hours : defaults.buffer_hours,
    allow_same_domain_clusters: (typeof qc.allow_same_domain_clusters === 'boolean') ? qc.allow_same_domain_clusters : defaults.allow_same_domain_clusters,
  };

  _cache.set(feedId, { value: resolved, expires: now + _CACHE_TTL_MS });
  return resolved;
}

/**
 * Invalidate the cache. Called from the feed PUT handler so a saved config
 * takes effect on the next pipeline tick instead of waiting for the TTL.
 *
 * @param {number|null} [feedId] - If omitted, clears the whole cache
 *   (including the 'GLOBAL' entry — useful after a Pipeline Settings save
 *   that moves a global default).
 */
function invalidateClusteringCache(feedId) {
  if (feedId) {
    _cache.delete(feedId);
  } else {
    _cache.clear();
  }
}

/**
 * Compute the LOOSEST (minimum) min_sources + similarity_threshold across
 * every row in feeds — the floor for pipeline.js's SQL pre-filter. A feed
 * configured more permissive than the global would otherwise be silently
 * excluded at the SQL layer before the per-feed resolver ever sees its
 * clusters. The per-feed resolver still applies the precise gate downstream;
 * this floor only guarantees the candidate reaches it.
 *
 * Layering:
 *   each feed: q.min_sources || globals.min_sources   (same for similarity)
 *   floor = min(each feed's effective value)
 *   clamped to [1, 0] respectively for sanity.
 *
 * @returns {{ min_sources:number, similarity_threshold:number }}
 */
function _computeFloor() {
  var defaults = _globalDefaults();
  var fallback = {
    min_sources: Math.max(1, Math.floor(defaults.min_sources)),
    similarity_threshold: Math.max(0, defaults.similarity_threshold),
  };

  if (!_db) return fallback;

  var rows;
  try {
    rows = _db.prepare('SELECT quality_config FROM feeds').all();
  } catch (_e) { return fallback; }

  if (!rows.length) return fallback;

  var loosestMs = defaults.min_sources;
  var loosestSt = defaults.similarity_threshold;

  for (var i = 0; i < rows.length; i++) {
    var q = {};
    try { q = JSON.parse(rows[i].quality_config || '{}'); } catch (_pe) { q = {}; }

    var ms = (typeof q.min_sources === 'number' && isFinite(q.min_sources))
      ? q.min_sources
      : defaults.min_sources;
    var st = (typeof q.similarity_threshold === 'number' && isFinite(q.similarity_threshold))
      ? q.similarity_threshold
      : defaults.similarity_threshold;

    if (ms < loosestMs) loosestMs = ms;
    if (st < loosestSt) loosestSt = st;
  }

  return {
    min_sources: Math.max(1, Math.floor(loosestMs)),
    similarity_threshold: Math.max(0, loosestSt),
  };
}

function getPrefilterFloor() {
  var now = Date.now();
  if (_floorCache && (now - _floorCacheAt) < _CACHE_TTL_MS) return _floorCache;
  _floorCache = _computeFloor();
  _floorCacheAt = now;
  return _floorCache;
}

function invalidateFloorCache() {
  _floorCache = null;
  _floorCacheAt = 0;
}

/**
 * Compute the max buffer_hours across all active feeds — used by the
 * similarity prefetch to cover every feed's window in a single query.
 * Falls back to the global BUFFER_HOURS if nothing resolves.
 *
 * @returns {number}
 */
function getMaxBufferHours() {
  var fallback = parseFloat(_cfg.get('BUFFER_HOURS')) || 2.5;
  if (!_db) return fallback;
  try {
    var rows = _db.prepare("SELECT quality_config FROM feeds WHERE is_active = 1").all();
    var maxH = fallback;
    for (var i = 0; i < rows.length; i++) {
      try {
        var q = JSON.parse(rows[i].quality_config || '{}');
        if (typeof q.buffer_hours === 'number' && q.buffer_hours > maxH) {
          maxH = q.buffer_hours;
        }
      } catch (_e) { /* skip malformed */ }
    }
    return maxH;
  } catch (_e) {
    return fallback;
  }
}

module.exports = {
  init: init,
  resolveClusteringConfig: resolveClusteringConfig,
  invalidateClusteringCache: invalidateClusteringCache,
  getMaxBufferHours: getMaxBufferHours,
  getPrefilterFloor: getPrefilterFloor,
  invalidateFloorCache: invalidateFloorCache,
};
