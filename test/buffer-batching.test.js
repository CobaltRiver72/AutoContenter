'use strict';

// Tests for src/modules/buffer.js batched-insert pipeline.
//
// The buffer used to call .run() per article on the synchronous better-sqlite3
// statement, which blocked the event loop during cold-boot Firehose replay.
// These tests pin the new behavior: deferred enqueue, time-window flush,
// max-size flush, shutdown drain, and event emission AFTER commit.
//
// Run with `npm test`.

var test = require('node:test');
var assert = require('node:assert/strict');
var Database = require('better-sqlite3');
var crypto = require('node:crypto');

// Encryption key needed if buffer ever pulls config helpers — set defensively.
if (!process.env.SECRETS_ENCRYPTION_KEY) {
  process.env.SECRETS_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
}

var { ArticleBuffer } = require('../src/modules/buffer');

function makeDb() {
  var db = new Database(':memory:');
  db.exec(`
    CREATE TABLE articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      firehose_event_id TEXT UNIQUE,
      url TEXT NOT NULL,
      domain TEXT NOT NULL,
      title TEXT,
      publish_time TEXT,
      content_markdown TEXT,
      fingerprint TEXT,
      cluster_id INTEGER,
      trends_matched INTEGER DEFAULT 0,
      authority_tier INTEGER DEFAULT 3,
      page_category TEXT DEFAULT NULL,
      language TEXT DEFAULT NULL,
      source_site_id INTEGER DEFAULT 1,
      feed_id INTEGER DEFAULT NULL,
      image_url TEXT DEFAULT NULL,
      received_at TEXT DEFAULT (datetime('now'))
    );
  `);
  return db;
}

function makeLogger() {
  return {
    info: function () {},
    warn: function () {},
    error: function () {},
    debug: function () {},
  };
}

function makeArticle(i) {
  return {
    firehose_event_id: 'evt-' + i,
    url: 'https://example.com/a/' + i,
    domain: 'example.com',
    title: 'Article number ' + i,
    content_markdown: 'Body for article ' + i + ' with enough text to fingerprint.',
    publish_time: '2026-04-27T12:00:00Z',
    language: 'en',
    source_site_id: 1,
  };
}

test('addArticle does NOT insert synchronously (deferred to flush)', function () {
  var db = makeDb();
  var buf = new ArticleBuffer({}, db, makeLogger());
  buf.addArticle(makeArticle(1));
  // Synchronously, no row is in the table yet — the insert is deferred.
  var row = db.prepare('SELECT COUNT(*) AS n FROM articles').get();
  assert.equal(row.n, 0, 'addArticle must not write through to DB synchronously');
});

test('flushes immediately when batch hits FLUSH_MAX', function (t, done) {
  var db = makeDb();
  var buf = new ArticleBuffer({}, db, makeLogger());

  var emitted = [];
  buf.on('article-buffered', function (a) { emitted.push(a); });

  // 50 = _FLUSH_MAX → triggers immediate flush at the 50th add.
  for (var i = 0; i < 50; i++) {
    buf.addArticle(makeArticle(i));
  }

  // Synchronous flush path — DB and emit happen before this line returns.
  var row = db.prepare('SELECT COUNT(*) AS n FROM articles').get();
  assert.equal(row.n, 50, 'all 50 rows should be committed by max-size flush');
  assert.equal(emitted.length, 50, 'one event per inserted row');
  // ids attached
  assert.ok(emitted[0].id > 0, 'emitted article should carry DB id');
  done();
});

test('flushes after FLUSH_MS time window', function (t, done) {
  var db = makeDb();
  var buf = new ArticleBuffer({}, db, makeLogger());
  buf._FLUSH_MS = 30; // shrink window for fast test

  var emitted = [];
  buf.on('article-buffered', function (a) { emitted.push(a); });

  for (var i = 0; i < 5; i++) buf.addArticle(makeArticle(i));

  // Not flushed yet — under FLUSH_MAX and timer hasn't fired.
  var pre = db.prepare('SELECT COUNT(*) AS n FROM articles').get();
  assert.equal(pre.n, 0, 'sub-threshold batch must wait for the timer');

  setTimeout(function () {
    var post = db.prepare('SELECT COUNT(*) AS n FROM articles').get();
    assert.equal(post.n, 5, 'timer should have flushed the pending batch');
    assert.equal(emitted.length, 5);
    done();
  }, 80);
});

test('shutdown drains pending batch', async function () {
  var db = makeDb();
  var buf = new ArticleBuffer({}, db, makeLogger());

  var emitted = [];
  buf.on('article-buffered', function (a) { emitted.push(a); });

  for (var i = 0; i < 7; i++) buf.addArticle(makeArticle(i));
  // Pre-shutdown: nothing committed.
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM articles').get().n, 0);

  await buf.shutdown();

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM articles').get().n, 7,
    'shutdown must drain pending articles before the DB is closed');
  assert.equal(emitted.length, 7);
});

test('duplicate firehose_event_id does not emit a second time', function (t, done) {
  var db = makeDb();
  var buf = new ArticleBuffer({}, db, makeLogger());

  var emitted = [];
  buf.on('article-buffered', function (a) { emitted.push(a); });

  // Two articles, same firehose_event_id (the unique key).
  var a = makeArticle(1);
  var b = makeArticle(1);
  b.url = 'https://example.com/a/1-other';
  buf.addArticle(a);
  buf.addArticle(b);

  // Force flush via max-threshold (top up to 50).
  for (var i = 100; i < 148; i++) buf.addArticle(makeArticle(i));

  // 49 inserts (1 dup of evt-1) + the unique evt-1 → 49 total.
  var n = db.prepare('SELECT COUNT(*) AS n FROM articles').get().n;
  assert.equal(n, 49, 'INSERT OR IGNORE should drop the duplicate firehose_event_id');
  assert.equal(emitted.length, 49, 'duplicate should NOT fire article-buffered');
  done();
});

test('event-loop is not blocked while ingesting 1000 articles', function (t, done) {
  var db = makeDb();
  var buf = new ArticleBuffer({}, db, makeLogger());

  // Tick monitor: setInterval is paid only when the event loop is free.
  // If the buffer were committing per article, a 1000-item burst would
  // starve the timer for the entire run.
  var ticks = 0;
  var ticker = setInterval(function () { ticks++; }, 5);

  // Spread the inserts across 200 turns of the event loop. With batched
  // inserts each turn flushes at most one transaction; the ticker should
  // get plenty of chances to run between them.
  var i = 0;
  function step() {
    for (var k = 0; k < 5 && i < 1000; k++, i++) buf.addArticle(makeArticle(i));
    if (i < 1000) {
      setImmediate(step);
    } else {
      // Let the trailing timer flush, then assert.
      setTimeout(function () {
        clearInterval(ticker);
        var n = db.prepare('SELECT COUNT(*) AS n FROM articles').get().n;
        assert.equal(n, 1000, 'all 1000 articles should land in the DB');
        // 1000 inserts split across ~200 setImmediate turns @ 5ms ticker —
        // we need *some* ticks to prove the loop wasn't pinned. A pinned
        // loop would produce 0–1 ticks; healthy operation produces dozens.
        assert.ok(ticks >= 5, 'event loop must remain responsive — got ' + ticks + ' ticks');
        done();
      }, 400);
    }
  }
  step();
});
