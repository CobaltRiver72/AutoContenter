'use strict';

// Tests for src/modules/log-retention.js — pruneOldLogs + vacuumDb.
// Drives the prune logic against an in-memory DB; the cron schedule
// itself is left untested because node-cron has its own coverage.
//
// Run with `npm test`.

var test = require('node:test');
var assert = require('node:assert/strict');
var Database = require('better-sqlite3');
var crypto = require('node:crypto');

if (!process.env.SECRETS_ENCRYPTION_KEY) {
  process.env.SECRETS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
}

var { pruneOldLogs, vacuumDb } = require('../src/modules/log-retention');

function makeDb() {
  var db = new Database(':memory:');
  db.exec(`
    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT,
      module TEXT,
      message TEXT,
      details TEXT,
      site_id INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function insertLog(db, message, ageDays) {
  db.prepare(
    "INSERT INTO logs (level, module, message, created_at) VALUES ('info','t',?,datetime('now', '-' || ? || ' days'))"
  ).run(message, ageDays);
}

test('pruneOldLogs deletes rows older than the cutoff', function () {
  var db = makeDb();
  insertLog(db, 'old',    30);
  insertLog(db, 'recent',  1);

  var removed = pruneOldLogs(db, 7);
  assert.equal(removed, 1, 'only the 30-day-old row should be deleted');

  var rows = db.prepare('SELECT message FROM logs ORDER BY id').all().map(function (r) { return r.message; });
  assert.deepEqual(rows, ['recent']);
});

test('pruneOldLogs is no-op when nothing is past the cutoff', function () {
  var db = makeDb();
  insertLog(db, 'a', 1);
  insertLog(db, 'b', 2);

  var removed = pruneOldLogs(db, 7);
  assert.equal(removed, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM logs').get().n, 2);
});

test('pruneOldLogs respects a tight 1-day window', function () {
  var db = makeDb();
  insertLog(db, 'today',    0);
  insertLog(db, 'yesterday', 2);
  insertLog(db, 'last-week', 8);

  var removed = pruneOldLogs(db, 1);
  // datetime('now','-1 days') strictly drops the 2- and 8-day rows.
  assert.equal(removed, 2);
  var rows = db.prepare('SELECT message FROM logs').all().map(function (r) { return r.message; });
  assert.deepEqual(rows, ['today']);
});

test('pruneOldLogs falls back to 7-day default for invalid input', function () {
  var db = makeDb();
  insertLog(db, 'old',    30);
  insertLog(db, 'recent',  1);

  pruneOldLogs(db, 'not-a-number');
  assert.equal(
    db.prepare("SELECT COUNT(*) AS n FROM logs").get().n,
    1,
    'invalid days arg should default to 7d retention, dropping the 30d row only'
  );
});

test('vacuumDb runs without throwing', function () {
  var db = makeDb();
  insertLog(db, 'x', 0);
  // VACUUM on an in-memory DB succeeds and is essentially a no-op for size,
  // but proves the SQL is syntactically fine and the helper doesn't blow up.
  assert.doesNotThrow(function () { vacuumDb(db); });
});
