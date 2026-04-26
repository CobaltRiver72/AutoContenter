/* ================================================================
   Shared route helpers — pure functions for parsing/building hash
   routes (e.g. "#editor/47526" ↔ {page:'editor', id:47526}). Lives
   here, not inside dashboard.js's IIFE, so the test suite can pull
   it via `require()` without booting a DOM.

   UMD wrapper exposes:
     - browser: window.__shRoute = { parseRouteHash, buildHash }
     - node:    module.exports     = { parseRouteHash, buildHash }
   ================================================================ */

(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) {
    module.exports = factory();
  } else {
    root.__shRoute = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Pure hash parser. `#editor/47526` → { page: 'editor', id: 47526 }.
  // Empty / null hash returns the default landing page (overview, no id).
  // Non-numeric trailing segments produce id=null so a stray slash can't
  // accidentally claim to be an id.
  function parseRouteHash(hash) {
    var raw = String(hash == null ? '' : hash).replace(/^#/, '');
    if (!raw) return { page: 'overview', id: null };
    var parts = raw.split('/');
    var page = parts[0];
    var id = null;
    if (parts.length > 1 && parts[1] !== '') {
      var n = parseInt(parts[1], 10);
      id = (!isNaN(n) && String(n) === parts[1]) ? n : null;
    }
    return { page: page, id: id };
  }

  // Inverse of parseRouteHash. Omits the trailing /id when id is null/undefined
  // so pages without a selection produce the same hash they always did.
  function buildHash(page, id) {
    return id != null ? page + '/' + id : page;
  }

  return {
    parseRouteHash: parseRouteHash,
    buildHash: buildHash,
  };
}));
