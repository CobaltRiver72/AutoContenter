'use strict';

// Tests for src/utils/ttl-cache.js — the helper backing /api/feeds/stats's
// 30-second response cache.
//
// Run with `npm test`.

var test = require('node:test');
var assert = require('node:assert/strict');

var TTLCache = require('../src/utils/ttl-cache');
var { keyForIds } = require('../src/utils/ttl-cache');

test('cache returns same value within TTL', function () {
  var c = new TTLCache(1000);
  c.set('k', { x: 1 });
  assert.deepEqual(c.get('k'), { x: 1 });
});

test('cache expires after TTL window', async function () {
  var c = new TTLCache(40);
  c.set('k', 'v');
  assert.equal(c.get('k'), 'v');
  await new Promise(function (r) { setTimeout(r, 80); });
  assert.equal(c.get('k'), undefined, 'value must be invalidated past the TTL');
});

test('expired entries are evicted from internal store on read', async function () {
  var c = new TTLCache(20);
  c.set('a', 1);
  await new Promise(function (r) { setTimeout(r, 40); });
  c.get('a');
  assert.equal(c.size(), 0, 'expired key must not occupy a slot after a read miss');
});

test('overwriting a key resets the TTL', async function () {
  var c = new TTLCache(60);
  c.set('k', 1);
  await new Promise(function (r) { setTimeout(r, 40); });
  c.set('k', 2);
  await new Promise(function (r) { setTimeout(r, 40); });
  // 80 ms total; original would have expired at 60 ms, the rewrite resets it.
  assert.equal(c.get('k'), 2);
});

test('clear() empties the store', function () {
  var c = new TTLCache(1000);
  c.set('a', 1); c.set('b', 2); c.set('c', 3);
  c.clear();
  assert.equal(c.size(), 0);
  assert.equal(c.get('a'), undefined);
});

test('keyForIds normalises sort order so [3,1,2] === [1,2,3]', function () {
  assert.equal(keyForIds([3, 1, 2]), keyForIds([1, 2, 3]));
  assert.equal(keyForIds([3, 1, 2]), '1,2,3');
});

test('keyForIds sorts numerically (10 > 9)', function () {
  // String sort would put 10 before 9 — numeric sort must not.
  assert.equal(keyForIds([10, 9, 1]), '1,9,10');
});

test('keyForIds drops NaN entries', function () {
  assert.equal(keyForIds([1, 'abc', 2]), '1,2');
});

test('keyForIds returns empty string for empty / non-array input', function () {
  assert.equal(keyForIds([]), '');
  assert.equal(keyForIds(null), '');
  assert.equal(keyForIds('not-an-array'), '');
});
