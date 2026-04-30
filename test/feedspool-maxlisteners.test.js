'use strict';

// Tests for src/modules/feeds-pool.js — verifies the constructor raises
// the EventEmitter listener ceiling so multiple SSE dashboard tabs don't
// trip the MaxListenersExceededWarning.
//
// Run with `npm test`.

var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('node:crypto');

if (!process.env.SECRETS_ENCRYPTION_KEY) {
  process.env.SECRETS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
}

var FeedsPool = require('../src/modules/feeds-pool');

function makeFakeDb() {
  return {
    prepare: function () {
      return {
        all: function () { return []; },
        get: function () { return null; },
        run: function () { return { changes: 0 }; },
      };
    },
  };
}
function makeLogger() {
  return { info: function () {}, warn: function () {}, error: function () {}, debug: function () {} };
}

test('FeedsPool sets a high maxListeners ceiling', function () {
  var pool = new FeedsPool({}, makeFakeDb(), makeLogger());
  assert.ok(pool.getMaxListeners() >= 50, 'expected >=50 maxListeners, got ' + pool.getMaxListeners());
});

test('FeedsPool can absorb 30 listeners without warning', function () {
  var pool = new FeedsPool({}, makeFakeDb(), makeLogger());

  var warnings = [];
  function onWarn(w) { if (w.name === 'MaxListenersExceededWarning') warnings.push(w); }
  process.on('warning', onWarn);

  try {
    for (var i = 0; i < 30; i++) {
      pool.on('article', function () {});
    }
    // Node fires the warning synchronously the moment the threshold is
    // crossed — by the time addListener returns, we'd already see it.
    assert.equal(warnings.length, 0, 'should not warn at 30 listeners with the bumped ceiling');
  } finally {
    process.removeListener('warning', onWarn);
    pool.removeAllListeners('article');
  }
});
