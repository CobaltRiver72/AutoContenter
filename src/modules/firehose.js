'use strict';

const { EventEmitter } = require('events');
const EventSource = require('eventsource');
const { URL } = require('url');

const MODULE = 'firehose';
const BASE_URL = 'https://api.firehose.com';
const MIN_RECONNECT_MS = 2000;
const MAX_RECONNECT_MS = 60000; // 1 minute cap for exponential backoff

class FirehoseListener extends EventEmitter {
  /**
   * @param {object} config - Frozen config object
   * @param {import('better-sqlite3').Database} db
   * @param {object} logger - Logger with .info(), .warn(), .error(), .debug()
   */
  constructor(config, db, logger) {
    super();
    this.config = config;
    this.db = db;
    this.logger = logger;

    this._es = null;
    this._connected = false;
    this._lastEventId = null;
    this._articlesReceived = 0;
    this._articlesDroppedByLang = 0;
    this._lastArticleAt = null;
    this._reconnectTimer = null;
    this._lastConnectAttempt = 0;
    this._stopped = false;
    this._reconnectAttempts = 0;

    // Language gate — only accept these ISO codes from the firehose stream.
    // Override via ALLOWED_LANGUAGES=en,hi,bn in env. Hindi and English only by default.
    var rawLangs = (config && config.ALLOWED_LANGUAGES) || 'en,hi';
    this._allowedLangs = String(rawLangs)
      .split(',')
      .map(function (l) { return l.trim().toLowerCase(); })
      .filter(Boolean);
    // Module independence
    this.enabled = false;
    this.status = 'disabled';
    this.error = null;

    // Prepared statements (lazy)
    this._stmtGetSetting = null;
    this._stmtSetSetting = null;
  }

  /**
   * Update the config and optionally reconnect.
   */
  updateConfig(newConfig) {
    this.config = newConfig;
  }

  /**
   * Open the SSE connection.
   */
  connect() {
    if (this._stopped) return;

    // Rate limit: don't reconnect faster than 2 seconds
    const now = Date.now();
    const elapsed = now - this._lastConnectAttempt;
    if (elapsed < MIN_RECONNECT_MS) {
      const delay = MIN_RECONNECT_MS - elapsed;
      this.logger.debug(MODULE, `Throttling reconnect, waiting ${delay}ms`);
      this._reconnectTimer = setTimeout(() => this.connect(), delay);
      return;
    }
    this._lastConnectAttempt = now;

    try {
      // Close any existing connection
      this._closeEventSource();

      // Build stream URL
      const streamUrl = new URL('/v1/stream', BASE_URL);
      streamUrl.searchParams.set('timeout', '300');

      // Load last event ID for resume
      const lastId = this.getLastEventId();
      const headers = {
        Authorization: `Bearer ${this.config.FIREHOSE_TOKEN}`,
      };
      if (lastId) {
        // Reconnect: resume from exact position via Last-Event-ID
        headers['Last-Event-ID'] = lastId;
      } else {
        // First connect ever: replay the last hour of articles
        streamUrl.searchParams.set('since', '1h');
      }

      this.logger.info(MODULE, `Connecting to ${streamUrl.toString()}`, {
        lastEventId: lastId || 'none',
      });

      this._es = new EventSource(streamUrl.toString(), { headers });

      // ─── SSE Event Handlers ───

      this._es.addEventListener('connected', (event) => {
        this._connected = true;
        this.status = 'connected';
        this.ready = true;
        this._reconnectAttempts = 0; // reset backoff on successful connection
        this.logger.info(MODULE, 'SSE connected');
        this.emit('status', { type: 'connected' });
      });

      this._es.addEventListener('update', (event) => {
        try {
          this.handleUpdate(event);
        } catch (err) {
          this.logger.error(MODULE, 'Error handling update event', err.message);
        }
      });

      this._es.addEventListener('error', (event) => {
        this._connected = false;
        const msg = event && event.message ? event.message : 'SSE error';
        this.logger.warn(MODULE, `SSE error: ${msg}`);
        this.emit('status', { type: 'error', message: msg });
      });

      this._es.addEventListener('end', (event) => {
        this._connected = false;
        this.logger.info(MODULE, 'SSE stream ended, will reconnect');
        this.emit('status', { type: 'disconnected', reason: 'end' });
        this.reconnect();
      });

      // Generic error handler (EventSource built-in)
      this._es.onerror = (err) => {
        if (this._stopped) return;
        this._connected = false;
        this.logger.warn(MODULE, 'SSE connection error, reconnecting...');
        this.emit('status', { type: 'error', message: 'Connection error' });
        this.reconnect();
      };

      // Generic open handler
      this._es.onopen = () => {
        this._connected = true;
      };
    } catch (err) {
      this.logger.error(MODULE, 'Failed to connect', err.message);
      this.reconnect();
    }
  }

  /**
   * Disconnect the SSE stream (called by memory watchdog).
   * Does NOT set _stopped=true so connect() can resume.
   */
  disconnect() {
    if (this._es) {
      this._es.close();
      this._es = null;
    }
    this._connected = false;
    this.status = 'paused';
    this.logger.info(MODULE, 'SSE disconnected (paused)');
  }

  /**
   * Reconnect after a delay (min 2 seconds).
   */
  reconnect() {
    if (this._stopped) return;

    this._closeEventSource();

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
    }

    // Exponential backoff with full jitter: delay is random in [MIN_RECONNECT_MS, base]
    // where base grows as 2^attempt, capped at MAX_RECONNECT_MS.
    var base = Math.min(MIN_RECONNECT_MS * Math.pow(2, this._reconnectAttempts), MAX_RECONNECT_MS);
    var delay = Math.floor(Math.random() * base) + MIN_RECONNECT_MS;
    this._reconnectAttempts++;
    this.logger.info(MODULE, `Reconnecting in ${delay}ms (attempt ${this._reconnectAttempts})`);
    this._reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  /**
   * Stop the listener entirely.
   */
  stop() {
    this._stopped = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._closeEventSource();
    this._connected = false;
    this.logger.info(MODULE, 'Firehose listener stopped');
    this.emit('status', { type: 'stopped' });
  }

  /**
   * Parse an SSE update event and emit an article.
   *
   * @param {MessageEvent} event
   */
  handleUpdate(event) {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch (err) {
      this.logger.warn(MODULE, 'Failed to parse update event data', err.message);
      return;
    }

    // Save the event ID for resumption
    if (event.lastEventId) {
      this._lastEventId = event.lastEventId;
      this.saveLastEventId(event.lastEventId);
    }

    // Extract document from payload
    const doc = data.document;
    if (!doc || !doc.url) {
      this.logger.debug(MODULE, 'Update event missing document or URL, skipping');
      return;
    }

    // Extract domain from URL
    let domain = '';
    try {
      domain = new URL(doc.url).hostname.replace(/^www\./, '');
    } catch (err) {
      this.logger.debug(MODULE, `Invalid URL in update: ${doc.url}`);
      return;
    }

    // Build article object
    const article = {
      firehose_event_id: event.lastEventId || (data.tap_id + '-' + data.query_id + '-' + Date.now()),
      query_id: data.query_id || null,
      url: doc.url,
      domain: domain,
      title: doc.title || '',
      publish_time: doc.publish_time || null,
      content_markdown: typeof doc.markdown === 'string' ? doc.markdown
        : typeof doc.diff === 'string' ? doc.diff
        : (doc.markdown || doc.diff) ? JSON.stringify(doc.markdown || doc.diff)
        : '',
      language: doc.language ? String(doc.language).toLowerCase() : null,
      page_category: doc.page_category || null,
      page_types: doc.page_types || null,
    };

    // ─── Language Gate ─────────────────────────────────────────────────────
    // Drop articles whose declared language isn't in the allow-list. For
    // articles with no language metadata, sniff Devanagari Unicode range
    // (U+0900..U+097F) in title + first 500 chars of content. Three or
    // more Devanagari chars in a row → Hindi; otherwise default to English.
    if (article.language && this._allowedLangs.indexOf(article.language) === -1) {
      this._articlesDroppedByLang++;
      this.logger.debug(MODULE,
        '[lang-filter] Dropped ' + article.language + ' article: "' + (article.title || article.url) + '"'
      );
      return; // Drop — do not emit
    }

    if (!article.language) {
      var checkText = (article.title || '') + ' ' + String(article.content_markdown || '').substring(0, 500);
      if (/[\u0900-\u097F]{3,}/.test(checkText)) {
        article.language = 'hi';
      } else {
        article.language = 'en';
      }
      // Re-check against the allow-list in case the operator excluded en/hi.
      if (this._allowedLangs.indexOf(article.language) === -1) {
        this._articlesDroppedByLang++;
        return;
      }
      this.logger.debug(MODULE, '[lang-detect] Assigned language=' + article.language + ' to "' + (article.title || article.url) + '"');
    }
    // ─── End Language Gate ─────────────────────────────────────────────────

    this._articlesReceived++;
    this._lastArticleAt = new Date().toISOString();

    this.logger.debug(MODULE, `Article received: ${article.title || article.url}`, {
      domain: article.domain,
      eventId: article.firehose_event_id,
    });

    this.emit('article', article);
  }

  /**
   * Get the last event ID from SQLite settings table.
   *
   * @returns {string|null}
   */
  getLastEventId() {
    try {
      if (!this._stmtGetSetting) {
        this._stmtGetSetting = this.db.prepare(
          "SELECT value FROM settings WHERE key = ?"
        );
      }
      const row = this._stmtGetSetting.get('firehose_last_event_id');
      return row ? row.value : null;
    } catch (err) {
      this.logger.error(MODULE, 'Failed to get last event ID', err.message);
      return this._lastEventId;
    }
  }

  /**
   * Persist the last event ID to SQLite.
   *
   * @param {string} id
   */
  saveLastEventId(id) {
    try {
      if (!this._stmtSetSetting) {
        this._stmtSetSetting = this.db.prepare(
          "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        );
      }
      this._stmtSetSetting.run('firehose_last_event_id', id);
    } catch (err) {
      this.logger.error(MODULE, 'Failed to save last event ID', err.message);
    }
  }

  /**
   * Async init — MUST NOT THROW.
   */
  async init() {
    try {
      var token = this.config.FIREHOSE_TOKEN;
      if (!token) {
        this.status = 'disabled';
        return;
      }
      this.enabled = true;
      this.status = 'connecting';
      this.logger.info(MODULE, 'Language gate active: allowing [' + this._allowedLangs.join(',') + ']');
      this.connect();
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      this.logger.warn(MODULE, 'Init failed: ' + err.message + '. Module disabled.');
    }
  }

  /**
   * Get module health.
   */
  getHealth() {
    return {
      module: 'firehose',
      enabled: this.enabled,
      ready: this._connected,
      status: this.status,
      error: this.error,
      lastActivity: this._lastArticleAt,
      stats: {
        articlesReceived: this._articlesReceived,
        articlesDroppedByLang: this._articlesDroppedByLang,
        allowedLangs: this._allowedLangs,
        lastEventId: this._lastEventId,
        connected: this._connected,
      }
    };
  }

  /**
   * Async shutdown.
   */
  async shutdown() {
    this.stop();
    this.enabled = false;
    this.status = 'disabled';
  }

  /**
   * Get current status for dashboard/monitoring.
   *
   * @returns {object}
   */
  getStatus() {
    return {
      connected: this._connected,
      lastEventId: this._lastEventId || this.getLastEventId(),
      articlesReceived: this._articlesReceived,
      articlesDroppedByLang: this._articlesDroppedByLang,
      allowedLangs: this._allowedLangs,
      lastArticleAt: this._lastArticleAt,
      stopped: this._stopped,
    };
  }

  /**
   * Close the EventSource connection cleanly.
   * @private
   */
  _closeEventSource() {
    if (this._es) {
      try {
        this._es.close();
      } catch (err) {
        // Ignore close errors
      }
      this._es = null;
    }
  }
}

module.exports = { FirehoseListener };
