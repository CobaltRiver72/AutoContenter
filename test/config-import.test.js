'use strict';

// Bulk Config Import test suite — Phase D.
//
// Uses a temp SQLite DB (created fresh per run) so production data stays
// untouched. Run with:  npm test
// or:                    node --test test/config-import.test.js

var fs = require('fs');
var path = require('path');
var os = require('os');
var test = require('node:test');
var assert = require('node:assert/strict');

// ─── Isolated DB setup — must run BEFORE any project module is required ────

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdf-import-test-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
// Quiet the bootstrap warnings — they're not relevant to test output
process.env.DASHBOARD_PASSWORD = 'test-only-not-real';

// Load modules AFTER env vars are set
var dbModule = require('../src/utils/db');
var db = dbModule.db;
var validator = require('../src/utils/config-import-validator');
var engine = require('../src/utils/config-import-engine');
var { IMPORT_MANAGED_SETTING_KEYS } = require('../src/utils/config-import-keys');

// ─── Helpers ────────────────────────────────────────────────────────────────

function _resetState() {
  // Wipe anything the import system owns so each test starts clean.
  // Day-zero snapshot (id=1) must survive — that's a feature, not a leak.
  for (var i = 0; i < IMPORT_MANAGED_SETTING_KEYS.length; i++) {
    db.prepare('DELETE FROM settings WHERE key = ?').run(IMPORT_MANAGED_SETTING_KEYS[i]);
  }
  db.prepare("DELETE FROM publish_rules WHERE source = 'import'").run();
  db.prepare("DELETE FROM config_snapshots WHERE id != 1").run();
}

function _seedWpCache(authors, categories, tags) {
  db.prepare("DELETE FROM wp_taxonomy_cache WHERE tax_type IN ('author','category','tag')").run();
  var ins = db.prepare(
    "INSERT INTO wp_taxonomy_cache (tax_type, wp_id, name, slug, synced_at) " +
    "VALUES (?, ?, ?, ?, datetime('now'))"
  );
  for (var i = 0; i < (authors || []).length; i++) {
    ins.run('author', authors[i].id, authors[i].name || authors[i].slug, authors[i].slug);
  }
  for (var j = 0; j < (categories || []).length; j++) {
    ins.run('category', categories[j].id, categories[j].name || categories[j].slug, categories[j].slug);
  }
  for (var k = 0; k < (tags || []).length; k++) {
    ins.run('tag', tags[k].id, tags[k].name || tags[k].slug, tags[k].slug);
  }
}

function _stubClassifier() {
  // Minimal stub so applyImport's classifier.reloadDictionaries() call doesn't
  // crash. Records calls so tests can assert reload happened.
  return { reloadCount: 0, reloadDictionaries: function () { this.reloadCount++; } };
}

function _baseCtx(extra) {
  var c = {
    db: db,
    classifier: _stubClassifier(),
    config: {},
    logger: null,
    filename: 'test.json',
    createdBy: 'test-suite',
  };
  if (extra) for (var k in extra) c[k] = extra[k];
  return c;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

test('day-zero baseline snapshot exists after fresh install', function () {
  var snaps = engine.listSnapshots(db);
  var dayZero = snaps.find(function (s) { return s.id === 1; });
  assert.ok(dayZero, 'snapshot id=1 must exist on a fresh install');
  assert.match(dayZero.label, /^factory_default_/, 'label must follow factory_default_<timestamp> format');
});

test('validator: empty {} is rejected (missing version)', function () {
  var v = validator.validate({});
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(function (e) { return /version/.test(e.message); }));
});

test('validator: {version:"1.0"} alone is a valid no-op config', function () {
  var v = validator.validate({ version: '1.0' });
  assert.equal(v.ok, true);
  assert.equal(v.errors.length, 0);
});

test('validator: bad author username is hard-rejected', function () {
  var v = validator.validate({ version: '1.0', authors: [{ username: 'Bad Slug!' }] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(function (e) { return /username/.test(e.message); }));
});

test('validator: duplicate author usernames are hard-rejected', function () {
  var v = validator.validate({ version: '1.0', authors: [{ username: 'a' }, { username: 'a' }] });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(function (e) { return /duplicate/.test(e.message); }));
});

test('validator: publish_rule.key regex enforced', function () {
  var v = validator.validate({
    version: '1.0',
    publish_rules: [{ key: 'Foo Bar', name: 'x', priority: 1, match: {}, assign: {} }],
  });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some(function (e) { return /key.*match/.test(e.message); }));
});

test('validator: 250-char tag canonical name is hard-rejected', function () {
  var longName = 'x'.repeat(250);
  var v = validator.validate({ version: '1.0', tags: { foo: longName } });
  assert.equal(v.ok, false);
});

test('validator: keyword scores can be int OR null (null = delete)', function () {
  var v = validator.validate({
    version: '1.0',
    authors: [{ username: 'rahul', keywords: { ipl: 5, bcci: null } }],
  });
  assert.equal(v.ok, true);
});

test('engine: empty no-op config applies cleanly and creates snapshot', async function () {
  _resetState();
  var beforeSnapCount = engine.listSnapshots(db).length;
  var result = await engine.applyImport({ version: '1.0' }, _baseCtx());
  assert.ok(result.snapshot_id > 0);
  var afterSnapCount = engine.listSnapshots(db).length;
  assert.equal(afterSnapCount, beforeSnapCount + 1, 'apply must create exactly one new snapshot');
});

test('engine: missing author hard-fails apply', async function () {
  _resetState();
  _seedWpCache([], [], []);  // no authors in cache
  var cfg = {
    version: '1.0',
    authors: [{ username: 'ghost-author', keywords: { test: 5 } }],
  };
  await assert.rejects(
    engine.applyImport(cfg, _baseCtx()),
    /ghost-author/,
    'apply must throw with the missing username in the message'
  );
});

test('engine: round-trip — export then re-import sees zero changes', async function () {
  _resetState();
  _seedWpCache(
    [{ id: 42, slug: 'rahul-sharma', name: 'Rahul Sharma' }],
    [{ id: 12, slug: 'cricket', name: 'Cricket' }],
    []
  );
  var cfg = {
    version: '1.0',
    defaults: { post_status: 'publish' },
    authors: [{ username: 'rahul-sharma', keywords: { ipl: 5 } }],
    categories: [{ slug: 'cricket', keywords: { test: 7 } }],
    tags: { 'kohli': 'Virat Kohli' },
  };
  await engine.applyImport(cfg, _baseCtx());

  // Export current state, re-import, verify diff is empty
  var exported = engine.exportConfig(db);
  var v = validator.validate(exported);
  assert.equal(v.ok, true, 'exported config must re-validate as v1.0');

  var diff = engine.computeDiff(exported, db);
  assert.equal(diff.changes.authors.added.length, 0, 'no new authors expected');
  assert.equal(diff.changes.categories.added.length, 0, 'no new categories expected');
  assert.equal(diff.changes.tags.added, 0, 'no new tags expected');
});

test('engine: re-importing the same file is idempotent', async function () {
  _resetState();
  _seedWpCache(
    [{ id: 1, slug: 'admin' }],
    [{ id: 1, slug: 'general' }],
    []
  );
  var cfg = {
    version: '1.0',
    authors: [{ username: 'admin', keywords: { hello: 3 } }],
    categories: [{ slug: 'general', keywords: { news: 4 } }],
  };
  await engine.applyImport(cfg, _baseCtx());

  // Second apply — diff should show only "unchanged" authors/categories
  var diff = engine.computeDiff(cfg, db);
  assert.equal(diff.changes.authors.added.length, 0);
  assert.equal(diff.changes.authors.unchanged.length, 1);
  assert.equal(diff.changes.categories.added.length, 0);
  assert.equal(diff.changes.categories.unchanged.length, 1);
});

test('engine: null value in keywords removes the key on apply', async function () {
  _resetState();
  _seedWpCache([{ id: 1, slug: 'admin' }], [], []);

  // Step 1 — seed two keywords
  await engine.applyImport({
    version: '1.0',
    authors: [{ username: 'admin', keywords: { foo: 5, bar: 5 } }],
  }, _baseCtx());

  // Step 2 — null-delete one of them
  await engine.applyImport({
    version: '1.0',
    authors: [{ username: 'admin', keywords: { foo: null } }],
  }, _baseCtx());

  // Step 3 — read settings and confirm 'foo' is gone, 'bar' remains
  var raw = db.prepare("SELECT value FROM settings WHERE key='CLASSIFIER_AUTHOR_DICTIONARIES'").get();
  var parsed = JSON.parse(raw.value);
  assert.equal(parsed.admin.foo, undefined, 'foo should be deleted');
  assert.equal(parsed.admin.bar, 5, 'bar should remain');
});

test('engine: snapshot capture + restore round-trip preserves managed state', async function () {
  _resetState();
  _seedWpCache([{ id: 1, slug: 'admin' }], [], []);

  await engine.applyImport({
    version: '1.0',
    defaults: { post_status: 'publish' },
    authors: [{ username: 'admin', keywords: { initial: 5 } }],
  }, _baseCtx());

  var snapBefore = engine.captureSnapshot(db, { label: 'before-mutation', createdBy: 'test' });

  // Mutate state
  await engine.applyImport({
    version: '1.0',
    defaults: { post_status: 'draft' },
    authors: [{ username: 'admin', keywords: { mutated: 9 } }],
  }, _baseCtx());

  // Verify mutation applied
  var afterMutate = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='CLASSIFIER_AUTHOR_DICTIONARIES'").get().value);
  assert.equal(afterMutate.admin.mutated, 9);

  // Restore
  engine.restoreSnapshot(db, snapBefore);

  var afterRestore = JSON.parse(db.prepare("SELECT value FROM settings WHERE key='CLASSIFIER_AUTHOR_DICTIONARIES'").get().value);
  assert.equal(afterRestore.admin.initial, 5, 'restored state should match snapshot');
  assert.equal(afterRestore.admin.mutated, undefined, 'mutated key should be gone');

  var statusAfterRestore = db.prepare("SELECT value FROM settings WHERE key='WP_POST_STATUS'").get();
  assert.equal(statusAfterRestore.value, 'publish');
});

test('engine: restore does NOT touch unrelated settings', function () {
  _resetState();
  // Set an unrelated key (NOT in IMPORT_MANAGED_SETTING_KEYS)
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('MAX_PUBLISH_PER_HOUR', '99')").run();

  var snapId = engine.captureSnapshot(db, { label: 'test', createdBy: 'test' });
  // Mutate the unrelated key
  db.prepare("UPDATE settings SET value='42' WHERE key='MAX_PUBLISH_PER_HOUR'").run();

  engine.restoreSnapshot(db, snapId);

  // The unrelated key should still be 42 — restore must not touch it
  var row = db.prepare("SELECT value FROM settings WHERE key='MAX_PUBLISH_PER_HOUR'").get();
  assert.equal(row.value, '42', 'unrelated settings must survive a restore');
});

test('engine: restore does NOT delete manual publish rules', function () {
  _resetState();
  // Insert a manual rule (no key, source='manual')
  db.prepare(
    "INSERT INTO publish_rules (rule_name, priority, source, is_active, created_at, updated_at) " +
    "VALUES ('manual rule', 50, 'manual', 1, datetime('now'), datetime('now'))"
  ).run();
  var manualCountBefore = db.prepare("SELECT COUNT(*) AS c FROM publish_rules WHERE source='manual'").get().c;

  var snapId = engine.captureSnapshot(db, { label: 'test', createdBy: 'test' });
  engine.restoreSnapshot(db, snapId);

  var manualCountAfter = db.prepare("SELECT COUNT(*) AS c FROM publish_rules WHERE source='manual'").get().c;
  assert.equal(manualCountAfter, manualCountBefore, 'manual rules must survive restore');
});

test('engine: snapshot pruning keeps baseline (is_baseline=1), not hardcoded id=1', function () {
  _resetState();
  // Create 15 snapshots — pruning should keep baseline + last 10
  for (var i = 0; i < 15; i++) {
    engine.captureSnapshot(db, { label: 'prune-test-' + i, createdBy: 'test' });
  }
  engine.pruneSnapshots(db);
  var snaps = engine.listSnapshots(db);
  // baseline + 10 most recent = 11
  assert.ok(snaps.length <= 11, 'should keep at most 11 snapshots, got ' + snaps.length);
  // The baseline is marked by is_baseline=1, not by id. Verify via SQL.
  var baseline = db.prepare("SELECT id FROM config_snapshots WHERE is_baseline = 1").get();
  assert.ok(baseline, 'baseline row (is_baseline=1) must survive pruning');
});

test('engine: prune respects is_baseline marker even when baseline id is NOT 1', function () {
  _resetState();
  // Simulate a re-seeded install where the baseline got id=99
  db.prepare("DELETE FROM config_snapshots WHERE is_baseline = 1").run();
  db.prepare(
    "INSERT INTO config_snapshots (id, label, settings_json, publish_rules_json, created_by, is_baseline) " +
    "VALUES (99, 'factory_default_reseeded', '{}', '[]', 'system', 1)"
  ).run();
  // Now create 12 normal snapshots
  for (var i = 0; i < 12; i++) {
    engine.captureSnapshot(db, { label: 'post-reseed-' + i, createdBy: 'test' });
  }
  engine.pruneSnapshots(db);
  var survives = db.prepare("SELECT id FROM config_snapshots WHERE id = 99").get();
  assert.ok(survives, 'baseline with id=99 must survive pruning via is_baseline marker');
});

test('engine: applyImport invokes classifier.reloadDictionaries on success', async function () {
  _resetState();
  var ctx = _baseCtx();
  await engine.applyImport({ version: '1.0', tags: { foo: 'Foo' } }, ctx);
  assert.equal(ctx.classifier.reloadCount, 1, 'reloadDictionaries must be called exactly once');
});

test('engine: export strips credentials from output', function () {
  _resetState();
  // Set a credential key that should never appear in export
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('WP_APP_PASSWORD', 'super-secret')").run();
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('ANTHROPIC_API_KEY', 'sk-test')").run();

  var exported = engine.exportConfig(db);
  var serialized = JSON.stringify(exported);
  assert.equal(serialized.indexOf('super-secret'), -1, 'WP password must not appear in export');
  assert.equal(serialized.indexOf('sk-test'), -1, 'API key must not appear in export');
  assert.equal(serialized.indexOf('WP_APP_PASSWORD'), -1, 'credential key names must not appear');
});

test('engine: applyImport snapshot points to BEFORE-state for undo', async function () {
  _resetState();
  _seedWpCache([{ id: 1, slug: 'admin' }], [], []);

  // Set initial state
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('WP_POST_STATUS', 'draft')").run();

  // Apply a change
  var result = await engine.applyImport({
    version: '1.0',
    defaults: { post_status: 'publish' },
  }, _baseCtx());

  // Verify mutation took
  var current = db.prepare("SELECT value FROM settings WHERE key='WP_POST_STATUS'").get();
  assert.equal(current.value, 'publish');

  // Restore the snapshot the apply created — should bring us back to 'draft'
  engine.restoreSnapshot(db, result.snapshot_id);
  var restored = db.prepare("SELECT value FROM settings WHERE key='WP_POST_STATUS'").get();
  assert.equal(restored.value, 'draft', 'snapshot must capture the BEFORE-state, not the after-state');
});

test('engine: silent-truncation guard — applyImport throws if a referenced category cannot be resolved', async function () {
  _resetState();
  _seedWpCache([{ id: 1, slug: 'admin' }], [], []);
  // Seed a config that references a category slug which will NOT exist in
  // wp_taxonomy_cache after resolveCategorySlugs runs (we pass an empty config
  // so the resolver can't actually call WP). With the truncation guard, this
  // must throw a clear error — without it, publish_rules would save null IDs.
  var cfg = {
    version: '1.0',
    authors: [{ username: 'admin', keywords: {} }],
    publish_rules: [{
      key: 'ghost_rule',
      name: 'References a ghost category',
      priority: 10,
      is_active: true,
      match: { source_domain: 'example.com', source_category: null, title_keyword: null },
      assign: { category_slugs: ['ghost-cat-does-not-exist'], primary_category_slug: 'ghost-cat-does-not-exist', tag_slugs: [], author_username: 'admin' },
    }],
  };
  // config:{} has no WP credentials, so resolveCategorySlugs will skip creation
  // but applyImport should then detect the missing slug and throw.
  await assert.rejects(
    engine.applyImport(cfg, _baseCtx()),
    /ghost-cat-does-not-exist/,
    'apply must throw naming the unresolved category slug'
  );
});

test('validator + engine: routing_hints diff reports change counts', function () {
  _resetState();
  // Seed current state
  db.prepare(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('CLASSIFIER_DOMAIN_HINTS', ?)"
  ).run(JSON.stringify({ 'old.com': 'general' }));

  var diff = engine.computeDiff({
    version: '1.0',
    routing_hints: {
      domains: { 'new.com': 'cricket', 'another.com': 'auto' },
    },
  }, db);

  assert.ok(diff.changes.routing_hints.domains_changed > 0);
});

// ─── Cleanup ────────────────────────────────────────────────────────────────

test.after(function () {
  try { db.close(); } catch (e) { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});
