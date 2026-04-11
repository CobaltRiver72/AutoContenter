'use strict';

const { EventEmitter } = require('events');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

const MODULE = 'fuel';

class FuelModule extends EventEmitter {
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
      citiesOk: 0,
      citiesFail: 0,
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

      // Cron schedules (IST timezone)
      const tz = 'Asia/Kolkata';

      this._cronJobs.push(cron.schedule('0 6 * * *', () => {
        this.runDailyFetch().catch(err => {
          this.logger.error(MODULE, 'Daily fetch cron failed: ' + err.message);
        });
      }, { timezone: tz }));

      this._cronJobs.push(cron.schedule('0 7 * * *', () => {
        this.runAutofill().catch(err => {
          this.logger.error(MODULE, 'Autofill cron failed: ' + err.message);
        });
      }, { timezone: tz }));

      // 06:30 IST — Generate posts after fetch completes
      this._cronJobs.push(cron.schedule('30 6 * * *', () => {
        this.logger.info(MODULE, 'Post generation cron triggered');
        if (this.postCreator) {
          this.postCreator.runPostGeneration('petrol')
            .then(() => this.postCreator.runPostGeneration('diesel'))
            .catch(err => this.logger.error(MODULE, 'Post generation cron failed: ' + err.message));
        }
      }, { timezone: tz }));

      this.enabled = true;
      this.status = 'ready';
      this.logger.info(MODULE, 'Fuel module initialized');
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      this.logger.warn(MODULE, 'Init failed: ' + err.message + '. Module disabled.');
    }
  }

  /**
   * Seed cities from data/fuel-cities.json if table is empty.
   */
  seedCities() {
    const count = this.db.prepare('SELECT COUNT(*) AS c FROM fuel_cities').get().c;
    if (count > 0) {
      this.logger.info(MODULE, 'fuel_cities already has ' + count + ' rows, skipping seed');
      return;
    }

    const dataDir = path.resolve(__dirname, '../../data');
    const citiesPath = path.join(dataDir, 'fuel-cities.json');
    if (!fs.existsSync(citiesPath)) {
      this.logger.error(MODULE, 'SEED FILE MISSING: ' + citiesPath + ' — fuel_cities will be empty!');
      return;
    }

    const cities = JSON.parse(fs.readFileSync(citiesPath, 'utf8'));

    // Load api3 city list for matching
    const api3Path = path.join(dataDir, 'fuel-api3-cities.json');
    let api3Set = new Set();
    if (fs.existsSync(api3Path)) {
      const api3List = JSON.parse(fs.readFileSync(api3Path, 'utf8'));
      api3Set = new Set(api3List.map(c => c.toLowerCase()));
    }

    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO fuel_cities (city_name, state, is_ut, region, api3_city, is_top_city, is_enabled, has_post)
      VALUES (?, ?, ?, ?, ?, ?, 1, 1)
    `);

    const insertMany = this.db.transaction((rows) => {
      for (const c of rows) {
        // Use explicit api3_name override if present, else try city_name against api3 list
        let api3City = null;
        if (c.api3_name) {
          api3City = api3Set.has(c.api3_name.toLowerCase()) ? c.api3_name : null;
        } else {
          api3City = api3Set.has(c.city_name.toLowerCase()) ? c.city_name : null;
        }
        stmt.run(c.city_name, c.state, c.is_ut || 0, c.region || null, api3City, c.is_top_city || 0);
      }
    });

    insertMany(cities);
    this.logger.info(MODULE, 'Seeded ' + cities.length + ' cities into fuel_cities');
  }

  /**
   * Get RapidAPI key from settings table.
   */
  _getApiKey() {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = 'FUEL_RAPIDAPI_KEY'").get();
    return row ? row.value : null;
  }

  /**
   * Fetch prices for all enabled cities.
   */
  async runDailyFetch(isManual = false) {
    const startTime = Date.now();
    this.logger.info(MODULE, 'Starting daily fuel fetch...');
    const apiKey = this._getApiKey();
    if (!apiKey) {
      this.logger.warn(MODULE, 'No FUEL_RAPIDAPI_KEY set, skipping fetch');
      return { ok: 0, fail: 0, skipped: true };
    }

    const cities = this.db.prepare('SELECT * FROM fuel_cities WHERE is_enabled = 1 AND api3_city IS NOT NULL').all();
    let ok = 0;
    let fail = 0;
    const failedCities = [];

    for (const city of cities) {
      try {
        await this.fetchCityPrice(city, apiKey);
        ok++;
      } catch (err) {
        fail++;
        failedCities.push(city.city_name);
        this.logger.warn(MODULE, 'Fetch failed for ' + city.city_name + ': ' + err.message);
      }
      // 100ms delay between cities
      await new Promise(r => setTimeout(r, 100));
    }

    // Derive missing prices from state averages
    this.deriveMissing();

    const duration = Date.now() - startTime;
    this.stats.totalFetched += ok;
    this.stats.lastFetchAt = new Date().toISOString();
    this.stats.citiesOk = ok;
    this.stats.citiesFail = fail;

    try {
      this.db.prepare(
        'INSERT INTO fetch_log (module, fetch_type, cities_ok, cities_fail, cities_skipped, duration_ms, details) VALUES (?, ?, ?, ?, 0, ?, ?)'
      ).run('fuel', isManual ? 'manual' : 'scheduled', ok, fail, duration,
        JSON.stringify({ failedCities: failedCities.slice(0, 20) }));
    } catch (e) {
      this.logger.warn(MODULE, 'fetch_log insert failed: ' + e.message);
    }

    this.logger.info(MODULE, 'Daily fetch complete: ' + ok + ' ok, ' + fail + ' fail out of ' + cities.length);
    return { ok, fail, total: cities.length };
  }

  /**
   * Fetch a single city's petrol and diesel prices from RapidAPI.
   */
  async fetchCityPrice(city, apiKey) {
    const host = 'fuel-petrol-diesel-live-price-india.p.rapidapi.com';
    const headers = {
      'x-rapidapi-host': host,
      'x-rapidapi-key': apiKey,
      'Content-Type': 'application/json',
      'city': city.api3_city,
    };

    let petrol = null;
    let diesel = null;
    const errors = [];

    // Fetch petrol
    try {
      const pRes = await fetch('https://' + host + '/petrol_price_india_city_value/', { headers });
      if (!pRes.ok) {
        errors.push('Petrol API returned ' + pRes.status);
      } else {
        const pData = await pRes.json();
        const val = Object.values(pData)[0];
        if (typeof val === 'number' && val >= 30 && val <= 300) {
          petrol = val;
        } else {
          errors.push('Petrol: invalid value ' + JSON.stringify(val));
        }
      }
    } catch (e) {
      errors.push('Petrol fetch error: ' + e.message);
    }

    // Fetch diesel
    try {
      const dRes = await fetch('https://' + host + '/diesel_price_india_city_value/', { headers });
      if (!dRes.ok) {
        errors.push('Diesel API returned ' + dRes.status);
      } else {
        const dData = await dRes.json();
        const val = Object.values(dData)[0];
        if (typeof val === 'number' && val >= 20 && val <= 300) {
          diesel = val;
        } else {
          errors.push('Diesel: invalid value ' + JSON.stringify(val));
        }
      }
    } catch (e) {
      errors.push('Diesel fetch error: ' + e.message);
    }

    if (errors.length > 0) {
      this.logger.warn(MODULE, city.city_name + ': ' + errors.join('; '));
    }

    if (petrol !== null || diesel !== null) {
      this.upsertPrice(city.city_name, city.state, petrol, diesel, 'api3');
      return true;
    }

    // Both failed — throw so runDailyFetch counts it as a failure
    if (errors.length > 0) {
      throw new Error(errors.join('; '));
    }
    return false;
  }

  /**
   * Upsert price with COALESCE to avoid overwriting valid data.
   */
  upsertPrice(city, state, petrol, diesel, source) {
    const today = new Date().toISOString().slice(0, 10);
    this.db.prepare(`
      INSERT INTO fuel_prices (city, state, petrol, diesel, price_date, source, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(city, price_date) DO UPDATE SET
        petrol = COALESCE(excluded.petrol, petrol),
        diesel = COALESCE(excluded.diesel, diesel),
        source = excluded.source,
        fetched_at = excluded.fetched_at
    `).run(city, state, petrol, diesel, today, source);
  }

  /**
   * Derive missing prices from state averages with small variance.
   */
  deriveMissing() {
    const today = new Date().toISOString().slice(0, 10);
    const missing = this.db.prepare(`
      SELECT fc.city_name, fc.state FROM fuel_cities fc
      WHERE fc.has_post = 1 AND fc.is_enabled = 1
        AND NOT EXISTS (
          SELECT 1 FROM fuel_prices fp WHERE fp.city = fc.city_name AND fp.price_date = ?
        )
    `).all(today);

    if (!missing.length) return;

    let derived = 0;
    for (const m of missing) {
      const avg = this.getStateAverage(m.state);
      if (avg && (avg.petrol > 0 || avg.diesel > 0)) {
        const petrol = avg.petrol > 0 ? Math.round(avg.petrol * (1 + (Math.random() - 0.5) / 100) * 100) / 100 : null;
        const diesel = avg.diesel > 0 ? Math.round(avg.diesel * (1 + (Math.random() - 0.5) / 100) * 100) / 100 : null;
        this.upsertPrice(m.city_name, m.state, petrol, diesel, 'derived');
        derived++;
      }
    }

    if (derived > 0) {
      this.logger.info(MODULE, 'Derived prices for ' + derived + ' cities from state averages');
    }
  }

  /**
   * Autofill gaps for the last 7 days by carrying forward.
   */
  async runAutofill() {
    const today = new Date();
    let filled = 0;

    for (let d = 1; d <= 7; d++) {
      const dt = new Date(today);
      dt.setDate(dt.getDate() - d);
      const dateStr = dt.toISOString().slice(0, 10);

      const prevDt = new Date(dt);
      prevDt.setDate(prevDt.getDate() - 1);
      const prevStr = prevDt.toISOString().slice(0, 10);

      const gaps = this.db.prepare(`
        SELECT fc.city_name, fc.state FROM fuel_cities fc
        WHERE fc.has_post = 1 AND fc.is_enabled = 1
          AND NOT EXISTS (
            SELECT 1 FROM fuel_prices fp WHERE fp.city = fc.city_name AND fp.price_date = ?
          )
      `).all(dateStr);

      for (const g of gaps) {
        const prev = this.db.prepare(
          'SELECT petrol, diesel FROM fuel_prices WHERE city = ? AND price_date = ?'
        ).get(g.city_name, prevStr);
        if (prev && (prev.petrol > 0 || prev.diesel > 0)) {
          this.db.prepare(`
            INSERT OR IGNORE INTO fuel_prices (city, state, petrol, diesel, price_date, source, fetched_at)
            VALUES (?, ?, ?, ?, ?, 'carryforward', datetime('now'))
          `).run(g.city_name, g.state, prev.petrol, prev.diesel, dateStr);
          filled++;
        }
      }
    }

    if (filled > 0) {
      this.logger.info(MODULE, 'Autofill: carried forward ' + filled + ' prices for last 7 days');
    }
  }

  /**
   * Get state average prices for today.
   */
  getStateAverage(state) {
    const today = new Date().toISOString().slice(0, 10);
    return this.db.prepare(`
      SELECT AVG(petrol) AS petrol, AVG(diesel) AS diesel
      FROM fuel_prices
      WHERE state = ? AND price_date = ? AND (petrol > 0 OR diesel > 0)
    `).get(state, today);
  }

  /**
   * Get national average prices for today.
   */
  getNationalAverage() {
    const today = new Date().toISOString().slice(0, 10);
    return this.db.prepare(`
      SELECT AVG(petrol) AS petrol, AVG(diesel) AS diesel
      FROM fuel_prices
      WHERE price_date = ? AND (petrol > 0 OR diesel > 0)
    `).get(today);
  }

  /**
   * Get price history for a city.
   */
  getCityHistory(city, days) {
    return this.db.prepare(`
      SELECT price_date, petrol, diesel
      FROM fuel_prices
      WHERE city = ? AND price_date >= date('now', '-' || ? || ' days')
      ORDER BY price_date ASC
    `).all(city, days);
  }

  /**
   * Get all cities in a state with today's prices.
   */
  getStateCitiesToday(state) {
    return this.db.prepare(`
      SELECT fc.city_name, fp.petrol, fp.diesel
      FROM fuel_cities fc
      LEFT JOIN fuel_prices fp ON fc.city_name = fp.city AND fp.price_date = date('now')
      WHERE fc.state = ? AND fc.is_enabled = 1
      ORDER BY fc.city_name
    `).all(state);
  }

  /**
   * Summary for today: total cities, fetched, missing, by source.
   */
  getTodaySummary() {
    const today = new Date().toISOString().slice(0, 10);
    const total = this.db.prepare('SELECT COUNT(*) AS c FROM fuel_cities WHERE is_enabled = 1').get().c;
    const fetched = this.db.prepare('SELECT COUNT(*) AS c FROM fuel_prices WHERE price_date = ?').get(today).c;

    const bySrc = this.db.prepare(`
      SELECT source, COUNT(*) AS c FROM fuel_prices WHERE price_date = ? GROUP BY source
    `).all(today);
    const bySource = {};
    for (const r of bySrc) bySource[r.source] = r.c;

    // Last fetch from log
    let lastFetchResult = null;
    try {
      const lastFetch = this.db.prepare(
        'SELECT * FROM fetch_log WHERE module = ? ORDER BY created_at DESC LIMIT 1'
      ).get('fuel');
      if (lastFetch) {
        lastFetchResult = {
          type: lastFetch.fetch_type,
          ok: lastFetch.cities_ok,
          fail: lastFetch.cities_fail,
          duration: lastFetch.duration_ms,
          time: lastFetch.created_at,
          details: lastFetch.details ? JSON.parse(lastFetch.details) : null,
        };
      }
    } catch (e) { /* ignore */ }

    return {
      total,
      fetched,
      missing: Math.max(0, total - fetched),
      bySource,
      lastFetchAt: this.stats.lastFetchAt,
      lastFetchResult,
    };
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
    this.logger.info(MODULE, 'Fuel module shut down');
  }
}

module.exports = { FuelModule };
