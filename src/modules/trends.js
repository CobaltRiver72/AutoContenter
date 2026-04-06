'use strict';

const { EventEmitter } = require('events');
const cron = require('node-cron');
const googleTrends = require('google-trends-api');

const MODULE = 'trends';

class TrendsPoller extends EventEmitter {
  /**
   * @param {object} config - Frozen config object
   * @param {import('better-sqlite3').Database} db
   * @param {object} logger
   */
  constructor(config, db, logger) {
    super();
    this.config = config;
    this.db = db;
    this.logger = logger;

    this._cronJob = null;
    this._running = false;
    this._lastPollAt = null;
    this._pollCount = 0;

    // Module independence
    this.enabled = false;
    this.status = 'disabled';
    this.error = null;

    // Prepared statements (lazy init)
    this._stmts = {};
  }

  /**
   * Async init — MUST NOT THROW.
   */
  async init() {
    try {
      if (!this.config.TRENDS_ENABLED) {
        this.status = 'disabled';
        return;
      }
      this.enabled = true;
      this.status = 'connected';
      this.start();
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
      module: 'trends',
      enabled: this.enabled,
      ready: this._cronJob !== null,
      status: this.status,
      error: this.error,
      lastActivity: this._lastPollAt,
      stats: {
        pollCount: this._pollCount,
        running: this._cronJob !== null,
        enabled: !!this.config.TRENDS_ENABLED,
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
   * Start the cron-based polling job.
   */
  start() {
    if (!this.config.TRENDS_ENABLED) {
      this.logger.info(MODULE, 'Trends polling is disabled (TRENDS_ENABLED=false)');
      return;
    }
    const minutes = this.config.TRENDS_POLL_MINUTES || 15;

    // node-cron expression: every N minutes
    const cronExpr = `*/${minutes} * * * *`;

    this.logger.info(MODULE, `Starting trends poller every ${minutes} minutes (cron: ${cronExpr})`);

    this._cronJob = cron.schedule(cronExpr, async () => {
      await this.pollOnce();
    }, { scheduled: true });

    // Do an immediate first poll
    this.pollOnce().catch((err) => {
      this.logger.error(MODULE, 'Initial poll failed', err.message);
    });
  }

  /**
   * Stop the cron job.
   */
  stop() {
    if (this._cronJob) {
      this._cronJob.stop();
      this._cronJob = null;
      this.logger.info(MODULE, 'Trends poller stopped');
    }
  }

  /**
   * Perform a single poll of both Google Trends endpoints.
   */
  async pollOnce() {
    if (!this.config.TRENDS_ENABLED) {
      return { disabled: true };
    }
    if (this._running) {
      this.logger.debug(MODULE, 'Poll already in progress, skipping');
      return;
    }

    this._running = true;
    this.logger.info(MODULE, 'Polling Google Trends...');

    try {
      const geo = this.config.TRENDS_GEO || 'IN';
      const results = [];

      // Fetch real-time trends
      const realTimeResults = await this._fetchRealTimeTrends(geo);
      results.push(...realTimeResults);

      // Fetch daily trends
      const dailyResults = await this._fetchDailyTrends(geo);
      results.push(...dailyResults);

      // Update DB
      let newCount = 0;
      let updatedCount = 0;

      for (const trend of results) {
        try {
          const existing = this._getExistingTrend(trend.topic, trend.trend_type);
          if (existing) {
            this._updateTrend(existing.id, trend);
            updatedCount++;
          } else {
            this._insertTrend(trend);
            newCount++;
          }
        } catch (err) {
          this.logger.error(MODULE, `Failed to upsert trend: ${trend.topic}`, err.message);
        }
      }

      // Clean expired trends
      this.cleanExpired();

      this._lastPollAt = new Date().toISOString();
      this._pollCount++;

      this.logger.info(MODULE, `Poll complete: ${newCount} new, ${updatedCount} updated, total fetched: ${results.length}`);
      this.emit('trends-updated', { newCount, updatedCount, total: results.length });
    } catch (err) {
      this.logger.error(MODULE, 'Poll failed', err.message);
    } finally {
      this._running = false;
    }
  }

  /**
   * Fetch real-time trends from Google Trends.
   *
   * @param {string} geo
   * @returns {Promise<Array>}
   */
  async _fetchRealTimeTrends(geo) {
    const trends = [];
    try {
      const raw = await Promise.race([
        googleTrends.realTimeTrends({ geo, category: 'all' }),
        this._timeout(15000, 'realTimeTrends timeout'),
      ]);

      const parsed = JSON.parse(raw);
      const stories = parsed.storySummaries && parsed.storySummaries.trendingStories
        ? parsed.storySummaries.trendingStories
        : [];

      for (const story of stories) {
        const topic = story.title || (story.entityNames && story.entityNames[0]) || '';
        if (!topic) continue;

        const relatedQueries = story.entityNames ? story.entityNames.join(', ') : '';
        const sourceUrl = story.articles && story.articles[0] ? story.articles[0].url : '';

        trends.push({
          topic: topic.trim(),
          trend_type: 'realtime',
          related_queries: relatedQueries,
          traffic_volume: story.entityExploreLink || '',
          source_url: sourceUrl,
        });
      }

      this.logger.debug(MODULE, `Fetched ${trends.length} real-time trends`);
    } catch (err) {
      this.logger.warn(MODULE, 'Failed to fetch real-time trends', err.message);
    }
    return trends;
  }

  /**
   * Fetch daily trends from Google Trends.
   *
   * @param {string} geo
   * @returns {Promise<Array>}
   */
  async _fetchDailyTrends(geo) {
    const trends = [];
    try {
      const raw = await Promise.race([
        googleTrends.dailyTrends({ geo }),
        this._timeout(15000, 'dailyTrends timeout'),
      ]);

      const parsed = JSON.parse(raw);
      const days = parsed.default && parsed.default.trendingSearchesDays
        ? parsed.default.trendingSearchesDays
        : [];

      for (const day of days) {
        const searches = day.trendingSearches || [];
        for (const search of searches) {
          const topic = search.title && search.title.query ? search.title.query : '';
          if (!topic) continue;

          const relatedQueries = search.relatedQueries
            ? search.relatedQueries.map((q) => q.query).join(', ')
            : '';
          const traffic = search.formattedTraffic || '';
          const sourceUrl = search.articles && search.articles[0]
            ? search.articles[0].url
            : '';

          trends.push({
            topic: topic.trim(),
            trend_type: 'daily',
            related_queries: relatedQueries,
            traffic_volume: traffic,
            source_url: sourceUrl,
          });
        }
      }

      this.logger.debug(MODULE, `Fetched ${trends.length} daily trends`);
    } catch (err) {
      this.logger.warn(MODULE, 'Failed to fetch daily trends', err.message);
    }
    return trends;
  }

  /**
   * Get all non-expired trends (the watchlist).
   *
   * @returns {Array}
   */
  getWatchlist() {
    try {
      if (!this._stmts.watchlist) {
        this._stmts.watchlist = this.db.prepare(
          "SELECT * FROM trends WHERE status = 'watching' AND (expires_at IS NULL OR expires_at > datetime('now')) ORDER BY last_updated DESC"
        );
      }
      return this._stmts.watchlist.all();
    } catch (err) {
      this.logger.error(MODULE, 'Failed to get watchlist', err.message);
      return [];
    }
  }

  /**
   * Check if an article matches any active trend.
   *
   * @param {object} article - Must have title and content_markdown
   * @returns {{ matched: boolean, trend: object|null, score: number }}
   */
  matchArticle(article) {
    try {
      const watchlist = this.getWatchlist();
      if (watchlist.length === 0) {
        return { matched: false, trend: null, score: 0 };
      }

      const titleLower = (article.title || '').toLowerCase();
      // First 200 words of content
      const contentWords = (article.content_markdown || '')
        .replace(/[#*_\[\]()>`~|\\-]/g, ' ')
        .split(/\s+/)
        .slice(0, 200)
        .join(' ')
        .toLowerCase();
      const searchText = `${titleLower} ${contentWords}`;

      let bestMatch = null;
      let bestScore = 0;

      for (const trend of watchlist) {
        const topicLower = trend.topic.toLowerCase();
        let score = 0;

        // Check 1: Full topic substring in title
        if (titleLower.includes(topicLower)) {
          score = 1.0;
        } else {
          // Check 2: Keyword overlap (60%+ of trend topic keywords in title + first 200 words)
          const trendKeywords = topicLower
            .split(/\s+/)
            .filter((w) => w.length > 2);

          if (trendKeywords.length > 0) {
            const matchedKeywords = trendKeywords.filter((kw) => searchText.includes(kw));
            score = matchedKeywords.length / trendKeywords.length;
          }
        }

        if (score >= 0.6 && score > bestScore) {
          bestScore = score;
          bestMatch = trend;
        }
      }

      if (bestMatch) {
        this.logger.debug(MODULE, `Article matched trend: "${bestMatch.topic}" (score: ${bestScore.toFixed(2)})`, {
          articleTitle: article.title,
        });
        this.emit('trend-matched', { article, trend: bestMatch, score: bestScore });
        return { matched: true, trend: bestMatch, score: bestScore };
      }

      return { matched: false, trend: null, score: 0 };
    } catch (err) {
      this.logger.error(MODULE, 'Error matching article to trends', err.message);
      return { matched: false, trend: null, score: 0 };
    }
  }

  /**
   * Remove trends older than the buffer window (default 6 hours).
   */
  cleanExpired() {
    try {
      const hours = this.config.BUFFER_HOURS || 6;
      if (!this._stmts.clean) {
        this._stmts.clean = this.db.prepare(
          "DELETE FROM trends WHERE expires_at IS NOT NULL AND expires_at < datetime('now')"
        );
      }
      if (!this._stmts.cleanOld) {
        this._stmts.cleanOld = this.db.prepare(
          `DELETE FROM trends WHERE first_seen < datetime('now', '-${hours} hours') AND status = 'watching'`
        );
      }
      const r1 = this._stmts.clean.run();
      const r2 = this._stmts.cleanOld.run();
      const total = r1.changes + r2.changes;
      if (total > 0) {
        this.logger.debug(MODULE, `Cleaned ${total} expired trends`);
      }
    } catch (err) {
      this.logger.error(MODULE, 'Failed to clean expired trends', err.message);
    }
  }

  /**
   * Get poller status for dashboard.
   *
   * @returns {object}
   */
  getStatus() {
    return {
      enabled: !!this.config.TRENDS_ENABLED,
      running: this._cronJob !== null,
      lastPollAt: this._lastPollAt,
      pollCount: this._pollCount,
      isPolling: this._running,
    };
  }

  // ─── Private Helpers ────────────────────────────────────────────────────────

  /**
   * Get existing trend by topic + type.
   */
  _getExistingTrend(topic, trendType) {
    try {
      if (!this._stmts.getExisting) {
        this._stmts.getExisting = this.db.prepare(
          'SELECT * FROM trends WHERE topic = ? AND trend_type = ?'
        );
      }
      return this._stmts.getExisting.get(topic, trendType) || null;
    } catch (err) {
      this.logger.error(MODULE, 'Failed to query existing trend', err.message);
      return null;
    }
  }

  /**
   * Insert a new trend.
   */
  _insertTrend(trend) {
    if (!this._stmts.insert) {
      this._stmts.insert = this.db.prepare(
        `INSERT INTO trends (topic, trend_type, related_queries, traffic_volume, source_url, expires_at)
         VALUES (?, ?, ?, ?, ?, datetime('now', '+${this.config.BUFFER_HOURS || 6} hours'))`
      );
    }
    this._stmts.insert.run(
      trend.topic,
      trend.trend_type,
      trend.related_queries || null,
      trend.traffic_volume || null,
      trend.source_url || null
    );
  }

  /**
   * Update an existing trend's timestamp and metadata.
   */
  _updateTrend(id, trend) {
    if (!this._stmts.update) {
      this._stmts.update = this.db.prepare(
        `UPDATE trends SET
          related_queries = ?,
          traffic_volume = ?,
          source_url = ?,
          last_updated = datetime('now'),
          expires_at = datetime('now', '+${this.config.BUFFER_HOURS || 6} hours')
         WHERE id = ?`
      );
    }
    this._stmts.update.run(
      trend.related_queries || null,
      trend.traffic_volume || null,
      trend.source_url || null,
      id
    );
  }

  /**
   * Timeout helper for Promise.race.
   */
  _timeout(ms, message) {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message || `Timeout after ${ms}ms`)), ms);
    });
  }
}

module.exports = { TrendsPoller };
