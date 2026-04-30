'use strict';

const path = require('path');
const winston = require('winston');
require('winston-daily-rotate-file');
const { getConfig } = require('./config');

const config = getConfig();
const logDir = config.DATA_DIR || path.resolve(__dirname, '..', '..', 'data');

// ─── Redaction ──────────────────────────────────────────────────────────────
// Patterns that should never be persisted to the SQLite logs table.
// Replacements use a fixed sentinel so it's obvious in logs that redaction happened.
const REDACT_PATTERNS = [
  // Authorization headers (Bearer, Basic, Token schemes)
  { re: /(Authorization[:\s=]+)(Bearer|Basic|Token)\s+[\w.\-+/=]+/gi, replace: '$1$2 [REDACTED]' },
  { re: /Bearer\s+[\w.\-]+/gi, replace: 'Bearer [REDACTED]' },
  // API key patterns (OpenAI sk-, OpenRouter sk-or-v1-, Anthropic, RapidAPI, generic)
  { re: /sk-or-v1-[\w\-]{20,}/gi, replace: 'sk-or-v1-[REDACTED]' },
  { re: /sk-ant-[\w\-]{20,}/gi, replace: 'sk-ant-[REDACTED]' },
  { re: /sk-[A-Za-z0-9]{20,}/g, replace: 'sk-[REDACTED]' },
  // Firehose management keys
  { re: /fhm_[\w\-]{20,}/gi, replace: 'fhm_[REDACTED]' },
  // Generic API-key=value and api_key=value patterns in query strings / configs
  { re: /(api[_-]?key[:=]\s*["']?)[\w\-]{16,}/gi, replace: '$1[REDACTED]' },
  // Basic auth embedded in URLs
  { re: /\/\/[^:/\s]+:[^@/\s]+@/g, replace: '//[REDACTED]:[REDACTED]@' },
  // WordPress application passwords (WP generates 4-char-groups separated by spaces)
  { re: /([A-Za-z0-9]{4}\s){5}[A-Za-z0-9]{4}/g, replace: '[REDACTED-WP-APP-PASSWORD]' },
];

function redactSensitive(str) {
  if (typeof str !== 'string') return str;
  let out = str;
  for (let i = 0; i < REDACT_PATTERNS.length; i++) {
    out = out.replace(REDACT_PATTERNS[i].re, REDACT_PATTERNS[i].replace);
  }
  return out;
}

// Lazy db reference — set after db.js is initialized
let _db = null;

/**
 * Set the database reference for writing logs to SQLite.
 * Must be called after db.js is loaded.
 *
 * @param {import('better-sqlite3').Database} db
 */
function setDb(db) {
  _db = db;
}

// ─── Winston Transports ─────────────────────────────────────────────────────

const consoleTransport = new winston.transports.Console({
  format: winston.format.combine(
    winston.format.colorize(),
    winston.format.timestamp({ format: 'HH:mm:ss' }),
    winston.format.printf(({ timestamp, level, message, module: mod, ...rest }) => {
      const modTag = mod ? `[${mod}]` : '';
      const extra = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
      return `${timestamp} ${level} ${modTag} ${message}${extra}`;
    })
  ),
});

const fileTransport = new winston.transports.DailyRotateFile({
  filename: path.join(logDir, 'app-%DATE%.log'),
  datePattern: 'YYYY-MM-DD',
  maxSize: '5m',
  maxFiles: 3,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
});

const winstonLogger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports: [consoleTransport, fileTransport],
  exitOnError: false,
});

// ─── SQLite Log Writer ──────────────────────────────────────────────────────

let _insertStmt = null;

// Serialize `details` for DB persistence while stripping stack traces and
// known sensitive patterns. File/console logging is unaffected — this helper
// is only used for the SQLite write path.
function sanitizeDetailsForDb(details) {
  if (details == null) return null;
  try {
    if (typeof details === 'string') {
      return redactSensitive(details);
    }
    if (details instanceof Error) {
      // Never persist stack traces to the DB.
      return redactSensitive(JSON.stringify({ name: details.name, message: details.message }));
    }
    if (typeof details === 'object') {
      // Clone and drop any `stack` fields (including nested err/error.stack) before stringifying.
      const cloned = JSON.parse(JSON.stringify(details, (key, value) => {
        if (key === 'stack') return undefined;
        if (value instanceof Error) {
          return { name: value.name, message: value.message };
        }
        return value;
      }));
      return redactSensitive(JSON.stringify(cloned));
    }
    return redactSensitive(String(details));
  } catch (err) {
    // Don't swallow silently — surface to console and fall back to a safe string.
    console.error('[logger] Failed to sanitize details for DB:', err.message);
    try {
      return redactSensitive(String(details));
    } catch (_) {
      return null;
    }
  }
}

// Numeric severity for the DB-level threshold. error > warn > info > debug.
// Reading config lazily because logger.js is required before config is
// fully loaded in some boot paths.
var _LEVEL_RANK = { error: 40, warn: 30, info: 20, debug: 10 };
var _dbLevelMin = null;
function _resolveDbLevelMin() {
  if (_dbLevelMin !== null) return _dbLevelMin;
  try {
    var cfgLvl = String(config.DB_LOG_LEVEL || 'info').toLowerCase();
    _dbLevelMin = _LEVEL_RANK[cfgLvl] || _LEVEL_RANK.info;
  } catch (_e) {
    _dbLevelMin = _LEVEL_RANK.info;
  }
  return _dbLevelMin;
}

function writeToDb(level, mod, message, details, siteId) {
  // Drop silently if the DB has been closed — happens during graceful
  // shutdown when module .shutdown() methods log their own teardown.
  // better-sqlite3 exposes `.open = false` after close(); without this
  // check every late log call throws "database connection is not open"
  // and the catch below spams stderr with it.
  if (!_db || _db.open === false) return;

  // Skip levels below DB_LOG_LEVEL. At firehose saturation (~245k articles/
  // day) debug accounts for the bulk of log writes; dropping it at this
  // gate prevents the logs table from out-growing every other table in
  // the schema. Console + file transports still get the full stream.
  var rank = _LEVEL_RANK[level] || 0;
  if (rank < _resolveDbLevelMin()) return;

  try {
    if (!_insertStmt) {
      _insertStmt = _db.prepare(
        'INSERT INTO logs (level, module, message, details, site_id) VALUES (?, ?, ?, ?, ?)'
      );
    }

    const safeMessage = typeof message === 'string'
      ? redactSensitive(message)
      : redactSensitive(String(message == null ? '' : message));
    const detailsStr = sanitizeDetailsForDb(details);
    const siteCol = Number.isInteger(siteId) && siteId > 0 ? siteId : null;

    _insertStmt.run(level, mod || null, safeMessage, detailsStr, siteCol);
  } catch (err) {
    // Avoid infinite recursion — only console.error
    console.error('[logger] Failed to write log to DB:', err.message);
  }
}

// Extract a site_id tag from details when the caller passed it inline. This
// lets existing call sites opt in just by including `{ site_id: N, ... }` in
// details, without updating every logger method signature in the codebase.
function _extractSiteId(details) {
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    var sid = details.site_id || details.siteId;
    if (Number.isInteger(sid) && sid > 0) return sid;
  }
  return null;
}

// ─── Exported log() Function ────────────────────────────────────────────────

/**
 * Log a message.
 *
 * @param {'error'|'warn'|'info'|'debug'} level
 * @param {string} mod - Module name (e.g. 'firehose', 'trends')
 * @param {string} message
 * @param {*} [details] - Optional details object/string. If an object, a
 *   `site_id` field will be promoted to the logs.site_id column.
 * @param {number} [siteId] - Override: explicit per-site tag. Usually supplied
 *   by the wrapper returned from logger.forSite(siteId).
 */
// Lazy-loaded to avoid a require cycle if request-context ever imports logger.
let _requestCtx = null;
function _currentRequestId() {
  try {
    if (!_requestCtx) _requestCtx = require('./request-context');
    return _requestCtx.requestId();
  } catch (_e) {
    return null;
  }
}

function log(level, mod, message, details, siteId) {
  // Prefix with [rid=xxxxxx] when we're inside an Express request so the
  // message can be grep'd end-to-end through route → module → worker call
  // chains. No-op outside a request (workers, boot, pipeline ticks).
  const rid = _currentRequestId();
  const taggedMsg = rid ? '[rid=' + rid + '] ' + message : message;

  // Winston log
  const meta = { module: mod };
  if (rid) meta.requestId = rid;
  if (details !== undefined && details !== null) {
    meta.details = typeof details === 'string' ? details : JSON.stringify(details);
  }
  winstonLogger.log(level, taggedMsg, meta);

  // SQLite log (async-safe, fire-and-forget). Explicit siteId wins over
  // inline-in-details tagging; either fills logs.site_id.
  const resolvedSiteId = Number.isInteger(siteId) && siteId > 0
    ? siteId
    : _extractSiteId(details);
  writeToDb(level, mod, taggedMsg, details, resolvedSiteId);
}

/**
 * Convenience methods.
 */
function info(mod, message, details) { log('info', mod, message, details); }
function warn(mod, message, details) { log('warn', mod, message, details); }
function error(mod, message, details) { log('error', mod, message, details); }
function debug(mod, message, details) { log('debug', mod, message, details); }

/**
 * Create a child logger bound to a specific site. Every call through the
 * returned object stamps logs.site_id = siteId. Intended for per-site modules
 * (FirehoseListener within a feed, WordPressPublisher) that already know
 * their siteId at construction time.
 *
 * @param {number} siteId
 * @returns {{ info, warn, error, debug, log }}
 */
function forSite(siteId) {
  const sid = Number.isInteger(siteId) && siteId > 0 ? siteId : null;
  return {
    log:   function (level, mod, message, details) { log(level, mod, message, details, sid); },
    info:  function (mod, message, details)        { log('info',  mod, message, details, sid); },
    warn:  function (mod, message, details)        { log('warn',  mod, message, details, sid); },
    error: function (mod, message, details)        { log('error', mod, message, details, sid); },
    debug: function (mod, message, details)        { log('debug', mod, message, details, sid); },
    forSite: forSite, // keep the method available on child loggers too
  };
}

module.exports = {
  log,
  info,
  warn,
  error,
  debug,
  setDb,
  forSite,
  winstonLogger,
};
