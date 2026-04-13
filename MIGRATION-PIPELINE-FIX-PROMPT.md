# HDF AutoPub — Pipeline Fix Prompt
## Fix Fetch Pipelines + Per-City Fetch Buttons + Error Visibility

> **Context:** Fuel & Metals dashboards show 136/696 cities seeded but 0 fetched, "Never" last fetch. Root cause: multiple bugs in the fetch pipeline — wrong ping endpoint, fire-and-forget API routes, silent error swallowing, and no UI refresh. This prompt fixes ALL of them and adds per-city manual fetch.

---

## BUG 1 — CRITICAL: Fuel Ping Uses Wrong RapidAPI Host

**File:** `src/routes/api.js`

**Problem:** The `GET /api/fuel/ping-api` endpoint (around line 817) tests the API key against a DIFFERENT RapidAPI host than what `fetchCityPrice()` actually uses.

- **Ping uses:** `daily-petrol-diesel-lpg-cng-fuel-prices-in-india.p.rapidapi.com` with path `/v1/petrol/state/delhi`
- **Actual fetch uses:** `fuel-petrol-diesel-live-price-india.p.rapidapi.com` with path `/petrol_price_india_city_value/`

These are two different APIs. The ping can succeed while the actual fetch fails with 401/403.

**Fix:** Change the ping endpoint to match the ACTUAL fetch API:

```js
// In GET /api/fuel/ping-api (around line 817)
// REPLACE this:
var host = 'daily-petrol-diesel-lpg-cng-fuel-prices-in-india.p.rapidapi.com';
try {
  var r = await fetch('https://' + host + '/v1/petrol/state/delhi', {
    headers: { 'x-rapidapi-host': host, 'x-rapidapi-key': apiKey },
  });

// WITH this:
var host = 'fuel-petrol-diesel-live-price-india.p.rapidapi.com';
try {
  var r = await fetch('https://' + host + '/petrol_price_india_city_value/', {
    headers: {
      'x-rapidapi-host': host,
      'x-rapidapi-key': apiKey,
      'Content-Type': 'application/json',
      'city': 'delhi',
    },
  });
```

This way the ping tests the EXACT same host + path + headers that the real fetch uses.

---

## BUG 2 — CRITICAL: Fire-and-Forget Fetch Routes

**File:** `src/routes/api.js`

**Problem:** Both `POST /api/fuel/fetch` (line 714) and `POST /api/metals/fetch` (line 794) call `runDailyFetch()` without awaiting. They respond with `{ success: true }` IMMEDIATELY before the fetch even starts. Errors are silently caught and logged but the client never knows.

**Fix — Fuel route (line 714):**

Replace the entire `POST /api/fuel/fetch` handler:

```js
router.post('/fuel/fetch', async function (req, res) {
  try {
    var fuel = req.app.locals.modules.fuel;
    if (!fuel) return res.status(503).json({ error: 'Fuel module not loaded' });

    var result = await fuel.runDailyFetch(true);
    if (result.skipped) {
      return res.json({ success: false, error: 'No FUEL_RAPIDAPI_KEY set. Add it in Settings first.' });
    }
    res.json({
      success: true,
      message: 'Fetch completed: ' + result.ok + ' OK, ' + result.fail + ' failed out of ' + result.total,
      result: result,
    });
  } catch (err) {
    logger.error('api', 'Fuel fetch failed: ' + err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
```

**Fix — Metals route (line 794):**

Replace the entire `POST /api/metals/fetch` handler:

```js
router.post('/metals/fetch', async function (req, res) {
  try {
    var metals = req.app.locals.modules.metals;
    if (!metals) return res.status(503).json({ error: 'Metals module not loaded' });

    var result = await metals.runDailyFetch(true);
    if (result.skipped) {
      return res.json({ success: false, error: 'No METALS_RAPIDAPI_KEY set. Add it in Settings first.' });
    }
    res.json({
      success: true,
      message: 'Metals fetch completed: ' + JSON.stringify(result),
      result: result,
    });
  } catch (err) {
    logger.error('api', 'Metals fetch failed: ' + err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
```

---

## BUG 3 — HIGH: Silent Error Swallowing in fetchCityPrice()

**File:** `src/modules/fuel.js`

**Problem:** Lines 205-222 have `catch (e) { /* skip */ }` — when the API returns 401, 403, 429, or any error, the code silently does nothing. No error is thrown, no log is recorded. The city appears to have been processed successfully but with no data.

**Fix:** Replace the `fetchCityPrice()` method (around line 192-227):

```js
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
  let errors = [];

  // Fetch petrol
  try {
    const pRes = await fetch('https://' + host + '/petrol_price_india_city_value/', { headers });
    if (!pRes.ok) {
      errors.push('Petrol API returned ' + pRes.status);
    } else {
      const pData = await pRes.json();
      const val = Object.values(pData)[0];
      if (typeof val === 'number' && val >= 30 && val <= 200) {
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
      if (typeof val === 'number' && val >= 30 && val <= 200) {
        diesel = val;
      } else {
        errors.push('Diesel: invalid value ' + JSON.stringify(val));
      }
    }
  } catch (e) {
    errors.push('Diesel fetch error: ' + e.message);
  }

  // Log errors if any
  if (errors.length > 0) {
    this.logger.warn(MODULE, city.city_name + ': ' + errors.join('; '));
  }

  if (petrol !== null || diesel !== null) {
    this.upsertPrice(city.city_name, city.state, petrol, diesel, 'api3');
    return true;
  }

  // If BOTH failed, throw so runDailyFetch() counts it as a failure
  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
  return false;
}
```

---

## BUG 4 — HIGH: Dashboard Never Refreshes After Fetch

**File:** `public/js/dashboard.js`

**Problem:** `triggerFuelFetch()` and `triggerMetalsFetch()` call the fetch endpoint but never reload the page data. User sees "0 fetched" forever.

**Fix — triggerFuelFetch() (around line 5236):**

Replace entirely:

```js
async function triggerFuelFetch() {
  var btn = document.getElementById('fuelFetchBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Fetching...'; }
  try {
    var res = await fetch('/api/fuel/fetch', { method: 'POST' });
    var data = await res.json();
    if (data.success) {
      showToast('✅ ' + data.message, 'success');
    } else {
      showToast('❌ ' + (data.error || 'Fetch failed'), 'error');
    }
  } catch (err) {
    showToast('❌ Error: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Fetch All Prices'; }
    // REFRESH the page data
    loadFuelPage();
  }
}
```

**Fix — triggerMetalsFetch() (around line 5336):**

Replace entirely:

```js
async function triggerMetalsFetch() {
  var btn = event && event.target;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Fetching...'; }
  try {
    var res = await fetch('/api/metals/fetch', { method: 'POST' });
    var data = await res.json();
    if (data.success) {
      showToast('✅ ' + data.message, 'success');
    } else {
      showToast('❌ ' + (data.error || 'Fetch failed'), 'error');
    }
  } catch (err) {
    showToast('❌ Error: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡ Fetch All Prices'; }
    // REFRESH the page data
    loadMetalsPage();
  }
}
```

---

## BUG 5 — MEDIUM: metals_cities "Active" Column Shows Red X for All

**File:** Check the metals cities API endpoint

**Possible cause:** The cities API LEFT JOINs to metals_prices. If no prices exist yet, the `is_active` field might not be coming through, or the dashboard JS renders `undefined` as inactive.

**Fix in api.js — `GET /api/metals/cities` (around line 751):**

Make sure the SELECT includes `mc.is_active`:

```sql
SELECT mc.city_name, mc.state, mc.is_active,
       mp.price_24k, mp.price_22k, mp.price_18k,
       mp.price_1g, mp.price_date, mp.source
FROM metals_cities mc
LEFT JOIN metals_prices mp ON mc.city_name = mp.city
  AND mp.metal_type = ? AND mp.price_date = date('now')
WHERE mc.is_active = 1
ORDER BY mc.state, mc.city_name
```

**Fix in dashboard.js** — wherever the metals cities table is rendered, check `is_active` properly:

```js
// When rendering the Active column:
var activeHtml = row.is_active === 1 || row.is_active === true
  ? '<span class="text-green">✓</span>'
  : '<span class="text-red">✗</span>';
```

**Also fix the same for fuel cities** — ensure `is_enabled` is included in the fuel cities query and rendered properly.

---

## FEATURE 1 — Per-City Manual Fetch Buttons

### 1A. New API Endpoints

**File:** `src/routes/api.js`

```js
// POST /api/fuel/fetch-city — Fetch a single city's fuel prices
router.post('/fuel/fetch-city', async function (req, res) {
  try {
    var fuel = req.app.locals.modules.fuel;
    if (!fuel) return res.status(503).json({ error: 'Fuel module not loaded' });

    var { city_name, state } = req.body;
    if (!city_name) return res.status(400).json({ error: 'city_name required' });

    var apiKey = fuel._getApiKey();
    if (!apiKey) return res.json({ success: false, error: 'No FUEL_RAPIDAPI_KEY set' });

    var cityRow = fuel.db.prepare(
      'SELECT * FROM fuel_cities WHERE city_name = ? AND is_enabled = 1'
    ).get(city_name);

    if (!cityRow) return res.json({ success: false, error: 'City not found or disabled: ' + city_name });
    if (!cityRow.api3_city) return res.json({ success: false, error: city_name + ' has no API mapping (api3_city is null)' });

    await fuel.fetchCityPrice(cityRow, apiKey);

    // Read back the price we just inserted
    var price = fuel.db.prepare(
      'SELECT * FROM fuel_prices WHERE city = ? AND price_date = date("now") ORDER BY id DESC LIMIT 1'
    ).get(city_name);

    res.json({
      success: true,
      message: 'Fetched ' + city_name,
      price: price || null,
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// POST /api/metals/fetch-city — Fetch metals for a single city
router.post('/metals/fetch-city', async function (req, res) {
  try {
    var metals = req.app.locals.modules.metals;
    if (!metals) return res.status(503).json({ error: 'Metals module not loaded' });

    var { city_name, metal } = req.body;
    if (!city_name) return res.status(400).json({ error: 'city_name required' });

    var apiKey = metals._getApiKey();
    if (!apiKey) return res.json({ success: false, error: 'No METALS_RAPIDAPI_KEY set' });

    // Metals API is bulk (returns all cities at once), so we fetch bulk then filter
    var metalTypes = metal ? [metal] : ['gold', 'silver', 'platinum'];
    var results = {};
    for (var m of metalTypes) {
      try {
        var count = await metals.fetchBulk(m, apiKey);
        results[m] = count;
      } catch (e) {
        results[m] = { error: e.message };
      }
    }

    // Read back the prices for this city
    var prices = metals.db.prepare(
      'SELECT * FROM metals_prices WHERE city = ? AND price_date = date("now")'
    ).all(city_name);

    res.json({
      success: true,
      message: 'Fetched metals for ' + city_name,
      results: results,
      prices: prices,
    });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});
```

### 1B. Dashboard JS — Per-City Fetch Functions

**File:** `public/js/dashboard.js`

```js
async function fetchSingleFuelCity(cityName) {
  var btn = event && event.target;
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  try {
    var res = await fetch('/api/fuel/fetch-city', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city_name: cityName }),
    });
    var data = await res.json();
    if (data.success) {
      showToast('✅ ' + cityName + ': ₹' + (data.price ? data.price.petrol : '—') + ' / ₹' + (data.price ? data.price.diesel : '—'), 'success');
      loadFuelPage(); // refresh table
    } else {
      showToast('❌ ' + cityName + ': ' + data.error, 'error');
    }
  } catch (e) {
    showToast('❌ ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡'; }
  }
}

async function fetchSingleMetalsCity(cityName) {
  var btn = event && event.target;
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  try {
    var res = await fetch('/api/metals/fetch-city', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city_name: cityName }),
    });
    var data = await res.json();
    if (data.success) {
      showToast('✅ Metals fetched for ' + cityName, 'success');
      loadMetalsPage(); // refresh
    } else {
      showToast('❌ ' + cityName + ': ' + data.error, 'error');
    }
  } catch (e) {
    showToast('❌ ' + e.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⚡'; }
  }
}
```

### 1C. Add Fetch Button to City Table Rows

**File:** `public/js/dashboard.js`

Wherever the fuel cities table rows are rendered (the function that builds `fuel-cities-tbody`), add a fetch button in the Actions column:

```js
// In the Actions column for each fuel city row:
'<button class="btn-icon" onclick="fetchSingleFuelCity(\'' + esc(row.city_name) + '\')" title="Fetch this city">⚡</button>'
```

Same for metals cities table:
```js
'<button class="btn-icon" onclick="fetchSingleMetalsCity(\'' + esc(row.city_name) + '\')" title="Fetch this city">⚡</button>'
```

---

## FEATURE 2 — Better Error Visibility in Overview Tab

### 2A. Show Last Fetch Result in Summary Cards

**File:** `src/modules/fuel.js`

Update `getTodaySummary()` to include the last fetch result from `fetch_log`:

```js
getTodaySummary() {
  const today = new Date().toISOString().slice(0, 10);
  const total = this.db.prepare('SELECT COUNT(*) AS c FROM fuel_cities WHERE is_enabled = 1').get().c;
  const fetched = this.db.prepare('SELECT COUNT(*) AS c FROM fuel_prices WHERE price_date = ?').get(today).c;

  // Get source breakdown
  const sources = this.db.prepare(
    'SELECT source, COUNT(*) AS c FROM fuel_prices WHERE price_date = ? GROUP BY source'
  ).all(today);
  const bySource = {};
  for (const s of sources) bySource[s.source] = s.c;

  // Get last fetch from log
  const lastFetch = this.db.prepare(
    'SELECT * FROM fetch_log WHERE module = ? ORDER BY created_at DESC LIMIT 1'
  ).get('fuel');

  return {
    total,
    fetched,
    missing: Math.max(0, total - fetched),
    bySource,
    lastFetchAt: this.stats.lastFetchAt,
    lastFetchResult: lastFetch ? {
      type: lastFetch.fetch_type,
      ok: lastFetch.cities_ok,
      fail: lastFetch.cities_fail,
      duration: lastFetch.duration_ms,
      time: lastFetch.created_at,
      details: lastFetch.details ? JSON.parse(lastFetch.details) : null,
    } : null,
  };
}
```

**Same pattern for `src/modules/metals.js` `getTodaySummary()`.**

### 2B. Show Last Fetch Error in Dashboard

**File:** `public/js/dashboard.js`

In the fuel overview tab rendering (inside `loadFuelPage()`), after setting summary cards, add:

```js
// Show last fetch result detail
var lfr = data.lastFetchResult;
if (lfr) {
  var lfrHtml = '<div class="mini-panel">';
  lfrHtml += '<strong>Last Fetch:</strong> ' + timeAgo(lfr.time) + ' (' + lfr.type + ')';
  lfrHtml += ' — <span class="text-green">' + lfr.ok + ' OK</span>';
  if (lfr.fail > 0) {
    lfrHtml += ', <span class="text-red">' + lfr.fail + ' failed</span>';
    if (lfr.details && lfr.details.failedCities) {
      lfrHtml += '<br><span class="text-sm text-muted">Failed: ' + lfr.details.failedCities.join(', ') + '</span>';
    }
  }
  lfrHtml += '</div>';
  // Insert below the summary cards
  var target = document.getElementById('fuel-last-fetch-detail');
  if (target) target.innerHTML = lfrHtml;
}
```

**Add the target div in HTML** (inside fuel overview tab, after the stat cards row):
```html
<div id="fuel-last-fetch-detail" class="mt-2"></div>
```

Same for metals: `<div id="metals-last-fetch-detail" class="mt-2"></div>`

---

## FEATURE 3 — API Key Status Indicator on Dashboard

**File:** `public/js/dashboard.js`

In `loadFuelPage()`, check if the API key is configured:

```js
// At the start of loadFuelPage():
try {
  var settingsRes = await fetch('/api/settings');
  var settings = await settingsRes.json();
  var hasFuelKey = settings.FUEL_RAPIDAPI_KEY && settings.FUEL_RAPIDAPI_KEY !== '';
  var fuelKeyEl = document.getElementById('fuel-api-key-status');
  if (fuelKeyEl) {
    fuelKeyEl.innerHTML = hasFuelKey
      ? '<span class="text-green text-sm">🔑 API key configured</span>'
      : '<span class="text-red text-sm">⚠️ No API key — <a href="#" onclick="showPage(\'settings\')">Set it in Settings</a></span>';
  }
} catch(e) {}
```

**Add the status element in HTML** (in fuel page header area):
```html
<div id="fuel-api-key-status" class="mt-1"></div>
```

Same for metals: `<div id="metals-api-key-status" class="mt-1"></div>`

---

## FEATURE 4 — "Fetch First 5" Quick Test Button

Add a button that fetches just 5 cities (quick validation that the pipeline works):

### 4A. API Route

**File:** `src/routes/api.js`

```js
// POST /api/fuel/fetch-test — Fetch only top 5 cities as a quick test
router.post('/fuel/fetch-test', async function (req, res) {
  try {
    var fuel = req.app.locals.modules.fuel;
    if (!fuel) return res.status(503).json({ error: 'Fuel module not loaded' });

    var apiKey = fuel._getApiKey();
    if (!apiKey) return res.json({ success: false, error: 'No FUEL_RAPIDAPI_KEY set. Add it in Settings first.' });

    var cities = fuel.db.prepare(
      'SELECT * FROM fuel_cities WHERE is_enabled = 1 AND api3_city IS NOT NULL AND is_top_city = 1 LIMIT 5'
    ).all();

    if (cities.length === 0) {
      // Fallback: grab any 5 with api3_city
      cities = fuel.db.prepare(
        'SELECT * FROM fuel_cities WHERE is_enabled = 1 AND api3_city IS NOT NULL LIMIT 5'
      ).all();
    }

    var results = [];
    for (var city of cities) {
      try {
        await fuel.fetchCityPrice(city, apiKey);
        var price = fuel.db.prepare(
          'SELECT petrol, diesel FROM fuel_prices WHERE city = ? AND price_date = date("now")'
        ).get(city.city_name);
        results.push({ city: city.city_name, ok: true, petrol: price ? price.petrol : null, diesel: price ? price.diesel : null });
      } catch (e) {
        results.push({ city: city.city_name, ok: false, error: e.message });
      }
    }

    fuel.stats.lastFetchAt = new Date().toISOString();
    res.json({ success: true, results: results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/metals/fetch-test — Quick test: fetch one bulk call
router.post('/metals/fetch-test', async function (req, res) {
  try {
    var metals = req.app.locals.modules.metals;
    if (!metals) return res.status(503).json({ error: 'Metals module not loaded' });

    var apiKey = metals._getApiKey();
    if (!apiKey) return res.json({ success: false, error: 'No METALS_RAPIDAPI_KEY set. Add it in Settings first.' });

    // Just fetch gold as a test
    var count = await metals.fetchBulk('gold', apiKey);
    metals.stats.lastFetchAt = new Date().toISOString();

    // Get a sample of results
    var sample = metals.db.prepare(
      'SELECT city, price_24k, price_22k FROM metals_prices WHERE metal_type = ? AND price_date = date("now") LIMIT 5'
    ).all('gold');

    res.json({ success: true, message: count + ' gold prices fetched', sample: sample });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
```

### 4B. Dashboard Buttons

**File:** `public/index.html`

In the Fuel page header (next to existing buttons), add:
```html
<button class="btn btn-outline" onclick="testFuelFetch()">🧪 Test Fetch (5 cities)</button>
```

In the Metals page header:
```html
<button class="btn btn-outline" onclick="testMetalsFetch()">🧪 Test Fetch (Gold)</button>
```

### 4C. Dashboard JS

**File:** `public/js/dashboard.js`

```js
async function testFuelFetch() {
  var btn = event.target;
  btn.disabled = true; btn.textContent = '🧪 Testing...';
  try {
    var res = await fetch('/api/fuel/fetch-test', { method: 'POST' });
    var data = await res.json();
    if (data.success) {
      var msg = data.results.map(function(r) {
        return r.city + ': ' + (r.ok ? '₹' + r.petrol + '/' + r.diesel : '❌ ' + r.error);
      }).join('\n');
      showToast('Test results:\n' + msg, 'success');
      loadFuelPage();
    } else {
      showToast('❌ ' + data.error, 'error');
    }
  } catch(e) { showToast('❌ ' + e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = '🧪 Test Fetch (5 cities)'; }
}

async function testMetalsFetch() {
  var btn = event.target;
  btn.disabled = true; btn.textContent = '🧪 Testing...';
  try {
    var res = await fetch('/api/metals/fetch-test', { method: 'POST' });
    var data = await res.json();
    if (data.success) {
      var msg = data.message;
      if (data.sample && data.sample.length > 0) {
        msg += '\nSample: ' + data.sample.map(function(s) { return s.city + ' ₹' + s.price_24k; }).join(', ');
      }
      showToast('✅ ' + msg, 'success');
      loadMetalsPage();
    } else {
      showToast('❌ ' + data.error, 'error');
    }
  } catch(e) { showToast('❌ ' + e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = '🧪 Test Fetch (Gold)'; }
}
```

---

## FEATURE 5 — Diagnostic Endpoint

Add a one-shot diagnostic endpoint that checks EVERYTHING:

**File:** `src/routes/api.js`

```js
// GET /api/diagnostics — Check all pipeline requirements
router.get('/api/diagnostics', function (req, res) {
  var checks = [];
  var db = req.app.locals.db || req.app.locals.modules.fuel?.db;

  // 1. Fuel API key
  var fuelKey = db.prepare("SELECT value FROM settings WHERE key = 'FUEL_RAPIDAPI_KEY'").get();
  checks.push({ name: 'Fuel API Key', ok: !!(fuelKey && fuelKey.value), detail: fuelKey ? 'Set (' + fuelKey.value.length + ' chars)' : 'NOT SET' });

  // 2. Metals API key
  var metalsKey = db.prepare("SELECT value FROM settings WHERE key = 'METALS_RAPIDAPI_KEY'").get();
  checks.push({ name: 'Metals API Key', ok: !!(metalsKey && metalsKey.value), detail: metalsKey ? 'Set (' + metalsKey.value.length + ' chars)' : 'NOT SET' });

  // 3. Fuel cities seeded
  var fuelCities = db.prepare('SELECT COUNT(*) AS c FROM fuel_cities').get().c;
  checks.push({ name: 'Fuel Cities Seeded', ok: fuelCities > 0, detail: fuelCities + ' cities' });

  // 4. Fuel cities with API mapping
  var fuelApi3 = db.prepare('SELECT COUNT(*) AS c FROM fuel_cities WHERE api3_city IS NOT NULL').get().c;
  checks.push({ name: 'Fuel Cities with API Mapping', ok: fuelApi3 > 0, detail: fuelApi3 + ' of ' + fuelCities + ' have api3_city' });

  // 5. Metals cities seeded
  var metalsCities = db.prepare('SELECT COUNT(*) AS c FROM metals_cities').get().c;
  checks.push({ name: 'Metals Cities Seeded', ok: metalsCities > 0, detail: metalsCities + ' cities' });

  // 6. Fuel prices today
  var fuelToday = db.prepare("SELECT COUNT(*) AS c FROM fuel_prices WHERE price_date = date('now')").get().c;
  checks.push({ name: 'Fuel Prices Today', ok: fuelToday > 0, detail: fuelToday + ' rows' });

  // 7. Metals prices today
  var metalsToday = db.prepare("SELECT COUNT(*) AS c FROM metals_prices WHERE price_date = date('now')").get().c;
  checks.push({ name: 'Metals Prices Today', ok: metalsToday > 0, detail: metalsToday + ' rows' });

  // 8. WP credentials
  var wpUrl = db.prepare("SELECT value FROM settings WHERE key = 'WP_SITE_URL'").get();
  var wpUser = db.prepare("SELECT value FROM settings WHERE key = 'WP_USERNAME'").get();
  var wpPass = db.prepare("SELECT value FROM settings WHERE key = 'WP_APP_PASSWORD'").get();
  checks.push({ name: 'WP Credentials', ok: !!(wpUrl && wpUser && wpPass && wpUrl.value), detail: wpUrl ? wpUrl.value : 'NOT SET' });

  // 9. Last fetch log
  var lastFetch = db.prepare('SELECT * FROM fetch_log ORDER BY created_at DESC LIMIT 1').get();
  checks.push({ name: 'Last Fetch', ok: !!lastFetch, detail: lastFetch ? lastFetch.module + ' ' + lastFetch.fetch_type + ' at ' + lastFetch.created_at + ' (' + lastFetch.cities_ok + ' ok, ' + lastFetch.cities_fail + ' fail)' : 'Never fetched' });

  // 10. Fuel module status
  var fuel = req.app.locals.modules.fuel;
  checks.push({ name: 'Fuel Module', ok: fuel && fuel.status === 'ready', detail: fuel ? fuel.status + (fuel.error ? ': ' + fuel.error : '') : 'Not loaded' });

  // 11. Metals module status
  var metals = req.app.locals.modules.metals;
  checks.push({ name: 'Metals Module', ok: metals && metals.status === 'ready', detail: metals ? metals.status + (metals.error ? ': ' + metals.error : '') : 'Not loaded' });

  var allOk = checks.every(function(c) { return c.ok; });
  res.json({ ok: allOk, checks: checks });
});
```

### Add Diagnostics Button to Settings Page

**File:** `public/index.html`

In the settings page:
```html
<div class="card">
  <h3>Pipeline Diagnostics</h3>
  <p class="text-muted">Quick check of all system requirements.</p>
  <button class="btn btn-secondary" onclick="runDiagnostics()">🔍 Run Diagnostics</button>
  <div id="diagnostics-result" class="mt-2"></div>
</div>
```

**File:** `public/js/dashboard.js`

```js
async function runDiagnostics() {
  var el = document.getElementById('diagnostics-result');
  el.innerHTML = '⏳ Checking...';
  try {
    var res = await fetch('/api/diagnostics');
    var data = await res.json();
    var html = '<table class="data-table"><thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead><tbody>';
    data.checks.forEach(function(c) {
      html += '<tr><td>' + c.name + '</td>';
      html += '<td>' + (c.ok ? '<span class="text-green">✅ OK</span>' : '<span class="text-red">❌ FAIL</span>') + '</td>';
      html += '<td class="text-sm">' + c.detail + '</td></tr>';
    });
    html += '</tbody></table>';
    el.innerHTML = html;
  } catch(e) { el.textContent = '❌ ' + e.message; }
}
```

---

## CSS Addition

**File:** `public/index.html` (in `<style>` block) or `public/css/style.css`

```css
.btn-outline { background: transparent; border: 1px solid #6b7280; color: #9ca3af; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 12px; }
.btn-outline:hover { background: #374151; color: #e5e7eb; }
.mini-panel { background: #1f2937; border: 1px solid #374151; border-radius: 6px; padding: 10px 14px; margin-top: 8px; font-size: 12px; color: #d1d5db; line-height: 1.6; }
.mt-1 { margin-top: 4px; }
.mt-2 { margin-top: 8px; }
```

---

## CHECKLIST — Run these tests after applying:

1. Go to **Settings** → click **Run Diagnostics** → verify Fuel/Metals API keys, cities seeded, module status
2. **Set API keys** if not already set → Save → Run Diagnostics again
3. Go to **Fuel** → click **🧪 Test Fetch (5 cities)** → should see actual prices in the toast
4. Go to **Metals** → click **🧪 Test Fetch (Gold)** → should see gold prices
5. If test passes → click **⚡ Fetch All Prices** → wait for it to complete → dashboard should refresh with real data
6. In the **Cities tab** → click **⚡** button on any individual city → should fetch and show result
7. Check **Fetch Log** tab → should show the fetch operations you just ran
