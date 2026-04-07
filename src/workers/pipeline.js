'use strict';

var { extractDraftContent } = require('../utils/draft-helpers');

var MODULE = 'pipeline';

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
  constructor(config, db, rewriter, publisher, logger, extractor) {
    this.config = config;
    this.db = db;
    this.rewriter = rewriter;
    this.publisher = publisher;
    this.logger = logger;
    this.extractor = extractor;

    // Worker config
    this.EXTRACTION_CONCURRENCY = 5;   // Tuned for 4GB RAM — JSDOM uses 50-100MB per parse
    this.EXTRACTION_POLL_MS = 2000;
    this.REWRITE_CONCURRENCY = 3;
    this.REWRITE_POLL_MS = 5000;
    this.PUBLISH_POLL_MS = 30000;

    // ─── Memory safety (for 4GB server) ─────────────────────────────────
    this.MEMORY_LIMIT_MB = 3200;            // Pause extraction if RSS exceeds this
    this.RAMP_UP_INITIAL = 2;               // Start with only 2 concurrent on cold start
    this.RAMP_UP_INTERVAL_MS = 30000;       // Add 1 more worker every 30 seconds

    // Track active workers
    this._extractionRunning = false;
    this._rewriteRunning = false;
    this._publishRunning = false;

    // Publish rate limiting (in-memory, same as old scheduler)
    this.publishHistory = [];

    // Ramp-up state
    this._currentMaxExtractions = this.RAMP_UP_INITIAL;
    this._rampUpTimer = null;

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

    // Prepared statements (lazy)
    this._stmts = {};

    // Flag for backward compat with old scheduler code
    this._processing = false;
  }

  // ─── PREPARED STATEMENTS ─────────────────────────────────────────────

  _getStmt(name, sql) {
    if (!this._stmts[name]) {
      this._stmts[name] = this.db.prepare(sql);
    }
    return this._stmts[name];
  }

  // ─── ATOMIC JOB CLAIMING ─────────────────────────────────────────────
  //
  // Claims a batch of jobs atomically. Uses lease_expires_at to prevent
  // duplicate processing. Dead jobs auto-recover when lease expires.

  claimJobs(status, workerName, count, extraConditions) {
    var leaseMinutes = this.LEASE_MINUTES || 3;
    var conditions = "status = ? AND mode = 'auto'" +
      " AND (locked_by IS NULL OR lease_expires_at < datetime('now'))" +
      " AND (next_run_at IS NULL OR next_run_at <= datetime('now'))";

    // SAFETY: Only allow known extra conditions (prevent SQL injection)
    if (extraConditions === "extraction_status NOT IN ('success','cached','fallback')") {
      conditions += " AND extraction_status NOT IN ('success','cached','fallback')";
    } else if (extraConditions === "cluster_role = 'primary'") {
      conditions += " AND cluster_role = 'primary'";
    }
    // Any other extraConditions value is silently ignored for safety

    // ATOMIC: Claim and select in a transaction so no other worker can race us
    var self = this;
    var claimTransaction = this.db.transaction(function () {
      // Step 1: Find unclaimed jobs
      var findSql = 'SELECT id FROM drafts WHERE ' + conditions +
        " ORDER BY cluster_role = 'primary' DESC, created_at ASC LIMIT ?";
      var found = self.db.prepare(findSql).all(status, count);
      if (found.length === 0) return [];

      var ids = found.map(function (r) { return r.id; });

      // Step 2: Claim them atomically (in same transaction)
      var placeholders = ids.map(function () { return '?'; }).join(',');
      var claimSql = "UPDATE drafts SET locked_by = ?, locked_at = datetime('now'), " +
        "lease_expires_at = datetime('now', '+" + leaseMinutes + " minutes') " +
        "WHERE id IN (" + placeholders + ") AND (locked_by IS NULL OR lease_expires_at < datetime('now'))";
      self.db.prepare(claimSql).run.apply(null, [workerName].concat(ids));

      // Step 3: Return claimed drafts
      var claimedSql = 'SELECT * FROM drafts WHERE id IN (' + placeholders + ') AND locked_by = ?';
      return self.db.prepare(claimedSql).all.apply(null, ids.concat([workerName]));
    });

    return claimTransaction();
  }

  releaseJob(draftId) {
    this.db.prepare(
      "UPDATE drafts SET locked_by = NULL, locked_at = NULL, lease_expires_at = NULL, updated_at = datetime('now') WHERE id = ?"
    ).run(draftId);
  }

  // ─── MEMORY WATCHDOG ─────────────────────────────────────────────────

  _checkMemory() {
    var memUsage = process.memoryUsage();
    var rssMB = Math.round(memUsage.rss / 1024 / 1024);
    if (rssMB > this.MEMORY_LIMIT_MB) {
      this.logger.warn(MODULE, 'MEMORY HIGH: RSS=' + rssMB + 'MB (limit=' + this.MEMORY_LIMIT_MB + 'MB). Pausing extraction 30s');
      return false;
    }
    return true;
  }

  // ─── EXTRACTION WORKER LOOP ──────────────────────────────────────────

  async _extractionLoop() {
    if (this._extractionRunning) return;
    this._extractionRunning = true;

    try {
      // Memory guard
      if (!this._checkMemory()) {
        this._extractionRunning = false;
        var self = this;
        setTimeout(function () {
          self._extractionLoop().catch(function (err) {
            self.logger.error(MODULE, 'Extraction error after memory pause: ' + err.message);
          });
        }, 30000);
        return;
      }
      // Backpressure: pause extraction if too many drafts waiting for rewrite
      var draftBacklog = this.db.prepare(
        "SELECT COUNT(*) as count FROM drafts WHERE mode = 'auto' AND status = 'draft' AND cluster_role = 'primary'"
      ).get();
      if (draftBacklog && draftBacklog.count > 500) {
        this.logger.debug(MODULE, 'Backpressure: ' + draftBacklog.count + ' drafts waiting for rewrite — pausing extraction');
        return;
      }

      // Claim a batch of fetching drafts (use ramp-up limited count)
      var jobs = this.claimJobs('fetching', 'extractor', this._currentMaxExtractions);

      if (jobs.length === 0) return;

      this.logger.info(MODULE, 'Extraction: claimed ' + jobs.length + ' jobs');
      this.stats.extractionsStarted += jobs.length;

      var self = this;
      var draftDeps = { db: this.db, logger: this.logger, extractor: this.extractor, rewriter: this.rewriter };

      // Run ALL claimed jobs in parallel (they're all network I/O)
      var promises = jobs.map(function (draft) {
        return extractDraftContent(draft.id, draftDeps)
          .then(function () {
            // Release lock (extractDraftContent already updates status to 'draft')
            self.releaseJob(draft.id);
            self.stats.extractionsCompleted++;

            var updated = self.db.prepare('SELECT extraction_status, extracted_content FROM drafts WHERE id = ?').get(draft.id);
            if (updated) {
              self.logger.info(MODULE, 'Extracted #' + draft.id + ' (' + draft.source_domain + ') -> ' +
                updated.extraction_status + ' (' + (updated.extracted_content || '').length + ' chars)');
            }
          })
          .catch(function (err) {
            self.logger.warn(MODULE, 'Extraction #' + draft.id + ' failed: ' + err.message);
            self.stats.extractionsFailed++;
            // Reset extraction_status so it doesn't stay stuck in 'extracting'
            try {
              self.db.prepare(
                "UPDATE drafts SET extraction_status = 'failed', " +
                "locked_by = NULL, locked_at = NULL, lease_expires_at = NULL, " +
                "updated_at = datetime('now') WHERE id = ? AND extraction_status = 'extracting'"
              ).run(draft.id);
            } catch (dbErr) {
              self.logger.error(MODULE, 'Failed to reset extraction_status for #' + draft.id + ': ' + dbErr.message);
            }
            self._failOrRetry(draft, 'fetching', err.message);
          });
      });

      await Promise.all(promises);

    } catch (err) {
      this.logger.error(MODULE, 'Extraction loop error: ' + err.message);
    } finally {
      this._extractionRunning = false;
    }
  }

  // ─── REWRITE WORKER LOOP ────────────────────────────────────────────

  async _rewriteLoop() {
    if (this._rewriteRunning) return;
    this._rewriteRunning = true;

    try {
      // Find clusters where ALL drafts are extracted (status = 'draft')
      // and the primary draft is not locked
      var readyClusters = this.db.prepare(
        "SELECT d.cluster_id, c.topic, c.trends_boosted, COUNT(*) as draft_count " +
        "FROM drafts d " +
        "JOIN clusters c ON d.cluster_id = c.id " +
        "WHERE d.mode = 'auto' AND d.cluster_id IS NOT NULL AND d.status = 'draft' " +
        "  AND c.status = 'queued' " +
        "  AND (d.locked_by IS NULL OR d.lease_expires_at < datetime('now')) " +
        "  AND NOT EXISTS (" +
        "    SELECT 1 FROM drafts d2 WHERE d2.cluster_id = d.cluster_id " +
        "    AND d2.status = 'fetching' AND d2.mode = 'auto'" +
        "  ) " +
        "GROUP BY d.cluster_id " +
        "HAVING COUNT(CASE WHEN d.cluster_role = 'primary' THEN 1 END) > 0 " +
        "ORDER BY c.trends_boosted DESC, c.article_count DESC, c.detected_at ASC " +
        "LIMIT ?"
      ).all(this.REWRITE_CONCURRENCY);

      if (readyClusters.length === 0) return;

      this.logger.info(MODULE, 'Rewrite: found ' + readyClusters.length + ' clusters ready for AI rewrite');

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

  async _rewriteCluster(clusterInfo) {
    var clusterId = clusterInfo.cluster_id;

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

    // Lock the primary draft
    this.db.prepare(
      "UPDATE drafts SET status = 'rewriting', locked_by = 'rewriter', locked_at = datetime('now'), " +
      "lease_expires_at = datetime('now', '+5 minutes'), updated_at = datetime('now') WHERE id = ?"
    ).run(primaryDraft.id);

    this.stats.rewritesStarted++;

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

      var rewritten = await this.rewriter.rewrite(primaryArticle, clusterForRewrite);

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

    } catch (err) {
      this.logger.error(MODULE, 'Rewrite failed for cluster #' + clusterId + ': ' + err.message);
      this.stats.rewritesFailed++;

      var retryCount = (primaryDraft.retry_count || 0) + 1;
      if (retryCount >= 3) {
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

    // Call the existing _rewriteCluster method with proper clusterInfo shape
    await this._rewriteCluster({
      cluster_id: clusterId,
      topic: cluster ? cluster.topic : '',
      trends_boosted: cluster ? cluster.trends_boosted : 0,
    });

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

        // Fire and forget — let them run in the background
        this._rewriteCluster({
          cluster_id: clusterId,
          topic: cluster ? cluster.topic : '',
          trends_boosted: cluster ? cluster.trends_boosted : 0,
        }).catch(function (err) {
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

  async _publishLoop() {
    if (this._publishRunning) return;
    this._publishRunning = true;

    try {
      if (!this.canPublishNow()) return;

      // Find a cluster with primary draft in 'ready' status
      var readyPrimary = this.db.prepare(
        "SELECT d.*, c.topic, c.trends_boosted FROM drafts d " +
        "JOIN clusters c ON d.cluster_id = c.id " +
        "WHERE d.mode = 'auto' AND d.status = 'ready' AND d.cluster_role = 'primary' " +
        "  AND d.rewritten_html IS NOT NULL AND LENGTH(d.rewritten_html) > 100 " +
        "  AND (d.locked_by IS NULL OR d.lease_expires_at < datetime('now')) " +
        "  AND c.status = 'queued' " +
        "ORDER BY c.trends_boosted DESC, c.article_count DESC, d.created_at ASC " +
        "LIMIT 1"
      ).get();

      if (!readyPrimary) return;

      var clusterId = readyPrimary.cluster_id;

      // Lock it
      this.db.prepare(
        "UPDATE drafts SET locked_by = 'publisher', locked_at = datetime('now'), " +
        "lease_expires_at = datetime('now', '+3 minutes') WHERE id = ?"
      ).run(readyPrimary.id);

      this.logger.info(MODULE, 'Publishing cluster #' + clusterId + ': "' +
        (readyPrimary.rewritten_title || readyPrimary.source_title || '').substring(0, 60) + '"');

      // Load all cluster drafts for the publisher
      var clusterDrafts = this.db.prepare(
        "SELECT * FROM drafts WHERE cluster_id = ?"
      ).all(clusterId);

      // Build the objects the publisher expects
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
        var pubResult = await this.publisher.publish(rewrittenArticle, clusterForPublish, this.db);

        // Record publish for rate limiting
        this.publishHistory.push(Date.now());

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
        this.logger.error(MODULE, 'Publish failed for cluster #' + clusterId + ': ' + pubErr.message);
        this.stats.publishesFailed++;

        var retryCount = (readyPrimary.retry_count || 0) + 1;
        if (retryCount >= 3) {
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

  // ─── RATE LIMIT (same logic as old scheduler) ───────────────────────

  canPublishNow() {
    try {
      var now = Date.now();
      var oneHourAgo = now - 60 * 60 * 1000;

      var maxPerHour = parseInt(this.config.MAX_PUBLISH_PER_HOUR, 10);
      if (isNaN(maxPerHour) || maxPerHour <= 0) maxPerHour = 4;

      var cooldownMinutes = parseInt(this.config.PUBLISH_COOLDOWN_MINUTES, 10);
      if (isNaN(cooldownMinutes) || cooldownMinutes < 0) cooldownMinutes = 10;
      var cooldownMs = cooldownMinutes * 60 * 1000;

      this.publishHistory = this.publishHistory.filter(function (ts) { return ts > oneHourAgo; });

      if (this.publishHistory.length >= maxPerHour) {
        return false;
      }

      if (this.publishHistory.length > 0 && cooldownMs > 0) {
        var lastPublish = Math.max.apply(null, this.publishHistory);
        if ((now - lastPublish) < cooldownMs) return false;
      }

      return true;
    } catch (err) {
      this.logger.error(MODULE, 'canPublishNow error (allowing): ' + err.message);
      return true;
    }
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

    this.logger.info(MODULE, 'Pipeline V2 initialized (extract:' + this.EXTRACTION_CONCURRENCY +
      ' rewrite:' + this.REWRITE_CONCURRENCY + ' publish:rate-limited)');
  }

  start() {
    var self = this;

    this.logger.info(MODULE, 'Starting Pipeline V2 workers...');

    // ─── Gradual ramp-up: prevents cold-start memory spike ──────────
    this._currentMaxExtractions = this.RAMP_UP_INITIAL;
    this.logger.info(MODULE, 'Starting with ' + this.RAMP_UP_INITIAL + ' concurrent extractions, ramping to ' + this.EXTRACTION_CONCURRENCY);
    this._rampUpTimer = setInterval(function () {
      if (self._currentMaxExtractions < self.EXTRACTION_CONCURRENCY) {
        self._currentMaxExtractions += 1;
        self.logger.info(MODULE, 'Ramp-up: extractions now ' + self._currentMaxExtractions + '/' + self.EXTRACTION_CONCURRENCY);
      } else {
        clearInterval(self._rampUpTimer);
        self._rampUpTimer = null;
      }
    }, this.RAMP_UP_INTERVAL_MS);

    // Extraction loop — fast, high concurrency
    this._extractionTimer = setInterval(function () {
      self._extractionLoop().catch(function (err) {
        self.logger.error(MODULE, 'Extraction loop crash: ' + err.message);
        self._extractionRunning = false;
      });
    }, this.EXTRACTION_POLL_MS);

    // ─── REWRITE LOOP DISABLED — Manual trigger only ─────────────
    // The rewrite loop no longer auto-polls. Rewriting is triggered
    // manually via POST /api/drafts/batch-rewrite or individual
    // POST /api/clusters/:clusterId/rewrite buttons in the UI.
    // The _rewriteCluster() method is still available for manual use.
    this._rewriteTimer = null;
    this.logger.info(MODULE, 'Rewrite loop: MANUAL MODE (no auto-polling)');

    // Publish loop — strict rate limit
    this._publishTimer = setInterval(function () {
      self._publishLoop().catch(function (err) {
        self.logger.error(MODULE, 'Publish loop crash: ' + err.message);
        self._publishRunning = false;
      });
    }, this.PUBLISH_POLL_MS);

    this.logger.info(MODULE, 'All 3 worker loops started');
  }

  stop() {
    if (this._rampUpTimer) { clearInterval(this._rampUpTimer); this._rampUpTimer = null; }
    if (this._extractionTimer) { clearInterval(this._extractionTimer); this._extractionTimer = null; }
    if (this._rewriteTimer) { clearInterval(this._rewriteTimer); this._rewriteTimer = null; }
    if (this._publishTimer) { clearInterval(this._publishTimer); this._publishTimer = null; }
    this.logger.info(MODULE, 'Pipeline stopped');
  }

  async shutdown() {
    this.stop();
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

      this.publishHistory = this.publishHistory.filter(function (ts) { return ts > oneHourAgo; });
      var publishedThisHour = this.publishHistory.length;

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
      if (this.publishHistory.length > 0) {
        var lastPublish = Math.max.apply(null, this.publishHistory);
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
    // The old scheduler.enqueue() created drafts. Keep that behavior.
    try {
      if (!cluster || !cluster.id) return;

      var existing = this.db.prepare(
        'SELECT COUNT(*) as count FROM drafts WHERE cluster_id = ?'
      ).get(cluster.id);
      if (existing && existing.count > 0) return;

      var articles = this.db.prepare(
        'SELECT * FROM articles WHERE cluster_id = ? ORDER BY authority_tier ASC, received_at ASC'
      ).all(cluster.id);
      if (articles.length === 0) return;

      var insertDraft = this.db.prepare(
        "INSERT OR IGNORE INTO drafts (" +
        "  source_article_id, source_url, source_domain, source_title," +
        "  source_content_markdown, target_platform, status, mode," +
        "  cluster_id, cluster_role, extraction_status" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );

      var self = this;
      var createDrafts = this.db.transaction(function () {
        for (var i = 0; i < articles.length; i++) {
          var a = articles[i];
          insertDraft.run(
            a.id, a.url, a.domain, a.title,
            a.content_markdown || '', 'wordpress',
            'fetching', 'auto',
            cluster.id, i === 0 ? 'primary' : 'source', 'pending'
          );
        }
        self.db.prepare("UPDATE clusters SET status = 'queued' WHERE id = ?").run(cluster.id);
      });

      createDrafts();
      this.logger.info(MODULE, 'Enqueued cluster ' + cluster.id + ' -> ' + articles.length + ' drafts');
      // No need for immediate trigger — extraction loop picks up in 2 seconds

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
