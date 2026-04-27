'use strict';

// Tests for src/middleware/timing.js — per-request timing logger.
//
// The middleware is the canary for event-loop-blocking regressions: when
// the ingest hot-path saturates the loop, /login goes from <50 ms to
// multi-second and the warn log surfaces it. These tests pin the
// log-level routing (slow → warn, 5xx → warn, fast → debug) and the
// shape of the metadata.
//
// Run with `npm test`.

var test = require('node:test');
var assert = require('node:assert/strict');
var http = require('node:http');
var express = require('express');

var timingMiddleware = require('../src/middleware/timing');

function makeLogger() {
  var calls = { warn: [], debug: [] };
  return {
    warn: function (mod, msg, meta) { calls.warn.push({ mod: mod, msg: msg, meta: meta }); },
    debug: function (mod, msg, meta) { calls.debug.push({ mod: mod, msg: msg, meta: meta }); },
    info: function () {},
    error: function () {},
    _calls: calls,
  };
}

function listen(app) {
  return new Promise(function (resolve) {
    var server = http.createServer(app);
    server.listen(0, '127.0.0.1', function () { resolve(server); });
  });
}

function request(server, path) {
  return new Promise(function (resolve, reject) {
    var addr = server.address();
    http.get({ host: addr.address, port: addr.port, path: path }, function (res) {
      res.resume();
      res.on('end', function () { resolve(res.statusCode); });
    }).on('error', reject);
  });
}

test('fast 200 response logs at debug', async function () {
  var logger = makeLogger();
  var app = express();
  app.use(timingMiddleware(logger, { slowMs: 250 }));
  app.get('/ok', function (req, res) { res.status(200).send('ok'); });

  var server = await listen(app);
  try {
    var status = await request(server, '/ok');
    assert.equal(status, 200);
    // res.finish fires synchronously when the response ends, but allow a
    // microtask in case Node ever changes that.
    await new Promise(function (r) { setImmediate(r); });
    assert.equal(logger._calls.debug.length, 1, 'fast response should log debug');
    assert.equal(logger._calls.warn.length, 0, 'fast response must NOT warn');
    var entry = logger._calls.debug[0];
    assert.equal(entry.mod, 'http');
    assert.equal(entry.meta.method, 'GET');
    assert.equal(entry.meta.path, '/ok');
    assert.equal(entry.meta.status, 200);
    assert.equal(typeof entry.meta.duration_ms, 'number');
    assert.ok(entry.meta.duration_ms >= 0);
  } finally {
    server.close();
  }
});

test('slow request (over slowMs) logs at warn', async function () {
  var logger = makeLogger();
  var app = express();
  app.use(timingMiddleware(logger, { slowMs: 30 }));
  app.get('/slow', function (req, res) {
    setTimeout(function () { res.status(200).send('done'); }, 80);
  });

  var server = await listen(app);
  try {
    var status = await request(server, '/slow');
    assert.equal(status, 200);
    await new Promise(function (r) { setImmediate(r); });
    assert.equal(logger._calls.warn.length, 1, 'slow response should log warn');
    assert.equal(logger._calls.debug.length, 0);
    var entry = logger._calls.warn[0];
    assert.ok(entry.meta.duration_ms > 30, 'duration should exceed slowMs threshold');
    assert.equal(entry.meta.status, 200);
  } finally {
    server.close();
  }
});

test('5xx response logs at warn even when fast', async function () {
  var logger = makeLogger();
  var app = express();
  app.use(timingMiddleware(logger, { slowMs: 250 }));
  app.get('/boom', function (req, res) { res.status(503).send('nope'); });

  var server = await listen(app);
  try {
    var status = await request(server, '/boom');
    assert.equal(status, 503);
    await new Promise(function (r) { setImmediate(r); });
    assert.equal(logger._calls.warn.length, 1, '5xx must warn');
    assert.equal(logger._calls.warn[0].meta.status, 503);
  } finally {
    server.close();
  }
});
