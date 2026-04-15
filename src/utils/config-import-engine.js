'use strict';

// Bulk Config Import — diff/apply/rollback engine.
//
// Pure data-layer logic. Endpoints in src/routes/api.js call into here;
// validation lives in src/utils/config-import-validator.js. The engine
// owns the snapshot/restore contract via IMPORT_MANAGED_SETTING_KEYS.

var crypto = require('crypto');
var { IMPORT_MANAGED_SETTING_KEYS } = require('./config-import-keys');
var { resolveCategorySlugs, resolveTagNames } = require('../modules/wp-taxonomy');

// ─── Settings access helpers ────────────────────────────────────────────────

function _getSetting(db, key) {
  var row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function _setSetting(db, key, value) {
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(key, String(value == null ? '' : value));
}

function _parseJsonSetting(db, key, fallback) {
  var raw = _getSetting(db, key);
  if (!raw) return fallback;
  try {
    var parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : fallback;
  } catch (e) {
    return fallback;
  }
}

// Merge a "patch" object into a "current" object. A null value in the patch
// deletes the key from the result. Used for keyword dictionaries and tag
// normalization maps so an admin can selectively remove entries via import.
function _mergeWithNullDelete(current, patch) {
  var result = {};
  var k;
  if (current && typeof current === 'object') {
    var curKeys = Object.keys(current);
    for (var i = 0; i < curKeys.length; i++) {
      result[curKeys[i]] = current[curKeys[i]];
    }
  }
  if (patch && typeof patch === 'object') {
    var patchKeys = Object.keys(patch);
    for (var j = 0; j < patchKeys.length; j++) {
      k = patchKeys[j];
      if (patch[k] === null) {
        delete result[k];
      } else {
        result[k] = patch[k];
      }
    }
  }
  return result;
}

// ─── Diff computation ───────────────────────────────────────────────────────
//
// Returns a structured diff describing what an apply would change. Pure
// function — no DB writes, no WP calls. Cross-references are limited to
// SELECT queries against wp_taxonomy_cache to flag missing slugs/usernames.

function computeDiff(parsed, db) {
  var changes = {
    defaults:      { before: {}, after: {} },
    authors:       { added: [], updated: [], unchanged: [], removed: [] },
    categories:    { added: [], updated: [], unchanged: [], removed: [], missing_on_wp: [] },
    tags:          { added: 0, updated: 0, removed: 0 },
    routing_hints: { domains_changed: 0, source_categories_changed: 0, category_to_author_changed: 0 },
    publish_rules: { added: [], updated: [], unchanged: [], removed: [] },
    modules:       { before: null, after: null },
  };
  var warnings = [];

  // ─── defaults section ─────────────────────────────────────────────────
  if (parsed.defaults && typeof parsed.defaults === 'object') {
    var defaultsKeyMap = {
      post_status:             'WP_POST_STATUS',
      comment_status:          'WP_COMMENT_STATUS',
      ping_status:             'WP_PING_STATUS',
      default_author_username: 'DEFAULT_AUTHOR_USERNAME',
      default_category_slug:   'DEFAULT_CATEGORY_SLUG',
    };
    var dKeys = Object.keys(defaultsKeyMap);
    for (var di = 0; di < dKeys.length; di++) {
      var importKey = dKeys[di];
      if (parsed.defaults[importKey] === undefined) continue;
      var settingKey = defaultsKeyMap[importKey];
      var currentVal = _getSetting(db, settingKey) || '';
      var newVal = String(parsed.defaults[importKey] == null ? '' : parsed.defaults[importKey]);
      if (currentVal !== newVal) {
        changes.defaults.before[settingKey] = currentVal;
        changes.defaults.after[settingKey] = newVal;
      }
    }
  }

  // ─── authors + author keywords ────────────────────────────────────────
  // Author roster is the keys of CLASSIFIER_AUTHOR_DICTIONARIES; we also
  // cross-check usernames against wp_taxonomy_cache (tax_type='author').
  if (Array.isArray(parsed.authors)) {
    var currentAuthorDicts = _parseJsonSetting(db, 'CLASSIFIER_AUTHOR_DICTIONARIES', {});
    var wpAuthorRows = [];
    try {
      wpAuthorRows = db.prepare(
        "SELECT slug, name, wp_id FROM wp_taxonomy_cache WHERE tax_type = 'author'"
      ).all();
    } catch (e) { /* table may not exist on a brand-new install */ }
    var wpAuthorSlugs = {};
    for (var ai = 0; ai < wpAuthorRows.length; ai++) {
      var ar = wpAuthorRows[ai];
      if (ar.slug) wpAuthorSlugs[ar.slug] = true;
      if (ar.name) wpAuthorSlugs[String(ar.name).toLowerCase()] = true;
    }

    for (var aj = 0; aj < parsed.authors.length; aj++) {
      var author = parsed.authors[aj];
      var username = author.username;
      var existed = currentAuthorDicts[username] !== undefined;
      var newDict = author.keywords || {};
      var mergedDict = _mergeWithNullDelete(currentAuthorDicts[username] || {}, newDict);

      if (!existed) {
        changes.authors.added.push(username);
      } else if (JSON.stringify(currentAuthorDicts[username]) !== JSON.stringify(mergedDict)) {
        changes.authors.updated.push(username);
      } else {
        changes.authors.unchanged.push(username);
      }

      if (!wpAuthorSlugs[username]) {
        warnings.push({
          path: 'authors[' + aj + '].username',
          message: 'Author "' + username + '" is not in the WP taxonomy cache. Import will hard-fail at apply time unless you sync taxonomy and create this user on WP first.',
        });
      }
    }
  }

  // ─── categories + category keywords ───────────────────────────────────
  if (Array.isArray(parsed.categories)) {
    var currentCatDicts = _parseJsonSetting(db, 'CLASSIFIER_CATEGORY_DICTIONARIES', {});
    var wpCatRows = [];
    try {
      wpCatRows = db.prepare(
        "SELECT slug, name, wp_id FROM wp_taxonomy_cache WHERE tax_type = 'category'"
      ).all();
    } catch (e) { /* tolerate */ }
    var wpCatSlugs = {};
    for (var ci = 0; ci < wpCatRows.length; ci++) {
      if (wpCatRows[ci].slug) wpCatSlugs[wpCatRows[ci].slug] = true;
    }

    for (var cj = 0; cj < parsed.categories.length; cj++) {
      var cat = parsed.categories[cj];
      var slug = cat.slug;
      var catExisted = currentCatDicts[slug] !== undefined;
      var newCatDict = cat.keywords || {};
      var mergedCatDict = _mergeWithNullDelete(currentCatDicts[slug] || {}, newCatDict);

      if (!catExisted) {
        changes.categories.added.push(slug);
      } else if (JSON.stringify(currentCatDicts[slug]) !== JSON.stringify(mergedCatDict)) {
        changes.categories.updated.push(slug);
      } else {
        changes.categories.unchanged.push(slug);
      }

      if (!wpCatSlugs[slug]) {
        changes.categories.missing_on_wp.push(slug);
        warnings.push({
          path: 'categories[' + cj + '].slug',
          message: 'Category "' + slug + '" not in WP taxonomy cache — will be auto-created on WordPress at apply time.',
        });
      }
    }
  }

  // ─── tags ────────────────────────────────────────────────────────────
  if (parsed.tags && typeof parsed.tags === 'object') {
    var currentTagMap = _parseJsonSetting(db, 'CLASSIFIER_TAG_NORMALIZATION', {});
    var newTagKeys = Object.keys(parsed.tags);
    for (var ti = 0; ti < newTagKeys.length; ti++) {
      var tk = newTagKeys[ti];
      var tv = parsed.tags[tk];
      if (tv === null) {
        if (currentTagMap[tk] !== undefined) changes.tags.removed++;
      } else if (currentTagMap[tk] === undefined) {
        changes.tags.added++;
      } else if (currentTagMap[tk] !== tv) {
        changes.tags.updated++;
      }
    }
  }

  // ─── routing_hints ────────────────────────────────────────────────────
  if (parsed.routing_hints && typeof parsed.routing_hints === 'object') {
    var rh = parsed.routing_hints;
    if (rh.domains && typeof rh.domains === 'object') {
      var currentDomains = _parseJsonSetting(db, 'CLASSIFIER_DOMAIN_HINTS', {});
      changes.routing_hints.domains_changed = _countDiff(currentDomains, rh.domains);
    }
    if (rh.source_categories && typeof rh.source_categories === 'object') {
      var currentSrcCat = _parseJsonSetting(db, 'CLASSIFIER_SOURCE_CATEGORY_HINTS', {});
      changes.routing_hints.source_categories_changed = _countDiff(currentSrcCat, rh.source_categories);
    }
    if (rh.category_to_author && typeof rh.category_to_author === 'object') {
      var currentCatAuth = _parseJsonSetting(db, 'CLASSIFIER_CATEGORY_TO_AUTHOR', {});
      changes.routing_hints.category_to_author_changed = _countDiff(currentCatAuth, rh.category_to_author);
    }
  }

  // ─── publish_rules ────────────────────────────────────────────────────
  if (Array.isArray(parsed.publish_rules)) {
    var existingImportRules = [];
    try {
      existingImportRules = db.prepare(
        "SELECT key, rule_name, priority, match_source_domain, match_source_category, " +
        "match_title_keyword, wp_category_ids, wp_primary_cat_id, wp_tag_ids, wp_author_id, is_active " +
        "FROM publish_rules WHERE source = 'import' AND key IS NOT NULL"
      ).all();
    } catch (e) { /* tolerate */ }
    var existingByKey = {};
    for (var ri = 0; ri < existingImportRules.length; ri++) {
      existingByKey[existingImportRules[ri].key] = existingImportRules[ri];
    }
    for (var rj = 0; rj < parsed.publish_rules.length; rj++) {
      var rule = parsed.publish_rules[rj];
      if (existingByKey[rule.key]) {
        changes.publish_rules.updated.push(rule.key);
      } else {
        changes.publish_rules.added.push(rule.key);
      }
    }
  }

  // ─── modules (forward-compat, parsed but no logic depends on it yet) ──
  if (parsed.modules && typeof parsed.modules === 'object') {
    var currentModules = _parseJsonSetting(db, 'MODULE_ROUTING_CONFIG', null);
    changes.modules.before = currentModules;
    changes.modules.after = parsed.modules;
  }

  return { changes: changes, warnings: warnings };
}

// Count keys that differ between two flat objects (added + changed + removed).
function _countDiff(a, b) {
  var aKeys = Object.keys(a || {});
  var bKeys = Object.keys(b || {});
  var seen = {};
  var n = 0;
  for (var i = 0; i < aKeys.length; i++) {
    seen[aKeys[i]] = true;
    if (b[aKeys[i]] === undefined || b[aKeys[i]] === null) n++;
    else if (b[aKeys[i]] !== a[aKeys[i]]) n++;
  }
  for (var j = 0; j < bKeys.length; j++) {
    if (!seen[bKeys[j]] && b[bKeys[j]] !== null) n++;
  }
  return n;
}

// ─── Snapshot capture / restore ─────────────────────────────────────────────

function captureSnapshot(db, opts) {
  opts = opts || {};
  var managed = {};
  for (var i = 0; i < IMPORT_MANAGED_SETTING_KEYS.length; i++) {
    var k = IMPORT_MANAGED_SETTING_KEYS[i];
    var v = _getSetting(db, k);
    if (v !== null) managed[k] = v;
  }
  var importedRules = db.prepare(
    "SELECT * FROM publish_rules WHERE source = 'import'"
  ).all();
  var label = opts.label || ('snapshot_' + new Date().toISOString().replace(/[:.]/g, '-'));
  var result = db.prepare(
    "INSERT INTO config_snapshots (label, settings_json, publish_rules_json, created_by, import_filename) " +
    "VALUES (?, ?, ?, ?, ?)"
  ).run(
    label,
    JSON.stringify(managed),
    JSON.stringify(importedRules),
    opts.createdBy || 'system',
    opts.filename || null
  );
  return Number(result.lastInsertRowid);
}

function restoreSnapshot(db, snapshotId) {
  var snap = db.prepare(
    "SELECT id, label, settings_json, publish_rules_json, created_at FROM config_snapshots WHERE id = ?"
  ).get(snapshotId);
  if (!snap) throw new Error('Snapshot ' + snapshotId + ' not found');
  var settingsToRestore = JSON.parse(snap.settings_json || '{}');
  var rulesToRestore    = JSON.parse(snap.publish_rules_json || '[]');

  var restore = db.transaction(function () {
    // 1. Restore only the IMPORT_MANAGED_SETTING_KEYS — leave everything else alone
    for (var i = 0; i < IMPORT_MANAGED_SETTING_KEYS.length; i++) {
      var k = IMPORT_MANAGED_SETTING_KEYS[i];
      if (settingsToRestore[k] !== undefined) {
        _setSetting(db, k, settingsToRestore[k]);
      } else {
        // Key wasn't in the snapshot — clear it to match the snapshot state
        db.prepare("DELETE FROM settings WHERE key = ?").run(k);
      }
    }

    // 2. Wipe only source='import' rules; leave manual rules untouched
    db.prepare("DELETE FROM publish_rules WHERE source = 'import'").run();

    // 3. Re-insert the import rules from the snapshot
    var insertRule = db.prepare(
      "INSERT INTO publish_rules (key, rule_name, priority, match_source_domain, " +
      "match_source_category, match_title_keyword, wp_category_ids, wp_primary_cat_id, " +
      "wp_tag_ids, wp_author_id, is_active, source, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', datetime('now'), datetime('now'))"
    );
    for (var ri = 0; ri < rulesToRestore.length; ri++) {
      var r = rulesToRestore[ri];
      insertRule.run(
        r.key,
        r.rule_name,
        r.priority || 0,
        r.match_source_domain || null,
        r.match_source_category || null,
        r.match_title_keyword || null,
        r.wp_category_ids || null,
        r.wp_primary_cat_id || null,
        r.wp_tag_ids || null,
        r.wp_author_id || null,
        r.is_active == null ? 1 : r.is_active
      );
    }
  });

  restore();
  return { snapshot_id: snap.id, label: snap.label, restored_at: new Date().toISOString() };
}

// Keep every is_baseline=1 row (day-zero factory defaults) plus the 10 most
// recent non-baseline rows. The old implementation hardcoded id=1 as the
// baseline, which broke if the table was ever TRUNCATEd and re-seeded — the
// new baseline would get a non-1 autoincrement id and then be pruned on the
// 11th import. Marking by column makes this data-driven and resilient.
function pruneSnapshots(db) {
  try {
    var stale = db.prepare(
      "SELECT id FROM config_snapshots " +
      "WHERE (is_baseline IS NULL OR is_baseline = 0) " +
      "ORDER BY id DESC LIMIT -1 OFFSET 10"
    ).all();
    for (var i = 0; i < stale.length; i++) {
      db.prepare("DELETE FROM config_snapshots WHERE id = ?").run(stale[i].id);
    }
  } catch (e) { /* non-fatal */ }
}

function listSnapshots(db) {
  return db.prepare(
    "SELECT id, label, created_by, import_filename, created_at " +
    "FROM config_snapshots ORDER BY id DESC"
  ).all();
}

// ─── Apply ──────────────────────────────────────────────────────────────────
//
// Wraps the whole import in a single SQLite transaction. WP-side category
// auto-creation happens BEFORE the transaction (it's async/network) so the
// transaction itself is purely synchronous DB work and can't be left in a
// half-applied state.

async function applyImport(parsed, ctx) {
  var db = ctx.db;
  var classifier = ctx.classifier;
  var config = ctx.config;
  var logger = ctx.logger;

  // Step 1 — resolve all referenced authors against the WP taxonomy cache.
  // Hard-fail if any are missing. We never auto-create WP users.
  var requiredAuthors = _collectReferencedAuthors(parsed);
  var wpAuthorMap = _loadWpAuthorMap(db);
  var missingAuthors = [];
  for (var ai = 0; ai < requiredAuthors.length; ai++) {
    if (!wpAuthorMap[requiredAuthors[ai]]) missingAuthors.push(requiredAuthors[ai]);
  }
  if (missingAuthors.length > 0) {
    throw new Error(
      'The following author username(s) must be created in WordPress (and synced via the Taxonomy panel) before importing: ' +
      missingAuthors.join(', ')
    );
  }

  // Step 2 — resolve all referenced categories. For misses, auto-create on
  // WP via resolveCategorySlugs. This is the only network step; it runs
  // outside the SQLite transaction so a network failure doesn't poison it.
  // maxCreatePerCall is raised to 200 here (vs. the 12 used by the rewrite
  // pipeline) because a single import can legitimately reference that many
  // new categories in one shot.
  var requiredCatSlugs = _collectReferencedCategories(parsed);
  if (requiredCatSlugs.length > 0) {
    try {
      await resolveCategorySlugs(db, config, requiredCatSlugs, { logger: logger, maxCreatePerCall: 200 });
    } catch (catErr) {
      throw new Error('Failed to resolve/create categories on WordPress: ' + catErr.message);
    }
    // Verify every referenced category now resolves. resolveCategorySlugs
    // silently skips any slug that hits an error, so we must re-check the
    // cache and hard-fail if anything is still missing — otherwise publish
    // rules that reference those slugs would silently save null WP IDs.
    var postCatMap = _loadWpCategoryMap(db);
    var stillMissingCats = [];
    for (var scm = 0; scm < requiredCatSlugs.length; scm++) {
      if (!postCatMap[requiredCatSlugs[scm]]) stillMissingCats.push(requiredCatSlugs[scm]);
    }
    if (stillMissingCats.length > 0) {
      throw new Error(
        'Failed to create ' + stillMissingCats.length + ' categories on WordPress (check WP REST permissions): ' +
        stillMissingCats.slice(0, 10).join(', ') + (stillMissingCats.length > 10 ? ' and ' + (stillMissingCats.length - 10) + ' more' : '')
      );
    }
  }

  // Step 3 — resolve referenced tag slugs (auto-creates missing tags). Same
  // network-outside-transaction reasoning, same raised cap.
  var requiredTagSlugs = _collectReferencedTagSlugs(parsed);
  if (requiredTagSlugs.length > 0) {
    try {
      await resolveTagNames(db, config, requiredTagSlugs, { logger: logger, maxCreatePerCall: 200 });
    } catch (tagErr) {
      // Non-fatal — publish rules referencing missing tags will save without those tag IDs.
      if (logger) logger.warn('config-import', 'Tag resolution had errors (non-fatal): ' + tagErr.message);
    }
  }

  // Step 4 — reload WP maps now that resolver may have added rows
  var wpCatMap = _loadWpCategoryMap(db);
  wpAuthorMap = _loadWpAuthorMap(db);
  var wpTagMap = _loadWpTagMap(db);

  // Step 5 — snapshot + apply in one atomic transaction. Previously the
  // snapshot ran outside the apply transaction, which left a window where a
  // concurrent writer (another admin tab / a poll tick / a manual setting
  // save) could mutate the managed state between the snapshot read and the
  // apply write, making the "before" snapshot point to an inconsistent state.
  var snapshotId;
  var summary;
  var snapshotAndApply = db.transaction(function () {
    snapshotId = captureSnapshot(db, {
      label: 'before_import_' + new Date().toISOString().replace(/[:.]/g, '-'),
      createdBy: ctx.createdBy || 'admin',
      filename: ctx.filename || null,
    });
    summary = _applyTx(db, parsed, { wpAuthorMap: wpAuthorMap, wpCatMap: wpCatMap, wpTagMap: wpTagMap });
  });
  snapshotAndApply();

  // Step 6 — prune old snapshots.
  pruneSnapshots(db);

  // Step 7 — hot-reload classifier so new dictionaries take effect immediately.
  if (classifier && typeof classifier.reloadDictionaries === 'function') {
    try {
      classifier.reloadDictionaries();
    } catch (e) {
      if (logger) logger.warn('config-import', 'Classifier reload failed (non-fatal): ' + e.message);
    }
  }

  return { snapshot_id: snapshotId, summary: summary };
}

// The actual writes — runs inside the transaction. Pure SQLite work, no I/O.
function _applyTx(db, parsed, maps) {
  var counts = {
    defaults_changed: 0,
    authors_added: 0, authors_updated: 0,
    categories_added: 0, categories_updated: 0,
    tags_changed: 0,
    routing_hints_changed: 0,
    publish_rules_added: 0, publish_rules_updated: 0,
  };

  // defaults
  if (parsed.defaults && typeof parsed.defaults === 'object') {
    var defaultsKeyMap = {
      post_status:             'WP_POST_STATUS',
      comment_status:          'WP_COMMENT_STATUS',
      ping_status:             'WP_PING_STATUS',
      default_author_username: 'DEFAULT_AUTHOR_USERNAME',
      default_category_slug:   'DEFAULT_CATEGORY_SLUG',
    };
    var dKeys = Object.keys(defaultsKeyMap);
    for (var di = 0; di < dKeys.length; di++) {
      if (parsed.defaults[dKeys[di]] !== undefined) {
        _setSetting(db, defaultsKeyMap[dKeys[di]], parsed.defaults[dKeys[di]]);
        counts.defaults_changed++;
      }
    }
  }

  // authors
  if (Array.isArray(parsed.authors) && parsed.authors.length > 0) {
    var currentAuthorDicts = _parseJsonSetting(db, 'CLASSIFIER_AUTHOR_DICTIONARIES', {});
    for (var ai = 0; ai < parsed.authors.length; ai++) {
      var author = parsed.authors[ai];
      var existed = currentAuthorDicts[author.username] !== undefined;
      var merged = _mergeWithNullDelete(currentAuthorDicts[author.username] || {}, author.keywords || {});
      currentAuthorDicts[author.username] = merged;
      if (existed) counts.authors_updated++;
      else counts.authors_added++;
    }
    _setSetting(db, 'CLASSIFIER_AUTHOR_DICTIONARIES', JSON.stringify(currentAuthorDicts));
  }

  // categories
  if (Array.isArray(parsed.categories) && parsed.categories.length > 0) {
    var currentCatDicts = _parseJsonSetting(db, 'CLASSIFIER_CATEGORY_DICTIONARIES', {});
    var currentCatToAuthor = _parseJsonSetting(db, 'CLASSIFIER_CATEGORY_TO_AUTHOR', {});
    for (var ci = 0; ci < parsed.categories.length; ci++) {
      var cat = parsed.categories[ci];
      var catExisted = currentCatDicts[cat.slug] !== undefined;
      var mergedCat = _mergeWithNullDelete(currentCatDicts[cat.slug] || {}, cat.keywords || {});
      currentCatDicts[cat.slug] = mergedCat;
      if (cat.default_author_username) {
        currentCatToAuthor[cat.slug] = cat.default_author_username;
      }
      if (catExisted) counts.categories_updated++;
      else counts.categories_added++;
    }
    _setSetting(db, 'CLASSIFIER_CATEGORY_DICTIONARIES', JSON.stringify(currentCatDicts));
    _setSetting(db, 'CLASSIFIER_CATEGORY_TO_AUTHOR',    JSON.stringify(currentCatToAuthor));
  }

  // tags
  if (parsed.tags && typeof parsed.tags === 'object') {
    var currentTagMap = _parseJsonSetting(db, 'CLASSIFIER_TAG_NORMALIZATION', {});
    var merged = _mergeWithNullDelete(currentTagMap, parsed.tags);
    _setSetting(db, 'CLASSIFIER_TAG_NORMALIZATION', JSON.stringify(merged));
    counts.tags_changed = Object.keys(parsed.tags).length;
  }

  // routing_hints
  if (parsed.routing_hints && typeof parsed.routing_hints === 'object') {
    var rh = parsed.routing_hints;
    if (rh.domains && typeof rh.domains === 'object') {
      var curDomains = _parseJsonSetting(db, 'CLASSIFIER_DOMAIN_HINTS', {});
      _setSetting(db, 'CLASSIFIER_DOMAIN_HINTS', JSON.stringify(_mergeWithNullDelete(curDomains, rh.domains)));
      counts.routing_hints_changed += Object.keys(rh.domains).length;
    }
    if (rh.source_categories && typeof rh.source_categories === 'object') {
      var curSrcCat = _parseJsonSetting(db, 'CLASSIFIER_SOURCE_CATEGORY_HINTS', {});
      _setSetting(db, 'CLASSIFIER_SOURCE_CATEGORY_HINTS', JSON.stringify(_mergeWithNullDelete(curSrcCat, rh.source_categories)));
      counts.routing_hints_changed += Object.keys(rh.source_categories).length;
    }
    if (rh.category_to_author && typeof rh.category_to_author === 'object') {
      var curCatAuth = _parseJsonSetting(db, 'CLASSIFIER_CATEGORY_TO_AUTHOR', {});
      _setSetting(db, 'CLASSIFIER_CATEGORY_TO_AUTHOR', JSON.stringify(_mergeWithNullDelete(curCatAuth, rh.category_to_author)));
      counts.routing_hints_changed += Object.keys(rh.category_to_author).length;
    }
  }

  // publish_rules — upsert by key
  if (Array.isArray(parsed.publish_rules)) {
    var insertOrUpdate = db.prepare(
      "INSERT INTO publish_rules (key, rule_name, priority, match_source_domain, " +
      "match_source_category, match_title_keyword, wp_category_ids, wp_primary_cat_id, " +
      "wp_tag_ids, wp_author_id, is_active, source, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'import', datetime('now'), datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET " +
      "  rule_name             = excluded.rule_name, " +
      "  priority              = excluded.priority, " +
      "  match_source_domain   = excluded.match_source_domain, " +
      "  match_source_category = excluded.match_source_category, " +
      "  match_title_keyword   = excluded.match_title_keyword, " +
      "  wp_category_ids       = excluded.wp_category_ids, " +
      "  wp_primary_cat_id     = excluded.wp_primary_cat_id, " +
      "  wp_tag_ids            = excluded.wp_tag_ids, " +
      "  wp_author_id          = excluded.wp_author_id, " +
      "  is_active             = excluded.is_active, " +
      "  source                = 'import', " +
      "  updated_at            = datetime('now')"
    );
    var existingKeys = {};
    var existing = db.prepare("SELECT key FROM publish_rules WHERE key IS NOT NULL").all();
    for (var ek = 0; ek < existing.length; ek++) existingKeys[existing[ek].key] = true;

    for (var ri = 0; ri < parsed.publish_rules.length; ri++) {
      var rule = parsed.publish_rules[ri];
      var assign = rule.assign || {};
      var match = rule.match || {};

      // Resolve category slugs → IDs via cache (populated in step 2 above)
      var catIds = [];
      if (Array.isArray(assign.category_slugs)) {
        for (var csi = 0; csi < assign.category_slugs.length; csi++) {
          var cid = maps.wpCatMap[assign.category_slugs[csi]];
          if (cid) catIds.push(cid);
        }
      }
      var primCatId = assign.primary_category_slug ? (maps.wpCatMap[assign.primary_category_slug] || null) : null;

      // Resolve tag slugs → IDs (best-effort; skipped if not in cache)
      var tagIds = [];
      if (Array.isArray(assign.tag_slugs)) {
        for (var tsi = 0; tsi < assign.tag_slugs.length; tsi++) {
          var tid = maps.wpTagMap[assign.tag_slugs[tsi]];
          if (tid) tagIds.push(tid);
        }
      }

      var authorId = assign.author_username ? (maps.wpAuthorMap[assign.author_username] || null) : null;
      var isActive = (rule.is_active === false) ? 0 : 1;

      insertOrUpdate.run(
        rule.key,
        rule.name || rule.key,
        rule.priority || 0,
        match.source_domain || null,
        match.source_category || null,
        match.title_keyword || null,
        catIds.length ? JSON.stringify(catIds) : null,
        primCatId,
        tagIds.length ? JSON.stringify(tagIds) : null,
        authorId,
        isActive
      );

      if (existingKeys[rule.key]) counts.publish_rules_updated++;
      else counts.publish_rules_added++;
    }
  }

  // modules — stored verbatim, no logic depends on it yet
  if (parsed.modules && typeof parsed.modules === 'object') {
    _setSetting(db, 'MODULE_ROUTING_CONFIG', JSON.stringify(parsed.modules));
  }

  return counts;
}

// ─── Helper: collect referenced slugs/usernames for cross-checks ────────────

function _collectReferencedAuthors(parsed) {
  var set = {};
  if (parsed.defaults && parsed.defaults.default_author_username) {
    set[parsed.defaults.default_author_username] = true;
  }
  if (Array.isArray(parsed.authors)) {
    for (var i = 0; i < parsed.authors.length; i++) {
      if (parsed.authors[i].username) set[parsed.authors[i].username] = true;
    }
  }
  if (Array.isArray(parsed.categories)) {
    for (var j = 0; j < parsed.categories.length; j++) {
      if (parsed.categories[j].default_author_username) set[parsed.categories[j].default_author_username] = true;
    }
  }
  if (parsed.routing_hints && parsed.routing_hints.category_to_author) {
    var rhKeys = Object.keys(parsed.routing_hints.category_to_author);
    for (var k = 0; k < rhKeys.length; k++) {
      var v = parsed.routing_hints.category_to_author[rhKeys[k]];
      if (v) set[v] = true;
    }
  }
  if (Array.isArray(parsed.publish_rules)) {
    for (var r = 0; r < parsed.publish_rules.length; r++) {
      var au = parsed.publish_rules[r].assign && parsed.publish_rules[r].assign.author_username;
      if (au) set[au] = true;
    }
  }
  return Object.keys(set);
}

function _collectReferencedCategories(parsed) {
  var set = {};
  if (Array.isArray(parsed.categories)) {
    for (var i = 0; i < parsed.categories.length; i++) {
      if (parsed.categories[i].slug) set[parsed.categories[i].slug] = true;
    }
  }
  if (Array.isArray(parsed.publish_rules)) {
    for (var j = 0; j < parsed.publish_rules.length; j++) {
      var assign = parsed.publish_rules[j].assign || {};
      if (Array.isArray(assign.category_slugs)) {
        for (var k = 0; k < assign.category_slugs.length; k++) set[assign.category_slugs[k]] = true;
      }
      if (assign.primary_category_slug) set[assign.primary_category_slug] = true;
    }
  }
  if (parsed.routing_hints && parsed.routing_hints.domains) {
    var dKeys = Object.keys(parsed.routing_hints.domains);
    for (var d = 0; d < dKeys.length; d++) {
      var slug = parsed.routing_hints.domains[dKeys[d]];
      if (slug) set[slug] = true;
    }
  }
  return Object.keys(set);
}

function _collectReferencedTagSlugs(parsed) {
  var set = {};
  if (Array.isArray(parsed.publish_rules)) {
    for (var j = 0; j < parsed.publish_rules.length; j++) {
      var tags = parsed.publish_rules[j].assign && parsed.publish_rules[j].assign.tag_slugs;
      if (Array.isArray(tags)) {
        for (var k = 0; k < tags.length; k++) set[tags[k]] = true;
      }
    }
  }
  return Object.keys(set);
}

function _loadWpAuthorMap(db) {
  var map = {};
  try {
    var rows = db.prepare(
      "SELECT slug, name, wp_id FROM wp_taxonomy_cache WHERE tax_type = 'author'"
    ).all();
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].slug) map[rows[i].slug] = rows[i].wp_id;
      if (rows[i].name) map[String(rows[i].name).toLowerCase()] = rows[i].wp_id;
    }
  } catch (e) { /* tolerate */ }
  return map;
}

function _loadWpCategoryMap(db) {
  var map = {};
  try {
    var rows = db.prepare(
      "SELECT slug, name, wp_id FROM wp_taxonomy_cache WHERE tax_type = 'category'"
    ).all();
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].slug) map[rows[i].slug] = rows[i].wp_id;
    }
  } catch (e) { /* tolerate */ }
  return map;
}

function _loadWpTagMap(db) {
  var map = {};
  try {
    var rows = db.prepare(
      "SELECT slug, name, wp_id FROM wp_taxonomy_cache WHERE tax_type = 'tag'"
    ).all();
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].slug) map[rows[i].slug] = rows[i].wp_id;
      if (rows[i].name) map[String(rows[i].name).toLowerCase()] = rows[i].wp_id;
    }
  } catch (e) { /* tolerate */ }
  return map;
}

// ─── Export — synthesize an import-shaped JSON from current state ───────────

// Hardcoded credential deny-list. NEVER include these in exports, even by
// accident. We don't rely on naming conventions like *_KEY or *_PASSWORD —
// every excluded key is listed explicitly so a future setting key with an
// unusual name can't slip through.
var EXPORT_CREDENTIAL_DENYLIST = [
  'WP_USERNAME', 'WP_APP_PASSWORD', 'WP_URL', 'WP_SITE_URL',
  'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY',
  'INFRANODUS_API_KEY', 'JINA_API_KEY',
  'FUEL_RAPIDAPI_KEY', 'METALS_RAPIDAPI_KEY',
  'FIREHOSE_TOKEN', 'FIREHOSE_MANAGEMENT_KEY',
  'DASHBOARD_PASSWORD', 'DASHBOARD_PASSWORD_HASH', 'SESSION_SECRET',
];

function exportConfig(db) {
  var out = {
    version: '1.0',
    generated_at: new Date().toISOString(),
    notes: 'Exported from HDF AutoPub. Re-importable as-is.',
    defaults: {},
    authors: [],
    categories: [],
    tags: {},
    routing_hints: {},
    publish_rules: [],
    modules: null,
  };

  // defaults — read each managed key, skip credentials
  var defaultsKeyReverseMap = {
    WP_POST_STATUS:          'post_status',
    WP_COMMENT_STATUS:       'comment_status',
    WP_PING_STATUS:          'ping_status',
    DEFAULT_AUTHOR_USERNAME: 'default_author_username',
    DEFAULT_CATEGORY_SLUG:   'default_category_slug',
  };
  var dKeys = Object.keys(defaultsKeyReverseMap);
  for (var di = 0; di < dKeys.length; di++) {
    if (_indexOf(EXPORT_CREDENTIAL_DENYLIST, dKeys[di]) !== -1) continue;
    var v = _getSetting(db, dKeys[di]);
    if (v !== null && v !== undefined && v !== '') {
      out.defaults[defaultsKeyReverseMap[dKeys[di]]] = v;
    }
  }

  // authors — derive from CLASSIFIER_AUTHOR_DICTIONARIES
  var authorDicts = _parseJsonSetting(db, 'CLASSIFIER_AUTHOR_DICTIONARIES', {});
  var authorUsernames = Object.keys(authorDicts);
  var wpAuthors = _loadWpAuthorMap(db);
  for (var au = 0; au < authorUsernames.length; au++) {
    var un = authorUsernames[au];
    out.authors.push({
      username: un,
      display_name: '', // not stored locally; admin can fill in if needed
      beats: [],        // not stored locally
      keywords: authorDicts[un] || {},
    });
  }

  // categories — derive from CLASSIFIER_CATEGORY_DICTIONARIES. Omit
  // default_author_username entirely when there's no mapping (the validator
  // rejects null for that field, and the export must be re-importable as-is).
  var catDicts = _parseJsonSetting(db, 'CLASSIFIER_CATEGORY_DICTIONARIES', {});
  var catToAuthor = _parseJsonSetting(db, 'CLASSIFIER_CATEGORY_TO_AUTHOR', {});
  var catSlugs = Object.keys(catDicts);
  for (var cs = 0; cs < catSlugs.length; cs++) {
    var slug = catSlugs[cs];
    var catRow = {
      slug: slug,
      display_name: '',
      keywords: catDicts[slug] || {},
    };
    if (catToAuthor[slug]) catRow.default_author_username = catToAuthor[slug];
    out.categories.push(catRow);
  }

  // tags
  out.tags = _parseJsonSetting(db, 'CLASSIFIER_TAG_NORMALIZATION', {});

  // routing_hints
  out.routing_hints = {
    domains:            _parseJsonSetting(db, 'CLASSIFIER_DOMAIN_HINTS', {}),
    source_categories:  _parseJsonSetting(db, 'CLASSIFIER_SOURCE_CATEGORY_HINTS', {}),
    category_to_author: catToAuthor,
  };

  // publish_rules — only source='import' rows; UI-managed manual rules stay private
  var rules = db.prepare(
    "SELECT key, rule_name, priority, is_active, " +
    "match_source_domain, match_source_category, match_title_keyword, " +
    "wp_category_ids, wp_primary_cat_id, wp_tag_ids, wp_author_id " +
    "FROM publish_rules WHERE source = 'import' AND key IS NOT NULL " +
    "ORDER BY priority DESC, id ASC"
  ).all();
  // Reverse-map IDs back to slugs/usernames so the export is portable to
  // a different WP install with different numeric IDs.
  var wpCatById = _invertMap(_loadWpCategoryMap(db));
  var wpAuthById = _invertMap(wpAuthors);
  var wpTagById = _invertMap(_loadWpTagMap(db));
  for (var rr = 0; rr < rules.length; rr++) {
    var r = rules[rr];
    var catSlugList = [];
    if (r.wp_category_ids) {
      try {
        var arr = JSON.parse(r.wp_category_ids);
        if (Array.isArray(arr)) {
          for (var ci2 = 0; ci2 < arr.length; ci2++) {
            if (wpCatById[arr[ci2]]) catSlugList.push(wpCatById[arr[ci2]]);
          }
        }
      } catch (e) { /* skip */ }
    }
    var tagSlugList = [];
    if (r.wp_tag_ids) {
      try {
        var tarr = JSON.parse(r.wp_tag_ids);
        if (Array.isArray(tarr)) {
          for (var ti2 = 0; ti2 < tarr.length; ti2++) {
            if (wpTagById[tarr[ti2]]) tagSlugList.push(wpTagById[tarr[ti2]]);
          }
        }
      } catch (e) { /* skip */ }
    }
    out.publish_rules.push({
      key: r.key,
      name: r.rule_name,
      priority: r.priority || 0,
      is_active: r.is_active === 0 ? false : true,
      match: {
        source_domain:   r.match_source_domain || null,
        source_category: r.match_source_category || null,
        title_keyword:   r.match_title_keyword || null,
      },
      assign: {
        category_slugs:        catSlugList,
        primary_category_slug: r.wp_primary_cat_id ? (wpCatById[r.wp_primary_cat_id] || null) : null,
        tag_slugs:             tagSlugList,
        author_username:       r.wp_author_id ? (wpAuthById[r.wp_author_id] || null) : null,
      },
    });
  }

  // modules — emit if MODULE_ROUTING_CONFIG is set; otherwise omit (validator
  // rejects null for this field, and the export must be re-importable as-is).
  var moduleCfg = _parseJsonSetting(db, 'MODULE_ROUTING_CONFIG', null);
  if (moduleCfg) {
    out.modules = moduleCfg;
  } else {
    delete out.modules;
  }

  return out;
}

function _invertMap(map) {
  var out = {};
  var keys = Object.keys(map);
  for (var i = 0; i < keys.length; i++) {
    out[map[keys[i]]] = keys[i];
  }
  return out;
}

function _indexOf(arr, val) {
  for (var i = 0; i < arr.length; i++) if (arr[i] === val) return i;
  return -1;
}

// ─── Public API ─────────────────────────────────────────────────────────────

module.exports = {
  computeDiff: computeDiff,
  applyImport: applyImport,
  captureSnapshot: captureSnapshot,
  restoreSnapshot: restoreSnapshot,
  pruneSnapshots: pruneSnapshots,
  listSnapshots: listSnapshots,
  exportConfig: exportConfig,
  EXPORT_CREDENTIAL_DENYLIST: EXPORT_CREDENTIAL_DENYLIST,
};
