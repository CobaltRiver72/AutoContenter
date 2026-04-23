'use strict';

// Contract test for PR 4's getPrefilterFloor cache invalidation.
//
// The floor is computed by querying every row of `feeds` and taking the
// minimum effective min_sources / similarity_threshold. That query isn't
// cheap, so the helper caches the result with a 5 s TTL (matching the
// resolveClusteringConfig cache so operators only have one mental model).
//
// Callers that mutate feeds.quality_config MUST call invalidateFloorCache()
// so subsequent reads see the change without waiting for the TTL. This
// test documents the contract and will catch any future caller that writes
// quality_config without invalidating.

var fs = require('fs');
var path = require('path');
var os = require('os');
var test = require('node:test');
var assert = require('node:assert/strict');

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdf-prefilter-cache-test-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.DASHBOARD_PASSWORD = 'test-only-not-real';

var dbModule = require('../src/utils/db');
var db = dbModule.db;
var clusteringConfig = require('../src/utils/clustering-config');
clusteringConfig.init(db);

function _reset() {
  db.prepare('DELETE FROM feeds WHERE name LIKE ?').run('__cache_test_%');
  db.prepare("DELETE FROM settings WHERE key IN ('MIN_SOURCES_THRESHOLD','SIMILARITY_THRESHOLD')").run();
  clusteringConfig.invalidateFloorCache();
}

function _insertFeed(quality) {
  return db.prepare(
    "INSERT INTO feeds (site_id, name, kind, is_active, source_config, dest_config, quality_config) " +
    "VALUES (1, '__cache_test_feed', 'firehose', 1, '{}', '{}', ?)"
  ).run(JSON.stringify(quality)).lastInsertRowid;
}

function _updateQuality(feedId, quality) {
  db.prepare('UPDATE feeds SET quality_config = ? WHERE id = ?')
    .run(JSON.stringify(quality), feedId);
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('cache-hit within TTL: repeated reads return the same object', function () {
  _reset();
  _insertFeed({ min_sources: 2, similarity_threshold: 0.20 });

  var first = clusteringConfig.getPrefilterFloor();
  var second = clusteringConfig.getPrefilterFloor();
  // Same reference → cache returned the cached entry, not a fresh computation.
  assert.strictEqual(first, second, 'consecutive calls within TTL must return cached reference');
});

test('stale read: mutation without invalidation keeps the old cached value', function () {
  _reset();
  var feedId = _insertFeed({ min_sources: 2, similarity_threshold: 0.20 });

  var baseline = clusteringConfig.getPrefilterFloor();
  assert.equal(baseline.min_sources, 2);

  // Loosen the feed OUTSIDE the official invalidation path (simulating a
  // buggy caller that forgot to call invalidateFloorCache).
  _updateQuality(feedId, { min_sources: 1, similarity_threshold: 0.05 });

  var stale = clusteringConfig.getPrefilterFloor();
  assert.equal(stale.min_sources, 2, 'cache must still return old value without invalidation');
  assert.equal(stale.similarity_threshold, 0.20);
});

test('post-invalidation read: new floor reflects the mutation', function () {
  _reset();
  var feedId = _insertFeed({ min_sources: 2, similarity_threshold: 0.20 });

  // Warm cache.
  clusteringConfig.getPrefilterFloor();

  _updateQuality(feedId, { min_sources: 1, similarity_threshold: 0.05 });
  clusteringConfig.invalidateFloorCache();

  var fresh = clusteringConfig.getPrefilterFloor();
  assert.equal(fresh.min_sources, 1, 'post-invalidation read must reflect new value');
  assert.equal(fresh.similarity_threshold, 0.05);
});

test('invalidation after feed insert: floor sees the new feed', function () {
  _reset();
  // Warm the empty-feeds case.
  var empty = clusteringConfig.getPrefilterFloor();
  assert.equal(empty.min_sources, 2, 'empty feeds → globals');

  // Add a looser feed WITHOUT invalidating — cache stays stale.
  _insertFeed({ min_sources: 1, similarity_threshold: 0.05 });
  var stale = clusteringConfig.getPrefilterFloor();
  assert.equal(stale.min_sources, 2, 'stale cache still returns globals');

  // Invalidate → next read picks up the new feed.
  clusteringConfig.invalidateFloorCache();
  var fresh = clusteringConfig.getPrefilterFloor();
  assert.equal(fresh.min_sources, 1, 'after invalidation, floor matches new feed');
});

test('invalidation after feed delete: floor tightens back up', function () {
  _reset();
  var feedId = _insertFeed({ min_sources: 1, similarity_threshold: 0.05 });

  // Warm cache with loose feed present.
  var loose = clusteringConfig.getPrefilterFloor();
  assert.equal(loose.min_sources, 1);

  // Delete the loose feed WITHOUT invalidating.
  db.prepare('DELETE FROM feeds WHERE id = ?').run(feedId);
  var stale = clusteringConfig.getPrefilterFloor();
  assert.equal(stale.min_sources, 1, 'stale cache keeps loose value even after delete');

  // Invalidate → no feeds → globals win.
  clusteringConfig.invalidateFloorCache();
  var fresh = clusteringConfig.getPrefilterFloor();
  assert.equal(fresh.min_sources, 2, 'after invalidation, floor tightens to globals');
});

test('init(db) clears the floor cache', function () {
  _reset();
  _insertFeed({ min_sources: 1, similarity_threshold: 0.05 });

  var loose = clusteringConfig.getPrefilterFloor();
  assert.equal(loose.min_sources, 1);

  // init() re-running should clear the cache (covers the memory-watchdog
  // db-swap path where init gets called a second time at runtime).
  db.prepare('DELETE FROM feeds WHERE name LIKE ?').run('__cache_test_%');
  clusteringConfig.init(db);

  var fresh = clusteringConfig.getPrefilterFloor();
  assert.equal(fresh.min_sources, 2, 'init should clear floor cache, next read recomputes');
});
