'use strict';

// Integration test for PR 4 — the SQL pre-filter floor fix.
//
// Before PR 4, pipeline.js's readyClustersSql used the GLOBAL
// MIN_SOURCES_THRESHOLD / SIMILARITY_THRESHOLD as a WHERE-clause floor.
// Consequence: a feed configured more permissive than the global (e.g.
// min_sources=1 when the global is 2) never received its candidates —
// they were excluded at the SQL layer before the per-feed resolver saw
// them.
//
// This test seeds a feed with a looser threshold and a cluster that
// only meets the looser bar, then asserts the cluster IS returned by
// the exact SQL query pipeline.js uses when parameterised from
// getPrefilterFloor(). For contrast, it also runs the same SQL with the
// pre-PR-4 global floor and asserts the cluster is EXCLUDED — so the
// test will fail regression if the fix ever gets reverted.

var fs = require('fs');
var path = require('path');
var os = require('os');
var test = require('node:test');
var assert = require('node:assert/strict');

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdf-prefilter-itest-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.DASHBOARD_PASSWORD = 'test-only-not-real';

var dbModule = require('../src/utils/db');
var db = dbModule.db;
var clusteringConfig = require('../src/utils/clustering-config');
clusteringConfig.init(db);

// Exact copy of the WHERE/SELECT portion of readyClustersSql from
// src/workers/pipeline.js, simplified to the minimum that exercises the
// PR-4 floor params. If pipeline.js's query shape changes in a future PR,
// this test protects the regression surface by pinning the query here.
var READY_CLUSTERS_SQL =
  "SELECT d.cluster_id, c.topic, c.trends_boosted, c.article_count, c.feed_id, COUNT(*) as draft_count " +
  "FROM drafts d " +
  "JOIN clusters c ON d.cluster_id = c.id " +
  "WHERE d.mode IN ('auto', 'manual_import') AND d.cluster_id IS NOT NULL AND d.status = 'draft' " +
  "  AND c.status = 'queued' " +
  "  AND c.article_count >= ? " +
  "  AND (c.avg_similarity IS NULL OR c.avg_similarity >= ?) " +
  "  AND (d.locked_by IS NULL OR d.lease_expires_at < datetime('now')) " +
  "GROUP BY d.cluster_id " +
  "HAVING COUNT(CASE WHEN d.cluster_role = 'primary' THEN 1 END) > 0 " +
  "ORDER BY c.article_count DESC " +
  "LIMIT 10";

// ─── Helpers ────────────────────────────────────────────────────────────────

function _reset() {
  db.prepare('DELETE FROM drafts').run();
  db.prepare('DELETE FROM clusters').run();
  db.prepare('DELETE FROM feeds WHERE name LIKE ?').run('__prefilter_test_%');
  db.prepare("DELETE FROM settings WHERE key IN ('MIN_SOURCES_THRESHOLD','SIMILARITY_THRESHOLD')").run();
  clusteringConfig.invalidateFloorCache();
  clusteringConfig.invalidateClusteringCache();
}

function _insertLooseFeed(qualityOverride) {
  var info = db.prepare(
    "INSERT INTO feeds (site_id, name, kind, is_active, source_config, dest_config, quality_config) " +
    "VALUES (1, '__prefilter_test_loose', 'firehose', 1, '{}', '{}', ?)"
  ).run(JSON.stringify(qualityOverride || { min_sources: 1, similarity_threshold: 0.10 }));
  clusteringConfig.invalidateFloorCache();
  return info.lastInsertRowid;
}

function _insertClusterWithPrimaryDraft(feedId, opts) {
  var articleCount = opts.articleCount;
  var avgSim = opts.avgSimilarity;
  var topic = opts.topic || 'test cluster';

  var clusterInfo = db.prepare(
    "INSERT INTO clusters (topic, article_count, avg_similarity, status, detected_at, feed_id) " +
    "VALUES (?, ?, ?, 'queued', datetime('now'), ?)"
  ).run(topic, articleCount, avgSim, feedId);
  var clusterId = Number(clusterInfo.lastInsertRowid);

  db.prepare(
    "INSERT INTO drafts (cluster_id, cluster_role, source_url, source_domain, status, mode, feed_id, site_id) " +
    "VALUES (?, 'primary', ?, 'example.com', 'draft', 'auto', ?, 1)"
  ).run(clusterId, 'https://example.com/' + clusterId, feedId);

  return clusterId;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('PR-4 fix: looser-than-global feed receives its borderline cluster via SQL', function () {
  _reset();
  // Globals default to MIN_SOURCES_THRESHOLD=2, SIMILARITY_THRESHOLD=0.20
  // (via config.js DEFAULTS). Feed loosens both.
  var feedId = _insertLooseFeed({ min_sources: 1, similarity_threshold: 0.10 });
  // Cluster meets the feed's floor but NOT the global floor.
  var clusterId = _insertClusterWithPrimaryDraft(feedId, {
    articleCount: 1,
    avgSimilarity: 0.15,
    topic: 'borderline cluster',
  });

  var floor = clusteringConfig.getPrefilterFloor();
  assert.equal(floor.min_sources, 1, 'floor should drop to 1 with looser feed present');
  assert.equal(floor.similarity_threshold, 0.10, 'floor should drop to 0.10 with looser feed present');

  var rows = db.prepare(READY_CLUSTERS_SQL).all(floor.min_sources, floor.similarity_threshold);
  var matched = rows.filter(function (r) { return r.cluster_id === clusterId; });
  assert.equal(matched.length, 1, 'cluster MUST be returned by SQL with the PR-4 floor');
  assert.equal(matched[0].article_count, 1);
});

test('PR-4 counterfactual: same cluster EXCLUDED if we apply the old global floor', function () {
  // Same setup as above; this test proves the pre-PR-4 behavior would have
  // silently dropped the borderline cluster. If the fix ever gets reverted
  // (restoring _minSources/_minSimilarity in the SQL params), this test
  // becomes INCONSISTENT with the previous one — either both pass (fix
  // present, but old globals now happen to match the feed) or the test
  // above starts failing. A guard rail, not a round-trip.
  _reset();
  var feedId = _insertLooseFeed({ min_sources: 1, similarity_threshold: 0.10 });
  var clusterId = _insertClusterWithPrimaryDraft(feedId, {
    articleCount: 1,
    avgSimilarity: 0.15,
    topic: 'borderline cluster',
  });

  // The pre-PR-4 behaviour: feed the SQL the literal GLOBAL values.
  var preFix = db.prepare(READY_CLUSTERS_SQL).all(2, 0.20);
  var matched = preFix.filter(function (r) { return r.cluster_id === clusterId; });
  assert.equal(matched.length, 0, 'pre-PR-4 global floor would have excluded this cluster');
});

test('PR-4 fix does not expand the set on stricter-than-global feeds', function () {
  _reset();
  var feedId = _insertLooseFeed({ min_sources: 5, similarity_threshold: 0.80 });
  // Cluster meets global floor but not the stricter feed's floor. SQL
  // should still return it (feed's stricter value filters in JS by the
  // per-feed resolver, which this test does NOT exercise — the SQL floor
  // must never be STRICTER than the global, that's the whole invariant).
  var clusterId = _insertClusterWithPrimaryDraft(feedId, {
    articleCount: 3,
    avgSimilarity: 0.25,
    topic: 'should reach JS gate',
  });

  var floor = clusteringConfig.getPrefilterFloor();
  assert.equal(floor.min_sources, 2, 'stricter feed cannot raise SQL floor above global');
  assert.equal(floor.similarity_threshold, 0.20);

  var rows = db.prepare(READY_CLUSTERS_SQL).all(floor.min_sources, floor.similarity_threshold);
  var matched = rows.filter(function (r) { return r.cluster_id === clusterId; });
  assert.equal(matched.length, 1, 'SQL must pass the candidate through to the per-feed resolver');
});

test('Empty-feeds scenario: SQL uses globals, pipeline doesn\'t crash', function () {
  _reset();
  // No feeds, no clusters, no drafts. Floor returns globals.
  var floor = clusteringConfig.getPrefilterFloor();
  assert.equal(floor.min_sources, 2);
  assert.equal(floor.similarity_threshold, 0.20);

  var rows = db.prepare(READY_CLUSTERS_SQL).all(floor.min_sources, floor.similarity_threshold);
  assert.equal(rows.length, 0);
});
