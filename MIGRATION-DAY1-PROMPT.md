# Day 1 Migration Prompt — Fuel + Metals Modules + Dashboard

## OVERVIEW

Migrate the HDF Fuel and HDF Metals WordPress plugins into the HDF AutoPub
Node.js application. This prompt covers: SQLite schema, seed data, RapidAPI
fetchers, cron scheduling, API routes, and dashboard pages for both modules.

The existing app structure follows this pattern:
- Modules live in `src/modules/` (e.g. firehose.js, rewriter.js)
- Each module is a class with `init()`, `getHealth()`, `shutdown()` methods
- Modules are wired in `src/index.js` and exposed via `app.locals.modules`
- Routes live in `src/routes/api.js`
- Frontend is in `public/index.html` + `public/js/dashboard.js`
- DB setup is in `src/utils/db.js`
- The app uses better-sqlite3 (synchronous), node-cron, Express

---

## PART 1 — Database Schema

FILE: `src/utils/db.js`
LOCATION: Inside `runMigrations()`, after all existing table/index creation

ADD these tables and indexes:

```sql
-- ═══════════════════════════════════════════════════════════════════
-- FUEL MODULE TABLES
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS fuel_cities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city_name TEXT NOT NULL,
  state TEXT NOT NULL,
  is_ut INTEGER DEFAULT 0,
  region TEXT,
  api3_city TEXT,
  is_top_city INTEGER DEFAULT 0,
  is_enabled INTEGER DEFAULT 1,
  has_post INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(city_name, state)
);

CREATE INDEX IF NOT EXISTS idx_fuel_cities_state ON fuel_cities(state);
CREATE INDEX IF NOT EXISTS idx_fuel_cities_enabled ON fuel_cities(is_enabled);

CREATE TABLE IF NOT EXISTS fuel_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  petrol REAL,
  diesel REAL,
  price_date TEXT NOT NULL,
  source TEXT DEFAULT 'api3',
  fetched_at TEXT DEFAULT (datetime('now')),
  UNIQUE(city, price_date)
);

CREATE INDEX IF NOT EXISTS idx_fuel_prices_city ON fuel_prices(city);
CREATE INDEX IF NOT EXISTS idx_fuel_prices_date ON fuel_prices(price_date);
CREATE INDEX IF NOT EXISTS idx_fuel_prices_state_date ON fuel_prices(state, price_date);
CREATE INDEX IF NOT EXISTS idx_fuel_prices_city_date ON fuel_prices(city, price_date);

CREATE TABLE IF NOT EXISTS fuel_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  log_type TEXT DEFAULT 'info',
  source TEXT,
  message TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ═══════════════════════════════════════════════════════════════════
-- METALS MODULE TABLES
-- ═══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS metals_cities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city_name TEXT NOT NULL,
  state TEXT NOT NULL,
  api1_name TEXT,
  is_active INTEGER DEFAULT 1,
  UNIQUE(city_name)
);

CREATE INDEX IF NOT EXISTS idx_metals_cities_state ON metals_cities(state);

CREATE TABLE IF NOT EXISTS metals_prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city TEXT NOT NULL,
  metal_type TEXT NOT NULL,
  price_24k REAL,
  price_22k REAL,
  price_18k REAL,
  price_1g REAL,
  price_date TEXT NOT NULL,
  source TEXT DEFAULT 'api1',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(city, metal_type, price_date)
);

CREATE INDEX IF NOT EXISTS idx_metals_prices_city ON metals_prices(city);
CREATE INDEX IF NOT EXISTS idx_metals_prices_date ON metals_prices(price_date);
CREATE INDEX IF NOT EXISTS idx_metals_prices_metal_date ON metals_prices(metal_type, price_date);
CREATE INDEX IF NOT EXISTS idx_metals_prices_city_metal ON metals_prices(city, metal_type);

CREATE TABLE IF NOT EXISTS metals_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);
```

---

## PART 2 — Seed Data

Copy these JSON files from the WP plugins into `data/` folder in AutoPub:

- `data/fuel-cities.json` — copy from `hdf-fuel/data/cities.json`
- `data/fuel-api3-cities.json` — copy from `hdf-fuel/data/api3-all-cities.json`
- `data/metals-cities.json` — copy from `hdf-metals/data/cities.json`

The fuel cities.json shape per entry:
```json
{
  "city_name": "Mumbai",
  "state": "Maharashtra",
  "is_ut": 0,
  "region": "western",
  "api1_city": "Mumbai",
  "api2_city": "Mumbai",
  "api2_state": "Maharashtra",
  "is_top_city": 1
}
```

The metals cities.json shape per entry:
```json
{
  "city_name": "Mumbai",
  "state": "Maharashtra",
  "api1_name": "Mumbai"
}
```

---

## PART 3 — Fuel Module

FILE: `src/modules/fuel.js` (NEW FILE)

Create a class `FuelModule` following the same pattern as other modules in the
codebase (constructor takes config, db, logger; has init/getHealth/shutdown).

### Constructor
- Store config, db, logger
- Set this.enabled, this.status, this.error, this.stats
- this.stats = { totalFetched: 0, lastFetchAt: null, citiesOk: 0, citiesFail: 0 }

### init()
- Seed cities from `data/fuel-cities.json` if fuel_cities table is empty
  (INSERT OR IGNORE pattern)
- Set up node-cron schedules (use `require('node-cron')`):
  - `'0 6 * * *'` (06:00 IST) → this.runDailyFetch()
  - `'30 6 * * *'` (06:30 IST) → this.runPostRegen() [placeholder for Phase 4]
  - `'0 7 * * *'` (07:00 IST) → this.runAutofill()
- Mark enabled = true, status = 'ready'
- IMPORTANT: node-cron uses system timezone. If server is UTC, offset the
  cron expressions OR use config.TIMEZONE with `{ timezone: 'Asia/Kolkata' }`

### seedCities()
- Read data/fuel-cities.json
- INSERT OR IGNORE into fuel_cities table
- Log count of seeded cities

### runDailyFetch()
- Get all enabled cities: `SELECT * FROM fuel_cities WHERE is_enabled = 1`
- For each city that has an api3_city value, call fetchCityPrice(city)
- After batch: call deriveMissing() for cities with no price today
- Call flushCache() (delete any in-memory caches)
- Log summary

### fetchCityPrice(city)
- Call RapidAPI endpoint for petrol:
  ```
  GET https://fuel-petrol-diesel-live-price-india.p.rapidapi.com/petrol_price_india_city_value/
  Headers:
    x-rapidapi-host: fuel-petrol-diesel-live-price-india.p.rapidapi.com
    x-rapidapi-key: <from settings table, key = 'FUEL_RAPIDAPI_KEY'>
    Content-Type: application/json
    city: <api3_city name>
  ```
- Call same host for diesel: `/diesel_price_india_city_value/`
- Response shape: `{ "CityName": 104.23 }`
- Validate price is between 30 and 200
- Call upsertPrice(city_name, state, petrol, diesel, 'api3')
- 100ms delay between cities (use setTimeout promise)

### upsertPrice(city, state, petrol, diesel, source)
- Today = new Date().toISOString().slice(0, 10)
- Check if existing record: SELECT petrol, diesel FROM fuel_prices WHERE city = ? AND price_date = ?
- If exists with valid data, only fill missing fuel type (don't overwrite)
- INSERT OR REPLACE with COALESCE logic:
  ```sql
  INSERT INTO fuel_prices (city, state, petrol, diesel, price_date, source, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
  ON CONFLICT(city, price_date) DO UPDATE SET
    petrol = COALESCE(excluded.petrol, petrol),
    diesel = COALESCE(excluded.diesel, diesel),
    source = excluded.source,
    fetched_at = excluded.fetched_at
  ```

### deriveMissing()
- Find cities with has_post=1 but no price today
- For each, get state average: SELECT AVG(petrol), AVG(diesel) FROM fuel_prices
  WHERE state = ? AND price_date = ? AND petrol > 0
- Apply ±0.5% random variance: price * (1 + (Math.random() - 0.5) / 100)
- upsertPrice with source = 'derived'

### runAutofill()
- For last 7 days, find dates where cities have gaps
- Carry-forward: copy previous day's price for that city
- Log count filled

### getStateAverage(state)
- SELECT AVG(petrol) as petrol, AVG(diesel) as diesel FROM fuel_prices
  WHERE state = ? AND price_date = ? AND (petrol > 0 OR diesel > 0)

### getNationalAverage()
- Same but without state filter

### getCityHistory(city, days)
- SELECT price_date, petrol, diesel FROM fuel_prices
  WHERE city = ? AND price_date >= date('now', '-' || ? || ' days')
  ORDER BY price_date ASC

### getStateCitiesToday(state)
- SELECT fc.city_name, fp.petrol, fp.diesel FROM fuel_cities fc
  LEFT JOIN fuel_prices fp ON fc.city_name = fp.city AND fp.price_date = date('now')
  WHERE fc.state = ? AND fc.is_enabled = 1
  ORDER BY fc.city_name

### getTodaySummary()
- Return { total, fetched, missing, bySource: { api3, derived, manual } }

### getHealth() / shutdown() — standard pattern

### Export:
```js
module.exports = { FuelModule };
```

---

## PART 4 — Metals Module

FILE: `src/modules/metals.js` (NEW FILE)

Same class pattern as FuelModule.

### Constructor
- Same pattern, stats = { totalFetched: 0, lastFetchAt: null }

### init()
- Seed cities from data/metals-cities.json if metals_cities is empty
- node-cron schedules:
  - `'15 6 * * *'` (06:15 IST) → this.runDailyFetch()
  - `'30 7 * * *'` (07:30 IST) → this.runPostRegen() [placeholder]
  - `'0 7 * * *'` (07:00 IST) → this.runAutofill()

### seedCities()
- Read data/metals-cities.json, INSERT OR IGNORE into metals_cities

### runDailyFetch()
- For each metal in ['gold', 'silver', 'platinum']:
  - Call fetchBulk(metal)
- Log summary

### fetchBulk(metal)
- API endpoint mapping:
  - gold → GoldPriceTodayForCities
  - silver → SilverPriceTodayForCities
  - platinum → PlatinumPriceTodayForCities
- Call:
  ```
  GET https://gold-silver-platinum-price-in-india.p.rapidapi.com/{endpoint}
  Headers:
    x-rapidapi-host: gold-silver-platinum-price-in-india.p.rapidapi.com
    x-rapidapi-key: <from settings table, key = 'METALS_RAPIDAPI_KEY'>
  ```
- Response is an array of city objects with price_24carat, price_22carat,
  price_18carat, price (1g) fields
- For each city in response, call extractPrices() then upsertPrice()

### extractPrices(cityData)
- Read price_24k from: cityData.price_24carat || cityData.price_24k
- Read price_22k from: cityData.price_22carat || cityData.price_22k
- Read price_18k from: cityData.price_18carat || cityData.price_18k
- Read price_1g from: cityData.price || cityData.price_1g
- If have 24k but missing 22k: price_22k = round(price_24k * 22/24, 2)
- If have 24k but missing 18k: price_18k = round(price_24k * 18/24, 2)
- Return { price_24k, price_22k, price_18k, price_1g }

### upsertPrice(city, metal, date, prices, source)
```sql
INSERT INTO metals_prices (city, metal_type, price_24k, price_22k, price_18k, price_1g, price_date, source)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(city, metal_type, price_date) DO UPDATE SET
  price_24k = COALESCE(NULLIF(excluded.price_24k, 0), price_24k),
  price_22k = COALESCE(NULLIF(excluded.price_22k, 0), price_22k),
  price_18k = COALESCE(NULLIF(excluded.price_18k, 0), price_18k),
  price_1g  = COALESCE(NULLIF(excluded.price_1g, 0), price_1g),
  source = excluded.source,
  created_at = datetime('now')
```

### fetchHistorical(metal, days)
- Endpoint mapping:
  - gold → GoldHistoricalPrices
  - silver → SilverHistoricalPrices
  - platinum → PlatinumHistoricalPrices
- Query param: ?number_of_days=30
- Parse and upsert each day's data

### generateSyntheticHistory(city, metal, days)
- Get latest known price for this city+metal
- For each missing day in range, create a record with ±2% variance
- Tag source = 'synthetic'

### runAutofill()
- Call autofillMissingDates(7) — fill gaps for last 7 days
- For each city+metal combo missing a date, carry forward the nearest price

### getCityHistory(city, metal, days)
- SELECT price_date, price_24k, price_22k, price_18k, price_1g
  FROM metals_prices WHERE city=? AND metal_type=?
  AND price_date >= date('now', '-'||?||' days')
  ORDER BY price_date ASC

### getStateTrend(state, metal, days)
- SELECT price_date, AVG(price_24k) as avg_price FROM metals_prices mp
  INNER JOIN metals_cities mc ON mp.city = mc.city_name
  WHERE mc.state = ? AND mp.metal_type = ?
  GROUP BY price_date ORDER BY price_date ASC

### getNationalTrend(metal, days)
- Same without state filter

### getTodaySummary()
- Cities with data today, by metal, missing count

### getHealth() / shutdown()

### Export:
```js
module.exports = { MetalsModule };
```

---

## PART 5 — Wire Modules into index.js

FILE: `src/index.js`

1. Import at top:
```js
var { FuelModule } = require('./modules/fuel');
var { MetalsModule } = require('./modules/metals');
```

2. Instantiate after other modules (around line 175):
```js
var fuel = new FuelModule(frozenConfig, db, logger);
var metals = new MetalsModule(frozenConfig, db, logger);
```

3. Init after other modules but before firehose (around line 188):
```js
await fuel.init();
await metals.init();
```

4. Add to app.locals.modules (around line 201):
```js
app.locals.modules = {
  firehose, trends, buffer, similarity, extractor, rewriter,
  publisher, scheduler, infranodus, fuel, metals,
};
```

---

## PART 6 — API Routes

FILE: `src/routes/api.js`

Add these routes. Place them after the existing `/api/sources/stats` route.

### Settings routes (store/retrieve API keys)

The existing settings table already works for this. Users will set:
- `FUEL_RAPIDAPI_KEY` — stored in settings table
- `METALS_RAPIDAPI_KEY` — stored in settings table

Add these keys to the SENSITIVE_KEYS array in GET /api/settings (around line 534)
so they get masked in the frontend.

### Fuel routes

```js
// ─── FUEL MODULE ROUTES ─────────────────────────────────────────────────

// GET /api/fuel/summary — today's fetch stats
router.get('/fuel/summary', function (req, res) {
  try {
    var fuel = req.app.locals.modules.fuel;
    if (!fuel) return res.status(503).json({ error: 'Fuel module not loaded' });
    res.json(fuel.getTodaySummary());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fuel/cities — all cities with today's price
router.get('/fuel/cities', function (req, res) {
  try {
    var state = req.query.state || null;
    var sql = `
      SELECT fc.*, fp.petrol, fp.diesel, fp.price_date, fp.source
      FROM fuel_cities fc
      LEFT JOIN fuel_prices fp ON fc.city_name = fp.city AND fp.price_date = date('now')
      WHERE fc.is_enabled = 1
    `;
    var params = [];
    if (state) { sql += ' AND fc.state = ?'; params.push(state); }
    sql += ' ORDER BY fc.state, fc.city_name';
    res.json({ data: db.prepare(sql).all.apply(db.prepare(sql), params) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fuel/states — all states with avg prices today
router.get('/fuel/states', function (req, res) {
  try {
    var rows = db.prepare(`
      SELECT fc.state,
        COUNT(DISTINCT fc.city_name) as total_cities,
        COUNT(DISTINCT CASE WHEN fp.petrol > 0 THEN fc.city_name END) as fetched,
        ROUND(AVG(fp.petrol), 2) as avg_petrol,
        ROUND(AVG(fp.diesel), 2) as avg_diesel
      FROM fuel_cities fc
      LEFT JOIN fuel_prices fp ON fc.city_name = fp.city AND fp.price_date = date('now')
      WHERE fc.is_enabled = 1
      GROUP BY fc.state ORDER BY fc.state
    `).all();
    res.json({ data: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fuel/history?city=X&days=30
router.get('/fuel/history', function (req, res) {
  try {
    var city = req.query.city;
    var days = Math.min(parseInt(req.query.days) || 30, 365);
    if (!city) return res.status(400).json({ error: 'city required' });

    var fuel = req.app.locals.modules.fuel;
    var rows = fuel.getCityHistory(city, days);
    res.json({
      labels: rows.map(function(r) { return r.price_date; }),
      petrol: rows.map(function(r) { return r.petrol; }),
      diesel: rows.map(function(r) { return r.diesel; }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/fuel/fetch — trigger manual fetch (admin only)
router.post('/fuel/fetch', function (req, res) {
  try {
    var fuel = req.app.locals.modules.fuel;
    fuel.runDailyFetch().then(function(result) {
      res.json({ success: true, result: result });
    }).catch(function(err) {
      res.status(500).json({ error: err.message });
    });
    // Don't await — return immediately
    res.json({ success: true, message: 'Fetch started in background' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/fuel/compare?state=X — top 10 cities in state
router.get('/fuel/compare', function (req, res) {
  try {
    var state = req.query.state;
    if (!state) return res.status(400).json({ error: 'state required' });
    var fuel = req.app.locals.modules.fuel;
    var rows = fuel.getStateCitiesToday(state);
    res.json({ data: rows.slice(0, 10) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

### Metals routes (same pattern)

```js
// ─── METALS MODULE ROUTES ───────────────────────────────────────────────

router.get('/metals/summary', function (req, res) {
  try {
    var metals = req.app.locals.modules.metals;
    if (!metals) return res.status(503).json({ error: 'Metals module not loaded' });
    res.json(metals.getTodaySummary());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/metals/cities', function (req, res) {
  try {
    var metal = req.query.metal || 'gold';
    var state = req.query.state || null;
    var sql = `
      SELECT mc.city_name, mc.state, mp.price_24k, mp.price_22k, mp.price_18k,
             mp.price_1g, mp.price_date, mp.source
      FROM metals_cities mc
      LEFT JOIN metals_prices mp ON mc.city_name = mp.city
        AND mp.metal_type = ? AND mp.price_date = date('now')
      WHERE mc.is_active = 1
    `;
    var params = [metal];
    if (state) { sql += ' AND mc.state = ?'; params.push(state); }
    sql += ' ORDER BY mc.state, mc.city_name';
    res.json({ data: db.prepare(sql).all.apply(db.prepare(sql), params) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/metals/history', function (req, res) {
  try {
    var city = req.query.city;
    var metal = req.query.metal || 'gold';
    var days = Math.min(parseInt(req.query.days) || 30, 365);
    if (!city) return res.status(400).json({ error: 'city required' });

    var metals = req.app.locals.modules.metals;
    var rows = metals.getCityHistory(city, metal, days);
    res.json({
      city: city, metal: metal,
      labels: rows.map(function(r) { return r.price_date; }),
      price_24k: rows.map(function(r) { return r.price_24k; }),
      price_22k: rows.map(function(r) { return r.price_22k; }),
      price_18k: rows.map(function(r) { return r.price_18k; }),
      price_1g: rows.map(function(r) { return r.price_1g; }),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/metals/fetch', function (req, res) {
  try {
    var metals = req.app.locals.modules.metals;
    metals.runDailyFetch();
    res.json({ success: true, message: 'Metals fetch started in background' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

---

## PART 7 — Dashboard Pages (HTML)

FILE: `public/index.html`

### Nav links — add after the Sources nav link:

```html
<a href="#fuel" class="nav-link" data-page="fuel">
  ⛽ Fuel
</a>
<a href="#metals" class="nav-link" data-page="metals">
  🥇 Metals
</a>
```

### Fuel Page Section:

```html
<!-- ═══════════════════════════ FUEL PAGE ══════════════════════════ -->
<div id="page-fuel" class="page-section" style="display:none;">
  <div class="page-header">
    <h2>Fuel Price Tracker</h2>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-sm btn-purple" id="fuelFetchBtn" onclick="triggerFuelFetch()">⚡ Fetch All Prices</button>
      <button class="btn btn-sm btn-ghost" onclick="loadFuelPage()">↻ Refresh</button>
    </div>
  </div>

  <!-- Summary cards -->
  <div class="stats-grid" style="margin-bottom:20px;">
    <div class="stat-card"><div class="stat-value" id="fuel-total-cities">—</div><div class="stat-label">Total Cities</div></div>
    <div class="stat-card"><div class="stat-value" id="fuel-fetched-today">—</div><div class="stat-label">Fetched Today</div></div>
    <div class="stat-card"><div class="stat-value" id="fuel-missing-today">—</div><div class="stat-label">Missing</div></div>
    <div class="stat-card"><div class="stat-value" id="fuel-last-fetch">—</div><div class="stat-label">Last Fetch</div></div>
  </div>

  <!-- State-level overview + chart -->
  <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:20px;">
    <div class="card">
      <div class="card-title">National Average Trend (30d)</div>
      <canvas id="fuel-national-chart" height="220"></canvas>
    </div>
    <div class="card">
      <div class="card-title">States Overview</div>
      <div style="overflow-y:auto; max-height:300px;">
        <table class="data-table" id="fuel-states-table">
          <thead><tr><th>State</th><th>Cities</th><th>Fetched</th><th>Avg Petrol</th><th>Avg Diesel</th></tr></thead>
          <tbody id="fuel-states-tbody"><tr><td colspan="5" style="text-align:center;color:#888">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- City table with search -->
  <div class="card">
    <div class="card-title" style="display:flex;justify-content:space-between;align-items:center;">
      <span>All Cities — Today's Prices</span>
      <div style="display:flex;gap:8px;">
        <select id="fuel-state-filter" onchange="filterFuelCities()" style="padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:13px;">
          <option value="">All States</option>
        </select>
        <input type="text" id="fuel-city-search" placeholder="Search city..." oninput="filterFuelCities()"
          style="padding:4px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg2);color:var(--text);font-size:13px;width:180px;">
      </div>
    </div>
    <div style="overflow-x:auto;max-height:500px;overflow-y:auto;">
      <table class="data-table">
        <thead><tr><th>City</th><th>State</th><th>Petrol (₹)</th><th>Diesel (₹)</th><th>Source</th><th>Date</th></tr></thead>
        <tbody id="fuel-cities-tbody"><tr><td colspan="6" style="text-align:center;color:#888">Loading...</td></tr></tbody>
      </table>
    </div>
  </div>
</div>
```

### Metals Page Section:

```html
<!-- ═══════════════════════════ METALS PAGE ══════════════════════════ -->
<div id="page-metals" class="page-section" style="display:none;">
  <div class="page-header">
    <h2>Metals Price Tracker</h2>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-sm btn-purple" onclick="triggerMetalsFetch()">⚡ Fetch All Prices</button>
      <button class="btn btn-sm btn-ghost" onclick="loadMetalsPage()">↻ Refresh</button>
    </div>
  </div>

  <!-- Metal type selector -->
  <div style="display:flex;gap:8px;margin-bottom:16px;">
    <button class="btn btn-sm" id="metal-btn-gold" onclick="switchMetal('gold')" style="background:#f59e0b;color:#000;">Gold</button>
    <button class="btn btn-sm btn-ghost" id="metal-btn-silver" onclick="switchMetal('silver')">Silver</button>
    <button class="btn btn-sm btn-ghost" id="metal-btn-platinum" onclick="switchMetal('platinum')">Platinum</button>
  </div>

  <!-- Summary cards -->
  <div class="stats-grid" style="margin-bottom:20px;">
    <div class="stat-card"><div class="stat-value" id="metals-total-cities">—</div><div class="stat-label">Total Cities</div></div>
    <div class="stat-card"><div class="stat-value" id="metals-fetched-today">—</div><div class="stat-label">Fetched Today</div></div>
    <div class="stat-card"><div class="stat-value" id="metals-avg-price">—</div><div class="stat-label">National Avg (10g)</div></div>
    <div class="stat-card"><div class="stat-value" id="metals-last-fetch">—</div><div class="stat-label">Last Fetch</div></div>
  </div>

  <!-- Chart + top cities -->
  <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px; margin-bottom:20px;">
    <div class="card">
      <div class="card-title" id="metals-chart-title">Gold National Trend (30d)</div>
      <canvas id="metals-national-chart" height="220"></canvas>
    </div>
    <div class="card">
      <div class="card-title">Price by City</div>
      <div style="overflow-y:auto; max-height:300px;">
        <table class="data-table">
          <thead><tr><th>City</th><th>24K</th><th>22K</th><th>18K</th><th>1g</th></tr></thead>
          <tbody id="metals-cities-tbody"><tr><td colspan="5" style="text-align:center;color:#888">Loading...</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>
</div>
```

---

## PART 8 — Dashboard JavaScript

FILE: `public/js/dashboard.js`

Add near the bottom, alongside other load*Page functions.

### Fuel page JS:

```js
// ─── Fuel Page ──────────────────────────────────────────────────────────

var _fuelCitiesData = [];
var _fuelStatesData = [];

function loadFuelPage() {
  // Summary
  fetchApi('/api/fuel/summary').then(function(data) {
    var set = function(id, val) { var el = $(id); if (el) el.textContent = val; };
    set('fuel-total-cities', data.total || 0);
    set('fuel-fetched-today', data.fetched || 0);
    set('fuel-missing-today', data.missing || 0);
    set('fuel-last-fetch', data.lastFetchAt ? timeAgo(data.lastFetchAt) : 'Never');
  });

  // States table
  fetchApi('/api/fuel/states').then(function(data) {
    _fuelStatesData = data.data || [];
    var tbody = $('fuel-states-tbody');
    if (!tbody) return;
    // Populate state filter dropdown
    var sel = $('fuel-state-filter');
    if (sel && sel.options.length <= 1) {
      _fuelStatesData.forEach(function(s) {
        var o = document.createElement('option');
        o.value = s.state; o.textContent = s.state;
        sel.appendChild(o);
      });
    }
    tbody.innerHTML = _fuelStatesData.map(function(s) {
      return '<tr><td>' + escapeHtml(s.state) + '</td><td>' + s.total_cities +
        '</td><td style="color:#10b981">' + (s.fetched || 0) +
        '</td><td>₹' + (s.avg_petrol || '—') +
        '</td><td>₹' + (s.avg_diesel || '—') + '</td></tr>';
    }).join('');
  });

  // Cities table
  fetchApi('/api/fuel/cities').then(function(data) {
    _fuelCitiesData = data.data || [];
    renderFuelCities(_fuelCitiesData);
  });

  // National chart
  fetchApi('/api/fuel/history?city=India&days=30').then(function(data) {
    renderFuelNationalChart(data);
  }).catch(function() {});
}

function renderFuelCities(cities) {
  var tbody = $('fuel-cities-tbody');
  if (!tbody) return;
  if (!cities.length) { tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#888">No data</td></tr>'; return; }
  tbody.innerHTML = cities.map(function(c) {
    var pColor = c.petrol > 0 ? 'var(--text)' : '#ef4444';
    var dColor = c.diesel > 0 ? 'var(--text)' : '#ef4444';
    return '<tr><td><strong>' + escapeHtml(c.city_name) + '</strong></td>' +
      '<td>' + escapeHtml(c.state) + '</td>' +
      '<td style="color:' + pColor + '">' + (c.petrol ? '₹' + Number(c.petrol).toFixed(2) : '—') + '</td>' +
      '<td style="color:' + dColor + '">' + (c.diesel ? '₹' + Number(c.diesel).toFixed(2) : '—') + '</td>' +
      '<td><span style="font-size:11px;background:var(--bg3);padding:2px 6px;border-radius:4px;">' + (c.source || '—') + '</span></td>' +
      '<td style="font-size:12px;color:#888">' + (c.price_date || '—') + '</td></tr>';
  }).join('');
}

function filterFuelCities() {
  var state = ($('fuel-state-filter') || {}).value || '';
  var search = ($('fuel-city-search') || {}).value || '';
  var filtered = _fuelCitiesData.filter(function(c) {
    if (state && c.state !== state) return false;
    if (search && c.city_name.toLowerCase().indexOf(search.toLowerCase()) === -1) return false;
    return true;
  });
  renderFuelCities(filtered);
}

function renderFuelNationalChart(data) {
  var canvas = document.getElementById('fuel-national-chart');
  if (!canvas || !window.Chart) return;
  if (canvas._chartInstance) canvas._chartInstance.destroy();
  canvas._chartInstance = new Chart(canvas, {
    type: 'line',
    data: {
      labels: data.labels || [],
      datasets: [
        { label: 'Petrol', data: data.petrol || [], borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.1)', tension: 0.3, fill: true },
        { label: 'Diesel', data: data.diesel || [], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', tension: 0.3, fill: true },
      ]
    },
    options: {
      maintainAspectRatio: false,
      plugins: { legend: { position: 'top' } },
      scales: {
        x: { grid: { color: 'rgba(255,255,255,0.05)' } },
        y: { grid: { color: 'rgba(255,255,255,0.05)' } }
      }
    }
  });
}

function triggerFuelFetch() {
  var btn = $('fuelFetchBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Fetching...'; }
  fetchApi('/api/fuel/fetch', { method: 'POST' })
    .then(function() { showToast('Fuel fetch started', 'info'); })
    .catch(function(err) { showToast('Fetch failed: ' + err.message, 'error'); })
    .finally(function() {
      if (btn) { btn.disabled = false; btn.textContent = '⚡ Fetch All Prices'; }
    });
}
```

### Metals page JS:

```js
// ─── Metals Page ────────────────────────────────────────────────────────

var _currentMetal = 'gold';
var _metalsCitiesData = [];

function loadMetalsPage() {
  fetchMetalsData(_currentMetal);
}

function switchMetal(metal) {
  _currentMetal = metal;
  // Update button styles
  ['gold','silver','platinum'].forEach(function(m) {
    var btn = $('metal-btn-' + m);
    if (!btn) return;
    if (m === metal) {
      btn.style.background = m === 'gold' ? '#f59e0b' : m === 'silver' ? '#9ca3af' : '#a78bfa';
      btn.style.color = '#000';
      btn.className = 'btn btn-sm';
    } else {
      btn.style.background = '';
      btn.style.color = '';
      btn.className = 'btn btn-sm btn-ghost';
    }
  });
  fetchMetalsData(metal);
}

function fetchMetalsData(metal) {
  // Summary
  fetchApi('/api/metals/summary').then(function(data) {
    var set = function(id, val) { var el = $(id); if (el) el.textContent = val; };
    var metalData = data[metal] || data;
    set('metals-total-cities', metalData.total || data.total || 0);
    set('metals-fetched-today', metalData.fetched || data.fetched || 0);
    set('metals-avg-price', metalData.avgPrice ? '₹' + Number(metalData.avgPrice).toLocaleString() : '—');
    set('metals-last-fetch', data.lastFetchAt ? timeAgo(data.lastFetchAt) : 'Never');
  });

  // Cities
  fetchApi('/api/metals/cities?metal=' + metal).then(function(data) {
    _metalsCitiesData = data.data || [];
    var tbody = $('metals-cities-tbody');
    if (!tbody) return;
    if (!_metalsCitiesData.length) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#888">No data</td></tr>'; return; }
    tbody.innerHTML = _metalsCitiesData.filter(function(c) {
      return c.price_24k > 0 || c.price_1g > 0;
    }).slice(0, 50).map(function(c) {
      return '<tr><td><strong>' + escapeHtml(c.city_name) + '</strong></td>' +
        '<td>' + (c.price_24k ? '₹' + Number(c.price_24k).toLocaleString() : '—') + '</td>' +
        '<td>' + (c.price_22k ? '₹' + Number(c.price_22k).toLocaleString() : '—') + '</td>' +
        '<td>' + (c.price_18k ? '₹' + Number(c.price_18k).toLocaleString() : '—') + '</td>' +
        '<td>' + (c.price_1g ? '₹' + Number(c.price_1g).toFixed(2) : '—') + '</td></tr>';
    }).join('');
  });

  // Chart
  var chartTitle = $('metals-chart-title');
  if (chartTitle) chartTitle.textContent = metal.charAt(0).toUpperCase() + metal.slice(1) + ' National Trend (30d)';

  fetchApi('/api/metals/history?city=India&metal=' + metal + '&days=30').then(function(data) {
    var canvas = document.getElementById('metals-national-chart');
    if (!canvas || !window.Chart) return;
    if (canvas._chartInstance) canvas._chartInstance.destroy();
    var priceKey = metal === 'gold' ? 'price_24k' : 'price_1g';
    var label = metal === 'gold' ? '24K per 10g' : 'Per gram';
    var color = metal === 'gold' ? '#f59e0b' : metal === 'silver' ? '#9ca3af' : '#a78bfa';
    canvas._chartInstance = new Chart(canvas, {
      type: 'line',
      data: {
        labels: data.labels || [],
        datasets: [{
          label: label,
          data: data[priceKey] || [],
          borderColor: color,
          backgroundColor: color + '22',
          tension: 0.3, fill: true
        }]
      },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { position: 'top' } },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { grid: { color: 'rgba(255,255,255,0.05)' } }
        }
      }
    });
  }).catch(function() {});
}

function triggerMetalsFetch() {
  fetchApi('/api/metals/fetch', { method: 'POST' })
    .then(function() { showToast('Metals fetch started', 'info'); })
    .catch(function(err) { showToast('Fetch failed: ' + err.message, 'error'); });
}
```

### Page navigation hook

Find the existing nav click handler that switches pages (search for
`data-page` or the showPage/switchTab function). Add these cases:

```js
case 'fuel': loadFuelPage(); break;
case 'metals': loadMetalsPage(); break;
```

---

## PART 9 — Settings UI Updates

FILE: `public/index.html`

In the Settings page section (where API keys for Anthropic/OpenAI/OpenRouter
are configured), ADD two new key fields:

```html
<div class="setting-section">
  <h3>Fuel Price API (RapidAPI)</h3>
  <div class="setting-row">
    <label>RapidAPI Key</label>
    <input type="password" id="fuel-rapidapi-key" class="setting-input" placeholder="Your RapidAPI key for fuel prices">
    <button class="btn btn-sm btn-ghost" onclick="testFuelApi()">Ping</button>
    <span id="fuel-key-status" style="font-size:12px;"></span>
  </div>
</div>
<div class="setting-section">
  <h3>Metals Price API (RapidAPI)</h3>
  <div class="setting-row">
    <label>RapidAPI Key</label>
    <input type="password" id="metals-rapidapi-key" class="setting-input" placeholder="Your RapidAPI key for metals prices">
    <button class="btn btn-sm btn-ghost" onclick="testMetalsApi()">Ping</button>
    <span id="metals-key-status" style="font-size:12px;"></span>
  </div>
</div>
```

Wire the save/load for these keys into the existing loadAISettings() and
saveAISettings() functions (or create separate fuel/metals settings handlers).

---

## VERIFICATION

1. `node -c src/modules/fuel.js` — exits clean
2. `node -c src/modules/metals.js` — exits clean
3. `node -c src/utils/db.js` — exits clean
4. `node -c src/routes/api.js` — exits clean
5. Start the app. Check logs for:
   - "Fuel module ready, X cities seeded"
   - "Metals module ready, X cities seeded"
6. Hit GET /api/fuel/summary — returns { total, fetched, missing }
7. Hit GET /api/fuel/cities — returns array of cities with null prices (no fetch yet)
8. Hit GET /api/metals/summary — same pattern
9. Click "Fuel" in sidebar — page loads with stats cards, empty chart, city table
10. Click "Metals" in sidebar — page loads, gold/silver/platinum tabs work
11. Set FUEL_RAPIDAPI_KEY in settings, click "Fetch All Prices" — watch cities populate
12. Set METALS_RAPIDAPI_KEY in settings, click "Fetch All Prices" — watch metals populate

## CONSTRAINTS

- Use `var` style throughout (this codebase is pre-ES6 in dashboard.js)
- Use `const`/`let` in Node.js module files (fuel.js, metals.js) since the
  rest of the Node codebase already uses them (see firehose.js, buffer.js)
- No new npm dependencies needed — use built-in `fetch()` (Node 18+) for
  RapidAPI calls, `node-cron` is already in package.json
- Do NOT touch any existing modules, routes, or HTML sections
- Do NOT create WordPress posts yet (that's Phase 4-5)
- Chart.js is already loaded in the dashboard — no extra script tags needed
- Keep the same dark-themed styling as existing dashboard pages
