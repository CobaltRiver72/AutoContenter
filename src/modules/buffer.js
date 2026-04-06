'use strict';

const MODULE = 'buffer';

class ArticleBuffer {
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
  }

  async init() {
    this.enabled = true;
    this.status = 'connected';
  }

  getHealth() {
    var stats = this.getStats();
    return {
      module: 'buffer',
      enabled: true,
      ready: true,
      status: 'connected',
      error: null,
      lastActivity: stats.latestArticleAt,
      stats: { count: stats.recentArticles, totalArticles: stats.totalArticles }
    };
  }

  async shutdown() { /* no-op */ }

  /**
   * Add an article to the buffer.
   * Generates a fingerprint from title + first 500 words of content.
   *
   * @param {object} article
   * @returns {number|null} The inserted article ID, or null on failure
   */
  addArticle(article) {
    try {
      const fingerprint = this._buildFingerprint(article);

      if (!this._stmts.insert) {
        this._stmts.insert = this.db.prepare(`
          INSERT OR IGNORE INTO articles
            (firehose_event_id, url, domain, title, publish_time, content_markdown, fingerprint, authority_tier, received_at)
          VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `);
      }

      const result = this._stmts.insert.run(
        article.firehose_event_id || null,
        article.url,
        article.domain,
        article.title || null,
        article.publish_time || null,
        typeof article.content_markdown === 'string' ? article.content_markdown : (article.content_markdown ? JSON.stringify(article.content_markdown) : null),
        fingerprint,
        article.authority_tier || 3
      );

      if (result.changes === 0) {
        // Likely a duplicate (firehose_event_id UNIQUE constraint)
        this.logger.debug(MODULE, `Duplicate article skipped: ${article.url}`);
        return null;
      }

      const articleId = result.lastInsertRowid;

      this.logger.info(MODULE, `Article buffered: id=${articleId} "${article.title || article.url}"`, {
        domain: article.domain,
        id: articleId,
      });

      return typeof articleId === 'bigint' ? Number(articleId) : articleId;
    } catch (err) {
      this.logger.error(MODULE, 'Failed to add article: ' + err.message, {
        url: article.url,
        domain: article.domain,
        firehose_event_id: article.firehose_event_id,
        stack: err.stack,
      });
      return null;
    }
  }

  /**
   * Get articles received within the last N hours.
   *
   * @param {number} [hours] - Defaults to config.BUFFER_HOURS
   * @returns {Array}
   */
  getRecentArticles(hours) {
    const h = hours || this.config.BUFFER_HOURS || 6;
    try {
      if (!this._stmts.recent) {
        this._stmts.recent = this.db.prepare(
          "SELECT * FROM articles WHERE received_at >= datetime('now', ? || ' hours') ORDER BY received_at DESC"
        );
      }
      return this._stmts.recent.all(`-${h}`);
    } catch (err) {
      this.logger.error(MODULE, 'Failed to get recent articles', err.message);
      return [];
    }
  }

  /**
   * Get all articles belonging to a cluster.
   *
   * @param {number} clusterId
   * @returns {Array}
   */
  getArticlesByCluster(clusterId) {
    try {
      if (!this._stmts.byCluster) {
        this._stmts.byCluster = this.db.prepare(
          'SELECT * FROM articles WHERE cluster_id = ? ORDER BY received_at DESC'
        );
      }
      return this._stmts.byCluster.all(clusterId);
    } catch (err) {
      this.logger.error(MODULE, `Failed to get articles for cluster ${clusterId}`, err.message);
      return [];
    }
  }

  /**
   * Assign an article to a cluster.
   *
   * @param {number} articleId
   * @param {number} clusterId
   */
  assignCluster(articleId, clusterId) {
    try {
      if (!this._stmts.assignCluster) {
        this._stmts.assignCluster = this.db.prepare(
          'UPDATE articles SET cluster_id = ? WHERE id = ?'
        );
      }
      this._stmts.assignCluster.run(clusterId, articleId);
      this.logger.debug(MODULE, `Article ${articleId} assigned to cluster ${clusterId}`);
    } catch (err) {
      this.logger.error(MODULE, `Failed to assign article ${articleId} to cluster ${clusterId}`, err.message);
    }
  }

  /**
   * Delete articles older than the buffer window.
   * Only deletes articles that haven't been assigned to a cluster.
   *
   * @returns {number} Number of deleted rows
   */
  cleanOldArticles() {
    try {
      const hours = this.config.BUFFER_HOURS || 6;
      if (!this._stmts.clean) {
        this._stmts.clean = this.db.prepare(
          `DELETE FROM articles WHERE received_at < datetime('now', ? || ' hours') AND cluster_id IS NULL`
        );
      }
      const result = this._stmts.clean.run(`-${hours}`);
      if (result.changes > 0) {
        this.logger.info(MODULE, `Cleaned ${result.changes} old unbuffered articles`);
      }
      return result.changes;
    } catch (err) {
      this.logger.error(MODULE, 'Failed to clean old articles', err.message);
      return 0;
    }
  }

  /**
   * Get buffer statistics for dashboard.
   *
   * @returns {object}
   */
  getStats() {
    try {
      if (!this._stmts.countTotal) {
        this._stmts.countTotal = this.db.prepare('SELECT COUNT(*) as count FROM articles');
      }
      if (!this._stmts.countRecent) {
        const hours = this.config.BUFFER_HOURS || 6;
        this._stmts.countRecent = this.db.prepare(
          `SELECT COUNT(*) as count FROM articles WHERE received_at >= datetime('now', '-${hours} hours')`
        );
      }
      if (!this._stmts.countClustered) {
        this._stmts.countClustered = this.db.prepare(
          'SELECT COUNT(*) as count FROM articles WHERE cluster_id IS NOT NULL'
        );
      }
      if (!this._stmts.countDomains) {
        this._stmts.countDomains = this.db.prepare(
          'SELECT COUNT(DISTINCT domain) as count FROM articles'
        );
      }
      if (!this._stmts.latestArticle) {
        this._stmts.latestArticle = this.db.prepare(
          'SELECT received_at FROM articles ORDER BY received_at DESC LIMIT 1'
        );
      }

      const total = this._stmts.countTotal.get().count;
      const recent = this._stmts.countRecent.get().count;
      const clustered = this._stmts.countClustered.get().count;
      const domains = this._stmts.countDomains.get().count;
      const latest = this._stmts.latestArticle.get();

      return {
        totalArticles: total,
        recentArticles: recent,
        clusteredArticles: clustered,
        uniqueDomains: domains,
        latestArticleAt: latest ? latest.received_at : null,
        bufferHours: this.config.BUFFER_HOURS || 6,
      };
    } catch (err) {
      this.logger.error(MODULE, 'Failed to get buffer stats', err.message);
      return {
        totalArticles: 0,
        recentArticles: 0,
        clusteredArticles: 0,
        uniqueDomains: 0,
        latestArticleAt: null,
        bufferHours: this.config.BUFFER_HOURS || 6,
      };
    }
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Build a fingerprint from article title + first 500 words of content.
   * Strips markdown, lowercases, and trims.
   *
   * @param {object} article
   * @returns {string}
   */
  _buildFingerprint(article) {
    const title = String(article.title || '').trim();
    const content = String(article.content_markdown || '')
      // Strip common markdown symbols
      .replace(/[#*_\[\]()>`~|\\]/g, ' ')
      .replace(/!\[.*?\]\(.*?\)/g, '')
      .replace(/\[([^\]]*)\]\(.*?\)/g, '$1')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/`[^`]*`/g, '');

    // Take first 500 words of content
    const contentWords = content
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 500)
      .join(' ');

    return `${title} ${contentWords}`.toLowerCase().trim();
  }
}

module.exports = { ArticleBuffer };
