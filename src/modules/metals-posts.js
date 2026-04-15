'use strict';

const MODULE = 'metals-posts';
const crypto = require('crypto');
const _cfg = require('../utils/config');

// Read admin-configured post status — respect Settings → WP_POST_STATUS.
function _wpPostStatus() {
  var v = (_cfg.get('WP_POST_STATUS') || '').toLowerCase().trim();
  var allowed = ['publish', 'draft', 'pending', 'private'];
  return allowed.indexOf(v) !== -1 ? v : 'publish';
}

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
    this.METAL_CONFIG = METAL_CONFIG;
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
        INSERT INTO metals_log (message, created_at)
        VALUES (?, datetime('now'))
      `).run(JSON.stringify({ metalType, action: 'post_generation', created, updated, cities: cities.length, states: states.length }));
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
    const title = config.label + ' Price in ' + city + ' Today (' + fmtDate(today) + ') — Per Gram';
    const slug = slugify(metalType + '-price-in-' + city + '-today');
    const metaDescription = (config.label + ' price in ' + city + ' today is ₹' + indianFormat(primaryPrice) + ' per gram, ' + changeText(delta) + '. Check ' + config.titleSuffix + ' rates.').substring(0, 160);

    // Build prices object for _buildCityContent
    const prices = {
      '24K': todayRow.price_24k || null,
      '22K': todayRow.price_22k || null,
      '18K': todayRow.price_18k || null,
      '1g': todayRow.price_1g || null,
    };

    // Get all cities for stats
    const allCities = this.db.prepare(
      'SELECT mc.city_name, mc.state FROM metals_cities mc WHERE mc.is_active = 1'
    ).all();

    const stateSlug = slugify(metalType + '-price-in-' + state + '-today');
    const nationalSlug = slugify(metalType + '-price-in-india-today');
    const stateUrl = '/' + stateSlug + '/';
    const nationalUrl = '/' + nationalSlug + '/';

    const cityObj = { city_name: city, state_name: state };
    const html = this._buildCityContent(cityObj, metalType, prices, allCities, stateUrl, nationalUrl);

    // Publish
    const result = await this.wp.upsertPost({
      slug,
      title,
      content: html,
      categoryNames: [config.label],
      metaDescription,
      status: _wpPostStatus(),
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

  _buildFaq(cityOrState, metalName, price, dateStr, variant) {
    const faqs = [
      { q: 'What is ' + metalName + ' price in ' + cityOrState + ' today?',
        a: 'The ' + metalName + ' (' + variant + ') price in ' + cityOrState + ' today is <strong>' + price + ' per gram</strong> as on ' + dateStr + ', sourced from IBJA.' },
      { q: 'Why does ' + metalName + ' price change daily?',
        a: metalName + ' prices change due to international commodity markets, USD/INR forex rates, import duties, and macroeconomic factors like inflation and central bank policies.' },
      { q: 'What is GST on ' + metalName + ' in India?',
        a: metalName + ' attracts 3% GST in India. Making charges on jewellery attract 5% GST separately.' },
      { q: 'Where can I check the latest ' + metalName + ' rate in ' + cityOrState + '?',
        a: 'You can check the latest ' + metalName + ' rate in ' + cityOrState + ' on this page \u2014 prices are updated daily from the IBJA benchmark rate.' },
    ];
    const items = faqs.map(f =>
      '<div class="hdf-faq-item" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question">' +
      '<h3 itemprop="name">' + f.q + '</h3>' +
      '<div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer">' +
      '<p itemprop="text">' + f.a + '</p></div></div>'
    ).join('\n');
    const jsonld = JSON.stringify({
      '@context': 'https://schema.org', '@type': 'FAQPage',
      'mainEntity': faqs.map(f => ({
        '@type': 'Question', 'name': f.q,
        'acceptedAnswer': { '@type': 'Answer', 'text': f.a }
      }))
    });
    return '<section class="hdf-faq" itemscope itemtype="https://schema.org/FAQPage">\n' +
      '<h2>Frequently Asked Questions</h2>\n' + items + '\n</section>\n' +
      '<script type="application/ld+json">' + jsonld + '</script>';
  }

  _buildCityContent(city, metalType, prices, allCities, stateUrl, nationalUrl) {
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const isoDate = today.toISOString().split('T')[0];
    const metal = this.METAL_CONFIG[metalType];
    const metalLabel = metal.label;
    const primaryVariant = metalType === 'gold' ? '24K' : '1g';
    const primaryPrice = prices[primaryVariant];
    const priceDisplay = primaryPrice ? '\u20b9' + primaryPrice.toLocaleString('en-IN') : 'N/A';
    const cityCount = allCities.length;
    const stateCount = [...new Set(allCities.map(c => c.state))].filter(Boolean).length;

    const displayVariants = (metal.variants && metal.variants.length > 0) ? [...metal.variants, '1g'] : ['1g'];
    const variantRows = displayVariants.map(function(v) {
      const p = prices[v];
      const per10 = p ? '\u20b9' + (p * 10).toLocaleString('en-IN') : '\u2014';
      return '<tr><td>' + v + ' ' + metalLabel + '</td><td>' + (p ? '\u20b9' + p.toLocaleString('en-IN') : '\u2014') + '</td><td>' + per10 + '</td></tr>';
    }).join('');

    const nearbyCities = allCities.filter(function(c) { return c.state === city.state_name && c.city_name !== city.city_name; }).slice(0, 8);
    const nearbyRows = nearbyCities.map(function(c) {
      const p = prices[primaryVariant];
      return '<tr><td>' + c.city_name + '</td><td>' + (p ? '\u20b9' + p.toLocaleString('en-IN') : '\u2014') + '</td></tr>';
    }).join('');

    const faqs = [
      { q: 'What is ' + metalLabel + ' price in ' + city.city_name + ' today?', a: 'The ' + metalLabel + ' (' + primaryVariant + ') price in ' + city.city_name + ' today is ' + priceDisplay + ' per gram as on ' + dateStr + ', sourced from IBJA.' },
      { q: 'Is ' + metalLabel + ' price the same across all cities in ' + city.state_name + '?', a: 'The IBJA benchmark rate is uniform nationally. Minor variations can occur at local jewellers due to dealer margins and local body taxes.' },
      { q: 'Why does ' + metalLabel + ' price change daily?', a: metalLabel + ' prices change due to international commodity markets, USD/INR exchange rates, import duties, and RBI monetary policy decisions.' },
      { q: 'What is GST on ' + metalLabel + ' in India?', a: metalLabel + ' attracts 3% GST in India on the purchase price. Making charges on jewellery attract an additional 5% GST.' },
      { q: 'Where to buy ' + metalLabel + ' in ' + city.city_name + '?', a: 'Buy ' + metalLabel + ' at BIS-hallmarked jewellers, bank branches, India Post Gold, or reputed platforms like Tanishq, Malabar Gold, or Joyalukkas. Always check for BIS 916/999 hallmark.' }
    ];
    const faqItems = faqs.map(function(f) {
      return '<div class="hdf-faq-item" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question"><h3 itemprop="name">' + f.q + '</h3><div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer"><p itemprop="text">' + f.a + '</p></div></div>';
    }).join('\n');
    const articleJsonLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'NewsArticle', 'headline': metalLabel + ' Price in ' + city.city_name + ' Today \u2014 ' + dateStr, 'description': metalLabel + ' price in ' + city.city_name + ' today is ' + priceDisplay + ' per gram (' + primaryVariant + ') on ' + dateStr + '. Source: IBJA.', 'datePublished': today.toISOString(), 'dateModified': today.toISOString(), 'author': { '@type': 'Organization', 'name': 'HDF News' }, 'publisher': { '@type': 'Organization', 'name': 'HDF News' } });
    const faqJsonLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', 'mainEntity': faqs.map(function(f) { return { '@type': 'Question', 'name': f.q, 'acceptedAnswer': { '@type': 'Answer', 'text': f.a } }; }) });

    // Weight table (static)
    const weightRows = (metal.weightRows || [1, 2, 4, 8, 10, 20, 50, 100]).map(function(w) {
      const cols = displayVariants.map(function(v) {
        const p = prices[v];
        return '<td>' + (p ? '\u20b9' + (p * w).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 }) : '\u2014') + '</td>';
      }).join('');
      return '<tr><td>' + w + 'g</td>' + cols + '</tr>';
    }).join('');
    const weightHeaders = ['<th>Weight</th>'].concat(displayVariants.map(function(v) { return '<th style="text-align:center">' + v + '</th>'; })).join('');

    return [
      '<script type="application/ld+json">' + articleJsonLd + '</script>',
      '<script type="application/ld+json">' + faqJsonLd + '</script>',
      '',
      '<div data-hdf="price-box" data-module="metals" data-city="' + city.city_name + '" data-metal="' + metalType + '">',
      '  <p><strong>' + metalLabel + ' price in ' + city.city_name + ' today</strong> is <strong>' + priceDisplay + ' per gram</strong> (' + primaryVariant + ') as on ' + dateStr + '. Source: IBJA.</p>',
      '</div>',
      '',
      '<article>',
      '',
      '<p>The <strong>' + metalLabel + ' price in ' + city.city_name + '</strong> today is <strong>' + priceDisplay + ' per gram</strong> for ' + primaryVariant + ' ' + metalLabel + ' as on <time datetime="' + isoDate + '">' + dateStr + '</time>, sourced from IBJA (Indian Bullion and Jewellers Association). We track ' + metalLabel + ' prices daily across <strong>' + cityCount + ' cities in ' + stateCount + ' states</strong>.</p>',
      '',
      '<span class="hdf-source">\ud83d\udcca Source: IBJA \u2014 Indian Bullion and Jewellers Association</span>',
      '',
      '<h2>' + metalLabel + ' Price by Variant in ' + city.city_name + ' \u2014 ' + dateStr + '</h2>',
      '',
      '<div data-hdf="price-table" data-module="metals" data-state="' + city.state_name + '" data-metal="' + metalType + '">',
      '  <div class="hdf-table-wrap"><table class="hdf-table"><caption>' + metalLabel + ' variants in ' + city.city_name + ' today</caption>',
      '  <thead><tr><th>Variant</th><th>Per Gram</th><th>Per 10 Grams</th></tr></thead>',
      '  <tbody>' + variantRows + '</tbody></table></div>',
      '</div>',
      '',
      '<h2>' + metalLabel + ' Price by Weight in ' + city.city_name + ' \u2014 ' + dateStr + '</h2>',
      '<div class="hdf-table-wrap"><table class="hdf-table">',
      '<caption>' + metalLabel + ' price for different weights — ' + dateStr + '</caption>',
      '<thead><tr>' + weightHeaders + '</tr></thead>',
      '<tbody>' + weightRows + '</tbody>',
      '</table></div>',
      '',
      '<h2>' + metalLabel + ' Price History in ' + city.city_name + ' \u2014 Last 30 Days</h2>',
      '<div data-hdf="price-history" data-module="metals" data-city="' + city.city_name + '" data-metal="' + metalType + '" data-days="30">',
      '  <p>' + metalLabel + ' price in ' + city.city_name + ' today: ' + priceDisplay + ' per gram. Full 30-day history loads dynamically.</p>',
      '</div>',
      '',
      '<h2>' + metalLabel + ' Price Trend Chart \u2014 ' + city.city_name + '</h2>',
      '<div data-hdf="price-chart" data-module="metals" data-city="' + city.city_name + '" data-metal="' + metalType + '" data-days="30">',
      '  <div class="hdf-chart-wrap"><p style="font-size:13px;color:#6b7280">Chart loading\u2026</p></div>',
      '</div>',
      '',
      '<h2>Compare Precious Metals in ' + city.city_name + ' Today</h2>',
      '<div data-hdf="cross-metal" data-city="' + city.city_name + '">',
      '  <p>Live gold, silver, and platinum prices in ' + city.city_name + ' load dynamically.</p>',
      '</div>',
      '',
      '<div class="hdf-callout">',
      '  <div class="hdf-callout-label">Read Also</div>',
      '  <a href="' + stateUrl + '">' + metalLabel + ' Price in ' + city.state_name + ' Today \u2014 All Cities (' + dateStr + ')</a>',
      '</div>',
      '',
      '<h2>' + metalLabel + ' Price in Cities Near ' + city.city_name + ' \u2014 ' + city.state_name + '</h2>',
      '',
      '<div data-hdf="price-table" data-module="metals" data-state="' + city.state_name + '" data-metal="' + metalType + '">',
      '  <div class="hdf-table-wrap"><table class="hdf-table"><caption>' + metalLabel + ' price in ' + city.state_name + ' cities</caption>',
      '  <thead><tr><th>City</th><th>' + primaryVariant + ' (per gram)</th></tr></thead>',
      '  <tbody>' + nearbyRows + '</tbody></table></div>',
      '</div>',
      '',
      '<h2>More Cities in ' + city.state_name + '</h2>',
      '<div data-hdf="city-pills" data-module="metals" data-state="' + city.state_name + '" data-prefix="' + metalType + '-price-in">',
      '  <div class="hdf-city-pills">' + nearbyCities.map(function(c) { return '<a href="/' + metalType + '-price-in-' + c.city_name.toLowerCase().replace(/[^a-z0-9]+/g, '-') + '-today/">' + c.city_name + '</a>'; }).join('') + '</div>',
      '</div>',
      '',
      '<div class="hdf-info">\ud83d\udca1 Prices shown are IBJA benchmark rates. Actual purchase price at jewellers includes 3% GST and making charges. Always verify before purchase.</div>',
      '',
      '<h2>Factors Affecting ' + metalLabel + ' Price in ' + city.city_name + '</h2>',
      '<p>The <strong>' + metalLabel + ' price in ' + city.city_name + '</strong> is influenced by the same national factors that drive rates across India \u2014 international commodity spot prices (USD/troy oz), the USD/INR exchange rate, import duty (currently 15%), and 3% GST. Local jeweller margins and seasonal demand during festivals and weddings can add minor premiums above the IBJA benchmark.</p>',
      '',
      '<section class="hdf-faq" itemscope itemtype="https://schema.org/FAQPage">',
      '<h2>Frequently Asked Questions</h2>',
      faqItems,
      '</section>',
      '',
      '</article>'
    ].join('\n').trim();
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

    const title = config.label + ' Price in ' + state + ' Today (' + fmtDate(today) + ') — All Cities';
    const slug = slugify(metalType + '-price-in-' + state + '-today');
    const metaDescription = (config.label + ' price in ' + state + ' today averages ₹' + indianFormat(avgPrice) + '/g. Check ' + config.titleSuffix + ' across all cities.').substring(0, 160);

    const nationalSlug = slugify(metalType + '-price-in-india-today');
    const nationalUrl = '/' + nationalSlug + '/';
    const citiesWithPrices = stateCities.map(c => ({
      city_name: c.city_name,
      state_name: state,
      prices: {
        '24K': c.price_24k || null,
        '22K': c.price_22k || null,
        '18K': c.price_18k || null,
        '1g': c.price_1g || null,
      }
    }));
    const html = this._buildStateContent(state, metalType, citiesWithPrices, nationalUrl);

    // Publish
    const result = await this.wp.upsertPost({
      slug,
      title,
      content: html,
      categoryNames: [config.label],
      metaDescription,
      status: _wpPostStatus(),
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

  _buildStateContent(stateName, metalType, citiesWithPrices, nationalUrl) {
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const metal = this.METAL_CONFIG[metalType];
    const metalLabel = metal.label;
    const primaryVariant = metalType === 'gold' ? '24K' : '1g';
    const stateUrl = '/' + slugify(metalType + '-price-in-' + stateName + '-today') + '/';
    const validCities = citiesWithPrices.filter(c => c.prices && c.prices[primaryVariant]);
    const avgPrice = validCities.length
      ? Math.round(validCities.reduce((s, c) => s + c.prices[primaryVariant], 0) / validCities.length)
      : null;
    const avgDisplay = avgPrice ? '\u20b9' + avgPrice.toLocaleString('en-IN') : 'N/A';

    const cityRows = validCities.sort(function(a, b) { return a.city_name.localeCompare(b.city_name); }).map(function(c) {
      const p = c.prices[primaryVariant];
      return '<tr><td>' + c.city_name + '</td><td>\u20b9' + p.toLocaleString('en-IN') + '</td></tr>';
    }).join('');

    const stateFaqs = [
      { q: 'What is ' + metalLabel + ' price in ' + stateName + ' today?', a: 'The average ' + metalLabel + ' (' + primaryVariant + ') price in ' + stateName + ' today is ' + avgDisplay + ' per gram as on ' + dateStr + ', tracked across ' + validCities.length + ' cities.' },
      { q: 'Which city has the cheapest ' + metalLabel + ' in ' + stateName + '?', a: metalLabel + ' prices across ' + stateName + ' are benchmarked to the IBJA national rate. Minor differences between cities occur due to local dealer margins.' },
      { q: 'Is ' + metalLabel + ' price in ' + stateName + ' different from other states?', a: 'The IBJA rate is uniform nationally. State-level differences arise only from local body taxes or dealer premiums, typically within \u20b950\u2013\u20b9100 per gram.' }
    ];
    const stateFaqItems = stateFaqs.map(function(f) {
      return '<div class="hdf-faq-item" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question"><h3 itemprop="name">' + f.q + '</h3><div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer"><p itemprop="text">' + f.a + '</p></div></div>';
    }).join('\n');
    const stateArticleJsonLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'NewsArticle', 'headline': metalLabel + ' Price in ' + stateName + ' Today \u2014 ' + dateStr, 'description': metalLabel + ' price in ' + stateName + ' today averages ' + avgDisplay + ' per gram. Check rates in all ' + validCities.length + ' cities in ' + stateName + '.', 'datePublished': today.toISOString(), 'dateModified': today.toISOString(), 'author': { '@type': 'Organization', 'name': 'HDF News' }, 'publisher': { '@type': 'Organization', 'name': 'HDF News' } });
    const stateFaqJsonLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', 'mainEntity': stateFaqs.map(function(f) { return { '@type': 'Question', 'name': f.q, 'acceptedAnswer': { '@type': 'Answer', 'text': f.a } }; }) });

    return [
      '<script type="application/ld+json">' + stateArticleJsonLd + '</script>',
      '<script type="application/ld+json">' + stateFaqJsonLd + '</script>',
      '',
      '<div data-hdf="national" data-module="metals" data-metal="' + metalType + '">',
      '  <p>Average <strong>' + metalLabel + ' price in ' + stateName + '</strong> today is <strong>' + avgDisplay + ' per gram</strong> (' + primaryVariant + ') as on ' + dateStr + '. Source: IBJA.</p>',
      '</div>',
      '',
      '<article>',
      '',
      '<p>The average <strong>' + metalLabel + ' price in ' + stateName + '</strong> today is <strong>' + avgDisplay + ' per gram</strong> for ' + primaryVariant + ' ' + metalLabel + ' as on <time datetime="' + today.toISOString().split('T')[0] + '">' + dateStr + '</time>. We track ' + metalLabel + ' rates across <strong>' + validCities.length + ' cities in ' + stateName + '</strong>, sourced from IBJA.</p>',
      '',
      '<span class="hdf-source">\ud83d\udcca Source: IBJA \u2014 Indian Bullion and Jewellers Association</span>',
      '',
      '<div class="hdf-callout">',
      '  <div class="hdf-callout-label">See Also</div>',
      '  <a href="' + nationalUrl + '">' + metalLabel + ' Price in India Today \u2014 National Average (' + dateStr + ')</a>',
      '</div>',
      '',
      '<h2>' + metalLabel + ' Price in All Cities of ' + stateName + ' \u2014 ' + dateStr + '</h2>',
      '',
      '<div data-hdf="price-table" data-module="metals" data-state="' + stateName + '" data-metal="' + metalType + '">',
      '  <div class="hdf-table-wrap"><table class="hdf-table"><caption>' + metalLabel + ' price in ' + stateName + ' \u2014 all cities</caption>',
      '  <thead><tr><th>City</th><th>' + primaryVariant + ' (per gram)</th></tr></thead>',
      '  <tbody>' + cityRows + '</tbody></table></div>',
      '</div>',
      '',
      '<section class="hdf-faq" itemscope itemtype="https://schema.org/FAQPage">',
      '<h2>Frequently Asked Questions</h2>',
      stateFaqItems,
      '</section>',
      '',
      '</article>'
    ].join('\n').trim();
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

    const title = config.label + ' Price in India Today (' + fmtDate(today) + ') — All States';
    const slug = slugify(metalType + '-price-in-india-today');
    const metaDescription = (config.label + ' price in India today is ₹' + indianFormat(nationalAvg) + '/g avg, ' + changeText(delta) + '. Check ' + config.titleSuffix + ' in all cities.').substring(0, 160);

    const allCitiesWithPrices = allCities.map(c => ({
      city_name: c.city_name,
      state_name: c.state,
      prices: {
        '24K': c.price_24k || null,
        '22K': c.price_22k || null,
        '18K': c.price_18k || null,
        '1g': c.price_1g || null,
      }
    }));
    const html = this._buildNationalContent(metalType, allCitiesWithPrices);

    // Publish
    const result = await this.wp.upsertPost({
      slug,
      title,
      content: html,
      categoryNames: [config.label],
      metaDescription,
      status: _wpPostStatus(),
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

  _buildNationalContent(metalType, allCitiesWithPrices) {
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const metal = this.METAL_CONFIG[metalType];
    const metalLabel = metal.label;
    const primaryVariant = metalType === 'gold' ? '24K' : '1g';
    const valid = allCitiesWithPrices.filter(c => c.prices && c.prices[primaryVariant]);
    const avgPrice = valid.length
      ? Math.round(valid.reduce((s, c) => s + c.prices[primaryVariant], 0) / valid.length)
      : null;
    const avgDisplay = avgPrice ? '\u20b9' + avgPrice.toLocaleString('en-IN') : 'N/A';
    const stateCount = [...new Set(valid.map(c => c.state_name))].filter(Boolean).length;

    const byState = {};
    valid.forEach(function(c) {
      if (!byState[c.state_name]) byState[c.state_name] = [];
      byState[c.state_name].push(c.prices[primaryVariant]);
    });
    const stateRows = Object.entries(byState).sort(function(a, b) { return a[0].localeCompare(b[0]); }).map(function(entry) {
      const avg = Math.round(entry[1].reduce(function(s, p) { return s + p; }, 0) / entry[1].length);
      return '<tr><td>' + entry[0] + '</td><td>\u20b9' + avg.toLocaleString('en-IN') + '</td><td>' + entry[1].length + '</td></tr>';
    }).join('');

    const natFaqs = [
      { q: 'What is ' + metalLabel + ' price in India today (' + dateStr + ')?', a: 'The national average ' + metalLabel + ' (' + primaryVariant + ') price in India today is ' + avgDisplay + ' per gram as on ' + dateStr + ', sourced from IBJA.' },
      { q: 'How is ' + metalLabel + ' price set in India?', a: metalLabel + ' prices in India are benchmarked by IBJA based on international spot prices, USD/INR exchange rate, import duty, and GST.' },
      { q: 'What is the best time to buy ' + metalLabel + ' in India?', a: metalLabel + ' prices tend to be lower in non-festive periods (February\u2013March, July\u2013August). However, ' + metalLabel + ' is primarily a long-term store of value \u2014 timing short-term fluctuations is difficult.' },
      { q: 'What is GST on ' + metalLabel + ' in India?', a: metalLabel + ' attracts 3% GST in India. Making charges attract an additional 5% GST. Import duty is currently 15%.' },
      { q: 'How often is ' + metalLabel + ' price updated in India?', a: 'IBJA updates ' + metalLabel + ' rates every morning. International spot prices change continuously \u2014 Indian rates reflect the morning fix based on overnight global markets.' }
    ];
    const natFaqItems = natFaqs.map(function(f) {
      return '<div class="hdf-faq-item" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question"><h3 itemprop="name">' + f.q + '</h3><div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer"><p itemprop="text">' + f.a + '</p></div></div>';
    }).join('\n');
    const natArticleJsonLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'NewsArticle', 'headline': metalLabel + ' Price in India Today \u2014 ' + dateStr, 'description': 'National average ' + metalLabel + ' price in India today is ' + avgDisplay + ' per gram. Check state-wise rates across ' + valid.length + ' cities and ' + stateCount + ' states.', 'datePublished': today.toISOString(), 'dateModified': today.toISOString(), 'author': { '@type': 'Organization', 'name': 'HDF News' }, 'publisher': { '@type': 'Organization', 'name': 'HDF News' } });
    const natFaqJsonLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', 'mainEntity': natFaqs.map(function(f) { return { '@type': 'Question', 'name': f.q, 'acceptedAnswer': { '@type': 'Answer', 'text': f.a } }; }) });

    return [
      '<script type="application/ld+json">' + natArticleJsonLd + '</script>',
      '<script type="application/ld+json">' + natFaqJsonLd + '</script>',
      '',
      '<div data-hdf="national" data-module="metals" data-metal="' + metalType + '">',
      '  <p>National average <strong>' + metalLabel + ' price in India</strong> today is <strong>' + avgDisplay + ' per gram</strong> (' + primaryVariant + ') as on ' + dateStr + '. Source: IBJA.</p>',
      '</div>',
      '',
      '<article>',
      '',
      '<p>The national average <strong>' + metalLabel + ' price in India</strong> today is <strong>' + avgDisplay + ' per gram</strong> for ' + primaryVariant + ' ' + metalLabel + ' as on <time datetime="' + today.toISOString().split('T')[0] + '">' + dateStr + '</time>. We track ' + metalLabel + ' rates across <strong>' + valid.length + ' cities in ' + stateCount + ' states</strong>, sourced from IBJA (Indian Bullion and Jewellers Association).</p>',
      '',
      '<span class="hdf-source">\ud83d\udcca Source: IBJA \u2014 Indian Bullion and Jewellers Association</span>',
      '',
      '<h2>' + metalLabel + ' Price by State in India \u2014 ' + dateStr + '</h2>',
      '',
      '<div data-hdf="ranking" data-module="metals" data-metal="' + metalType + '" data-sort="asc" data-limit="30" data-label="State-wise ' + metalLabel + ' Price in India Today">',
      '  <div class="hdf-table-wrap"><table class="hdf-table"><caption>' + metalLabel + ' price across Indian states</caption>',
      '  <thead><tr><th>State</th><th>Avg Price (per gram)</th><th>Cities Tracked</th></tr></thead>',
      '  <tbody>' + stateRows + '</tbody></table></div>',
      '</div>',
      '',
      '<h2>Top 10 Cities with Cheapest ' + metalLabel + ' in India Today</h2>',
      '',
      '<div data-hdf="ranking" data-module="metals" data-metal="' + metalType + '" data-sort="asc" data-limit="10" data-label="Cheapest ' + metalLabel + ' Cities in India \u2014 ' + dateStr + '">',
      '  <p>Loading cheapest ' + metalLabel + ' cities...</p>',
      '</div>',
      '',
      '<div class="hdf-info">\ud83d\udca1 ' + metalLabel + ' prices shown are IBJA benchmark rates. Actual purchase price includes 3% GST and making charges. Rates are updated every morning.</div>',
      '',
      '<section class="hdf-faq" itemscope itemtype="https://schema.org/FAQPage">',
      '<h2>Frequently Asked Questions</h2>',
      natFaqItems,
      '</section>',
      '',
      '</article>'
    ].join('\n').trim();
  }
}

module.exports = { MetalsPostCreator };
