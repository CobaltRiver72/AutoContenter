'use strict';

// Direct unit tests for src/validators/feed.js. Run with `npm test`.
//
// The validator is the single source of truth for "does this payload have
// the minimum required to create a feed". The server hits it inside
// POST /api/feeds; the client mirrors the same rule in the canSubmit gate
// of public/js/create-feed-page.js. Both paths must agree.

var test = require('node:test');
var assert = require('node:assert/strict');

var { validateFeedInput } = require('../src/validators/feed');

// ─── Name requirement ──────────────────────────────────────────────────────

test('rejects missing body', function () {
  var r = validateFeedInput(null);
  assert.equal(r.valid, false);
  assert.match(r.error, /body/i);
});

test('rejects missing name', function () {
  assert.equal(validateFeedInput({ query: 'cars' }).valid, false);
});

test('rejects empty / whitespace name', function () {
  assert.equal(validateFeedInput({ name: '',     query: 'cars' }).valid, false);
  assert.equal(validateFeedInput({ name: '   ',  query: 'cars' }).valid, false);
  assert.equal(validateFeedInput({ name: '\t\n', query: 'cars' }).valid, false);
});

// ─── At-least-one-signal rule ──────────────────────────────────────────────

test('accepts name + query (no domains)', function () {
  var r = validateFeedInput({ name: 'Cars', query: 'electric cars' });
  assert.equal(r.valid, true);
  assert.equal(r.error, null);
});

test('accepts name + include_domains array (no query)', function () {
  var r = validateFeedInput({
    name: 'Cars',
    include_domains: ['hindustantimes.com'],
  });
  assert.equal(r.valid, true);
});

test('accepts name + include_domains as comma-string (no query)', function () {
  // Some legacy callers serialize the array as a comma-string. Must accept.
  var r = validateFeedInput({
    name: 'Cars',
    include_domains: 'hindustantimes.com,timesofindia.indiatimes.com',
  });
  assert.equal(r.valid, true);
});

test('rejects name only (no query, no domains)', function () {
  var r = validateFeedInput({ name: 'Cars' });
  assert.equal(r.valid, false);
  assert.match(r.error, /search query|include-domain/i);
});

test('accepts name + both query and domains', function () {
  var r = validateFeedInput({
    name: 'Cars',
    query: '"electric vehicle"',
    include_domains: ['ndtv.com'],
  });
  assert.equal(r.valid, true);
});

test('time_range and languages do NOT count as primary signals', function () {
  assert.equal(validateFeedInput({ name: 'Cars', time_range: 'past-day' }).valid, false);
  assert.equal(validateFeedInput({ name: 'Cars', allowed_languages: ['en'] }).valid, false);
  assert.equal(validateFeedInput({ name: 'Cars', exclude_domains: ['spammy.com'] }).valid, false);
});

// ─── Edge cases — falsy / blank / whitespace inputs ────────────────────────

test('whitespace-only query does NOT count', function () {
  assert.equal(validateFeedInput({ name: 'Cars', query: '   ' }).valid, false);
});

test('empty include_domains array does NOT count', function () {
  assert.equal(validateFeedInput({ name: 'Cars', include_domains: [] }).valid, false);
});

test('include_domains array of empty strings does NOT count', function () {
  // The chip-input UI can leave [''] after deletes if not normalized — make
  // sure that doesn't accidentally pass validation.
  assert.equal(validateFeedInput({ name: 'Cars', include_domains: ['', '  '] }).valid, false);
});

// ─── Nested source_config shape (matches the API wire format) ──────────────

test('accepts nested source_config.query', function () {
  var r = validateFeedInput({
    name: 'Cars',
    source_config: { query: 'electric' },
  });
  assert.equal(r.valid, true);
});

test('accepts nested source_config.include_domains', function () {
  var r = validateFeedInput({
    name: 'Cars',
    source_config: { include_domains: ['ndtv.com'] },
  });
  assert.equal(r.valid, true);
});

test('rejects nested source_config with only time_range', function () {
  var r = validateFeedInput({
    name: 'Cars',
    source_config: { time_range: 'past-week', allowed_languages: ['en'] },
  });
  assert.equal(r.valid, false);
});

// ─── Error message shape (UI surfaces this verbatim) ──────────────────────

test('name-missing error mentions "name"', function () {
  var r = validateFeedInput({ query: 'cars' });
  assert.match(r.error, /name/i);
});

test('no-signal error mentions both options', function () {
  var r = validateFeedInput({ name: 'Cars' });
  assert.match(r.error, /search query/i);
  assert.match(r.error, /include-domain/i);
});
