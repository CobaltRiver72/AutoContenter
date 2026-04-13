# CODEBASE FIXES PROMPT — Bug Sweep + Dead Code Cleanup

Feed this entire prompt to your AI IDE assistant.
It fixes 12 issues found during a full code review of the HDF AutoPub application.

---

## Fix 1 — CRITICAL: Add `multer` to `package.json`

The CSV and JSON import routes in `src/routes/api.js` both `require('multer')` but it is NOT listed
in `package.json` dependencies. A fresh `npm install` on a new deployment will crash.

**Action:** Run this command:
```bash
npm install multer --save
```

Then verify `package.json` has `"multer"` in the `dependencies` block.

---

## Fix 2 — CRITICAL: Fix `metals_log` INSERT using wrong columns

In `src/modules/metals-posts.js`, the `runPostGeneration()` method writes to `metals_log` using
columns that don't exist in the table schema.

**Find this block** (around line 197–204):
```js
    // Log to metals_log
    try {
      this.db.prepare(`
        INSERT INTO metals_log (metal_type, action, detail, created_at)
        VALUES (?, 'post_generation', ?, datetime('now'))
      `).run(metalType, JSON.stringify({ created, updated, cities: cities.length, states: states.length }));
    } catch (err) {
      this.logger.warn(MODULE, 'Failed to write metals_log: ' + err.message);
    }
```

**Replace with:**
```js
    // Log to metals_log — table schema only has (id, message, created_at)
    try {
      this.db.prepare(
        "INSERT INTO metals_log (message, created_at) VALUES (?, datetime('now'))"
      ).run(metalType + ' post_generation: ' + JSON.stringify({ created, updated, cities: cities.length, states: states.length }));
    } catch (err) {
      this.logger.warn(MODULE, 'Failed to write metals_log: ' + err.message);
    }
```

---

## Fix 3 — CRITICAL: Fix `date('now')` missing `'localtime'` in fuel module

In `src/modules/fuel.js`, the `getStateCitiesToday()` method uses `date('now')` without
`'localtime'`. Every other query in the codebase uses `date('now', 'localtime')`.

On the Hostinger server (UTC timezone), `date('now')` lags behind IST by 5.5 hours,
meaning between midnight and 5:30 AM IST, the query looks for "yesterday" in IST terms.
At 6:30 AM when posts are generated, state city lists could still be stale.

**Find this** (around line 440–448):
```js
  getStateCitiesToday(state) {
    return this.db.prepare(`
      SELECT fc.city_name, fp.petrol, fp.diesel
      FROM fuel_cities fc
      LEFT JOIN fuel_prices fp ON fc.city_name = fp.city AND fp.price_date = date('now')
      WHERE fc.state = ? AND fc.is_enabled = 1
      ORDER BY fc.city_name
    `).all(state);
  }
```

**Replace with:**
```js
  getStateCitiesToday(state) {
    return this.db.prepare(`
      SELECT fc.city_name, fp.petrol, fp.diesel
      FROM fuel_cities fc
      LEFT JOIN fuel_prices fp ON fc.city_name = fp.city AND fp.price_date = date('now', 'localtime')
      WHERE fc.state = ? AND fc.is_enabled = 1
      ORDER BY fc.city_name
    `).all(state);
  }
```

---

## Fix 4 — Fix `stats.totalFetched` double-counting in MetalsModule

In `src/modules/metals.js`, the `fetchBulk()` method increments `this.stats.totalFetched`,
and then `runDailyFetch()` ALSO increments it with the sum of all fetchBulk counts.
This causes the stat to be 2× the actual number.

**Find this line in `fetchBulk()`** (around line 265):
```js
    this.stats.totalFetched += count;
```

**Delete that line entirely.** The increment in `runDailyFetch()` (line 178) already handles it:
```js
    this.stats.totalFetched += totalOk;
```

---

## Fix 5 — Fix generate-posts routes returning empty `results`

In `src/routes/api.js`, the `POST /api/fuel/generate-posts` and `POST /api/metals/generate-posts`
routes respond immediately with `results: results` but `results` is an empty `{}` at that point
because the chain runs in background.

**Fix for fuel generate-posts — find** (around line 1136):
```js
      res.json({ ok: true, message: 'Post generation started in background', results: results });
```

**Replace with:**
```js
      res.json({ ok: true, message: 'Post generation started in background for ' + fuelType });
```

**Fix for metals generate-posts — find** (around line 1162):
```js
      res.json({ ok: true, message: 'Post generation started in background', results: results });
```

**Replace with:**
```js
      res.json({ ok: true, message: 'Post generation started in background for ' + (metalType === 'all' ? 'gold, silver, platinum' : metalType) });
```

---

## Fix 6 — Delete dead `scripts/import-csv.js`

This standalone script was the OLD import approach that caused the "Database not found" error
on Hostinger. It was replaced by Express route handlers in `src/routes/api.js` (via
MIGRATION-CSV-IMPORT-FIX-PROMPT.md and MIGRATION-JSON-IMPORT-PROMPT.md).

Keeping it in the repo is dangerous because:
- Someone could accidentally run it, opening a second SQLite connection on a live server
- Its upsert logic (`ON CONFLICT DO UPDATE SET ... COALESCE`) differs from the API routes (`INSERT OR IGNORE`)

**Action:** Delete the file entirely:
```bash
rm scripts/import-csv.js
```

---

## Fix 7 — Remove dead `post-html.js` imports from fuel-posts.js and metals-posts.js

Both `src/modules/fuel-posts.js` and `src/modules/metals-posts.js` import 10 functions from
`src/utils/post-html.js`, but **none of them are ever called**. The widget system replaced them.
The imports just waste memory and confuse anyone reading the code.

**In `src/modules/fuel-posts.js`, delete lines 5–9:**
```js
const {
  liveBadge, priceChangeBadge, statPills, sourceBadge,
  readAlsoBox, infoBox, styledTable, faqSection,
  articleSchema, breadcrumbs, priceHero
} = require('../utils/post-html');
```

**In `src/modules/metals-posts.js`, delete lines 5–9:**
```js
const {
  liveBadge, priceChangeBadge, statPills, sourceBadge,
  readAlsoBox, infoBox, styledTable, faqSection,
  articleSchema, breadcrumbs, priceHero
} = require('../utils/post-html');
```

After removing these imports, also check if `src/utils/post-html.js` is imported anywhere else.
If nothing else requires it, the file itself is dead code too — but keep it for now in case it's
useful later for debugging. Just remove the imports.

---

## Fix 8 — Remove dead `recoverStaleLocks` export from db.js

In `src/utils/db.js`, the function `recoverStaleLocks()` (line 715) is defined and exported but
never called anywhere in the codebase. Its work overlaps with `recoverStuckDrafts()` which IS
called at startup. The function also has a broader reset (no lease expiry check) which could
cause race conditions if someone ever calls it incorrectly.

**Option A (recommended):** Remove the function entirely and remove it from `module.exports`:

Find and delete the entire `recoverStaleLocks` function (around lines 715–742):
```js
function recoverStaleLocks() {
  // ... entire function body ...
}
```

And update the exports:
```js
module.exports = {
  db,
  closeDb,
  runMigrations,
  recoverStuckDrafts,
  // removed: recoverStaleLocks
};
```

**Option B:** Keep it but just remove from exports. Either way, don't leave dead code in exports.

---

## Fix 9 — Fix double `db.prepare()` call in metals/cities route

In `src/routes/api.js`, the `GET /api/metals/cities` route calls `db.prepare(sql)` twice:

**Find** (around line 819):
```js
      res.json({ data: db.prepare(sql).all.apply(db.prepare(sql), params) });
```

**Replace with:**
```js
      var stmt = db.prepare(sql);
      res.json({ data: stmt.all.apply(stmt, params) });
```

---

## Fix 10 — Give public API routes a separate (higher) rate limit

In `src/index.js`, the rate limiter at line 256 covers ALL `/api/` routes including the public
widget endpoints. The WordPress widget JS calls 3–5 API endpoints per page view (price-box,
price-table, ranking, city-pills, etc.). With just 40 concurrent visitors, you'd exceed
200 requests per 15 minutes from the server's own IP (since the WP server calls the Node app).

**Find** (around lines 255–260):
```js
  // Rate limiting — general API
  app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { error: 'Too many requests' }
  }));
```

**Replace with two separate limiters:**
```js
  // Rate limiting — public widget API (called by WordPress on every page load)
  app.use('/api/public/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 3000,
    message: { error: 'Too many requests' }
  }));

  // Rate limiting — authenticated dashboard API
  app.use('/api/', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { error: 'Too many requests' }
  }));
```

**Important:** The `/api/public/` limiter MUST come BEFORE the `/api/` limiter. Express matches
middleware in order — the more specific path must be first, otherwise `/api/` catches everything.

---

## Fix 11 — Pin Chart.js CDN version in hdf-widgets.js

In `public/wp-assets/hdf-widgets.js`, Chart.js is lazy-loaded from an unpinned major version URL.

**Find** (around line 39):
```js
    s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js';
```

**Replace with pinned version:**
```js
    s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
```

---

## Fix 12 — Clean up unused variable in hdf-widgets.js cross-metal handler

This is very minor but keeps the code clean.

In `public/wp-assets/hdf-widgets.js`, inside the `'cross-metal'` widget handler, there's an
unused variable. Find and examine the cross-metal handler — if there's a `var today = ...` that
is defined but never used in the rendering logic, remove it.

---

## Summary

| # | File | Fix | Impact |
|---|---|---|---|
| 1 | `package.json` | Add `multer` dependency | App crashes on fresh deploy |
| 2 | `metals-posts.js` | Fix `metals_log` INSERT columns | Metals post logs silently fail |
| 3 | `fuel.js` | Add `'localtime'` to `date('now')` | State cities return empty data |
| 4 | `metals.js` | Remove double `totalFetched` increment in `fetchBulk` | Dashboard shows 2x real count |
| 5 | `api.js` | Remove `results` from generate-posts responses | Response always shows `{}` |
| 6 | `scripts/import-csv.js` | Delete file | Dead code, dangerous if run |
| 7 | `fuel-posts.js` + `metals-posts.js` | Remove dead `post-html.js` imports | Dead imports, confusing |
| 8 | `db.js` | Remove `recoverStaleLocks` function + export | Dead code |
| 9 | `api.js` | Fix double `db.prepare()` | Wastes CPU on every request |
| 10 | `index.js` | Split rate limiter for public vs admin API | Widget API gets throttled |
| 11 | `hdf-widgets.js` | Pin Chart.js to `@4.4.1` | Prevents breaking CDN updates |
| 12 | `hdf-widgets.js` | Remove unused `today` variable | Code cleanliness |

**After applying all fixes:**
1. Run `npm install` to confirm all deps resolve
2. Restart the app
3. Check dashboard diagnostics: `/api/diagnostics`
4. Verify widgets load on a WordPress post
5. Test the import (CSV + JSON) via dashboard
