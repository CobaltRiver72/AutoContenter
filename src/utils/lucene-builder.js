'use strict';

/**
 * lucene-builder — translates a Feed's `source_config` (the dashboard form's
 * structured filters) into a single Lucene query string that Ahrefs Firehose
 * accepts as a rule value.
 *
 * The Ahrefs API supports ClassicQueryParser syntax. See the firehose-api
 * reference for the full schema. Key rules we obey:
 *
 *   • Default field is `added` (inserted diff text) — bare terms search there.
 *   • `recent:Nh|Nd|Nmo` is the built-in recency filter (server-side).
 *   • `domain:…` is a keyword field; wildcards and regex are allowed but
 *     forward slashes must be escaped (`\/`) inside patterns.
 *   • All terms AND together unless explicit OR is used.
 *
 * If every input is empty the feed has no filter at all — rather than install
 * a rule that matches every page in the firehose (hugely wasteful), we return
 * null and let the caller refuse to create the rule.
 */

var TIME_RANGE_MAP = {
  'past-hour':  'recent:1h',
  'past-day':   'recent:24h',
  'past-week':  'recent:7d',
  'past-month': 'recent:30d',
  'past-year':  'recent:365d',
  'any':        null,
};

/**
 * Build a Lucene query from a feed's source_config.
 *
 * @param {object} src - feed.source_config
 * @param {string} [src.query] - whitespace-separated keywords (AND combined)
 * @param {string} [src.time_range] - one of TIME_RANGE_MAP keys
 * @param {string[]} [src.include_domains] - exact domain or "*.example.com" wildcards
 * @param {string[]} [src.exclude_domains] - same shape
 * @returns {string|null} Lucene query string, or null if no filters at all
 */
function buildLuceneQuery(src) {
  if (!src || typeof src !== 'object') return null;

  var clauses = [];

  // ── Keyword terms ────────────────────────────────────────────────────────
  // Split on whitespace; each term becomes a token. We broaden each term
  // to match BOTH `title:term` and bare `term` (which targets the default
  // `added` field, i.e. inserted diff chunks). Without the title fallback,
  // a news story about "cars" whose diff no longer includes the word "cars"
  // (e.g. the crawler caught a later update that didn't re-insert the
  // headline keyword) would silently fail to match — a common failure mode
  // seen in the wild.
  //
  // Phrase queries (admin wrapped a substring in "double quotes") are
  // passed through verbatim — the admin explicitly asked for a phrase.
  if (src.query && typeof src.query === 'string') {
    var q = src.query.trim();
    if (q) {
      if (q.indexOf('"') !== -1) {
        // Phrase: search title and default (added) for the phrase.
        clauses.push('(title:' + q + ' OR ' + q + ')');
      } else {
        var terms = q.split(/\s+/).filter(Boolean);
        if (terms.length === 1) {
          clauses.push('(title:' + terms[0] + ' OR ' + terms[0] + ')');
        } else {
          // Match when all terms appear in title OR all terms appear in added.
          // (title:A AND title:B) OR (A AND B)
          var titleAnd = terms.map(function (t) { return 'title:' + t; }).join(' AND ');
          var bareAnd  = terms.join(' AND ');
          clauses.push('((' + titleAnd + ') OR (' + bareAnd + '))');
        }
      }
    }
  }

  // ── Recency filter ───────────────────────────────────────────────────────
  var timeClause = TIME_RANGE_MAP[src.time_range];
  if (timeClause) clauses.push(timeClause);

  // ── Include domains ──────────────────────────────────────────────────────
  // Admin can list multiple; they OR together (match ANY). Wildcards like
  // "*.example.com" become regex queries on the keyword `domain` field.
  if (Array.isArray(src.include_domains) && src.include_domains.length) {
    var includeClauses = src.include_domains
      .map(_cleanDomain)
      .filter(Boolean)
      .map(_domainClause);
    if (includeClauses.length === 1) {
      clauses.push(includeClauses[0]);
    } else if (includeClauses.length > 1) {
      clauses.push('(' + includeClauses.join(' OR ') + ')');
    }
  }

  // ── Exclude domains ──────────────────────────────────────────────────────
  if (Array.isArray(src.exclude_domains) && src.exclude_domains.length) {
    var excludeClauses = src.exclude_domains
      .map(_cleanDomain)
      .filter(Boolean)
      .map(_domainClause);
    for (var ei = 0; ei < excludeClauses.length; ei++) {
      clauses.push('NOT ' + excludeClauses[ei]);
    }
  }

  if (!clauses.length) return null;
  return clauses.join(' AND ');
}

/**
 * Normalize a domain entry typed by a user:
 *   • lowercase
 *   • trim whitespace
 *   • strip leading scheme if they pasted a URL
 *   • strip trailing slashes/paths
 */
function _cleanDomain(raw) {
  if (raw == null) return '';
  var s = String(raw).trim().toLowerCase();
  if (!s) return '';
  // Strip scheme
  s = s.replace(/^https?:\/\//, '');
  // Strip path + query
  var slashIdx = s.indexOf('/');
  if (slashIdx > -1) s = s.slice(0, slashIdx);
  return s;
}

/**
 * Produce a single Lucene `domain:…` clause for one entry. Literal domains
 * use exact-match. "*.example.com" patterns become a Lucene regex that
 * matches "example.com" and every subdomain.
 */
function _domainClause(d) {
  if (d.indexOf('*.') === 0) {
    var base = d.slice(2);
    // Lucene regex: /.../ delimiters; `.` needs escape for a literal dot;
    // `/` doesn't conflict since we don't have any in a domain.
    var esc = base.replace(/\./g, '\\.');
    return 'domain:/(.*\\.)?' + esc + '/';
  }
  // Plain exact-match. Domain field is keyword-analyzed so this is case-
  // sensitive, but we lowercased on ingest above so that's fine.
  return 'domain:' + d;
}

module.exports = {
  buildLuceneQuery: buildLuceneQuery,
  // Exported for tests
  _cleanDomain: _cleanDomain,
  _domainClause: _domainClause,
};
