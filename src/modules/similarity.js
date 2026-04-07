'use strict';

const natural = require('natural');
const TfIdf = natural.TfIdf;

const MODULE = 'similarity';

class SimilarityEngine {
  /**
   * @param {object} config - Frozen config object
   * @param {import('better-sqlite3').Database} db
   * @param {object} logger
   */
  constructor(config, db, logger) {
    this.config = config;
    this.db = db;
    this.logger = logger;

    // Module independence
    this.enabled = true;
    this.status = 'connected';
    this.error = null;

    // Prepared statements (lazy init)
    this._stmts = {};

    // Worker thread for CPU-intensive TF-IDF work
    this._worker = null;
    this._workerReady = false;
    this._pendingJobs = new Map();
    this._jobCounter = 0;
    this._WORKER_TIMEOUT_MS = 15000;
  }

  async init() {
    this.enabled = true;
    this.status = 'connected';
    this._initWorker();
  }

  _initWorker() {
    try {
      var WorkerClass = require('worker_threads').Worker;
      var path = require('path');

      this._worker = new WorkerClass(path.resolve(__dirname, '..', 'workers', 'similarity-worker.js'));
      this._workerReady = true;

      var self = this;

      this._worker.on('message', function(msg) {
        var job = self._pendingJobs.get(msg.id);
        if (!job) return;
        clearTimeout(job.timer);
        self._pendingJobs.delete(msg.id);
        if (msg.type === 'error') {
          job.reject(new Error(msg.payload.message));
        } else {
          job.resolve(msg.payload);
        }
      });

      this._worker.on('error', function(err) {
        self.logger.error(MODULE, 'Similarity worker error: ' + err.message);
        self._workerReady = false;
        for (var entry of self._pendingJobs) {
          clearTimeout(entry[1].timer);
          entry[1].reject(err);
        }
        self._pendingJobs.clear();
        setTimeout(function() { self._initWorker(); }, 5000);
      });

      this._worker.on('exit', function(code) {
        self._workerReady = false;
        if (code !== 0) {
          self.logger.warn(MODULE, 'Similarity worker exited with code ' + code + ', restarting...');
          setTimeout(function() { self._initWorker(); }, 5000);
        }
      });

      this.logger.info(MODULE, 'Similarity worker thread started');
    } catch (err) {
      this.logger.warn(MODULE, 'Worker threads not available, using main thread: ' + err.message);
      this._workerReady = false;
    }
  }

  _sendToWorker(payload) {
    var self = this;
    var id = ++this._jobCounter;
    return new Promise(function(resolve, reject) {
      var timer = setTimeout(function() {
        self._pendingJobs.delete(id);
        reject(new Error('Worker timeout after ' + self._WORKER_TIMEOUT_MS + 'ms'));
      }, self._WORKER_TIMEOUT_MS);
      self._pendingJobs.set(id, { resolve: resolve, reject: reject, timer: timer });
      self._worker.postMessage({ type: 'findMatches', id: id, payload: payload });
    });
  }

  getHealth() {
    return {
      module: 'similarity',
      enabled: true,
      ready: true,
      status: 'connected',
      error: null,
      lastActivity: null,
      stats: { workerReady: this._workerReady, pendingJobs: this._pendingJobs.size }
    };
  }

  async shutdown() {
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
      this._workerReady = false;
    }
  }

  /**
   * Find similar articles in the buffer for a new article.
   * Uses TF-IDF cosine similarity, filtering by threshold and requiring different domains.
   *
   * @param {object} newArticle - Must have fingerprint and domain
   * @param {Array} bufferArticles - Array of articles with fingerprint and domain
   * @returns {Array<{ article: object, score: number }>} Matches above threshold, different domain
   */
  findMatches(newArticle, bufferArticles) {
    try {
      if (!newArticle || !newArticle.fingerprint) {
        this.logger.debug(MODULE, 'No fingerprint on new article, cannot find matches');
        return [];
      }

      if (!bufferArticles || bufferArticles.length === 0) {
        return [];
      }

      const threshold = this.config.SIMILARITY_THRESHOLD || 0.20;
      const tfidf = new TfIdf();

      // Add all buffer article fingerprints to the corpus (index 0..N-1)
      for (const article of bufferArticles) {
        tfidf.addDocument(article.fingerprint || '');
      }

      // Add the new article fingerprint as the last document (index N)
      tfidf.addDocument(newArticle.fingerprint);

      const newDocIndex = bufferArticles.length;
      const matches = [];

      const allowSameDomain = this.config.ALLOW_SAME_DOMAIN_CLUSTERS === 'true' || this.config.ALLOW_SAME_DOMAIN_CLUSTERS === true;

      // Compute cosine similarity between new article and each buffer article
      for (let i = 0; i < bufferArticles.length; i++) {
        // Skip same article (by ID or URL)
        if (bufferArticles[i].id === newArticle.id) continue;
        if (bufferArticles[i].url === newArticle.url) continue;

        const isSameDomain = bufferArticles[i].domain === newArticle.domain;

        // Skip same-domain if not allowed
        if (isSameDomain && !allowSameDomain) continue;

        const score = this._cosineSimilarity(tfidf, newDocIndex, i);

        // Same-domain matches need higher threshold to avoid noise
        const effectiveThreshold = isSameDomain ? threshold * 1.5 : threshold;

        if (score > effectiveThreshold) {
          matches.push({
            article: bufferArticles[i],
            score: Math.round(score * 10000) / 10000,
          });
        }
      }

      // Sort by score descending
      matches.sort((a, b) => b.score - a.score);

      this.logger.debug(MODULE, `Found ${matches.length} matches for "${newArticle.title || newArticle.url}"`, {
        threshold,
        bufferSize: bufferArticles.length,
      });

      return matches;
    } catch (err) {
      this.logger.error(MODULE, 'Error finding matches', err.message);
      return [];
    }
  }

  /**
   * Async findMatches — delegates to worker thread, falls back to sync on main thread.
   */
  async findMatchesAsync(newArticle, bufferArticles) {
    if (this._workerReady && this._worker) {
      try {
        var result = await this._sendToWorker({
          newArticle: {
            id: newArticle.id,
            url: newArticle.url,
            domain: newArticle.domain,
            title: newArticle.title,
            fingerprint: newArticle.fingerprint,
          },
          bufferArticles: bufferArticles.map(function(a) {
            return {
              id: a.id, url: a.url, domain: a.domain, title: a.title,
              fingerprint: a.fingerprint, cluster_id: a.cluster_id,
              authority_tier: a.authority_tier,
            };
          }),
          threshold: this.config.SIMILARITY_THRESHOLD || 0.20,
          allowSameDomain: this.config.ALLOW_SAME_DOMAIN_CLUSTERS === 'true' || this.config.ALLOW_SAME_DOMAIN_CLUSTERS === true,
        });

        // Re-attach full article objects to matches
        var articleMap = {};
        for (var i = 0; i < bufferArticles.length; i++) {
          articleMap[bufferArticles[i].id] = bufferArticles[i];
        }
        var matches = [];
        for (var j = 0; j < result.matches.length; j++) {
          var m = result.matches[j];
          var fullArticle = articleMap[m.articleId];
          if (fullArticle) {
            matches.push({ article: fullArticle, score: m.score });
          }
        }
        return matches;
      } catch (err) {
        this.logger.warn(MODULE, 'Worker findMatches failed, falling back to sync: ' + err.message);
      }
    }
    // Fallback: run on main thread
    return this.findMatches(newArticle, bufferArticles);
  }

  /**
   * Create a new cluster or update an existing one based on matching articles.
   *
   * @param {object} newArticle - The newly received article (must have id)
   * @param {Array<{ article: object, score: number }>} matches - From findMatches()
   * @param {{ matched: boolean, trend: object|null, score: number }} trendsMatch - From TrendsPoller.matchArticle()
   * @returns {object|null} The cluster object, or null on failure
   */
  createOrUpdateCluster(newArticle, matches, trendsMatch) {
    try {
      // Check if any match is already in a cluster
      let existingClusterId = null;
      for (const match of matches) {
        if (match.article.cluster_id) {
          existingClusterId = match.article.cluster_id;
          break;
        }
      }

      const trendsBoosted = trendsMatch && trendsMatch.matched ? 1 : 0;
      const trendTopic = trendsMatch && trendsMatch.trend ? trendsMatch.trend.topic : null;
      const priority = trendsBoosted ? 'high' : 'normal';

      if (existingClusterId) {
        // Update existing cluster
        return this._updateExistingCluster(existingClusterId, newArticle, matches, trendsBoosted, trendTopic, priority);
      } else {
        // Create new cluster
        return this._createNewCluster(newArticle, matches, trendsBoosted, trendTopic, priority);
      }
    } catch (err) {
      this.logger.error(MODULE, 'Error creating/updating cluster', err.message);
      return null;
    }
  }

  /**
   * Get a cluster by ID.
   *
   * @param {number} clusterId
   * @returns {object|null}
   */
  getCluster(clusterId) {
    try {
      if (!this._stmts.getCluster) {
        this._stmts.getCluster = this.db.prepare('SELECT * FROM clusters WHERE id = ?');
      }
      return this._stmts.getCluster.get(clusterId) || null;
    } catch (err) {
      this.logger.error(MODULE, `Failed to get cluster ${clusterId}`, err.message);
      return null;
    }
  }

  /**
   * Get clusters detected within the last N hours.
   *
   * @param {number} [hours=24]
   * @returns {Array}
   */
  getRecentClusters(hours) {
    const h = hours || 24;
    try {
      if (!this._stmts.recentClusters) {
        this._stmts.recentClusters = this.db.prepare(
          "SELECT * FROM clusters WHERE detected_at >= datetime('now', ? || ' hours') ORDER BY detected_at DESC"
        );
      }
      return this._stmts.recentClusters.all(`-${h}`);
    } catch (err) {
      this.logger.error(MODULE, 'Failed to get recent clusters', err.message);
      return [];
    }
  }

  /**
   * Determine if a cluster is ready for publishing.
   * Requires: article_count >= MIN_SOURCES_THRESHOLD AND status === 'detected'.
   *
   * @param {object} cluster
   * @returns {boolean}
   */
  shouldPublish(cluster) {
    if (!cluster) return false;

    const minSources = this.config.MIN_SOURCES_THRESHOLD || 2;
    return cluster.article_count >= minSources && cluster.status === 'detected';
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Compute cosine similarity between two documents in a TfIdf instance.
   *
   * @param {TfIdf} tfidf
   * @param {number} docIndexA
   * @param {number} docIndexB
   * @returns {number} Similarity score (0-1)
   */
  _cosineSimilarity(tfidf, docIndexA, docIndexB) {
    try {
      // Collect all terms and their TF-IDF values for both documents
      const vecA = {};
      const vecB = {};

      tfidf.listTerms(docIndexA).forEach((item) => {
        vecA[item.term] = item.tfidf;
      });

      tfidf.listTerms(docIndexB).forEach((item) => {
        vecB[item.term] = item.tfidf;
      });

      // Compute dot product and magnitudes
      const allTerms = new Set([...Object.keys(vecA), ...Object.keys(vecB)]);
      let dotProduct = 0;
      let magA = 0;
      let magB = 0;

      for (const term of allTerms) {
        const a = vecA[term] || 0;
        const b = vecB[term] || 0;
        dotProduct += a * b;
        magA += a * a;
        magB += b * b;
      }

      magA = Math.sqrt(magA);
      magB = Math.sqrt(magB);

      if (magA === 0 || magB === 0) return 0;

      return dotProduct / (magA * magB);
    } catch (err) {
      this.logger.error(MODULE, 'Error computing cosine similarity', err.message);
      return 0;
    }
  }

  /**
   * Create a brand new cluster.
   */
  _createNewCluster(newArticle, matches, trendsBoosted, trendTopic, priority) {
    // The primary article is the one with the best authority tier, falling back to newArticle
    const allArticles = [newArticle, ...matches.map((m) => m.article)];
    const primaryArticle = allArticles.reduce((best, curr) => {
      return (curr.authority_tier || 3) < (best.authority_tier || 3) ? curr : best;
    }, newArticle);

    // Compute average similarity
    const avgSim = matches.length > 0
      ? matches.reduce((sum, m) => sum + m.score, 0) / matches.length
      : 0;

    // Determine topic from primary article title
    const topic = primaryArticle.title || newArticle.title || 'Unknown topic';

    if (!this._stmts.insertCluster) {
      this._stmts.insertCluster = this.db.prepare(`
        INSERT INTO clusters (topic, article_count, avg_similarity, primary_article_id, trends_boosted, trend_topic, priority, status, detected_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'detected', datetime('now'))
      `);
    }

    const articleCount = 1 + matches.length; // new article + matched articles

    const result = this._stmts.insertCluster.run(
      topic,
      articleCount,
      Math.round(avgSim * 10000) / 10000,
      primaryArticle.id || newArticle.id,
      trendsBoosted,
      trendTopic,
      priority
    );

    const clusterId = typeof result.lastInsertRowid === 'bigint'
      ? Number(result.lastInsertRowid)
      : result.lastInsertRowid;

    // Assign all articles to this cluster
    this._assignArticlesToCluster(clusterId, [newArticle, ...matches.map((m) => m.article)]);

    // Mark trends_matched on the new article if applicable
    if (trendsBoosted && newArticle.id) {
      this._markTrendsMatched(newArticle.id);
    }

    this.logger.info(MODULE, `New cluster ${clusterId}: "${topic}" (${articleCount} articles, priority: ${priority})`);

    return this.getCluster(clusterId);
  }

  /**
   * Update an existing cluster with a new article.
   */
  _updateExistingCluster(clusterId, newArticle, matches, trendsBoosted, trendTopic, priority) {
    if (!this._stmts.updateCluster) {
      this._stmts.updateCluster = this.db.prepare(`
        UPDATE clusters SET
          article_count = article_count + 1,
          avg_similarity = ?,
          trends_boosted = CASE WHEN ? = 1 THEN 1 ELSE trends_boosted END,
          trend_topic = CASE WHEN ? IS NOT NULL THEN ? ELSE trend_topic END,
          priority = CASE WHEN ? = 'high' THEN 'high' ELSE priority END
        WHERE id = ?
      `);
    }

    // Recalculate average similarity including new match scores
    const existingCluster = this.getCluster(clusterId);
    const existingAvg = existingCluster ? existingCluster.avg_similarity : 0;
    const existingCount = existingCluster ? existingCluster.article_count : 0;

    const newMatchAvg = matches.length > 0
      ? matches.reduce((sum, m) => sum + m.score, 0) / matches.length
      : 0;

    // Weighted average of old and new similarities
    const totalAvg = existingCount > 0
      ? ((existingAvg * existingCount) + newMatchAvg) / (existingCount + 1)
      : newMatchAvg;

    this._stmts.updateCluster.run(
      Math.round(totalAvg * 10000) / 10000,
      trendsBoosted,
      trendTopic,
      trendTopic,
      priority,
      clusterId
    );

    // Assign new article to the cluster
    this._assignArticlesToCluster(clusterId, [newArticle]);

    // Mark trends_matched if applicable
    if (trendsBoosted && newArticle.id) {
      this._markTrendsMatched(newArticle.id);
    }

    this.logger.info(MODULE, `Updated cluster ${clusterId} (now ${existingCount + 1} articles)`);

    return this.getCluster(clusterId);
  }

  /**
   * Assign articles to a cluster in the articles table.
   */
  _assignArticlesToCluster(clusterId, articles) {
    if (!this._stmts.assignCluster) {
      this._stmts.assignCluster = this.db.prepare(
        'UPDATE articles SET cluster_id = ? WHERE id = ?'
      );
    }

    for (const article of articles) {
      if (article && article.id) {
        try {
          this._stmts.assignCluster.run(clusterId, article.id);
        } catch (err) {
          this.logger.error(MODULE, `Failed to assign article ${article.id} to cluster ${clusterId}`, err.message);
        }
      }
    }
  }

  /**
   * Mark an article as trends_matched.
   */
  _markTrendsMatched(articleId) {
    try {
      if (!this._stmts.markTrends) {
        this._stmts.markTrends = this.db.prepare(
          'UPDATE articles SET trends_matched = 1 WHERE id = ?'
        );
      }
      this._stmts.markTrends.run(articleId);
    } catch (err) {
      this.logger.error(MODULE, `Failed to mark trends_matched for article ${articleId}`, err.message);
    }
  }
}

module.exports = { SimilarityEngine };
