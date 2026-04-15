'use strict';

/**
 * Look up a WP author's numeric ID from their slug/username via the
 * wp_taxonomy_cache. Returns null on any miss/error so the caller can fall
 * through to the next layer of the resolution chain.
 */
function _resolveAuthorUsernameToId(db, username) {
  if (!username) return null;
  try {
    var row = db.prepare(
      "SELECT wp_id FROM wp_taxonomy_cache WHERE tax_type = 'author' AND slug = ? LIMIT 1"
    ).get(String(username).toLowerCase().trim());
    return row ? Number(row.wp_id) : null;
  } catch (e) { return null; }
}

/**
 * Look up a WP category's numeric ID from its slug via the wp_taxonomy_cache.
 * Returns null on any miss/error so the caller can fall through.
 */
function _resolveCategorySlugToId(db, slug) {
  if (!slug) return null;
  try {
    var row = db.prepare(
      "SELECT wp_id FROM wp_taxonomy_cache WHERE tax_type = 'category' AND slug = ? LIMIT 1"
    ).get(String(slug).toLowerCase().trim());
    return row ? Number(row.wp_id) : null;
  } catch (e) { return null; }
}

/**
 * Evaluate all active publish_rules in priority order and return the resolved
 * taxonomy for the given draft. Per-draft overrides (wp_category_ids etc.) on
 * the draft row take precedence over any rule.
 *
 * Resolution chain (each layer falls through to the next on miss):
 *   authorId    = draft override → matching rule → DEFAULT_AUTHOR_USERNAME slug
 *                 → WP_AUTHOR_ID numeric fallback
 *   categoryIds = draft override → matching rule → DEFAULT_CATEGORY_SLUG slug
 *                 → WP_DEFAULT_CATEGORY numeric fallback
 *
 * Returns: { categoryIds: number[], primaryCategoryId: number, tagIds: number[], authorId: number }
 */
function resolveTaxonomy(draft, db, config) {
  function parseIds(val) {
    if (!val) return [];
    try { var arr = JSON.parse(val); return Array.isArray(arr) ? arr.filter(Number.isFinite) : []; }
    catch (e) { return []; }
  }

  var defaultCategoryId = parseInt(config.WP_DEFAULT_CATEGORY, 10) || 1;
  var defaultAuthorId   = parseInt(config.WP_AUTHOR_ID, 10) || 1;

  // Slug-based global defaults — resolve via wp_taxonomy_cache. These sit
  // BETWEEN the matching rule and the numeric config fallback so that admins
  // who set DEFAULT_AUTHOR_USERNAME / DEFAULT_CATEGORY_SLUG (via the Post
  // Defaults form or bulk config import) get their intent honored at publish
  // time. If either lookup misses (empty, not in cache, or table error), the
  // chain falls through to the numeric fallback — preserving existing
  // behavior for every case where the new keys are unset or unresolvable.
  var slugAuthorId    = _resolveAuthorUsernameToId(db, config.DEFAULT_AUTHOR_USERNAME);
  var slugCategoryId  = _resolveCategorySlugToId(db, config.DEFAULT_CATEGORY_SLUG);

  // --- Draft-level overrides (highest priority) ---
  var draftCategoryIds = parseIds(draft.wp_category_ids);
  var draftPrimaryCatId = draft.wp_primary_cat_id ? Number(draft.wp_primary_cat_id) : null;
  var draftTagIds = parseIds(draft.wp_tag_ids);
  var draftAuthorId = draft.wp_author_id_override ? Number(draft.wp_author_id_override) : null;

  // --- Evaluate rules ---
  var matchedRule = null;
  try {
    var rules = db.prepare(
      'SELECT * FROM publish_rules WHERE is_active = 1 ORDER BY priority DESC, id ASC'
    ).all();

    var title = (draft.rewritten_title || draft.extracted_title || draft.source_title || '').toLowerCase();

    for (var i = 0; i < rules.length; i++) {
      var r = rules[i];
      var pass = true;

      if (r.match_source_domain) {
        var domain = (draft.source_domain || '').toLowerCase();
        if (domain !== r.match_source_domain.toLowerCase() &&
            !domain.endsWith('.' + r.match_source_domain.toLowerCase())) {
          pass = false;
        }
      }
      if (pass && r.match_source_category) {
        var cat = (draft.source_category || '').toLowerCase();
        if (cat.indexOf(r.match_source_category.toLowerCase()) === -1) pass = false;
      }
      if (pass && r.match_title_keyword) {
        if (title.indexOf(r.match_title_keyword.toLowerCase()) === -1) pass = false;
      }

      if (pass) { matchedRule = r; break; }
    }
  } catch (e) { /* rules table may not exist yet — ignore */ }

  // --- Merge: draft override > rule > slug default > numeric default ---
  var categoryIds = draftCategoryIds.length   ? draftCategoryIds
                  : (matchedRule && parseIds(matchedRule.wp_category_ids).length)
                      ? parseIds(matchedRule.wp_category_ids)
                  : (slugCategoryId ? [slugCategoryId] : [defaultCategoryId]);

  var primaryCategoryId = draftPrimaryCatId
    || (matchedRule && matchedRule.wp_primary_cat_id ? Number(matchedRule.wp_primary_cat_id) : null)
    || categoryIds[0]
    || slugCategoryId
    || defaultCategoryId;

  // Primary category MUST be in the categories array (WP requirement)
  if (categoryIds.indexOf(primaryCategoryId) === -1) categoryIds = [primaryCategoryId].concat(categoryIds);

  var tagIds = draftTagIds.length ? draftTagIds
             : (matchedRule && parseIds(matchedRule.wp_tag_ids).length)
                 ? parseIds(matchedRule.wp_tag_ids)
             : [];

  var authorId = draftAuthorId
    || (matchedRule && matchedRule.wp_author_id ? Number(matchedRule.wp_author_id) : null)
    || slugAuthorId
    || defaultAuthorId;

  var postStatus = draft.wp_post_status_override || null;
  return { categoryIds: categoryIds, primaryCategoryId: primaryCategoryId, tagIds: tagIds, authorId: authorId, postStatus: postStatus };
}

module.exports = { resolveTaxonomy };
