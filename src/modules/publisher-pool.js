'use strict';

var { WordPressPublisher } = require('./publisher');
var { WPPublisher } = require('./wp-publisher');
var siteConfig = require('../utils/site-config');

var MODULE = 'publisher-pool';

/**
 * Manages N WordPressPublisher instances — one per active site with WP credentials.
 */
class PublisherPool {
  /**
   * @param {object} config  - Frozen global config
   * @param {import('better-sqlite3').Database} db
   * @param {object} logger
   */
  constructor(config, db, logger) {
    this.config = config;
    this.db = db;
    this.logger = logger;
    /** @type {Map<number, WordPressPublisher>} */
    this._publishers = new Map();
    /** @type {Map<number, WPPublisher>} */
    this._wpPublishers = new Map();
  }

  /**
   * Boot: create a publisher for every active site that has WP credentials.
   */
  async init() {
    var sites = siteConfig.getAllActiveSites();
    var started = 0;
    for (var i = 0; i < sites.length; i++) {
      var site = sites[i];
      if (!site.wp_url || !site.wp_username || !site.wp_app_password) {
        this.logger.info(MODULE, 'Site "' + site.name + '" (id=' + site.id + ') — missing WP creds, skipped');
        continue;
      }
      this._createPublisher(site);
      started++;
    }
    this.logger.info(MODULE, 'Initialised ' + started + ' publisher(s) across ' + sites.length + ' active site(s)');
  }

  /**
   * Create both publisher instances for a site.
   * @private
   */
  _createPublisher(site) {
    var creds = {
      wp_url: site.wp_url,
      wp_username: site.wp_username,
      wp_app_password: site.wp_app_password
    };

    // High-level publisher (publish logic, rate limiting, taxonomy)
    var pub = new WordPressPublisher(this.config, this.logger, site.id, creds);
    this._publishers.set(site.id, pub);

    // Low-level WP REST API client (used by taxonomy sync, fuel/metals/lottery posts)
    var wpPub = new WPPublisher(this.config, this.db, this.logger, site.id, creds);
    this._wpPublishers.set(site.id, wpPub);
  }

  /**
   * Initialise all publishers (call after pool.init()).
   * WordPressPublisher.init() sets up auth headers.
   */
  async initAll() {
    var promises = [];
    this._publishers.forEach(function (pub) {
      promises.push(pub.init());
    });
    await Promise.all(promises);
  }

  /**
   * Hot-add a site's publisher.
   */
  async addSite(siteId) {
    var site = siteConfig.getSite(siteId);
    if (!site || !site.wp_url || !site.wp_username || !site.wp_app_password) return;
    this._createPublisher(site);
    await this._publishers.get(siteId).init();
    this.logger.info(MODULE, 'Added publisher for site "' + site.name + '" (id=' + siteId + ')');
  }

  /**
   * Hot-remove a site's publisher.
   */
  removeSite(siteId) {
    this._publishers.delete(siteId);
    this._wpPublishers.delete(siteId);
    this.logger.info(MODULE, 'Removed publisher for site id=' + siteId);
  }

  /**
   * Get the high-level publisher for a site.
   * @param {number} siteId
   * @returns {WordPressPublisher|undefined}
   */
  get(siteId) {
    return this._publishers.get(siteId);
  }

  /**
   * Get the WP REST API client for a site.
   * @param {number} siteId
   * @returns {WPPublisher|undefined}
   */
  getWP(siteId) {
    return this._wpPublishers.get(siteId);
  }

  /**
   * Get all site IDs that have publishers.
   * @returns {number[]}
   */
  getSiteIds() {
    return Array.from(this._publishers.keys());
  }

  /**
   * Aggregate health for all publishers.
   */
  getHealth() {
    var result = [];
    this._publishers.forEach(function (pub, siteId) {
      result.push({
        siteId: siteId,
        wpBaseUrl: pub.wpBaseUrl || '(not initialised)',
        ready: !!pub.wpBaseUrl
      });
    });
    return result;
  }
}

module.exports = PublisherPool;
