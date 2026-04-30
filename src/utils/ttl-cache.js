'use strict';

// Tiny in-memory TTL cache. Used by routes whose response is computed by
// expensive aggregate queries (feeds/stats, clusters/stats, ...) and that
// don't need second-level freshness — a 30 s window is plenty for anything
// the dashboard renders.
//
// keyForIds() normalises an arbitrary id list into a stable string so a
// caller passing [3,1,2] gets the same cache slot as [1,2,3]. Callers
// that key off something other than an id-list build their own keys.

function TTLCache(ttlMs) {
  this._ttl = (typeof ttlMs === 'number' && ttlMs > 0) ? ttlMs : 30000;
  this._store = new Map();
}

TTLCache.prototype.get = function (key) {
  var entry = this._store.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) {
    this._store.delete(key);
    return undefined;
  }
  return entry.value;
};

TTLCache.prototype.set = function (key, value) {
  this._store.set(key, { value: value, expires: Date.now() + this._ttl });
};

TTLCache.prototype.delete = function (key) { this._store.delete(key); };

TTLCache.prototype.clear = function () { this._store.clear(); };

TTLCache.prototype.size = function () { return this._store.size; };

/**
 * Stable key for an id list. [3,1,2] → "1,2,3". Sorts as numbers, not
 * strings, so [10,9] doesn't collide with [9,10].
 *
 * @param {Array<number|string>} ids
 * @returns {string}
 */
function keyForIds(ids) {
  if (!Array.isArray(ids) || !ids.length) return '';
  var copy = ids.map(function (n) { return parseInt(n, 10); }).filter(function (n) { return !isNaN(n); });
  copy.sort(function (a, b) { return a - b; });
  return copy.join(',');
}

module.exports = TTLCache;
module.exports.TTLCache = TTLCache;
module.exports.keyForIds = keyForIds;
