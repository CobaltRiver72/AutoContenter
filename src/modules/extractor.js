'use strict';

var axios = require('axios');
var { Readability } = require('@mozilla/readability');
var { assertSafeUrl, safeAxiosOptions } = require('../utils/safe-http');
var { createQuietJsdom } = require('../utils/jsdom-helpers');

var MODULE = 'extractor';

var FETCH_TIMEOUT_MS = 10000;
var MAX_CONTENT_LENGTH = 5 * 1024 * 1024;
var USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

var BLOCKED_DOMAINS = [
  'economictimes.indiatimes.com',
];

class ContentExtractor {
  constructor(config, db, logger) {
    this.config = config;
    this.db = db;
    this.logger = logger;

    this.enabled = true;
    this.status = 'connected';
    this.error = null;

    this.stats = {
      totalExtracted: 0,
      totalFailed: 0,
      totalSkipped: 0,
      lastExtractAt: null,
    };

    this._stmts = {};
  }

  async init() {
    this.enabled = true;
    this.status = 'connected';
    this.logger.info(MODULE, 'Content Extractor initialized');
  }

  getHealth() {
    return {
      module: MODULE,
      enabled: this.enabled,
      ready: this.enabled,
      status: this.status,
      error: this.error,
      lastActivity: this.stats.lastExtractAt,
      stats: {
        totalExtracted: this.stats.totalExtracted,
        totalFailed: this.stats.totalFailed,
        totalSkipped: this.stats.totalSkipped,
      },
    };
  }

  async shutdown() {
    this.enabled = false;
    this.status = 'disabled';
  }

  async extractClusterContent(cluster) {
    if (!cluster || !cluster.articles || cluster.articles.length === 0) {
      this.logger.warn(MODULE, 'No articles in cluster to extract');
      return cluster;
    }

    this.logger.info(MODULE, 'Extracting content for cluster ' + cluster.id + ' (' + cluster.articles.length + ' articles)');

    var self = this;
    var tasks = cluster.articles.map(function(article) {
      return function() { return self._extractArticle(article); };
    });

    await this._runInBatches(tasks, 3);

    var successCount = cluster.articles.filter(function(a) {
      return a.extraction_status === 'success' || a.extraction_status === 'cached';
    }).length;
    this.logger.info(MODULE, 'Cluster ' + cluster.id + ' extraction complete: ' + successCount + '/' + cluster.articles.length + ' successful');

    return cluster;
  }

  async _extractArticle(article) {
    try {
      var cached = this._getCachedContent(article.id);
      if (cached) {
        article.extracted_content = cached;
        article.extraction_status = 'cached';
        this.logger.debug(MODULE, 'Using cached content for article ' + article.id);
        return;
      }

      var dominated = article.domain || '';
      for (var i = 0; i < BLOCKED_DOMAINS.length; i++) {
        if (dominated.indexOf(BLOCKED_DOMAINS[i]) !== -1) {
          article.extracted_content = this._buildFallbackContent(article);
          article.extraction_status = 'blocked_domain';
          this.stats.totalSkipped++;
          this.logger.debug(MODULE, 'Skipping blocked domain: ' + article.domain);
          return;
        }
      }

      var extracted = await this._fetchAndExtract(article.url);

      if (extracted && extracted.textContent && extracted.textContent.length > 100) {
        article.extracted_content = extracted.textContent;
        article.extracted_title = extracted.title || article.title;
        article.extracted_excerpt = extracted.excerpt || '';
        article.extracted_byline = extracted.byline || '';
        article.extraction_status = 'success';

        this._cacheContent(article.id, extracted.textContent);

        this.stats.totalExtracted++;
        this.stats.lastExtractAt = new Date().toISOString();

        this.logger.info(MODULE, 'Extracted ' + extracted.textContent.length + ' chars from ' + article.domain);
      } else {
        article.extracted_content = this._buildFallbackContent(article);
        article.extraction_status = 'insufficient';
        this.stats.totalFailed++;

        this.logger.warn(MODULE, 'Insufficient extracted content from ' + article.url);
      }
    } catch (err) {
      article.extracted_content = this._buildFallbackContent(article);
      article.extraction_status = 'error';
      this.stats.totalFailed++;

      this.logger.warn(MODULE, 'Extraction failed for ' + article.url + ': ' + err.message);
    }
  }

  async _fetchAndExtract(url) {
    // SSRF: structural pre-flight before axios. The safe agents below
    // also intercept DNS + redirects, but pre-flight is needed for the
    // case where the URL itself is an IP literal (DNS never called).
    assertSafeUrl(url);

    var response = await axios.get(url, safeAxiosOptions({
      timeout: FETCH_TIMEOUT_MS,
      maxContentLength: MAX_CONTENT_LENGTH,
      headers: {
        'User-Agent': USER_AGENT,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        'Cache-Control': 'no-cache',
      },
      maxRedirects: 5,
      validateStatus: function(status) { return status >= 200 && status < 300; },
    }));

    var html = response.data;
    if (typeof html !== 'string' || html.length < 500) {
      return null;
    }

    var dom;
    try {
      dom = createQuietJsdom(html, { url: url });
    } catch (jsdomErr) {
      this.logger.warn(MODULE, 'JSDOM parsing failed for ' + url + ': ' + jsdomErr.message);
      return null;
    }
    try {
      var reader = new Readability(dom.window.document, {
        charThreshold: 100,
      });
      var article = reader.parse();

      if (!article) {
        return null;
      }

      return {
        title: article.title || '',
        textContent: article.textContent || '',
        content: article.content || '',
        excerpt: article.excerpt || '',
        byline: article.byline || '',
        length: article.length || 0,
        siteName: article.siteName || '',
      };
    } finally {
      if (dom) dom.window.close();
    }
  }

  _buildFallbackContent(article) {
    var raw = article.content_markdown || '';

    // Detect JSON content (chunks format from Firehose)
    if (typeof raw === 'string' && raw.length > 0) {
      var trimmed = raw.trim();
      if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
        try {
          var parsed = JSON.parse(trimmed);

          // Check for empty chunks — no usable content
          if (parsed && parsed.chunks && Array.isArray(parsed.chunks) && parsed.chunks.length === 0) {
            // Fall through to title-only fallback
          } else {
            // Try to extract text from non-empty JSON
            var texts = [];
            this._extractTextsFromJson(parsed, texts);
            var result = texts.join(' ').trim();
            if (result.length > 50) return result;
          }
        } catch (e) {
          // Not valid JSON — use as-is if it's substantial
          if (raw.length > 100) return raw;
        }
      } else if (raw.length > 100) {
        // Non-JSON content, use directly
        return raw;
      }
    }

    // Build from title + other available fields
    var parts = [];
    if (article.title) parts.push(article.title);
    if (article.domain) parts.push('Source: ' + article.domain);
    return parts.join('. ') || '';
  }

  /**
   * Recursively extract text from JSON structures (chunks format).
   */
  _extractTextsFromJson(obj, result) {
    if (!obj) return;
    if (typeof obj === 'string') {
      var cleaned = obj.trim();
      if (cleaned.length > 2) result.push(cleaned);
      return;
    }
    if (Array.isArray(obj)) {
      for (var i = 0; i < obj.length; i++) {
        this._extractTextsFromJson(obj[i], result);
      }
      return;
    }
    if (typeof obj === 'object') {
      var keys = Object.keys(obj);
      for (var k = 0; k < keys.length; k++) {
        this._extractTextsFromJson(obj[keys[k]], result);
      }
    }
  }

  _getCachedContent(articleId) {
    if (!articleId) return null;

    try {
      if (!this._stmts.getCached) {
        this._stmts.getCached = this.db.prepare(
          'SELECT extracted_content FROM articles WHERE id = ? AND extracted_content IS NOT NULL AND length(extracted_content) > 100'
        );
      }
      var row = this._stmts.getCached.get(articleId);
      return row ? row.extracted_content : null;
    } catch (err) {
      return null;
    }
  }

  _cacheContent(articleId, content) {
    if (!articleId || !content) return;

    try {
      if (!this._stmts.cacheContent) {
        this._stmts.cacheContent = this.db.prepare(
          'UPDATE articles SET extracted_content = ? WHERE id = ?'
        );
      }
      this._stmts.cacheContent.run(content, articleId);
    } catch (err) {
      this.logger.warn(MODULE, 'Failed to cache content for article ' + articleId + ': ' + err.message);
    }
  }

  async _runInBatches(tasks, batchSize) {
    for (var i = 0; i < tasks.length; i += batchSize) {
      var batch = tasks.slice(i, i + batchSize);
      var promises = [];
      for (var j = 0; j < batch.length; j++) {
        promises.push(batch[j]());
      }
      await Promise.allSettled(promises);
    }
  }

  getStatus() {
    return {
      totalExtracted: this.stats.totalExtracted,
      totalFailed: this.stats.totalFailed,
      totalSkipped: this.stats.totalSkipped,
      lastExtractAt: this.stats.lastExtractAt,
    };
  }
}

module.exports = { ContentExtractor };
