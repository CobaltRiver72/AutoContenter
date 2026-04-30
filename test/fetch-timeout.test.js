'use strict';

// Tests for src/utils/fetch-timeout.js — pins the AbortController timeout
// behaviour so a hung WP host doesn't pin a publisher worker forever.
//
// Run with `npm test`.

var test = require('node:test');
var assert = require('node:assert/strict');
var http = require('node:http');

var { fetchWithTimeout } = require('../src/utils/fetch-timeout');

function startSilentServer() {
  return new Promise(function (resolve) {
    // Server accepts the TCP connection but never writes a response.
    var server = http.createServer(function () { /* hold the request open forever */ });
    server.listen(0, '127.0.0.1', function () { resolve(server); });
  });
}

function startInstantServer(status, body) {
  return new Promise(function (resolve) {
    var server = http.createServer(function (req, res) {
      res.writeHead(status, { 'Content-Type': 'text/plain' });
      res.end(body || 'ok');
    });
    server.listen(0, '127.0.0.1', function () { resolve(server); });
  });
}

test('aborts when the remote hangs past the timeout', async function () {
  var server = await startSilentServer();
  try {
    var port = server.address().port;
    var t0 = Date.now();
    await assert.rejects(
      fetchWithTimeout('http://127.0.0.1:' + port + '/', {}, 200),
      /aborted|abort|AbortError|This operation was aborted/i
    );
    var elapsed = Date.now() - t0;
    assert.ok(elapsed >= 180 && elapsed < 1500, 'expected ~200ms, got ' + elapsed + 'ms');
  } finally {
    server.close();
  }
});

test('returns Response when the server replies before the timeout', async function () {
  var server = await startInstantServer(200, 'hello');
  try {
    var port = server.address().port;
    var res = await fetchWithTimeout('http://127.0.0.1:' + port + '/', {}, 5000);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'hello');
  } finally {
    server.close();
  }
});

test('default timeout is applied when caller omits it', async function () {
  // Drive only the early-return path via an instant server — verifies the
  // default arg path doesn't blow up.
  var server = await startInstantServer(204);
  try {
    var port = server.address().port;
    var res = await fetchWithTimeout('http://127.0.0.1:' + port + '/');
    assert.equal(res.status, 204);
  } finally {
    server.close();
  }
});

test("respects caller's own AbortController signal (composes correctly)", async function () {
  var server = await startSilentServer();
  try {
    var port = server.address().port;
    var ctl = new AbortController();
    setTimeout(function () { ctl.abort(); }, 100);
    var t0 = Date.now();
    await assert.rejects(
      fetchWithTimeout('http://127.0.0.1:' + port + '/', { signal: ctl.signal }, 60000),
      /aborted|abort|AbortError/i
    );
    // External abort fires before the 60s timeout — proves we honour both.
    assert.ok(Date.now() - t0 < 1500);
  } finally {
    server.close();
  }
});
