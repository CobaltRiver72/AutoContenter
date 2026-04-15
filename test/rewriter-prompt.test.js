'use strict';

// Rewriter master-prompt test — verifies that the author and category slug
// lists baked into the system prompt are driven by the admin-imported
// CLASSIFIER_AUTHOR_DICTIONARIES / CLASSIFIER_CATEGORY_DICTIONARIES settings.
//
// Before this suite existed the slug lists were hardcoded inside the prompt,
// so admin-imported authors were silently ignored at rewrite time. These
// tests lock in the dynamic-lookup behavior by stubbing config.get() and
// asserting the built prompt string contains the expected slugs (and does
// NOT contain the legacy slugs when a custom roster is active).
//
// This test does not require API keys — it calls the prompt-builder
// directly, never hitting any AI provider.

var fs = require('fs');
var path = require('path');
var os = require('os');
var test = require('node:test');
var assert = require('node:assert/strict');

// ─── Isolated DB setup — must run BEFORE any project module is required ────

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdf-prompt-test-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.DASHBOARD_PASSWORD = 'test-only-not-real';

// Load the config module first so we can monkey-patch its get() for the
// duration of each test. rewriter.js captures the same object reference via
// its module-level require, so mutating this object affects the helper's
// lookup path directly.
var configMod = require('../src/utils/config');
var rewriterMod = require('../src/modules/rewriter');
var buildPrompt = rewriterMod.buildPrompt;

// ─── Helpers ────────────────────────────────────────────────────────────────

function _withMockConfig(mockMap, fn) {
  var originalGet = configMod.get;
  configMod.get = function (k) {
    if (Object.prototype.hasOwnProperty.call(mockMap, k)) return mockMap[k];
    return originalGet.call(configMod, k);
  };
  try {
    return fn();
  } finally {
    configMod.get = originalGet;
  }
}

function _fakeArticle() {
  return {
    title: 'Fake test article title',
    url: 'https://example.com/fake',
    domain: 'example.com',
    extracted_content: 'A short piece of test content that mentions a price of 100 and a date 2026-04-15.',
    language: 'en',
  };
}

function _fakeCluster() {
  return { articles: [_fakeArticle()], trends_boosted: false };
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('prompt falls back to hardcoded 5 authors when setting is empty', function () {
  _withMockConfig({
    CLASSIFIER_AUTHOR_DICTIONARIES: '',
    CLASSIFIER_CATEGORY_DICTIONARIES: '',
  }, function () {
    var prompt = buildPrompt(_fakeArticle(), _fakeCluster(), {});
    assert.ok(prompt.indexOf('priya-mehta') !== -1, 'prompt should contain priya-mehta');
    assert.ok(prompt.indexOf('arjun-sharma') !== -1, 'prompt should contain arjun-sharma');
    assert.ok(prompt.indexOf('rahul-desai') !== -1, 'prompt should contain rahul-desai');
    assert.ok(prompt.indexOf('deepa-nair') !== -1, 'prompt should contain deepa-nair');
    assert.ok(prompt.indexOf('karan-verma') !== -1, 'prompt should contain karan-verma');
  });
});

test('prompt falls back to hardcoded 6 categories when setting is empty', function () {
  _withMockConfig({
    CLASSIFIER_AUTHOR_DICTIONARIES: '',
    CLASSIFIER_CATEGORY_DICTIONARIES: '',
  }, function () {
    var prompt = buildPrompt(_fakeArticle(), _fakeCluster(), {});
    assert.ok(prompt.indexOf('entertainment') !== -1, 'prompt should contain entertainment');
    assert.ok(prompt.indexOf('cricket') !== -1, 'prompt should contain cricket');
    assert.ok(prompt.indexOf('auto') !== -1, 'prompt should contain auto');
    assert.ok(prompt.indexOf('finance') !== -1, 'prompt should contain finance');
    assert.ok(prompt.indexOf('fuel-prices') !== -1, 'prompt should contain fuel-prices');
    assert.ok(prompt.indexOf('gold-silver') !== -1, 'prompt should contain gold-silver');
  });
});

test('prompt uses admin-configured author slugs and omits legacy ones', function () {
  var customAuthors = JSON.stringify({
    'foo': { 'keyword-a': 5 },
    'bar': { 'keyword-b': 5 },
    'baz': { 'keyword-c': 5 },
  });
  _withMockConfig({
    CLASSIFIER_AUTHOR_DICTIONARIES: customAuthors,
    CLASSIFIER_CATEGORY_DICTIONARIES: '',
  }, function () {
    var prompt = buildPrompt(_fakeArticle(), _fakeCluster(), {});
    assert.ok(prompt.indexOf('"foo"') !== -1, 'prompt should contain quoted "foo"');
    assert.ok(prompt.indexOf('"bar"') !== -1, 'prompt should contain quoted "bar"');
    assert.ok(prompt.indexOf('"baz"') !== -1, 'prompt should contain quoted "baz"');
    assert.ok(prompt.indexOf('priya-mehta') === -1, 'prompt should NOT contain priya-mehta');
    assert.ok(prompt.indexOf('arjun-sharma') === -1, 'prompt should NOT contain arjun-sharma');
    assert.ok(prompt.indexOf('rahul-desai') === -1, 'prompt should NOT contain rahul-desai');
    assert.ok(prompt.indexOf('deepa-nair') === -1, 'prompt should NOT contain deepa-nair');
    assert.ok(prompt.indexOf('karan-verma') === -1, 'prompt should NOT contain karan-verma');
  });
});

test('prompt uses admin-configured category slugs and omits legacy ones', function () {
  var customCats = JSON.stringify({
    'tech': { 't1': 5 },
    'politics': { 't2': 5 },
  });
  _withMockConfig({
    CLASSIFIER_AUTHOR_DICTIONARIES: '',
    CLASSIFIER_CATEGORY_DICTIONARIES: customCats,
  }, function () {
    var prompt = buildPrompt(_fakeArticle(), _fakeCluster(), {});
    assert.ok(prompt.indexOf('"tech"') !== -1, 'prompt should contain quoted "tech"');
    assert.ok(prompt.indexOf('"politics"') !== -1, 'prompt should contain quoted "politics"');
    // Legacy category slugs should be gone — check specific fallback-only ones
    assert.ok(prompt.indexOf('fuel-prices') === -1, 'prompt should NOT contain fuel-prices');
    assert.ok(prompt.indexOf('gold-silver') === -1, 'prompt should NOT contain gold-silver');
  });
});

test('prompt falls back to hardcoded slugs when setting JSON is malformed', function () {
  _withMockConfig({
    CLASSIFIER_AUTHOR_DICTIONARIES: '{not valid json',
    CLASSIFIER_CATEGORY_DICTIONARIES: '[]',
  }, function () {
    var prompt = buildPrompt(_fakeArticle(), _fakeCluster(), {});
    assert.ok(prompt.indexOf('priya-mehta') !== -1, 'malformed author json → fallback to priya-mehta');
    // CLASSIFIER_CATEGORY_DICTIONARIES set to [] is an array, not an object, so fallback kicks in
    assert.ok(prompt.indexOf('entertainment') !== -1, 'array-typed category setting → fallback to entertainment');
  });
});

test('prompt falls back when parsed setting is not an object', function () {
  _withMockConfig({
    CLASSIFIER_AUTHOR_DICTIONARIES: '"a-string-value"',
    CLASSIFIER_CATEGORY_DICTIONARIES: '123',
  }, function () {
    var prompt = buildPrompt(_fakeArticle(), _fakeCluster(), {});
    assert.ok(prompt.indexOf('karan-verma') !== -1, 'string-typed author setting → fallback');
    assert.ok(prompt.indexOf('cricket') !== -1, 'number-typed category setting → fallback');
  });
});
