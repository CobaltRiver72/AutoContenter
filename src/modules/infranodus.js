'use strict';

var EventEmitter = require('events').EventEmitter;
var axios = require('axios');
var { sanitizeAxiosError } = require('../utils/safe-http');

var MODULE = 'infranodus';

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

  async analyzeText(text, options) {
    if (!this.enabled || !this.ready) return null;

    options = options || {};
    try {
      var response = await axios.post('https://infranodus.com/api/v1/graphAndStatements', {
        text: text,
        doNotSave: true,
        addStats: true,
        aiTopics: options.aiTopics !== false,
        compactGraph: true
      }, {
        headers: {
          'Authorization': 'Bearer ' + this.apiKey,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      });

      this.stats.analysesRun++;
      this.lastActivity = new Date().toISOString();
      return response.data;
    } catch (err) {
      this.logger.error(MODULE, 'Analysis failed: ' + sanitizeAxiosError(err).message);
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

  async enhanceArticle(articleText) {
    if (!this.enabled) return null;
    if (!articleText || articleText.length < 200) return null;

    try {
      var result = await this.analyzeText(articleText, { aiTopics: true });
      if (!result) return null;

      var enhancement = {
        mainTopics: [],
        missingEntities: [],
        contentGaps: [],
        researchQuestions: []
      };

      if (result.aiTopics) {
        enhancement.mainTopics = result.aiTopics.mainTopics || [];
        enhancement.contentGaps = result.aiTopics.contentGaps || [];
        enhancement.researchQuestions = result.aiTopics.researchQuestions || [];
      }

      if (result.stats && result.stats.gaps) {
        for (var i = 0; i < result.stats.gaps.length; i++) {
          var gap = result.stats.gaps[i];
          if (gap.bridgeConcepts) {
            for (var j = 0; j < gap.bridgeConcepts.length; j++) {
              if (enhancement.missingEntities.indexOf(gap.bridgeConcepts[j]) === -1) {
                enhancement.missingEntities.push(gap.bridgeConcepts[j]);
              }
            }
          }
        }
      }

      this.lastActivity = new Date().toISOString();
      return enhancement;
    } catch (err) {
      this.logger.error(MODULE, 'Enhancement failed: ' + sanitizeAxiosError(err).message);
      return null;
    }
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
  }
}

module.exports = { InfranodusAnalyzer };
