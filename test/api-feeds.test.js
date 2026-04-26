'use strict';

// Integration test for POST /api/feeds. Boots a minimal Express app with
// just the API router mounted (no checkAuth / verifyCsrf — those are
// orthogonal to feed-validation behavior and have their own test surface).
// Uses Node's built-in fetch so we don't add supertest as a dep.
//
// Why a real Express server: the validator unit tests at
// test/feed-validator.test.js cover the rule itself; this file proves the
// route handler actually CALLS the validator and returns the right shape.

var fs = require('fs');
var path = require('path');
var os = require('os');
var test = require('node:test');
var assert = require('node:assert/strict');

// Isolated DB — must be wired up BEFORE any project module is required,
// matching publish-rule-engine.test.js's pattern.
var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdf-api-feeds-test-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.DASHBOARD_PASSWORD = 'test-only-not-real';
process.env.FIREHOSE_MANAGEMENT_KEY = ''; // ensure willAutoProvision = false

var express = require('express');
var dbModule = require('../src/utils/db');
var db = dbModule.db;
var siteConfigMod = require('../src/utils/site-config');
siteConfigMod.init(db);

var createApiRouter = require('../src/routes/api');

// ─── Test app setup ────────────────────────────────────────────────────────

// No-op logger — silences route-handler chatter.
var logger = {
  info:  function () {}, warn: function () {}, error: function () {},
  debug: function () {}, forSite: function () { return logger; },
};

// Stub modules — POST /api/feeds only uses feedsPool.addFeed; everything
// else is referenced via deps but never called in the create flow.
var feedsPoolStub = { addFeed: function () { return Promise.resolve(); } };

// Patch app.locals.modules so the route handlers that read
// req.app.locals.modules.feedsPool find the stub.
function buildTestApp() {
  var app = express();
  app.use(express.json());
  app.locals.modules = { feedsPool: feedsPoolStub };
  app.use('/api', createApiRouter({
    feedsPool: feedsPoolStub,
    publisherPool: {},
    trends: {},
    buffer: {},
    similarity: {},
    extractor: {},
    rewriter: {},
    publisher: {},
    scheduler: {},
    infranodus: {},
    db: db,
    logger: logger,
  }));
  return app;
}

// Listen on a random port and return { port, close }.
function startServer(app) {
  return new Promise(function (resolve) {
    var server = app.listen(0, '127.0.0.1', function () {
      resolve({
        port: server.address().port,
        close: function () { return new Promise(function (r) { server.close(r); }); },
      });
    });
  });
}

// Convenience POST helper.
function postFeed(port, body) {
  return fetch('http://127.0.0.1:' + port + '/api/feeds', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(function (r) {
    return r.json().then(function (json) {
      return { status: r.status, body: json };
    });
  });
}

// Reset between tests so feed-name uniqueness doesn't bite.
function reset() {
  db.prepare("DELETE FROM feeds WHERE name LIKE 'apitest_%'").run();
}

// Make sure site_id=1 exists (the default site is seeded by migrations,
// but we're paranoid — one of the migrations might not run on a fresh DB).
function ensureDefaultSite() {
  var row = db.prepare('SELECT id FROM sites WHERE id = 1').get();
  if (!row) {
    siteConfigMod.createSite({ name: 'Test Site', slug: 'test' });
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('POST /api/feeds: { name, query } → 200', async function () {
  ensureDefaultSite();
  reset();
  var srv = await startServer(buildTestApp());
  try {
    var res = await postFeed(srv.port, {
      site_id: 1,
      name: 'apitest_query_only',
      kind: 'firehose',
      source_config: { query: 'electric vehicles' },
    });
    assert.equal(res.status, 200, 'expected 200, got ' + res.status + ' body=' + JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.ok(res.body.feed && res.body.feed.id, 'response should include the new feed');
  } finally {
    await srv.close();
  }
});

test('POST /api/feeds: { name, include_domains: ["x.com"] } → 200', async function () {
  ensureDefaultSite();
  reset();
  var srv = await startServer(buildTestApp());
  try {
    var res = await postFeed(srv.port, {
      site_id: 1,
      name: 'apitest_domain_only',
      kind: 'firehose',
      source_config: { include_domains: ['hindustantimes.com'] },
    });
    assert.equal(res.status, 200, JSON.stringify(res));
    assert.equal(res.body.ok, true);
  } finally {
    await srv.close();
  }
});

test('POST /api/feeds: name only → 400 with the expected message', async function () {
  ensureDefaultSite();
  reset();
  var srv = await startServer(buildTestApp());
  try {
    var res = await postFeed(srv.port, {
      site_id: 1,
      name: 'apitest_name_only',
      kind: 'firehose',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /search query|include-domain/i);
  } finally {
    await srv.close();
  }
});

test('POST /api/feeds: missing name → 400', async function () {
  ensureDefaultSite();
  reset();
  var srv = await startServer(buildTestApp());
  try {
    var res = await postFeed(srv.port, {
      site_id: 1,
      kind: 'firehose',
      source_config: { query: 'electric' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    // The pre-existing _validateFeedBody catches this BEFORE the new
    // content validator runs, so the message comes from the older check.
    // Either ordering produces a 400, which is the test's actual contract.
    assert.match(res.body.error, /name/i);
  } finally {
    await srv.close();
  }
});

test('POST /api/feeds: time-range only (no query, no domains) → 400', async function () {
  // Regression for the spec's "drop time/lang as primary signals" rule —
  // the older `willAutoProvision && !luceneQuery` gate accepted
  // time-range-only feeds; the new rule rejects them unconditionally.
  ensureDefaultSite();
  reset();
  var srv = await startServer(buildTestApp());
  try {
    var res = await postFeed(srv.port, {
      site_id: 1,
      name: 'apitest_time_only',
      kind: 'firehose',
      source_config: { time_range: 'past-day' },
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.ok, false);
    assert.match(res.body.error, /search query|include-domain/i);
  } finally {
    await srv.close();
  }
});

test('POST /api/feeds: persists the feed row on success', async function () {
  ensureDefaultSite();
  reset();
  var srv = await startServer(buildTestApp());
  try {
    var res = await postFeed(srv.port, {
      site_id: 1,
      name: 'apitest_persist',
      kind: 'firehose',
      source_config: { query: 'test persist' },
    });
    assert.equal(res.status, 200);
    var row = db.prepare("SELECT id, name FROM feeds WHERE name = 'apitest_persist'").get();
    assert.ok(row, 'feed row should exist after 200 response');
    assert.equal(row.id, res.body.feed.id);
  } finally {
    await srv.close();
  }
});
