'use strict';

var { EventEmitter } = require('events');
var { FirehoseListener } = require('./firehose');
var siteConfig = require('../utils/site-config');

var MODULE = 'firehose-pool';

/**
 * Manages N FirehoseListener instances — one per active site with a token.
 * Exposes an aggregate EventEmitter so callers wire up once.
 */
class FirehosePool extends EventEmitter {
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
   * Boot: create a FirehoseListener for every active site that has a firehose_token.
   */
  async init() {
    var sites = siteConfig.getAllActiveSites();
    var started = 0;
    for (var i = 0; i < sites.length; i++) {
      var site = sites[i];
      var token = site.firehose_token;
      if (!token) {
        this.logger.info(MODULE, 'Site "' + site.name + '" (id=' + site.id + ') — no firehose token, skipped');
        continue;
      }
      await this._startListener(site.id, site.name, token);
      started++;
    }
    this.logger.info(MODULE, 'Initialised ' + started + ' firehose listener(s) across ' + sites.length + ' active site(s)');
  }

  /**
   * Create, wire, and connect a single listener.
   * @private
   */
  async _startListener(siteId, siteName, token) {
    if (this._listeners.has(siteId)) return; // already running

    var listener = new FirehoseListener(this.config, this.db, this.logger, siteId, token);
    var self = this;

    // Forward all events with the original args
    listener.on('article', function (article) {
      self.emit('article', article);
    });
    listener.on('status', function (status) {
      status.siteId = siteId;
      self.emit('status', status);
    });

    this._listeners.set(siteId, listener);
    await listener.init();
    this.logger.info(MODULE, 'Started firehose for site "' + siteName + '" (id=' + siteId + ')');
  }

  /**
   * Hot-add a site's firehose (e.g. when admin creates a new site).
   */
  async addSite(siteId) {
    var site = siteConfig.getSite(siteId);
    if (!site || !site.firehose_token) return;
    await this._startListener(site.id, site.name, site.firehose_token);
  }

  /**
   * Hot-remove a site's firehose (e.g. when admin deactivates a site).
   */
  async removeSite(siteId) {
    var listener = this._listeners.get(siteId);
    if (!listener) return;
    await listener.shutdown();
    this._listeners.delete(siteId);
    this.logger.info(MODULE, 'Stopped firehose for site id=' + siteId);
  }

  /**
   * Get a specific site's listener.
   * @param {number} siteId
   * @returns {FirehoseListener|undefined}
   */
  get(siteId) {
    return this._listeners.get(siteId);
  }

  /**
   * Get all active listeners.
   * @returns {FirehoseListener[]}
   */
  getAll() {
    return Array.from(this._listeners.values());
  }

  /**
   * Aggregate health for all listeners.
   */
  getHealth() {
    var result = [];
    this._listeners.forEach(function (listener, siteId) {
      var h = listener.getHealth();
      h.siteId = siteId;
      result.push(h);
    });
    return result;
  }

  /**
   * Graceful shutdown of all listeners.
   */
  async shutdown() {
    var promises = [];
    this._listeners.forEach(function (listener) {
      promises.push(listener.shutdown());
    });
    await Promise.all(promises);
    this._listeners.clear();
    this.logger.info(MODULE, 'All firehose listeners stopped');
  }
}

module.exports = FirehosePool;
