'use strict';

/**
 * Per-request timing middleware. Measures wall-clock time spent in the
 * request → response cycle and logs it on `res.finish`.
 *
 * Loglevel rules:
 *   • status >= 500           → warn  (server error)
 *   • duration_ms > slowMs    → warn  (slow request — investigate)
 *   • otherwise               → debug (normal traffic, off by default)
 *
 * The middleware is the canary for the event-loop-blocking class of bugs:
 * when buffer/firehose batches saturate the loop, the next request's
 * timing field jumps from <50ms to multi-second. Pair with the warn log
 * to set a Grafana alert on `duration_ms > 1000`.
 *
 * @param {object} logger - Project logger with .warn(module, msg, meta) and .debug(...)
 * @param {object} [opts]
 * @param {number} [opts.slowMs=250] - Log threshold for "slow" warn level
 * @returns {Function} Express middleware
 */
function timingMiddleware(logger, opts) {
  var slowMs = (opts && opts.slowMs) || 250;
  return function (req, res, next) {
    var started = process.hrtime.bigint();
    res.on('finish', function () {
      var ns = process.hrtime.bigint() - started;
      var ms = Number(ns) / 1e6;
      var meta = {
        method: req.method,
        path: req.originalUrl || req.url,
        status: res.statusCode,
        duration_ms: Math.round(ms * 10) / 10,
      };
      var msg = req.method + ' ' + meta.path + ' → ' + res.statusCode + ' ' + meta.duration_ms + 'ms';
      if (res.statusCode >= 500 || ms > slowMs) {
        logger.warn('http', msg, meta);
      } else {
        logger.debug('http', msg, meta);
      }
    });
    next();
  };
}

module.exports = timingMiddleware;
