'use strict';

var { extractDraftContent } = require('../utils/draft-helpers');
var _cfg = require('../utils/config');
var { resolveTaxonomy } = require('../utils/publish-rule-engine');
var siteConfig = require('../utils/site-config');

var MODULE = 'pipeline';

// Hot-reload config helpers — read fresh from SQLite on every call
function _leaseMins()        { return parseInt(_cfg.get('LEASE_MINUTES'), 10) || 8; }
function _rewriteConcurrency(){ return parseInt(_cfg.get('REWRITE_CONCURRENCY'), 10) || 3; }
function _rewriteMaxRetries() { return parseInt(_cfg.get('REWRITE_MAX_RETRIES'), 10) || 3; }
function _extractionPollMs()  { return parseInt(_cfg.get('EXTRACTION_POLL_MS'), 10) || 500; }
function _publishPollMs()     { return parseInt(_cfg.get('PUBLISH_POLL_MS'), 10) || 30000; }
function _maxPublishPerHour() { return parseInt(_cfg.get('MAX_PUBLISH_PER_HOUR'), 10) || 4; }
function _publishCooldownMs() { return (parseInt(_cfg.get('PUBLISH_COOLDOWN_MINUTES'), 10) || 10) * 60000; }

// Unified publish rate: PUBLISH_RATE_COUNT articles per PUBLISH_RATE_UNIT.
// If either is unset, falls back to legacy MAX_PUBLISH_PER_HOUR +
// PUBLISH_COOLDOWN_MINUTES so existing installs keep working unchanged.
function _publishRateUnit() {
  var u = String(_cfg.get('PUBLISH_RATE_UNIT') || '').trim().toLowerCase();
  if (u === 'second' || u === 'minute' || u === 'hour' || u === 'day') return u;
  return '';
}
function _publishRateCount() {
  var raw = _cfg.get('PUBLISH_RATE_COUNT');
  if (raw === undefined || raw === null || raw === '') return 0;
  var n = parseInt(raw, 10);
  return (isNaN(n) || n < 0) ? 0 : n;
}
function _publishWindowMs(unit) {
  if (unit === 'second') return 1000;
  if (unit === 'minute') return 60000;
  if (unit === 'day')    return 86400000;
  return 3600000; // hour default
}

function _autoRewriteEnabled() {
  var v = _cfg.get('AUTO_REWRITE_ENABLED');
  return v === true || v === 1 || String(v).toLowerCase() === 'true' || v === '1';
}
function _autoRewritePollMs()     { return parseInt(_cfg.get('REWRITE_POLL_MS'), 10) || 5000; }
function _autoRewriteDailyLimit() { return parseInt(_cfg.get('AUTO_REWRITE_DAILY_LIMIT'), 10) || 100; }
function _autoRewriteHourlyLimit(){ return parseInt(_cfg.get('AUTO_REWRITE_HOURLY_LIMIT'), 10) || 20; }

// Unified min-sources, min-similarity, and blocked-keyword gates — shared with
// the autopilot publish decision in src/modules/autopilot.js so a single
// admin-facing value gates BOTH the rewrite stage and the publish stage. This
// replaced three duplicate AUTO_REWRITE_* keys that were drifting apart from
// their autopilot counterparts in the admin UI.
function _minSources()            { return parseInt(_cfg.get('MIN_SOURCES_THRESHOLD'), 10) || 2; }
function _minSimilarity()         { return parseFloat(_cfg.get('AUTOPILOT_MIN_SIMILARITY')) || 0.30; }
function _blockedKeywords()       {
  var v = _cfg.get('AUTOPILOT_BLOCKED_KEYWORDS') || '';
  return String(v).split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
}

/**
 * Pipeline V2: Decoupled multi-stage workers.
 *
 * 3 independent loops:
 *   - Extraction: 15 concurrent, polls every 2s
 *   - Rewrite: 3 concurrent, polls every 5s
 *   - Publish: 1 at a time, rate-limited, polls every 30s
 *
 * All run in the same Node.js process. SQLite drafts table is the queue.
 */
class Pipeline {
  constructor(config, db, rewriter, publisher, logger, extractor, infranodus, autopilot, classifier, publisherPool) {
    this.config = config;
    this.db = db;
    this.rewriter = rewriter;
    this.publisher = publisher;
    this.logger = logger;
    this.extractor = extractor;
    this.infranodus = infranodus || null;
    this.autopilot = autopilot || null;
    this.classifier = classifier || null;
    this.publisherPool = publisherPool || null;

    // Worker config is read fresh from config on each cycle via helper functions
    // above (_leaseMins, _rewriteConcurrency, etc.) for hot-reload support.

    // Track active workers
    this._extractionRunning = false;
    this._rewriteRunning = false;
    this._publishRunning = false;
    this._stopped = false;

    // Publish rate limiting — per-site Map for multi-site fan-out.
    // Each key is a siteId, each value is an array of timestamps.
    this.publishHistory = new Map();

    // Interval handles
    this._extractionTimer = null;
    this._rewriteTimer = null;
    this._publishTimer = null;

    // Stats
    this.stats = {
      extractionsStarted: 0,
      extractionsCompleted: 0,
      extractionsFailed: 0,
      rewritesStarted: 0,
      rewritesCompleted: 0,
      rewritesFailed: 0,
      publishesCompleted: 0,
      publishesFailed: 0,
    };

    // Track AbortControllers for in-flight rewrite/publish jobs so
    // shutdown() can cancel them immediately instead of waiting for
    // the provider timeout.
    this._activeControllers = new Set();
  }

  // ─── EXTRACTION WORKER LOOP ──────────────────────────────────────────

  async _extractionLoop() {
    // Simple sequential queue: pick one, extract, repeat
    // No backpressure, no concurrency, no Promise.all
    if (this._extractionRunning) return;
    this._extractionRunning = true;

    try {
      // Find ONE draft that needs extraction
      var draft = this.db.prepare(
        "SELECT * FROM drafts WHERE status = 'fetching' " +
        "  AND mode IN ('auto', 'manual_import') " +
        "  AND (locked_by IS NULL OR lease_expires_at < datetime('now')) " +
        "  AND (next_run_at IS NULL OR next_run_at <= datetime('now')) " +
        "ORDER BY " +
        "  CASE WHEN mode = 'manual_import' THEN 0 ELSE 1 END, " +
        "  cluster_role = 'primary' DESC, " +
        "  created_at ASC " +
        "LIMIT 1"
      ).get();

      if (!draft) return;

      // Lock this one draft (lease window must match _leaseMins())
      var lockResult = this.db.prepare(
        "UPDATE drafts SET locked_by = 'extractor', locked_at = datetime('now'), " +
        "lease_expires_at = datetime('now', '+' || ? || ' minutes') " +
        "WHERE id = ? AND (locked_by IS NULL OR lease_expires_at < datetime('now'))"
      ).run(_leaseMins(), draft.id);

      if (lockResult.changes === 0) return;

      this.stats.extractionsStarted++;
      this.logger.info(MODULE, 'Extracting #' + draft.id + ' (' + draft.source_domain + ')...');

      var draftDeps = { db: this.db, logger: this.logger, extractor: this.extractor, rewriter: this.rewriter };

      try {
        await extractDraftContent(draft.id, draftDeps);

        // Release lock
        this.db.prepare(
          "UPDATE drafts SET locked_by = NULL, locked_at = NULL, lease_expires_at = NULL, " +
          "updated_at = datetime('now') WHERE id = ?"
        ).run(draft.id);

        this.stats.extractionsCompleted++;

        var updated = this.db.prepare(
          'SELECT extraction_status, extracted_content, mode FROM drafts WHERE id = ?'
        ).get(draft.id);

        if (updated) {
          this.logger.info(MODULE, 'Extracted #' + draft.id + ' -> ' +
            updated.extraction_status + ' (' + (updated.extracted_content || '').length + ' chars)');

          // ─── B5: Auto InfraNodus analysis DISABLED ───────────────────────────
          // InfraNodus only runs when AI actively rewrites (pre-rewrite block
          // below) or when the user clicks "Re-run" / "Fetch" manually.
          // Disabled here to conserve API tokens on extraction-only events.
          // ─── END B5 ──────────────────────────────────────────────────────────

          // ─── MANUAL IMPORT: Create synthetic cluster so rewrite + publish pipeline handles it ───
          if (updated.mode === 'manual_import') {
            var extractionOk = updated.extraction_status === 'success'
              || updated.extraction_status === 'cached'
              || updated.extraction_status === 'fallback';

            if (extractionOk && updated.extracted_content && updated.extracted_content.length >= 50) {
              // Create a synthetic single-article cluster so the existing rewrite
              // and publish workers can handle this import exactly like an auto article.
              var clusterTitle = updated.extracted_title || draft.source_title || ('Manual Import: ' + draft.source_domain);
              var clusterInsert = this.db.prepare(
                "INSERT INTO clusters (topic, article_count, avg_similarity, primary_article_id, " +
                "trends_boosted, priority, status, detected_at) " +
                "VALUES (?, 1, 1.0, ?, 0, 'normal', 'queued', datetime('now'))"
              );
              var updateDraft = this.db.prepare(
                "UPDATE drafts SET cluster_id = ?, cluster_role = 'primary', updated_at = datetime('now') WHERE id = ?"
              );
              var newClusterId;
              this.db.transaction(function () {
                var clusterResult = clusterInsert.run(clusterTitle, draft.id);
                newClusterId = typeof clusterResult.lastInsertRowid === 'bigint'
                  ? Number(clusterResult.lastInsertRowid)
                  : clusterResult.lastInsertRowid;
                updateDraft.run(newClusterId, draft.id);
              })();

              this.logger.info(MODULE,
                'Manual import #' + draft.id + ' -> synthetic cluster #' + newClusterId + ' created. Queued for AI rewrite.');
            }
            // If extraction failed, extractDraftContent() already set status = 'failed'.
            // No extra handling needed here.
          }
          // ─── END MANUAL IMPORT HANDLING ─────────────────────────────────
        }
      } catch (err) {
        this.logger.warn(MODULE, 'Extraction #' + draft.id + ' error: ' + err.message);
        this.stats.extractionsFailed++;

        try {
          this.db.prepare(
            "UPDATE drafts SET extraction_status = 'failed', " +
            "error_message = ?, " +
            "locked_by = NULL, locked_at = NULL, lease_expires_at = NULL, " +
            "updated_at = datetime('now') WHERE id = ?"
          ).run((err.message || 'Unknown error').substring(0, 500), draft.id);
        } catch (dbErr) {
          this.logger.error(MODULE, 'DB update failed for #' + draft.id + ': ' + dbErr.message);
        }

        this._failOrRetry(draft, 'fetching', err.message);
      }

    } catch (loopErr) {
      this.logger.error(MODULE, 'Extraction queue error: ' + loopErr.message);
    } finally {
      this._extractionRunning = false;
    }
  }

  // ─── REWRITE WORKER LOOP ────────────────────────────────────────────

  async _rewriteLoop(siteFilter) {
    if (this._rewriteRunning) return;
    this._rewriteRunning = true;

    try {
      // Guard: auto-rewrite must be enabled
      if (!_autoRewriteEnabled()) return;

      // Daily limit check
      var dailyLimit = _autoRewriteDailyLimit();
      var rewrittenToday = this._getRewriteCountToday();
      if (rewrittenToday >= dailyLimit) {
        this.logger.info(MODULE, 'Auto-rewrite: daily limit reached (' + rewrittenToday + '/' + dailyLimit + ')');
        return;
      }

      // Hourly limit check
      var hourlyLimit = _autoRewriteHourlyLimit();
      var rewrittenThisHour = this._getRewriteCountThisHour();
      if (rewrittenThisHour >= hourlyLimit) {
        this.logger.info(MODULE, 'Auto-rewrite: hourly limit reached (' + rewrittenThisHour + '/' + hourlyLimit + ')');
        return;
      }

      var minSources = _minSources();
      var minSim = _minSimilarity();
      var blockedKw = _blockedKeywords();

      // Slots available this tick (bounded by rate limits and concurrency)
      var slotsAvailable = Math.min(
        _rewriteConcurrency(),
        dailyLimit - rewrittenToday,
        hourlyLimit - rewrittenThisHour
      );

      // Blocked-keyword filter is applied IN SQL (not after) so the ORDER BY
      // can step past blocked clusters. Applying it in JS post-SELECT meant
      // that when the top-N by priority were all blocked (e.g. a surge of
      // Hindi rashifal / horoscope clusters), every tick's LIMIT returned
      // the same N rows, JS dropped them, the loop bailed, and nothing ever
      // advanced — even with thousands of eligible non-blocked clusters
      // sitting further down the queue.
      var kwWhere = '';
      var kwParams = [];
      for (var kwi = 0; kwi < blockedKw.length; kwi++) {
        kwWhere += ' AND LOWER(c.topic) NOT LIKE ?';
        kwParams.push('%' + blockedKw[kwi] + '%');
      }

      // Optional per-site filter. Run-Now passes a siteFilter to restrict
      // rewrites to drafts owned by the active site; the scheduler tick omits it.
      var siteWhere = '';
      var siteParams = [];
      if (siteFilter && typeof siteFilter === 'number' && siteFilter > 0) {
        siteWhere = ' AND d.site_id = ?';
        siteParams = [siteFilter];
      }

      // Per-site opt-out: drop drafts whose site has explicitly set
      // AUTO_REWRITE_ENABLED='false' in site_config. Drafts for sites
      // with no per-site override fall back to the global flag (already
      // checked at line 250 above). Sites that explicitly set 'true'
      // match nothing here and are included. This lets an admin keep the
      // global rewriter on while pausing a single site without touching
      // the master switch.
      var SITE_OPT_OUT = " AND NOT EXISTS (" +
        "  SELECT 1 FROM site_config sc WHERE sc.site_id = d.site_id " +
        "    AND sc.key = 'AUTO_REWRITE_ENABLED' " +
        "    AND LOWER(sc.value) IN ('false', '0'))";

      // Find clusters where ALL drafts are extracted (status = 'draft')
      // and the primary draft is not locked, with quality pre-filters
      var readyClustersSql =
        "SELECT d.cluster_id, c.topic, c.trends_boosted, c.article_count, c.feed_id, COUNT(*) as draft_count " +
        "FROM drafts d " +
        "JOIN clusters c ON d.cluster_id = c.id " +
        "WHERE d.mode IN ('auto', 'manual_import') AND d.cluster_id IS NOT NULL AND d.status = 'draft' " +
        "  AND c.status = 'queued' " +
        "  AND c.article_count >= ? " +
        "  AND (c.avg_similarity IS NULL OR c.avg_similarity >= ?) " +
        "  AND (d.locked_by IS NULL OR d.lease_expires_at < datetime('now')) " +
        "  AND NOT EXISTS (" +
        "    SELECT 1 FROM drafts d2 WHERE d2.cluster_id = d.cluster_id " +
        "    AND d2.status = 'fetching' AND d2.mode IN ('auto', 'manual_import')" +
        "  )" +
        kwWhere + siteWhere + SITE_OPT_OUT + " " +
        "GROUP BY d.cluster_id " +
        "HAVING COUNT(CASE WHEN d.cluster_role = 'primary' THEN 1 END) > 0 " +
        "ORDER BY c.trends_boosted DESC, c.article_count DESC, c.detected_at ASC " +
        "LIMIT ?";
      var readyClustersStmt = this.db.prepare(readyClustersSql);
      var readyClustersParams = [minSources, minSim].concat(kwParams).concat(siteParams).concat([slotsAvailable]);
      var readyClusters = readyClustersStmt.all.apply(readyClustersStmt, readyClustersParams);

      if (readyClusters.length === 0) return;

      // ─── Language gate ───────────────────────────────────────────────────────
      // Filter clusters whose primary draft language doesn't match PUBLISH_LANGUAGE.
      // Uses source_language stored on the draft; falls back to Devanagari regex
      // detection on source_title for rows where source_language is still NULL.
      var publishLangCfg = (_cfg.get('PUBLISH_LANGUAGE') || 'en').toLowerCase().trim();
      if (publishLangCfg !== 'both' && readyClusters.length > 0) {
        var wantLang = publishLangCfg === 'hi' ? 'hi' : 'en';
        var langPlaceholders = readyClusters.map(function () { return '?'; }).join(',');
        var langClusterIds = readyClusters.map(function (c) { return c.cluster_id; });
        var primaryLangStmt = this.db.prepare(
          "SELECT cluster_id, source_language, source_title FROM drafts " +
          "WHERE cluster_id IN (" + langPlaceholders + ") AND cluster_role = 'primary'"
        );
        var primaryLangRows = primaryLangStmt.all.apply(primaryLangStmt, langClusterIds);
        var langMap = {};
        for (var lri = 0; lri < primaryLangRows.length; lri++) {
          var lr = primaryLangRows[lri];
          var detLang = lr.source_language;
          if (!detLang) {
            detLang = /[\u0900-\u097F]{3,}/.test(lr.source_title || '') ? 'hi' : 'en';
          }
          langMap[lr.cluster_id] = detLang;
        }
        var filteredClusters = [];
        for (var lfi = 0; lfi < readyClusters.length; lfi++) {
          var lfc = readyClusters[lfi];
          var lfcLang = langMap[lfc.cluster_id] || 'en';
          if (lfcLang === wantLang) {
            filteredClusters.push(lfc);
          } else {
            this.logger.info(MODULE, 'Rewrite skip (lang): cluster #' + lfc.cluster_id +
              ' "' + (lfc.topic || '').substring(0, 40) + '" lang=' + lfcLang + ' filter=' + wantLang);
          }
        }
        readyClusters = filteredClusters;
      }
      // ─── End language gate ────────────────────────────────────────────────────

      if (readyClusters.length === 0) return;

      // ─── Per-feed quality gates (B3) ────────────────────────────────────────
      // Legacy clusters (feed_id NULL) stay on the global gates already
      // applied above. Feed-mode clusters also need to respect the admin's
      // per-feed overrides (quality_config): min_sources, daily_limit, and
      // blocked_keywords. Cluster admin set iPhone feed with min_sources=5
      // shouldn't have 2-source clusters rewritten; legacy clusters on the
      // same tick aren't affected.
      var feedQualityMap = {}; // feedId → parsed quality_config (cache per tick)
      var feedPublishedTodayMap = {}; // feedId → count of today's published
      // Match SQLite datetime('now') format (space separator, not ISO 'T')
      // so the per-feed daily_limit check actually finds today's rows.
      var todayStart = new Date().toISOString().slice(0, 10) + ' 00:00:00';
      var feedIdsToCheck = readyClusters.map(function (c) { return c.feed_id; }).filter(Boolean);
      if (feedIdsToCheck.length) {
        // Fetch all the feed quality configs in one shot so each cluster
        // doesn't re-query.
        var uniqFeedIds = Array.from(new Set(feedIdsToCheck));
        var fqStmt = this.db.prepare(
          'SELECT id, quality_config FROM feeds WHERE id IN (' +
          uniqFeedIds.map(function () { return '?'; }).join(',') + ')'
        );
        var feedRows = fqStmt.all.apply(fqStmt, uniqFeedIds);
        for (var fqi = 0; fqi < feedRows.length; fqi++) {
          var fqr = feedRows[fqi];
          var qc = {};
          try { qc = JSON.parse(fqr.quality_config || '{}'); } catch (_e) { qc = {}; }
          feedQualityMap[fqr.id] = qc;
        }
        // Daily-limit needs today's publish counts. One query per feed (cheap
        // with the idx_published_feed index added in the Phase 1 migration).
        for (var fdi = 0; fdi < uniqFeedIds.length; fdi++) {
          var fdId = uniqFeedIds[fdi];
          try {
            var cnt = this.db.prepare(
              "SELECT COUNT(*) AS n FROM published WHERE feed_id = ? AND published_at >= ?"
            ).get(fdId, todayStart);
            feedPublishedTodayMap[fdId] = (cnt && cnt.n) || 0;
          } catch (_dce) { feedPublishedTodayMap[fdId] = 0; }
        }
      }

      var gatedClusters = [];
      for (var fci = 0; fci < readyClusters.length; fci++) {
        var c = readyClusters[fci];
        var cFeedId = c.feed_id;
        if (!cFeedId) { gatedClusters.push(c); continue; }
        var q = feedQualityMap[cFeedId] || {};

        // min_sources override (feed-specific; global minSources already gated at SQL)
        if (q.min_sources && c.article_count < q.min_sources) {
          this.logger.info(MODULE, 'Rewrite skip (feed min_sources): cluster #' + c.cluster_id + ' has ' + c.article_count + ' < feed=' + cFeedId + ' min=' + q.min_sources);
          continue;
        }
        // daily_limit — cap auto-publishes per feed per UTC day. Hit = stop.
        if (q.daily_limit && (feedPublishedTodayMap[cFeedId] || 0) >= q.daily_limit) {
          this.logger.info(MODULE, 'Rewrite skip (feed daily_limit): cluster #' + c.cluster_id + ' feed=' + cFeedId + ' already at ' + feedPublishedTodayMap[cFeedId] + '/' + q.daily_limit);
          continue;
        }
        // blocked_keywords — case-insensitive substring match on cluster topic.
        if (Array.isArray(q.blocked_keywords) && q.blocked_keywords.length && c.topic) {
          var topicLower = String(c.topic).toLowerCase();
          var blocked = null;
          for (var bki = 0; bki < q.blocked_keywords.length; bki++) {
            var kw = String(q.blocked_keywords[bki] || '').trim().toLowerCase();
            if (kw && topicLower.indexOf(kw) !== -1) { blocked = kw; break; }
          }
          if (blocked) {
            this.logger.info(MODULE, 'Rewrite skip (feed blocked_kw): cluster #' + c.cluster_id + ' feed=' + cFeedId + ' topic matched "' + blocked + '"');
            continue;
          }
        }
        gatedClusters.push(c);
      }
      readyClusters = gatedClusters;
      if (readyClusters.length === 0) return;
      // ─── End per-feed quality gates ─────────────────────────────────────────

      this.logger.info(MODULE, 'Auto-rewrite: ' + readyClusters.length + ' clusters ready (daily:' + rewrittenToday + '/' + dailyLimit + ' hourly:' + rewrittenThisHour + '/' + hourlyLimit + ')');

      var self = this;

      var promises = readyClusters.map(function (cluster) {
        return self._rewriteCluster(cluster).catch(function (err) {
          self.logger.error(MODULE, 'Rewrite cluster #' + cluster.cluster_id + ' failed: ' + err.message);
        });
      });

      await Promise.all(promises);

    } catch (err) {
      this.logger.error(MODULE, 'Rewrite loop error: ' + err.message);
    } finally {
      this._rewriteRunning = false;
    }
  }

  _getRewriteCountToday() {
    try {
      var row = this.db.prepare(
        "SELECT COUNT(*) AS cnt FROM draft_versions WHERE created_at >= date('now')"
      ).get();
      return (row && row.cnt) ? row.cnt : 0;
    } catch (e) {
      return 0;
    }
  }

  _getRewriteCountThisHour() {
    try {
      var row = this.db.prepare(
        "SELECT COUNT(*) AS cnt FROM draft_versions WHERE created_at >= datetime('now', '-1 hour')"
      ).get();
      return (row && row.cnt) ? row.cnt : 0;
    } catch (e) {
      return 0;
    }
  }

  getAutoRewriteStatus() {
    var enabled = _autoRewriteEnabled();
    var dailyLimit = _autoRewriteDailyLimit();
    var hourlyLimit = _autoRewriteHourlyLimit();
    var rewrittenToday = this._getRewriteCountToday();
    var rewrittenThisHour = this._getRewriteCountThisHour();
    var pendingClusters = 0;
    try {
      var row = this.db.prepare(
        "SELECT COUNT(DISTINCT d.cluster_id) AS cnt FROM drafts d " +
        "JOIN clusters c ON d.cluster_id = c.id " +
        "WHERE d.status = 'draft' AND c.status = 'queued' AND d.cluster_role = 'primary'"
      ).get();
      pendingClusters = (row && row.cnt) ? row.cnt : 0;
    } catch (e) { /* ignore */ }
    return {
      enabled: enabled,
      rewrittenToday: rewrittenToday,
      dailyLimit: dailyLimit,
      rewrittenThisHour: rewrittenThisHour,
      hourlyLimit: hourlyLimit,
      pendingClusters: pendingClusters,
      filters: {
        minSources: _minSources(),
        minSimilarity: _minSimilarity(),
        blockedKeywords: _cfg.get('AUTOPILOT_BLOCKED_KEYWORDS') || '',
      },
    };
  }

  async _rewriteCluster(clusterInfo, _opts) {
    var clusterId = clusterInfo.cluster_id;
    var skipLock = !!(_opts && _opts.alreadyLocked);

    // Load all drafts for this cluster
    var clusterDrafts = this.db.prepare(
      "SELECT * FROM drafts WHERE cluster_id = ? ORDER BY cluster_role ASC"
    ).all(clusterId);

    // Find primary
    var primaryDraft = null;
    for (var i = 0; i < clusterDrafts.length; i++) {
      if (clusterDrafts[i].cluster_role === 'primary') {
        primaryDraft = clusterDrafts[i];
        break;
      }
    }
    if (!primaryDraft) {
      primaryDraft = clusterDrafts[0];
      this.db.prepare("UPDATE drafts SET cluster_role = 'primary' WHERE id = ?").run(primaryDraft.id);
    }

    // Check primary has content
    if (!primaryDraft.extracted_content || primaryDraft.extracted_content.length < 50) {
      this.logger.warn(MODULE, 'Cluster #' + clusterId + ' primary has no content — skipping');
      return;
    }

    // Per-site rewrite config — read prompt and language overrides from site_config
    var draftSiteId = primaryDraft.site_id || 1;
    var sitePrompt = null;
    var siteLang = null;
    try {
      sitePrompt = siteConfig.getSiteConfig(draftSiteId, 'SITE_REWRITE_PROMPT') || null;
      siteLang = siteConfig.getSiteConfig(draftSiteId, 'REWRITE_LANGUAGE') || null;
    } catch (_e) { /* site-config not initialised yet — use global defaults */ }

    // Atomic CAS lock of the primary draft. If another worker (auto loop,
    // manual trigger, or batch rewrite) already grabbed this draft between
    // the caller's SELECT and our UPDATE, changes === 0 and we bail out.
    // Manual entry points (rewriteClusterManual / rewriteAllExtractedClusters)
    // acquire the lock themselves and pass { alreadyLocked: true } so we
    // honour their pre-check without fighting ourselves.
    if (!skipLock) {
      var rewriteLockResult = this.db.prepare(
        "UPDATE drafts SET status = 'rewriting', locked_by = 'rewriter', locked_at = datetime('now'), " +
        "lease_expires_at = datetime('now', '+' || ? || ' minutes'), updated_at = datetime('now') " +
        "WHERE id = ? AND (locked_by IS NULL OR lease_expires_at < datetime('now'))"
      ).run(_leaseMins(), primaryDraft.id);

      if (rewriteLockResult.changes === 0) {
        this.logger.debug(MODULE, 'Rewrite lock race lost for draft #' + primaryDraft.id + ' (cluster #' + clusterId + ')');
        return;
      }
    } else {
      // Manual caller already holds the lock; just mark status transition.
      this.db.prepare(
        "UPDATE drafts SET status = 'rewriting', updated_at = datetime('now') WHERE id = ?"
      ).run(primaryDraft.id);
    }

    this.stats.rewritesStarted++;

    // Per-job AbortController — lets shutdown() cancel in-flight AI calls
    // immediately, preventing double-billing on crash-restart.
    var rewriteController = new AbortController();
    this._activeControllers.add(rewriteController);

    // Build cluster object for rewriter (same format as before)
    var clusterForRewrite = {
      id: clusterId,
      topic: clusterInfo.topic,
      trends_boosted: clusterInfo.trends_boosted,
      trends_topic: clusterInfo.topic,
      articles: clusterDrafts.map(function (d) {
        return {
          id: d.source_article_id || d.id,
          url: d.source_url,
          domain: d.source_domain,
          title: d.extracted_title || d.source_title,
          content_markdown: d.extracted_content || d.source_content_markdown || '',
          extracted_content: d.extracted_content || '',
          extracted_title: d.extracted_title || d.source_title || '',
          extracted_byline: d.extracted_byline || '',
          extracted_excerpt: d.extracted_excerpt || '',
          extraction_status: d.extraction_status || 'pending',
          authority_tier: 3,
          featured_image: d.featured_image || null,
        };
      }),
    };

    var primaryArticle = {
      id: primaryDraft.source_article_id || primaryDraft.id,
      url: primaryDraft.source_url,
      domain: primaryDraft.source_domain,
      title: primaryDraft.extracted_title || primaryDraft.source_title,
      content_markdown: primaryDraft.extracted_content || primaryDraft.source_content_markdown || '',
      extracted_content: primaryDraft.extracted_content || '',
      extracted_title: primaryDraft.extracted_title || primaryDraft.source_title || '',
      extracted_byline: primaryDraft.extracted_byline || '',
    };

    try {
      this.logger.info(MODULE, 'Rewriting cluster #' + clusterId + ' (' + clusterDrafts.length + ' sources): "' +
        (clusterInfo.topic || '').substring(0, 60) + '"');

      // InfraNodus entity analysis — enriches the rewrite prompt with
      // graph-derived topics, missing entities, and content gaps. Non-fatal:
      // any failure is logged and the rewrite proceeds without it.
      var infraData = null;
      if (this.infranodus && this.infranodus.enabled) {
        try {
          var combinedText = clusterDrafts
            .map(function (d) { return d.extracted_content || ''; })
            .join('\n\n')
            .slice(0, 12000);
          if (combinedText.length >= 200) {
            infraData = await this.infranodus.enhanceArticle(combinedText, { targetKeyword: primaryDraft.target_keyword || '' }, rewriteController.signal);
            if (infraData) {
              var infraJsonPipe = JSON.stringify(infraData);
              this.db.prepare("UPDATE drafts SET infranodus_data = ?, updated_at = datetime('now') WHERE id = ?")
                .run(infraJsonPipe, primaryDraft.id);
              // Append to analysis history (non-fatal)
              try {
                this.db.prepare("INSERT INTO infranodus_history (draft_id, source, query, data_json) VALUES (?, 'article', ?, ?)")
                  .run(primaryDraft.id, primaryDraft.target_keyword || null, infraJsonPipe);
              } catch (histErr) { /* ignore if table not yet migrated */ }
              this.logger.info(MODULE, 'Pre-rewrite InfraNodus analysis done for cluster #' + primaryDraft.id +
                ' (' + (infraData.mainTopics || []).length + ' topics, ' +
                (infraData.missingEntities || []).length + ' entities)');
            } else {
              this.logger.warn(MODULE, 'Pre-rewrite InfraNodus returned no data for cluster #' + primaryDraft.id +
                ' — rewriting without entity context');
            }
          }
        } catch (infraErr) {
          this.logger.warn(MODULE, 'InfraNodus analysis failed, continuing without it: ' + infraErr.message);
        }
      }

      var rewriteOpts = {
        infraData: infraData,
        signal: rewriteController.signal,
      };
      // Per-site prompt/language overrides (set earlier from site_config)
      if (sitePrompt || siteLang) {
        rewriteOpts.siteOverrides = {};
        if (sitePrompt) rewriteOpts.siteOverrides.SITE_REWRITE_PROMPT = sitePrompt;
        if (siteLang) rewriteOpts.siteOverrides.REWRITE_LANGUAGE = siteLang;
      }
      var rewritten = await this.rewriter.rewrite(primaryArticle, clusterForRewrite, rewriteOpts);
      this._activeControllers.delete(rewriteController);

      // Save rewritten content
      this.db.prepare(
        "UPDATE drafts SET " +
        "  rewritten_html = ?, rewritten_title = ?, rewritten_word_count = ?," +
        "  ai_model_used = ?, target_keyword = ?," +
        "  status = 'ready', error_message = NULL," +
        "  locked_by = NULL, locked_at = NULL, lease_expires_at = NULL," +
        "  updated_at = datetime('now') " +
        "WHERE id = ?"
      ).run(
        rewritten.content || '',
        rewritten.title || '',
        rewritten.wordCount || 0,
        rewritten.aiModel || '',
        rewritten.targetKeyword || '',
        primaryDraft.id
      );

      this.stats.rewritesCompleted++;
      this.logger.info(MODULE, 'Rewrite complete: cluster #' + clusterId + ' -> "' +
        (rewritten.title || '').substring(0, 60) + '" (' + (rewritten.wordCount || 0) + ' words)');

      // ─── Content Classification ──────────────────────────────────────────
      if (this.classifier && _cfg.get('AUTHOR_ASSIGNMENT_ENABLED') !== 'false') {
        try {
          // Layer 1: local keyword scoring
          var localScore = this.classifier.scoreLocally(
            primaryDraft.source_title || '',
            primaryDraft.extracted_text || '',
            primaryDraft.source_domain || '',
            primaryDraft.source_category || ''
          );

          // Layer 2: AI classification embedded in rewrite response
          var aiCls = rewritten.aiCategory ? {
            category: rewritten.aiCategory,
            author:   rewritten.aiAuthorBeat,
            tags:     rewritten.aiTags || [],
            confidence: rewritten.aiConfidence || 0
          } : null;

          // Merge strategy
          var l2Confident = aiCls && aiCls.confidence >= 0.8;
          var finalCls;

          if (localScore.allConfident && !l2Confident) {
            finalCls = { category: localScore.category.key, author: localScore.author.username,
              tags: localScore.tags, source: 'layer1_keyword',
              l1Score: localScore.category.score, l2Conf: 0, reasons: localScore.matchReasons };
          } else if (l2Confident) {
            var mergedT = Array.from(new Set((aiCls.tags).concat(localScore.tags))).slice(0, 10);
            finalCls = { category: aiCls.category, author: aiCls.author,
              tags: mergedT, source: 'layer2_ai',
              l1Score: localScore.category.score, l2Conf: aiCls.confidence,
              reasons: ['ai_classification (conf:' + aiCls.confidence + ')'] };
          } else if (localScore.allConfident) {
            var mergedT2 = aiCls ? Array.from(new Set((aiCls.tags || []).concat(localScore.tags))).slice(0, 10) : localScore.tags;
            finalCls = { category: localScore.category.key, author: localScore.author.username,
              tags: mergedT2, source: 'layer1_primary',
              l1Score: localScore.category.score, l2Conf: aiCls ? aiCls.confidence : 0,
              reasons: localScore.matchReasons };
          } else if (aiCls) {
            finalCls = { category: aiCls.category, author: aiCls.author,
              tags: aiCls.tags, source: 'layer2_ai_fallback',
              l1Score: localScore.category.score, l2Conf: aiCls.confidence,
              reasons: ['ai_fallback (l1_score:' + localScore.category.score + ')'] };
          } else {
            // No confident match — leave author empty so the publish-rule
            // engine / global WP_AUTHOR_ID takes over. Hardcoding a username
            // here would silently miscategorize posts on admin's WP site.
            finalCls = { category: 'general', author: '',
              tags: localScore.tags, source: 'default_fallback',
              l1Score: 0, l2Conf: 0, reasons: ['no_confident_match'] };
          }

          // Resolve WP IDs and update draft only if no manual overrides exist
          var catMap = this.classifier.getCategoryWpIdMap();
          var authMap = this.classifier.getAuthorWpIdMap();
          var wpCatId = catMap[finalCls.category] || null;
          var wpAuthId = authMap[finalCls.author] || null;

          // Resolve tag names → WP tag IDs (creates missing tags, caches them).
          // Bounded by maxCreatePerCall to prevent flooding WP on a single rewrite.
          // Non-blocking: failure here must not break the rewrite → publish flow.
          var wpTagIds = [];
          if (Array.isArray(finalCls.tags) && finalCls.tags.length > 0 && !primaryDraft.wp_tag_ids) {
            try {
              var _wpTaxonomy = require('../modules/wp-taxonomy');
              wpTagIds = await _wpTaxonomy.resolveTagNames(
                this.db,
                require('../utils/config').getConfig(),
                finalCls.tags,
                { logger: this.logger, maxCreatePerCall: 12 }
              );
            } catch (tagErr) {
              this.logger.warn(MODULE, 'Tag resolution failed (non-fatal): ' + tagErr.message);
              wpTagIds = [];
            }
          }

          var colParts = [], colVals = [];
          if (wpCatId && !primaryDraft.wp_category_ids) {
            colParts.push('wp_category_ids = ?', 'wp_primary_cat_id = ?');
            colVals.push(JSON.stringify([wpCatId]), wpCatId);
          }
          if (wpAuthId && !primaryDraft.wp_author_id_override) {
            colParts.push('wp_author_id_override = ?');
            colVals.push(wpAuthId);
          }
          if (wpTagIds.length > 0 && !primaryDraft.wp_tag_ids) {
            colParts.push('wp_tag_ids = ?');
            colVals.push(JSON.stringify(wpTagIds));
          }
          if (colParts.length) {
            colVals.push(primaryDraft.id);
            this.db.prepare('UPDATE drafts SET ' + colParts.join(', ') + ' WHERE id = ?')
              .run(...colVals);
          }

          // Log to classification_log
          this.classifier.logClassification({
            draft_id: primaryDraft.id, cluster_id: clusterId,
            title: rewritten.title || primaryDraft.source_title || '',
            assigned_category: finalCls.category, assigned_author: finalCls.author,
            assigned_tags: finalCls.tags, layer_used: finalCls.source,
            l1_category_score: finalCls.l1Score,
            l1_author_score: localScore.author ? localScore.author.score : 0,
            l2_ai_confidence: finalCls.l2Conf, match_reasons: finalCls.reasons
          });

          this.logger.info(MODULE, 'Classified → cat:' + finalCls.category +
            ' author:' + finalCls.author +
            ' tags:' + finalCls.tags.length + ' (wp:' + wpTagIds.length + ')' +
            ' src:' + finalCls.source);
        } catch (clsErr) {
          this.logger.warn(MODULE, 'Classification failed (non-fatal): ' + clsErr.message);
        }
      }
      // ─── End classification ──────────────────────────────────────────────

    } catch (err) {
      this._activeControllers.delete(rewriteController);
      this.logger.error(MODULE, 'Rewrite failed for cluster #' + clusterId + ': ' + err.message);
      this.stats.rewritesFailed++;

      var retryCount = (primaryDraft.retry_count || 0) + 1;
      if (retryCount >= _rewriteMaxRetries()) {
        this.db.prepare(
          "UPDATE drafts SET status = 'failed', error_message = ?, retry_count = ?, " +
          "locked_by = NULL, lease_expires_at = NULL, updated_at = datetime('now') WHERE id = ?"
        ).run('Rewrite failed: ' + err.message, retryCount, primaryDraft.id);
        this.db.prepare("UPDATE clusters SET status = 'failed' WHERE id = ?").run(clusterId);
      } else {
        this.db.prepare(
          "UPDATE drafts SET status = 'draft', error_message = ?, retry_count = ?, " +
          "next_run_at = datetime('now', '+' || ? || ' minutes'), " +
          "locked_by = NULL, lease_expires_at = NULL, updated_at = datetime('now') WHERE id = ?"
        ).run('Rewrite failed (retry ' + retryCount + '/3): ' + err.message, retryCount,
          retryCount * 2, primaryDraft.id);
      }
    }
  }

  // ─── MANUAL REWRITE METHODS ──────────────────────────────────────────

  /**
   * Manually trigger rewrite for a specific cluster.
   * Called from the API when admin clicks "Rewrite" button.
   * @param {number} clusterId
   * @returns {Promise<object>} result
   */
  async rewriteClusterManual(clusterId) {
    this.logger.info(MODULE, 'Manual rewrite triggered for cluster #' + clusterId);

    // Find the primary draft for this cluster
    var primary = this.db.prepare(
      "SELECT * FROM drafts WHERE cluster_id = ? AND cluster_role = 'primary'"
    ).get(clusterId);

    if (!primary) {
      throw new Error('No primary draft found for cluster #' + clusterId);
    }

    // Check if all sources are extracted
    var unextracted = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM drafts WHERE cluster_id = ? AND extraction_status NOT IN ('success','cached','fallback')"
    ).get(clusterId);

    if (unextracted.cnt > 0) {
      throw new Error('Cluster #' + clusterId + ' has ' + unextracted.cnt + ' un-extracted sources. Extract first.');
    }

    // Load cluster info for _rewriteCluster
    var cluster = this.db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId);

    // Atomic CAS lock acquisition BEFORE calling _rewriteCluster. If the auto
    // loop, another manual trigger, or a batch rewrite already grabbed this
    // primary draft, changes === 0 and we surface a clear error to the API
    // caller rather than silently stepping on the other worker.
    var manualLockResult = this.db.prepare(
      "UPDATE drafts SET status = 'rewriting', locked_by = 'rewriter', locked_at = datetime('now'), " +
      "lease_expires_at = datetime('now', '+' || ? || ' minutes'), updated_at = datetime('now') " +
      "WHERE id = ? AND (locked_by IS NULL OR lease_expires_at < datetime('now'))"
    ).run(_leaseMins(), primary.id);

    if (manualLockResult.changes === 0) {
      this.logger.debug(MODULE, 'Manual rewrite lock race lost for cluster #' + clusterId + ' (draft #' + primary.id + ')');
      throw new Error('Cluster is currently being processed, try again in a moment.');
    }

    // Call the existing _rewriteCluster method with proper clusterInfo shape
    await this._rewriteCluster({
      cluster_id: clusterId,
      topic: cluster ? cluster.topic : '',
      trends_boosted: cluster ? cluster.trends_boosted : 0,
    }, { alreadyLocked: true });

    return { success: true, primaryDraftId: primary.id, clusterId: clusterId };
  }

  /**
   * Manually trigger rewrite for ALL extracted clusters at once.
   * Called from the API when admin clicks "Rewrite All" button.
   * @returns {Promise<object>} result with count
   */
  async rewriteAllExtractedClusters() {
    // Find all clusters where:
    // - Primary draft exists and is NOT yet rewritten
    // - ALL source drafts are extracted
    var readyClusters = this.db.prepare(
      "SELECT DISTINCT d.cluster_id FROM drafts d " +
      "WHERE d.cluster_role = 'primary' " +
      "AND d.status = 'draft' " +
      "AND (d.rewritten_html IS NULL OR d.rewritten_html = '') " +
      "AND d.cluster_id IS NOT NULL " +
      "AND d.cluster_id NOT IN (" +
      "  SELECT cluster_id FROM drafts " +
      "  WHERE cluster_id = d.cluster_id " +
      "  AND extraction_status NOT IN ('success','cached','fallback')" +
      ")"
    ).all();

    this.logger.info(MODULE, 'Batch rewrite: found ' + readyClusters.length + ' clusters ready for rewrite');

    var results = { queued: 0, failed: 0, errors: [] };
    var self = this;

    for (var i = 0; i < readyClusters.length; i++) {
      var clusterId = readyClusters[i].cluster_id;
      try {
        var cluster = this.db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId);

        // Resolve the primary draft for this cluster so we can CAS-lock it.
        var batchPrimary = this.db.prepare(
          "SELECT id FROM drafts WHERE cluster_id = ? AND cluster_role = 'primary' LIMIT 1"
        ).get(clusterId);

        if (!batchPrimary) {
          results.failed++;
          results.errors.push('Cluster #' + clusterId + ': no primary draft found');
          continue;
        }

        // Atomic CAS lock before kicking off the rewrite. If the auto loop
        // or another manual trigger already owns this draft, skip it.
        var batchLockResult = this.db.prepare(
          "UPDATE drafts SET status = 'rewriting', locked_by = 'rewriter', locked_at = datetime('now'), " +
          "lease_expires_at = datetime('now', '+' || ? || ' minutes'), updated_at = datetime('now') " +
          "WHERE id = ? AND (locked_by IS NULL OR lease_expires_at < datetime('now'))"
        ).run(_leaseMins(), batchPrimary.id);

        if (batchLockResult.changes === 0) {
          this.logger.debug(MODULE, 'Batch rewrite lock race lost for cluster #' + clusterId + ' (draft #' + batchPrimary.id + ')');
          results.failed++;
          results.errors.push('Cluster #' + clusterId + ': currently being processed, skipped');
          continue;
        }

        // Fire and forget — let them run in the background. Pass
        // alreadyLocked so _rewriteCluster doesn't re-CAS.
        this._rewriteCluster({
          cluster_id: clusterId,
          topic: cluster ? cluster.topic : '',
          trends_boosted: cluster ? cluster.trends_boosted : 0,
        }, { alreadyLocked: true }).catch(function (err) {
          self.logger.warn(MODULE, 'Rewrite failed for cluster: ' + err.message);
        });

        results.queued++;

        // Throttle: wait 2 seconds between starting rewrites to avoid API rate limits
        if (i < readyClusters.length - 1) {
          await new Promise(function (resolve) { setTimeout(resolve, 2000); });
        }
      } catch (err) {
        results.failed++;
        results.errors.push('Cluster #' + clusterId + ': ' + err.message);
      }
    }

    return results;
  }

  // ─── PUBLISH WORKER LOOP ────────────────────────────────────────────

  async _publishLoop(siteFilter) {
    if (this._publishRunning) return;
    this._publishRunning = true;

    try {
      var rateState = this.getPublishRateState(siteFilter && siteFilter > 0 ? siteFilter : undefined);
      if (!rateState.ready) {
        this._logPublishSkip(rateState);
        return;
      }

      // Optional per-site filter. Run-Now passes siteFilter to restrict
      // publishes to the active site; the scheduler tick leaves it undefined.
      var pubSiteWhere = '';
      var pubSiteParams = [];
      if (siteFilter && typeof siteFilter === 'number' && siteFilter > 0) {
        pubSiteWhere = ' AND d.site_id = ?';
        pubSiteParams = [siteFilter];
      }

      // Per-site opt-out for publish: drafts whose site set AUTOPILOT_ENABLED='false'
      // in site_config are skipped here so they don't starve siblings. The
      // per-site AutopilotEngine.isActive() gate below is still the source of
      // truth on a successful pick — this SQL filter is a pre-emptive fairness
      // tweak so one disabled site doesn't hog the single-candidate LIMIT 1.
      var PUB_SITE_OPT_OUT = " AND NOT EXISTS (" +
        "  SELECT 1 FROM site_config sc WHERE sc.site_id = d.site_id " +
        "    AND sc.key = 'AUTOPILOT_ENABLED' " +
        "    AND LOWER(sc.value) IN ('false', '0'))";

      // Find a cluster with primary draft in 'ready' status.
      // c.article_count and c.avg_similarity MUST be in the SELECT — the
      // autopilot gate below reads them from readyPrimary; if they're missing
      // they come back undefined, default to 1/0, and every article is
      // permanently rejected with "too few sources".
      var readyPrimarySql =
        "SELECT d.*, c.topic, c.trends_boosted, c.article_count, c.avg_similarity FROM drafts d " +
        "JOIN clusters c ON d.cluster_id = c.id " +
        "WHERE d.mode IN ('auto', 'manual_import') AND d.status = 'ready' AND d.cluster_role = 'primary' " +
        "  AND d.rewritten_html IS NOT NULL AND LENGTH(d.rewritten_html) > 100 " +
        "  AND (d.locked_by IS NULL OR d.lease_expires_at < datetime('now')) " +
        "  AND c.status = 'queued'" +
        pubSiteWhere + PUB_SITE_OPT_OUT + " " +
        "ORDER BY c.trends_boosted DESC, c.article_count DESC, d.created_at ASC " +
        "LIMIT 1";
      var readyPrimaryStmt = this.db.prepare(readyPrimarySql);
      var readyPrimary = pubSiteParams.length
        ? readyPrimaryStmt.get.apply(readyPrimaryStmt, pubSiteParams)
        : readyPrimaryStmt.get();

      if (!readyPrimary) return;

      // ─── Autopilot gate ────────────────────────────────────────────────────
      // Use per-site autopilot when the draft has a site_id, falling back to
      // the global autopilot instance for backward compat.
      var _apSiteId = readyPrimary.site_id || 1;
      var AutopilotEngine = require('../modules/autopilot');
      var _siteAutopilot = new AutopilotEngine(require('../utils/config'), this.db, this.logger, _apSiteId);
      if (_siteAutopilot.isActive()) {
        // Build minimal cluster/draft objects for the decision engine.
        // Use correct column names from the drafts table:
        //   source_language (not language), rewritten_word_count (not word_count)
        var clusterForAutopilot = {
          id: readyPrimary.cluster_id,
          avg_similarity: readyPrimary.avg_similarity || 0,
          article_count: readyPrimary.article_count || 1,
        };
        // Detect language: prefer stored source_language, else detect from
        // rewritten title + extracted content so existing rows with NULL
        // source_language are still filtered correctly.
        var _detectedLang = readyPrimary.source_language;
        if (!_detectedLang) {
          var _langSample = (readyPrimary.rewritten_title || readyPrimary.source_title || '') +
                            ' ' + (readyPrimary.extracted_content || '').slice(0, 500);
          _detectedLang = /[\u0900-\u097F]{3,}/.test(_langSample) ? 'hi' : 'en';
        }
        var draftForAutopilot = {
          title: readyPrimary.rewritten_title || readyPrimary.source_title || '',
          language: _detectedLang,
          word_count: readyPrimary.rewritten_word_count || 0,
          tier: 3,
          domain: readyPrimary.source_domain || '',
          page_category: readyPrimary.source_category || '',
        };
        var decision = _siteAutopilot.shouldPublish(clusterForAutopilot, draftForAutopilot);
        _siteAutopilot.logDecision(
          readyPrimary.cluster_id,
          draftForAutopilot.title,
          decision.approved,
          decision.reason
        );
        if (!decision.approved) {
          this.logger.info(MODULE, 'Autopilot skipped cluster #' + readyPrimary.cluster_id +
            ' "' + draftForAutopilot.title.substring(0, 50) + '" — ' + decision.reason);
          // Release the optimistic lock we haven't taken yet — nothing to unlock
          return;
        }
      }
      // ─── End autopilot gate ────────────────────────────────────────────────

      var publishSiteId = readyPrimary.site_id || 1;
      var clusterId = readyPrimary.cluster_id;

      // Select the correct publisher for this draft's site
      var sitePublisher = (this.publisherPool && this.publisherPool.get(publishSiteId)) || this.publisher;
      if (!sitePublisher) {
        this.logger.warn(MODULE, 'No publisher for site ' + publishSiteId + ', skipping cluster #' + clusterId);
        return;
      }

      // Atomic CAS lock (lease window must match _leaseMins()).
      // The WHERE clause guarantees only one worker wins the race — if another
      // worker grabbed this draft between our SELECT and UPDATE, changes === 0
      // and we skip this draft on this tick.
      var publishLockResult = this.db.prepare(
        "UPDATE drafts SET locked_by = 'publisher', locked_at = datetime('now'), " +
        "lease_expires_at = datetime('now', '+' || ? || ' minutes'), " +
        "updated_at = datetime('now') " +
        "WHERE id = ? AND (locked_by IS NULL OR lease_expires_at < datetime('now'))"
      ).run(_leaseMins(), readyPrimary.id);

      if (publishLockResult.changes === 0) {
        this.logger.debug(MODULE, 'Publish lock race lost for draft #' + readyPrimary.id);
        return;
      }

      this.logger.info(MODULE, 'Publishing cluster #' + clusterId + ': "' +
        (readyPrimary.rewritten_title || readyPrimary.source_title || '').substring(0, 60) + '"');

      // Per-job AbortController so shutdown() can cancel the WP upload / API
      // call immediately rather than waiting for the 60-second timeout.
      var publishController = new AbortController();
      this._activeControllers.add(publishController);

      // Load all cluster drafts for the publisher
      var clusterDrafts = this.db.prepare(
        "SELECT * FROM drafts WHERE cluster_id = ?"
      ).all(clusterId);

      // Build the objects the publisher expects
      var taxonomy = resolveTaxonomy(readyPrimary, this.db, require('../utils/config').getConfig());

      // Feed-mode: override classifier/publish-rules taxonomy with the Feed's
      // explicit dest_config. A Feed already decided category/author/tags/status
      // at creation time — we respect that without letting the AI classifier
      // second-guess it.
      if (readyPrimary.feed_id) {
        try {
          var feedRow = this.db.prepare('SELECT dest_config FROM feeds WHERE id = ?').get(readyPrimary.feed_id);
          if (feedRow && feedRow.dest_config) {
            var dest = JSON.parse(feedRow.dest_config || '{}');
            if (Array.isArray(dest.wp_category_ids) && dest.wp_category_ids.length) {
              taxonomy.categoryIds = dest.wp_category_ids;
            } else if (dest.wp_category_id) {
              taxonomy.categoryIds = [dest.wp_category_id];
            }
            if (dest.wp_category_id) taxonomy.primaryCategoryId = dest.wp_category_id;
            if (Array.isArray(dest.wp_tag_ids) && dest.wp_tag_ids.length) taxonomy.tagIds = dest.wp_tag_ids;
            if (dest.wp_author_id) taxonomy.authorId = dest.wp_author_id;
            if (dest.post_status)  taxonomy.postStatus = dest.post_status;
          }
        } catch (feedDestErr) {
          this.logger.warn(MODULE, 'Feed dest_config parse failed for feed ' + readyPrimary.feed_id + ': ' + feedDestErr.message);
        }
      }

      var rewrittenArticle = {
        title: readyPrimary.rewritten_title || readyPrimary.source_title,
        content: readyPrimary.rewritten_html,
        slug: (readyPrimary.rewritten_title || readyPrimary.source_title || '')
          .toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 60),
        excerpt: readyPrimary.extracted_excerpt || '',
        metaDescription: '',
        targetKeyword: readyPrimary.target_keyword || '',
        wordCount: readyPrimary.rewritten_word_count || 0,
        aiModel: readyPrimary.ai_model_used || '',
        schemaTypes: readyPrimary.schema_types || 'NewsArticle,FAQPage,BreadcrumbList',
        targetDomain: readyPrimary.target_domain || '',
        featuredImage: readyPrimary.featured_image || null,
        faq: [],
        wpCategories:   taxonomy.categoryIds,
        wpPrimaryCatId: taxonomy.primaryCategoryId,
        wpTags:         taxonomy.tagIds,
        wpAuthorId:     taxonomy.authorId,
        wpPostStatus:   taxonomy.postStatus || null,
        feedId:         readyPrimary.feed_id || null,
      };

      // Find featured image from any cluster draft
      if (!rewrittenArticle.featuredImage) {
        for (var fi = 0; fi < clusterDrafts.length; fi++) {
          if (clusterDrafts[fi].featured_image) {
            rewrittenArticle.featuredImage = clusterDrafts[fi].featured_image;
            break;
          }
        }
      }

      var clusterForPublish = {
        id: clusterId,
        topic: readyPrimary.topic,
        articles: clusterDrafts.map(function (d) {
          return {
            url: d.source_url,
            domain: d.source_domain,
            title: d.source_title,
            content_markdown: d.extracted_content || d.source_content_markdown || '',
            featured_image: d.featured_image || null,
          };
        }),
      };

      try {
        var pubResult = await sitePublisher.publish(rewrittenArticle, clusterForPublish, this.db, publishController.signal);
        this._activeControllers.delete(publishController);

        // Record publish for per-site rate limiting
        this._getSitePublishHistory(publishSiteId).push(Date.now());

        // Update ALL drafts in cluster to published
        this.db.prepare(
          "UPDATE drafts SET status = 'published', wp_post_id = ?, wp_post_url = ?, " +
          "locked_by = NULL, locked_at = NULL, lease_expires_at = NULL, " +
          "published_at = datetime('now'), updated_at = datetime('now') " +
          "WHERE cluster_id = ?"
        ).run(pubResult.wpPostId, pubResult.wpPostUrl, clusterId);

        this.db.prepare("UPDATE clusters SET status = 'published', published_at = datetime('now') WHERE id = ?").run(clusterId);

        this.stats.publishesCompleted++;
        this.logger.info(MODULE, 'Published cluster #' + clusterId + ' -> WP post #' + pubResult.wpPostId);

      } catch (pubErr) {
        this._activeControllers.delete(publishController);
        this.logger.error(MODULE, 'Publish failed for cluster #' + clusterId + ': ' + pubErr.message);
        this.stats.publishesFailed++;

        var retryCount = (readyPrimary.retry_count || 0) + 1;
        if (retryCount >= _rewriteMaxRetries()) {
          this.db.prepare(
            "UPDATE drafts SET status = 'failed', error_message = ?, retry_count = ?, " +
            "locked_by = NULL, lease_expires_at = NULL, updated_at = datetime('now') WHERE id = ?"
          ).run('WP publish failed: ' + pubErr.message, retryCount, readyPrimary.id);
          this.db.prepare("UPDATE clusters SET status = 'failed' WHERE id = ?").run(clusterId);
        } else {
          this.db.prepare(
            "UPDATE drafts SET error_message = ?, retry_count = ?, " +
            "next_run_at = datetime('now', '+' || ? || ' minutes'), " +
            "locked_by = NULL, lease_expires_at = NULL, updated_at = datetime('now') WHERE id = ?"
          ).run('WP publish failed (retry ' + retryCount + '/3): ' + pubErr.message,
            retryCount, retryCount * 5, readyPrimary.id);
        }
      }

    } catch (err) {
      this.logger.error(MODULE, 'Publish loop error: ' + err.message);
    } finally {
      this._publishRunning = false;
    }
  }

  // ─── RETRY + FAILURE LOGIC ──────────────────────────────────────────

  _failOrRetry(draft, resetStatus, errorMsg) {
    var retryCount = (draft.retry_count || 0) + 1;
    var maxRetries = draft.max_retries || 3;

    if (retryCount >= maxRetries) {
      this.db.prepare(
        "UPDATE drafts SET status = 'failed', error_message = ?, retry_count = ?, " +
        "failed_permanent = 1, locked_by = NULL, locked_at = NULL, lease_expires_at = NULL, " +
        "updated_at = datetime('now') WHERE id = ?"
      ).run(errorMsg, retryCount, draft.id);
    } else {
      // Exponential backoff: 2min, 4min, 8min
      var backoffMinutes = Math.pow(2, retryCount);
      this.db.prepare(
        "UPDATE drafts SET status = ?, error_message = ?, retry_count = ?, " +
        "next_run_at = datetime('now', '+' || ? || ' minutes'), " +
        "locked_by = NULL, locked_at = NULL, lease_expires_at = NULL, " +
        "updated_at = datetime('now') WHERE id = ?"
      ).run(resetStatus, errorMsg + ' (retry ' + retryCount + '/' + maxRetries + ')',
        retryCount, backoffMinutes, draft.id);
    }
  }

  // ─── Per-site publish history helpers ─────────────────────────────────
  _getSitePublishHistory(siteId) {
    if (!this.publishHistory.has(siteId)) this.publishHistory.set(siteId, []);
    return this.publishHistory.get(siteId);
  }

  // Flatten all per-site histories into a single array (for global views).
  _getAllPublishHistory() {
    var all = [];
    this.publishHistory.forEach(function (arr) {
      for (var i = 0; i < arr.length; i++) all.push(arr[i]);
    });
    return all;
  }

  // ─── RATE LIMIT ───────────────────────────────────────────────────────
  //
  // Reads the unified PUBLISH_RATE_COUNT + PUBLISH_RATE_UNIT settings when
  // both are set; otherwise falls back to the legacy MAX_PUBLISH_PER_HOUR +
  // PUBLISH_COOLDOWN_MINUTES pair. The gap between consecutive publishes is
  // derived as windowMs / count, so setting "10 per hour" gives a 6-minute
  // cadence automatically — no need to keep cooldown in sync manually.

  _resolvedPublishRate() {
    var unit = _publishRateUnit();
    var count = _publishRateCount();
    var windowMs, gapMs, source;

    if (unit && count > 0) {
      windowMs = _publishWindowMs(unit);
      gapMs = Math.floor(windowMs / count);
      source = 'unified';
    } else {
      // Legacy path
      unit = 'hour';
      count = _maxPublishPerHour();
      windowMs = 60 * 60 * 1000;
      gapMs = _publishCooldownMs();
      source = 'legacy';
    }
    return { count: count, unit: unit, windowMs: windowMs, gapMs: gapMs, source: source };
  }

  getPublishRateState(siteId) {
    var r = this._resolvedPublishRate();
    var now = Date.now();
    var cutoff = now - r.windowMs;
    var historyArr = siteId ? this._getSitePublishHistory(siteId) : this._getAllPublishHistory();
    var recent = historyArr.filter(function (ts) { return ts > cutoff; });
    var recentCount = recent.length;
    var nextAtMs = now;
    var reason = 'ready';

    if (recentCount >= r.count) {
      // Window cap hit — next publish is when the oldest in-window event rolls off.
      var oldest = Math.min.apply(null, recent);
      nextAtMs = oldest + r.windowMs;
      reason = 'window_cap_' + r.count + '_per_' + r.unit;
    } else if (recentCount > 0 && r.gapMs > 0) {
      var last = Math.max.apply(null, recent);
      var ready = last + r.gapMs;
      if (ready > now) {
        nextAtMs = ready;
        reason = 'cooldown_gap_' + Math.round(r.gapMs / 1000) + 's';
      }
    }

    var nextInMs = Math.max(0, nextAtMs - now);
    return {
      count: r.count,
      unit: r.unit,
      gapMs: r.gapMs,
      windowMs: r.windowMs,
      source: r.source,
      recentCount: recentCount,
      nextInMs: nextInMs,
      nextAtIso: new Date(nextAtMs).toISOString(),
      reason: reason,
      ready: nextInMs === 0,
    };
  }

  canPublishNow() {
    try {
      var state = this.getPublishRateState();
      // Prune any history older than the largest window we care about so the
      // Map doesn't grow unbounded between windows.
      var cutoff = Date.now() - Math.max(state.windowMs, 60 * 60 * 1000);
      this.publishHistory.forEach(function (arr, key, map) {
        var pruned = arr.filter(function (ts) { return ts > cutoff; });
        if (pruned.length === 0) map.delete(key);
        else map.set(key, pruned);
      });
      return state.ready;
    } catch (err) {
      this.logger.error(MODULE, 'canPublishNow error (allowing): ' + err.message);
      return true;
    }
  }

  // Throttled log when _publishLoop skips on rate limit. Logs at most once per
  // 120s per reason so the log panel stays legible during a long cooldown.
  _logPublishSkip(state) {
    var now = Date.now();
    if (!this._lastRateLimitLogAt) this._lastRateLimitLogAt = 0;
    if (!this._lastRateLimitLogReason) this._lastRateLimitLogReason = '';
    if (now - this._lastRateLimitLogAt < 120000 && state.reason === this._lastRateLimitLogReason) return;
    this._lastRateLimitLogAt = now;
    this._lastRateLimitLogReason = state.reason;
    var secs = Math.ceil(state.nextInMs / 1000);
    this.logger.info(
      MODULE,
      'Publish rate limit: ' + state.count + '/' + state.unit + ' (recent=' + state.recentCount +
      ', source=' + state.source + ') — next in ' + secs + 's at ' + state.nextAtIso
    );
  }

  // ─── LIFECYCLE ──────────────────────────────────────────────────────

  async init() {
    // Only release EXPIRED locks (not all locks — some might still be processing)
    try {
      var staleResult = this.db.prepare(
        "UPDATE drafts SET locked_by = NULL, locked_at = NULL, lease_expires_at = NULL " +
        "WHERE locked_by IS NOT NULL AND lease_expires_at < datetime('now')"
      ).run();
      if (staleResult.changes > 0) {
        this.logger.info(MODULE, 'Released ' + staleResult.changes + ' expired locks from previous session');
      }
    } catch (e) {
      this.logger.warn(MODULE, 'Could not release stale locks (columns may not exist yet): ' + e.message);
    }

    // Recover drafts stuck in transient states (from server crash)
    try {
      var stuckResult = this.db.prepare(
        "UPDATE drafts SET status = 'draft', locked_by = NULL, locked_at = NULL, lease_expires_at = NULL, " +
        "error_message = 'Recovered from stuck state (server restarted)', updated_at = datetime('now') " +
        "WHERE status IN ('fetching', 'rewriting') AND locked_by IS NULL AND " +
        "updated_at < datetime('now', '-5 minutes')"
      ).run();
      if (stuckResult.changes > 0) {
        this.logger.info(MODULE, 'Recovered ' + stuckResult.changes + ' stuck drafts from previous crash');
      }
    } catch (e) {
      this.logger.warn(MODULE, 'Could not recover stuck drafts (columns may not exist yet): ' + e.message);
    }

    this.logger.info(MODULE, 'Pipeline V2 initialized (extract:sequential rewrite:manual publish:rate-limited)');
  }

  start() {
    var self = this;

    this.logger.info(MODULE, 'Starting Pipeline V2 workers...');

    // Sequential extraction — no ramp-up needed
    this.logger.info(MODULE, 'Sequential extraction queue — 1 article at a time, ~1-2 per second');

    // Extraction loop — self-rescheduling setTimeout reads poll interval from config
    // on each tick so EXTRACTION_POLL_MS changes take effect without restart.
    function scheduleExtraction() {
      self._extractionTimer = setTimeout(function () {
        self._extractionLoop().catch(function (err) {
          self.logger.error(MODULE, 'Extraction loop crash: ' + err.message);
          self._extractionRunning = false;
        }).finally(function () {
          if (!self._stopped) scheduleExtraction();
        });
      }, _extractionPollMs());
    }
    scheduleExtraction();

    // Rewrite loop — self-rescheduling setTimeout reads poll interval from config
    // on each tick. Guarded by AUTO_REWRITE_ENABLED flag (hot-reloaded each tick),
    // so toggling the setting takes effect without restart.
    function scheduleRewrite() {
      self._rewriteTimer = setTimeout(function () {
        self._rewriteLoop().catch(function (err) {
          self.logger.error(MODULE, 'Rewrite loop crash: ' + err.message);
          self._rewriteRunning = false;
        }).finally(function () {
          if (!self._stopped) scheduleRewrite();
        });
      }, _autoRewritePollMs());
    }
    scheduleRewrite();

    // Publish loop — self-rescheduling setTimeout reads poll interval from config
    // on each tick so PUBLISH_POLL_MS changes take effect without restart.
    function schedulePublish() {
      self._publishTimer = setTimeout(function () {
        self._publishLoop().catch(function (err) {
          self.logger.error(MODULE, 'Publish loop crash: ' + err.message);
          self._publishRunning = false;
        }).finally(function () {
          if (!self._stopped) schedulePublish();
        });
      }, _publishPollMs());
    }
    schedulePublish();

    this.logger.info(MODULE, 'All worker loops started (extraction: sequential queue, rewrite: auto-gated, publish: auto)');
  }

  stop() {
    this._stopped = true;
    if (this._extractionTimer) { clearTimeout(this._extractionTimer); this._extractionTimer = null; }
    if (this._rewriteTimer) { clearTimeout(this._rewriteTimer); this._rewriteTimer = null; }
    if (this._publishTimer) { clearTimeout(this._publishTimer); this._publishTimer = null; }
    this.logger.info(MODULE, 'Pipeline stopped');
  }

  async shutdown() {
    this.stop();
    // Cancel all in-flight rewrite/publish HTTP calls immediately.
    // Without this, in-flight requests keep running until the provider's
    // socket timeout (up to 60s), and recovered drafts are re-processed
    // on restart → double AI billing / duplicate WP posts.
    this._activeControllers.forEach(function (ctrl) { ctrl.abort(); });
    this._activeControllers.clear();
    // Release all our locks
    try {
      this.db.prepare("UPDATE drafts SET locked_by = NULL, locked_at = NULL, lease_expires_at = NULL WHERE locked_by IS NOT NULL").run();
    } catch (e) { /* ignore */ }
  }

  // ─── HEALTH / STATUS (for API compatibility) ────────────────────────

  getHealth() {
    return {
      module: MODULE,
      enabled: true,
      ready: true,
      status: 'connected',
      error: null,
      lastActivity: null,
      stats: this.stats,
    };
  }

  getQueueStatus() {
    try {
      var now = Date.now();
      var oneHourAgo = now - 60 * 60 * 1000;
      var maxPerHour = parseInt(this.config.MAX_PUBLISH_PER_HOUR, 10) || 4;
      var cooldownMs = (parseInt(this.config.PUBLISH_COOLDOWN_MINUTES, 10) || 10) * 60 * 1000;

      var allHistory = this._getAllPublishHistory();
      var recentHistory = allHistory.filter(function (ts) { return ts > oneHourAgo; });
      var publishedThisHour = recentHistory.length;

      var counts = this.db.prepare(
        "SELECT status, COUNT(*) as count FROM drafts WHERE mode = 'auto' GROUP BY status"
      ).all();

      var statusCounts = {};
      for (var i = 0; i < counts.length; i++) {
        statusCounts[counts[i].status] = counts[i].count;
      }

      var pendingDrafts = (statusCounts.fetching || 0) + (statusCounts.draft || 0) +
        (statusCounts.rewriting || 0) + (statusCounts.ready || 0);

      var nextPublishIn = 0;
      if (recentHistory.length > 0) {
        var lastPublish = Math.max.apply(null, recentHistory);
        var cooldownRemaining = (lastPublish + cooldownMs) - now;
        nextPublishIn = Math.max(0, Math.ceil(cooldownRemaining / 1000));
      }

      return {
        queueLength: pendingDrafts,
        pendingDrafts: pendingDrafts,
        nextPublishIn: nextPublishIn,
        publishedThisHour: publishedThisHour,
        rateLimitHit: publishedThisHour >= maxPerHour,
        stages: {
          fetching: statusCounts.fetching || 0,
          draft: statusCounts.draft || 0,
          rewriting: statusCounts.rewriting || 0,
          ready: statusCounts.ready || 0,
          published: statusCounts.published || 0,
          failed: statusCounts.failed || 0,
        },
        stats: this.stats,
      };
    } catch (err) {
      this.logger.error(MODULE, 'getQueueStatus error: ' + err.message);
      return { queueLength: 0, pendingDrafts: 0, nextPublishIn: 0, publishedThisHour: 0, rateLimitHit: false };
    }
  }

  // ─── BACKWARD COMPATIBILITY ─────────────────────────────────────────
  // These methods exist so existing code that calls scheduler.enqueue()
  // or scheduler.processQueue() still works.

  enqueue(cluster) {
    // Create drafts from a cluster's articles. Two modes:
    //   • Feed-mode (cluster.feed_id set)    → one target: the feed's site.
    //     Drafts stamped with feed_id and site_id. No language fan-out — the
    //     feed's own filter already handled language selection at SSE ingest.
    //   • Legacy multi-site mode (feed_id NULL) → fan-out to every active site
    //     whose PUBLISH_LANGUAGE matches the cluster's primary language.
    try {
      if (!cluster || !cluster.id) return;

      var articles = this.db.prepare(
        'SELECT * FROM articles WHERE cluster_id = ? ORDER BY authority_tier ASC, received_at ASC'
      ).all(cluster.id);
      if (articles.length === 0) return;

      var primaryArt = articles[0];
      var primaryLang = primaryArt.language ||
        (/[\u0900-\u097F]{3,}/.test((primaryArt.title || '') + ' ' + (primaryArt.content_markdown || '').slice(0, 300)) ? 'hi' : 'en');

      // Fresh-read the cluster so we pick up feed_id after similarity.js
      // stamped it (enqueue is called after createOrUpdateCluster resolves).
      var clusterRow = this.db.prepare('SELECT feed_id FROM clusters WHERE id = ?').get(cluster.id);
      var feedId = clusterRow && clusterRow.feed_id ? clusterRow.feed_id : null;

      var insertDraft = this.db.prepare(
        "INSERT OR IGNORE INTO drafts (" +
        "  source_article_id, source_url, source_domain, source_title," +
        "  source_content_markdown, source_language, target_platform, status, mode," +
        "  cluster_id, cluster_role, extraction_status, site_id, feed_id" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );

      // Per-(cluster, site, article) existence check so a SECOND article
      // joining an already-enqueued cluster still gets its own draft. The
      // old code short-circuited the whole site loop when any draft for
      // the cluster existed, which meant growth events (2nd source, 3rd
      // source, ...) never produced drafts for the new articles — they
      // sat in the articles table with no extraction queued.
      var articleHasDraft = this.db.prepare(
        'SELECT 1 FROM drafts WHERE cluster_id = ? AND site_id = ? AND source_article_id = ? LIMIT 1'
      );

      var self = this;
      var totalDrafts = 0;
      var matchedSites = 0;

      // Resolve the target-site list. Feed-mode = 1 site (the feed owns it).
      // Legacy multi-site = every active site.
      var targetSites;
      if (feedId) {
        var feedRow = this.db.prepare('SELECT site_id FROM feeds WHERE id = ?').get(feedId);
        if (!feedRow) {
          this.logger.warn(MODULE, 'Enqueue: cluster ' + cluster.id + ' references feed ' + feedId + ' but the feed row is gone; skipping');
          return;
        }
        targetSites = [{ id: feedRow.site_id, _feedMode: true }];
      } else {
        try {
          targetSites = siteConfig.getAllActiveSites();
        } catch (_e) {
          targetSites = [{ id: 1 }];
        }
        if (!targetSites || targetSites.length === 0) targetSites = [{ id: 1 }];
      }

      var createDrafts = this.db.transaction(function () {
        for (var si = 0; si < targetSites.length; si++) {
          var site = targetSites[si];
          var siteId = site.id;

          // Language filter is ONLY applied in legacy multi-site mode. In
          // feed-mode the feed's own filter already gated on ALLOWED_LANGUAGES
          // at ingest — re-applying PUBLISH_LANGUAGE here would double-filter
          // and drop valid feed articles.
          if (!site._feedMode) {
            var siteLangPref;
            try {
              siteLangPref = (siteConfig.getSiteConfig(siteId, 'PUBLISH_LANGUAGE') || 'en').toLowerCase().trim();
            } catch (_e) {
              siteLangPref = 'en';
            }
            if (siteLangPref !== 'both' && siteLangPref !== primaryLang) continue;
          }

          matchedSites++;

          // If the cluster already has a primary draft for this site, keep
          // it as primary. Otherwise promote the first article this pass.
          var hasPrimary = self.db.prepare(
            "SELECT 1 FROM drafts WHERE cluster_id = ? AND site_id = ? AND cluster_role = 'primary' LIMIT 1"
          ).get(cluster.id, siteId);
          var primaryAssignedThisRun = false;

          for (var i = 0; i < articles.length; i++) {
            var a = articles[i];
            // Skip articles that already have a draft for this site —
            // growth events re-run enqueue() and this guard lets new
            // articles get drafts without duplicating the existing ones.
            if (articleHasDraft.get(cluster.id, siteId, a.id)) continue;

            var role;
            if (hasPrimary || primaryAssignedThisRun) {
              role = 'source';
            } else {
              role = 'primary';
              primaryAssignedThisRun = true;
            }
            var artLang = a.language || (/[\u0900-\u097F]{3,}/.test((a.title || '') + ' ' + (a.content_markdown || '').slice(0, 300)) ? 'hi' : 'en');
            insertDraft.run(
              a.id, a.url, a.domain, a.title,
              a.content_markdown || '', artLang, 'wordpress',
              'fetching', 'auto',
              cluster.id, role, 'pending',
              siteId, feedId
            );
            totalDrafts++;
          }
        }
        self.db.prepare("UPDATE clusters SET status = 'queued' WHERE id = ?").run(cluster.id);
      });

      createDrafts();
      this.logger.info(MODULE, 'Enqueued cluster ' + cluster.id +
        (feedId ? ' (feed=' + feedId + ')' : '') +
        ' -> ' + totalDrafts + ' drafts across ' + matchedSites + ' site(s)');

    } catch (err) {
      this.logger.error(MODULE, 'Enqueue failed: ' + err.message);
    }
  }

  async processQueue() {
    // Backward compat: manual trigger just runs one extraction cycle
    await this._extractionLoop();
  }
}

module.exports = { Pipeline };
