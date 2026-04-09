'use strict';

var express = require('express');
var { getConfig } = require('../utils/config');

/**
 * Create the API router.
 *
 * @param {object} deps - Module references
 * @param {object} deps.firehose
 * @param {object} deps.trends
 * @param {object} deps.buffer
 * @param {object} deps.similarity
 * @param {object} deps.scheduler
 * @param {import('better-sqlite3').Database} deps.db
 * @param {object} deps.logger
 * @returns {import('express').Router}
 */
function createApiRouter(deps) {
  var router = express.Router();
  var axios = require('axios');
  var { assertSafeUrl, safeAxiosOptions } = require('../utils/safe-http');
  var { parseId, httpError, sanitizeForClient } = require('../utils/api-helpers');
  var { validateAndNormalizeUrl } = require('../utils/draft-helpers');
  var { firehose, trends, buffer, similarity, extractor, rewriter, publisher, scheduler, infranodus, db, logger } = deps;

  // ─── Simple in-memory cache for expensive API responses ────────────────────
  var _apiCache = {};
  var _API_CACHE_TTL_MS = 10000;

  function getCached(key) {
    var cached = _apiCache[key];
    if (cached && Date.now() - cached.timestamp < _API_CACHE_TTL_MS) {
      return cached.data;
    }
    return null;
  }

  function setCache(key, data) {
    _apiCache[key] = { data: data, timestamp: Date.now() };
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  function paginate(query, countQuery, params, page, perPage) {
    var offset = (page - 1) * perPage;
    var totalRow = countQuery.get(params || {});
    var total = totalRow ? (totalRow.total || totalRow.count || 0) : 0;
    var data = query.all(Object.assign({}, params || {}, { limit: perPage, offset: offset }));
    return { data: data, total: total, page: page, perPage: perPage };
  }

  function parsePageParam(req, defaultPerPage) {
    var page = Math.max(1, parseInt(req.query.page, 10) || 1);
    var perPage = defaultPerPage || 20;
    return { page: page, perPage: perPage };
  }

  // ─── GET /api/status ───────────────────────────────────────────────────────

  router.get('/status', function (req, res) {
    try {
      var status = {
        firehose: firehose ? firehose.getStatus() : { state: 'not_loaded' },
        trends: trends ? trends.getStatus() : { state: 'not_loaded' },
        scheduler: scheduler ? scheduler.getQueueStatus() : { state: 'not_loaded' },
        buffer: buffer ? buffer.getStats() : { state: 'not_loaded' },
      };
      res.json(status);
    } catch (err) {
      logger.error('api', 'Failed to get status', err.message);
      res.status(500).json({ error: 'Failed to get status' });
    }
  });

  // ─── GET /api/health ────────────────────────────────────────────────────────

  router.get('/health', function (req, res) {
    try {
      var modules = [];
      var sources = [firehose, trends, buffer, similarity, extractor, scheduler, infranodus];
      for (var i = 0; i < sources.length; i++) {
        if (sources[i] && typeof sources[i].getHealth === 'function') {
          modules.push(sources[i].getHealth());
        }
      }

      var hasCriticalError = modules.some(function (m) {
        return (m.module === 'firehose' || m.module === 'buffer') && m.status === 'error';
      });
      var hasAnyError = modules.some(function (m) { return m.status === 'error'; });

      var overall = 'healthy';
      if (hasCriticalError) overall = 'error';
      else if (hasAnyError) overall = 'degraded';

      res.json({ status: overall, uptime: process.uptime(), modules: modules });
    } catch (err) {
      res.status(500).json({ error: 'Failed to get health' });
    }
  });

  // ─── POST /api/test/infranodus ────────────────────────────────────────────

  router.post('/test/infranodus', function (req, res) {
    if (!infranodus || typeof infranodus.analyzeText !== 'function') {
      return res.status(503).json({ error: 'InfraNodus module not available' });
    }
    var health = infranodus.getHealth();
    if (!health.enabled) {
      return res.json({ success: false, enabled: false, message: 'InfraNodus is disabled. Enable it in Settings.' });
    }
    infranodus.analyzeText('Test connection from HDF AutoPub dashboard', {})
      .then(function (result) {
        res.json({ success: !!result, message: result ? 'Connection successful' : 'No response' });
      })
      .catch(function (err) {
        res.json({ success: false, error: err.message });
      });
  });

  // ─── POST /api/settings/test-jina ─────────────────────────────────────────
  // Tests the Jina AI Reader fallback. Accepts an optional `api_key` in body
  // (so users can validate a fresh key before saving it). Falls back to the
  // currently saved JINA_API_KEY when no override is provided.

  router.post('/settings/test-jina', function (req, res) {
    var startedAt = Date.now();
    var overrideKey = req.body && typeof req.body.api_key === 'string' ? req.body.api_key.trim() : '';
    var testUrl = (req.body && typeof req.body.url === 'string' && req.body.url.trim()) || 'https://example.com';

    var liveCfg = getConfig();
    var effectiveKey = overrideKey || liveCfg.JINA_API_KEY || '';
    var ephemeralCfg = Object.assign({}, liveCfg, { JINA_API_KEY: effectiveKey });

    var { fetchViaJina } = require('../modules/extractor-jina');

    fetchViaJina(testUrl, ephemeralCfg, logger)
      .then(function (result) {
        var elapsedMs = Date.now() - startedAt;
        if (result && result.content) {
          res.json({
            success: true,
            has_key: !!effectiveKey,
            elapsed_ms: elapsedMs,
            content_length: result.content.length,
            title: result.title || null,
            sample: result.content.substring(0, 200),
          });
        } else {
          res.json({
            success: false,
            has_key: !!effectiveKey,
            elapsed_ms: elapsedMs,
            error: 'Jina returned no usable content',
          });
        }
      })
      .catch(function (err) {
        res.json({
          success: false,
          has_key: !!effectiveKey,
          elapsed_ms: Date.now() - startedAt,
          error: err && err.message ? err.message : 'Unknown error',
        });
      });
  });

  // ─── GET /api/feed ─────────────────────────────────────────────────────────

  router.get('/feed', function (req, res) {
    try {
      var p = parsePageParam(req, 50);
      var countStmt = db.prepare('SELECT COUNT(*) as total FROM articles');
      var dataStmt = db.prepare(
        'SELECT * FROM articles ORDER BY received_at DESC LIMIT @limit OFFSET @offset'
      );
      var result = paginate(dataStmt, countStmt, null, p.page, p.perPage);
      res.json(result);
    } catch (err) {
      logger.error('api', 'Failed to fetch feed', err.message);
      res.status(500).json({ error: 'Failed to fetch feed' });
    }
  });

  // ─── GET /api/feed/live — SSE ──────────────────────────────────────────────

  router.get('/feed/live', function (req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(':\n\n'); // SSE comment to establish connection

    // Send initial batch of recent articles so the dashboard isn't empty on load
    try {
      var recentArticles = db.prepare(
        'SELECT * FROM articles ORDER BY received_at DESC LIMIT 50'
      ).all();
      if (recentArticles.length > 0) {
        res.write('event: initial-batch\ndata: ' + JSON.stringify(recentArticles) + '\n\n');
      }
    } catch (err) {
      logger.error('api', 'Failed to send initial-batch SSE', err.message);
    }

    var heartbeat = setInterval(function () {
      res.write(':\n\n');
    }, 30000);

    function onArticle(article) {
      var data = JSON.stringify(article);
      res.write('event: article\ndata: ' + data + '\n\n');
    }

    if (firehose && typeof firehose.on === 'function') {
      firehose.on('article', onArticle);
    }

    req.on('close', function () {
      if (firehose && typeof firehose.removeListener === 'function') {
        firehose.removeListener('article', onArticle);
      }
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    });

    // Also handle broken pipe / error
    req.on('error', function () {
      if (firehose && typeof firehose.removeListener === 'function') {
        firehose.removeListener('article', onArticle);
      }
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    });
  });

  // ─── GET /api/trends ───────────────────────────────────────────────────────

  router.get('/trends', function (req, res) {
    try {
      var rows = db.prepare(
        'SELECT * FROM trends ORDER BY last_updated DESC'
      ).all();
      res.json({ data: rows });
    } catch (err) {
      logger.error('api', 'Failed to fetch trends', err.message);
      res.status(500).json({ error: 'Failed to fetch trends' });
    }
  });

  // ─── GET /api/articles/search ──────────────────────────────────────────────

  router.get('/articles/search', function (req, res) {
    try {
      var query = (req.query.q || '').trim();
      if (!query || query.length < 2) {
        return res.status(400).json({ error: 'Query must be at least 2 characters' });
      }

      var limit = Math.min(parseInt(req.query.limit) || 100, 500);

      var keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
      var whereClauses = [];
      var params = [];

      for (var i = 0; i < keywords.length; i++) {
        whereClauses.push('LOWER(title) LIKE ?');
        params.push('%' + keywords[i] + '%');
      }

      var sql = 'SELECT id, firehose_event_id, url, domain, title, publish_time, ' +
                'page_category, language, authority_tier, cluster_id, received_at ' +
                'FROM articles WHERE ' + whereClauses.join(' AND ') +
                ' ORDER BY received_at DESC LIMIT ?';
      params.push(limit);

      var stmt = db.prepare(sql);
      var articles = stmt.all.apply(stmt, params);

      res.json({
        articles: articles,
        total: articles.length,
        query: query,
        keywords: keywords
      });
    } catch (err) {
      logger.error('api', 'Article search failed', err.message);
      res.status(500).json({ error: 'Search failed' });
    }
  });

  // ─── GET /api/clusters/stats ────────────────────────────────────────────────

  router.get('/clusters/stats', function (req, res) {
    try {
      var cached = getCached('cluster_stats');
      if (cached) return res.json(cached);

      var totalClusters = db.prepare('SELECT COUNT(*) as count FROM clusters').get().count;
      var detected = db.prepare("SELECT COUNT(*) as count FROM clusters WHERE status = 'detected'").get().count;
      var published = db.prepare("SELECT COUNT(*) as count FROM clusters WHERE status = 'published'").get().count;
      var failed = db.prepare("SELECT COUNT(*) as count FROM clusters WHERE status = 'failed'").get().count;
      var skipped = db.prepare("SELECT COUNT(*) as count FROM clusters WHERE status = 'skipped'").get().count;

      var avgResult = db.prepare('SELECT AVG(article_count) as avg FROM clusters').get();
      var avgArticles = avgResult && avgResult.avg ? Math.round(avgResult.avg * 10) / 10 : 0;

      var bufferHours = require('../utils/config').getConfig().BUFFER_HOURS || 6;
      var bufferSize = db.prepare(
        "SELECT COUNT(*) as count FROM articles WHERE received_at >= datetime('now', '-' || ? || ' hours')"
      ).get(bufferHours).count;

      var uniqueDomains = db.prepare(
        "SELECT COUNT(DISTINCT domain) as count FROM articles WHERE received_at >= datetime('now', '-' || ? || ' hours')"
      ).get(bufferHours).count;

      var responseData = {
        totalClusters: totalClusters,
        detected: detected,
        published: published,
        failed: failed,
        skipped: skipped,
        avgArticlesPerCluster: avgArticles,
        bufferSize: bufferSize,
        uniqueDomains: uniqueDomains,
        bufferHours: bufferHours
      };
      setCache('cluster_stats', responseData);
      res.json(responseData);
    } catch (err) {
      logger.error('api', 'Failed to fetch cluster stats', err.message);
      res.status(500).json({ error: 'Failed to fetch cluster stats' });
    }
  });

  // ─── POST /api/clusters/recluster — Re-run similarity on all buffer articles ──

  router.post('/clusters/recluster', function (req, res) {
    try {
      var bufferHours = require('../utils/config').getConfig().BUFFER_HOURS || 6;
      var articles = db.prepare(
        "SELECT * FROM articles WHERE received_at >= datetime('now', '-' || ? || ' hours') AND cluster_id IS NULL ORDER BY received_at ASC"
      ).all(bufferHours);

      if (articles.length < 2) {
        return res.json({ success: true, message: 'Not enough unclustered articles (' + articles.length + ')', clustersCreated: 0 });
      }

      var clustersCreated = 0;
      var articlesMatched = 0;

      for (var i = 0; i < articles.length; i++) {
        var article = articles[i];
        if (!article.fingerprint || article.cluster_id) continue;

        var matches = similarity.findMatches(article, articles);
        if (matches.length >= (require('../utils/config').getConfig().MIN_SOURCES_THRESHOLD || 2) - 1) {
          var cluster = similarity.createOrUpdateCluster(article, matches, null);
          if (cluster) {
            clustersCreated++;
            articlesMatched += cluster.article_count || 0;
            // Refresh articles array to reflect new cluster_id assignments
            for (var j = 0; j < articles.length; j++) {
              if (articles[j].cluster_id === undefined || articles[j].cluster_id === null) {
                var fresh = db.prepare('SELECT cluster_id FROM articles WHERE id = ?').get(articles[j].id);
                if (fresh) articles[j].cluster_id = fresh.cluster_id;
              }
            }
          }
        }
      }

      logger.info('api', 'Re-cluster completed: ' + clustersCreated + ' new cluster(s) from ' + articles.length + ' articles');
      res.json({ success: true, clustersCreated: clustersCreated, articlesMatched: articlesMatched, totalArticles: articles.length });
    } catch (err) {
      logger.error('api', 'Re-cluster failed: ' + err.message);
      res.status(500).json({ error: 'Re-cluster failed: ' + err.message });
    }
  });

  // ─── GET /api/clusters ────────────────────────────────────────────────────

  router.get('/clusters', function (req, res) {
    try {
      var p = parsePageParam(req, 20);
      var statusFilter = req.query.status || null;

      var whereClause = statusFilter ? 'WHERE status = @status' : '';
      var params = statusFilter ? { status: statusFilter } : {};

      var countStmt = db.prepare('SELECT COUNT(*) as total FROM clusters ' + whereClause);
      var dataStmt = db.prepare(
        'SELECT * FROM clusters ' + whereClause +
        ' ORDER BY detected_at DESC LIMIT @limit OFFSET @offset'
      );

      var result = paginate(dataStmt, countStmt, params, p.page, p.perPage);
      res.json(result);
    } catch (err) {
      logger.error('api', 'Failed to fetch clusters', err.message);
      res.status(500).json({ error: 'Failed to fetch clusters' });
    }
  });

  // ─── GET /api/clusters/:id ────────────────────────────────────────────────

  router.get('/clusters/:id', function (req, res) {
    try {
      var clusterId = parseId(req.params.id);
      if (!clusterId) return res.status(400).json({ success: false, error: 'Invalid cluster id' });

      var cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId);
      if (!cluster) {
        return res.status(404).json({ success: false, error: 'Cluster not found' });
      }

      var articles = db.prepare(
        'SELECT * FROM articles WHERE cluster_id = ? ORDER BY authority_tier ASC, received_at DESC'
      ).all(clusterId);

      res.json({ cluster: cluster, articles: articles });
    } catch (err) {
      logger.error('api', 'Failed to fetch cluster: ' + err.message);
      res.status(500).json({ success: false, error: 'Failed to fetch cluster' });
    }
  });

  // ─── GET /api/published ───────────────────────────────────────────────────

  router.get('/published', function (req, res) {
    try {
      var p = parsePageParam(req, 20);
      var countStmt = db.prepare('SELECT COUNT(*) as total FROM published');
      var dataStmt = db.prepare(
        'SELECT * FROM published ORDER BY published_at DESC LIMIT @limit OFFSET @offset'
      );
      var result = paginate(dataStmt, countStmt, null, p.page, p.perPage);
      res.json(result);
    } catch (err) {
      logger.error('api', 'Failed to fetch published', err.message);
      res.status(500).json({ error: 'Failed to fetch published' });
    }
  });

  // ─── GET /api/logs ─────────────────────────────────────────────────────────

  router.get('/logs', function (req, res) {
    try {
      var p = parsePageParam(req, 100);
      var moduleFilter = req.query.module || null;
      var levelFilter = req.query.level || null;

      var conditions = [];
      var params = {};

      if (moduleFilter) {
        conditions.push('module = @module');
        params.module = moduleFilter;
      }
      if (levelFilter) {
        conditions.push('level = @level');
        params.level = levelFilter;
      }

      var whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';
      var countStmt = db.prepare('SELECT COUNT(*) as total FROM logs ' + whereClause);
      var dataStmt = db.prepare(
        'SELECT * FROM logs ' + whereClause +
        ' ORDER BY created_at DESC LIMIT @limit OFFSET @offset'
      );

      var result = paginate(dataStmt, countStmt, params, p.page, p.perPage);
      res.json(result);
    } catch (err) {
      logger.error('api', 'Failed to fetch logs', err.message);
      res.status(500).json({ error: 'Failed to fetch logs' });
    }
  });

  // ─── GET /api/stats ────────────────────────────────────────────────────────

  router.get('/stats', function (req, res) {
    try {
      var today = new Date().toISOString().slice(0, 10);

      var articlesToday = db.prepare(
        "SELECT COUNT(*) as count FROM articles WHERE received_at >= ?"
      ).get(today + 'T00:00:00');

      var clustersToday = db.prepare(
        "SELECT COUNT(*) as count FROM clusters WHERE detected_at >= ?"
      ).get(today + 'T00:00:00');

      var publishedToday = db.prepare(
        "SELECT COUNT(*) as count FROM published WHERE published_at >= ?"
      ).get(today + 'T00:00:00');

      var totalArticles = db.prepare('SELECT COUNT(*) as count FROM articles').get();

      // Articles per hour (last 24h) for chart
      var hourlyData = db.prepare(
        "SELECT strftime('%Y-%m-%dT%H:00:00', received_at) as hour, COUNT(*) as count " +
        "FROM articles WHERE received_at >= datetime('now', '-24 hours') " +
        "GROUP BY hour ORDER BY hour"
      ).all();

      res.json({
        articlesToday: articlesToday ? articlesToday.count : 0,
        clustersToday: clustersToday ? clustersToday.count : 0,
        publishedToday: publishedToday ? publishedToday.count : 0,
        totalArticles: totalArticles ? totalArticles.count : 0,
        hourlyArticles: hourlyData,
      });
    } catch (err) {
      logger.error('api', 'Failed to fetch stats', err.message);
      res.status(500).json({ error: 'Failed to fetch stats' });
    }
  });

  // ─── GET /api/settings ────────────────────────────────────────────────────

  router.get('/settings', function (req, res) {
    try {
      var rows = db.prepare('SELECT key, value, updated_at FROM settings').all();
      var settings = {};
      rows.forEach(function (row) {
        settings[row.key] = row.value;
      });

      // SECURITY: Mask ALL sensitive values before sending to frontend
      var SENSITIVE_KEYS = [
        'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY',
        'FIREHOSE_TOKEN', 'FIREHOSE_MANAGEMENT_KEY',
        'WP_APP_PASSWORD', 'WP_USERNAME',
        'DASHBOARD_PASSWORD', 'DASHBOARD_PASSWORD_HASH',
        'INFRANODUS_API_KEY', 'SESSION_SECRET'
      ];

      var safeSettings = {};
      var settingKeys = Object.keys(settings);
      for (var i = 0; i < settingKeys.length; i++) {
        var sKey = settingKeys[i];
        if (SENSITIVE_KEYS.indexOf(sKey) !== -1) {
          if (settings[sKey] && settings[sKey].length > 4) {
            safeSettings[sKey] = '••••••••' + settings[sKey].slice(-4);
          } else if (settings[sKey]) {
            safeSettings[sKey] = '••••••••';
          } else {
            safeSettings[sKey] = '';
          }
        } else {
          safeSettings[sKey] = settings[sKey];
        }
      }

      var config = getConfig();
      var safeConfig = {};
      var configKeys = Object.keys(config);
      for (var k = 0; k < configKeys.length; k++) {
        if (SENSITIVE_KEYS.indexOf(configKeys[k]) !== -1) {
          safeConfig[configKeys[k]] = config[configKeys[k]] ? '••••••••' : '';
        } else {
          safeConfig[configKeys[k]] = config[configKeys[k]];
        }
      }

      res.json({ settings: safeSettings, config: safeConfig });
    } catch (err) {
      logger.error('api', 'Failed to fetch settings', err.message);
      res.status(500).json({ error: 'Failed to fetch settings' });
    }
  });

  // ─── PUT /api/settings ────────────────────────────────────────────────────

  router.put('/settings', function (req, res) {
    try {
      var updates = req.body;
      if (!updates || typeof updates !== 'object') {
        return res.status(400).json({ error: 'Request body must be an object of key-value pairs' });
      }

      // SECURITY: Only allow known settings keys
      var ALLOWED_KEYS = [
        'FIREHOSE_TOKEN',
        'WP_URL', 'WP_USERNAME', 'WP_APP_PASSWORD', 'WP_AUTHOR_ID', 'WP_DEFAULT_CATEGORY', 'WP_POST_STATUS',
        'MIN_SOURCES_THRESHOLD', 'SIMILARITY_THRESHOLD', 'BUFFER_HOURS', 'ALLOW_SAME_DOMAIN_CLUSTERS',
        'MAX_PUBLISH_PER_HOUR', 'PUBLISH_COOLDOWN_MINUTES',
        'TRENDS_ENABLED', 'TRENDS_GEO', 'TRENDS_POLL_MINUTES',
        'INFRANODUS_ENABLED', 'INFRANODUS_API_KEY',
        'TIER1_SOURCES', 'TIER2_SOURCES', 'TIER3_SOURCES',
        'PORT',
      ];

      var BLOCKED_KEYS = [
        'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY',
        'DASHBOARD_PASSWORD', 'DASHBOARD_PASSWORD_HASH', 'SESSION_SECRET',
        'FIREHOSE_MANAGEMENT_KEY',
        'DB_PATH', 'DATA_DIR', 'LOG_PATH', 'NODE_ENV',
      ];

      var entries = Object.entries(updates);
      var validEntries = [];
      var rejected = [];

      for (var i = 0; i < entries.length; i++) {
        var entryKey = entries[i][0];
        var entryVal = entries[i][1];

        if (BLOCKED_KEYS.indexOf(entryKey) !== -1) {
          rejected.push(entryKey + ' (blocked)');
          continue;
        }
        if (ALLOWED_KEYS.indexOf(entryKey) === -1) {
          rejected.push(entryKey + ' (unknown)');
          continue;
        }
        // Skip masked/placeholder values
        if (typeof entryVal === 'string' && (entryVal === '••••••••' || entryVal.indexOf('••••') === 0)) {
          continue;
        }
        validEntries.push([entryKey, String(entryVal)]);
      }

      if (rejected.length > 0) {
        logger.warn('api', 'Settings update rejected keys: ' + rejected.join(', '));
      }

      if (validEntries.length === 0) {
        return res.json({ success: true, updated: 0, message: 'No valid settings to update' });
      }

      var upsertStmt = db.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      );

      var insertMany = db.transaction(function (items) {
        for (var j = 0; j < items.length; j++) {
          upsertStmt.run(items[j][0], items[j][1]);
        }
      });

      insertMany(validEntries);

      // Reload config with new overrides
      var { loadRuntimeOverrides } = require('../utils/config');
      loadRuntimeOverrides(db);

      // Re-initialize publisher if any WP credentials changed
      var wpKeys = ['WP_URL', 'WP_USERNAME', 'WP_APP_PASSWORD', 'WP_POST_STATUS', 'WP_AUTHOR_ID', 'WP_DEFAULT_CATEGORY'];
      var hasWpChange = validEntries.some(function (e) { return wpKeys.indexOf(e[0]) !== -1; });
      if (hasWpChange && publisher && typeof publisher.reinit === 'function') {
        publisher.reinit();
        logger.info('api', 'Publisher re-initialized after WP settings change');
      }

      logger.info('api', 'Settings updated', { keys: validEntries.map(function (e) { return e[0]; }) });
      res.json({ success: true, updated: validEntries.length });
    } catch (err) {
      logger.error('api', 'Failed to update settings', err.message);
      res.status(500).json({ error: 'Failed to update settings' });
    }
  });

  // ─── AI Settings Routes ────────────────────────────────────────────────────

  router.get('/ai/settings', function (req, res) {
    try {
      var settings = rewriter.getSettings();
      res.json({ success: true, provider: settings.provider, anthropicKey: settings.anthropicKey, anthropicModel: settings.anthropicModel, openaiKey: settings.openaiKey, openaiModel: settings.openaiModel, openrouterKey: settings.openrouterKey, openrouterModel: settings.openrouterModel, enableFallback: settings.enableFallback, maxTokens: settings.maxTokens, temperature: settings.temperature, models: settings.models });
    } catch (err) {
      logger.error('api', 'Get AI settings failed: ' + err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/ai/settings', function (req, res) {
    try {
      var body = req.body || {};
      rewriter.updateSettings({
        provider: body.provider,
        anthropicKey: body.anthropicKey,
        anthropicModel: body.anthropicModel,
        openaiKey: body.openaiKey,
        openaiModel: body.openaiModel,
        openrouterKey: body.openrouterKey,
        openrouterModel: body.openrouterModel,
        enableFallback: body.enableFallback === true || body.enableFallback === 'true',
        maxTokens: body.maxTokens ? parseInt(body.maxTokens, 10) : undefined,
        temperature: body.temperature !== undefined ? parseFloat(body.temperature) : undefined,
      });
      res.json({ success: true, message: 'AI settings saved' });
    } catch (err) {
      logger.error('api', 'Save AI settings failed: ' + err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/ai/test', async function (req, res) {
    try {
      var body = req.body || {};
      if (!body.provider || !body.apiKey) {
        return res.status(400).json({ success: false, error: 'Provider and API key required' });
      }
      // Pass body.model so we test the model the user actually selected
      var result = await rewriter.testConnection(body.provider, body.apiKey, body.model);
      res.json(result);
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/ai/models', async function (req, res) {
    try {
      var rewriterModule = require('../modules/rewriter');
      var AI_MODELS = rewriterModule.AI_MODELS;
      var fetchOpenRouterFreeModels = rewriterModule.fetchOpenRouterFreeModels;

      // Always return Anthropic and OpenAI from static list
      // Fetch OpenRouter dynamically (cached 1h)
      var orModels = [];
      try {
        orModels = await fetchOpenRouterFreeModels(false);
      } catch (e) {
        logger.warn('api', 'OpenRouter model fetch failed: ' + e.message);
      }

      var combined = {
        anthropic: AI_MODELS.anthropic || [],
        openai: AI_MODELS.openai || [],
        openrouter: orModels,
      };

      res.json({ success: true, models: combined });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Force-refresh OpenRouter model list (bypasses 1h cache)
  router.post('/ai/openrouter-models/refresh', async function (req, res) {
    try {
      var fetchOpenRouterFreeModels = require('../modules/rewriter').fetchOpenRouterFreeModels;
      var models = await fetchOpenRouterFreeModels(true);
      res.json({ success: true, count: models.length, models: models });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── POST /api/clusters/:id/publish ───────────────────────────────────────
  //
  // NEW ARCHITECTURE: Creates drafts for each cluster article.
  // The scheduler picks up drafts with mode='auto' and processes them.
  //
  router.post('/clusters/:id/publish', function (req, res) {
    try {
      var clusterId = parseId(req.params.id);
      if (!clusterId) return res.status(400).json({ success: false, error: 'Invalid cluster id' });

      var cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId);
      if (!cluster) {
        return res.status(404).json({ success: false, error: 'Cluster not found' });
      }

      if (cluster.status === 'published' || cluster.status === 'queued') {
        return res.status(409).json({ error: 'Cluster already ' + cluster.status });
      }

      // Load all articles in this cluster
      var articles = db.prepare(
        'SELECT * FROM articles WHERE cluster_id = ? ORDER BY authority_tier ASC, received_at ASC'
      ).all(clusterId);

      if (articles.length === 0) {
        return res.status(400).json({ error: 'Cluster has no articles' });
      }

      // Check if drafts already exist for this cluster
      var existingDrafts = db.prepare(
        'SELECT id, source_url, cluster_role FROM drafts WHERE cluster_id = ?'
      ).all(clusterId);

      if (existingDrafts.length > 0) {
        db.prepare("UPDATE clusters SET status = 'queued' WHERE id = ?").run(clusterId);
        return res.json({
          success: true,
          clusterId: clusterId,
          status: 'queued',
          draftsCreated: 0,
          totalDrafts: existingDrafts.length,
          message: 'Drafts already exist for this cluster'
        });
      }

      // Choose primary article: highest authority tier (lowest number), or first
      var primaryArticle = articles[0]; // Already sorted by authority_tier ASC

      // Create drafts in a transaction for atomicity
      var insertDraft = db.prepare(
        "INSERT OR IGNORE INTO drafts (" +
        "  source_article_id, source_url, source_domain, source_title," +
        "  source_content_markdown, source_language, source_category," +
        "  source_publish_time, target_platform, status, mode," +
        "  cluster_id, cluster_role, extraction_status" +
        ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );

      var draftsCreated = 0;
      var primaryDraftId = null;

      var createDrafts = db.transaction(function () {
        for (var i = 0; i < articles.length; i++) {
          var article = articles[i];
          var isPrimary = article.id === primaryArticle.id;
          var role = isPrimary ? 'primary' : 'source';

          var result = insertDraft.run(
            article.id,
            article.url,
            article.domain,
            article.title,
            article.content_markdown || '',
            '', // source_language
            '', // source_category
            article.publish_time || '',
            'wordpress',
            'fetching',
            'auto',
            clusterId,
            role,
            'pending'
          );

          if (result.changes > 0) {
            draftsCreated++;
            if (isPrimary) {
              primaryDraftId = result.lastInsertRowid;
            }
          }
        }

        db.prepare("UPDATE clusters SET status = 'queued' WHERE id = ?").run(clusterId);
      });

      createDrafts();

      logger.info('api', 'Cluster ' + clusterId + ' -> ' + draftsCreated + ' drafts created (primary=#' + primaryDraftId + ')');

      // Trigger immediate scheduler processing — don't wait 30s
      if (scheduler && scheduler.processQueue && !scheduler._processing) {
        setTimeout(function () {
          scheduler.processQueue().catch(function (err) {
            logger.error('api', 'Immediate scheduler trigger failed: ' + err.message);
          });
        }, 1000);
      }

      res.json({
        success: true,
        clusterId: clusterId,
        status: 'queued',
        draftsCreated: draftsCreated,
        primaryDraftId: primaryDraftId,
        articleCount: articles.length,
      });
    } catch (err) {
      logger.error('api', 'Failed to create drafts for cluster ' + req.params.id + ': ' + err.message);
      res.status(500).json({ success: false, error: 'Failed to enqueue cluster' });
    }
  });

  // ─── DELETE /api/clusters/:id/drafts ──────────────────────────────────────
  //
  // Deletes ALL drafts for a cluster and marks cluster as dismissed.
  // Safety: refuses to delete if any draft is already published to WordPress.
  //
  router.delete('/clusters/:id/drafts', function (req, res) {
    try {
      var clusterId = parseId(req.params.id);
      if (!clusterId) return res.status(400).json({ success: false, error: 'Invalid cluster id' });

      // Safety check: don't delete if any draft is already published
      var publishedDraft = db.prepare(
        "SELECT id FROM drafts WHERE cluster_id = ? AND status = 'published' LIMIT 1"
      ).get(clusterId);

      if (publishedDraft) {
        return res.status(409).json({
          success: false,
          error: 'Cannot delete — cluster has published articles. Remove from WordPress first.'
        });
      }

      // Count what we're deleting
      var draftCount = db.prepare(
        'SELECT COUNT(*) as cnt FROM drafts WHERE cluster_id = ?'
      ).get(clusterId);

      if (!draftCount || draftCount.cnt === 0) {
        return res.status(404).json({ success: false, error: 'No drafts found for cluster #' + clusterId });
      }

      // Delete all drafts in a transaction
      var deleteAll = db.transaction(function () {
        // Release any locks first
        db.prepare(
          "UPDATE drafts SET locked_by = NULL, locked_at = NULL, lease_expires_at = NULL WHERE cluster_id = ? AND locked_by IS NOT NULL"
        ).run(clusterId);

        // Delete all drafts for this cluster
        var result = db.prepare('DELETE FROM drafts WHERE cluster_id = ?').run(clusterId);

        // Mark cluster as dismissed
        db.prepare(
          "UPDATE clusters SET status = 'dismissed' WHERE id = ?"
        ).run(clusterId);

        return result.changes;
      });

      var deletedCount = deleteAll();

      logger.info('api', 'Cluster #' + clusterId + ': deleted ' + deletedCount + ' drafts, status -> dismissed');

      res.json({
        success: true,
        message: 'Cluster deleted',
        clusterId: clusterId,
        draftsDeleted: deletedCount
      });
    } catch (err) {
      logger.error('api', 'Failed to delete cluster #' + req.params.id + ' drafts: ' + err.message);
      res.status(500).json({ success: false, error: 'Failed to delete cluster drafts' });
    }
  });

  // ─── POST /api/clusters/:id/skip ──────────────────────────────────────────

  router.post('/clusters/:id/skip', function (req, res) {
    try {
      var clusterId = parseId(req.params.id);
      if (!clusterId) return res.status(400).json({ success: false, error: 'Invalid cluster id' });

      var reason = (req.body && req.body.reason) || 'Manually skipped';

      var result = db.prepare(
        "UPDATE clusters SET status = 'skipped' WHERE id = ?"
      ).run(clusterId);

      if (result.changes === 0) {
        return res.status(404).json({ success: false, error: 'Cluster not found' });
      }

      logger.info('api', 'Cluster skipped', { clusterId: clusterId, reason: reason });
      res.json({ success: true, clusterId: clusterId, status: 'skipped', reason: reason });
    } catch (err) {
      logger.error('api', 'Failed to skip cluster: ' + err.message);
      res.status(500).json({ success: false, error: 'Failed to skip cluster' });
    }
  });

  // ─── POST /api/test/firehose ──────────────────────────────────────────────

  router.post('/test/firehose', function (req, res) {
    var config = getConfig();
    var token = config.FIREHOSE_TOKEN;
    if (!token) {
      return res.json({ success: false, error: 'Firehose token not configured', tokenConfigured: false });
    }
    // Test by fetching rules (lightweight API call)
    return axios.get('https://api.firehose.com/v1/rules', {
      headers: { 'Authorization': 'Bearer ' + token },
      timeout: 10000,
    })
    .then(function (response) {
      var rulesCount = Array.isArray(response.data) ? response.data.length : 0;
      res.json({
        success: true,
        tokenConfigured: true,
        rulesCount: rulesCount,
        message: 'Connection successful. ' + rulesCount + ' rules configured.',
        status: firehose ? firehose.getStatus() : {},
      });
    })
    .catch(function (err) {
      var msg = err.response ? 'API error ' + err.response.status : err.message;
      res.json({ success: false, tokenConfigured: true, error: msg });
    });
  });

  // ─── POST /api/test/trends ────────────────────────────────────────────────

  router.post('/test/trends', function (req, res) {
    if (!trends || typeof trends.pollOnce !== 'function') {
      return res.status(503).json({ error: 'Trends module not available' });
    }

    return trends.pollOnce()
      .then(function (results) {
        res.json({ success: true, results: results });
      })
      .catch(function (err) {
        logger.error('api', 'Trends poll test failed', err.message);
        res.status(500).json({ error: 'Trends poll failed: ' + err.message });
      });
  });

  // ─── POST /api/test/rewrite ───────────────────────────────────────────────

  router.post('/test/rewrite', function (req, res) {
    try {
      if (!rewriter || !rewriter.enabled) {
        return res.status(503).json({ error: 'Rewriter module not available' });
      }

      if (!req.body || !req.body.article) {
        return res.status(400).json({ error: 'Request body must include "article" object' });
      }

      var article = req.body.article;
      var cluster = { topic: article.title || 'Test', trends_boosted: false, articles: [article] };
      return rewriter.rewrite(article, cluster)
        .then(function (result) {
          res.json({ success: true, result: result });
        })
        .catch(function (err) {
          logger.error('api', 'Rewrite test failed', err.message);
          res.status(500).json({ error: 'Rewrite failed: ' + err.message });
        });
    } catch (err) {
      logger.error('api', 'Rewrite test failed', err.message);
      res.status(500).json({ error: 'Rewrite test failed' });
    }
  });

  // ─── POST /api/test/wordpress ─────────────────────────────────────────────

  router.post('/test/wordpress', function (req, res) {
    var config = getConfig();

    if (!config.WP_URL || !config.WP_USERNAME || !config.WP_APP_PASSWORD) {
      return res.status(400).json({
        error: 'WordPress credentials not configured',
        missing: ['WP_URL', 'WP_USERNAME', 'WP_APP_PASSWORD'].filter(function (k) {
          return !config[k];
        }),
      });
    }

    var wpUrl = config.WP_URL.replace(/\/$/, '');
    var authHeader = 'Basic ' + Buffer.from(
      config.WP_USERNAME + ':' + config.WP_APP_PASSWORD
    ).toString('base64');

    // Use ?rest_route= format (works on Cloudways without Nginx rewrite)
    var restRouteUrl = wpUrl + '/?rest_route=' + encodeURIComponent('/wp/v2/users/me');

    logger.info('api', 'Testing WP connection: ' + restRouteUrl);

    axios.get(restRouteUrl, {
      headers: { 'Authorization': authHeader },
      timeout: 15000,
    })
      .then(function (userRes) {
        if (userRes.data && userRes.data.id) {
          res.json({
            success: true,
            message: 'WordPress connection successful. Authenticated as: ' + (userRes.data.name || userRes.data.slug),
            wpUrl: wpUrl,
            userId: userRes.data.id,
            method: '?rest_route=',
          });
        } else {
          res.json({ success: false, error: 'Unexpected response from WordPress' });
        }
      })
      .catch(function (err) {
        var statusCode = err.response ? err.response.status : null;
        var wpMsg = err.response && err.response.data ? (err.response.data.message || err.response.data.code || '') : err.message;
        var fullMsg = '';

        if (statusCode === 401) {
          fullMsg = 'Authentication failed (HTTP 401): ' + wpMsg +
            '. The Authorization header is likely stripped by Nginx. ' +
            'Fix: Add "SetEnvIf Authorization (.*) HTTP_AUTHORIZATION=$1" to .htaccess, ' +
            'or add "fastcgi_param HTTP_AUTHORIZATION $http_authorization;" to Nginx config.';
        } else if (statusCode === 404) {
          fullMsg = 'REST API not found (HTTP 404). WordPress REST API may be disabled. ' +
            'Check: Settings → Permalinks → Save. Ensure no plugin is blocking REST API.';
        } else if (statusCode) {
          fullMsg = 'WP API error (HTTP ' + statusCode + '): ' + wpMsg;
        } else {
          fullMsg = 'Cannot reach WordPress: ' + err.message +
            '. Check that WP_URL is correct and the server is reachable.';
        }

        logger.error('api', 'WordPress test failed: ' + fullMsg);
        try {
          db.prepare("INSERT INTO logs (level, module, message, created_at) VALUES ('error', 'publisher', ?, datetime('now'))").run('WP test failed: ' + fullMsg);
        } catch (logErr) { /* ignore */ }
        res.status(500).json({ error: fullMsg });
      });
  });

  // ─── GET /api/wp-logs — Recent WordPress-related logs ──────────────────

  router.get('/wp-logs', function (req, res) {
    try {
      var limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
      var rows = db.prepare(
        "SELECT id, level, module, message, details, created_at FROM logs " +
        "WHERE (module IN ('publisher', 'wordpress')) " +
        "OR (module = 'api' AND (message LIKE '%WP%' OR message LIKE '%WordPress%' OR message LIKE '%wordpress%' OR message LIKE '%wp-json%')) " +
        "ORDER BY created_at DESC LIMIT ?"
      ).all(limit);
      res.json({ logs: rows, total: rows.length });
    } catch (err) {
      logger.error('api', 'Failed to fetch WP logs: ' + err.message);
      res.status(500).json({ error: 'Failed to fetch WP logs' });
    }
  });

  // ─── GET /api/wp-status — Live WordPress connection diagnostic ────────

  router.get('/wp-status', function (req, res) {
    var config = getConfig();
    var result = {
      configured: !!(config.WP_URL && config.WP_USERNAME && config.WP_APP_PASSWORD),
      wpUrl: config.WP_URL ? config.WP_URL.replace(/\/$/, '') : '',
      wpUsername: config.WP_USERNAME || '',
      publisherEnabled: publisher ? publisher.enabled : false,
      publisherStatus: publisher ? publisher.status : 'not_loaded',
      publisherError: publisher ? publisher.error : null,
      postStatus: config.WP_POST_STATUS || 'draft',
      checks: {},
    };

    if (!result.configured) {
      result.checks.credentials = { ok: false, message: 'Missing WP_URL, WP_USERNAME, or WP_APP_PASSWORD' };
      return res.json(result);
    }

    // Test actual connection
    var wpUrl = config.WP_URL.replace(/\/$/, '');
    var authHeader = 'Basic ' + Buffer.from(
      config.WP_USERNAME + ':' + config.WP_APP_PASSWORD
    ).toString('base64');

    result.checks.credentials = { ok: true, message: 'All credentials present' };

    // Test REST API discovery using ?rest_route= (works on Cloudways)
    var restRouteBase = wpUrl + '/?rest_route=';

    axios.get(restRouteBase + encodeURIComponent('/'), {
      headers: { 'Authorization': authHeader },
      timeout: 15000,
    }).then(function (apiRes) {
      result.checks.restApi = { ok: true, message: 'REST API reachable via ?rest_route=', siteName: apiRes.data.name || '' };

      // Test auth by fetching current user
      return axios.get(restRouteBase + encodeURIComponent('/wp/v2/users/me'), {
        headers: { 'Authorization': authHeader },
        timeout: 10000,
      });
    }).then(function (userRes) {
      result.checks.auth = {
        ok: true,
        message: 'Authenticated as ' + (userRes.data.name || userRes.data.slug || 'user'),
        userId: userRes.data.id,
        roles: userRes.data.roles || [],
      };
      var canPublish = userRes.data.capabilities && (userRes.data.capabilities.publish_posts || userRes.data.capabilities.edit_posts);
      result.checks.permissions = {
        ok: !!canPublish,
        message: canPublish ? 'User can create posts' : 'User may lack publish_posts capability',
      };
      res.json(result);
    }).catch(function (err) {
      var statusCode = err.response ? err.response.status : null;
      var wpMsg = err.response && err.response.data ? (err.response.data.message || err.response.data.code || '') : '';
      if (statusCode === 401 || statusCode === 403) {
        result.checks.auth = {
          ok: false,
          message: 'Authentication failed (HTTP ' + statusCode + '): ' + wpMsg +
            '. Nginx may be stripping the Authorization header. Add to .htaccess: SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1'
        };
      } else if (statusCode) {
        result.checks.restApi = { ok: false, message: 'REST API error (HTTP ' + statusCode + '): ' + wpMsg };
      } else {
        result.checks.restApi = { ok: false, message: 'Cannot reach WordPress: ' + err.message };
      }
      res.json(result);
    });
  });

  // ─── Firehose Rules Proxy ──────────────────────────────────────────────

  router.get('/firehose/rules', function (req, res) {
    var config = getConfig();
    var token = config.FIREHOSE_TOKEN;
    if (!token) {
      return res.status(400).json({ error: 'Firehose token not configured' });
    }
    axios.get('https://api.firehose.com/v1/rules', {
      headers: { 'Authorization': 'Bearer ' + token },
      timeout: 15000,
    })
    .then(function (response) {
      res.json(response.data);
    })
    .catch(function (err) {
      var msg = err.response ? 'API error ' + err.response.status + ': ' + JSON.stringify(err.response.data) : err.message;
      logger.error('api', 'Failed to fetch firehose rules', msg);
      res.status(err.response ? err.response.status : 500).json({ error: msg });
    });
  });

  router.post('/firehose/rules', function (req, res) {
    var config = getConfig();
    var token = config.FIREHOSE_TOKEN;
    if (!token) {
      return res.status(400).json({ error: 'Firehose token not configured' });
    }
    var body = req.body;
    if (!body || !body.value) {
      return res.status(400).json({ error: 'Rule "value" (Lucene query) is required' });
    }
    axios.post('https://api.firehose.com/v1/rules', {
      value: body.value,
      tag: body.tag || '',
      quality: body.quality !== false,
    }, {
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      timeout: 15000,
    })
    .then(function (response) {
      logger.info('api', 'Firehose rule created', { tag: body.tag, value: body.value.substring(0, 80) });
      res.json(response.data);
    })
    .catch(function (err) {
      var msg = err.response ? 'API error ' + err.response.status + ': ' + JSON.stringify(err.response.data) : err.message;
      logger.error('api', 'Failed to create firehose rule', msg);
      res.status(err.response ? err.response.status : 500).json({ error: msg });
    });
  });

  router.put('/firehose/rules/:id', function (req, res) {
    var config = getConfig();
    var token = config.FIREHOSE_TOKEN;
    if (!token) {
      return res.status(400).json({ error: 'Firehose token not configured' });
    }
    var ruleId = req.params.id;
    if (!/^[a-zA-Z0-9_-]+$/.test(ruleId)) {
      return res.status(400).json({ error: 'Invalid rule ID format' });
    }
    var body = req.body;
    return axios.put('https://api.firehose.com/v1/rules/' + ruleId, body, {
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      timeout: 15000,
    })
    .then(function (response) {
      logger.info('api', 'Firehose rule updated', { ruleId: ruleId });
      res.json(response.data);
    })
    .catch(function (err) {
      var msg = err.response ? 'API error ' + err.response.status + ': ' + JSON.stringify(err.response.data) : err.message;
      logger.error('api', 'Failed to update firehose rule', msg);
      res.status(err.response ? err.response.status : 500).json({ error: msg });
    });
  });

  router.delete('/firehose/rules/:id', function (req, res) {
    var config = getConfig();
    var token = config.FIREHOSE_TOKEN;
    if (!token) {
      return res.status(400).json({ error: 'Firehose token not configured' });
    }
    var ruleId = req.params.id;
    if (!/^[a-zA-Z0-9_-]+$/.test(ruleId)) {
      return res.status(400).json({ error: 'Invalid rule ID format' });
    }
    return axios.delete('https://api.firehose.com/v1/rules/' + ruleId, {
      headers: { 'Authorization': 'Bearer ' + token },
      timeout: 15000,
    })
    .then(function (response) {
      logger.info('api', 'Firehose rule deleted', { ruleId: ruleId });
      res.json({ success: true });
    })
    .catch(function (err) {
      var msg = err.response ? 'API error ' + err.response.status + ': ' + JSON.stringify(err.response.data) : err.message;
      logger.error('api', 'Failed to delete firehose rule', msg);
      res.status(err.response ? err.response.status : 500).json({ error: msg });
    });
  });

  router.get('/firehose/status', function (req, res) {
    try {
      var status = firehose ? firehose.getStatus() : { connected: false, stopped: true };
      var config = getConfig();
      status.tokenConfigured = !!config.FIREHOSE_TOKEN;
      status.tokenPreview = config.FIREHOSE_TOKEN ? '...' + config.FIREHOSE_TOKEN.slice(-4) : '';
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /api/firehose/connect — Save token & connect ────────────────
  // Accepts either a tap token (fh_) or management key (fhm_).
  // If management key, auto-discovers/creates a tap and saves the tap token.

  router.post('/firehose/connect', function (req, res) {
    try {
      var token = req.body && req.body.token;
      if (!token) {
        return res.status(400).json({ error: 'Token is required' });
      }

      token = token.trim();

      // Detect key type
      if (token.indexOf('fhm_') === 0) {
        // Management key — need to discover or create a tap
        logger.info('api', 'Management key detected, discovering taps...');
        var mgmtKey = token;

        // Save management key for future use
        var upsertMgmt = db.prepare(
          "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        );
        upsertMgmt.run('FIREHOSE_MANAGEMENT_KEY', mgmtKey);

        // List existing taps
        axios.get('https://api.firehose.com/v1/taps', {
          headers: { 'Authorization': 'Bearer ' + mgmtKey },
          timeout: 15000,
        })
        .then(function (tapsRes) {
          var taps = tapsRes.data;
          if (!Array.isArray(taps)) taps = taps.taps || taps.data || [];

          if (taps.length > 0) {
            // Use the first tap's token
            var tapToken = taps[0].token || taps[0].tap_token;
            var tapName = taps[0].name || taps[0].id || 'tap-1';
            logger.info('api', 'Found existing tap: ' + tapName + ', token: ...' + (tapToken ? tapToken.slice(-4) : ''));
            saveTapTokenAndConnect(tapToken, res);
          } else {
            // No taps exist — create one
            logger.info('api', 'No taps found, creating new tap...');
            axios.post('https://api.firehose.com/v1/taps', {
              name: 'hdf-autopub'
            }, {
              headers: { 'Authorization': 'Bearer ' + mgmtKey, 'Content-Type': 'application/json' },
              timeout: 15000,
            })
            .then(function (createRes) {
              var newTap = createRes.data;
              var tapToken = newTap.token || newTap.tap_token;
              logger.info('api', 'Created new tap: hdf-autopub, token: ...' + (tapToken ? tapToken.slice(-4) : ''));
              saveTapTokenAndConnect(tapToken, res);
            })
            .catch(function (err) {
              var msg = err.response ? 'API error ' + err.response.status + ': ' + JSON.stringify(err.response.data) : err.message;
              logger.error('api', 'Failed to create tap', msg);
              res.status(500).json({ error: 'Failed to create tap: ' + msg });
            });
          }
        })
        .catch(function (err) {
          var msg = err.response ? 'API error ' + err.response.status + ': ' + JSON.stringify(err.response.data) : err.message;
          logger.error('api', 'Failed to list taps', msg);
          res.status(500).json({ error: 'Failed to list taps with management key: ' + msg });
        });

      } else {
        // Direct tap token (fh_ or other) — save and connect immediately
        saveTapTokenAndConnect(token, res);
      }
    } catch (err) {
      logger.error('api', 'Failed to save firehose token', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  function saveTapTokenAndConnect(tapToken, res) {
    if (!tapToken) {
      return res.status(500).json({ error: 'No tap token received from API' });
    }

    var upsertStmt = db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    );
    upsertStmt.run('FIREHOSE_TOKEN', tapToken);

    // Reload config
    var { loadRuntimeOverrides } = require('../utils/config');
    loadRuntimeOverrides(db);
    var newConfig = getConfig();

    // Restart firehose with new token
    if (firehose) {
      firehose.stop();
      firehose._stopped = false;
      firehose.updateConfig(newConfig);
      firehose.connect();
    }

    logger.info('api', 'Tap token saved and connection initiated');
    res.json({
      success: true,
      message: 'Tap token saved. Connecting to Firehose...',
      tokenPreview: '...' + tapToken.slice(-4),
    });
  }

  // ─── Draft Routes (Manual Selection + Editor) ─────────────────────────

  var { extractDraftContent, rewriteDraftContent, extractImageFromHtml } = require('../utils/draft-helpers');
  var draftDeps = { db: db, logger: logger, extractor: extractor, rewriter: rewriter };

  // POST /api/drafts/check-urls — Check which URLs already exist as drafts
  router.post('/drafts/check-urls', function (req, res) {
    try {
      var urls = req.body && req.body.urls;
      if (!urls || !Array.isArray(urls)) {
        return res.json({ drafts: {} });
      }
      if (urls.length > 500) urls = urls.slice(0, 500);

      var result = {};
      var stmt = db.prepare('SELECT id, source_url, status, wp_post_url FROM drafts WHERE source_url = ?');
      for (var i = 0; i < urls.length; i++) {
        var row = stmt.get(urls[i]);
        if (row) {
          result[urls[i]] = { draft_id: row.id, status: row.status, wp_post_url: row.wp_post_url || null };
        }
      }
      return res.json({ drafts: result });
    } catch (err) {
      logger.error('api', 'POST /api/drafts/check-urls failed: ' + err.message);
      return res.status(500).json({ drafts: {} });
    }
  });

  // GET /api/drafts/status?url=... — Check draft status for a single URL
  // GET /api/drafts/status?url=... — Check draft status for a single URL
  router.get('/drafts/status', function (req, res) {
    try {
      var url = req.query.url;
      if (!url) return res.json({ exists: false, draft: null });

      var row = db.prepare(
        'SELECT id, status, wp_post_url, wp_post_id FROM drafts WHERE source_url = ?'
      ).get(url);

      if (row) {
        // Return BOTH flat fields (backward compat) AND a `draft` object (for SSE handler)
        var draftObj = {
          draft_id: row.id,
          status: row.status,
          wp_post_url: row.wp_post_url || null,
          wp_post_id: row.wp_post_id || null
        };
        return res.json({
          exists: true,
          draft_id: row.id,
          status: row.status,
          wp_post_url: row.wp_post_url || null,
          wp_post_id: row.wp_post_id || null,
          draft: draftObj
        });
      }
      return res.json({ exists: false, draft: null });
    } catch (err) {
      logger.error('api', 'GET /api/drafts/status failed: ' + err.message);
      return res.json({ exists: false, draft: null });
    }
  });

  // POST /api/drafts — Create draft from selected article
  router.post('/drafts', function (req, res) {
    try {
      var body = req.body || {};

      // Validate + normalise the URL through the same helper used by
      // manual-import. We can't trust body.url to be well-formed, and we
      // also can't trust body.domain — it must be derived from the
      // canonicalised URL so the dashboard groups sources correctly.
      var v = validateAndNormalizeUrl(body.url);
      if (!v) {
        return res.status(400).json({ success: false, error: 'Invalid URL' });
      }

      // Check for duplicate
      var existing = db.prepare('SELECT id FROM drafts WHERE source_url = ?').get(v.url);
      if (existing) {
        return res.json({ success: true, draft_id: existing.id, message: 'Draft already exists' });
      }

      var draftConfig = getConfig();
      var draftPlatform = (draftConfig.WP_URL && draftConfig.WP_USERNAME && draftConfig.WP_APP_PASSWORD) ? 'wordpress' : 'blogspot';

      var result = db.prepare(
        "INSERT INTO drafts (source_article_id, source_url, source_domain, source_title, source_content_markdown, source_language, source_category, source_publish_time, target_platform, status, mode) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'fetching', 'manual')"
      ).run(
        body.article_id || null,
        v.url,
        v.domain,
        body.title || null,
        body.content_markdown || '',
        body.language || null,
        body.page_category || null,
        body.publish_time || null,
        draftPlatform
      );

      var draftId = result.lastInsertRowid;
      logger.info('api', 'Draft ' + draftId + ' created from ' + v.domain + ': "' + (body.title || v.url) + '"');

      // Trigger extraction in background
      extractDraftContent(draftId, draftDeps).catch(function (err) {
        logger.warn('api', 'Background extraction failed for draft ' + draftId + ': ' + err.message);
      });

      return res.json({ success: true, draft_id: draftId });
    } catch (err) {
      logger.error('api', 'POST /api/drafts failed: ' + err.message);
      return res.status(500).json({ success: false, error: 'Failed to create draft' });
    }
  });

  // POST /api/drafts/bulk-create — Create multiple drafts from Live Feed selection
  router.post('/drafts/bulk-create', function (req, res) {
    try {
      var articles = req.body && req.body.articles;
      if (!articles || !Array.isArray(articles) || articles.length === 0) {
        return res.status(400).json({ success: false, error: 'No articles provided' });
      }
      if (articles.length > 50) {
        return res.status(400).json({ success: false, error: 'Maximum 50 articles at once' });
      }

      var draftConfig = getConfig();
      var draftPlatform = (draftConfig.WP_URL && draftConfig.WP_USERNAME && draftConfig.WP_APP_PASSWORD) ? 'wordpress' : 'blogspot';

      var insertStmt = db.prepare(
        "INSERT OR IGNORE INTO drafts (source_article_id, source_url, source_domain, source_title, source_content_markdown, source_language, source_category, source_publish_time, target_platform, status, mode) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'fetching', 'manual')"
      );
      var checkDup = db.prepare('SELECT id FROM drafts WHERE source_url = ?');

      var created = 0;
      var skipped = 0;
      var invalid = 0;
      var createdIds = [];
      var urlMap = {};

      for (var i = 0; i < articles.length; i++) {
        var a = articles[i];
        // Validate + normalise URL — same helper as manual-import + POST
        // /drafts. We use the canonical form (not the raw input) for both
        // dedupe and storage so the same article entered different ways
        // (with/without www., with/without trailing slash) collapses.
        var bv = validateAndNormalizeUrl(a.url);
        if (!bv) { invalid++; continue; }

        // Skip known duplicates (fast path)
        var existingDraft = checkDup.get(bv.url);
        if (existingDraft) {
          skipped++;
          urlMap[bv.url] = existingDraft.id;
          continue;
        }

        try {
          var result = insertStmt.run(
            a.article_id || null,
            bv.url,
            bv.domain,
            a.title || null,
            a.content_markdown || '',
            a.language || null,
            a.page_category || null,
            a.publish_time || null,
            draftPlatform
          );
          createdIds.push(result.lastInsertRowid);
          urlMap[bv.url] = result.lastInsertRowid;
          created++;
        } catch (insertErr) {
          logger.warn('api', 'Bulk draft insert failed for ' + bv.url + ': ' + insertErr.message);
          skipped++;
        }
      }

      // Trigger extraction for all new drafts (async, non-blocking)
      if (createdIds.length > 0) {
        logger.info('api', 'Bulk created ' + created + ' drafts, triggering extraction...');
        (async function () {
          for (var j = 0; j < createdIds.length; j++) {
            try {
              await extractDraftContent(createdIds[j], draftDeps);
            } catch (err) {
              logger.warn('api', 'Bulk extraction failed for draft ' + createdIds[j] + ': ' + err.message);
            }
          }
          logger.info('api', 'Bulk extraction complete for ' + createdIds.length + ' drafts');
        })();
      }

      return res.json({ success: true, created: created, skipped: skipped, invalid: invalid, total: articles.length, draftIds: createdIds, urlMap: urlMap });
    } catch (err) {
      logger.error('api', 'POST /api/drafts/bulk-create failed: ' + err.message);
      return res.status(500).json({ success: false, error: 'Failed to create drafts' });
    }
  });

  // GET /api/drafts — List all drafts
  router.get('/drafts', function (req, res) {
    try {
      var status = req.query.status || null;
      var mode = req.query.mode || null;
      var clusterId = req.query.cluster_id || null;

      var query = 'SELECT * FROM drafts';
      var conditions = [];
      var params = [];

      if (status) { conditions.push('status = ?'); params.push(status); }
      if (mode) { conditions.push('mode = ?'); params.push(mode); }
      if (clusterId) { conditions.push('cluster_id = ?'); params.push(clusterId); }

      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }
      // Order: cluster primary drafts first within their group, then by date
      query += ' ORDER BY cluster_id DESC NULLS LAST, ' +
               "CASE WHEN cluster_role = 'primary' THEN 0 ELSE 1 END, " +
               'created_at DESC';

      var stmt = db.prepare(query);
      var drafts = stmt.all.apply(stmt, params);
      return res.json({ success: true, data: drafts });
    } catch (err) {
      logger.error('api', 'GET /api/drafts failed: ' + err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── GET /api/drafts/stats ──────────────────────────────────────────────
  //
  // Returns counts by extraction status for the batch extract button badge.
  //
  router.get('/drafts/stats', function (req, res) {
    try {
      var stats = db.prepare(
        "SELECT " +
        "  COUNT(*) as total, " +
        "  SUM(CASE WHEN extraction_status = 'pending' THEN 1 ELSE 0 END) as pending, " +
        "  SUM(CASE WHEN extraction_status = 'failed' THEN 1 ELSE 0 END) as failed, " +
        "  SUM(CASE WHEN extraction_status IN ('success','cached','fallback') THEN 1 ELSE 0 END) as extracted, " +
        "  SUM(CASE WHEN status = 'fetching' AND locked_by IS NOT NULL THEN 1 ELSE 0 END) as in_progress, " +
        "  SUM(CASE WHEN status = 'published' THEN 1 ELSE 0 END) as published, " +
        "  SUM(CASE WHEN status = 'rewriting' THEN 1 ELSE 0 END) as rewriting " +
        "FROM drafts"
      ).get();

      res.json({ success: true, stats: stats });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── GET /api/drafts/ready — Rewritten but not yet published ─────────────────
  // MUST be before /drafts/:id to prevent Express matching "ready" as :id.
  router.get('/drafts/ready', function (req, res) {
    try {
      var pp = parsePageParam(req, 20);
      var rows = db.prepare(
        "SELECT d.id, d.source_url, d.source_domain, d.rewritten_title, d.rewritten_word_count, " +
        "  d.ai_model_used, d.target_keyword, d.updated_at, d.mode, d.cluster_id, " +
        "  c.topic, c.article_count, c.trends_boosted " +
        "FROM drafts d " +
        "LEFT JOIN clusters c ON d.cluster_id = c.id " +
        "WHERE d.status = 'ready' " +
        "  AND d.cluster_role = 'primary' " +
        "  AND d.rewritten_html IS NOT NULL " +
        "  AND LENGTH(d.rewritten_html) > 100 " +
        "ORDER BY c.trends_boosted DESC, d.updated_at DESC " +
        "LIMIT ? OFFSET ?"
      ).all(pp.perPage, (pp.page - 1) * pp.perPage);

      var total = db.prepare(
        "SELECT COUNT(*) as count FROM drafts d " +
        "WHERE d.status = 'ready' AND d.cluster_role = 'primary' " +
        "  AND d.rewritten_html IS NOT NULL AND LENGTH(d.rewritten_html) > 100"
      ).get().count || 0;

      res.json({ success: true, data: rows, total: total, page: pp.page, perPage: pp.perPage });
    } catch (err) {
      logger.error('api', 'GET /api/drafts/ready failed: ' + err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── GET /api/drafts/failed — List failed drafts with error details ──────────
  // MUST be registered before /drafts/:id parametric route.
  router.get('/drafts/failed', function (req, res) {
    try {
      var pp = parsePagination(req);
      var rows = db.prepare(
        "SELECT d.id, d.source_url, d.source_domain, d.rewritten_title, d.rewritten_word_count, " +
        "  d.ai_model_used, d.error_message, d.retry_count, d.updated_at, d.mode, d.cluster_id, " +
        "  d.rewritten_html, " +
        "  c.topic, c.article_count " +
        "FROM drafts d " +
        "LEFT JOIN clusters c ON d.cluster_id = c.id " +
        "WHERE d.status = 'failed' " +
        "ORDER BY d.updated_at DESC " +
        "LIMIT ? OFFSET ?"
      ).all(pp.perPage, (pp.page - 1) * pp.perPage);

      // Strip large html field — only need presence flag
      var mapped = rows.map(function (r) {
        return {
          id: r.id,
          source_url: r.source_url,
          source_domain: r.source_domain,
          rewritten_title: r.rewritten_title,
          rewritten_word_count: r.rewritten_word_count,
          ai_model_used: r.ai_model_used,
          error_message: r.error_message,
          retry_count: r.retry_count,
          updated_at: r.updated_at,
          mode: r.mode,
          cluster_id: r.cluster_id,
          topic: r.topic,
          article_count: r.article_count,
          has_rewritten_html: !!(r.rewritten_html && r.rewritten_html.length > 100),
        };
      });

      var total = db.prepare("SELECT COUNT(*) as count FROM drafts WHERE status = 'failed'").get().count || 0;
      res.json({ success: true, data: mapped, total: total, page: pp.page, perPage: pp.perPage });
    } catch (err) {
      logger.error('api', 'GET /api/drafts/failed: ' + err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── POST /api/drafts/retry-all-failed — Bulk reset all failed drafts ────────
  // MUST be registered before /drafts/:id parametric route.
  router.post('/drafts/retry-all-failed', function (req, res) {
    try {
      // Drafts with rewritten content → ready; without → back to draft
      var withContent = db.prepare(
        "UPDATE drafts SET status = 'ready', error_message = NULL, retry_count = 0, " +
        "failed_permanent = 0, last_error_at = NULL, next_run_at = NULL, " +
        "locked_by = NULL, locked_at = NULL, lease_expires_at = NULL, " +
        "updated_at = datetime('now') " +
        "WHERE status = 'failed' AND rewritten_html IS NOT NULL AND LENGTH(rewritten_html) > 100"
      ).run();

      var withoutContent = db.prepare(
        "UPDATE drafts SET status = 'draft', error_message = NULL, retry_count = 0, " +
        "failed_permanent = 0, last_error_at = NULL, next_run_at = NULL, " +
        "locked_by = NULL, locked_at = NULL, lease_expires_at = NULL, " +
        "updated_at = datetime('now') " +
        "WHERE status = 'failed' AND (rewritten_html IS NULL OR LENGTH(rewritten_html) <= 100)"
      ).run();

      // Reset any cluster that no longer has failed drafts
      db.prepare(
        "UPDATE clusters SET status = 'ready' WHERE status = 'failed' " +
        "AND id IN (SELECT DISTINCT cluster_id FROM drafts WHERE status = 'ready' AND cluster_id IS NOT NULL)"
      ).run();

      var total = withContent.changes + withoutContent.changes;
      logger.info('api', 'Bulk retry: reset ' + total + ' failed drafts (' + withContent.changes + ' to ready, ' + withoutContent.changes + ' to draft)');
      res.json({ success: true, count: total, toReady: withContent.changes, toDraft: withoutContent.changes, message: 'Reset ' + total + ' drafts' });
    } catch (err) {
      logger.error('api', 'POST /drafts/retry-all-failed: ' + err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── POST /api/drafts/publish-all-ready ─────────────────────────────────────
  // Publish every ready primary draft to WordPress in a background loop with
  // 3-second spacing. MUST be registered before /drafts/:id parametric routes.
  router.post('/drafts/publish-all-ready', function (req, res) {
    try {
      var publisherMod = deps.publisher || (deps.scheduler && deps.scheduler.publisher);
      if (publisherMod && !publisherMod.enabled && typeof publisherMod.reinit === 'function') {
        publisherMod.reinit();
      }
      if (!publisherMod || !publisherMod.enabled) {
        return res.status(400).json({ success: false, error: 'WordPress publisher not configured. Set WP credentials in Settings.' });
      }

      var readyDrafts = db.prepare(
        "SELECT id FROM drafts WHERE status = 'ready' AND cluster_role = 'primary' " +
        "AND rewritten_html IS NOT NULL AND LENGTH(rewritten_html) > 100"
      ).all();

      if (readyDrafts.length === 0) {
        return res.json({ success: true, queued: 0, message: 'No ready articles found' });
      }

      // Fire and forget — publish each one with a 3-second delay between them
      (async function () {
        for (var i = 0; i < readyDrafts.length; i++) {
          try {
            // Re-fetch to ensure still ready
            var d = db.prepare("SELECT * FROM drafts WHERE id = ? AND status = 'ready'").get(readyDrafts[i].id);
            if (!d) continue;

            var article = {
              title: d.rewritten_title || d.extracted_title || d.source_title,
              content: d.rewritten_html,
              excerpt: d.extracted_excerpt || '',
              metaDescription: d.meta_description || d.extracted_excerpt || '',
              slug: (function () {
                var source = d.target_keyword || d.rewritten_title || d.extracted_title || d.source_title || '';
                return source.toLowerCase()
                  .replace(/[^\w\s-]/g, '')
                  .replace(/\s+/g, '-')
                  .replace(/-+/g, '-')
                  .replace(/^-|-$/g, '')
                  .slice(0, 70);
              })(),
              targetKeyword: d.target_keyword || '',
              relatedKeywords: [],
              faq: (function () { try { return d.faq_json ? JSON.parse(d.faq_json) : []; } catch (e) { return []; } })(),
              wordCount: d.rewritten_word_count || 0,
              aiModel: d.ai_model_used || 'manual',
              tokensUsed: 0,
              featuredImage: d.featured_image || null,
              schemaTypes: d.schema_types || 'NewsArticle,FAQPage,BreadcrumbList',
              targetDomain: d.target_domain || '',
            };

            var clusterDrafts = d.cluster_id
              ? db.prepare("SELECT * FROM drafts WHERE cluster_id = ?").all(d.cluster_id)
              : [d];

            var clusterObj = {
              id: d.cluster_id || null,
              articles: clusterDrafts.map(function (cd) {
                return {
                  url: cd.source_url,
                  domain: cd.source_domain,
                  title: cd.source_title,
                  content_markdown: cd.extracted_content || cd.source_content_markdown || '',
                  featured_image: cd.featured_image || null,
                };
              }),
            };

            // Idempotent: UPDATE existing post if wp_post_id exists, else CREATE new
            var pubResult;
            if (d.wp_post_id) {
              var updateData = {
                title: article.title,
                content: article.content,
                excerpt: article.excerpt,
                featured_media: d.wp_media_id || 0,
              };
              var upd = await publisherMod.updatePost(d.wp_post_id, updateData);
              pubResult = { wpPostId: upd.wpPostId, wpPostUrl: upd.wpPostUrl, wpImageId: d.wp_media_id || null };
            } else {
              pubResult = await publisherMod.publish(article, clusterObj, db);
            }

            db.prepare(
              "UPDATE drafts SET status = 'published', wp_post_id = ?, wp_post_url = ?, " +
              "published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
            ).run(pubResult.wpPostId || null, pubResult.wpPostUrl || null, d.id);

            if (pubResult.wpImageId) {
              try { db.prepare("UPDATE drafts SET wp_media_id = ? WHERE id = ?").run(pubResult.wpImageId, d.id); } catch (e) { /* ignore */ }
            }

            if (d.cluster_id) {
              db.prepare("UPDATE clusters SET status = 'published', published_at = datetime('now') WHERE id = ?")
                .run(d.cluster_id);
            }

            logger.info('api', 'Batch publish: draft #' + d.id + ' -> WP post ' + (pubResult.wpPostUrl || ''));

            // Wait 3 seconds between publishes to avoid overloading WP REST API
            if (i < readyDrafts.length - 1) {
              await new Promise(function (resolve) { setTimeout(resolve, 3000); });
            }
          } catch (err) {
            logger.warn('api', 'Batch publish failed for draft #' + readyDrafts[i].id + ': ' + (err.message || err));
          }
        }
        logger.info('api', 'Batch publish complete: ' + readyDrafts.length + ' drafts processed');
      })();

      res.json({
        success: true,
        queued: readyDrafts.length,
        message: 'Publishing ' + readyDrafts.length + ' articles in the background',
      });
    } catch (err) {
      logger.error('api', 'publish-all-ready failed: ' + err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/drafts/:id — Get single draft
  router.get('/drafts/:id', function (req, res) {
    try {
      var id = parseId(req.params.id);
      if (!id) return res.status(400).json({ success: false, error: 'Invalid draft id' });
      var draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
      if (!draft) {
        return res.status(404).json({ success: false, error: 'Draft not found' });
      }
      return res.json({ success: true, data: draft });
    } catch (err) {
      logger.error('api', 'GET /drafts/:id: ' + err.message);
      return res.status(500).json({ success: false, error: 'Failed to load draft' });
    }
  });

  // PUT /api/drafts/:id — Update draft settings
  router.put('/drafts/:id', function (req, res) {
    try {
      var id = parseId(req.params.id);
      if (!id) return res.status(400).json({ success: false, error: 'Invalid draft id' });
      var body = req.body || {};

      var updates = [];
      var params = [];

      var fields = ['target_keyword', 'target_domain', 'target_platform', 'target_language', 'schema_types', 'status', 'featured_image', 'custom_ai_instructions'];
      for (var i = 0; i < fields.length; i++) {
        if (body[fields[i]] !== undefined) {
          updates.push(fields[i] + ' = ?');
          params.push(body[fields[i]]);
        }
      }

      if (updates.length === 0) {
        return res.status(400).json({ success: false, error: 'No fields to update' });
      }

      updates.push("updated_at = datetime('now')");
      params.push(id);

      var stmt = db.prepare('UPDATE drafts SET ' + updates.join(', ') + ' WHERE id = ?');
      stmt.run.apply(stmt, params);

      logger.info('api', 'Draft ' + id + ' updated');
      return res.json({ success: true });
    } catch (err) {
      logger.error('api', 'PUT /drafts/:id: ' + err.message);
      return res.status(500).json({ success: false, error: 'Failed to update draft' });
    }
  });

  // ─── POST /api/drafts/batch-fetch-images ──────────────────────────────
  //
  // Fetches featured images for all extracted articles that are missing images.
  // Runs async — returns immediately, processes in background.
  //
  router.post('/drafts/batch-fetch-images', function (req, res) {
    try {
      var missingImages = db.prepare(
        "SELECT id, source_url, source_domain FROM drafts " +
        "WHERE (featured_image IS NULL OR featured_image = '') " +
        "AND extraction_status IN ('success', 'cache', 'fallback') " +
        "AND status != 'failed' " +
        "ORDER BY created_at DESC " +
        "LIMIT 500"
      ).all();

      if (missingImages.length === 0) {
        return res.json({ success: true, message: 'All articles already have images', count: 0 });
      }

      logger.info('api', 'Batch image fetch: starting for ' + missingImages.length + ' articles');

      (async function () {
        var found = 0;
        var failed = 0;

        for (var i = 0; i < missingImages.length; i++) {
          var draft = missingImages[i];
          try {
            // SSRF: source_url originated from a user-supplied URL, so the
            // background image-fetch must use the same defenses as the
            // foreground extractor.
            assertSafeUrl(draft.source_url);
            var imgRes = await axios.get(draft.source_url, safeAxiosOptions({
              timeout: 8000,
              maxContentLength: 50 * 1024,
              headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml',
                'Referer': 'https://www.google.com/'
              },
              maxRedirects: 3,
              validateStatus: function (s) { return s < 400; },
            }));

            if (imgRes.data && typeof imgRes.data === 'string') {
              var imageUrl = extractImageFromHtml(imgRes.data, draft.source_url);

              if (imageUrl) {
                db.prepare("UPDATE drafts SET featured_image = ?, updated_at = datetime('now') WHERE id = ?")
                  .run(imageUrl, draft.id);
                found++;
                logger.info('api', 'Batch image: found image for #' + draft.id + ' (' + draft.source_domain + ')');
              } else {
                failed++;
              }
            }
          } catch (err) {
            failed++;
          }

          if (i < missingImages.length - 1) {
            await new Promise(function (resolve) { setTimeout(resolve, 300); });
          }
        }

        logger.info('api', 'Batch image fetch complete: ' + found + ' found, ' + failed + ' failed, ' + missingImages.length + ' total');
      })().catch(function (err) {
        logger.error('api', 'Batch image fetch error: ' + err.message);
      });

      res.json({
        success: true,
        message: 'Image fetch started for ' + missingImages.length + ' articles (processing in background)',
        count: missingImages.length
      });
    } catch (err) {
      logger.error('api', 'Batch image fetch start error: ' + err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── POST /api/drafts/recover-stuck ─────────────────────────────────────
  //
  // Recovers all drafts stuck in extraction_status = 'extracting'
  // by resetting them to 'pending' so the extraction loop picks them up again.
  //
  router.post('/drafts/recover-stuck', function (req, res) {
    try {
      var result = db.prepare(
        "UPDATE drafts SET extraction_status = 'pending', " +
        "status = 'fetching', " +
        "locked_by = NULL, locked_at = NULL, lease_expires_at = NULL, " +
        "updated_at = datetime('now') " +
        "WHERE extraction_status = 'extracting'"
      ).run();

      logger.info('api', 'Manual recovery: reset ' + result.changes + ' stuck extracting drafts');

      res.json({
        success: true,
        message: 'Recovered ' + result.changes + ' stuck drafts',
        recoveredCount: result.changes
      });
    } catch (err) {
      logger.error('api', 'Recovery error: ' + err.message);
      res.status(500).json({ success: false, error: 'Recovery failed: ' + err.message });
    }
  });

  // ─── Manual URL Import ────────────────────────────────────────────────
  // User pastes URLs one per line. We create draft records with mode='manual_import'
  // and the existing extraction loop picks them up automatically.
  // The extraction loop picks them up, then the rewrite + publish workers handle them
  // exactly like auto-pipeline articles. Full AI rewrite + WordPress publish.
  router.post('/drafts/manual-import', async function (req, res) {
    try {
      var body = req.body || {};
      var rawUrls = body.urls;

      if (!Array.isArray(rawUrls) || rawUrls.length === 0) {
        return res.status(400).json({ success: false, error: 'urls array required' });
      }

      // Cap at 100 URLs per request to avoid runaway imports
      if (rawUrls.length > 100) {
        return res.status(400).json({ success: false, error: 'Maximum 100 URLs per import request' });
      }

      // Normalize + validate via shared helper. Centralising the rules
      // (string-only, 2048-char cap, http(s) scheme, hostname required)
      // means POST /drafts, bulk-create, and manual-import all enforce
      // the same shape.
      var validUrls = [];
      var invalidUrls = [];
      for (var i = 0; i < rawUrls.length; i++) {
        var v = validateAndNormalizeUrl(rawUrls[i]);
        if (!v) {
          invalidUrls.push(rawUrls[i]);
          continue;
        }
        validUrls.push(v);
      }

      if (validUrls.length === 0) {
        return res.status(400).json({ success: false, error: 'No valid URLs found', invalid: invalidUrls });
      }

      // Insert drafts (skip duplicates — UNIQUE constraint on source_url will throw)
      var insertStmt = db.prepare(
        "INSERT INTO drafts (source_url, source_domain, source_title, source_content_markdown, " +
        "mode, status, extraction_status, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, 'manual_import', 'fetching', 'pending', datetime('now'), datetime('now'))"
      );

      var imported = [];
      var skipped = [];

      for (var j = 0; j < validUrls.length; j++) {
        var v = validUrls[j];
        try {
          var placeholderTitle = 'Manual Import: ' + v.domain;
          var info = insertStmt.run(v.url, v.domain, placeholderTitle, '');
          imported.push({ id: info.lastInsertRowid, url: v.url, domain: v.domain });
        } catch (dbErr) {
          // Most likely UNIQUE constraint violation (URL already exists)
          if (String(dbErr.message).indexOf('UNIQUE') !== -1) {
            skipped.push({ url: v.url, reason: 'already exists' });
          } else {
            skipped.push({ url: v.url, reason: dbErr.message });
          }
        }
      }

      logger.info('api', 'Manual import: ' + imported.length + ' queued, ' +
        skipped.length + ' skipped, ' + invalidUrls.length + ' invalid');

      res.json({
        success: true,
        imported: imported.length,
        skipped: skipped.length,
        invalid: invalidUrls.length,
        details: {
          imported: imported,
          skipped: skipped,
          invalid: invalidUrls,
        },
        message: imported.length + ' URLs queued. Each will be extracted, AI-rewritten, and published to WordPress automatically.',
      });

    } catch (err) {
      logger.error('api', 'Manual import failed: ' + err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── POST /api/drafts/batch-delete ──────────────────────────────────────
  //
  // Deletes specific drafts by ID array.
  // Body: { ids: [1, 2, 3, ...] }
  // Safety: won't delete drafts with status 'published'.
  //
  router.post('/drafts/batch-delete', function (req, res) {
    try {
      var ids = req.body && req.body.ids;

      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ success: false, error: 'ids must be a non-empty array' });
      }

      // Sanitize: only allow positive integers
      var safeIds = ids
        .map(function (id) { return parseInt(id, 10); })
        .filter(function (id) { return !isNaN(id) && id > 0; });

      if (safeIds.length === 0) {
        return res.status(400).json({ success: false, error: 'No valid draft IDs provided' });
      }

      // Cap at 500 per request to avoid mega-queries
      if (safeIds.length > 500) {
        return res.status(400).json({ success: false, error: 'Maximum 500 drafts per batch delete' });
      }

      // Build parameterized placeholders: (?, ?, ?, ...)
      var placeholders = safeIds.map(function () { return '?'; }).join(', ');

      // Safety: exclude published drafts
      var deleteStmt = db.prepare(
        'DELETE FROM drafts WHERE id IN (' + placeholders + ') AND status != \'published\''
      );

      var result = deleteStmt.run.apply(deleteStmt, safeIds);

      logger.info('api', 'Batch delete: removed ' + result.changes + ' of ' + safeIds.length + ' requested drafts');

      res.json({
        success: true,
        message: 'Deleted ' + result.changes + ' drafts',
        deletedCount: result.changes,
        requestedCount: safeIds.length,
        skippedPublished: safeIds.length - result.changes
      });
    } catch (err) {
      logger.error('api', 'Batch delete error: ' + err.message);
      res.status(500).json({ success: false, error: 'Batch delete failed: ' + err.message });
    }
  });

  // ─── DELETE /api/drafts/batch-failed ────────────────────────────────────
  //
  // Deletes ALL drafts with extraction_status = 'failed'.
  // Safety: won't delete published articles.
  // MUST be before /drafts/:id to prevent Express matching "batch-failed" as :id
  //
  router.delete('/drafts/batch-failed', function (req, res) {
    try {
      var failedCount = db.prepare(
        "SELECT COUNT(*) as cnt FROM drafts WHERE extraction_status = 'failed' AND status != 'published'"
      ).get().cnt;

      if (failedCount === 0) {
        return res.json({ success: true, message: 'No failed drafts to delete', deletedCount: 0 });
      }

      var deleteResult = db.transaction(function () {
        db.prepare(
          "UPDATE drafts SET locked_by = NULL WHERE extraction_status = 'failed' AND locked_by IS NOT NULL"
        ).run();

        var result = db.prepare(
          "DELETE FROM drafts WHERE extraction_status = 'failed' AND status != 'published'"
        ).run();

        return result.changes;
      });

      var deleted = deleteResult();

      logger.info('api', 'Batch delete: removed ' + deleted + ' failed drafts');

      res.json({
        success: true,
        message: 'Deleted ' + deleted + ' failed drafts',
        deletedCount: deleted
      });
    } catch (err) {
      logger.error('api', 'Batch delete failed: ' + err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // DELETE /api/drafts/:id — Delete a draft
  router.delete('/drafts/:id', function (req, res) {
    try {
      var id = parseId(req.params.id);
      if (!id) return res.status(400).json({ success: false, error: 'Invalid draft id' });
      var result = db.prepare('DELETE FROM drafts WHERE id = ?').run(id);
      if (result.changes === 0) {
        return res.status(404).json({ success: false, error: 'Draft not found' });
      }
      return res.json({ success: true });
    } catch (err) {
      logger.error('api', 'DELETE /drafts/:id: ' + err.message);
      return res.status(500).json({ success: false, error: 'Failed to delete draft' });
    }
  });

  // ─── POST /api/drafts/batch-extract ─────────────────────────────────────
  //
  // Re-queues all un-extracted and optionally failed drafts for Pipeline V2.
  // Does NOT extract inline — just resets statuses so the extraction loop picks them up.
  //
  router.post('/drafts/batch-extract', function (req, res) {
    try {
      var includeFailed = req.body && req.body.include_failed;
      var now = new Date().toISOString();

      // Count what we're about to re-queue
      var pendingCount = db.prepare(
        "SELECT COUNT(*) as cnt FROM drafts WHERE extraction_status IN ('pending') AND status IN ('draft', 'fetching')"
      ).get().cnt;

      var stuckCount = db.prepare(
        "SELECT COUNT(*) as cnt FROM drafts WHERE status = 'fetching' AND locked_by IS NOT NULL AND lease_expires_at < ?"
      ).get(now).cnt;

      var failedCount = 0;
      if (includeFailed) {
        failedCount = db.prepare(
          "SELECT COUNT(*) as cnt FROM drafts WHERE extraction_status = 'failed'"
        ).get().cnt;
      }

      // Run all resets in a single transaction for atomicity
      var batchReset = db.transaction(function () {
        var totalReset = 0;

        // 1. Reset stuck/locked articles (stale leases from crashed workers)
        var stuckResult = db.prepare(
          "UPDATE drafts SET " +
          "  locked_by = NULL, locked_at = NULL, lease_expires_at = NULL, " +
          "  status = 'fetching', " +
          "  updated_at = datetime('now') " +
          "WHERE locked_by IS NOT NULL AND lease_expires_at < ?"
        ).run(now);
        totalReset += stuckResult.changes;

        // 2. Reset pending articles that might be in wrong status
        var pendingResult = db.prepare(
          "UPDATE drafts SET " +
          "  status = 'fetching', " +
          "  locked_by = NULL, locked_at = NULL, lease_expires_at = NULL, " +
          "  updated_at = datetime('now') " +
          "WHERE extraction_status = 'pending' AND status NOT IN ('fetching')"
        ).run();
        totalReset += pendingResult.changes;

        // 3. Reset failed articles if requested (clear retry count so they get another chance)
        var failedReset = 0;
        if (includeFailed) {
          var failedResult = db.prepare(
            "UPDATE drafts SET " +
            "  extraction_status = 'pending', " +
            "  status = 'fetching', " +
            "  retry_count = 0, " +
            "  next_run_at = NULL, " +
            "  locked_by = NULL, locked_at = NULL, lease_expires_at = NULL, " +
            "  updated_at = datetime('now') " +
            "WHERE extraction_status = 'failed'"
          ).run();
          failedReset = failedResult.changes;
          totalReset += failedReset;
        }

        return { totalReset: totalReset, failedReset: failedReset };
      });

      var result = batchReset();

      logger.info('api', 'Batch extract: re-queued ' + result.totalReset + ' drafts (pending=' + pendingCount + ', stuck=' + stuckCount + ', failed=' + result.failedReset + ')');

      // Nudge the pipeline if it has a processQueue method (backward compat)
      if (scheduler && typeof scheduler.processQueue === 'function') {
        setTimeout(function () {
          scheduler.processQueue().catch(function (err) {
            logger.warn('api', 'Pipeline nudge after batch-extract failed: ' + err.message);
          });
        }, 500);
      }

      res.json({
        success: true,
        message: 'Batch extraction queued',
        stats: {
          totalReQueued: result.totalReset,
          pending: pendingCount,
          stuck: stuckCount,
          failedReQueued: result.failedReset
        }
      });
    } catch (err) {
      logger.error('api', 'Batch extract failed: ' + err.message);
      res.status(500).json({ success: false, error: 'Batch extract failed: ' + err.message });
    }
  });

  // POST /api/drafts/:id/extract — Re-trigger extraction
  router.post('/drafts/:id/extract', function (req, res) {
    try {
      var id = parseId(req.params.id);
      if (!id) return res.status(400).json({ success: false, error: 'Invalid draft id' });
      db.prepare("UPDATE drafts SET extraction_status = 'pending', status = 'fetching', updated_at = datetime('now') WHERE id = ?").run(id);

      extractDraftContent(id, draftDeps).catch(function (err) {
        logger.warn('api', 'Re-extraction failed for draft ' + id + ': ' + err.message);
      });

      return res.json({ success: true, message: 'Extraction re-triggered' });
    } catch (err) {
      logger.error('api', 'POST /drafts/:id/extract: ' + err.message);
      return res.status(500).json({ success: false, error: 'Failed to re-trigger extraction' });
    }
  });

  // ─── POST /api/drafts/batch-rewrite ─────────────────────────────────────
  //
  // Triggers AI rewrite for ALL clusters that have finished extraction.
  // Does NOT auto-run — only triggered when admin clicks the button.
  //
  router.post('/drafts/batch-rewrite', async function (req, res) {
    try {
      if (!scheduler || typeof scheduler.rewriteAllExtractedClusters !== 'function') {
        return res.status(500).json({ success: false, error: 'Pipeline not available or missing rewriteAllExtractedClusters method' });
      }

      var result = await scheduler.rewriteAllExtractedClusters();

      logger.info('api', 'Batch rewrite: queued=' + result.queued + ', failed=' + result.failed);

      res.json({
        success: true,
        message: 'Batch rewrite started',
        stats: {
          clustersQueued: result.queued,
          clustersFailed: result.failed,
          errors: (result.errors || []).slice(0, 5)
        }
      });
    } catch (err) {
      logger.error('api', 'Batch rewrite failed: ' + err.message);
      res.status(500).json({ success: false, error: 'Batch rewrite failed: ' + err.message });
    }
  });

  // ─── POST /api/clusters/:clusterId/rewrite ──────────────────────────────
  //
  // Triggers AI rewrite for a SINGLE cluster.
  //
  router.post('/clusters/:clusterId/rewrite', async function (req, res) {
    try {
      var clusterId = parseId(req.params.clusterId);
      if (!clusterId) return res.status(400).json({ success: false, error: 'Invalid cluster id' });

      if (!scheduler || typeof scheduler.rewriteClusterManual !== 'function') {
        return res.status(500).json({ success: false, error: 'Pipeline not available' });
      }

      var result = await scheduler.rewriteClusterManual(clusterId);

      res.json({
        success: true,
        message: 'Rewrite started for cluster #' + clusterId,
        primaryDraftId: result.primaryDraftId
      });
    } catch (err) {
      logger.error('api', 'Cluster rewrite failed: ' + err.message);
      res.status(500).json({ success: false, error: 'Cluster rewrite failed' });
    }
  });

  // POST /api/drafts/:id/rewrite — Trigger AI rewrite
  router.post('/drafts/:id/rewrite', function (req, res) {
    try {
      var id = parseId(req.params.id);
      if (!id) {
        return res.status(400).json({ success: false, error: 'Invalid draft id' });
      }
      var draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);

      if (!draft) {
        return res.status(404).json({ success: false, error: 'Draft not found' });
      }

      if (!draft.extracted_content && !draft.source_content_markdown) {
        return res.status(400).json({ success: false, error: 'No content available to rewrite. Extract content first.' });
      }

      var customPrompt = (req.body && req.body.custom_prompt) || draft.custom_ai_instructions || '';

      // Save custom instructions if provided
      if (req.body && req.body.custom_prompt) {
        db.prepare('UPDATE drafts SET custom_ai_instructions = ? WHERE id = ?').run(req.body.custom_prompt, id);
      }

      var aiOptions = {};
      if (req.body && req.body.provider) aiOptions.provider = req.body.provider;
      if (req.body && req.body.model) aiOptions.model = req.body.model;
      // Pass all draft settings through to the rewriter
      aiOptions.targetKeyword = draft.target_keyword || '';
      aiOptions.targetDomain = draft.target_domain || '';
      aiOptions.language = draft.target_language || 'en+hi';
      aiOptions.schemaTypes = draft.schema_types || 'NewsArticle,FAQPage,BreadcrumbList';
      aiOptions.customPrompt = customPrompt;

      // IMPORTANT: rewriteDraftContent owns ALL status transitions
      // (rewriting → ready / draft / failed) and writes retry_count +
      // error_message on failure. Earlier this route also flipped status
      // to 'rewriting' before calling the helper AND reset to 'draft' in
      // the .catch handler — that race could clobber the helper's
      // 'failed' status when retries were exhausted, causing drafts to
      // appear retryable forever. Now we just log and trust the helper.
      rewriteDraftContent(id, customPrompt, draftDeps, aiOptions).catch(function (err) {
        logger.warn('api', 'Rewrite failed for draft ' + id + ': ' + err.message);
      });

      return res.json({ success: true, message: 'Rewrite started' });
    } catch (err) {
      logger.error('api', 'POST /drafts/' + req.params.id + '/rewrite: ' + err.message);
      return res.status(500).json({ success: false, error: 'Failed to start rewrite' });
    }
  });

  // GET /api/drafts/:id/versions — List all versions for a draft
  router.get('/drafts/:id/versions', function (req, res) {
    try {
      var id = parseId(req.params.id);
      if (!id) return res.status(400).json({ success: false, error: 'Invalid draft id' });

      var draft = db.prepare('SELECT id, current_version FROM drafts WHERE id = ?').get(id);
      if (!draft) return res.status(404).json({ success: false, error: 'Draft not found' });

      var versions = db.prepare(
        'SELECT id, version, rewritten_title, rewritten_word_count, ai_model_used, ai_provider, ai_tokens_used, created_at' +
        ' FROM draft_versions WHERE draft_id = ? ORDER BY version DESC'
      ).all(id);

      return res.json({
        success: true,
        draft_id: id,
        current_version: draft.current_version || 0,
        versions: versions,
      });
    } catch (err) {
      logger.error('api', 'GET /drafts/' + req.params.id + '/versions: ' + err.message);
      return res.status(500).json({ success: false, error: 'Failed to list versions' });
    }
  });

  // GET /api/drafts/:id/versions/:version — Fetch a specific version
  router.get('/drafts/:id/versions/:version', function (req, res) {
    try {
      var id = parseId(req.params.id);
      if (!id) return res.status(400).json({ success: false, error: 'Invalid draft id' });
      var version = parseInt(req.params.version, 10);
      if (!version || version < 1) return res.status(400).json({ success: false, error: 'Invalid version' });

      var row = db.prepare(
        'SELECT * FROM draft_versions WHERE draft_id = ? AND version = ?'
      ).get(id, version);

      if (!row) return res.status(404).json({ success: false, error: 'Version not found' });

      return res.json({ success: true, version: row });
    } catch (err) {
      logger.error('api', 'GET /drafts/' + req.params.id + '/versions/' + req.params.version + ': ' + err.message);
      return res.status(500).json({ success: false, error: 'Failed to fetch version' });
    }
  });

  // POST /api/drafts/:id/versions/:version/restore — Restore an old version
  // This copies the snapshot's content back into drafts AND creates a new
  // version row (so the restore itself is also tracked in history).
  router.post('/drafts/:id/versions/:version/restore', function (req, res) {
    try {
      var id = parseId(req.params.id);
      if (!id) return res.status(400).json({ success: false, error: 'Invalid draft id' });
      var version = parseInt(req.params.version, 10);
      if (!version || version < 1) return res.status(400).json({ success: false, error: 'Invalid version' });

      var draft = db.prepare('SELECT id FROM drafts WHERE id = ?').get(id);
      if (!draft) return res.status(404).json({ success: false, error: 'Draft not found' });

      var snapshot = db.prepare(
        'SELECT * FROM draft_versions WHERE draft_id = ? AND version = ?'
      ).get(id, version);
      if (!snapshot) return res.status(404).json({ success: false, error: 'Version not found' });

      var maxRow = db.prepare(
        'SELECT COALESCE(MAX(version), 0) AS max_version FROM draft_versions WHERE draft_id = ?'
      ).get(id);
      var nextVersion = (maxRow && maxRow.max_version ? maxRow.max_version : 0) + 1;

      var txn = db.transaction(function () {
        db.prepare(
          "UPDATE drafts SET" +
          "  rewritten_html = ?," +
          "  rewritten_title = ?," +
          "  rewritten_word_count = ?," +
          "  ai_model_used = ?," +
          "  ai_provider = ?," +
          "  ai_tokens_used = ?," +
          "  faq_json = ?," +
          "  in_brief_json = ?," +
          "  body_markdown = ?," +
          "  ai_signals = ?," +
          "  current_version = ?," +
          "  status = 'ready'," +
          "  updated_at = datetime('now')" +
          " WHERE id = ?"
        ).run(
          snapshot.rewritten_html,
          snapshot.rewritten_title,
          snapshot.rewritten_word_count,
          snapshot.ai_model_used,
          snapshot.ai_provider,
          snapshot.ai_tokens_used,
          snapshot.faq_json,
          snapshot.in_brief_json,
          snapshot.body_markdown,
          snapshot.ai_signals,
          nextVersion,
          id
        );

        db.prepare(
          "INSERT INTO draft_versions (" +
          "  draft_id, version, rewritten_title, rewritten_html, rewritten_word_count," +
          "  in_brief_json, body_markdown, faq_json, ai_signals," +
          "  ai_model_used, ai_provider, ai_tokens_used" +
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(
          id,
          nextVersion,
          snapshot.rewritten_title,
          snapshot.rewritten_html,
          snapshot.rewritten_word_count,
          snapshot.in_brief_json,
          snapshot.body_markdown,
          snapshot.faq_json,
          snapshot.ai_signals,
          snapshot.ai_model_used,
          snapshot.ai_provider,
          snapshot.ai_tokens_used
        );
      });
      txn();

      logger.info('api', 'Draft ' + id + ' restored from v' + version + ' as v' + nextVersion);
      return res.json({ success: true, restored_from: version, new_version: nextVersion });
    } catch (err) {
      logger.error('api', 'POST /drafts/' + req.params.id + '/versions/' + req.params.version + '/restore: ' + err.message);
      return res.status(500).json({ success: false, error: 'Failed to restore version' });
    }
  });

  // PUT /api/drafts/:id/html — Save edited HTML
  router.put('/drafts/:id/html', function (req, res) {
    try {
      var id = parseId(req.params.id);
      if (!id) return res.status(400).json({ success: false, error: 'Invalid draft id' });
      var html = req.body && req.body.html;
      if (typeof html !== 'string') return res.status(400).json({ success: false, error: 'html field required' });

      var info = db.prepare("UPDATE drafts SET rewritten_html = ?, updated_at = datetime('now') WHERE id = ?").run(html, id);
      if (info.changes === 0) return res.status(404).json({ success: false, error: 'Draft not found' });
      return res.json({ success: true });
    } catch (err) {
      logger.error('api', 'PUT /drafts/:id/html: ' + err.message);
      return res.status(500).json({ success: false, error: 'Failed to save HTML' });
    }
  });

  // POST /api/drafts/:id/blogger-xml — Convert HTML to Blogger XML
  router.post('/drafts/:id/blogger-xml', function (req, res) {
    try {
      var html = req.body && req.body.html;
      if (!html) return res.status(400).json({ success: false, error: 'No HTML provided' });

      // Extract parts
      var cssMatch = html.match(/<style>([\s\S]*?)<\/style>/);
      var css = cssMatch ? cssMatch[1] : '';

      var bodyMatch = html.match(/<body>([\s\S]*?)<\/body>/);
      var body = bodyMatch ? bodyMatch[1] : html;

      var headMatch = html.match(/<head>([\s\S]*?)<\/head>/);
      var headContent = headMatch ? headMatch[1] : '';

      var metaTags = (headContent.match(/<meta[^>]+\/?>/g) || [])
        .filter(function (t) { return t.indexOf('charset') === -1 && t.indexOf('viewport') === -1; })
        .join('\n    ');

      var linkTags = (headContent.match(/<link[^>]+\/?>/g) || []).join('\n    ');

      var schemas = (headContent.match(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g) || [])
        .map(function (s) {
          return s.replace(/<script type="application\/ld\+json">/, '<script type="application/ld+json">\n//<![CDATA[\n')
                  .replace(/<\/script>/, '\n//]]>\n    </script>');
        })
        .join('\n    ');

      var titleMatch = headContent.match(/<title>([\s\S]*?)<\/title>/);
      var title = titleMatch ? titleMatch[1].replace(/&/g, '&amp;') : 'Article';

      // Fix body for XML
      var xmlBody = body
        .replace(/<br\s*>/g, '<br/>')
        .replace(/<hr\s*>/g, '<hr/>')
        .replace(/<img([^>]*?)(?<!\/)>/g, '<img$1/>')
        .replace(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-fA-F]+;)/g, '&amp;');

      var bloggerXML = '<?xml version="1.0" encoding="UTF-8" ?>\n' +
        '<!DOCTYPE html>\n' +
        '<html xmlns=\'http://www.w3.org/1999/xhtml\' xmlns:b=\'http://www.google.com/2005/gml/b\' xmlns:data=\'http://www.google.com/2005/gml/data\' xmlns:expr=\'http://www.google.com/2005/gml/expr\'>\n' +
        '<head>\n' +
        '    <meta content=\'IE=edge\' http-equiv=\'X-UA-Compatible\'/>\n' +
        '    <meta content=\'width=device-width, initial-scale=1.0\' name=\'viewport\'/>\n' +
        '    <b:include data=\'blog\' name=\'all-head-content\'/>\n' +
        '    <title>' + title + '</title>\n' +
        '    ' + metaTags + '\n' +
        '    ' + linkTags + '\n' +
        '    ' + schemas + '\n' +
        '    <b:skin><![CDATA[\n' + css + '\n    ]]></b:skin>\n' +
        '</head>\n' +
        '<body>\n' + xmlBody + '\n' +
        '    <b:section id=\'main\' showaddelement=\'no\' maxwidgets=\'0\'/>\n' +
        '</body>\n' +
        '</html>';

      return res.json({ success: true, xml: bloggerXML });
    } catch (err) {
      logger.error('api', 'Blogger XML conversion failed: ' + err.message);
      return res.status(500).json({ success: false, error: 'Blogger XML conversion failed' });
    }
  });

  // POST /api/drafts/:id/publish — Publish to platform
  router.post('/drafts/:id/publish', function (req, res) {
    try {
      var id = parseId(req.params.id);
      if (!id) return res.status(400).json({ success: false, error: 'Invalid draft id' });
      var body = req.body || {};
      // Default to wordpress if WP credentials are configured
      var config = getConfig();
      var wpConfigured = !!(config.WP_URL && config.WP_USERNAME && config.WP_APP_PASSWORD);
      var platform = body.platform || (wpConfigured ? 'wordpress' : 'blogspot');
      var draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
      if (!draft) return res.status(404).json({ success: false, error: 'Draft not found' });

      var publishUrl = null;

      if (platform === 'wordpress') {
        // Use existing publisher module
        var publisherMod = deps.publisher || (deps.scheduler && deps.scheduler.publisher);
        // Auto-reinit if publisher was disabled but credentials may now exist
        if (publisherMod && !publisherMod.enabled && typeof publisherMod.reinit === 'function') {
          publisherMod.reinit();
        }
        if (publisherMod && publisherMod.enabled) {
          // Build rewrittenArticle object matching what publisher.publish() expects
          var rewrittenArticle = {
            title: draft.rewritten_title || draft.extracted_title || draft.source_title,
            content: body.html || draft.rewritten_html || '',
            excerpt: draft.extracted_excerpt || '',
            metaDescription: draft.meta_description || draft.extracted_excerpt || '',
            slug: (function () {
              var source = draft.target_keyword || draft.rewritten_title || draft.extracted_title || draft.source_title || '';
              return source.toLowerCase()
                .replace(/[^\w\s-]/g, '')
                .replace(/\s+/g, '-')
                .replace(/-+/g, '-')
                .replace(/^-|-$/g, '')
                .slice(0, 70);
            })(),
            targetKeyword: draft.target_keyword || '',
            relatedKeywords: [],
            faq: (function() { try { return draft.faq_json ? JSON.parse(draft.faq_json) : []; } catch (e) { return []; } })(),
            wordCount: draft.rewritten_word_count || 0,
            aiModel: draft.ai_model_used || 'manual',
            tokensUsed: 0,
            featuredImage: draft.featured_image || null,
            schemaTypes: draft.schema_types || 'NewsArticle,FAQPage,BreadcrumbList',
            targetDomain: draft.target_domain || '',
          };

          // Build a minimal cluster with articles for image extraction
          var draftCluster = {
            id: null,
            articles: [{
              content_markdown: draft.source_content_markdown || '',
              content: draft.extracted_content || '',
              featured_image: draft.featured_image || '',
            }],
          };

          // Idempotent: UPDATE existing post if wp_post_id exists, else CREATE new
          var existingWpPostId = draft.wp_post_id || null;
          var publishPromise;

          if (existingWpPostId) {
            logger.info('api', 'Draft ' + id + ': UPDATING existing WP post ' + existingWpPostId);
            var updateData = {
              title: rewrittenArticle.title,
              content: rewrittenArticle.content,
              excerpt: rewrittenArticle.excerpt,
              featured_media: draft.wp_media_id || 0,
            };
            publishPromise = publisherMod.updatePost(existingWpPostId, updateData)
              .then(function (result) { return { wpPostId: result.wpPostId, wpPostUrl: result.wpPostUrl, wpImageId: draft.wp_media_id || null, isUpdate: true }; });
          } else {
            logger.info('api', 'Draft ' + id + ': Creating NEW WP post');
            publishPromise = publisherMod.publish(rewrittenArticle, draftCluster, db)
              .then(function (result) { return { wpPostId: result.wpPostId, wpPostUrl: result.wpPostUrl, wpImageId: result.wpImageId || null, isUpdate: false }; });
          }

          publishPromise.then(function (result) {
            publishUrl = result.wpPostUrl || '';
            db.prepare(
              "UPDATE drafts SET status = 'published', wp_post_id = ?, wp_post_url = ?, " +
              "error_message = NULL, retry_count = 0, failed_permanent = 0, " +
              "published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
            ).run(result.wpPostId, publishUrl, id);
            if (result.wpImageId) {
              try { db.prepare("UPDATE drafts SET wp_media_id = ? WHERE id = ?").run(result.wpImageId, id); } catch (e) { /* ignore */ }
            }
            if (draft.cluster_id) {
              try { db.prepare("UPDATE clusters SET status = 'published', published_at = datetime('now') WHERE id = ?").run(draft.cluster_id); } catch (e) { /* ignore */ }
            }
            var action = result.isUpdate ? 'updated' : 'published';
            logger.info('api', 'Draft ' + id + ' ' + action + ' to WordPress: ' + publishUrl + (result.wpImageId ? ' (image: ' + result.wpImageId + ')' : ''));
            res.json({ success: true, url: publishUrl, wpPostId: result.wpPostId, wpMediaId: result.wpImageId || null, isUpdate: result.isUpdate });
          }).catch(function (err) {
            var detail = err.message || 'Unknown error';
            var statusCode = err.response ? err.response.status : null;
            var wpError = err.response && err.response.data ? (err.response.data.message || err.response.data.code || '') : '';
            var fullMsg = 'WP publish failed' + (statusCode ? ' (HTTP ' + statusCode + ')' : '') + ': ' + detail + (wpError ? ' — ' + wpError : '');
            logger.error('api', fullMsg);
            try {
              db.prepare("INSERT INTO logs (level, module, message, created_at) VALUES ('error', 'publisher', ?, datetime('now'))").run(fullMsg);
            } catch (logErr) { /* ignore */ }
            res.status(500).json({ success: false, error: fullMsg });
          });
          return;
        } else {
          return res.json({ success: false, error: 'WordPress publisher not configured. Set WP credentials in Settings.' });
        }
      }

      // For Blogspot/GitHub/S3 — mark as published, user copies HTML/XML manually
      publishUrl = draft.target_domain ? 'https://' + draft.target_domain : null;

      db.prepare("UPDATE drafts SET status = 'published', published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
      logger.info('api', 'Draft ' + id + ' published to ' + platform + (publishUrl ? ': ' + publishUrl : ''));
      return res.json({ success: true, url: publishUrl });
    } catch (err) {
      logger.error('api', 'Publish failed for draft ' + id + ': ' + err.message);
      return res.status(500).json({ success: false, error: 'Publish failed' });
    }
  });

  // ─── GET /api/firehose/taps — List taps (requires management key) ────

  router.get('/firehose/taps', function (req, res) {
    var mgmtKey = db.prepare("SELECT value FROM settings WHERE key = 'FIREHOSE_MANAGEMENT_KEY'").get();
    if (!mgmtKey || !mgmtKey.value) {
      return res.status(400).json({ error: 'No management key configured. Save one first via Firehose connect.' });
    }

    axios.get('https://api.firehose.com/v1/taps', {
      headers: { 'Authorization': 'Bearer ' + mgmtKey.value },
      timeout: 15000,
    })
    .then(function (response) {
      var taps = response.data;
      if (!Array.isArray(taps)) taps = taps.taps || taps.data || [];
      res.json({ taps: taps });
    })
    .catch(function (err) {
      var msg = err.response ? 'API error ' + err.response.status + ': ' + JSON.stringify(err.response.data) : err.message;
      res.status(err.response ? err.response.status : 500).json({ error: msg });
    });
  });

  // ─── POST /api/drafts/:id/retry — Reset a failed draft for retry ──────
  // If the draft has rewritten_html → reset to 'ready' (publish retry).
  // If it has no content yet → reset to 'draft' (rewrite retry).

  router.post('/drafts/:id/retry', function (req, res) {
    try {
      var id = parseId(req.params.id);
      if (!id) return res.status(400).json({ success: false, error: 'Invalid draft id' });

      var draft = db.prepare('SELECT id, cluster_id, status, rewritten_html FROM drafts WHERE id = ?').get(id);
      if (!draft) return res.status(404).json({ success: false, error: 'Draft not found' });
      if (draft.status !== 'failed') {
        return res.status(400).json({ success: false, error: 'Draft is not in failed state (current: ' + draft.status + ')' });
      }

      var hasContent = !!(draft.rewritten_html && draft.rewritten_html.length > 100);
      var newStatus = hasContent ? 'ready' : 'draft';

      db.prepare(
        "UPDATE drafts SET status = ?, retry_count = 0, failed_permanent = 0, " +
        "error_message = NULL, last_error_at = NULL, next_run_at = NULL, " +
        "locked_by = NULL, locked_at = NULL, lease_expires_at = NULL, " +
        "updated_at = datetime('now') WHERE id = ?"
      ).run(newStatus, id);

      if (draft.cluster_id) {
        db.prepare("UPDATE clusters SET status = 'ready' WHERE id = ? AND status = 'failed'").run(draft.cluster_id);
      }

      logger.info('api', 'Draft ' + id + ' reset from failed to ' + newStatus + ' for retry');
      res.json({ success: true, newStatus: newStatus });
    } catch (err) {
      logger.error('api', 'POST /drafts/:id/retry: ' + err.message);
      res.status(500).json({ success: false, error: 'Failed to reset draft' });
    }
  });

  // ─── GET /api/domains — List tracked domains with extraction stats ────

  router.get('/domains', function (req, res) {
    try {
      var rows = db.prepare('SELECT * FROM domains_config ORDER BY total_attempts DESC').all();
      res.json({ data: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /api/domains/:domain — Update domain config ────────────────

  router.post('/domains/:domain', function (req, res) {
    try {
      var domain = req.params.domain;
      var body = req.body || {};
      var existing = db.prepare('SELECT * FROM domains_config WHERE domain = ?').get(domain);
      if (!existing) return res.status(404).json({ error: 'Domain not found' });

      if (body.is_blocked !== undefined) {
        db.prepare("UPDATE domains_config SET is_blocked = ?, updated_at = datetime('now') WHERE domain = ?").run(body.is_blocked ? 1 : 0, domain);
      }
      if (body.notes !== undefined) {
        db.prepare("UPDATE domains_config SET notes = ?, updated_at = datetime('now') WHERE domain = ?").run(body.notes, domain);
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── POST /api/auth/change-password — Change dashboard password ──────

  router.post('/auth/change-password', function (req, res) {
    try {
      var { changePassword } = require('./auth');
      var body = req.body || {};
      var result = changePassword(body.currentPassword, body.newPassword);
      if (!result.success) {
        return res.status(400).json(result);
      }
      logger.info('api', 'Dashboard password changed successfully');
      return res.json({ success: true, message: 'Password changed successfully' });
    } catch (err) {
      logger.error('api', 'Password change failed: ' + err.message);
      return res.status(500).json({ success: false, error: 'Failed to change password' });
    }
  });

  // ─── GET /api/system/performance — Live performance monitoring ──────────────

  router.get('/system/performance', function(req, res) {
    try {
      var memUsage = process.memoryUsage();
      var uptime = process.uptime();

      var data = {
        uptime: {
          seconds: Math.round(uptime),
          formatted: Math.floor(uptime / 3600) + 'h ' + Math.floor((uptime % 3600) / 60) + 'm',
        },
        memory: {
          heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
          rssMB: Math.round(memUsage.rss / 1024 / 1024),
          externalMB: Math.round(memUsage.external / 1024 / 1024),
        },
        process: {
          pid: process.pid,
          nodeVersion: process.version,
          platform: process.platform,
        },
        modules: {},
      };

      var moduleNames = ['firehose', 'trends', 'buffer', 'similarity', 'extractor', 'rewriter', 'publisher', 'scheduler', 'infranodus'];
      for (var i = 0; i < moduleNames.length; i++) {
        var mod = deps[moduleNames[i]];
        if (mod && mod.getHealth) {
          data.modules[moduleNames[i]] = mod.getHealth();
        }
      }

      if (buffer && buffer.getStats) {
        data.buffer = buffer.getStats();
      }

      res.json(data);
    } catch (err) {
      res.status(500).json({ error: 'Failed to get performance data' });
    }
  });

  return router;
}

module.exports = createApiRouter;
