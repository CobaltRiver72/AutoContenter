'use strict';

var EventEmitter = require('events').EventEmitter;
var crypto = require('crypto');
var axios = require('axios');
var { sanitizeAxiosError } = require('../utils/safe-http');

var MODULE = 'infranodus';
var API_BASE = 'https://infranodus.com';
var CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes in-memory (not DB — avoids write contention)
var TEXT_LIMIT = 12000;             // raised from 5 000: captures full article context

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
    this._cache = new Map(); // keyed by sha256(text).slice(0,16); evicted on TTL or shutdown
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

  // POST to an InfraNodus endpoint with 1 retry (5s delay) on transient failure.
  // signal: optional AbortController.signal — aborted requests are not retried.
  async _callAPI(endpoint, body, signal) {
    var options = {
      headers: {
        'Authorization': 'Bearer ' + this.apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    };
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

  // Legacy: kept for backwards-compat callers (dashboard test-connection route).
  async analyzeText(text, options) {
    if (!this.enabled || !this.ready) return null;
    options = options || {};
    try {
      return await this._callAPI('/api/v1/graphAndStatements', {
        text: text,
        doNotSave: true,
        addStats: true,
        aiTopics: options.aiTopics !== false,
        compactGraph: true,
      });
    } catch (err) {
      this.logger.error(MODULE, 'analyzeText failed: ' + err.message);
      return null;
    }
  }

  // Phase 2: Calls /api/v1/graphAndAdvice — graph + AI advice for the given optimise mode.
  // optimizeMode: 'gaps' (default) | 'develop' | 'reinforce' | 'latent' | 'imagine' | 'optimize'
  async analyzeWithAdvice(text, optimizeMode, signal) {
    if (!this.enabled || !this.ready) return null;
    try {
      return await this._callAPI('/api/v1/graphAndAdvice', {
        text: text,
        optimize: optimizeMode || 'gaps',
        addStats: true,
        aiTopics: true,
        doNotSave: true,
      }, signal);
    } catch (err) {
      this.logger.error(MODULE, 'analyzeWithAdvice failed: ' + err.message);
      return null;
    }
  }

  // Phase 2: Calls /api/v1/dotGraphFromText — compact DOT graph + graphSummary string.
  async getCompactGraph(text, signal) {
    if (!this.enabled || !this.ready) return null;
    try {
      return await this._callAPI('/api/v1/dotGraphFromText', {
        text: text,
        doNotSave: true,
      }, signal);
    } catch (err) {
      this.logger.error(MODULE, 'getCompactGraph failed: ' + err.message);
      return null;
    }
  }

  // Main entry point for the pipeline (post-extraction B5 + pre-rewrite).
  // Runs graphAndAdvice + dotGraphFromText in parallel; validates, caches, and
  // returns a structured result ready for buildPrompt() injection.
  async enhanceArticle(articleText, options, signal) {
    if (!this.enabled) return null;
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
      // Both calls in parallel — each has its own retry inside _callAPI.
      var results = await Promise.all([
        this.analyzeWithAdvice(text, options.optimize || 'gaps', signal),
        this.getCompactGraph(text, signal),
      ]);

      var adviceResult = results[0];
      var dotResult    = results[1];

      // Validate response shapes — never trust raw API output.
      var mainTopics       = [];
      var missingEntities  = [];
      var contentGaps      = [];
      var researchQuestions = [];
      var advice           = null;
      var graphSummary     = null;

      if (adviceResult) {
        // graphAndAdvice mirrors graphAndStatements structure + adds `advice`.
        var aiTopics = adviceResult.aiTopics || {};
        mainTopics        = Array.isArray(aiTopics.mainTopics)       ? aiTopics.mainTopics.slice(0, 10)       : [];
        contentGaps       = Array.isArray(aiTopics.contentGaps)      ? aiTopics.contentGaps.slice(0, 5)       : [];
        researchQuestions = Array.isArray(aiTopics.researchQuestions) ? aiTopics.researchQuestions.slice(0, 3) : [];

        // missingEntities derived from bridge concepts spanning structural gaps
        if (adviceResult.stats && Array.isArray(adviceResult.stats.gaps)) {
          for (var i = 0; i < adviceResult.stats.gaps.length; i++) {
            var gap = adviceResult.stats.gaps[i];
            if (Array.isArray(gap.bridgeConcepts)) {
              for (var j = 0; j < gap.bridgeConcepts.length; j++) {
                if (missingEntities.indexOf(gap.bridgeConcepts[j]) === -1) {
                  missingEntities.push(gap.bridgeConcepts[j]);
                }
              }
            }
          }
          missingEntities = missingEntities.slice(0, 10);
        }

        if (typeof adviceResult.advice === 'string') {
          advice = adviceResult.advice.slice(0, 2000);
        }
      }

      if (dotResult && typeof dotResult.graphSummary === 'string') {
        graphSummary = dotResult.graphSummary.slice(0, 1000);
      }

      var result = {
        mainTopics:        mainTopics,
        missingEntities:   missingEntities,
        contentGaps:       contentGaps,
        researchQuestions: researchQuestions,
        advice:            advice,
        graphSummary:      graphSummary,
        analyzedAt:        new Date().toISOString(),
        charsSent:         text.length,
      };

      this._setCache(cacheKey, result);
      this.lastActivity = new Date().toISOString();
      return result;

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
