'use strict';

// AES-256-GCM at-rest encryption for secrets stored in SQLite. Used by
// the settings + sites write/read paths so a leaked DB backup doesn't
// hand attackers the FIREHOSE_TOKEN, RapidAPI keys, WP app password, etc.
//
// Wire format:
//   enc:v1:base64(iv ‖ tag ‖ ciphertext)
//     iv  = 12 random bytes (GCM-recommended length)
//     tag = 16 bytes (GCM auth tag)
//     ciphertext = utf-8 bytes of the plaintext, AES-256-GCM
//
// The version prefix (`v1`) lets us migrate to a new scheme later without
// touching existing rows — `decrypt()` can branch on the prefix.
//
// Key management: SECRETS_ENCRYPTION_KEY env var, 32 bytes base64-encoded.
// Generate with:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//
// If the key is lost: encrypted values cannot be recovered. Re-enter all
// secrets via the Settings UI. Document this in the README.

var crypto = require('node:crypto');

var ALGO = 'aes-256-gcm';
var KEY_LEN = 32;
var IV_LEN  = 12;
var TAG_LEN = 16;
var PREFIX  = 'enc:v1:';

// Cache the parsed key so we don't re-decode the env var on every call.
var _keyCache = null;
var _keyCacheRaw = null;

function getKey() {
  var raw = process.env.SECRETS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'SECRETS_ENCRYPTION_KEY missing in .env. Generate with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  if (raw === _keyCacheRaw && _keyCache) return _keyCache;

  var buf;
  try {
    buf = Buffer.from(raw, 'base64');
  } catch (_e) {
    throw new Error('SECRETS_ENCRYPTION_KEY must be valid base64.');
  }
  if (buf.length !== KEY_LEN) {
    throw new Error('SECRETS_ENCRYPTION_KEY must decode to exactly ' + KEY_LEN +
      ' bytes (got ' + buf.length + '). Generate a fresh key with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
  }
  _keyCache = buf;
  _keyCacheRaw = raw;
  return buf;
}

/**
 * Encrypt a UTF-8 string. Idempotent — already-encrypted input is
 * returned verbatim, so callers don't need to track encryption state
 * across pipeline stages. null / empty strings pass through unchanged.
 *
 * @param {string|null} plaintext
 * @returns {string|null}
 */
function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return plaintext;
  if (typeof plaintext !== 'string') plaintext = String(plaintext);
  if (plaintext.indexOf(PREFIX) === 0) return plaintext; // already encrypted

  var key = getKey();
  var iv = crypto.randomBytes(IV_LEN);
  var cipher = crypto.createCipheriv(ALGO, key, iv);
  var ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  var tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
}

/**
 * Decrypt a wire-formatted ciphertext. Plain-text input (no PREFIX) is
 * returned unchanged — that's the legacy fallback during the migration
 * window. Throws on tampered ciphertext (GCM auth tag mismatch).
 *
 * @param {string|null} value
 * @returns {string|null}
 */
function decrypt(value) {
  if (value == null || value === '') return value;
  if (typeof value !== 'string') return value;
  if (value.indexOf(PREFIX) !== 0) return value; // legacy plain-text

  var key = getKey();
  var blob = Buffer.from(value.slice(PREFIX.length), 'base64');
  if (blob.length < IV_LEN + TAG_LEN + 1) {
    throw new Error('decrypt: ciphertext too short (corrupt or wrong key)');
  }
  var iv  = blob.subarray(0, IV_LEN);
  var tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  var ct  = blob.subarray(IV_LEN + TAG_LEN);
  var decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

/**
 * Detects whether a value is in the encrypted wire format. Useful for
 * one-time migrations that should skip already-converted rows.
 *
 * @param {*} value
 * @returns {boolean}
 */
function isEncrypted(value) {
  return typeof value === 'string' && value.indexOf(PREFIX) === 0;
}

// Set of setting / column names that automatically pass through encrypt
// on write and decrypt on read. Centralized so every consumer (settings
// table getter, sites helpers, fuel/metals/lottery modules) shares the
// same allowlist — adding a new secret means adding it here once.
var SECRET_SETTING_KEYS = new Set([
  'FUEL_RAPIDAPI_KEY',
  'METALS_RAPIDAPI_KEY',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'FIREHOSE_MANAGEMENT_KEY',
  'FIREHOSE_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'WP_APP_PASSWORD',
  'JINA_API_KEY',
  'INFRANODUS_API_KEY',
  'SESSION_SECRET',
]);

// Sites-table columns that hold secrets (per-site overrides for the
// global settings above).
var SECRET_SITE_COLUMNS = new Set([
  'firehose_token',
  'wp_app_password',
]);

function isSecretSettingKey(key) { return SECRET_SETTING_KEYS.has(key); }
function isSecretSiteColumn(col) { return SECRET_SITE_COLUMNS.has(col); }

module.exports = {
  encrypt: encrypt,
  decrypt: decrypt,
  isEncrypted: isEncrypted,
  isSecretSettingKey: isSecretSettingKey,
  isSecretSiteColumn: isSecretSiteColumn,
  SECRET_SETTING_KEYS: SECRET_SETTING_KEYS,
  SECRET_SITE_COLUMNS: SECRET_SITE_COLUMNS,
  PREFIX: PREFIX,
};
