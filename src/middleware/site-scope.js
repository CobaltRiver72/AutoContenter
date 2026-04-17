'use strict';

/**
 * Express middleware: extracts req.siteId from the request.
 *
 * Resolution order:
 *   1. X-Site-Id header  (set by frontend on every fetchApi call)
 *   2. ?site_id query param  (for direct links / testing)
 *   3. session.activeSiteId  (last site the admin switched to)
 *   4. default: 1
 *
 * Special value 0 means "All Sites" — scoped queries should omit
 * the WHERE site_id = ? clause.
 */
function siteScope(req, res, next) {
  var raw = req.headers['x-site-id'] || req.query.site_id;
  if (raw === undefined || raw === null || raw === '') {
    raw = req.session && req.session.activeSiteId;
  }
  var siteId = parseInt(raw, 10);
  req.siteId = (isNaN(siteId) || siteId < 0) ? 1 : siteId;
  next();
}

module.exports = siteScope;
