# HDF AutoPub — CSV Data Import Prompt
## Historical Price Import: Fuel + Metals

> **Context:** This imports historical price data exported from the WordPress `hdf-fuel` and `hdf-metals` MySQL plugins into AutoPub's SQLite database. This preserves years of price history so trend charts work from day one.

---

## HOW TO EXPORT FROM WORDPRESS (Do this BEFORE running this prompt)

### Fuel Export (from WP Admin → HDF Fuel → Export tab)
- Date From: earliest date you have data
- Date To: today
- State: All, City: All, Fuel: Both
- Export will download in chunks of 5000 rows
- **Save all chunks as:** `data/import-fuel.csv`

**Expected fuel CSV columns:**
```
city,state,petrol,diesel,price_date,source
Delhi,Delhi,96.72,89.62,2025-01-15,api1
Mumbai,Maharashtra,106.31,92.15,2025-01-15,api1
...
```

### Metals Export (from WP Admin → HDF Metals → Export tab)
- Date From: earliest date, Date To: today
- Metal: All, State: All
- **Save as:** `data/import-metals.csv`

**Expected metals CSV columns:**
```
city,state,metal_type,price_24k,price_22k,price_18k,price_1g,price_date,source
Delhi,Delhi,gold,7245.50,6641.67,4979.85,,2025-01-15,api1
Delhi,Delhi,silver,,,,95.50,2025-01-15,api1
...
```

---

## PART 1 — Create the Import Script

**New file:** `scripts/import-csv.js`

This is a standalone Node.js script (not part of the running server). Run it once manually.

```
node scripts/import-csv.js --type=fuel
node scripts/import-csv.js --type=metals
node scripts/import-csv.js --type=all
```

### Full Implementation

```js
#!/usr/bin/env node
/**
 * HDF AutoPub — Historical CSV Importer
 * Usage:
 *   node scripts/import-csv.js --type=fuel
 *   node scripts/import-csv.js --type=metals
 *   node scripts/import-csv.js --type=all
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// ── Arg parsing ───────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const typeArg = (args.find(a => a.startsWith('--type=')) || '--type=all').split('=')[1];
const dryRun  = args.includes('--dry-run');

// ── Paths ─────────────────────────────────────────────────────────────────────
const ROOT      = path.join(__dirname, '..');
const DB_PATH   = path.join(ROOT, 'data', 'autopub.db');
const FUEL_CSV  = path.join(ROOT, 'data', 'import-fuel.csv');
const METALS_CSV = path.join(ROOT, 'data', 'import-metals.csv');

// ── DB ────────────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// ── CSV Parser (no dependencies — pure Node) ──────────────────────────────────
function parseCSV(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`❌  File not found: ${filePath}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    console.error(`❌  CSV has no data rows: ${filePath}`);
    process.exit(1);
  }
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitCSVLine(lines[i]);
    if (cols.length !== headers.length) continue; // skip malformed rows
    const row = {};
    headers.forEach((h, idx) => { row[h] = cols[idx] === '' ? null : cols[idx]; });
    rows.push(row);
  }
  return rows;
}

// Handle quoted fields with commas inside
function splitCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// ── Validators ────────────────────────────────────────────────────────────────
function isValidDate(s) { return s && /^\d{4}-\d{2}-\d{2}$/.test(s); }
function toDecimal(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}
function cleanCity(s) { return s ? s.trim() : null; }
function cleanState(s) { return s ? s.trim() : null; }

// ── FUEL IMPORT ───────────────────────────────────────────────────────────────
function importFuel() {
  console.log('\n📦  Importing Fuel prices...');
  const rows = parseCSV(FUEL_CSV);
  console.log(`    Parsed ${rows.length} rows from ${FUEL_CSV}`);

  // Validate required columns
  const required = ['city', 'price_date'];
  const sample = rows[0];
  for (const col of required) {
    if (!(col in sample)) {
      console.error(`❌  Missing required column: ${col}`);
      console.error(`    Available columns: ${Object.keys(sample).join(', ')}`);
      process.exit(1);
    }
  }

  // Check if petrol/diesel columns exist
  const hasPetrol = 'petrol' in sample;
  const hasDiesel = 'diesel' in sample;
  if (!hasPetrol && !hasDiesel) {
    console.error('❌  CSV must have at least one of: petrol, diesel');
    process.exit(1);
  }

  const stmt = db.prepare(`
    INSERT INTO fuel_prices (city, state, petrol, diesel, price_date, source, fetched_at)
    VALUES (@city, @state, @petrol, @diesel, @price_date, @source, @fetched_at)
    ON CONFLICT(city, price_date) DO UPDATE SET
      petrol   = COALESCE(excluded.petrol,  fuel_prices.petrol),
      diesel   = COALESCE(excluded.diesel,  fuel_prices.diesel),
      state    = COALESCE(excluded.state,   fuel_prices.state),
      source   = COALESCE(excluded.source,  fuel_prices.source)
  `);

  let inserted = 0, skipped = 0, errors = 0;

  const runImport = db.transaction(() => {
    for (const row of rows) {
      const city      = cleanCity(row.city);
      const state     = cleanState(row.state || null);
      const petrol    = toDecimal(row.petrol);
      const diesel    = toDecimal(row.diesel);
      const priceDate = row.price_date;
      const source    = row.source || 'imported';

      // Skip invalid rows
      if (!city) { skipped++; continue; }
      if (!isValidDate(priceDate)) { skipped++; continue; }
      if (petrol === null && diesel === null) { skipped++; continue; }

      try {
        if (!dryRun) {
          stmt.run({
            city,
            state,
            petrol,
            diesel,
            price_date: priceDate,
            source,
            fetched_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
          });
        }
        inserted++;
      } catch (e) {
        errors++;
        if (errors <= 5) console.warn(`    ⚠️  Row error: ${e.message} (city=${city}, date=${priceDate})`);
      }
    }
  });

  runImport();

  console.log(`    ✅  Fuel import complete:`);
  console.log(`        Inserted/Updated : ${inserted}`);
  console.log(`        Skipped          : ${skipped}`);
  console.log(`        Errors           : ${errors}`);
  if (dryRun) console.log(`        [DRY RUN — no changes written]`);

  // Print date range summary
  const range = db.prepare(`
    SELECT MIN(price_date) as earliest, MAX(price_date) as latest, COUNT(DISTINCT price_date) as days, COUNT(*) as total
    FROM fuel_prices
  `).get();
  console.log(`\n    📊 Fuel DB now: ${range.total} price rows across ${range.days} days`);
  console.log(`       Date range: ${range.earliest} → ${range.latest}`);
}

// ── METALS IMPORT ─────────────────────────────────────────────────────────────
function importMetals() {
  console.log('\n📦  Importing Metals prices...');
  const rows = parseCSV(METALS_CSV);
  console.log(`    Parsed ${rows.length} rows from ${METALS_CSV}`);

  // Validate required columns
  const required = ['city', 'metal_type', 'price_date'];
  const sample = rows[0];
  for (const col of required) {
    if (!(col in sample)) {
      console.error(`❌  Missing required column: ${col}`);
      console.error(`    Available columns: ${Object.keys(sample).join(', ')}`);
      process.exit(1);
    }
  }

  // Normalize metal_type values
  const VALID_METALS = new Set(['gold', 'silver', 'platinum']);

  const stmt = db.prepare(`
    INSERT INTO metals_prices (city, metal_type, price_24k, price_22k, price_18k, price_1g, price_date, source, created_at)
    VALUES (@city, @metal_type, @price_24k, @price_22k, @price_18k, @price_1g, @price_date, @source, @created_at)
    ON CONFLICT(city, metal_type, price_date) DO UPDATE SET
      price_24k = COALESCE(excluded.price_24k, metals_prices.price_24k),
      price_22k = COALESCE(excluded.price_22k, metals_prices.price_22k),
      price_18k = COALESCE(excluded.price_18k, metals_prices.price_18k),
      price_1g  = COALESCE(excluded.price_1g,  metals_prices.price_1g),
      source    = COALESCE(excluded.source,    metals_prices.source)
  `);

  let inserted = 0, skipped = 0, errors = 0;

  const runImport = db.transaction(() => {
    for (const row of rows) {
      const city      = cleanCity(row.city);
      const metalType = (row.metal_type || '').toLowerCase().trim();
      const priceDate = row.price_date;
      const source    = row.source || 'imported';

      // Skip invalid rows
      if (!city) { skipped++; continue; }
      if (!isValidDate(priceDate)) { skipped++; continue; }
      if (!VALID_METALS.has(metalType)) { skipped++; continue; }

      const price24k = toDecimal(row.price_24k);
      const price22k = toDecimal(row.price_22k);
      const price18k = toDecimal(row.price_18k);
      const price1g  = toDecimal(row.price_1g);

      // Skip if all prices are null
      if (price24k === null && price22k === null && price18k === null && price1g === null) {
        skipped++; continue;
      }

      try {
        if (!dryRun) {
          stmt.run({
            city,
            metal_type: metalType,
            price_24k: price24k,
            price_22k: price22k,
            price_18k: price18k,
            price_1g:  price1g,
            price_date: priceDate,
            source,
            created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
          });
        }
        inserted++;
      } catch (e) {
        errors++;
        if (errors <= 5) console.warn(`    ⚠️  Row error: ${e.message} (city=${city}, metal=${metalType}, date=${priceDate})`);
      }
    }
  });

  runImport();

  console.log(`    ✅  Metals import complete:`);
  console.log(`        Inserted/Updated : ${inserted}`);
  console.log(`        Skipped          : ${skipped}`);
  console.log(`        Errors           : ${errors}`);
  if (dryRun) console.log(`        [DRY RUN — no changes written]`);

  // Summary per metal
  const perMetal = db.prepare(`
    SELECT metal_type, COUNT(*) as rows, COUNT(DISTINCT price_date) as days, MIN(price_date) as earliest, MAX(price_date) as latest
    FROM metals_prices
    GROUP BY metal_type
  `).all();
  console.log('\n    📊 Metals DB now:');
  for (const m of perMetal) {
    console.log(`       ${m.metal_type.padEnd(10)} ${m.rows} rows · ${m.days} days · ${m.earliest} → ${m.latest}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════');
console.log('  HDF AutoPub — CSV Historical Data Importer');
console.log('═══════════════════════════════════════════════');
if (dryRun) console.log('  ⚠️  DRY RUN MODE — no data will be written\n');

if (typeArg === 'fuel' || typeArg === 'all') importFuel();
if (typeArg === 'metals' || typeArg === 'all') importMetals();

console.log('\n✅  Done.\n');
db.close();
```

---

## PART 2 — Add Import Trigger to Dashboard (Optional but Useful)

### 2A. HTML Button

**File:** `public/index.html`

In the Settings page, add an "Import" section card after WordPress credentials:

```html
<div class="card">
  <h3>Historical Data Import</h3>
  <p class="text-muted">Import historical price data from CSV exports of the WordPress plugins. Place your CSV files in the <code>data/</code> folder before importing.</p>
  <div class="form-group">
    <label>Expected files</label>
    <div class="text-muted" style="font-family:monospace;font-size:12px;line-height:1.8">
      data/import-fuel.csv &nbsp;— columns: city, state, petrol, diesel, price_date, source<br>
      data/import-metals.csv — columns: city, state, metal_type, price_24k, price_22k, price_18k, price_1g, price_date, source
    </div>
  </div>
  <div class="btn-row">
    <button class="btn btn-secondary" onclick="runImport('fuel')">⛽ Import Fuel CSV</button>
    <button class="btn btn-secondary" onclick="runImport('metals')">🥇 Import Metals CSV</button>
    <button class="btn btn-primary" onclick="runImport('all')">📥 Import Both</button>
  </div>
  <div id="import-result" class="mt-2"></div>
</div>
```

### 2B. API Route

**File:** `src/routes/api.js`

```js
// POST /api/import/run
router.post('/import/run', async (req, res) => {
  const { type = 'all' } = req.body;
  const { spawn } = require('child_process');
  const path = require('path');

  const scriptPath = path.join(__dirname, '../../scripts/import-csv.js');

  try {
    const child = spawn('node', [scriptPath, `--type=${type}`], {
      cwd: path.join(__dirname, '../..'),
      env: process.env,
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });

    child.on('close', code => {
      res.json({
        ok: code === 0,
        output: stdout,
        error: stderr || null,
        exitCode: code,
      });
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});
```

### 2C. Dashboard JavaScript

**File:** `public/js/dashboard.js`

```js
async function runImport(type) {
  const el = document.getElementById('import-result');
  el.textContent = `⏳ Running ${type} import...`;
  try {
    const res = await fetch('/api/import/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type })
    });
    const data = await res.json();
    if (data.ok) {
      el.innerHTML = '<pre style="font-size:11px;white-space:pre-wrap;color:#4ade80">' + escapeHtml(data.output) + '</pre>';
    } else {
      el.innerHTML = '<pre style="font-size:11px;white-space:pre-wrap;color:#f87171">' + escapeHtml(data.error || data.output) + '</pre>';
    }
  } catch(e) {
    el.textContent = '❌ ' + e.message;
  }
}

function escapeHtml(s) {
  return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
```

---

## PART 3 — Verify Import with Summary Queries

Add these to the import script output, and also expose as a `GET /api/import/summary` endpoint:

**File:** `src/routes/api.js`

```js
// GET /api/import/summary
router.get('/import/summary', (req, res) => {
  const { db } = req.app.locals;

  const fuelSummary = db.prepare(`
    SELECT
      COUNT(*) as total_rows,
      COUNT(DISTINCT city) as cities,
      COUNT(DISTINCT price_date) as days,
      MIN(price_date) as earliest,
      MAX(price_date) as latest,
      SUM(CASE WHEN petrol IS NOT NULL THEN 1 ELSE 0 END) as petrol_rows,
      SUM(CASE WHEN diesel IS NOT NULL THEN 1 ELSE 0 END) as diesel_rows,
      SUM(CASE WHEN source = 'imported' THEN 1 ELSE 0 END) as imported_rows,
      SUM(CASE WHEN source != 'imported' THEN 1 ELSE 0 END) as live_rows
    FROM fuel_prices
  `).get();

  const metalsSummary = db.prepare(`
    SELECT
      metal_type,
      COUNT(*) as total_rows,
      COUNT(DISTINCT city) as cities,
      COUNT(DISTINCT price_date) as days,
      MIN(price_date) as earliest,
      MAX(price_date) as latest,
      SUM(CASE WHEN source = 'imported' THEN 1 ELSE 0 END) as imported_rows,
      SUM(CASE WHEN source != 'imported' THEN 1 ELSE 0 END) as live_rows
    FROM metals_prices
    GROUP BY metal_type
  `).all();

  res.json({ ok: true, fuel: fuelSummary, metals: metalsSummary });
});
```

---

## NOTES

1. **The script uses no extra dependencies** — only `better-sqlite3` which is already in package.json. No `csv-parse` or similar needed.

2. **UPSERT strategy is non-destructive** — uses `COALESCE(excluded.col, existing.col)` so if a row already exists with a valid price, it will not be overwritten by a NULL from the import.

3. **Duplicate-safe** — can be run multiple times without creating duplicate rows (UNIQUE constraint on city+price_date for fuel, city+metal_type+price_date for metals).

4. **source column** — imported rows get `source = 'imported'`. Live AutoPub fetches use `source = 'api1'`, `'api3'`, `'derived'`, or `'autofill'`. The summary endpoint breaks these down so you can see how much data is historical vs live.

5. **Multi-chunk fuel exports** — if the WP plugin exported multiple CSV files (5000 rows each), concatenate them first:
   ```bash
   # On Mac/Linux:
   head -1 fuel-export-part1.csv > data/import-fuel.csv   # write header once
   tail -n +2 fuel-export-part1.csv >> data/import-fuel.csv  # append data
   tail -n +2 fuel-export-part2.csv >> data/import-fuel.csv  # append data
   tail -n +2 fuel-export-part3.csv >> data/import-fuel.csv  # etc.
   ```

6. **Dry run first** — always test before a real import:
   ```bash
   node scripts/import-csv.js --type=all --dry-run
   ```
