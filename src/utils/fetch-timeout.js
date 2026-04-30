'use strict';

// fetchWithTimeout — global fetch wrapped in an AbortController.
//
// Bare `await fetch(...)` will hang forever if the remote opens TCP but
// stops sending bytes (slow-loris). With WP cluster locks involved, a
// hung publish keeps the cluster locked and blocks every subsequent
// publish, which is how a single misbehaving WP host quietly stalls the
// pipeline.
//
// Default timeout matches WP_TIMEOUT_MS (60s) so callers that don't
// supply a value get the same envelope as the axios paths.

var DEFAULT_TIMEOUT_MS = 60000;

/**
 * @param {string|URL} url
 * @param {RequestInit} [opts]
 * @param {number} [timeoutMs=60000]
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, opts, timeoutMs) {
  var ms = (typeof timeoutMs === 'number' && timeoutMs > 0) ? timeoutMs : DEFAULT_TIMEOUT_MS;
  var ctl = new AbortController();
  // If the caller already supplied a signal, honour it AND our timeout —
  // either firing aborts the request.
  if (opts && opts.signal) {
    var external = opts.signal;
    if (external.aborted) ctl.abort();
    else external.addEventListener('abort', function () { ctl.abort(); }, { once: true });
  }
  var timer = setTimeout(function () { ctl.abort(); }, ms);
  try {
    return await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchWithTimeout: fetchWithTimeout };
