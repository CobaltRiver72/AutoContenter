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

function writeToDb(level, mod, message, details) {
  if (!_db) return;

  try {
    if (!_insertStmt) {
      _insertStmt = _db.prepare(
        'INSERT INTO logs (level, module, message, details) VALUES (?, ?, ?, ?)'
      );
    }

    const safeMessage = typeof message === 'string'
      ? redactSensitive(message)
      : redactSensitive(String(message == null ? '' : message));
    const detailsStr = sanitizeDetailsForDb(details);

    _insertStmt.run(level, mod || null, safeMessage, detailsStr);
  } catch (err) {
    // Avoid infinite recursion — only console.error
    console.error('[logger] Failed to write log to DB:', err.message);
  }
}

// ─── Exported log() Function ────────────────────────────────────────────────

/**
 * Log a message.
 *
 * @param {'error'|'warn'|'info'|'debug'} level
 * @param {string} mod - Module name (e.g. 'firehose', 'trends')
 * @param {string} message
 * @param {*} [details] - Optional details object/string
 */
function log(level, mod, message, details) {
  // Winston log
  const meta = { module: mod };
  if (details !== undefined && details !== null) {
    meta.details = typeof details === 'string' ? details : JSON.stringify(details);
  }
  winstonLogger.log(level, message, meta);

  // SQLite log (async-safe, fire-and-forget)
  writeToDb(level, mod, message, details);
}

/**
 * Convenience methods.
 */
function info(mod, message, details) { log('info', mod, message, details); }
function warn(mod, message, details) { log('warn', mod, message, details); }
function error(mod, message, details) { log('error', mod, message, details); }
function debug(mod, message, details) { log('debug', mod, message, details); }

module.exports = {
  log,
  info,
  warn,
  error,
  debug,
  setDb,
  winstonLogger,
};
