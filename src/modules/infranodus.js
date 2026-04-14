'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// InfraNodus integration — knowledge graph + AI advice for the rewriter prompt
//
// Authoritative reference (read this BEFORE editing):
//   /INFRANODUS_API_REFERENCE.md  at the repo root.
//
// Key API rules learned the hard way:
//   1. InfraNodus separates QUERY params (URL ?foo=bar) from BODY params (JSON).
//      _callAPI() takes them as separate args; never mix them.
//   2. AI advice text comes back as `aiAdvice[0].text` — NOT a flat `.advice` string.
//   3. /api/v1/dotGraphFromText does NOT accept `doNotSave` (it's a pure transform).
//   4. /api/v1/graphAndAdvice needs `requestMode` set or behavior is unspecified.
//   5. `optimize: 'gaps'` (plural) is canonical across endpoints; the singular
//      `'gap'` shown in the endpoint #2 docs is a documentation typo.
// ─────────────────────────────────────────────────────────────────────────────

var EventEmitter = require('events').EventEmitter;
var crypto = require('crypto');
var axios = require('axios');
var { sanitizeAxiosError } = require('../utils/safe-http');

var MODULE = 'infranodus';
var API_BASE = 'https://infranodus.com';
// Read at use time for hot-reload
var _cfg = require('../utils/config');
function _cacheTtlMs() { return (parseInt(_cfg.get('INFRANODUS_CACHE_TTL_MINUTES'), 10) || 30) * 60 * 1000; }
function _textLimit()  { return parseInt(_cfg.get('INFRANODUS_TEXT_LIMIT'), 10) || 12000; }

class InfranodusAnalyzer extends EventEmitter {
  constructor(config, db, logger) {
    super();
    this.config = config;
    this.db = db;
    this.logger = logger;

    this.enabled = false;
    this.ready = false;
    this.status = 'disabled';
    this.error = null;
    this.lastActivity = null;
    this.apiKey = null;
    this.stats = { analysesRun: 0 };
    this._cache = new Map(); // key: sha256(text).slice(0,16); value: { data, ts }
  }

  async init() {
    try {
      var apiKey = this.config.INFRANODUS_API_KEY;
      var isEnabled = String(this.config.INFRANODUS_ENABLED).toLowerCase() === 'true' ||
                      this.config.INFRANODUS_ENABLED === true;

      if (!isEnabled || !apiKey) {
        this.status = 'disabled';
        return;
      }

      this.apiKey = apiKey;
      this.enabled = true;
      this.ready = true;
      this.status = 'connected';
      this.logger.info(MODULE, 'InfraNodus analyzer initialized');
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      this.logger.warn(MODULE, 'Init failed: ' + sanitizeAxiosError(err).message);
    }
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  _hashText(text) {
    return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
  }

  _getCache(key) {
    var entry = this._cache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > _cacheTtlMs()) {
      this._cache.delete(key);
      return null;
    }
    return entry.data;
  }

  _setCache(key, data) {
    this._cache.set(key, { data: data, ts: Date.now() });
  }

  /**
   * POST to an InfraNodus endpoint with strict query/body separation.
   *
   * @param {string} endpoint     - e.g. '/api/v1/graphAndAdvice'
   * @param {object} body         - JSON body parameters per InfraNodus body spec
   * @param {object} queryParams  - URL query parameters per InfraNodus query spec
   * @param {AbortSignal} [signal] - AbortController.signal for graceful shutdown
   * @returns {Promise<object>}   response.data
   *
   * Single retry with 5 s delay on transient failure. Aborted requests are
   * NOT retried. All errors are passed through sanitizeAxiosError() to scrub
   * Bearer tokens before they reach logs.
   */
  async _callAPI(endpoint, body, queryParams, signal) {
    var options = {
      headers: {
        'Authorization': 'Bearer ' + this.apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    };
    if (queryParams) options.params = queryParams; // axios serializes to URL query string
    if (signal) options.signal = signal;

    for (var attempt = 1; attempt <= 2; attempt++) {
      try {
        var response = await axios.post(API_BASE + endpoint, body, options);
        this.stats.analysesRun++;
        this.lastActivity = new Date().toISOString();
        return response.data;
      } catch (err) {
        var isAbort = err.name === 'AbortError' || err.code === 'ERR_CANCELED' ||
                      (signal && signal.aborted);
        if (attempt === 2 || isAbort) {
          throw sanitizeAxiosError(err);
        }
        this.logger.warn(MODULE,
          'API ' + endpoint + ' failed (attempt ' + attempt + '), retrying in 5s: ' +
          sanitizeAxiosError(err).message);
        await new Promise(function (resolve) { setTimeout(resolve, 5000); });
      }
    }
  }

  // ─── Public analysis methods ─────────────────────────────────────────────

  /**
   * Endpoint #1: POST /api/v1/graphAndStatements
   * Lighter analysis (graph + topics + stats) without AI advice. Used by the
   * dashboard's "test connection" route and by getEntityClusters/getContentGaps.
   *
   * This is ALSO the source of aiTopics, stats.gaps, and graphSummary for
   * enhanceArticle() — graphAndAdvice (#2) does NOT return aiTopics data.
   */
  async analyzeText(text, options) {
    if (!this.enabled || !this.ready) return null;
    options = options || {};
    try {
      return await this._callAPI(
        '/api/v1/graphAndStatements',
        // ─── body ─────────────────────────────────────
        {
          text: text,
          aiTopics: options.aiTopics !== false,
        },
        // ─── query ────────────────────────────────────
        {
          doNotSave: true,
          addStats: true,
          compactGraph: true,
          includeGraphSummary: true,
          extendedGraphSummary: true,
          gapDepth: 1, // one level deeper for richer entity bridge detection
        }
      );
    } catch (err) {
      this.logger.error(MODULE, 'analyzeText failed: ' + err.message);
      return null;
    }
  }

  /**
   * Endpoint #2: POST /api/v1/graphAndAdvice
   * Text → graph + AI-generated advice via LLM.
   *
   * Configured to return EVERYTHING in one response: graph, stats, aiTopics,
   * aiAdvice, graphSummary. enhanceArticle() relies on this single-call shape.
   *
   * @param {string} text
   * @param {string} [optimizeMode] - 'gaps' (default) | 'develop' | 'reinforce' | 'imagine'
   * @param {AbortSignal} [signal]
   */
  async analyzeWithAdvice(text, optimizeMode, signal) {
    if (!this.enabled || !this.ready) return null;
    try {
      return await this._callAPI(
        '/api/v1/graphAndAdvice',
        // ─── body ─────────────────────────────────────
        {
          text: text,
          // 'summary' → graph-augmented summary; ideal for content-strategy
          // injection into the rewriter prompt.
          requestMode: 'summary',
          // body-level toggle — enables AI topic extraction in the response
          aiTopics: true,
        },
        // ─── query ────────────────────────────────────
        {
          doNotSave: true,
          addStats: true,
          optimize: optimizeMode || 'gaps',
          includeGraph: true,
          includeGraphSummary: true,
          extendedGraphSummary: true,
          gapDepth: 1, // one step deeper than default for richer gap detection
        },
        signal
      );
    } catch (err) {
      this.logger.error(MODULE, 'analyzeWithAdvice failed: ' + err.message);
      return null;
    }
  }

  /**
   * Endpoint #3: POST /api/v1/dotGraphFromText
   * Compact DOT graph + graphSummary, designed for direct LLM prompt injection.
   * Kept as a public helper — enhanceArticle() does NOT call this because
   * graphAndAdvice already returns graphSummary when configured correctly.
   *
   * IMPORTANT: doNotSave is NOT a valid parameter for this endpoint (pure transform).
   */
  async getCompactGraph(text, signal) {
    if (!this.enabled || !this.ready) return null;
    try {
      return await this._callAPI(
        '/api/v1/dotGraphFromText',
        // ─── body ─────────────────────────────────────
        {
          text: text,
          aiTopics: true, // unlocks clusterKeywords + allClusters in response
        },
        // ─── query (NO doNotSave here — not a valid param) ─
        {
          optimize: 'gaps',
          includeGraph: false,
          includeGraphSummary: true,
          extendedGraphSummary: true,
        },
        signal
      );
    } catch (err) {
      this.logger.error(MODULE, 'getCompactGraph failed: ' + err.message);
      return null;
    }
  }

  /**
   * Main pipeline entry point (post-extraction B5 + pre-rewrite).
   *
   * Runs TWO calls in parallel:
   *   #1 graphAndStatements → aiTopics (mainTopics/contentGaps/researchQuestions)
   *                           + stats.gaps (missingEntities/bridgeConcepts)
   *                           + graphSummary
   *   #2 graphAndAdvice     → aiAdvice[0].text (content strategy advice)
   *
   * NOTE: graphAndAdvice does NOT return aiTopics or stats — those only come
   * from graphAndStatements. This was confirmed by observing advice=yes but
   * topics=0 when using graphAndAdvice alone.
   *
   * Cached by sha256(text) for 30 min — same text within a session is free.
   * Both calls share the same AbortSignal so cancellation is clean.
   */
  async enhanceArticle(articleText, options, signal) {
    if (!this.enabled || !this.ready) return null;
    if (!articleText || articleText.length < 200) return null;

    var text    = articleText.slice(0, _textLimit());
    var keyword = (options && options.targetKeyword) ? String(options.targetKeyword).trim().slice(0, 200) : null;

    // Cache key includes keyword so same text + different keyword = fresh fetch
    var cacheKey = this._hashText(text + (keyword ? '|kw:' + keyword : ''));
    var cached = this._getCache(cacheKey);
    if (cached) {
      this.logger.info(MODULE, 'Cache hit for text hash ' + cacheKey);
      return cached;
    }

    options = options || {};
    var self    = this;
    var country = 'US';
    var lang    = 'EN';

    try {
      // ─── Build parallel call list ────────────────────────────────────
      // Slots 0–2 always run (text-based).
      // Slots 3–7 run only when a targetKeyword is available (Google search).
      var calls = [
        // #1 graphAndStatements → topics / bridge concepts / gaps
        this.analyzeText(text, { aiTopics: true }).catch(function (e) {
          self.logger.warn(MODULE, 'graphAndStatements failed: ' + e.message); return null;
        }),
        // #2 graphAndAdvice → article-level AI advice text
        this.analyzeWithAdvice(text, options.optimize || 'gaps', signal).catch(function (e) {
          self.logger.warn(MODULE, 'graphAndAdvice failed: ' + e.message); return null;
        }),
        // #3 dotGraphFromText → bigrams + cluster descriptions
        this._callAPI(
          '/api/v1/dotGraphFromText',
          { text: text, aiTopics: true },
          { optimize: 'gaps', includeGraph: false, includeGraphSummary: true, extendedGraphSummary: true },
          signal
        ).catch(function (e) { self.logger.warn(MODULE, 'dotGraphFromText failed: ' + e.message); return null; }),
      ];

      if (keyword) {
        calls.push(
          // #10 — AI advice on what currently ranks for the target keyword
          this._callAPI(
            '/api/v1/import/googleSearchResultsAiAdvice',
            { searchQuery: keyword, aiTopics: true, requestMode: 'summary', importCountry: country, importLanguage: lang },
            { doNotSave: true, addStats: true, optimize: 'gaps', includeGraphSummary: true, extendedGraphSummary: true },
            signal
          ).catch(function (e) { self.logger.warn(MODULE, 'googleSearchResultsAiAdvice failed: ' + e.message); return null; }),
          // #11 — related search queries / reader intent
          this._callAPI(
            '/api/v1/import/googleSearchIntentGraph',
            { searchQuery: keyword, aiTopics: true, keywordsSource: 'related', importCountry: country, importLanguage: lang },
            { doNotSave: true, addStats: true, includeGraphSummary: true, extendedGraphSummary: true },
            signal
          ).catch(function (e) { self.logger.warn(MODULE, 'googleSearchIntentGraph failed: ' + e.message); return null; }),
          // #12 — AI advice on search intent (what readers want)
          this._callAPI(
            '/api/v1/import/googleSearchIntentAiAdvice',
            { searchQuery: keyword, aiTopics: true, requestMode: 'summary', keywordsSource: 'related', importCountry: country, importLanguage: lang },
            { doNotSave: true, addStats: true, optimize: 'gaps', includeGraphSummary: true, extendedGraphSummary: true },
            signal
          ).catch(function (e) { self.logger.warn(MODULE, 'googleSearchIntentAiAdvice failed: ' + e.message); return null; }),
          // #13 — supply-vs-demand graph
          this._callAPI(
            '/api/v1/import/googleSearchVsIntentGraph',
            { searchQuery: keyword, aiTopics: true },
            { doNotSave: true, addStats: true, compareMode: 'difference', includeGraphSummary: true, extendedGraphSummary: true },
            signal
          ).catch(function (e) { self.logger.warn(MODULE, 'googleSearchVsIntentGraph failed: ' + e.message); return null; }),
          // #14 — AI advice on supply/demand gap (best SEO insight)
          this._callAPI(
            '/api/v1/import/googleSearchVsIntentAiAdvice',
            { searchQuery: keyword, aiTopics: true, requestMode: 'summary', keywordsSource: 'related' },
            { doNotSave: true, addStats: true, compareMode: 'difference', optimize: 'gaps', includeGraphSummary: true, extendedGraphSummary: true },
            signal
          ).catch(function (e) { self.logger.warn(MODULE, 'googleSearchVsIntentAiAdvice failed: ' + e.message); return null; })
        );
      }

      var results = await Promise.all(calls);

      var stmtResult         = results[0]; // #1
      var adviceResult       = results[1]; // #2
      var dotResult          = results[2]; // #3
      var rankingAdvResult   = keyword ? results[3] : null; // #10
      var intentGResult      = keyword ? results[4] : null; // #11
      var intentAResult      = keyword ? results[5] : null; // #12
      var vsIntentGResult    = keyword ? results[6] : null; // #13
      var gapAdvResult       = keyword ? results[7] : null; // #14

      if (!stmtResult && !adviceResult) return null;

      // ─── Reused helpers (same as searchEntity) ───────────────────────
      function _extractAdvice(r, maxLen) {
        if (!r || !Array.isArray(r.aiAdvice) || !r.aiAdvice.length) return null;
        var t = r.aiAdvice[0];
        return (t && typeof t.text === 'string' && t.text.length > 0) ? t.text.slice(0, maxLen || 2000) : null;
      }
      function _extractTopicsData(r) {
        if (!r) return {};
        return r.aiTopics || (r.graph && r.graph.aiTopics) || {};
      }
      function _extractMainTopics(r, max) {
        var td = _extractTopicsData(r);
        if (Array.isArray(td.mainTopics) && td.mainTopics.length) return td.mainTopics.slice(0, max || 10);
        var stmts = (r && r.statements) || (r && r.entriesAndGraphOfContext && r.entriesAndGraphOfContext.statements) || [];
        var out = [];
        for (var si = 0; si < stmts.length && out.length < (max || 10); si++) {
          var c = stmts[si] && stmts[si].content;
          if (c && out.indexOf(c) === -1) out.push(c);
        }
        return out;
      }

      // ─── Article-level advice (#2) ────────────────────────────────────
      var advice = _extractAdvice(adviceResult, 2000);

      // ─── Keyword-level advice (#10, #12, #14) ────────────────────────
      var rankingAdvice = _extractAdvice(rankingAdvResult, 2000);
      var intentAdvice  = _extractAdvice(intentAResult,   2000);
      var gapAdvice     = _extractAdvice(gapAdvResult,    2000);

      // ─── graphSummary — best available ───────────────────────────────
      var graphSummary = null;
      var summaryOrder = [dotResult, stmtResult, adviceResult, rankingAdvResult];
      for (var si = 0; si < summaryOrder.length; si++) {
        var sc = summaryOrder[si];
        if (!sc) continue;
        if (typeof sc.graphSummary === 'string' && sc.graphSummary.length > 0) { graphSummary = sc.graphSummary.slice(0, 1500); break; }
        if (sc.graph && typeof sc.graph.graphSummary === 'string' && sc.graph.graphSummary.length > 0) { graphSummary = sc.graph.graphSummary.slice(0, 1500); break; }
      }

      // ─── Topics / gaps / questions from #1 ───────────────────────────
      var aiTopicsData      = _extractTopicsData(stmtResult);
      var mainTopics        = Array.isArray(aiTopicsData.mainTopics)        ? aiTopicsData.mainTopics.slice(0, 10)       : [];
      var contentGaps       = Array.isArray(aiTopicsData.contentGaps)       ? aiTopicsData.contentGaps.slice(0, 5)       : [];
      var researchQuestions = Array.isArray(aiTopicsData.researchQuestions) ? aiTopicsData.researchQuestions.slice(0, 5) : [];

      // ─── Bridge concepts from #1 ─────────────────────────────────────
      var statsData = stmtResult ? (stmtResult.stats || (stmtResult.graph && stmtResult.graph.stats) || {}) : {};
      var missingEntities = [];
      if (Array.isArray(statsData.gaps)) {
        for (var i = 0; i < statsData.gaps.length; i++) {
          var gap = statsData.gaps[i];
          if (gap && Array.isArray(gap.bridgeConcepts)) {
            for (var j = 0; j < gap.bridgeConcepts.length; j++) {
              if (missingEntities.indexOf(gap.bridgeConcepts[j]) === -1) missingEntities.push(gap.bridgeConcepts[j]);
            }
          }
        }
        missingEntities = missingEntities.slice(0, 10);
      }

      // ─── Related queries (#11) + demand topics/gaps (#13) ────────────
      var relatedQueries = _extractMainTopics(intentGResult, 12);
      var demandTopics   = _extractMainTopics(vsIntentGResult, 12);
      var vsTopicsData   = _extractTopicsData(vsIntentGResult);
      var demandGaps     = Array.isArray(vsTopicsData.contentGaps) ? vsTopicsData.contentGaps.slice(0, 5) : [];

      // ─── Bigrams + cluster descriptions from #3 ──────────────────────
      var bigrams = [];
      var clusterDescriptions = [];
      if (dotResult) {
        if (Array.isArray(dotResult.bigrams)) bigrams = dotResult.bigrams.slice(0, 15);
        if (Array.isArray(dotResult.allClusters)) {
          for (var ci = 0; ci < dotResult.allClusters.length; ci++) {
            var cl = dotResult.allClusters[ci];
            if (cl && typeof cl.text === 'string' && cl.text.trim()) clusterDescriptions.push(cl.text.trim());
          }
        }
        if (!clusterDescriptions.length && typeof dotResult.clusterKeywords === 'string' && dotResult.clusterKeywords.trim()) {
          clusterDescriptions = [dotResult.clusterKeywords.trim()];
        }
      }

      var enhancement = {
        // Text-analysis fields (always present)
        mainTopics:           mainTopics,
        missingEntities:      missingEntities,
        contentGaps:          contentGaps,
        researchQuestions:    researchQuestions,
        advice:               advice,
        graphSummary:         graphSummary,
        bigrams:              bigrams,
        clusterDescriptions:  clusterDescriptions,
        // Keyword/SEO fields (present only when targetKeyword was supplied)
        targetKeyword:        keyword || null,
        rankingAdvice:        rankingAdvice,
        intentAdvice:         intentAdvice,
        gapAdvice:            gapAdvice,
        relatedQueries:       relatedQueries,
        demandTopics:         demandTopics,
        demandGaps:           demandGaps,
        // Meta
        analyzedAt:           new Date().toISOString(),
        charsSent:            text.length,
      };

      this.logger.info(MODULE,
        'enhanceArticle complete — topics:' + mainTopics.length +
        ' entities:' + missingEntities.length +
        ' bigrams:' + bigrams.length +
        (keyword ? ' keyword:"' + keyword + '"' : '') +
        ' rankingAdv:' + (rankingAdvice ? 'yes' : 'no') +
        ' gapAdv:' + (gapAdvice ? 'yes' : 'no')
      );

      this._setCache(cacheKey, enhancement);
      this.lastActivity = new Date().toISOString();
      return enhancement;

    } catch (err) {
      this.logger.error(MODULE, 'enhanceArticle failed: ' + sanitizeAxiosError(err).message);
      return null;
    }
  }

  /**
   * Entity-level deep search — runs 7 InfraNodus API calls in parallel and
   * returns everything the API can tell us about an entity / keyword.
   *
   * Parallel calls:
   *   #10 googleSearchResultsAiAdvice  → AI advice on what Google currently ranks
   *   #11 googleSearchIntentGraph      → related search queries / reader intent
   *   #12 googleSearchIntentAiAdvice   → AI advice on what readers want to know
   *   #13 googleSearchVsIntentGraph    → supply-vs-demand gap graph
   *   #14 googleSearchVsIntentAiAdvice → AI advice on supply/demand gaps
   *   #3  dotGraphFromText(entity)     → bigrams + topic cluster descriptions
   *   #1  graphAndStatements(entity)   → topics / bridge concepts / gaps
   *
   * IMPORTANT: Google search endpoints (#10–#14) default doNotSave to FALSE.
   * Always pass doNotSave: true in queryParams.
   *
   * @param {string} entity  - single word or short phrase
   * @param {object} [opts]
   * @param {AbortSignal} [signal]
   */
  async searchEntity(entity, opts, signal) {
    if (!this.enabled || !this.ready) return null;
    if (!entity || !entity.trim()) return null;

    var q = entity.trim().slice(0, 200);
    opts = opts || {};
    var country  = opts.importCountry  || 'US';
    var language = opts.importLanguage || 'EN';
    var self = this;

    try {
      var results = await Promise.all([

        // #10 — AI advice on what Google currently ranks for this entity
        this._callAPI(
          '/api/v1/import/googleSearchResultsAiAdvice',
          { searchQuery: q, aiTopics: true, requestMode: 'summary', importCountry: country, importLanguage: language },
          { doNotSave: true, addStats: true, optimize: 'gaps', includeGraphSummary: true, extendedGraphSummary: true },
          signal
        ).catch(function (e) { self.logger.warn(MODULE, 'googleSearchResultsAiAdvice: ' + e.message); return null; }),

        // #11 — related search queries / reader search intent graph
        this._callAPI(
          '/api/v1/import/googleSearchIntentGraph',
          { searchQuery: q, aiTopics: true, keywordsSource: 'related', importCountry: country, importLanguage: language },
          { doNotSave: true, addStats: true, includeGraphSummary: true, extendedGraphSummary: true },
          signal
        ).catch(function (e) { self.logger.warn(MODULE, 'googleSearchIntentGraph: ' + e.message); return null; }),

        // #12 — AI advice on what readers want to know (intent-focused)
        this._callAPI(
          '/api/v1/import/googleSearchIntentAiAdvice',
          { searchQuery: q, aiTopics: true, requestMode: 'summary', keywordsSource: 'related', importCountry: country, importLanguage: language },
          { doNotSave: true, addStats: true, optimize: 'gaps', includeGraphSummary: true, extendedGraphSummary: true },
          signal
        ).catch(function (e) { self.logger.warn(MODULE, 'googleSearchIntentAiAdvice: ' + e.message); return null; }),

        // #13 — supply-vs-demand: what people search for vs. what's published
        this._callAPI(
          '/api/v1/import/googleSearchVsIntentGraph',
          { searchQuery: q, aiTopics: true },
          { doNotSave: true, addStats: true, compareMode: 'difference', includeGraphSummary: true, extendedGraphSummary: true },
          signal
        ).catch(function (e) { self.logger.warn(MODULE, 'googleSearchVsIntentGraph: ' + e.message); return null; }),

        // #14 — AI advice on the supply/demand gap (highest-value SEO insight)
        this._callAPI(
          '/api/v1/import/googleSearchVsIntentAiAdvice',
          { searchQuery: q, aiTopics: true, requestMode: 'summary', keywordsSource: 'related' },
          { doNotSave: true, addStats: true, compareMode: 'difference', optimize: 'gaps', includeGraphSummary: true, extendedGraphSummary: true },
          signal
        ).catch(function (e) { self.logger.warn(MODULE, 'googleSearchVsIntentAiAdvice: ' + e.message); return null; }),

        // #3 — compact graph of the entity term: bigrams + cluster descriptions
        // NOTE: doNotSave is NOT a valid param for dotGraphFromText (pure transform)
        this._callAPI(
          '/api/v1/dotGraphFromText',
          { text: q, aiTopics: true },
          { optimize: 'gaps', includeGraph: false, includeGraphSummary: true, extendedGraphSummary: true },
          signal
        ).catch(function (e) { self.logger.warn(MODULE, 'dotGraphFromText(entity): ' + e.message); return null; }),

        // #1 — text analysis of the entity term for topics/bridge concepts/gaps
        this.analyzeText(q, { aiTopics: true }).catch(function (e) {
          self.logger.warn(MODULE, 'analyzeText(entity): ' + e.message); return null;
        }),

      ]);

      var rankingAdviceResult  = results[0]; // #10
      var intentGraphResult    = results[1]; // #11
      var intentAdviceResult   = results[2]; // #12
      var vsIntentGraphResult  = results[3]; // #13
      var gapAdviceResult      = results[4]; // #14
      var dotResult            = results[5]; // #3
      var stmtResult           = results[6]; // #1

      if (!rankingAdviceResult && !intentGraphResult && !intentAdviceResult &&
          !vsIntentGraphResult && !gapAdviceResult && !dotResult && !stmtResult) {
        return null;
      }

      // ─── Helper: extract first aiAdvice text from a result ────────────
      function _extractAdvice(r, maxLen) {
        if (!r || !Array.isArray(r.aiAdvice) || !r.aiAdvice.length) return null;
        var t = r.aiAdvice[0];
        return (t && typeof t.text === 'string' && t.text.length > 0) ? t.text.slice(0, maxLen || 3000) : null;
      }

      // ─── Helper: extract aiTopics object from various response shapes ──
      function _extractTopicsData(r) {
        if (!r) return {};
        return r.aiTopics || (r.graph && r.graph.aiTopics) || {};
      }

      // ─── Helper: extract graphSummary from various shapes ─────────────
      function _extractSummary(r) {
        if (!r) return null;
        if (typeof r.graphSummary === 'string' && r.graphSummary.length > 0) return r.graphSummary.slice(0, 1000);
        if (r.graph && typeof r.graph.graphSummary === 'string' && r.graph.graphSummary.length > 0) return r.graph.graphSummary.slice(0, 1000);
        return null;
      }

      // ─── Helper: extract bridge concepts from statsData.gaps ──────────
      function _extractBridges(r) {
        var statsData = r ? (r.stats || (r.graph && r.graph.stats) || {}) : {};
        var out = [];
        if (Array.isArray(statsData.gaps)) {
          for (var gi = 0; gi < statsData.gaps.length; gi++) {
            var gp = statsData.gaps[gi];
            if (gp && Array.isArray(gp.bridgeConcepts)) {
              for (var bi = 0; bi < gp.bridgeConcepts.length; bi++) {
                if (out.indexOf(gp.bridgeConcepts[bi]) === -1) out.push(gp.bridgeConcepts[bi]);
              }
            }
          }
        }
        return out.slice(0, 10);
      }

      // ─── Helper: extract mainTopics from intent/graph results ─────────
      function _extractMainTopics(r, max) {
        var td = _extractTopicsData(r);
        if (Array.isArray(td.mainTopics) && td.mainTopics.length) return td.mainTopics.slice(0, max || 10);
        // Fallback to raw statements
        var stmts = (r && r.statements) ||
                    (r && r.entriesAndGraphOfContext && r.entriesAndGraphOfContext.statements) || [];
        var out = [];
        for (var si = 0; si < stmts.length && out.length < (max || 10); si++) {
          var c = stmts[si] && stmts[si].content;
          if (c && out.indexOf(c) === -1) out.push(c);
        }
        return out;
      }

      // ─── 1. Three AI advice texts ──────────────────────────────────────
      var rankingAdvice = _extractAdvice(rankingAdviceResult, 3000); // what ranks
      var intentAdvice  = _extractAdvice(intentAdviceResult,  3000); // what readers want
      var gapAdvice     = _extractAdvice(gapAdviceResult,     3000); // supply/demand gap

      // ─── 2. graphSummary — best available ─────────────────────────────
      var graphSummary = _extractSummary(dotResult) ||
                         _extractSummary(rankingAdviceResult) ||
                         _extractSummary(stmtResult) ||
                         _extractSummary(intentGraphResult) ||
                         null;

      // ─── 3. Topics from #1 (entity text analysis) ─────────────────────
      var stmtTopics    = _extractTopicsData(stmtResult);
      var mainTopics        = Array.isArray(stmtTopics.mainTopics)        ? stmtTopics.mainTopics.slice(0, 10)       : [];
      var contentGaps       = Array.isArray(stmtTopics.contentGaps)       ? stmtTopics.contentGaps.slice(0, 5)       : [];
      var researchQuestions = Array.isArray(stmtTopics.researchQuestions) ? stmtTopics.researchQuestions.slice(0, 5) : [];
      var missingEntities   = _extractBridges(stmtResult);

      // ─── 4. Related search queries from #11 ───────────────────────────
      var relatedQueries = _extractMainTopics(intentGraphResult, 12);

      // ─── 5. High-demand topics from #13 (supply/demand gap) ───────────
      var demandTopics = _extractMainTopics(vsIntentGraphResult, 12);
      var demandTopicsData = _extractTopicsData(vsIntentGraphResult);
      var demandGaps = Array.isArray(demandTopicsData.contentGaps) ? demandTopicsData.contentGaps.slice(0, 5) : [];

      // ─── 6. Bigrams + cluster descriptions from #3 ────────────────────
      var bigrams = [];
      var clusterDescriptions = [];
      if (dotResult) {
        if (Array.isArray(dotResult.bigrams)) {
          bigrams = dotResult.bigrams.slice(0, 15);
        }
        if (Array.isArray(dotResult.allClusters)) {
          for (var ci = 0; ci < dotResult.allClusters.length; ci++) {
            var cl = dotResult.allClusters[ci];
            if (cl && typeof cl.text === 'string' && cl.text.trim()) {
              clusterDescriptions.push(cl.text.trim());
            }
          }
        }
        if (!clusterDescriptions.length && typeof dotResult.clusterKeywords === 'string' && dotResult.clusterKeywords.trim()) {
          clusterDescriptions = [dotResult.clusterKeywords.trim()];
        }
      }

      var searchResult = {
        entity:               q,
        // Three AI advice texts
        rankingAdvice:        rankingAdvice,
        intentAdvice:         intentAdvice,
        gapAdvice:            gapAdvice,
        // Topic data
        mainTopics:           mainTopics,
        missingEntities:      missingEntities,
        contentGaps:          contentGaps,
        researchQuestions:    researchQuestions,
        // Search query data
        relatedQueries:       relatedQueries,
        // Supply/demand data
        demandTopics:         demandTopics,
        demandGaps:           demandGaps,
        // Concept graph data
        bigrams:              bigrams,
        clusterDescriptions:  clusterDescriptions,
        graphSummary:         graphSummary,
        analyzedAt:           new Date().toISOString(),
      };

      this.logger.info(MODULE,
        'searchEntity "' + q + '" — topics:' + mainTopics.length +
        ' related:' + relatedQueries.length +
        ' demand:' + demandTopics.length +
        ' bigrams:' + bigrams.length +
        ' rankingAdvice:' + (rankingAdvice ? 'yes' : 'no') +
        ' intentAdvice:' + (intentAdvice ? 'yes' : 'no') +
        ' gapAdvice:' + (gapAdvice ? 'yes' : 'no')
      );

      return searchResult;

    } catch (err) {
      this.logger.error(MODULE, 'searchEntity failed: ' + sanitizeAxiosError(err).message);
      return null;
    }
  }

  async getEntityClusters(text) {
    var result = await this.analyzeText(text);
    if (!result || !result.stats || !result.stats.topClusters) return [];
    return result.stats.topClusters.map(function(c) {
      return {
        clusterName: c.name,
        entities: c.keywords || [],
        influence: c.influence || 0,
        connectivity: c.connectivity || 0
      };
    });
  }

  async getContentGaps(text) {
    var result = await this.analyzeText(text);
    if (!result || !result.stats || !result.stats.gaps) return [];
    return result.stats.gaps.map(function(g) {
      return {
        gap: g.between ? g.between.join(' <> ') : '',
        bridgeConcepts: g.bridgeConcepts || [],
        suggestion: g.suggestion || ''
      };
    });
  }

  getHealth() {
    return {
      module: 'infranodus',
      enabled: this.enabled,
      ready: this.ready,
      status: this.status,
      error: this.error,
      lastActivity: this.lastActivity,
      stats: this.stats
    };
  }

  getStatus() {
    return {
      enabled: this.enabled,
      analysesRun: this.stats.analysesRun,
      lastActivity: this.lastActivity,
    };
  }

  async shutdown() {
    this.enabled = false;
    this.ready = false;
    this.status = 'disabled';
    this._cache.clear();
  }
}

module.exports = { InfranodusAnalyzer };
