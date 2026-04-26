'use strict';

// Tests for src/utils/secrets.js — AES-256-GCM encryption helper.
// Run with `npm test`.

var test = require('node:test');
var assert = require('node:assert/strict');
var crypto = require('node:crypto');

// Set the env var BEFORE requiring the module — the key is cached on
// first use, but the module-level require() doesn't trigger the cache.
process.env.SECRETS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
var enc = require('../src/utils/secrets');

test('round-trip: decrypt(encrypt(x)) === x', function () {
  var out = enc.decrypt(enc.encrypt('my-rapidapi-key-abc-123'));
  assert.equal(out, 'my-rapidapi-key-abc-123');
});

test('encrypt is non-deterministic (different IV each call)', function () {
  var a = enc.encrypt('same plaintext');
  var b = enc.encrypt('same plaintext');
  assert.notEqual(a, b, 'two encryptions of the same input must differ (random IV)');
  // But both decrypt to the same value.
  assert.equal(enc.decrypt(a), 'same plaintext');
  assert.equal(enc.decrypt(b), 'same plaintext');
});

test('encrypt is idempotent on already-encrypted value', function () {
  var once = enc.encrypt('hello');
  var twice = enc.encrypt(once);
  assert.equal(once, twice, 'encrypting an already-encrypted value must be a no-op');
});

test('decrypt passes through legacy plain-text (no prefix)', function () {
  // During the one-time migration window, the read path may see values
  // that haven't been encrypted yet. Decrypt must return them unchanged
  // rather than throw, otherwise the migration boot would crash.
  assert.equal(enc.decrypt('legacy-plaintext-no-prefix'), 'legacy-plaintext-no-prefix');
});

test('decrypt throws on tampered ciphertext (GCM auth tag mismatch)', function () {
  var ct = enc.encrypt('secret payload');
  // Flip a byte deep in the base64 to corrupt the ciphertext or tag.
  var tampered = ct.slice(0, -2) + 'XX';
  assert.throws(function () { enc.decrypt(tampered); });
});

test('null and empty string pass through unchanged', function () {
  assert.equal(enc.encrypt(null), null);
  assert.equal(enc.encrypt(''), '');
  assert.equal(enc.decrypt(null), null);
  assert.equal(enc.decrypt(''), '');
});

test('isEncrypted detects the v1 prefix', function () {
  assert.equal(enc.isEncrypted(enc.encrypt('x')), true);
  assert.equal(enc.isEncrypted('plain-text'), false);
  assert.equal(enc.isEncrypted(''), false);
  assert.equal(enc.isEncrypted(null), false);
  assert.equal(enc.isEncrypted(undefined), false);
});

test('encrypted output starts with version prefix', function () {
  var ct = enc.encrypt('hello');
  assert.ok(ct.indexOf(enc.PREFIX) === 0, 'wire format must start with ' + enc.PREFIX);
});

test('non-string inputs are coerced to string before encrypt', function () {
  // The settings table stores values as TEXT; numeric or boolean values
  // sneak in via bulk-import paths. Ensure encryption tolerates that.
  var ct = enc.encrypt(12345);
  assert.equal(enc.decrypt(ct), '12345');
});

test('isSecretSettingKey covers expected keys', function () {
  assert.equal(enc.isSecretSettingKey('FUEL_RAPIDAPI_KEY'), true);
  assert.equal(enc.isSecretSettingKey('FIREHOSE_MANAGEMENT_KEY'), true);
  assert.equal(enc.isSecretSettingKey('WP_APP_PASSWORD'), true);
  assert.equal(enc.isSecretSettingKey('ANTHROPIC_API_KEY'), true);
  assert.equal(enc.isSecretSettingKey('PORT'), false);
  assert.equal(enc.isSecretSettingKey('TIER1_SOURCES'), false);
});

test('isSecretSiteColumn covers expected columns', function () {
  assert.equal(enc.isSecretSiteColumn('firehose_token'), true);
  assert.equal(enc.isSecretSiteColumn('wp_app_password'), true);
  assert.equal(enc.isSecretSiteColumn('name'), false);
  assert.equal(enc.isSecretSiteColumn('slug'), false);
});

// ─── Key validation ────────────────────────────────────────────────────────

test('throws clearly when SECRETS_ENCRYPTION_KEY is missing', function () {
  // Use child process so we don't pollute the cached key in this process.
  var saved = process.env.SECRETS_ENCRYPTION_KEY;
  delete process.env.SECRETS_ENCRYPTION_KEY;
  try {
    // Invalidate the cached key — clear via re-require pattern is tricky
    // since require caches the module. We test the path that re-reads
    // the env via a fresh module load in a child process.
    var spawnSync = require('node:child_process').spawnSync;
    var result = spawnSync('node', ['-e',
      'delete process.env.SECRETS_ENCRYPTION_KEY; ' +
      'try { require("' + require.resolve('../src/utils/secrets') + '").encrypt("x"); console.log("NO_THROW"); } ' +
      'catch (e) { console.log("THREW:" + e.message.substring(0, 60)); }'
    ], { encoding: 'utf8' });
    var stdout = result.stdout || '';
    assert.match(stdout, /THREW:.*SECRETS_ENCRYPTION_KEY/i,
      'expected thrown error mentioning SECRETS_ENCRYPTION_KEY; got: ' + stdout);
  } finally {
    process.env.SECRETS_ENCRYPTION_KEY = saved;
  }
});

test('throws clearly when key is not 32 bytes', function () {
  var spawnSync = require('node:child_process').spawnSync;
  // 16-byte key = wrong length.
  var shortKey = require('node:crypto').randomBytes(16).toString('base64');
  var result = spawnSync('node', ['-e',
    'process.env.SECRETS_ENCRYPTION_KEY = "' + shortKey + '"; ' +
    'try { require("' + require.resolve('../src/utils/secrets') + '").encrypt("x"); console.log("NO_THROW"); } ' +
    'catch (e) { console.log("THREW:" + e.message.substring(0, 80)); }'
  ], { encoding: 'utf8' });
  var stdout = result.stdout || '';
  assert.match(stdout, /THREW:.*32 bytes/i,
    'expected thrown error mentioning 32 bytes; got: ' + stdout);
});
