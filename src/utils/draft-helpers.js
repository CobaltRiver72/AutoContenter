'use strict';

var axios = require('axios');
var { JSDOM } = require('jsdom');
var { Readability } = require('@mozilla/readability');

/**
 * Extract full body content for a single draft.
 * Uses the existing ContentExtractor module if available,
 * otherwise does a direct fetch + Readability parse.
 *
 * @param {number} draftId
 * @param {object} deps - { db, logger, extractor }
 */
async function extractDraftContent(draftId, deps) {
  var db = deps.db;
  var logger = deps.logger;
  var extractor = deps.extractor;

  var draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(draftId);
  if (!draft) return;

  db.prepare("UPDATE drafts SET extraction_status = 'extracting', updated_at = datetime('now') WHERE id = ?").run(draftId);

  try {
    // Try existing ContentExtractor module first
    if (extractor && extractor.enabled && typeof extractor._fetchAndExtract === 'function') {
      var extracted = await extractor._fetchAndExtract(draft.source_url);

      if (extracted && extracted.textContent && extracted.textContent.length > 100) {
        db.prepare(`
          UPDATE drafts SET
            extracted_content = ?,
            extracted_title = ?,
            extracted_excerpt = ?,
            extracted_byline = ?,
            extraction_status = 'success',
            status = 'draft',
            updated_at = datetime('now')
          WHERE id = ?
        `).run(extracted.textContent, extracted.title, extracted.excerpt, extracted.byline, draftId);

        logger.info('draft-helpers', 'Draft ' + draftId + ': Extracted ' + extracted.textContent.length + ' chars from ' + draft.source_domain);
        return;
      }
    }

    // Fallback: Direct fetch with jsdom + Readability
    var response = await axios.get(draft.source_url, {
      timeout: 15000,
      maxContentLength: 5 * 1024 * 1024,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,hi;q=0.8',
      },
      maxRedirects: 5,
    });

    var dom = new JSDOM(response.data, { url: draft.source_url });
    try {
      var reader = new Readability(dom.window.document, { charThreshold: 100 });
      var article = reader.parse();

      if (article && article.textContent && article.textContent.length > 100) {
        db.prepare(`
          UPDATE drafts SET
            extracted_content = ?,
            extracted_title = ?,
            extracted_excerpt = ?,
            extracted_byline = ?,
            extraction_status = 'success',
            status = 'draft',
            updated_at = datetime('now')
          WHERE id = ?
        `).run(article.textContent, article.title, article.excerpt, article.byline, draftId);

        logger.info('draft-helpers', 'Draft ' + draftId + ': Fallback extracted ' + article.textContent.length + ' chars');
      } else {
        // Use Firehose content as fallback
        db.prepare(`
          UPDATE drafts SET
            extracted_content = COALESCE(source_content_markdown, source_title),
            extraction_status = 'fallback',
            status = 'draft',
            updated_at = datetime('now')
          WHERE id = ?
        `).run(draftId);

        logger.warn('draft-helpers', 'Draft ' + draftId + ': Extraction returned insufficient content, using fallback');
      }
    } finally {
      dom.window.close();
    }
  } catch (err) {
    db.prepare(`
      UPDATE drafts SET
        extracted_content = COALESCE(source_content_markdown, source_title),
        extraction_status = 'failed',
        extraction_error = ?,
        status = 'draft',
        updated_at = datetime('now')
      WHERE id = ?
    `).run(err.message, draftId);

    logger.warn('draft-helpers', 'Draft ' + draftId + ': Extraction failed: ' + err.message);
  }
}

/**
 * Rewrite draft content using AI.
 *
 * @param {number} draftId
 * @param {string} customPrompt - Optional custom instructions
 * @param {object} deps - { db, logger, rewriter }
 */
async function rewriteDraftContent(draftId, customPrompt, deps) {
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

    var result = await rewriter.rewrite(articleObj, clusterObj);

    if (result && (result.html || result.content)) {
      var html = result.html || result.content || '';
      var title = result.title || draft.extracted_title || draft.source_title || '';
      var wordCount = result.wordCount || result.word_count || 0;
      var model = result.model || result.aiModel || 'unknown';

      db.prepare(`
        UPDATE drafts SET
          rewritten_html = ?,
          rewritten_title = ?,
          rewritten_word_count = ?,
          ai_model_used = ?,
          status = 'ready',
          updated_at = datetime('now')
        WHERE id = ?
      `).run(html, title, wordCount, model, draftId);

      logger.info('draft-helpers', 'Draft ' + draftId + ' rewrite complete (' + wordCount + ' words)');
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
