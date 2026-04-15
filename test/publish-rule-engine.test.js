'use strict';

// Publish rule engine resolveTaxonomy() tests — covers the slug-based global
// default resolution (DEFAULT_AUTHOR_USERNAME / DEFAULT_CATEGORY_SLUG) that
// sits between the matching-rule layer and the numeric WP_AUTHOR_ID /
// WP_DEFAULT_CATEGORY fallback layer.
//
// Uses a temp SQLite DB (created fresh per run) so production data stays
// untouched. Run with:  npm test
// or:                    node --test test/publish-rule-engine.test.js

var fs = require('fs');
var path = require('path');
var os = require('os');
var test = require('node:test');
var assert = require('node:assert/strict');

// ─── Isolated DB setup — must run BEFORE any project module is required ────

var tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hdf-rule-engine-test-'));
process.env.DATA_DIR = tmpDir;
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.DASHBOARD_PASSWORD = 'test-only-not-real';

// Load modules AFTER env vars are set
var dbModule = require('../src/utils/db');
var db = dbModule.db;
var engine = require('../src/utils/publish-rule-engine');

// ─── Helpers ────────────────────────────────────────────────────────────────

function _resetState() {
  db.prepare("DELETE FROM wp_taxonomy_cache WHERE tax_type IN ('author','category','tag')").run();
  db.prepare("DELETE FROM publish_rules").run();
}

function _seedAuthor(id, slug) {
  db.prepare(
    "INSERT INTO wp_taxonomy_cache (tax_type, wp_id, name, slug, synced_at) " +
    "VALUES ('author', ?, ?, ?, datetime('now'))"
  ).run(id, slug, slug);
}

function _seedCategory(id, slug) {
  db.prepare(
    "INSERT INTO wp_taxonomy_cache (tax_type, wp_id, name, slug, synced_at) " +
    "VALUES ('category', ?, ?, ?, datetime('now'))"
  ).run(id, slug, slug);
}

function _insertRule(row) {
  // Minimal helper — supply defaults for NOT-NULL columns.
  var stmt = db.prepare(
    "INSERT INTO publish_rules (rule_name, priority, match_source_domain, " +
    "match_source_category, match_title_keyword, wp_category_ids, " +
    "wp_primary_cat_id, wp_tag_ids, wp_author_id, is_active) " +
    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  stmt.run(
    row.rule_name || 'test-rule',
    row.priority == null ? 0 : row.priority,
    row.match_source_domain || null,
    row.match_source_category || null,
    row.match_title_keyword || null,
    row.wp_category_ids || null,
    row.wp_primary_cat_id || null,
    row.wp_tag_ids || null,
    row.wp_author_id || null,
    row.is_active == null ? 1 : row.is_active
  );
}

function _emptyDraft(extra) {
  var d = {
    wp_category_ids: null,
    wp_primary_cat_id: null,
    wp_tag_ids: null,
    wp_author_id_override: null,
    wp_post_status_override: null,
    source_domain: 'example.com',
    source_category: null,
    rewritten_title: 'Test story',
    extracted_title: null,
    source_title: null,
  };
  if (extra) for (var k in extra) d[k] = extra[k];
  return d;
}

// ─── DEFAULT_AUTHOR_USERNAME tests ──────────────────────────────────────────

test('resolveTaxonomy: DEFAULT_AUTHOR_USERNAME resolves via wp_taxonomy_cache when set and cached', function () {
  _resetState();
  _seedAuthor(77, 'jane-doe');
  var cfg = {
    WP_AUTHOR_ID: '1',
    WP_DEFAULT_CATEGORY: '1',
    DEFAULT_AUTHOR_USERNAME: 'jane-doe',
    DEFAULT_CATEGORY_SLUG: '',
  };
  var out = engine.resolveTaxonomy(_emptyDraft(), db, cfg);
  assert.equal(out.authorId, 77, 'author should resolve via slug lookup');
});

test('resolveTaxonomy: DEFAULT_AUTHOR_USERNAME set but NOT in cache falls through to WP_AUTHOR_ID', function () {
  _resetState();
  // wp_taxonomy_cache is empty — slug will not resolve
  var cfg = {
    WP_AUTHOR_ID: '5',
    WP_DEFAULT_CATEGORY: '1',
    DEFAULT_AUTHOR_USERNAME: 'ghost-author',
    DEFAULT_CATEGORY_SLUG: '',
  };
  var out = engine.resolveTaxonomy(_emptyDraft(), db, cfg);
  assert.equal(out.authorId, 5, 'missing slug must fall through to numeric WP_AUTHOR_ID');
});

test('resolveTaxonomy: empty DEFAULT_AUTHOR_USERNAME falls through to WP_AUTHOR_ID (existing behavior)', function () {
  _resetState();
  var cfg = {
    WP_AUTHOR_ID: '9',
    WP_DEFAULT_CATEGORY: '1',
    DEFAULT_AUTHOR_USERNAME: '',
    DEFAULT_CATEGORY_SLUG: '',
  };
  var out = engine.resolveTaxonomy(_emptyDraft(), db, cfg);
  assert.equal(out.authorId, 9, 'empty slug must preserve pre-fix behavior');
});

test('resolveTaxonomy: matching rule author beats DEFAULT_AUTHOR_USERNAME slug', function () {
  _resetState();
  _seedAuthor(77, 'jane-doe');
  _insertRule({
    rule_name: 'force-author',
    priority: 100,
    match_source_domain: 'example.com',
    wp_author_id: 123,
  });
  var cfg = {
    WP_AUTHOR_ID: '1',
    WP_DEFAULT_CATEGORY: '1',
    DEFAULT_AUTHOR_USERNAME: 'jane-doe',
    DEFAULT_CATEGORY_SLUG: '',
  };
  var out = engine.resolveTaxonomy(_emptyDraft(), db, cfg);
  assert.equal(out.authorId, 123, 'rule wins over slug fallback');
});

test('resolveTaxonomy: per-draft wp_author_id_override beats everything', function () {
  _resetState();
  _seedAuthor(77, 'jane-doe');
  _insertRule({
    rule_name: 'force-author',
    priority: 100,
    match_source_domain: 'example.com',
    wp_author_id: 123,
  });
  var cfg = {
    WP_AUTHOR_ID: '1',
    WP_DEFAULT_CATEGORY: '1',
    DEFAULT_AUTHOR_USERNAME: 'jane-doe',
    DEFAULT_CATEGORY_SLUG: '',
  };
  var draft = _emptyDraft({ wp_author_id_override: 999 });
  var out = engine.resolveTaxonomy(draft, db, cfg);
  assert.equal(out.authorId, 999, 'draft override wins over rule, slug, and numeric fallback');
});

// ─── DEFAULT_CATEGORY_SLUG tests ────────────────────────────────────────────

test('resolveTaxonomy: DEFAULT_CATEGORY_SLUG resolves via wp_taxonomy_cache when set and cached', function () {
  _resetState();
  _seedCategory(55, 'headlines');
  var cfg = {
    WP_AUTHOR_ID: '1',
    WP_DEFAULT_CATEGORY: '1',
    DEFAULT_AUTHOR_USERNAME: '',
    DEFAULT_CATEGORY_SLUG: 'headlines',
  };
  var out = engine.resolveTaxonomy(_emptyDraft(), db, cfg);
  assert.deepEqual(out.categoryIds, [55], 'category should resolve via slug lookup');
  assert.equal(out.primaryCategoryId, 55, 'primary category should match slug lookup');
});

test('resolveTaxonomy: DEFAULT_CATEGORY_SLUG set but NOT in cache falls through to WP_DEFAULT_CATEGORY', function () {
  _resetState();
  var cfg = {
    WP_AUTHOR_ID: '1',
    WP_DEFAULT_CATEGORY: '7',
    DEFAULT_AUTHOR_USERNAME: '',
    DEFAULT_CATEGORY_SLUG: 'ghost-cat',
  };
  var out = engine.resolveTaxonomy(_emptyDraft(), db, cfg);
  assert.deepEqual(out.categoryIds, [7], 'missing slug must fall through to WP_DEFAULT_CATEGORY');
  assert.equal(out.primaryCategoryId, 7);
});

test('resolveTaxonomy: empty DEFAULT_CATEGORY_SLUG falls through to WP_DEFAULT_CATEGORY (existing behavior)', function () {
  _resetState();
  var cfg = {
    WP_AUTHOR_ID: '1',
    WP_DEFAULT_CATEGORY: '3',
    DEFAULT_AUTHOR_USERNAME: '',
    DEFAULT_CATEGORY_SLUG: '',
  };
  var out = engine.resolveTaxonomy(_emptyDraft(), db, cfg);
  assert.deepEqual(out.categoryIds, [3], 'empty slug must preserve pre-fix behavior');
});

test('resolveTaxonomy: matching rule categories beat DEFAULT_CATEGORY_SLUG', function () {
  _resetState();
  _seedCategory(55, 'headlines');
  _insertRule({
    rule_name: 'force-cat',
    priority: 100,
    match_source_domain: 'example.com',
    wp_category_ids: JSON.stringify([201, 202]),
    wp_primary_cat_id: 201,
  });
  var cfg = {
    WP_AUTHOR_ID: '1',
    WP_DEFAULT_CATEGORY: '1',
    DEFAULT_AUTHOR_USERNAME: '',
    DEFAULT_CATEGORY_SLUG: 'headlines',
  };
  var out = engine.resolveTaxonomy(_emptyDraft(), db, cfg);
  assert.deepEqual(out.categoryIds, [201, 202], 'rule categories win over slug fallback');
  assert.equal(out.primaryCategoryId, 201);
});

test('resolveTaxonomy: per-draft wp_category_ids beats everything', function () {
  _resetState();
  _seedCategory(55, 'headlines');
  _insertRule({
    rule_name: 'force-cat',
    priority: 100,
    match_source_domain: 'example.com',
    wp_category_ids: JSON.stringify([201, 202]),
    wp_primary_cat_id: 201,
  });
  var cfg = {
    WP_AUTHOR_ID: '1',
    WP_DEFAULT_CATEGORY: '1',
    DEFAULT_AUTHOR_USERNAME: '',
    DEFAULT_CATEGORY_SLUG: 'headlines',
  };
  var draft = _emptyDraft({
    wp_category_ids: JSON.stringify([900, 901]),
    wp_primary_cat_id: 900,
  });
  var out = engine.resolveTaxonomy(draft, db, cfg);
  assert.deepEqual(out.categoryIds, [900, 901], 'draft override wins over rule, slug, and numeric fallback');
  assert.equal(out.primaryCategoryId, 900);
});

// ─── WP_ALWAYS_APPEND_CATEGORY_ID tests ─────────────────────────────────────

test('resolveTaxonomy: WP_ALWAYS_APPEND_CATEGORY_ID appends to rule-matched categories', function () {
  _resetState();
  _insertRule({
    rule_name: 'auto-rule',
    priority: 100,
    match_source_domain: 'example.com',
    wp_category_ids: JSON.stringify([10]),
    wp_primary_cat_id: 10,
  });
  var cfg = {
    WP_AUTHOR_ID: '1',
    WP_DEFAULT_CATEGORY: '1',
    WP_ALWAYS_APPEND_CATEGORY_ID: '42',
    DEFAULT_AUTHOR_USERNAME: '',
    DEFAULT_CATEGORY_SLUG: '',
  };
  var out = engine.resolveTaxonomy(_emptyDraft(), db, cfg);
  assert.deepEqual(out.categoryIds, [10, 42], 'always-append id appended to rule categories');
  assert.equal(out.primaryCategoryId, 10, 'primary remains from the matched rule');
});

test('resolveTaxonomy: WP_ALWAYS_APPEND_CATEGORY_ID appends to per-draft overrides too', function () {
  _resetState();
  var cfg = {
    WP_AUTHOR_ID: '1',
    WP_DEFAULT_CATEGORY: '1',
    WP_ALWAYS_APPEND_CATEGORY_ID: '42',
    DEFAULT_AUTHOR_USERNAME: '',
    DEFAULT_CATEGORY_SLUG: '',
  };
  var draft = _emptyDraft({
    wp_category_ids: JSON.stringify([900]),
    wp_primary_cat_id: 900,
  });
  var out = engine.resolveTaxonomy(draft, db, cfg);
  assert.deepEqual(out.categoryIds, [900, 42], 'always-append id appended even to explicit draft override');
  assert.equal(out.primaryCategoryId, 900);
});

test('resolveTaxonomy: WP_ALWAYS_APPEND_CATEGORY_ID is not duplicated when already present', function () {
  _resetState();
  var cfg = {
    WP_AUTHOR_ID: '1',
    WP_DEFAULT_CATEGORY: '1',
    WP_ALWAYS_APPEND_CATEGORY_ID: '42',
    DEFAULT_AUTHOR_USERNAME: '',
    DEFAULT_CATEGORY_SLUG: '',
  };
  var draft = _emptyDraft({
    wp_category_ids: JSON.stringify([42, 900]),
    wp_primary_cat_id: 900,
  });
  var out = engine.resolveTaxonomy(draft, db, cfg);
  assert.deepEqual(out.categoryIds, [42, 900], 'no duplicate when id already in category list');
});

test('resolveTaxonomy: WP_ALWAYS_APPEND_CATEGORY_ID is the fallback when nothing else resolves', function () {
  _resetState();
  var cfg = {
    WP_AUTHOR_ID: '1',
    WP_DEFAULT_CATEGORY: '1',
    WP_ALWAYS_APPEND_CATEGORY_ID: '42',
    DEFAULT_AUTHOR_USERNAME: '',
    DEFAULT_CATEGORY_SLUG: '',
  };
  var out = engine.resolveTaxonomy(_emptyDraft(), db, cfg);
  assert.deepEqual(out.categoryIds, [42], 'append id used as sole fallback (not duplicated with WP_DEFAULT_CATEGORY)');
  assert.equal(out.primaryCategoryId, 42, 'primary is the append id when nothing else resolves');
});

test('resolveTaxonomy: DEFAULT_CATEGORY_SLUG still wins over WP_ALWAYS_APPEND_CATEGORY_ID as fallback primary', function () {
  _resetState();
  _seedCategory(55, 'headlines');
  var cfg = {
    WP_AUTHOR_ID: '1',
    WP_DEFAULT_CATEGORY: '1',
    WP_ALWAYS_APPEND_CATEGORY_ID: '42',
    DEFAULT_AUTHOR_USERNAME: '',
    DEFAULT_CATEGORY_SLUG: 'headlines',
  };
  var out = engine.resolveTaxonomy(_emptyDraft(), db, cfg);
  assert.deepEqual(out.categoryIds, [55, 42], 'slug default is primary; append id added as secondary');
  assert.equal(out.primaryCategoryId, 55);
});

test('resolveTaxonomy: empty WP_ALWAYS_APPEND_CATEGORY_ID preserves pre-feature behavior', function () {
  _resetState();
  var cfg = {
    WP_AUTHOR_ID: '1',
    WP_DEFAULT_CATEGORY: '7',
    WP_ALWAYS_APPEND_CATEGORY_ID: '',
    DEFAULT_AUTHOR_USERNAME: '',
    DEFAULT_CATEGORY_SLUG: '',
  };
  var out = engine.resolveTaxonomy(_emptyDraft(), db, cfg);
  assert.deepEqual(out.categoryIds, [7], 'feature off — only legacy numeric fallback is used');
  assert.equal(out.primaryCategoryId, 7);
});

// ─── Cleanup ────────────────────────────────────────────────────────────────

test.after(function () {
  try { db.close(); } catch (e) { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
});
