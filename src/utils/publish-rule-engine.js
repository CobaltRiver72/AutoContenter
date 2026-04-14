'use strict';

/**
 * Evaluate all active publish_rules in priority order and return the resolved
 * taxonomy for the given draft. Per-draft overrides (wp_category_ids etc.) on
 * the draft row take precedence over any rule.
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

  // --- Merge: draft override > rule > global default ---
  var categoryIds = draftCategoryIds.length   ? draftCategoryIds
                  : (matchedRule && parseIds(matchedRule.wp_category_ids).length)
                      ? parseIds(matchedRule.wp_category_ids)
                  : [defaultCategoryId];

  var primaryCategoryId = draftPrimaryCatId
    || (matchedRule && matchedRule.wp_primary_cat_id ? Number(matchedRule.wp_primary_cat_id) : null)
    || categoryIds[0]
    || defaultCategoryId;

  // Primary category MUST be in the categories array (WP requirement)
  if (categoryIds.indexOf(primaryCategoryId) === -1) categoryIds = [primaryCategoryId].concat(categoryIds);

  var tagIds = draftTagIds.length ? draftTagIds
             : (matchedRule && parseIds(matchedRule.wp_tag_ids).length)
                 ? parseIds(matchedRule.wp_tag_ids)
             : [];

  var authorId = draftAuthorId
    || (matchedRule && matchedRule.wp_author_id ? Number(matchedRule.wp_author_id) : null)
    || defaultAuthorId;

  var postStatus = draft.wp_post_status_override || null;
  return { categoryIds: categoryIds, primaryCategoryId: primaryCategoryId, tagIds: tagIds, authorId: authorId, postStatus: postStatus };
}

module.exports = { resolveTaxonomy };
