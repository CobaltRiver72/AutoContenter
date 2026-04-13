# DATA ENRICHMENT PROMPT — FULL PARITY WITH ORIGINAL WP PLUGINS + IMPROVEMENTS

Feed this entire prompt to your AI IDE assistant.

---

## Context

We audited the original `hdf-fuel` and `hdf-metals` WordPress plugins. Our current Node.js posts are missing
significant data sections that the original plugins showed readers. This prompt restores full parity and adds improvements.

**Original WP plugin sections we are MISSING:**

### Metals (city posts):
1. Yesterday's price change (₹ + %) in the hero
2. Gold variant prices (22K, 18K) in the hero card
3. Full weight table (1g → 1kg) × all variants
4. 7-day price history table (date | price | change ₹ | change %)
5. Price trend chart (7D/30D/90D/1Y/All range buttons)
6. 30-day auto trend paragraph (increased/decreased by ₹X, high/low dates, N increases/decreases)
7. Cross-metal section (gold/silver/platinum pills in same city)
8. Same-state city pills with prices + links
9. Major cities pills with prices + links
10. About pricing section (LBMA → exchange rate → import duty → GST → making charges)

### Fuel (city posts):
1. Yesterday's price change (₹ + %) in the hero
2. Petrol ↔ Diesel toggle link in the hero
3. Fill-up cost calculator (5L / 10L / 20L / Full Tank)
4. Price breakdown table (Base ~45% / Excise ~20% / State VAT / Dealer commission)
5. 7-day price history table
6. Price trend chart (7D/30D/90D/1Y/All)
7. 30-day trend paragraph
8. Cross-fuel link section
9. Same-state city pills with prices

---

## Part 1 — DB: Ensure Daily History Is Preserved

The current `metals_prices` table must store ONE row per city/metal/date (not overwrite).
The current `fuel_prices` table must store ONE row per city/fuel_type/date (not overwrite).

### 1.1 Verify/fix metals_prices schema

In `src/modules/metals.js`, find the `savePrices()` or upsert method.
Change the INSERT to use `INSERT OR IGNORE` (not `INSERT OR REPLACE`) so historical rows are never overwritten:

```js
// In metals.js — savePrices or equivalent method
// Use INSERT OR IGNORE to preserve history
const stmt = this.db.prepare(`
  INSERT OR IGNORE INTO metals_prices
    (city_id, metal_type, price_per_gram, variant, fetched_at, price_date)
  VALUES (?, ?, ?, ?, ?, DATE('now', 'localtime'))
`);
```

If `price_date` column doesn't exist in `metals_prices`, add a migration:
```js
// Add to DB init / migration check
try {
  this.db.exec(`ALTER TABLE metals_prices ADD COLUMN price_date TEXT`);
  this.db.exec(`UPDATE metals_prices SET price_date = DATE(fetched_at) WHERE price_date IS NULL`);
} catch(e) { /* column already exists */ }

// Add unique constraint if not present (use a covering index instead since SQLite can't add constraints after creation)
try {
  this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_metals_history ON metals_prices (city_id, metal_type, variant, price_date)`);
} catch(e) { /* already exists */ }
```

### 1.2 Verify/fix fuel_prices schema

Same pattern for `fuel_prices`:
```js
try {
  this.db.exec(`ALTER TABLE fuel_prices ADD COLUMN price_date TEXT`);
  this.db.exec(`UPDATE fuel_prices SET price_date = DATE(fetched_at) WHERE price_date IS NULL`);
} catch(e) {}

try {
  this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_fuel_history ON fuel_prices (city_id, fuel_type, price_date)`);
} catch(e) {}
```

Run both migrations inside the existing DB init function (wherever `CREATE TABLE` statements live).

---

## Part 2 — New Public API Endpoints

Add to the `/api/public` group in `src/routes/api.js`.

### 2.1 Price with yesterday comparison
Update existing `GET /api/public/price` to include yesterday's price and change:

```js
router.get('/public/price', publicCors, (req, res) => {
  const { module, city, metal, fuel } = req.query;
  try {
    let today, yesterday;
    if (module === 'metals' && city && metal) {
      // Get today's primary variant price
      today = db.prepare(`
        SELECT mc.city_name, mc.state_name, mp.metal_type, mp.price_per_gram as price,
               mp.variant, mp.fetched_at, mp.price_date
        FROM metals_prices mp JOIN metals_cities mc ON mp.city_id = mc.id
        WHERE mc.city_name = ? AND mp.metal_type = ? AND mp.variant = ?
        ORDER BY mp.price_date DESC LIMIT 1
      `).get(city, metal, metal === 'gold' ? '24K' : '1g');

      yesterday = db.prepare(`
        SELECT mp.price_per_gram as price
        FROM metals_prices mp JOIN metals_cities mc ON mp.city_id = mc.id
        WHERE mc.city_name = ? AND mp.metal_type = ? AND mp.variant = ?
          AND mp.price_date < COALESCE(?, DATE('now', 'localtime'))
        ORDER BY mp.price_date DESC LIMIT 1
      `).get(city, metal, metal === 'gold' ? '24K' : '1g', today?.price_date || null);

    } else if (module === 'fuel' && city) {
      const fuelType = fuel || 'petrol';
      today = db.prepare(`
        SELECT fc.city_name, fc.state_name, fp.fuel_type, fp.price, fp.fetched_at, fp.price_date
        FROM fuel_prices fp JOIN fuel_cities fc ON fp.city_id = fc.id
        WHERE fc.city_name = ? AND fp.fuel_type = ?
        ORDER BY fp.price_date DESC LIMIT 1
      `).get(city, fuelType);

      yesterday = db.prepare(`
        SELECT fp.price
        FROM fuel_prices fp JOIN fuel_cities fc ON fp.city_id = fc.id
        WHERE fc.city_name = ? AND fp.fuel_type = ?
          AND fp.price_date < COALESCE(?, DATE('now', 'localtime'))
        ORDER BY fp.price_date DESC LIMIT 1
      `).get(city, fuelType, today?.price_date || null);
    }

    if (!today) return res.json({ ok: false, data: null });

    const change = yesterday ? Math.round((today.price - yesterday.price) * 100) / 100 : 0;
    const changePct = yesterday && yesterday.price > 0
      ? Math.round((change / yesterday.price) * 10000) / 100
      : 0;
    const direction = change > 0 ? 'up' : change < 0 ? 'down' : 'none';

    res.json({
      ok: true,
      data: {
        ...today,
        yesterday_price: yesterday?.price || null,
        change,
        change_pct: changePct,
        direction
      },
      ts: Date.now()
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
```

### 2.2 Price history endpoint
```js
// GET /api/public/history?module=metals&city=Mumbai&metal=gold&days=7
// GET /api/public/history?module=fuel&city=Mumbai&fuel=petrol&days=30
router.get('/public/history', publicCors, (req, res) => {
  const { module, city, metal, fuel, days = 7 } = req.query;
  const limit = Math.min(parseInt(days) || 7, 365);
  try {
    let rows;
    if (module === 'metals' && city && metal) {
      const variant = metal === 'gold' ? '24K' : '1g';
      rows = db.prepare(`
        SELECT mp.price_date, mp.price_per_gram as price, mp.variant
        FROM metals_prices mp JOIN metals_cities mc ON mp.city_id = mc.id
        WHERE mc.city_name = ? AND mp.metal_type = ? AND mp.variant = ?
        ORDER BY mp.price_date DESC LIMIT ?
      `).all(city, metal, variant, limit);
    } else if (module === 'fuel' && city) {
      const fuelType = fuel || 'petrol';
      rows = db.prepare(`
        SELECT fp.price_date, fp.price, fp.fuel_type
        FROM fuel_prices fp JOIN fuel_cities fc ON fp.city_id = fc.id
        WHERE fc.city_name = ? AND fp.fuel_type = ?
        ORDER BY fp.price_date DESC LIMIT ?
      `).all(city, fuelType, limit);
    }

    // Compute day-over-day changes
    const enriched = (rows || []).map((row, i, arr) => {
      const prev = arr[i + 1];
      const change = prev ? Math.round((row.price - prev.price) * 100) / 100 : null;
      const changePct = prev && prev.price > 0
        ? Math.round((change / prev.price) * 10000) / 100
        : null;
      return { ...row, change, change_pct: changePct };
    });

    res.json({ ok: true, data: enriched, ts: Date.now() });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
```

### 2.3 Chart data endpoint (optimised for Chart.js)
```js
// GET /api/public/chart?module=metals&city=Mumbai&metal=gold&days=30
router.get('/public/chart', publicCors, (req, res) => {
  const { module, city, metal, fuel, days = 30 } = req.query;
  const limit = Math.min(parseInt(days) || 30, 365);
  try {
    let rows;
    if (module === 'metals' && city && metal) {
      const variant = metal === 'gold' ? '24K' : '1g';
      rows = db.prepare(`
        SELECT mp.price_date as date, mp.price_per_gram as price
        FROM metals_prices mp JOIN metals_cities mc ON mp.city_id = mc.id
        WHERE mc.city_name = ? AND mp.metal_type = ? AND mp.variant = ?
        ORDER BY mp.price_date ASC
        LIMIT ?
      `).all(city, metal, variant, limit);
    } else if (module === 'fuel' && city) {
      rows = db.prepare(`
        SELECT fp.price_date as date, fp.price
        FROM fuel_prices fp JOIN fuel_cities fc ON fp.city_id = fc.id
        WHERE fc.city_name = ? AND fp.fuel_type = ?
        ORDER BY fp.price_date ASC LIMIT ?
      `).all(city, fuel || 'petrol', limit);
    }

    res.json({
      ok: true,
      labels: (rows || []).map(r => r.date),
      prices: (rows || []).map(r => r.price),
      ts: Date.now()
    });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
```

### 2.4 Cross-metal endpoint
```js
// GET /api/public/cross-metal?city=Mumbai
router.get('/public/cross-metal', publicCors, (req, res) => {
  const { city } = req.query;
  try {
    const metals = ['gold', 'silver', 'platinum'];
    const result = {};
    for (const m of metals) {
      const variant = m === 'gold' ? '24K' : '1g';
      const row = db.prepare(`
        SELECT mp.price_per_gram as price, mp.metal_type, mp.fetched_at
        FROM metals_prices mp JOIN metals_cities mc ON mp.city_id = mc.id
        WHERE mc.city_name = ? AND mp.metal_type = ? AND mp.variant = ?
        ORDER BY mp.price_date DESC LIMIT 1
      `).get(city, m, variant);
      result[m] = row ? row.price : null;
    }
    res.json({ ok: true, data: result, ts: Date.now() });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
```

### 2.5 State cities endpoint
```js
// GET /api/public/state-cities?module=metals&state=Maharashtra&metal=gold&limit=15
// GET /api/public/state-cities?module=fuel&state=Maharashtra&fuel=petrol&limit=15
router.get('/public/state-cities', publicCors, (req, res) => {
  const { module, state, metal, fuel, limit = 15 } = req.query;
  const cap = Math.min(parseInt(limit) || 15, 50);
  try {
    let rows;
    if (module === 'metals' && state && metal) {
      const variant = metal === 'gold' ? '24K' : '1g';
      rows = db.prepare(`
        SELECT mc.city_name, mp.price_per_gram as price, mp.fetched_at
        FROM metals_prices mp JOIN metals_cities mc ON mp.city_id = mc.id
        WHERE mc.state_name = ? AND mp.metal_type = ? AND mp.variant = ?
          AND mp.price_date = (
            SELECT MAX(mp2.price_date) FROM metals_prices mp2
            WHERE mp2.city_id = mp.city_id AND mp2.metal_type = mp.metal_type AND mp2.variant = mp.variant
          )
        ORDER BY mc.city_name LIMIT ?
      `).all(state, metal, variant, cap);
    } else if (module === 'fuel' && state) {
      const fuelType = fuel || 'petrol';
      rows = db.prepare(`
        SELECT fc.city_name, fp.price, fp.fetched_at
        FROM fuel_prices fp JOIN fuel_cities fc ON fp.city_id = fc.id
        WHERE fc.state_name = ? AND fp.fuel_type = ?
          AND fp.price_date = (
            SELECT MAX(fp2.price_date) FROM fuel_prices fp2
            WHERE fp2.city_id = fp.city_id AND fp2.fuel_type = fp.fuel_type
          )
        ORDER BY fc.city_name LIMIT ?
      `).all(state, fuelType, cap);
    }
    res.json({ ok: true, data: rows || [], ts: Date.now() });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
```

---

## Part 3 — WordPress: Add Chart.js

In `functions.php`, add Chart.js CDN before our widget script:

```php
function hdf_enqueue_widgets() {
    // Chart.js — only load on singular posts
    if ( is_singular() ) {
        wp_enqueue_script(
            'chartjs',
            'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js',
            [], '4.4.1', true
        );
    }
    wp_enqueue_style('hdf-widgets', 'https://YOUR-APP-URL/wp-assets/hdf-widgets.css', [], '1.1');
    wp_enqueue_script('hdf-widgets', 'https://YOUR-APP-URL/wp-assets/hdf-widgets.js', ['chartjs'], '1.1', true);
    wp_localize_script('hdf-widgets', 'HDF_API_BASE', 'https://YOUR-APP-URL');
}
```

---

## Part 4 — New CSS for New Widgets

Append to `public/wp-assets/hdf-widgets.css`:

```css
/* ── Hero change delta ── */
.hdf-hero-delta { display:inline-flex; align-items:center; gap:5px; border-radius:20px; padding:4px 12px; font-size:12px; font-weight:700; margin-top:8px; }
.hdf-hero-delta.up   { background:#f0fdf4; border:1px solid #bbf7d0; color:#16a34a; }
.hdf-hero-delta.down { background:#fff1f2; border:1px solid #fecdd3; color:#dc2626; }
.hdf-hero-delta.none { background:var(--hdf-surface); border:1px solid var(--hdf-border); color:var(--hdf-muted); }

/* ── Fuel toggle ── */
.hdf-fuel-toggle { display:inline-flex; align-items:center; gap:8px; background:rgba(255,255,255,.1); border:1px solid rgba(255,255,255,.2); border-radius:8px; padding:8px 16px; margin-top:12px; text-decoration:none; color:#fff; font-size:13px; font-weight:600; }
.hdf-fuel-toggle:hover { background:rgba(255,255,255,.2); }
.hdf-fuel-toggle .hdf-alt-price { font-size:16px; font-weight:800; }

/* ── History table change cells ── */
.hdf-table .hdf-td-up   { color:#16a34a; font-weight:600; }
.hdf-table .hdf-td-down { color:#dc2626; font-weight:600; }
.hdf-table .hdf-td-flat { color:var(--hdf-muted); }
.hdf-table .hdf-row-today td { font-weight:700; background:#f0f6ff !important; }

/* ── Price chart ── */
.hdf-chart-section { margin:24px 0; }
.hdf-chart-ranges { display:flex; gap:6px; margin-bottom:12px; flex-wrap:wrap; }
.hdf-range-btn { background:var(--hdf-surface); border:1px solid var(--hdf-border); border-radius:6px; padding:5px 12px; font-size:12px; font-weight:600; cursor:pointer; color:var(--hdf-text); transition:all .15s; }
.hdf-range-btn:hover, .hdf-range-btn.active { background:var(--hdf-primary); border-color:var(--hdf-primary); color:#fff; }
.hdf-chart-canvas-wrap { position:relative; height:260px; border:1px solid var(--hdf-border); border-radius:var(--hdf-radius); padding:12px; background:var(--hdf-bg); }
.hdf-chart-caption { font-size:11px; color:var(--hdf-muted); margin-top:6px; text-align:center; }

/* ── Fill-up calculator ── */
.hdf-fillup-grid { display:grid; grid-template-columns:repeat(2,1fr); gap:10px; margin:12px 0; }
@media(min-width:480px){ .hdf-fillup-grid { grid-template-columns:repeat(4,1fr); } }
.hdf-fillup-item { background:var(--hdf-surface); border:1px solid var(--hdf-border); border-radius:var(--hdf-radius); padding:14px 10px; text-align:center; }
.hdf-fillup-item.highlight { background:#f0f6ff; border-color:#cce0ff; }
.hdf-fillup-qty { display:block; font-size:13px; color:var(--hdf-muted); margin-bottom:4px; }
.hdf-fillup-cost { display:block; font-size:20px; font-weight:800; color:var(--hdf-text); }

/* ── City pills ── */
.hdf-city-pills { display:flex; flex-wrap:wrap; gap:8px; margin:12px 0; }
.hdf-city-pill { display:inline-flex; flex-direction:column; align-items:center; background:var(--hdf-surface); border:1px solid var(--hdf-border); border-radius:var(--hdf-radius); padding:8px 14px; text-decoration:none; transition:all .15s; min-width:90px; }
.hdf-city-pill:hover { border-color:var(--hdf-primary); background:#f0f6ff; }
.hdf-city-pill .hdf-pill-name { font-size:12px; font-weight:600; color:var(--hdf-text); }
.hdf-city-pill .hdf-pill-val  { font-size:14px; font-weight:800; color:var(--hdf-primary); margin-top:2px; }

/* ── Trend analysis ── */
.hdf-trend-analysis { background:var(--hdf-surface); border:1px solid var(--hdf-border); border-radius:var(--hdf-radius); padding:16px; margin:20px 0; }
.hdf-trend-analysis h2 { margin-top:0; font-size:16px; }
.hdf-trend-analysis p { margin:0; font-size:14px; line-height:1.7; color:#374151; }

/* ── Gold variant hero pills ── */
.hdf-variant-pills { display:flex; gap:10px; flex-wrap:wrap; margin-top:10px; }
.hdf-variant-pill { background:rgba(255,255,255,.1); border:1px solid rgba(255,255,255,.25); border-radius:8px; padding:6px 14px; }
.hdf-variant-pill .hdf-vp-label { display:block; font-size:10px; opacity:.7; font-weight:600; text-transform:uppercase; letter-spacing:.5px; }
.hdf-variant-pill .hdf-vp-price { display:block; font-size:15px; font-weight:800; color:#fff; }
```

---

## Part 5 — New Widget Handlers in hdf-widgets.js

Add these new widget handlers to the `widgets` object inside `hdf-widgets.js`:

```js
// ── 7-day history table ──
// <div data-hdf="price-history" data-module="metals" data-city="Mumbai" data-metal="gold" data-days="7"></div>
async 'price-history'(el) {
  const { module, city, metal, fuel, days = '7' } = el.dataset;
  const rows = await fetchData('history', { module, city, metal: metal || fuel, fuel, days });
  if (!rows || !rows.length) { el.innerHTML = '<p class="hdf-info">No history data available yet.</p>'; return; }

  const today = new Date().toISOString().split('T')[0];
  const isMetals = module === 'metals';
  const caption = `${(metal || fuel || '').charAt(0).toUpperCase() + (metal || fuel || '').slice(1)} Price — Last ${days} Days`;
  const headers = ['Date', 'Price', 'Change', '%'];

  const tableRows = rows.map((r, i) => {
    const isToday = r.price_date === today;
    const priceCell = `<span style="font-weight:700">${fmt(r.price, isMetals ? 2 : 2)}</span>`;

    let changeCell = '—', pctCell = '—', tdClass = 'hdf-td-flat';
    if (r.change !== null) {
      const arrow = r.change > 0 ? '▲' : r.change < 0 ? '▼' : '—';
      tdClass = r.change > 0 ? 'hdf-td-up' : r.change < 0 ? 'hdf-td-down' : 'hdf-td-flat';
      changeCell = `<span class="${tdClass}">${arrow} ${fmt(Math.abs(r.change))}</span>`;
      pctCell = `<span class="${tdClass}">${r.change > 0 ? '+' : ''}${r.change_pct?.toFixed(2) || '0.00'}%</span>`;
    }
    return [
      `<time datetime="${r.price_date}">${new Date(r.price_date + 'T00:00:00').toLocaleDateString('en-IN', { day:'numeric', month:'short' })}${isToday ? ' <strong>(Today)</strong>' : ''}</time>`,
      priceCell, changeCell, pctCell
    ];
  });

  el.innerHTML = renderTable(caption, headers, tableRows);
  // Highlight today row
  el.querySelectorAll('tbody tr').forEach((tr, i) => {
    if (rows[i]?.price_date === today) tr.style.background = '#f0f6ff';
  });
},

// ── Price chart ──
// <div data-hdf="price-chart" data-module="metals" data-city="Mumbai" data-metal="gold"></div>
async 'price-chart'(el) {
  const { module, city, metal, fuel } = el.dataset;
  const label = (metal || fuel || '').charAt(0).toUpperCase() + (metal || fuel || '').slice(1);
  const unit = module === 'metals' ? '₹/gram' : '₹/litre';

  el.innerHTML = `
<div class="hdf-chart-section">
  <div class="hdf-chart-ranges">
    <button class="hdf-range-btn" data-days="7">7D</button>
    <button class="hdf-range-btn active" data-days="30">30D</button>
    <button class="hdf-range-btn" data-days="90">90D</button>
    <button class="hdf-range-btn" data-days="365">1Y</button>
  </div>
  <div class="hdf-chart-canvas-wrap">
    <canvas id="hdf-chart-${city}-${metal || fuel}"></canvas>
  </div>
  <p class="hdf-chart-caption">${label} price trend in ${city}. Source: ${module === 'metals' ? 'IBJA' : 'IOCL/HPCL/BPCL'}.</p>
</div>`;

  let currentDays = 30;
  let chartInstance = null;

  async function loadChart(days) {
    const data = await fetchData('chart', { module, city, metal: metal || fuel, fuel, days });
    const canvas = el.querySelector('canvas');
    if (!canvas) return;

    if (chartInstance) chartInstance.destroy();

    chartInstance = new Chart(canvas, {
      type: 'line',
      data: {
        labels: data.labels,
        datasets: [{
          label: `${label} Price (${unit})`,
          data: data.prices,
          borderColor: '#2563eb',
          backgroundColor: 'rgba(37,99,235,0.08)',
          borderWidth: 2,
          pointRadius: 3,
          pointHoverRadius: 6,
          fill: true,
          tension: 0.3,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => `${label}: ₹${Number(ctx.raw).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { maxTicksLimit: 8, font: { size: 11 } } },
          y: {
            ticks: {
              callback: val => '₹' + Number(val).toLocaleString('en-IN'),
              font: { size: 11 }
            }
          }
        }
      }
    });
  }

  await loadChart(currentDays);

  el.querySelectorAll('.hdf-range-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      el.querySelectorAll('.hdf-range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentDays = parseInt(btn.dataset.days);
      await loadChart(currentDays);
    });
  });
},

// ── Fill-up calculator (static, uses price from data attribute) ──
// <div data-hdf="fill-up" data-price="102.34" data-fuel="petrol"></div>
'fill-up'(el) {
  const price = parseFloat(el.dataset.price) || 0;
  const fuel = el.dataset.fuel || 'petrol';
  const tankSize = fuel === 'petrol' ? 45 : 55;
  const items = [
    { label: '5 Litres', litres: 5 },
    { label: '10 Litres', litres: 10 },
    { label: '20 Litres', litres: 20 },
    { label: `Full Tank (${tankSize}L)`, litres: tankSize, highlight: true },
  ];
  const cards = items.map(item =>
    `<div class="hdf-fillup-item${item.highlight ? ' highlight' : ''}">
      <span class="hdf-fillup-qty">${item.label}</span>
      <span class="hdf-fillup-cost">₹${(price * item.litres).toFixed(2)}</span>
    </div>`
  ).join('');
  el.innerHTML = `<div class="hdf-fillup-grid">${cards}</div>`;
},

// ── City pills grid (with live prices) ──
// <div data-hdf="city-pills" data-module="metals" data-state="Maharashtra" data-metal="gold" data-exclude="Mumbai"></div>
async 'city-pills'(el) {
  const { module, state, metal, fuel, exclude, limit = '12' } = el.dataset;
  const rows = await fetchData('state-cities', { module, state, metal: metal || fuel, fuel, limit });
  const filtered = rows.filter(r => r.city_name !== exclude);
  if (!filtered.length) { el.style.display = 'none'; return; }

  const fuelOrMetal = metal || fuel || '';
  const pills = filtered.map(r =>
    `<a class="hdf-city-pill" href="/${fuelOrMetal.toLowerCase()}-price-in-${r.city_name.toLowerCase().replace(/\s+/g, '-')}-today/">
      <span class="hdf-pill-name">${r.city_name}</span>
      <span class="hdf-pill-val">${fmt(r.price)}</span>
    </a>`
  ).join('');
  el.innerHTML = `<div class="hdf-city-pills">${pills}</div>`;
},

// ── Cross-metal pills ──
// <div data-hdf="cross-metal" data-city="Mumbai" data-current="gold"></div>
async 'cross-metal'(el) {
  const { city, current } = el.dataset;
  const data = await fetchData('cross-metal', { city });
  const others = ['gold', 'silver', 'platinum'].filter(m => m !== current);
  const pills = others.map(m => {
    const price = data[m];
    const label = m.charAt(0).toUpperCase() + m.slice(1);
    return `<a class="hdf-city-pill" href="/${m}-price-in-${city.toLowerCase().replace(/\s+/g, '-')}-today/">
      <span class="hdf-pill-name">${label}</span>
      <span class="hdf-pill-val">${price ? fmt(price) + '/g' : '—'}</span>
    </a>`;
  }).join('');
  el.innerHTML = `<div class="hdf-city-pills">${pills}</div>`;
},
```

Also update the existing `price-box` widget to show the delta and gold variants:

```js
async 'price-box'(el) {
  const { module, city, metal, fuel } = el.dataset;
  const fuelType = fuel || 'petrol';
  const data = await fetchData('price', { module, city, metal: metal || fuelType, fuel: fuelType });

  const isMetals = module === 'metals';
  const price = isMetals ? fmt(data.price) : fmt(data.price);
  const unit = isMetals ? 'per gram' : 'per litre';
  const metalLabel = (metal || fuelType).charAt(0).toUpperCase() + (metal || fuelType).slice(1);
  const cityLabel = city.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  // Change delta badge
  let deltaHtml = '';
  if (data.direction === 'up') {
    deltaHtml = `<span class="hdf-hero-delta up">▲ ₹${Math.abs(data.change).toFixed(2)} (+${data.change_pct?.toFixed(2)}%) vs yesterday</span>`;
  } else if (data.direction === 'down') {
    deltaHtml = `<span class="hdf-hero-delta down">▼ ₹${Math.abs(data.change).toFixed(2)} (${data.change_pct?.toFixed(2)}%) vs yesterday</span>`;
  } else {
    deltaHtml = `<span class="hdf-hero-delta none">→ Unchanged from yesterday</span>`;
  }

  // Gold variants
  let variantsHtml = '';
  if (metal === 'gold') {
    // Fetch 22K and 18K separately
    const v22 = await fetchData('price', { module, city, metal: 'gold_22k' }).catch(() => null);
    const v18 = await fetchData('price', { module, city, metal: 'gold_18k' }).catch(() => null);
    if (v22 || v18) {
      variantsHtml = `<div class="hdf-variant-pills">
        ${v22 ? `<div class="hdf-variant-pill"><span class="hdf-vp-label">22K</span><span class="hdf-vp-price">${fmt(v22.price)}</span></div>` : ''}
        ${v18 ? `<div class="hdf-variant-pill"><span class="hdf-vp-label">18K</span><span class="hdf-vp-price">${fmt(v18.price)}</span></div>` : ''}
      </div>`;
    }
  }

  el.innerHTML = renderHero(
    `${metalLabel} Price in ${cityLabel}`,
    price, unit,
    [
      { value: price, label: unit },
      { value: data.state_name || '', label: '' },
    ],
    `Updated ${timeAgo(data.fetched_at)}`
  ) + deltaHtml + variantsHtml;
},
```

---

## Part 6 — Update Post Creators with All Missing Sections

### 6.1 MetalsPostCreator — `_buildCityContent()`

After the existing `<div data-hdf="price-box">` and intro paragraph, add these sections in order:

```js
// Weight table
const weights = metal.name === 'Gold'
  ? [[1,'1 gram'],[2,'2 grams'],[4,'4 grams'],[8,'8 grams'],[10,'10 grams'],[20,'20 grams'],[50,'50 grams'],[100,'100 grams']]
  : [[1,'1 gram'],[10,'10 grams'],[50,'50 grams'],[100,'100 grams'],[500,'500 grams'],[1000,'1 kg']];

const weightHeaders = metalType === 'gold'
  ? ['Weight', '24K', '22K', '18K']
  : ['Weight', 'Price'];

const weightRows = weights.map(([g, label]) => {
  if (metalType === 'gold') {
    return [label,
      prices['24K'] ? `₹${(prices['24K']*g).toLocaleString('en-IN')}` : '—',
      prices['22K'] ? `₹${(prices['22K']*g).toLocaleString('en-IN')}` : '—',
      prices['18K'] ? `₹${(prices['18K']*g).toLocaleString('en-IN')}` : '—',
    ];
  }
  return [label, primaryPrice ? `₹${(primaryPrice*g).toLocaleString('en-IN')}` : '—'];
});
```

Add these widget sections after the main content in the return string:

```js
`
<h2>${metal.name} Price for Different Weights in ${city.city_name}</h2>
<div data-hdf="weight-table" data-module="metals" data-city="${city.city_name}" data-metal="${metalType}">
  ${renderStaticTable(
    `${metal.name} weight prices in ${city.city_name}`,
    weightHeaders,
    weightRows
  )}
</div>

<h2>${metal.name} Price History in ${city.city_name} — Last 7 Days</h2>
<div data-hdf="price-history" data-module="metals" data-city="${city.city_name}" data-metal="${metalType}" data-days="7">
  <p>Loading price history...</p>
</div>

<h2>${metal.name} Price Trend in ${city.city_name}</h2>
<div data-hdf="price-chart" data-module="metals" data-city="${city.city_name}" data-metal="${metalType}">
  <p>Loading chart...</p>
</div>

<h2>Other Metal Prices in ${city.city_name} Today</h2>
<div data-hdf="cross-metal" data-city="${city.city_name}" data-current="${metalType}">
  <p>Loading...</p>
</div>

<h2>${metal.name} Price in Other ${city.state_name} Cities</h2>
<div data-hdf="city-pills" data-module="metals" data-state="${city.state_name}" data-metal="${metalType}" data-exclude="${city.city_name}" data-limit="15">
  <p>Loading...</p>
</div>

<h2>${metal.name} Price in Major Indian Cities</h2>
<div data-hdf="ranking" data-module="metals" data-metal="${metalType}" data-sort="asc" data-limit="10" data-label="${metal.name} Price in Major Indian Cities Today">
  <p>Loading...</p>
</div>

<h2>How ${metal.name} Price Is Calculated</h2>
<p>The final ${metal.name} price you pay at a jeweller in ${city.city_name} includes several components:</p>
<div class="hdf-table-wrap">
<table class="hdf-table">
<thead><tr><th>Component</th><th>Details</th></tr></thead>
<tbody>
<tr><td><strong>International Spot Price</strong></td><td>Set by the London Bullion Market Association (LBMA) in USD per troy ounce</td></tr>
<tr><td><strong>USD/INR Exchange Rate</strong></td><td>Converts the international price to Indian Rupees daily</td></tr>
<tr><td><strong>Import Duty</strong></td><td>Currently 15% on ${metal.name} imported into India</td></tr>
<tr><td><strong>GST</strong></td><td>${metalType === 'gold' ? '3% on gold + 5% on making charges' : '3% on purchase price'}</td></tr>
<tr><td><strong>Making Charges</strong></td><td>8%–35% of metal value (set by jeweller, varies by design)</td></tr>
</tbody>
</table>
</div>
<div class="hdf-info">💡 The IBJA (Indian Bullion and Jewellers Association) publishes benchmark rates daily. Retail prices in ${city.city_name} may include a small dealer premium above the IBJA rate.</div>
`
```

### 6.2 FuelPostCreator — `_buildCityContent()`

Add after the intro paragraph:

```js
`
<h2>Fill-Up Cost in ${city.city_name} — ${dateStr}</h2>
<div data-hdf="fill-up" data-price="${prices.petrol || prices.diesel || 0}" data-fuel="${fuelType}">
</div>

<h2>How ${fuelType.charAt(0).toUpperCase()+fuelType.slice(1)} Price Is Calculated in ${city.city_name}</h2>
<div class="hdf-table-wrap">
<table class="hdf-table">
<caption>Price breakdown for ${city.city_name}, ${city.state_name}</caption>
<thead><tr><th>Component</th><th>Approx. Share</th></tr></thead>
<tbody>
<tr><td>Base Price (Refinery)</td><td>~45–50%</td></tr>
<tr><td>Central Excise Duty</td><td>~20–25%</td></tr>
<tr><td>State VAT (${city.state_name})</td><td>${stateInfo?.vatPetrol || '—'}%</td></tr>
<tr><td>Dealer Commission</td><td>~3–4%</td></tr>
<tr><td><strong>Retail Price</strong></td><td><strong>₹${prices.petrol?.toFixed(2) || '—'}</strong></td></tr>
</tbody>
</table>
</div>

<h2>${fuelType.charAt(0).toUpperCase()+fuelType.slice(1)} Price History in ${city.city_name} — Last 7 Days</h2>
<div data-hdf="price-history" data-module="fuel" data-city="${city.city_name}" data-fuel="${fuelType}" data-days="7">
  <p>Loading price history...</p>
</div>

<h2>${fuelType.charAt(0).toUpperCase()+fuelType.slice(1)} Price Trend in ${city.city_name}</h2>
<div data-hdf="price-chart" data-module="fuel" data-city="${city.city_name}" data-fuel="${fuelType}">
  <p>Loading chart...</p>
</div>

<h2>${fuelType.charAt(0).toUpperCase()+fuelType.slice(1)} Price in Other ${city.state_name} Cities</h2>
<div data-hdf="city-pills" data-module="fuel" data-state="${city.state_name}" data-fuel="${fuelType}" data-exclude="${city.city_name}" data-limit="15">
  <p>Loading...</p>
</div>
`
```

Also add a small helper `renderStaticTable()` to `metals-post-creator.js` and `fuel-post-creator.js`:

```js
renderStaticTable(caption, headers, rows) {
  const ths = headers.map(h => `<th>${h}</th>`).join('');
  const trs = rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('');
  return `<div class="hdf-table-wrap">
<table class="hdf-table">
<caption>${caption}</caption>
<thead><tr>${ths}</tr></thead>
<tbody>${trs}</tbody>
</table></div>`;
}
```

---

## Part 7 — DB migration for 22K and 18K variant support

The `/api/public/price` endpoint supports `metal=gold_22k` and `metal=gold_18k` for fetching those variants.
In the price endpoint handler, map these aliases:

```js
const variantMap = {
  'gold':     { metal: 'gold', variant: '24K' },
  'gold_24k': { metal: 'gold', variant: '24K' },
  'gold_22k': { metal: 'gold', variant: '22K' },
  'gold_18k': { metal: 'gold', variant: '18K' },
  'silver':   { metal: 'silver', variant: '1g' },
  'platinum': { metal: 'platinum', variant: '1g' },
};
const { metal: metalType, variant } = variantMap[metal] || { metal, variant: '1g' };
```

---

## Summary of Files Changed

| File | Changes |
|------|---------|
| `src/routes/api.js` | Add `/api/public/history`, `/api/public/chart`, `/api/public/cross-metal`, `/api/public/state-cities`; update `/api/public/price` with yesterday comparison + variant map |
| `src/modules/metals.js` (or DB init) | Add `price_date` column migration + unique index on metals_prices |
| `src/modules/fuel.js` (or DB init) | Add `price_date` column migration + unique index on fuel_prices |
| `public/wp-assets/hdf-widgets.css` | Append new styles (delta, chart, fill-up, city pills, variants) |
| `public/wp-assets/hdf-widgets.js` | Add `price-history`, `price-chart`, `fill-up`, `city-pills`, `cross-metal` widgets; update `price-box` with delta + gold variants |
| `src/modules/metals-post-creator.js` | Add weight table, history widget, chart widget, cross-metal, city pills, price breakdown sections |
| `src/modules/fuel-post-creator.js` | Add fill-up calc, price breakdown table, history widget, chart widget, city pills sections |
| `functions.php` (WordPress) | Add Chart.js CDN dependency before hdf-widgets.js |

**After deploying:** Republish a few posts, verify chart loads (requires at least 2 days of historical data),
verify fill-up calculator shows correct numbers, verify city pills link to correct post URLs.
