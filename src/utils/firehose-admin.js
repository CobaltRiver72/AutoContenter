'use strict';

/**
 * firehose-admin — thin wrapper around Ahrefs Firehose management API.
 *
 * The app uses this to provision a tap + rule per Feed on behalf of the
 * admin, instead of asking them to paste a tap token they created manually
 * in the Ahrefs dashboard.
 *
 * Auth model:
 *   • createTap / deleteTap / listTaps / countOrgRules → require the org's
 *     management key (`fhm_` prefix) stored in global settings.
 *   • createRule / updateRule / deleteRule / listRules → require a specific
 *     tap token (`fh_` prefix) that the management key was used to create.
 *
 * All functions return a uniform shape:
 *   success → { ok: true, data: … }
 *   failure → { ok: false, status: <http>, error: <string> }
 *
 * We never throw — callers chain these in a provisioning flow where a single
 * failure needs to trigger a rollback (e.g. tap created but rule creation
 * failed → delete the tap). Throwing from here would force try/catch at every
 * step and risk leaving orphan taps in the user's org.
 */

var axios = require('axios');
var { sanitizeAxiosError } = require('./sanitize-axios-error');

var BASE_URL = 'https://api.firehose.com/v1';
var TIMEOUT_MS = 15000;

function _mgmtHeaders(mgmtKey) {
  return {
    'Authorization': 'Bearer ' + mgmtKey,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

function _tapHeaders(tapToken) {
  return {
    'Authorization': 'Bearer ' + tapToken,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

function _fail(err) {
  var safe = sanitizeAxiosError(err);
  return {
    ok: false,
    status: safe.status || 0,
    error: safe.status === 401 ? 'Firehose rejected the key (401 Unauthorized). Check the token or regenerate it in the Ahrefs dashboard.'
         : safe.status === 403 ? 'Forbidden (403). The key cannot access this resource.'
         : safe.status === 404 ? 'Not found (404).'
         : safe.status === 422 ? 'Validation error (422): ' + (safe.data || safe.message)
         : safe.status === 429 ? 'Rate limited (429). Wait and try again.'
         : safe.status ? 'Firehose API error ' + safe.status + ': ' + (safe.data || safe.message)
         : 'Network error reaching Firehose: ' + safe.message,
  };
}

// ─── Taps ──────────────────────────────────────────────────────────────────

/**
 * List all taps owned by the org that the management key belongs to.
 * Used by countOrgRules and by the UI to show existing taps.
 */
async function listTaps(mgmtKey) {
  try {
    var res = await axios.get(BASE_URL + '/taps', { headers: _mgmtHeaders(mgmtKey), timeout: TIMEOUT_MS });
    var data = res.data && res.data.data ? res.data.data : (Array.isArray(res.data) ? res.data : []);
    return { ok: true, data: data };
  } catch (err) {
    return _fail(err);
  }
}

/**
 * Create a new tap. The response includes the full tap token (it's only
 * visible on create — subsequent listTaps calls return only a token_prefix).
 * Store the full token on the feed row.
 */
async function createTap(mgmtKey, name) {
  try {
    var res = await axios.post(
      BASE_URL + '/taps',
      { name: String(name || 'hdf-feed').slice(0, 120) },
      { headers: _mgmtHeaders(mgmtKey), timeout: TIMEOUT_MS }
    );
    var body = res.data || {};
    var tap = body.data || {};
    return {
      ok: true,
      data: {
        tap_id: tap.id,
        tap_name: tap.name,
        token: body.token || tap.token,
      },
    };
  } catch (err) {
    return _fail(err);
  }
}

/**
 * Delete a tap. Removes all of its rules (frees up space in the org's
 * 25-rule cap). Returns ok:true even when the tap is already gone (404) so
 * retries are safe.
 */
async function deleteTap(mgmtKey, tapId) {
  try {
    await axios.delete(BASE_URL + '/taps/' + encodeURIComponent(tapId), {
      headers: _mgmtHeaders(mgmtKey),
      timeout: TIMEOUT_MS,
    });
    return { ok: true };
  } catch (err) {
    var safe = sanitizeAxiosError(err);
    if (safe.status === 404) return { ok: true, data: { already_gone: true } };
    return _fail(err);
  }
}

// ─── Rules ─────────────────────────────────────────────────────────────────

/**
 * List rules on a tap. Used to sanity-check the provisioned rule exists
 * after a save, and to let the UI show what the admin's tap currently has.
 */
async function listRules(tapToken) {
  try {
    var res = await axios.get(BASE_URL + '/rules', { headers: _tapHeaders(tapToken), timeout: TIMEOUT_MS });
    var data = res.data && res.data.data ? res.data.data : [];
    return { ok: true, data: data };
  } catch (err) {
    return _fail(err);
  }
}

/**
 * Install a Lucene rule on a tap. Returns the new rule's id.
 *
 * @param {string} tapToken
 * @param {string} value - Lucene query (from lucene-builder)
 * @param {string} [tag] - free-form label (we use "feed-<id>")
 * @param {object} [opts] - { quality: boolean, nsfw: boolean }
 */
async function createRule(tapToken, value, tag, opts) {
  try {
    var body = { value: String(value) };
    if (tag) body.tag = String(tag).slice(0, 255);
    if (opts && typeof opts.quality === 'boolean') body.quality = opts.quality;
    if (opts && typeof opts.nsfw === 'boolean') body.nsfw = opts.nsfw;

    var res = await axios.post(BASE_URL + '/rules', body, {
      headers: _tapHeaders(tapToken),
      timeout: TIMEOUT_MS,
    });
    var data = res.data && res.data.data ? res.data.data : res.data;
    return { ok: true, data: data };
  } catch (err) {
    return _fail(err);
  }
}

/**
 * Update an existing rule's Lucene value (and optionally tag / quality / nsfw).
 * Used when an admin edits the Feed's source_config — the tap + rule stay,
 * only the query changes.
 */
async function updateRule(tapToken, ruleId, patch) {
  try {
    var body = {};
    if (patch.value !== undefined)   body.value = String(patch.value);
    if (patch.tag !== undefined)     body.tag = String(patch.tag).slice(0, 255);
    if (patch.quality !== undefined) body.quality = !!patch.quality;
    if (patch.nsfw !== undefined)    body.nsfw = !!patch.nsfw;

    var res = await axios.put(BASE_URL + '/rules/' + encodeURIComponent(ruleId), body, {
      headers: _tapHeaders(tapToken),
      timeout: TIMEOUT_MS,
    });
    var data = res.data && res.data.data ? res.data.data : res.data;
    return { ok: true, data: data };
  } catch (err) {
    return _fail(err);
  }
}

/**
 * Delete a rule by id on a specific tap. Idempotent — 404 counts as success.
 */
async function deleteRule(tapToken, ruleId) {
  try {
    await axios.delete(BASE_URL + '/rules/' + encodeURIComponent(ruleId), {
      headers: _tapHeaders(tapToken),
      timeout: TIMEOUT_MS,
    });
    return { ok: true };
  } catch (err) {
    var safe = sanitizeAxiosError(err);
    if (safe.status === 404) return { ok: true, data: { already_gone: true } };
    return _fail(err);
  }
}

// ─── Org-wide rule count ───────────────────────────────────────────────────
// Ahrefs' "25 rules per org" cap is enforced server-side with a 422. We can
// approximate it locally by summing `rules_count` across all taps (which
// listTaps returns). Used only for pre-flight warnings; the authoritative
// check is the 422 from Ahrefs on createRule.
async function countOrgRules(mgmtKey) {
  var list = await listTaps(mgmtKey);
  if (!list.ok) return list;
  var total = 0;
  for (var i = 0; i < list.data.length; i++) {
    total += list.data[i].rules_count || 0;
  }
  return { ok: true, data: { total: total, limit: 25 } };
}

module.exports = {
  listTaps: listTaps,
  createTap: createTap,
  deleteTap: deleteTap,
  listRules: listRules,
  createRule: createRule,
  updateRule: updateRule,
  deleteRule: deleteRule,
  countOrgRules: countOrgRules,
};
