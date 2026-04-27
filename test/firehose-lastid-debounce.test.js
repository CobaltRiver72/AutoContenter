'use strict';

// Tests for the debounced last-event-id persistence in src/modules/firehose.js.
//
// Pre-debounce, every Firehose event ran an UPDATE on the feeds row, turning
// a 100-event/sec replay burst into 100 SQLite writes/sec on the synchronous
// path. We coalesce: only the most recent id matters for resumption, so we
// write at most once per second.
//
// Run with `npm test`.

var test = require('node:test');
var assert = require('node:assert/strict');
var Database = require('better-sqlite3');
var crypto = require('node:crypto');

if (!process.env.SECRETS_ENCRYPTION_KEY) {
  process.env.SECRETS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
}

var { FirehoseListener } = require('../src/modules/firehose');

function makeDb() {
  var db = new Database(':memory:');
  db.exec(`
    CREATE TABLE feeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      site_id INTEGER DEFAULT 1,
      firehose_token TEXT,
      firehose_last_event_id TEXT,
      updated_at TEXT
    );
  `);
  db.prepare('INSERT INTO feeds (id, name, site_id) VALUES (1, ?, 1)').run('test-feed');
  return db;
}

function makeLogger() {
  return {
    info: function () {},
    warn: function () {},
    error: function () {},
    debug: function () {},
    forSite: function () { return this; },
  };
}

function makeListener(db) {
  // Bypass init() / connect() — we're only exercising the debounce path.
  return new FirehoseListener({}, db, makeLogger(), 1, 'tok', { feedId: 1 });
}

test('coalesces N rapid id updates into a single DB write per window', function (t, done) {
  var db = makeDb();
  var listener = makeListener(db);
  // Shrink the window so the test runs fast.
  listener._LAST_ID_SAVE_MS = 30;

  // Wrap saveLastEventId to count physical writes.
  var calls = 0;
  var realSave = listener.saveLastEventId.bind(listener);
  listener.saveLastEventId = function (id) {
    calls++;
    return realSave(id);
  };

  // Burst — would have been 25 UPDATEs pre-debounce.
  for (var i = 1; i <= 25; i++) {
    listener._queueLastIdSave('id-' + i);
  }

  // No write yet — the timer fires at the end of the window.
  assert.equal(calls, 0, 'no synchronous write — debounce window in flight');

  setTimeout(function () {
    assert.equal(calls, 1, 'exactly one DB write for the whole burst');
    var row = db.prepare('SELECT firehose_last_event_id FROM feeds WHERE id = 1').get();
    assert.equal(row.firehose_last_event_id, 'id-25', 'must persist the LATEST id, not an interim one');

    // After the timer fires, a fresh queue should start a new window.
    listener._queueLastIdSave('id-26');
    setTimeout(function () {
      assert.equal(calls, 2, 'a fresh queue after the window opens a new debounce cycle');
      var row2 = db.prepare('SELECT firehose_last_event_id FROM feeds WHERE id = 1').get();
      assert.equal(row2.firehose_last_event_id, 'id-26');
      done();
    }, 60);
  }, 60);
});

test('stop() flushes pending id immediately so resume picks up the live cursor', function () {
  var db = makeDb();
  var listener = makeListener(db);
  listener._LAST_ID_SAVE_MS = 60_000; // long window — only stop() can flush in time

  listener._queueLastIdSave('mid-stream-id');
  // Pre-stop: not yet persisted.
  var pre = db.prepare('SELECT firehose_last_event_id FROM feeds WHERE id = 1').get();
  assert.equal(pre.firehose_last_event_id, null);

  listener.stop();

  var post = db.prepare('SELECT firehose_last_event_id FROM feeds WHERE id = 1').get();
  assert.equal(post.firehose_last_event_id, 'mid-stream-id',
    'stop() must flush so the next boot resumes from the live cursor');
});

test('disconnect() flushes pending id (paused listener can resume cleanly)', function () {
  var db = makeDb();
  var listener = makeListener(db);
  listener._LAST_ID_SAVE_MS = 60_000;

  listener._queueLastIdSave('paused-cursor');
  listener.disconnect();

  var row = db.prepare('SELECT firehose_last_event_id FROM feeds WHERE id = 1').get();
  assert.equal(row.firehose_last_event_id, 'paused-cursor');
});
