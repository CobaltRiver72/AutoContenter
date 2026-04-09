'use strict';

// Model definitions — used by both backend and sent to frontend
var AI_MODELS = {
  anthropic: [
    { id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', tier: 'Fast & Cheap', type: 'standard' },
    { id: 'claude-sonnet-4-20250514', name: 'Claude Sonnet 4', tier: 'Balanced', type: 'standard' },
    { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', tier: 'Latest Balanced', type: 'standard' },
    { id: 'claude-opus-4-20250514', name: 'Claude Opus 4', tier: 'Best Quality', type: 'standard' },
    { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', tier: 'Latest Best', type: 'standard' },
  ],
  openai: [
    { id: 'gpt-4o', name: 'GPT-4o', tier: 'Balanced', type: 'standard' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini', tier: 'Fast & Cheap', type: 'standard' },
    { id: 'gpt-4.1', name: 'GPT-4.1', tier: 'Latest', type: 'standard' },
    { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini', tier: 'Latest Fast', type: 'standard' },
    { id: 'gpt-4.1-nano', name: 'GPT-4.1 Nano', tier: 'Cheapest', type: 'standard' },
    { id: 'o3', name: 'O3', tier: 'Reasoning', type: 'reasoning' },
    { id: 'o3-mini', name: 'O3 Mini', tier: 'Reasoning Fast', type: 'reasoning' },
    { id: 'o4-mini', name: 'O4 Mini', tier: 'Latest Reasoning', type: 'reasoning' },
  ],
  // OpenRouter list is fetched dynamically — see fetchOpenRouterFreeModels()
  openrouter: [],
};

function countWords(html) {
  var text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  return text ? text.split(' ').length : 0;
}

// ─── SEO Prompt Builder (used by automated pipeline) ──────────────────────

function buildPrompt(article, cluster, settings) {
  var s = settings || {};

  // ─── Determine Output Language ────────────────────────────────────────────────
  // Rule: if ANY source article in the cluster is English → write in English.
  //       Only write Hindi if ALL cluster articles are Hindi (or Hindi-detected).
  // This way a mixed Hindi+English cluster about the same story always outputs English,
  // and the AI uses all sources (including Hindi ones) as research input.
  var targetLang = (s.language === 'hi' || s.language === 'en') ? s.language : null;

  if (!targetLang) {
    // Collect all articles available for language inspection
    var allClusterArticles = [];
    if (cluster && cluster.articles && Array.isArray(cluster.articles) && cluster.articles.length > 0) {
      allClusterArticles = cluster.articles;
    } else if (article) {
      allClusterArticles = [article];
    }

    var hasEnglish = false;
    var hasHindi = false;

    for (var li = 0; li < allClusterArticles.length; li++) {
      var a = allClusterArticles[li];
      if (!a) continue;
      var lang = a.language || null;

      // If language is null, detect from content
      if (!lang) {
        var detectText = (a.title || '') + ' ' +
          ((a.extracted_content || a.content_markdown || '').substring(0, 500));
        lang = /[\u0900-\u097F]{3,}/.test(detectText) ? 'hi' : 'en';
      }

      if (lang === 'en') { hasEnglish = true; }
      if (lang === 'hi') { hasHindi = true; }
    }

    // English wins if even one English source exists
    if (hasEnglish) {
      targetLang = 'en';
    } else if (hasHindi) {
      targetLang = 'hi';
    } else {
      // Absolute fallback: detect from primary article
      var detectSrc = ((article && article.title) || '') + ' ' +
        (((article && (article.extracted_content || article.content_markdown)) || '').substring(0, 1000));
      targetLang = /[\u0900-\u097F]{3,}/.test(detectSrc) ? 'hi' : 'en';
    }
  }
  // ─── End Output Language Detection ───────────────────────────────────────────

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
  ((s.targetKeyword && s.targetKeyword.trim())
    ? '5. TARGET KEYWORD: The user has specified this target keyword: "' + s.targetKeyword.trim() + '". Use this EXACT keyword as the primary keyword. Optimize the title, meta description, slug, and content around this keyword. Place it naturally in the H1, first paragraph, at least 2 H2 subheadings, and the conclusion.\n\n'
    : '5. TARGET KEYWORD: Identify the best long-tail keyword to target (e.g., "OnePlus Nord 6 price in India April 2026"). Prefer date/event-specific keywords with low competition.\n\n') +
  (targetLang === 'hi'
    ? 'LANGUAGE: Write the ENTIRE article in Hindi (Devanagari script). All headings, paragraphs, FAQ questions and answers must be in Hindi. Only keep proper nouns, brand names, and technical terms in English where Hindi readers would expect them. Do NOT mix English sentences into the article body.\n\n'
    : 'LANGUAGE: Write the ENTIRE article in English only. Do NOT include Hindi translations, Devanagari text, or Hindi sentences anywhere in the body, headings, or FAQ. Proper nouns and Indian-specific terms (₹, IST, city names) are fine.\n\n') +
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
  ((s.customPrompt && s.customPrompt.trim())
    ? 'ADDITIONAL INSTRUCTIONS FROM EDITOR:\n' + s.customPrompt.trim() + '\nFollow these additional instructions while also following all the above requirements.\n\n'
    : '') +
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
      var hasOpenRouter = !!this._cfg.openrouterKey;
      if (!hasAnthropic && !hasOpenAI && !hasOpenRouter) {
        this.status = 'disabled';
        this.enabled = false;
        this.logger.warn('rewriter', 'No AI API keys configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, or OPENROUTER_API_KEY.');
        return;
      }

      this.enabled = true;
      this.ready = true;
      var keyCount = [hasAnthropic, hasOpenAI, hasOpenRouter].filter(Boolean).length;
      this.status = keyCount >= 2 ? 'connected' : 'degraded';

      var activeModel = this._cfg.provider === 'anthropic' ? this._cfg.anthropicModel
        : this._cfg.provider === 'openrouter' ? this._cfg.openrouterModel
        : this._cfg.openaiModel;
      this.logger.info('rewriter', 'Rewriter ready. Provider: ' + this._cfg.provider + ', Model: ' + activeModel);
      this.logger.info('rewriter', 'Anthropic key: ' + (hasAnthropic ? 'SET' : 'NOT SET') +
        ', OpenAI key: ' + (hasOpenAI ? 'SET' : 'NOT SET') +
        ', OpenRouter key: ' + (hasOpenRouter ? 'SET' : 'NOT SET'));
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
      { name: 'custom_ai_instructions', type: 'TEXT DEFAULT NULL' },
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
      provider:         this._getSetting('AI_PROVIDER')         || process.env.AI_PROVIDER         || 'openrouter',
      anthropicKey:     this._getSetting('ANTHROPIC_API_KEY')    || process.env.ANTHROPIC_API_KEY    || '',
      anthropicModel:   this._getSetting('ANTHROPIC_MODEL')      || process.env.ANTHROPIC_MODEL      || 'claude-haiku-4-5-20251001',
      openaiKey:        this._getSetting('OPENAI_API_KEY')       || process.env.OPENAI_API_KEY       || '',
      openaiModel:      this._getSetting('OPENAI_MODEL')         || process.env.OPENAI_MODEL         || 'gpt-4o',
      openrouterKey:    this._getSetting('OPENROUTER_API_KEY')   || process.env.OPENROUTER_API_KEY   || '',
      openrouterModel:  this._getSetting('OPENROUTER_MODEL')     || process.env.OPENROUTER_MODEL     || 'meta-llama/llama-3.3-70b-instruct:free',
      enableFallback:   (this._getSetting('ENABLE_FALLBACK')     || process.env.ENABLE_FALLBACK     || 'true') === 'true',
      maxTokens:        parseInt(this._getSetting('MAX_TOKENS')  || process.env.MAX_TOKENS           || '4096', 10),
      temperature:      parseFloat(this._getSetting('TEMPERATURE') || process.env.TEMPERATURE        || '0.7'),
    };

    // Validate model IDs against known models — fix stale DB values
    this._cfg.anthropicModel = this._validateModelId('anthropic', this._cfg.anthropicModel, 'claude-haiku-4-5-20251001');
    this._cfg.openaiModel = this._validateModelId('openai', this._cfg.openaiModel, 'gpt-4o');
    // OpenRouter models are fetched dynamically from their API,
    // so we cannot validate against AI_MODELS.openrouter (which is empty by design).
    // Trust whatever the user picked — OpenRouter API will return a clear error
    // if the model ID is invalid.
    if (!this._cfg.openrouterModel || typeof this._cfg.openrouterModel !== 'string') {
      this._cfg.openrouterModel = 'meta-llama/llama-3.3-70b-instruct:free';
    }
  }

  _validateModelId(provider, currentId, defaultId) {
    if (!currentId) return defaultId;

    var knownModels = AI_MODELS[provider] || [];
    var isValid = knownModels.some(function(m) { return m.id === currentId; });

    if (!isValid) {
      this.logger.warn('rewriter',
        'Invalid ' + provider + ' model ID "' + currentId + '" in settings. ' +
        'Resetting to default: "' + defaultId + '". ' +
        'Valid: ' + knownModels.map(function(m) { return m.id; }).join(', ')
      );
      var dbKeyMap = { anthropic: 'ANTHROPIC_MODEL', openai: 'OPENAI_MODEL', openrouter: 'OPENROUTER_MODEL' };
      try {
        this._setSetting(dbKeyMap[provider], defaultId);
      } catch (e) { /* silent */ }
      return defaultId;
    }

    return currentId;
  }

  // ─── Settings API (called by routes) ────────────────────────────────────

  updateSettings(settings) {
    var mapping = {
      provider: 'AI_PROVIDER',
      anthropicKey: 'ANTHROPIC_API_KEY',
      anthropicModel: 'ANTHROPIC_MODEL',
      openaiKey: 'OPENAI_API_KEY',
      openaiModel: 'OPENAI_MODEL',
      openrouterKey: 'OPENROUTER_API_KEY',
      openrouterModel: 'OPENROUTER_MODEL',
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
    var hasOpenRouter = !!this._cfg.openrouterKey;
    this.enabled = hasAnthropic || hasOpenAI || hasOpenRouter;
    this.ready = this.enabled;
    var keyCount = [hasAnthropic, hasOpenAI, hasOpenRouter].filter(Boolean).length;
    this.status = this.enabled ? (keyCount >= 2 ? 'connected' : 'degraded') : 'disabled';

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
      openrouterKey: this._cfg.openrouterKey ? '***' + this._cfg.openrouterKey.slice(-4) : '',
      openrouterModel: this._cfg.openrouterModel,
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

  _getProviderKeyModel(provider, opts) {
    if (provider === 'anthropic') return { key: this._cfg.anthropicKey, model: opts.model || this._cfg.anthropicModel };
    if (provider === 'openrouter') return { key: this._cfg.openrouterKey, model: opts.model || this._cfg.openrouterModel };
    return { key: this._cfg.openaiKey, model: opts.model || this._cfg.openaiModel };
  }

  async rewrite(article, cluster, options) {
    this._loadConfig();
    var opts = options || {};

    var provider = opts.provider || this._cfg.provider;
    var enableFallback = this._cfg.enableFallback;

    var pkm = this._getProviderKeyModel(provider, opts);
    var primaryKey = pkm.key;
    var primaryModel = pkm.model;

    if (!primaryKey) {
      var errMsg = provider.toUpperCase() + ' API key is not configured. Go to Settings and enter your API key.';
      this.logger.error('rewriter', errMsg);
      throw new Error(errMsg);
    }

    // Build the SEO prompt from article + cluster + user settings
    var promptSettings = {
      targetKeyword: opts.targetKeyword || '',
      targetDomain: opts.targetDomain || '',
      language: opts.language || 'en+hi',
      schemaTypes: opts.schemaTypes || 'NewsArticle,FAQPage,BreadcrumbList',
      customPrompt: opts.customPrompt || '',
    };
    var prompt = buildPrompt(article, cluster || { articles: [article] }, promptSettings);

    // Try primary
    try {
      this.logger.info('rewriter', 'Calling ' + provider + ' with model ' + primaryModel + '...');
      var result = await this._callProviderStructured(provider, primaryKey, primaryModel, prompt);
      result.aiProvider = provider;
      result.aiModel = primaryModel;

      this.stats.totalRewrites++;
      this.stats.lastRewriteAt = new Date().toISOString();
      this.stats.totalTokens += result.tokensUsed || 0;

      this.logger.info('rewriter', 'SUCCESS: ' + provider + ' / ' + primaryModel + ' — ' + result.tokensUsed + ' tokens');
      return result;
    } catch (primaryErr) {
      this.logger.error('rewriter', 'PRIMARY FAILED (' + provider + '): ' + primaryErr.message);

      if (!enableFallback) throw primaryErr;

      // 3-provider fallback chain
      var allProviders = ['openrouter', 'anthropic', 'openai'];
      var fallbackProviders = allProviders.filter(function (p) { return p !== provider; });
      var self = this;
      var lastError = primaryErr;

      for (var fi = 0; fi < fallbackProviders.length; fi++) {
        var fbProvider = fallbackProviders[fi];
        var fb = self._getProviderKeyModel(fbProvider, {});
        if (!fb.key) continue;

        self.logger.info('rewriter', 'Trying fallback: ' + fbProvider + ' / ' + fb.model + '...');
        try {
          var fbResult = await self._callProviderStructured(fbProvider, fb.key, fb.model, prompt);
          fbResult.aiProvider = fbProvider;
          fbResult.aiModel = fb.model;
          fbResult.usedFallback = true;

          self.stats.totalRewrites++;
          self.stats.lastRewriteAt = new Date().toISOString();
          self.stats.totalTokens += fbResult.tokensUsed || 0;

          self.logger.info('rewriter', 'FALLBACK SUCCESS: ' + fbProvider + ' / ' + fb.model);
          return fbResult;
        } catch (fbErr) {
          self.logger.error('rewriter', 'FALLBACK FAILED (' + fbProvider + '): ' + fbErr.message);
          lastError = fbErr;
        }
      }

      throw new Error('All providers failed. Last error: ' + lastError.message);
    }
  }

  // ─── Simple rewrite (for /api/drafts/:id/rewrite — returns HTML only) ───

  async rewriteSimple(content, customPrompt, options) {
    this._loadConfig();
    var opts = options || {};

    var provider = opts.provider || this._cfg.provider;
    var enableFallback = this._cfg.enableFallback;

    var pkm = this._getProviderKeyModel(provider, opts);
    var primaryKey = pkm.key;
    var primaryModel = pkm.model;

    if (!primaryKey) {
      throw new Error(provider.toUpperCase() + ' API key is not configured. Go to Settings and enter your API key.');
    }

    // Build dynamic language/keyword notes for simple rewrite system prompt
    var langNote = '';
    if (opts.language === 'hi') {
      langNote = ' Write the output entirely in Hindi (Devanagari script).';
    } else if (opts.language === 'en') {
      langNote = ' Write the output in English only, no Hindi.';
    } else {
      langNote = ' Write in English with Hindi terms in parentheses where relevant for Indian readers.';
    }
    var keywordNote = '';
    if (opts.targetKeyword && opts.targetKeyword.trim()) {
      keywordNote = ' Optimize for the target keyword: "' + opts.targetKeyword.trim() + '". Place it naturally in the title, first paragraph, and key headings.';
    }
    var systemExtra = langNote + keywordNote;

    try {
      var result = await this._callProviderSimple(provider, primaryKey, primaryModel, content, customPrompt, systemExtra);
      this.stats.totalRewrites++;
      this.stats.lastRewriteAt = new Date().toISOString();
      this.stats.totalTokens += result.tokensUsed || 0;
      return result;
    } catch (primaryErr) {
      this.logger.error('rewriter', 'PRIMARY FAILED (' + provider + '): ' + primaryErr.message);

      if (!enableFallback) throw primaryErr;

      // 3-provider fallback chain
      var allProviders = ['openrouter', 'anthropic', 'openai'];
      var fallbackProviders = allProviders.filter(function (p) { return p !== provider; });
      var self = this;
      var lastError = primaryErr;

      for (var fi = 0; fi < fallbackProviders.length; fi++) {
        var fbProvider = fallbackProviders[fi];
        var fb = self._getProviderKeyModel(fbProvider, {});
        if (!fb.key) continue;

        try {
          var fbResult = await self._callProviderSimple(fbProvider, fb.key, fb.model, content, customPrompt, systemExtra);
          fbResult.usedFallback = true;
          self.stats.totalRewrites++;
          self.stats.lastRewriteAt = new Date().toISOString();
          self.stats.totalTokens += fbResult.tokensUsed || 0;
          return fbResult;
        } catch (fbErr) {
          lastError = fbErr;
        }
      }

      throw new Error('All providers failed. Last error: ' + lastError.message);
    }
  }

  // ─── Provider calls (structured JSON output for pipeline) ───────────────

  async _callProviderStructured(provider, apiKey, model, prompt) {
    if (provider === 'anthropic') return this._callAnthropicStructured(apiKey, model, prompt);
    if (provider === 'openrouter') return this._callOpenRouterStructured(apiKey, model, prompt);
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
    var wc = parsed.content ? countWords(parsed.content) : (parsed.word_count || 0);

    return {
      title: parsed.title,
      content: parsed.content,
      excerpt: parsed.excerpt,
      metaDescription: parsed.meta_description,
      slug: parsed.slug,
      targetKeyword: parsed.target_keyword || '',
      relatedKeywords: parsed.related_keywords || [],
      faq: parsed.faq || [],
      wordCount: wc,
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
          { role: 'developer', content: 'You are a professional news journalist. Always respond in valid JSON.' },
          { role: 'user', content: prompt },
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
    var wc = parsed.content ? countWords(parsed.content) : (parsed.word_count || 0);

    return {
      title: parsed.title,
      content: parsed.content,
      excerpt: parsed.excerpt,
      metaDescription: parsed.meta_description,
      slug: parsed.slug,
      targetKeyword: parsed.target_keyword || '',
      relatedKeywords: parsed.related_keywords || [],
      faq: parsed.faq || [],
      wordCount: wc,
      tokensUsed: tokensUsed,
    };
  }

  // ─── Provider calls (simple HTML output for draft rewrite) ──────────────

  async _callProviderSimple(provider, apiKey, model, content, customPrompt, systemExtra) {
    if (provider === 'anthropic') return this._callAnthropicSimple(apiKey, model, content, customPrompt, systemExtra);
    if (provider === 'openrouter') return this._callOpenRouterSimple(apiKey, model, content, customPrompt, systemExtra);
    return this._callOpenAISimple(apiKey, model, content, customPrompt, systemExtra);
  }

  async _callAnthropicSimple(apiKey, model, content, customPrompt, systemExtra) {
    var Anthropic = require('@anthropic-ai/sdk');
    var maxTokens = this._cfg.maxTokens || 4096;
    var temperature = this._cfg.temperature;
    if (temperature === undefined || temperature === null) temperature = 0.7;

    var client = new Anthropic({ apiKey: apiKey.trim() });

    var systemPrompt = 'You are an expert news article rewriter for an Indian news website. Rewrite the given article completely in your own words while maintaining all key facts, names, dates, numbers, quotes, and SEO value.' + (systemExtra || '') + ' Output clean HTML with h2/h3 headings and paragraphs. Do NOT include html/head/body tags.';
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
      wordCount: countWords(rewrittenContent),
      provider: 'anthropic',
      model: model,
      tokensUsed: tokensUsed,
    };
  }

  async _callOpenAISimple(apiKey, model, content, customPrompt, systemExtra) {
    var OpenAI = require('openai');
    var maxTokens = this._cfg.maxTokens || 4096;
    var temperature = this._cfg.temperature;
    if (temperature === undefined || temperature === null) temperature = 0.7;

    var isOModel = model.startsWith('o3') || model.startsWith('o4');
    var client = new OpenAI({ apiKey: apiKey.trim() });

    var systemPrompt = 'You are an expert news article rewriter for an Indian news website. Rewrite the given article completely in your own words while maintaining all key facts, names, dates, numbers, quotes, and SEO value.' + (systemExtra || '') + ' Output clean HTML with h2/h3 headings and paragraphs. Do NOT include html/head/body tags.';
    var userPrompt = customPrompt
      ? customPrompt + '\n\n---\n\nSource article to rewrite:\n' + content
      : 'Rewrite this news article completely in your own words. Maintain all facts and SEO value. Output clean HTML.\n\n' + content;

    var response;
    if (isOModel) {
      response = await client.chat.completions.create({
        model: model,
        max_completion_tokens: maxTokens,
        messages: [
          { role: 'developer', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
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
      wordCount: countWords(rewrittenContent),
      provider: 'openai',
      model: model,
      tokensUsed: tokensUsed,
    };
  }

  // ─── OpenRouter calls (uses OpenAI SDK with custom baseURL) ──────────

  _openRouterClient(apiKey) {
    var OpenAI = require('openai');
    return new OpenAI({
      apiKey: apiKey.trim(),
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://hdf-autopub.com',
        'X-Title': 'HDF AutoPub',
      },
    });
  }

  async _callOpenRouterStructured(apiKey, model, prompt) {
    var maxTokens = this._cfg.maxTokens || 4096;
    var temperature = this._cfg.temperature;
    if (temperature === undefined || temperature === null) temperature = 0.7;

    var client = this._openRouterClient(apiKey);

    var response = await client.chat.completions.create({
      model: model,
      max_tokens: maxTokens,
      temperature: temperature,
      messages: [
        { role: 'system', content: 'You are a professional news journalist. Always respond in valid JSON.' },
        { role: 'user', content: prompt },
      ],
    });

    var rawText = response.choices && response.choices[0] ? response.choices[0].message.content : '';
    if (!rawText || rawText.length < 50) {
      throw new Error('OpenRouter returned empty or too-short response');
    }

    var parsed = parseAIResponse(rawText);
    var tokensUsed = (response.usage ? (response.usage.prompt_tokens || 0) + (response.usage.completion_tokens || 0) : 0);
    var wc = parsed.content ? countWords(parsed.content) : (parsed.word_count || 0);

    return {
      title: parsed.title,
      content: parsed.content,
      excerpt: parsed.excerpt,
      metaDescription: parsed.meta_description,
      slug: parsed.slug,
      targetKeyword: parsed.target_keyword || '',
      relatedKeywords: parsed.related_keywords || [],
      faq: parsed.faq || [],
      wordCount: wc,
      tokensUsed: tokensUsed,
    };
  }

  async _callOpenRouterSimple(apiKey, model, content, customPrompt, systemExtra) {
    var maxTokens = this._cfg.maxTokens || 4096;
    var temperature = this._cfg.temperature;
    if (temperature === undefined || temperature === null) temperature = 0.7;

    var client = this._openRouterClient(apiKey);

    var systemPrompt = 'You are an expert news article rewriter for an Indian news website. Rewrite the given article completely in your own words while maintaining all key facts, names, dates, numbers, quotes, and SEO value.' + (systemExtra || '') + ' Output clean HTML with h2/h3 headings and paragraphs. Do NOT include html/head/body tags.';
    var userPrompt = customPrompt
      ? customPrompt + '\n\n---\n\nSource article to rewrite:\n' + content
      : 'Rewrite this news article completely in your own words. Maintain all facts and SEO value. Output clean HTML.\n\n' + content;

    var response = await client.chat.completions.create({
      model: model,
      max_tokens: maxTokens,
      temperature: temperature,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    });

    var rewrittenContent = response.choices && response.choices[0] ? response.choices[0].message.content : '';
    if (!rewrittenContent || rewrittenContent.length < 50) {
      throw new Error('OpenRouter returned empty or too-short content');
    }

    var tokensUsed = (response.usage ? (response.usage.prompt_tokens || 0) + (response.usage.completion_tokens || 0) : 0);

    return {
      success: true,
      rewrittenContent: rewrittenContent,
      wordCount: countWords(rewrittenContent),
      provider: 'openrouter',
      model: model,
      tokensUsed: tokensUsed,
    };
  }

  // ─── Test connection ────────────────────────────────────────────────────

  async testConnection(provider, apiKey, modelOverride) {
    try {
      if (provider === 'anthropic') {
        var Anthropic = require('@anthropic-ai/sdk');
        var aClient = new Anthropic({ apiKey: apiKey.trim() });
        var aModel = modelOverride || 'claude-haiku-4-5-20251001';
        var aRes = await aClient.messages.create({
          model: aModel,
          max_tokens: 20,
          messages: [{ role: 'user', content: 'Say "OK" and nothing else.' }],
        });
        return {
          success: true,
          model: aModel,
          response: aRes.content && aRes.content[0] ? aRes.content[0].text : '',
        };

      } else if (provider === 'openrouter') {
        var orClient = this._openRouterClient(apiKey);
        // Use user's selected model if provided, else fall back to a known-stable free model
        var orModel = modelOverride || this._cfg.openrouterModel || 'meta-llama/llama-3.3-70b-instruct:free';
        var orRes = await orClient.chat.completions.create({
          model: orModel,
          max_tokens: 20,
          messages: [{ role: 'user', content: 'Say "OK" and nothing else.' }],
        });
        return {
          success: true,
          model: orModel,
          response: orRes.choices && orRes.choices[0] ? orRes.choices[0].message.content : '',
        };

      } else {
        var OpenAI = require('openai');
        var oaiClient = new OpenAI({ apiKey: apiKey.trim() });
        var oaiModel = modelOverride || 'gpt-4o-mini';
        var oaiRes = await oaiClient.chat.completions.create({
          model: oaiModel,
          max_tokens: 20,
          messages: [{ role: 'user', content: 'Say "OK" and nothing else.' }],
        });
        return {
          success: true,
          model: oaiModel,
          response: oaiRes.choices && oaiRes.choices[0] ? oaiRes.choices[0].message.content : '',
        };
      }
    } catch (err) {
      // OpenRouter returns useful error structure — surface model name in message
      var msg = err && err.message ? err.message : String(err);
      return { success: false, error: msg };
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

// ─── Dynamic OpenRouter Free Model Fetcher ─────────────────────────────
// Fetches the real, currently-available list of free models from OpenRouter's
// public /models endpoint. Cached for 1 hour to avoid hammering their API.

var _openrouterModelCache = { models: null, fetchedAt: 0 };
var OPENROUTER_CACHE_MS = 60 * 60 * 1000; // 1 hour

async function fetchOpenRouterFreeModels(forceRefresh) {
  var now = Date.now();
  if (!forceRefresh && _openrouterModelCache.models && (now - _openrouterModelCache.fetchedAt) < OPENROUTER_CACHE_MS) {
    return _openrouterModelCache.models;
  }

  try {
    // Use built-in fetch (Node 18+). Fallback to axios if not available.
    var response;
    if (typeof fetch === 'function') {
      var res = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { 'Accept': 'application/json' },
      });
      if (!res.ok) throw new Error('OpenRouter /models returned HTTP ' + res.status);
      response = await res.json();
    } else {
      var axios = require('axios');
      var axRes = await axios.get('https://openrouter.ai/api/v1/models', { timeout: 15000 });
      response = axRes.data;
    }

    var data = (response && response.data) ? response.data : [];

    // Filter to free models only.
    // OpenRouter marks free models with `:free` suffix in id AND/OR pricing.prompt === "0"
    var freeModels = data.filter(function (m) {
      if (!m || !m.id) return false;
      var idIsFree = m.id.indexOf(':free') !== -1;
      var priceIsZero = m.pricing && (m.pricing.prompt === '0' || m.pricing.prompt === 0);
      return idIsFree || priceIsZero;
    });

    // Map to our shape, sort by context length descending (bigger = better default sort)
    var mapped = freeModels.map(function (m) {
      var ctx = m.context_length || 0;
      var ctxLabel = ctx >= 1000000 ? Math.round(ctx / 1000000) + 'M ctx'
                  : ctx >= 1000 ? Math.round(ctx / 1000) + 'k ctx'
                  : '';
      var name = m.name || m.id;
      // Strip provider prefix from name for cleaner display
      var displayName = name.replace(/^[^:]+:\s*/, '');
      return {
        id: m.id,
        name: displayName + (ctxLabel ? ' (' + ctxLabel + ')' : ''),
        tier: 'Free',
        type: 'standard',
        contextLength: ctx,
      };
    });

    // Sort: largest context first
    mapped.sort(function (a, b) { return (b.contextLength || 0) - (a.contextLength || 0); });

    // Cache and return
    _openrouterModelCache.models = mapped;
    _openrouterModelCache.fetchedAt = now;
    return mapped;
  } catch (err) {
    // On failure, return cached list (even if stale) or a SAFE fallback of well-known free models
    if (_openrouterModelCache.models && _openrouterModelCache.models.length > 0) {
      return _openrouterModelCache.models;
    }
    // Last-resort fallback — these are widely-known stable free model IDs.
    // If they're also gone, the user will see "no models available" and can refresh.
    return [
      { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B Instruct', tier: 'Free', type: 'standard', contextLength: 131072 },
      { id: 'google/gemini-2.0-flash-exp:free', name: 'Gemini 2.0 Flash Experimental', tier: 'Free', type: 'standard', contextLength: 1048576 },
      { id: 'deepseek/deepseek-chat:free', name: 'DeepSeek V3', tier: 'Free', type: 'standard', contextLength: 65536 },
      { id: 'deepseek/deepseek-r1:free', name: 'DeepSeek R1', tier: 'Free', type: 'reasoning', contextLength: 65536 },
      { id: 'qwen/qwen-2.5-72b-instruct:free', name: 'Qwen 2.5 72B Instruct', tier: 'Free', type: 'standard', contextLength: 32768 },
    ];
  }
}

module.exports = { ArticleRewriter, AI_MODELS, fetchOpenRouterFreeModels };
