'use strict';

/**
 * Small, focused helpers used by src/routes/api.js. None of these are
 * speculative — every export is consumed by 5+ routes today.
 *
 * Design notes:
 *   - Plain Error + statusCode property (no custom class hierarchy).
 *   - sanitizeForClient hides 5xx internals so SQL fragments, hostnames,
 *     and SDK error codes never leak to the dashboard.
 *   - parseId normalises every `:id` param so routes can fail-fast on
 *     `/api/drafts/foo/...` instead of silently affecting zero rows.
 */

/**
 * Parse a route param into a positive integer.
 * Returns null if the value isn't a finite positive integer.
 */
function parseId(raw) {
  if (raw === null || raw === undefined) return null;
  var n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * Standard success envelope.
 *
 *   ok({ id: 5 })                     → { success: true, data: { id: 5 } }
 *   ok([...drafts])                   → { success: true, data: [...] }
 *   ok({ id: 5 }, { meta: {...} })    → { success: true, data: {...}, meta: {...} }
 *
 * Routes that already shape their own response (e.g. legacy endpoints
 * the dashboard depends on) keep using res.json directly — only adopt
 * `ok()` when touching a route for other reasons.
 */
function ok(data, extra) {
  var body = { success: true, data: data === undefined ? null : data };
  if (extra) {
    var keys = Object.keys(extra);
    for (var i = 0; i < keys.length; i++) body[keys[i]] = extra[keys[i]];
  }
  return body;
}

/**
 * Standard failure envelope. Use for 4xx responses where the message
 * is safe to show the user. For 5xx, prefer httpError() so the client
 * gets a generic message.
 */
function fail(message, extra) {
  var body = { success: false, error: message || 'Request failed' };
  if (extra) {
    var keys = Object.keys(extra);
    for (var i = 0; i < keys.length; i++) body[keys[i]] = extra[keys[i]];
  }
  return body;
}

/**
 * Build an Error object that the global error handler will turn into a
 * proper HTTP response with the given status code.
 *
 *   throw httpError(404, 'Draft not found');
 *   throw httpError(409, 'Already published');
 *
 * The `expose` flag lets the global handler know it's safe to echo
 * the message to the client. Default true for 4xx, false for 5xx.
 */
function httpError(statusCode, message) {
  var err = new Error(message || 'HTTP ' + statusCode);
  err.statusCode = statusCode;
  err.expose = statusCode >= 400 && statusCode < 500;
  return err;
}

/**
 * Wrap an async route handler so rejected promises bubble to the
 * global error handler instead of becoming silent unhandled rejections.
 *
 *   router.post('/drafts', asyncHandler(async function (req, res) {
 *     ...
 *   }));
 *
 * Sync handlers don't need this — they already throw into Express.
 */
function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Decide what error message (if any) to return to the client.
 *
 * - 4xx with `expose === true` (or default-true 4xx): show the message
 * - 5xx or `expose === false`: return a generic message
 *
 * The original message is always preserved for logging by the caller.
 */
function sanitizeForClient(err) {
  var status = (err && err.statusCode) || 500;
  var safeMessage;
  if (status >= 400 && status < 500 && err && err.expose !== false) {
    safeMessage = err.message || 'Bad request';
  } else {
    safeMessage = 'Internal server error';
  }
  return { status: status, message: safeMessage };
}

module.exports = {
  parseId: parseId,
  ok: ok,
  fail: fail,
  httpError: httpError,
  asyncHandler: asyncHandler,
  sanitizeForClient: sanitizeForClient,
};
