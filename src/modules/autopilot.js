'use strict';

var MODULE = 'autopilot';

/**
 * AutopilotEngine — decides whether a cluster should be auto-published.
 *
 * All thresholds and filters are read from config at call time (hot-reload).
 * Wire into pipeline.js _publishLoop() to gate every publish decision.
 */
class AutopilotEngine {
  constructor(config, db, logger) {
    this.config = config;
    this.db = db;
    this.logger = logger;
  }

  // ─── Config helpers ──────────────────────────────────────────────────────

  _get(key) {
    return this.config.get ? this.config.get(key) : this.config[key];
  }

  _bool(key, fallback) {
    var v = this._get(key);
    if (v === undefined || v === null || v === '') return fallback;
    return v === true || v === 1 || String(v).toLowerCase() === 'true' || v === '1';
  }

  _int(key, fallback) {
    var v = parseInt(this._get(key), 10);
    return isNaN(v) ? fallback : v;
  }

  _float(key, fallback) {
    var v = parseFloat(this._get(key));
    return isNaN(v) ? fallback : v;
  }

  _csv(key) {
    var v = this._get(key) || '';
    return String(v).split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
  }

  // ─── Operating state ─────────────────────────────────────────────────────

  /**
   * Returns true when autopilot is enabled AND we are within the configured
   * publishing window (hour + weekday check).
   */
  isActive() {
    if (!this._bool('AUTOPILOT_ENABLED', false)) return false;

    var now = new Date();
    var hour = now.getHours();
    var dayOfWeek = now.getDay(); // 0 = Sunday, 6 = Saturday

    var startHour = this._int('AUTOPILOT_START_HOUR', 6);
    var endHour   = this._int('AUTOPILOT_END_HOUR', 23);
    if (hour < startHour || hour > endHour) return false;

    var weekendsAllowed = this._bool('AUTOPILOT_WEEKENDS', true);
    if (!weekendsAllowed && (dayOfWeek === 0 || dayOfWeek === 6)) return false;

    return true;
  }

  // ─── Daily quota ─────────────────────────────────────────────────────────

  getPublishedToday() {
    try {
      var row = this.db.prepare(
        "SELECT COUNT(*) AS cnt FROM published WHERE created_at >= date('now') AND created_at < date('now', '+1 day')"
      ).get();
      return (row && row.cnt) ? row.cnt : 0;
    } catch (e) {
      return 0;
    }
  }

  getRemainingQuota() {
    var target = this._int('AUTOPILOT_DAILY_TARGET', 50);
    return Math.max(0, target - this.getPublishedToday());
  }

  // ─── Core decision ───────────────────────────────────────────────────────

  /**
   * Check whether a cluster+draft passes ALL autopilot filters.
   * @param {object} cluster  — { id, article_count, avg_similarity, domains, ... }
   * @param {object} draft    — { id, title, language, word_count, tier, domain, ... }
   * @returns {{ approved: boolean, reason: string }}
   */
  shouldPublish(cluster, draft) {
    // 1. Daily quota
    var dailyTarget = this._int('AUTOPILOT_DAILY_TARGET', 50);
    var publishedToday = this.getPublishedToday();
    if (publishedToday >= dailyTarget) {
      return { approved: false, reason: 'daily limit reached (' + publishedToday + '/' + dailyTarget + ')' };
    }

    // 2. Publishing window
    if (!this.isActive()) {
      var hour = new Date().getHours();
      return { approved: false, reason: 'outside publishing window (hour=' + hour + ')' };
    }

    // 3. Minimum source count
    var minSources = this._int('MIN_SOURCES_THRESHOLD', 2);
    var sourceCount = cluster.article_count || (cluster.articles ? cluster.articles.length : 1);
    if (sourceCount < minSources) {
      return { approved: false, reason: 'too few sources (' + sourceCount + ' < ' + minSources + ')' };
    }

    // 4. Similarity threshold
    var minSimilarity = this._float('AUTOPILOT_MIN_SIMILARITY', 0.70);
    var sim = parseFloat(cluster.avg_similarity) || 0;
    if (sim < minSimilarity) {
      return { approved: false, reason: 'low similarity (' + sim.toFixed(2) + ' < ' + minSimilarity + ')' };
    }

    // 5. Minimum word count
    var minWords = this._int('AUTOPILOT_MIN_WORDS', 300);
    var wordCount = parseInt(draft.word_count, 10) || 0;
    if (wordCount < minWords) {
      return { approved: false, reason: 'word count too low (' + wordCount + ' < ' + minWords + ')' };
    }

    // 6. Source authority tier
    var minTier = this._int('AUTOPILOT_MIN_TIER', 0);
    if (minTier > 0) {
      var draftTier = parseInt(draft.tier, 10) || 3;
      if (draftTier > minTier) {
        return { approved: false, reason: 'source tier too low (T' + draftTier + ', required T' + minTier + ' or better)' };
      }
    }

    // 7. Language filter
    var publishLang = (this._get('PUBLISH_LANGUAGE') || 'en').toLowerCase().trim();
    if (publishLang !== 'both') {
      var draftLang = (draft.language || 'en').toLowerCase().trim();
      var wantLang = publishLang === 'hi' ? 'hi' : 'en';
      if (draftLang !== wantLang) {
        return { approved: false, reason: 'language mismatch (article=' + draftLang + ', filter=' + wantLang + ')' };
      }
    }

    // 8. Blocked title keywords
    var blockedKw = this._csv('AUTOPILOT_BLOCKED_KEYWORDS');
    if (blockedKw.length > 0) {
      var titleLower = (draft.title || '').toLowerCase();
      for (var ki = 0; ki < blockedKw.length; ki++) {
        if (titleLower.indexOf(blockedKw[ki]) !== -1) {
          return { approved: false, reason: 'blocked keyword "' + blockedKw[ki] + '"' };
        }
      }
    }

    // 9. Blocked domains
    var blockedDomains = this._csv('AUTOPILOT_BLOCKED_DOMAINS');
    if (blockedDomains.length > 0) {
      var draftDomain = (draft.domain || '').toLowerCase();
      if (blockedDomains.indexOf(draftDomain) !== -1) {
        return { approved: false, reason: 'blocked domain "' + draftDomain + '"' };
      }
    }

    // 10. Allowed domains (whitelist — empty = allow all)
    var allowedDomains = this._csv('AUTOPILOT_ALLOWED_DOMAINS');
    if (allowedDomains.length > 0) {
      var srcDomain = (draft.domain || '').toLowerCase();
      if (allowedDomains.indexOf(srcDomain) === -1) {
        return { approved: false, reason: 'domain not in allow-list "' + srcDomain + '"' };
      }
    }

    // 11. Blocked categories
    var blockedCats = this._csv('AUTOPILOT_BLOCKED_CATEGORIES');
    if (blockedCats.length > 0) {
      var draftCat = (draft.page_category || draft.category || '').toLowerCase();
      for (var ci = 0; ci < blockedCats.length; ci++) {
        if (draftCat.indexOf(blockedCats[ci]) !== -1) {
          return { approved: false, reason: 'blocked category "' + blockedCats[ci] + '"' };
        }
      }
    }

    return { approved: true, reason: 'all checks passed' };
  }

  /**
   * Like shouldPublish() but runs ALL checks without short-circuiting.
   * Returns a full per-check breakdown for the Simulate UI.
   * @returns {{ approved: boolean, reason: string, checks: object }}
   */
  simulateChecks(cluster, draft) {
    var checks = {};
    var failedReason = null;

    // 1. Daily quota
    var dailyTarget = this._int('AUTOPILOT_DAILY_TARGET', 50);
    var publishedToday = this.getPublishedToday();
    var quotaPass = publishedToday < dailyTarget;
    checks['Daily quota'] = { pass: quotaPass, value: publishedToday + '/' + dailyTarget, threshold: dailyTarget };
    if (!quotaPass && !failedReason) failedReason = 'daily limit reached (' + publishedToday + '/' + dailyTarget + ')';

    // 2. Publishing window
    var windowPass = this.isActive();
    var hour = new Date().getHours();
    var startHour = this._int('AUTOPILOT_START_HOUR', 6);
    var endHour = this._int('AUTOPILOT_END_HOUR', 23);
    checks['Publishing window'] = { pass: windowPass, value: 'hour=' + hour, threshold: startHour + '–' + endHour };
    if (!windowPass && !failedReason) failedReason = 'outside publishing window (hour=' + hour + ')';

    // 3. Source count
    var minSources = this._int('MIN_SOURCES_THRESHOLD', 2);
    var sourceCount = cluster.article_count || 1;
    var sourcesPass = sourceCount >= minSources;
    checks['Min sources'] = { pass: sourcesPass, value: sourceCount, threshold: minSources };
    if (!sourcesPass && !failedReason) failedReason = 'too few sources (' + sourceCount + ' < ' + minSources + ')';

    // 4. Similarity
    var minSim = this._float('AUTOPILOT_MIN_SIMILARITY', 0.70);
    var sim = parseFloat(cluster.avg_similarity || cluster.similarity_score) || 0;
    var simPass = sim >= minSim;
    checks['Similarity'] = { pass: simPass, value: sim.toFixed(3), threshold: minSim };
    if (!simPass && !failedReason) failedReason = 'low similarity (' + sim.toFixed(2) + ' < ' + minSim + ')';

    // 5. Word count
    var minWords = this._int('AUTOPILOT_MIN_WORDS', 300);
    var wordCount = parseInt(draft.rewritten_word_count || draft.word_count, 10) || 0;
    var wordsPass = wordCount >= minWords;
    checks['Word count'] = { pass: wordsPass, value: wordCount, threshold: minWords };
    if (!wordsPass && !failedReason) failedReason = 'word count too low (' + wordCount + ' < ' + minWords + ')';

    // 6. Language
    var publishLang = (this._get('PUBLISH_LANGUAGE') || 'en').toLowerCase().trim();
    var draftLang = (draft.language || 'en').toLowerCase().trim();
    var langPass = publishLang === 'both' || draftLang === (publishLang === 'hi' ? 'hi' : 'en');
    checks['Language'] = { pass: langPass, value: draftLang, threshold: publishLang };
    if (!langPass && !failedReason) failedReason = 'language mismatch (' + draftLang + ' vs ' + publishLang + ')';

    // 7. Blocked keywords
    var blockedKw = this._csv('AUTOPILOT_BLOCKED_KEYWORDS');
    var titleLower = (draft.rewritten_title || draft.source_title || '').toLowerCase();
    var matchedKw = blockedKw.filter(function (k) { return k && titleLower.indexOf(k) !== -1; });
    var kwPass = matchedKw.length === 0;
    checks['Blocked keywords'] = { pass: kwPass, value: matchedKw.length ? 'matched: ' + matchedKw[0] : 'none matched', threshold: blockedKw.length + ' keywords' };
    if (!kwPass && !failedReason) failedReason = 'blocked keyword "' + matchedKw[0] + '"';

    // 8. Blocked / allowed domains
    var blockedDomains = this._csv('AUTOPILOT_BLOCKED_DOMAINS');
    var allowedDomains = this._csv('AUTOPILOT_ALLOWED_DOMAINS');
    var srcDomain = (draft.source_domain || draft.domain || '').toLowerCase();
    var domainBlocked = blockedDomains.length > 0 && blockedDomains.indexOf(srcDomain) !== -1;
    var domainAllowed = allowedDomains.length === 0 || allowedDomains.indexOf(srcDomain) !== -1;
    var domainPass = !domainBlocked && domainAllowed;
    checks['Domain filter'] = { pass: domainPass, value: srcDomain || '(none)', threshold: blockedDomains.length ? 'blocked:' + blockedDomains.length : 'all allowed' };
    if (!domainPass && !failedReason) failedReason = domainBlocked ? 'blocked domain "' + srcDomain + '"' : 'domain not in allow-list "' + srcDomain + '"';

    var allPass = Object.keys(checks).every(function (k) { return checks[k].pass !== false; });
    return { approved: allPass, reason: allPass ? 'all checks passed' : failedReason, checks: checks };
  }

  // ─── Decision log ─────────────────────────────────────────────────────────

  logDecision(clusterId, draftTitle, approved, reason) {
    try {
      this.db.prepare(
        "INSERT INTO autopilot_decisions (cluster_id, draft_title, approved, reason, created_at) " +
        "VALUES (?, ?, ?, ?, datetime('now'))"
      ).run(clusterId || null, draftTitle || null, approved ? 1 : 0, reason || '');
    } catch (e) {
      if (this.logger) this.logger.warn(MODULE, 'Failed to log decision: ' + e.message);
    }
  }

  getRecentDecisions(limit) {
    var n = parseInt(limit, 10) || 100;
    try {
      return this.db.prepare(
        "SELECT id, cluster_id, draft_title, approved, reason, created_at FROM autopilot_decisions " +
        "ORDER BY created_at DESC LIMIT ?"
      ).all(n);
    } catch (e) {
      return [];
    }
  }

  // ─── Status for dashboard ─────────────────────────────────────────────────

  getStatus() {
    var enabled   = this._bool('AUTOPILOT_ENABLED', false);
    var active    = this.isActive();
    var today     = this.getPublishedToday();
    var target    = this._int('AUTOPILOT_DAILY_TARGET', 50);
    var remaining = Math.max(0, target - today);

    // Next publish ETA: estimate based on cooldown
    var cooldown = this._int('PUBLISH_COOLDOWN_MINUTES', 10);
    var nextEta = null;
    try {
      var lastRow = this.db.prepare(
        "SELECT created_at FROM published ORDER BY created_at DESC LIMIT 1"
      ).get();
      if (lastRow && lastRow.created_at) {
        var lastMs  = new Date(lastRow.created_at + 'Z').getTime();
        var nextMs  = lastMs + cooldown * 60 * 1000;
        var nowMs   = Date.now();
        nextEta     = nextMs > nowMs ? Math.ceil((nextMs - nowMs) / 60000) + ' min' : 'now';
      }
    } catch (e) { /* ignore */ }

    return {
      enabled:       enabled,
      active:        active,
      publishedToday: today,
      dailyTarget:   target,
      remainingQuota: remaining,
      nextPublishETA: nextEta,
      operatingHours: {
        start: this._int('AUTOPILOT_START_HOUR', 6),
        end:   this._int('AUTOPILOT_END_HOUR', 23),
        weekends: this._bool('AUTOPILOT_WEEKENDS', true),
      },
      filters: {
        minSimilarity:    this._float('AUTOPILOT_MIN_SIMILARITY', 0.70),
        minSources:       this._int('MIN_SOURCES_THRESHOLD', 2),
        minWords:         this._int('AUTOPILOT_MIN_WORDS', 300),
        minTier:          this._int('AUTOPILOT_MIN_TIER', 0),
        publishLanguage:  this._get('PUBLISH_LANGUAGE') || 'en',
        blockedKeywords:  this._get('AUTOPILOT_BLOCKED_KEYWORDS') || '',
        blockedDomains:   this._get('AUTOPILOT_BLOCKED_DOMAINS') || '',
        allowedDomains:   this._get('AUTOPILOT_ALLOWED_DOMAINS') || '',
      },
    };
  }
}

module.exports = AutopilotEngine;
