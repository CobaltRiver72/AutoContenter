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
var CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes — in-memory only, cleared on shutdown
var TEXT_LIMIT = 12000;             // chars; raised from 5 000 to capture full articles

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
    if (Date.now() - entry.ts > CACHE_TTL_MS) {
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

    var text = articleText.slice(0, TEXT_LIMIT);
    var cacheKey = this._hashText(text);
    var cached = this._getCache(cacheKey);
    if (cached) {
      this.logger.info(MODULE, 'Cache hit for text hash ' + cacheKey);
      return cached;
    }

    options = options || {};
    var self = this;

    try {
      // Run both endpoints in parallel. Each failure is caught independently
      // so a single endpoint error doesn't wipe out the other result.
      var results = await Promise.all([
        this.analyzeText(text, { aiTopics: true }).catch(function (e) {
          self.logger.warn(MODULE, 'graphAndStatements failed: ' + e.message);
          return null;
        }),
        this.analyzeWithAdvice(text, options.optimize || 'gaps', signal).catch(function (e) {
          self.logger.warn(MODULE, 'graphAndAdvice failed: ' + e.message);
          return null;
        }),
      ]);

      var stmtResult   = results[0]; // graphAndStatements  → topics + entities
      var adviceResult = results[1]; // graphAndAdvice      → advice text

      if (!stmtResult && !adviceResult) return null;

      // ─── 1) AI advice — from graphAndAdvice only ───────────────────────
      var advice = null;
      if (adviceResult && Array.isArray(adviceResult.aiAdvice) && adviceResult.aiAdvice.length > 0) {
        var firstAdvice = adviceResult.aiAdvice[0];
        if (firstAdvice && typeof firstAdvice.text === 'string' && firstAdvice.text.length > 0) {
          advice = firstAdvice.text.slice(0, 2000);
        }
      }

      // ─── 2) graphSummary — prefer stmtResult, fall back to adviceResult ─
      var graphSummary = null;
      var summaryCandidate = stmtResult || adviceResult;
      if (typeof summaryCandidate.graphSummary === 'string' && summaryCandidate.graphSummary.length > 0) {
        graphSummary = summaryCandidate.graphSummary.slice(0, 1000);
      } else if (summaryCandidate.graph && typeof summaryCandidate.graph.graphSummary === 'string' && summaryCandidate.graph.graphSummary.length > 0) {
        graphSummary = summaryCandidate.graph.graphSummary.slice(0, 1000);
      }
      // If stmtResult had no summary, also check adviceResult
      if (!graphSummary && stmtResult && adviceResult) {
        if (typeof adviceResult.graphSummary === 'string' && adviceResult.graphSummary.length > 0) {
          graphSummary = adviceResult.graphSummary.slice(0, 1000);
        } else if (adviceResult.graph && typeof adviceResult.graph.graphSummary === 'string' && adviceResult.graph.graphSummary.length > 0) {
          graphSummary = adviceResult.graph.graphSummary.slice(0, 1000);
        }
      }

      // ─── 3) AI-extracted topics — from graphAndStatements only ────────
      var aiTopicsData = {};
      if (stmtResult) {
        aiTopicsData = stmtResult.aiTopics || (stmtResult.graph && stmtResult.graph.aiTopics) || {};
      }
      var mainTopics        = Array.isArray(aiTopicsData.mainTopics)        ? aiTopicsData.mainTopics.slice(0, 10)        : [];
      var contentGaps       = Array.isArray(aiTopicsData.contentGaps)       ? aiTopicsData.contentGaps.slice(0, 5)        : [];
      var researchQuestions = Array.isArray(aiTopicsData.researchQuestions) ? aiTopicsData.researchQuestions.slice(0, 3) : [];

      // ─── 4) Bridge concepts = entities never connected in the graph ────
      var statsData = stmtResult ? (stmtResult.stats || (stmtResult.graph && stmtResult.graph.stats) || {}) : {};
      var missingEntities = [];
      if (Array.isArray(statsData.gaps)) {
        for (var i = 0; i < statsData.gaps.length; i++) {
          var gap = statsData.gaps[i];
          if (gap && Array.isArray(gap.bridgeConcepts)) {
            for (var j = 0; j < gap.bridgeConcepts.length; j++) {
              if (missingEntities.indexOf(gap.bridgeConcepts[j]) === -1) {
                missingEntities.push(gap.bridgeConcepts[j]);
              }
            }
          }
        }
        missingEntities = missingEntities.slice(0, 10);
      }

      var enhancement = {
        mainTopics:        mainTopics,
        missingEntities:   missingEntities,
        contentGaps:       contentGaps,
        researchQuestions: researchQuestions,
        advice:            advice,
        graphSummary:      graphSummary,
        analyzedAt:        new Date().toISOString(),
        charsSent:         text.length,
      };

      this.logger.info(MODULE,
        'enhanceArticle complete — topics:' + mainTopics.length +
        ' entities:' + missingEntities.length +
        ' gaps:' + contentGaps.length +
        ' advice:' + (advice ? 'yes' : 'no') +
        ' summary:' + (graphSummary ? 'yes' : 'no')
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
   * Entity-level deep search: fetch AI advice, related search queries, and
   * topical analysis for a single entity word or phrase.
   *
   * Runs three calls in parallel:
   *   #10 googleSearchResultsAiAdvice → AI advice on what Google ranks for this entity
   *   #11 googleSearchIntentGraph     → related search queries / search intent
   *   #1  graphAndStatements(entity)  → topics/entities/gaps from the entity term itself
   *
   * IMPORTANT: Google search endpoints (#10, #11) default doNotSave to FALSE.
   * Always pass doNotSave: true in queryParams for these endpoints.
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
    var self = this;

    try {
      var results = await Promise.all([
        // #10 — AI advice on what Google currently ranks for this entity
        this._callAPI(
          '/api/v1/import/googleSearchResultsAiAdvice',
          {
            searchQuery: q,
            aiTopics: true,
            requestMode: 'summary',
            importCountry: opts.importCountry || 'US',
            importLanguage: opts.importLanguage || 'EN',
          },
          {
            doNotSave: true,
            addStats: true,
            optimize: 'gaps',
            includeGraphSummary: true,
            extendedGraphSummary: true,
          },
          signal
        ).catch(function (e) {
          self.logger.warn(MODULE, 'googleSearchResultsAiAdvice failed: ' + e.message);
          return null;
        }),

        // #11 — related search queries / reader search intent graph
        this._callAPI(
          '/api/v1/import/googleSearchIntentGraph',
          {
            searchQuery: q,
            aiTopics: true,
            keywordsSource: 'related',
            importCountry: opts.importCountry || 'US',
            importLanguage: opts.importLanguage || 'EN',
          },
          {
            doNotSave: true,
            addStats: true,
            includeGraphSummary: true,
            extendedGraphSummary: true,
          },
          signal
        ).catch(function (e) {
          self.logger.warn(MODULE, 'googleSearchIntentGraph failed: ' + e.message);
          return null;
        }),

        // #1 — text analysis of the entity term itself for topics/gaps/bridge concepts
        this.analyzeText(q, { aiTopics: true }).catch(function (e) {
          self.logger.warn(MODULE, 'analyzeText(entity) failed: ' + e.message);
          return null;
        }),
      ]);

      var adviceResult = results[0]; // #10 AI advice on Google results
      var intentResult = results[1]; // #11 search intent graph
      var stmtResult   = results[2]; // #1 text analysis

      if (!adviceResult && !intentResult && !stmtResult) return null;

      // ─── AI advice from #10 ───────────────────────────────────────────
      var advice = null;
      if (adviceResult && Array.isArray(adviceResult.aiAdvice) && adviceResult.aiAdvice.length > 0) {
        var firstAdvice = adviceResult.aiAdvice[0];
        if (firstAdvice && typeof firstAdvice.text === 'string' && firstAdvice.text.length > 0) {
          advice = firstAdvice.text.slice(0, 3000);
        }
      }

      // ─── graphSummary — prefer adviceResult, fall back to others ──────
      var graphSummary = null;
      var summaryOrder = [adviceResult, intentResult, stmtResult];
      for (var si = 0; si < summaryOrder.length; si++) {
        var sc = summaryOrder[si];
        if (!sc) continue;
        if (typeof sc.graphSummary === 'string' && sc.graphSummary.length > 0) {
          graphSummary = sc.graphSummary.slice(0, 1000);
          break;
        }
        if (sc.graph && typeof sc.graph.graphSummary === 'string' && sc.graph.graphSummary.length > 0) {
          graphSummary = sc.graph.graphSummary.slice(0, 1000);
          break;
        }
      }

      // ─── AI topics + gaps from stmtResult (#1) ───────────────────────
      var aiTopicsData = {};
      if (stmtResult) {
        aiTopicsData = stmtResult.aiTopics || (stmtResult.graph && stmtResult.graph.aiTopics) || {};
      }
      var mainTopics        = Array.isArray(aiTopicsData.mainTopics)        ? aiTopicsData.mainTopics.slice(0, 10)       : [];
      var contentGaps       = Array.isArray(aiTopicsData.contentGaps)       ? aiTopicsData.contentGaps.slice(0, 5)       : [];
      var researchQuestions = Array.isArray(aiTopicsData.researchQuestions) ? aiTopicsData.researchQuestions.slice(0, 5) : [];

      // ─── Bridge concepts (entities in gaps) from stmtResult ──────────
      var statsData = stmtResult ? (stmtResult.stats || (stmtResult.graph && stmtResult.graph.stats) || {}) : {};
      var missingEntities = [];
      if (Array.isArray(statsData.gaps)) {
        for (var i = 0; i < statsData.gaps.length; i++) {
          var gap = statsData.gaps[i];
          if (gap && Array.isArray(gap.bridgeConcepts)) {
            for (var j = 0; j < gap.bridgeConcepts.length; j++) {
              if (missingEntities.indexOf(gap.bridgeConcepts[j]) === -1) {
                missingEntities.push(gap.bridgeConcepts[j]);
              }
            }
          }
        }
        missingEntities = missingEntities.slice(0, 10);
      }

      // ─── Related search queries from intentResult (#11) ──────────────
      // #11 response is same shape as #1 (statements + graph at root)
      var relatedQueries = [];
      if (intentResult) {
        var intentTopics = intentResult.aiTopics || (intentResult.graph && intentResult.graph.aiTopics) || {};
        if (Array.isArray(intentTopics.mainTopics) && intentTopics.mainTopics.length) {
          relatedQueries = intentTopics.mainTopics.slice(0, 10);
        }
        // Fall back to raw statements if aiTopics is empty
        if (!relatedQueries.length) {
          var stmts = intentResult.statements ||
                      (intentResult.entriesAndGraphOfContext && intentResult.entriesAndGraphOfContext.statements) || [];
          for (var k = 0; k < stmts.length && relatedQueries.length < 10; k++) {
            var s = stmts[k];
            var content = (s && s.content) ? s.content : null;
            if (content && relatedQueries.indexOf(content) === -1) {
              relatedQueries.push(content);
            }
          }
        }
      }

      var searchResult = {
        entity:            q,
        advice:            advice,
        mainTopics:        mainTopics,
        missingEntities:   missingEntities,
        contentGaps:       contentGaps,
        researchQuestions: researchQuestions,
        relatedQueries:    relatedQueries,
        graphSummary:      graphSummary,
        analyzedAt:        new Date().toISOString(),
      };

      this.logger.info(MODULE,
        'searchEntity "' + q + '" — topics:' + mainTopics.length +
        ' related:' + relatedQueries.length +
        ' advice:' + (advice ? 'yes' : 'no')
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
