'use strict';

var path = require('path');
var express = require('express');
// Patches Express 4 so async handler throws/rejections reach the central
// error middleware (app.use((err,req,res,next)=>…) below) instead of hanging
// the request. Must be required before any routers are mounted.
require('express-async-errors');
var compression = require('compression');
var helmet = require('helmet');
var cors = require('cors');
var rateLimit = require('express-rate-limit');

// ─── 1. Load config (validates env vars, loads .env) ────────────────────────
var { getConfig, loadRuntimeOverrides } = require('./utils/config');
var config = getConfig();

// ─── 2. Initialize SQLite database (runs migrations on require) ─────────────
var { db, closeDb, recoverStuckDrafts } = require('./utils/db');
var { sanitizeForClient } = require('./utils/api-helpers');

// ─── 3. Initialize logger, set db reference ────────────────────────────────
var logger = require('./utils/logger');
logger.setDb(db);

// ─── 4. Load runtime config overrides from DB ──────────────────────────────
loadRuntimeOverrides(db);
config = getConfig();

// ─── 5. Create module instances ─────────────────────────────────────────────
var FeedsPool = require('./modules/feeds-pool');
var PublisherPool = require('./modules/publisher-pool');
var { TrendsPoller } = require('./modules/trends');
var { ArticleBuffer } = require('./modules/buffer');
var { SimilarityEngine } = require('./modules/similarity');
var { ArticleRewriter } = require('./modules/rewriter');
var { WordPressPublisher } = require('./modules/publisher');
var { Pipeline } = require('./workers/pipeline');
var { ContentExtractor } = require('./modules/extractor');
var { InfranodusAnalyzer } = require('./modules/infranodus');
var { ContentClassifier } = require('./modules/content-classifier');
var { FuelModule } = require('./modules/fuel');
var { MetalsModule } = require('./modules/metals');
var { LotteryModule } = require('./modules/lottery');
var { WPPublisher } = require('./modules/wp-publisher');
var { FuelPostCreator } = require('./modules/fuel-posts');
var { MetalsPostCreator } = require('./modules/metals-posts');
var { LotteryPostCreator } = require('./modules/lottery-posts');
var { setupSession, checkAuth, verifyCsrf } = require('./routes/auth');
var createApiRouter = require('./routes/api');
var createDashboardRouter = require('./routes/dashboard');
var siteConfigMod = require('./utils/site-config');

// ─── Initialise site-config module (must happen after DB + loadRuntimeOverrides) ──
siteConfigMod.init(db);

// ─── Multi-site pools ──────────────────────────────────────────────────────
// Per-feed SSE pool: one FirehoseListener per active Feed, keyed by feed_id.
// Feeds are the sole source of truth for firehose configuration — there is
// no system-wide firehose singleton or per-site pool anymore.
var feedsPool = new FeedsPool(config, db, logger);
var publisherPool = new PublisherPool(config, db, logger);

var trends = new TrendsPoller(config, db, logger);
var buffer = new ArticleBuffer(config, db, logger);
var similarity = new SimilarityEngine(config, db, logger);
var rewriter = new ArticleRewriter(config, logger);
var publisher = new WordPressPublisher(config, logger);
var extractor = new ContentExtractor(config, db, logger);
var infranodus = new InfranodusAnalyzer(config, db, logger);
var classifier = new ContentClassifier(require('./utils/config'), db, logger);
var scheduler = new Pipeline(config, db, rewriter, publisher, logger, extractor, infranodus, classifier);
var fuel = new FuelModule(config, db, logger);
var metals = new MetalsModule(config, db, logger);
var lottery = new LotteryModule(config, db, logger);

// ─── 6. Clustering queue (debounce rapid SSE events) ──────────────────────
var _clusteringQueue = [];
var _clusteringTimer = null;
var _clusteringProcessing = false;
var _clusteringFirstEventAt = null;
// Read from config at queue time for hot-reload
var _cfgMod = require('./utils/config');
function _clusteringDebounceMs() { return parseInt(_cfgMod.get('CLUSTERING_DEBOUNCE_MS'), 10) || 3000; }
function _clusteringMaxWaitMs()  { return parseInt(_cfgMod.get('CLUSTERING_MAX_WAIT_MS'), 10) || 10000; }
function _clusterQueueMax()      { return parseInt(_cfgMod.get('CLUSTER_QUEUE_MAX'), 10) || 500; }

async function boot() {
  // ─── Wire up event listeners BEFORE any module init ──────────────────────
  // EventEmitter drops events that have no listeners. Listener init opens SSE
  // streams immediately — listeners MUST exist first.

  // Shared handler for the per-feed pool. Articles carry source_site_id and
  // feed_id — buffer persists both and the pipeline scopes clusters/drafts
  // accordingly.
  async function _ingestArticle(article) {
    try {
      var articleId = buffer.addArticle(article);
      if (!articleId) return;
      // Successful ingest resets the feed's failure streak so it drops off the
      // Failed page the next time anyone refreshes. Guarded for legacy rows
      // with no feed_id (pre-Feeds ingests).
      if (article && article.feed_id) {
        try {
          db.prepare('UPDATE feeds SET consecutive_failures = 0 WHERE id = ? AND consecutive_failures > 0').run(article.feed_id);
        } catch (_resetErr) { /* non-critical */ }
      }
      var trendsMatch = null;
      if (trends.enabled && trends.ready) {
        trendsMatch = trends.matchArticle(article);
      }
      if (_clusteringQueue.length >= _clusterQueueMax()) {
        logger.warn('index', 'Clustering queue full, dropping article', { url: article.url });
        return;
      }
      _clusteringQueue.push({ article: article, trendsMatch: trendsMatch });
      if (!_clusteringFirstEventAt) _clusteringFirstEventAt = Date.now();
      if (_clusteringTimer) clearTimeout(_clusteringTimer);
      var waitedMs = Date.now() - _clusteringFirstEventAt;
      if (waitedMs >= _clusteringMaxWaitMs()) {
        processSimilarityBatch();
      } else {
        _clusteringTimer = setTimeout(processSimilarityBatch, _clusteringDebounceMs());
      }
    } catch (err) {
      logger.error('index', 'Error buffering firehose article: ' + err.message);
    }
  }

  feedsPool.on('article', _ingestArticle);

  // Track firehose SSE error events so Feeds with notify_failure=true can
  // surface on the Failed page after 3 consecutive failures. Only 'error'
  // events increment — a successful reconnect that yields an article resets
  // via _ingestArticle above.
  feedsPool.on('status', function (st) {
    if (!st || !st.feedId) return;
    if (st.type !== 'error') return;
    try {
      db.prepare('UPDATE feeds SET consecutive_failures = consecutive_failures + 1 WHERE id = ?').run(st.feedId);
    } catch (_incErr) { /* non-critical */ }
  });

  /**
   * Process all queued articles for similarity in one batch.
   * Loads buffer articles ONCE and runs async similarity for each.
   */
  async function processSimilarityBatch() {
    if (_clusteringProcessing) return;
    _clusteringProcessing = true;
    _clusteringTimer = null;
    _clusteringFirstEventAt = null;

    var batch = _clusteringQueue.splice(0);
    if (batch.length === 0) {
      _clusteringProcessing = false;
      return;
    }

    logger.info('index', 'Processing similarity batch: ' + batch.length + ' article(s)');

    try {
      // Load buffer articles ONCE for the entire batch
      var bufferArticles = buffer.getRecentArticlesForSimilarity(
        parseFloat(_cfgMod.get('BUFFER_HOURS')) || 2.5,
        parseInt(_cfgMod.get('MAX_BUFFER_FOR_SIMILARITY'), 10) || 100
      );

      for (var i = 0; i < batch.length; i++) {
        var item = batch[i];
        var article = item.article;

        // Feed-scoped clustering: an article tagged with feed_id only matches
        // other articles from the SAME feed. Legacy (no feed_id) articles only
        // match other legacy articles. This enforces the "per-feed clusters"
        // decision (each Feed is its own independent rewrite pipeline).
        var relevantBuffer = article.feed_id
          ? bufferArticles.filter(function (b) { return b.feed_id === article.feed_id; })
          : bufferArticles.filter(function (b) { return !b.feed_id; });

        try {
          logger.debug('index', 'Clustering: article #' + article.id +
            ' fp=' + (article.fingerprint ? article.fingerprint.length + ' chars' : 'NONE') +
            ', buffer=' + relevantBuffer.length + '/' + bufferArticles.length + ' articles' +
            (article.feed_id ? ' (feed=' + article.feed_id + ')' : ''));

          var matches = await similarity.findMatchesAsync(article, relevantBuffer);

          if (matches.length > 0) {
            logger.info('index', 'Similarity matches for "' +
              (article.title || article.url).substring(0, 60) + '": ' +
              matches.length + ' match(es), best score: ' + matches[0].score.toFixed(3));
          }

          if (matches.length >= config.MIN_SOURCES_THRESHOLD - 1) {
            var cluster = similarity.createOrUpdateCluster(article, matches, item.trendsMatch);
            if (cluster) {
              logger.info('index', 'Cluster ' + cluster.id + ' ready: "' +
                (cluster.topic || '').substring(0, 60) + '" (' + cluster.article_count + ' articles)');
              // Always enqueue drafts the moment a cluster is formed so the
              // extraction worker picks them up eagerly. Autopilot / admin
              // Regenerate should NEVER have to wait on extraction — content
              // is ready by the time they ask for a rewrite.
              //
              // The rewrite loop (workers/pipeline.js:_rewriteLoop) still
              // enforces c.article_count >= MIN_SOURCES_THRESHOLD and the
              // quality floor before firing the AI, so this change only
              // affects *when* extraction runs, not *whether* the cluster
              // eventually publishes. Singleton / below-threshold clusters
              // sit extracted-and-ready; they become rewritable automatically
              // if more matching articles join later.
              scheduler.enqueue(cluster);
            }
          }
        } catch (err) {
          logger.error('index', 'Error processing article #' + article.id + ' in batch: ' + err.message);
        }
      }
    } catch (err) {
      logger.error('index', 'Error in similarity batch: ' + err.message);
    } finally {
      _clusteringProcessing = false;
      if (_clusteringQueue.length > 0) {
        _clusteringTimer = setTimeout(processSimilarityBatch, CLUSTERING_DEBOUNCE_MS);
        _clusteringFirstEventAt = Date.now();
      }
    }
  }

  trends.on('trend-matched', function(trend, cluster) {
    try {
      if (cluster && cluster.status === 'detected' && !cluster.trends_boosted) {
        db.prepare(
          "UPDATE clusters SET trends_boosted = 1, trend_topic = ?, priority = 'high' WHERE id = ?"
        ).run(trend.topic, cluster.id);
        logger.info('index', 'Cluster ' + cluster.id + ' boosted by trend: ' + trend.topic);
      }
    } catch (err) {
      logger.error('index', 'Error handling trend-matched event', err.message);
    }
  });

  // ─── Init modules — order matters ────────────────────────────────────────
  // Buffer & similarity MUST be ready before the feeds pool connects (replay
  // articles arrive immediately). Feeds pool & trends start last.
  // Recover drafts stuck in transient states from previous run
  recoverStuckDrafts(logger);

  logger.info('index', 'Event listeners attached, initializing modules...');
  await buffer.init();
  await similarity.init();
  await extractor.init();
  await rewriter.init();
  await publisher.init();
  await scheduler.init();
  await infranodus.init();
  await fuel.init();
  await metals.init();
  await lottery.init();

  // ─── WP Publisher + Post Creators ───────────────────────────────────────
  var wpPub = new WPPublisher(config, db, logger);
  await wpPub.init();
  var fuelPosts = new FuelPostCreator(fuel, wpPub, db, logger);
  var metalsPosts = new MetalsPostCreator(metals, wpPub, db, logger);
  var lotteryPosts = new LotteryPostCreator(lottery, wpPub, db, logger);
  fuel.setPostCreator(fuelPosts);
  metals.setPostCreator(metalsPosts);
  lottery.setPostCreator(lotteryPosts);

  // ─── Init multi-site pools ─────────────────────────────────────────────
  await publisherPool.init();
  await publisherPool.initAll();

  logger.info('index', 'All downstream modules ready. Starting feed listeners...');
  // Per-feed SSE pool: one FirehoseListener per active Feed with a token.
  // Non-fatal if a single feed token is bad; init() logs per-feed failures.
  await feedsPool.init();
  await trends.init();
  logger.info('index', 'All modules initialized');

  // ─── Set up Express with security ────────────────────────────────────────

  var app = express();

  // Expose modules for performance monitoring endpoint
  app.locals.modules = {
    feedsPool: feedsPool,
    publisherPool: publisherPool,
    trends: trends, buffer: buffer, similarity: similarity,
    extractor: extractor, rewriter: rewriter, publisher: publisher,
    scheduler: scheduler, infranodus: infranodus, classifier: classifier,
    fuel: fuel, metals: metals, lottery: lottery,
    wpPublisher: wpPub, fuelPosts: fuelPosts, metalsPosts: metalsPosts, lotteryPosts: lotteryPosts,
  };
  app.locals.db = db;

  // Trust Hostinger reverse proxy
  app.set('trust proxy', 1);

  // Force HTTPS in production
  if (process.env.NODE_ENV === 'production' || config.FORCE_HTTPS === true || config.FORCE_HTTPS === 'true') {
    app.use(function (req, res, next) {
      if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
        return next();
      }
      res.redirect(301, 'https://' + req.headers.host + req.url);
    });
  }

  // Response compression (gzip/brotli) — shrinks dashboard.js ~5x on the wire
  app.use(compression());

  // Request correlation ID — assign once per request and bind via
  // AsyncLocalStorage so every log line inside the request chain (route,
  // module call, await callback) shares it. Reuses an incoming
  // X-Request-Id if the upstream proxy supplied one; else randoms 6 bytes.
  var requestCtx = require('./utils/request-context');
  var crypto = require('crypto');
  app.use(function (req, res, next) {
    var incoming = req.headers['x-request-id'];
    var rid = (typeof incoming === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(incoming))
      ? incoming
      : crypto.randomBytes(6).toString('hex');
    res.setHeader('X-Request-Id', rid);
    requestCtx.run({ requestId: rid }, next);
  });

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"]
      }
    }
  }));

  // CORS — same origin only
  app.use(cors({ origin: false }));

  // Rate limiting — public API (widget embeds; higher limit)
  app.use('/api/public/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3000,
    message: { error: 'Too many requests' }
  }));

  // Rate limiting — authenticated API
  app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { error: 'Too many requests' }
  }));

  // Rate limiting — login (stricter)
  app.use('/login', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    message: { error: 'Too many login attempts' }
  }));

  // Body limits — manual-import accepts up to 100 URLs at once, but the
  // largest realistic settings save is well under 256 KB. 2 MB on JSON
  // gives headroom for bulk imports without inviting memory abuse from
  // arbitrary giant payloads.
  app.use(express.json({ limit: '2mb' }));
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use(setupSession(db));

  // Public health check for uptime monitors and load balancers.
  // Mounted BEFORE checkAuth so external probes don't need a session.
  // Returns 200 OK if the Node process is alive and SQLite responds to a
  // trivial query; 503 otherwise. No body leakage — just status.
  app.get('/healthz', function (req, res) {
    try {
      db.prepare('SELECT 1 AS ok').get();
      res.status(200).json({ ok: true, uptime: Math.round(process.uptime()) });
    } catch (e) {
      res.status(503).json({ ok: false });
    }
  });

  // Dashboard routes (/, /login, /logout)
  var dashboardRouter = createDashboardRouter();
  app.use(dashboardRouter);

  // API routes — protected by checkAuth
  var apiRouter = createApiRouter({
    feedsPool: feedsPool,
    publisherPool: publisherPool,
    trends: trends,
    buffer: buffer,
    similarity: similarity,
    extractor: extractor,
    rewriter: rewriter,
    publisher: publisher,
    scheduler: scheduler,
    infranodus: infranodus,
    db: db,
    logger: logger,
  });
  var publicRouter = require('./routes/public')(db);
  app.use('/api/public', publicRouter);
  app.use('/api', checkAuth, verifyCsrf, apiRouter);

  // Static assets — accessible without auth for login page to work
  app.use('/css', express.static(path.resolve(__dirname, '..', 'public', 'css')));
  app.use('/js', express.static(path.resolve(__dirname, '..', 'public', 'js')));
  app.use('/img', express.static(path.resolve(__dirname, '..', 'public', 'img')));
  app.use('/fonts', express.static(path.resolve(__dirname, '..', 'public', 'fonts')));
  app.use('/wp-assets', express.static(path.resolve(__dirname, '..', 'public', 'wp-assets')));

  // Global error handler — NEVER expose stack traces.
  //
  // Routes throw `httpError(status, msg)` (or any Error with `statusCode`)
  // and we map that to a safe response here. 4xx with `expose !== false`
  // is echoed verbatim; everything else collapses to "Internal server
  // error" so SQL fragments, hostnames, and SDK error codes never leak.
  // The original message is always logged for debugging.
  app.use(function(err, req, res, next) {
    var safe = sanitizeForClient(err);
    if (safe.status >= 500) {
      logger.error('express', (req.method || '?') + ' ' + (req.originalUrl || req.url) + ' — ' + (err && err.message));
      if (err && err.stack) logger.error('express', err.stack);
    } else {
      logger.warn('express', (req.method || '?') + ' ' + (req.originalUrl || req.url) + ' → ' + safe.status + ' ' + (err && err.message));
    }
    res.status(safe.status).json({ success: false, error: safe.message });
  });

  // ─── Start server ────────────────────────────────────────────────────────

  var PORT = config.PORT || 3000;
  var server = app.listen(PORT, function() {
    logger.info('index', 'Express server listening on port ' + PORT);

    // Log module health summary. feedsPool returns an array (one entry per
    // active feed) — reported separately so its shape doesn't collide with
    // the per-module `{ module, status }` objects the others return.
    if (feedsPool && typeof feedsPool.getHealth === 'function') {
      var fpHealth = feedsPool.getHealth() || [];
      logger.info('index', 'feeds-pool: ' + fpHealth.length + ' listener(s)');
    }
    var modules = [trends, buffer, similarity, extractor, rewriter, publisher, infranodus, fuel, metals, lottery];
    for (var i = 0; i < modules.length; i++) {
      if (modules[i] && typeof modules[i].getHealth === 'function') {
        var h = modules[i].getHealth();
        if (h && h.module) logger.info('index', h.module + ': ' + h.status);
      }
    }
  });

  // ─── Start scheduler ────────────────────────────────────────────────────

  scheduler.start();
  logger.info('index', 'Pipeline V2 workers started (extract:15 rewrite:3 publish:rate-limited)');

  // ─── Periodic buffer cleanup ─────────────────────────────────────────────

  var CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
  var cleanupTimer = setInterval(function() {
    try {
      buffer.cleanOldArticles();
    } catch (err) {
      logger.error('index', 'Buffer cleanup failed', err.message);
    }
  }, CLEANUP_INTERVAL_MS);

  logger.info('index', 'HDF News AutoPub started successfully');

  // ─── Memory watchdog — pause all feeds if RAM gets critical ──────────────
  var MEMORY_CHECK_INTERVAL_MS = 30000;
  var MEMORY_HIGH_WATER_MB = 400;
  var MEMORY_LOW_WATER_MB = 300;
  var _feedsPaused = false;

  var memoryWatchdog = setInterval(function() {
    try {
      var usage = process.memoryUsage();
      var heapMB = Math.round(usage.heapUsed / 1024 / 1024);
      var rssMB = Math.round(usage.rss / 1024 / 1024);

      if (heapMB > MEMORY_HIGH_WATER_MB && !_feedsPaused) {
        _feedsPaused = true;
        logger.warn('index', 'MEMORY HIGH: ' + heapMB + 'MB heap, ' + rssMB + 'MB RSS — pausing feeds pool');
        if (feedsPool && typeof feedsPool.shutdown === 'function') feedsPool.shutdown();
        if (global.gc) global.gc();
      } else if (heapMB < MEMORY_LOW_WATER_MB && _feedsPaused) {
        _feedsPaused = false;
        logger.info('index', 'MEMORY OK: ' + heapMB + 'MB heap — resuming feeds pool');
        if (feedsPool && typeof feedsPool.init === 'function') {
          feedsPool.init().catch(function (e) {
            logger.error('index', 'Feeds pool resume failed: ' + e.message);
          });
        }
      }

      if (heapMB > 200) {
        logger.debug('index', 'Memory: heap=' + heapMB + 'MB rss=' + rssMB + 'MB');
      }
    } catch (err) {
      logger.error('index', 'Memory watchdog error: ' + err.message);
    }
  }, MEMORY_CHECK_INTERVAL_MS);

  // ─── Graceful shutdown ───────────────────────────────────────────────────

  var _shuttingDown = false;
  function shutdown(signal) {
    if (_shuttingDown) return;
    _shuttingDown = true;
    logger.info('index', 'Received ' + signal + ', shutting down...');

    clearInterval(cleanupTimer);
    clearInterval(memoryWatchdog);

    // Stop accepting new connections and wait for in-flight requests to
    // drain. Only AFTER that do we shut modules down and close the DB —
    // otherwise express-session's end-of-response touch() tries to
    // UPDATE sessions against a closed connection and spams the logs
    // with "database connection is not open" stack traces.
    server.close(function() {
      logger.info('index', 'HTTP server closed');
      try {
        var shutdownList = [feedsPool, trends, scheduler, extractor, infranodus, similarity, fuel, metals, lottery];
        for (var i = 0; i < shutdownList.length; i++) {
          try {
            if (shutdownList[i] && shutdownList[i].shutdown) shutdownList[i].shutdown();
            else if (shutdownList[i] && shutdownList[i].stop) shutdownList[i].stop();
          } catch (err) {
            logger.error('index', 'Error shutting down module', err.message);
          }
        }
        try { closeDb(); } catch (err) { logger.error('index', 'Error closing db', err.message); }
      } finally {
        setTimeout(function() { process.exit(0); }, 200);
      }
    });

    // Hard timeout guard: if a request hangs and server.close() never
    // fires its callback, we still exit cleanly after 10s so PM2 can
    // restart us. unref() keeps this timer from blocking exit itself.
    setTimeout(function() {
      logger.warn('index', 'Shutdown timed out after 10s, force-exiting');
      try { closeDb(); } catch (_e) {}
      process.exit(1);
    }, 10000).unref();
  }

  process.on('SIGTERM', function() { shutdown('SIGTERM'); });
  process.on('SIGINT', function() { shutdown('SIGINT'); });

  // ─── Resilient error handlers ────────────────────────────────────────────
  var _uncaughtCount = 0;
  var _MAX_UNCAUGHT = 5;
  var _uncaughtResetTimer = null;

  process.on('uncaughtException', function(err) {
    _uncaughtCount++;
    logger.error('index', 'Uncaught exception #' + _uncaughtCount + ': ' + (err.stack || err.message));
    if (!_uncaughtResetTimer) {
      _uncaughtResetTimer = setTimeout(function() {
        _uncaughtCount = 0;
        _uncaughtResetTimer = null;
      }, 60000);
    }
    if (_uncaughtCount >= _MAX_UNCAUGHT) {
      logger.error('index', 'Too many uncaught exceptions (' + _uncaughtCount + ' in 60s) — shutting down');
      shutdown('uncaughtException');
    }
  });

  process.on('unhandledRejection', function(reason) {
    var msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
    logger.error('index', 'Unhandled promise rejection: ' + msg);
  });

  return { app: app, server: server };
}

boot().catch(function(err) {
  console.error('FATAL: Boot failed:', err);
  process.exit(1);
});
