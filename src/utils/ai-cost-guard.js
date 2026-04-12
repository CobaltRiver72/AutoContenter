'use strict';

/**
 * In-process concurrency + cost guard for AI-spending endpoints.
 *
 * Two layers:
 *   1. Per-endpoint boolean lock — at most one body of work with a given
 *      name ("batch-rewrite", "cluster-rewrite", "publish-all",
 *      "batch-fetch-images") can be active at a time. Double-click or
 *      a scripted retry loop gets "already running" instead of a
 *      parallel AI spend.
 *   2. Sliding 60-minute counter across ALL endpoints combined —
 *      acquire() bumps the counter by `cost` (default 1), refuses if
 *      the next bump would exceed `hourlyLimit`. Each entry ages out
 *      after 60 minutes.
 *
 * The counter is intentionally cross-endpoint: a hijacked session
 * should not get 60 batch rewrites AND 60 cluster rewrites per hour.
 *
 * Construct once at boot, reuse. `hourlyLimit` is read lazily on
 * every call so Settings UI changes take effect without a restart.
 */

class AiCostGuard {
  constructor(opts) {
    opts = opts || {};
    this._getLimit = opts.getLimit || function () { return 60; };
    this._locks = Object.create(null);
    this._ledger = []; // array of { at: ms, cost: n, name: string }
  }

  _prune() {
    var cutoff = Date.now() - 60 * 60 * 1000;
    while (this._ledger.length && this._ledger[0].at < cutoff) {
      this._ledger.shift();
    }
  }

  _currentSpend() {
    this._prune();
    var total = 0;
    for (var i = 0; i < this._ledger.length; i++) total += this._ledger[i].cost;
    return total;
  }

  /**
   * Try to acquire the lock + budget slot.
   * Returns { ok: true } on success, or
   *         { ok: false, reason: 'locked' | 'budget', detail: string } on failure.
   */
  acquire(name, cost) {
    cost = (typeof cost === 'number' && cost >= 0) ? cost : 1;

    if (this._locks[name]) {
      return { ok: false, reason: 'locked',
               detail: 'Endpoint "' + name + '" is already running. Wait for it to finish.' };
    }

    if (cost > 0) {
      var limit = this._getLimit();
      var spent = this._currentSpend();
      if (spent + cost > limit) {
        return { ok: false, reason: 'budget',
                 detail: 'Hourly AI budget exceeded (' + spent + '/' + limit +
                         '). Wait for the oldest call to age out or raise MAX_AI_REWRITES_PER_HOUR in Settings.' };
      }
    }

    this._locks[name] = true;
    if (cost > 0) {
      this._ledger.push({ at: Date.now(), cost: cost, name: name });
    }
    return { ok: true };
  }

  release(name) {
    delete this._locks[name];
  }

  status() {
    this._prune();
    return {
      locks: Object.keys(this._locks),
      spentLastHour: this._currentSpend(),
      limit: this._getLimit(),
      entries: this._ledger.length,
    };
  }
}

module.exports = { AiCostGuard: AiCostGuard };
