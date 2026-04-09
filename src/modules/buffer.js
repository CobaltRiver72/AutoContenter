'use strict';

const { NEWS_CATEGORIES } = require('../utils/categories');

const MODULE = 'buffer';

// Maps known publisher domains to a NEWS_CATEGORIES slug.
// Only domains where category is unambiguous are listed.
const DOMAIN_CATEGORY_MAP = {
  // Hindi news
  'aajtak.in':              'hindi-news',
  'ndtv.in':                'hindi-news',
  'abplive.com':            'hindi-news',
  'zeenews.india.com':      'hindi-news',
  'amarujala.com':          'hindi-news',
  'jagran.com':             'hindi-news',
  'bhaskar.com':            'hindi-news',
  'navbharattimes.indiatimes.com': 'hindi-news',
  'livehindustan.com':      'hindi-news',
  'punjabkesari.in':        'hindi-news',
  // English news
  'timesofindia.indiatimes.com': 'india-news',
  'hindustantimes.com':     'india-news',
  'ndtv.com':               'india-news',
  'thehindu.com':           'india-news',
  'indianexpress.com':      'india-news',
  'indiatoday.in':          'india-news',
  'thequint.com':           'india-news',
  'scroll.in':              'india-news',
  'thewire.in':             'india-news',
  'firstpost.com':          'india-news',
  // Sports
  'cricbuzz.com':           'cricket',
  'espncricinfo.com':       'cricket',
  'goal.com':               'football',
  // Entertainment
  'bollywoodhungama.com':   'bollywood',
  'pinkvilla.com':          'bollywood',
  'filmfare.com':           'entertainment',
  // Business
  'economictimes.indiatimes.com': 'business',
  'livemint.com':           'business',
  'moneycontrol.com':       'business',
};

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

      // Attach fingerprint back to the article object so similarity engine can use it
      article.fingerprint = fingerprint;

      // Domain-based category tagging — only when article has no explicit category
      if (!article.page_category && article.domain) {
        var mappedCategory = DOMAIN_CATEGORY_MAP[article.domain];
        if (mappedCategory && NEWS_CATEGORIES[mappedCategory]) {
          article.page_category = mappedCategory;
          this.logger.debug(MODULE, '[domain-cat] Tagged ' + article.domain + ' → ' + mappedCategory);
        }
      }

      if (!this._stmts.insert) {
        this._stmts.insert = this.db.prepare(`
          INSERT OR IGNORE INTO articles
            (firehose_event_id, url, domain, title, publish_time, content_markdown, fingerprint, authority_tier, page_category, language, received_at)
          VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
        article.authority_tier || 3,
        article.page_category ? (Array.isArray(article.page_category) ? article.page_category.join(',') : article.page_category) : null,
        article.language || null
      );

      if (result.changes === 0) {
        // Likely a duplicate (firehose_event_id UNIQUE constraint)
        this.logger.debug(MODULE, `Duplicate article skipped: ${article.url}`);
        return null;
      }

      const articleId = result.lastInsertRowid;

      // Attach ID back so caller doesn't need to do it
      article.id = typeof articleId === 'bigint' ? Number(articleId) : articleId;

      this.logger.info(MODULE, `Article buffered: id=${article.id} "${article.title || article.url}"`, {
        domain: article.domain,
        id: article.id,
      });

      return article.id;
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
   * Get recent articles optimized for similarity matching.
   * Limits results and excludes articles in published/failed clusters.
   */
  getRecentArticlesForSimilarity(hours, limit) {
    var h = hours || this.config.BUFFER_HOURS || 6;
    var maxArticles = limit || this.config.MAX_BUFFER_FOR_SIMILARITY || 100;

    try {
      if (!this._stmts.recentForSimilarity) {
        this._stmts.recentForSimilarity = this.db.prepare(
          "SELECT a.* FROM articles a" +
          " LEFT JOIN clusters c ON a.cluster_id = c.id" +
          " WHERE a.received_at >= datetime('now', ? || ' hours')" +
          "   AND (a.cluster_id IS NULL OR c.status = 'detected')" +
          " ORDER BY a.received_at DESC" +
          " LIMIT ?"
        );
      }

      var articles = this._stmts.recentForSimilarity.all('-' + h, maxArticles);

      this.logger.debug(MODULE, 'Buffer for similarity: ' + articles.length + ' articles (max ' + maxArticles + ', window ' + h + 'h)');
      return articles;
    } catch (err) {
      this.logger.error(MODULE, 'Failed to get articles for similarity', err.message);
      var all = this.getRecentArticles(h);
      return all.slice(0, maxArticles);
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
      // Minimum 48h retention, or 2x buffer window, whichever is larger
      var bufferHours = this.config.BUFFER_HOURS || 6;
      var minRetention = Math.max(bufferHours * 2, 48);

      if (!this._stmts.clean) {
        this._stmts.clean = this.db.prepare(
          "DELETE FROM articles WHERE received_at < datetime('now', ? || ' hours') AND cluster_id IS NULL"
        );
      }
      var result = this._stmts.clean.run('-' + minRetention);
      if (result.changes > 0) {
        this.logger.info(MODULE, 'Cleaned ' + result.changes + ' old unbuffered articles (retention: ' + minRetention + 'h)');
      }

      // Also clean articles from very old published clusters (30 days)
      try {
        if (!this._stmts.cleanOldClusters) {
          this._stmts.cleanOldClusters = this.db.prepare(
            "DELETE FROM articles WHERE cluster_id IN (SELECT id FROM clusters WHERE status = 'published' AND detected_at < datetime('now', '-30 days'))"
          );
        }
        this._stmts.cleanOldClusters.run();
      } catch (e) { /* ignore */ }

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
   * Build a fingerprint from article title + extracted content.
   * Handles Firehose JSON content_markdown (chunks format) + plain markdown.
   * Also includes page_category for topic clustering.
   *
   * @param {object} article
   * @returns {string}
   */
  _buildFingerprint(article) {
    try {
      var title = String(article.title || '').trim();

      // Extract text from content_markdown (may be JSON from Firehose)
      var rawContent = '';
      try {
        rawContent = String(article.content_markdown || '');
      } catch (e) {
        rawContent = '';
      }

      var extractedText = '';

      if (rawContent.length > 0 && (rawContent.charAt(0) === '{' || rawContent.charAt(0) === '[')) {
        try {
          var parsed = JSON.parse(rawContent);
          extractedText = this._extractTextFromJson(parsed);
        } catch (e) {
          extractedText = rawContent;
        }
      } else {
        extractedText = rawContent;
      }

      // Length safety — truncate before regex processing
      if (extractedText.length > 100000) {
        extractedText = extractedText.substring(0, 100000);
      }

      // Strip markdown formatting
      extractedText = extractedText
        .replace(/[#*_\[\]()>`~|\\]/g, ' ')
        .replace(/!\[.*?\]\(.*?\)/g, '')
        .replace(/\[([^\]]*)\]\(.*?\)/g, '$1')
        .replace(/```[\s\S]*?```/g, '')
        .replace(/`[^`]*`/g, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\s+/g, ' ')
        .trim();

      // Take first 500 words of extracted content
      var contentWords = extractedText
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 500)
        .join(' ');

      // Include page_category for topic clustering
      var categoryText = '';
      if (article.page_category) {
        try {
          var cats = Array.isArray(article.page_category)
            ? article.page_category
            : [article.page_category];
          categoryText = cats
            .join(' ')
            .replace(/[\/]/g, ' ')
            .replace(/[_]/g, ' ')
            .toLowerCase()
            .trim();
        } catch (e) {
          categoryText = '';
        }
      }

      // Repeat title 3x to weight it heavily since content may be thin
      var titleWeighted = (title + ' ' + title + ' ' + title).trim();
      return (titleWeighted + ' ' + categoryText + ' ' + contentWords).toLowerCase().trim();
    } catch (err) {
      // LAST RESORT: return just the title so the article can still be compared
      this.logger.warn(MODULE, 'Fingerprint build failed, using title-only fallback: ' + err.message);
      var fallbackTitle = String(article.title || article.url || 'unknown').trim();
      return (fallbackTitle + ' ' + fallbackTitle + ' ' + fallbackTitle).toLowerCase();
    }
  }

  /**
   * Recursively extract text from a JSON object (handles Firehose chunk format).
   *
   * @param {*} obj
   * @returns {string}
   */
  _extractTextFromJson(obj) {
    if (!obj) return '';
    if (typeof obj === 'string') return obj;
    if (Array.isArray(obj)) {
      return obj.map(item => this._extractTextFromJson(item)).join(' ');
    }
    if (typeof obj === 'object') {
      let texts = [];
      const textKeys = ['text', 'content', 'value', 'body', 'title', 'heading',
                        'paragraph', 'description', 'summary', 'markdown'];
      for (const key of textKeys) {
        if (obj[key]) {
          texts.push(this._extractTextFromJson(obj[key]));
        }
      }
      if (obj.chunks && Array.isArray(obj.chunks)) {
        for (const chunk of obj.chunks) {
          texts.push(this._extractTextFromJson(chunk));
        }
      }
      if (texts.length === 0) {
        for (const [key, val] of Object.entries(obj)) {
          if (typeof val === 'string' && val.length > 10) {
            texts.push(val);
          } else if (typeof val === 'object') {
            texts.push(this._extractTextFromJson(val));
          }
        }
      }
      return texts.filter(Boolean).join(' ');
    }
    return String(obj);
  }
}

module.exports = { ArticleBuffer };
