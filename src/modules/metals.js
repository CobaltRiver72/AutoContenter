'use strict';

const { EventEmitter } = require('events');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

const MODULE = 'metals';

class MetalsModule extends EventEmitter {
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

    this._cronJobs = [];
    this.enabled = false;
    this.status = 'disabled';
    this.error = null;

    this.stats = {
      totalFetched: 0,
      lastFetchAt: null,
    };

    this.postCreator = null;
  }

  /**
   * Set the post creator instance (called from index.js after wiring).
   */
  setPostCreator(creator) {
    this.postCreator = creator;
  }

  /**
   * Async init - seed cities, set up cron schedules.
   */
  async init() {
    try {
      this.seedCities();

      const tz = 'Asia/Kolkata';

      this._cronJobs.push(cron.schedule('15 6 * * *', () => {
        this.runDailyFetch().catch(err => {
          this.logger.error(MODULE, 'Daily metals fetch cron failed: ' + err.message);
        });
      }, { timezone: tz }));

      this._cronJobs.push(cron.schedule('0 7 * * *', () => {
        this.runAutofill().catch(err => {
          this.logger.error(MODULE, 'Metals autofill cron failed: ' + err.message);
        });
      }, { timezone: tz }));

      // 07:30 IST — Generate posts after fetch + autofill
      this._cronJobs.push(cron.schedule('30 7 * * *', () => {
        this.logger.info(MODULE, 'Post generation cron triggered');
        if (this.postCreator) {
          this.postCreator.runPostGeneration('gold')
            .then(() => this.postCreator.runPostGeneration('silver'))
            .then(() => this.postCreator.runPostGeneration('platinum'))
            .catch(err => this.logger.error(MODULE, 'Post generation cron failed: ' + err.message));
        }
      }, { timezone: tz }));

      this.enabled = true;
      this.status = 'ready';
      this.logger.info(MODULE, 'Metals module initialized');
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      this.logger.warn(MODULE, 'Init failed: ' + err.message + '. Module disabled.');
    }
  }

  /**
   * Seed cities from data/metals-cities.json if table is empty.
   */
  seedCities() {
    const count = this.db.prepare('SELECT COUNT(*) AS c FROM metals_cities').get().c;
    if (count > 0) {
      this.logger.info(MODULE, 'metals_cities already has ' + count + ' rows, skipping seed');
      return;
    }

    const citiesPath = path.resolve(__dirname, '../../data/metals-cities.json');
    if (!fs.existsSync(citiesPath)) {
      this.logger.error(MODULE, 'SEED FILE MISSING: ' + citiesPath + ' — metals_cities will be empty!');
      return;
    }

    const cities = JSON.parse(fs.readFileSync(citiesPath, 'utf8'));

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO metals_cities (city_name, state, api1_name, is_active)
      VALUES (?, ?, ?, 1)
    `);

    const insertMany = this.db.transaction((rows) => {
      for (const c of rows) {
        stmt.run(c.city_name, c.state, c.api1_name || null);
      }
    });

    insertMany(cities);
    this.logger.info(MODULE, 'Seeded ' + cities.length + ' cities into metals_cities');
  }

  /**
   * Get RapidAPI key from settings table.
   */
  _getApiKey() {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'METALS_RAPIDAPI_KEY'").get();
    return row ? row.value : null;
  }

  /**
   * Fetch all metals for all cities.
   */
  async runDailyFetch(isManual = false) {
    const startTime = Date.now();
    this.logger.info(MODULE, 'Starting daily metals fetch...');
    const apiKey = this._getApiKey();
    if (!apiKey) {
      this.logger.warn(MODULE, 'No METALS_RAPIDAPI_KEY set, skipping fetch');
      return { skipped: true };
    }

    const results = {};
    let totalOk = 0;
    for (const metal of ['gold', 'silver', 'platinum']) {
      try {
        const count = await this.fetchBulk(metal, apiKey);
        results[metal] = count;
        totalOk += count;
      } catch (err) {
        this.logger.error(MODULE, 'fetchBulk(' + metal + ') failed: ' + err.message);
        results[metal] = 0;
      }
    }

    const duration = Date.now() - startTime;
    this.stats.lastFetchAt = new Date().toISOString();

    try {
      this.db.prepare(
        'INSERT INTO fetch_log (module, fetch_type, cities_ok, cities_fail, cities_skipped, duration_ms, details) VALUES (?, ?, ?, 0, 0, ?, ?)'
      ).run('metals', isManual ? 'manual' : 'scheduled', totalOk, duration,
        JSON.stringify({ perMetal: results }));
    } catch (e) {
      this.logger.warn(MODULE, 'fetch_log insert failed: ' + e.message);
    }

    this.logger.info(MODULE, 'Daily metals fetch complete: ' + JSON.stringify(results));
    return results;
  }

  /**
   * Fetch bulk prices for a metal type from RapidAPI.
   */
  async fetchBulk(metal, apiKey) {
    const endpointMap = {
      gold: 'GoldPriceTodayForCities',
      silver: 'SilverPriceTodayForCities',
      platinum: 'PlatinumPriceTodayForCities',
    };
    const endpoint = endpointMap[metal];
    if (!endpoint) return 0;

    const host = 'gold-silver-platinum-price-in-india.p.rapidapi.com';
    const res = await fetch('https://' + host + '/' + endpoint, {
      headers: {
        'x-rapidapi-host': host,
        'x-rapidapi-key': apiKey,
      },
    });

    if (!res.ok) {
      throw new Error('API returned ' + res.status);
    }

    const raw = await res.json();
    // API returns { data: { prices: [...] } } or a flat array
    const data = Array.isArray(raw) ? raw
      : (raw && raw.data && Array.isArray(raw.data.prices)) ? raw.data.prices
      : (raw && Array.isArray(raw.data)) ? raw.data
      : null;
    if (!data) {
      throw new Error('Unexpected API response format for ' + metal + ': ' + JSON.stringify(raw).slice(0, 200));
    }

    const today = new Date().toISOString().slice(0, 10);
    let count = 0;

    // Prepare lookup: API name (e.g. "GURGAON") → our canonical city_name (e.g. "Gurugram")
    const cityLookup = this.db.prepare(
      'SELECT city_name FROM metals_cities WHERE UPPER(api1_name) = UPPER(?)'
    );

    for (const cityData of data) {
      const apiName = cityData.city || cityData.City || cityData.city_name;
      if (!apiName) continue;

      // Map to our canonical city_name via api1_name — skip if not in our list
      const localRow = cityLookup.get(apiName.trim());
      if (!localRow) continue;
      const storeName = localRow.city_name;

      const prices = this.extractPrices(cityData);
      if (prices.price_24k || prices.price_1g) {
        this.upsertPrice(storeName, metal, today, prices, 'api1');
        count++;
      }
    }

    this.stats.totalFetched += count;
    return count;
  }

  /**
   * Extract and normalize price fields from API response.
   */
  extractPrices(cityData) {
    let price_24k = parseFloat(cityData.price_24carat || cityData.price_24k) || null;
    let price_22k = parseFloat(cityData.price_22carat || cityData.price_22k) || null;
    let price_18k = parseFloat(cityData.price_18carat || cityData.price_18k) || null;
    let price_1g = parseFloat(cityData.price || cityData.price_1g) || null;

    // Derive missing karats from 24k
    if (price_24k && !price_22k) {
      price_22k = Math.round(price_24k * 22 / 24 * 100) / 100;
    }
    if (price_24k && !price_18k) {
      price_18k = Math.round(price_24k * 18 / 24 * 100) / 100;
    }

    return { price_24k, price_22k, price_18k, price_1g };
  }

  /**
   * Upsert price with COALESCE to preserve valid data.
   */
  upsertPrice(city, metal, date, prices, source) {
    this.db.prepare(`
      INSERT INTO metals_prices (city, metal_type, price_24k, price_22k, price_18k, price_1g, price_date, source, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(city, metal_type, price_date) DO UPDATE SET
        price_24k = COALESCE(NULLIF(excluded.price_24k, 0), price_24k),
        price_22k = COALESCE(NULLIF(excluded.price_22k, 0), price_22k),
        price_18k = COALESCE(NULLIF(excluded.price_18k, 0), price_18k),
        price_1g  = COALESCE(NULLIF(excluded.price_1g, 0), price_1g),
        source = excluded.source,
        created_at = datetime('now')
    `).run(city, metal, prices.price_24k, prices.price_22k, prices.price_18k, prices.price_1g, date, source);
  }

  /**
   * Autofill missing dates for last 7 days by carrying forward.
   */
  async runAutofill() {
    const today = new Date();
    let filled = 0;

    for (const metal of ['gold', 'silver', 'platinum']) {
      for (let d = 1; d <= 7; d++) {
        const dt = new Date(today);
        dt.setDate(dt.getDate() - d);
        const dateStr = dt.toISOString().slice(0, 10);

        const prevDt = new Date(dt);
        prevDt.setDate(prevDt.getDate() - 1);
        const prevStr = prevDt.toISOString().slice(0, 10);

        const gaps = this.db.prepare(`
          SELECT mc.city_name FROM metals_cities mc
          WHERE mc.is_active = 1
            AND NOT EXISTS (
              SELECT 1 FROM metals_prices mp
              WHERE mp.city = mc.city_name AND mp.metal_type = ? AND mp.price_date = ?
            )
        `).all(metal, dateStr);

        for (const g of gaps) {
          const prev = this.db.prepare(
            'SELECT price_24k, price_22k, price_18k, price_1g FROM metals_prices WHERE city = ? AND metal_type = ? AND price_date = ?'
          ).get(g.city_name, metal, prevStr);
          if (prev && (prev.price_24k > 0 || prev.price_1g > 0)) {
            this.db.prepare(`
              INSERT OR IGNORE INTO metals_prices (city, metal_type, price_24k, price_22k, price_18k, price_1g, price_date, source, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, 'carryforward', datetime('now'))
            `).run(g.city_name, metal, prev.price_24k, prev.price_22k, prev.price_18k, prev.price_1g, dateStr);
            filled++;
          }
        }
      }
    }

    if (filled > 0) {
      this.logger.info(MODULE, 'Autofill: carried forward ' + filled + ' metals prices for last 7 days');
    }
  }

  /**
   * Get price history for a city + metal.
   */
  getCityHistory(city, metal, days) {
    return this.db.prepare(`
      SELECT price_date, price_24k, price_22k, price_18k, price_1g
      FROM metals_prices
      WHERE city = ? AND metal_type = ?
        AND price_date >= date('now', '-' || ? || ' days')
      ORDER BY price_date ASC
    `).all(city, metal, days);
  }

  /**
   * Get state trend for a metal.
   */
  getStateTrend(state, metal, days) {
    return this.db.prepare(`
      SELECT mp.price_date, AVG(mp.price_24k) AS avg_price
      FROM metals_prices mp
      INNER JOIN metals_cities mc ON mp.city = mc.city_name
      WHERE mc.state = ? AND mp.metal_type = ?
        AND mp.price_date >= date('now', '-' || ? || ' days')
      GROUP BY mp.price_date
      ORDER BY mp.price_date ASC
    `).all(state, metal, days);
  }

  /**
   * Get national trend for a metal.
   */
  getNationalTrend(metal, days) {
    return this.db.prepare(`
      SELECT price_date, AVG(price_24k) AS avg_price
      FROM metals_prices
      WHERE metal_type = ? AND price_date >= date('now', '-' || ? || ' days')
      GROUP BY price_date
      ORDER BY price_date ASC
    `).all(metal, days);
  }

  /**
   * Summary for today.
   */
  getTodaySummary() {
    const today = new Date().toISOString().slice(0, 10);
    const total = this.db.prepare('SELECT COUNT(*) AS c FROM metals_cities WHERE is_active = 1').get().c;

    const result = { total, lastFetchAt: this.stats.lastFetchAt };

    for (const metal of ['gold', 'silver', 'platinum']) {
      const fetched = this.db.prepare(
        'SELECT COUNT(*) AS c FROM metals_prices WHERE metal_type = ? AND price_date = ?'
      ).get(metal, today).c;

      const avg = this.db.prepare(
        'SELECT AVG(price_24k) AS avgPrice FROM metals_prices WHERE metal_type = ? AND price_date = ? AND price_24k > 0'
      ).get(metal, today);

      result[metal] = {
        fetched,
        total,
        missing: Math.max(0, total - fetched),
        avgPrice: avg ? Math.round(avg.avgPrice) : null,
      };
    }

    // Top-level fetched = gold fetched (primary metal)
    result.fetched = result.gold ? result.gold.fetched : 0;

    // Last fetch from log
    try {
      const lastFetch = this.db.prepare(
        'SELECT * FROM fetch_log WHERE module = ? ORDER BY created_at DESC LIMIT 1'
      ).get('metals');
      if (lastFetch) {
        result.lastFetchResult = {
          type: lastFetch.fetch_type,
          ok: lastFetch.cities_ok,
          fail: lastFetch.cities_fail,
          duration: lastFetch.duration_ms,
          time: lastFetch.created_at,
          details: lastFetch.details ? JSON.parse(lastFetch.details) : null,
        };
      }
    } catch (e) { /* ignore */ }

    return result;
  }

  /**
   * Module health.
   */
  getHealth() {
    return {
      module: MODULE,
      enabled: this.enabled,
      ready: this.status === 'ready',
      status: this.status,
      error: this.error,
      lastActivity: this.stats.lastFetchAt,
      stats: this.stats,
    };
  }

  /**
   * Graceful shutdown.
   */
  async shutdown() {
    for (const job of this._cronJobs) {
      job.stop();
    }
    this._cronJobs = [];
    this.enabled = false;
    this.status = 'disabled';
    this.logger.info(MODULE, 'Metals module shut down');
  }
}

module.exports = { MetalsModule };
