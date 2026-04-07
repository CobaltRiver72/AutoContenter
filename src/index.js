'use strict';

var path = require('path');
var express = require('express');
var helmet = require('helmet');
var cors = require('cors');
var rateLimit = require('express-rate-limit');

// ─── 1. Load config (validates env vars, loads .env) ────────────────────────
var { getConfig, loadRuntimeOverrides } = require('./utils/config');
var config = getConfig();

// ─── 2. Initialize SQLite database (runs migrations on require) ─────────────
var { db, closeDb, recoverStuckDrafts } = require('./utils/db');

// ─── 3. Initialize logger, set db reference ────────────────────────────────
var logger = require('./utils/logger');
logger.setDb(db);

// ─── 4. Load runtime config overrides from DB ──────────────────────────────
loadRuntimeOverrides(db);
config = getConfig();

// ─── 5. Create module instances ─────────────────────────────────────────────
var { FirehoseListener } = require('./modules/firehose');
var { TrendsPoller } = require('./modules/trends');
var { ArticleBuffer } = require('./modules/buffer');
var { SimilarityEngine } = require('./modules/similarity');
var { ArticleRewriter } = require('./modules/rewriter');
var { WordPressPublisher } = require('./modules/publisher');
var { PublishScheduler } = require('./modules/scheduler');
var { ContentExtractor } = require('./modules/extractor');
var { InfranodusAnalyzer } = require('./modules/infranodus');
var { setupSession, checkAuth } = require('./routes/auth');
var createApiRouter = require('./routes/api');
var createDashboardRouter = require('./routes/dashboard');

var firehose = new FirehoseListener(config, db, logger);
var trends = new TrendsPoller(config, db, logger);
var buffer = new ArticleBuffer(config, db, logger);
var similarity = new SimilarityEngine(config, db, logger);
var rewriter = new ArticleRewriter(config, logger);
var publisher = new WordPressPublisher(config, logger);
var extractor = new ContentExtractor(config, db, logger);
var scheduler = new PublishScheduler(config, db, rewriter, publisher, logger, extractor);
var infranodus = new InfranodusAnalyzer(config, db, logger);

// ─── 6. Clustering queue (debounce rapid SSE events) ──────────────────────
var _clusteringQueue = [];
var _clusteringTimer = null;
var _clusteringProcessing = false;
var CLUSTERING_DEBOUNCE_MS = 3000;
var CLUSTERING_MAX_WAIT_MS = 10000;
var _clusteringFirstEventAt = null;

async function boot() {
  // ─── Wire up event listeners BEFORE any module init ──────────────────────
  // EventEmitter drops events that have no listeners. Firehose.init() opens
  // SSE and replays articles immediately — listeners MUST exist first.

  firehose.on('article', async function(article) {
    try {
      var articleId = buffer.addArticle(article);
      if (!articleId) return; // duplicate or failed insert
      // buffer.addArticle() now attaches id + fingerprint to article object

      // Only match trends if the module is ready
      var trendsMatch = null;
      if (trends.enabled && trends.ready) {
        trendsMatch = trends.matchArticle(article);
      }

      // Queue article for batch similarity processing instead of immediate
      _clusteringQueue.push({ article: article, trendsMatch: trendsMatch });

      if (!_clusteringFirstEventAt) {
        _clusteringFirstEventAt = Date.now();
      }

      if (_clusteringTimer) clearTimeout(_clusteringTimer);

      // Force process if we've been waiting too long
      var waitedMs = Date.now() - _clusteringFirstEventAt;
      if (waitedMs >= CLUSTERING_MAX_WAIT_MS) {
        processSimilarityBatch();
      } else {
        _clusteringTimer = setTimeout(processSimilarityBatch, CLUSTERING_DEBOUNCE_MS);
      }
    } catch (err) {
      logger.error('index', 'Error buffering firehose article: ' + err.message);
    }
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
        config.BUFFER_HOURS,
        config.MAX_BUFFER_FOR_SIMILARITY || 100
      );

      for (var i = 0; i < batch.length; i++) {
        var item = batch[i];
        var article = item.article;

        try {
          logger.debug('index', 'Clustering: article #' + article.id +
            ' fp=' + (article.fingerprint ? article.fingerprint.length + ' chars' : 'NONE') +
            ', buffer=' + bufferArticles.length + ' articles');

          var matches = await similarity.findMatchesAsync(article, bufferArticles);

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
              if (similarity.shouldPublish(cluster)) {
                scheduler.enqueue(cluster);
              }
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
  // Buffer & similarity MUST be ready before firehose connects (replay articles
  // arrive immediately). Firehose & trends start last.
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
  logger.info('index', 'All downstream modules ready. Starting firehose...');
  // Firehose opens SSE — replay articles flow into listeners above
  await firehose.init();
  await trends.init();
  logger.info('index', 'All modules initialized');

  // ─── Set up Express with security ────────────────────────────────────────

  var app = express();

  // Expose modules for performance monitoring endpoint
  app.locals.modules = {
    firehose: firehose, trends: trends, buffer: buffer, similarity: similarity,
    extractor: extractor, rewriter: rewriter, publisher: publisher,
    scheduler: scheduler, infranodus: infranodus,
  };

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

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"]
      }
    }
  }));

  // CORS — same origin only
  app.use(cors({ origin: false }));

  // Rate limiting — general API
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

  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use(setupSession(db));

  // Dashboard routes (/, /login, /logout)
  var dashboardRouter = createDashboardRouter();
  app.use(dashboardRouter);

  // API routes — protected by checkAuth
  var apiRouter = createApiRouter({
    firehose: firehose,
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
  app.use('/api', checkAuth, apiRouter);

  // Static assets — accessible without auth for login page to work
  app.use('/css', express.static(path.resolve(__dirname, '..', 'public', 'css')));
  app.use('/js', express.static(path.resolve(__dirname, '..', 'public', 'js')));
  app.use('/img', express.static(path.resolve(__dirname, '..', 'public', 'img')));
  app.use('/fonts', express.static(path.resolve(__dirname, '..', 'public', 'fonts')));

  // Global error handler — NEVER expose stack traces
  app.use(function(err, req, res, next) {
    logger.error('express', err.message);
    res.status(500).json({ error: 'Internal server error' });
  });

  // ─── Start server ────────────────────────────────────────────────────────

  var PORT = config.PORT || 3000;
  var server = app.listen(PORT, function() {
    logger.info('index', 'Express server listening on port ' + PORT);

    // Log module health summary
    var modules = [firehose, trends, buffer, similarity, extractor, rewriter, publisher, infranodus];
    for (var i = 0; i < modules.length; i++) {
      var h = modules[i].getHealth();
      logger.info('index', h.module + ': ' + h.status);
    }
  });

  // ─── Start scheduler ────────────────────────────────────────────────────

  scheduler.start();
  logger.info('index', 'Publish scheduler started');

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

  // ─── Memory watchdog — pause firehose if RAM gets critical ──────────────
  var MEMORY_CHECK_INTERVAL_MS = 30000;
  var MEMORY_HIGH_WATER_MB = 400;
  var MEMORY_LOW_WATER_MB = 300;
  var _firehosePaused = false;

  var memoryWatchdog = setInterval(function() {
    try {
      var usage = process.memoryUsage();
      var heapMB = Math.round(usage.heapUsed / 1024 / 1024);
      var rssMB = Math.round(usage.rss / 1024 / 1024);

      if (heapMB > MEMORY_HIGH_WATER_MB && !_firehosePaused) {
        _firehosePaused = true;
        logger.warn('index', 'MEMORY HIGH: ' + heapMB + 'MB heap, ' + rssMB + 'MB RSS — pausing firehose');
        if (firehose.disconnect) firehose.disconnect();
        if (global.gc) global.gc();
      } else if (heapMB < MEMORY_LOW_WATER_MB && _firehosePaused) {
        _firehosePaused = false;
        logger.info('index', 'MEMORY OK: ' + heapMB + 'MB heap — resuming firehose');
        if (firehose.connect) firehose.connect();
      }

      if (heapMB > 200) {
        logger.debug('index', 'Memory: heap=' + heapMB + 'MB rss=' + rssMB + 'MB');
      }
    } catch (err) {
      logger.error('index', 'Memory watchdog error: ' + err.message);
    }
  }, MEMORY_CHECK_INTERVAL_MS);

  // ─── Graceful shutdown ───────────────────────────────────────────────────

  function shutdown(signal) {
    logger.info('index', 'Received ' + signal + ', shutting down...');

    server.close(function() {
      logger.info('index', 'HTTP server closed');
    });

    clearInterval(cleanupTimer);
    clearInterval(memoryWatchdog);

    // Shutdown modules
    var shutdownList = [firehose, trends, scheduler, extractor, infranodus, similarity];
    for (var i = 0; i < shutdownList.length; i++) {
      try {
        if (shutdownList[i].shutdown) shutdownList[i].shutdown();
        else if (shutdownList[i].stop) shutdownList[i].stop();
      } catch (err) {
        logger.error('index', 'Error shutting down module', err.message);
      }
    }

    try { closeDb(); } catch (err) { logger.error('index', 'Error closing db', err.message); }

    setTimeout(function() { process.exit(0); }, 500);
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
