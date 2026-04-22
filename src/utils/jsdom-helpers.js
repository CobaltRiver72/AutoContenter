'use strict';

/**
 * Small shims around jsdom for the extractor pipeline.
 *
 * Why: jsdom's built-in CSS parser (cssom) doesn't understand modern CSS
 * features — `@layer`, `@container`, `@supports selector(...)`, `color-mix()`,
 * `@scope`, etc. News sites emit this stuff heavily (Livemint, MSN, Reuters).
 * Each failure goes to jsdom's default VirtualConsole which dumps the entire
 * stack trace and the offending 20 KB stylesheet to stderr, drowning real
 * errors. The parsing failure is non-fatal — jsdom keeps going and the DOM
 * is still usable for Readability — so the right move is to silence the
 * noise, not fix jsdom.
 *
 * Usage:
 *   var { createQuietJsdom } = require('../utils/jsdom-helpers');
 *   var dom = createQuietJsdom(html, { url: sourceUrl });
 */

var { JSDOM, VirtualConsole } = require('jsdom');

/**
 * Returns a VirtualConsole that silently drops `jsdomError` events (the CSS
 * parse failures we don't care about) but still forwards real `error` /
 * `warn` / `info` messages to the host console.
 */
function quietVirtualConsole() {
  var vc = new VirtualConsole();
  // Drop CSS/HTML parser errors silently. Other log channels still flow.
  vc.on('jsdomError', function () { /* intentional noop */ });
  return vc;
}

/**
 * Drop-in replacement for `new JSDOM(html, opts)` that mounts the quiet
 * virtual console when the caller hasn't supplied one.
 */
function createQuietJsdom(html, opts) {
  opts = opts || {};
  if (!opts.virtualConsole) opts.virtualConsole = quietVirtualConsole();
  return new JSDOM(html, opts);
}

module.exports = { createQuietJsdom: createQuietJsdom, quietVirtualConsole: quietVirtualConsole };
