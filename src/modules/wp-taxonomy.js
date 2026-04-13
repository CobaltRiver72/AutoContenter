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

module.exports = { syncTaxonomyFromWP, getCachedTaxonomy, getLastSyncedAt };
