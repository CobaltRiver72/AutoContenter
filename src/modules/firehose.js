'use strict';

const { EventEmitter } = require('events');
const EventSource = require('eventsource');
const { URL } = require('url');

const MODULE = 'firehose';
const BASE_URL = 'https://api.firehose.com';

// Reconnect bounds — read from config at reconnect time for hot-reload
var _cfg = require('../utils/config');
var siteConfig = require('../utils/site-config');
function _minReconnectMs() { return parseInt(_cfg.get('FIREHOSE_RECONNECT_MIN'), 10) || 2000; }
function _maxReconnectMs() { return parseInt(_cfg.get('FIREHOSE_RECONNECT_MAX'), 10) || 60000; }
// Keep legacy constants for inline use in rate-limit throttle check (always 2 s minimum)
const MIN_RECONNECT_MS = 2000;

// Wildcard-aware domain matcher. Patterns beginning "*." match that base
// domain plus every subdomain, so "*.my-competitor.com" matches
// "my-competitor.com" AND "blog.my-competitor.com". Plain entries match
// exactly. Cheap O(n) for the short filter lists we ship (typically <20).
// Turn a Firehose `doc`'s content field into a clean markdown string. The
// event can ship content three ways:
//   1. doc.markdown / doc.diff as a plain string — use as-is.
//   2. A structured object like {chunks: [{text, type}, ...]} — join the
//      text of each chunk. Empty arrays mean "no content captured", which
//      should be stored as '' so the editor doesn't render `{"chunks":[]}`
//      as a visible block of JSON.
//   3. Anything else — return ''.
// Never JSON.stringify a wrapper object into the content column: that's
// what caused the ugly raw-JSON display in the cluster editor.
function _coerceFirehoseContent(doc) {
  if (!doc) return '';
  if (typeof doc.markdown === 'string' && doc.markdown.trim()) return doc.markdown;
  if (typeof doc.diff === 'string' && doc.diff.trim()) return doc.diff;

  var candidates = [doc.markdown, doc.diff, doc.content];
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (!c || typeof c !== 'object') continue;
    var chunks = Array.isArray(c.chunks) ? c.chunks
               : Array.isArray(c.paragraphs) ? c.paragraphs
               : Array.isArray(c.blocks) ? c.blocks
               : null;
    if (!chunks || !chunks.length) continue;
    var parts = [];
    for (var j = 0; j < chunks.length; j++) {
      var ch = chunks[j];
      if (typeof ch === 'string') { parts.push(ch); continue; }
      if (ch && typeof ch === 'object') {
        var text = ch.text || ch.content || ch.value || '';
        if (typeof text === 'string' && text.trim()) parts.push(text);
      }
    }
    var joined = parts.join('\n\n').trim();
    if (joined) return joined;
  }
  return '';
}

function _domainMatchesAny(domain, patterns) {
  if (!domain || !Array.isArray(patterns) || !patterns.length) return false;
  var d = String(domain).toLowerCase();
  for (var i = 0; i < patterns.length; i++) {
    var p = String(patterns[i] || '').toLowerCase();
    if (!p) continue;
    if (p.indexOf('*.') === 0) {
      var base = p.slice(2);
      if (d === base || d.endsWith('.' + base)) return true;
    } else if (d === p) {
      return true;
    }
  }
  return false;
}

class FirehoseListener extends EventEmitter {
  /**
   * @param {object} config - Frozen config object
   * @param {import('better-sqlite3').Database} db
   * @param {object} logger - Logger with .info(), .warn(), .error(), .debug()
   * @param {number} [siteId=1] - Site identifier for multi-site operation
   * @param {string} [firehoseToken] - Per-site token override (falls back to config.FIREHOSE_TOKEN)
   */
  constructor(config, db, logger, siteId, firehoseToken, opts) {
    super();
    this.config = config;
    this.db = db;
    this.siteId = siteId || 1;
    // Feed-mode: when opts.feedId is set, filters + last-event-id read from
    // the `feeds` table's source_config + firehose_last_event_id column
    // instead of site_config. Lets each Feed have its own query, country,
    // and include/exclude domains without polluting site-level settings.
    this.feedId     = (opts && opts.feedId)     || null;
    this.feedConfig = (opts && opts.feedConfig) || null;
    // Wrap the logger so every firehose log stamps logs.site_id for this site.
    // Gracefully no-op when the supplied logger predates the forSite helper.
    this.logger = (logger && typeof logger.forSite === 'function')
      ? logger.forSite(this.siteId)
      : logger;
    this.firehoseToken = firehoseToken || null;

    this._es = null;
    this._connected = false;
    this._lastEventId = null;
    this._articlesReceived = 0;
    this._articlesDroppedByLang = 0;
    this._articlesDroppedByDomain = 0;
    this._lastArticleAt = null;
    this._reconnectTimer = null;
    this._lastConnectAttempt = 0;
    this._stopped = false;
    this._reconnectAttempts = 0;

    // Debounced last-event-id persistence. Cold-boot replay can fire dozens
    // of events per second; writing each one to SQLite turned saveLastEventId
    // into a hot-path bottleneck synonymous with the per-INSERT bottleneck
    // the buffer batch already solved. We coalesce: only the most recent id
    // matters for resumption, so we write at most once per second.
    this._pendingLastEventId = null;
    this._lastIdSaveTimer = null;
    this._LAST_ID_SAVE_MS = 1000;

    // _allowedLangs is read fresh from config in handleUpdate() for hot-reload.
    // Keep a boot-time snapshot only as an emergency fallback if config is unavailable.
    this._allowedLangs = ['en', 'hi'];
    // Module independence
    this.enabled = false;
    this.status = 'disabled';
    this.error = null;

    // (last-event-id storage now uses site-config module)
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

      // Build stream URL — read timeout and since window from config for hot-reload
      const streamUrl = new URL('/v1/stream', BASE_URL);
      const sseTimeout = parseInt(_cfg.get('FIREHOSE_TIMEOUT'), 10) || 300;
      streamUrl.searchParams.set('timeout', String(sseTimeout));

      // Load last event ID for resume
      const lastId = this.getLastEventId();
      const headers = {
        Authorization: `Bearer ${this.firehoseToken || this.config.FIREHOSE_TOKEN}`,
      };
      if (lastId) {
        // Reconnect: resume from exact position via Last-Event-ID
        headers['Last-Event-ID'] = lastId;
      } else {
        // First connect ever: replay the configured window of articles.
        // Default '5m' (set in src/utils/config.js DEFAULTS) — bigger
        // windows on cold boot saturate buffer.addArticle's synchronous
        // INSERT path and starve the event loop, blocking /login. The
        // genuine reconnect path uses Last-Event-ID and ignores `since`,
        // so this fallback only fires on first-ever-connect for a feed.
        const sinceWindow = _cfg.get('FIREHOSE_SINCE') || '5m';
        streamUrl.searchParams.set('since', sinceWindow);
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
    // Flush any pending last-event-id so a paused listener can resume
    // exactly where it stopped instead of replaying the debounce window.
    try { this._flushLastIdSave(); } catch (_e) { /* logged inside */ }
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

    // Exponential backoff with full jitter: delay is random in [minMs, base]
    // where base grows as 2^attempt, capped at maxMs. Both read from config for hot-reload.
    var minMs = _minReconnectMs();
    var maxMs = _maxReconnectMs();
    var base = Math.min(minMs * Math.pow(2, this._reconnectAttempts), maxMs);
    var delay = Math.floor(Math.random() * base) + minMs;
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
    // Flush pending last-event-id before any restart code reads the cursor.
    try { this._flushLastIdSave(); } catch (_e) { /* logged inside */ }
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

    // Save the event ID for resumption (debounced — see _queueLastIdSave)
    if (event.lastEventId) {
      this._lastEventId = event.lastEventId;
      this._queueLastIdSave(event.lastEventId);
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

    // Image URL from the Firehose event — field name varies by provider, so
    // try common ones in order and take the first that looks like an http(s)
    // URL. If nothing matches, the column stays NULL and the UI falls back
    // to drafts.featured_image once the extractor fills it in.
    var _imgCandidates = [doc.image, doc.image_url, doc.thumbnail, doc.thumbnail_url, doc.og_image, doc.media_url];
    var imageUrl = null;
    for (var _ii = 0; _ii < _imgCandidates.length; _ii++) {
      var _c = _imgCandidates[_ii];
      if (typeof _c === 'string' && /^https?:\/\//i.test(_c)) { imageUrl = _c; break; }
    }

    // Build article object
    const article = {
      firehose_event_id: event.lastEventId || (data.tap_id + '-' + data.query_id + '-' + Date.now()),
      query_id: data.query_id || null,
      url: doc.url,
      domain: domain,
      title: doc.title || '',
      publish_time: doc.publish_time || null,
      content_markdown: _coerceFirehoseContent(doc),
      language: doc.language ? String(doc.language).toLowerCase() : null,
      page_category: doc.page_category || null,
      page_types: doc.page_types || null,
      image_url: imageUrl,
    };

    // ─── Language Gate ─────────────────────────────────────────────────────
    // Feed-mode reads from feedConfig.allowed_languages; site-mode reads from
    // site_config. Re-reads each event so UI edits take effect on the next
    // article — no restart required.
    var allowedLangs = this._resolveAllowedLangs();
    this._allowedLangs = allowedLangs; // keep in sync for getStats()

    if (article.language && allowedLangs.indexOf(article.language) === -1) {
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
      if (allowedLangs.indexOf(article.language) === -1) {
        this._articlesDroppedByLang++;
        return;
      }
      this.logger.debug(MODULE, '[lang-detect] Assigned language=' + article.language + ' to "' + (article.title || article.url) + '"');
    }
    // ─── End Language Gate ─────────────────────────────────────────────────

    // ─── Domain Gate ───────────────────────────────────────────────────────
    // Supports wildcard entries like "*.my-competitor.com" — matches that
    // domain and every subdomain.
    var blockedDomains = this._resolveBlockedDomains();
    var allowedDomains = this._resolveAllowedDomains();
    if (blockedDomains.length && _domainMatchesAny(domain, blockedDomains)) {
      this._articlesDroppedByDomain++;
      this.logger.debug(MODULE, '[domain-filter] Blocked domain: ' + domain);
      return;
    }
    if (allowedDomains.length && !_domainMatchesAny(domain, allowedDomains)) {
      this._articlesDroppedByDomain++;
      this.logger.debug(MODULE, '[domain-filter] Domain not in allow-list: ' + domain);
      return;
    }
    // ─── End Domain Gate ───────────────────────────────────────────────────

    // ─── Query Gate (feed-mode only) ───────────────────────────────────────
    // A Feed's search_query is a whitespace-separated keyword list; ALL terms
    // must appear in the title + first 500 chars of content. Cheap, not a
    // real ranker — just filters the noise to articles plausibly on-topic.
    if (this.feedConfig && this.feedConfig.query) {
      var haystack = ((article.title || '') + ' ' + String(article.content_markdown || '').substring(0, 500)).toLowerCase();
      var terms = String(this.feedConfig.query).toLowerCase().split(/\s+/).filter(Boolean);
      var allMatch = terms.every(function (t) { return haystack.indexOf(t) !== -1; });
      if (!allMatch) {
        this._articlesDroppedByDomain++;
        return;
      }
    }
    // ─── End Query Gate ────────────────────────────────────────────────────

    // ─── Country Gate (feed-mode only, best-effort) ────────────────────────
    // Ahrefs doesn't always tag geo cleanly; we match on the article's TLD
    // when feedConfig.country is set. This is an approximation — "US" maps
    // to ".com" etc., so disable by leaving country empty for global feeds.
    // Intentionally loose: rather drop nothing than wrongly filter.
    // (kept minimal for Phase 1; can be hardened later)

    this._articlesReceived++;
    this._lastArticleAt = new Date().toISOString();

    this.logger.debug(MODULE, `Article received: ${article.title || article.url}`, {
      domain: article.domain,
      eventId: article.firehose_event_id,
    });

    article.source_site_id = this.siteId;
    if (this.feedId) article.feed_id = this.feedId;
    this.emit('article', article);
  }

  /**
   * Get the last event ID from SQLite. Feed-mode reads the `feeds` row,
   * site-mode reads site_config for backward compat.
   *
   * @returns {string|null}
   */
  getLastEventId() {
    try {
      if (this.feedId) {
        var row = this.db.prepare('SELECT firehose_last_event_id FROM feeds WHERE id = ?').get(this.feedId);
        return (row && row.firehose_last_event_id) || null;
      }
      var value = siteConfig.getSiteConfig(this.siteId, 'firehose_last_event_id');
      return value || null;
    } catch (err) {
      this.logger.error(MODULE, 'Failed to get last event ID', err.message);
      return this._lastEventId;
    }
  }

  /**
   * Persist the last event ID to SQLite. Branches on feed-mode vs site-mode.
   *
   * @param {string} id
   */
  saveLastEventId(id) {
    try {
      if (this.feedId) {
        this.db.prepare('UPDATE feeds SET firehose_last_event_id = ?, updated_at = datetime(\'now\') WHERE id = ?').run(id, this.feedId);
        return;
      }
      siteConfig.setSiteConfig(this.siteId, 'firehose_last_event_id', id);
    } catch (err) {
      this.logger.error(MODULE, 'Failed to save last event ID', err.message);
    }
  }

  /**
   * Coalesce last-event-id writes to at most one DB write per second.
   * Only the most recent id is needed for SSE resumption — intermediate
   * ids are throw-away. The pending id is flushed on the timer or when
   * the listener stops/disconnects.
   *
   * @param {string} id
   * @private
   */
  _queueLastIdSave(id) {
    this._pendingLastEventId = id;
    if (this._lastIdSaveTimer) return;
    var self = this;
    this._lastIdSaveTimer = setTimeout(function () {
      self._lastIdSaveTimer = null;
      self._flushLastIdSave();
    }, this._LAST_ID_SAVE_MS);
  }

  /**
   * Persist the pending last-event-id immediately. Called by the debounce
   * timer and by stop()/disconnect() so a graceful shutdown can resume from
   * where the live stream left off rather than the previously-saved cursor.
   * @private
   */
  _flushLastIdSave() {
    if (this._lastIdSaveTimer) {
      clearTimeout(this._lastIdSaveTimer);
      this._lastIdSaveTimer = null;
    }
    if (!this._pendingLastEventId) return;
    var id = this._pendingLastEventId;
    this._pendingLastEventId = null;
    this.saveLastEventId(id);
  }

  // ─── Filter resolvers ────────────────────────────────────────────────────
  // Feed-mode reads from the supplied feedConfig; site-mode reads from
  // site_config. Kept as methods so subclasses / tests can override without
  // touching the hot-path branching in handleUpdate().

  _resolveAllowedLangs() {
    if (this.feedConfig && this.feedConfig.allowed_languages) {
      var raw = this.feedConfig.allowed_languages;
      var arr = Array.isArray(raw) ? raw : String(raw).split(',');
      var out = arr.map(function (l) { return String(l).trim().toLowerCase(); }).filter(Boolean);
      if (out.length) return out;
    }
    var cfgRaw = siteConfig.getSiteConfig(this.siteId, 'ALLOWED_LANGUAGES') || 'en,hi';
    var cfgArr = String(cfgRaw).split(',').map(function (l) { return l.trim().toLowerCase(); }).filter(Boolean);
    return cfgArr.length ? cfgArr : ['en', 'hi'];
  }

  _resolveBlockedDomains() {
    if (this.feedConfig && Array.isArray(this.feedConfig.exclude_domains)) {
      return this.feedConfig.exclude_domains.map(function (d) { return String(d).trim().toLowerCase(); }).filter(Boolean);
    }
    return String(siteConfig.getSiteConfig(this.siteId, 'FIREHOSE_BLOCKED_DOMAINS') || '').split(',').map(function (d) { return d.trim().toLowerCase(); }).filter(Boolean);
  }

  _resolveAllowedDomains() {
    if (this.feedConfig && Array.isArray(this.feedConfig.include_domains)) {
      return this.feedConfig.include_domains.map(function (d) { return String(d).trim().toLowerCase(); }).filter(Boolean);
    }
    return String(siteConfig.getSiteConfig(this.siteId, 'FIREHOSE_ALLOWED_DOMAINS') || '').split(',').map(function (d) { return d.trim().toLowerCase(); }).filter(Boolean);
  }

  /**
   * Async init — MUST NOT THROW.
   */
  async init() {
    try {
      var token = this.firehoseToken || this.config.FIREHOSE_TOKEN;
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
        articlesDroppedByDomain: this._articlesDroppedByDomain,
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
      articlesDroppedByDomain: this._articlesDroppedByDomain,
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
