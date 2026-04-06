'use strict';

const axios = require('axios');

// Timeout for AI API calls (30 seconds)
const AI_TIMEOUT_MS = 60000;

// Max retries for each provider before giving up
const MAX_RETRIES = 2;

/**
 * Builds the rewrite prompt for both Claude and OpenAI.
 *
 * @param {object} article  - The primary article from the cluster
 * @param {object} cluster  - The full cluster object (with articles array)
 * @returns {string}
 */
function buildPrompt(article, cluster) {
  // Trending context block
  var trendingContext = '';
  if (cluster.trends_boosted) {
    trendingContext =
      'TRENDING CONTEXT: This story is currently trending on Google Trends in India.\n' +
      'Trend Topic: ' + (cluster.trends_topic || 'N/A') + '\n' +
      'Related Queries: ' + (cluster.trends_queries || 'N/A') + '\n' +
      'Use this trending momentum — weave the trend topic into the headline and opening paragraph.\n\n';
  }

  // Build source articles block with extracted content
  var sourceArticles = '';
  var allArticles = (cluster.articles && Array.isArray(cluster.articles)) ? cluster.articles : [article];

  for (var i = 0; i < allArticles.length; i++) {
    var a = allArticles[i];
    var content = a.extracted_content || a.content_markdown || '';
    if (content && content.length > 3000) {
      content = content.substring(0, 3000) + '\n...[truncated]';
    }

    sourceArticles += '\n--- SOURCE ' + (i + 1) + ' ---\n';
    sourceArticles += 'Title: ' + (a.extracted_title || a.title || 'Untitled') + '\n';
    sourceArticles += 'URL: ' + (a.url || '') + '\n';
    sourceArticles += 'Domain: ' + (a.domain || '') + '\n';
    if (a.extracted_byline) {
      sourceArticles += 'Byline: ' + a.extracted_byline + '\n';
    }
    sourceArticles += 'Content:\n' + (content || '[Content not available]') + '\n';
  }

  // Determine article category for tailored instructions
  var category = '';
  if (article.page_category) {
    category = article.page_category;
  }

  return 'You are a senior editor at a leading Indian digital news publication. You produce high-quality, SEO-optimized articles that rank on Google and get featured on Google Discover.\n\n' +

  'TASK: Write a completely original, comprehensive news article by synthesizing facts from ALL source articles below. Do NOT paraphrase any single source. Combine facts, quotes, data, and context from multiple sources into a new, authoritative narrative.\n\n' +

  trendingContext +

  'SEO REQUIREMENTS:\n' +
  '1. HEADLINE: Write a compelling, click-worthy headline (55-65 characters). Include the primary keyword naturally. Use power words (Revealed, Confirmed, Breaking, Official, etc.).\n' +
  '2. SLUG: URL-friendly slug (lowercase, hyphens, under 60 chars). Include primary keyword.\n' +
  '3. EXCERPT: Google Discover-optimized summary (2 sentences, under 160 chars). Must entice clicks.\n' +
  '4. META DESCRIPTION: Unique meta description (under 155 chars). Include primary keyword in first 60 chars.\n' +
  '5. TARGET KEYWORD: Identify the best long-tail keyword to target (e.g., "OnePlus Nord 6 price in India April 2026"). Prefer date/event-specific keywords with low competition.\n\n' +

  'CONTENT STRUCTURE (800-1200 words):\n' +
  '1. Opening paragraph: Lead with the most newsworthy fact (who, what, when, where, why). Hook the reader in the first sentence. Include the target keyword naturally.\n' +
  '2. Key Details section (H2): Expand on the core facts with data, quotes, and context.\n' +
  '3. Analysis/Impact section (H2): What does this mean? Why does it matter to Indian readers?\n' +
  '4. Additional Context section (H2): Background, history, comparisons, or expert opinions.\n' +
  '5. What\'s Next section (H2): Future implications, upcoming events, or expected developments.\n' +
  '6. Each H2 subheading should contain a keyword variation or related search query.\n' +
  '7. Use short paragraphs (2-3 sentences each).\n' +
  '8. Include bullet points or numbered lists where appropriate.\n' +
  '9. Naturally mention Indian context (₹ prices, IST times, Indian cities/states, Hindi terms in parentheses where relevant).\n\n' +

  'FAQ SECTION:\n' +
  'Generate 5-7 FAQ questions and answers based on the article content. These should:\n' +
  '- Target "People Also Ask" queries related to the topic\n' +
  '- Include long-tail keyword variations\n' +
  '- Be genuine questions a reader would ask\n' +
  '- Have concise, factual answers (2-3 sentences each)\n' +
  '- Where appropriate, include a Hindi translation of the question in parentheses\n\n' +

  'KEYWORD PLACEMENT (target 15-20 natural mentions):\n' +
  '- Title/H1, meta description, slug\n' +
  '- First paragraph, last paragraph\n' +
  '- At least 2 of the H2 subheadings\n' +
  '- FAQ questions\n' +
  '- Do NOT keyword-stuff — every mention must read naturally\n\n' +

  'HTML OUTPUT RULES:\n' +
  '- Output clean HTML (no <html>, <head>, <body> tags)\n' +
  '- Start with the first <p> tag\n' +
  '- Use <h2> for subheadings (NOT <h1>)\n' +
  '- Use <strong> for emphasis, <ul>/<ol> for lists\n' +
  '- For FAQ section: use <h2>Frequently Asked Questions</h2> then <div class="faq-item"><h3>Question?</h3><p>Answer.</p></div> pattern\n' +
  '- Do NOT include inline styles or CSS\n' +
  '- Do NOT include <script> tags\n\n' +

  'SOURCE ARTICLES:\n' +
  sourceArticles + '\n\n' +

  'OUTPUT FORMAT (respond in valid JSON only, no markdown code fences):\n' +
  '{\n' +
  '  "title": "SEO-optimized headline",\n' +
  '  "slug": "url-friendly-slug",\n' +
  '  "excerpt": "Google Discover summary under 160 chars",\n' +
  '  "meta_description": "Meta description under 155 chars",\n' +
  '  "target_keyword": "primary long-tail keyword",\n' +
  '  "related_keywords": ["keyword 2", "keyword 3", "keyword 4"],\n' +
  '  "content": "<p>Full article HTML with H2s, lists, FAQ section...</p>",\n' +
  '  "faq": [\n' +
  '    {"question": "Q1?", "answer": "A1."},\n' +
  '    {"question": "Q2?", "answer": "A2."}\n' +
  '  ],\n' +
  '  "word_count": 850\n' +
  '}';
}

/**
 * Safely parse the AI response text as JSON.
 * Handles cases where the response contains markdown code fences.
 *
 * @param {string} text - Raw text from the AI response
 * @returns {object}
 */
function parseAIResponse(text) {
  let cleaned = text.trim();

  // Strip markdown code fences if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  return JSON.parse(cleaned);
}

class ArticleRewriter {
  /**
   * @param {object} config - App config from getConfig()
   * @param {object} logger - Winston logger instance
   */
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;

    // Module independence
    this.enabled = false;
    this.status = 'disabled';
    this.error = null;

    // Stats tracking
    this.stats = {
      totalRewrites: 0,
      claudeCount: 0,
      openaiCount: 0,
      lastRewriteAt: null,
      totalTokens: 0,
    };
  }

  /**
   * Rewrite an article using the configured AI provider with optional fallback.
   *
   * @param {object} article  - The primary article { title, url, content_markdown, ... }
   * @param {object} cluster  - The cluster object { articles, trends_boosted, ... }
   * @param {object} [options] - Per-call overrides { provider, model }
   * @returns {Promise<object>} { title, content, excerpt, metaDescription, slug, aiModel, aiProvider, tokensUsed }
   */
  async rewrite(article, cluster, options) {
    var opts = options || {};
    var { getConfig } = require('../utils/config');
    var freshConfig = getConfig();

    // Determine primary provider from per-call override or config
    var provider = opts.provider || freshConfig.AI_PROVIDER || 'anthropic';
    var enableFallback = freshConfig.ENABLE_FALLBACK !== false;

    // Per-call model override
    var modelOverride = opts.model || null;

    // Try primary provider
    var primaryFn = provider === 'openai' ? 'rewriteWithOpenAI' : 'rewriteWithClaude';
    var fallbackFn = provider === 'openai' ? 'rewriteWithClaude' : 'rewriteWithOpenAI';

    try {
      this.logger.info('Attempting rewrite with ' + provider, {
        articleTitle: article.title,
        model: modelOverride || (provider === 'openai' ? freshConfig.AI_FALLBACK_MODEL : freshConfig.AI_PRIMARY_MODEL),
      });
      var result = await this[primaryFn](article, cluster, modelOverride);
      result.aiProvider = provider;
      return result;
    } catch (primaryErr) {
      this.logger.warn(provider + ' rewrite failed', {
        error: primaryErr.message,
        articleTitle: article.title,
      });

      if (!enableFallback) {
        throw primaryErr;
      }
    }

    // Try fallback provider
    var fallbackProvider = provider === 'openai' ? 'anthropic' : 'openai';
    var fallbackKey = fallbackProvider === 'openai' ? freshConfig.OPENAI_API_KEY : freshConfig.ANTHROPIC_API_KEY;
    if (!fallbackKey) {
      throw new Error(provider + ' rewrite failed and no ' + fallbackProvider + ' API key configured for fallback');
    }

    try {
      this.logger.info('Falling back to ' + fallbackProvider, {
        articleTitle: article.title,
      });
      var result = await this[fallbackFn](article, cluster);
      result.aiProvider = fallbackProvider;
      result.usedFallback = true;
      return result;
    } catch (fallbackErr) {
      this.logger.error('Both AI providers failed', {
        error: fallbackErr.message,
        articleTitle: article.title,
      });
      throw new Error('Both AI providers failed for "' + article.title + '": ' + fallbackErr.message);
    }
  }

  /**
   * Rewrite using the Anthropic Claude API.
   *
   * @param {object} article
   * @param {object} cluster
   * @returns {Promise<object>}
   */
  async rewriteWithClaude(article, cluster, modelOverride) {
    var { getConfig } = require('../utils/config');
    var freshConfig = getConfig();
    var model = modelOverride || freshConfig.AI_PRIMARY_MODEL || 'claude-haiku-4-5-20251001';
    var maxTokens = parseInt(freshConfig.MAX_TOKENS, 10) || 4096;
    var temperature = parseFloat(freshConfig.TEMPERATURE) || 0.7;

    const prompt = buildPrompt(article, cluster);
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await axios.post(
          'https://api.anthropic.com/v1/messages',
          {
            model: model,
            max_tokens: maxTokens,
            temperature: temperature,
            messages: [{ role: 'user', content: prompt }],
          },
          {
            headers: {
              'x-api-key': this.config.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
            timeout: AI_TIMEOUT_MS,
          }
        );

        if (!response.data || !response.data.content || !response.data.content[0]) {
          throw new Error('Claude returned empty response');
        }
        const rawText = response.data.content[0].text;
        const parsed = parseAIResponse(rawText);

        // Extract token usage
        const tokensUsed =
          (response.data.usage && response.data.usage.input_tokens + response.data.usage.output_tokens) || 0;

        // Update stats
        this.stats.totalRewrites++;
        this.stats.claudeCount++;
        this.stats.lastRewriteAt = new Date().toISOString();
        this.stats.totalTokens += tokensUsed;

        this.logger.info('Claude rewrite successful', {
          articleTitle: article.title,
          tokensUsed,
          attempt,
        });

        return {
          title: parsed.title,
          content: parsed.content,
          excerpt: parsed.excerpt,
          metaDescription: parsed.meta_description,
          slug: parsed.slug,
          targetKeyword: parsed.target_keyword || '',
          relatedKeywords: parsed.related_keywords || [],
          faq: parsed.faq || [],
          wordCount: parsed.word_count || 0,
          aiModel: model,
          tokensUsed: tokensUsed,
        };
      } catch (err) {
        lastError = err;
        this.logger.warn(`Claude attempt ${attempt}/${MAX_RETRIES} failed`, {
          error: err.message,
          status: err.response ? err.response.status : null,
        });

        // Don't retry on auth errors or invalid request
        if (err.response && (err.response.status === 401 || err.response.status === 400)) {
          break;
        }
      }
    }

    throw lastError;
  }

  /**
   * Rewrite using the OpenAI Chat Completions API.
   *
   * @param {object} article
   * @param {object} cluster
   * @returns {Promise<object>}
   */
  async rewriteWithOpenAI(article, cluster, modelOverride) {
    var { getConfig } = require('../utils/config');
    var freshConfig = getConfig();
    var model = modelOverride || freshConfig.AI_FALLBACK_MODEL || 'gpt-4o';
    var maxTokens = parseInt(freshConfig.MAX_TOKENS, 10) || 4096;
    var temperature = parseFloat(freshConfig.TEMPERATURE) || 0.7;

    const prompt = buildPrompt(article, cluster);
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: model,
            max_tokens: maxTokens,
            temperature: temperature,
            response_format: { type: 'json_object' },
            messages: [
              {
                role: 'system',
                content: 'You are a professional news journalist. Always respond in valid JSON.',
              },
              { role: 'user', content: prompt },
            ],
          },
          {
            headers: {
              Authorization: 'Bearer ' + freshConfig.OPENAI_API_KEY,
              'Content-Type': 'application/json',
            },
            timeout: AI_TIMEOUT_MS,
          }
        );

        if (!response.data || !response.data.choices || !response.data.choices[0]) {
          throw new Error('OpenAI returned empty response');
        }
        const rawText = response.data.choices[0].message.content;
        const parsed = parseAIResponse(rawText);

        // Extract token usage
        const tokensUsed =
          (response.data.usage && response.data.usage.prompt_tokens + response.data.usage.completion_tokens) || 0;

        // Update stats
        this.stats.totalRewrites++;
        this.stats.openaiCount++;
        this.stats.lastRewriteAt = new Date().toISOString();
        this.stats.totalTokens += tokensUsed;

        this.logger.info('OpenAI rewrite successful', {
          articleTitle: article.title,
          model: model,
          tokensUsed,
          attempt,
        });

        return {
          title: parsed.title,
          content: parsed.content,
          excerpt: parsed.excerpt,
          metaDescription: parsed.meta_description,
          slug: parsed.slug,
          targetKeyword: parsed.target_keyword || '',
          relatedKeywords: parsed.related_keywords || [],
          faq: parsed.faq || [],
          wordCount: parsed.word_count || 0,
          aiModel: model,
          tokensUsed: tokensUsed,
        };
      } catch (err) {
        lastError = err;
        this.logger.warn('OpenAI attempt ' + attempt + '/' + MAX_RETRIES + ' failed', {
          error: err.message,
          status: err.response ? err.response.status : null,
        });

        // Don't retry on auth errors or invalid request
        if (err.response && (err.response.status === 401 || err.response.status === 400)) {
          break;
        }
      }
    }

    throw lastError;
  }

  async init() {
    try {
      var hasClaude = !!this.config.ANTHROPIC_API_KEY;
      var hasOpenAI = !!this.config.OPENAI_API_KEY;
      if (!hasClaude && !hasOpenAI) {
        this.status = 'disabled';
        return;
      }
      this.enabled = true;
      this.status = hasClaude && hasOpenAI ? 'connected' : 'degraded';
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
    }
  }

  getHealth() {
    return {
      module: 'rewriter',
      enabled: this.enabled,
      ready: this.enabled,
      status: this.status,
      error: this.error,
      lastActivity: this.stats.lastRewriteAt,
      stats: {
        primaryModel: this.config.AI_PRIMARY_MODEL,
        fallbackAvailable: !!this.config.OPENAI_API_KEY,
        totalRewrites: this.stats.totalRewrites,
      }
    };
  }

  async shutdown() {
    this.enabled = false;
    this.status = 'disabled';
  }

  /**
   * Get current rewriter statistics.
   *
   * @returns {object}
   */
  getStatus() {
    return { ...this.stats };
  }
}

module.exports = { ArticleRewriter };
