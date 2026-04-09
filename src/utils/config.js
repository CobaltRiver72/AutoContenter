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
  AI_FALLBACK_MODEL: 'gpt-4o',
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
  TIER1_SOURCES: 'ndtv.com,hindustantimes.com,timesofindia.indiatimes.com,thehindu.com,indianexpress.com',
  TIER2_SOURCES: 'livemint.com,business-standard.com,deccanherald.com,firstpost.com,news18.com',
  TIER3_SOURCES: 'zeenews.india.com,republicworld.com,wionews.com,aninews.in',
  TRENDS_ENABLED: 'false',
  INFRANODUS_API_KEY: '',
  INFRANODUS_ENABLED: 'false',
  FORCE_HTTPS: 'false',
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
var BOOLEAN_KEYS = ['TRENDS_ENABLED', 'INFRANODUS_ENABLED', 'ENABLE_FALLBACK', 'FORCE_HTTPS', 'ALLOW_SAME_DOMAIN_CLUSTERS'];

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
 * Get the current frozen config object.
 * @returns {Readonly<Record<string, any>>}
 */
function getConfig() {
  return _frozen;
}

/**
 * Get a single config value. Checks SQLite settings first, then env/defaults.
 *
 * @param {string} key - The config key to look up
 * @returns {*} The value, or undefined if not found
 */
function get(key) {
  // Check SQLite settings first if db is available
  if (_db) {
    try {
      var row = _db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      if (row) {
        return row.value;
      }
    } catch (err) {
      // Fall through to frozen config
    }
  }

  // Fall back to the frozen config snapshot
  if (_frozen[key] !== undefined) {
    return _frozen[key];
  }

  // Fall back to env vars
  if (process.env[key] !== undefined) {
    return process.env[key];
  }

  // Fall back to defaults
  if (DEFAULTS[key] !== undefined) {
    return DEFAULTS[key];
  }

  return undefined;
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
  get: get,
  set: set,
  isEnabled: isEnabled,
  reload: reload,
  REQUIRED_VARS: REQUIRED_VARS,
  DEFAULTS: DEFAULTS,
};
