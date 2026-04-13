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
   * ONE call to graphAndAdvice returns everything we need:
   *   - mainTopics, missingEntities, contentGaps, researchQuestions
   *   - advice (from aiAdvice[0].text)
   *   - graphSummary
   *
   * Cached by sha256(text) for 30 min — same text within a session is free.
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

    try {
      var result = await this.analyzeWithAdvice(
        text,
        options.optimize || 'gaps',
        signal
      );

      if (!result) return null;

      // ─── Defensive response parsing ─────────────────────────────────────
      // graphAndAdvice may place fields at root OR nested in result.graph.
      // We check both locations for every field we care about.

      // 1) AI advice text — array form, NOT a flat .advice string
      var advice = null;
      if (Array.isArray(result.aiAdvice) && result.aiAdvice.length > 0) {
        var firstAdvice = result.aiAdvice[0];
        if (firstAdvice && typeof firstAdvice.text === 'string' && firstAdvice.text.length > 0) {
          advice = firstAdvice.text.slice(0, 2000);
        }
      }

      // 2) Graph summary — at root or nested in result.graph
      var graphSummary = null;
      if (typeof result.graphSummary === 'string' && result.graphSummary.length > 0) {
        graphSummary = result.graphSummary.slice(0, 1000);
      } else if (result.graph && typeof result.graph.graphSummary === 'string' && result.graph.graphSummary.length > 0) {
        graphSummary = result.graph.graphSummary.slice(0, 1000);
      }

      // 3) AI-extracted topics — at root or nested
      var aiTopicsData = result.aiTopics || (result.graph && result.graph.aiTopics) || {};
      var mainTopics        = Array.isArray(aiTopicsData.mainTopics)        ? aiTopicsData.mainTopics.slice(0, 10)        : [];
      var contentGaps       = Array.isArray(aiTopicsData.contentGaps)       ? aiTopicsData.contentGaps.slice(0, 5)        : [];
      var researchQuestions = Array.isArray(aiTopicsData.researchQuestions) ? aiTopicsData.researchQuestions.slice(0, 3) : [];

      // 4) Stats with bridge concepts (= entities the article mentions but
      //    never connects) — at root or nested
      var statsData = result.stats || (result.graph && result.graph.stats) || {};
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

      this._setCache(cacheKey, enhancement);
      this.lastActivity = new Date().toISOString();
      return enhancement;

    } catch (err) {
      this.logger.error(MODULE, 'enhanceArticle failed: ' + sanitizeAxiosError(err).message);
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
