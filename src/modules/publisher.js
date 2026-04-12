'use strict';

var axios = require('axios');
var path = require('path');
var { assertSafeUrl, safeAxiosOptions, sanitizeAxiosError } = require('../utils/safe-http');

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

/**
 * Detect the actual image type by inspecting the first bytes of the buffer.
 * Returns one of 'image/png', 'image/jpeg', 'image/gif', 'image/webp', or
 * null if the bytes don't match any supported raster format. This is the
 * defense against URL-extension spoofing (e.g. `.jpg` URL returning SVG).
 */
function sniffImageType(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47 &&
    buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A
  ) {
    return 'image/png';
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg';
  }

  // GIF87a / GIF89a: 47 49 46 38 (37|39) 61
  if (
    buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38 &&
    (buffer[4] === 0x37 || buffer[4] === 0x39) && buffer[5] === 0x61
  ) {
    return 'image/gif';
  }

  // WebP: "RIFF" (52 49 46 46) at 0-3, "WEBP" (57 45 42 50) at 8-11
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

// Map sniffed mime type to a filesystem extension (used to align the
// Content-Disposition filename with the real bytes).
function extForMime(mime) {
  if (mime === 'image/png') return '.png';
  if (mime === 'image/jpeg') return '.jpg';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/webp') return '.webp';
  return '.jpg';
}

/**
 * Sanitize AI-generated HTML before publishing to WordPress.
 */
function sanitizeHtmlForWP(html) {
  if (!html) return '';
  var cleaned = html;

  // Remove document-level wrappers
  cleaned = cleaned
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<\/?html[^>]*>/gi, '')
    .replace(/<\/?head[^>]*>/gi, '')
    .replace(/<\/?body[^>]*>/gi, '')
    .replace(/<meta[^>]*>/gi, '')
    .replace(/<title[^>]*>.*?<\/title>/gi, '');

  // Remove inline styles
  cleaned = cleaned.replace(/\s+style\s*=\s*"[^"]*"/gi, '');
  cleaned = cleaned.replace(/\s+style\s*=\s*'[^']*'/gi, '');

  // Remove class attributes (except faq- and hdf- classes used by the
  // master prompt v2 structured blocks: hdf-in-brief, hdf-body, hdf-faqs,
  // hdf-faq-item — themes can style these on the WordPress side).
  cleaned = cleaned.replace(/\s+class\s*=\s*"(?!faq-|hdf-)[^"]*"/gi, '');
  cleaned = cleaned.replace(/\s+class\s*=\s*'(?!faq-|hdf-)[^']*'/gi, '');

  // Fix orphaned inline elements (not wrapped in block tags)
  var lines = cleaned.split('\n');
  var fixedLines = [];
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var startsWithInline = /^<(strong|em|b|i|a|span|mark|small|sub|sup|code)\b/i.test(line);
    var startsWithBlock = /^<(p|h[1-6]|div|ul|ol|li|blockquote|table|tr|td|th|thead|tbody|figure|figcaption|section|article|nav|header|footer|script|pre|hr)\b/i.test(line);
    var isClosingTag = /^<\/(p|h[1-6]|div|ul|ol|li|blockquote|table|script|pre|section)\s*>/i.test(line);
    var isEmptyLine = !line.replace(/<[^>]+>/g, '').trim();

    if (startsWithInline && !isEmptyLine) {
      fixedLines.push('<p>' + line + '</p>');
    } else if (!startsWithBlock && !isClosingTag && !isEmptyLine && line.length > 5 && !line.startsWith('<!--') && !line.startsWith('<script')) {
      if (line.indexOf('<') === -1 || /^[^<]+</.test(line)) {
        fixedLines.push('<p>' + line + '</p>');
      } else {
        fixedLines.push(line);
      }
    } else {
      fixedLines.push(line);
    }
  }
  cleaned = fixedLines.join('\n');

  // Remove empty paragraphs/headings
  cleaned = cleaned.replace(/<p>\s*<\/p>/gi, '');
  cleaned = cleaned.replace(/<h[1-6]>\s*<\/h[1-6]>/gi, '');

  // Fix double-wrapped paragraphs
  cleaned = cleaned.replace(/<p>\s*<p>/gi, '<p>');
  cleaned = cleaned.replace(/<\/p>\s*<\/p>/gi, '</p>');

  // Convert h1 to h2
  cleaned = cleaned.replace(/<h1(\s|>)/gi, '<h2$1');
  cleaned = cleaned.replace(/<\/h1>/gi, '</h2>');

  // Remove non-schema script tags
  cleaned = cleaned.replace(/<script(?!\s+type\s*=\s*["']application\/ld\+json["'])[^>]*>[\s\S]*?<\/script>/gi, '');

  // Trim excessive whitespace
  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return cleaned;
}

/**
 * Fix alt text on in-content images.
 */
function fixContentImageAlts(html, targetKeyword, title) {
  if (!html) return html;
  var imgCount = 0;
  return html.replace(/<img([^>]*)>/gi, function (match, attrs) {
    imgCount++;
    var altMatch = attrs.match(/alt\s*=\s*["']([^"']*?)["']/i);
    var existingAlt = altMatch ? altMatch[1].trim() : '';
    var isGeneric = !existingAlt || existingAlt === 'image' || existingAlt === 'photo' ||
      existingAlt === 'Featured Image' || /^IMG_?\d+$/i.test(existingAlt) ||
      /^DSC_?\d+$/i.test(existingAlt) || /^\d+\.jpg$/i.test(existingAlt);

    if (isGeneric) {
      var newAlt = targetKeyword
        ? targetKeyword + (imgCount > 1 ? ' - image ' + imgCount : '')
        : (title || 'Article image').slice(0, 100) + (imgCount > 1 ? ' - ' + imgCount : '');
      if (altMatch) {
        var newAttrs = attrs.replace(/alt\s*=\s*["'][^"']*?["']/i, 'alt="' + newAlt.replace(/"/g, '&quot;') + '"');
        return '<img' + newAttrs + '>';
      } else {
        return '<img alt="' + newAlt.replace(/"/g, '&quot;') + '"' + attrs + '>';
      }
    }
    return match;
  });
}

/**
 * Generate SEO-optimized filename for featured image.
 */
function generateSeoFilename(targetKeyword, title, imageUrl) {
  var ext = path.extname(imageUrl || '').toLowerCase().split('?')[0] || '.jpg';
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg'].indexOf(ext) === -1) ext = '.jpg';

  var source = (targetKeyword || title || 'featured-image').trim();
  var slug = source.toLowerCase()
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

  if (slug.length < 5) slug = 'featured-' + Date.now().toString(36);
  return slug + ext;
}

/**
 * Generate SEO-optimized alt text for featured image.
 */
function generateSeoAltText(targetKeyword, title, excerpt) {
  if (targetKeyword && targetKeyword.length > 5) {
    var alt = targetKeyword;
    if (title && title.toLowerCase().indexOf(targetKeyword.toLowerCase()) === -1) {
      var titlePart = title.split(/[,\-|–—:]/).map(function (s) { return s.trim(); }).filter(Boolean)[0] || '';
      if (titlePart && titlePart.length < 60) alt = targetKeyword + ' - ' + titlePart;
    }
    return alt.slice(0, 125);
  }
  if (title) return title.replace(/<[^>]+>/g, '').slice(0, 125);
  return 'Featured news article image';
}

function buildSchemaMarkup(rewrittenArticle, wpPostUrl, siteName, schemaTypes, targetDomain) {
  var schemas = [];
  var types = (schemaTypes || 'NewsArticle,FAQPage').split(',');
  for (var t = 0; t < types.length; t++) types[t] = types[t].trim();

  // NewsArticle
  if (types.indexOf('NewsArticle') !== -1) {
    var publisherUrl = targetDomain ? ('https://' + targetDomain.replace(/^https?:\/\//, '')) : wpPostUrl;
    var newsArticle = {
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      'headline': rewrittenArticle.title || '',
      'description': rewrittenArticle.metaDescription || rewrittenArticle.excerpt || '',
      'datePublished': new Date().toISOString(),
      'dateModified': new Date().toISOString(),
      'author': { '@type': 'Organization', 'name': siteName || 'HDF News' },
      'publisher': { '@type': 'Organization', 'name': siteName || 'HDF News', 'url': publisherUrl },
      'mainEntityOfPage': { '@type': 'WebPage', '@id': wpPostUrl || '' }
    };
    if (rewrittenArticle.targetKeyword) newsArticle.keywords = rewrittenArticle.targetKeyword;
    schemas.push(newsArticle);
  }

  // FAQPage
  if (types.indexOf('FAQPage') !== -1 && rewrittenArticle.faq && Array.isArray(rewrittenArticle.faq) && rewrittenArticle.faq.length > 0) {
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

  // BreadcrumbList
  if (types.indexOf('BreadcrumbList') !== -1) {
    var siteUrl = targetDomain ? ('https://' + targetDomain.replace(/^https?:\/\//, '')) : '';
    if (siteUrl || wpPostUrl) {
      schemas.push({
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        'itemListElement': [
          { '@type': 'ListItem', 'position': 1, 'name': 'Home', 'item': siteUrl || wpPostUrl },
          { '@type': 'ListItem', 'position': 2, 'name': 'News', 'item': (siteUrl || wpPostUrl) + '/news' },
          { '@type': 'ListItem', 'position': 3, 'name': rewrittenArticle.title || 'Article' },
        ],
      });
    }
  }

  // Product
  if (types.indexOf('Product') !== -1) {
    schemas.push({
      '@context': 'https://schema.org',
      '@type': 'Product',
      'name': rewrittenArticle.title || '',
      'description': rewrittenArticle.metaDescription || rewrittenArticle.excerpt || '',
    });
  }

  // Event
  if (types.indexOf('Event') !== -1) {
    schemas.push({
      '@context': 'https://schema.org',
      '@type': 'Event',
      'name': rewrittenArticle.title || '',
      'description': rewrittenArticle.excerpt || '',
      'startDate': new Date().toISOString(),
      'eventStatus': 'https://schema.org/EventScheduled',
      'eventAttendanceMode': 'https://schema.org/OnlineEventAttendanceMode',
    });
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
      var safe1 = sanitizeAxiosError(err1);
      var status1 = safe1.status;
      var msg1 = safe1.data || safe1.message;
      self.logger.warn('publisher', 'Method 1 failed: ' + (status1 || '') + ' ' + msg1);
      errors.push({ method: '?rest_route= + header', status: status1, message: msg1 });

      // If 401 — auth header likely stripped by Nginx
      if (status1 === 401) {
        // Method 2: header-only auth with different URL format
        self.logger.info('publisher', 'WP API Method 2: header auth with alternate URL');
        try {
          var authHeader2 = 'Basic ' + Buffer.from(self.config.WP_USERNAME + ':' + self.config.WP_APP_PASSWORD).toString('base64');
          var url2 = self.config.WP_URL.replace(/\/+$/, '') + '/?rest_route=' + encodeURIComponent(restPath);
          var headers2 = Object.assign({ 'Content-Type': 'application/json', 'Authorization': authHeader2 }, extraHeaders || {});

          var res2 = await axios({ method: method, url: url2, data: data, headers: headers2, timeout: WP_TIMEOUT_MS });
          self.logger.info('publisher', 'Method 2 succeeded (' + res2.status + ')');
          return res2;
        } catch (err2) {
          var safe2 = sanitizeAxiosError(err2);
          var status2 = safe2.status;
          var msg2 = safe2.data || safe2.message;
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
      var safe3 = sanitizeAxiosError(err3);
      var status3 = safe3.status;
      var msg3 = safe3.data || safe3.message;
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
   * @param {object} rewrittenArticle
   * @param {object} cluster
   * @param {object} db
   * @param {AbortSignal} [signal] - optional AbortSignal from pipeline shutdown
   */
  async publish(rewrittenArticle, cluster, db, signal) {
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
        var imageResult = await this.uploadImage(featuredImageUrl, {
          targetKeyword: rewrittenArticle.targetKeyword || '',
          title: rewrittenArticle.title || '',
          excerpt: rewrittenArticle.excerpt || '',
          slug: rewrittenArticle.slug || '',
        }, signal);
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
    var schemaHtml = buildSchemaMarkup(rewrittenArticle, '', siteName, rewrittenArticle.schemaTypes, rewrittenArticle.targetDomain);

    // Step 3: Create the WordPress post — sanitize and optimize content
    var postContent = sanitizeHtmlForWP(rewrittenArticle.content || '');
    postContent = fixContentImageAlts(postContent, rewrittenArticle.targetKeyword || '', rewrittenArticle.title || '');
    if (schemaHtml) {
      postContent += '\n\n' + schemaHtml;
    }

    var postData = {
      title: rewrittenArticle.title,
      slug: rewrittenArticle.slug || '',
      content: postContent,
      excerpt: rewrittenArticle.excerpt,
      status: this.config.WP_POST_STATUS || 'draft',
      author: parseInt(this.config.WP_AUTHOR_ID, 10) || 1,
      categories: [parseInt(this.config.WP_DEFAULT_CATEGORY, 10) || 1],
      featured_media: wpImageId || 0,
      meta: {
        _yoast_wpseo_metadesc: rewrittenArticle.metaDescription || '',
        _yoast_wpseo_focuskw: rewrittenArticle.targetKeyword || '',
        rank_math_description: rewrittenArticle.metaDescription || '',
        rank_math_focus_keyword: rewrittenArticle.targetKeyword || '',
      },
    };

    var postResult = await this.createPost(postData);

    // Step 4: Update schema with actual post URL (non-critical)
    if (postResult.wpPostUrl && schemaHtml) {
      try {
        var updatedSchema = buildSchemaMarkup(rewrittenArticle, postResult.wpPostUrl, siteName, rewrittenArticle.schemaTypes, rewrittenArticle.targetDomain);
        var updatedContent = sanitizeHtmlForWP(rewrittenArticle.content || '') + '\n\n' + updatedSchema;
        await this._wpRequest('post', '/wp/v2/posts/' + postResult.wpPostId, { content: updatedContent });
      } catch (schemaErr) {
        this.logger.warn('publisher', 'Schema URL update failed (non-critical): ' + schemaErr.message);
      }
    }

    // Step 5: Record in the published table (LEGACY — kept for backward compat)
    // The new pipeline records everything in the drafts table.
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
   * Upload an image to WP media library with SEO-optimized filename, alt text, title, caption, description.
   * @param {string} imageUrl
   * @param {object} [seoData]
   * @param {AbortSignal} [signal] - optional AbortSignal from pipeline shutdown
   */
  async uploadImage(imageUrl, seoData, signal) {
    seoData = seoData || {};

    // SSRF pre-flight: block private-range IPs, bad schemes, metadata
    // endpoints, etc. before touching the network.
    try {
      assertSafeUrl(imageUrl);
    } catch (ssrfErr) {
      this.logger.warn('publisher', 'Image upload blocked by SSRF guard: ' + ssrfErr.message);
      throw new Error('Image upload blocked: ' + ssrfErr.message);
    }

    var imageResponse;
    try {
      var fetchOpts = safeAxiosOptions({
        responseType: 'arraybuffer',
        maxContentLength: 10 * 1024 * 1024,
        maxRedirects: 3,
        timeout: 15000,
        headers: { 'User-Agent': 'HDF-News-AutoPub/1.0' },
      });
      if (signal) fetchOpts.signal = signal;
      imageResponse = await axios.get(imageUrl, fetchOpts);
    } catch (fetchErr) {
      this.logger.warn('publisher', 'Image fetch failed: ' + fetchErr.message);
      throw new Error('Image fetch failed: ' + fetchErr.message);
    }

    var imageBuffer = Buffer.from(imageResponse.data);

    // Secondary sanity check on the upstream content-type header. If the
    // server admits it's HTML/XML/SVG, bail out immediately — these can be
    // used to mount stored XSS against WordPress admins.
    var upstreamCt = '';
    if (imageResponse.headers && imageResponse.headers['content-type']) {
      upstreamCt = String(imageResponse.headers['content-type']).toLowerCase();
    }
    if (
      upstreamCt.indexOf('text/html') === 0 ||
      upstreamCt.indexOf('application/xml') === 0 ||
      upstreamCt.indexOf('image/svg+xml') === 0
    ) {
      this.logger.warn('publisher', 'Image upload rejected: disallowed content-type "' + upstreamCt + '" for ' + imageUrl);
      throw new Error('Image upload rejected: disallowed content-type ' + upstreamCt);
    }

    // Authoritative check: inspect the actual bytes. If they don't match
    // a known raster format, reject — NEVER fall back to URL extension.
    var mimeType = sniffImageType(imageBuffer);
    if (!mimeType) {
      this.logger.warn('publisher', 'Image upload rejected: bytes do not match PNG/JPEG/GIF/WebP signature (' + imageUrl + ')');
      throw new Error('Image upload rejected: unrecognized image format');
    }

    var filename = generateSeoFilename(
      seoData.targetKeyword || '',
      seoData.title || '',
      imageUrl
    );
    // Align filename extension with the sniffed type — if the URL said
    // `.jpg` but the bytes are PNG, WordPress must see `.png`.
    var desiredExt = extForMime(mimeType);
    var currentExt = path.extname(filename).toLowerCase();
    if (currentExt !== desiredExt) {
      filename = filename.slice(0, filename.length - currentExt.length) + desiredExt;
    }

    var altText = generateSeoAltText(
      seoData.targetKeyword || '',
      seoData.title || '',
      seoData.excerpt || ''
    );

    this.logger.info('publisher', 'Uploading image: filename="' + filename + '", alt="' + altText.substring(0, 50) + '..."');

    var uploadRes = await this._wpRequest('post', '/wp/v2/media', imageBuffer, {
      'Content-Type': mimeType,
      'Content-Disposition': 'attachment; filename="' + filename + '"',
    });

    // Set ALL media SEO fields
    if (uploadRes.data.id) {
      try {
        var mediaUpdate = {
          alt_text: altText,
          title: seoData.targetKeyword || seoData.title || altText,
          caption: seoData.excerpt ? seoData.excerpt.slice(0, 200) : '',
          description: 'Featured image for: ' + (seoData.title || '').slice(0, 200),
        };
        await this._wpRequest('post', '/wp/v2/media/' + uploadRes.data.id, mediaUpdate);
      } catch (e) {
        this.logger.warn('publisher', 'Failed to set image SEO data: ' + e.message);
      }
    }

    return {
      mediaId: uploadRes.data.id,
      mediaUrl: uploadRes.data.source_url || (uploadRes.data.guid && uploadRes.data.guid.rendered) || '',
      filename: filename,
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

  /**
   * Update an existing WordPress post via the REST API.
   */
  async updatePost(postId, data) {
    var response = await this._wpRequest('post', '/wp/v2/posts/' + postId, data);

    if (!response.data || !response.data.id) {
      throw new Error('WordPress update returned no post ID. Response status: ' + response.status);
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
