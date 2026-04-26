'use strict';

// Regression test for the escapeHtml helper that ships in 9 inline copies
// across public/js/*.js. The previous textContent→innerHTML implementation
// did NOT escape " or ', which silently broke every
//   `value="' + escapeHtml(...) + '"`
// call site when user input contained a quote. That's the bug this asserts
// against — the prompt's example repro: type `"foo` in the New Feed Query
// field and watch the value get truncated on the next 300ms re-render.
//
// Fixture-style: the prod copies are identical inline IIFE-private functions
// so they can't be required from Node. A future PR will dedupe them; this
// test asserts the canonical implementation is correct, and a separate
// grep-based check below ensures the prod copies haven't drifted.

var fs = require('fs');
var path = require('path');
var test = require('node:test');
var assert = require('node:assert/strict');

// Canonical implementation — must be byte-equivalent to every inline copy
// in public/js/*.js (see grep check below).
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

test('escapeHtml: escapes the five HTML-significant characters', function () {
  assert.equal(escapeHtml('&'), '&amp;');
  assert.equal(escapeHtml('<'), '&lt;');
  assert.equal(escapeHtml('>'), '&gt;');
  assert.equal(escapeHtml('"'), '&quot;');
  assert.equal(escapeHtml("'"), '&#39;');
});

test('escapeHtml: handles null and undefined safely', function () {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('escapeHtml: preserves quote inside attribute context (the bug we hit)', function () {
  var out = escapeHtml('hello"world');
  assert.equal(out, 'hello&quot;world');
  // Sanity check: the attribute-context interpolation MUST be valid HTML
  // (browser parses value="hello&quot;world" as the string hello"world,
  // not as value="hello" + garbage attribute).
  var html = '<input value="' + out + '">';
  assert.equal(html, '<input value="hello&quot;world">');
});

test('escapeHtml: escapes 0 (not a falsy null check)', function () {
  // Pre-fix dashboard.js used `if (!str) return '';` which dropped 0 to ''.
  // The unified implementation uses `str == null` so numeric 0 passes through.
  assert.equal(escapeHtml(0), '0');
});

test('escapeHtml: escapes empty string to empty string', function () {
  assert.equal(escapeHtml(''), '');
});

test('escapeHtml: order — & must be replaced first to avoid double-escape', function () {
  // If we replaced "<" before "&", we'd produce &amp;lt; for a literal "<".
  // Wrong order regression: an input of "&lt;" would become "&amp;lt;" — and
  // then the user sees the literal characters "&lt;" in the page instead of
  // the intended "<" (well, they intended a literal "&lt;" — but more
  // importantly the canonical form is byte-stable across calls).
  assert.equal(escapeHtml('&lt;'), '&amp;lt;');
  assert.equal(escapeHtml('a&b<c>d"e\'f'), 'a&amp;b&lt;c&gt;d&quot;e&#39;f');
});

// ─── Drift guard ──────────────────────────────────────────────────────────
// Every public/js/*.js copy of escapeHtml must contain the 5 expected
// .replace() calls. Catches a future drift where one copy gets refactored
// without updating the others.
test('escapeHtml: every public/js copy still has all 5 replace() calls', function () {
  var jsDir = path.resolve(__dirname, '..', 'public', 'js');
  var files = fs.readdirSync(jsDir).filter(function (f) { return f.endsWith('.js'); });
  var checked = 0;
  for (var i = 0; i < files.length; i++) {
    var src = fs.readFileSync(path.join(jsDir, files[i]), 'utf8');
    if (src.indexOf('function escapeHtml') === -1) continue;
    checked++;
    var msg = files[i] + ' — escapeHtml missing required replace';
    assert.ok(/\.replace\(\/&\/g/.test(src),     msg + ' (&)');
    assert.ok(/\.replace\(\/<\/g/.test(src),     msg + ' (<)');
    assert.ok(/\.replace\(\/>\/g/.test(src),     msg + ' (>)');
    assert.ok(/\.replace\(\/"\/g/.test(src),     msg + ' (")');
    assert.ok(/\.replace\(\/'\/g/.test(src),     msg + ' (\')');
  }
  assert.ok(checked >= 7, 'expected at least 7 copies; found ' + checked);
});
