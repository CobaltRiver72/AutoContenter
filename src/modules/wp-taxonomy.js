'use strict';

var axios = require('axios');
var { assertSafeUrl, safeAxiosOptions } = require('../utils/safe-http');

/** Decode HTML entities that WP REST API returns in name fields (e.g. "Gold &amp; Silver" → "Gold & Silver"). */
function _decodeHtml(str) {
  return (str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, function (_, code) { return String.fromCharCode(parseInt(code, 10)); });
}

/**
 * Fetch all pages from a WP REST API endpoint (handles X-WP-TotalPages pagination).
 * Uses ?rest_route= format for Cloudways/Nginx compatibility.
 */
async function _wpFetchAll(wpBaseUrl, authHeader, restPath, extraParams) {
  var results = [];
  var page = 1;
  var totalPages = 1;
  var params = Object.assign({ per_page: 100 }, extraParams || {});

  while (page <= totalPages) {
    var url = wpBaseUrl + '/?rest_route=' + encodeURIComponent(restPath) +
      '&per_page=' + params.per_page + '&page=' + page +
      (params.context ? '&context=' + params.context : '');

    assertSafeUrl(url);
    var resp = await axios.get(url, safeAxiosOptions({
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
      timeout: 20000,
    }));

    if (page === 1) {
      totalPages = Math.min(parseInt(resp.headers['x-wp-totalpages'] || '1', 10) || 1, 100);
    }

    var items = Array.isArray(resp.data) ? resp.data : [];
    results = results.concat(items);
    page++;
  }
  return results;
}

/**
 * Fetch categories, tags, and authors from WordPress and upsert into wp_taxonomy_cache.
 * Returns { categories, tags, authors, errors[] }
 */
async function syncTaxonomyFromWP(db, config) {
  var wpUrl = (config.WP_URL || '').replace(/\/+$/, '');
  var username = config.WP_USERNAME || '';
  var password = config.WP_APP_PASSWORD || '';

  if (!wpUrl || !username || !password) {
    throw new Error('WP credentials not configured (WP_URL, WP_USERNAME, WP_APP_PASSWORD required)');
  }
  assertSafeUrl(wpUrl);

  var authHeader = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');
  var errors = [];

  var categories = [], tags = [], authors = [];

  try {
    categories = await _wpFetchAll(wpUrl, authHeader, '/wp/v2/categories');
  } catch (e) { errors.push('categories: ' + e.message); }

  try {
    tags = await _wpFetchAll(wpUrl, authHeader, '/wp/v2/tags');
  } catch (e) { errors.push('tags: ' + e.message); }

  try {
    authors = await _wpFetchAll(wpUrl, authHeader, '/wp/v2/users', { context: 'edit' });
  } catch (e) { errors.push('authors: ' + e.message); }

  // Upsert into DB using a transaction
  var upsertStmt = db.prepare(
    'INSERT OR REPLACE INTO wp_taxonomy_cache (tax_type, wp_id, name, slug, parent_id, synced_at) ' +
    'VALUES (?, ?, ?, ?, ?, datetime(\'now\'))'
  );

  var upsertAll = db.transaction(function () {
    categories.forEach(function (c) {
      upsertStmt.run('category', c.id, _decodeHtml(c.name), c.slug || '', c.parent || 0);
    });
    tags.forEach(function (t) {
      upsertStmt.run('tag', t.id, _decodeHtml(t.name), t.slug || '', 0);
    });
    authors.forEach(function (a) {
      upsertStmt.run('author', a.id, _decodeHtml(a.name || a.username), a.slug || '', 0);
    });
  });
  upsertAll();

  return {
    categories: categories.length,
    tags: tags.length,
    authors: authors.length,
    errors: errors,
  };
}

/**
 * Get all cached taxonomy entries for a given type ('category', 'tag', 'author').
 */
function getCachedTaxonomy(db, taxType) {
  return db.prepare(
    'SELECT wp_id, name, slug, parent_id, synced_at FROM wp_taxonomy_cache WHERE tax_type = ? ORDER BY name ASC'
  ).all(taxType);
}

/**
 * Get the most recent sync timestamp across all taxonomy types.
 */
function getLastSyncedAt(db) {
  var row = db.prepare('SELECT MAX(synced_at) as ts FROM wp_taxonomy_cache').get();
  return (row && row.ts) || null;
}

/**
 * Normalize a tag name for cache lookup (case-insensitive, trim, collapse whitespace).
 */
function _normalizeTagKey(name) {
  return String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Resolve an array of tag name strings to an array of WP tag IDs.
 * Looks up each name in wp_taxonomy_cache first; for any misses, creates the
 * tag via the WP REST API and caches the new ID. Returns integer IDs only.
 *
 * Safe against launch-time volume: batches WP cache reads, never fails the
 * whole batch if one tag creation errors, and caches slug + name lookups.
 *
 * @param {Database} db
 * @param {object}   config  — must expose WP_URL, WP_USERNAME, WP_APP_PASSWORD
 * @param {string[]} tagNames
 * @param {object}   [opts]  — { logger, maxCreatePerCall: 12 }
 * @returns {Promise<number[]>}
 */
async function resolveTagNames(db, config, tagNames, opts) {
  opts = opts || {};
  var logger = opts.logger || null;
  var maxCreate = opts.maxCreatePerCall || 12;

  if (!Array.isArray(tagNames) || tagNames.length === 0) return [];

  // Deduplicate + normalize
  var seen = {};
  var wanted = [];
  for (var i = 0; i < tagNames.length; i++) {
    var raw = tagNames[i];
    if (!raw) continue;
    var key = _normalizeTagKey(raw);
    if (!key || seen[key]) continue;
    seen[key] = true;
    wanted.push({ raw: String(raw).trim(), key: key });
  }
  if (wanted.length === 0) return [];

  // ── Step 1: Build an in-memory cache from wp_taxonomy_cache ────────────
  var cacheByKey = {};
  try {
    var rows = db.prepare(
      "SELECT wp_id, name, slug FROM wp_taxonomy_cache WHERE tax_type = 'tag'"
    ).all();
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      if (row.name) cacheByKey[_normalizeTagKey(row.name)] = row.wp_id;
      if (row.slug) cacheByKey[_normalizeTagKey(row.slug)] = row.wp_id;
    }
  } catch (e) {
    if (logger) logger.warn('[wp-taxonomy] resolveTagNames: cache read failed: ' + e.message);
  }

  // ── Step 2: Separate cache hits from misses ────────────────────────────
  var ids = [];
  var misses = [];
  for (var w = 0; w < wanted.length; w++) {
    var hit = cacheByKey[wanted[w].key];
    if (hit) {
      ids.push(hit);
    } else {
      misses.push(wanted[w]);
    }
  }

  if (misses.length === 0) return ids;

  // ── Step 3: Create missing tags in WP (bounded per call) ───────────────
  var wpUrl = (config.WP_URL || '').replace(/\/+$/, '');
  var username = config.WP_USERNAME || '';
  var password = config.WP_APP_PASSWORD || '';
  if (!wpUrl || !username || !password) {
    if (logger) logger.warn('[wp-taxonomy] resolveTagNames: WP credentials missing, skipping tag creation');
    return ids;
  }

  try { assertSafeUrl(wpUrl); }
  catch (e) {
    if (logger) logger.warn('[wp-taxonomy] resolveTagNames: unsafe WP URL, skipping: ' + e.message);
    return ids;
  }

  var authHeader = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');

  var upsertStmt = null;
  try {
    upsertStmt = db.prepare(
      'INSERT OR REPLACE INTO wp_taxonomy_cache (tax_type, wp_id, name, slug, parent_id, synced_at) ' +
      'VALUES (?, ?, ?, ?, 0, datetime(\'now\'))'
    );
  } catch (e) {
    if (logger) logger.warn('[wp-taxonomy] resolveTagNames: prepare failed: ' + e.message);
  }

  var toCreate = misses.slice(0, maxCreate);
  for (var c = 0; c < toCreate.length; c++) {
    var tag = toCreate[c];
    var createUrl = wpUrl + '/?rest_route=' + encodeURIComponent('/wp/v2/tags');
    try {
      assertSafeUrl(createUrl);
      var resp = await axios.post(createUrl, { name: tag.raw }, safeAxiosOptions({
        headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
        timeout: 15000,
        validateStatus: function (s) { return (s >= 200 && s < 300) || s === 400; },
      }));

      var created = resp.data || {};

      // If tag already existed, WP returns 400 with the existing term's ID in data
      if (resp.status === 400 && created.data && created.data.term_id) {
        var existingId = Number(created.data.term_id);
        if (Number.isFinite(existingId)) {
          ids.push(existingId);
          if (upsertStmt) {
            try { upsertStmt.run('tag', existingId, tag.raw, '', ); } catch (e) {}
          }
        }
        continue;
      }

      if (created.id && Number.isFinite(Number(created.id))) {
        var newId = Number(created.id);
        ids.push(newId);
        if (upsertStmt) {
          try { upsertStmt.run('tag', newId, _decodeHtml(created.name || tag.raw), created.slug || ''); } catch (e) {}
        }
      }
    } catch (err) {
      // Non-blocking: log and continue. A single failed tag must not fail the publish.
      if (logger) logger.warn('[wp-taxonomy] resolveTagNames: create failed for "' + tag.raw + '": ' + err.message);
    }
  }

  return ids;
}

/**
 * Resolve an array of category slug strings to an array of WP category IDs.
 * Looks up each slug in wp_taxonomy_cache first; for any misses, creates the
 * category via the WP REST API and caches the new ID. Returns integer IDs only.
 *
 * Safe against launch-time volume: batches WP cache reads, never fails the
 * whole batch if one category creation errors, and caches slug lookups.
 *
 * @param {Database} db
 * @param {object}   config  — must expose WP_URL, WP_USERNAME, WP_APP_PASSWORD
 * @param {string[]} slugs
 * @param {object}   [opts]  — { logger, maxCreatePerCall: 12 }
 * @returns {Promise<number[]>}
 */
async function resolveCategorySlugs(db, config, slugs, opts) {
  opts = opts || {};
  var logger = opts.logger || null;
  var maxCreate = opts.maxCreatePerCall || 12;

  if (!Array.isArray(slugs) || slugs.length === 0) return [];

  // Deduplicate + normalize
  var seen = {};
  var wanted = [];
  for (var i = 0; i < slugs.length; i++) {
    var raw = slugs[i];
    if (!raw) continue;
    var key = String(raw).trim().toLowerCase();
    if (!key || seen[key]) continue;
    seen[key] = true;
    wanted.push({ raw: key, key: key });
  }
  if (wanted.length === 0) return [];

  // ── Step 1: Build an in-memory cache from wp_taxonomy_cache ────────────
  var cacheBySlug = {};
  try {
    var rows = db.prepare(
      "SELECT wp_id, name, slug FROM wp_taxonomy_cache WHERE tax_type = 'category'"
    ).all();
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      if (row.slug) cacheBySlug[String(row.slug).trim().toLowerCase()] = row.wp_id;
    }
  } catch (e) {
    if (logger) logger.warn('[wp-taxonomy] resolveCategorySlugs: cache read failed: ' + e.message);
  }

  // ── Step 2: Separate cache hits from misses ────────────────────────────
  var ids = [];
  var misses = [];
  for (var w = 0; w < wanted.length; w++) {
    var hit = cacheBySlug[wanted[w].key];
    if (hit) {
      ids.push(hit);
    } else {
      misses.push(wanted[w]);
    }
  }

  if (misses.length === 0) return ids;

  // ── Step 3: Create missing categories in WP (bounded per call) ─────────
  var wpUrl = (config.WP_URL || '').replace(/\/+$/, '');
  var username = config.WP_USERNAME || '';
  var password = config.WP_APP_PASSWORD || '';
  if (!wpUrl || !username || !password) {
    if (logger) logger.warn('[wp-taxonomy] resolveCategorySlugs: WP credentials missing, skipping category creation');
    return ids;
  }

  try { assertSafeUrl(wpUrl); }
  catch (e) {
    if (logger) logger.warn('[wp-taxonomy] resolveCategorySlugs: unsafe WP URL, skipping: ' + e.message);
    return ids;
  }

  var authHeader = 'Basic ' + Buffer.from(username + ':' + password).toString('base64');

  var upsertStmt = null;
  try {
    upsertStmt = db.prepare(
      'INSERT OR REPLACE INTO wp_taxonomy_cache (tax_type, wp_id, name, slug, parent_id, synced_at) ' +
      'VALUES (?, ?, ?, ?, 0, datetime(\'now\'))'
    );
  } catch (e) {
    if (logger) logger.warn('[wp-taxonomy] resolveCategorySlugs: prepare failed: ' + e.message);
  }

  var toCreate = misses.slice(0, maxCreate);
  for (var c = 0; c < toCreate.length; c++) {
    var cat = toCreate[c];
    var createUrl = wpUrl + '/?rest_route=' + encodeURIComponent('/wp/v2/categories');
    try {
      assertSafeUrl(createUrl);
      var resp = await axios.post(createUrl, { name: cat.raw, slug: cat.raw }, safeAxiosOptions({
        headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
        timeout: 15000,
        validateStatus: function (s) { return (s >= 200 && s < 300) || s === 400; },
      }));

      var created = resp.data || {};

      // If category already existed, WP returns 400 with the existing term's ID in data
      if (resp.status === 400 && created.data && created.data.term_id) {
        var existingId = Number(created.data.term_id);
        if (Number.isFinite(existingId)) {
          ids.push(existingId);
          if (upsertStmt) {
            try { upsertStmt.run('category', existingId, cat.raw, cat.raw); } catch (e) {}
          }
        }
        continue;
      }

      if (created.id && Number.isFinite(Number(created.id))) {
        var newId = Number(created.id);
        ids.push(newId);
        if (upsertStmt) {
          try { upsertStmt.run('category', newId, _decodeHtml(created.name || cat.raw), created.slug || cat.raw); } catch (e) {}
        }
      }
    } catch (err) {
      // Non-blocking: log and continue. A single failed category must not fail the publish.
      if (logger) logger.warn('[wp-taxonomy] resolveCategorySlugs: create failed for "' + cat.raw + '": ' + err.message);
    }
  }

  return ids;
}

module.exports = { syncTaxonomyFromWP, getCachedTaxonomy, getLastSyncedAt, resolveTagNames, resolveCategorySlugs };
