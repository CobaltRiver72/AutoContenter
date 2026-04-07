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

// ─── 6. Async boot ─────────────────────────────────────────────────────────

async function boot() {
  // ─── Wire up event listeners BEFORE any module init ──────────────────────
  // EventEmitter drops events that have no listeners. Firehose.init() opens
  // SSE and replays articles immediately — listeners MUST exist first.

  firehose.on('article', async function(article) {
    try {
      var articleId = buffer.addArticle(article);
      if (!articleId) return; // duplicate or failed insert

      // Attach ID back to article for similarity engine
      article.id = articleId;

      // Only match trends if the module is ready
      var trendsMatch = null;
      if (trends.enabled && trends.ready) {
        trendsMatch = trends.matchArticle(article);
      }

      var bufferArticles = buffer.getRecentArticles(config.BUFFER_HOURS);
      var matches = similarity.findMatches(article, bufferArticles);

      // Debug: Log similarity results for monitoring
      if (matches.length > 0) {
        logger.info('index', 'Similarity matches for "' + (article.title || article.url).substring(0, 60) + '": ' + matches.length + ' match(es), best score: ' + matches[0].score);
      }

      if (matches.length >= config.MIN_SOURCES_THRESHOLD - 1) {
        var cluster = similarity.createOrUpdateCluster(article, matches, trendsMatch);
        if (cluster) {
          logger.info('index', 'Cluster ' + cluster.id + ' ready: "' + (cluster.topic || '').substring(0, 60) + '" (' + cluster.article_count + ' articles)');
          if (similarity.shouldPublish(cluster)) {
            scheduler.enqueue(cluster);
          }
        }
      }
    } catch (err) {
      logger.error('index', 'Error processing firehose article', err.message);
    }
  });

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

  // ─── Graceful shutdown ───────────────────────────────────────────────────

  function shutdown(signal) {
    logger.info('index', 'Received ' + signal + ', shutting down...');

    server.close(function() {
      logger.info('index', 'HTTP server closed');
    });

    clearInterval(cleanupTimer);

    // Shutdown modules
    var shutdownList = [firehose, trends, scheduler, extractor, infranodus];
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
  process.on('uncaughtException', function(err) {
    logger.error('index', 'Uncaught exception', err.stack || err.message);
    shutdown('uncaughtException');
  });
  process.on('unhandledRejection', function(reason) {
    var msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
    logger.error('index', 'Unhandled promise rejection', msg);
  });

  return { app: app, server: server };
}

boot().catch(function(err) {
  console.error('FATAL: Boot failed:', err);
  process.exit(1);
});
