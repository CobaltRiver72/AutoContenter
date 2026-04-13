# HDF WIDGET SYSTEM — PROMPT FOR AI IDE

Feed this entire prompt to your AI IDE assistant.

---

## What We Are Building

A lightweight widget system that separates **content** (text, SEO, structure) from **data** (prices, charts, tables).

**The rule from this point forward:**
- WordPress posts store ONLY text + tiny widget placeholders
- No inline CSS ever again
- No prices hardcoded in HTML
- One CSS file + one JS file loaded globally in WordPress (never in posts)
- Data always comes from the Node.js API at render time

**Why:**
- Post HTML drops from ~10KB → ~1KB
- Prices stay live without republishing
- AI post generation becomes dead simple (write text + drop one line)
- Future charts, rankings, comparisons all work with the same system

---

## Part 1 — Public API Endpoints (no auth required)

In `src/routes/api.js`, add a new `/api/public` group. These endpoints are CORS-enabled and return fresh data from SQLite.

```js
const cors = require('cors');

// Public widget API — no auth, CORS open
// Allow requests from the WordPress domain
const publicCors = cors({
  origin: '*', // tighten to your WP domain in production
  methods: ['GET'],
});

// ── Single city price ──────────────────────────────────
// GET /api/public/price?module=fuel&city=Mumbai&state=Maharashtra
router.get('/public/price', publicCors, (req, res) => {
  const { module, city, state, metal } = req.query;
  try {
    let row;
    if (module === 'metals' && metal && city) {
      row = db.prepare(`
        SELECT mc.city_name, mc.state_name, mp.metal_type, mp.price_per_gram, mp.fetched_at
        FROM metals_prices mp
        JOIN metals_cities mc ON mp.city_id = mc.id
        WHERE mc.city_name = ? AND mp.metal_type = ?
        ORDER BY mp.fetched_at DESC LIMIT 1
      `).get(city, metal);
    } else if (module === 'fuel' && city) {
      row = db.prepare(`
        SELECT fc.city_name, fc.state_name, fp.fuel_type, fp.price, fp.fetched_at
        FROM fuel_prices fp
        JOIN fuel_cities fc ON fp.city_id = fc.id
        WHERE fc.city_name = ?
        ORDER BY fp.fetched_at DESC LIMIT 1
      `).get(city);
    }
    if (!row) return res.json({ ok: false, data: null });
    res.json({ ok: true, data: row, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── State average price ────────────────────────────────
// GET /api/public/state?module=metals&state=Maharashtra&metal=gold
router.get('/public/state', publicCors, (req, res) => {
  const { module, state, metal } = req.query;
  try {
    let rows;
    if (module === 'metals' && metal && state) {
      rows = db.prepare(`
        SELECT mc.city_name, mp.metal_type, mp.price_per_gram, mp.fetched_at
        FROM metals_prices mp
        JOIN metals_cities mc ON mp.city_id = mc.id
        WHERE mc.state_name = ? AND mp.metal_type = ?
          AND mp.fetched_at = (
            SELECT MAX(mp2.fetched_at) FROM metals_prices mp2 WHERE mp2.city_id = mp.city_id AND mp2.metal_type = mp.metal_type
          )
      `).all(state, metal);
    } else if (module === 'fuel' && state) {
      rows = db.prepare(`
        SELECT fc.city_name, fp.fuel_type, fp.price, fp.fetched_at
        FROM fuel_prices fp
        JOIN fuel_cities fc ON fp.city_id = fc.id
        WHERE fc.state_name = ?
          AND fp.fetched_at = (
            SELECT MAX(fp2.fetched_at) FROM fuel_prices fp2 WHERE fp2.city_id = fp.city_id AND fp2.fuel_type = fp.fuel_type
          )
      `).all(state);
    }
    res.json({ ok: true, data: rows || [], ts: Date.now() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── National ranking ───────────────────────────────────
// GET /api/public/ranking?module=metals&metal=gold&sort=asc&limit=10
// GET /api/public/ranking?module=fuel&fuel=petrol&sort=asc&limit=10
router.get('/public/ranking', publicCors, (req, res) => {
  const { module, metal, fuel, sort = 'asc', limit = 10 } = req.query;
  const dir = sort === 'desc' ? 'DESC' : 'ASC';
  const cap = Math.min(parseInt(limit) || 10, 50);
  try {
    let rows;
    if (module === 'metals' && metal) {
      rows = db.prepare(`
        SELECT mc.city_name, mc.state_name, mp.price_per_gram AS price, mp.fetched_at
        FROM metals_prices mp
        JOIN metals_cities mc ON mp.city_id = mc.id
        WHERE mp.metal_type = ?
          AND mp.fetched_at = (
            SELECT MAX(mp2.fetched_at) FROM metals_prices mp2 WHERE mp2.city_id = mp.city_id AND mp2.metal_type = mp.metal_type
          )
        ORDER BY mp.price_per_gram ${dir} LIMIT ?
      `).all(metal, cap);
    } else if (module === 'fuel' && fuel) {
      rows = db.prepare(`
        SELECT fc.city_name, fc.state_name, fp.price, fp.fetched_at
        FROM fuel_prices fp
        JOIN fuel_cities fc ON fp.city_id = fc.id
        WHERE fp.fuel_type = ?
          AND fp.fetched_at = (
            SELECT MAX(fp2.fetched_at) FROM fuel_prices fp2 WHERE fp2.city_id = fp.city_id AND fp2.fuel_type = fp.fuel_type
          )
        ORDER BY fp.price ${dir} LIMIT ?
      `).all(fuel, cap);
    }
    res.json({ ok: true, data: rows || [], ts: Date.now() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── National summary ───────────────────────────────────
// GET /api/public/national?module=metals&metal=gold
router.get('/public/national', publicCors, (req, res) => {
  const { module, metal } = req.query;
  try {
    let summary = {};
    if (module === 'metals' && metal) {
      const row = db.prepare(`
        SELECT AVG(mp.price_per_gram) AS avg_price,
               MIN(mp.price_per_gram) AS min_price,
               MAX(mp.price_per_gram) AS max_price,
               COUNT(DISTINCT mc.city_name) AS city_count,
               COUNT(DISTINCT mc.state_name) AS state_count,
               MAX(mp.fetched_at) AS last_updated
        FROM metals_prices mp
        JOIN metals_cities mc ON mp.city_id = mc.id
        WHERE mp.metal_type = ?
          AND DATE(mp.fetched_at) = DATE('now', 'localtime')
      `).get(metal);
      summary = row;
    } else if (module === 'fuel') {
      const petrol = db.prepare(`
        SELECT AVG(fp.price) AS avg_price, MIN(fp.price) AS min_price, MAX(fp.price) AS max_price,
               COUNT(DISTINCT fc.city_name) AS city_count, MAX(fp.fetched_at) AS last_updated
        FROM fuel_prices fp JOIN fuel_cities fc ON fp.city_id = fc.id
        WHERE fp.fuel_type = 'petrol' AND DATE(fp.fetched_at) = DATE('now', 'localtime')
      `).get();
      const diesel = db.prepare(`
        SELECT AVG(fp.price) AS avg_price
        FROM fuel_prices fp WHERE fp.fuel_type = 'diesel' AND DATE(fp.fetched_at) = DATE('now', 'localtime')
      `).get();
      summary = { petrol, diesel };
    }
    res.json({ ok: true, data: summary, ts: Date.now() });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
```

Also add `cors` to package.json if not already there: `npm install cors`

---

## Part 2 — WordPress Widget Files

Create these two files in `public/wp-assets/`:

### `public/wp-assets/hdf-widgets.css`

```css
/* HDF Price Widgets — loaded once globally in WordPress
   Uses WordPress theme CSS variables for colors.
   Falls back to sensible defaults if theme doesn't define them. */

:root {
  --hdf-primary:    var(--wp--preset--color--primary,       #1d4ed8);
  --hdf-accent:     var(--wp--preset--color--vivid-red,     #dc2626);
  --hdf-text:       var(--wp--preset--color--foreground,    #111827);
  --hdf-muted:      var(--wp--preset--color--contrast-2,    #6b7280);
  --hdf-bg:         var(--wp--preset--color--background,    #ffffff);
  --hdf-border:     var(--wp--preset--color--contrast-3,    #e5e7eb);
  --hdf-surface:    var(--wp--preset--color--base-2,        #f9fafb);
  --hdf-green:      #16a34a;
  --hdf-red:        #dc2626;
  --hdf-radius:     8px;
  --hdf-font:       inherit;
}

/* ── Loading skeleton ── */
.hdf-widget[data-loading] { min-height: 80px; background: linear-gradient(90deg, var(--hdf-surface) 25%, var(--hdf-border) 50%, var(--hdf-surface) 75%); background-size: 200% 100%; animation: hdf-shimmer 1.4s infinite; border-radius: var(--hdf-radius); }
@keyframes hdf-shimmer { 0% { background-position: 200% 0 } 100% { background-position: -200% 0 } }

/* ── Price hero card ── */
.hdf-hero { background: var(--hdf-text); color: #fff; border-radius: var(--hdf-radius); padding: 24px; margin: 0 0 24px; }
.hdf-hero-top { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 16px; }
.hdf-hero-meta { font-size: 12px; opacity: .6; margin-top: 4px; }
.hdf-hero-price { font-size: 36px; font-weight: 800; line-height: 1; }
.hdf-hero-unit { font-size: 12px; opacity: .6; margin-top: 4px; }
.hdf-hero-pills { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; border-top: 1px solid rgba(255,255,255,.1); padding-top: 14px; }
.hdf-pill { background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.2); border-radius: 20px; padding: 4px 12px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.hdf-pill strong { margin-right: 3px; }

/* ── Live badge ── */
.hdf-live { display: inline-flex; align-items: center; gap: 6px; background: rgba(255,68,68,.15); border: 1px solid rgba(255,68,68,.4); border-radius: 20px; padding: 3px 10px; font-size: 11px; font-weight: 700; color: #ff6b6b; text-transform: uppercase; letter-spacing: .5px; }
.hdf-live i { width: 7px; height: 7px; border-radius: 50%; background: #ff4444; display: inline-block; animation: hdf-blink 1.2s ease-in-out infinite; }
@keyframes hdf-blink { 0%,100%{opacity:1} 50%{opacity:.2} }

/* ── Change badge ── */
.hdf-change { display: inline-flex; align-items: center; gap: 4px; border-radius: 20px; padding: 3px 10px; font-size: 12px; font-weight: 600; margin-top: 8px; }
.hdf-change.up   { color: var(--hdf-green); background: #f0fdf4; border: 1px solid #bbf7d0; }
.hdf-change.down { color: var(--hdf-red);   background: #fff1f2; border: 1px solid #fecdd3; }
.hdf-change.none { color: var(--hdf-muted); background: var(--hdf-surface); border: 1px solid var(--hdf-border); }

/* ── Tables ── */
.hdf-table-wrap { overflow-x: auto; border-radius: var(--hdf-radius); border: 1px solid var(--hdf-border); margin: 20px 0; }
.hdf-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.hdf-table caption { text-align: left; padding: 12px 14px; font-size: 14px; font-weight: 700; color: var(--hdf-text); background: var(--hdf-surface); border-bottom: 1px solid var(--hdf-border); }
.hdf-table thead tr { background: var(--hdf-text); }
.hdf-table thead th { padding: 10px 14px; color: #fff; font-size: 12px; font-weight: 700; text-align: left; letter-spacing: .3px; }
.hdf-table thead th:not(:first-child) { text-align: center; }
.hdf-table tbody tr { border-bottom: 1px solid var(--hdf-border); transition: background .15s; }
.hdf-table tbody tr:hover { background: #f0f6ff; }
.hdf-table tbody tr:last-child { border-bottom: none; }
.hdf-table td { padding: 10px 14px; color: var(--hdf-text); }
.hdf-table td:not(:first-child) { text-align: center; font-variant-numeric: tabular-nums; }
.hdf-table .hdf-rank { font-weight: 700; color: var(--hdf-primary); }
.hdf-table .hdf-price-cell { font-weight: 700; }
.hdf-table .hdf-tag { font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 4px; text-transform: uppercase; }
.hdf-table .hdf-tag.cheap  { background: #f0fdf4; color: var(--hdf-green); }
.hdf-table .hdf-tag.exp    { background: #fff1f2; color: var(--hdf-red); }

/* ── Callout / Read Also ── */
.hdf-callout { border-left: 3px solid var(--hdf-primary); background: #f0f6ff; border-radius: 0 var(--hdf-radius) var(--hdf-radius) 0; padding: 10px 14px; margin: 20px 0; font-size: 13px; }
.hdf-callout .hdf-callout-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--hdf-muted); }
.hdf-callout a { color: var(--hdf-primary); font-weight: 600; text-decoration: none; font-size: 14px; }
.hdf-callout a:hover { text-decoration: underline; }

/* ── Info box ── */
.hdf-info { background: #f0f9ff; border: 1px solid #bae6fd; border-radius: var(--hdf-radius); padding: 12px 16px; font-size: 13px; color: #0c4a6e; line-height: 1.6; margin: 16px 0; }

/* ── Source badge ── */
.hdf-source { display: inline-block; background: #fffbe6; border: 1px solid #ffe58f; border-radius: 4px; padding: 2px 8px; font-size: 11px; color: #92400e; font-weight: 600; margin: 8px 0; }

/* ── FAQ ── */
.hdf-faq { margin: 28px 0; }
.hdf-faq h2 { font-size: 18px; font-weight: 700; border-bottom: 2px solid var(--hdf-border); padding-bottom: 10px; margin-bottom: 0; }
.hdf-faq-item { border-bottom: 1px solid var(--hdf-border); padding: 14px 0; }
.hdf-faq-item h3 { margin: 0 0 6px; font-size: 14px; font-weight: 700; color: var(--hdf-text); }
.hdf-faq-item p { margin: 0; font-size: 13px; color: #374151; line-height: 1.7; }

/* ── Breadcrumb ── */
.hdf-breadcrumb { font-size: 12px; color: var(--hdf-muted); margin-bottom: 16px; }
.hdf-breadcrumb a { color: var(--hdf-primary); text-decoration: none; }
.hdf-breadcrumb a:hover { text-decoration: underline; }
.hdf-breadcrumb span { margin: 0 5px; opacity: .5; }

/* ── Stat pills (standalone) ── */
.hdf-pills { display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
.hdf-pill-item { background: #f0f6ff; border: 1px solid #cce0ff; border-radius: 20px; padding: 5px 14px; font-size: 12px; color: var(--hdf-primary); font-weight: 600; }

/* ── Mobile ── */
@media (max-width: 640px) {
  .hdf-hero { padding: 18px; }
  .hdf-hero-price { font-size: 28px; }
  .hdf-hero-top { flex-direction: column; }
}
```

---

### `public/wp-assets/hdf-widgets.js`

```js
/**
 * HDF Price Widgets
 * Finds [data-hdf] elements in post content and hydrates them with live data.
 * Replace HDF_API_BASE with your Node.js app URL.
 */
(function () {
  const API = (window.HDF_API_BASE || 'https://YOUR-HOSTINGER-APP-URL') + '/api/public';

  function fmt(n, decimals = 2) {
    if (n == null || isNaN(n)) return '—';
    return '₹' + Number(n).toLocaleString('en-IN', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  function timeAgo(iso) {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    return `${Math.floor(mins / 60)}h ago`;
  }

  async function fetchData(endpoint, params) {
    const url = `${API}/${endpoint}?${new URLSearchParams(params)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    const json = await res.json();
    if (!json.ok) throw new Error('no data');
    return json.data;
  }

  // ── Renderers ──────────────────────────────────────────────────────────

  function renderTable(caption, headers, rows) {
    const ths = headers.map((h, i) => `<th${i > 0 ? '' : ''}>${h}</th>`).join('');
    const trs = rows.map(r =>
      `<tr>${r.map((c, i) => `<td${i > 0 ? '' : ''}>${c}</td>`).join('')}</tr>`
    ).join('');
    return `<div class="hdf-table-wrap">
<table class="hdf-table" role="table">
<caption>${caption}</caption>
<thead><tr>${ths}</tr></thead>
<tbody>${trs}</tbody>
</table></div>`;
  }

  function renderHero(title, price, unit, pills, subtitle) {
    const pillsHtml = pills.map(p =>
      `<span class="hdf-pill"><strong>${p.value}</strong> ${p.label}</span>`
    ).join('');
    return `<div class="hdf-hero">
<div class="hdf-hero-top">
  <div>
    <span class="hdf-live"><i></i>Live</span>
    <div style="font-size:20px;font-weight:800;margin-top:10px;color:#fff">${title}</div>
    <div class="hdf-hero-meta">${subtitle}</div>
  </div>
  <div>
    <div class="hdf-hero-price">${price}</div>
    <div class="hdf-hero-unit">${unit}</div>
  </div>
</div>
<div class="hdf-hero-pills">${pillsHtml}</div>
</div>`;
  }

  // ── Widget handlers ───────────────────────────────────────────────────

  const widgets = {

    // <div data-hdf="price-box" data-module="metals" data-city="Mumbai" data-metal="gold"></div>
    async 'price-box'(el) {
      const { module, city, metal, fuel } = el.dataset;
      const data = await fetchData('price', { module, city, metal: metal || fuel });
      const price = module === 'metals' ? fmt(data.price_per_gram) : fmt(data.price);
      const unit = module === 'metals' ? 'per gram' : 'per litre';
      el.innerHTML = renderHero(
        `${metal || fuel} price in ${city}`,
        price, unit,
        [{ value: price, label: unit }, { value: data.state_name, label: '' }],
        `Updated ${timeAgo(data.fetched_at)}`
      );
    },

    // <div data-hdf="price-table" data-module="metals" data-state="Maharashtra" data-metal="gold"></div>
    // <div data-hdf="price-table" data-module="fuel" data-state="Maharashtra"></div>
    async 'price-table'(el) {
      const { module, state, metal } = el.dataset;
      const rows = await fetchData('state', { module, state, metal });
      const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

      let tableRows, headers;
      if (module === 'metals') {
        headers = ['City', `${metal} (per gram)`, 'Updated'];
        tableRows = rows.map(r => [r.city_name, fmt(r.price_per_gram), timeAgo(r.fetched_at)]);
      } else {
        // group by city: one row per city with petrol + diesel
        const byCity = {};
        rows.forEach(r => { byCity[r.city_name] = byCity[r.city_name] || {}; byCity[r.city_name][r.fuel_type] = r.price; });
        headers = ['City', 'Petrol (₹/L)', 'Diesel (₹/L)'];
        tableRows = Object.entries(byCity).map(([city, p]) => [city, fmt(p.petrol), fmt(p.diesel)]);
      }
      el.innerHTML = renderTable(`${metal || 'Fuel'} Price in ${state} — ${today}`, headers, tableRows);
    },

    // <div data-hdf="ranking" data-module="metals" data-metal="gold" data-sort="asc" data-limit="10" data-label="Cheapest Gold Cities in India"></div>
    async 'ranking'(el) {
      const { module, metal, fuel, sort = 'asc', limit = 10, label } = el.dataset;
      const rows = await fetchData('ranking', { module, metal: metal || fuel, sort, limit });
      const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

      const isMetals = module === 'metals';
      const headers = ['#', 'City', 'State', isMetals ? 'Price (per gram)' : 'Price (per litre)', ''];
      const tableRows = rows.map((r, i) => {
        const price = isMetals ? fmt(r.price_per_gram) : fmt(r.price);
        const tag = i === 0
          ? `<span class="hdf-tag cheap">Lowest</span>`
          : i === rows.length - 1 && sort === 'asc'
            ? `<span class="hdf-tag exp">Highest</span>`
            : '';
        return [`<span class="hdf-rank">${i + 1}</span>`, r.city_name, r.state_name, `<span class="hdf-price-cell">${price}</span>`, tag];
      });

      el.innerHTML = renderTable(
        label || `${sort === 'asc' ? 'Cheapest' : 'Most Expensive'} ${metal || fuel} Cities — ${today}`,
        headers, tableRows
      );
    },

    // <div data-hdf="national" data-module="metals" data-metal="gold"></div>
    async 'national'(el) {
      const { module, metal } = el.dataset;
      const data = await fetchData('national', { module, metal });
      const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

      if (module === 'metals') {
        const avg = fmt(data.avg_price);
        el.innerHTML = renderHero(
          `${metal} Price in India Today`,
          avg, 'avg per gram',
          [
            { value: data.city_count, label: 'cities' },
            { value: data.state_count, label: 'states' },
            { value: fmt(data.min_price), label: 'lowest' },
            { value: fmt(data.max_price), label: 'highest' },
          ],
          `${today} · Source: IBJA`
        );
      } else {
        const petrolAvg = fmt(data.petrol?.avg_price);
        el.innerHTML = renderHero(
          `Petrol & Diesel Price in India Today`,
          petrolAvg, 'avg petrol/litre',
          [
            { value: petrolAvg, label: 'Petrol/L' },
            { value: fmt(data.diesel?.avg_price), label: 'Diesel/L' },
            { value: data.petrol?.city_count, label: 'cities' },
          ],
          `${today} · IOCL / HPCL / BPCL`
        );
      }
    },
  };

  // ── Boot ───────────────────────────────────────────────────────────────

  function hydrate() {
    document.querySelectorAll('[data-hdf]').forEach(async (el) => {
      const type = el.dataset.hdf;
      if (!widgets[type]) return;
      el.setAttribute('data-loading', '1');
      el.classList.add('hdf-widget');
      try {
        await widgets[type](el);
      } catch (e) {
        // Silently keep whatever static HTML was inside the element (SEO snapshot)
        console.warn('HDF widget error:', type, e.message);
      } finally {
        el.removeAttribute('data-loading');
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hydrate);
  } else {
    hydrate();
  }
})();
```

---

## Part 3 — WordPress Setup (one-time, done by hand)

Add this snippet to your WordPress theme's `functions.php` (or a must-use plugin at `wp-content/mu-plugins/hdf-widgets.php`):

```php
<?php
// HDF Price Widgets — enqueue global assets
function hdf_enqueue_widgets() {
    wp_enqueue_style(
        'hdf-widgets',
        'https://YOUR-HOSTINGER-APP-URL/wp-assets/hdf-widgets.css',
        [], '1.0'
    );
    wp_enqueue_script(
        'hdf-widgets',
        'https://YOUR-HOSTINGER-APP-URL/wp-assets/hdf-widgets.js',
        [], '1.0', true
    );
    // Pass API base URL to JS (so the script knows where to fetch)
    wp_localize_script('hdf-widgets', 'HDF_API_BASE', 'https://YOUR-HOSTINGER-APP-URL');
}
add_action('wp_enqueue_scripts', 'hdf_enqueue_widgets');
```

Replace `YOUR-HOSTINGER-APP-URL` with your actual Node.js app domain (e.g. `https://autopub.hdfindia.com`).

Also serve the static files from Express. In `src/app.js` or wherever Express is set up:

```js
const path = require('path');
app.use('/wp-assets', express.static(path.join(__dirname, '../public/wp-assets')));
```

---

## Part 4 — Rewrite Post Creators (minimal HTML)

Now that widgets exist, post HTML becomes pure article text + widget placeholders.

### New rule for all `_build*Content()` methods in `fuel-post-creator.js` and `metals-post-creator.js`:

**Remove:** all inline CSS, all `priceHero()`, all `styledTable()`, all `statPills()` calls

**Replace with:** widget placeholders that include a static SEO snapshot inside them

### How a city post looks now:

```js
_buildCityContent(city, metalType, prices, allCities, stateUrl, nationalUrl) {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' });
  const metal = this.METAL_CONFIG[metalType];
  const primaryVariant = metal.variants[0];
  const primaryPrice = prices[primaryVariant];
  const priceDisplay = primaryPrice ? `₹${primaryPrice.toLocaleString('en-IN')}` : 'N/A';
  const stateCount = [...new Set(allCities.map(c => c.state_name))].length;

  // Static snapshot for SEO (Google crawls this; JS replaces with live data)
  const snapshot = JSON.stringify({ price: primaryPrice, city: city.city_name, metal: metalType });

  return `
<nav class="hdf-breadcrumb" aria-label="Breadcrumb">
  <a href="/">Home</a><span>›</span>
  <a href="${nationalUrl}">${metal.name} Price</a><span>›</span>
  <a href="${stateUrl}">${city.state_name}</a><span>›</span>
  ${city.city_name}
</nav>

<div data-hdf="price-box" data-module="metals" data-city="${city.city_name}" data-metal="${metalType}">
  <!-- SEO snapshot: ${metal.name} price in ${city.city_name} today is ${priceDisplay} per gram -->
  <p><strong>${metal.name} price in ${city.city_name} today</strong> is <strong>${priceDisplay} per gram</strong> (${primaryVariant}) as on ${dateStr}. Source: IBJA.</p>
</div>

<article>

<p>The <strong>${metal.name} price in ${city.city_name}</strong> today is <strong>${priceDisplay} per gram</strong> for ${primaryVariant} ${metal.name} as on <time datetime="${today.toISOString().split('T')[0]}">${dateStr}</time>, sourced from the IBJA (Indian Bullion and Jewellers Association). We track ${metal.name} prices daily across ${allCities.length} cities in ${stateCount} states.</p>

<span class="hdf-source">📊 Source: IBJA — Indian Bullion and Jewellers Association</span>

<h2>${metal.name} Price by Variant in ${city.city_name} — ${dateStr}</h2>

<div data-hdf="price-table" data-module="metals" data-state="${city.state_name}" data-metal="${metalType}">
  <!-- Static fallback table for SEO -->
  <table class="hdf-table"><caption>${metal.name} price in cities near ${city.city_name}</caption>
  <thead><tr><th>City</th><th>Price/gram</th></tr></thead>
  <tbody>
  ${allCities.filter(c => c.state_name === city.state_name).slice(0,5).map(c =>
    `<tr><td>${c.city_name}</td><td>${prices[primaryVariant] ? `₹${prices[primaryVariant].toLocaleString('en-IN')}` : '—'}</td></tr>`
  ).join('')}
  </tbody></table>
</div>

<div class="hdf-callout">
  <div class="hdf-callout-label">Read Also</div>
  <a href="${stateUrl}">${metal.name} Price in ${city.state_name} — All Cities (${dateStr})</a>
</div>

<h2>Factors Affecting ${metal.name} Price in ${city.city_name}</h2>
<p>${metal.name} prices in ${city.city_name} are influenced by global commodity markets, USD/INR exchange rates, import duties (currently 15%), and 3% GST. The IBJA rate is a national benchmark updated each morning and is applicable across all cities including ${city.city_name}.</p>

${this._buildFaq(city.city_name, metal.name, priceDisplay, dateStr, primaryVariant)}

</article>`.trim();
}
```

### FAQ helper (add to each creator class):

```js
_buildFaq(cityOrState, metalName, price, dateStr, variant) {
  const faqs = [
    { q: `What is ${metalName} price in ${cityOrState} today?`,
      a: `The ${metalName} (${variant}) price in ${cityOrState} today is <strong>${price} per gram</strong> as on ${dateStr}, sourced from IBJA.` },
    { q: `Why does ${metalName} price change daily?`,
      a: `${metalName} prices change due to international commodity markets, USD/INR forex rates, import duties, and macroeconomic factors like inflation and central bank policies.` },
    { q: `What is GST on ${metalName} in India?`,
      a: `${metalName} attracts 3% GST in India. Making charges on jewellery attract 5% GST separately.` },
    { q: `Where can I check the latest ${metalName} rate in ${cityOrState}?`,
      a: `You can check the latest ${metalName} rate in ${cityOrState} on this page — prices are updated daily from the IBJA benchmark rate.` },
  ];
  const items = faqs.map(f => `
<div class="hdf-faq-item" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question">
  <h3 itemprop="name">${f.q}</h3>
  <div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer">
    <p itemprop="text">${f.a}</p>
  </div>
</div>`).join('');

  const jsonld = JSON.stringify({
    "@context": "https://schema.org", "@type": "FAQPage",
    "mainEntity": faqs.map(f => ({
      "@type": "Question", "name": f.q,
      "acceptedAnswer": { "@type": "Answer", "text": f.a }
    }))
  });

  return `<section class="hdf-faq" itemscope itemtype="https://schema.org/FAQPage">
<h2>Frequently Asked Questions</h2>${items}
</section>
<script type="application/ld+json">${jsonld}</script>`;
}
```

Apply the same pattern to `_buildStateContent()` and `_buildNationalContent()` — use `data-hdf` widgets instead of inline tables, keep article text lean.

---

## Part 5 — AI Post Generation Template (for future use)

When building the AI content generator, the AI only needs to output this structure:

```
[BREADCRUMB]     — generated by code, not AI
[WIDGET]         — one line placeholder, not AI
[ARTICLE TEXT]   — AI writes this (300-600 words)
[WIDGET]         — one line placeholder, not AI
[CALLOUT]        — generated by code, not AI
[FAQ]            — AI writes Q&A pairs, code wraps them
[SCHEMA]         — generated by code, not AI
```

Example prompt you'll send to the AI for a "Top 10 cheapest gold cities" article:

```
Write a 400-word article about the cheapest cities to buy gold in India today.
Mention that Mumbai, Kolkata, and Chennai tend to have lower rates.
Explain factors like state VAT and local taxes.
DO NOT include any prices or numbers — those will be injected via live data widgets.
Output only the article body paragraphs. No headings, no lists.
```

Then your code wraps it:

```js
const articleText = await openai.generate(prompt);
const postContent = `
<div data-hdf="ranking" data-module="metals" data-metal="gold" data-sort="asc" data-limit="10" data-label="Top 10 Cheapest Cities for Gold in India Today"></div>

<article>
${articleText}
</article>

<div data-hdf="national" data-module="metals" data-metal="gold"></div>
`;
```

That's the entire post. 3 lines of widget markup + AI text. Renders fast, SEO-rich, live data.

---

## Summary

| File | Action |
|------|--------|
| `public/wp-assets/hdf-widgets.css` | CREATE |
| `public/wp-assets/hdf-widgets.js` | CREATE |
| `src/routes/api.js` | ADD `/api/public/*` routes |
| `src/app.js` | ADD `app.use('/wp-assets', express.static(...))` |
| `src/modules/metals-post-creator.js` | REWRITE `_build*Content()` to use widget placeholders |
| `src/modules/fuel-post-creator.js` | REWRITE `_build*Content()` to use widget placeholders |
| WordPress `functions.php` | ADD enqueue snippet (manual, one-time) |

**Post size after this change: ~1–2KB. Previously: ~10–12KB.**
