'use strict';

// Pure validator for POST /api/feeds. Extracted out of the route handler so
// it can be unit-tested without spinning up Express. Used at two layers:
//
//   1. Server (src/routes/api.js POST /api/feeds) — authoritative gate.
//   2. Client (public/js/create-feed-page.js) — mirrored as canSubmit gate
//      via window.__feedValidator (loaded via shared-feed-form.js's UMD
//      wrapper) so the Submit button reflects the same rule before the
//      first round-trip.
//
// Rule (single source of truth):
//   - Feed name is required.
//   - At least ONE matching signal: source_config.query OR
//     source_config.include_domains (non-empty array, or non-empty string
//     for the flat-shape callers used by the test suite).
//   - time_range, allowed_languages, exclude_domains, etc. are
//     refinements — they don't satisfy the "must have something to match
//     on" rule alone.
//
// Returns { valid: boolean, error: string|null }.

function _hasQuery(src) {
  if (!src || src.query == null) return false;
  return String(src.query).trim().length > 0;
}

function _hasIncludeDomains(src) {
  if (!src) return false;
  var v = src.include_domains;
  if (Array.isArray(v)) {
    // Non-empty array of non-empty strings. Filter out blanks because the
    // chip-input UI can write `[''] ` after deletes if not normalized.
    for (var i = 0; i < v.length; i++) {
      if (v[i] && String(v[i]).trim().length > 0) return true;
    }
    return false;
  }
  if (v && typeof v === 'string' && String(v).trim().length > 0) return true;
  return false;
}

/**
 * @param {object} body — feed payload. Accepts both shapes:
 *   - Nested:  { name, source_config: { query, include_domains, … } }
 *     (matches POST /api/feeds wire format)
 *   - Flat:    { name, query, include_domains, … }
 *     (matches the prompt's test examples)
 * @returns {{ valid: boolean, error: string|null }}
 */
function validateFeedInput(body) {
  if (!body || typeof body !== 'object') {
    return { valid: false, error: 'body required' };
  }

  if (!body.name || !String(body.name).trim()) {
    return { valid: false, error: 'Feed name is required.' };
  }

  // Filters can be nested under source_config (API shape) or flat (test
  // shape). Pick whichever the caller used.
  var src = (body.source_config && typeof body.source_config === 'object')
    ? body.source_config
    : body;

  if (!_hasQuery(src) && !_hasIncludeDomains(src)) {
    return {
      valid: false,
      error: 'Add a search query or at least one include-domain. Without one of those, the feed has nothing to match on.',
    };
  }

  return { valid: true, error: null };
}

module.exports = {
  validateFeedInput: validateFeedInput,
};
