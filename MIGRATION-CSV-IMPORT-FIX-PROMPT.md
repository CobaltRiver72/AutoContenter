# CSV IMPORT FIX PROMPT

Feed this entire prompt to your AI IDE assistant.

---

## What's Wrong

The "Import CSV" button triggers `scripts/import-csv.js` as a standalone child process.
That script tries to open its own SQLite connection and guesses the DB path using `__dirname`.
On Hostinger, the working directory doesn't match where the main app created `autopub.db`,
so it errors: **"Database not found at: .../nodejs/data/autopub.db"**

## The Fix

Delete the standalone script approach entirely.
Move the import logic **into the Express app as a route handler** that uses the already-open `db` instance.
No path guessing. No child processes. No env var workarounds.

---

## Part 1 — Delete the old approach

In `src/routes/api.js`, find the existing `POST /api/import/run` (or similar) route that spawns
`scripts/import-csv.js` as a child process. **Delete it entirely.**

Also find and remove any `require('child_process')` or `spawn`/`exec` calls related to CSV import.

---

## Part 2 — Add inline CSV parser utility

Add this helper at the top of `src/routes/api.js` (or in a new `src/utils/csv-parser.js` file):

```js
/**
 * Parse a CSV string into an array of objects.
 * Handles quoted fields, trims whitespace, skips blank lines.
 * Zero dependencies — pure Node.
 */
function parseCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const headers = splitCsvLine(lines[0]).map(h => h.trim().toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const values = splitCsvLine(line);
    const row = {};
    headers.forEach((h, idx) => {
      row[h] = (values[idx] || '').trim().replace(/^"|"$/g, '');
    });
    rows.push(row);
  }
  return { headers, rows };
}

function splitCsvLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}
```

---

## Part 3 — Replace import routes with inline handlers

Replace the old import routes with these new ones in `src/routes/api.js`.
These use the `db` object that is already open in the app — no path resolution needed.

```js
const multer  = require('multer');
const storage = multer.memoryStorage();       // files stay in RAM, never touch disk
const upload  = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } }); // 50MB max

// ── Import Fuel CSV ────────────────────────────────────────────────────────
// POST /api/import/fuel  — multipart upload, field name: "file"
router.post('/import/fuel', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });

  const dryRun  = req.query.dry === '1' || req.query.dry === 'true';
  const csvText = req.file.buffer.toString('utf8');

  let parsed;
  try {
    parsed = parseCsv(csvText);
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'CSV parse failed: ' + e.message });
  }

  const required = ['city', 'price_date'];
  const missing  = required.filter(c => !parsed.headers.includes(c));
  if (missing.length) {
    return res.status(400).json({ ok: false, error: 'Missing columns: ' + missing.join(', ') });
  }

  const stats = { total: 0, inserted: 0, skipped: 0, errors: [] };

  // Prepare statements once
  const getCityId  = db.prepare('SELECT id FROM fuel_cities WHERE city_name = ?');
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO fuel_prices (city_id, fuel_type, price, price_date, fetched_at, source)
    VALUES (?, ?, ?, ?, datetime('now'), ?)
  `);

  const runImport = db.transaction((rows) => {
    for (const row of rows) {
      stats.total++;

      // Validate date
      if (!row.price_date || !/^\d{4}-\d{2}-\d{2}$/.test(row.price_date)) {
        stats.errors.push(`Row ${stats.total}: invalid date "${row.price_date}"`);
        stats.skipped++;
        continue;
      }

      const cityRow = getCityId.get(row.city);
      if (!cityRow) {
        stats.skipped++;
        continue; // city not in our DB, silently skip
      }

      const source = row.source || 'imported';

      // Insert petrol
      if (row.petrol && !isNaN(parseFloat(row.petrol))) {
        if (!dryRun) {
          const r = insertStmt.run(cityRow.id, 'petrol', parseFloat(row.petrol), row.price_date, source);
          if (r.changes > 0) stats.inserted++;
          else stats.skipped++;
        } else {
          stats.inserted++; // dry run count
        }
      }

      // Insert diesel
      if (row.diesel && !isNaN(parseFloat(row.diesel))) {
        if (!dryRun) {
          const r = insertStmt.run(cityRow.id, 'diesel', parseFloat(row.diesel), row.price_date, source);
          if (r.changes > 0) stats.inserted++;
          else stats.skipped++;
        } else {
          stats.inserted++;
        }
      }
    }
  });

  try {
    runImport(parsed.rows);
    res.json({
      ok: true,
      dryRun,
      stats,
      message: dryRun
        ? `Dry run: would insert ~${stats.inserted} rows from ${stats.total} CSV rows`
        : `Imported ${stats.inserted} rows (${stats.skipped} skipped) from ${stats.total} CSV rows`
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, stats });
  }
});

// ── Import Metals CSV ──────────────────────────────────────────────────────
// POST /api/import/metals  — multipart upload, field name: "file"
router.post('/import/metals', requireAuth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: 'No file uploaded' });

  const dryRun  = req.query.dry === '1' || req.query.dry === 'true';
  const csvText = req.file.buffer.toString('utf8');

  let parsed;
  try {
    parsed = parseCsv(csvText);
  } catch (e) {
    return res.status(400).json({ ok: false, error: 'CSV parse failed: ' + e.message });
  }

  const required = ['city', 'metal_type', 'price_date'];
  const missing  = required.filter(c => !parsed.headers.includes(c));
  if (missing.length) {
    return res.status(400).json({ ok: false, error: 'Missing columns: ' + missing.join(', ') });
  }

  const stats = { total: 0, inserted: 0, skipped: 0, errors: [] };

  const getCityId  = db.prepare('SELECT id FROM metals_cities WHERE city_name = ?');
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO metals_prices (city_id, metal_type, variant, price_per_gram, price_date, fetched_at, source)
    VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
  `);

  // Map CSV columns to (variant, price) pairs
  const variantMap = [
    { col: 'price_24k', variant: '24K' },
    { col: 'price_22k', variant: '22K' },
    { col: 'price_18k', variant: '18K' },
    { col: 'price_1g',  variant: '1g'  },
  ];

  const runImport = db.transaction((rows) => {
    for (const row of rows) {
      stats.total++;

      if (!row.price_date || !/^\d{4}-\d{2}-\d{2}$/.test(row.price_date)) {
        stats.errors.push(`Row ${stats.total}: invalid date "${row.price_date}"`);
        stats.skipped++;
        continue;
      }

      const metal = (row.metal_type || '').toLowerCase().trim();
      if (!['gold', 'silver', 'platinum'].includes(metal)) {
        stats.skipped++;
        continue;
      }

      const cityRow = getCityId.get(row.city);
      if (!cityRow) {
        stats.skipped++;
        continue;
      }

      const source = row.source || 'imported';
      let rowInserted = false;

      for (const { col, variant } of variantMap) {
        const val = row[col];
        if (!val || isNaN(parseFloat(val)) || parseFloat(val) <= 0) continue;

        if (!dryRun) {
          const r = insertStmt.run(
            cityRow.id, metal, variant, parseFloat(val),
            row.price_date, source
          );
          if (r.changes > 0) { stats.inserted++; rowInserted = true; }
          else stats.skipped++;
        } else {
          stats.inserted++;
          rowInserted = true;
        }
      }

      if (!rowInserted) stats.skipped++;
    }
  });

  try {
    runImport(parsed.rows);
    res.json({
      ok: true,
      dryRun,
      stats,
      message: dryRun
        ? `Dry run: would insert ~${stats.inserted} rows from ${stats.total} CSV rows`
        : `Imported ${stats.inserted} rows (${stats.skipped} skipped) from ${stats.total} CSV rows`
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message, stats });
  }
});

// ── Import summary ─────────────────────────────────────────────────────────
router.get('/import/summary', requireAuth, (req, res) => {
  try {
    const fuelDates = db.prepare(`
      SELECT MIN(price_date) as earliest, MAX(price_date) as latest, COUNT(*) as total_rows,
             COUNT(DISTINCT price_date) as days
      FROM fuel_prices WHERE source = 'imported'
    `).get();

    const metalsDates = db.prepare(`
      SELECT MIN(price_date) as earliest, MAX(price_date) as latest, COUNT(*) as total_rows,
             COUNT(DISTINCT price_date) as days
      FROM metals_prices WHERE source = 'imported'
    `).get();

    res.json({ ok: true, fuel: fuelDates, metals: metalsDates });
  } catch(e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});
```

---

## Part 4 — Install multer

```bash
npm install multer
```

Add to `package.json` dependencies.

---

## Part 5 — Update the dashboard Import UI

Find the import section in the dashboard HTML (wherever "Import Fuel CSV" / "Import Metals CSV" buttons are).

Replace the current buttons with a proper file-upload form:

```html
<!-- Import Section -->
<div class="import-section">
  <h3>Import Historical Price Data</h3>
  <p style="font-size:13px;color:#6b7280;margin-bottom:16px;">
    Upload CSV exports from the WordPress plugins to backfill price history for trend charts.
  </p>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">

    <!-- Fuel Import -->
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;">
      <div style="font-size:14px;font-weight:700;margin-bottom:8px;">⛽ Import Fuel CSV</div>
      <div style="font-size:12px;color:#6b7280;margin-bottom:10px;">
        Columns: city, state, petrol, diesel, price_date, source
      </div>
      <input type="file" id="fuelCsvFile" accept=".csv"
             style="font-size:12px;width:100%;margin-bottom:8px;">
      <div style="display:flex;gap:6px;">
        <button onclick="importCsv('fuel', true)"
                style="flex:1;padding:6px;font-size:12px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:6px;cursor:pointer;">
          Dry Run
        </button>
        <button onclick="importCsv('fuel', false)"
                style="flex:1;padding:6px;font-size:12px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;">
          Import
        </button>
      </div>
    </div>

    <!-- Metals Import -->
    <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;">
      <div style="font-size:14px;font-weight:700;margin-bottom:8px;">🥇 Import Metals CSV</div>
      <div style="font-size:12px;color:#6b7280;margin-bottom:10px;">
        Columns: city, state, metal_type, price_24k, price_22k, price_18k, price_1g, price_date, source
      </div>
      <input type="file" id="metalsCsvFile" accept=".csv"
             style="font-size:12px;width:100%;margin-bottom:8px;">
      <div style="display:flex;gap:6px;">
        <button onclick="importCsv('metals', true)"
                style="flex:1;padding:6px;font-size:12px;background:#f3f4f6;border:1px solid #d1d5db;border-radius:6px;cursor:pointer;">
          Dry Run
        </button>
        <button onclick="importCsv('metals', false)"
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

Add this JavaScript to the dashboard:

```js
async function importCsv(type, dryRun) {
  const fileInput = document.getElementById(type === 'fuel' ? 'fuelCsvFile' : 'metalsCsvFile');
  const resultDiv = document.getElementById('importResult');

  if (!fileInput.files.length) {
    showImportResult('error', 'Please select a CSV file first.');
    return;
  }

  const file = fileInput.files[0];
  if (!file.name.endsWith('.csv')) {
    showImportResult('error', 'Please select a .csv file.');
    return;
  }

  showImportResult('loading', `${dryRun ? 'Dry-running' : 'Importing'} ${file.name} (${(file.size/1024).toFixed(0)} KB)...`);

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch(`/api/import/${type}${dryRun ? '?dry=1' : ''}`, {
      method: 'POST',
      headers: { 'X-Dashboard-Token': window.DASHBOARD_TOKEN || '' },
      body: formData,
    });
    const data = await res.json();

    if (data.ok) {
      const s = data.stats;
      showImportResult('success',
        `✅ ${data.message}<br>
        <small>Total rows: ${s.total} · Inserted: ${s.inserted} · Skipped: ${s.skipped}
        ${s.errors.length ? ` · ${s.errors.length} warnings` : ''}</small>`
      );
    } else {
      showImportResult('error', '❌ ' + data.error);
    }
  } catch (e) {
    showImportResult('error', '❌ Network error: ' + e.message);
  }
}

function showImportResult(type, html) {
  const div = document.getElementById('importResult');
  div.style.display = 'block';
  const colors = {
    success: '#f0fdf4',
    error:   '#fff1f2',
    loading: '#f0f6ff',
  };
  const borders = {
    success: '#bbf7d0',
    error:   '#fecdd3',
    loading: '#cce0ff',
  };
  div.style.cssText = `
    margin-top:12px; padding:12px 16px; border-radius:8px;
    background:${colors[type]}; border:1px solid ${borders[type]};
    font-size:13px; line-height:1.6;
  `;
  div.innerHTML = html;
}
```

---

## Part 6 — Auth header for upload

The upload endpoint uses `requireAuth`. Make sure the dashboard sends the token.
Find where `DASHBOARD_TOKEN` is exposed to the frontend (usually via a `<script>` tag injecting it as a JS variable), and ensure the `importCsv()` function's fetch call includes it:

```js
headers: {
  'X-Dashboard-Token': window.DASHBOARD_TOKEN || document.cookie.match(/token=([^;]+)/)?.[1] || ''
}
```

If the existing dashboard uses cookie-based auth (session), switch to:
```js
const res = await fetch(`/api/import/${type}${dryRun ? '?dry=1' : ''}`, {
  method: 'POST',
  credentials: 'include',   // sends cookies automatically
  body: formData,           // NO Content-Type header — let browser set multipart boundary
});
```

---

## Summary

| What changed | Why |
|---|---|
| Deleted `scripts/import-csv.js` child process approach | Script couldn't find the DB on Hostinger |
| Import logic moved into Express route handlers | Uses the already-open `db` connection — no path issues ever |
| Files uploaded via `multipart/form-data` (multer in-memory) | No temp files written to disk, works on any hosting |
| Dashboard UI changed from "button → spawn script" to "file picker → fetch upload" | User picks the CSV file directly from their browser |
| `INSERT OR IGNORE` used | Safely skips duplicates, never overwrites existing data |
| Dry-run mode preserved | Test before committing large imports |

**After deploying:** refresh the dashboard, pick your CSV file, click Dry Run first to verify counts, then Import.
