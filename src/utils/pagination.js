'use strict';

/**
 * parsePageParam — pull `page` + `perPage` out of an Express req.query.
 *
 * Accepts both `per_page` (snake_case, REST convention) and `perPage`
 * (camelCase, internal convention). Snake_case wins when both are
 * present. Falls back to defaultPerPage when neither is a positive
 * number. Hard-caps perPage at 200 so a malicious or careless client
 * can't OFFSET-scan the entire articles table in one request.
 *
 * History: this used to read only camelCase. Frontend pages were
 * sending `per_page=50` (snake_case), which silently fell through to
 * the default of 20 — the user-reported "only 20 stories" bug.
 *
 * @param {{query: object}} req
 * @param {number} [defaultPerPage=20]
 * @returns {{page: number, perPage: number}}
 */
function parsePageParam(req, defaultPerPage) {
  var q = (req && req.query) || {};
  var page = Math.max(1, parseInt(q.page, 10) || 1);
  var def = defaultPerPage || 20;
  // Snake_case wins — that's what every dashboard page sends today.
  // Falls through to camelCase for any older internal caller still
  // using the legacy spelling.
  var raw = (q.per_page !== undefined && q.per_page !== null && q.per_page !== '')
    ? q.per_page
    : q.perPage;
  var reqPp = parseInt(raw, 10);
  var perPage = (reqPp > 0) ? Math.min(200, reqPp) : def;
  return { page: page, perPage: perPage };
}

module.exports = { parsePageParam: parsePageParam };
