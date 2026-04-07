'use strict';

// Queue processing interval (30 seconds)
var PROCESS_INTERVAL_MS = 30000;

class PublishScheduler {
  /**
   * @param {object} config
   * @param {object} db - better-sqlite3 Database instance
   * @param {import('./rewriter').ArticleRewriter} rewriter
   * @param {import('./publisher').WordPressPublisher} publisher
   * @param {object} logger
   * @param {import('./extractor').ContentExtractor} extractor
   */
  constructor(config, db, rewriter, publisher, logger, extractor) {
    this.config = config;
    this.db = db;
    this.rewriter = rewriter;
    this.publisher = publisher;
    this.logger = logger;
    this.extractor = extractor || null;

    // Publish history for rate limiting
    this.publishHistory = [];

    // Timer handle for the processing loop
    this._intervalHandle = null;

    // Flag to prevent concurrent processQueue executions
    this._processing = false;

    // Module independence
    this.enabled = true;
    this.status = 'connected';
    this.error = null;

    // Prepared statements (lazy init)
    this._stmts = {};
  }

  async init() {
    this.enabled = true;
    this.status = 'connected';

    // ─── STARTUP RECOVERY: Recover orphaned drafts and clusters ─────────
    this._recoverOrphanedWork();
  }

  /**
   * On startup, find clusters stuck in 'queued' that have drafts stuck in
   * transient states. Reset them so the scheduler picks them back up.
   */
  _recoverOrphanedWork() {
    try {
      // Find auto-mode drafts stuck in transient states from a previous crash
      var stuckDrafts = this.db.prepare(
        "SELECT id, status, cluster_id FROM drafts WHERE mode = 'auto' AND status IN ('fetching', 'rewriting') AND updated_at < datetime('now', '-5 minutes')"
      ).all();

      if (stuckDrafts.length > 0) {
        this.logger.info('scheduler', 'Recovering ' + stuckDrafts.length + ' stuck auto-drafts from previous session');

        var resetStmt = this.db.prepare(
          "UPDATE drafts SET status = 'fetching', extraction_status = 'pending', error_message = 'Recovered from stuck state (server restarted)', retry_count = COALESCE(retry_count, 0), updated_at = datetime('now') WHERE id = ?"
        );

        for (var i = 0; i < stuckDrafts.length; i++) {
          resetStmt.run(stuckDrafts[i].id);
          this.logger.debug('scheduler', 'Reset stuck draft #' + stuckDrafts[i].id + ' (was: ' + stuckDrafts[i].status + ')');
        }
      }

      // Find clusters in 'queued' that have NO drafts at all
      var orphanedClusters = this.db.prepare(
        "SELECT c.id FROM clusters c WHERE c.status = 'queued' AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.cluster_id = c.id)"
      ).all();

      if (orphanedClusters.length > 0) {
        this.logger.warn('scheduler', orphanedClusters.length + ' clusters in queued with no drafts — resetting to detected');
        var resetCluster = this.db.prepare("UPDATE clusters SET status = 'detected' WHERE id = ?");
        for (var j = 0; j < orphanedClusters.length; j++) {
          resetCluster.run(orphanedClusters[j].id);
        }
      }
    } catch (err) {
      this.logger.error('scheduler', 'Startup recovery failed: ' + err.message);
    }
  }

  getHealth() {
    var qs = this.getQueueStatus();
    return {
      module: 'scheduler',
      enabled: true,
      ready: true,
      status: 'connected',
      error: null,
      lastActivity: null,
      stats: {
        pendingDrafts: qs.pendingDrafts,
        publishedThisHour: qs.publishedThisHour,
      },
    };
  }

  async shutdown() {
    this.stop();
    this.enabled = false;
    this.status = 'disabled';
  }

  /**
   * Enqueue a cluster by creating drafts in the database.
   * Called from index.js when auto-detected clusters pass shouldPublish threshold.
   */
  enqueue(cluster) {
    try {
      if (!cluster || !cluster.id) return;

      // Check if drafts already exist for this cluster
      var existing = this.db.prepare(
        'SELECT COUNT(*) as count FROM drafts WHERE cluster_id = ?'
      ).get(cluster.id);

      if (existing && existing.count > 0) {
        this.logger.debug('scheduler', 'Cluster ' + cluster.id + ' already has drafts, skipping enqueue');
        return;
      }

      // Load articles
      var articles = this.db.prepare(
        'SELECT * FROM articles WHERE cluster_id = ? ORDER BY authority_tier ASC, received_at ASC'
      ).all(cluster.id);

      if (articles.length === 0) {
        this.logger.warn('scheduler', 'Cluster ' + cluster.id + ' has no articles to enqueue');
        return;
      }

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
          var isPrimary = i === 0;
          insertDraft.run(
            a.id, a.url, a.domain, a.title,
            a.content_markdown || '', 'wordpress',
            'fetching', 'auto',
            cluster.id, isPrimary ? 'primary' : 'source', 'pending'
          );
        }
        self.db.prepare("UPDATE clusters SET status = 'queued' WHERE id = ?").run(cluster.id);
      });

      createDrafts();
      this.logger.info('scheduler', 'Auto-enqueued cluster ' + cluster.id + ' -> ' + articles.length + ' drafts created');
    } catch (err) {
      this.logger.error('scheduler', 'Failed to auto-enqueue cluster ' + (cluster ? cluster.id : '?') + ': ' + err.message);
    }
  }

  /**
   * Process the next cluster-group of drafts.
   *
   * Pipeline per cluster:
   *   1. Find a cluster with auto-drafts in 'fetching' state
   *   2. Extract content for ALL drafts in that cluster
   *   3. Rewrite the PRIMARY draft using all source content
   *   4. Publish the PRIMARY draft to WordPress
   *   5. Update all draft statuses and the cluster status
   */
  async processQueue() {
    if (this._processing) return;
    this._processing = true;

    try {
      this.logger.debug('scheduler', 'processQueue tick: processing=' + this._processing + ', publishHistory=' + this.publishHistory.length);

      // ─── Step 1: Find the next cluster to process ───────────────────────
      // Include 'ready' status — drafts already extracted+rewritten, just waiting for rate limit
      var nextCluster = this.db.prepare(
        "SELECT DISTINCT d.cluster_id, c.topic, c.trends_boosted, c.priority " +
        "FROM drafts d " +
        "JOIN clusters c ON d.cluster_id = c.id " +
        "WHERE d.mode = 'auto' " +
        "  AND d.cluster_id IS NOT NULL " +
        "  AND d.status IN ('fetching', 'draft', 'ready') " +
        "  AND c.status = 'queued' " +
        "ORDER BY " +
        "  CASE WHEN d.status = 'ready' THEN 0 ELSE 1 END, " +
        "  CASE WHEN c.trends_boosted = 1 THEN 0 ELSE 1 END, " +
        "  c.article_count DESC, " +
        "  c.detected_at ASC " +
        "LIMIT 1"
      ).get();

      if (!nextCluster || !nextCluster.cluster_id) {
        // Log why nothing was found if there are pending drafts
        var pendingCount = this.db.prepare(
          "SELECT COUNT(*) as count FROM drafts WHERE mode = 'auto' AND status IN ('fetching', 'draft', 'ready')"
        ).get();
        if (pendingCount && pendingCount.count > 0) {
          this.logger.debug('scheduler', 'No processable clusters found, but ' + pendingCount.count + ' auto-drafts exist — check cluster statuses');
        }
        return;
      }

      var clusterId = nextCluster.cluster_id;
      this.logger.info('scheduler', 'Processing cluster #' + clusterId + ': "' + (nextCluster.topic || '').substring(0, 60) + '"');

      // Load ALL drafts for this cluster
      var clusterDrafts = this.db.prepare(
        "SELECT * FROM drafts WHERE cluster_id = ? ORDER BY cluster_role ASC"
      ).all(clusterId);

      if (clusterDrafts.length === 0) {
        this.logger.warn('scheduler', 'Cluster #' + clusterId + ' has no drafts — marking as failed');
        this.db.prepare("UPDATE clusters SET status = 'failed' WHERE id = ?").run(clusterId);
        return;
      }

      // Identify primary and source drafts
      var primaryDraft = null;
      var sourceDrafts = [];

      for (var i = 0; i < clusterDrafts.length; i++) {
        if (clusterDrafts[i].cluster_role === 'primary') {
          primaryDraft = clusterDrafts[i];
        } else {
          sourceDrafts.push(clusterDrafts[i]);
        }
      }

      // If no primary was set, use the first draft
      if (!primaryDraft) {
        primaryDraft = clusterDrafts[0];
        this.db.prepare("UPDATE drafts SET cluster_role = 'primary' WHERE id = ?").run(primaryDraft.id);
        sourceDrafts = clusterDrafts.slice(1);
      }

      // ─── Fast path: Primary already ready (extracted + rewritten), skip to publish ─
      if (primaryDraft.status === 'ready' && primaryDraft.rewritten_html) {
        this.logger.info('scheduler', 'Primary draft #' + primaryDraft.id + ' already ready — skipping to publish');

        if (!this.canPublishNow()) {
          this.logger.info('scheduler', 'Cluster #' + clusterId + ' ready but rate limited — will publish next cycle');
          return;
        }

        var savedRewrite = {
          title: primaryDraft.rewritten_title || primaryDraft.source_title,
          content: primaryDraft.rewritten_html,
          slug: (primaryDraft.rewritten_title || primaryDraft.source_title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 60),
          excerpt: primaryDraft.extracted_excerpt || '',
          metaDescription: '',
          targetKeyword: primaryDraft.target_keyword || '',
          wordCount: primaryDraft.rewritten_word_count || 0,
          aiModel: primaryDraft.ai_model_used || '',
          schemaTypes: primaryDraft.schema_types || 'NewsArticle,FAQPage,BreadcrumbList',
          targetDomain: primaryDraft.target_domain || '',
          featuredImage: primaryDraft.featured_image || null,
          faq: [],
        };

        if (!savedRewrite.featuredImage) {
          for (var fi2 = 0; fi2 < clusterDrafts.length; fi2++) {
            if (clusterDrafts[fi2].featured_image) {
              savedRewrite.featuredImage = clusterDrafts[fi2].featured_image;
              break;
            }
          }
        }

        var clusterForPublish = {
          id: clusterId,
          topic: nextCluster.topic,
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
          var pubResult = await this.publisher.publish(savedRewrite, clusterForPublish, this.db);
          this.publishHistory.push(Date.now());

          this.db.prepare(
            "UPDATE drafts SET status = 'published', wp_post_id = ?, wp_post_url = ?, published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
          ).run(pubResult.wpPostId, pubResult.wpPostUrl, primaryDraft.id);

          this.db.prepare(
            "UPDATE drafts SET status = 'published', wp_post_id = ?, wp_post_url = ?, published_at = datetime('now'), updated_at = datetime('now') WHERE cluster_id = ? AND id != ?"
          ).run(pubResult.wpPostId, pubResult.wpPostUrl, clusterId, primaryDraft.id);

          this.db.prepare("UPDATE clusters SET status = 'published', published_at = datetime('now') WHERE id = ?").run(clusterId);
          this.logger.info('scheduler', 'Cluster #' + clusterId + ' published (from ready state) → WP post #' + pubResult.wpPostId);
        } catch (pubErr) {
          this.logger.error('scheduler', 'WP publish failed for ready cluster #' + clusterId + ': ' + pubErr.message);
          var retryCount2 = (primaryDraft.retry_count || 0) + 1;
          this.db.prepare(
            "UPDATE drafts SET error_message = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
          ).run('WP publish failed: ' + pubErr.message, retryCount2, primaryDraft.id);

          if (retryCount2 >= 3) {
            this.db.prepare("UPDATE drafts SET status = 'failed' WHERE id = ?").run(primaryDraft.id);
            this.db.prepare("UPDATE clusters SET status = 'failed' WHERE id = ?").run(clusterId);
          }
        }
        return;
      }

      // ─── Step 2: Extract content for ALL drafts that need it ────────────
      var draftsToExtract = clusterDrafts.filter(function (d) {
        return d.extraction_status !== 'success' && d.extraction_status !== 'cached';
      });

      if (draftsToExtract.length > 0) {
        this.logger.info('scheduler', 'Extracting content for ' + draftsToExtract.length + '/' + clusterDrafts.length + ' drafts');

        for (var e = 0; e < draftsToExtract.length; e++) {
          var draft = draftsToExtract[e];
          try {
            this.db.prepare("UPDATE drafts SET status = 'fetching', updated_at = datetime('now') WHERE id = ?").run(draft.id);

            if (this.extractor && this.extractor.enabled) {
              var articleObj = {
                id: draft.source_article_id || draft.id,
                url: draft.source_url,
                domain: draft.source_domain,
                title: draft.source_title,
                content_markdown: draft.source_content_markdown,
              };

              await this.extractor._extractArticle(articleObj);

              this.db.prepare(
                "UPDATE drafts SET " +
                "  extracted_content = ?, extracted_title = ?, extracted_excerpt = ?," +
                "  extracted_byline = ?, extraction_status = ?, extraction_error = NULL," +
                "  status = 'draft', updated_at = datetime('now') " +
                "WHERE id = ?"
              ).run(
                articleObj.extracted_content || articleObj.content_markdown || '',
                articleObj.extracted_title || draft.source_title || '',
                articleObj.extracted_excerpt || '',
                articleObj.extracted_byline || '',
                articleObj.extraction_status || 'success',
                draft.id
              );

              this.logger.info('scheduler', 'Extracted content for draft #' + draft.id + ' (' + (articleObj.extracted_content || '').length + ' chars)');
            } else {
              // No extractor — use Firehose content as-is
              this.db.prepare(
                "UPDATE drafts SET extracted_content = source_content_markdown, extraction_status = 'firehose', status = 'draft', updated_at = datetime('now') WHERE id = ?"
              ).run(draft.id);
            }
          } catch (extractErr) {
            this.logger.warn('scheduler', 'Extraction failed for draft #' + draft.id + ': ' + extractErr.message);
            this.db.prepare(
              "UPDATE drafts SET extraction_status = 'failed', extraction_error = ?, error_message = ?, status = 'draft', updated_at = datetime('now') WHERE id = ?"
            ).run(extractErr.message, extractErr.message, draft.id);
            // Continue — we can still rewrite with partial content
          }
        }
      }

      // ─── Step 3: Rewrite the PRIMARY draft using ALL sources ────────────
      this.logger.info('scheduler', 'Rewriting primary draft #' + primaryDraft.id + ' using ' + clusterDrafts.length + ' sources');

      this.db.prepare("UPDATE drafts SET status = 'rewriting', updated_at = datetime('now') WHERE id = ?").run(primaryDraft.id);

      // Reload all drafts to get fresh extracted content
      var freshDrafts = this.db.prepare(
        "SELECT * FROM drafts WHERE cluster_id = ? ORDER BY cluster_role ASC"
      ).all(clusterId);

      // Build cluster-like object that the rewriter expects
      var clusterForRewrite = {
        id: clusterId,
        topic: nextCluster.topic,
        trends_boosted: nextCluster.trends_boosted,
        trends_topic: nextCluster.topic,
        articles: freshDrafts.map(function (d) {
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

      // Reload fresh primary
      var freshPrimary = this.db.prepare('SELECT * FROM drafts WHERE id = ?').get(primaryDraft.id);
      var primaryArticle = {
        id: freshPrimary.source_article_id || freshPrimary.id,
        url: freshPrimary.source_url,
        domain: freshPrimary.source_domain,
        title: freshPrimary.extracted_title || freshPrimary.source_title,
        content_markdown: freshPrimary.extracted_content || freshPrimary.source_content_markdown || '',
        extracted_content: freshPrimary.extracted_content || '',
        extracted_title: freshPrimary.extracted_title || freshPrimary.source_title || '',
        extracted_byline: freshPrimary.extracted_byline || '',
      };

      var rewrittenArticle;
      try {
        rewrittenArticle = await this.rewriter.rewrite(primaryArticle, clusterForRewrite);
      } catch (rewriteErr) {
        this.logger.error('scheduler', 'Rewrite failed for cluster #' + clusterId + ': ' + rewriteErr.message);

        var retryCount = (freshPrimary.retry_count || 0) + 1;
        var maxRetries = freshPrimary.max_retries || 3;

        if (retryCount >= maxRetries) {
          this.db.prepare(
            "UPDATE drafts SET status = 'failed', error_message = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
          ).run('Rewrite failed: ' + rewriteErr.message, retryCount, primaryDraft.id);
          this.db.prepare("UPDATE clusters SET status = 'failed' WHERE id = ?").run(clusterId);
        } else {
          this.db.prepare(
            "UPDATE drafts SET status = 'draft', error_message = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
          ).run('Rewrite failed (retry ' + retryCount + '/' + maxRetries + '): ' + rewriteErr.message, retryCount, primaryDraft.id);
        }
        return;
      }

      // Save rewritten content to PRIMARY draft
      this.db.prepare(
        "UPDATE drafts SET " +
        "  rewritten_html = ?, rewritten_title = ?, rewritten_word_count = ?," +
        "  ai_model_used = ?, target_keyword = ?," +
        "  status = 'ready', error_message = NULL, updated_at = datetime('now') " +
        "WHERE id = ?"
      ).run(
        rewrittenArticle.content || '',
        rewrittenArticle.title || '',
        rewrittenArticle.wordCount || 0,
        rewrittenArticle.aiModel || '',
        rewrittenArticle.targetKeyword || '',
        primaryDraft.id
      );

      // Attach SEO properties that the publisher needs but rewriter doesn't set
      rewrittenArticle.schemaTypes = freshPrimary.schema_types || 'NewsArticle,FAQPage,BreadcrumbList';
      rewrittenArticle.targetDomain = freshPrimary.target_domain || '';

      // Try to find a featured image from cluster articles
      if (!rewrittenArticle.featuredImage) {
        for (var fi = 0; fi < freshDrafts.length; fi++) {
          if (freshDrafts[fi].featured_image) {
            rewrittenArticle.featuredImage = freshDrafts[fi].featured_image;
            break;
          }
        }
      }

      this.logger.info('scheduler', 'Rewrite complete for primary draft #' + primaryDraft.id + ': "' + (rewrittenArticle.title || '').substring(0, 60) + '"');

      // ─── Step 4: Publish to WordPress (rate-limited) ────────────────────
      if (!this.canPublishNow()) {
        this.logger.info('scheduler', 'Cluster #' + clusterId + ' is READY but rate limit active — will publish on next cycle');
        return;
      }

      try {
        var publishResult = await this.publisher.publish(rewrittenArticle, clusterForRewrite, this.db);

        // Record publish timestamp for rate limiting
        this.publishHistory.push(Date.now());

        // Update PRIMARY draft with WP details
        this.db.prepare(
          "UPDATE drafts SET " +
          "  status = 'published', wp_post_id = ?, wp_post_url = ?," +
          "  published_at = datetime('now'), updated_at = datetime('now') " +
          "WHERE id = ?"
        ).run(publishResult.wpPostId, publishResult.wpPostUrl, primaryDraft.id);

        // Update SOURCE drafts to 'published' too
        this.db.prepare(
          "UPDATE drafts SET status = 'published', wp_post_id = ?, wp_post_url = ?, published_at = datetime('now'), updated_at = datetime('now') WHERE cluster_id = ? AND id != ?"
        ).run(publishResult.wpPostId, publishResult.wpPostUrl, clusterId, primaryDraft.id);

        // Update cluster status
        this.db.prepare(
          "UPDATE clusters SET status = 'published', published_at = datetime('now') WHERE id = ?"
        ).run(clusterId);

        this.logger.info('scheduler', 'Cluster #' + clusterId + ' published -> WP post #' + publishResult.wpPostId + ' ' + publishResult.wpPostUrl);
      } catch (publishErr) {
        this.logger.error('scheduler', 'WordPress publish failed for cluster #' + clusterId + ': ' + publishErr.message);

        // Re-read retry_count fresh from DB (may have been incremented by rewrite phase)
        var latestPrimary = this.db.prepare('SELECT retry_count FROM drafts WHERE id = ?').get(primaryDraft.id);
        var pubRetry = ((latestPrimary ? latestPrimary.retry_count : 0) || 0) + 1;
        if (pubRetry >= 3) {
          this.db.prepare(
            "UPDATE drafts SET status = 'failed', error_message = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
          ).run('WP publish failed: ' + publishErr.message, pubRetry, primaryDraft.id);
          this.db.prepare("UPDATE clusters SET status = 'failed' WHERE id = ?").run(clusterId);
        } else {
          this.db.prepare(
            "UPDATE drafts SET error_message = ?, retry_count = ?, updated_at = datetime('now') WHERE id = ?"
          ).run('WP publish failed (retry ' + pubRetry + '/3): ' + publishErr.message, pubRetry, primaryDraft.id);
        }
      }
    } catch (err) {
      this.logger.error('scheduler', 'Unexpected error in processQueue: ' + err.message);
    } finally {
      this._processing = false;
    }
  }

  /**
   * Rate limit check.
   */
  canPublishNow() {
    try {
      var now = Date.now();
      var oneHourAgo = now - 60 * 60 * 1000;

      // Parse config with safe defaults — parseInt handles undefined/NaN/0
      var maxPerHour = parseInt(this.config.MAX_PUBLISH_PER_HOUR, 10);
      if (isNaN(maxPerHour) || maxPerHour <= 0) maxPerHour = 4;

      var cooldownMinutes = parseInt(this.config.PUBLISH_COOLDOWN_MINUTES, 10);
      if (isNaN(cooldownMinutes) || cooldownMinutes < 0) cooldownMinutes = 10;
      var cooldownMs = cooldownMinutes * 60 * 1000;

      // Prune old entries from publish history
      this.publishHistory = this.publishHistory.filter(function (ts) { return ts > oneHourAgo; });

      // Check hourly limit
      if (this.publishHistory.length >= maxPerHour) {
        this.logger.debug('scheduler', 'Rate limit: ' + this.publishHistory.length + '/' + maxPerHour + ' published this hour');
        return false;
      }

      // Check cooldown since last publish
      if (this.publishHistory.length > 0 && cooldownMs > 0) {
        var lastPublish = Math.max.apply(null, this.publishHistory);
        var elapsed = now - lastPublish;
        if (elapsed < cooldownMs) {
          this.logger.debug('scheduler', 'Rate limit: cooldown ' + Math.round((cooldownMs - elapsed) / 1000) + 's remaining');
          return false;
        }
      }

      return true;
    } catch (err) {
      // Error should NOT block publishing — log and allow it
      this.logger.error('scheduler', 'canPublishNow() error (allowing publish): ' + err.message);
      return true;
    }
  }

  start() {
    if (this._intervalHandle) {
      this.logger.warn('scheduler', 'Scheduler already running');
      return;
    }

    var self = this;
    this.logger.info('scheduler', 'Starting publish scheduler (interval=' + PROCESS_INTERVAL_MS + 'ms, max=' + this.config.MAX_PUBLISH_PER_HOUR + '/hr)');

    this._intervalHandle = setInterval(function () {
      self.processQueue().catch(function (err) {
        self.logger.error('scheduler', 'Unhandled error in scheduler loop: ' + err.message);
      });
    }, PROCESS_INTERVAL_MS);
  }

  stop() {
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
      this.logger.info('scheduler', 'Publish scheduler stopped');
    }
  }

  getQueueStatus() {
    try {
      var now = Date.now();
      var oneHourAgo = now - 60 * 60 * 1000;
      var maxPerHour = this.config.MAX_PUBLISH_PER_HOUR || 4;
      var cooldownMs = (this.config.PUBLISH_COOLDOWN_MINUTES || 10) * 60 * 1000;

      this.publishHistory = this.publishHistory.filter(function (ts) { return ts > oneHourAgo; });

      var publishedThisHour = this.publishHistory.length;
      var rateLimitHit = publishedThisHour >= maxPerHour;

      // Count pending auto-drafts (primary only — that's the actual queue)
      var pendingRow = this.db.prepare(
        "SELECT COUNT(*) as count FROM drafts WHERE mode = 'auto' AND cluster_role = 'primary' AND status IN ('fetching', 'draft', 'rewriting', 'ready')"
      ).get();
      var pendingDrafts = pendingRow ? pendingRow.count : 0;

      var nextPublishIn = 0;
      if (rateLimitHit && this.publishHistory.length > 0) {
        var earliest = Math.min.apply(null, this.publishHistory);
        nextPublishIn = Math.max(0, (earliest + 60 * 60 * 1000) - now);
      } else if (this.publishHistory.length > 0) {
        var lastPublish = Math.max.apply(null, this.publishHistory);
        var cooldownRemaining = (lastPublish + cooldownMs) - now;
        nextPublishIn = Math.max(0, cooldownRemaining);
      }

      return {
        queueLength: pendingDrafts,
        pendingDrafts: pendingDrafts,
        nextPublishIn: Math.ceil(nextPublishIn / 1000),
        publishedThisHour: publishedThisHour,
        rateLimitHit: rateLimitHit,
      };
    } catch (err) {
      this.logger.error('scheduler', 'Error getting queue status: ' + err.message);
      return { queueLength: 0, pendingDrafts: 0, nextPublishIn: 0, publishedThisHour: 0, rateLimitHit: false };
    }
  }
}

module.exports = { PublishScheduler };
