'use strict';

// Queue processing interval (30 seconds)
const PROCESS_INTERVAL_MS = 30000;

class PublishScheduler {
  /**
   * @param {object} config    - App config from getConfig()
   * @param {object} db        - better-sqlite3 Database instance
   * @param {import('./rewriter').ArticleRewriter} rewriter
   * @param {import('./publisher').WordPressPublisher} publisher
   * @param {object} logger    - Winston logger instance
   */
  constructor(config, db, rewriter, publisher, logger, extractor) {
    this.config = config;
    this.db = db;
    this.rewriter = rewriter;
    this.publisher = publisher;
    this.logger = logger;
    this.extractor = extractor || null;

    // In-memory priority queue
    this.queue = [];

    // Publish history for rate limiting (timestamps of publishes within the last hour)
    this.publishHistory = [];

    // Timer handle for the processing loop
    this._intervalHandle = null;

    // Flag to prevent concurrent processQueue executions
    this._processing = false;

    // Module independence
    this.enabled = true;
    this.status = 'connected';
    this.error = null;
  }

  async init() {
    this.enabled = true;
    this.status = 'connected';
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
        queueSize: qs.queueLength,
        publishedThisHour: qs.publishedThisHour,
      }
    };
  }

  async shutdown() {
    this.stop();
    this.enabled = false;
    this.status = 'disabled';
  }

  /**
   * Add a cluster to the publish queue with priority sorting.
   *
   * Priority order:
   * 1. Trends-boosted clusters first (priority = 'high')
   * 2. Same priority: higher article_count first
   * 3. Same count: earlier detected_at first (FIFO)
   *
   * @param {object} cluster - The cluster object to enqueue
   */
  enqueue(cluster) {
    try {
      const item = {
        cluster,
        priority: cluster.trends_boosted ? 'high' : 'normal',
        articleCount: cluster.article_count || (cluster.articles ? cluster.articles.length : 1),
        detectedAt: cluster.detected_at || new Date().toISOString(),
        enqueuedAt: new Date().toISOString(),
        retries: 0,
      };

      this.queue.push(item);
      this._sortQueue();

      this.logger.info('Cluster enqueued for publishing', {
        clusterId: cluster.id,
        priority: item.priority,
        articleCount: item.articleCount,
        queueLength: this.queue.length,
      });
    } catch (err) {
      this.logger.error('Failed to enqueue cluster', {
        error: err.message,
        clusterId: cluster.id,
      });
    }
  }

  /**
   * Sort the queue by priority rules.
   */
  _sortQueue() {
    this.queue.sort((a, b) => {
      // High priority first
      if (a.priority === 'high' && b.priority !== 'high') return -1;
      if (a.priority !== 'high' && b.priority === 'high') return 1;

      // Same priority: higher article count first
      if (a.articleCount !== b.articleCount) return b.articleCount - a.articleCount;

      // Same count: earlier detected_at first (FIFO)
      return new Date(a.detectedAt).getTime() - new Date(b.detectedAt).getTime();
    });
  }

  /**
   * Process the next item in the queue if rate limits allow.
   * Called every 30 seconds by the processing loop.
   */
  async processQueue() {
    // Guard against concurrent execution
    if (this._processing) return;
    this._processing = true;

    try {
      // Nothing to process
      if (this.queue.length === 0) return;

      // Check rate limits
      if (!this.canPublishNow()) {
        this.logger.debug('Rate limit active — skipping queue processing', {
          queueLength: this.queue.length,
          publishedThisHour: this._getPublishedThisHour(),
        });
        return;
      }

      // Dequeue the highest-priority item
      const item = this.queue.shift();
      const cluster = item.cluster;

      this.logger.info('Processing cluster from queue', {
        clusterId: cluster.id,
        priority: item.priority,
        retries: item.retries,
      });

      // Step 1: Load full article data for the cluster
      let clusterWithArticles;
      try {
        var articles = this.db.prepare(
          'SELECT * FROM articles WHERE cluster_id = ? ORDER BY authority_tier ASC, received_at ASC'
        ).all(cluster.id);

        clusterWithArticles = Object.assign({}, cluster, { articles: articles });
      } catch (loadErr) {
        this.logger.error('Failed to load cluster articles', {
          error: loadErr.message,
          clusterId: cluster.id,
        });
        this._updateClusterStatus(cluster.id, 'failed');
        return;
      }

      // Step 2: Extract full content from source URLs
      try {
        if (this.extractor && this.extractor.enabled) {
          clusterWithArticles = await this.extractor.extractClusterContent(clusterWithArticles);
        }
      } catch (extractErr) {
        this.logger.warn('Content extraction failed — proceeding with available content', {
          error: extractErr.message,
          clusterId: cluster.id,
        });
      }

      // Step 3: Rewrite the article using extracted content
      let rewrittenArticle;
      try {
        const primaryArticle = (clusterWithArticles.articles && clusterWithArticles.articles[0]) || cluster;
        rewrittenArticle = await this.rewriter.rewrite(primaryArticle, clusterWithArticles);
      } catch (rewriteErr) {
        this.logger.error('Rewrite failed for cluster — will retry next cycle', {
          error: rewriteErr.message,
          clusterId: cluster.id,
          retries: item.retries,
        });

        if (item.retries < 3) {
          item.retries++;
          this.queue.push(item);
          this._sortQueue();
        } else {
          this.logger.error('Cluster exceeded max retries — dropping from queue', {
            clusterId: cluster.id,
          });
          this._updateClusterStatus(cluster.id, 'failed');
        }
        return;
      }

      // Step 2: Publish to WordPress
      try {
        const publishResult = await this.publisher.publish(rewrittenArticle, cluster, this.db);

        // Record the publish timestamp for rate limiting
        this.publishHistory.push(Date.now());

        // Update cluster status in DB
        this._updateClusterStatus(cluster.id, 'published');

        this.logger.info('Cluster published successfully', {
          clusterId: cluster.id,
          wpPostId: publishResult.wpPostId,
          wpPostUrl: publishResult.wpPostUrl,
        });
      } catch (publishErr) {
        this.logger.error('WordPress publish failed — re-queuing cluster', {
          error: publishErr.message,
          clusterId: cluster.id,
          retries: item.retries,
        });

        // Keep in queue for retry
        if (item.retries < 3) {
          item.retries++;
          // Store the already-rewritten article so we don't re-call the AI
          item.rewrittenArticle = rewrittenArticle;
          this.queue.push(item);
          this._sortQueue();
        } else {
          this.logger.error('Cluster exceeded max retries for publishing — dropping', {
            clusterId: cluster.id,
          });
          this._updateClusterStatus(cluster.id, 'failed');
        }
      }
    } catch (err) {
      this.logger.error('Unexpected error in processQueue', { error: err.message });
    } finally {
      this._processing = false;
    }
  }

  /**
   * Check whether we are allowed to publish right now based on rate limits.
   *
   * Rules:
   * - Published fewer than MAX_PUBLISH_PER_HOUR articles in the last 60 minutes
   * - Last publish was more than PUBLISH_COOLDOWN_MINUTES ago
   *
   * @returns {boolean}
   */
  canPublishNow() {
    try {
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;
      const maxPerHour = this.config.MAX_PUBLISH_PER_HOUR || 4;
      const cooldownMs = (this.config.PUBLISH_COOLDOWN_MINUTES || 10) * 60 * 1000;

      // Prune old entries from publish history
      this.publishHistory = this.publishHistory.filter((ts) => ts > oneHourAgo);

      // Check hourly limit
      if (this.publishHistory.length >= maxPerHour) {
        return false;
      }

      // Check cooldown since last publish
      if (this.publishHistory.length > 0) {
        const lastPublish = Math.max(...this.publishHistory);
        if (now - lastPublish < cooldownMs) {
          return false;
        }
      }

      return true;
    } catch (err) {
      this.logger.error('Error checking publish rate limit', { error: err.message });
      return false;
    }
  }

  /**
   * Start the 30-second processing loop.
   */
  start() {
    if (this._intervalHandle) {
      this.logger.warn('Scheduler already running');
      return;
    }

    this.logger.info('Starting publish scheduler', {
      intervalMs: PROCESS_INTERVAL_MS,
      maxPerHour: this.config.MAX_PUBLISH_PER_HOUR,
      cooldownMinutes: this.config.PUBLISH_COOLDOWN_MINUTES,
    });

    this._intervalHandle = setInterval(() => {
      this.processQueue().catch((err) => {
        this.logger.error('Unhandled error in scheduler loop', { error: err.message });
      });
    }, PROCESS_INTERVAL_MS);
  }

  /**
   * Stop the processing loop.
   */
  stop() {
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
      this.logger.info('Publish scheduler stopped');
    }
  }

  /**
   * Get the current queue and rate-limit status.
   *
   * @returns {object}
   */
  getQueueStatus() {
    try {
      const now = Date.now();
      const oneHourAgo = now - 60 * 60 * 1000;
      const maxPerHour = this.config.MAX_PUBLISH_PER_HOUR || 4;
      const cooldownMs = (this.config.PUBLISH_COOLDOWN_MINUTES || 10) * 60 * 1000;

      // Prune old entries
      this.publishHistory = this.publishHistory.filter((ts) => ts > oneHourAgo);

      const publishedThisHour = this.publishHistory.length;
      const rateLimitHit = publishedThisHour >= maxPerHour;

      // Calculate when the next publish is allowed
      let nextPublishIn = 0;
      if (rateLimitHit) {
        // Earliest entry will expire, opening a slot
        const earliest = Math.min(...this.publishHistory);
        nextPublishIn = Math.max(0, (earliest + 60 * 60 * 1000) - now);
      } else if (this.publishHistory.length > 0) {
        // Cooldown from last publish
        const lastPublish = Math.max(...this.publishHistory);
        const cooldownRemaining = (lastPublish + cooldownMs) - now;
        nextPublishIn = Math.max(0, cooldownRemaining);
      }

      return {
        queueLength: this.queue.length,
        nextPublishIn: Math.ceil(nextPublishIn / 1000), // seconds
        publishedThisHour,
        rateLimitHit,
      };
    } catch (err) {
      this.logger.error('Error getting queue status', { error: err.message });
      return {
        queueLength: this.queue.length,
        nextPublishIn: 0,
        publishedThisHour: 0,
        rateLimitHit: false,
      };
    }
  }

  /**
   * Get the count of articles published in the last hour.
   *
   * @returns {number}
   */
  _getPublishedThisHour() {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    this.publishHistory = this.publishHistory.filter((ts) => ts > oneHourAgo);
    return this.publishHistory.length;
  }

  /**
   * Update a cluster's status in the database.
   *
   * @param {number|string} clusterId
   * @param {string} status - 'published' | 'failed'
   */
  _updateClusterStatus(clusterId, status) {
    if (!clusterId) return;

    try {
      this.db.prepare('UPDATE clusters SET status = ?, updated_at = ? WHERE id = ?').run(
        status,
        new Date().toISOString(),
        clusterId
      );
    } catch (err) {
      this.logger.error('Failed to update cluster status', {
        error: err.message,
        clusterId,
        status,
      });
    }
  }
}

module.exports = { PublishScheduler };
