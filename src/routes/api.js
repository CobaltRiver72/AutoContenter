'use strict';

var express = require('express');
var { getConfig } = require('../utils/config');

// ── CSV helpers (used by inline import routes) ─────────────────────────────

function parseCsv(text) {
  var lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  var headers = splitCsvLine(lines[0]).map(function (h) { return h.trim().toLowerCase().replace(/^"|"$/g, ''); });
  var rows = [];
  for (var i = 1; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var values = splitCsvLine(line);
    var row = {};
    headers.forEach(function (h, idx) {
      row[h] = (values[idx] || '').trim().replace(/^"|"$/g, '');
    });
    rows.push(row);
  }
  return { headers: headers, rows: rows };
}

function splitCsvLine(line) {
  var result = [];
  var current = '';
  var inQuotes = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

function toDec(v) {
  if (v === null || v === undefined || v === '') return null;
  var n = parseFloat(v);
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}

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
  var { assertSafeUrl, safeAxiosOptions, sanitizeAxiosError } = require('../utils/safe-http');
  var { AiCostGuard } = require('../utils/ai-cost-guard');
  var configUtils = require('../utils/config');
  var aiGuard = new AiCostGuard({
    getLimit: function () {
      var v = parseInt(configUtils.get('MAX_AI_REWRITES_PER_HOUR'), 10);
      return (isNaN(v) || v <= 0) ? 60 : v;
    },
  });
  var { parseId, sanitizeForClient } = require('../utils/api-helpers');
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
      var { fuel, metals } = req.app.locals.modules || {};
      var sources = [firehose, trends, buffer, similarity, extractor, scheduler, infranodus, fuel, metals].filter(Boolean);
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

  // ─── POST /api/infranodus/cache-clear ────────────────────────────────────
  // Clears the in-memory 30-min analysis cache so the next enhanceArticle()
  // call makes a fresh API request instead of returning a stale cached result.

  router.post('/infranodus/cache-clear', function (req, res) {
    if (!infranodus || typeof infranodus._cache === 'undefined') {
      return res.status(503).json({ error: 'InfraNodus module not available' });
    }
    var size = infranodus._cache.size;
    infranodus._cache.clear();
    logger.info('api', 'InfraNodus analysis cache cleared (' + size + ' entries)');
    res.json({ success: true, clearedEntries: size });
  });

  // ─── POST /api/test/infranodus ────────────────────────────────────────────
  // Accepts an optional `apiKey` in body so users can validate a fresh key
  // before saving it. Falls back to the currently loaded infranodus module.

  router.post('/test/infranodus', async function (req, res) {
    var providedKey = (req.body && req.body.apiKey) ? String(req.body.apiKey).trim() : null;

    // If a key was supplied directly, test it without requiring the module to be enabled
    if (providedKey) {
      try {
        var testResponse = await axios.post(
          'https://infranodus.com/api/v1/graphAndStatements',
          { text: 'Test connection from HDF AutoPub', aiTopics: false },
          {
            headers: { 'Authorization': 'Bearer ' + providedKey, 'Content-Type': 'application/json' },
            params: { doNotSave: true, addStats: false, compactGraph: true },
            timeout: 15000,
          }
        );
        return res.json({ success: true, message: 'Connection successful — key is valid' });
      } catch (err) {
        var httpStatus = err.response ? err.response.status : 0;
        var msg = httpStatus === 401 ? 'Invalid API key (401 Unauthorized)' :
                  httpStatus === 403 ? 'Key has no access (403 Forbidden)' :
                  'Connection failed: ' + (err.message || String(err));
        return res.json({ success: false, message: msg });
      }
    }

    // No key supplied — use the in-memory module
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

  // ─── Manual cluster creation (batch article clustering) ──────────────────

  router.post('/clusters/manual', (req, res) => {
    const { articleIds, topic } = req.body;

    if (!articleIds || !Array.isArray(articleIds) || articleIds.length < 2) {
      return res.status(400).json({ error: 'Select at least 2 articles to create a cluster' });
    }
    if (articleIds.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 articles per manual cluster' });
    }

    const placeholders = articleIds.map(() => '?').join(',');
    const articles = db.prepare(
      `SELECT id, title, url, domain, cluster_id FROM articles WHERE id IN (${placeholders})`
    ).all(...articleIds);

    if (articles.length < 2) {
      return res.status(400).json({ error: 'Could not find enough valid articles' });
    }

    const alreadyClustered = articles.filter(a => a.cluster_id);
    if (alreadyClustered.length > 0) {
      return res.status(400).json({
        error: `${alreadyClustered.length} article(s) already belong to a cluster. Remove them first or pick different articles.`,
        clusteredIds: alreadyClustered.map(a => a.id)
      });
    }

    const safeTopic = (typeof topic === 'string' ? topic.trim().slice(0, 200) : '');
    const clusterTopic = safeTopic || (articles[0].title || '').slice(0, 120);
    const primaryArticleId = articleIds[0];

    const createCluster = db.transaction(() => {
      const clusterResult = db.prepare(`
        INSERT INTO clusters (topic, article_count, avg_similarity, primary_article_id,
                              trends_boosted, priority, status, detected_at)
        VALUES (?, ?, 1.0, ?, 0, 'high', 'queued', datetime('now', 'localtime'))
      `).run(clusterTopic, articles.length, primaryArticleId);

      const clusterId = clusterResult.lastInsertRowid;

      const updateArticle = db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?');
      for (const id of articleIds) {
        updateArticle.run(clusterId, id);
      }

      const insertDraft = db.prepare(`
        INSERT INTO drafts (source_article_id, source_url, source_domain, source_title,
                            cluster_id, cluster_role, mode, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'manual_import', 'fetching', datetime('now'), datetime('now'))
      `);

      for (let i = 0; i < articles.length; i++) {
        const a = articles[i];
        const role = (a.id === primaryArticleId) ? 'primary' : 'secondary';
        insertDraft.run(a.id, a.url, a.domain, a.title, clusterId, role);
      }

      return clusterId;
    });

    try {
      const clusterId = createCluster();
      res.json({
        success: true,
        clusterId,
        topic: clusterTopic,
        articleCount: articles.length,
        message: `Manual cluster created with ${articles.length} articles. Extraction will start automatically.`
      });
    } catch (err) {
      logger.error('api', 'POST /clusters/manual failed: ' + err.message);
      const safe = sanitizeForClient(err);
      res.status(safe.status).json({ error: safe.message });
    }
  });

  router.post('/clusters/manual-from-drafts', (req, res) => {
    const { draftIds, topic } = req.body;

    if (!draftIds || !Array.isArray(draftIds) || draftIds.length < 2) {
      return res.status(400).json({ error: 'Select at least 2 drafts' });
    }
    if (draftIds.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 drafts per manual cluster' });
    }

    const placeholders = draftIds.map(() => '?').join(',');
    const drafts = db.prepare(
      `SELECT id, source_url, source_domain, source_title, cluster_id, cluster_role,
              status, mode, extracted_content,
              (CASE WHEN locked_by IS NOT NULL AND lease_expires_at > datetime('now')
                    THEN 1 ELSE 0 END) AS is_locked
       FROM drafts WHERE id IN (${placeholders})`
    ).all(...draftIds);

    if (drafts.length < 2) {
      return res.status(400).json({ error: 'Not enough valid drafts found' });
    }

    const alreadyClustered = drafts.filter(d => d.cluster_id);
    if (alreadyClustered.length > 0) {
      return res.status(400).json({
        error: `${alreadyClustered.length} draft(s) already belong to a cluster. Remove them first.`,
        clusteredIds: alreadyClustered.map(d => d.id)
      });
    }

    // Refuse to merge drafts that are actively locked by a worker — the worker
    // would otherwise complete its rewrite against a draft that has moved into
    // a new cluster, wasting an AI call and producing stale data.
    const activelyLocked = drafts.filter(d => d.is_locked === 1);
    if (activelyLocked.length > 0) {
      return res.status(409).json({
        error: `${activelyLocked.length} draft(s) are currently being processed by a worker. Try again in a few minutes.`,
        lockedIds: activelyLocked.map(d => d.id)
      });
    }

    const safeTopic = (typeof topic === 'string' ? topic.trim().slice(0, 200) : '');
    const clusterTopic = safeTopic || 'Manual Cluster — ' + new Date().toISOString().slice(0, 10);

    const createCluster = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO clusters (topic, article_count, avg_similarity, primary_article_id,
                              trends_boosted, priority, status, detected_at)
        VALUES (?, ?, 1.0, NULL, 0, 'high', 'queued', datetime('now', 'localtime'))
      `).run(clusterTopic, drafts.length);

      const clusterId = result.lastInsertRowid;

      const updateDraft = db.prepare(`
        UPDATE drafts SET
          cluster_id = ?,
          cluster_role = ?,
          mode = 'manual_import',
          status = CASE
            WHEN extracted_content IS NOT NULL AND length(extracted_content) > 50
              THEN 'draft'
            ELSE 'fetching'
          END,
          rewritten_html = NULL,
          rewritten_title = NULL,
          rewritten_word_count = NULL,
          infranodus_data = NULL,
          error_message = NULL,
          locked_by = NULL,
          locked_at = NULL,
          lease_expires_at = NULL,
          updated_at = datetime('now')
        WHERE id = ?
      `);

      updateDraft.run(clusterId, 'primary', draftIds[0]);
      for (let i = 1; i < draftIds.length; i++) {
        updateDraft.run(clusterId, 'secondary', draftIds[i]);
      }

      return clusterId;
    });

    try {
      const clusterId = createCluster();
      res.json({
        success: true,
        clusterId,
        topic: clusterTopic,
        draftCount: drafts.length,
        primaryDraftId: draftIds[0],
        message: `Manual cluster created from ${drafts.length} drafts. ` +
          `Drafts with content reset to 'draft' status; drafts without content reset to 'fetching'. ` +
          `Pipeline will rewrite with multi-source context.`
      });
    } catch (err) {
      logger.error('api', 'POST /clusters/manual-from-drafts failed: ' + err.message);
      const safe = sanitizeForClient(err);
      res.status(safe.status).json({ error: safe.message });
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

  // ─── GET /api/sources/stats ───────────────────────────────────────────────
  // Per-domain article statistics for the Sources analytics page.

  router.get('/sources/stats', function (req, res) {
    try {
      // ── 1. Per-domain summary ──────────────────────────────────────────────
      var domainRows = db.prepare(`
        SELECT
          domain,
          COUNT(*)                                                AS total,
          SUM(CASE WHEN language = 'en' THEN 1 ELSE 0 END)       AS en_count,
          SUM(CASE WHEN language = 'hi' THEN 1 ELSE 0 END)       AS hi_count,
          SUM(CASE WHEN language NOT IN ('en','hi') AND language IS NOT NULL
                   THEN 1 ELSE 0 END)                            AS other_count,
          SUM(CASE WHEN language IS NULL THEN 1 ELSE 0 END)      AS unknown_count,
          SUM(CASE WHEN cluster_id IS NOT NULL THEN 1 ELSE 0 END) AS clustered_count,
          SUM(CASE WHEN trends_matched > 0 THEN 1 ELSE 0 END)    AS trending_count,
          MIN(authority_tier)                                     AS best_tier,
          MAX(received_at)                                        AS last_seen,
          MIN(received_at)                                        AS first_seen,
          GROUP_CONCAT(DISTINCT page_category)                   AS categories
        FROM articles
        GROUP BY domain
        ORDER BY total DESC
        LIMIT 100
      `).all();

      // ── 2. Draft conversion per domain ────────────────────────────────────
      var draftRows = db.prepare(`
        SELECT source_domain AS domain, COUNT(*) AS draft_count
        FROM drafts
        WHERE source_domain IS NOT NULL AND source_domain != ''
        GROUP BY source_domain
      `).all();
      var draftMap = {};
      draftRows.forEach(function(r) { draftMap[r.domain] = r.draft_count; });

      // ── 3. Articles per day per domain — last 7 days (top 10 domains only) ─
      var topDomains = domainRows.slice(0, 10).map(function(r) { return r.domain; });
      var sparklineRows = [];
      if (topDomains.length > 0) {
        var placeholders = topDomains.map(function() { return '?'; }).join(',');
        sparklineRows = db.prepare(`
          SELECT
            domain,
            DATE(received_at) AS day,
            COUNT(*)          AS count
          FROM articles
          WHERE received_at >= DATE('now', '-7 days')
            AND domain IN (` + placeholders + `)
          GROUP BY domain, day
          ORDER BY domain, day
        `).all(topDomains);
      }

      // ── 4. Language totals ────────────────────────────────────────────────
      var langTotals = db.prepare(`
        SELECT
          COALESCE(language, 'unknown') AS language,
          COUNT(*) AS count
        FROM articles
        GROUP BY language
        ORDER BY count DESC
      `).all();

      // ── 5. Category totals ────────────────────────────────────────────────
      var categoryTotals = db.prepare(`
        SELECT
          COALESCE(page_category, 'uncategorized') AS category,
          COUNT(*) AS count
        FROM articles
        GROUP BY page_category
        ORDER BY count DESC
        LIMIT 20
      `).all();

      // ── 6. Stale domains (no article in last 24h) ─────────────────────────
      var staleDomains = db.prepare(`
        SELECT domain, MAX(received_at) AS last_seen, COUNT(*) AS total
        FROM articles
        GROUP BY domain
        HAVING last_seen < datetime('now', '-24 hours')
        ORDER BY last_seen DESC
        LIMIT 20
      `).all();

      // ── 7. New domains today ──────────────────────────────────────────────
      var newToday = db.prepare(`
        SELECT domain, MIN(received_at) AS first_seen, COUNT(*) AS count
        FROM articles
        GROUP BY domain
        HAVING DATE(first_seen) = DATE('now')
        ORDER BY first_seen DESC
      `).all();

      // Attach draft counts to domain rows
      domainRows.forEach(function(r) {
        r.draft_count = draftMap[r.domain] || 0;
        r.draft_rate = r.total > 0 ? Math.round((r.draft_count / r.total) * 100) : 0;
        r.cluster_rate = r.total > 0 ? Math.round((r.clustered_count / r.total) * 100) : 0;
      });

      res.json({
        domains: domainRows,
        sparklines: sparklineRows,
        langTotals: langTotals,
        categoryTotals: categoryTotals,
        staleDomains: staleDomains,
        newToday: newToday,
        summary: {
          totalDomains: domainRows.length,
          totalArticles: domainRows.reduce(function(s, r) { return s + r.total; }, 0),
          staleDomainCount: staleDomains.length,
          newDomainCount: newToday.length,
        }
      });
    } catch (err) {
      logger.error('api', 'Failed to fetch sources stats', err.message);
      res.status(500).json({ error: 'Failed to fetch sources stats' });
    }
  });

  // ─── FUEL MODULE ROUTES ─────────────────────────────────────────────────

  router.get('/fuel/summary', function (req, res) {
    try {
      var fuel = req.app.locals.modules.fuel;
      if (!fuel) return res.status(503).json({ error: 'Fuel module not loaded' });
      res.json(fuel.getTodaySummary());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/fuel/cities', function (req, res) {
    try {
      var state = req.query.state || null;
      var sql = `
        SELECT fc.*, fp.petrol, fp.diesel, fp.price_date, fp.source
        FROM fuel_cities fc
        LEFT JOIN fuel_prices fp ON fc.city_name = fp.city AND fp.price_date = date('now')
        WHERE fc.is_enabled = 1
      `;
      var params = [];
      if (state) { sql += ' AND fc.state = ?'; params.push(state); }
      sql += ' ORDER BY fc.state, fc.city_name';
      var stmt = db.prepare(sql);
      res.json({ data: params.length ? stmt.all(params[0]) : stmt.all() });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/fuel/states', function (req, res) {
    try {
      var rows = db.prepare(`
        SELECT fc.state,
          COUNT(DISTINCT fc.city_name) as total_cities,
          COUNT(DISTINCT CASE WHEN fp.petrol > 0 THEN fc.city_name END) as fetched,
          ROUND(AVG(fp.petrol), 2) as avg_petrol,
          ROUND(AVG(fp.diesel), 2) as avg_diesel
        FROM fuel_cities fc
        LEFT JOIN fuel_prices fp ON fc.city_name = fp.city AND fp.price_date = date('now')
        WHERE fc.is_enabled = 1
        GROUP BY fc.state ORDER BY fc.state
      `).all();
      res.json({ data: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/fuel/history', function (req, res) {
    try {
      var city = req.query.city;
      var days = Math.min(parseInt(req.query.days) || 30, 365);
      if (!city) return res.status(400).json({ error: 'city required' });

      var fuel = req.app.locals.modules.fuel;
      var rows = fuel.getCityHistory(city, days);
      res.json({
        labels: rows.map(function(r) { return r.price_date; }),
        petrol: rows.map(function(r) { return r.petrol; }),
        diesel: rows.map(function(r) { return r.diesel; }),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/fuel/fetch', async function (req, res) {
    try {
      var fuel = req.app.locals.modules.fuel;
      if (!fuel) return res.status(503).json({ error: 'Fuel module not loaded' });

      var result = await fuel.runDailyFetch(true);
      if (result.skipped) {
        return res.json({ success: false, error: 'No FUEL_RAPIDAPI_KEY set. Add it in Settings first.' });
      }
      res.json({
        success: true,
        message: 'Fetch completed: ' + result.ok + ' OK, ' + result.fail + ' failed out of ' + result.total,
        result: result,
      });
    } catch (err) {
      logger.error('api', 'Fuel fetch failed: ' + err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/fuel/compare', function (req, res) {
    try {
      var state = req.query.state;
      if (!state) return res.status(400).json({ error: 'state required' });
      var fuel = req.app.locals.modules.fuel;
      var rows = fuel.getStateCitiesToday(state);
      res.json({ data: rows.slice(0, 10) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ─── METALS MODULE ROUTES ───────────────────────────────────────────────

  router.get('/metals/summary', function (req, res) {
    try {
      var metals = req.app.locals.modules.metals;
      if (!metals) return res.status(503).json({ error: 'Metals module not loaded' });
      res.json(metals.getTodaySummary());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/metals/cities', function (req, res) {
    try {
      var metal = req.query.metal || 'gold';
      var state = req.query.state || null;
      var sql = `
        SELECT mc.city_name, mc.state, mc.is_active,
               mp.price_24k, mp.price_22k, mp.price_18k,
               mp.price_1g, mp.price_date, mp.source
        FROM metals_cities mc
        LEFT JOIN metals_prices mp ON mc.city_name = mp.city
          AND mp.metal_type = ? AND mp.price_date = date('now')
        WHERE mc.is_active = 1
      `;
      var params = [metal];
      if (state) { sql += ' AND mc.state = ?'; params.push(state); }
      sql += ' ORDER BY mc.state, mc.city_name';
      var stmt = db.prepare(sql); res.json({ data: stmt.all.apply(stmt, params) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.get('/metals/history', function (req, res) {
    try {
      var city = req.query.city;
      var metal = req.query.metal || 'gold';
      var days = Math.min(parseInt(req.query.days) || 30, 365);
      if (!city) return res.status(400).json({ error: 'city required' });

      var metals = req.app.locals.modules.metals;
      var rows = metals.getCityHistory(city, metal, days);
      res.json({
        city: city, metal: metal,
        labels: rows.map(function(r) { return r.price_date; }),
        price_24k: rows.map(function(r) { return r.price_24k; }),
        price_22k: rows.map(function(r) { return r.price_22k; }),
        price_18k: rows.map(function(r) { return r.price_18k; }),
        price_1g: rows.map(function(r) { return r.price_1g; }),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/metals/fetch', async function (req, res) {
    try {
      var metals = req.app.locals.modules.metals;
      if (!metals) return res.status(503).json({ error: 'Metals module not loaded' });

      var result = await metals.runDailyFetch(true);
      if (result.skipped) {
        return res.json({ success: false, error: 'No METALS_RAPIDAPI_KEY set. Add it in Settings first.' });
      }
      res.json({
        success: true,
        message: 'Metals fetch completed: ' + JSON.stringify(result),
        result: result,
      });
    } catch (err) {
      logger.error('api', 'Metals fetch failed: ' + err.message);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── GET /api/fuel/ping-api — Test RapidAPI key for fuel ─────────────────

  router.get('/fuel/ping-api', async function (req, res) {
    var apiKey = req.query.key || null;
    if (!apiKey) {
      var row = db.prepare("SELECT value FROM settings WHERE key = 'FUEL_RAPIDAPI_KEY'").get();
      apiKey = row ? row.value : null;
    }
    if (!apiKey) return res.json({ ok: false, error: 'FUEL_RAPIDAPI_KEY not set — type a key above and Ping, or save it first' });

    var host = 'fuel-petrol-diesel-live-price-india.p.rapidapi.com';
    try {
      var r = await fetch('https://' + host + '/petrol_price_india_city_value/', {
        headers: {
          'x-rapidapi-host': host,
          'x-rapidapi-key': apiKey,
          'Content-Type': 'application/json',
          'city': 'delhi',
        },
      });
      if (r.ok || r.status === 200) {
        return res.json({ ok: true, status: r.status, message: 'RapidAPI key is valid' });
      }
      var body = await r.text().catch(function() { return ''; });
      res.json({ ok: false, status: r.status, error: 'API returned ' + r.status + (body ? ': ' + body.slice(0, 200) : '') });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ─── GET /api/metals/ping-api — Test RapidAPI key for metals ─────────────

  router.get('/metals/ping-api', async function (req, res) {
    var apiKey = req.query.key || null;
    if (!apiKey) {
      var row = db.prepare("SELECT value FROM settings WHERE key = 'METALS_RAPIDAPI_KEY'").get();
      apiKey = row ? row.value : null;
    }
    if (!apiKey) return res.json({ ok: false, error: 'METALS_RAPIDAPI_KEY not set — type a key above and Ping, or save it first' });

    var host = 'gold-silver-platinum-price-in-india.p.rapidapi.com';
    try {
      var r = await fetch('https://' + host + '/GoldPriceTodayForCities', {
        headers: { 'x-rapidapi-host': host, 'x-rapidapi-key': apiKey },
      });
      if (r.ok || r.status === 200) {
        return res.json({ ok: true, status: r.status, message: 'RapidAPI key is valid' });
      }
      var body = await r.text().catch(function() { return ''; });
      res.json({ ok: false, status: r.status, error: 'API returned ' + r.status + (body ? ': ' + body.slice(0, 200) : '') });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // ─── PER-CITY FETCH ──────────────────────────────────────────────────────

  router.post('/fuel/fetch-city', async function (req, res) {
    try {
      var fuel = req.app.locals.modules.fuel;
      if (!fuel) return res.status(503).json({ error: 'Fuel module not loaded' });

      var cityName = req.body && req.body.city_name;
      if (!cityName) return res.status(400).json({ error: 'city_name required' });

      var apiKey = fuel._getApiKey();
      if (!apiKey) return res.json({ success: false, error: 'No FUEL_RAPIDAPI_KEY set' });

      var cityRow = fuel.db.prepare(
        'SELECT * FROM fuel_cities WHERE city_name = ? AND is_enabled = 1'
      ).get(cityName);
      if (!cityRow) return res.json({ success: false, error: 'City not found or disabled: ' + cityName });
      if (!cityRow.api3_city) return res.json({ success: false, error: cityName + ' has no API mapping (api3_city is null)' });

      await fuel.fetchCityPrice(cityRow, apiKey);

      var price = fuel.db.prepare(
        "SELECT * FROM fuel_prices WHERE city = ? AND price_date = date('now') ORDER BY id DESC LIMIT 1"
      ).get(cityName);

      res.json({ success: true, message: 'Fetched ' + cityName, price: price || null });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  router.post('/metals/fetch-city', async function (req, res) {
    try {
      var metals = req.app.locals.modules.metals;
      if (!metals) return res.status(503).json({ error: 'Metals module not loaded' });

      var cityName = req.body && req.body.city_name;
      if (!cityName) return res.status(400).json({ error: 'city_name required' });

      var apiKey = metals._getApiKey();
      if (!apiKey) return res.json({ success: false, error: 'No METALS_RAPIDAPI_KEY set' });

      // Metals API is bulk — fetch all then filter
      var metalTypes = (req.body.metal) ? [req.body.metal] : ['gold', 'silver', 'platinum'];
      var results = {};
      for (var m of metalTypes) {
        try {
          var count = await metals.fetchBulk(m, apiKey);
          results[m] = count;
        } catch (e) {
          results[m] = { error: e.message };
        }
      }

      var prices = metals.db.prepare(
        "SELECT * FROM metals_prices WHERE city = ? AND price_date = date('now')"
      ).all(cityName);

      res.json({ success: true, message: 'Fetched metals for ' + cityName, results: results, prices: prices });
    } catch (err) {
      res.json({ success: false, error: err.message });
    }
  });

  // ─── TEST FETCH (5 cities / 1 metal) ───────────────────────────────────

  router.post('/fuel/fetch-test', async function (req, res) {
    try {
      var fuel = req.app.locals.modules.fuel;
      if (!fuel) return res.status(503).json({ error: 'Fuel module not loaded' });

      var apiKey = fuel._getApiKey();
      if (!apiKey) return res.json({ success: false, error: 'No FUEL_RAPIDAPI_KEY set. Add it in Settings first.' });

      var cities = fuel.db.prepare(
        'SELECT * FROM fuel_cities WHERE is_enabled = 1 AND api3_city IS NOT NULL LIMIT 5'
      ).all();

      var results = [];
      for (var city of cities) {
        try {
          await fuel.fetchCityPrice(city, apiKey);
          var price = fuel.db.prepare(
            "SELECT petrol, diesel FROM fuel_prices WHERE city = ? AND price_date = date('now')"
          ).get(city.city_name);
          results.push({ city: city.city_name, ok: true, petrol: price ? price.petrol : null, diesel: price ? price.diesel : null });
        } catch (e) {
          results.push({ city: city.city_name, ok: false, error: e.message });
        }
      }

      fuel.stats.lastFetchAt = new Date().toISOString();
      res.json({ success: true, results: results });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/metals/fetch-test', async function (req, res) {
    try {
      var metals = req.app.locals.modules.metals;
      if (!metals) return res.status(503).json({ error: 'Metals module not loaded' });

      var apiKey = metals._getApiKey();
      if (!apiKey) return res.json({ success: false, error: 'No METALS_RAPIDAPI_KEY set. Add it in Settings first.' });

      var count = await metals.fetchBulk('gold', apiKey);
      metals.stats.lastFetchAt = new Date().toISOString();

      var sample = metals.db.prepare(
        "SELECT city, price_24k, price_22k FROM metals_prices WHERE metal_type = 'gold' AND price_date = date('now') LIMIT 5"
      ).all();

      res.json({ success: true, message: count + ' gold prices fetched', sample: sample });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // ─── DIAGNOSTICS ────────────────────────────────────────────────────────

  router.get('/diagnostics', function (req, res) {
    var checks = [];

    // Cities seeded
    var fuelCities = db.prepare('SELECT COUNT(*) AS c FROM fuel_cities').get().c;
    checks.push({ name: 'Fuel Cities Seeded', ok: fuelCities > 0, detail: fuelCities + ' cities' });

    var fuelApi3 = db.prepare('SELECT COUNT(*) AS c FROM fuel_cities WHERE api3_city IS NOT NULL').get().c;
    checks.push({ name: 'Fuel Cities with API Mapping', ok: fuelApi3 > 0, detail: fuelApi3 + ' of ' + fuelCities + ' have api3_city' });

    var metalsCities = db.prepare('SELECT COUNT(*) AS c FROM metals_cities').get().c;
    checks.push({ name: 'Metals Cities Seeded', ok: metalsCities > 0, detail: metalsCities + ' cities' });

    // Prices today
    var fuelToday = db.prepare("SELECT COUNT(*) AS c FROM fuel_prices WHERE price_date = date('now')").get().c;
    checks.push({ name: 'Fuel Prices Today', ok: fuelToday > 0, detail: fuelToday + ' rows' });

    var metalsToday = db.prepare("SELECT COUNT(*) AS c FROM metals_prices WHERE price_date = date('now')").get().c;
    checks.push({ name: 'Metals Prices Today', ok: metalsToday > 0, detail: metalsToday + ' rows' });

    // Fuel API key — check both DB settings and env var fallback
    var fuelKeyDb = db.prepare("SELECT value FROM settings WHERE key = 'FUEL_RAPIDAPI_KEY'").get();
    var fuelKeyEnv = process.env.FUEL_RAPIDAPI_KEY;
    var fuelKeyVal = (fuelKeyDb && fuelKeyDb.value) || fuelKeyEnv || '';
    checks.push({
      name: 'Fuel API Key',
      ok: !!fuelKeyVal,
      detail: fuelKeyDb && fuelKeyDb.value
        ? 'settings (' + fuelKeyDb.value.length + ' chars)'
        : fuelKeyEnv ? 'env var (' + fuelKeyEnv.length + ' chars)' : 'NOT SET'
    });

    // Metals API key — same pattern
    var metalsKeyDb = db.prepare("SELECT value FROM settings WHERE key = 'METALS_RAPIDAPI_KEY'").get();
    var metalsKeyEnv = process.env.METALS_RAPIDAPI_KEY;
    var metalsKeyVal = (metalsKeyDb && metalsKeyDb.value) || metalsKeyEnv || '';
    checks.push({
      name: 'Metals API Key',
      ok: !!metalsKeyVal,
      detail: metalsKeyDb && metalsKeyDb.value
        ? 'settings (' + metalsKeyDb.value.length + ' chars)'
        : metalsKeyEnv ? 'env var (' + metalsKeyEnv.length + ' chars)' : 'NOT SET'
    });

    // WP credentials — check config (merges DB + env, aliases WP_URL ↔ WP_SITE_URL)
    var diagConfig = getConfig();
    var wpUrlVal = diagConfig.WP_SITE_URL || diagConfig.WP_URL || '';
    var wpUserVal = diagConfig.WP_USERNAME || '';
    var wpPassVal = diagConfig.WP_APP_PASSWORD || '';
    checks.push({ name: 'WP Credentials', ok: !!(wpUrlVal && wpUserVal && wpPassVal), detail: wpUrlVal || 'NOT SET (need WP_SITE_URL or WP_URL)' });

    // Last fetch
    var lastFetch = db.prepare('SELECT * FROM fetch_log ORDER BY created_at DESC LIMIT 1').get();
    checks.push({ name: 'Last Fetch', ok: !!lastFetch, detail: lastFetch ? lastFetch.module + ' ' + lastFetch.fetch_type + ' at ' + lastFetch.created_at + ' (' + lastFetch.cities_ok + ' ok, ' + lastFetch.cities_fail + ' fail)' : 'Never fetched' });

    // Module status
    var fuel = req.app.locals.modules.fuel;
    checks.push({ name: 'Fuel Module', ok: !!(fuel && fuel.status === 'ready'), detail: fuel ? (fuel.status || 'unknown') : 'Not loaded' });

    var metals = req.app.locals.modules.metals;
    checks.push({ name: 'Metals Module', ok: !!(metals && metals.status === 'ready'), detail: metals ? (metals.status || 'unknown') : 'Not loaded' });

    var allOk = checks.every(function(c) { return c.ok; });
    res.json({ ok: allOk, checks: checks });
  });

  // ─── POST GENERATION + WP ROUTES ───────────────────────────────────────

  router.post('/fuel/generate-posts', function (req, res) {
    try {
      var fuelPosts = req.app.locals.modules.fuelPosts;
      if (!fuelPosts) return res.status(503).json({ error: 'Fuel post creator not loaded' });
      var fuelType = (req.body && req.body.fuelType) || 'both';
      var results = {};

      var chain = Promise.resolve();
      if (fuelType === 'petrol' || fuelType === 'both') {
        chain = chain.then(function() {
          return fuelPosts.runPostGeneration('petrol').then(function(r) { results.petrol = r; });
        });
      }
      if (fuelType === 'diesel' || fuelType === 'both') {
        chain = chain.then(function() {
          return fuelPosts.runPostGeneration('diesel').then(function(r) { results.diesel = r; });
        });
      }

      chain.then(function() {
        logger.info('api', 'Fuel post generation complete: ' + JSON.stringify(results));
      }).catch(function(err) {
        logger.error('api', 'Fuel post generation failed: ' + err.message);
      });

      res.json({ ok: true, message: 'Post generation started in background' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/metals/generate-posts', function (req, res) {
    try {
      var metalsPosts = req.app.locals.modules.metalsPosts;
      if (!metalsPosts) return res.status(503).json({ error: 'Metals post creator not loaded' });
      var metalType = (req.body && req.body.metalType) || 'all';
      var results = {};
      var types = metalType === 'all' ? ['gold', 'silver', 'platinum'] : [metalType];

      var chain = Promise.resolve();
      types.forEach(function(mt) {
        chain = chain.then(function() {
          return metalsPosts.runPostGeneration(mt).then(function(r) { results[mt] = r; });
        });
      });

      chain.then(function() {
        logger.info('api', 'Metals post generation complete: ' + JSON.stringify(results));
      }).catch(function(err) {
        logger.error('api', 'Metals post generation failed: ' + err.message);
      });

      res.json({ ok: true, message: 'Post generation started in background' });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/wp/test', function (req, res) {
    try {
      var wpPub = req.app.locals.modules.wpPublisher;
      if (!wpPub) return res.json({ ok: false, error: 'WP Publisher not loaded' });
      wpPub.testConnection().then(function(result) {
        res.json(result);
      }).catch(function(err) {
        res.json({ ok: false, error: err.message });
      });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  router.get('/wp/health', function (req, res) {
    try {
      var wpPub = req.app.locals.modules.wpPublisher;
      if (!wpPub) return res.json({ module: 'wp-publisher', status: 'not loaded', ready: false });
      res.json(wpPub.getHealth());
    } catch (err) {
      res.status(500).json({ error: err.message });
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
        'INFRANODUS_API_KEY', 'SESSION_SECRET',
        'FUEL_RAPIDAPI_KEY', 'METALS_RAPIDAPI_KEY'
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
        'FUEL_RAPIDAPI_KEY', 'METALS_RAPIDAPI_KEY',
        'WP_SITE_URL',
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
      var wpKeys = ['WP_URL', 'WP_USERNAME', 'WP_APP_PASSWORD', 'WP_POST_STATUS', 'WP_AUTHOR_ID', 'WP_DEFAULT_CATEGORY', 'WP_SITE_URL'];
      var hasWpChange = validEntries.some(function (e) { return wpKeys.indexOf(e[0]) !== -1; });
      if (hasWpChange && publisher && typeof publisher.reinit === 'function') {
        publisher.reinit();
        logger.info('api', 'Publisher re-initialized after WP settings change');
      }
      // Also re-init the fuel/metals WP publisher
      if (hasWpChange) {
        var wpPub = req.app.locals.modules.wpPublisher;
        if (wpPub && typeof wpPub.init === 'function') {
          wpPub.init().catch(function(e) { logger.warn('api', 'wpPublisher re-init failed: ' + e.message); });
        }
      }

      // Re-initialize InfraNodus if its API key or enabled flag changed.
      // infranodus.config is a frozen snapshot from boot; we must replace it
      // with the fresh config BEFORE calling init() so it reads the new key.
      var infraSettingKeys = ['INFRANODUS_API_KEY', 'INFRANODUS_ENABLED'];
      var hasInfraChange = validEntries.some(function (e) { return infraSettingKeys.indexOf(e[0]) !== -1; });
      if (hasInfraChange && infranodus && typeof infranodus.init === 'function') {
        infranodus.config = configUtils.getConfig();
        infranodus.init().catch(function (e) { logger.warn('api', 'InfraNodus re-init failed: ' + e.message); });
        logger.info('api', 'InfraNodus re-initialized after settings change');
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

  router.post('/ai/validate-rewrite', async function (req, res) {
    try {
      var body = req.body || {};
      if (!body.provider || !body.apiKey) {
        return res.status(400).json({ success: false, error: 'Provider and API key required' });
      }
      var result = await rewriter.validateRewriteCapability(body.provider, body.apiKey, body.model);
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

    try {
      assertSafeUrl(wpUrl);
    } catch (safeErr) {
      return res.status(400).json({ success: false, error: 'WordPress URL rejected: ' + safeErr.message });
    }

    var authHeader = 'Basic ' + Buffer.from(
      config.WP_USERNAME + ':' + config.WP_APP_PASSWORD
    ).toString('base64');

    // Use ?rest_route= format (works on Cloudways without Nginx rewrite)
    var restRouteUrl = wpUrl + '/?rest_route=' + encodeURIComponent('/wp/v2/users/me');

    logger.info('api', 'Testing WP connection: ' + restRouteUrl);

    axios.get(restRouteUrl, safeAxiosOptions({
      headers: { 'Authorization': authHeader },
      timeout: 15000,
    }))
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
        var safeWp = sanitizeAxiosError(err);
        var statusCode = safeWp.status;
        var wpMsg = safeWp.data || safeWp.message;
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

    try {
      assertSafeUrl(wpUrl);
    } catch (safeErr) {
      return res.status(400).json({ success: false, error: 'WordPress URL rejected: ' + safeErr.message });
    }

    var authHeader = 'Basic ' + Buffer.from(
      config.WP_USERNAME + ':' + config.WP_APP_PASSWORD
    ).toString('base64');

    result.checks.credentials = { ok: true, message: 'All credentials present' };

    // Test REST API discovery using ?rest_route= (works on Cloudways)
    var restRouteBase = wpUrl + '/?rest_route=';

    axios.get(restRouteBase + encodeURIComponent('/'), safeAxiosOptions({
      headers: { 'Authorization': authHeader },
      timeout: 15000,
    })).then(function (apiRes) {
      result.checks.restApi = { ok: true, message: 'REST API reachable via ?rest_route=', siteName: apiRes.data.name || '' };

      // Test auth by fetching current user
      return axios.get(restRouteBase + encodeURIComponent('/wp/v2/users/me'), safeAxiosOptions({
        headers: { 'Authorization': authHeader },
        timeout: 10000,
      }));
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
      var safeWp2 = sanitizeAxiosError(err);
      var statusCode = safeWp2.status;
      var wpMsg = safeWp2.data || safeWp2.message || '';
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
      var safe = sanitizeAxiosError(err);
      var msg = safe.status ? 'API error ' + safe.status + ': ' + (safe.data || safe.message) : safe.message;
      logger.error('api', 'Failed to fetch firehose rules', msg);
      res.status(safe.status || 500).json({ error: msg });
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
      var safe = sanitizeAxiosError(err);
      var msg = safe.status ? 'API error ' + safe.status + ': ' + (safe.data || safe.message) : safe.message;
      logger.error('api', 'Failed to create firehose rule', msg);
      res.status(safe.status || 500).json({ error: msg });
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
      var safe = sanitizeAxiosError(err);
      var msg = safe.status ? 'API error ' + safe.status + ': ' + (safe.data || safe.message) : safe.message;
      logger.error('api', 'Failed to update firehose rule', msg);
      res.status(safe.status || 500).json({ error: msg });
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
      var safe = sanitizeAxiosError(err);
      var msg = safe.status ? 'API error ' + safe.status + ': ' + (safe.data || safe.message) : safe.message;
      logger.error('api', 'Failed to delete firehose rule', msg);
      res.status(safe.status || 500).json({ error: msg });
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
              var safe = sanitizeAxiosError(err);
              var msg = safe.status ? 'API error ' + safe.status + ': ' + (safe.data || safe.message) : safe.message;
              logger.error('api', 'Failed to create tap', msg);
              res.status(500).json({ error: 'Failed to create tap: ' + msg });
            });
          }
        })
        .catch(function (err) {
          var safe = sanitizeAxiosError(err);
          var msg = safe.status ? 'API error ' + safe.status + ': ' + (safe.data || safe.message) : safe.message;
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

      // Explicit column list: large text blobs (rewritten_html, extracted_content,
      // source_content_markdown, body_markdown, faq_json, ai_signals, infranodus_data)
      // are excluded or truncated to keep the listing payload small and avoid
      // ERR_HTTP2_PROTOCOL_ERROR on connections with many drafts.
      //   extracted_chars  — exact byte length before truncation (for UI display)
      //   extracted_content  — first 1200 chars (enough for 800-char card preview)
      //   rewritten_html  — stub '1'/NULL so JS truthiness checks still work;
      //                      full HTML is fetched per-draft in the editor
      var query = `SELECT
        id, source_article_id, source_url, source_domain, source_title,
        source_language, source_category, source_publish_time,
        COALESCE(LENGTH(extracted_content), 0) AS extracted_chars,
        SUBSTR(extracted_content, 1, 1200) AS extracted_content,
        SUBSTR(source_content_markdown, 1, 1200) AS source_content_markdown,
        extracted_title, extracted_excerpt, extracted_byline,
        extraction_status, extraction_error, extraction_method,
        target_keyword, target_domain, target_platform, target_language,
        schema_types, featured_image,
        CASE WHEN rewritten_html IS NOT NULL AND LENGTH(rewritten_html) > 0
             THEN '1' ELSE NULL END AS rewritten_html,
        rewritten_title, rewritten_word_count, ai_model_used,
        status, mode, created_at, updated_at, published_at,
        current_version, is_partial, ai_provider, ai_tokens_used,
        wp_media_id, wp_post_id, wp_post_url,
        retry_count, max_retries, error_message, last_error_at, failed_permanent,
        cluster_id, cluster_role,
        locked_by, locked_at, lease_expires_at, next_run_at
      FROM drafts`;
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
      var pp = parsePageParam(req, 20);
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
    var slot = aiGuard.acquire('publish-all-ready', 0); // cost: 0 — not an AI spend
    if (!slot.ok) {
      return res.status(429).json({ success: false, error: slot.detail, reason: slot.reason });
    }
    try {
      var publisherMod = deps.publisher || (deps.scheduler && deps.scheduler.publisher);
      if (publisherMod && !publisherMod.enabled && typeof publisherMod.reinit === 'function') {
        publisherMod.reinit();
      }
      if (!publisherMod || !publisherMod.enabled) {
        aiGuard.release('publish-all-ready');
        return res.status(400).json({ success: false, error: 'WordPress publisher not configured. Set WP credentials in Settings.' });
      }

      var readyDrafts = db.prepare(
        "SELECT id FROM drafts WHERE status = 'ready' AND cluster_role = 'primary' " +
        "AND rewritten_html IS NOT NULL AND LENGTH(rewritten_html) > 100"
      ).all();

      if (readyDrafts.length === 0) {
        aiGuard.release('publish-all-ready');
        return res.json({ success: true, queued: 0, message: 'No ready articles found' });
      }

      // Respond immediately; the background loop owns the lock until it finishes.
      res.json({ success: true, queued: readyDrafts.length, message: 'Publishing ' + readyDrafts.length + ' drafts' });

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
      })().catch(function (bgErr) {
        logger.error('api', 'publish-all-ready background loop failed: ' + bgErr.message);
      }).finally(function () {
        aiGuard.release('publish-all-ready');
      });
    } catch (err) {
      aiGuard.release('publish-all-ready');
      logger.error('api', 'publish-all-ready failed: ' + sanitizeAxiosError(err).message);
      res.status(500).json({ success: false, error: sanitizeForClient(err, 'publish-all-ready failed') });
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

  // ─── InfraNodus entity analysis (per draft) ──────────────────────────────

  router.get('/drafts/:id/infranodus', (req, res) => {
    const draft = db.prepare('SELECT id, infranodus_data, ai_model_used FROM drafts WHERE id = ?')
      .get(req.params.id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });

    let infraData = null;
    try {
      infraData = draft.infranodus_data ? JSON.parse(draft.infranodus_data) : null;
    } catch (e) {
      infraData = null;
    }

    res.json({
      draftId: draft.id,
      aiModel: draft.ai_model_used,
      infraData,
      hasInfraData: !!infraData
    });
  });

  router.post('/drafts/:id/analyze', async function (req, res) {
    var id = parseId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid draft id' });

    var draft = db.prepare('SELECT id, extracted_content, rewritten_html FROM drafts WHERE id = ?')
      .get(id);
    if (!draft) return res.status(404).json({ error: 'Draft not found' });

    var text = draft.extracted_content || draft.rewritten_html || '';
    if (!text) return res.status(400).json({ error: 'No content to analyze' });

    if (!infranodus || !infranodus.enabled) {
      return res.status(400).json({ error: 'InfraNodus is not enabled. Set INFRANODUS_ENABLED=true and add your API key in Settings.' });
    }

    try {
      // Pass full text — enhanceArticle internally truncates to TEXT_LIMIT (12 000 chars)
      var infraData = await infranodus.enhanceArticle(text);
      if (!infraData) {
        return res.status(502).json({ error: 'InfraNodus returned no data. Check your API key and that the article has enough content (200+ chars).' });
      }
      db.prepare('UPDATE drafts SET infranodus_data = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(JSON.stringify(infraData), id);
      res.json({ success: true, infraData });
    } catch (err) {
      logger.error('api', 'POST /drafts/:id/analyze failed: ' + err.message);
      var safe = sanitizeForClient(err);
      res.status(safe.status).json({ error: safe.message });
    }
  });

  // ─── POST /api/drafts/batch-fetch-images ──────────────────────────────
  //
  // Fetches featured images for all extracted articles that are missing images.
  // Runs async — returns immediately, processes in background.
  //
  router.post('/drafts/batch-fetch-images', function (req, res) {
    var slot = aiGuard.acquire('batch-fetch-images', 0); // cost: 0 — not an AI spend
    if (!slot.ok) {
      return res.status(429).json({ success: false, error: slot.detail, reason: slot.reason });
    }
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
        aiGuard.release('batch-fetch-images');
        return res.json({ success: true, message: 'All articles already have images', count: 0 });
      }

      logger.info('api', 'Batch image fetch: starting for ' + missingImages.length + ' articles');

      res.json({
        success: true,
        message: 'Image fetch started for ' + missingImages.length + ' articles (processing in background)',
        count: missingImages.length
      });

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
      })().catch(function (bgErr) {
        logger.error('api', 'Batch image fetch error: ' + bgErr.message);
      }).finally(function () {
        aiGuard.release('batch-fetch-images');
      });
    } catch (err) {
      aiGuard.release('batch-fetch-images');
      logger.error('api', 'Batch image fetch start error: ' + sanitizeAxiosError(err).message);
      res.status(500).json({ success: false, error: sanitizeForClient(err, 'batch-fetch-images failed') });
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
        "SELECT COUNT(*) as cnt FROM drafts WHERE extraction_status = 'failed' " +
        "AND status != 'published' " +
        "AND (rewritten_html IS NULL OR LENGTH(rewritten_html) < 100)"
      ).get().cnt;

      if (failedCount === 0) {
        return res.json({ success: true, message: 'No failed drafts to delete', deletedCount: 0 });
      }

      var deleteResult = db.transaction(function () {
        db.prepare(
          "UPDATE drafts SET locked_by = NULL WHERE extraction_status = 'failed' AND locked_by IS NOT NULL"
        ).run();

        var result = db.prepare(
          "DELETE FROM drafts WHERE extraction_status = 'failed' " +
          "AND status != 'published' " +
          "AND (rewritten_html IS NULL OR LENGTH(rewritten_html) < 100)"
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
      // Clear infranodus_data so the panel doesn't show stale analysis for new content
      db.prepare("UPDATE drafts SET extraction_status = 'pending', status = 'fetching', infranodus_data = NULL, updated_at = datetime('now') WHERE id = ?").run(id);

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
    var slot = aiGuard.acquire('batch-rewrite');
    if (!slot.ok) {
      return res.status(429).json({ success: false, error: slot.detail, reason: slot.reason });
    }
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
      logger.error('api', 'Batch rewrite failed: ' + sanitizeAxiosError(err).message);
      res.status(500).json({ success: false, error: sanitizeForClient(err, 'Batch rewrite failed') });
    } finally {
      aiGuard.release('batch-rewrite');
    }
  });

  // ─── POST /api/clusters/:clusterId/rewrite ──────────────────────────────
  //
  // Triggers AI rewrite for a SINGLE cluster.
  //
  router.post('/clusters/:clusterId/rewrite', async function (req, res) {
    var clusterId = parseId(req.params.clusterId);
    if (!clusterId) return res.status(400).json({ success: false, error: 'Invalid cluster id' });

    var lockName = 'cluster-rewrite:' + clusterId;
    var slot = aiGuard.acquire(lockName);
    if (!slot.ok) {
      return res.status(429).json({ success: false, error: slot.detail, reason: slot.reason });
    }
    try {
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
      logger.error('api', 'Cluster rewrite failed: ' + sanitizeAxiosError(err).message);
      res.status(500).json({ success: false, error: sanitizeForClient(err, 'Cluster rewrite failed') });
    } finally {
      aiGuard.release(lockName);
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
            var safeWp3 = sanitizeAxiosError(err);
            var statusCode = safeWp3.status;
            var wpError = safeWp3.data || '';
            var detail = safeWp3.message || 'Unknown error';
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
      var safe = sanitizeAxiosError(err);
      var msg = safe.status ? 'API error ' + safe.status + ': ' + (safe.data || safe.message) : safe.message;
      res.status(safe.status || 500).json({ error: msg });
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

  // ─── GET /api/posts/list ──────────────────────────────────────────────────

  router.get('/posts/list', function (req, res) {
    try {
      var module = req.query.module || null;
      var itemType = req.query.item_type || null;
      var postType = req.query.post_type || null;
      var action = req.query.action || null;
      var search = req.query.search || null;
      var page = Math.max(1, parseInt(req.query.page) || 1);
      var limit = Math.min(parseInt(req.query.limit) || 50, 200);
      var offset = (page - 1) * limit;

      var conditions = [];
      var params = [];
      if (module) { conditions.push('module = ?'); params.push(module); }
      if (itemType) { conditions.push('item_type = ?'); params.push(itemType); }
      if (postType) { conditions.push('post_type = ?'); params.push(postType); }
      if (action) { conditions.push('action = ?'); params.push(action); }
      if (search) { conditions.push('item_name LIKE ?'); params.push('%' + search + '%'); }

      var where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';
      var total = db.prepare('SELECT COUNT(*) as c FROM wp_posts_log ' + where).get(params).c;
      var data = db.prepare('SELECT * FROM wp_posts_log ' + where + ' ORDER BY created_at DESC LIMIT ? OFFSET ?')
        .all(params.concat([limit, offset]));

      res.json({ ok: true, data: data, total: total, page: page, pages: Math.ceil(total / limit) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── GET /api/posts/stats ─────────────────────────────────────────────────

  router.get('/posts/stats', function (req, res) {
    try {
      var today = new Date().toISOString().slice(0, 10);
      var stat = function (mod) {
        var r = db.prepare(`
          SELECT
            COUNT(*) as total,
            SUM(CASE WHEN post_type='city' THEN 1 ELSE 0 END) as cities,
            SUM(CASE WHEN post_type='state' THEN 1 ELSE 0 END) as states,
            SUM(CASE WHEN post_type='national' THEN 1 ELSE 0 END) as national,
            SUM(CASE WHEN action='failed' THEN 1 ELSE 0 END) as failed,
            SUM(CASE WHEN DATE(created_at)=? THEN 1 ELSE 0 END) as updated_today
          FROM wp_posts_log WHERE module=?
        `).get(today, mod);
        return r || { total: 0, cities: 0, states: 0, national: 0, failed: 0, updated_today: 0 };
      };
      res.json({ ok: true, fuel: stat('fuel'), metals: stat('metals') });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── POST /api/posts/regenerate ───────────────────────────────────────────

  router.post('/posts/regenerate', async function (req, res) {
    try {
      var body = req.body || {};
      var mod = body.module;
      var itemType = body.item_type;
      var postType = body.post_type;
      var itemName = body.item_name;

      if (!mod || !itemType || !postType || !itemName) {
        return res.status(400).json({ ok: false, error: 'module, item_type, post_type, item_name required' });
      }

      var fuelPosts = req.app.locals.modules.fuelPosts;
      var metalsPosts = req.app.locals.modules.metalsPosts;

      if (mod === 'fuel') {
        if (!fuelPosts) return res.status(503).json({ ok: false, error: 'fuelPosts not loaded' });
        if (postType === 'city') {
          var cityRow = db.prepare('SELECT state FROM fuel_cities WHERE city_name = ?').get(itemName);
          if (!cityRow) return res.status(404).json({ ok: false, error: 'City not found: ' + itemName });
          await fuelPosts.generateCityPost(itemName, cityRow.state, itemType);
        } else if (postType === 'state') {
          await fuelPosts.generateStatePost(itemName, itemType);
        } else if (postType === 'national') {
          await fuelPosts.generateNationalPost(itemType);
        } else {
          return res.status(400).json({ ok: false, error: 'Unknown post_type: ' + postType });
        }
      } else if (mod === 'metals') {
        if (!metalsPosts) return res.status(503).json({ ok: false, error: 'metalsPosts not loaded' });
        if (postType === 'city') {
          var mCityRow = db.prepare('SELECT state FROM metals_cities WHERE city_name = ?').get(itemName);
          if (!mCityRow) return res.status(404).json({ ok: false, error: 'City not found: ' + itemName });
          await metalsPosts.generateCityPost(itemName, mCityRow.state, itemType);
        } else if (postType === 'state') {
          await metalsPosts.generateStatePost(itemName, itemType);
        } else if (postType === 'national') {
          await metalsPosts.generateNationalPost(itemType);
        } else {
          return res.status(400).json({ ok: false, error: 'Unknown post_type: ' + postType });
        }
      } else {
        return res.status(400).json({ ok: false, error: 'Unknown module: ' + mod });
      }

      var logEntry = db.prepare(
        'SELECT * FROM wp_posts_log WHERE module=? AND item_type=? AND post_type=? AND item_name=?'
      ).get(mod, itemType, postType, itemName);

      res.json({ ok: true, result: logEntry || { action: 'done' } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── GET /api/fetch-log ───────────────────────────────────────────────────

  router.get('/fetch-log', function (req, res) {
    try {
      var mod = req.query.module || null;
      var limit = Math.min(parseInt(req.query.limit) || 20, 100);
      var where = mod ? 'WHERE module = ?' : '';
      var params = mod ? [mod] : [];
      var rows = db.prepare('SELECT * FROM fetch_log ' + where + ' ORDER BY created_at DESC LIMIT ?')
        .all(params.concat([limit]));
      res.json({ ok: true, data: rows });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── GET /api/fuel/city-detail ────────────────────────────────────────────

  router.get('/fuel/city-detail', function (req, res) {
    try {
      var city = req.query.city;
      if (!city) return res.status(400).json({ error: 'city required' });

      var cityRow = db.prepare('SELECT * FROM fuel_cities WHERE city_name = ?').get(city);
      if (!cityRow) return res.status(404).json({ error: 'City not found' });

      var today = new Date().toISOString().slice(0, 10);
      var todayPrice = db.prepare('SELECT * FROM fuel_prices WHERE city = ? AND price_date = ?').get(city, today);
      var history = db.prepare(
        'SELECT price_date, petrol, diesel FROM fuel_prices WHERE city = ? ORDER BY price_date DESC LIMIT 30'
      ).all(city);
      var posts = {
        petrol: db.prepare("SELECT * FROM wp_posts_log WHERE module='fuel' AND item_type='petrol' AND post_type='city' AND item_name=?").get(city),
        diesel: db.prepare("SELECT * FROM wp_posts_log WHERE module='fuel' AND item_type='diesel' AND post_type='city' AND item_name=?").get(city),
      };

      res.json({ ok: true, city: cityRow, today: todayPrice, history: history.reverse(), posts: posts });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── GET /api/metals/city-detail ─────────────────────────────────────────

  router.get('/metals/city-detail', function (req, res) {
    try {
      var city = req.query.city;
      if (!city) return res.status(400).json({ error: 'city required' });

      var cityRow = db.prepare('SELECT * FROM metals_cities WHERE city_name = ?').get(city);
      if (!cityRow) return res.status(404).json({ error: 'City not found' });

      var today = new Date().toISOString().slice(0, 10);
      var todayPrices = {};
      var history = {};
      var posts = {};
      for (var metal of ['gold', 'silver', 'platinum']) {
        todayPrices[metal] = db.prepare(
          'SELECT * FROM metals_prices WHERE city=? AND metal_type=? AND price_date=?'
        ).get(city, metal, today);
        history[metal] = db.prepare(
          'SELECT price_date, price_24k, price_22k, price_18k, price_1g FROM metals_prices WHERE city=? AND metal_type=? ORDER BY price_date DESC LIMIT 30'
        ).all(city, metal).reverse();
        posts[metal] = db.prepare(
          "SELECT * FROM wp_posts_log WHERE module='metals' AND item_type=? AND post_type='city' AND item_name=?"
        ).get(metal, city);
      }

      res.json({ ok: true, city: cityRow, today: todayPrices, history: history, posts: posts });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── PUT /api/fuel/price ──────────────────────────────────────────────────

  router.put('/fuel/price', function (req, res) {
    try {
      var body = req.body || {};
      var city = body.city;
      var priceDate = body.price_date;
      var petrol = body.petrol !== undefined && body.petrol !== null && body.petrol !== '' ? parseFloat(body.petrol) : null;
      var diesel = body.diesel !== undefined && body.diesel !== null && body.diesel !== '' ? parseFloat(body.diesel) : null;

      if (!city || !priceDate) return res.status(400).json({ ok: false, error: 'city and price_date required' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(priceDate)) return res.status(400).json({ ok: false, error: 'Invalid date format' });
      if (petrol !== null && (petrol < 30 || petrol > 300)) return res.status(400).json({ ok: false, error: 'Petrol price out of range (30-300)' });
      if (diesel !== null && (diesel < 20 || diesel > 300)) return res.status(400).json({ ok: false, error: 'Diesel price out of range (20-300)' });

      var cityRow = db.prepare('SELECT state FROM fuel_cities WHERE city_name = ?').get(city);
      var state = cityRow ? cityRow.state : null;

      db.prepare(`
        INSERT INTO fuel_prices (city, state, petrol, diesel, price_date, source, fetched_at)
        VALUES (?, ?, ?, ?, ?, 'manual', datetime('now'))
        ON CONFLICT(city, price_date) DO UPDATE SET
          petrol = COALESCE(?, petrol), diesel = COALESCE(?, diesel),
          source = 'manual', fetched_at = datetime('now')
      `).run(city, state, petrol, diesel, priceDate, petrol, diesel);

      res.json({ ok: true, updated: { city, price_date: priceDate, petrol, diesel } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── PUT /api/metals/price ────────────────────────────────────────────────

  router.put('/metals/price', function (req, res) {
    try {
      var body = req.body || {};
      var city = body.city;
      var metalType = body.metal_type;
      var priceDate = body.price_date;
      var p24k = body.price_24k !== undefined && body.price_24k !== '' ? parseFloat(body.price_24k) || null : null;
      var p22k = body.price_22k !== undefined && body.price_22k !== '' ? parseFloat(body.price_22k) || null : null;
      var p18k = body.price_18k !== undefined && body.price_18k !== '' ? parseFloat(body.price_18k) || null : null;
      var p1g = body.price_1g !== undefined && body.price_1g !== '' ? parseFloat(body.price_1g) || null : null;

      if (!city || !metalType || !priceDate) return res.status(400).json({ ok: false, error: 'city, metal_type, price_date required' });
      if (!['gold', 'silver', 'platinum'].includes(metalType)) return res.status(400).json({ ok: false, error: 'Invalid metal_type' });
      if (!/^\d{4}-\d{2}-\d{2}$/.test(priceDate)) return res.status(400).json({ ok: false, error: 'Invalid date format' });

      db.prepare(`
        INSERT INTO metals_prices (city, metal_type, price_24k, price_22k, price_18k, price_1g, price_date, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'manual', datetime('now'))
        ON CONFLICT(city, metal_type, price_date) DO UPDATE SET
          price_24k = COALESCE(?, price_24k), price_22k = COALESCE(?, price_22k),
          price_18k = COALESCE(?, price_18k), price_1g = COALESCE(?, price_1g),
          source = 'manual', created_at = datetime('now')
      `).run(city, metalType, p24k, p22k, p18k, p1g, priceDate, p24k, p22k, p18k, p1g);

      res.json({ ok: true, updated: { city, metal_type: metalType, price_date: priceDate, price_24k: p24k, price_22k: p22k, price_18k: p18k, price_1g: p1g } });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── PUT /api/fuel/city ───────────────────────────────────────────────────

  router.put('/fuel/city', function (req, res) {
    try {
      var body = req.body || {};
      var city = body.city_name;
      if (!city) return res.status(400).json({ ok: false, error: 'city_name required' });

      var updates = [];
      var params = [];
      if (body.is_enabled !== undefined) { updates.push('is_enabled = ?'); params.push(body.is_enabled ? 1 : 0); }
      if (body.has_post !== undefined) { updates.push('has_post = ?'); params.push(body.has_post ? 1 : 0); }
      if (!updates.length) return res.status(400).json({ ok: false, error: 'Nothing to update' });

      params.push(city);
      db.prepare('UPDATE fuel_cities SET ' + updates.join(', ') + ' WHERE city_name = ?').run(params);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── PUT /api/metals/city ─────────────────────────────────────────────────

  router.put('/metals/city', function (req, res) {
    try {
      var body = req.body || {};
      var city = body.city_name;
      if (!city) return res.status(400).json({ ok: false, error: 'city_name required' });

      var updates = [];
      var params = [];
      if (body.is_active !== undefined) { updates.push('is_active = ?'); params.push(body.is_active ? 1 : 0); }
      if (!updates.length) return res.status(400).json({ ok: false, error: 'Nothing to update' });

      params.push(city);
      db.prepare('UPDATE metals_cities SET ' + updates.join(', ') + ' WHERE city_name = ?').run(params);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── GET /api/fuel/data-quality ──────────────────────────────────────────

  router.get('/fuel/data-quality', function (req, res) {
    try {
      var today = new Date().toISOString().slice(0, 10);
      var totalCities = db.prepare('SELECT COUNT(*) as c FROM fuel_cities').get().c;
      var enabledCities = db.prepare('SELECT COUNT(*) as c FROM fuel_cities WHERE is_enabled=1').get().c;
      var fetchedToday = db.prepare('SELECT COUNT(*) as c FROM fuel_prices WHERE price_date=? AND (petrol>0 OR diesel>0)').get(today).c;

      var staleCities = db.prepare(`
        SELECT fc.city_name, fc.state,
          CAST(julianday('now') - julianday(MAX(fp.price_date)) AS INTEGER) as days_since
        FROM fuel_cities fc
        LEFT JOIN fuel_prices fp ON fc.city_name = fp.city
        WHERE fc.is_enabled = 1
        GROUP BY fc.city_name
        HAVING days_since >= 3 OR days_since IS NULL
        ORDER BY days_since DESC LIMIT 50
      `).all();

      var priceSuspicious = db.prepare(`
        SELECT t.city, t.petrol as today, y.petrol as yesterday,
          ROUND(ABS(t.petrol - y.petrol) / y.petrol * 100, 1) as pct_change, 'petrol' as fuel
        FROM fuel_prices t
        JOIN fuel_prices y ON t.city = y.city
        WHERE t.price_date = date('now')
          AND y.price_date = date('now', '-1 day')
          AND y.petrol > 0 AND t.petrol > 0
          AND ABS(t.petrol - y.petrol) / y.petrol > 0.05
        UNION ALL
        SELECT t.city, t.diesel, y.diesel,
          ROUND(ABS(t.diesel - y.diesel) / y.diesel * 100, 1), 'diesel'
        FROM fuel_prices t
        JOIN fuel_prices y ON t.city = y.city
        WHERE t.price_date = date('now')
          AND y.price_date = date('now', '-1 day')
          AND y.diesel > 0 AND t.diesel > 0
          AND ABS(t.diesel - y.diesel) / y.diesel > 0.05
        ORDER BY pct_change DESC LIMIT 20
      `).all();

      var sourceBreakdown = {};
      var srcRows = db.prepare('SELECT source, COUNT(*) as c FROM fuel_prices GROUP BY source').all();
      srcRows.forEach(function (r) { sourceBreakdown[r.source || 'unknown'] = r.c; });

      var coverageByState = db.prepare(`
        SELECT fc.state,
          COUNT(DISTINCT fc.city_name) as total,
          COUNT(DISTINCT CASE WHEN fp.petrol > 0 THEN fc.city_name END) as fetched
        FROM fuel_cities fc
        LEFT JOIN fuel_prices fp ON fc.city_name = fp.city AND fp.price_date = ?
        WHERE fc.is_enabled = 1
        GROUP BY fc.state ORDER BY fc.state
      `).all(today);

      res.json({ ok: true, totalCities, enabledCities, fetchedToday, staleCities, priceSuspicious, sourceBreakdown, coverageByState });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── GET /api/metals/data-quality ────────────────────────────────────────

  router.get('/metals/data-quality', function (req, res) {
    try {
      var metal = req.query.metal || 'gold';
      var today = new Date().toISOString().slice(0, 10);
      var totalCities = db.prepare('SELECT COUNT(*) as c FROM metals_cities').get().c;
      var activeCities = db.prepare('SELECT COUNT(*) as c FROM metals_cities WHERE is_active=1').get().c;
      var fetchedToday = db.prepare(
        'SELECT COUNT(*) as c FROM metals_prices WHERE metal_type=? AND price_date=? AND (price_24k>0 OR price_1g>0)'
      ).get(metal, today).c;

      var staleCities = db.prepare(`
        SELECT mc.city_name, mc.state,
          CAST(julianday('now') - julianday(MAX(mp.price_date)) AS INTEGER) as days_since
        FROM metals_cities mc
        LEFT JOIN metals_prices mp ON mc.city_name = mp.city AND mp.metal_type = ?
        WHERE mc.is_active = 1
        GROUP BY mc.city_name
        HAVING days_since >= 3 OR days_since IS NULL
        ORDER BY days_since DESC LIMIT 50
      `).all(metal);

      var sourceBreakdown = {};
      var srcRows = db.prepare('SELECT source, COUNT(*) as c FROM metals_prices WHERE metal_type=? GROUP BY source').all(metal);
      srcRows.forEach(function (r) { sourceBreakdown[r.source || 'unknown'] = r.c; });

      var coverageByState = db.prepare(`
        SELECT mc.state,
          COUNT(DISTINCT mc.city_name) as total,
          COUNT(DISTINCT CASE WHEN mp.price_24k > 0 OR mp.price_1g > 0 THEN mc.city_name END) as fetched
        FROM metals_cities mc
        LEFT JOIN metals_prices mp ON mc.city_name = mp.city AND mp.metal_type = ? AND mp.price_date = ?
        WHERE mc.is_active = 1
        GROUP BY mc.state ORDER BY mc.state
      `).all(metal, today);

      res.json({ ok: true, metal, totalCities, activeCities, fetchedToday, staleCities, sourceBreakdown, coverageByState });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ─── POST /api/import/fuel ────────────────────────────────────────────────

  router.post('/import/fuel', function (req, res) {
    var csvText = req.body && req.body.csv;
    if (!csvText || typeof csvText !== 'string') return res.status(400).json({ ok: false, error: 'No CSV text provided' });

    var dryRun  = req.query.dry === '1' || req.query.dry === 'true';

    var parsed;
    try { parsed = parseCsv(csvText); }
    catch (e) { return res.status(400).json({ ok: false, error: 'CSV parse failed: ' + e.message }); }

    var missing = ['city', 'price_date'].filter(function (c) { return !parsed.headers.includes(c); });
    if (missing.length) return res.status(400).json({ ok: false, error: 'Missing columns: ' + missing.join(', ') });

    var stats = { total: 0, inserted: 0, skipped: 0, errors: [] };

    var lookupFuelState = db.prepare('SELECT state FROM fuel_cities WHERE LOWER(city_name) = LOWER(?) LIMIT 1');

    var insertStmt = db.prepare(`
      INSERT INTO fuel_prices (city, state, petrol, diesel, price_date, source, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(city, price_date) DO UPDATE SET
        petrol  = COALESCE(excluded.petrol,  fuel_prices.petrol),
        diesel  = COALESCE(excluded.diesel,  fuel_prices.diesel),
        state   = COALESCE(excluded.state,   fuel_prices.state),
        source  = COALESCE(excluded.source,  fuel_prices.source)
    `);

    var runFuelImport = db.transaction(function (rows) {
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        stats.total++;
        var city = (row.city || '').trim();
        if (!city) { stats.skipped++; continue; }
        if (!row.price_date || !/^\d{4}-\d{2}-\d{2}$/.test(row.price_date)) {
          stats.errors.push('Row ' + stats.total + ': invalid date "' + row.price_date + '"');
          stats.skipped++; continue;
        }
        var petrol = toDec(row.petrol);
        var diesel = toDec(row.diesel);
        if (petrol === null && diesel === null) { stats.skipped++; continue; }
        var state = (row.state || '').trim();
        if (!state) { var sl = lookupFuelState.get(city); state = sl ? sl.state : ''; }
        var source = (row.source || 'imported').trim();
        if (!dryRun) {
          try { insertStmt.run(city, state, petrol, diesel, row.price_date, source); stats.inserted++; }
          catch (e) { stats.errors.push('Row ' + stats.total + ': ' + e.message); stats.skipped++; }
        } else { stats.inserted++; }
      }
    });

    try {
      runFuelImport(parsed.rows);
      res.json({
        ok: true, dryRun: dryRun, stats: stats,
        message: dryRun
          ? 'Dry run: would insert/update ~' + stats.inserted + ' rows from ' + stats.total + ' CSV rows'
          : 'Imported ' + stats.inserted + ' rows (' + stats.skipped + ' skipped) from ' + stats.total + ' CSV rows',
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, stats: stats });
    }
  });

  // ─── POST /api/import/metals ──────────────────────────────────────────────

  router.post('/import/metals', function (req, res) {
    var csvText = req.body && req.body.csv;
    if (!csvText || typeof csvText !== 'string') return res.status(400).json({ ok: false, error: 'No CSV text provided' });

    var dryRun  = req.query.dry === '1' || req.query.dry === 'true';

    var parsed;
    try { parsed = parseCsv(csvText); }
    catch (e) { return res.status(400).json({ ok: false, error: 'CSV parse failed: ' + e.message }); }

    var missing = ['city', 'metal_type', 'price_date'].filter(function (c) { return !parsed.headers.includes(c); });
    if (missing.length) return res.status(400).json({ ok: false, error: 'Missing columns: ' + missing.join(', ') });

    var stats = { total: 0, inserted: 0, skipped: 0, errors: [] };

    var insertStmt = db.prepare(`
      INSERT INTO metals_prices (city, metal_type, price_24k, price_22k, price_18k, price_1g, price_date, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(city, metal_type, price_date) DO UPDATE SET
        price_24k = COALESCE(excluded.price_24k, metals_prices.price_24k),
        price_22k = COALESCE(excluded.price_22k, metals_prices.price_22k),
        price_18k = COALESCE(excluded.price_18k, metals_prices.price_18k),
        price_1g  = COALESCE(excluded.price_1g,  metals_prices.price_1g),
        source    = COALESCE(excluded.source,    metals_prices.source)
    `);

    var VALID_METALS = ['gold', 'silver', 'platinum'];

    var runMetalsImport = db.transaction(function (rows) {
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        stats.total++;
        var city  = (row.city || '').trim();
        var metal = (row.metal_type || '').toLowerCase().trim();
        if (!city) { stats.skipped++; continue; }
        if (!row.price_date || !/^\d{4}-\d{2}-\d{2}$/.test(row.price_date)) {
          stats.errors.push('Row ' + stats.total + ': invalid date "' + row.price_date + '"');
          stats.skipped++; continue;
        }
        if (!VALID_METALS.includes(metal)) { stats.skipped++; continue; }
        var p24k = toDec(row.price_24k);
        var p22k = toDec(row.price_22k);
        var p18k = toDec(row.price_18k);
        var p1g  = toDec(row.price_1g);
        if (p24k === null && p22k === null && p18k === null && p1g === null) { stats.skipped++; continue; }
        var source = (row.source || 'imported').trim();
        if (!dryRun) {
          try { insertStmt.run(city, metal, p24k, p22k, p18k, p1g, row.price_date, source); stats.inserted++; }
          catch (e) { stats.errors.push('Row ' + stats.total + ': ' + e.message); stats.skipped++; }
        } else { stats.inserted++; }
      }
    });

    try {
      runMetalsImport(parsed.rows);
      res.json({
        ok: true, dryRun: dryRun, stats: stats,
        message: dryRun
          ? 'Dry run: would insert/update ~' + stats.inserted + ' rows from ' + stats.total + ' CSV rows'
          : 'Imported ' + stats.inserted + ' rows (' + stats.skipped + ' skipped) from ' + stats.total + ' CSV rows',
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, stats: stats });
    }
  });

  // ─── POST /api/import/fuel-json ──────────────────────────────────────────

  router.post('/import/fuel-json', function (req, res) {
    var rows = req.body && req.body.rows;
    if (!Array.isArray(rows)) return res.status(400).json({ ok: false, error: 'Expected { rows: [...] } body' });
    if (!rows.length) return res.json({ ok: true, stats: { total: 0, inserted: 0, skipped: 0, errors: [] }, message: 'No rows in file' });

    var dryRun = req.query.dry === '1' || req.query.dry === 'true';

    var first = rows[0];
    var missing = ['city', 'price_date'].filter(function (k) { return !(k in first); });
    if (missing.length) return res.status(400).json({ ok: false, error: 'Missing fields: ' + missing.join(', ') });

    var stats = { total: 0, inserted: 0, skipped: 0, errors: [] };

    var lookupFuelStateJ = db.prepare('SELECT state FROM fuel_cities WHERE LOWER(city_name) = LOWER(?) LIMIT 1');

    var insertStmt = db.prepare(`
      INSERT INTO fuel_prices (city, state, petrol, diesel, price_date, source, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(city, price_date) DO UPDATE SET
        petrol  = COALESCE(excluded.petrol,  fuel_prices.petrol),
        diesel  = COALESCE(excluded.diesel,  fuel_prices.diesel),
        state   = COALESCE(excluded.state,   fuel_prices.state),
        source  = COALESCE(excluded.source,  fuel_prices.source)
    `);

    var runFuelJsonImport = db.transaction(function (rows) {
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        stats.total++;
        var city = String(row.city || '').trim();
        if (!city) { stats.skipped++; continue; }
        var dateVal = String(row.price_date || '').trim();
        if (!dateVal || !/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) {
          stats.errors.push('Row ' + stats.total + ': invalid date "' + dateVal + '"');
          stats.skipped++; continue;
        }
        var petrol = toDec(row.petrol);
        var diesel = toDec(row.diesel);
        if (petrol === null && diesel === null) { stats.skipped++; continue; }
        var state = String(row.state || '').trim();
        if (!state) { var slj = lookupFuelStateJ.get(city); state = slj ? slj.state : ''; }
        var source = String(row.source || 'imported').trim();
        if (!dryRun) {
          try { insertStmt.run(city, state, petrol, diesel, dateVal, source); stats.inserted++; }
          catch (e) { stats.errors.push('Row ' + stats.total + ': ' + e.message); stats.skipped++; }
        } else { stats.inserted++; }
      }
    });

    try {
      runFuelJsonImport(rows);
      res.json({
        ok: true, dryRun: dryRun, stats: stats,
        message: dryRun
          ? 'Dry run: would insert/update ~' + stats.inserted + ' rows from ' + stats.total + ' JSON objects'
          : 'Imported ' + stats.inserted + ' rows (' + stats.skipped + ' skipped) from ' + stats.total + ' JSON objects',
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, stats: stats });
    }
  });

  // ─── POST /api/import/metals-json ─────────────────────────────────────────

  router.post('/import/metals-json', function (req, res) {
    var rows = req.body && req.body.rows;
    if (!Array.isArray(rows)) return res.status(400).json({ ok: false, error: 'Expected { rows: [...] } body' });
    if (!rows.length) return res.json({ ok: true, stats: { total: 0, inserted: 0, skipped: 0, errors: [] }, message: 'No rows in file' });

    var dryRun = req.query.dry === '1' || req.query.dry === 'true';

    var first = rows[0];
    var missing = ['city', 'metal_type', 'price_date'].filter(function (k) { return !(k in first); });
    if (missing.length) return res.status(400).json({ ok: false, error: 'Missing fields: ' + missing.join(', ') });

    var stats = { total: 0, inserted: 0, skipped: 0, errors: [] };

    var insertStmt = db.prepare(`
      INSERT INTO metals_prices (city, metal_type, price_24k, price_22k, price_18k, price_1g, price_date, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(city, metal_type, price_date) DO UPDATE SET
        price_24k = COALESCE(excluded.price_24k, metals_prices.price_24k),
        price_22k = COALESCE(excluded.price_22k, metals_prices.price_22k),
        price_18k = COALESCE(excluded.price_18k, metals_prices.price_18k),
        price_1g  = COALESCE(excluded.price_1g,  metals_prices.price_1g),
        source    = COALESCE(excluded.source,    metals_prices.source)
    `);

    var VALID_METALS_J = ['gold', 'silver', 'platinum'];

    var runMetalsJsonImport = db.transaction(function (rows) {
      for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        stats.total++;
        var city  = String(row.city || '').trim();
        var metal = String(row.metal_type || '').toLowerCase().trim();
        if (!city) { stats.skipped++; continue; }
        var dateVal = String(row.price_date || '').trim();
        if (!dateVal || !/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) {
          stats.errors.push('Row ' + stats.total + ': invalid date "' + dateVal + '"');
          stats.skipped++; continue;
        }
        if (!VALID_METALS_J.includes(metal)) { stats.skipped++; continue; }
        var p24k = toDec(row.price_24k);
        var p22k = toDec(row.price_22k);
        var p18k = toDec(row.price_18k);
        var p1g  = toDec(row.price_1g);
        if (p24k === null && p22k === null && p18k === null && p1g === null) { stats.skipped++; continue; }
        var source = String(row.source || 'imported').trim();
        if (!dryRun) {
          try { insertStmt.run(city, metal, p24k, p22k, p18k, p1g, dateVal, source); stats.inserted++; }
          catch (e) { stats.errors.push('Row ' + stats.total + ': ' + e.message); stats.skipped++; }
        } else { stats.inserted++; }
      }
    });

    try {
      runMetalsJsonImport(rows);
      res.json({
        ok: true, dryRun: dryRun, stats: stats,
        message: dryRun
          ? 'Dry run: would insert/update ~' + stats.inserted + ' rows from ' + stats.total + ' JSON objects'
          : 'Imported ' + stats.inserted + ' rows (' + stats.skipped + ' skipped) from ' + stats.total + ' JSON objects',
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message, stats: stats });
    }
  });

  // ─── GET /api/import/summary ──────────────────────────────────────────────

  router.get('/import/summary', function (req, res) {
    try {
      var fuelSummary = db.prepare(`
        SELECT
          COUNT(*) as total_rows,
          COUNT(DISTINCT city) as cities,
          COUNT(DISTINCT price_date) as days,
          MIN(price_date) as earliest,
          MAX(price_date) as latest,
          SUM(CASE WHEN petrol IS NOT NULL THEN 1 ELSE 0 END) as petrol_rows,
          SUM(CASE WHEN diesel IS NOT NULL THEN 1 ELSE 0 END) as diesel_rows,
          SUM(CASE WHEN source = 'imported' THEN 1 ELSE 0 END) as imported_rows,
          SUM(CASE WHEN source != 'imported' THEN 1 ELSE 0 END) as live_rows
        FROM fuel_prices
      `).get();

      var metalsSummary = db.prepare(`
        SELECT
          metal_type,
          COUNT(*) as total_rows,
          COUNT(DISTINCT city) as cities,
          COUNT(DISTINCT price_date) as days,
          MIN(price_date) as earliest,
          MAX(price_date) as latest,
          SUM(CASE WHEN source = 'imported' THEN 1 ELSE 0 END) as imported_rows,
          SUM(CASE WHEN source != 'imported' THEN 1 ELSE 0 END) as live_rows
        FROM metals_prices
        GROUP BY metal_type
      `).all();

      res.json({ ok: true, fuel: fuelSummary, metals: metalsSummary });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // LOTTERY ROUTES
  // ═══════════════════════════════════════════════════════════════════════════

  // GET /api/lottery/summary — today's three draw slots status
  router.get('/lottery/summary', function(req, res) {
    try {
      var lottery = req.app.locals.modules.lottery;
      if (!lottery) return res.json({ ok: false, error: 'Lottery module not loaded' });
      res.json({ ok: true, data: lottery.getTodaySummary() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/lottery/results?date=YYYY-MM-DD
  router.get('/lottery/results', function(req, res) {
    try {
      var config = getConfig();
      var db = req.app.locals.modules.lottery && req.app.locals.modules.lottery.db;
      if (!db) return res.json({ ok: false, error: 'Lottery module not loaded' });
      var date = req.query.date || new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
      var rows = db.prepare('SELECT * FROM lottery_results WHERE draw_date = ? ORDER BY draw_time ASC').all(date);
      res.json({ ok: true, data: rows, date: date });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/lottery/recent?limit=N
  router.get('/lottery/recent', function(req, res) {
    try {
      var lottery = req.app.locals.modules.lottery;
      if (!lottery) return res.json({ ok: false, error: 'Lottery module not loaded' });
      var limit = Math.min(parseInt(req.query.limit) || 30, 100);
      res.json({ ok: true, data: lottery.getRecentResults(limit) });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/lottery/fetch — manual fetch for all draw slots today
  router.post('/lottery/fetch', async function(req, res) {
    try {
      var lottery = req.app.locals.modules.lottery;
      if (!lottery) return res.json({ ok: false, error: 'Lottery module not loaded' });
      var date = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
      var results = {};
      for (var slot of ['1pm', '6pm', '8pm']) {
        try {
          results[slot] = await lottery.runFetch(slot, date, true);
        } catch (e) {
          results[slot] = false;
        }
      }
      res.json({ ok: true, date: date, results: results });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/lottery/fetch/:drawTime — manual fetch for one draw slot
  router.post('/lottery/fetch/:drawTime', async function(req, res) {
    try {
      var lottery = req.app.locals.modules.lottery;
      if (!lottery) return res.json({ ok: false, error: 'Lottery module not loaded' });
      var drawTime = req.params.drawTime;
      if (!['1pm', '6pm', '8pm'].includes(drawTime)) {
        return res.status(400).json({ ok: false, error: 'drawTime must be 1pm, 6pm, or 8pm' });
      }
      var date = req.body.date || new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
      var ok = await lottery.runFetch(drawTime, date, true);
      res.json({ ok: ok, drawTime: drawTime, date: date });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // POST /api/lottery/generate-posts — (re)generate WP posts for today's fetched results
  router.post('/lottery/generate-posts', async function(req, res) {
    try {
      var lottery = req.app.locals.modules.lottery;
      var lotteryPosts = req.app.locals.modules.lotteryPosts;
      if (!lottery || !lotteryPosts) return res.json({ ok: false, error: 'Lottery module not loaded' });
      var date = new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
      var results = lottery.getResultsByDate(date).filter(function(r) { return r.status !== 'pending'; });
      var created = 0; var updated = 0; var failed = 0;
      for (var r of results) {
        try {
          var wpResult = await lotteryPosts.generateDrawPost(r);
          if (wpResult) {
            if (wpResult.action === 'created') created++;
            else updated++;
          }
        } catch (e) {
          failed++;
        }
      }
      res.json({ ok: true, date: date, created: created, updated: updated, failed: failed });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/lottery/logs?limit=N
  router.get('/lottery/logs', function(req, res) {
    try {
      var db = req.app.locals.modules.lottery && req.app.locals.modules.lottery.db;
      if (!db) return res.json({ ok: false, error: 'Lottery module not loaded' });
      var limit = Math.min(parseInt(req.query.limit) || 50, 200);
      var rows = db.prepare(
        "SELECT * FROM fetch_log WHERE module = 'lottery' ORDER BY created_at DESC LIMIT ?"
      ).all(limit);
      res.json({ ok: true, data: rows });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/lottery/wp-log — wp_posts_log entries for lottery module
  router.get('/lottery/wp-log', function(req, res) {
    try {
      var db = req.app.locals.modules.lottery && req.app.locals.modules.lottery.db;
      if (!db) return res.json({ ok: false, error: 'Lottery module not loaded' });
      var limit = Math.min(parseInt(req.query.limit) || 50, 200);
      var rows = db.prepare(
        "SELECT * FROM wp_posts_log WHERE module = 'lottery' ORDER BY created_at DESC LIMIT ?"
      ).all(limit);
      res.json({ ok: true, data: rows });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // GET /api/lottery/schedule — return draw schedule JSON
  router.get('/lottery/schedule', function(req, res) {
    try {
      var lottery = req.app.locals.modules.lottery;
      if (!lottery) return res.json({ ok: false, error: 'Lottery module not loaded' });
      res.json({ ok: true, data: lottery.getSchedule() });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  return router;
}

module.exports = createApiRouter;
