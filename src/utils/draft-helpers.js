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

function fetchHtml(url) {
  return axios.get(url, {
    timeout: 15000,
    maxContentLength: 5 * 1024 * 1024,
    headers: BROWSER_HEADERS,
    maxRedirects: 5,
  }).then(function (res) { return res.data; });
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
    return reader.parse();
  } finally {
    dom.window.close();
  }
}

function extractImageFromHtml(rawHtml, sourceUrl) {
  var dom = new JSDOM(rawHtml, { url: sourceUrl });
  try {
    return extractFeaturedImage(dom.window.document, sourceUrl);
  } finally {
    dom.window.close();
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
  } else {
    db.prepare(`
      UPDATE drafts SET
        extracted_content = COALESCE(source_content_markdown, source_title),
        extraction_status = 'failed',
        extraction_method = NULL,
        is_partial = 0,
        extraction_error = 'All extraction methods failed. Site may require JavaScript rendering.',
        status = 'draft',
        updated_at = datetime('now')
      WHERE id = ?
    `).run(draftId);

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

    // Per-call AI overrides (provider, model)
    var opts = aiOptions || {};
    var result = await rewriter.rewrite(articleObj, clusterObj, opts);

    if (result && (result.html || result.content)) {
      var html = result.html || result.content || '';
      var title = result.title || draft.extracted_title || draft.source_title || '';
      var wordCount = result.wordCount || result.word_count || 0;
      var model = result.aiModel || result.model || 'unknown';
      var provider = result.aiProvider || opts.provider || '';
      var tokensUsed = result.tokensUsed || 0;

      db.prepare(
        "UPDATE drafts SET" +
        "  rewritten_html = ?," +
        "  rewritten_title = ?," +
        "  rewritten_word_count = ?," +
        "  ai_model_used = ?," +
        "  ai_provider = ?," +
        "  ai_tokens_used = ?," +
        "  status = 'ready'," +
        "  updated_at = datetime('now')" +
        " WHERE id = ?"
      ).run(html, title, wordCount, model, provider, tokensUsed, draftId);

      logger.info('draft-helpers', 'Draft ' + draftId + ' rewrite complete (' + wordCount + ' words, ' + model + ')');
    } else {
      throw new Error('Rewriter returned no output');
    }
  } catch (err) {
    db.prepare("UPDATE drafts SET status = 'draft', updated_at = datetime('now') WHERE id = ?").run(draftId);
    logger.error('draft-helpers', 'Draft ' + draftId + ' rewrite failed: ' + err.message);
    throw err;
  }
}

module.exports = {
  extractDraftContent: extractDraftContent,
  rewriteDraftContent: rewriteDraftContent,
};
