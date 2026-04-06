'use strict';

// Model definitions — used by both backend and sent to frontend
var AI_MODELS = {
  anthropic: [
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', tier: 'Fast & Cheap' },
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', tier: 'Balanced' },
    { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', tier: 'Best Quality' },
  ],
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o', tier: 'Balanced' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', tier: 'Fast & Cheap' },
    { id: 'gpt-4.1', name: 'GPT-4.1', tier: 'Latest' },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', tier: 'Latest Fast' },
    { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', tier: 'Cheapest' },
    { id: 'o3', name: 'O3', tier: 'Reasoning' },
    { id: 'o3-mini', name: 'O3 Mini', tier: 'Reasoning Fast' },
    { id: 'o4-mini', name: 'O4 Mini', tier: 'Latest Reasoning' },
  ],
};

// ─── SEO Prompt Builder (used by automated pipeline) ──────────────────────

function buildPrompt(article, cluster) {
  var trendingContext = '';
  if (cluster && cluster.trends_boosted) {
    trendingContext =
      'TRENDING CONTEXT: This story is currently trending on Google Trends in India.\n' +
      'Trend Topic: ' + (cluster.trends_topic || 'N/A') + '\n' +
      'Related Queries: ' + (cluster.trends_queries || 'N/A') + '\n' +
      'Use this trending momentum — weave the trend topic into the headline and opening paragraph.\n\n';
  }

  var sourceArticles = '';
  var allArticles = (cluster && cluster.articles && Array.isArray(cluster.articles)) ? cluster.articles : [article];

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

function parseAIResponse(text) {
  var cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return JSON.parse(cleaned);
}

// ─── Rewriter Module ──────────────────────────────────────────────────────

class ArticleRewriter {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.db = null;

    this.enabled = false;
    this.ready = false;
    this.status = 'disabled';
    this.error = null;

    this.stats = {
      totalRewrites: 0,
      claudeCount: 0,
      openaiCount: 0,
      lastRewriteAt: null,
      totalTokens: 0,
    };
  }

  async init() {
    try {
      // Get db reference
      var dbMod = require('../utils/db');
      this.db = dbMod.db;

      // Ensure AI columns on drafts table
      this._ensureColumns();

      // Load config from DB + env
      this._loadConfig();

      // Check if at least one provider is configured
      var hasAnthropic = !!this._cfg.anthropicKey;
      var hasOpenAI = !!this._cfg.openaiKey;
      if (!hasAnthropic && !hasOpenAI) {
        this.status = 'disabled';
        this.enabled = false;
        this.logger.warn('rewriter', 'No AI API keys configured. Set ANTHROPIC_API_KEY or OPENAI_API_KEY.');
        return;
      }

      this.enabled = true;
      this.ready = true;
      this.status = hasAnthropic && hasOpenAI ? 'connected' : 'degraded';

      this.logger.info('rewriter', 'Rewriter ready. Provider: ' + this._cfg.provider +
        ', Model: ' + (this._cfg.provider === 'anthropic' ? this._cfg.anthropicModel : this._cfg.openaiModel));
      this.logger.info('rewriter', 'Anthropic key: ' + (this._cfg.anthropicKey ? 'SET (' + this._cfg.anthropicKey.substring(0, 10) + '...)' : 'NOT SET'));
      this.logger.info('rewriter', 'OpenAI key: ' + (this._cfg.openaiKey ? 'SET (' + this._cfg.openaiKey.substring(0, 8) + '...)' : 'NOT SET'));
    } catch (err) {
      this.logger.error('rewriter', 'Init failed: ' + err.message);
      this.status = 'error';
      this.error = err.message;
    }
  }

  _ensureColumns() {
    var columns = [
      { name: 'ai_provider', type: 'TEXT DEFAULT NULL' },
      { name: 'ai_model', type: 'TEXT DEFAULT NULL' },
      { name: 'ai_tokens_used', type: 'INTEGER DEFAULT 0' },
      { name: 'rewritten_at', type: 'TEXT DEFAULT NULL' },
    ];
    for (var i = 0; i < columns.length; i++) {
      try {
        this.db.prepare('ALTER TABLE drafts ADD COLUMN ' + columns[i].name + ' ' + columns[i].type).run();
      } catch (e) { /* already exists */ }
    }
  }

  _getSetting(key) {
    try {
      var row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      return row ? row.value : null;
    } catch (e) {
      return null;
    }
  }

  _setSetting(key, value) {
    this.db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run(key, String(value));
  }

  _loadConfig() {
    this._cfg = {
      provider:       this._getSetting('AI_PROVIDER')       || process.env.AI_PROVIDER       || 'anthropic',
      anthropicKey:   this._getSetting('ANTHROPIC_API_KEY')  || process.env.ANTHROPIC_API_KEY  || '',
      anthropicModel: this._getSetting('ANTHROPIC_MODEL')    || process.env.ANTHROPIC_MODEL    || process.env.AI_PRIMARY_MODEL || 'claude-haiku-4-5-20251001',
      openaiKey:      this._getSetting('OPENAI_API_KEY')     || process.env.OPENAI_API_KEY     || '',
      openaiModel:    this._getSetting('OPENAI_MODEL')       || process.env.OPENAI_MODEL       || process.env.AI_FALLBACK_MODEL || 'gpt-4o',
      enableFallback: (this._getSetting('ENABLE_FALLBACK')   || process.env.ENABLE_FALLBACK   || 'true') === 'true',
      maxTokens:      parseInt(this._getSetting('MAX_TOKENS') || process.env.MAX_TOKENS        || '4096', 10),
      temperature:    parseFloat(this._getSetting('TEMPERATURE') || process.env.TEMPERATURE    || '0.7'),
    };
  }

  // ─── Settings API (called by routes) ────────────────────────────────────

  updateSettings(settings) {
    var mapping = {
      provider: 'AI_PROVIDER',
      anthropicKey: 'ANTHROPIC_API_KEY',
      anthropicModel: 'ANTHROPIC_MODEL',
      openaiKey: 'OPENAI_API_KEY',
      openaiModel: 'OPENAI_MODEL',
      enableFallback: 'ENABLE_FALLBACK',
      maxTokens: 'MAX_TOKENS',
      temperature: 'TEMPERATURE',
    };

    var keys = Object.keys(mapping);
    for (var i = 0; i < keys.length; i++) {
      var jsKey = keys[i];
      var dbKey = mapping[jsKey];
      if (settings[jsKey] !== undefined && settings[jsKey] !== '') {
        var val = typeof settings[jsKey] === 'boolean' ? String(settings[jsKey]) : String(settings[jsKey]);
        this._setSetting(dbKey, val);
      }
    }

    this._loadConfig();

    // Re-check enabled status
    var hasAnthropic = !!this._cfg.anthropicKey;
    var hasOpenAI = !!this._cfg.openaiKey;
    this.enabled = hasAnthropic || hasOpenAI;
    this.ready = this.enabled;
    this.status = this.enabled ? (hasAnthropic && hasOpenAI ? 'connected' : 'degraded') : 'disabled';

    this.logger.info('rewriter', 'Settings updated. Provider: ' + this._cfg.provider);
  }

  getSettings() {
    this._loadConfig();
    return {
      provider: this._cfg.provider,
      anthropicKey: this._cfg.anthropicKey ? '***' + this._cfg.anthropicKey.slice(-4) : '',
      anthropicModel: this._cfg.anthropicModel,
      openaiKey: this._cfg.openaiKey ? '***' + this._cfg.openaiKey.slice(-4) : '',
      openaiModel: this._cfg.openaiModel,
      enableFallback: this._cfg.enableFallback,
      maxTokens: this._cfg.maxTokens,
      temperature: this._cfg.temperature,
      models: AI_MODELS,
    };
  }

  // ─── Main rewrite method (used by scheduler + draft-helpers) ────────────
  //
  // Signature: rewrite(article, cluster, options)
  //   article  — { title, content_markdown, url, domain, extracted_content, ... }
  //   cluster  — { articles[], trends_boosted, topic, ... } (can be minimal for drafts)
  //   options  — { provider, model } per-call overrides
  //
  // Returns: { title, content, excerpt, metaDescription, slug, targetKeyword,
  //            relatedKeywords, faq, wordCount, aiModel, aiProvider, tokensUsed }

  async rewrite(article, cluster, options) {
    this._loadConfig();
    var opts = options || {};

    var provider = opts.provider || this._cfg.provider;
    var enableFallback = this._cfg.enableFallback;

    // Determine key + model for primary provider
    var primaryKey, primaryModel;
    if (provider === 'anthropic') {
      primaryKey = this._cfg.anthropicKey;
      primaryModel = opts.model || this._cfg.anthropicModel;
    } else {
      primaryKey = this._cfg.openaiKey;
      primaryModel = opts.model || this._cfg.openaiModel;
    }

    if (!primaryKey) {
      var errMsg = provider.toUpperCase() + ' API key is not configured. Go to Settings and enter your API key.';
      this.logger.error('rewriter', errMsg);
      throw new Error(errMsg);
    }

    // Build the SEO prompt from article + cluster
    var prompt = buildPrompt(article, cluster || { articles: [article] });

    // Try primary
    try {
      this.logger.info('rewriter', 'Calling ' + provider + ' with model ' + primaryModel + '...');
      var result = await this._callProviderStructured(provider, primaryKey, primaryModel, prompt);
      result.aiProvider = provider;
      result.aiModel = primaryModel;

      // Update stats
      this.stats.totalRewrites++;
      if (provider === 'anthropic') this.stats.claudeCount++;
      else this.stats.openaiCount++;
      this.stats.lastRewriteAt = new Date().toISOString();
      this.stats.totalTokens += result.tokensUsed || 0;

      this.logger.info('rewriter', 'SUCCESS: ' + provider + ' / ' + primaryModel + ' — ' + result.tokensUsed + ' tokens');
      return result;
    } catch (primaryErr) {
      this.logger.error('rewriter', 'PRIMARY FAILED (' + provider + '): ' + primaryErr.message);

      if (!enableFallback) {
        throw primaryErr;
      }

      // Try fallback
      var fallbackProvider = provider === 'anthropic' ? 'openai' : 'anthropic';
      var fallbackKey = fallbackProvider === 'anthropic' ? this._cfg.anthropicKey : this._cfg.openaiKey;
      var fallbackModel = fallbackProvider === 'anthropic' ? this._cfg.anthropicModel : this._cfg.openaiModel;

      if (!fallbackKey) {
        throw new Error(provider + ' rewrite failed: ' + primaryErr.message + '. Fallback provider (' + fallbackProvider + ') has no API key configured.');
      }

      this.logger.info('rewriter', 'Trying fallback: ' + fallbackProvider + ' / ' + fallbackModel + '...');
      try {
        var fbResult = await this._callProviderStructured(fallbackProvider, fallbackKey, fallbackModel, prompt);
        fbResult.aiProvider = fallbackProvider;
        fbResult.aiModel = fallbackModel;
        fbResult.usedFallback = true;

        this.stats.totalRewrites++;
        if (fallbackProvider === 'anthropic') this.stats.claudeCount++;
        else this.stats.openaiCount++;
        this.stats.lastRewriteAt = new Date().toISOString();
        this.stats.totalTokens += fbResult.tokensUsed || 0;

        this.logger.info('rewriter', 'FALLBACK SUCCESS: ' + fallbackProvider + ' / ' + fallbackModel);
        return fbResult;
      } catch (fbErr) {
        this.logger.error('rewriter', 'FALLBACK ALSO FAILED (' + fallbackProvider + '): ' + fbErr.message);
        throw new Error('Both providers failed.\nPrimary (' + provider + '): ' + primaryErr.message + '\nFallback (' + fallbackProvider + '): ' + fbErr.message);
      }
    }
  }

  // ─── Simple rewrite (for /api/drafts/:id/rewrite — returns HTML only) ───

  async rewriteSimple(content, customPrompt, options) {
    this._loadConfig();
    var opts = options || {};

    var provider = opts.provider || this._cfg.provider;
    var enableFallback = this._cfg.enableFallback;

    var primaryKey, primaryModel;
    if (provider === 'anthropic') {
      primaryKey = this._cfg.anthropicKey;
      primaryModel = opts.model || this._cfg.anthropicModel;
    } else {
      primaryKey = this._cfg.openaiKey;
      primaryModel = opts.model || this._cfg.openaiModel;
    }

    if (!primaryKey) {
      throw new Error(provider.toUpperCase() + ' API key is not configured. Go to Settings and enter your API key.');
    }

    try {
      var result = await this._callProviderSimple(provider, primaryKey, primaryModel, content, customPrompt);
      this.stats.totalRewrites++;
      if (provider === 'anthropic') this.stats.claudeCount++;
      else this.stats.openaiCount++;
      this.stats.lastRewriteAt = new Date().toISOString();
      this.stats.totalTokens += result.tokensUsed || 0;
      return result;
    } catch (primaryErr) {
      this.logger.error('rewriter', 'PRIMARY FAILED (' + provider + '): ' + primaryErr.message);

      if (!enableFallback) throw primaryErr;

      var fbProvider = provider === 'anthropic' ? 'openai' : 'anthropic';
      var fbKey = fbProvider === 'anthropic' ? this._cfg.anthropicKey : this._cfg.openaiKey;
      var fbModel = fbProvider === 'anthropic' ? this._cfg.anthropicModel : this._cfg.openaiModel;

      if (!fbKey) {
        throw new Error(provider + ' rewrite failed: ' + primaryErr.message + '. No ' + fbProvider + ' API key for fallback.');
      }

      try {
        var fbResult = await this._callProviderSimple(fbProvider, fbKey, fbModel, content, customPrompt);
        fbResult.usedFallback = true;
        return fbResult;
      } catch (fbErr) {
        throw new Error('Both providers failed. Primary: ' + primaryErr.message + '. Fallback: ' + fbErr.message);
      }
    }
  }

  // ─── Provider calls (structured JSON output for pipeline) ───────────────

  async _callProviderStructured(provider, apiKey, model, prompt) {
    if (provider === 'anthropic') {
      return this._callAnthropicStructured(apiKey, model, prompt);
    }
    return this._callOpenAIStructured(apiKey, model, prompt);
  }

  async _callAnthropicStructured(apiKey, model, prompt) {
    var Anthropic;
    try { Anthropic = require('@anthropic-ai/sdk'); }
    catch (e) { throw new Error('Anthropic SDK not installed. Run: npm install @anthropic-ai/sdk'); }

    var maxTokens = this._cfg.maxTokens || 4096;
    var temperature = this._cfg.temperature;
    if (temperature === undefined || temperature === null) temperature = 0.7;

    var client = new Anthropic({ apiKey: apiKey.trim() });

    var response = await client.messages.create({
      model: model,
      max_tokens: maxTokens,
      temperature: temperature,
      messages: [{ role: 'user', content: prompt }],
    });

    var rawText = response.content && response.content[0] ? response.content[0].text : '';
    if (!rawText || rawText.length < 50) {
      throw new Error('Anthropic returned empty or too-short response');
    }

    var parsed = parseAIResponse(rawText);
    var tokensUsed = (response.usage ? (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0) : 0);

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
      tokensUsed: tokensUsed,
    };
  }

  async _callOpenAIStructured(apiKey, model, prompt) {
    var OpenAI;
    try { OpenAI = require('openai'); }
    catch (e) { throw new Error('OpenAI SDK not installed. Run: npm install openai'); }

    var maxTokens = this._cfg.maxTokens || 4096;
    var temperature = this._cfg.temperature;
    if (temperature === undefined || temperature === null) temperature = 0.7;

    var isOModel = model.startsWith('o3') || model.startsWith('o4');
    var client = new OpenAI({ apiKey: apiKey.trim() });

    var response;
    if (isOModel) {
      response = await client.chat.completions.create({
        model: model,
        max_completion_tokens: maxTokens,
        messages: [
          { role: 'user', content: 'You are a professional news journalist. Always respond in valid JSON.\n\n' + prompt },
        ],
      });
    } else {
      response = await client.chat.completions.create({
        model: model,
        max_tokens: maxTokens,
        temperature: temperature,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a professional news journalist. Always respond in valid JSON.' },
          { role: 'user', content: prompt },
        ],
      });
    }

    var rawText = response.choices && response.choices[0] ? response.choices[0].message.content : '';
    if (!rawText || rawText.length < 50) {
      throw new Error('OpenAI returned empty or too-short response');
    }

    var parsed = parseAIResponse(rawText);
    var tokensUsed = (response.usage ? (response.usage.prompt_tokens || 0) + (response.usage.completion_tokens || 0) : 0);

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
      tokensUsed: tokensUsed,
    };
  }

  // ─── Provider calls (simple HTML output for draft rewrite) ──────────────

  async _callProviderSimple(provider, apiKey, model, content, customPrompt) {
    if (provider === 'anthropic') {
      return this._callAnthropicSimple(apiKey, model, content, customPrompt);
    }
    return this._callOpenAISimple(apiKey, model, content, customPrompt);
  }

  async _callAnthropicSimple(apiKey, model, content, customPrompt) {
    var Anthropic = require('@anthropic-ai/sdk');
    var maxTokens = this._cfg.maxTokens || 4096;
    var temperature = this._cfg.temperature;
    if (temperature === undefined || temperature === null) temperature = 0.7;

    var client = new Anthropic({ apiKey: apiKey.trim() });

    var systemPrompt = 'You are an expert news article rewriter for an Indian news website. Rewrite the given article completely in your own words while maintaining all key facts, names, dates, numbers, quotes, SEO value, and the original language. Output clean HTML with h2/h3 headings and paragraphs. Do NOT include html/head/body tags.';
    var userPrompt = customPrompt
      ? customPrompt + '\n\n---\n\nSource article to rewrite:\n' + content
      : 'Rewrite this news article completely in your own words. Maintain all facts and SEO value. Output clean HTML.\n\n' + content;

    var response = await client.messages.create({
      model: model,
      max_tokens: maxTokens,
      temperature: temperature,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    var rewrittenContent = response.content && response.content[0] ? response.content[0].text : '';
    if (!rewrittenContent || rewrittenContent.length < 50) {
      throw new Error('Anthropic returned empty or too-short content');
    }

    var tokensUsed = (response.usage ? (response.usage.input_tokens || 0) + (response.usage.output_tokens || 0) : 0);

    return {
      success: true,
      rewrittenContent: rewrittenContent,
      provider: 'anthropic',
      model: model,
      tokensUsed: tokensUsed,
    };
  }

  async _callOpenAISimple(apiKey, model, content, customPrompt) {
    var OpenAI = require('openai');
    var maxTokens = this._cfg.maxTokens || 4096;
    var temperature = this._cfg.temperature;
    if (temperature === undefined || temperature === null) temperature = 0.7;

    var isOModel = model.startsWith('o3') || model.startsWith('o4');
    var client = new OpenAI({ apiKey: apiKey.trim() });

    var systemPrompt = 'You are an expert news article rewriter for an Indian news website. Rewrite the given article completely in your own words while maintaining all key facts, names, dates, numbers, quotes, SEO value, and the original language. Output clean HTML with h2/h3 headings and paragraphs. Do NOT include html/head/body tags.';
    var userPrompt = customPrompt
      ? customPrompt + '\n\n---\n\nSource article to rewrite:\n' + content
      : 'Rewrite this news article completely in your own words. Maintain all facts and SEO value. Output clean HTML.\n\n' + content;

    var response;
    if (isOModel) {
      response = await client.chat.completions.create({
        model: model,
        max_completion_tokens: maxTokens,
        messages: [{ role: 'user', content: systemPrompt + '\n\n' + userPrompt }],
      });
    } else {
      response = await client.chat.completions.create({
        model: model,
        max_tokens: maxTokens,
        temperature: temperature,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      });
    }

    var rewrittenContent = response.choices && response.choices[0] ? response.choices[0].message.content : '';
    if (!rewrittenContent || rewrittenContent.length < 50) {
      throw new Error('OpenAI returned empty or too-short content');
    }

    var tokensUsed = (response.usage ? (response.usage.prompt_tokens || 0) + (response.usage.completion_tokens || 0) : 0);

    return {
      success: true,
      rewrittenContent: rewrittenContent,
      provider: 'openai',
      model: model,
      tokensUsed: tokensUsed,
    };
  }

  // ─── Test connection ────────────────────────────────────────────────────

  async testConnection(provider, apiKey) {
    try {
      if (provider === 'anthropic') {
        var Anthropic = require('@anthropic-ai/sdk');
        var client = new Anthropic({ apiKey: apiKey.trim() });
        var res = await client.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 20,
          messages: [{ role: 'user', content: 'Say "OK" and nothing else.' }],
        });
        return { success: true, response: res.content && res.content[0] ? res.content[0].text : '' };
      } else {
        var OpenAI = require('openai');
        var oaiClient = new OpenAI({ apiKey: apiKey.trim() });
        var oaiRes = await oaiClient.chat.completions.create({
          model: 'gpt-4o-mini',
          max_tokens: 20,
          messages: [{ role: 'user', content: 'Say "OK" and nothing else.' }],
        });
        return { success: true, response: oaiRes.choices && oaiRes.choices[0] ? oaiRes.choices[0].message.content : '' };
      }
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  // ─── Health / Status ────────────────────────────────────────────────────

  getHealth() {
    return {
      module: 'rewriter',
      enabled: this.enabled,
      ready: this.ready,
      status: this.status,
      error: this.error,
      lastActivity: this.stats.lastRewriteAt,
      stats: {
        provider: this._cfg ? this._cfg.provider : 'unknown',
        totalRewrites: this.stats.totalRewrites,
      },
    };
  }

  getStatus() {
    return {
      totalRewrites: this.stats.totalRewrites,
      claudeCount: this.stats.claudeCount,
      openaiCount: this.stats.openaiCount,
      lastRewriteAt: this.stats.lastRewriteAt,
      totalTokens: this.stats.totalTokens,
    };
  }

  async shutdown() {
    this.enabled = false;
    this.status = 'disabled';
  }
}

module.exports = { ArticleRewriter, AI_MODELS };
