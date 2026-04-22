'use strict';

/**
 * Request-scoped context carrier for correlation IDs (and anything else we
 * later want to stamp onto every log line without threading it manually
 * through every function signature).
 *
 * Built on Node's AsyncLocalStorage — an Express middleware wraps each
 * request in `als.run({ requestId }, next)` and every await chain rooted
 * in that request sees the same store. Code called outside an Express
 * request (workers, pipelines, boot) sees `undefined` and falls through
 * cleanly.
 *
 * Keep the store shape small: adding keys here affects every log line.
 */

const { AsyncLocalStorage } = require('async_hooks');

const als = new AsyncLocalStorage();

/** Run `fn` with `ctx` as the request-scoped store. */
function run(ctx, fn) {
  return als.run(ctx, fn);
}

/** Current store, or an empty object if called outside a request. */
function current() {
  return als.getStore() || {};
}

/** Convenience — just the request ID, or null. */
function requestId() {
  const store = als.getStore();
  return (store && store.requestId) || null;
}

module.exports = { als, run, current, requestId };
