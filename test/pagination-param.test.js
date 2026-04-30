'use strict';

// Tests for src/utils/pagination.js parsePageParam.
// Run with `npm test`.

var test = require('node:test');
var assert = require('node:assert/strict');
var { parsePageParam } = require('../src/utils/pagination');

function fakeReq(q) { return { query: q }; }

test('accepts snake_case per_page (the user-reported "only 20" path)', function () {
  var p = parsePageParam(fakeReq({ per_page: '50' }), 20);
  assert.equal(p.perPage, 50);
});

test('accepts camelCase perPage (back-compat for legacy callers)', function () {
  var p = parsePageParam(fakeReq({ perPage: '50' }), 20);
  assert.equal(p.perPage, 50);
});

test('snake_case wins over camelCase when both are supplied', function () {
  var p = parsePageParam(fakeReq({ per_page: '40', perPage: '10' }), 20);
  assert.equal(p.perPage, 40);
});

test('falls back to default when neither set', function () {
  var p = parsePageParam(fakeReq({}), 20);
  assert.equal(p.perPage, 20);
  assert.equal(p.page, 1);
});

test('default defaults to 20 when caller omits it', function () {
  var p = parsePageParam(fakeReq({}));
  assert.equal(p.perPage, 20);
});

test('caps at 200 (anti-DoS — no whole-table scans)', function () {
  var p = parsePageParam(fakeReq({ per_page: '999' }), 20);
  assert.equal(p.perPage, 200);
});

test('rejects negative / zero / NaN — falls through to default', function () {
  assert.equal(parsePageParam(fakeReq({ per_page: '-5'  }), 20).perPage, 20);
  assert.equal(parsePageParam(fakeReq({ per_page: '0'   }), 20).perPage, 20);
  assert.equal(parsePageParam(fakeReq({ per_page: 'abc' }), 20).perPage, 20);
});

test('page floors at 1', function () {
  assert.equal(parsePageParam(fakeReq({ page: '0'  }), 20).page, 1);
  assert.equal(parsePageParam(fakeReq({ page: '-3' }), 20).page, 1);
  assert.equal(parsePageParam(fakeReq({ page: 'x'  }), 20).page, 1);
});

test('page parses normal positive integer', function () {
  assert.equal(parsePageParam(fakeReq({ page: '5' }), 20).page, 5);
});

test('empty string per_page is ignored (treated as missing)', function () {
  var p = parsePageParam(fakeReq({ per_page: '', perPage: '30' }), 20);
  assert.equal(p.perPage, 30, 'empty snake_case must fall through to camelCase');
});

test('handles req.query missing entirely', function () {
  var p = parsePageParam({}, 20);
  assert.equal(p.perPage, 20);
  assert.equal(p.page, 1);
});
