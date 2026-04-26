'use strict';

// Tests for the pure hash router helpers in public/js/shared-route.js.
// The whole reason that file was extracted from dashboard.js's IIFE is so
// these tests can run in Node — UMD wrapper handles both contexts.

var test = require('node:test');
var assert = require('node:assert/strict');

var { parseRouteHash, buildHash } = require('../public/js/shared-route');

// ─── parseRouteHash ────────────────────────────────────────────────────────

test('parseRouteHash: empty hash → overview, no id', function () {
  assert.deepEqual(parseRouteHash(''),  { page: 'overview', id: null });
  assert.deepEqual(parseRouteHash('#'), { page: 'overview', id: null });
  assert.deepEqual(parseRouteHash(null),     { page: 'overview', id: null });
  assert.deepEqual(parseRouteHash(undefined),{ page: 'overview', id: null });
});

test('parseRouteHash: page-only hash → page, no id', function () {
  assert.deepEqual(parseRouteHash('#editor'),       { page: 'editor', id: null });
  assert.deepEqual(parseRouteHash('#feed-detail'),  { page: 'feed-detail', id: null });
  assert.deepEqual(parseRouteHash('#feeds'),        { page: 'feeds', id: null });
});

test('parseRouteHash: page/id hash → page + integer id', function () {
  assert.deepEqual(parseRouteHash('#editor/47526'),     { page: 'editor', id: 47526 });
  assert.deepEqual(parseRouteHash('#feed-detail/19'),   { page: 'feed-detail', id: 19 });
});

test('parseRouteHash: leading # is optional', function () {
  assert.deepEqual(parseRouteHash('editor/12'),  { page: 'editor', id: 12 });
  assert.deepEqual(parseRouteHash('feeds'),      { page: 'feeds', id: null });
});

test('parseRouteHash: non-numeric trailing segment → id null (no false id)', function () {
  assert.deepEqual(parseRouteHash('#editor/abc'),        { page: 'editor', id: null });
  assert.deepEqual(parseRouteHash('#editor/12abc'),      { page: 'editor', id: null });
  assert.deepEqual(parseRouteHash('#editor/'),           { page: 'editor', id: null });
});

test('parseRouteHash: id parses leading-zero correctly (rejects "01" as an id)', function () {
  // Strict round-trip check: parseInt('01', 10) === 1, but String(1) !== '01'.
  // The parser rejects anything that doesn't survive the round-trip so we
  // never silently change the canonical form of an id.
  assert.deepEqual(parseRouteHash('#editor/01'), { page: 'editor', id: null });
});

test('parseRouteHash: zero is a valid id', function () {
  // Edge case — feed_id=0 wouldn't ever exist in this app (autoincrement
  // starts at 1) but the parser shouldn't have an opinion.
  assert.deepEqual(parseRouteHash('#editor/0'), { page: 'editor', id: 0 });
});

test('parseRouteHash: extra trailing segments are ignored', function () {
  // Defensive — future routes might use deeper paths. Today we just take
  // the first two segments and ignore the rest.
  assert.deepEqual(parseRouteHash('#editor/12/extra/garbage'),
                   { page: 'editor', id: 12 });
});

test('parseRouteHash: result is a plain object (no prototype surprises)', function () {
  var r = parseRouteHash('#editor/12');
  assert.equal(typeof r, 'object');
  assert.equal(Object.keys(r).length, 2);
  assert.ok('page' in r && 'id' in r);
});

// ─── buildHash ─────────────────────────────────────────────────────────────

test('buildHash: page + id → page/id', function () {
  assert.equal(buildHash('editor', 47526),      'editor/47526');
  assert.equal(buildHash('feed-detail', 19),    'feed-detail/19');
});

test('buildHash: omits id when null/undefined', function () {
  assert.equal(buildHash('feeds'),         'feeds');
  assert.equal(buildHash('feeds', null),   'feeds');
  assert.equal(buildHash('overview', undefined), 'overview');
});

test('buildHash: zero id is preserved (matches parseRouteHash invariant)', function () {
  assert.equal(buildHash('editor', 0), 'editor/0');
});

// ─── Round-trip ────────────────────────────────────────────────────────────

test('round-trip: parse(build(p, i)) === { p, i }', function () {
  [
    ['overview', null],
    ['feeds', null],
    ['editor', 47526],
    ['feed-detail', 19],
    ['editor', 0],
  ].forEach(function (pair) {
    var built = '#' + buildHash(pair[0], pair[1]);
    var parsed = parseRouteHash(built);
    assert.equal(parsed.page, pair[0], 'page round-trip ' + built);
    assert.equal(parsed.id, pair[1],   'id round-trip ' + built);
  });
});
