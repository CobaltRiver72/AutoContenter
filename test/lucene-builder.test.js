'use strict';

// Unit tests for src/utils/lucene-builder. Uses node's built-in test runner
// so no additional dependency is needed — run with `node --test test/`.

var test = require('node:test');
var assert = require('node:assert/strict');

var { buildLuceneQuery, _cleanDomain, _domainClause } = require('../src/utils/lucene-builder');

test('buildLuceneQuery — returns null for empty input', function () {
  assert.equal(buildLuceneQuery({}), null);
  assert.equal(buildLuceneQuery(null), null);
  assert.equal(buildLuceneQuery(undefined), null);
  assert.equal(buildLuceneQuery({ query: '' }), null);
  assert.equal(buildLuceneQuery({ query: '   ' }), null);
});

test('buildLuceneQuery — single bare term searches title AND added', function () {
  // Why: without `title:` fallback, articles whose diff doesn't contain the
  // keyword (common when the crawler picks up a later update) fail to match.
  assert.equal(buildLuceneQuery({ query: 'iphone' }), '(title:iphone OR iphone)');
});

test('buildLuceneQuery — multi-term AND-combined across both fields', function () {
  // ALL terms must appear in title, OR ALL terms must appear in added.
  var out = buildLuceneQuery({ query: 'iphone launch' });
  assert.equal(out, '((title:iphone AND title:launch) OR (iphone AND launch))');
});

test('buildLuceneQuery — phrase (quoted) is passed through to both fields', function () {
  var out = buildLuceneQuery({ query: '"iphone launch"' });
  assert.equal(out, '(title:"iphone launch" OR "iphone launch")');
});

test('buildLuceneQuery — time_range maps to Lucene recent filter', function () {
  assert.equal(buildLuceneQuery({ time_range: 'past-hour' }),  'recent:1h');
  assert.equal(buildLuceneQuery({ time_range: 'past-day' }),   'recent:24h');
  assert.equal(buildLuceneQuery({ time_range: 'past-week' }),  'recent:7d');
  assert.equal(buildLuceneQuery({ time_range: 'past-month' }), 'recent:30d');
  assert.equal(buildLuceneQuery({ time_range: 'past-year' }),  'recent:365d');
  assert.equal(buildLuceneQuery({ time_range: 'any' }),        null);
  // Unknown value → ignored (no recent clause).
  assert.equal(buildLuceneQuery({ time_range: 'garbage' }),    null);
});

test('buildLuceneQuery — single include domain', function () {
  assert.equal(buildLuceneQuery({ include_domains: ['example.com'] }), 'domain:example.com');
});

test('buildLuceneQuery — multiple include domains OR-combined', function () {
  var out = buildLuceneQuery({ include_domains: ['example.com', 'other.net'] });
  assert.equal(out, '(domain:example.com OR domain:other.net)');
});

test('buildLuceneQuery — include wildcard becomes regex covering subdomains', function () {
  var out = buildLuceneQuery({ include_domains: ['*.techcrunch.com'] });
  assert.equal(out, 'domain:/(.*\\.)?techcrunch\\.com/');
});

test('buildLuceneQuery — exclude domains prefixed with NOT', function () {
  var out = buildLuceneQuery({ exclude_domains: ['spam.com', '*.trash.net'] });
  assert.equal(out, 'NOT domain:spam.com AND NOT domain:/(.*\\.)?trash\\.net/');
});

test('buildLuceneQuery — combined full query', function () {
  var out = buildLuceneQuery({
    query: 'iphone launch',
    time_range: 'past-day',
    include_domains: ['techcrunch.com', '*.apple.com'],
    exclude_domains: ['rumor.com'],
  });
  assert.equal(
    out,
    '((title:iphone AND title:launch) OR (iphone AND launch)) AND recent:24h AND (domain:techcrunch.com OR domain:/(.*\\.)?apple\\.com/) AND NOT domain:rumor.com'
  );
});

test('_cleanDomain — strips scheme, path, and lowercases', function () {
  assert.equal(_cleanDomain('https://Example.com/path/to/page'), 'example.com');
  assert.equal(_cleanDomain('http://WWW.example.com'),           'www.example.com');
  assert.equal(_cleanDomain('  example.com  '),                  'example.com');
  assert.equal(_cleanDomain(''),                                 '');
  assert.equal(_cleanDomain(null),                               '');
});

test('_domainClause — literal vs wildcard', function () {
  assert.equal(_domainClause('example.com'),        'domain:example.com');
  assert.equal(_domainClause('*.example.com'),      'domain:/(.*\\.)?example\\.com/');
  assert.equal(_domainClause('*.sub.example.com'),  'domain:/(.*\\.)?sub\\.example\\.com/');
});
