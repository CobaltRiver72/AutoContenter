'use strict';

var path = require('path');
var dotenv = require('dotenv');

// Load .env from project root
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

var REQUIRED_VARS = [
  'FIREHOSE_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'WP_URL',
  'WP_USERNAME',
  'WP_APP_PASSWORD',
  'DASHBOARD_PASSWORD',
  'PORT',
];

var DEFAULTS = {
  AI_PROVIDER: 'anthropic',
  AI_PRIMARY_MODEL: 'claude-haiku-4-5-20251001',
  AI_FALLBACK_MODEL: 'gpt-4o-mini',
  ENABLE_FALLBACK: 'true',
  MAX_TOKENS: '4096',
  TEMPERATURE: '0.7',
  MIN_SOURCES_THRESHOLD: '2',
  SIMILARITY_THRESHOLD: '0.20',
  ALLOW_SAME_DOMAIN_CLUSTERS: 'true',
  MAX_BUFFER_FOR_SIMILARITY: '100',
  BUFFER_HOURS: '2.5',
  MAX_PUBLISH_PER_HOUR: '4',
  PUBLISH_COOLDOWN_MINUTES: '10',
  TRENDS_GEO: 'IN',
  TRENDS_POLL_MINUTES: '15',
  WP_AUTHOR_ID: '1',
  WP_DEFAULT_CATEGORY: '1',
  WP_POST_STATUS: 'draft',
  WP_COMMENT_STATUS: '',
  WP_PING_STATUS: '',
  TIER1_SOURCES: 'ndtv.com,hindustantimes.com,timesofindia.indiatimes.com,thehindu.com,indianexpress.com',
  TIER2_SOURCES: 'livemint.com,business-standard.com,deccanherald.com,firstpost.com,news18.com',
  TIER3_SOURCES: 'zeenews.india.com,republicworld.com,wionews.com,aninews.in',
  TRENDS_ENABLED: 'false',
  INFRANODUS_API_KEY: '',
  INFRANODUS_ENABLED: 'false',
  FORCE_HTTPS: 'false',
  JINA_API_KEY: '',
  JINA_ENABLED: 'true',
  MAX_AI_REWRITES_PER_HOUR: '60',
  // Autopilot
  AUTOPILOT_ENABLED: 'false',
  AUTOPILOT_DAILY_TARGET: '50',
  AUTOPILOT_START_HOUR: '6',
  AUTOPILOT_END_HOUR: '23',
  AUTOPILOT_WEEKENDS: 'true',
  AUTOPILOT_MIN_SIMILARITY: '0.70',
  AUTOPILOT_MIN_TIER: '0',
  AUTOPILOT_MIN_WORDS: '300',
  AUTOPILOT_BLOCKED_KEYWORDS: 'horoscope,rashifal,zodiac,numerology,angel number,wishes,greetings,lottery,panchang',
  AUTOPILOT_BLOCKED_DOMAINS: '',
  AUTOPILOT_ALLOWED_DOMAINS: '',
  AUTOPILOT_BLOCKED_CATEGORIES: '',
  AUTOPILOT_AUTO_CATEGORIZE: 'true',
  PUBLISH_LANGUAGE: 'en',
  REWRITE_LANGUAGE: 'en',
  // Firehose
  FIREHOSE_SINCE: '1h',
  FIREHOSE_TIMEOUT: '300',
  FIREHOSE_RECONNECT_MIN: '2000',
  FIREHOSE_RECONNECT_MAX: '60000',
  FIREHOSE_ALLOWED_DOMAINS: '',
  FIREHOSE_BLOCKED_DOMAINS: '',
  FIREHOSE_ALLOWED_LANGS: 'en,hi',
  FIREHOSE_CUSTOM_TEMPLATES: '',
  // Pipeline engine
  EXTRACTION_POLL_MS: '500',
  EXTRACTION_TIMEOUT_MS: '10000',
  EXTRACTION_MAX_SIZE_MB: '5',
  CLUSTERING_DEBOUNCE_MS: '3000',
  CLUSTERING_MAX_WAIT_MS: '10000',
  CLUSTER_QUEUE_MAX: '500',
  REWRITE_CONCURRENCY: '3',
  REWRITE_POLL_MS: '5000',
  LEASE_MINUTES: '8',
  REWRITE_MAX_RETRIES: '3',
  PUBLISH_POLL_MS: '30000',
  WP_TIMEOUT_MS: '60000',
  BATCH_PUBLISH_DELAY_MS: '2000',
  // InfraNodus
  INFRANODUS_CACHE_TTL_MINUTES: '30',
  INFRANODUS_TEXT_LIMIT: '12000',
  INFRANODUS_AUTO_ANALYZE: 'true',
  INFRANODUS_GOOGLE_ENABLED: 'false',
  // Content classifier
  DEFAULT_AUTHOR_USERNAME: '',
  AUTHOR_ASSIGNMENT_ENABLED: 'true',
  CLASSIFIER_CONFIDENCE_THRESHOLD: '15',
  AUTO_CREATE_WP_TAGS: 'true',
  MAX_TAGS_PER_ARTICLE: '8',
  BLOCKED_TAGS: '',
  CLASSIFIER_CATEGORY_DICTIONARIES: '',
  CLASSIFIER_AUTHOR_DICTIONARIES: '',
  CLASSIFIER_CATEGORY_TO_AUTHOR: '',
  CLASSIFIER_TAG_DICTIONARY: '',
  // Auto-Rewrite engine
  AUTO_REWRITE_ENABLED: 'false',
  AUTO_REWRITE_DAILY_LIMIT: '100',
  AUTO_REWRITE_HOURLY_LIMIT: '20',
  AUTO_REWRITE_MIN_SOURCES: '2',
  AUTO_REWRITE_MIN_SIMILARITY: '0.30',
  AUTO_REWRITE_BLOCKED_KEYWORDS: 'horoscope,rashifal,zodiac,numerology,wishes,greetings',
  BACKLOG_MAX_AGE_HOURS: '72',
  // Bulk Config Import — feature flag, default off until Phase C ships UI
  BULK_IMPORT_ENABLED: 'false',
};

// Numeric keys that should be parsed as numbers
var NUMERIC_KEYS = [
  'PORT',
  'MIN_SOURCES_THRESHOLD',
  'SIMILARITY_THRESHOLD',
  'BUFFER_HOURS',
  'MAX_PUBLISH_PER_HOUR',
  'PUBLISH_COOLDOWN_MINUTES',
  'TRENDS_POLL_MINUTES',
  'WP_AUTHOR_ID',
  'WP_DEFAULT_CATEGORY',
  'MAX_BUFFER_FOR_SIMILARITY',
];

// CSV keys that should be parsed as arrays
var CSV_KEYS = ['TIER1_SOURCES', 'TIER2_SOURCES', 'TIER3_SOURCES'];

// Boolean keys that should be parsed as booleans
var BOOLEAN_KEYS = ['TRENDS_ENABLED', 'INFRANODUS_ENABLED', 'ENABLE_FALLBACK', 'FORCE_HTTPS', 'ALLOW_SAME_DOMAIN_CLUSTERS', 'JINA_ENABLED'];

/**
 * Build the config object from environment variables and defaults.
 * Does NOT throw if required vars are missing -- logs warnings instead.
 */
function buildConfig() {
  var missing = [];
  var raw = {};
  var i, key, keys, defaultVal, num;

  // Collect required vars
  for (i = 0; i < REQUIRED_VARS.length; i++) {
    key = REQUIRED_VARS[i];
    if (process.env[key]) {
      raw[key] = process.env[key];
    } else {
      missing.push(key);
      raw[key] = '';
    }
  }

  // Collect optional vars with defaults
  keys = Object.keys(DEFAULTS);
  for (i = 0; i < keys.length; i++) {
    key = keys[i];
    defaultVal = DEFAULTS[key];
    raw[key] = process.env[key] || defaultVal;
  }

  // Log warnings for missing required vars (use console because logger isn't ready yet)
  if (missing.length > 0) {
    console.warn(
      '[config] WARNING: Missing required env vars: ' + missing.join(', ') + '. ' +
      'App will start in unconfigured state. Set them via .env or dashboard.'
    );
  }

  // Parse numeric values
  var config = {};
  var rawKeys = Object.keys(raw);
  for (i = 0; i < rawKeys.length; i++) {
    config[rawKeys[i]] = raw[rawKeys[i]];
  }

  for (i = 0; i < NUMERIC_KEYS.length; i++) {
    key = NUMERIC_KEYS[i];
    if (config[key] !== undefined && config[key] !== '') {
      num = Number(config[key]);
      config[key] = Number.isNaN(num) ? config[key] : num;
    }
  }

  // Parse boolean values
  for (i = 0; i < BOOLEAN_KEYS.length; i++) {
    key = BOOLEAN_KEYS[i];
    if (typeof config[key] === 'string') {
      config[key] = config[key].toLowerCase() === 'true';
    }
  }

  // Parse CSV values into arrays
  for (i = 0; i < CSV_KEYS.length; i++) {
    key = CSV_KEYS[i];
    if (typeof config[key] === 'string') {
      config[key] = config[key]
        .split(',')
        .map(function(s) { return s.trim(); })
        .filter(Boolean);
    }
  }

  // Derived convenience values — use persistent path to survive redeployments
  if (process.env.DB_PATH) {
    config.DB_PATH = process.env.DB_PATH;
    config.DATA_DIR = path.dirname(config.DB_PATH);
  } else if (process.env.DATA_DIR) {
    config.DATA_DIR = process.env.DATA_DIR;
    config.DB_PATH = path.join(config.DATA_DIR, 'autopub.db');
  } else {
    var homeDir = process.env.HOME || process.env.USERPROFILE || '';
    if (homeDir) {
      config.DATA_DIR = path.join(homeDir, 'hdf-data');
    } else {
      config.DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
    }
    config.DB_PATH = path.join(config.DATA_DIR, 'autopub.db');
  }
  config.LOG_PATH = path.join(config.DATA_DIR, 'app.log');
  config.MISSING_REQUIRED = missing;
  config.IS_CONFIGURED = missing.length === 0;

  return config;
}

// Internal mutable config (frozen snapshot is served via getConfig)
var _config = buildConfig();
var _frozen = Object.freeze(JSON.parse(JSON.stringify(_config)));

// Reference to the SQLite database (set via loadRuntimeOverrides)
var _db = null;

/**
 * Load runtime overrides from the `settings` SQLite table.
 * Merges on top of env-based config (settings win).
 *
 * @param {import('better-sqlite3').Database} db
 */
function loadRuntimeOverrides(db) {
  try {
    _db = db;
    _getStmt = null;
    _invalidateGetCache();
    seedSettingsFromEnv(db);
    var rows = db.prepare('SELECT key, value FROM settings').all();
    if (!rows || rows.length === 0) return;

    var overrides = {};
    var i, key, num;
    for (i = 0; i < rows.length; i++) {
      overrides[rows[i].key] = rows[i].value;
    }

    // Merge overrides into config
    var merged = {};
    var configKeys = Object.keys(_config);
    for (i = 0; i < configKeys.length; i++) {
      merged[configKeys[i]] = _config[configKeys[i]];
    }
    var overrideKeys = Object.keys(overrides);
    for (i = 0; i < overrideKeys.length; i++) {
      merged[overrideKeys[i]] = overrides[overrideKeys[i]];
    }

    // Re-parse numeric keys
    for (i = 0; i < NUMERIC_KEYS.length; i++) {
      key = NUMERIC_KEYS[i];
      if (merged[key] !== undefined && merged[key] !== '') {
        num = Number(merged[key]);
        merged[key] = Number.isNaN(num) ? merged[key] : num;
      }
    }

    // Re-parse CSV keys
    for (i = 0; i < CSV_KEYS.length; i++) {
      key = CSV_KEYS[i];
      if (typeof merged[key] === 'string') {
        merged[key] = merged[key]
          .split(',')
          .map(function(s) { return s.trim(); })
          .filter(Boolean);
      }
    }

    // Re-parse boolean values
    for (i = 0; i < BOOLEAN_KEYS.length; i++) {
      key = BOOLEAN_KEYS[i];
      if (typeof merged[key] === 'string') {
        merged[key] = merged[key].toLowerCase() === 'true';
      }
    }

    // Sync WP URL aliases: WP_SITE_URL (dashboard key) ↔ WP_URL (env/config key)
    if (merged.WP_SITE_URL && !merged.WP_URL) merged.WP_URL = merged.WP_SITE_URL;
    if (merged.WP_URL && !merged.WP_SITE_URL) merged.WP_SITE_URL = merged.WP_URL;

    // Update IS_CONFIGURED based on whether required vars are now filled
    var stillMissing = REQUIRED_VARS.filter(function(k) { return !merged[k]; });
    merged.MISSING_REQUIRED = stillMissing;
    merged.IS_CONFIGURED = stillMissing.length === 0;

    _config = merged;
    _frozen = Object.freeze(JSON.parse(JSON.stringify(_config)));
  } catch (err) {
    console.error('[config] Failed to load runtime overrides:', err.message);
  }
}

/**
 * Seed settings table from environment variables on first boot.
 * Only writes a key if it does NOT already exist in the settings table.
 */
function seedSettingsFromEnv(db) {
  var ENV_KEYS = [
    'FUEL_RAPIDAPI_KEY', 'METALS_RAPIDAPI_KEY',
    'WP_URL', 'WP_SITE_URL', 'WP_USERNAME', 'WP_APP_PASSWORD',
    'WP_AUTHOR_ID', 'WP_DEFAULT_CATEGORY', 'WP_POST_STATUS',
    'INFRANODUS_API_KEY', 'JINA_API_KEY',
    'CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET',
  ];

  // Use upsert so .env rotations always override stored DB values (C5)
  var stmt = db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')"
  );

  var seeded = [];
  for (var i = 0; i < ENV_KEYS.length; i++) {
    var key = ENV_KEYS[i];
    var val = process.env[key];
    if (val) {
      stmt.run(key, val);
      seeded.push(key);
    }
  }

  // If WP_URL is set in env, also keep WP_SITE_URL in sync
  if (process.env.WP_URL) {
    stmt.run('WP_SITE_URL', process.env.WP_URL);
    seeded.push('WP_SITE_URL (from WP_URL)');
  }

  if (seeded.length > 0) {
    console.log('[config] Seeded settings from env: ' + seeded.join(', '));
  }
}

/**
 * Get the current frozen config object.
 * @returns {Readonly<Record<string, any>>}
 */
function getConfig() {
  return _frozen;
}

// In-process TTL cache for get() to avoid hitting SQLite on every pipeline
// tick. Pipeline workers call _cfg.get() dozens of times per second; without
// this, that's 100k+ settings queries per day. 5s TTL keeps hot-reload from
// the dashboard responsive while eliminating the hot-path cost.
var _getCache = new Map();
var _GET_CACHE_TTL_MS = 5000;
var _getStmt = null;

function _invalidateGetCache(key) {
  if (key) _getCache.delete(key);
  else _getCache.clear();
}

/**
 * Get a single config value. Checks SQLite settings first, then env/defaults.
 *
 * @param {string} key - The config key to look up
 * @returns {*} The value, or undefined if not found
 */
function get(key) {
  var cached = _getCache.get(key);
  var now = Date.now();
  if (cached && cached.expires > now) return cached.value;

  var value;
  if (_db) {
    try {
      if (!_getStmt) _getStmt = _db.prepare('SELECT value FROM settings WHERE key = ?');
      var row = _getStmt.get(key);
      if (row) value = row.value;
    } catch (err) {
      // Fall through to frozen config
    }
  }

  if (value === undefined) {
    if (_frozen[key] !== undefined) value = _frozen[key];
    else if (process.env[key] !== undefined) value = process.env[key];
    else if (DEFAULTS[key] !== undefined) value = DEFAULTS[key];
  }

  _getCache.set(key, { value: value, expires: now + _GET_CACHE_TTL_MS });
  return value;
}

/**
 * Write a setting to the SQLite settings table and update the in-memory config.
 *
 * @param {string} key - The setting key
 * @param {*} value - The setting value
 * @param {import('better-sqlite3').Database} [db] - Optional db instance (uses stored reference if omitted)
 */
function set(key, value, db) {
  var database = db || _db;
  if (!database) {
    throw new Error('No database available. Call loadRuntimeOverrides first.');
  }

  try {
    database.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).run(key, String(value));

    // Update in-memory config
    _config[key] = value;

    // Re-parse if needed
    var i;
    for (i = 0; i < NUMERIC_KEYS.length; i++) {
      if (NUMERIC_KEYS[i] === key && _config[key] !== undefined && _config[key] !== '') {
        var num = Number(_config[key]);
        _config[key] = Number.isNaN(num) ? _config[key] : num;
        break;
      }
    }

    for (i = 0; i < BOOLEAN_KEYS.length; i++) {
      if (BOOLEAN_KEYS[i] === key && typeof _config[key] === 'string') {
        _config[key] = _config[key].toLowerCase() === 'true';
        break;
      }
    }

    for (i = 0; i < CSV_KEYS.length; i++) {
      if (CSV_KEYS[i] === key && typeof _config[key] === 'string') {
        _config[key] = _config[key]
          .split(',')
          .map(function(s) { return s.trim(); })
          .filter(Boolean);
        break;
      }
    }

    _frozen = Object.freeze(JSON.parse(JSON.stringify(_config)));
    _invalidateGetCache(key);
  } catch (err) {
    console.error('[config] Failed to set config key "' + key + '":', err.message);
    throw err;
  }
}

/**
 * Check if a setting is truthy ('true', '1', true, 1).
 *
 * @param {string} key - The config key to check
 * @returns {boolean}
 */
function isEnabled(key) {
  var value = get(key);
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    var lower = value.toLowerCase();
    return lower === 'true' || lower === '1';
  }
  return false;
}

/**
 * Force rebuild from env (useful for testing).
 */
function reload() {
  _config = buildConfig();
  _frozen = Object.freeze(JSON.parse(JSON.stringify(_config)));
  return _frozen;
}

module.exports = {
  getConfig: getConfig,
  loadRuntimeOverrides: loadRuntimeOverrides,
  seedSettingsFromEnv: seedSettingsFromEnv,
  get: get,
  set: set,
  isEnabled: isEnabled,
  reload: reload,
  REQUIRED_VARS: REQUIRED_VARS,
  DEFAULTS: DEFAULTS,
};
