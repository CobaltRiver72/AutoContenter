'use strict';

const MODULE = 'fuel-posts';

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function fmtPrice(n) { return n ? Number(n).toFixed(2) : '—'; }
function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }
function fmtDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
}
function changeText(delta) {
  if (!delta || delta === 0) return 'unchanged from yesterday';
  return delta > 0 ? 'up ₹' + Math.abs(delta).toFixed(2) + ' from yesterday' : 'down ₹' + Math.abs(delta).toFixed(2) + ' from yesterday';
}
function changeBadge(delta) {
  if (!delta || delta === 0) return '<span class="hdf-flat">→ No Change</span>';
  return delta > 0
    ? '<span class="hdf-up">▲ ₹' + Math.abs(delta).toFixed(2) + '</span>'
    : '<span class="hdf-down">▼ ₹' + Math.abs(delta).toFixed(2) + '</span>';
}

// ---------------------------------------------------------------------------
// Top cities for cross-linking
// ---------------------------------------------------------------------------

const TOP_CITIES = ['Delhi','Mumbai','Bangalore','Chennai','Hyderabad','Kolkata','Ahmedabad','Pune','Jaipur','Lucknow'];

// ---------------------------------------------------------------------------
// State information map (VAT, notes, nearby states, region)
// ---------------------------------------------------------------------------

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
};

// ---------------------------------------------------------------------------
// FuelPostCreator class
// ---------------------------------------------------------------------------

class FuelPostCreator {
  /**
   * @param {object} fuel - FuelModule instance
   * @param {object} wpPublisher - WPPublisher instance
   * @param {import('better-sqlite3').Database} db
   * @param {object} logger
   */
  constructor(fuel, wpPublisher, db, logger) {
    this.fuel = fuel;
    this.wp = wpPublisher;
    this.db = db;
    this.logger = logger;
  }

  // =========================================================================
  // runPostGeneration — main entry point
  // =========================================================================

  async runPostGeneration(fuelType) {
    if (!this.wp.isReady()) {
      this.logger.warn(MODULE, 'WP publisher not ready, skipping post generation for ' + fuelType);
      return { created: 0, updated: 0 };
    }

    const today = new Date().toISOString().slice(0, 10);

    // Get cities with today's price
    const cities = this.db.prepare(
      'SELECT fc.city_name, fc.state, fp.petrol, fp.diesel ' +
      'FROM fuel_cities fc ' +
      'INNER JOIN fuel_prices fp ON fc.city_name = fp.city AND fp.price_date = ? ' +
      'WHERE fc.has_post = 1 AND fc.is_enabled = 1'
    ).all(today);

    // Distinct states
    const stateSet = new Set();
    for (const c of cities) {
      stateSet.add(c.state);
    }
    const states = Array.from(stateSet);

    let created = 0;
    let updated = 0;

    // City posts
    for (const c of cities) {
      try {
        const action = await this.generateCityPost(c.city_name, c.state, fuelType);
        if (action === 'created') created++;
        else if (action === 'updated') updated++;
      } catch (err) {
        this.logger.error(MODULE, 'City post failed for ' + c.city_name + ': ' + err.message);
      }
      await new Promise(r => setTimeout(r, 200));
    }

    // State posts
    for (const state of states) {
      try {
        const action = await this.generateStatePost(state, fuelType);
        if (action === 'created') created++;
        else if (action === 'updated') updated++;
      } catch (err) {
        this.logger.error(MODULE, 'State post failed for ' + state + ': ' + err.message);
      }
      await new Promise(r => setTimeout(r, 200));
    }

    // National post
    try {
      const action = await this.generateNationalPost(fuelType);
      if (action === 'created') created++;
      else if (action === 'updated') updated++;
    } catch (err) {
      this.logger.error(MODULE, 'National post failed: ' + err.message);
    }

    // Log summary
    this.db.prepare(
      'INSERT INTO fuel_log (log_type, source, message) VALUES (?, ?, ?)'
    ).run('info', 'post-gen', fuelType + ' post generation complete: ' + created + ' created, ' + updated + ' updated (' + cities.length + ' cities, ' + states.length + ' states)');

    return { created, updated };
  }

  // =========================================================================
  // generateCityPost
  // =========================================================================

  async generateCityPost(city, state, fuelType) {
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    // Today's price
    const row = this.db.prepare(
      'SELECT petrol, diesel FROM fuel_prices WHERE city = ? AND price_date = ?'
    ).get(city, today);
    if (!row) return null;

    // Yesterday's price for delta
    const yesterdayRow = this.db.prepare(
      'SELECT petrol, diesel FROM fuel_prices WHERE city = ? AND price_date = ?'
    ).get(city, yesterday);

    const price = fuelType === 'petrol' ? row.petrol : row.diesel;
    const yesterdayPrice = yesterdayRow ? (fuelType === 'petrol' ? yesterdayRow.petrol : yesterdayRow.diesel) : null;
    const delta = price && yesterdayPrice ? Math.round((price - yesterdayPrice) * 100) / 100 : 0;
    const pctChange = yesterdayPrice > 0 ? Math.round((delta / yesterdayPrice) * 10000) / 100 : 0;

    // 7-day history
    const history7 = this.db.prepare(
      'SELECT price_date, petrol, diesel FROM fuel_prices WHERE city = ? AND price_date >= date(?, \'-7 days\') ORDER BY price_date DESC'
    ).all(city, today);

    // 30-day history
    const history30 = this.db.prepare(
      'SELECT price_date, petrol, diesel FROM fuel_prices WHERE city = ? AND price_date >= date(?, \'-30 days\') ORDER BY price_date ASC'
    ).all(city, today);

    // Same-state cities with today's prices
    const stateCities = this.db.prepare(
      'SELECT fc.city_name, fp.petrol, fp.diesel FROM fuel_cities fc ' +
      'INNER JOIN fuel_prices fp ON fc.city_name = fp.city AND fp.price_date = ? ' +
      'WHERE fc.state = ? AND fc.is_enabled = 1 ORDER BY fc.city_name'
    ).all(today, state);

    const stateInfo = STATE_INFO[state] || { vat: 'varies', note: '', nearby: [], region: '' };
    const fuelLabel = fuelType === 'petrol' ? 'Petrol' : 'Diesel';
    const altFuel = fuelType === 'petrol' ? 'diesel' : 'petrol';
    const altLabel = fuelType === 'petrol' ? 'Diesel' : 'Petrol';
    const tankSize = fuelType === 'petrol' ? 45 : 55;
    const dateStr = fmtDate(today);
    const slug = slugify(fuelType + '-price-in-' + city + '-today');
    const title = fuelLabel + ' Price in ' + city + ' Today (' + dateStr + ') — Current Rate';
    let metaDescription = fuelLabel + ' price in ' + city + ' today is ₹' + fmtPrice(price) + '/litre (' + dateStr + '). Compare with other ' + state + ' cities, view 30-day chart, and check daily rate history.';
    if (metaDescription.length > 160) {
      metaDescription = metaDescription.substring(0, 157) + '...';
    }

    // Build alt fuel slug for cross-link
    const altSlug = slugify(altFuel + '-price-in-' + city + '-today');

    // -----------------------------------------------------------------------
    // Build HTML content — 14 sections
    // -----------------------------------------------------------------------

    let html = '';

    // ---- Section 1: Hero ----
    html += '<div class="hdf-hero">\n';
    html += '  <div class="hdf-hero-price">\n';
    html += '    <span class="hdf-hero-label">' + fuelLabel + ' Price in ' + city + '</span>\n';
    html += '    <span class="hdf-hero-value">₹' + fmtPrice(price) + '<small>/litre</small></span>\n';
    html += '    <span class="hdf-hero-change">' + changeBadge(delta) + '</span>\n';
    html += '  </div>\n';
    html += '  <div class="hdf-hero-meta">\n';
    html += '    <span class="hdf-hero-date">' + dateStr + ' <span class="hdf-live-badge">LIVE</span></span>\n';
    html += '    <span class="hdf-hero-source">Source: Indian Oil Corporation, BPCL, HPCL Daily Bulletin</span>\n';
    html += '    <a class="hdf-hero-alt" href="/' + altSlug + '/">Check ' + altLabel + ' Price in ' + city + ' →</a>\n';
    html += '  </div>\n';
    html += '</div>\n\n';

    // ---- Section 2: Intro paragraph ----
    html += '<p>Today\'s ' + fuelLabel.toLowerCase() + ' price in ' + city + ' is <strong>₹' + fmtPrice(price) + '/litre</strong>, ' + changeText(delta) + '. ';
    html += 'Prices include ' + state + ' VAT at ' + stateInfo.vat + '.</p>\n\n';

    // ---- Section 3: Fill-Up Calculator ----
    html += '<h2>Fill-Up Cost Calculator — ' + fuelLabel + ' in ' + city + '</h2>\n';
    html += '<table class="hdf-table hdf-calc-table">\n';
    html += '  <thead><tr><th>Litres</th><th>Cost (₹)</th></tr></thead>\n';
    html += '  <tbody>\n';
    const calcLitres = [5, 10, 20, tankSize];
    const calcLabels = ['5L', '10L', '20L', 'Full Tank (' + tankSize + 'L)'];
    for (let i = 0; i < calcLitres.length; i++) {
      const cost = price ? (price * calcLitres[i]).toFixed(2) : '—';
      html += '    <tr><td>' + calcLabels[i] + '</td><td>₹' + cost + '</td></tr>\n';
    }
    html += '  </tbody>\n';
    html += '</table>\n\n';

    // ---- Section 4: Price Breakdown ----
    html += '<h2>' + fuelLabel + ' Price Breakdown in ' + city + '</h2>\n';
    html += '<table class="hdf-table hdf-breakdown-table">\n';
    html += '  <thead><tr><th>Component</th><th>Approx. Share</th></tr></thead>\n';
    html += '  <tbody>\n';
    html += '    <tr><td>Base Price (Refinery)</td><td>~45-50%</td></tr>\n';
    html += '    <tr><td>Central Excise Duty</td><td>~20-25%</td></tr>\n';
    html += '    <tr><td>State VAT (' + stateInfo.vat + ')</td><td>Varies</td></tr>\n';
    html += '    <tr><td>Dealer Commission</td><td>~3-4%</td></tr>\n';
    html += '    <tr><td><strong>Total Retail Price</strong></td><td><strong>₹' + fmtPrice(price) + '/L</strong></td></tr>\n';
    html += '  </tbody>\n';
    html += '</table>\n\n';

    // ---- Section 5: 7-Day History Table ----
    html += '<h2>' + fuelLabel + ' Price History in ' + city + ' — Last 7 Days</h2>\n';
    html += '<table class="hdf-table hdf-history-table">\n';
    html += '  <thead><tr><th>Date</th><th>Price (₹/L)</th><th>Change (₹)</th><th>Change (%)</th></tr></thead>\n';
    html += '  <tbody>\n';
    for (let i = 0; i < history7.length; i++) {
      const h = history7[i];
      const hPrice = fuelType === 'petrol' ? h.petrol : h.diesel;
      let hDelta = 0;
      let hPct = 0;
      if (i < history7.length - 1) {
        const prevH = history7[i + 1];
        const prevPrice = fuelType === 'petrol' ? prevH.petrol : prevH.diesel;
        if (hPrice && prevPrice) {
          hDelta = Math.round((hPrice - prevPrice) * 100) / 100;
          hPct = prevPrice > 0 ? Math.round((hDelta / prevPrice) * 10000) / 100 : 0;
        }
      }
      const isToday = h.price_date === today;
      const rowClass = isToday ? ' class="hdf-today"' : '';
      html += '    <tr' + rowClass + '>';
      html += '<td>' + fmtDate(h.price_date) + '</td>';
      html += '<td>₹' + fmtPrice(hPrice) + '</td>';
      html += '<td>' + changeBadge(hDelta) + '</td>';
      html += '<td>' + (hPct !== 0 ? (hPct > 0 ? '+' : '') + hPct.toFixed(2) + '%' : '0.00%') + '</td>';
      html += '</tr>\n';
    }
    html += '  </tbody>\n';
    html += '</table>\n\n';

    // ---- Section 6: Chart placeholder ----
    const chartDataRest = history30.map(h => {
      return h.price_date + ':' + (fuelType === 'petrol' ? (h.petrol || '') : (h.diesel || ''));
    }).join(',');
    html += '<div class="hdf-chart">\n';
    html += '  <h2>' + fuelLabel + ' Price Trend in ' + city + ' — 30 Day Chart</h2>\n';
    html += '  <canvas id="hdf-fuel-chart" data-city="' + city + '" data-fuel="' + fuelType + '" data-rest="' + chartDataRest + '"></canvas>\n';
    html += '</div>\n\n';

    // ---- Section 7: 30-Day Trend Analysis ----
    html += '<h2>' + fuelLabel + ' 30-Day Trend Analysis — ' + city + '</h2>\n';
    const prices30 = history30.map(h => fuelType === 'petrol' ? h.petrol : h.diesel).filter(p => p && p > 0);
    if (prices30.length > 1) {
      const min30 = Math.min(...prices30);
      const max30 = Math.max(...prices30);
      const avg30 = Math.round(prices30.reduce((a, b) => a + b, 0) / prices30.length * 100) / 100;
      const first30 = prices30[0];
      const last30 = prices30[prices30.length - 1];
      const direction = last30 > first30 ? 'upward' : last30 < first30 ? 'downward' : 'flat';
      const range = Math.round((max30 - min30) * 100) / 100;
      const stability = range <= 0.5 ? 'highly stable' : range <= 2 ? 'moderately stable' : 'volatile';

      html += '<p>Over the last 30 days, ' + fuelLabel.toLowerCase() + ' prices in ' + city + ' have shown a <strong>' + direction + ' trend</strong>. ';
      html += 'The price ranged from a low of <strong>₹' + fmtPrice(min30) + '</strong> to a high of <strong>₹' + fmtPrice(max30) + '</strong>, ';
      html += 'with an average of <strong>₹' + fmtPrice(avg30) + '</strong> per litre. ';
      html += 'The ₹' + range.toFixed(2) + ' spread indicates the market has been <strong>' + stability + '</strong> during this period. ';
      html += 'Prices are revised daily at 6:00 AM by oil marketing companies based on international crude oil rates and the USD-INR exchange rate.</p>\n\n';
    } else {
      html += '<p>Insufficient historical data for a 30-day trend analysis. Prices are revised daily at 6:00 AM by oil marketing companies.</p>\n\n';
    }

    // ---- Section 8: Same-State Cities pills ----
    html += '<h2>' + fuelLabel + ' Price in Other ' + state + ' Cities</h2>\n';
    html += '<div class="hdf-pills">\n';
    for (const sc of stateCities) {
      if (sc.city_name === city) continue;
      const scPrice = fuelType === 'petrol' ? sc.petrol : sc.diesel;
      const scSlug = slugify(fuelType + '-price-in-' + sc.city_name + '-today');
      html += '  <a class="hdf-pill" href="/' + scSlug + '/">' + sc.city_name + ' ₹' + fmtPrice(scPrice) + '</a>\n';
    }
    html += '</div>\n\n';

    // ---- Section 9: Top Cities pills ----
    html += '<h2>' + fuelLabel + ' Price in Major Indian Cities</h2>\n';
    html += '<div class="hdf-pills">\n';
    for (const tc of TOP_CITIES) {
      if (tc === city) continue;
      const tcSlug = slugify(fuelType + '-price-in-' + tc + '-today');
      html += '  <a class="hdf-pill" href="/' + tcSlug + '/">' + tc + '</a>\n';
    }
    html += '</div>\n\n';

    // ---- Section 10: About Pricing ----
    html += '<h2>About ' + fuelLabel + ' Pricing in ' + state + '</h2>\n';
    if (stateInfo.note) {
      html += '<p>' + stateInfo.note + '</p>\n';
    }
    html += '<p>' + state + ' levies <strong>' + stateInfo.vat + '</strong> on ' + fuelLabel.toLowerCase() + '. ';
    html += 'State VAT is one of the key factors that creates price differences between states. ';
    html += 'The final retail price also includes central excise duty, dealer commission, and transportation charges.</p>\n\n';

    // ---- Section 11: Cross-Metal Links ----
    html += '<div class="hdf-cross-links">\n';
    html += '  <h2>Also Check in ' + city + '</h2>\n';
    const goldSlug = slugify('gold-price-in-' + city + '-today');
    const silverSlug = slugify('silver-price-in-' + city + '-today');
    html += '  <a class="hdf-cross-link" href="/' + goldSlug + '/">Gold Price in ' + city + ' Today</a>\n';
    html += '  <a class="hdf-cross-link" href="/' + silverSlug + '/">Silver Price in ' + city + ' Today</a>\n';
    html += '</div>\n\n';

    // ---- Section 12: Breadcrumb ----
    const nationalSlug = slugify(fuelType + '-price-in-india-today');
    const stateSlug = slugify(fuelType + '-price-in-' + state + '-today');
    html += '<nav class="hdf-breadcrumb">\n';
    html += '  <a href="/">Home</a> › ';
    html += '<a href="/' + nationalSlug + '/">' + fuelLabel + ' Price in India</a> › ';
    html += '<a href="/' + stateSlug + '/">' + state + '</a> › ';
    html += '<span>' + city + '</span>\n';
    html += '</nav>\n\n';

    // ---- Section 13: FAQ ----
    const faqItems = [
      {
        q: 'What is the ' + fuelLabel.toLowerCase() + ' price in ' + city + ' today?',
        a: 'The ' + fuelLabel.toLowerCase() + ' price in ' + city + ' today (' + dateStr + ') is ₹' + fmtPrice(price) + ' per litre, ' + changeText(delta) + '.'
      },
      {
        q: 'Why is ' + fuelLabel.toLowerCase() + ' price different in ' + city + ' compared to other cities?',
        a: fuelLabel + ' prices vary across cities due to differences in state VAT (currently ' + stateInfo.vat + ' in ' + state + '), local body taxes, transportation costs, and dealer commissions.'
      },
      {
        q: 'How much does it cost to fill a full tank of ' + fuelLabel.toLowerCase() + ' in ' + city + '?',
        a: 'A full ' + tankSize + '-litre tank of ' + fuelLabel.toLowerCase() + ' in ' + city + ' costs approximately ₹' + (price ? (price * tankSize).toFixed(2) : '—') + ' at today\'s rate of ₹' + fmtPrice(price) + '/litre.'
      },
      {
        q: 'When are ' + fuelLabel.toLowerCase() + ' prices updated in ' + city + '?',
        a: fuelLabel + ' prices in ' + city + ' are revised daily at 6:00 AM under the dynamic daily pricing system introduced in 2017. Indian Oil, BPCL, and HPCL adjust rates based on international crude oil prices and the USD-INR exchange rate.'
      },
      {
        q: 'What is the 30-day trend for ' + fuelLabel.toLowerCase() + ' price in ' + city + '?',
        a: prices30.length > 1
          ? 'Over the last 30 days, ' + fuelLabel.toLowerCase() + ' in ' + city + ' has ranged from ₹' + fmtPrice(Math.min(...prices30)) + ' to ₹' + fmtPrice(Math.max(...prices30)) + ' per litre, with an average of ₹' + fmtPrice(Math.round(prices30.reduce((a, b) => a + b, 0) / prices30.length * 100) / 100) + '.'
          : fuelLabel + ' price trend data for ' + city + ' will be available after sufficient daily records are collected.'
      }
    ];

    html += '<h2>Frequently Asked Questions</h2>\n';
    for (const faq of faqItems) {
      html += '<h3>' + faq.q + '</h3>\n';
      html += '<p>' + faq.a + '</p>\n';
    }
    html += '\n';

    // ---- Section 14: FAQ Schema JSON-LD ----
    const faqSchema = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      'mainEntity': faqItems.map(faq => ({
        '@type': 'Question',
        'name': faq.q,
        'acceptedAnswer': {
          '@type': 'Answer',
          'text': faq.a
        }
      }))
    };
    html += '<script type="application/ld+json">' + JSON.stringify(faqSchema) + '</script>\n';

    // -----------------------------------------------------------------------
    // Publish via WP
    // -----------------------------------------------------------------------

    const result = await this.wp.upsertPost({
      slug: slug,
      title: title,
      content: html,
      categoryNames: [fuelLabel],
      metaDescription: metaDescription,
      status: 'publish',
      meta: {
        _hdf_fuel_city: city,
        _hdf_fuel_state: state,
        _hdf_fuel_type: fuelType
      }
    });

    return result.action;
  }

  // =========================================================================
  // generateStatePost
  // =========================================================================

  async generateStatePost(state, fuelType) {
    const today = new Date().toISOString().slice(0, 10);
    const dateStr = fmtDate(today);
    const fuelLabel = fuelType === 'petrol' ? 'Petrol' : 'Diesel';
    const altFuel = fuelType === 'petrol' ? 'diesel' : 'petrol';
    const altLabel = fuelType === 'petrol' ? 'Diesel' : 'Petrol';
    const stateInfo = STATE_INFO[state] || { vat: 'varies', note: '', nearby: [], region: '' };

    // All cities in state with today's prices
    const stateCities = this.db.prepare(
      'SELECT fc.city_name, fp.petrol, fp.diesel FROM fuel_cities fc ' +
      'INNER JOIN fuel_prices fp ON fc.city_name = fp.city AND fp.price_date = ? ' +
      'WHERE fc.state = ? AND fc.is_enabled = 1 ORDER BY fc.city_name'
    ).all(today, state);

    if (!stateCities.length) return null;

    // State average
    const stateAvg = this.db.prepare(
      'SELECT AVG(petrol) AS petrol, AVG(diesel) AS diesel FROM fuel_prices ' +
      'WHERE state = ? AND price_date = ? AND (petrol > 0 OR diesel > 0)'
    ).get(state, today);

    const avgPrice = stateAvg ? (fuelType === 'petrol' ? stateAvg.petrol : stateAvg.diesel) : null;
    const avgPriceFmt = avgPrice ? (Math.round(avgPrice * 100) / 100) : null;

    // Nearby states with their averages
    const nearbyData = [];
    for (const ns of (stateInfo.nearby || [])) {
      const nsAvg = this.db.prepare(
        'SELECT AVG(petrol) AS petrol, AVG(diesel) AS diesel FROM fuel_prices ' +
        'WHERE state = ? AND price_date = ? AND (petrol > 0 OR diesel > 0)'
      ).get(ns, today);
      if (nsAvg) {
        const nsPrice = fuelType === 'petrol' ? nsAvg.petrol : nsAvg.diesel;
        if (nsPrice && nsPrice > 0) {
          nearbyData.push({ state: ns, price: Math.round(nsPrice * 100) / 100 });
        }
      }
    }

    // 30-day state history for chart
    const stateHistory30 = this.db.prepare(
      'SELECT price_date, AVG(petrol) AS petrol, AVG(diesel) AS diesel FROM fuel_prices ' +
      'WHERE state = ? AND price_date >= date(?, \'-30 days\') AND (petrol > 0 OR diesel > 0) ' +
      'GROUP BY price_date ORDER BY price_date ASC'
    ).all(state, today);

    const slug = slugify(fuelType + '-price-in-' + state + '-today');
    const title = fuelLabel + ' Price in ' + state + ' Today (' + dateStr + ') — All Cities';
    let metaDescription = fuelLabel + ' price in ' + state + ' today: avg ₹' + fmtPrice(avgPriceFmt) + '/L. Check rates in ' + stateCities.length + ' cities, compare with nearby states, and view daily trends.';
    if (metaDescription.length > 160) {
      metaDescription = metaDescription.substring(0, 157) + '...';
    }

    let html = '';

    // ---- Hero ----
    html += '<div class="hdf-hero">\n';
    html += '  <div class="hdf-hero-price">\n';
    html += '    <span class="hdf-hero-label">' + fuelLabel + ' Price in ' + state + ' (Avg)</span>\n';
    html += '    <span class="hdf-hero-value">₹' + fmtPrice(avgPriceFmt) + '<small>/litre</small></span>\n';
    html += '  </div>\n';
    html += '  <div class="hdf-hero-meta">\n';
    html += '    <span class="hdf-hero-date">' + dateStr + ' <span class="hdf-live-badge">LIVE</span></span>\n';
    html += '    <span class="hdf-hero-source">Source: Indian Oil Corporation, BPCL, HPCL Daily Bulletin</span>\n';
    const altStateSlug = slugify(altFuel + '-price-in-' + state + '-today');
    html += '    <a class="hdf-hero-alt" href="/' + altStateSlug + '/">Check ' + altLabel + ' Price in ' + state + ' →</a>\n';
    html += '  </div>\n';
    html += '</div>\n\n';

    // ---- Intro ----
    html += '<p>Today\'s average ' + fuelLabel.toLowerCase() + ' price across ' + state + ' is <strong>₹' + fmtPrice(avgPriceFmt) + '/litre</strong> (' + dateStr + '). ';
    html += state + ' levies ' + stateInfo.vat + ' on fuel. ';
    html += 'Below is the city-wise breakdown for all ' + stateCities.length + ' cities in ' + state + '.</p>\n\n';

    // ---- All Cities Table ----
    html += '<h2>' + fuelLabel + ' Price in All ' + state + ' Cities Today</h2>\n';
    html += '<table class="hdf-table hdf-state-cities-table">\n';
    html += '  <thead><tr><th>City</th><th>Price (₹/L)</th></tr></thead>\n';
    html += '  <tbody>\n';
    for (const sc of stateCities) {
      const scPrice = fuelType === 'petrol' ? sc.petrol : sc.diesel;
      const scSlug = slugify(fuelType + '-price-in-' + sc.city_name + '-today');
      html += '    <tr><td><a href="/' + scSlug + '/">' + sc.city_name + '</a></td><td>₹' + fmtPrice(scPrice) + '</td></tr>\n';
    }
    html += '  </tbody>\n';
    html += '</table>\n\n';

    // ---- VAT Explanation ----
    html += '<h2>VAT &amp; Taxes on ' + fuelLabel + ' in ' + state + '</h2>\n';
    html += '<p>' + state + ' levies <strong>' + stateInfo.vat + '</strong> on ' + fuelLabel.toLowerCase() + '. ';
    html += 'In addition to state taxes, the central government levies excise duty. ';
    html += 'The final retail price also includes dealer commission (~₹2-4/L) and transportation charges that vary by city.</p>\n\n';

    // ---- Chart placeholder ----
    const stateChartData = stateHistory30.map(h => {
      return h.price_date + ':' + (fuelType === 'petrol' ? (h.petrol ? Math.round(h.petrol * 100) / 100 : '') : (h.diesel ? Math.round(h.diesel * 100) / 100 : ''));
    }).join(',');
    html += '<div class="hdf-chart">\n';
    html += '  <h2>' + fuelLabel + ' Price Trend in ' + state + ' — 30 Day Chart</h2>\n';
    html += '  <canvas id="hdf-fuel-chart" data-city="' + state + '" data-fuel="' + fuelType + '" data-rest="' + stateChartData + '"></canvas>\n';
    html += '</div>\n\n';

    // ---- Cross-fuel link ----
    html += '<div class="hdf-cross-links">\n';
    html += '  <a class="hdf-cross-link" href="/' + altStateSlug + '/">' + altLabel + ' Price in ' + state + ' Today</a>\n';
    html += '</div>\n\n';

    // ---- Nearby States Comparison ----
    if (nearbyData.length > 0) {
      html += '<h2>' + fuelLabel + ' Price in Nearby States</h2>\n';
      html += '<table class="hdf-table hdf-nearby-table">\n';
      html += '  <thead><tr><th>State</th><th>Avg Price (₹/L)</th><th>Difference</th></tr></thead>\n';
      html += '  <tbody>\n';
      html += '    <tr class="hdf-today"><td><strong>' + state + '</strong></td><td>₹' + fmtPrice(avgPriceFmt) + '</td><td>—</td></tr>\n';
      for (const nd of nearbyData) {
        const diff = avgPriceFmt && nd.price ? Math.round((nd.price - avgPriceFmt) * 100) / 100 : 0;
        const nsSlug = slugify(fuelType + '-price-in-' + nd.state + '-today');
        html += '    <tr><td><a href="/' + nsSlug + '/">' + nd.state + '</a></td><td>₹' + fmtPrice(nd.price) + '</td><td>' + changeBadge(diff) + '</td></tr>\n';
      }
      html += '  </tbody>\n';
      html += '</table>\n\n';
    }

    // ---- About ----
    html += '<h2>About ' + fuelLabel + ' Pricing in ' + state + '</h2>\n';
    if (stateInfo.note) {
      html += '<p>' + stateInfo.note + '</p>\n';
    }
    html += '<p>Fuel prices in ' + state + ' are revised daily at 6:00 AM under India\'s dynamic daily pricing system. ';
    html += 'Rates are determined by international crude oil prices, the USD-INR exchange rate, and applicable state and central taxes.</p>\n\n';

    // ---- FAQ ----
    const faqItems = [
      {
        q: 'What is the average ' + fuelLabel.toLowerCase() + ' price in ' + state + ' today?',
        a: 'The average ' + fuelLabel.toLowerCase() + ' price across ' + state + ' today (' + dateStr + ') is approximately ₹' + fmtPrice(avgPriceFmt) + ' per litre.'
      },
      {
        q: 'Which city in ' + state + ' has the cheapest ' + fuelLabel.toLowerCase() + '?',
        a: (function() {
          let cheapest = null;
          for (const sc of stateCities) {
            const p = fuelType === 'petrol' ? sc.petrol : sc.diesel;
            if (p && p > 0 && (!cheapest || p < cheapest.price)) {
              cheapest = { city: sc.city_name, price: p };
            }
          }
          return cheapest
            ? cheapest.city + ' currently has the lowest ' + fuelLabel.toLowerCase() + ' price in ' + state + ' at ₹' + fmtPrice(cheapest.price) + '/litre.'
            : 'Price data for ' + state + ' cities is being updated.';
        })()
      },
      {
        q: 'How many cities in ' + state + ' have ' + fuelLabel.toLowerCase() + ' price data?',
        a: 'We track daily ' + fuelLabel.toLowerCase() + ' prices in ' + stateCities.length + ' cities across ' + state + ', updated every morning at 6:00 AM.'
      },
      {
        q: 'What is the VAT on ' + fuelLabel.toLowerCase() + ' in ' + state + '?',
        a: state + ' levies ' + stateInfo.vat + ' on ' + fuelLabel.toLowerCase() + '. This is one of the primary reasons fuel prices vary across states.'
      },
      {
        q: 'How does ' + state + ' ' + fuelLabel.toLowerCase() + ' price compare to nearby states?',
        a: nearbyData.length > 0
          ? state + ' average is ₹' + fmtPrice(avgPriceFmt) + '/L compared to ' + nearbyData.map(nd => nd.state + ' at ₹' + fmtPrice(nd.price) + '/L').join(', ') + '.'
          : 'Comparison data with nearby states is currently being compiled.'
      }
    ];

    html += '<h2>Frequently Asked Questions</h2>\n';
    for (const faq of faqItems) {
      html += '<h3>' + faq.q + '</h3>\n';
      html += '<p>' + faq.a + '</p>\n';
    }
    html += '\n';

    // FAQ Schema
    const faqSchema = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      'mainEntity': faqItems.map(faq => ({
        '@type': 'Question',
        'name': faq.q,
        'acceptedAnswer': {
          '@type': 'Answer',
          'text': faq.a
        }
      }))
    };
    html += '<script type="application/ld+json">' + JSON.stringify(faqSchema) + '</script>\n';

    // Publish
    const result = await this.wp.upsertPost({
      slug: slug,
      title: title,
      content: html,
      categoryNames: [fuelLabel],
      metaDescription: metaDescription,
      status: 'publish',
      meta: {
        _hdf_fuel_state: state,
        _hdf_fuel_type: fuelType,
        _hdf_fuel_is_state: '1'
      }
    });

    return result.action;
  }

  // =========================================================================
  // generateNationalPost
  // =========================================================================

  async generateNationalPost(fuelType) {
    const today = new Date().toISOString().slice(0, 10);
    const dateStr = fmtDate(today);
    const fuelLabel = fuelType === 'petrol' ? 'Petrol' : 'Diesel';
    const altFuel = fuelType === 'petrol' ? 'diesel' : 'petrol';
    const altLabel = fuelType === 'petrol' ? 'Diesel' : 'Petrol';

    // All state averages
    const stateRows = this.db.prepare(
      'SELECT state, AVG(petrol) AS petrol, AVG(diesel) AS diesel FROM fuel_prices ' +
      'WHERE price_date = ? AND (petrol > 0 OR diesel > 0) GROUP BY state ORDER BY state'
    ).all(today);

    // National average
    const natAvg = this.db.prepare(
      'SELECT AVG(petrol) AS petrol, AVG(diesel) AS diesel FROM fuel_prices ' +
      'WHERE price_date = ? AND (petrol > 0 OR diesel > 0)'
    ).get(today);

    const nationalPrice = natAvg ? (fuelType === 'petrol' ? natAvg.petrol : natAvg.diesel) : null;
    const nationalPriceFmt = nationalPrice ? Math.round(nationalPrice * 100) / 100 : null;

    // Top cities prices
    const topCitiesData = [];
    for (const tc of TOP_CITIES) {
      const tcRow = this.db.prepare(
        'SELECT petrol, diesel FROM fuel_prices WHERE city = ? AND price_date = ?'
      ).get(tc, today);
      if (tcRow) {
        topCitiesData.push({ city: tc, petrol: tcRow.petrol, diesel: tcRow.diesel });
      }
    }

    // 30-day national trend for chart
    const natHistory30 = this.db.prepare(
      'SELECT price_date, AVG(petrol) AS petrol, AVG(diesel) AS diesel FROM fuel_prices ' +
      'WHERE price_date >= date(?, \'-30 days\') AND (petrol > 0 OR diesel > 0) ' +
      'GROUP BY price_date ORDER BY price_date ASC'
    ).all(today);

    const slug = slugify(fuelType + '-price-in-india-today');
    const title = fuelLabel + ' Price in India Today (' + dateStr + ') — All States & Cities';
    let metaDescription = fuelLabel + ' price in India today: national avg ₹' + fmtPrice(nationalPriceFmt) + '/L (' + dateStr + '). State-wise rates, major cities, and 30-day trend chart.';
    if (metaDescription.length > 160) {
      metaDescription = metaDescription.substring(0, 157) + '...';
    }

    // Compute most/least expensive states
    const stateWithPrices = stateRows.map(sr => ({
      state: sr.state,
      price: fuelType === 'petrol' ? sr.petrol : sr.diesel
    })).filter(s => s.price && s.price > 0);
    stateWithPrices.sort((a, b) => b.price - a.price);
    const mostExpensive = stateWithPrices.slice(0, 5);
    const leastExpensive = stateWithPrices.slice(-5).reverse();

    let html = '';

    // ---- Hero ----
    html += '<div class="hdf-hero">\n';
    html += '  <div class="hdf-hero-price">\n';
    html += '    <span class="hdf-hero-label">' + fuelLabel + ' Price in India (National Avg)</span>\n';
    html += '    <span class="hdf-hero-value">₹' + fmtPrice(nationalPriceFmt) + '<small>/litre</small></span>\n';
    html += '  </div>\n';
    html += '  <div class="hdf-hero-meta">\n';
    html += '    <span class="hdf-hero-date">' + dateStr + ' <span class="hdf-live-badge">LIVE</span></span>\n';
    html += '    <span class="hdf-hero-source">Source: Indian Oil Corporation, BPCL, HPCL Daily Bulletin</span>\n';
    const altNationalSlug = slugify(altFuel + '-price-in-india-today');
    html += '    <a class="hdf-hero-alt" href="/' + altNationalSlug + '/">Check ' + altLabel + ' Price in India →</a>\n';
    html += '  </div>\n';
    html += '</div>\n\n';

    // ---- Intro ----
    html += '<p>The national average ' + fuelLabel.toLowerCase() + ' price in India today (' + dateStr + ') is <strong>₹' + fmtPrice(nationalPriceFmt) + '/litre</strong>. ';
    html += 'Prices vary across ' + stateWithPrices.length + ' states and union territories due to differences in state VAT, surcharges, and transportation costs. ';
    html += 'Below is the complete state-wise and city-wise breakdown.</p>\n\n';

    // ---- State-wise Table ----
    html += '<h2>' + fuelLabel + ' Price in All Indian States Today</h2>\n';
    html += '<table class="hdf-table hdf-national-states-table">\n';
    html += '  <thead><tr><th>State / UT</th><th>Avg Price (₹/L)</th><th>VAT</th></tr></thead>\n';
    html += '  <tbody>\n';
    for (const sr of stateRows) {
      const srPrice = fuelType === 'petrol' ? sr.petrol : sr.diesel;
      const srPriceFmt = srPrice ? Math.round(srPrice * 100) / 100 : null;
      const srInfo = STATE_INFO[sr.state] || { vat: '—' };
      const srSlug = slugify(fuelType + '-price-in-' + sr.state + '-today');
      html += '    <tr><td><a href="/' + srSlug + '/">' + sr.state + '</a></td><td>₹' + fmtPrice(srPriceFmt) + '</td><td>' + srInfo.vat + '</td></tr>\n';
    }
    html += '  </tbody>\n';
    html += '</table>\n\n';

    // ---- Major Cities Table ----
    html += '<h2>' + fuelLabel + ' Price in Major Indian Cities</h2>\n';
    html += '<table class="hdf-table hdf-national-cities-table">\n';
    html += '  <thead><tr><th>City</th><th>Price (₹/L)</th></tr></thead>\n';
    html += '  <tbody>\n';
    for (const tc of topCitiesData) {
      const tcPrice = fuelType === 'petrol' ? tc.petrol : tc.diesel;
      const tcSlug = slugify(fuelType + '-price-in-' + tc.city + '-today');
      html += '    <tr><td><a href="/' + tcSlug + '/">' + tc.city + '</a></td><td>₹' + fmtPrice(tcPrice) + '</td></tr>\n';
    }
    html += '  </tbody>\n';
    html += '</table>\n\n';

    // ---- Most Expensive States ----
    html += '<h2>Most Expensive States for ' + fuelLabel + '</h2>\n';
    html += '<table class="hdf-table">\n';
    html += '  <thead><tr><th>#</th><th>State</th><th>Avg Price (₹/L)</th></tr></thead>\n';
    html += '  <tbody>\n';
    for (let i = 0; i < mostExpensive.length; i++) {
      const me = mostExpensive[i];
      const meSlug = slugify(fuelType + '-price-in-' + me.state + '-today');
      html += '    <tr><td>' + (i + 1) + '</td><td><a href="/' + meSlug + '/">' + me.state + '</a></td><td>₹' + fmtPrice(Math.round(me.price * 100) / 100) + '</td></tr>\n';
    }
    html += '  </tbody>\n';
    html += '</table>\n\n';

    // ---- Least Expensive States ----
    html += '<h2>Least Expensive States for ' + fuelLabel + '</h2>\n';
    html += '<table class="hdf-table">\n';
    html += '  <thead><tr><th>#</th><th>State</th><th>Avg Price (₹/L)</th></tr></thead>\n';
    html += '  <tbody>\n';
    for (let i = 0; i < leastExpensive.length; i++) {
      const le = leastExpensive[i];
      const leSlug = slugify(fuelType + '-price-in-' + le.state + '-today');
      html += '    <tr><td>' + (i + 1) + '</td><td><a href="/' + leSlug + '/">' + le.state + '</a></td><td>₹' + fmtPrice(Math.round(le.price * 100) / 100) + '</td></tr>\n';
    }
    html += '  </tbody>\n';
    html += '</table>\n\n';

    // ---- Chart placeholder ----
    const natChartData = natHistory30.map(h => {
      return h.price_date + ':' + (fuelType === 'petrol' ? (h.petrol ? Math.round(h.petrol * 100) / 100 : '') : (h.diesel ? Math.round(h.diesel * 100) / 100 : ''));
    }).join(',');
    html += '<div class="hdf-chart">\n';
    html += '  <h2>' + fuelLabel + ' Price Trend in India — 30 Day Chart</h2>\n';
    html += '  <canvas id="hdf-fuel-chart" data-city="India" data-fuel="' + fuelType + '" data-rest="' + natChartData + '"></canvas>\n';
    html += '</div>\n\n';

    // ---- How Prices Are Decided ----
    html += '<h2>How ' + fuelLabel + ' Prices Are Decided in India</h2>\n';
    html += '<p>India follows a <strong>daily dynamic pricing</strong> system since June 2017. ';
    html += 'Oil marketing companies — Indian Oil Corporation (IOC), Bharat Petroleum (BPCL), and Hindustan Petroleum (HPCL) — revise retail fuel prices every day at 6:00 AM.</p>\n';
    html += '<p>The final retail price of ' + fuelLabel.toLowerCase() + ' is determined by:</p>\n';
    html += '<ul>\n';
    html += '  <li><strong>International crude oil price</strong> — India imports ~85% of its crude; global Brent crude rates directly affect base price.</li>\n';
    html += '  <li><strong>USD-INR exchange rate</strong> — crude is traded in US dollars; a weaker rupee raises import cost.</li>\n';
    html += '  <li><strong>Central excise duty</strong> — fixed per-litre duty levied by the union government.</li>\n';
    html += '  <li><strong>State VAT &amp; surcharges</strong> — each state sets its own VAT rate, creating inter-state price differences.</li>\n';
    html += '  <li><strong>Dealer commission</strong> — typically ₹2-4 per litre for the retail outlet.</li>\n';
    html += '  <li><strong>Transportation &amp; freight</strong> — distance from the nearest refinery affects final cost.</li>\n';
    html += '</ul>\n\n';

    // ---- Cross-fuel link ----
    html += '<div class="hdf-cross-links">\n';
    html += '  <a class="hdf-cross-link" href="/' + altNationalSlug + '/">' + altLabel + ' Price in India Today</a>\n';
    html += '</div>\n\n';

    // ---- Cross-metal links ----
    html += '<div class="hdf-cross-links">\n';
    html += '  <h2>Also Check</h2>\n';
    html += '  <a class="hdf-cross-link" href="/' + slugify('gold-price-in-india-today') + '/">Gold Price in India Today</a>\n';
    html += '  <a class="hdf-cross-link" href="/' + slugify('silver-price-in-india-today') + '/">Silver Price in India Today</a>\n';
    html += '</div>\n\n';

    // ---- FAQ ----
    const faqItems = [
      {
        q: 'What is the ' + fuelLabel.toLowerCase() + ' price in India today?',
        a: 'The national average ' + fuelLabel.toLowerCase() + ' price in India today (' + dateStr + ') is approximately ₹' + fmtPrice(nationalPriceFmt) + ' per litre. Actual prices vary by state and city.'
      },
      {
        q: 'Which state has the highest ' + fuelLabel.toLowerCase() + ' price in India?',
        a: mostExpensive.length > 0
          ? mostExpensive[0].state + ' currently has the highest average ' + fuelLabel.toLowerCase() + ' price at ₹' + fmtPrice(Math.round(mostExpensive[0].price * 100) / 100) + '/litre due to its high state VAT.'
          : 'State-wise comparison data is being updated.'
      },
      {
        q: 'Which state has the lowest ' + fuelLabel.toLowerCase() + ' price in India?',
        a: leastExpensive.length > 0
          ? leastExpensive[0].state + ' currently has the lowest average ' + fuelLabel.toLowerCase() + ' price at ₹' + fmtPrice(Math.round(leastExpensive[0].price * 100) / 100) + '/litre.'
          : 'State-wise comparison data is being updated.'
      },
      {
        q: 'Why are ' + fuelLabel.toLowerCase() + ' prices different across Indian states?',
        a: fuelLabel + ' prices vary across states primarily due to different state VAT rates and surcharges. Additionally, distance from the nearest refinery, local body taxes, and transportation costs contribute to price differences.'
      },
      {
        q: 'How often are ' + fuelLabel.toLowerCase() + ' prices revised in India?',
        a: fuelLabel + ' prices in India are revised daily at 6:00 AM by oil marketing companies (IOC, BPCL, HPCL) under the dynamic daily pricing system introduced in June 2017.'
      }
    ];

    html += '<h2>Frequently Asked Questions</h2>\n';
    for (const faq of faqItems) {
      html += '<h3>' + faq.q + '</h3>\n';
      html += '<p>' + faq.a + '</p>\n';
    }
    html += '\n';

    // FAQ Schema
    const faqSchema = {
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      'mainEntity': faqItems.map(faq => ({
        '@type': 'Question',
        'name': faq.q,
        'acceptedAnswer': {
          '@type': 'Answer',
          'text': faq.a
        }
      }))
    };
    html += '<script type="application/ld+json">' + JSON.stringify(faqSchema) + '</script>\n';

    // Publish
    const result = await this.wp.upsertPost({
      slug: slug,
      title: title,
      content: html,
      categoryNames: [fuelLabel],
      metaDescription: metaDescription,
      status: 'publish',
      meta: {
        _hdf_fuel_type: fuelType,
        _hdf_fuel_is_national: '1'
      }
    });

    return result.action;
  }
}

module.exports = { FuelPostCreator };
