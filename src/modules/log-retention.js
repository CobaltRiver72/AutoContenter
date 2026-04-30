'use strict';

// Log retention. Every logger.info / warn / error call inserts into the
// `logs` table. At firehose saturation (~245k articles/day) the table
// would grow to tens of millions of rows in a month and become the
// largest in the DB. This module:
//
//   • prunes rows older than LOG_RETENTION_DAYS every night at 03:00,
//   • runs a VACUUM once a week (Sunday 03:30) to reclaim freelist space,
//
// pruneOldLogs() is exported separately so tests can drive it directly
// against an in-memory DB without needing the cron scheduler.

var cron = require('node-cron');
var { getConfig } = require('../utils/config');

var MODULE = 'log-retention';

/**
 * Delete `logs` rows older than `days` days. Runs in a single SQL
 * statement on the synchronous better-sqlite3 path; for a 1M-row prune
 * this takes single-digit seconds and blocks writes briefly. We accept
 * that — the alternative (chunked deletes in a busy loop) costs more
 * total wall time and produces noisier WAL.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {number} days  - Retention window. <=0 means delete everything.
 * @returns {number} Number of rows deleted.
 */
function pruneOldLogs(db, days) {
  var d = parseInt(days, 10);
  if (!Number.isFinite(d) || d < 0) d = 7;
  var sql = "DELETE FROM logs WHERE created_at < datetime('now', '-' || ? || ' days')";
  var result = db.prepare(sql).run(d);
  return result.changes || 0;
}

/**
 * Reclaim freelist space. VACUUM is expensive (rewrites the entire DB
 * file) so we only call it weekly. better-sqlite3 holds a single
 * connection so VACUUM blocks every other writer for its duration —
 * keep the cron slot off-peak.
 *
 * @param {import('better-sqlite3').Database} db
 */
function vacuumDb(db) {
  db.exec('VACUUM');
}

/**
 * Wire the cron schedules. Idempotent — calling start() twice replaces
 * the existing jobs (each schedule call returns a fresh handle).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} logger - Project logger with .info/.warn/.error
 * @returns {{stop: Function}} Handle whose .stop() detaches both crons.
 */
function start(db, logger) {
  var config = getConfig();
  var retentionDays = parseInt(config.LOG_RETENTION_DAYS, 10);
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) retentionDays = 7;

  // Prune nightly at 03:00 server time — long after publishing peaks and
  // well clear of the daily WP cron windows the verticals run at 06:00–07:30.
  var pruneJob = cron.schedule('0 3 * * *', function () {
    try {
      var t0 = Date.now();
      var removed = pruneOldLogs(db, retentionDays);
      logger.info(MODULE, 'Pruned ' + removed + ' rows older than ' + retentionDays + ' days (' + (Date.now() - t0) + 'ms)');
    } catch (err) {
      logger.error(MODULE, 'Nightly prune failed: ' + err.message);
    }
  });

  // VACUUM once a week. Sunday 03:30 — sits 30 min after the prune so the
  // freelist is at its most-fragmented when we reclaim it.
  var vacuumJob = cron.schedule('30 3 * * 0', function () {
    try {
      var t0 = Date.now();
      vacuumDb(db);
      logger.info(MODULE, 'Weekly VACUUM done (' + (Date.now() - t0) + 'ms)');
    } catch (err) {
      logger.error(MODULE, 'Weekly VACUUM failed: ' + err.message);
    }
  });

  logger.info(MODULE, 'Log retention scheduled: prune daily 03:00, VACUUM weekly Sun 03:30 (retention=' + retentionDays + 'd)');

  return {
    stop: function () {
      try { pruneJob.stop(); } catch (_e) {}
      try { vacuumJob.stop(); } catch (_e) {}
    },
  };
}

module.exports = { pruneOldLogs: pruneOldLogs, vacuumDb: vacuumDb, start: start };
