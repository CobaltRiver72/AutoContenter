# HDF AutoPub — Day 3 Prompt
## Gitignore Fix + Fuel & Metals Dashboard Enhancements

> **Context:** Day 1-2 shipped FuelModule, MetalsModule, WP Publisher, Post Creators, CSV importer. Both dashboard pages currently show basic summary cards + one chart + one table each. This prompt fixes the deploy blocker and adds comprehensive data management, post tracking, manual editing, fetch logs, and AI template controls.

---

## PART 0 — CRITICAL: Fix .gitignore Blocking Seed Files

**File:** `.gitignore`

**Problem:** The line `data/` blocks seed JSON files from being committed/deployed. The app can't seed cities on the server, so both dashboards show 0 cities.

**Replace this line:**
```
data/
```

**With these lines:**
```
data/*.db
data/*.db-wal
data/*.db-shm
data/import-*.csv
```

This keeps the SQLite DB and import CSVs out of git but allows the seed JSON files (`fuel-cities.json`, `fuel-api3-cities.json`, `fuel-city-state-map.json`, `metals-cities.json`) to be committed and deployed.

**Also**, make the seed warning louder in both modules:

In `src/modules/fuel.js` seedCities() (around line 98), change `this.logger.warn` to `this.logger.error`:
```js
this.logger.error(MODULE, 'SEED FILE MISSING: ' + citiesPath + ' — fuel_cities will be empty!');
```

Same in `src/modules/metals.js` seedCities() (around line 95).

---

## PART 1 — New Database Tables for Post Tracking

**File:** `src/utils/db.js`

Add these tables after the existing fuel/metals tables:

```sql
-- Track all generated WordPress posts
CREATE TABLE IF NOT EXISTS wp_posts_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module TEXT NOT NULL,          -- 'fuel' or 'metals'
  post_type TEXT NOT NULL,       -- 'city', 'state', 'national'
  item_type TEXT NOT NULL,       -- 'petrol', 'diesel', 'gold', 'silver', 'platinum'
  item_name TEXT NOT NULL,       -- city name, state name, or 'India'
  wp_post_id INTEGER,            -- WordPress post ID (null if failed)
  wp_slug TEXT,
  wp_url TEXT,
  wp_status TEXT,                -- 'publish', 'draft', 'failed'
  action TEXT,                   -- 'created', 'updated', 'failed'
  error_message TEXT,
  content_hash TEXT,             -- MD5 of generated content (for change detection)
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(module, item_type, post_type, item_name)
);

CREATE INDEX IF NOT EXISTS idx_wp_posts_module ON wp_posts_log(module);
CREATE INDEX IF NOT EXISTS idx_wp_posts_type ON wp_posts_log(item_type, post_type);
CREATE INDEX IF NOT EXISTS idx_wp_posts_action ON wp_posts_log(action);

-- Track fetch operations
CREATE TABLE IF NOT EXISTS fetch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module TEXT NOT NULL,           -- 'fuel' or 'metals'
  fetch_type TEXT DEFAULT 'scheduled',  -- 'scheduled', 'manual', 'autofill', 'derive'
  cities_ok INTEGER DEFAULT 0,
  cities_fail INTEGER DEFAULT 0,
  cities_skipped INTEGER DEFAULT 0,
  duration_ms INTEGER,
  error_message TEXT,
  details TEXT,                  -- JSON: per-city results, failed cities list, etc.
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fetch_log_module ON fetch_log(module, created_at);
```

---

## PART 2 — Update FuelModule & MetalsModule to Log Fetches

### File: `src/modules/fuel.js`

In `runDailyFetch()`, after the fetch loop completes, log to `fetch_log`:

```js
// After the for loop and deriveMissing()
const duration = Date.now() - startTime;   // add startTime = Date.now() at top of method
const failedCities = failures.map(f => f.city);  // collect failures in loop

this.db.prepare(`
  INSERT INTO fetch_log (module, fetch_type, cities_ok, cities_fail, cities_skipped, duration_ms, details)
  VALUES ('fuel', ?, ?, ?, ?, ?, ?)
`).run(
  isManual ? 'manual' : 'scheduled',
  ok, fail, 0, duration,
  JSON.stringify({ failedCities: failedCities.slice(0, 20) })
);
```

Add `isManual` parameter to `runDailyFetch(isManual = false)`.

Update the `POST /api/fuel/fetch` route to pass `true`: `fuel.runDailyFetch(true)`.

### File: `src/modules/metals.js`

Same pattern — add fetch logging to `runDailyFetch()` and pass `isManual` flag.

---

## PART 3 — Update Post Creators to Log to wp_posts_log

### File: `src/modules/fuel-posts.js`

After each successful `wp.upsertPost()` call, log:

```js
this.db.prepare(`
  INSERT INTO wp_posts_log (module, post_type, item_type, item_name, wp_post_id, wp_slug, wp_url, wp_status, action, content_hash)
  VALUES ('fuel', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(module, item_type, post_type, item_name) DO UPDATE SET
    wp_post_id = excluded.wp_post_id,
    wp_url = excluded.wp_url,
    wp_status = excluded.wp_status,
    action = excluded.action,
    content_hash = excluded.content_hash,
    created_at = datetime('now')
`).run(postType, fuelType, itemName, result.id, result.slug, result.url, result.status || 'publish', result.action, contentHash);
```

On failure, log with `action = 'failed'` and populate `error_message`.

Use `require('crypto').createHash('md5').update(content).digest('hex')` for `content_hash`.

### File: `src/modules/metals-posts.js`

Same pattern with `module = 'metals'`.

---

## PART 4 — New API Endpoints

**File:** `src/routes/api.js`

### 4A. Generated Posts Management

```
GET /api/posts/list
  Query params: module (fuel|metals), item_type (petrol|diesel|gold|silver|platinum), post_type (city|state|national), search (text), page (default 1), limit (default 50)
  SQL: SELECT * FROM wp_posts_log WHERE ... ORDER BY created_at DESC LIMIT ? OFFSET ?
  Returns: { data: [...], total: count, page, pages }

GET /api/posts/stats
  Returns: {
    fuel: { total, cities, states, national, updated_today, failed },
    metals: { total, cities, states, national, updated_today, failed }
  }

POST /api/posts/regenerate
  Body: { module, item_type, post_type, item_name }
  Regenerates a single specific post (city/state/national)
  Returns: { ok, result: { id, slug, url, action } }

POST /api/posts/regenerate-batch
  Body: { module, item_type, post_type } (e.g. regenerate all gold city posts)
  Returns: { ok, queued: count }
```

### 4B. Fetch Log & History

```
GET /api/fetch-log
  Query params: module (fuel|metals), limit (default 20)
  SQL: SELECT * FROM fetch_log WHERE module = ? ORDER BY created_at DESC LIMIT ?
  Returns: { data: [...] }

GET /api/fuel/city-detail?city=Delhi
  Returns: {
    city: { city_name, state, is_enabled, has_post, api3_city, ... },
    today: { petrol, diesel, source, price_date },
    history: [last 30 days],
    posts: { petrol: { wp_post_id, wp_url, action, created_at }, diesel: { ... } }
  }

GET /api/metals/city-detail?city=Delhi
  Returns: {
    city: { city_name, state, is_active, api1_name, ... },
    today: { gold: { price_24k, price_22k, price_18k }, silver: { price_1g }, platinum: { price_1g } },
    history: { gold: [30 days], silver: [30 days], platinum: [30 days] },
    posts: { gold: { wp_post_id, wp_url, ... }, silver: { ... }, platinum: { ... } }
  }
```

### 4C. Manual Price Edit

```
PUT /api/fuel/price
  Body: { city, price_date, petrol, diesel }
  Validates: price between 30-200 or null
  SQL: UPDATE fuel_prices SET petrol=?, diesel=?, source='manual' WHERE city=? AND price_date=?
  If no row exists: INSERT with source='manual'
  Returns: { ok, updated: { city, price_date, petrol, diesel } }

PUT /api/metals/price
  Body: { city, metal_type, price_date, price_24k, price_22k, price_18k, price_1g }
  SQL: UPDATE metals_prices SET ... source='manual' WHERE city=? AND metal_type=? AND price_date=?
  Returns: { ok, updated: { ... } }
```

### 4D. City Management

```
PUT /api/fuel/city
  Body: { city_name, state, is_enabled, has_post }
  SQL: UPDATE fuel_cities SET is_enabled=?, has_post=? WHERE city_name=? AND state=?
  Returns: { ok }

PUT /api/metals/city
  Body: { city_name, is_active }
  SQL: UPDATE metals_cities SET is_active=? WHERE city_name=?
  Returns: { ok }
```

### 4E. Data Quality Check

```
GET /api/fuel/data-quality
  Returns: {
    totalCities: N,
    enabledCities: N,
    fetchedToday: N,
    staleCities: [cities with no data in last 3 days],
    priceSuspicious: [cities where price changed > 5% in one day],
    sourceBreakdown: { api3: N, derived: N, carryforward: N, manual: N, imported: N },
    coverageByState: [{ state, total, fetched, pct }]
  }

GET /api/metals/data-quality
  Same pattern for metals: stale cities, suspicious changes, coverage by state/metal
```

---

## PART 5 — Enhanced Fuel Dashboard Page

**File:** `public/index.html`

Redesign the fuel page (`id="page-fuel"`) with a **tabbed layout** inside the page:

### Tab Navigation (below the header buttons)

```html
<div class="page-tabs" id="fuel-tabs">
  <button class="tab active" data-tab="fuel-tab-overview" onclick="switchFuelTab('overview')">📊 Overview</button>
  <button class="tab" data-tab="fuel-tab-cities" onclick="switchFuelTab('cities')">🏙️ Cities</button>
  <button class="tab" data-tab="fuel-tab-posts" onclick="switchFuelTab('posts')">📝 Posts</button>
  <button class="tab" data-tab="fuel-tab-logs" onclick="switchFuelTab('logs')">📋 Fetch Log</button>
  <button class="tab" data-tab="fuel-tab-quality" onclick="switchFuelTab('quality')">🔍 Data Quality</button>
</div>
```

### Tab 1: Overview (fuel-tab-overview) — Keep existing layout
- 4 stat cards (Total Cities, Fetched Today, Missing, Last Fetch)
- National Average Trend chart (30d)
- States Overview table
- **NEW:** Add a mini "Recent Activity" panel below the chart:
  - Last 5 fetch_log entries for fuel (time, cities_ok/fail, duration)
  - Last 5 wp_posts_log entries for fuel (item_name, action, time)

### Tab 2: Cities (fuel-tab-cities) — Enhanced city table
- Keep existing state filter + search box
- **Enhanced table columns:** City | State | Petrol (₹) | Diesel (₹) | Source | Date | Enabled | Has Post | Actions
- **Actions column:** 
  - 🔗 (link to WP post if exists)
  - ✏️ (edit price — opens inline edit row)
  - 🔄 (regenerate post for this city)
  - ⚙️ (toggle enabled/has_post)
- **Inline edit row:** When ✏️ is clicked, the row transforms into input fields:
  - Petrol input (number, step 0.01)
  - Diesel input (number, step 0.01)
  - Save / Cancel buttons
  - On save: PUT /api/fuel/price

### Tab 3: Posts (fuel-tab-posts) — Generated WordPress Posts
```html
<div id="fuel-tab-posts" class="tab-content" style="display:none">
  <!-- Post stats summary -->
  <div class="stats-row">
    <div class="stat-card"><span id="fuel-posts-total">—</span><label>Total Posts</label></div>
    <div class="stat-card"><span id="fuel-posts-updated-today">—</span><label>Updated Today</label></div>
    <div class="stat-card"><span id="fuel-posts-failed">—</span><label>Failed</label></div>
  </div>

  <!-- Filters -->
  <div class="filter-row">
    <select id="fuel-posts-type-filter" onchange="loadFuelPosts()">
      <option value="">All Types</option>
      <option value="petrol">Petrol</option>
      <option value="diesel">Diesel</option>
    </select>
    <select id="fuel-posts-tier-filter" onchange="loadFuelPosts()">
      <option value="">All Tiers</option>
      <option value="city">City</option>
      <option value="state">State</option>
      <option value="national">National</option>
    </select>
    <select id="fuel-posts-status-filter" onchange="loadFuelPosts()">
      <option value="">All Status</option>
      <option value="created">Created</option>
      <option value="updated">Updated</option>
      <option value="failed">Failed</option>
    </select>
    <input id="fuel-posts-search" placeholder="Search posts..." oninput="loadFuelPosts()" />
  </div>

  <!-- Posts table -->
  <table class="data-table">
    <thead>
      <tr>
        <th>Name</th>
        <th>Type</th>
        <th>Tier</th>
        <th>WP Status</th>
        <th>Last Action</th>
        <th>Updated</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody id="fuel-posts-tbody"></tbody>
  </table>

  <!-- Pagination -->
  <div class="pagination" id="fuel-posts-pagination"></div>
</div>
```

**Table rows display:**
- Name: city/state/India name
- Type: Petrol/Diesel badge (colored)
- Tier: City/State/National badge
- WP Status: publish (green) / draft (yellow) / failed (red)
- Last Action: created/updated/failed with timestamp
- Updated: relative time (e.g. "2h ago")
- Actions:
  - 🔗 Open in WP (external link to wp_url)
  - 🔄 Regenerate (POST /api/posts/regenerate)

### Tab 4: Fetch Log (fuel-tab-logs)
```html
<div id="fuel-tab-logs" class="tab-content" style="display:none">
  <table class="data-table">
    <thead>
      <tr>
        <th>Time</th>
        <th>Type</th>
        <th>OK</th>
        <th>Failed</th>
        <th>Duration</th>
        <th>Details</th>
      </tr>
    </thead>
    <tbody id="fuel-fetch-log-tbody"></tbody>
  </table>
</div>
```

**Row display:**
- Time: relative timestamp
- Type: scheduled/manual badge
- OK: green number
- Failed: red number (0 = gray)
- Duration: e.g. "45s" or "2m 12s"
- Details: expandable — shows failed city names JSON

### Tab 5: Data Quality (fuel-tab-quality)
```html
<div id="fuel-tab-quality" class="tab-content" style="display:none">
  <!-- Coverage by state (horizontal bar chart or table) -->
  <div class="card">
    <h3>State Coverage — Today</h3>
    <table class="data-table">
      <thead><tr><th>State</th><th>Total</th><th>Fetched</th><th>Coverage</th><th>Bar</th></tr></thead>
      <tbody id="fuel-coverage-tbody"></tbody>
    </table>
  </div>

  <!-- Stale cities -->
  <div class="card">
    <h3>⚠️ Stale Cities (No data in 3+ days)</h3>
    <div id="fuel-stale-cities"></div>
  </div>

  <!-- Suspicious price changes -->
  <div class="card">
    <h3>🔍 Suspicious Price Changes (>5% daily)</h3>
    <div id="fuel-suspicious-prices"></div>
  </div>

  <!-- Source breakdown (doughnut chart) -->
  <div class="card" style="max-width:400px">
    <h3>Price Source Breakdown</h3>
    <canvas id="fuel-source-chart" height="200"></canvas>
  </div>
</div>
```

---

## PART 6 — Enhanced Metals Dashboard Page

**File:** `public/index.html`

Same tabbed layout pattern for metals page (`id="page-metals"`):

### Tab Navigation
```html
<div class="page-tabs" id="metals-tabs">
  <button class="tab active" data-tab="metals-tab-overview" onclick="switchMetalsTab('overview')">📊 Overview</button>
  <button class="tab" data-tab="metals-tab-cities" onclick="switchMetalsTab('cities')">🏙️ Cities</button>
  <button class="tab" data-tab="metals-tab-posts" onclick="switchMetalsTab('posts')">📝 Posts</button>
  <button class="tab" data-tab="metals-tab-logs" onclick="switchMetalsTab('logs')">📋 Fetch Log</button>
  <button class="tab" data-tab="metals-tab-quality" onclick="switchMetalsTab('quality')">🔍 Data Quality</button>
</div>
```

**Keep the Gold / Silver / Platinum metal selector** above the tabs — it affects data across all tabs.

### Tab 1: Overview — Same as current but add mini activity panel
### Tab 2: Cities — Enhanced table with inline edit + actions
- Gold columns: City | State | 24K | 22K | 18K | Source | Date | Active | Actions
- Silver/Platinum columns: City | State | 1g | Per KG | Source | Date | Active | Actions
- Inline edit: ✏️ opens number inputs for all price columns
- PUT /api/metals/price on save
### Tab 3: Posts — Same table pattern as fuel but with Gold/Silver/Platinum filter
### Tab 4: Fetch Log — Same pattern as fuel
### Tab 5: Data Quality — Same pattern with metal-specific coverage

---

## PART 7 — Dashboard JavaScript

**File:** `public/js/dashboard.js`

### 7A. Tab Switching

```js
function switchFuelTab(tab) {
  document.querySelectorAll('#fuel-tabs .tab').forEach(b => b.classList.remove('active'));
  document.querySelector(`#fuel-tabs [data-tab="fuel-tab-${tab}"]`).classList.add('active');
  document.querySelectorAll('#page-fuel .tab-content').forEach(el => el.style.display = 'none');
  document.getElementById('fuel-tab-' + tab).style.display = '';
  // Load data for tab
  if (tab === 'posts') loadFuelPosts();
  if (tab === 'logs') loadFuelFetchLog();
  if (tab === 'quality') loadFuelDataQuality();
}

// Same pattern for switchMetalsTab(tab)
```

### 7B. Posts Tab Functions

```js
async function loadFuelPosts(page = 1) {
  const type = document.getElementById('fuel-posts-type-filter').value;
  const tier = document.getElementById('fuel-posts-tier-filter').value;
  const status = document.getElementById('fuel-posts-status-filter').value;
  const search = document.getElementById('fuel-posts-search').value;
  
  const params = new URLSearchParams({ module: 'fuel', page, limit: 50 });
  if (type) params.set('item_type', type);
  if (tier) params.set('post_type', tier);
  if (status) params.set('action', status);
  if (search) params.set('search', search);

  const res = await fetch('/api/posts/list?' + params);
  const json = await res.json();

  // Update stats
  const statsRes = await fetch('/api/posts/stats');
  const stats = await statsRes.json();
  setText('fuel-posts-total', stats.fuel.total);
  setText('fuel-posts-updated-today', stats.fuel.updated_today);
  setText('fuel-posts-failed', stats.fuel.failed);

  // Render table
  const tbody = document.getElementById('fuel-posts-tbody');
  tbody.innerHTML = json.data.map(p => `
    <tr class="${p.action === 'failed' ? 'row-error' : ''}">
      <td>${esc(p.item_name)}</td>
      <td><span class="badge badge-${p.item_type}">${p.item_type}</span></td>
      <td><span class="badge badge-tier">${p.post_type}</span></td>
      <td><span class="dot dot-${p.wp_status === 'publish' ? 'green' : p.wp_status === 'draft' ? 'yellow' : 'red'}"></span> ${p.wp_status || 'unknown'}</td>
      <td>${p.action}${p.error_message ? ' <span class="text-red" title="' + esc(p.error_message) + '">⚠</span>' : ''}</td>
      <td title="${p.created_at}">${timeAgo(p.created_at)}</td>
      <td>
        ${p.wp_url ? '<a href="' + p.wp_url + '" target="_blank" title="Open in WordPress">🔗</a>' : ''}
        <button class="btn-icon" onclick="regeneratePost('fuel','${p.item_type}','${p.post_type}','${esc(p.item_name)}')" title="Regenerate">🔄</button>
      </td>
    </tr>
  `).join('');

  // Pagination
  renderPagination('fuel-posts-pagination', json.page, json.pages, (p) => loadFuelPosts(p));
}

async function regeneratePost(module, itemType, postType, itemName) {
  if (!confirm(`Regenerate ${itemType} ${postType} post for ${itemName}?`)) return;
  try {
    const res = await fetch('/api/posts/regenerate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ module, item_type: itemType, post_type: postType, item_name: itemName })
    });
    const data = await res.json();
    showToast(data.ok ? `✅ ${data.result.action}: ${data.result.slug}` : `❌ ${data.error}`, data.ok ? 'success' : 'error');
    // Refresh posts list
    if (module === 'fuel') loadFuelPosts();
    else loadMetalsPosts();
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}
```

### 7C. Fetch Log Functions

```js
async function loadFuelFetchLog() {
  const res = await fetch('/api/fetch-log?module=fuel&limit=30');
  const json = await res.json();
  const tbody = document.getElementById('fuel-fetch-log-tbody');
  tbody.innerHTML = json.data.map(l => {
    const details = l.details ? JSON.parse(l.details) : {};
    const dur = l.duration_ms > 60000 ? Math.round(l.duration_ms/60000) + 'm' : Math.round(l.duration_ms/1000) + 's';
    return `
      <tr>
        <td title="${l.created_at}">${timeAgo(l.created_at)}</td>
        <td><span class="badge badge-${l.fetch_type}">${l.fetch_type}</span></td>
        <td class="text-green">${l.cities_ok}</td>
        <td class="${l.cities_fail > 0 ? 'text-red' : 'text-muted'}">${l.cities_fail}</td>
        <td>${dur}</td>
        <td>${details.failedCities && details.failedCities.length > 0 ? '<span class="text-red text-sm">' + details.failedCities.join(', ') + '</span>' : '—'}</td>
      </tr>
    `;
  }).join('') || '<tr><td colspan="6" class="text-center text-muted">No fetch history yet</td></tr>';
}
```

### 7D. Data Quality Functions

```js
async function loadFuelDataQuality() {
  const res = await fetch('/api/fuel/data-quality');
  const q = await res.json();

  // Coverage by state table
  const tbody = document.getElementById('fuel-coverage-tbody');
  tbody.innerHTML = q.coverageByState.map(s => {
    const pct = s.total > 0 ? Math.round(s.fetched / s.total * 100) : 0;
    const barColor = pct >= 80 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444';
    return `
      <tr>
        <td>${s.state}</td>
        <td>${s.total}</td>
        <td>${s.fetched}</td>
        <td>${pct}%</td>
        <td><div class="bar-bg"><div class="bar-fill" style="width:${pct}%;background:${barColor}"></div></div></td>
      </tr>
    `;
  }).join('');

  // Stale cities
  const staleEl = document.getElementById('fuel-stale-cities');
  if (q.staleCities.length === 0) {
    staleEl.innerHTML = '<p class="text-green">✅ All cities have recent data</p>';
  } else {
    staleEl.innerHTML = q.staleCities.map(c => `<span class="pill pill-warn">${c.city_name} (${c.state}) — ${c.days_since} days</span>`).join(' ');
  }

  // Suspicious prices
  const suspEl = document.getElementById('fuel-suspicious-prices');
  if (q.priceSuspicious.length === 0) {
    suspEl.innerHTML = '<p class="text-green">✅ No suspicious price changes</p>';
  } else {
    suspEl.innerHTML = '<table class="data-table"><thead><tr><th>City</th><th>Type</th><th>Yesterday</th><th>Today</th><th>Change</th></tr></thead><tbody>' +
      q.priceSuspicious.map(p => `<tr><td>${p.city}</td><td>${p.fuel}</td><td>₹${p.yesterday}</td><td>₹${p.today}</td><td class="text-red">${p.pct_change}%</td></tr>`).join('') +
      '</tbody></table>';
  }

  // Source breakdown doughnut
  renderSourceChart('fuel-source-chart', q.sourceBreakdown);
}

function renderSourceChart(canvasId, data) {
  const ctx = document.getElementById(canvasId);
  if (window._sourceChart) window._sourceChart.destroy();
  const labels = Object.keys(data);
  const values = Object.values(data);
  const colors = { api3: '#10b981', derived: '#3b82f6', carryforward: '#f59e0b', manual: '#a78bfa', imported: '#6b7280' };
  window._sourceChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: labels.map(l => colors[l] || '#6b7280') }]
    },
    options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { color: '#9ca3af' } } } }
  });
}
```

### 7E. Inline Price Edit Functions

```js
function startEditFuelPrice(city, state, petrol, diesel, priceDate) {
  const row = document.querySelector(`tr[data-fuel-city="${city}"]`);
  if (!row) return;
  row.classList.add('editing');
  const petrolCell = row.querySelector('.col-petrol');
  const dieselCell = row.querySelector('.col-diesel');
  const actionsCell = row.querySelector('.col-actions');
  
  // Store original values
  row.dataset.origPetrol = petrol;
  row.dataset.origDiesel = diesel;

  petrolCell.innerHTML = `<input type="number" step="0.01" min="30" max="200" value="${petrol || ''}" class="edit-input" id="edit-petrol-${city}" />`;
  dieselCell.innerHTML = `<input type="number" step="0.01" min="30" max="200" value="${diesel || ''}" class="edit-input" id="edit-diesel-${city}" />`;
  actionsCell.innerHTML = `
    <button class="btn-icon text-green" onclick="saveEditFuelPrice('${city}','${state}','${priceDate}')" title="Save">💾</button>
    <button class="btn-icon text-red" onclick="cancelEditFuelPrice('${city}')" title="Cancel">✖</button>
  `;
}

async function saveEditFuelPrice(city, state, priceDate) {
  const petrol = parseFloat(document.getElementById('edit-petrol-' + city).value) || null;
  const diesel = parseFloat(document.getElementById('edit-diesel-' + city).value) || null;
  try {
    const res = await fetch('/api/fuel/price', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city, price_date: priceDate, petrol, diesel })
    });
    const data = await res.json();
    if (data.ok) {
      showToast('✅ Price updated for ' + city);
      loadFuelPage(); // refresh
    } else {
      showToast('❌ ' + data.error, 'error');
    }
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
}

function cancelEditFuelPrice(city) {
  loadFuelPage(); // simplest way to restore
}
```

Same pattern for metals inline edit: `startEditMetalsPrice()`, `saveEditMetalsPrice()`, `cancelEditMetalsPrice()`.

### 7F. Pagination Helper

```js
function renderPagination(containerId, currentPage, totalPages, onPageClick) {
  const el = document.getElementById(containerId);
  if (totalPages <= 1) { el.innerHTML = ''; return; }
  let html = '';
  if (currentPage > 1) html += `<button class="btn-page" onclick="(${onPageClick.toString()})(${currentPage-1})">← Prev</button>`;
  for (let i = Math.max(1, currentPage-2); i <= Math.min(totalPages, currentPage+2); i++) {
    html += `<button class="btn-page ${i === currentPage ? 'active' : ''}" onclick="(${onPageClick.toString()})(${i})">${i}</button>`;
  }
  if (currentPage < totalPages) html += `<button class="btn-page" onclick="(${onPageClick.toString()})(${currentPage+1})">Next →</button>`;
  el.innerHTML = html;
}
```

### 7G. Metals versions of all above functions

Create `loadMetalsPosts()`, `loadMetalsFetchLog()`, `loadMetalsDataQuality()` — same patterns but calling metals API endpoints and using `_currentMetal` for filtering.

---

## PART 8 — CSS for New Components

**File:** `public/index.html` (or `public/css/style.css` if separate)

Add these styles:

```css
/* Tabs */
.page-tabs { display: flex; gap: 4px; margin: 16px 0; border-bottom: 1px solid #374151; padding-bottom: 8px; }
.page-tabs .tab { background: transparent; border: none; color: #9ca3af; padding: 8px 16px; cursor: pointer; font-size: 13px; border-radius: 6px 6px 0 0; transition: all 0.2s; }
.page-tabs .tab:hover { background: #1f2937; color: #e5e7eb; }
.page-tabs .tab.active { background: #1f2937; color: #fff; border-bottom: 2px solid #8b5cf6; }

/* Tab content */
.tab-content { /* no extra styles needed, shown/hidden via display */ }

/* Badges */
.badge { padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
.badge-petrol { background: #ef444420; color: #ef4444; }
.badge-diesel { background: #3b82f620; color: #3b82f6; }
.badge-gold { background: #f59e0b20; color: #f59e0b; }
.badge-silver { background: #9ca3af20; color: #9ca3af; }
.badge-platinum { background: #a78bfa20; color: #a78bfa; }
.badge-tier { background: #6b728020; color: #9ca3af; }
.badge-scheduled { background: #10b98120; color: #10b981; }
.badge-manual { background: #8b5cf620; color: #8b5cf6; }

/* Status dots */
.dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; }
.dot-green { background: #10b981; }
.dot-yellow { background: #f59e0b; }
.dot-red { background: #ef4444; }

/* Coverage bar */
.bar-bg { width: 100%; height: 6px; background: #374151; border-radius: 3px; overflow: hidden; }
.bar-fill { height: 100%; border-radius: 3px; transition: width 0.5s; }

/* Pills */
.pill { display: inline-block; padding: 4px 10px; border-radius: 12px; font-size: 12px; margin: 3px; }
.pill-warn { background: #f59e0b20; color: #f59e0b; border: 1px solid #f59e0b40; }

/* Inline edit */
.editing td { background: #1e293b !important; }
.edit-input { width: 80px; padding: 4px; background: #0f172a; border: 1px solid #8b5cf6; border-radius: 4px; color: #e5e7eb; font-size: 13px; }

/* Icon buttons */
.btn-icon { background: transparent; border: none; cursor: pointer; padding: 2px 6px; font-size: 14px; opacity: 0.7; transition: opacity 0.2s; }
.btn-icon:hover { opacity: 1; }

/* Filter row */
.filter-row { display: flex; gap: 8px; margin: 12px 0; flex-wrap: wrap; align-items: center; }
.filter-row select, .filter-row input { background: #1f2937; border: 1px solid #374151; color: #e5e7eb; padding: 6px 10px; border-radius: 6px; font-size: 13px; }

/* Pagination */
.pagination { display: flex; gap: 4px; justify-content: center; margin-top: 16px; }
.btn-page { background: #1f2937; border: 1px solid #374151; color: #9ca3af; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; }
.btn-page.active { background: #8b5cf6; color: #fff; border-color: #8b5cf6; }
.btn-page:hover:not(.active) { background: #374151; color: #e5e7eb; }

/* Row error highlight */
.row-error { background: #ef444410 !important; }
.row-error td { border-left: 2px solid #ef4444; }

/* Text utilities */
.text-green { color: #10b981; }
.text-red { color: #ef4444; }
.text-muted { color: #6b7280; }
.text-sm { font-size: 11px; }
.text-center { text-align: center; }

/* Button colors */
.btn-blue { background: #3b82f6; }
.btn-blue:hover { background: #2563eb; }
```

---

## PART 9 — Wire Tab Loading into Page Navigation

**File:** `public/js/dashboard.js`

Update `loadFuelPage()` to also initialize the first tab:

```js
async function loadFuelPage() {
  // ... existing code (load summary, states, cities, chart) ...
  // After existing code, mark overview tab as loaded
  switchFuelTab('overview');
}
```

Update `loadMetalsPage()` similarly.

---

## IMPORTANT IMPLEMENTATION NOTES

1. **Tab content sections** must all be wrapped in a div with `class="tab-content"` and initially `style="display:none"` except the Overview tab.

2. **City table rows** need a `data-fuel-city` attribute for the inline edit selector: `<tr data-fuel-city="${city_name}">`.

3. **The POST /api/posts/regenerate** endpoint must:
   - For fuel: call `fuelPosts.generateCityPost()`, `generateStatePost()`, or `generateNationalPost()` based on `post_type`
   - For metals: same pattern with `metalsPosts`
   - Return the upsert result including WP post URL

4. **renderPagination** — the callback function approach may not work well with closures. Alternatively, use data attributes and event delegation:
   ```js
   document.getElementById('fuel-posts-pagination').addEventListener('click', e => {
     if (e.target.dataset.page) loadFuelPosts(Number(e.target.dataset.page));
   });
   ```

5. **timeAgo() helper** — if not already present, add:
   ```js
   function timeAgo(dateStr) {
     if (!dateStr) return 'Never';
     const diff = Date.now() - new Date(dateStr).getTime();
     const mins = Math.floor(diff / 60000);
     if (mins < 1) return 'just now';
     if (mins < 60) return mins + 'm ago';
     const hrs = Math.floor(mins / 60);
     if (hrs < 24) return hrs + 'h ago';
     const days = Math.floor(hrs / 24);
     return days + 'd ago';
   }
   ```

6. **esc() helper** — HTML entity escape for XSS safety:
   ```js
   function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
   ```

7. **All new endpoints** must check that the relevant module exists in `req.app.locals.modules` before accessing it, returning 503 if not loaded.

8. **fetch_log.details** column stores JSON — use `JSON.stringify()` when inserting, `JSON.parse()` when reading. Handle parse errors gracefully.
