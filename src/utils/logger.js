'use strict';

const path = require('path');
const winston = require('winston');
require('winston-daily-rotate-file');
const { getConfig } = require('./config');

const config = getConfig();
const logDir = config.DATA_DIR || path.resolve(__dirname, '..', '..', 'data');

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

function writeToDb(level, mod, message, details) {
  if (!_db) return;

  try {
    if (!_insertStmt) {
      _insertStmt = _db.prepare(
        'INSERT INTO logs (level, module, message, details) VALUES (?, ?, ?, ?)'
      );
    }

    const detailsStr = details != null
      ? (typeof details === 'string' ? details : JSON.stringify(details))
      : null;

    _insertStmt.run(level, mod || null, message, detailsStr);
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
