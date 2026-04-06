'use strict';

var axios = require('axios');
var path = require('path');

// Timeout for WordPress API calls
var WP_TIMEOUT_MS = 60000;

// Regex patterns to extract the first image URL from article content
var MD_IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/;
var HTML_IMAGE_RE = /<img[^>]+src=["']([^"']+)["']/;

function extractImageUrl(content) {
  if (!content) return null;
  var mdMatch = content.match(MD_IMAGE_RE);
  if (mdMatch && mdMatch[1]) return mdMatch[1];
  var htmlMatch = content.match(HTML_IMAGE_RE);
  if (htmlMatch && htmlMatch[1]) return htmlMatch[1];
  return null;
}

function guessMimeType(url) {
  var ext = path.extname(url).toLowerCase().split('?')[0];
  var mimeMap = {
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
  };
  return mimeMap[ext] || 'image/jpeg';
}

function generateFilename(slug, imageUrl) {
  var ext = path.extname(imageUrl).toLowerCase().split('?')[0] || '.jpg';
  var safeName = (slug || 'featured').replace(/[^a-z0-9-]/g, '').slice(0, 50);
  return safeName + ext;
}

function buildSchemaMarkup(rewrittenArticle, wpPostUrl, siteName) {
  var schemas = [];

  var newsArticle = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    'headline': rewrittenArticle.title || '',
    'description': rewrittenArticle.metaDescription || rewrittenArticle.excerpt || '',
    'url': wpPostUrl || '',
    'datePublished': new Date().toISOString(),
    'dateModified': new Date().toISOString(),
    'author': { '@type': 'Organization', 'name': siteName || 'HDF News' },
    'publisher': { '@type': 'Organization', 'name': siteName || 'HDF News' },
    'mainEntityOfPage': { '@type': 'WebPage', '@id': wpPostUrl || '' }
  };

  if (rewrittenArticle.targetKeyword) {
    newsArticle.keywords = rewrittenArticle.targetKeyword;
  }
  schemas.push(newsArticle);

  if (rewrittenArticle.faq && Array.isArray(rewrittenArticle.faq) && rewrittenArticle.faq.length > 0) {
    var faqEntities = [];
    for (var i = 0; i < rewrittenArticle.faq.length; i++) {
      var item = rewrittenArticle.faq[i];
      if (item.question && item.answer) {
        faqEntities.push({
          '@type': 'Question',
          'name': item.question,
          'acceptedAnswer': { '@type': 'Answer', 'text': item.answer }
        });
      }
    }
    if (faqEntities.length > 0) {
      schemas.push({ '@context': 'https://schema.org', '@type': 'FAQPage', 'mainEntity': faqEntities });
    }
  }

  var html = '';
  for (var j = 0; j < schemas.length; j++) {
    html += '<script type="application/ld+json">' + JSON.stringify(schemas[j]) + '</script>\n';
  }
  return html;
}

class WordPressPublisher {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;

    this.authHeader = '';
    this.wpBaseUrl = '';

    this.enabled = false;
    this.status = 'disabled';
    this.error = null;

    this.stats = {
      totalPublished: 0,
      publishedToday: 0,
      lastPublishAt: null,
      _todayDate: null,
    };
  }

  /**
   * Build the REST API URL for a given path.
   * Uses ?rest_route= format (works on Cloudways/Nginx without rewrite rules)
   * with /wp-json/ as fallback.
   */
  _restUrl(restPath) {
    return this.wpBaseUrl + '/?rest_route=' + encodeURIComponent(restPath);
  }

  _wpJsonUrl(restPath) {
    return this.wpBaseUrl + '/wp-json' + restPath;
  }

  /**
   * Make a WP REST API request with multi-method fallback:
   *   1. ?rest_route= with Authorization header
   *   2. ?rest_route= with credentials in URL (if auth header stripped)
   *   3. /wp-json/ with Authorization header (if Nginx rewrite works)
   */
  async _wpRequest(method, restPath, data, extraHeaders) {
    var self = this;
    var headers = Object.assign({
      'Authorization': self.authHeader,
      'Content-Type': 'application/json',
    }, extraHeaders || {});

    var errors = [];

    // Method 1: ?rest_route= with auth header (most reliable on Cloudways)
    var url1 = self._restUrl(restPath);
    self.logger.info('publisher', 'WP API Method 1: ' + method + ' ' + url1);
    try {
      var res1 = await axios({ method: method, url: url1, data: data, headers: headers, timeout: WP_TIMEOUT_MS });
      self.logger.info('publisher', 'Method 1 succeeded (' + res1.status + ')');
      return res1;
    } catch (err1) {
      var status1 = err1.response ? err1.response.status : null;
      var msg1 = err1.response && err1.response.data ? (err1.response.data.message || err1.response.data.code || '') : err1.message;
      self.logger.warn('publisher', 'Method 1 failed: ' + (status1 || '') + ' ' + msg1);
      errors.push({ method: '?rest_route= + header', status: status1, message: msg1 });

      // If 401 — auth header likely stripped by Nginx
      if (status1 === 401) {
        // Method 2: credentials in URL
        self.logger.info('publisher', 'WP API Method 2: URL-encoded credentials');
        try {
          var encodedUser = encodeURIComponent(self.config.WP_USERNAME);
          var encodedPwd = encodeURIComponent(self.config.WP_APP_PASSWORD);
          var urlParsed = new URL(self.wpBaseUrl);
          var authBaseUrl = urlParsed.protocol + '//' + encodedUser + ':' + encodedPwd + '@' + urlParsed.host + urlParsed.pathname.replace(/\/+$/, '');
          var url2 = authBaseUrl + '/?rest_route=' + encodeURIComponent(restPath);
          var headers2 = Object.assign({}, extraHeaders || {}, { 'Content-Type': 'application/json' });

          var res2 = await axios({ method: method, url: url2, data: data, headers: headers2, timeout: WP_TIMEOUT_MS });
          self.logger.info('publisher', 'Method 2 succeeded (' + res2.status + ')');
          return res2;
        } catch (err2) {
          var status2 = err2.response ? err2.response.status : null;
          var msg2 = err2.response && err2.response.data ? (err2.response.data.message || err2.response.data.code || '') : err2.message;
          self.logger.warn('publisher', 'Method 2 failed: ' + (status2 || '') + ' ' + msg2);
          errors.push({ method: 'URL-encoded auth', status: status2, message: msg2 });
        }
      }
    }

    // Method 3: /wp-json/ pretty URL with auth header
    var url3 = self._wpJsonUrl(restPath);
    self.logger.info('publisher', 'WP API Method 3: ' + method + ' ' + url3);
    try {
      var res3 = await axios({ method: method, url: url3, data: data, headers: headers, timeout: WP_TIMEOUT_MS });
      self.logger.info('publisher', 'Method 3 succeeded (' + res3.status + ')');
      return res3;
    } catch (err3) {
      var status3 = err3.response ? err3.response.status : null;
      var msg3 = err3.response && err3.response.data ? (err3.response.data.message || err3.response.data.code || '') : err3.message;
      self.logger.warn('publisher', 'Method 3 failed: ' + (status3 || '') + ' ' + msg3);
      errors.push({ method: '/wp-json/ + header', status: status3, message: msg3 });
    }

    // All methods failed — build detailed error
    var detail = errors.map(function (e) { return e.method + ': ' + (e.status || 'network') + ' ' + e.message; }).join(' | ');
    var finalErr = new Error('All WP API methods failed for ' + restPath + '. Details: ' + detail);
    finalErr.wpErrors = errors;

    // Check if auth-related
    var hasAuth401 = errors.some(function (e) { return e.status === 401; });
    if (hasAuth401) {
      finalErr.message += '\n\nLikely fix: Nginx is stripping the Authorization header. ' +
        'Add to .htaccess: SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1\n' +
        'Or add to wp-config.php the HTTP_AUTHORIZATION fix.\n' +
        'Or add to Nginx: fastcgi_param HTTP_AUTHORIZATION $http_authorization;';
    }

    throw finalErr;
  }

  /**
   * Full publish pipeline.
   */
  async publish(rewrittenArticle, cluster, db) {
    var wpImageId = null;

    // Step 1: Upload featured image (if available)
    var featuredImageUrl = rewrittenArticle.featuredImage || null;

    // Try to extract featured image from cluster articles
    if (!featuredImageUrl && cluster && cluster.articles) {
      for (var ai = 0; ai < cluster.articles.length; ai++) {
        var a = cluster.articles[ai];
        if (a.featured_image) { featuredImageUrl = a.featured_image; break; }
        var imgUrl = extractImageUrl(a.content_markdown || a.content || '');
        if (imgUrl) { featuredImageUrl = imgUrl; break; }
      }
    }

    if (featuredImageUrl) {
      try {
        this.logger.info('publisher', 'Uploading featured image: ' + featuredImageUrl.substring(0, 100) + '...');
        var imageResult = await this.uploadImage(featuredImageUrl, rewrittenArticle.title || 'Featured Image');
        wpImageId = imageResult.mediaId;
        this.logger.info('publisher', 'Featured image uploaded: mediaId=' + wpImageId);
      } catch (imgErr) {
        // Non-blocking — publish without image
        this.logger.warn('publisher', 'Featured image upload failed (continuing without): ' + imgErr.message);
      }
    }

    // Step 2: Build schema markup
    var siteName = '';
    try {
      siteName = new URL(this.wpBaseUrl).hostname.replace(/^www\./, '');
    } catch (e) {
      siteName = 'HDF News';
    }
    var schemaHtml = buildSchemaMarkup(rewrittenArticle, '', siteName);

    // Step 3: Create the WordPress post
    var postContent = (rewrittenArticle.content || '');
    if (schemaHtml) {
      postContent += '\n\n' + schemaHtml;
    }

    var postData = {
      title: rewrittenArticle.title,
      content: postContent,
      excerpt: rewrittenArticle.excerpt,
      status: this.config.WP_POST_STATUS || 'draft',
      author: parseInt(this.config.WP_AUTHOR_ID, 10) || 1,
      categories: [parseInt(this.config.WP_DEFAULT_CATEGORY, 10) || 1],
      featured_media: wpImageId || 0,
    };

    var postResult = await this.createPost(postData);

    // Step 4: Update schema with actual post URL (non-critical)
    if (postResult.wpPostUrl && schemaHtml) {
      try {
        var updatedSchema = buildSchemaMarkup(rewrittenArticle, postResult.wpPostUrl, siteName);
        var updatedContent = (rewrittenArticle.content || '') + '\n\n' + updatedSchema;
        await this._wpRequest('post', '/wp/v2/posts/' + postResult.wpPostId, { content: updatedContent });
      } catch (schemaErr) {
        this.logger.warn('publisher', 'Schema URL update failed (non-critical): ' + schemaErr.message);
      }
    }

    // Step 5: Record in the published table
    try {
      var insertStmt = db.prepare(
        'INSERT INTO published (' +
        '  cluster_id, wp_post_id, wp_post_url, wp_image_id,' +
        '  title, slug, excerpt, meta_description,' +
        '  word_count, target_keyword, ai_model, tokens_used, published_at' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );
      insertStmt.run(
        cluster.id || 0,
        postResult.wpPostId,
        postResult.wpPostUrl,
        wpImageId,
        rewrittenArticle.title,
        rewrittenArticle.slug,
        rewrittenArticle.excerpt,
        rewrittenArticle.metaDescription,
        rewrittenArticle.wordCount || 0,
        rewrittenArticle.targetKeyword || '',
        rewrittenArticle.aiModel,
        rewrittenArticle.tokensUsed,
        new Date().toISOString()
      );
    } catch (dbErr) {
      this.logger.error('publisher', 'Failed to record published article: ' + dbErr.message);
    }

    this._updateStats();

    this.logger.info('publisher', 'Article published to WordPress: postId=' + postResult.wpPostId + ' url=' + postResult.wpPostUrl);

    return {
      wpPostId: postResult.wpPostId,
      wpPostUrl: postResult.wpPostUrl,
      wpImageId: wpImageId,
    };
  }

  /**
   * Upload an image to WP media library using multi-method fallback.
   */
  async uploadImage(imageUrl, altText) {
    // Download the image first
    var imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: WP_TIMEOUT_MS,
      headers: { 'User-Agent': 'HDF-News-AutoPub/1.0' },
    });

    var imageBuffer = Buffer.from(imageResponse.data);
    var mimeType = guessMimeType(imageUrl);
    var filename = generateFilename(altText, imageUrl);

    // Upload via _wpRequest with binary content type
    var uploadRes = await this._wpRequest('post', '/wp/v2/media', imageBuffer, {
      'Content-Type': mimeType,
      'Content-Disposition': 'attachment; filename="' + filename + '"',
    });

    // Set alt text (non-critical)
    if (uploadRes.data.id && altText) {
      try {
        await this._wpRequest('post', '/wp/v2/media/' + uploadRes.data.id, { alt_text: altText });
      } catch (e) { /* ignore */ }
    }

    return {
      mediaId: uploadRes.data.id,
      mediaUrl: uploadRes.data.source_url || (uploadRes.data.guid && uploadRes.data.guid.rendered) || '',
    };
  }

  /**
   * Create a WordPress post via the REST API with multi-method fallback.
   */
  async createPost(data) {
    var response = await this._wpRequest('post', '/wp/v2/posts', data);

    if (!response.data || !response.data.id) {
      throw new Error('WordPress returned no post ID. Response status: ' + response.status);
    }

    return {
      wpPostId: response.data.id,
      wpPostUrl: response.data.link || (response.data.guid && response.data.guid.rendered) || '',
    };
  }

  _updateStats() {
    var today = new Date().toISOString().slice(0, 10);
    if (this.stats._todayDate !== today) {
      this.stats._todayDate = today;
      this.stats.publishedToday = 0;
    }
    this.stats.totalPublished++;
    this.stats.publishedToday++;
    this.stats.lastPublishAt = new Date().toISOString();
  }

  async init() {
    this.reinit();
  }

  reinit() {
    try {
      var { getConfig } = require('../utils/config');
      var freshConfig = getConfig();
      this.config = freshConfig;

      if (!this.config.WP_URL || !this.config.WP_USERNAME || !this.config.WP_APP_PASSWORD) {
        this.enabled = false;
        this.status = 'disabled';
        this.error = null;
        this.authHeader = '';
        this.wpBaseUrl = '';
        return;
      }

      this.authHeader = 'Basic ' + Buffer.from(
        this.config.WP_USERNAME + ':' + this.config.WP_APP_PASSWORD
      ).toString('base64');
      this.wpBaseUrl = (this.config.WP_URL || '').replace(/\/+$/, '');
      this.enabled = true;
      this.status = 'connected';
      this.error = null;

      this.logger.info('publisher', 'Publisher initialized: ' + this.wpBaseUrl);
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      this.logger.error('publisher', 'Publisher reinit failed: ' + err.message);
    }
  }

  getHealth() {
    return {
      module: 'publisher',
      enabled: this.enabled,
      ready: this.enabled,
      status: this.status,
      error: this.error,
      lastActivity: this.stats.lastPublishAt,
      stats: { wpUrl: this.wpBaseUrl, totalPublished: this.stats.totalPublished },
    };
  }

  async shutdown() {
    this.enabled = false;
    this.status = 'disabled';
  }

  getStatus() {
    var today = new Date().toISOString().slice(0, 10);
    if (this.stats._todayDate !== today) {
      this.stats._todayDate = today;
      this.stats.publishedToday = 0;
    }
    return {
      totalPublished: this.stats.totalPublished,
      publishedToday: this.stats.publishedToday,
      lastPublishAt: this.stats.lastPublishAt,
    };
  }
}

module.exports = { WordPressPublisher };
