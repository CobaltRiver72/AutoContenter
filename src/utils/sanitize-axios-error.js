'use strict';

/**
 * Reduce an axios error (or any Error) to a log-safe object with no
 * request config, no headers, no Authorization tokens, and no
 * response body that might echo credentials.
 *
 * Output shape is always: { message, status, code, url, method, data }
 * where `data` is a scrubbed slice of the upstream response body (if any).
 *
 * Usage:
 *   logger.error('rewriter', 'Primary failed: ' + sanitizeAxiosError(err).message);
 *   // or
 *   logger.error('rewriter', 'Primary failed', sanitizeAxiosError(err));
 */

var SECRET_PATTERNS = [
  /sk-ant-[a-zA-Z0-9_\-]{10,}/g,
  /sk-or-v1-[a-zA-Z0-9_\-]{10,}/g,
  /sk-[a-zA-Z0-9_\-]{20,}/g,
  /Bearer\s+[a-zA-Z0-9_\-\.]{10,}/gi,
  /fhm_[a-zA-Z0-9_\-]{10,}/g,
  /Basic\s+[A-Za-z0-9+/=]{10,}/gi,
];

function scrubString(s) {
  if (typeof s !== 'string') return s;
  var out = s;
  for (var i = 0; i < SECRET_PATTERNS.length; i++) {
    out = out.replace(SECRET_PATTERNS[i], '[REDACTED]');
  }
  return out;
}

function sanitizeAxiosError(err) {
  if (!err) return { message: 'unknown error' };

  var out = {
    message: scrubString(err.message || String(err)),
    status: null,
    code: err.code || null,
    url: null,
    method: null,
    data: null,
  };

  if (err.response) {
    out.status = err.response.status || null;
    // Response body can contain anything. Take at most 500 chars and
    // scrub before including.
    var body = err.response.data;
    if (body != null) {
      var bodyStr;
      try { bodyStr = typeof body === 'string' ? body : JSON.stringify(body); }
      catch (e) { bodyStr = '[unserializable]'; }
      out.data = scrubString(bodyStr).slice(0, 500);
    }
  }

  if (err.config) {
    // URL and method are safe; headers are NOT.
    out.url = scrubString(err.config.url || '');
    out.method = (err.config.method || '').toUpperCase() || null;
  }

  return out;
}

module.exports = { sanitizeAxiosError: sanitizeAxiosError };
