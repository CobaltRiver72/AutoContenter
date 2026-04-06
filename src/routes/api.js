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
  var { firehose, trends, buffer, similarity, extractor, rewriter, publisher, scheduler, infranodus, db, logger } = deps;

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
      clearInterval(heartbeat);
      if (firehose && typeof firehose.removeListener === 'function') {
        firehose.removeListener('article', onArticle);
      }
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
      var clusterId = parseInt(req.params.id, 10);
      if (isNaN(clusterId)) {
        return res.status(400).json({ error: 'Invalid cluster ID' });
      }

      var cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId);
      if (!cluster) {
        return res.status(404).json({ error: 'Cluster not found' });
      }

      var articles = db.prepare(
        'SELECT * FROM articles WHERE cluster_id = ? ORDER BY authority_tier ASC, received_at DESC'
      ).all(clusterId);

      res.json({ cluster: cluster, articles: articles });
    } catch (err) {
      logger.error('api', 'Failed to fetch cluster', err.message);
      res.status(500).json({ error: 'Failed to fetch cluster' });
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

      // Merge with current config defaults for display
      var config = getConfig();
      res.json({ settings: settings, config: config });
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

      var upsertStmt = db.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      );

      var insertMany = db.transaction(function (entries) {
        for (var i = 0; i < entries.length; i++) {
          upsertStmt.run(entries[i][0], String(entries[i][1]));
        }
      });

      var entries = Object.entries(updates);
      insertMany(entries);

      // Reload config with new overrides
      var { loadRuntimeOverrides } = require('../utils/config');
      loadRuntimeOverrides(db);

      logger.info('api', 'Settings updated', { keys: entries.map(function (e) { return e[0]; }) });
      res.json({ success: true, updated: entries.length });
    } catch (err) {
      logger.error('api', 'Failed to update settings', err.message);
      res.status(500).json({ error: 'Failed to update settings' });
    }
  });

  // ─── POST /api/clusters/:id/publish ───────────────────────────────────────

  router.post('/clusters/:id/publish', function (req, res) {
    try {
      var clusterId = parseInt(req.params.id, 10);
      if (isNaN(clusterId)) {
        return res.status(400).json({ error: 'Invalid cluster ID' });
      }

      var cluster = db.prepare('SELECT * FROM clusters WHERE id = ?').get(clusterId);
      if (!cluster) {
        return res.status(404).json({ error: 'Cluster not found' });
      }

      if (cluster.status === 'published') {
        return res.status(409).json({ error: 'Cluster already published' });
      }

      // Mark as queued and enqueue
      db.prepare("UPDATE clusters SET status = 'queued' WHERE id = ?").run(clusterId);

      if (scheduler && typeof scheduler.enqueue === 'function') {
        scheduler.enqueue(clusterId, 'high');
      }

      logger.info('api', 'Cluster manually enqueued for publish', { clusterId: clusterId });
      res.json({ success: true, clusterId: clusterId, status: 'queued' });
    } catch (err) {
      logger.error('api', 'Failed to enqueue cluster', err.message);
      res.status(500).json({ error: 'Failed to enqueue cluster' });
    }
  });

  // ─── POST /api/clusters/:id/skip ──────────────────────────────────────────

  router.post('/clusters/:id/skip', function (req, res) {
    try {
      var clusterId = parseInt(req.params.id, 10);
      if (isNaN(clusterId)) {
        return res.status(400).json({ error: 'Invalid cluster ID' });
      }

      var reason = (req.body && req.body.reason) || 'Manually skipped';

      var result = db.prepare(
        "UPDATE clusters SET status = 'skipped' WHERE id = ?"
      ).run(clusterId);

      if (result.changes === 0) {
        return res.status(404).json({ error: 'Cluster not found' });
      }

      logger.info('api', 'Cluster skipped', { clusterId: clusterId, reason: reason });
      res.json({ success: true, clusterId: clusterId, status: 'skipped', reason: reason });
    } catch (err) {
      logger.error('api', 'Failed to skip cluster', err.message);
      res.status(500).json({ error: 'Failed to skip cluster' });
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
    axios.get('https://api.firehose.com/v1/rules', {
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

    trends.pollOnce()
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
      var rewriter;
      try {
        rewriter = require('../modules/rewriter');
      } catch (e) {
        return res.status(503).json({ error: 'Rewriter module not available' });
      }

      if (!req.body || !req.body.article) {
        return res.status(400).json({ error: 'Request body must include "article" object' });
      }

      var article = req.body.article;
      rewriter.rewrite(article)
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
    var axios;
    try {
      axios = require('axios');
    } catch (e) {
      return res.status(503).json({ error: 'axios not available' });
    }

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

    var testPost = {
      title: '[HDF AutoPub] Connection Test — ' + new Date().toISOString(),
      content: '<p>This is an automated connection test. This draft will be deleted.</p>',
      status: 'draft',
    };

    axios.post(wpUrl + '/wp-json/wp/v2/posts', testPost, {
      headers: { Authorization: authHeader, 'Content-Type': 'application/json' },
      timeout: 15000,
    })
      .then(function (createRes) {
        var postId = createRes.data.id;
        // Delete the draft
        return axios.delete(wpUrl + '/wp-json/wp/v2/posts/' + postId + '?force=true', {
          headers: { Authorization: authHeader },
          timeout: 10000,
        }).then(function () {
          res.json({
            success: true,
            message: 'WordPress connection successful. Draft created and deleted.',
            wpUrl: wpUrl,
            postId: postId,
          });
        });
      })
      .catch(function (err) {
        var msg = err.response
          ? 'WP API error ' + err.response.status + ': ' + (err.response.data.message || '')
          : err.message;
        logger.error('api', 'WordPress test failed', msg);
        res.status(500).json({ error: 'WordPress test failed: ' + msg });
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
    var body = req.body;
    axios.put('https://api.firehose.com/v1/rules/' + ruleId, body, {
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
    axios.delete('https://api.firehose.com/v1/rules/' + ruleId, {
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

  var { extractDraftContent, rewriteDraftContent } = require('../utils/draft-helpers');
  var draftDeps = { db: db, logger: logger, extractor: extractor, rewriter: rewriter };

  // POST /api/drafts — Create draft from selected article
  router.post('/drafts', function (req, res) {
    try {
      var body = req.body || {};
      var url = body.url;

      if (!url) {
        return res.status(400).json({ success: false, error: 'URL is required' });
      }

      // Check for duplicate
      var existing = db.prepare('SELECT id FROM drafts WHERE source_url = ?').get(url);
      if (existing) {
        return res.json({ success: true, draft_id: existing.id, message: 'Draft already exists' });
      }

      var result = db.prepare(
        "INSERT INTO drafts (source_article_id, source_url, source_domain, source_title, source_content_markdown, source_language, source_category, source_publish_time, status, mode) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fetching', 'manual')"
      ).run(
        body.article_id || null,
        url,
        body.domain || null,
        body.title || null,
        body.content_markdown || '',
        body.language || null,
        body.page_category || null,
        body.publish_time || null
      );

      var draftId = result.lastInsertRowid;
      logger.info('api', 'Draft ' + draftId + ' created from ' + (body.domain || 'unknown') + ': "' + (body.title || url) + '"');

      // Trigger extraction in background
      extractDraftContent(draftId, draftDeps).catch(function (err) {
        logger.warn('api', 'Background extraction failed for draft ' + draftId + ': ' + err.message);
      });

      return res.json({ success: true, draft_id: draftId });
    } catch (err) {
      logger.error('api', 'POST /api/drafts failed: ' + err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/drafts — List all drafts
  router.get('/drafts', function (req, res) {
    try {
      var status = req.query.status || null;
      var mode = req.query.mode || null;

      var query = 'SELECT * FROM drafts';
      var conditions = [];
      var params = [];

      if (status) { conditions.push('status = ?'); params.push(status); }
      if (mode) { conditions.push('mode = ?'); params.push(mode); }

      if (conditions.length > 0) {
        query += ' WHERE ' + conditions.join(' AND ');
      }
      query += ' ORDER BY created_at DESC';

      var stmt = db.prepare(query);
      var drafts = stmt.all.apply(stmt, params);
      return res.json({ success: true, data: drafts });
    } catch (err) {
      logger.error('api', 'GET /api/drafts failed: ' + err.message);
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/drafts/:id — Get single draft
  router.get('/drafts/:id', function (req, res) {
    try {
      var draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(req.params.id);
      if (!draft) {
        return res.status(404).json({ success: false, error: 'Draft not found' });
      }
      return res.json({ success: true, data: draft });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // PUT /api/drafts/:id — Update draft settings
  router.put('/drafts/:id', function (req, res) {
    try {
      var body = req.body || {};
      var id = req.params.id;

      var updates = [];
      var params = [];

      var fields = ['target_keyword', 'target_domain', 'target_platform', 'target_language', 'schema_types', 'status', 'featured_image'];
      for (var i = 0; i < fields.length; i++) {
        if (body[fields[i]] !== undefined) {
          updates.push(fields[i] + ' = ?');
          params.push(body[fields[i]]);
        }
      }

      updates.push("updated_at = datetime('now')");
      params.push(id);

      var stmt = db.prepare('UPDATE drafts SET ' + updates.join(', ') + ' WHERE id = ?');
      stmt.run.apply(stmt, params);

      logger.info('api', 'Draft ' + id + ' updated');
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // DELETE /api/drafts/:id — Delete a draft
  router.delete('/drafts/:id', function (req, res) {
    try {
      db.prepare('DELETE FROM drafts WHERE id = ?').run(req.params.id);
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/drafts/:id/extract — Re-trigger extraction
  router.post('/drafts/:id/extract', function (req, res) {
    try {
      var id = req.params.id;
      db.prepare("UPDATE drafts SET extraction_status = 'pending', status = 'fetching', updated_at = datetime('now') WHERE id = ?").run(id);

      extractDraftContent(id, draftDeps).catch(function (err) {
        logger.warn('api', 'Re-extraction failed for draft ' + id + ': ' + err.message);
      });

      return res.json({ success: true, message: 'Extraction re-triggered' });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/drafts/:id/rewrite — Trigger AI rewrite
  router.post('/drafts/:id/rewrite', function (req, res) {
    try {
      var id = req.params.id;
      var draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);

      if (!draft) {
        return res.status(404).json({ success: false, error: 'Draft not found' });
      }

      if (!draft.extracted_content && !draft.source_content_markdown) {
        return res.status(400).json({ success: false, error: 'No content available to rewrite. Extract content first.' });
      }

      db.prepare("UPDATE drafts SET status = 'rewriting', updated_at = datetime('now') WHERE id = ?").run(id);

      var customPrompt = (req.body && req.body.custom_prompt) || '';

      rewriteDraftContent(id, customPrompt, draftDeps).catch(function (err) {
        logger.warn('api', 'Rewrite failed for draft ' + id + ': ' + err.message);
        db.prepare("UPDATE drafts SET status = 'draft', updated_at = datetime('now') WHERE id = ?").run(id);
      });

      return res.json({ success: true, message: 'Rewrite started' });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // PUT /api/drafts/:id/html — Save edited HTML
  router.put('/drafts/:id/html', function (req, res) {
    try {
      var html = req.body && req.body.html;
      var id = req.params.id;

      db.prepare("UPDATE drafts SET rewritten_html = ?, updated_at = datetime('now') WHERE id = ?").run(html, id);
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
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
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/drafts/:id/publish — Publish to platform
  router.post('/drafts/:id/publish', function (req, res) {
    try {
      var id = req.params.id;
      var body = req.body || {};
      var platform = body.platform || 'blogspot';
      var draft = db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
      if (!draft) return res.status(404).json({ success: false, error: 'Draft not found' });

      var publishUrl = null;

      if (platform === 'wordpress') {
        // Use existing publisher module if available
        var publisherMod = deps.publisher || (deps.scheduler && deps.scheduler.publisher);
        if (publisherMod && publisherMod.enabled) {
          publisherMod.publishPost({
            title: draft.rewritten_title || draft.extracted_title || draft.source_title,
            content: body.html || draft.rewritten_html,
            excerpt: draft.extracted_excerpt || '',
            status: 'publish',
          }).then(function (result) {
            publishUrl = result.url || result.link;
            db.prepare("UPDATE drafts SET status = 'published', published_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(id);
            logger.info('api', 'Draft ' + id + ' published to WordPress' + (publishUrl ? ': ' + publishUrl : ''));
            res.json({ success: true, url: publishUrl });
          }).catch(function (err) {
            logger.error('api', 'WP publish failed for draft ' + id + ': ' + err.message);
            res.status(500).json({ success: false, error: err.message });
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
      return res.status(500).json({ success: false, error: err.message });
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

  return router;
}

module.exports = createApiRouter;
