# HDF AutoPub — Day 2 Migration Prompt
## Post Creators + WordPress Publisher + Health Panel Fixes

> **Context:** Day 1 shipped SQLite schema, FuelModule, MetalsModule, API routes, and dashboard pages. Everything works but the DB is empty (no API keys set yet, no fetch run). This prompt adds the post-generation engine that turns price data into SEO-optimized WordPress posts, plus a WP REST API publisher, plus small Day 1 gaps.

---

## PART 0 — Day 1 Health Panel Fixes (Quick)

### 0A. Add fuel & metals to health-check array

**File:** `src/routes/api.js`

Find the `GET /api/health` handler where `sources` array is built (around line 81):

```js
var sources = [firehose, trends, buffer, similarity, extractor, scheduler, infranodus];
```

Add fuel and metals from `req.app.locals.modules`:

```js
var { fuel, metals } = req.app.locals.modules || {};
var sources = [firehose, trends, buffer, similarity, extractor, scheduler, infranodus, fuel, metals].filter(Boolean);
```

### 0B. Add health cards in dashboard HTML

**File:** `public/index.html`

After the last health card (`health-infranodus`), add two more cards inside the health grid:

```html
<div class="health-card" id="health-fuel">
  <div class="health-dot"></div>
  <span class="health-label">Fuel</span>
  <span class="health-status">—</span>
</div>
<div class="health-card" id="health-metals">
  <div class="health-dot"></div>
  <span class="health-label">Metals</span>
  <span class="health-status">—</span>
</div>
```

---

## PART 1 — WordPress Publisher Module

**New file:** `src/modules/wp-publisher.js`

This module handles all WordPress REST API communication for creating/updating posts.

### Class: `WPPublisher`

```
Constructor(config, db, logger)
  - this.config = config
  - this.db = db
  - this.logger = logger
  - this.siteUrl = null    // from settings: WP_SITE_URL
  - this.username = null    // from settings: WP_USERNAME
  - this.appPassword = null // from settings: WP_APP_PASSWORD
  - this.categoryCache = {} // name → id
  - this.postCache = {}     // cacheKey → { id, slug }
```

### Settings Keys (in SQLite settings table)

| Key | Example Value |
|-----|---------------|
| `WP_SITE_URL` | `https://hdfnews.com` |
| `WP_USERNAME` | `autopub` |
| `WP_APP_PASSWORD` | `xxxx xxxx xxxx xxxx` |

### Methods

#### `async init()`
- Read WP_SITE_URL, WP_USERNAME, WP_APP_PASSWORD from settings table
- If any missing, log warning and set `this.ready = false`
- If all present, set `this.ready = true`
- Pre-load category cache via `GET /wp-json/wp/v2/categories?per_page=100`

#### `isReady()`
- Returns `this.ready`

#### `async getOrCreateCategory(name)`
- Check `this.categoryCache[name.toLowerCase()]`
- If miss, `GET /wp-json/wp/v2/categories?search={name}`
- If not found, `POST /wp-json/wp/v2/categories` with `{ name, slug: slugify(name) }`
- Cache and return category ID

#### `async findPost(slug)`
- `GET /wp-json/wp/v2/posts?slug={slug}&status=publish,draft,private&per_page=1`
- Return `{ id, slug, modified }` or null

#### `async upsertPost(opts)`
- `opts`: `{ slug, title, content, categoryNames, metaDescription, status, meta }`
- Call `findPost(slug)`
- If found: `PUT /wp-json/wp/v2/posts/{id}` (update)
- If not found: `POST /wp-json/wp/v2/posts` (create)
- Set categories via `getOrCreateCategory()` for each name
- Set `meta` object for custom fields (fuel/metal meta keys)
- Set `excerpt` = metaDescription
- Set Yoast/RankMath meta description via `meta: { _yoast_wpseo_metadesc: metaDescription }` or `rank_math_description`
- Return `{ id, slug, url, action: 'created'|'updated' }`

#### `async _wpFetch(method, path, body)`
- Base URL: `${this.siteUrl}/wp-json/wp/v2${path}`
- Auth: Basic auth with `Buffer.from(username:appPassword).toString('base64')`
- Headers: `Content-Type: application/json`, `Authorization: Basic {base64}`
- Use `fetch()` (Node 18+ built-in)
- Retry on 429 with exponential backoff (2s, 4s, 8s) — max 3 retries
- Log errors to `logger`
- Throw on 4xx/5xx (after retries)

#### `async testConnection()`
- `GET /wp-json/wp/v2/posts?per_page=1`
- Return `{ ok: true, site: siteUrl }` or `{ ok: false, error: message }`

#### `getHealth()`
- Return `{ name: 'wp-publisher', status: this.ready ? 'ok' : 'warn', message: '...' }`

---

## PART 2 — Fuel Post Creator Module

**New file:** `src/modules/fuel-posts.js`

This module generates HTML content for fuel price posts and publishes them via WPPublisher.

### Class: `FuelPostCreator`

```
Constructor(fuel, wpPublisher, db, logger)
  - this.fuel = fuel          // FuelModule instance
  - this.wp = wpPublisher     // WPPublisher instance
  - this.db = db
  - this.logger = logger
```

### Constants (top of file)

#### STATE_INFO map
A plain object with 45 entries. Each key is state name, value has: `region`, `nearby` (array of state names), `vat`, `note`.

Here are ALL entries — copy exactly:

```js
const STATE_INFO = {
  'Andhra Pradesh': { region: 'south', nearby: ['Telangana','Karnataka','Tamil Nadu','Odisha'], vat: '31%+₹4/L VAT+Cess', note: 'Visakhapatnam refinery serves the state, keeping transport costs moderate.' },
  'Arunachal Pradesh': { region: 'northeast', nearby: ['Assam','Nagaland'], vat: '20% VAT', note: 'Fuel transported from Assam refineries over mountainous terrain, adding ₹1-2/L.' },
  'Assam': { region: 'northeast', nearby: ['Meghalaya','Nagaland','Manipur','Arunachal Pradesh','Tripura','Mizoram','West Bengal'], vat: '32.66% VAT', note: 'Guwahati and Numaligarh refineries reduce transport surcharge.' },
  'Bihar': { region: 'east', nearby: ['Jharkhand','Uttar Pradesh','West Bengal'], vat: '26%+₹3.43/L surcharge', note: 'Barauni refinery provides local supply; transport adds ₹0.50-1/L for remote districts.' },
  'Chhattisgarh': { region: 'central', nearby: ['Madhya Pradesh','Odisha','Jharkhand','Maharashtra','Telangana','Uttar Pradesh'], vat: '25%+₹2/L VAT+Cess', note: 'No refinery in-state; fuel railed from Gujarat and Odisha.' },
  'Goa': { region: 'west', nearby: ['Maharashtra','Karnataka'], vat: '20.5% VAT', note: 'Small state with short supply lines from Mumbai and Mangalore refineries.' },
  'Gujarat': { region: 'west', nearby: ['Rajasthan','Maharashtra','Madhya Pradesh'], vat: '19.42%+₹4/L Cess', note: 'Jamnagar mega-refinery (world\'s largest) keeps base cost low.' },
  'Haryana': { region: 'north', nearby: ['Punjab','Rajasthan','Uttar Pradesh','Delhi'], vat: '25% VAT', note: 'Panipat refinery serves NCR region, minimal transport cost.' },
  'Himachal Pradesh': { region: 'north', nearby: ['Punjab','Haryana','Uttarakhand','Jammu & Kashmir'], vat: '25% VAT', note: 'Hilly terrain adds ₹1-3/L in transport for remote areas like Spiti and Kinnaur.' },
  'Jharkhand': { region: 'east', nearby: ['Bihar','West Bengal','Odisha','Chhattisgarh','Uttar Pradesh'], vat: '22%+₹1.50/L surcharge', note: 'No local refinery; supply from Barauni (Bihar) and Paradip (Odisha).' },
  'Karnataka': { region: 'south', nearby: ['Maharashtra','Goa','Kerala','Tamil Nadu','Andhra Pradesh','Telangana'], vat: '25.92%+₹3.02/L surcharge', note: 'Mangalore refinery (MRPL) serves the state; Bangalore adds slight transport premium.' },
  'Kerala': { region: 'south', nearby: ['Karnataka','Tamil Nadu'], vat: '30.08%+₹1/L Cess', note: 'Kochi refinery (BPCL) provides direct supply, keeping costs moderate despite high taxes.' },
  'Madhya Pradesh': { region: 'central', nearby: ['Rajasthan','Uttar Pradesh','Chhattisgarh','Maharashtra','Gujarat'], vat: '29%+₹4.5/L VAT+Cess', note: 'Large state with no refinery; fuel transported from Gujarat and UP refineries.' },
  'Maharashtra': { region: 'west', nearby: ['Gujarat','Madhya Pradesh','Chhattisgarh','Telangana','Karnataka','Goa'], vat: '25%+₹10.12/L surcharge', note: 'Mumbai HPCL/BPCL refineries serve western India; surcharge keeps prices high.' },
  'Manipur': { region: 'northeast', nearby: ['Nagaland','Assam','Mizoram'], vat: '20% VAT', note: 'Remote location with single-road supply from Assam; transport adds ₹3-5/L.' },
  'Meghalaya': { region: 'northeast', nearby: ['Assam','Bangladesh'], vat: '20% VAT', note: 'Supply from Guwahati refinery; relatively short distance keeps transport low.' },
  'Mizoram': { region: 'northeast', nearby: ['Assam','Manipur','Tripura'], vat: '25% VAT', note: 'Most remote NE state for fuel supply; single-lane roads inflate transport costs ₹4-6/L.' },
  'Nagaland': { region: 'northeast', nearby: ['Assam','Manipur','Arunachal Pradesh'], vat: '25.36% VAT', note: 'Supplied from Assam refineries via NH-29; terrain adds ₹2-3/L.' },
  'Odisha': { region: 'east', nearby: ['West Bengal','Jharkhand','Chhattisgarh','Andhra Pradesh'], vat: '28%+₹3/L surcharge', note: 'Paradip refinery (IOC) directly serves the state with low transport costs.' },
  'Punjab': { region: 'north', nearby: ['Haryana','Rajasthan','Jammu & Kashmir','Himachal Pradesh'], vat: '22.45%+₹10/L surcharge', note: 'Bathinda refinery (HMEL-HPCL) serves the state; high surcharge inflates retail price.' },
  'Rajasthan': { region: 'west', nearby: ['Gujarat','Madhya Pradesh','Uttar Pradesh','Haryana','Punjab'], vat: '36%+₹1500/KL Cess', note: 'Highest VAT state; Barmer refinery (under construction) will reduce costs once operational.' },
  'Sikkim': { region: 'northeast', nearby: ['West Bengal'], vat: '17.50% VAT', note: 'Supplied from Siliguri depot; mountain roads add ₹2-4/L for northern districts.' },
  'Tamil Nadu': { region: 'south', nearby: ['Kerala','Karnataka','Andhra Pradesh','Puducherry'], vat: '15%+₹11.52/L surcharge', note: 'Chennai refinery (IOC) and Narimanam refinery keep southern Tamil Nadu well-supplied.' },
  'Telangana': { region: 'south', nearby: ['Andhra Pradesh','Maharashtra','Karnataka','Chhattisgarh'], vat: '35.20% VAT', note: 'No in-state refinery; supply from Visakhapatnam and Mangalore.' },
  'Tripura': { region: 'northeast', nearby: ['Assam','Mizoram'], vat: '15%+₹5/L surcharge', note: 'Natural gas-rich state but no refinery; fuel from Assam via NH-8.' },
  'Uttar Pradesh': { region: 'north', nearby: ['Uttarakhand','Haryana','Rajasthan','Madhya Pradesh','Bihar','Jharkhand'], vat: '26.80%+₹2/L surcharge', note: 'Mathura refinery (IOC) serves NCR/western UP; Barauni covers eastern UP.' },
  'Uttarakhand': { region: 'north', nearby: ['Uttar Pradesh','Himachal Pradesh'], vat: '25%+₹2/L Cess', note: 'No refinery; supplied from Mathura and Panipat; hills add transport cost for Garhwal/Kumaon.' },
  'West Bengal': { region: 'east', nearby: ['Bihar','Jharkhand','Odisha','Sikkim','Assam'], vat: '25%+₹6.12/L surcharge', note: 'Haldia refinery (IOC) serves southern WB; Siliguri depot for north Bengal.' },
  'Andaman and Nicobar Islands': { region: 'island', nearby: [], vat: '6% VAT', note: 'Fuel shipped from Chennai; sea freight adds ₹2-3/L. Lowest VAT in India.' },
  'Chandigarh': { region: 'north', nearby: ['Punjab','Haryana'], vat: '22.45% VAT', note: 'UT adjacent to Panipat refinery; minimal transport cost.' },
  'Dadra and Nagar Haveli and Daman and Diu': { region: 'west', nearby: ['Gujarat','Maharashtra'], vat: '15% VAT', note: 'Proximity to Jamnagar mega-refinery keeps supply cost rock-bottom.' },
  'Delhi': { region: 'north', nearby: ['Haryana','Uttar Pradesh'], vat: '19.40% VAT', note: 'Served by Mathura and Panipat refineries within 150 km; high volume keeps per-unit cost low.' },
  'Jammu & Kashmir': { region: 'north', nearby: ['Himachal Pradesh','Punjab','Ladakh'], vat: '24%+₹0.50/L Cess', note: 'Valley districts rely on Jawahar Tunnel supply route; winter closures cause seasonal price spikes.' },
  'Ladakh': { region: 'north', nearby: ['Jammu & Kashmir'], vat: '10% VAT', note: 'Highest transport cost in India; Zoji La and Tanglang La passes limit supply months. Prices ₹5-10/L above national avg.' },
  'Lakshadweep': { region: 'island', nearby: [], vat: '0% VAT', note: 'Only UT with zero fuel tax. Supply shipped from Kochi; limited demand keeps logistics expensive per unit.' },
  'Puducherry': { region: 'south', nearby: ['Tamil Nadu'], vat: '17.18% VAT', note: 'Small UT adjacent to Chennai refinery catchment; competitive pricing with Tamil Nadu.' },
  'Meghalaya': { region: 'northeast', nearby: ['Assam'], vat: '20% VAT', note: 'Supply from Guwahati refinery; relatively short distance keeps transport low.' },
};
```

#### TOP_CITIES (for cross-link pills)
```js
const TOP_CITIES = ['Delhi','Mumbai','Bangalore','Chennai','Hyderabad','Kolkata','Ahmedabad','Pune','Jaipur','Lucknow'];
```

### Methods

#### `async runPostGeneration(fuelType)`
- `fuelType`: `'petrol'` or `'diesel'`
- Check `this.wp.isReady()` — if not, log warning and return
- Get today's summary from `this.fuel.getTodaySummary()`
- If no prices fetched today, log and return
- Run in order:
  1. City posts (only for cities with `has_post=1` and today's price)
  2. State posts (for all states that have at least 1 city price today)
  3. National posts (1 per fuel type)
- Log total created/updated counts
- Log to `fuel_log` table

#### `async generateCityPost(city, state, fuelType)`
- Query today's price: `SELECT * FROM fuel_prices WHERE city=? AND price_date=date('now') LIMIT 1`
- Query yesterday's price for delta
- Query 7-day history for table
- Query 30-day history for trend analysis
- Query same-state cities for pills
- Get STATE_INFO for the state
- Build HTML content using sections below
- Build title: `"{Fuel} Price in {City} Today ({date}) — Current Rate"`
  - `{Fuel}` = `Petrol` or `Diesel` (capitalized)
  - `{date}` = format `j M Y` e.g. `10 Apr 2026`
- Build slug: `{fuel}-price-in-{city_slug}-today`
  - `city_slug` = lowercase, spaces→hyphens, remove special chars
- Build metaDescription: `"{Fuel} price in {city} today is ₹{price}/litre ({date}). Compare with other {state} cities, view 30-day chart, and check daily rate history."` (max 160 chars)
- Call `this.wp.upsertPost({ slug, title, content, categoryNames: [fuelType === 'petrol' ? 'Petrol' : 'Diesel'], metaDescription, meta: { _hdf_fuel_city: city, _hdf_fuel_state: state, _hdf_fuel_type: fuelType } })`

#### City Post HTML Sections (in order)

1. **Hero section** — `<div class="hdf-hero">`
   - Price: `₹{price}/litre`
   - Delta badge: `▲ ₹{delta} ({pct}%)` green if up, `▼` red if down, `→ No Change` gray if flat
   - Date + LIVE badge
   - Source: `Indian Oil Corporation, BPCL, HPCL Daily Bulletin`
   - Alt fuel link: `Also check: <a href="/{altFuel}-price-in-{slug}-today">{AltFuel} Price in {City}</a>`

2. **Intro paragraph** — `<p>`
   - `"Today's {fuel} price in {city} is ₹{price}/litre, {changeText}. Prices include {state} VAT at {vat}."`

3. **Fill-Up Cost Calculator** — `<div class="hdf-calc">`
   - `<h2>Fill-Up Cost Calculator — {City}</h2>`
   - Table with columns: Litres | Cost (₹)
   - Rows: 5L, 10L, 20L, Full Tank (45L for petrol, 55L for diesel)
   - Format costs with 2 decimals

4. **Price Breakdown** — `<div class="hdf-breakdown">`
   - `<h2>{Fuel} Price Breakdown in {City}</h2>`
   - Table: Component | Approx. Share
   - Rows: Base Price (~45-50%), Central Excise (~20-25%), State VAT ({vat}), Dealer Commission (~3-4%), **Total: ₹{price}**

5. **7-Day History Table** — `<div class="hdf-history">`
   - `<h2>{Fuel} Price History in {City} — Last 7 Days</h2>`
   - Table: Date | Price (₹/L) | Change | %
   - Highlight today's row with `class="hdf-today"`

6. **Price Trend Chart placeholder** — `<div class="hdf-chart">`
   - `<h2>{Fuel} Price Trend — {City}</h2>`
   - `<canvas id="hdf-fuel-chart" data-city="{city}" data-fuel="{fuel}" data-rest="{siteUrl}/wp-json/hdf-fuel/v1"></canvas>`
   - Buttons: 7D, 30D (default active), 90D, 1Y, All

7. **30-Day Trend Analysis** — `<div class="hdf-trend">`
   - `<h2>30-Day Trend Analysis</h2>`
   - Compute: min, max, avg, range, direction (increased/decreased/stable), count of ups/downs
   - Paragraph: `"Over the last 30 days, {fuel} prices in {city} have {direction} from ₹{start} to ₹{end}. The highest was ₹{max} on {maxDate} and lowest ₹{min} on {minDate}. Prices {stability_text}."`
   - Stability: range < 0.50 → "highly stable", < 1.50 → "relatively stable", else "moderately volatile"

8. **Same-State Cities pills** — `<div class="hdf-state-cities">`
   - `<h2>{Fuel} Price in Other {State} Cities</h2>`
   - For each city in state (exclude current), render: `<a class="hdf-pill" href="/{fuel}-price-in-{slug}-today">{city} ₹{price}</a>`

9. **Top Cities pills** — `<div class="hdf-top-cities">`
   - `<h2>{Fuel} Price in Major Indian Cities</h2>`
   - For each city in TOP_CITIES (exclude current): `<a class="hdf-pill" href="/{fuel}-price-in-{slug}-today">{city} ₹{price}</a>`

10. **About Pricing** — `<div class="hdf-about">`
    - `<h2>About {Fuel} Pricing in {State}</h2>`
    - `<p>{STATE_INFO[state].note}</p>`
    - `<p>Current VAT/tax structure: {vat}. Prices are revised daily at 6:00 AM by oil marketing companies based on international crude benchmarks.</p>`

11. **Cross-Metal Links** — `<div class="hdf-cross">`
    - `<p>Also check: <a href="/gold-price-in-{slug}-today">Gold Price in {City}</a> | <a href="/silver-price-in-{slug}-today">Silver Price in {City}</a></p>`

12. **Breadcrumb** — `<nav class="hdf-breadcrumb">`
    - `<a href="/{fuel}-price-in-{state_slug}-today">{Fuel} in {State}</a> › <a href="/{fuel}-price-in-india-today">{Fuel} in India</a> › {City}`

13. **FAQ** — `<div class="hdf-faq">`
    - `<h2>Frequently Asked Questions</h2>`
    - 5 items as `<div class="hdf-faq-item"><h3>{question}</h3><p>{answer}</p></div>`
    - Q1: "What is today's {fuel} price in {city}?" → "Today's {fuel} price in {city} is ₹{price} per litre as of {date}."
    - Q2: "Why did {fuel} price change in {city}?" → "Fuel prices are revised daily based on international crude oil prices, USD-INR exchange rates, and {state} VAT at {vat}."
    - Q3: "Which is the cheapest city for {fuel} in {state}?" → "Check our {state} page for a full comparison of all {cityCount} cities."
    - Q4: "How is {fuel} price decided in India?" → "Oil marketing companies (IOC, BPCL, HPCL) revise prices daily at 6 AM based on 15-day rolling average of international benchmark and exchange rates, plus central excise and state taxes."
    - Q5: "How much does a full tank of {fuel} cost in {city}?" → "A full tank ({tankSize}L) of {fuel} in {city} costs approximately ₹{fullTankCost} at today's rate."

14. **FAQ Schema JSON-LD** — `<script type="application/ld+json">`
    - Standard FAQPage schema with the 5 Q&A pairs above

#### `async generateStatePost(state, fuelType)`
- Query all cities in state with today's price
- Query state average
- Get STATE_INFO
- Get nearby states with their averages
- **Title:** `"{Fuel} Price in {State} Today ({date}) — All Cities"`
- **Slug:** `{fuel}-price-in-{state_slug}-today`
- **Meta:** `{ _hdf_fuel_state: state, _hdf_fuel_type: fuelType, _hdf_fuel_is_state: '1' }`

**Sections:**
1. Hero with state average, city count, VAT badge
2. Intro paragraph
3. All Cities table: City | Today's Price | Source — link each city to its post
4. District table (cities with `has_post=0`): District | Price (₹/L) — no links
5. State VAT explanation section
6. Chart placeholder (data-state attribute)
7. Cross-fuel link
8. National hub link
9. Nearby States Comparison table: State | Avg Price — highlight current state row
10. About section from STATE_INFO
11. FAQ (5 items, state-level)

#### `async generateNationalPost(fuelType)`
- Query all state averages
- Query national average
- Get top cities prices
- **Title:** `"{Fuel} Price in India Today ({date}) — All States & Cities"`
- **Slug:** `{fuel}-price-in-india-today`
- **Meta:** `{ _hdf_fuel_type: fuelType, _hdf_fuel_is_national: '1' }`

**Sections:**
1. Hero with national average, state count, city count
2. Intro paragraph
3. State-wise table: State | Avg Price | Min | Max | Cities — linked
4. Major Cities table: City | State | Price — linked
5. Most/Least Expensive States (top 5 each)
6. Chart placeholder (national)
7. How Prices Are Decided (static educational paragraph about dynamic daily pricing)
8. Cross-fuel link
9. Cross-metal links (gold, silver national)
10. FAQ (5 items, national-level)

### Formatting Helpers (top of file or in utils)

```js
function fmtPrice(n) { return n ? Number(n).toFixed(2) : '—'; }
function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
function fmtDate(d) { /* format as "10 Apr 2026" from YYYY-MM-DD */ }
function changeText(delta) {
  if (!delta || delta === 0) return 'unchanged from yesterday';
  return delta > 0
    ? `up ₹${Math.abs(delta).toFixed(2)} from yesterday`
    : `down ₹${Math.abs(delta).toFixed(2)} from yesterday`;
}
function changeBadge(delta) {
  if (!delta || delta === 0) return '<span class="hdf-flat">→ No Change</span>';
  return delta > 0
    ? `<span class="hdf-up">▲ ₹${Math.abs(delta).toFixed(2)}</span>`
    : `<span class="hdf-down">▼ ₹${Math.abs(delta).toFixed(2)}</span>`;
}
```

---

## PART 3 — Metals Post Creator Module

**New file:** `src/modules/metals-posts.js`

### Class: `MetalsPostCreator`

```
Constructor(metals, wpPublisher, db, logger)
  - this.metals = metals
  - this.wp = wpPublisher
  - this.db = db
  - this.logger = logger
```

### Constants

#### METAL_CONFIG
```js
const METAL_CONFIG = {
  gold: {
    label: 'Gold',
    source: 'IBJA (Indian Bullion and Jewellers Association)',
    variants: ['24K', '22K', '18K'],
    priceColumns: { '24K': 'price_24k', '22K': 'price_22k', '18K': 'price_18k' },
    weightRows: [1, 2, 4, 8, 10, 20, 50, 100],  // grams
    weightUnit: 'gram',
    titleSuffix: '24K, 22K, 18K Rates',
    gst: '3% on value + 5% on making charges',
    importDuty: '15%',
  },
  silver: {
    label: 'Silver',
    source: 'IBJA (Indian Bullion and Jewellers Association)',
    variants: [],
    priceColumns: { '1g': 'price_1g' },
    weightRows: [1, 10, 50, 100, 500, 1000],  // grams (1000g = 1kg)
    weightUnit: 'gram',
    titleSuffix: 'Per Gram & Per KG',
    gst: '3%',
    importDuty: '15%',
  },
  platinum: {
    label: 'Platinum',
    source: 'IBJA (Indian Bullion and Jewellers Association)',
    variants: [],
    priceColumns: { '1g': 'price_1g' },
    weightRows: [1, 10, 50, 100, 500, 1000],
    weightUnit: 'gram',
    titleSuffix: 'Per Gram Rate',
    gst: '3%',
    importDuty: '15.4%',
  }
};
```

### Methods

#### `async runPostGeneration(metalType)`
- `metalType`: `'gold'`, `'silver'`, or `'platinum'`
- Check `this.wp.isReady()`
- Get today's summary from `this.metals.getTodaySummary()`
- If no prices, log and return
- Generate city → state → national posts
- Log to `metals_log`

#### `async generateCityPost(city, metalType)`
- Query today's prices (all karat columns)
- Query yesterday for delta
- Query 7-day history
- Query 30-day history for trend
- Query same-state cities
- **Title:**
  - Gold: `"Gold Price in {City} Today ({date}) — 24K, 22K, 18K Rates"`
  - Silver: `"Silver Price in {City} Today ({date}) — Per Gram & Per KG"`
  - Platinum: `"Platinum Price in {City} Today ({date}) — Per Gram Rate"`
- **Slug:** `{metal}-price-in-{city_slug}-today`
- **Category:** `Gold`, `Silver`, or `Platinum`
- **Meta:** `{ _hdf_metal_city: city, _hdf_metal_type: metalType }`

#### City Post HTML Sections

1. **Hero** — Primary price per gram + delta + LIVE badge + source IBJA
   - If gold: also show 22K and 18K in hero badges
2. **Intro** — `"Today's {metal} price in {city} is ₹{price}/gram, {changeText}. Rates from IBJA, include import duties and GST."`
3. **Weight Table**
   - Gold: Weight | 24K Price | 22K Price | 18K Price
   - Silver/Platinum: Weight | Price
   - Use METAL_CONFIG.weightRows; for 1000g row, display as "1 KG"
4. **Investment Calculator** — same weight table but with total cost column
5. **7-Day History Table** — Date | Price | Change | %
6. **Chart placeholder** — `data-city data-metal`
7. **30-Day Trend Analysis** — narrative paragraph (same logic as fuel)
8. **Cross-Metal Pills** — links to other metals for same city (exclude current)
9. **Same-State City Pills** — all cities in state with current price
10. **Top Cities Pills** — 10 major cities
11. **About Pricing** — LBMA explanation, import duty, GST per metal type
12. **Price Breakdown** — International Spot | USD-INR Exchange | Import Duty | GST | Making Charges (8-35%)
13. **Breadcrumb** — State → National → Current
14. **Cross-Fuel Links** — `"Also check: Petrol/Diesel Price in {City}"`
15. **FAQ** (5 items) — per-metal GST differences

#### `async generateStatePost(state, metalType)`
- Title: `"{Metal} Price in {State} Today ({date}) — {variants} All Cities"`
- Slug: `{metal}-price-in-{state_slug}-today`
- Sections: hero, cross-metal pills, all cities table (gold shows 3 columns, silver/platinum shows 1), chart, national link, cross-fuel links, FAQ

#### `async generateNationalPost(metalType)`
- Title: `"{Metal} Price in India Today ({date}) — {variants} All Cities"`
- Slug: `{metal}-price-in-india-today`
- Sections: hero, cross-metal pills, state-wise table, most/least expensive states, major cities table (20 cities), chart, cross-metal links, cross-fuel links, about IBJA/LBMA, FAQ

### Indian Price Formatter
```js
function indianFormat(num) {
  if (num < 100000) return Number(num).toFixed(2);
  const parts = Number(num).toFixed(2).split('.');
  let intPart = parts[0];
  const lastThree = intPart.slice(-3);
  const remaining = intPart.slice(0, -3);
  const formatted = remaining.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return (remaining ? formatted + ',' : '') + lastThree + '.' + parts[1];
}
```

---

## PART 4 — Cron Jobs for Post Generation

### Wire into FuelModule (`src/modules/fuel.js`)

Add a new cron job after the existing fetch and autofill crons:

```js
// 06:30 IST — Generate posts after fetch completes
this.postCron = cron.schedule('30 6 * * *', async () => {
  this.logger.info('[Fuel] Post generation cron triggered');
  if (this.postCreator) {
    await this.postCreator.runPostGeneration('petrol');
    await this.postCreator.runPostGeneration('diesel');
  }
}, { timezone: 'Asia/Kolkata' });
```

Add method to accept post creator:
```js
setPostCreator(creator) { this.postCreator = creator; }
```

### Wire into MetalsModule (`src/modules/metals.js`)

```js
// 07:30 IST — Generate posts after fetch + autofill
this.postCron = cron.schedule('30 7 * * *', async () => {
  this.logger.info('[Metals] Post generation cron triggered');
  if (this.postCreator) {
    await this.postCreator.runPostGeneration('gold');
    await this.postCreator.runPostGeneration('silver');
    await this.postCreator.runPostGeneration('platinum');
  }
}, { timezone: 'Asia/Kolkata' });
```

Add `setPostCreator(creator)` method.

### Wire into index.js

After initializing fuel, metals, and wpPublisher:

```js
const { WPPublisher } = require('./modules/wp-publisher');
const { FuelPostCreator } = require('./modules/fuel-posts');
const { MetalsPostCreator } = require('./modules/metals-posts');

const wpPublisher = new WPPublisher(config, db, logger);
await wpPublisher.init();

const fuelPosts = new FuelPostCreator(fuel, wpPublisher, db, logger);
const metalsPosts = new MetalsPostCreator(metals, wpPublisher, db, logger);

fuel.setPostCreator(fuelPosts);
metals.setPostCreator(metalsPosts);

// Expose for API routes
app.locals.modules.wpPublisher = wpPublisher;
app.locals.modules.fuelPosts = fuelPosts;
app.locals.modules.metalsPosts = metalsPosts;
```

---

## PART 5 — API Routes for Post Generation

**File:** `src/routes/api.js`

### New Endpoints

```
POST /api/fuel/generate-posts
  - Body: { fuelType: 'petrol'|'diesel'|'both' }
  - Default: 'both'
  - Calls fuelPosts.runPostGeneration() for specified type(s)
  - Returns: { ok: true, results: { petrol: { created, updated }, diesel: { created, updated } } }

POST /api/metals/generate-posts
  - Body: { metalType: 'gold'|'silver'|'platinum'|'all' }
  - Default: 'all'
  - Calls metalsPosts.runPostGeneration() for specified type(s)
  - Returns: { ok: true, results: { gold: { created, updated }, ... } }

POST /api/wp/test
  - Tests WordPress connection via wpPublisher.testConnection()
  - Returns: { ok: true/false, site, error }

GET /api/wp/health
  - Returns wpPublisher.getHealth()
```

---

## PART 6 — Dashboard UI Updates

### 6A. Fuel Page — Add "Generate Posts" Button

**File:** `public/index.html`

In the Fuel page header (next to "Fetch All Prices" and "Refresh" buttons), add:

```html
<button class="btn btn-blue" onclick="triggerFuelPosts()">📝 Generate Posts</button>
```

### 6B. Metals Page — Add "Generate Posts" Button

Same pattern — add next to existing buttons:

```html
<button class="btn btn-blue" onclick="triggerMetalsPosts()">📝 Generate Posts</button>
```

### 6C. Dashboard JavaScript

**File:** `public/js/dashboard.js`

```js
async function triggerFuelPosts() {
  if (!confirm('Generate/update all fuel WordPress posts?')) return;
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = '⏳ Generating...';
  try {
    const res = await fetch('/api/fuel/generate-posts', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ fuelType: 'both' }) });
    const data = await res.json();
    if (data.ok) {
      showToast(`Posts generated! Petrol: ${data.results.petrol.created}+${data.results.petrol.updated}, Diesel: ${data.results.diesel.created}+${data.results.diesel.updated}`);
    } else {
      showToast('Error: ' + (data.error || 'Unknown'), 'error');
    }
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = '📝 Generate Posts'; }
}

async function triggerMetalsPosts() {
  if (!confirm('Generate/update all metals WordPress posts?')) return;
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = '⏳ Generating...';
  try {
    const res = await fetch('/api/metals/generate-posts', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ metalType: 'all' }) });
    const data = await res.json();
    if (data.ok) {
      const r = data.results;
      showToast(`Gold: ${r.gold.created}+${r.gold.updated}, Silver: ${r.silver.created}+${r.silver.updated}, Platinum: ${r.platinum.created}+${r.platinum.updated}`);
    } else {
      showToast('Error: ' + (data.error || 'Unknown'), 'error');
    }
  } catch(e) { showToast('Error: ' + e.message, 'error'); }
  finally { btn.disabled = false; btn.textContent = '📝 Generate Posts'; }
}
```

### 6D. Settings Page — Add WordPress Credentials Section

**File:** `public/index.html`

In the Settings page, add a new card after the RapidAPI keys section:

```html
<div class="card">
  <h3>WordPress Publishing</h3>
  <p class="text-muted">WordPress REST API credentials for post publishing. Create an Application Password in WordPress under Users → Your Profile → Application Passwords.</p>
  <div class="form-group">
    <label>Site URL</label>
    <input type="url" id="setting-WP_SITE_URL" placeholder="https://hdfnews.com" />
  </div>
  <div class="form-group">
    <label>Username</label>
    <input type="text" id="setting-WP_USERNAME" placeholder="autopub" />
  </div>
  <div class="form-group">
    <label>Application Password</label>
    <input type="password" id="setting-WP_APP_PASSWORD" placeholder="xxxx xxxx xxxx xxxx" />
  </div>
  <div class="btn-row">
    <button class="btn btn-secondary" onclick="testWPConnection()">🔗 Test Connection</button>
    <button class="btn btn-primary" onclick="saveSettings()">💾 Save</button>
  </div>
  <div id="wp-test-result" class="mt-2"></div>
</div>
```

**File:** `public/js/dashboard.js`

```js
async function testWPConnection() {
  const el = document.getElementById('wp-test-result');
  el.textContent = 'Testing...';
  try {
    const res = await fetch('/api/wp/test', { method: 'POST' });
    const data = await res.json();
    el.textContent = data.ok ? `✅ Connected to ${data.site}` : `❌ ${data.error}`;
    el.className = data.ok ? 'text-success mt-2' : 'text-danger mt-2';
  } catch(e) { el.textContent = '❌ ' + e.message; el.className = 'text-danger mt-2'; }
}
```

---

## PART 7 — Settings API Update

**File:** `src/routes/api.js`

Make sure the `GET /api/settings` and `POST /api/settings` endpoints handle these new keys:

- `WP_SITE_URL` — not sensitive, show as-is
- `WP_USERNAME` — not sensitive, show as-is
- `WP_APP_PASSWORD` — **SENSITIVE** — add to SENSITIVE_KEYS array, mask in GET response

Also ensure `POST /api/settings` calls `wpPublisher.init()` after saving WP settings so the publisher picks up new credentials without restart:

```js
// After saving settings, re-init WP publisher if WP keys changed
const wpKeys = ['WP_SITE_URL', 'WP_USERNAME', 'WP_APP_PASSWORD'];
if (Object.keys(req.body).some(k => wpKeys.includes(k))) {
  const wpPub = req.app.locals.modules.wpPublisher;
  if (wpPub) await wpPub.init();
}
```

---

## CRON SCHEDULE SUMMARY (All IST)

| Time | Module | Action |
|------|--------|--------|
| 06:00 | Fuel | Fetch all city prices from RapidAPI |
| 06:15 | Metals | Fetch gold/silver/platinum bulk prices |
| 06:30 | Fuel | Generate/update all petrol + diesel WordPress posts |
| 07:00 | Fuel | Autofill missing prices (7-day carryforward) |
| 07:00 | Metals | Autofill missing prices |
| 07:30 | Metals | Generate/update all gold/silver/platinum WordPress posts |

---

## IMPORTANT NOTES

1. **Do NOT use any WordPress SDK/library** — use raw `fetch()` with Basic Auth. Keep it lightweight.
2. **Rate-limit WP API calls** — add a small delay (200ms) between consecutive upsertPost calls to avoid overwhelming WP.
3. **Post content is pure HTML** — no shortcodes, no Gutenberg blocks. Just clean semantic HTML with BEM-style classes (`hdf-hero`, `hdf-calc`, `hdf-history`, etc.).
4. **All CSS classes use `hdf-` prefix** — the WordPress theme handles styling. We only output structure.
5. **FAQ Schema** is embedded only in city-level fuel posts (in a `<script type="application/ld+json">` tag). Metal posts rely on RankMath for schema.
6. **runPostGeneration() should return `{ created: N, updated: N }`** so the API can report results.
7. **Graceful degradation** — if WP publisher is not configured (no credentials), post generation should log a warning and skip, never crash.
8. **shutdown()** — both fuel and metals modules should stop the postCron in their shutdown() methods.
