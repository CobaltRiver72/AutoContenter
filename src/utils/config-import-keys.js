'use strict';

// Single source of truth for which settings keys the bulk-import system owns.
// Snapshot/rollback serializes ONLY these keys; everything else in the
// settings table (API keys, pipeline timing, rate limits, WP credentials, etc.)
// is left untouched by both snapshot capture and rollback restore.
//
// If you add a new section to the import schema, add its destination key here
// AND in src/utils/config.js DEFAULTS so it has a default value.
var IMPORT_MANAGED_SETTING_KEYS = [
  // Post defaults (defaults section in import schema)
  'WP_POST_STATUS',
  'WP_COMMENT_STATUS',
  'WP_PING_STATUS',
  'DEFAULT_AUTHOR_USERNAME',
  'DEFAULT_CATEGORY_SLUG',

  // Classifier dictionaries (authors[].keywords + categories[].keywords)
  'CLASSIFIER_CATEGORY_DICTIONARIES',
  'CLASSIFIER_AUTHOR_DICTIONARIES',

  // Classifier override maps (replace hardcoded constants in content-classifier.js)
  'CLASSIFIER_TAG_NORMALIZATION',     // tags section
  'CLASSIFIER_DOMAIN_HINTS',          // routing_hints.domains
  'CLASSIFIER_SOURCE_CATEGORY_HINTS', // routing_hints.source_categories
  'CLASSIFIER_CATEGORY_TO_AUTHOR',    // routing_hints.category_to_author + categories[].default_author_username

  // Forward-compat: modules section, parsed and stored, not yet read by anything
  'MODULE_ROUTING_CONFIG',
];

module.exports = { IMPORT_MANAGED_SETTING_KEYS: IMPORT_MANAGED_SETTING_KEYS };
