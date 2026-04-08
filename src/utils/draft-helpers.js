'use strict';

var axios = require('axios');
var { JSDOM } = require('jsdom');
var { Readability } = require('@mozilla/readability');

// ─── Featured Image Extraction ──────────────────────────────────────────

function resolveUrl(url, baseUrl) {
  try {
    if (!url) return null;
    url = url.trim();
    if (url.indexOf('//') === 0) return 'https:' + url;
    if (url.indexOf('http') === 0) return url;
    return new URL(url, baseUrl).href;
  } catch (e) {
    return url;
  }
}

function extractFeaturedImage(document, sourceUrl) {
  // Priority 1: Open Graph image
  var ogImage = document.querySelector('meta[property="og:image"]');
  if (ogImage && ogImage.getAttribute('content')) {
    return resolveUrl(ogImage.getAttribute('content'), sourceUrl);
  }

  // Priority 2: Twitter card image
  var twitterImage = document.querySelector('meta[name="twitter:image"]');
  if (twitterImage && twitterImage.getAttribute('content')) {
    return resolveUrl(twitterImage.getAttribute('content'), sourceUrl);
  }

  // Priority 3: Schema.org image in JSON-LD
  var jsonLdScripts = document.querySelectorAll('script[type="application/ld+json"]');
  for (var s = 0; s < jsonLdScripts.length; s++) {
    try {
      var data = JSON.parse(jsonLdScripts[s].textContent);
      var schemaImage = (data.image && data.image.url) || (Array.isArray(data.image) && (data.image[0].url || data.image[0])) || data.image || data.thumbnailUrl;
      if (schemaImage && typeof schemaImage === 'string') {
        return resolveUrl(schemaImage, sourceUrl);
      }
    } catch (e) { /* skip invalid JSON-LD */ }
  }

  // Priority 4: First large image in article body
  var articleImages = document.querySelectorAll('article img, .article-body img, .story-body img, [role="main"] img, .post-content img');
  for (var i = 0; i < articleImages.length; i++) {
    var img = articleImages[i];
    var src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
    if (src && src.indexOf('logo') === -1 && src.indexOf('icon') === -1 && src.indexOf('avatar') === -1 && src.indexOf('ads') === -1) {
      var width = parseInt(img.getAttribute('width') || '0', 10);
      if (width === 0 || width >= 300) {
        return resolveUrl(src, sourceUrl);
      }
    }
  }

  // Priority 5: Any meta image
  var metaImage = document.querySelector('meta[name="image"]') || document.querySelector('link[rel="image_src"]');
  if (metaImage) {
    var content = metaImage.getAttribute('content') || metaImage.getAttribute('href');
    if (content) return resolveUrl(content, sourceUrl);
  }

  return null;
}

// ─── HTTP Helpers ───────────────────────────────────────────────────────

var BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
  'Accept-Encoding': 'gzip, deflate',
  'Cache-Control': 'no-cache',
  'Sec-Ch-Ua': '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile': '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
  'Referer': 'https://www.google.com/',
};

async function fetchHtml(url) {
  var attempts = 0;
  var maxAttempts = 2;
  var lastErr = null;

  while (attempts < maxAttempts) {
    attempts++;
    try {
      var res = await axios.get(url, {
        timeout: attempts === 1 ? 15000 : 25000,
        maxContentLength: 5 * 1024 * 1024,
        headers: BROWSER_HEADERS,
        maxRedirects: 5,
        validateStatus: function (status) { return status < 400; },
      });

      var html = res.data;
      if (!html || typeof html !== 'string') return null;

      // Handle meta-refresh redirects (some sites use these)
      var metaMatch = html.match(/<meta[^>]*http-equiv=["']refresh["'][^>]*content=["']\d+;\s*url=([^"']+)["']/i);
      if (metaMatch && metaMatch[1] && html.length < 5000) {
        var redirectUrl = metaMatch[1];
        if (redirectUrl.startsWith('/')) {
          var urlObj = new URL(url);
          redirectUrl = urlObj.origin + redirectUrl;
        }
        var redirectRes = await axios.get(redirectUrl, {
          timeout: 15000,
          maxContentLength: 5 * 1024 * 1024,
          headers: BROWSER_HEADERS,
          maxRedirects: 5,
        });
        if (redirectRes.data && typeof redirectRes.data === 'string') {
          return redirectRes.data;
        }
      }

      return html;
    } catch (err) {
      lastErr = err;
      if (attempts < maxAttempts && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.code === 'ECONNRESET')) {
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('fetchHtml failed after ' + maxAttempts + ' attempts');
}

async function fetchFromCache(url) {
  // Try Google Web Cache
  var googleCacheUrl = 'https://webcache.googleusercontent.com/search?q=cache:' + encodeURIComponent(url);
  try {
    var html = await fetchHtml(googleCacheUrl);
    if (html && html.length > 5000) return html;
  } catch (e) { /* continue to next fallback */ }

  // Try Archive.org latest snapshot
  var archiveUrl = 'https://web.archive.org/web/2/' + url;
  try {
    var archiveHtml = await fetchHtml(archiveUrl);
    if (archiveHtml && archiveHtml.length > 5000) return archiveHtml;
  } catch (e) { /* continue */ }

  return null;
}

// ─── Parsing Helpers ────────────────────────────────────────────────────

function parseWithReadability(rawHtml, sourceUrl) {
  var dom = new JSDOM(rawHtml, { url: sourceUrl });
  try {
    var reader = new Readability(dom.window.document, { charThreshold: 100 });
    var result = reader.parse();

    if (result && result.textContent && result.textContent.length > 100) {
      return result;
    }

    // Readability failed — try manual extraction from article/main/body <p> tags
    var doc = dom.window.document;
    var containers = doc.querySelectorAll('article, [role="main"], main, .article-body, .story-body, .post-content, .entry-content, .article-content');
    var paragraphs = [];

    if (containers.length > 0) {
      for (var c = 0; c < containers.length; c++) {
        var ps = containers[c].querySelectorAll('p');
        for (var p = 0; p < ps.length; p++) {
          var text = ps[p].textContent.trim();
          if (text.length > 30) paragraphs.push(text);
        }
      }
    }

    // If no article container found, try all <p> tags in body
    if (paragraphs.length < 3) {
      paragraphs = [];
      var allPs = doc.querySelectorAll('body p');
      for (var a = 0; a < allPs.length; a++) {
        var pText = allPs[a].textContent.trim();
        if (pText.length > 40) paragraphs.push(pText);
      }
    }

    if (paragraphs.length >= 2) {
      var combinedText = paragraphs.join('\n\n');
      if (combinedText.length > 100) {
        var titleEl = doc.querySelector('h1') || doc.querySelector('title');
        return {
          title: titleEl ? titleEl.textContent.trim() : null,
          textContent: combinedText,
          content: combinedText,
          excerpt: paragraphs[0].substring(0, 200),
          byline: null,
        };
      }
    }

    return null;
  } finally {
    if (dom && dom.window) dom.window.close();
    dom = null;
  }
}

function extractImageFromHtml(rawHtml, sourceUrl) {
  var dom = new JSDOM(rawHtml, { url: sourceUrl });
  try {
    var result = extractFeaturedImage(dom.window.document, sourceUrl);
    return result;
  } finally {
    if (dom && dom.window) dom.window.close();
    dom = null;  // Allow GC to collect immediately
  }
}

function buildFromFirehoseData(draft) {
  var parts = [];

  if (draft.source_title) {
    parts.push(draft.source_title);
  }

  var md = draft.source_content_markdown;
  if (md && md !== '{"chunks":[]}') {
    try {
      var parsed = JSON.parse(md);
      if (parsed.chunks && parsed.chunks.length > 0) {
        var chunkText = '';
        for (var i = 0; i < parsed.chunks.length; i++) {
          var chunk = parsed.chunks[i];
          var text = '';
          if (typeof chunk === 'string') text = chunk;
          else if (chunk && chunk.text) text = chunk.text;
          else if (chunk && chunk.content) text = chunk.content;
          else if (chunk && chunk.value) text = chunk.value;
          if (text) chunkText += (chunkText ? '\n\n' : '') + text;
        }
        if (chunkText.length > 50) parts.push(chunkText);
      }
    } catch (e) {
      // Not valid JSON — use as raw text
      if (md.length > 100) parts.push(md);
    }
  }

  var content = parts.join('\n\n');
  return {
    content: content || null,
    isPartial: true,
    charCount: content ? content.length : 0,
  };
}

// ─── Domain Stats Tracking ─────────────────────────────────────────────

function updateDomainStats(db, domain, success, method) {
  if (!db || !domain) return;
  try {
    var existing = db.prepare('SELECT * FROM domains_config WHERE domain = ?').get(domain);
    if (!existing) {
      db.prepare(
        "INSERT INTO domains_config (domain, total_attempts, total_successes, total_failures, success_rate, last_attempt_at, last_success_at, preferred_method) " +
        "VALUES (?, 1, ?, ?, ?, datetime('now'), ?, ?)"
      ).run(domain, success ? 1 : 0, success ? 0 : 1, success ? 1.0 : 0.0, success ? new Date().toISOString() : null, method || null);
    } else {
      var newAttempts = existing.total_attempts + 1;
      var newSuccesses = existing.total_successes + (success ? 1 : 0);
      var newRate = newSuccesses / newAttempts;
      db.prepare(
        "UPDATE domains_config SET total_attempts = ?, total_successes = ?, total_failures = total_failures + ?, " +
        "success_rate = ?, last_attempt_at = datetime('now'), " +
        "last_success_at = CASE WHEN ? THEN datetime('now') ELSE last_success_at END, " +
        "preferred_method = COALESCE(?, preferred_method), updated_at = datetime('now') WHERE domain = ?"
      ).run(newAttempts, newSuccesses, success ? 0 : 1, newRate, success ? 1 : 0, method || null, domain);
    }
  } catch (e) { /* non-critical */ }
}

// ─── AI Output Validation ──────────────────────────────────────────────

var REFUSAL_PATTERNS = [
  /I (?:cannot|can't|am unable to|won't|will not) (?:write|create|generate|produce|rewrite)/i,
  /as an AI/i,
  /I'm sorry,? (?:but )?I/i,
  /I apologize,? (?:but )?I/i,
  /against my (?:guidelines|policy|programming)/i,
];

function validateRewriteOutput(html, originalContent) {
  var errors = [];
  var warnings = [];

  var text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  var wordCount = text ? text.split(' ').length : 0;

  // Min word count
  if (wordCount < 50) {
    errors.push('Output too short: ' + wordCount + ' words (minimum 50)');
  } else if (wordCount < 150) {
    warnings.push('Output is short: ' + wordCount + ' words');
  }

  // Not identical to original
  if (originalContent) {
    var origText = (originalContent || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text && origText && text === origText) {
      errors.push('Output is identical to original content');
    }
  }

  // AI refusal patterns
  for (var p = 0; p < REFUSAL_PATTERNS.length; p++) {
    if (REFUSAL_PATTERNS[p].test(text)) {
      errors.push('AI refusal detected in output');
      break;
    }
  }

  // No script tags
  if (/<script[^>]*>/i.test(html)) {
    errors.push('Output contains <script> tags');
  }

  // HTML structure
  if (html.indexOf('<p') === -1 && html.indexOf('<h') === -1 && wordCount > 100) {
    warnings.push('No HTML paragraph or heading tags found');
  }

  // Check for raw HTML entities (AI escaped HTML instead of writing tags)
  if (html.indexOf('&lt;strong&gt;') !== -1 || html.indexOf('&lt;p&gt;') !== -1 ||
      html.indexOf('&lt;h2&gt;') !== -1 || html.indexOf('&lt;em&gt;') !== -1) {
    warnings.push('HTML entities found where real tags expected — AI may have escaped HTML');
  }

  // Check for h1 tags (should be h2+ in article body)
  if (/<h1[\s>]/i.test(html)) {
    warnings.push('Content contains <h1> tags — should use <h2> for article body headings');
  }

  // Check for markdown leaking into HTML output
  if (html.indexOf('## ') !== -1 || html.indexOf('**') !== -1 || html.indexOf('```') !== -1) {
    warnings.push('Markdown syntax detected in HTML output — AI may have mixed formats');
  }

  return {
    valid: errors.length === 0,
    errors: errors,
    warnings: warnings,
    wordCount: wordCount,
  };
}

// ─── Content Extraction ─────────────────────────────────────────────────

/**
 * Extract full body content + featured image for a single draft.
 * Uses a 3-layer fallback: direct fetch → cache/archive → firehose data.
 *
 * @param {number} draftId
 * @param {object} deps - { db, logger }
 */
async function extractDraftContent(draftId, deps) {
  var db = deps.db;
  var logger = deps.logger;

  var draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
  if (!draft) return;

  db.prepare("UPDATE drafts SET extraction_status = 'extracting', updated_at = datetime('now') WHERE id = ?").run(draftId);

  var content = null;
  var title = null;
  var excerpt = null;
  var byline = null;
  var featuredImage = null;
  var extractionMethod = null;
  var isPartial = 0;

  // ── LAYER 1: Direct fetch with browser headers ──
  try {
    logger.info('draft-helpers', 'Draft ' + draftId + ': Layer 1 — direct fetch for ' + draft.source_domain);
    var rawHtml = await fetchHtml(draft.source_url);

    if (rawHtml && rawHtml.length > 2000) {
      featuredImage = extractImageFromHtml(rawHtml, draft.source_url);

      var article = parseWithReadability(rawHtml, draft.source_url);
      if (article && article.textContent && article.textContent.length > 100) {
        content = article.textContent;
        title = article.title;
        excerpt = article.excerpt;
        byline = article.byline;
        extractionMethod = 'direct';
        logger.info('draft-helpers', 'Draft ' + draftId + ': Layer 1 success — ' + content.length + ' chars' + (featuredImage ? ' + image' : ''));
      } else {
        logger.info('draft-helpers', 'Draft ' + draftId + ': Layer 1 — HTML fetched (' + rawHtml.length + ' chars) but Readability returned ' + (article ? (article.textContent || '').length + ' chars (too short)' : 'null'));
      }
    }
  } catch (err) {
    logger.info('draft-helpers', 'Draft ' + draftId + ': Layer 1 failed — ' + err.message);
  }

  // ── LAYER 2: Google Cache / Archive.org fallback ──
  if (!content) {
    try {
      logger.info('draft-helpers', 'Draft ' + draftId + ': Layer 2 — cache/archive fallback');
      var cachedHtml = await fetchFromCache(draft.source_url);

      if (cachedHtml) {
        if (!featuredImage) {
          featuredImage = extractImageFromHtml(cachedHtml, draft.source_url);
        }

        var cachedArticle = parseWithReadability(cachedHtml, draft.source_url);
        if (cachedArticle && cachedArticle.textContent && cachedArticle.textContent.length > 100) {
          content = cachedArticle.textContent;
          title = cachedArticle.title;
          excerpt = cachedArticle.excerpt;
          byline = cachedArticle.byline;
          extractionMethod = 'cache';
          logger.info('draft-helpers', 'Draft ' + draftId + ': Layer 2 success — ' + content.length + ' chars');
        }
      }
    } catch (err) {
      logger.info('draft-helpers', 'Draft ' + draftId + ': Layer 2 failed — ' + err.message);
    }
  }

  // ── LAYER 3: Build from Firehose data ──
  if (!content) {
    logger.info('draft-helpers', 'Draft ' + draftId + ': Layer 3 — building from Firehose data');
    var firehoseResult = buildFromFirehoseData(draft);

    if (firehoseResult.content && firehoseResult.content.length > 50) {
      content = firehoseResult.content;
      extractionMethod = 'firehose';
      isPartial = 1;
      logger.info('draft-helpers', 'Draft ' + draftId + ': Layer 3 — ' + firehoseResult.charCount + ' chars (partial)');
    }
  }

  // ── SAVE RESULT ──
  if (content) {
    db.prepare(`
      UPDATE drafts SET
        extracted_content = ?,
        extracted_title = ?,
        extracted_excerpt = ?,
        extracted_byline = ?,
        featured_image = COALESCE(?, featured_image),
        extraction_status = ?,
        extraction_method = ?,
        is_partial = ?,
        error_message = NULL,
        status = 'draft',
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      content,
      title || draft.source_title,
      excerpt,
      byline,
      featuredImage,
      isPartial ? 'fallback' : 'success',
      extractionMethod,
      isPartial,
      draftId
    );
    updateDomainStats(db, draft.source_domain, true, extractionMethod);
  } else {
    var extractErr = 'All extraction methods failed for ' + draft.source_domain + '. Site may require JavaScript rendering or has anti-bot protection.';

    // Don't save useless JSON as extracted content — use title only
    var fallbackContent = null;
    var rawMd = draft.source_content_markdown;
    if (rawMd && rawMd.length > 100) {
      try {
        var parsedMd = JSON.parse(rawMd);
        if (parsedMd.chunks && parsedMd.chunks.length > 0) {
          fallbackContent = rawMd;
        }
      } catch (e) {
        // Not JSON — it's raw text, use it if substantial
        if (rawMd.length > 200) {
          fallbackContent = rawMd;
        }
      }
    }

    if (!fallbackContent) {
      fallbackContent = draft.source_title || 'No content extracted';
    }

    db.prepare(
      "UPDATE drafts SET " +
      "extracted_content = ?, " +
      "extraction_status = 'failed', " +
      "extraction_method = NULL, " +
      "is_partial = 0, " +
      "extraction_error = ?, " +
      "error_message = ?, " +
      "retry_count = retry_count + 1, " +
      "last_error_at = datetime('now'), " +
      "failed_permanent = CASE WHEN retry_count + 1 >= COALESCE(max_retries, 3) THEN 1 ELSE 0 END, " +
      "status = CASE WHEN retry_count + 1 >= COALESCE(max_retries, 3) THEN 'failed' ELSE 'fetching' END, " +
      "updated_at = datetime('now') " +
      "WHERE id = ?"
    ).run(fallbackContent, extractErr, extractErr, draftId);
    updateDomainStats(db, draft.source_domain, false, null);

    logger.warn('draft-helpers', 'Draft ' + draftId + ': All extraction layers failed for ' + draft.source_domain);
  }
}

/**
 * Rewrite draft content using AI.
 *
 * @param {number} draftId
 * @param {string} customPrompt - Optional custom instructions
 * @param {object} deps - { db, logger, rewriter }
 */
async function rewriteDraftContent(draftId, customPrompt, deps, aiOptions) {
  var db = deps.db;
  var logger = deps.logger;
  var rewriter = deps.rewriter;

  var draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
  if (!draft) return;

  var content = draft.extracted_content || draft.source_content_markdown || draft.source_title;
  if (!content) {
    db.prepare("UPDATE drafts SET status = 'draft', updated_at = datetime('now') WHERE id = ?").run(draftId);
    return;
  }

  db.prepare("UPDATE drafts SET status = 'rewriting', updated_at = datetime('now') WHERE id = ?").run(draftId);

  try {
    if (!rewriter || !rewriter.enabled) {
      throw new Error('No AI rewriter configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY in Settings.');
    }

    // Build a pseudo-article object for the rewriter
    var articleObj = {
      title: draft.extracted_title || draft.source_title || 'Untitled',
      content_markdown: content,
      url: draft.source_url,
      domain: draft.source_domain,
    };

    // Build a pseudo-cluster with custom instructions
    var clusterObj = {
      topic: draft.target_keyword || draft.extracted_title || draft.source_title || 'News',
      articles: [articleObj],
      customPrompt: customPrompt || '',
      targetDomain: draft.target_domain || '',
      targetPlatform: draft.target_platform || 'blogspot',
      targetLanguage: draft.target_language || 'en+hi',
      schemaTypes: draft.schema_types || 'NewsArticle,FAQPage,BreadcrumbList',
    };

    // Per-call AI overrides (provider, model) + draft settings
    var opts = aiOptions || {};
    opts.targetKeyword = opts.targetKeyword || draft.target_keyword || '';
    opts.targetDomain = opts.targetDomain || draft.target_domain || '';
    opts.language = opts.language || draft.target_language || 'en+hi';
    opts.schemaTypes = opts.schemaTypes || draft.schema_types || 'NewsArticle,FAQPage,BreadcrumbList';
    opts.customPrompt = opts.customPrompt || draft.custom_ai_instructions || customPrompt || '';

    // Use rewriteSimple for draft content (returns HTML), falling back to rewrite (returns structured JSON)
    var result;
    if (typeof rewriter.rewriteSimple === 'function') {
      result = await rewriter.rewriteSimple(content, opts.customPrompt || null, opts);
    } else {
      result = await rewriter.rewrite(articleObj, clusterObj, opts);
    }

    // Handle both response formats
    var html = result.rewrittenContent || result.html || result.content || '';
    var title = result.title || draft.extracted_title || draft.source_title || '';
    var wordCount = result.wordCount || result.word_count || 0;
    var model = result.model || result.aiModel || 'unknown';
    var provider = result.provider || result.aiProvider || opts.provider || '';
    var tokensUsed = result.tokensUsed || 0;
    var faqData = result.faq || result.faqs || [];

    // Validate AI output
    var validation = validateRewriteOutput(html, content);
    if (!validation.valid) {
      throw new Error('AI output validation failed: ' + validation.errors.join('; '));
    }

    // Use validated word count if rewriter didn't provide one
    if (!wordCount && validation.wordCount) {
      wordCount = validation.wordCount;
    }

    if (validation.warnings.length > 0) {
      logger.warn('draft-helpers', 'Draft ' + draftId + ' rewrite warnings: ' + validation.warnings.join('; '));
    }

    db.prepare(
      "UPDATE drafts SET" +
      "  rewritten_html = ?," +
      "  rewritten_title = ?," +
      "  rewritten_word_count = ?," +
      "  ai_model_used = ?," +
      "  ai_provider = ?," +
      "  ai_tokens_used = ?," +
      "  faq_json = ?," +
      "  error_message = NULL," +
      "  status = 'ready'," +
      "  updated_at = datetime('now')" +
      " WHERE id = ?"
    ).run(html, title, wordCount, model, provider, tokensUsed, faqData.length > 0 ? JSON.stringify(faqData) : null, draftId);

    logger.info('draft-helpers', 'Draft ' + draftId + ' rewrite complete (' + wordCount + ' words, ' + model + ')');
  } catch (err) {
    // Track retry count and error on failure
    db.prepare(
      "UPDATE drafts SET" +
      "  retry_count = retry_count + 1," +
      "  error_message = ?," +
      "  last_error_at = datetime('now')," +
      "  failed_permanent = CASE WHEN retry_count + 1 >= COALESCE(max_retries, 3) THEN 1 ELSE 0 END," +
      "  status = CASE WHEN retry_count + 1 >= COALESCE(max_retries, 3) THEN 'failed' ELSE 'draft' END," +
      "  updated_at = datetime('now')" +
      " WHERE id = ?"
    ).run(err.message, draftId);
    logger.error('draft-helpers', 'Draft ' + draftId + ' rewrite failed: ' + err.message);
    throw err;
  }
}

module.exports = {
  extractDraftContent: extractDraftContent,
  rewriteDraftContent: rewriteDraftContent,
  validateRewriteOutput: validateRewriteOutput,
  updateDomainStats: updateDomainStats,
};
