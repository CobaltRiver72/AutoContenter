'use strict';

const axios = require('axios');
const path = require('path');

// Timeout for WordPress API calls (15 seconds)
const WP_TIMEOUT_MS = 15000;

// Max retries for WP API calls
const MAX_RETRIES = 2;

// Regex patterns to extract the first image URL from article content
const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/;
const HTML_IMAGE_RE = /<img[^>]+src=["']([^"']+)["']/;

/**
 * Extract the first image URL from markdown or HTML content.
 *
 * @param {string} content - Article content (markdown or HTML)
 * @returns {string|null}
 */
function extractImageUrl(content) {
  if (!content) return null;

  // Try markdown image first
  const mdMatch = content.match(MD_IMAGE_RE);
  if (mdMatch && mdMatch[1]) return mdMatch[1];

  // Try HTML img tag
  const htmlMatch = content.match(HTML_IMAGE_RE);
  if (htmlMatch && htmlMatch[1]) return htmlMatch[1];

  return null;
}

/**
 * Guess MIME type from URL or default to jpeg.
 *
 * @param {string} url
 * @returns {string}
 */
function guessMimeType(url) {
  const ext = path.extname(url).toLowerCase().split('?')[0];
  const mimeMap = {
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
  };
  return mimeMap[ext] || 'image/jpeg';
}

/**
 * Generate a filename from a slug and image URL.
 *
 * @param {string} slug
 * @param {string} imageUrl
 * @returns {string}
 */
function generateFilename(slug, imageUrl) {
  const ext = path.extname(imageUrl).toLowerCase().split('?')[0] || '.jpg';
  const safeName = (slug || 'featured').replace(/[^a-z0-9-]/g, '').slice(0, 50);
  return `${safeName}${ext}`;
}

/**
 * Build JSON-LD schema markup for the article.
 * Generates NewsArticle + FAQPage schemas.
 *
 * @param {object} rewrittenArticle - Output from rewriter
 * @param {string} wpPostUrl - The published WordPress post URL
 * @param {string} siteName - The site name from WP_URL
 * @returns {string} HTML string with <script type="application/ld+json"> blocks
 */
function buildSchemaMarkup(rewrittenArticle, wpPostUrl, siteName) {
  var schemas = [];

  // NewsArticle schema
  var newsArticle = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    'headline': rewrittenArticle.title || '',
    'description': rewrittenArticle.metaDescription || rewrittenArticle.excerpt || '',
    'url': wpPostUrl || '',
    'datePublished': new Date().toISOString(),
    'dateModified': new Date().toISOString(),
    'author': {
      '@type': 'Organization',
      'name': siteName || 'HDF News'
    },
    'publisher': {
      '@type': 'Organization',
      'name': siteName || 'HDF News'
    },
    'mainEntityOfPage': {
      '@type': 'WebPage',
      '@id': wpPostUrl || ''
    }
  };

  if (rewrittenArticle.targetKeyword) {
    newsArticle.keywords = rewrittenArticle.targetKeyword;
  }

  schemas.push(newsArticle);

  // FAQPage schema (if FAQ data available)
  if (rewrittenArticle.faq && Array.isArray(rewrittenArticle.faq) && rewrittenArticle.faq.length > 0) {
    var faqEntities = [];
    for (var i = 0; i < rewrittenArticle.faq.length; i++) {
      var item = rewrittenArticle.faq[i];
      if (item.question && item.answer) {
        faqEntities.push({
          '@type': 'Question',
          'name': item.question,
          'acceptedAnswer': {
            '@type': 'Answer',
            'text': item.answer
          }
        });
      }
    }

    if (faqEntities.length > 0) {
      schemas.push({
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        'mainEntity': faqEntities
      });
    }
  }

  // Build the HTML script tags
  var html = '';
  for (var j = 0; j < schemas.length; j++) {
    html += '<script type="application/ld+json">' + JSON.stringify(schemas[j]) + '</script>\n';
  }

  return html;
}

class WordPressPublisher {
  /**
   * @param {object} config - App config from getConfig()
   * @param {object} logger - Winston logger instance
   */
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;

    // Build the base auth header once
    this.authHeader = `Basic ${Buffer.from(
      `${this.config.WP_USERNAME}:${this.config.WP_APP_PASSWORD}`
    ).toString('base64')}`;

    // Base WP REST URL (strip trailing slash)
    this.wpBaseUrl = (this.config.WP_URL || '').replace(/\/+$/, '');

    // Module independence
    this.enabled = false;
    this.status = 'disabled';
    this.error = null;

    // Stats
    this.stats = {
      totalPublished: 0,
      publishedToday: 0,
      lastPublishAt: null,
      _todayDate: null, // internal: tracks which day "publishedToday" refers to
    };
  }

  /**
   * Full publish pipeline: download featured image, upload to WP media,
   * create post, record in the published table.
   *
   * @param {object} rewrittenArticle - Output from ArticleRewriter.rewrite()
   * @param {object} cluster - The cluster object
   * @param {object} db - better-sqlite3 Database instance
   * @returns {Promise<object>} { wpPostId, wpPostUrl, wpImageId }
   */
  async publish(rewrittenArticle, cluster, db) {
    let wpImageId = null;

    // Step 1: Try to upload a featured image (non-blocking on failure)
    try {
      const primaryArticle = (cluster.articles && cluster.articles[0]) || {};
      const imageUrl = extractImageUrl(
        primaryArticle.content_markdown || primaryArticle.content || ''
      );

      if (imageUrl) {
        this.logger.info('Uploading featured image', { imageUrl });
        const imageResult = await this.uploadImage(imageUrl, rewrittenArticle.title);
        wpImageId = imageResult.mediaId;
        this.logger.info('Featured image uploaded', {
          mediaId: imageResult.mediaId,
          mediaUrl: imageResult.mediaUrl,
        });
      } else {
        this.logger.info('No featured image found in primary article');
      }
    } catch (imgErr) {
      this.logger.warn('Featured image upload failed — publishing without image', {
        error: imgErr.message,
      });
      // Don't block publishing
    }

    // Step 2: Build schema markup
    var siteName = '';
    try {
      siteName = new URL(this.wpBaseUrl).hostname.replace(/^www\./, '');
    } catch (e) {
      siteName = 'HDF News';
    }
    var schemaHtml = buildSchemaMarkup(rewrittenArticle, '', siteName);

    // Step 3: Create the WordPress post with schema appended
    var postContent = (rewrittenArticle.content || '');
    if (schemaHtml) {
      postContent += '\n\n' + schemaHtml;
    }

    const postData = {
      title: rewrittenArticle.title,
      content: postContent,
      excerpt: rewrittenArticle.excerpt,
      status: this.config.WP_POST_STATUS || 'publish',
      author: this.config.WP_AUTHOR_ID || 1,
      categories: [this.config.WP_DEFAULT_CATEGORY || 1],
      featured_media: wpImageId || 0,
    };

    const postResult = await this.createPost(postData);

    // Update schema with actual post URL (we didn't know it before creation)
    if (postResult.wpPostUrl && schemaHtml) {
      try {
        var updatedSchema = buildSchemaMarkup(rewrittenArticle, postResult.wpPostUrl, siteName);
        var updatedContent = (rewrittenArticle.content || '') + '\n\n' + updatedSchema;
        await axios.post(
          this.wpBaseUrl + '/wp-json/wp/v2/posts/' + postResult.wpPostId,
          { content: updatedContent },
          {
            headers: {
              Authorization: this.authHeader,
              'Content-Type': 'application/json',
            },
            timeout: WP_TIMEOUT_MS,
          }
        );
      } catch (schemaErr) {
        this.logger.warn('Failed to update schema URL in post — non-critical', {
          error: schemaErr.message,
        });
      }
    }

    // Step 4: Record in the published table
    try {
      var insertStmt = db.prepare(
        'INSERT INTO published (' +
        '  cluster_id, wp_post_id, wp_post_url, wp_image_id,' +
        '  title, slug, excerpt, meta_description,' +
        '  word_count, target_keyword, ai_model, tokens_used, published_at' +
        ') VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      );

      insertStmt.run(
        cluster.id || null,
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
      this.logger.error('Failed to record published article in database', {
        error: dbErr.message,
        wpPostId: postResult.wpPostId,
      });
      // Don't throw — the article is already published
    }

    // Update stats
    this._updateStats();

    this.logger.info('Article published to WordPress', {
      wpPostId: postResult.wpPostId,
      wpPostUrl: postResult.wpPostUrl,
      title: rewrittenArticle.title,
    });

    return {
      wpPostId: postResult.wpPostId,
      wpPostUrl: postResult.wpPostUrl,
      wpImageId,
    };
  }

  /**
   * Download an image and upload it to WordPress media library.
   *
   * @param {string} imageUrl - Source image URL
   * @param {string} altText  - Alt text for the image
   * @returns {Promise<object>} { mediaId, mediaUrl }
   */
  async uploadImage(imageUrl, altText) {
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // Download the image
        const imageResponse = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          timeout: WP_TIMEOUT_MS,
          headers: {
            'User-Agent': 'HDF-News-AutoPub/1.0',
          },
        });

        const imageBuffer = Buffer.from(imageResponse.data);
        const mimeType = guessMimeType(imageUrl);
        const filename = generateFilename(altText, imageUrl);

        // Upload to WordPress
        const uploadResponse = await axios.post(
          `${this.wpBaseUrl}/wp-json/wp/v2/media`,
          imageBuffer,
          {
            headers: {
              Authorization: this.authHeader,
              'Content-Type': mimeType,
              'Content-Disposition': `attachment; filename="${filename}"`,
            },
            timeout: WP_TIMEOUT_MS,
          }
        );

        // Set alt text if the media endpoint returned an ID
        if (uploadResponse.data.id && altText) {
          try {
            await axios.post(
              `${this.wpBaseUrl}/wp-json/wp/v2/media/${uploadResponse.data.id}`,
              { alt_text: altText },
              {
                headers: {
                  Authorization: this.authHeader,
                  'Content-Type': 'application/json',
                },
                timeout: WP_TIMEOUT_MS,
              }
            );
          } catch (_altErr) {
            // Non-critical — ignore
          }
        }

        return {
          mediaId: uploadResponse.data.id,
          mediaUrl: uploadResponse.data.source_url || uploadResponse.data.guid?.rendered || '',
        };
      } catch (err) {
        lastError = err;
        this.logger.warn(`Image upload attempt ${attempt}/${MAX_RETRIES} failed`, {
          error: err.message,
          imageUrl,
        });

        // Don't retry on 4xx client errors (bad URL, forbidden, etc.)
        if (err.response && err.response.status >= 400 && err.response.status < 500) {
          break;
        }
      }
    }

    throw lastError;
  }

  /**
   * Create a WordPress post via the REST API.
   *
   * @param {object} data - Post data { title, content, excerpt, status, author, categories, featured_media }
   * @returns {Promise<object>} { wpPostId, wpPostUrl }
   */
  async createPost(data) {
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await axios.post(
          `${this.wpBaseUrl}/wp-json/wp/v2/posts`,
          data,
          {
            headers: {
              Authorization: this.authHeader,
              'Content-Type': 'application/json',
            },
            timeout: WP_TIMEOUT_MS,
          }
        );

        return {
          wpPostId: response.data.id,
          wpPostUrl: response.data.link || response.data.guid?.rendered || '',
        };
      } catch (err) {
        lastError = err;
        this.logger.warn(`WP post creation attempt ${attempt}/${MAX_RETRIES} failed`, {
          error: err.message,
          status: err.response ? err.response.status : null,
        });

        // Don't retry on auth or validation errors
        if (err.response && (err.response.status === 401 || err.response.status === 403 || err.response.status === 400)) {
          break;
        }
      }
    }

    throw lastError;
  }

  /**
   * Update internal stats counters.
   */
  _updateStats() {
    const today = new Date().toISOString().slice(0, 10);

    if (this.stats._todayDate !== today) {
      this.stats._todayDate = today;
      this.stats.publishedToday = 0;
    }

    this.stats.totalPublished++;
    this.stats.publishedToday++;
    this.stats.lastPublishAt = new Date().toISOString();
  }

  async init() {
    try {
      if (!this.config.WP_URL || !this.config.WP_USERNAME || !this.config.WP_APP_PASSWORD) {
        this.status = 'disabled';
        return;
      }
      this.enabled = true;
      this.status = 'connected';
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
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
      stats: {
        wpUrl: this.wpBaseUrl,
        totalPublished: this.stats.totalPublished,
      }
    };
  }

  async shutdown() {
    this.enabled = false;
    this.status = 'disabled';
  }

  /**
   * Get current publisher statistics.
   *
   * @returns {object}
   */
  getStatus() {
    const today = new Date().toISOString().slice(0, 10);

    // Reset publishedToday if the day has changed since last update
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
