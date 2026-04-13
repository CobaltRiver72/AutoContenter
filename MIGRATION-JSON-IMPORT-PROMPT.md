# JSON IMPORT PROMPT

Feed this entire prompt to your AI IDE assistant.

---

## What We're Adding

Extend the existing import system (built in MIGRATION-CSV-IMPORT-FIX-PROMPT.md) to also accept
`.json` files. The routes, multer setup, and dashboard already exist — we are **adding** JSON support
alongside CSV, not replacing it.

Both CSV and JSON imports use the same table structure, same `INSERT OR IGNORE` dedup logic,
and same `price_date` column introduced in MIGRATION-DATA-ENRICHMENT-PROMPT.md.

---

## JSON Data Formats

### Fuel JSON

```json
[
  {
    "city": "Delhi",
    "state": "Delhi",
    "petrol": 96.72,
    "diesel": 89.62,
    "price_date": "2025-01-15",
    "source": "api1"
  },
  {
    "city": "Mumbai",
    "state": "Maharashtra",
    "petrol": 106.31,
    "diesel": 94.27,
    "price_date": "2025-01-15"
  }
]
```

Required fields: `city`, `price_date`
Optional fields: `state` (ignored — we use city lookup), `source` (defaults to `"imported"`)
Price fields: `petrol`, `diesel` — include whichever are present

### Metals JSON

```json
[
  {
    "city": "Delhi",
    "state": "Delhi",
    "metal_type": "gold",
    "price_24k": 7245.50,
    "price_22k": 6641.67,
    "price_18k": 4979.85,
    "price_1g": null,
    "price_date": "2025-01-15",
    "source": "api1"
  },
  {
    "city": "Delhi",
    "state": "Delhi",
    "metal_type": "silver",
    "price_24k": null,
    "price_22k": null,
    "price_18k": null,
    "price_1g": 85.50,
    "price_date": "2025-01-15"
  }
]
```

Required fields: `city`, `metal_type`, `price_date`
Optional: `source` (defaults to `"imported"`)
Price fields: `price_24k`, `price_22k`, `price_18k`, `price_1g` — include whichever are present, null/missing values are skipped

---

## Part 1 — Add JSON import routes to `src/routes/api.js`

Add these two new routes **after** the existing `/api/import/fuel` and `/api/import/metals` CSV routes.
The `upload` multer instance and `db` reference are already in scope — reuse them.

```js
// ── Import Fuel JSON ───────────────────────────────────────────────────────
// POST /api/import/fuel-json  — multipart upload, field name: "file"
router.post('/import/fuel-json', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });

  const dryRun = req.query.dry === '1' || req.query.dry === 'true';

  let rows;
  try {
    const text = req.file.buffer.toString('utf8');
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('JSON must be an array of objects');
    rows = parsed;
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'JSON parse failed: ' + e.message });
  }

  if (!rows.length) {
    return res.json({ ok: true, dryRun, stats: { total: 0, inserted: 0, skipped: 0, errors: [] }, message: 'No rows in file' });
  }

  // Validate first row has required fields
  const first = rows[0];
  const missing = ['city', 'price_date'].filter(k => !(k in first));
  if (missing.length) {
    return res.status(400).json({ ok: false, error: 'Missing fields in JSON objects: ' + missing.join(', ') });
  }

  const stats = { total: 0, inserted: 0, skipped: 0, errors: [] };

  const getCityId  = db.prepare('SELECT id FROM fuel_cities WHERE city_name = ?');
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO fuel_prices (city_id, fuel_type, price, price_date, fetched_at, source)
    VALUES (?, ?, ?, ?, datetime('now'), ?)
  `);

  const runImport = db.transaction((rows) => {
    for (const row of rows) {
      stats.total++;

      const dateVal = row.price_date ? String(row.price_date).trim() : '';
      if (!dateVal || !/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) {
        stats.errors.push(`Row ${stats.total}: invalid date "${dateVal}"`);
        stats.skipped++;
        continue;
      }

      const cityRow = getCityId.get(String(row.city || '').trim());
      if (!cityRow) {
        stats.skipped++;
        continue;
      }

      const source = row.source ? String(row.source).trim() : 'imported';

      // Insert petrol
      const petrol = parseFloat(row.petrol);
      if (!isNaN(petrol) && petrol > 0) {
        if (!dryRun) {
          const r = insertStmt.run(cityRow.id, 'petrol', petrol, dateVal, source);
          r.changes > 0 ? stats.inserted++ : stats.skipped++;
        } else {
          stats.inserted++;
        }
      }

      // Insert diesel
      const diesel = parseFloat(row.diesel);
      if (!isNaN(diesel) && diesel > 0) {
        if (!dryRun) {
          const r = insertStmt.run(cityRow.id, 'diesel', diesel, dateVal, source);
          r.changes > 0 ? stats.inserted++ : stats.skipped++;
        } else {
          stats.inserted++;
        }
      }
    }
  });

  try {
    runImport(rows);
    res.json({
      ok: true,
      dryRun,
      stats,
      message: dryRun
        ? `Dry run: would insert ~${stats.inserted} rows from ${stats.total} JSON objects`
        : `Imported ${stats.inserted} rows (${stats.skipped} skipped) from ${stats.total} JSON objects`
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, stats });
  }
});


// ── Import Metals JSON ─────────────────────────────────────────────────────
// POST /api/import/metals-json  — multipart upload, field name: "file"
router.post('/import/metals-json', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });

  const dryRun = req.query.dry === '1' || req.query.dry === 'true';

  let rows;
  try {
    const text = req.file.buffer.toString('utf8');
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('JSON must be an array of objects');
    rows = parsed;
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'JSON parse failed: ' + e.message });
  }

  if (!rows.length) {
    return res.json({ ok: true, dryRun, stats: { total: 0, inserted: 0, skipped: 0, errors: [] }, message: 'No rows in file' });
  }

  const first = rows[0];
  const missing = ['city', 'metal_type', 'price_date'].filter(k => !(k in first));
  if (missing.length) {
    return res.status(400).json({ ok: false, error: 'Missing fields in JSON objects: ' + missing.join(', ') });
  }

  const stats = { total: 0, inserted: 0, skipped: 0, errors: [] };

  const getCityId  = db.prepare('SELECT id FROM metals_cities WHERE city_name = ?');
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO metals_prices (city_id, metal_type, variant, price_per_gram, price_date, fetched_at, source)
    VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
  `);

  const variantMap = [
    { key: 'price_24k', variant: '24K' },
    { key: 'price_22k', variant: '22K' },
    { key: 'price_18k', variant: '18K' },
    { key: 'price_1g',  variant: '1g'  },
  ];

  const runImport = db.transaction((rows) => {
    for (const row of rows) {
      stats.total++;

      const dateVal = row.price_date ? String(row.price_date).trim() : '';
      if (!dateVal || !/^\d{4}-\d{2}-\d{2}$/.test(dateVal)) {
        stats.errors.push(`Row ${stats.total}: invalid date "${dateVal}"`);
        stats.skipped++;
        continue;
      }

      const metal = String(row.metal_type || '').toLowerCase().trim();
      if (!['gold', 'silver', 'platinum'].includes(metal)) {
        stats.errors.push(`Row ${stats.total}: unknown metal_type "${row.metal_type}"`);
        stats.skipped++;
        continue;
      }

      const cityRow = getCityId.get(String(row.city || '').trim());
      if (!cityRow) {
        stats.skipped++;
        continue;
      }

      const source = row.source ? String(row.source).trim() : 'imported';
      let anyInserted = false;

      for (const { key, variant } of variantMap) {
        const val = parseFloat(row[key]);
        if (isNaN(val) || val <= 0) continue;

        if (!dryRun) {
          const r = insertStmt.run(cityRow.id, metal, variant, val, dateVal, source);
          if (r.changes > 0) { stats.inserted++; anyInserted = true; }
          else stats.skipped++;
        } else {
          stats.inserted++;
          anyInserted = true;
        }
      }

      if (!anyInserted) stats.skipped++;
    }
  });

  try {
    runImport(rows);
    res.json({
      ok: true,
      dryRun,
      stats,
      message: dryRun
        ? `Dry run: would insert ~${stats.inserted} rows from ${stats.total} JSON objects`
        : `Imported ${stats.inserted} rows (${stats.skipped} skipped) from ${stats.total} JSON objects`
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, stats });
  }
});
```

---

## Part 2 — Update the dashboard Import UI

Find the import section in the dashboard HTML. The current section has two cards (Fuel CSV, Metals CSV).

**Replace the entire import section** with this expanded version that has four cards (2 CSV + 2 JSON):

```html
<!-- Import Section -->
<div class="import-section">
  <h3>Import Historical Price Data</h3>
  <p style="font-size:13px;color:#6b7280;margin-bottom:16px;">
    Upload CSV or JSON exports from the WordPress plugins to backfill price history for trend charts.
    Use <strong>Dry Run</strong> first to verify row counts before committing.
  </p>

  <!-- Tab switcher -->
  <div style="display:flex;gap:4px;margin-bottom:16px;background:#f3f4f6;padding:4px;border-radius:8px;width:fit-content;">
    <button onclick="switchImportTab('csv')" id="importTabCsv"
            style="padding:6px 16px;font-size:13px;border:none;border-radius:6px;cursor:pointer;background:#fff;font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
      CSV
    </button>
    <button onclick="switchImportTab('json')" id="importTabJson"
            style="padding:6px 16px;font-size:13px;border:none;border-radius:6px;cursor:pointer;background:transparent;font-weight:500;">
      JSON
    </button>
  </div>

  <!-- CSV Cards -->
  <div id="importPanelCsv" style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">

    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;">
      <div style="font-size:14px;font-weight:700;margin-bottom:6px;">⛽ Fuel CSV</div>
      <div style="font-size:12px;color:#6b7280;margin-bottom:10px;">
        Columns: <code>city, state, petrol, diesel, price_date, source</code>
      </div>
      <input type="file" id="fuelCsvFile" accept=".csv"
             style="font-size:12px;width:100%;margin-bottom:8px;">
      <div style="display:flex;gap:6px;">
        <button onclick="runImport('fuel','csv',true)"
                style="flex:1;padding:6px;font-size:12px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:6px;cursor:pointer;">
          Dry Run
        </button>
        <button onclick="runImport('fuel','csv',false)"
                style="flex:1;padding:6px;font-size:12px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;">
          Import
        </button>
      </div>
    </div>

    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;">
      <div style="font-size:14px;font-weight:700;margin-bottom:6px;">🥇 Metals CSV</div>
      <div style="font-size:12px;color:#6b7280;margin-bottom:10px;">
        Columns: <code>city, state, metal_type, price_24k, price_22k, price_18k, price_1g, price_date, source</code>
      </div>
      <input type="file" id="metalsCsvFile" accept=".csv"
             style="font-size:12px;width:100%;margin-bottom:8px;">
      <div style="display:flex;gap:6px;">
        <button onclick="runImport('metals','csv',true)"
                style="flex:1;padding:6px;font-size:12px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:6px;cursor:pointer;">
          Dry Run
        </button>
        <button onclick="runImport('metals','csv',false)"
                style="flex:1;padding:6px;font-size:12px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;">
          Import
        </button>
      </div>
    </div>

  </div>

  <!-- JSON Cards -->
  <div id="importPanelJson" style="display:none;grid-template-columns:1fr 1fr;gap:16px;">

    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;">
      <div style="font-size:14px;font-weight:700;margin-bottom:6px;">⛽ Fuel JSON</div>
      <div style="font-size:12px;color:#6b7280;margin-bottom:10px;">
        Array of objects with fields: <code>city, petrol, diesel, price_date</code>
      </div>
      <div style="font-size:11px;color:#9ca3af;background:#fff;border:1px solid #e5e7eb;border-radius:4px;padding:6px;margin-bottom:10px;font-family:monospace;overflow:auto;">
        [{"city":"Delhi","petrol":96.72,"diesel":89.62,"price_date":"2025-01-15"}]
      </div>
      <input type="file" id="fuelJsonFile" accept=".json"
             style="font-size:12px;width:100%;margin-bottom:8px;">
      <div style="display:flex;gap:6px;">
        <button onclick="runImport('fuel','json',true)"
                style="flex:1;padding:6px;font-size:12px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:6px;cursor:pointer;">
          Dry Run
        </button>
        <button onclick="runImport('fuel','json',false)"
                style="flex:1;padding:6px;font-size:12px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;">
          Import
        </button>
      </div>
    </div>

    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;">
      <div style="font-size:14px;font-weight:700;margin-bottom:6px;">🥇 Metals JSON</div>
      <div style="font-size:12px;color:#6b7280;margin-bottom:10px;">
        Array of objects with fields: <code>city, metal_type, price_24k, price_22k, price_18k, price_1g, price_date</code>
      </div>
      <div style="font-size:11px;color:#9ca3af;background:#fff;border:1px solid #e5e7eb;border-radius:4px;padding:6px;margin-bottom:10px;font-family:monospace;overflow:auto;">
        [{"city":"Delhi","metal_type":"gold","price_24k":7245.50,"price_22k":6641.67,"price_18k":4979.85,"price_date":"2025-01-15"}]
      </div>
      <input type="file" id="metalsJsonFile" accept=".json"
             style="font-size:12px;width:100%;margin-bottom:8px;">
      <div style="display:flex;gap:6px;">
        <button onclick="runImport('metals','json',true)"
                style="flex:1;padding:6px;font-size:12px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:6px;cursor:pointer;">
          Dry Run
        </button>
        <button onclick="runImport('metals','json',false)"
                style="flex:1;padding:6px;font-size:12px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;">
          Import
        </button>
      </div>
    </div>

  </div>

  <!-- Result display -->
  <div id="importResult" style="margin-top:12px;display:none;"></div>
</div>
```

---

## Part 3 — Update the dashboard JavaScript

Find the existing `importCsv()` function and the `showImportResult()` helper in the dashboard JS.

**Replace `importCsv()` with the new unified `runImport()` function**, and add `switchImportTab()`.
Keep `showImportResult()` as-is (it doesn't need changes):

```js
function switchImportTab(tab) {
  const csvPanel  = document.getElementById('importPanelCsv');
  const jsonPanel = document.getElementById('importPanelJson');
  const csvBtn    = document.getElementById('importTabCsv');
  const jsonBtn   = document.getElementById('importTabJson');

  if (tab === 'csv') {
    csvPanel.style.display  = 'grid';
    jsonPanel.style.display = 'none';
    csvBtn.style.background  = '#fff';
    csvBtn.style.fontWeight  = '600';
    csvBtn.style.boxShadow   = '0 1px 3px rgba(0,0,0,0.1)';
    jsonBtn.style.background = 'transparent';
    jsonBtn.style.fontWeight = '500';
    jsonBtn.style.boxShadow  = 'none';
  } else {
    csvPanel.style.display  = 'none';
    jsonPanel.style.display = 'grid';
    jsonBtn.style.background = '#fff';
    jsonBtn.style.fontWeight = '600';
    jsonBtn.style.boxShadow  = '0 1px 3px rgba(0,0,0,0.1)';
    csvBtn.style.background  = 'transparent';
    csvBtn.style.fontWeight  = '500';
    csvBtn.style.boxShadow   = 'none';
  }
}

async function runImport(type, format, dryRun) {
  // Determine file input ID: fuelCsvFile, metalsCsvFile, fuelJsonFile, metalsJsonFile
  const inputId   = `${type}${format.charAt(0).toUpperCase() + format.slice(1)}File`;
  const fileInput = document.getElementById(inputId);

  if (!fileInput || !fileInput.files.length) {
    showImportResult('error', `Please select a .${format} file first.`);
    return;
  }

  const file = fileInput.files[0];
  const expectedExt = '.' + format;
  if (!file.name.toLowerCase().endsWith(expectedExt)) {
    showImportResult('error', `Please select a ${expectedExt} file.`);
    return;
  }

  // Endpoint: /api/import/fuel, /api/import/metals, /api/import/fuel-json, /api/import/metals-json
  const endpoint = format === 'csv'
    ? `/api/import/${type}`
    : `/api/import/${type}-json`;

  showImportResult('loading',
    `${dryRun ? 'Dry-running' : 'Importing'} ${file.name} (${(file.size / 1024).toFixed(0)} KB)...`
  );

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch(`${endpoint}${dryRun ? '?dry=1' : ''}`, {
      method: 'POST',
      credentials: 'include',  // cookie-based auth
      body: formData,           // let browser set multipart boundary — do NOT set Content-Type manually
    });

    if (!res.ok && res.status === 401) {
      showImportResult('error', '❌ Not authorised — please log in again.');
      return;
    }

    const data = await res.json();

    if (data.ok) {
      const s = data.stats;
      const warnHtml = s.errors && s.errors.length
        ? `<details style="margin-top:6px;"><summary style="cursor:pointer;font-size:12px;color:#92400e;">${s.errors.length} warnings — click to expand</summary>
           <pre style="font-size:11px;margin-top:4px;white-space:pre-wrap;">${s.errors.slice(0, 20).join('\n')}${s.errors.length > 20 ? `\n…and ${s.errors.length - 20} more` : ''}</pre></details>`
        : '';
      showImportResult('success',
        `✅ ${data.message}<br>
        <small style="color:#166534;">Total rows: ${s.total} &nbsp;·&nbsp; Inserted: ${s.inserted} &nbsp;·&nbsp; Skipped: ${s.skipped}</small>
        ${warnHtml}`
      );
    } else {
      showImportResult('error', '❌ ' + (data.error || 'Unknown error'));
    }
  } catch (e) {
    showImportResult('error', '❌ Network error: ' + e.message);
  }
}

// showImportResult — keep existing implementation, or use this one:
function showImportResult(type, html) {
  const div = document.getElementById('importResult');
  div.style.display = 'block';
  const styles = {
    success: 'background:#f0fdf4;border:1px solid #bbf7d0;',
    error:   'background:#fff1f2;border:1px solid #fecdd3;',
    loading: 'background:#eff6ff;border:1px solid #bfdbfe;',
  };
  div.style.cssText = `margin-top:12px;padding:12px 16px;border-radius:8px;font-size:13px;line-height:1.6;${styles[type] || styles.loading}`;
  div.innerHTML = html;
}
```

---

## Part 4 — Also update the Import Summary route (optional but recommended)

The existing `GET /api/import/summary` only shows rows where `source = 'imported'`.
Since JSON imports also use `source = 'imported'` (same default), this doesn't need changing.

However, if you want to distinguish CSV vs JSON imports, change the `source` defaults:
- CSV routes: `source = row.source || 'csv-import'`
- JSON routes: `source = row.source || 'json-import'`

And update the summary query:

```js
router.get('/import/summary', requireAuth, (req, res) => {
  try {
    const fuelStats = db.prepare(`
      SELECT
        MIN(price_date) as earliest,
        MAX(price_date) as latest,
        COUNT(*) as total_rows,
        COUNT(DISTINCT price_date) as days,
        COUNT(DISTINCT city_id) as cities
      FROM fuel_prices
      WHERE source IN ('imported', 'csv-import', 'json-import')
    `).get();

    const metalsStats = db.prepare(`
      SELECT
        MIN(price_date) as earliest,
        MAX(price_date) as latest,
        COUNT(*) as total_rows,
        COUNT(DISTINCT price_date) as days,
        COUNT(DISTINCT city_id) as cities
      FROM metals_prices
      WHERE source IN ('imported', 'csv-import', 'json-import')
    `).get();

    res.json({ ok: true, fuel: fuelStats, metals: metalsStats });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
```

---

## Part 5 — Sample JSON export script (bonus — add to `scripts/` folder)

Create `scripts/export-sample-json.js` so you can test the import with real-looking data:

```js
/**
 * Usage: node scripts/export-sample-json.js
 * Creates sample-fuel.json and sample-metals.json in /data/
 * These match exactly what the import routes expect.
 */

const fs   = require('fs');
const path = require('path');

const fuelSample = [
  { city: 'Delhi',   state: 'Delhi',       petrol: 96.72,  diesel: 89.62,  price_date: '2025-01-15' },
  { city: 'Mumbai',  state: 'Maharashtra', petrol: 106.31, diesel: 94.27,  price_date: '2025-01-15' },
  { city: 'Chennai', state: 'Tamil Nadu',  petrol: 102.63, diesel: 94.24,  price_date: '2025-01-15' },
  { city: 'Kolkata', state: 'West Bengal', petrol: 106.03, diesel: 92.76,  price_date: '2025-01-15' },
];

const metalsSample = [
  { city: 'Delhi',   state: 'Delhi',       metal_type: 'gold',     price_24k: 7245.50, price_22k: 6641.67, price_18k: 4979.85, price_1g: null,  price_date: '2025-01-15' },
  { city: 'Delhi',   state: 'Delhi',       metal_type: 'silver',   price_24k: null,    price_22k: null,    price_18k: null,    price_1g: 85.50, price_date: '2025-01-15' },
  { city: 'Mumbai',  state: 'Maharashtra', metal_type: 'gold',     price_24k: 7290.00, price_22k: 6682.50, price_18k: 5001.88, price_1g: null,  price_date: '2025-01-15' },
  { city: 'Mumbai',  state: 'Maharashtra', metal_type: 'silver',   price_24k: null,    price_22k: null,    price_18k: null,    price_1g: 86.10, price_date: '2025-01-15' },
];

const outDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'sample-fuel.json'),   JSON.stringify(fuelSample,   null, 2));
fs.writeFileSync(path.join(outDir, 'sample-metals.json'), JSON.stringify(metalsSample, null, 2));

console.log('✅ Written:', path.join(outDir, 'sample-fuel.json'));
console.log('✅ Written:', path.join(outDir, 'sample-metals.json'));
```

---

## Summary of Changes

| File | Change |
|---|---|
| `src/routes/api.js` | Add `POST /api/import/fuel-json` and `POST /api/import/metals-json` routes |
| `src/routes/api.js` | Update `GET /api/import/summary` to include `json-import` source (optional) |
| Dashboard HTML | Replace 2-card import section with 4-card CSV/JSON tabbed section |
| Dashboard JS | Replace `importCsv()` with unified `runImport(type, format, dryRun)` and add `switchImportTab()` |
| `scripts/export-sample-json.js` | New — generates sample JSON files for testing (optional) |

**No new npm packages needed** — `JSON.parse()` is built into Node.
**multer is already installed** from MIGRATION-CSV-IMPORT-FIX-PROMPT.md.

### Workflow after deploying

1. Go to dashboard → Import section
2. Click **JSON** tab
3. Select your `.json` file
4. Click **Dry Run** — verify row count looks right
5. Click **Import** — data loads into DB
6. Trend charts on posts will now have data to render
