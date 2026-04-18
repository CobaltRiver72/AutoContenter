'use strict';

var { EventEmitter } = require('events');
var { FirehoseListener } = require('./firehose');

var MODULE = 'feeds-pool';

/**
 * Per-feed SSE pool. Analog of FirehosePool but keyed by feed_id instead of
 * site_id. Each active Feed with a firehose_token gets its own FirehoseListener
 * that applies the Feed's source_config (query, country, include/exclude domains)
 * as filters. Articles emitted by the pool carry both feed_id and source_site_id,
 * so downstream code can tag the whole pipeline — articles → clusters → drafts
 * → published — with the originating Feed.
 *
 * Design decisions:
 *   • One SSE per Feed. Admin chose max isolation over cost efficiency (each
 *     feed bills its own Ahrefs tap). Pool boots all active-and-tokened feeds
 *     at start; individual feeds can be hot-added/removed via API.
 *   • Pool forwards articles verbatim — no per-feed clustering happens here.
 *     The pipeline's enqueue() reads article.feed_id and scopes clustering.
 */
class FeedsPool extends EventEmitter {
  /**
   * @param {object} config  - Frozen global config
   * @param {import('better-sqlite3').Database} db
   * @param {object} logger
   */
  constructor(config, db, logger) {
    super();
    this.config = config;
    this.db = db;
    this.logger = logger;
    /** @type {Map<number, FirehoseListener>} */
    this._listeners = new Map();
  }

  /**
   * Boot: create a FirehoseListener for every active feed that has a
   * firehose_token. Skip silently when no token is set — the feed row can be
   * saved partial, admin adds the token later, then calls addFeed to hot-start.
   */
  async init() {
    var rows = this.db.prepare(
      "SELECT * FROM feeds WHERE is_active = 1 AND firehose_token IS NOT NULL AND firehose_token != ''"
    ).all();
    var started = 0;
    for (var i = 0; i < rows.length; i++) {
      try {
        await this._startListener(rows[i]);
        started++;
      } catch (err) {
        this.logger.warn(MODULE, 'Failed to start feed listener for feed=' + rows[i].id + ': ' + err.message);
      }
    }
    this.logger.info(MODULE, 'Initialised ' + started + ' feed listener(s) (of ' + rows.length + ' candidate(s))');
  }

  /**
   * Create, wire, and connect a listener for a single feed row.
   * @private
   */
  async _startListener(feedRow) {
    if (this._listeners.has(feedRow.id)) return;

    var sourceConfig = {};
    try { sourceConfig = JSON.parse(feedRow.source_config || '{}'); } catch (_e) { sourceConfig = {}; }

    var listener = new FirehoseListener(
      this.config, this.db, this.logger, feedRow.site_id, feedRow.firehose_token,
      { feedId: feedRow.id, feedConfig: sourceConfig }
    );
    var self = this;

    listener.on('article', function (article) {
      self.emit('article', article);
    });
    listener.on('status', function (status) {
      status.feedId = feedRow.id;
      status.siteId = feedRow.site_id;
      self.emit('status', status);
    });

    this._listeners.set(feedRow.id, listener);
    await listener.init();
    this.logger.info(MODULE, 'Started listener for feed "' + feedRow.name + '" (id=' + feedRow.id + ', site=' + feedRow.site_id + ')');
  }

  /**
   * Hot-add a feed's listener (called when admin creates or re-activates).
   * Looks the row up fresh so the latest source_config + token are used.
   * @param {number} feedId
   */
  async addFeed(feedId) {
    var row = this.db.prepare('SELECT * FROM feeds WHERE id = ?').get(feedId);
    if (!row) return;
    if (!row.is_active) return;
    if (!row.firehose_token) return;
    await this._startListener(row);
  }

  /**
   * Hot-remove a feed's listener (called on deactivate / delete / config edit).
   * Safe to call for feeds that aren't running.
   * @param {number} feedId
   */
  async removeFeed(feedId) {
    var listener = this._listeners.get(feedId);
    if (!listener) return;
    try {
      await listener.shutdown();
    } catch (err) {
      this.logger.warn(MODULE, 'listener.shutdown failed for feed=' + feedId + ': ' + err.message);
    }
    this._listeners.delete(feedId);
    this.logger.info(MODULE, 'Stopped listener for feed id=' + feedId);
  }

  /**
   * @param {number} feedId
   * @returns {FirehoseListener|undefined}
   */
  get(feedId) {
    return this._listeners.get(feedId);
  }

  /**
   * @returns {FirehoseListener[]}
   */
  getAll() {
    return Array.from(this._listeners.values());
  }

  /**
   * Aggregate per-feed health for the Feeds page status column.
   */
  getHealth() {
    var result = [];
    this._listeners.forEach(function (listener, feedId) {
      var h = listener.getHealth ? listener.getHealth() : { status: 'unknown' };
      h.feedId = feedId;
      result.push(h);
    });
    return result;
  }

  /**
   * Graceful shutdown of all listeners.
   */
  async shutdown() {
    var promises = [];
    this._listeners.forEach(function (listener) { promises.push(listener.shutdown()); });
    await Promise.all(promises);
    this._listeners.clear();
    this.logger.info(MODULE, 'All feed listeners stopped');
  }
}

module.exports = FeedsPool;
