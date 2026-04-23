'use strict';

// Unit tests for src/utils/clustering-config.js — specifically the
// getPrefilterFloor() helper added in PR 4. Covers the "loosest across all
// feeds" rule that fixes the SQL pre-filter sharp edge documented in PR 2.
//
// Runs against a fresh temp SQLite DB so real data is untouched. The DB is
// initialised BEFORE the clustering-config module is loaded, matching the
// pattern used by publish-rule-engine.test.js.

var fs = require('fs');
var path = require('path');
var os = require('os');
var test = require('node:test');
var assert = require('node:assert/strict');

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdf-cluster-cfg-test-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.DASHBOARD_PASSWORD = 'test-only-not-real';

// Clear any global-rate settings that might bleed in from the dev env
// so the floor test sees the DEFAULTS-backed globals directly.
var dbModule = require('../src/utils/db');
var db = dbModule.db;

var clusteringConfig = require('../src/utils/clustering-config');
clusteringConfig.init(db);

// ─── Helpers ────────────────────────────────────────────────────────────────

function _clearFeeds() {
  db.prepare('DELETE FROM feeds').run();
  clusteringConfig.invalidateFloorCache();
  clusteringConfig.invalidateClusteringCache();
}

function _insertFeed(quality) {
  var name = '__test_feed_' + Math.random().toString(36).slice(2, 10);
  var info = db.prepare(
    "INSERT INTO feeds (site_id, name, kind, is_active, source_config, dest_config, quality_config) " +
    "VALUES (1, ?, 'firehose', 1, '{}', '{}', ?)"
  ).run(name, JSON.stringify(quality || {}));
  clusteringConfig.invalidateFloorCache();
  return info.lastInsertRowid;
}

function _setGlobalDefaults() {
  // Use DEFAULTS-backed values for globals so tests don't depend on whatever
  // an operator set in the live .env.
  db.prepare("DELETE FROM settings WHERE key IN ('MIN_SOURCES_THRESHOLD', 'SIMILARITY_THRESHOLD')").run();
  clusteringConfig.invalidateFloorCache();
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('getPrefilterFloor: no feeds → returns globals clamped to [1, 0]', function () {
  _setGlobalDefaults();
  _clearFeeds();

  var floor = clusteringConfig.getPrefilterFloor();
  // Config DEFAULTS: MIN_SOURCES_THRESHOLD=2, SIMILARITY_THRESHOLD=0.20
  assert.equal(floor.min_sources, 2);
  assert.equal(floor.similarity_threshold, 0.20);
});

test('getPrefilterFloor: one feed looser than global → returns feed value', function () {
  _setGlobalDefaults();
  _clearFeeds();
  _insertFeed({ min_sources: 1, similarity_threshold: 0.10 });

  var floor = clusteringConfig.getPrefilterFloor();
  assert.equal(floor.min_sources, 1);
  assert.equal(floor.similarity_threshold, 0.10);
});

test('getPrefilterFloor: one feed stricter than global → floor stays at global (min wins)', function () {
  _setGlobalDefaults();
  _clearFeeds();
  _insertFeed({ min_sources: 4, similarity_threshold: 0.50 });

  var floor = clusteringConfig.getPrefilterFloor();
  // Stricter feed (higher value) should NOT tighten the SQL floor — that
  // would silently exclude other feeds' candidates. Floor = minimum across
  // all feeds → globals win when only stricter feeds exist.
  assert.equal(floor.min_sources, 2);
  assert.equal(floor.similarity_threshold, 0.20);
});

test('getPrefilterFloor: multiple feeds, mixed → returns minimum across all', function () {
  _setGlobalDefaults();
  _clearFeeds();
  _insertFeed({ min_sources: 1, similarity_threshold: 0.15 });
  _insertFeed({ min_sources: 3, similarity_threshold: 0.25 });
  _insertFeed({ min_sources: 2, similarity_threshold: 0.40 });

  var floor = clusteringConfig.getPrefilterFloor();
  // Loosest across [1, 3, 2] = 1; loosest across [0.15, 0.25, 0.40] = 0.15.
  assert.equal(floor.min_sources, 1);
  assert.equal(floor.similarity_threshold, 0.15);
});

test('getPrefilterFloor: feed with missing keys falls back to globals for that dimension', function () {
  _setGlobalDefaults();
  _clearFeeds();
  // Feed A sets ONLY similarity; its min_sources comes from globals (2).
  _insertFeed({ similarity_threshold: 0.05 });
  // Feed B sets ONLY min_sources; its similarity comes from globals (0.20).
  _insertFeed({ min_sources: 1 });

  var floor = clusteringConfig.getPrefilterFloor();
  // Effective min_sources: [A=2 (global), B=1] → min = 1
  // Effective similarity:  [A=0.05, B=0.20 (global)] → min = 0.05
  assert.equal(floor.min_sources, 1);
  assert.equal(floor.similarity_threshold, 0.05);
});

test('getPrefilterFloor: NaN / non-finite values fall back to globals for that dimension', function () {
  _setGlobalDefaults();
  _clearFeeds();
  // NaN passes isFinite() → false → helper falls through to globals for BOTH
  // dimensions. Note: JSON.stringify serializes NaN as null, which JSON.parse
  // reads back as null, which is also rejected by our `typeof === 'number'`
  // check. Same result either way.
  _insertFeed({ min_sources: NaN, similarity_threshold: NaN });

  var floor = clusteringConfig.getPrefilterFloor();
  assert.equal(floor.min_sources, 2);
  assert.equal(floor.similarity_threshold, 0.20);
});

test('getPrefilterFloor: negative values are CLAMPED, not rejected (defensive not strict)', function () {
  _setGlobalDefaults();
  _clearFeeds();
  // -5 IS finite, so it enters the comparison. Negative is less than the
  // global (2), so it wins as the loosest. The sanity clamp `Math.max(1, ...)`
  // then floors it at 1. Same for similarity: `Math.max(0, -0.1) = 0`.
  //
  // This is explicit behavior — don't crash on bad admin input, just land
  // on the most permissive floor possible without going below physical
  // sense (min_sources < 1 would match a zero-article cluster).
  _insertFeed({ min_sources: -5, similarity_threshold: -0.1 });

  var floor = clusteringConfig.getPrefilterFloor();
  assert.equal(floor.min_sources, 1, 'negative min_sources clamps to 1');
  assert.equal(floor.similarity_threshold, 0, 'negative similarity clamps to 0');
});

test('getPrefilterFloor: value of 0 is treated as a real, permissive threshold', function () {
  _setGlobalDefaults();
  _clearFeeds();
  // 0 is finite and valid — it means "match anything" for similarity.
  _insertFeed({ min_sources: 1, similarity_threshold: 0 });

  var floor = clusteringConfig.getPrefilterFloor();
  assert.equal(floor.similarity_threshold, 0);
  assert.equal(floor.min_sources, 1);
});

test('getPrefilterFloor: clamps absurd low values (min_sources < 1) to 1', function () {
  _setGlobalDefaults();
  _clearFeeds();
  // 0.5 is finite; after Math.floor → 0 → clamped to 1.
  _insertFeed({ min_sources: 0.5, similarity_threshold: 0.10 });

  var floor = clusteringConfig.getPrefilterFloor();
  assert.equal(floor.min_sources, 1, 'min_sources must not drop below 1');
});

test('getPrefilterFloor: malformed JSON in quality_config is skipped (falls to globals)', function () {
  _setGlobalDefaults();
  _clearFeeds();
  // Write a malformed JSON blob directly so parse fails.
  var info = db.prepare(
    "INSERT INTO feeds (site_id, name, kind, is_active, source_config, dest_config, quality_config) " +
    "VALUES (1, '__malformed', 'firehose', 1, '{}', '{}', '{bogus json')"
  ).run();
  clusteringConfig.invalidateFloorCache();

  var floor = clusteringConfig.getPrefilterFloor();
  // Parse error → treated as empty object → globals for that feed.
  assert.equal(floor.min_sources, 2);
  assert.equal(floor.similarity_threshold, 0.20);

  db.prepare('DELETE FROM feeds WHERE id = ?').run(info.lastInsertRowid);
});

test('getPrefilterFloor: result shape — returns plain object with numeric fields', function () {
  _setGlobalDefaults();
  _clearFeeds();

  var floor = clusteringConfig.getPrefilterFloor();
  assert.equal(typeof floor, 'object');
  assert.equal(typeof floor.min_sources, 'number');
  assert.equal(typeof floor.similarity_threshold, 'number');
  assert.ok(Object.keys(floor).length >= 2);
});
