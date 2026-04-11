'use strict';

const MODULE = 'metals-posts';
const crypto = require('crypto');

// ─── Formatting helpers ─────────────────────────────────────────────────────

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
function indianFormat(num) {
  if (!num) return '—';
  if (num < 100000) return Number(num).toFixed(2);
  const parts = Number(num).toFixed(2).split('.');
  let intPart = parts[0];
  const lastThree = intPart.slice(-3);
  const remaining = intPart.slice(0, -3);
  const formatted = remaining.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return (remaining ? formatted + ',' : '') + lastThree + '.' + parts[1];
}

// ─── Constants ──────────────────────────────────────────────────────────────

const TOP_CITIES = ['Delhi','Mumbai','Bangalore','Chennai','Hyderabad','Kolkata','Ahmedabad','Pune','Jaipur','Lucknow'];

const METAL_CONFIG = {
  gold: {
    label: 'Gold',
    source: 'IBJA (Indian Bullion and Jewellers Association)',
    variants: ['24K', '22K', '18K'],
    priceColumns: { '24K': 'price_24k', '22K': 'price_22k', '18K': 'price_18k' },
    weightRows: [1, 2, 4, 8, 10, 20, 50, 100],
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
    weightRows: [1, 10, 50, 100, 500, 1000],
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

// ─── Class ──────────────────────────────────────────────────────────────────

class MetalsPostCreator {
  /**
   * @param {object} metals - MetalsModule instance
   * @param {import('./wp-publisher').WPPublisher} wpPublisher
   * @param {import('better-sqlite3').Database} db
   * @param {object} logger
   */
  constructor(metals, wpPublisher, db, logger) {
    this.metals = metals;
    this.wp = wpPublisher;
    this.db = db;
    this.logger = logger;
  }

  // ─── wp_posts_log helpers ────────────────────────────────────────────────

  _logPost(postType, metalType, itemName, result, contentHash) {
    try {
      this.db.prepare(`
        INSERT INTO wp_posts_log (module, post_type, item_type, item_name, wp_post_id, wp_slug, wp_url, wp_status, action, content_hash)
        VALUES ('metals', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(module, item_type, post_type, item_name) DO UPDATE SET
          wp_post_id = excluded.wp_post_id, wp_url = excluded.wp_url,
          wp_status = excluded.wp_status, action = excluded.action,
          content_hash = excluded.content_hash, created_at = datetime('now')
      `).run(postType, metalType, itemName, result.id || null, result.slug || null,
        result.url || null, result.status || 'publish', result.action || 'updated', contentHash || null);
    } catch (e) {
      this.logger.warn(MODULE, 'wp_posts_log insert failed: ' + e.message);
    }
  }

  _logPostFailed(postType, metalType, itemName, errorMsg) {
    try {
      this.db.prepare(`
        INSERT INTO wp_posts_log (module, post_type, item_type, item_name, action, error_message)
        VALUES ('metals', ?, ?, ?, 'failed', ?)
        ON CONFLICT(module, item_type, post_type, item_name) DO UPDATE SET
          action = 'failed', error_message = excluded.error_message, created_at = datetime('now')
      `).run(postType, metalType, itemName, errorMsg);
    } catch (e) { /* silent */ }
  }

  // ─── Main entry ─────────────────────────────────────────────────────────

  /**
   * Generate all posts for a metal type (city, state, national).
   * @param {'gold'|'silver'|'platinum'} metalType
   * @returns {Promise<{created: number, updated: number}>}
   */
  async runPostGeneration(metalType) {
    if (!this.wp.isReady()) {
      this.logger.warn(MODULE, 'WP Publisher not ready — skipping ' + metalType + ' post generation');
      return { created: 0, updated: 0 };
    }

    const today = new Date().toISOString().slice(0, 10);
    let created = 0;
    let updated = 0;

    // Get cities with today's prices
    const cities = this.db.prepare(`
      SELECT mc.city_name, mc.state,
             mp.price_24k, mp.price_22k, mp.price_18k, mp.price_1g
      FROM metals_cities mc
      INNER JOIN metals_prices mp ON mc.city_name = mp.city
        AND mp.metal_type = ? AND mp.price_date = ?
      WHERE mc.is_active = 1
    `).all(metalType, today);

    if (cities.length === 0) {
      this.logger.warn(MODULE, 'No ' + metalType + ' prices found for ' + today + ' — nothing to publish');
      return { created: 0, updated: 0 };
    }

    // Get distinct states
    const states = [...new Set(cities.map(c => c.state))].filter(Boolean).sort();

    this.logger.info(MODULE, 'Generating ' + metalType + ' posts: ' + cities.length + ' cities, ' + states.length + ' states');

    // City posts
    for (const city of cities) {
      try {
        const action = await this.generateCityPost(city.city_name, city.state, metalType);
        if (action === 'created') created++;
        else if (action === 'updated') updated++;
      } catch (err) {
        this.logger.error(MODULE, 'City post failed (' + city.city_name + '): ' + err.message);
      }
      await new Promise(r => setTimeout(r, 200));
    }

    // State posts
    for (const state of states) {
      try {
        const action = await this.generateStatePost(state, metalType);
        if (action === 'created') created++;
        else if (action === 'updated') updated++;
      } catch (err) {
        this.logger.error(MODULE, 'State post failed (' + state + '): ' + err.message);
      }
      await new Promise(r => setTimeout(r, 200));
    }

    // National post
    try {
      const action = await this.generateNationalPost(metalType);
      if (action === 'created') created++;
      else if (action === 'updated') updated++;
    } catch (err) {
      this.logger.error(MODULE, 'National post failed: ' + err.message);
    }

    // Log to metals_log
    try {
      this.db.prepare(`
        INSERT INTO metals_log (metal_type, action, detail, created_at)
        VALUES (?, 'post_generation', ?, datetime('now'))
      `).run(metalType, JSON.stringify({ created, updated, cities: cities.length, states: states.length }));
    } catch (err) {
      this.logger.warn(MODULE, 'Failed to write metals_log: ' + err.message);
    }

    this.logger.info(MODULE, metalType + ' post generation complete — created: ' + created + ', updated: ' + updated);
    return { created, updated };
  }

  // ─── City post ──────────────────────────────────────────────────────────

  /**
   * Generate and publish a city-level metal price post.
   */
  async generateCityPost(city, state, metalType) {
    const config = METAL_CONFIG[metalType];
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    // Today's prices
    const todayRow = this.db.prepare(
      'SELECT price_24k, price_22k, price_18k, price_1g FROM metals_prices WHERE city = ? AND metal_type = ? AND price_date = ?'
    ).get(city, metalType, today);
    if (!todayRow) return null;

    // Yesterday's prices (for delta)
    const yesterdayRow = this.db.prepare(
      'SELECT price_24k, price_22k, price_18k, price_1g FROM metals_prices WHERE city = ? AND metal_type = ? AND price_date = ?'
    ).get(city, metalType, yesterday);

    // Primary price
    const primaryPrice = metalType === 'gold' ? todayRow.price_24k : todayRow.price_1g;
    const yesterdayPrimary = yesterdayRow ? (metalType === 'gold' ? yesterdayRow.price_24k : yesterdayRow.price_1g) : null;
    const delta = (primaryPrice && yesterdayPrimary) ? primaryPrice - yesterdayPrimary : 0;

    // 7-day history
    const history7 = this.db.prepare(`
      SELECT price_date, price_24k, price_22k, price_18k, price_1g
      FROM metals_prices
      WHERE city = ? AND metal_type = ? AND price_date >= date(?, '-7 days')
      ORDER BY price_date ASC
    `).all(city, metalType, today);

    // 30-day history for trend analysis
    const history30 = this.db.prepare(`
      SELECT price_date, price_24k, price_22k, price_18k, price_1g
      FROM metals_prices
      WHERE city = ? AND metal_type = ? AND price_date >= date(?, '-30 days')
      ORDER BY price_date ASC
    `).all(city, metalType, today);

    // Same-state cities
    const stateCities = this.db.prepare(`
      SELECT mc.city_name, mp.price_24k, mp.price_22k, mp.price_18k, mp.price_1g
      FROM metals_cities mc
      INNER JOIN metals_prices mp ON mc.city_name = mp.city
        AND mp.metal_type = ? AND mp.price_date = ?
      WHERE mc.state = ? AND mc.is_active = 1
      ORDER BY mc.city_name ASC
    `).all(metalType, today, state);

    // Build post
    const title = config.label + ' Price in ' + city + ' Today (' + fmtDate(today) + ') — ' + config.titleSuffix;
    const slug = slugify(metalType + '-price-in-' + city + '-today');
    const metaDescription = (config.label + ' price in ' + city + ' today is ₹' + indianFormat(primaryPrice) + ' per gram, ' + changeText(delta) + '. Check ' + config.titleSuffix + ' rates.').substring(0, 160);

    // Build HTML content
    let html = '';

    // ── 1. Hero section ──
    html += '<div class="hdf-hero">';
    html += '<div class="hdf-hero-inner">';
    html += '<span class="hdf-live-badge">LIVE</span>';
    html += '<h2 class="hdf-hero-title">' + config.label + ' Price in ' + city + '</h2>';
    html += '<div class="hdf-hero-price">₹' + indianFormat(primaryPrice) + ' <small>per gram</small></div>';
    html += '<div class="hdf-hero-change">' + changeBadge(delta) + '</div>';
    if (metalType === 'gold') {
      html += '<div class="hdf-hero-variants">';
      html += '<span class="hdf-variant-badge">22K: ₹' + indianFormat(todayRow.price_22k) + '</span>';
      html += '<span class="hdf-variant-badge">18K: ₹' + indianFormat(todayRow.price_18k) + '</span>';
      html += '</div>';
    }
    html += '<div class="hdf-hero-source">Source: ' + config.source + '</div>';
    html += '</div>';
    html += '</div>';

    // ── 2. Intro paragraph ──
    html += '<div class="hdf-section hdf-intro">';
    html += '<p>Today\'s <strong>' + config.label.toLowerCase() + ' price in ' + city + '</strong> is <strong>₹' + indianFormat(primaryPrice) + ' per gram</strong>, ';
    html += changeText(delta) + '. ';
    if (metalType === 'gold') {
      html += 'The 22K gold rate stands at ₹' + indianFormat(todayRow.price_22k) + ' per gram, while 18K is priced at ₹' + indianFormat(todayRow.price_18k) + ' per gram. ';
    }
    html += 'Prices are sourced from the ' + config.source + ' and updated daily.</p>';
    html += '</div>';

    // ── 3. Weight table ──
    html += '<div class="hdf-section hdf-weight-table">';
    html += '<h2>' + config.label + ' Price in ' + city + ' — By Weight</h2>';
    html += '<table class="hdf-table">';
    html += '<thead><tr><th>Weight</th>';
    if (metalType === 'gold') {
      html += '<th>24K Price</th><th>22K Price</th><th>18K Price</th>';
    } else {
      html += '<th>Price (₹)</th>';
    }
    html += '</tr></thead>';
    html += '<tbody>';
    for (const w of config.weightRows) {
      const label = w >= 1000 ? (w / 1000) + ' KG' : w + ' ' + config.weightUnit;
      html += '<tr><td>' + label + '</td>';
      if (metalType === 'gold') {
        html += '<td>₹' + indianFormat(todayRow.price_24k ? todayRow.price_24k * w : null) + '</td>';
        html += '<td>₹' + indianFormat(todayRow.price_22k ? todayRow.price_22k * w : null) + '</td>';
        html += '<td>₹' + indianFormat(todayRow.price_18k ? todayRow.price_18k * w : null) + '</td>';
      } else {
        html += '<td>₹' + indianFormat(todayRow.price_1g ? todayRow.price_1g * w : null) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    html += '</div>';

    // ── 4. Investment calculator ──
    html += '<div class="hdf-section hdf-calculator">';
    html += '<h2>' + config.label + ' Investment Calculator — ' + city + '</h2>';
    html += '<table class="hdf-table">';
    html += '<thead><tr><th>Weight</th><th>Rate per Gram</th><th>Total Cost (₹)</th></tr></thead>';
    html += '<tbody>';
    for (const w of config.weightRows) {
      const label = w >= 1000 ? (w / 1000) + ' KG' : w + ' ' + config.weightUnit;
      const rate = metalType === 'gold' ? todayRow.price_24k : todayRow.price_1g;
      html += '<tr><td>' + label + '</td>';
      html += '<td>₹' + indianFormat(rate) + '</td>';
      html += '<td>₹' + indianFormat(rate ? rate * w : null) + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
    html += '</div>';

    // ── 5. 7-Day history table ──
    html += '<div class="hdf-section hdf-history">';
    html += '<h2>' + config.label + ' Price Trend in ' + city + ' — Last 7 Days</h2>';
    html += '<table class="hdf-table">';
    html += '<thead><tr><th>Date</th><th>Price (₹/g)</th><th>Change (₹)</th><th>Change (%)</th></tr></thead>';
    html += '<tbody>';
    for (let i = 0; i < history7.length; i++) {
      const row = history7[i];
      const price = metalType === 'gold' ? row.price_24k : row.price_1g;
      const prevPrice = i > 0 ? (metalType === 'gold' ? history7[i - 1].price_24k : history7[i - 1].price_1g) : null;
      const dayDelta = (price && prevPrice) ? price - prevPrice : 0;
      const dayPct = (price && prevPrice && prevPrice !== 0) ? ((dayDelta / prevPrice) * 100).toFixed(2) : '0.00';
      const isToday = row.price_date === today;
      html += '<tr' + (isToday ? ' class="hdf-today-row"' : '') + '>';
      html += '<td>' + fmtDate(row.price_date) + (isToday ? ' <span class="hdf-today-badge">Today</span>' : '') + '</td>';
      html += '<td>₹' + indianFormat(price) + '</td>';
      html += '<td>' + changeBadge(dayDelta) + '</td>';
      html += '<td>' + (dayDelta >= 0 ? '+' : '') + dayPct + '%</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
    html += '</div>';

    // ── 6. Chart placeholder ──
    html += '<div class="hdf-section hdf-chart">';
    html += '<h2>' + config.label + ' Price Chart — ' + city + '</h2>';
    html += '<canvas class="hdf-price-chart" data-city="' + city + '" data-metal="' + metalType + '" data-days="30" width="700" height="350"></canvas>';
    html += '</div>';

    // ── 7. 30-Day trend analysis ──
    html += this._build30DayTrend(history30, metalType, config, city);

    // ── 8. Cross-metal pills ──
    html += '<div class="hdf-section hdf-cross-metal">';
    html += '<h2>Other Metal Prices in ' + city + '</h2>';
    html += '<div class="hdf-pills">';
    const otherMetals = Object.keys(METAL_CONFIG).filter(m => m !== metalType);
    for (const om of otherMetals) {
      const omConf = METAL_CONFIG[om];
      const omSlug = slugify(om + '-price-in-' + city + '-today');
      html += '<a class="hdf-pill" href="/' + omSlug + '/">' + omConf.label + ' Price in ' + city + '</a>';
    }
    html += '</div>';
    html += '</div>';

    // ── 9. Same-state city pills ──
    html += '<div class="hdf-section hdf-state-cities">';
    html += '<h2>' + config.label + ' Price in Other ' + state + ' Cities</h2>';
    html += '<div class="hdf-pills">';
    for (const sc of stateCities) {
      const scPrice = metalType === 'gold' ? sc.price_24k : sc.price_1g;
      const scSlug = slugify(metalType + '-price-in-' + sc.city_name + '-today');
      html += '<a class="hdf-pill" href="/' + scSlug + '/">' + sc.city_name + ' — ₹' + indianFormat(scPrice) + '</a>';
    }
    html += '</div>';
    html += '</div>';

    // ── 10. Top cities pills ──
    html += '<div class="hdf-section hdf-top-cities">';
    html += '<h2>' + config.label + ' Price in Major Indian Cities</h2>';
    html += '<div class="hdf-pills">';
    for (const tc of TOP_CITIES) {
      const tcSlug = slugify(metalType + '-price-in-' + tc + '-today');
      html += '<a class="hdf-pill" href="/' + tcSlug + '/">' + tc + '</a>';
    }
    html += '</div>';
    html += '</div>';

    // ── 11. About pricing ──
    html += '<div class="hdf-section hdf-about-pricing">';
    html += '<h2>How ' + config.label + ' Prices Are Determined in India</h2>';
    html += '<p>' + config.label + ' prices in India are influenced by the international spot price set by the <strong>London Bullion Market Association (LBMA)</strong>, ';
    html += 'converted to INR using the prevailing USD-INR exchange rate. The domestic price also includes:</p>';
    html += '<ul>';
    html += '<li><strong>Import Duty:</strong> ' + config.importDuty + ' levied by the Government of India on imported ' + config.label.toLowerCase() + '.</li>';
    html += '<li><strong>GST:</strong> ' + config.gst + ' applicable on ' + config.label.toLowerCase() + ' purchases.</li>';
    html += '<li><strong>Making Charges:</strong> Jewellers add making charges (varies by design and jeweller) on top of the base metal price.</li>';
    html += '</ul>';
    html += '<p>The ' + config.source + ' publishes the official daily rate that jewellers across India use as their benchmark.</p>';
    html += '</div>';

    // ── 12. Price breakdown ──
    html += '<div class="hdf-section hdf-price-breakdown">';
    html += '<h2>' + config.label + ' Price Breakdown</h2>';
    html += '<table class="hdf-table">';
    html += '<thead><tr><th>Component</th><th>Details</th></tr></thead>';
    html += '<tbody>';
    html += '<tr><td>International Spot Price</td><td>Set by LBMA (London Bullion Market Association)</td></tr>';
    html += '<tr><td>USD-INR Exchange Rate</td><td>Prevailing RBI reference rate</td></tr>';
    html += '<tr><td>Import Duty</td><td>' + config.importDuty + ' on CIF value</td></tr>';
    html += '<tr><td>GST</td><td>' + config.gst + '</td></tr>';
    html += '<tr><td>Making Charges</td><td>Varies by jeweller and design (typically 8%–25%)</td></tr>';
    html += '</tbody></table>';
    html += '</div>';

    // ── 13. Breadcrumb ──
    html += '<nav class="hdf-breadcrumb">';
    const stateSlug = slugify(metalType + '-price-in-' + state + '-today');
    const nationalSlug = slugify(metalType + '-price-in-india-today');
    html += '<a href="/' + nationalSlug + '/">India</a>';
    html += ' &rsaquo; <a href="/' + stateSlug + '/">' + state + '</a>';
    html += ' &rsaquo; <span>' + city + '</span>';
    html += '</nav>';

    // ── 14. Cross-fuel links ──
    html += '<div class="hdf-section hdf-cross-fuel">';
    html += '<h2>Fuel Prices in ' + city + '</h2>';
    html += '<div class="hdf-pills">';
    const petrolSlug = slugify('petrol-price-in-' + city + '-today');
    const dieselSlug = slugify('diesel-price-in-' + city + '-today');
    html += '<a class="hdf-pill" href="/' + petrolSlug + '/">Petrol Price in ' + city + '</a>';
    html += '<a class="hdf-pill" href="/' + dieselSlug + '/">Diesel Price in ' + city + '</a>';
    html += '</div>';
    html += '</div>';

    // ── 15. FAQ ──
    html += '<div class="hdf-section hdf-faq">';
    html += '<h2>Frequently Asked Questions</h2>';
    html += '<div class="hdf-faq-list">';

    html += '<div class="hdf-faq-item"><h3>What is the ' + config.label.toLowerCase() + ' price in ' + city + ' today?</h3>';
    html += '<p>Today\'s ' + config.label.toLowerCase() + ' price in ' + city + ' is ₹' + indianFormat(primaryPrice) + ' per gram';
    if (metalType === 'gold') html += ' for 24K purity';
    html += ', as per the ' + config.source + '.</p></div>';

    html += '<div class="hdf-faq-item"><h3>How is ' + config.label.toLowerCase() + ' price calculated in ' + city + '?</h3>';
    html += '<p>' + config.label + ' prices in ' + city + ' are based on the international spot price (LBMA), converted to INR, plus import duty (' + config.importDuty + ') and GST (' + config.gst + '). Local demand and supply may cause minor variations.</p></div>';

    html += '<div class="hdf-faq-item"><h3>What is the GST on ' + config.label.toLowerCase() + ' in India?</h3>';
    html += '<p>GST on ' + config.label.toLowerCase() + ' in India is ' + config.gst + '. This is charged at the point of purchase from a jeweller or bullion dealer.</p></div>';

    html += '<div class="hdf-faq-item"><h3>Why do ' + config.label.toLowerCase() + ' prices differ between cities?</h3>';
    html += '<p>While the base ' + config.label.toLowerCase() + ' rate from IBJA is the same across India, city-level variations occur due to local demand, transportation costs, and jeweller margins. However, the difference is typically very small (₹20–₹50 per gram).</p></div>';

    html += '<div class="hdf-faq-item"><h3>Is it a good time to buy ' + config.label.toLowerCase() + ' in ' + city + '?</h3>';
    html += '<p>Prices have been ' + changeText(delta) + '. Review the 7-day and 30-day trend charts above to assess the price direction before making a purchase decision. Consult a financial advisor for large investments.</p></div>';

    html += '</div>';
    html += '</div>';

    // Publish
    const result = await this.wp.upsertPost({
      slug,
      title,
      content: html,
      categoryNames: [config.label],
      metaDescription,
      status: 'publish',
      meta: {
        _hdf_metal_city: city,
        _hdf_metal_type: metalType,
      },
    });

    const contentHash = crypto.createHash('md5').update(html).digest('hex');
    this._logPost('city', metalType, city, result, contentHash);
    this.logger.info(MODULE, config.label + ' city post ' + result.action + ': ' + city);
    return result.action;
  }

  // ─── State post ─────────────────────────────────────────────────────────

  /**
   * Generate and publish a state-level metal price post.
   */
  async generateStatePost(state, metalType) {
    const config = METAL_CONFIG[metalType];
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    // All cities in this state with today's prices
    const stateCities = this.db.prepare(`
      SELECT mc.city_name, mp.price_24k, mp.price_22k, mp.price_18k, mp.price_1g
      FROM metals_cities mc
      INNER JOIN metals_prices mp ON mc.city_name = mp.city
        AND mp.metal_type = ? AND mp.price_date = ?
      WHERE mc.state = ? AND mc.is_active = 1
      ORDER BY mc.city_name ASC
    `).all(metalType, today, state);

    if (stateCities.length === 0) return null;

    // State average
    let avgPrice;
    if (metalType === 'gold') {
      const prices = stateCities.map(c => c.price_24k).filter(Boolean);
      avgPrice = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
    } else {
      const prices = stateCities.map(c => c.price_1g).filter(Boolean);
      avgPrice = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
    }

    // Yesterday's state average for delta
    const stateCitiesYesterday = this.db.prepare(`
      SELECT mp.price_24k, mp.price_1g
      FROM metals_cities mc
      INNER JOIN metals_prices mp ON mc.city_name = mp.city
        AND mp.metal_type = ? AND mp.price_date = ?
      WHERE mc.state = ? AND mc.is_active = 1
    `).all(metalType, yesterday, state);

    let avgYesterday;
    if (metalType === 'gold') {
      const yPrices = stateCitiesYesterday.map(c => c.price_24k).filter(Boolean);
      avgYesterday = yPrices.length > 0 ? yPrices.reduce((a, b) => a + b, 0) / yPrices.length : null;
    } else {
      const yPrices = stateCitiesYesterday.map(c => c.price_1g).filter(Boolean);
      avgYesterday = yPrices.length > 0 ? yPrices.reduce((a, b) => a + b, 0) / yPrices.length : null;
    }

    const delta = (avgPrice && avgYesterday) ? avgPrice - avgYesterday : 0;

    // 7-day state trend
    const history7 = this.db.prepare(`
      SELECT mp.price_date,
             AVG(mp.price_24k) AS avg_24k,
             AVG(mp.price_22k) AS avg_22k,
             AVG(mp.price_18k) AS avg_18k,
             AVG(mp.price_1g) AS avg_1g
      FROM metals_prices mp
      INNER JOIN metals_cities mc ON mp.city = mc.city_name
      WHERE mc.state = ? AND mp.metal_type = ? AND mp.price_date >= date(?, '-7 days')
        AND mc.is_active = 1
      GROUP BY mp.price_date
      ORDER BY mp.price_date ASC
    `).all(state, metalType, today);

    const title = config.label + ' Price in ' + state + ' Today (' + fmtDate(today) + ') — ' + config.titleSuffix + ' All Cities';
    const slug = slugify(metalType + '-price-in-' + state + '-today');
    const metaDescription = (config.label + ' price in ' + state + ' today averages ₹' + indianFormat(avgPrice) + '/g. Check ' + config.titleSuffix + ' across all cities.').substring(0, 160);

    let html = '';

    // ── Hero with state average ──
    html += '<div class="hdf-hero">';
    html += '<div class="hdf-hero-inner">';
    html += '<span class="hdf-live-badge">LIVE</span>';
    html += '<h2 class="hdf-hero-title">' + config.label + ' Price in ' + state + '</h2>';
    html += '<div class="hdf-hero-price">₹' + indianFormat(avgPrice) + ' <small>avg per gram</small></div>';
    html += '<div class="hdf-hero-change">' + changeBadge(delta) + '</div>';
    html += '<div class="hdf-hero-source">Source: ' + config.source + '</div>';
    html += '<div class="hdf-hero-meta">' + stateCities.length + ' cities tracked</div>';
    html += '</div>';
    html += '</div>';

    // ── Intro ──
    html += '<div class="hdf-section hdf-intro">';
    html += '<p>The average <strong>' + config.label.toLowerCase() + ' price in ' + state + '</strong> today is <strong>₹' + indianFormat(avgPrice) + ' per gram</strong>, ';
    html += changeText(delta) + '. ';
    html += 'Prices are tracked across ' + stateCities.length + ' cities in ' + state + ', sourced daily from the ' + config.source + '.</p>';
    html += '</div>';

    // ── All cities table ──
    html += '<div class="hdf-section hdf-state-table">';
    html += '<h2>' + config.label + ' Price in ' + state + ' — All Cities</h2>';
    html += '<table class="hdf-table">';
    html += '<thead><tr><th>City</th>';
    if (metalType === 'gold') {
      html += '<th>24K (₹/g)</th><th>22K (₹/g)</th><th>18K (₹/g)</th>';
    } else {
      html += '<th>Price (₹/g)</th>';
    }
    html += '</tr></thead>';
    html += '<tbody>';
    for (const sc of stateCities) {
      const citySlug = slugify(metalType + '-price-in-' + sc.city_name + '-today');
      html += '<tr>';
      html += '<td><a href="/' + citySlug + '/">' + sc.city_name + '</a></td>';
      if (metalType === 'gold') {
        html += '<td>₹' + indianFormat(sc.price_24k) + '</td>';
        html += '<td>₹' + indianFormat(sc.price_22k) + '</td>';
        html += '<td>₹' + indianFormat(sc.price_18k) + '</td>';
      } else {
        html += '<td>₹' + indianFormat(sc.price_1g) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    html += '</div>';

    // ── 7-Day state history ──
    html += '<div class="hdf-section hdf-history">';
    html += '<h2>' + config.label + ' Price Trend in ' + state + ' — Last 7 Days</h2>';
    html += '<table class="hdf-table">';
    html += '<thead><tr><th>Date</th><th>Avg Price (₹/g)</th><th>Change</th><th>Change (%)</th></tr></thead>';
    html += '<tbody>';
    for (let i = 0; i < history7.length; i++) {
      const row = history7[i];
      const price = metalType === 'gold' ? row.avg_24k : row.avg_1g;
      const prevPrice = i > 0 ? (metalType === 'gold' ? history7[i - 1].avg_24k : history7[i - 1].avg_1g) : null;
      const dayDelta = (price && prevPrice) ? price - prevPrice : 0;
      const dayPct = (price && prevPrice && prevPrice !== 0) ? ((dayDelta / prevPrice) * 100).toFixed(2) : '0.00';
      const isToday = row.price_date === today;
      html += '<tr' + (isToday ? ' class="hdf-today-row"' : '') + '>';
      html += '<td>' + fmtDate(row.price_date) + (isToday ? ' <span class="hdf-today-badge">Today</span>' : '') + '</td>';
      html += '<td>₹' + indianFormat(price) + '</td>';
      html += '<td>' + changeBadge(dayDelta) + '</td>';
      html += '<td>' + (dayDelta >= 0 ? '+' : '') + dayPct + '%</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
    html += '</div>';

    // ── Chart placeholder ──
    html += '<div class="hdf-section hdf-chart">';
    html += '<h2>' + config.label + ' Price Chart — ' + state + '</h2>';
    html += '<canvas class="hdf-price-chart" data-city="' + state + '" data-metal="' + metalType + '" data-days="30" data-level="state" width="700" height="350"></canvas>';
    html += '</div>';

    // ── National link ──
    html += '<div class="hdf-section hdf-national-link">';
    const nationalSlug = slugify(metalType + '-price-in-india-today');
    html += '<p>View <a href="/' + nationalSlug + '/">' + config.label + ' Price in India — All States</a></p>';
    html += '</div>';

    // ── Cross-metal pills ──
    html += '<div class="hdf-section hdf-cross-metal">';
    html += '<h2>Other Metal Prices in ' + state + '</h2>';
    html += '<div class="hdf-pills">';
    const otherMetals = Object.keys(METAL_CONFIG).filter(m => m !== metalType);
    for (const om of otherMetals) {
      const omConf = METAL_CONFIG[om];
      const omSlug = slugify(om + '-price-in-' + state + '-today');
      html += '<a class="hdf-pill" href="/' + omSlug + '/">' + omConf.label + ' Price in ' + state + '</a>';
    }
    html += '</div>';
    html += '</div>';

    // ── Cross-fuel links ──
    html += '<div class="hdf-section hdf-cross-fuel">';
    html += '<h2>Fuel Prices in ' + state + '</h2>';
    html += '<div class="hdf-pills">';
    const petrolSlug = slugify('petrol-price-in-' + state + '-today');
    const dieselSlug = slugify('diesel-price-in-' + state + '-today');
    html += '<a class="hdf-pill" href="/' + petrolSlug + '/">Petrol Price in ' + state + '</a>';
    html += '<a class="hdf-pill" href="/' + dieselSlug + '/">Diesel Price in ' + state + '</a>';
    html += '</div>';
    html += '</div>';

    // ── FAQ ──
    html += '<div class="hdf-section hdf-faq">';
    html += '<h2>Frequently Asked Questions</h2>';
    html += '<div class="hdf-faq-list">';

    html += '<div class="hdf-faq-item"><h3>What is the ' + config.label.toLowerCase() + ' rate in ' + state + ' today?</h3>';
    html += '<p>The average ' + config.label.toLowerCase() + ' price in ' + state + ' today is ₹' + indianFormat(avgPrice) + ' per gram';
    if (metalType === 'gold') html += ' for 24K purity';
    html += '. Prices may vary slightly across cities.</p></div>';

    html += '<div class="hdf-faq-item"><h3>Which city in ' + state + ' has the lowest ' + config.label.toLowerCase() + ' price?</h3>';
    let cheapest = stateCities[0];
    for (const sc of stateCities) {
      const p = metalType === 'gold' ? sc.price_24k : sc.price_1g;
      const cp = metalType === 'gold' ? cheapest.price_24k : cheapest.price_1g;
      if (p && cp && p < cp) cheapest = sc;
    }
    const cheapPrice = metalType === 'gold' ? cheapest.price_24k : cheapest.price_1g;
    html += '<p>' + cheapest.city_name + ' currently has the lowest ' + config.label.toLowerCase() + ' price in ' + state + ' at ₹' + indianFormat(cheapPrice) + ' per gram.</p></div>';

    html += '<div class="hdf-faq-item"><h3>Are ' + config.label.toLowerCase() + ' prices the same across all cities in ' + state + '?</h3>';
    html += '<p>No, minor variations (typically ₹20–₹50 per gram) exist between cities due to local demand, transportation, and jeweller margins. The base rate from ' + config.source + ' is the same nationwide.</p></div>';

    html += '<div class="hdf-faq-item"><h3>What taxes are applicable on ' + config.label.toLowerCase() + ' in ' + state + '?</h3>';
    html += '<p>GST of ' + config.gst + ' is applicable on ' + config.label.toLowerCase() + ' purchases across India, including ' + state + '. Import duty is ' + config.importDuty + '.</p></div>';

    html += '<div class="hdf-faq-item"><h3>How often are ' + config.label.toLowerCase() + ' prices updated?</h3>';
    html += '<p>' + config.label + ' prices are updated daily based on the IBJA rate. The rate is typically announced between 10:30 AM and 11:30 AM IST on business days.</p></div>';

    html += '</div>';
    html += '</div>';

    // Publish
    const result = await this.wp.upsertPost({
      slug,
      title,
      content: html,
      categoryNames: [config.label],
      metaDescription,
      status: 'publish',
      meta: {
        _hdf_metal_state: state,
        _hdf_metal_type: metalType,
        _hdf_metal_is_state: '1',
      },
    });

    const contentHash = crypto.createHash('md5').update(html).digest('hex');
    this._logPost('state', metalType, state, result, contentHash);
    this.logger.info(MODULE, config.label + ' state post ' + result.action + ': ' + state);
    return result.action;
  }

  // ─── National post ──────────────────────────────────────────────────────

  /**
   * Generate and publish a national-level metal price post.
   */
  async generateNationalPost(metalType) {
    const config = METAL_CONFIG[metalType];
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    // All cities with today's prices
    const allCities = this.db.prepare(`
      SELECT mc.city_name, mc.state,
             mp.price_24k, mp.price_22k, mp.price_18k, mp.price_1g
      FROM metals_cities mc
      INNER JOIN metals_prices mp ON mc.city_name = mp.city
        AND mp.metal_type = ? AND mp.price_date = ?
      WHERE mc.is_active = 1
      ORDER BY mc.city_name ASC
    `).all(metalType, today);

    if (allCities.length === 0) return null;

    // National average
    let nationalAvg;
    if (metalType === 'gold') {
      const prices = allCities.map(c => c.price_24k).filter(Boolean);
      nationalAvg = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
    } else {
      const prices = allCities.map(c => c.price_1g).filter(Boolean);
      nationalAvg = prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
    }

    // Yesterday's national average
    const allCitiesYesterday = this.db.prepare(`
      SELECT mp.price_24k, mp.price_1g
      FROM metals_cities mc
      INNER JOIN metals_prices mp ON mc.city_name = mp.city
        AND mp.metal_type = ? AND mp.price_date = ?
      WHERE mc.is_active = 1
    `).all(metalType, yesterday);

    let avgYesterday;
    if (metalType === 'gold') {
      const yPrices = allCitiesYesterday.map(c => c.price_24k).filter(Boolean);
      avgYesterday = yPrices.length > 0 ? yPrices.reduce((a, b) => a + b, 0) / yPrices.length : null;
    } else {
      const yPrices = allCitiesYesterday.map(c => c.price_1g).filter(Boolean);
      avgYesterday = yPrices.length > 0 ? yPrices.reduce((a, b) => a + b, 0) / yPrices.length : null;
    }

    const delta = (nationalAvg && avgYesterday) ? nationalAvg - avgYesterday : 0;

    // State-wise aggregation
    const stateMap = {};
    for (const c of allCities) {
      if (!c.state) continue;
      if (!stateMap[c.state]) stateMap[c.state] = { prices: [], cities: [] };
      const p = metalType === 'gold' ? c.price_24k : c.price_1g;
      if (p) stateMap[c.state].prices.push(p);
      stateMap[c.state].cities.push(c);
    }

    const stateAverages = Object.entries(stateMap).map(([st, data]) => ({
      state: st,
      avg: data.prices.length > 0 ? data.prices.reduce((a, b) => a + b, 0) / data.prices.length : null,
      cityCount: data.cities.length,
    })).filter(s => s.avg).sort((a, b) => a.state.localeCompare(b.state));

    // 7-day national trend
    const history7 = this.db.prepare(`
      SELECT price_date,
             AVG(price_24k) AS avg_24k,
             AVG(price_1g) AS avg_1g
      FROM metals_prices
      WHERE metal_type = ? AND price_date >= date(?, '-7 days')
      GROUP BY price_date
      ORDER BY price_date ASC
    `).all(metalType, today);

    // Major cities (top 20)
    const majorCities = this.db.prepare(`
      SELECT mc.city_name, mc.state,
             mp.price_24k, mp.price_22k, mp.price_18k, mp.price_1g
      FROM metals_cities mc
      INNER JOIN metals_prices mp ON mc.city_name = mp.city
        AND mp.metal_type = ? AND mp.price_date = ?
      WHERE mc.is_active = 1
      ORDER BY mc.city_name ASC
      LIMIT 20
    `).all(metalType, today);

    const title = config.label + ' Price in India Today (' + fmtDate(today) + ') — ' + config.titleSuffix + ' All Cities';
    const slug = slugify(metalType + '-price-in-india-today');
    const metaDescription = (config.label + ' price in India today is ₹' + indianFormat(nationalAvg) + '/g avg, ' + changeText(delta) + '. Check ' + config.titleSuffix + ' in all cities.').substring(0, 160);

    let html = '';

    // ── Hero ──
    html += '<div class="hdf-hero">';
    html += '<div class="hdf-hero-inner">';
    html += '<span class="hdf-live-badge">LIVE</span>';
    html += '<h2 class="hdf-hero-title">' + config.label + ' Price in India</h2>';
    html += '<div class="hdf-hero-price">₹' + indianFormat(nationalAvg) + ' <small>avg per gram</small></div>';
    html += '<div class="hdf-hero-change">' + changeBadge(delta) + '</div>';
    html += '<div class="hdf-hero-source">Source: ' + config.source + '</div>';
    html += '<div class="hdf-hero-meta">' + allCities.length + ' cities · ' + stateAverages.length + ' states tracked</div>';
    html += '</div>';
    html += '</div>';

    // ── Intro ──
    html += '<div class="hdf-section hdf-intro">';
    html += '<p>The national average <strong>' + config.label.toLowerCase() + ' price in India</strong> today is <strong>₹' + indianFormat(nationalAvg) + ' per gram</strong>, ';
    html += changeText(delta) + '. ';
    html += 'We track ' + config.label.toLowerCase() + ' rates across ' + allCities.length + ' cities in ' + stateAverages.length + ' states, sourced from the ' + config.source + '.</p>';
    html += '</div>';

    // ── State-wise table ──
    html += '<div class="hdf-section hdf-statewise-table">';
    html += '<h2>' + config.label + ' Price by State</h2>';
    html += '<table class="hdf-table">';
    html += '<thead><tr><th>State</th><th>Avg Price (₹/g)</th><th>Cities</th></tr></thead>';
    html += '<tbody>';
    for (const sa of stateAverages) {
      const stSlug = slugify(metalType + '-price-in-' + sa.state + '-today');
      html += '<tr>';
      html += '<td><a href="/' + stSlug + '/">' + sa.state + '</a></td>';
      html += '<td>₹' + indianFormat(sa.avg) + '</td>';
      html += '<td>' + sa.cityCount + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
    html += '</div>';

    // ── Most / least expensive states ──
    const sortedByPrice = [...stateAverages].sort((a, b) => b.avg - a.avg);
    html += '<div class="hdf-section hdf-state-extremes">';
    html += '<h2>Most & Least Expensive States for ' + config.label + '</h2>';
    html += '<div class="hdf-extremes-grid">';

    html += '<div class="hdf-extreme-card hdf-extreme-high">';
    html += '<h3>Most Expensive</h3>';
    html += '<ol>';
    const topStates = sortedByPrice.slice(0, 5);
    for (const ts of topStates) {
      html += '<li>' + ts.state + ' — ₹' + indianFormat(ts.avg) + '/g</li>';
    }
    html += '</ol>';
    html += '</div>';

    html += '<div class="hdf-extreme-card hdf-extreme-low">';
    html += '<h3>Least Expensive</h3>';
    html += '<ol>';
    const bottomStates = sortedByPrice.slice(-5).reverse();
    for (const bs of bottomStates) {
      html += '<li>' + bs.state + ' — ₹' + indianFormat(bs.avg) + '/g</li>';
    }
    html += '</ol>';
    html += '</div>';

    html += '</div>';
    html += '</div>';

    // ── Major cities table (20) ──
    html += '<div class="hdf-section hdf-major-cities">';
    html += '<h2>' + config.label + ' Price in Major Indian Cities</h2>';
    html += '<table class="hdf-table">';
    html += '<thead><tr><th>City</th><th>State</th>';
    if (metalType === 'gold') {
      html += '<th>24K (₹/g)</th><th>22K (₹/g)</th><th>18K (₹/g)</th>';
    } else {
      html += '<th>Price (₹/g)</th>';
    }
    html += '</tr></thead>';
    html += '<tbody>';
    for (const mc of majorCities) {
      const mcSlug = slugify(metalType + '-price-in-' + mc.city_name + '-today');
      html += '<tr>';
      html += '<td><a href="/' + mcSlug + '/">' + mc.city_name + '</a></td>';
      html += '<td>' + (mc.state || '—') + '</td>';
      if (metalType === 'gold') {
        html += '<td>₹' + indianFormat(mc.price_24k) + '</td>';
        html += '<td>₹' + indianFormat(mc.price_22k) + '</td>';
        html += '<td>₹' + indianFormat(mc.price_18k) + '</td>';
      } else {
        html += '<td>₹' + indianFormat(mc.price_1g) + '</td>';
      }
      html += '</tr>';
    }
    html += '</tbody></table>';
    html += '</div>';

    // ── 7-Day national history ──
    html += '<div class="hdf-section hdf-history">';
    html += '<h2>' + config.label + ' Price Trend in India — Last 7 Days</h2>';
    html += '<table class="hdf-table">';
    html += '<thead><tr><th>Date</th><th>Avg Price (₹/g)</th><th>Change</th><th>Change (%)</th></tr></thead>';
    html += '<tbody>';
    for (let i = 0; i < history7.length; i++) {
      const row = history7[i];
      const price = metalType === 'gold' ? row.avg_24k : row.avg_1g;
      const prevPrice = i > 0 ? (metalType === 'gold' ? history7[i - 1].avg_24k : history7[i - 1].avg_1g) : null;
      const dayDelta = (price && prevPrice) ? price - prevPrice : 0;
      const dayPct = (price && prevPrice && prevPrice !== 0) ? ((dayDelta / prevPrice) * 100).toFixed(2) : '0.00';
      const isToday = row.price_date === today;
      html += '<tr' + (isToday ? ' class="hdf-today-row"' : '') + '>';
      html += '<td>' + fmtDate(row.price_date) + (isToday ? ' <span class="hdf-today-badge">Today</span>' : '') + '</td>';
      html += '<td>₹' + indianFormat(price) + '</td>';
      html += '<td>' + changeBadge(dayDelta) + '</td>';
      html += '<td>' + (dayDelta >= 0 ? '+' : '') + dayPct + '%</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
    html += '</div>';

    // ── Chart ──
    html += '<div class="hdf-section hdf-chart">';
    html += '<h2>' + config.label + ' Price Chart — India</h2>';
    html += '<canvas class="hdf-price-chart" data-city="India" data-metal="' + metalType + '" data-days="30" data-level="national" width="700" height="350"></canvas>';
    html += '</div>';

    // ── Cross-metal links ──
    html += '<div class="hdf-section hdf-cross-metal">';
    html += '<h2>Other Metal Prices in India</h2>';
    html += '<div class="hdf-pills">';
    const otherMetals = Object.keys(METAL_CONFIG).filter(m => m !== metalType);
    for (const om of otherMetals) {
      const omConf = METAL_CONFIG[om];
      const omSlug = slugify(om + '-price-in-india-today');
      html += '<a class="hdf-pill" href="/' + omSlug + '/">' + omConf.label + ' Price in India</a>';
    }
    html += '</div>';
    html += '</div>';

    // ── Cross-fuel links ──
    html += '<div class="hdf-section hdf-cross-fuel">';
    html += '<h2>Fuel Prices in India</h2>';
    html += '<div class="hdf-pills">';
    html += '<a class="hdf-pill" href="/petrol-price-in-india-today/">Petrol Price in India</a>';
    html += '<a class="hdf-pill" href="/diesel-price-in-india-today/">Diesel Price in India</a>';
    html += '</div>';
    html += '</div>';

    // ── About IBJA / LBMA ──
    html += '<div class="hdf-section hdf-about-pricing">';
    html += '<h2>About ' + config.label + ' Pricing in India</h2>';
    html += '<p>Domestic ' + config.label.toLowerCase() + ' prices in India are derived from the international spot price determined by the <strong>London Bullion Market Association (LBMA)</strong>. ';
    html += 'The LBMA conducts twice-daily electronic auctions (AM and PM fix) that set the global benchmark for precious metals.</p>';
    html += '<p>To arrive at the Indian price, the LBMA spot rate (in USD per troy ounce) is:</p>';
    html += '<ol>';
    html += '<li>Converted to INR using the prevailing RBI reference exchange rate</li>';
    html += '<li>Converted from troy ounce (31.1g) to per-gram pricing</li>';
    html += '<li>Adjusted for import duty of ' + config.importDuty + '</li>';
    html += '<li>GST of ' + config.gst + ' added at point of sale</li>';
    html += '</ol>';
    html += '<p>The <strong>' + config.source + '</strong> then publishes the official daily domestic rate that jewellers and dealers across India use as their benchmark.</p>';
    html += '</div>';

    // ── FAQ ──
    html += '<div class="hdf-section hdf-faq">';
    html += '<h2>Frequently Asked Questions</h2>';
    html += '<div class="hdf-faq-list">';

    html += '<div class="hdf-faq-item"><h3>What is today\'s ' + config.label.toLowerCase() + ' rate in India?</h3>';
    html += '<p>The average ' + config.label.toLowerCase() + ' price in India today is ₹' + indianFormat(nationalAvg) + ' per gram';
    if (metalType === 'gold') html += ' for 24K purity';
    html += ', sourced from the ' + config.source + '.</p></div>';

    html += '<div class="hdf-faq-item"><h3>Which state has the cheapest ' + config.label.toLowerCase() + ' in India?</h3>';
    const cheapestState = sortedByPrice.length > 0 ? sortedByPrice[sortedByPrice.length - 1] : null;
    if (cheapestState) {
      html += '<p>' + cheapestState.state + ' currently has the lowest average ' + config.label.toLowerCase() + ' price at ₹' + indianFormat(cheapestState.avg) + ' per gram.</p></div>';
    } else {
      html += '<p>Price data is being updated. Please check back shortly.</p></div>';
    }

    html += '<div class="hdf-faq-item"><h3>Why is ' + config.label.toLowerCase() + ' price different in each city?</h3>';
    html += '<p>While the IBJA base rate is uniform, city-level variations of ₹20–₹50 per gram arise from local demand, transportation costs, and individual jeweller margins.</p></div>';

    html += '<div class="hdf-faq-item"><h3>What is the import duty on ' + config.label.toLowerCase() + ' in India?</h3>';
    html += '<p>The current import duty on ' + config.label.toLowerCase() + ' in India is ' + config.importDuty + ', levied on the CIF (Cost, Insurance, and Freight) value of imported ' + config.label.toLowerCase() + '.</p></div>';

    html += '<div class="hdf-faq-item"><h3>How can I track daily ' + config.label.toLowerCase() + ' prices?</h3>';
    html += '<p>This page is updated every day with the latest ' + config.label.toLowerCase() + ' rates from IBJA. Bookmark this page or visit daily to track prices across all Indian cities and states.</p></div>';

    html += '</div>';
    html += '</div>';

    // Publish
    const result = await this.wp.upsertPost({
      slug,
      title,
      content: html,
      categoryNames: [config.label],
      metaDescription,
      status: 'publish',
      meta: {
        _hdf_metal_type: metalType,
        _hdf_metal_is_national: '1',
      },
    });

    const contentHash = crypto.createHash('md5').update(html).digest('hex');
    this._logPost('national', metalType, 'India', result, contentHash);
    this.logger.info(MODULE, config.label + ' national post ' + result.action);
    return result.action;
  }

  // ─── Shared helpers ─────────────────────────────────────────────────────

  /**
   * Build 30-day trend analysis section from history rows.
   */
  _build30DayTrend(history30, metalType, config, locationName) {
    if (!history30 || history30.length < 2) {
      return '<div class="hdf-section hdf-trend"><h2>30-Day Trend Analysis</h2><p>Insufficient data for trend analysis. Check back after a few days.</p></div>';
    }

    const prices = history30.map(r => metalType === 'gold' ? r.price_24k : r.price_1g).filter(Boolean);
    if (prices.length < 2) {
      return '<div class="hdf-section hdf-trend"><h2>30-Day Trend Analysis</h2><p>Insufficient data for trend analysis.</p></div>';
    }

    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    const first = prices[0];
    const last = prices[prices.length - 1];
    const totalChange = last - first;
    const pctChange = first !== 0 ? ((totalChange / first) * 100).toFixed(2) : '0.00';

    // Direction
    let direction;
    if (totalChange > 0) direction = 'upward';
    else if (totalChange < 0) direction = 'downward';
    else direction = 'flat';

    // Stability (standard deviation)
    const mean = avg;
    const variance = prices.reduce((sum, p) => sum + Math.pow(p - mean, 2), 0) / prices.length;
    const stdDev = Math.sqrt(variance);
    const cv = mean !== 0 ? (stdDev / mean) * 100 : 0;

    let stability;
    if (cv < 0.5) stability = 'very stable';
    else if (cv < 1.5) stability = 'relatively stable';
    else if (cv < 3) stability = 'moderately volatile';
    else stability = 'highly volatile';

    let html = '<div class="hdf-section hdf-trend">';
    html += '<h2>30-Day ' + config.label + ' Price Trend — ' + locationName + '</h2>';

    html += '<div class="hdf-trend-stats">';
    html += '<div class="hdf-trend-stat"><span class="hdf-trend-label">30-Day Low</span><span class="hdf-trend-value">₹' + indianFormat(min) + '</span></div>';
    html += '<div class="hdf-trend-stat"><span class="hdf-trend-label">30-Day High</span><span class="hdf-trend-value">₹' + indianFormat(max) + '</span></div>';
    html += '<div class="hdf-trend-stat"><span class="hdf-trend-label">30-Day Average</span><span class="hdf-trend-value">₹' + indianFormat(avg) + '</span></div>';
    html += '<div class="hdf-trend-stat"><span class="hdf-trend-label">Net Change</span><span class="hdf-trend-value">' + changeBadge(totalChange) + '</span></div>';
    html += '</div>';

    html += '<p>Over the past 30 days, <strong>' + config.label.toLowerCase() + ' prices in ' + locationName + '</strong> have shown an <strong>' + direction + ' trend</strong>, ';
    html += 'moving from ₹' + indianFormat(first) + ' to ₹' + indianFormat(last) + ' (' + (totalChange >= 0 ? '+' : '') + pctChange + '%). ';
    html += 'The price range during this period was ₹' + indianFormat(min) + ' to ₹' + indianFormat(max) + ', ';
    html += 'with an average of ₹' + indianFormat(avg) + ' per gram. ';
    html += 'The market has been <strong>' + stability + '</strong> with a coefficient of variation of ' + cv.toFixed(2) + '%.</p>';

    html += '</div>';
    return html;
  }
}

module.exports = { MetalsPostCreator };
