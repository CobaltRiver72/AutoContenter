# HDF AutoPub — Env Var Fallback + Resilient Fetch Prompt

> **Context:** Fuel & Metals modules read API keys ONLY from the SQLite settings table, ignoring env vars set in Hostinger. The config system already has a `get(key)` function (in `src/utils/config.js`) that checks: SQLite settings → frozen config → `process.env` → defaults. But fuel/metals modules bypass it. Also, the fetch pipeline should gracefully skip failing cities/states and continue with others.

---

## FIX 1 — Fuel & Metals: Use Config Fallback Chain for API Keys

### File: `src/modules/fuel.js`

**Replace `_getApiKey()` (around line 138):**

```js
_getApiKey() {
  // 1. Check settings table
  const row = this.db.prepare("SELECT value FROM settings WHERE key = 'FUEL_RAPIDAPI_KEY'").get();
  if (row && row.value) return row.value;
  // 2. Fallback to env var
  if (process.env.FUEL_RAPIDAPI_KEY) return process.env.FUEL_RAPIDAPI_KEY;
  return null;
}
```

### File: `src/modules/metals.js`

**Replace `_getApiKey()` (around line 120):**

```js
_getApiKey() {
  const row = this.db.prepare("SELECT value FROM settings WHERE key = 'METALS_RAPIDAPI_KEY'").get();
  if (row && row.value) return row.value;
  if (process.env.METALS_RAPIDAPI_KEY) return process.env.METALS_RAPIDAPI_KEY;
  return null;
}
```

### File: `src/modules/wp-publisher.js`

**In `init()` method, update how credentials are read:**

```js
async init() {
  // Helper: check settings table first, then env var
  const getSetting = (key) => {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    if (row && row.value) return row.value;
    return process.env[key] || null;
  };

  this.siteUrl = getSetting('WP_SITE_URL') || getSetting('WP_URL');  // support both key names
  this.username = getSetting('WP_USERNAME');
  this.appPassword = getSetting('WP_APP_PASSWORD');

  if (!this.siteUrl || !this.username || !this.appPassword) {
    this.logger.warn('wp-publisher', 'WordPress credentials incomplete. Set WP_SITE_URL, WP_USERNAME, WP_APP_PASSWORD in Settings or env vars.');
    this.ready = false;
    return;
  }

  // Strip trailing slash from site URL
  this.siteUrl = this.siteUrl.replace(/\/+$/, '');

  // Pre-load category cache
  try {
    await this._loadCategories();
    this.ready = true;
    this.logger.info('wp-publisher', 'WP Publisher ready for ' + this.siteUrl);
  } catch (err) {
    this.logger.warn('wp-publisher', 'Failed to connect to WordPress: ' + err.message);
    this.ready = false;
  }
}
```

**IMPORTANT:** The user's env var is `WP_URL` (not `WP_SITE_URL`). The code now checks both names.

---

## FIX 2 — Auto-Seed Settings from Env Vars on First Boot

### File: `src/utils/config.js`

Add a new function that seeds the settings table with env vars if they're not already set. Call this from `loadRuntimeOverrides()`:

**Add this function after `loadRuntimeOverrides()`:**

```js
/**
 * Seed settings table from environment variables (one-time on first boot).
 * Only writes if the key doesn't already exist in settings.
 */
function seedSettingsFromEnv(db) {
  var ENV_TO_SETTINGS = [
    'FUEL_RAPIDAPI_KEY',
    'METALS_RAPIDAPI_KEY',
    'WP_URL',
    'WP_SITE_URL',
    'WP_USERNAME',
    'WP_APP_PASSWORD',
    'WP_AUTHOR_ID',
    'WP_DEFAULT_CATEGORY',
    'WP_POST_STATUS',
    'ANTHROPIC_API_KEY',
    'OPENAI_API_KEY',
    'INFRANODUS_API_KEY',
    'JINA_API_KEY',
  ];

  var stmt = db.prepare(
    "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  );

  var seeded = [];
  for (var i = 0; i < ENV_TO_SETTINGS.length; i++) {
    var key = ENV_TO_SETTINGS[i];
    var val = process.env[key];
    if (val) {
      // Check if already in settings
      var existing = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      if (!existing) {
        stmt.run(key, val);
        seeded.push(key);
      }
    }
  }

  // Also seed WP_URL as WP_SITE_URL if WP_SITE_URL doesn't exist
  if (process.env.WP_URL && !db.prepare("SELECT value FROM settings WHERE key = 'WP_SITE_URL'").get()) {
    stmt.run('WP_SITE_URL', process.env.WP_URL);
    seeded.push('WP_SITE_URL (from WP_URL)');
  }

  if (seeded.length > 0) {
    console.log('[config] Seeded settings from env vars: ' + seeded.join(', '));
  }
}
```

**Call it inside `loadRuntimeOverrides(db)`, right after `_db = db;`:**

```js
function loadRuntimeOverrides(db) {
  try {
    _db = db;
    seedSettingsFromEnv(db);  // ← ADD THIS LINE
    var rows = db.prepare('SELECT key, value FROM settings').all();
    // ... rest of existing code
```

**Export it:**

```js
module.exports = { getConfig, get, set, loadRuntimeOverrides, seedSettingsFromEnv };
```

---

## FIX 3 — Resilient Fuel Fetch: Skip Failing Cities, Continue Others

### File: `src/modules/fuel.js`

**Replace `runDailyFetch()` (around line 146-186):**

```js
async runDailyFetch(isManual = false) {
  const startTime = Date.now();
  this.logger.info(MODULE, 'Starting daily fuel fetch...');
  const apiKey = this._getApiKey();
  if (!apiKey) {
    this.logger.warn(MODULE, 'No FUEL_RAPIDAPI_KEY set, skipping fetch');
    return { ok: 0, fail: 0, skipped: true };
  }

  const cities = this.db.prepare('SELECT * FROM fuel_cities WHERE is_enabled = 1 AND api3_city IS NOT NULL').all();
  if (cities.length === 0) {
    this.logger.warn(MODULE, 'No enabled cities with API mapping found. Check fuel_cities table.');
    return { ok: 0, fail: 0, total: 0, skipped: false };
  }

  let ok = 0;
  let fail = 0;
  let skipped = 0;
  const failedCities = [];
  const skippedCities = [];
  let consecutiveFails = 0;
  const MAX_CONSECUTIVE_FAILS = 10;  // If 10 in a row fail, likely API key/network issue

  // Group by state for organized fetching
  const byState = {};
  for (const city of cities) {
    if (!byState[city.state]) byState[city.state] = [];
    byState[city.state].push(city);
  }

  const states = Object.keys(byState).sort();
  this.logger.info(MODULE, 'Fetching ' + cities.length + ' cities across ' + states.length + ' states');

  for (const state of states) {
    const stateCities = byState[state];
    let stateOk = 0;
    let stateFail = 0;

    for (const city of stateCities) {
      // If too many consecutive failures, likely a systemic issue
      if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
        skipped++;
        skippedCities.push(city.city_name);
        continue;
      }

      try {
        await this.fetchCityPrice(city, apiKey);
        ok++;
        stateOk++;
        consecutiveFails = 0;  // Reset on success
      } catch (err) {
        fail++;
        stateFail++;
        consecutiveFails++;
        failedCities.push({ city: city.city_name, state: state, error: err.message });
        this.logger.warn(MODULE, 'Fetch failed: ' + city.city_name + ' (' + state + '): ' + err.message);

        // If API returns 401/403, stop immediately — key is invalid
        if (err.message.includes('401') || err.message.includes('403')) {
          this.logger.error(MODULE, 'API key rejected (401/403). Stopping fetch. Check FUEL_RAPIDAPI_KEY.');
          skipped = cities.length - ok - fail;
          break;
        }

        // If 429 (rate limit), wait longer before next request
        if (err.message.includes('429')) {
          this.logger.warn(MODULE, 'Rate limited (429). Waiting 5 seconds...');
          await new Promise(r => setTimeout(r, 5000));
        }
      }

      // Normal delay between cities (200ms to be safe)
      await new Promise(r => setTimeout(r, 200));
    }

    // If we broke out of inner loop (auth failure), break outer too
    if (consecutiveFails >= MAX_CONSECUTIVE_FAILS || failedCities.some(f => f.error.includes('401') || f.error.includes('403'))) {
      // Skip remaining states
      for (const remainingState of states.slice(states.indexOf(state) + 1)) {
        skipped += byState[remainingState].length;
      }
      break;
    }

    if (stateFail > 0) {
      this.logger.info(MODULE, '  ' + state + ': ' + stateOk + ' ok, ' + stateFail + ' fail');
    }
  }

  // If we got at least SOME skipped due to consecutive fails, log it
  if (skipped > 0) {
    this.logger.warn(MODULE, skipped + ' cities skipped due to consecutive failures');
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
      'INSERT INTO fetch_log (module, fetch_type, cities_ok, cities_fail, cities_skipped, duration_ms, details) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run('fuel', isManual ? 'manual' : 'scheduled', ok, fail, skipped, duration,
      JSON.stringify({
        failedCities: failedCities.slice(0, 30).map(f => f.city + ' (' + f.error.slice(0, 50) + ')'),
        skippedCount: skipped,
        stateCount: states.length,
      }));
  } catch (e) {
    this.logger.warn(MODULE, 'fetch_log insert failed: ' + e.message);
  }

  this.logger.info(MODULE, 'Daily fetch complete: ' + ok + ' ok, ' + fail + ' fail, ' + skipped + ' skipped out of ' + cities.length + ' (' + Math.round(duration/1000) + 's)');
  return { ok, fail, skipped, total: cities.length, duration };
}
```

---

## FIX 4 — Resilient Metals Fetch: Skip Failing Metals, Continue Others

### File: `src/modules/metals.js`

**Replace `runDailyFetch()` (around line 128-163):**

```js
async runDailyFetch(isManual = false) {
  const startTime = Date.now();
  this.logger.info(MODULE, 'Starting daily metals fetch...');
  const apiKey = this._getApiKey();
  if (!apiKey) {
    this.logger.warn(MODULE, 'No METALS_RAPIDAPI_KEY set, skipping fetch');
    return { skipped: true };
  }

  const results = {};
  const errors = {};
  let totalOk = 0;
  let totalFail = 0;

  for (const metal of ['gold', 'silver', 'platinum']) {
    try {
      const count = await this.fetchBulk(metal, apiKey);
      results[metal] = count;
      totalOk += count;
      this.logger.info(MODULE, '  ' + metal + ': ' + count + ' cities fetched');
    } catch (err) {
      this.logger.error(MODULE, 'fetchBulk(' + metal + ') failed: ' + err.message);
      results[metal] = 0;
      errors[metal] = err.message;
      totalFail++;

      // If 401/403, stop — key is invalid for all metals
      if (err.message.includes('401') || err.message.includes('403')) {
        this.logger.error(MODULE, 'API key rejected (401/403). Stopping. Check METALS_RAPIDAPI_KEY.');
        // Mark remaining metals as skipped
        for (const remaining of ['gold', 'silver', 'platinum']) {
          if (!results[remaining] && results[remaining] !== 0) {
            results[remaining] = 0;
            errors[remaining] = 'Skipped due to auth failure';
          }
        }
        break;
      }

      // If 429, wait before next metal
      if (err.message.includes('429')) {
        this.logger.warn(MODULE, 'Rate limited (429). Waiting 5 seconds...');
        await new Promise(r => setTimeout(r, 5000));
      }

      // Continue to next metal — don't let one failure stop the others
      continue;
    }

    // Small delay between metal types
    await new Promise(r => setTimeout(r, 500));
  }

  const duration = Date.now() - startTime;
  this.stats.lastFetchAt = new Date().toISOString();
  this.stats.totalFetched += totalOk;

  try {
    this.db.prepare(
      'INSERT INTO fetch_log (module, fetch_type, cities_ok, cities_fail, cities_skipped, duration_ms, details) VALUES (?, ?, ?, ?, 0, ?, ?)'
    ).run('metals', isManual ? 'manual' : 'scheduled', totalOk, totalFail, duration,
      JSON.stringify({
        perMetal: results,
        errors: Object.keys(errors).length > 0 ? errors : undefined,
      }));
  } catch (e) {
    this.logger.warn(MODULE, 'fetch_log insert failed: ' + e.message);
  }

  this.logger.info(MODULE, 'Daily metals fetch complete: ' + JSON.stringify(results) + ' (' + Math.round(duration/1000) + 's)');
  return results;
}
```

**Also add resilience inside `fetchBulk()` (around line 169) — add per-city error handling:**

In the `for (const cityData of data)` loop (around line 208-222), wrap the parse+upsert in try/catch:

```js
for (const cityData of data) {
  try {
    const apiName = cityData.city || cityData.City || cityData.city_name;
    if (!apiName) continue;

    const localRow = cityLookup.get(apiName.trim());
    if (!localRow) continue;
    const storeName = localRow.city_name;

    const prices = this.extractPrices(cityData);
    if (prices.price_24k || prices.price_1g) {
      this.upsertPrice(storeName, metal, today, prices, 'api1');
      count++;
    }
  } catch (e) {
    // Skip this city, continue with others
    this.logger.warn(MODULE, 'Failed to process city data for ' + metal + ': ' + e.message);
    continue;
  }
}
```

---

## FIX 5 — Add Timeout to Individual Fetch Calls

### File: `src/modules/fuel.js`

In `fetchCityPrice()`, add an AbortController timeout so a single slow city doesn't hang the whole pipeline:

```js
async fetchCityPrice(city, apiKey) {
  const host = 'fuel-petrol-diesel-live-price-india.p.rapidapi.com';
  const headers = {
    'x-rapidapi-host': host,
    'x-rapidapi-key': apiKey,
    'Content-Type': 'application/json',
    'city': city.api3_city,
  };

  // 15-second timeout per request
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  let petrol = null;
  let diesel = null;
  let errors = [];

  try {
    // Fetch petrol
    try {
      const pRes = await fetch('https://' + host + '/petrol_price_india_city_value/', {
        headers,
        signal: controller.signal,
      });
      if (!pRes.ok) {
        errors.push('Petrol API ' + pRes.status);
      } else {
        const pData = await pRes.json();
        const val = Object.values(pData)[0];
        if (typeof val === 'number' && val >= 30 && val <= 200) {
          petrol = val;
        } else {
          errors.push('Petrol invalid: ' + JSON.stringify(val));
        }
      }
    } catch (e) {
      errors.push('Petrol: ' + (e.name === 'AbortError' ? 'timeout 15s' : e.message));
    }

    // Fetch diesel
    try {
      const dRes = await fetch('https://' + host + '/diesel_price_india_city_value/', {
        headers,
        signal: controller.signal,
      });
      if (!dRes.ok) {
        errors.push('Diesel API ' + dRes.status);
      } else {
        const dData = await dRes.json();
        const val = Object.values(dData)[0];
        if (typeof val === 'number' && val >= 30 && val <= 200) {
          diesel = val;
        } else {
          errors.push('Diesel invalid: ' + JSON.stringify(val));
        }
      }
    } catch (e) {
      errors.push('Diesel: ' + (e.name === 'AbortError' ? 'timeout 15s' : e.message));
    }
  } finally {
    clearTimeout(timeout);
  }

  if (errors.length > 0) {
    this.logger.warn(MODULE, city.city_name + ': ' + errors.join('; '));
  }

  if (petrol !== null || diesel !== null) {
    this.upsertPrice(city.city_name, city.state, petrol, diesel, 'api3');
    return true;
  }

  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
  return false;
}
```

### File: `src/modules/metals.js`

Add timeout to `fetchBulk()` (around line 179):

```js
// Add timeout: 30 seconds for bulk call (returns 134 cities)
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30000);

try {
  const res = await fetch('https://' + host + '/' + endpoint, {
    headers: {
      'x-rapidapi-host': host,
      'x-rapidapi-key': apiKey,
    },
    signal: controller.signal,
  });
  // ... rest of existing parsing code
} finally {
  clearTimeout(timeout);
}
```

---

## FIX 6 — Update Diagnostics Endpoint

### File: `src/routes/api.js`

In the `GET /api/diagnostics` endpoint, update the fuel API key check to also report env var fallback:

```js
// Fuel API key — check both settings and env
var fuelKeyDb = db.prepare("SELECT value FROM settings WHERE key = 'FUEL_RAPIDAPI_KEY'").get();
var fuelKeyEnv = process.env.FUEL_RAPIDAPI_KEY;
var fuelKey = (fuelKeyDb && fuelKeyDb.value) || fuelKeyEnv;
checks.push({
  name: 'Fuel API Key',
  ok: !!fuelKey,
  detail: fuelKeyDb && fuelKeyDb.value
    ? 'From settings (' + fuelKeyDb.value.length + ' chars)'
    : fuelKeyEnv
      ? 'From env var (' + fuelKeyEnv.length + ' chars)'
      : 'NOT SET anywhere'
});

// Same pattern for metals
var metalsKeyDb = db.prepare("SELECT value FROM settings WHERE key = 'METALS_RAPIDAPI_KEY'").get();
var metalsKeyEnv = process.env.METALS_RAPIDAPI_KEY;
var metalsKey = (metalsKeyDb && metalsKeyDb.value) || metalsKeyEnv;
checks.push({
  name: 'Metals API Key',
  ok: !!metalsKey,
  detail: metalsKeyDb && metalsKeyDb.value
    ? 'From settings (' + metalsKeyDb.value.length + ' chars)'
    : metalsKeyEnv
      ? 'From env var (' + metalsKeyEnv.length + ' chars)'
      : 'NOT SET anywhere'
});

// WP credentials — check both WP_SITE_URL and WP_URL
var wpUrlDb = db.prepare("SELECT value FROM settings WHERE key = 'WP_SITE_URL'").get();
var wpUrlEnv = process.env.WP_SITE_URL || process.env.WP_URL;
var wpUrl = (wpUrlDb && wpUrlDb.value) || wpUrlEnv;
checks.push({
  name: 'WP Site URL',
  ok: !!wpUrl,
  detail: wpUrl || 'NOT SET (need WP_SITE_URL or WP_URL)'
});
```

---

## MISSING ENV VARS — Add These to Hostinger

| Variable | Value | Why |
|----------|-------|-----|
| `NODE_ENV` | `production` | Enables HTTPS redirect, disables verbose logging |
| `PORT` | `3000` (or whatever Hostinger assigns) | Required in REQUIRED_VARS list — app warns without it |
| `OPENAI_API_KEY` | Your OpenAI key (if using fallback) | Required in REQUIRED_VARS — needed for AI fallback |

**Note:** `OPENAI_API_KEY` is in the `REQUIRED_VARS` array. If you don't have one, the app logs a warning on every boot. Either add the key or remove it from REQUIRED_VARS if you only use Anthropic.

---

## SUMMARY OF CHANGES

| Fix | What | Impact |
|-----|------|--------|
| **#1** | `_getApiKey()` falls back to `process.env` | Env vars work without saving in dashboard |
| **#2** | WP Publisher checks both `WP_SITE_URL` and `WP_URL` | Matches your Hostinger env var name |
| **#3** | Auto-seed settings table from env vars on first boot | Settings page shows pre-filled values |
| **#4** | Fuel fetch: per-city resilience, consecutive-fail detection, 429 backoff, 401/403 abort | Failing cities skip, others continue |
| **#5** | Metals fetch: per-metal resilience, same error handling | One metal failing doesn't block others |
| **#6** | 15s timeout on fuel per-city, 30s on metals bulk | Slow/hung requests don't block pipeline |
| **#7** | Diagnostics shows env var fallback source | Clear visibility of where keys come from |
