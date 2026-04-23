'use strict';

// ─── Per-site publish-rate resolver ──────────────────────────────────────────
// Replaces the legacy MAX_PUBLISH_PER_HOUR + PUBLISH_COOLDOWN_MINUTES pair
// with a single unified rule: "count posts per {hour,day,week}". Each site
// gets its own cadence via site_config; the globals are the fallback layer.
//
// Resolution chain (first present wins):
//   site_config[siteId].SITE_PUBLISH_RATE_{COUNT,UNIT}  →
//   settings.PUBLISH_RATE_{COUNT,UNIT}                  →
//   settings.MAX_PUBLISH_PER_HOUR (legacy, 'hour')      →
//   hardcoded 4/hour
//
// The 5 s TTL cache mirrors clustering-config.js so publish-tick reads stay
// cheap. Invalidated from PUT /api/sites/:id/config after a successful save.

var siteConfig = require('./site-config');

var _cache = new Map();
var _CACHE_TTL_MS = 5000;

// Optional logger hook — wired from index.js at boot. Kept optional so the
// module can be required from migration code or tests without a ready logger.
var _logger = null;

function init(logger) {
  if (logger && typeof logger.debug === 'function') _logger = logger;
  _cache.clear();
}

function _normalizeUnit(u) {
  if (!u) return null;
  var s = String(u).toLowerCase().trim();
  return (s === 'hour' || s === 'day' || s === 'week') ? s : null;
}

function _windowMsForUnit(unit) {
  if (unit === 'hour') return 3600000;
  if (unit === 'day')  return 86400000;
  if (unit === 'week') return 604800000;
  return 0;
}

function _globalUnified(config) {
  var unit = _normalizeUnit(config.get('PUBLISH_RATE_UNIT'));
  var count = parseInt(config.get('PUBLISH_RATE_COUNT'), 10);
  if (isNaN(count) || count <= 0) count = 0;
  return { unit: unit, count: count };
}

function _globalLegacyFallback(config) {
  // Only reached when BOTH unified globals are empty. Migration seeds the
  // unified keys on first boot so this branch is rare post-deploy.
  var count = parseInt(config.get('MAX_PUBLISH_PER_HOUR'), 10);
  if (isNaN(count) || count <= 0) count = 4;
  return { unit: 'hour', count: count };
}

function _finalize(base, source) {
  var unit = base.unit;
  var count = Math.max(1, base.count || 1);
  var windowMs = _windowMsForUnit(unit);
  var gapMs = windowMs > 0 ? Math.floor(windowMs / count) : 0;
  return {
    count: count,
    unit: unit,
    windowMs: windowMs,
    gapMs: gapMs,
    source: source, // 'site' | 'unified' | 'legacy'
  };
}

/**
 * Resolve the publish rate for a site. Treat the returned object as read-only.
 *
 * @param {number|null|undefined} siteId  — 0/null/undefined returns the global
 *   (unified-or-legacy) rule. Used by aggregate monitoring views.
 * @param {object} config — the frozen config module (exposes .get()).
 * @returns {{ count:number, unit:string, windowMs:number, gapMs:number, source:'site'|'unified'|'legacy' }}
 */
function resolvePublishRate(siteId, config) {
  var cacheKey = siteId ? String(siteId) : 'GLOBAL';
  var now = Date.now();
  var cached = _cache.get(cacheKey);
  if (cached && cached.expires > now) return cached.value;

  var resolved;

  if (siteId) {
    var siteCount = parseInt(siteConfig.getSiteConfig(siteId, 'SITE_PUBLISH_RATE_COUNT'), 10);
    var siteUnit = _normalizeUnit(siteConfig.getSiteConfig(siteId, 'SITE_PUBLISH_RATE_UNIT'));
    if (siteUnit && !isNaN(siteCount) && siteCount > 0) {
      resolved = _finalize({ unit: siteUnit, count: siteCount }, 'site');
    }
  }

  if (!resolved) {
    var g = _globalUnified(config);
    if (g.unit && g.count > 0) {
      resolved = _finalize(g, 'unified');
    } else {
      resolved = _finalize(_globalLegacyFallback(config), 'legacy');
    }
  }

  _cache.set(cacheKey, { value: resolved, expires: now + _CACHE_TTL_MS });

  if (_logger) {
    _logger.debug('publish-rate', 'site=' + (siteId || 'GLOBAL') +
      ' resolved=' + resolved.count + '/' + resolved.unit +
      ' via=' + resolved.source + ' gapMs=' + resolved.gapMs);
  }

  return resolved;
}

/**
 * Invalidate the cached rule for a site (or all, if omitted). Call after a
 * site_config save so the next publish tick sees the new value without waiting
 * for the 5 s TTL.
 */
function invalidateCache(siteId) {
  if (siteId) _cache.delete(String(siteId));
  else _cache.clear();
}

/**
 * Max windowMs across every active site's resolved rate + the global. Used by
 * cleanup paths that need to retain history long enough for any site's window
 * to close. Returns ms.
 *
 * @param {object} config - for legacy fallback
 * @param {number[]} activeSiteIds - site IDs to consider
 * @returns {number}
 */
function getMaxWindowMs(config, activeSiteIds) {
  var globalRate = resolvePublishRate(null, config);
  var max = globalRate.windowMs;
  if (Array.isArray(activeSiteIds)) {
    for (var i = 0; i < activeSiteIds.length; i++) {
      var r = resolvePublishRate(activeSiteIds[i], config);
      if (r.windowMs > max) max = r.windowMs;
    }
  }
  return max;
}

module.exports = {
  init: init,
  resolvePublishRate: resolvePublishRate,
  invalidateCache: invalidateCache,
  getMaxWindowMs: getMaxWindowMs,
};
