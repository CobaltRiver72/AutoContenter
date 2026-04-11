'use strict';

const MODULE = 'metals-posts';
const crypto = require('crypto');
const {
  liveBadge, priceChangeBadge, statPills, sourceBadge,
  readAlsoBox, infoBox, styledTable, faqSection,
  articleSchema, breadcrumbs, priceHero
} = require('../utils/post-html');

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

  _buildCityContent(city, metalType, prices, allCities, stateUrl, nationalUrl) {
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' });
    const isoDate = today.toISOString();
    const metal = this.METAL_CONFIG[metalType];

    // Primary variant and price
    const primaryVariant = metalType === 'gold' ? '24K' : '1g';
    const primaryPrice = prices[primaryVariant];
    const priceDisplay = primaryPrice ? `₹${primaryPrice.toLocaleString('en-IN')}` : 'N/A';

    // Count unique states in city list
    const stateCount = [...new Set(allCities.map(c => c.state))].filter(Boolean).length;
    const cityCount = allCities.length;

    // Build variants table rows
    const variantKeys = metalType === 'gold' ? ['24K', '22K', '18K'] : ['1g'];
    const variantRows = variantKeys.map(v => {
      const p = prices[v];
      return [v, p ? `₹${p.toLocaleString('en-IN')}` : '—', p ? `₹${(p * 10).toLocaleString('en-IN')}` : '—'];
    });

    // Weight table rows
    const weights = [1, 5, 8, 10, 100];
    const weightRows = weights.map(g => {
      return [
        `${g}g`,
        ...variantKeys.map(v => prices[v] ? `₹${(prices[v] * g).toLocaleString('en-IN')}` : '—')
      ];
    });

    // State cities for nearby links
    const stateCities = allCities.filter(c => c.state === city.state_name && c.city_name !== city.city_name).slice(0, 5);

    const faqs = [
      {
        q: `What is the ${metal.label} price in ${city.city_name} today (${dateStr})?`,
        a: `The ${metal.label} (${primaryVariant}) price in ${city.city_name} today is <strong>${priceDisplay} per gram</strong>, sourced from IBJA (Indian Bullion and Jewellers Association).`
      },
      {
        q: `Is ${metal.label} price the same in all cities in ${city.state_name}?`,
        a: `${metal.label} prices can vary slightly between cities in ${city.state_name} depending on local taxes and dealer margins. The IBJA rate is a national benchmark, and local jewellers may charge slightly above or below this rate.`
      },
      {
        q: `Why does ${metal.label} price change daily?`,
        a: `${metal.label} prices fluctuate due to global commodity markets, USD/INR exchange rates, international demand, and macroeconomic factors. Indian prices are also influenced by import duties and GST.`
      },
      {
        q: `What is the difference between the purity grades of ${metal.label}?`,
        a: metalType === 'gold'
          ? `24K gold has the highest purity (99.9%), while 22K (91.7%) and 18K (75%) contain other metals for added durability. Higher karat means higher price.`
          : `${metal.label} purity is measured in fineness. Higher purity means more expensive metal.`
      },
      {
        q: `Where to buy ${metal.label} in ${city.city_name}?`,
        a: `You can buy ${metal.label} at certified jewellers, bank branches, post offices (India Post Gold), and reputed online platforms. Always check the BIS hallmark for purity certification.`
      }
    ];

    return `
${breadcrumbs([
  { name: 'Home', url: nationalUrl.replace(/\/[^/]+\/$/, '/') },
  { name: `${metal.label} Price`, url: nationalUrl },
  { name: city.state_name, url: stateUrl },
  { name: `${city.city_name} ${metal.label} Price Today` }
])}

${priceHero({
  title: `${metal.label} Price in ${city.city_name} Today (${dateStr})`,
  price: priceDisplay,
  unit: `per gram (${primaryVariant})`,
  change: null,
  direction: 'none',
  subtitle: `Updated daily · Sourced from IBJA · ${city.city_name}, ${city.state_name}`,
  pills: [
    { value: cityCount, label: 'cities tracked' },
    { value: stateCount, label: 'states covered' },
    { value: 'IBJA', label: 'source' }
  ]
})}

${articleSchema({
  headline: `${metal.label} Price in ${city.city_name} Today – ${dateStr}`,
  description: `Current ${metal.label} price in ${city.city_name} is ${priceDisplay} per gram (${primaryVariant}) on ${dateStr}. Compare all variants and weights.`,
  datePublished: isoDate,
  publisherName: 'HDF News'
})}

<article>

<section>
<p style="font-size:15px;line-height:1.8;color:#374151;">
The <strong>${metal.label} price in ${city.city_name}</strong> today is <strong>${priceDisplay} per gram</strong> for ${primaryVariant} ${metal.label}, as reported by the IBJA (Indian Bullion and Jewellers Association) on <time datetime="${today.toISOString().split('T')[0]}">${dateStr}</time>. Prices are updated every morning and reflect the national benchmark rate applicable across India, including ${city.city_name}.
</p>
${sourceBadge('IBJA — Indian Bullion and Jewellers Association')}
</section>

<section>
${styledTable(
  `${metal.label} Price by Variant in ${city.city_name} — ${dateStr}`,
  ['Variant', 'Per Gram', 'Per 10 Grams'],
  variantRows,
  ['40%', '30%', '30%']
)}
</section>

${readAlsoBox('Read Also', `${metal.label} Price in ${city.state_name} — All Cities`, stateUrl)}

<section>
${styledTable(
  `${metal.label} Price by Weight in ${city.city_name}`,
  ['Weight', ...variantKeys.map(v => `${v} (₹)`)],
  weightRows
)}
${infoBox(`Prices shown above are calculated using today's IBJA benchmark rate for ${city.city_name}. Actual purchase prices at jewellers may include GST (3%) and making charges.`)}
</section>

${stateCities.length > 0 ? `
<section>
<h2 style="font-size:20px;font-weight:700;color:#111827;margin-top:28px;">Nearby Cities in ${city.state_name}</h2>
<p style="font-size:14px;color:#6b7280;margin-bottom:12px;">Compare ${metal.label} prices in cities near ${city.city_name} in ${city.state_name}:</p>
<div style="display:flex;flex-wrap:wrap;gap:8px;">
${stateCities.map(c => `<a href="/${slugify(metalType + '-price-in-' + c.city_name + '-today')}/" style="background:#f3f4f6;border:1px solid #e5e7eb;border-radius:6px;padding:8px 14px;font-size:13px;color:#374151;text-decoration:none;font-weight:500;">${c.city_name}</a>`).join('')}
</div>
</section>
` : ''}

<section>
<h2 style="font-size:20px;font-weight:700;color:#111827;margin-top:28px;">Factors Affecting ${metal.label} Price in ${city.city_name}</h2>
<p style="font-size:14px;color:#374151;line-height:1.8;">Several factors influence the ${metal.label} price in ${city.city_name} and across India:</p>
<ul style="font-size:14px;color:#374151;line-height:2;padding-left:20px;">
  <li><strong>Global commodity prices</strong> — International ${metal.label} spot prices (USD/troy oz) directly impact Indian rates</li>
  <li><strong>USD/INR exchange rate</strong> — A weaker rupee makes imported ${metal.label} more expensive</li>
  <li><strong>Import duties &amp; GST</strong> — India levies import duty + 3% GST on ${metal.label} purchases</li>
  <li><strong>Demand seasonality</strong> — Festivals, weddings, and harvest seasons drive higher demand in India</li>
  <li><strong>Inflation &amp; interest rates</strong> — ${metal.label} is a safe-haven asset; demand rises during economic uncertainty</li>
</ul>
</section>

${faqSection(faqs)}

</article>
`.trim();
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

  _buildStateContent(stateName, metalType, citiesWithPrices, nationalUrl) {
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' });
    const metal = this.METAL_CONFIG[metalType];
    const primaryVariant = metalType === 'gold' ? '24K' : '1g';
    const stateUrl = '/' + slugify(metalType + '-price-in-' + stateName + '-today') + '/';

    const validCities = citiesWithPrices.filter(c => c.prices && c.prices[primaryVariant]);
    const avgPrice = validCities.length
      ? Math.round(validCities.reduce((s, c) => s + c.prices[primaryVariant], 0) / validCities.length)
      : null;
    const avgDisplay = avgPrice ? `₹${avgPrice.toLocaleString('en-IN')}` : 'N/A';
    const minCity = validCities.reduce((a, b) => (!a || b.prices[primaryVariant] < a.prices[primaryVariant]) ? b : a, null);
    const maxCity = validCities.reduce((a, b) => (!a || b.prices[primaryVariant] > a.prices[primaryVariant]) ? b : a, null);

    const tableRows = validCities.map(c => [
      c.city_name,
      `₹${c.prices[primaryVariant].toLocaleString('en-IN')}`,
      metalType === 'gold' && c.prices['22K'] ? `₹${c.prices['22K'].toLocaleString('en-IN')}` : '—'
    ]);

    const faqs = [
      {
        q: `What is the ${metal.label} price in ${stateName} today?`,
        a: `The average ${metal.label} (${primaryVariant}) price in ${stateName} today is <strong>${avgDisplay} per gram</strong> across ${validCities.length} cities, as of ${dateStr}.`
      },
      {
        q: `Which city has the cheapest ${metal.label} in ${stateName}?`,
        a: minCity ? `${minCity.city_name} has the lowest ${metal.label} price in ${stateName} today at ₹${minCity.prices[primaryVariant].toLocaleString('en-IN')} per gram.` : 'Price data is being updated.'
      },
      {
        q: `Is ${metal.label} price different across cities in ${stateName}?`,
        a: `${metal.label} prices across cities in ${stateName} are generally benchmarked to the IBJA national rate. Minor variations can occur due to local dealer margins and taxes.`
      }
    ];

    return `
${breadcrumbs([
  { name: 'Home', url: nationalUrl.replace(/\/[^/]+\/$/, '/') },
  { name: `${metal.label} Price`, url: nationalUrl },
  { name: `${stateName} ${metal.label} Price Today` }
])}

${priceHero({
  title: `${metal.label} Price in ${stateName} Today (${dateStr})`,
  price: avgDisplay,
  unit: `avg per gram · ${primaryVariant}`,
  change: null,
  direction: 'none',
  subtitle: `${validCities.length} cities tracked across ${stateName} · Source: IBJA`,
  pills: [
    { value: validCities.length, label: 'cities' },
    { value: minCity ? `₹${minCity.prices[primaryVariant].toLocaleString('en-IN')}` : '—', label: 'lowest' },
    { value: maxCity ? `₹${maxCity.prices[primaryVariant].toLocaleString('en-IN')}` : '—', label: 'highest' }
  ]
})}

${articleSchema({
  headline: `${metal.label} Price in ${stateName} Today – ${dateStr}`,
  description: `${metal.label} price in ${stateName} today averages ${avgDisplay} per gram. Check rates in all ${validCities.length} cities in ${stateName}.`,
  datePublished: today.toISOString(),
  publisherName: 'HDF News'
})}

<article>

<section>
<p style="font-size:15px;line-height:1.8;color:#374151;">
The average <strong>${metal.label} price in ${stateName}</strong> today is <strong>${avgDisplay} per gram</strong> for ${primaryVariant} ${metal.label} as on <time datetime="${today.toISOString().split('T')[0]}">${dateStr}</time>. We track ${metal.label} rates across <strong>${validCities.length} cities in ${stateName}</strong>, sourced from the IBJA (Indian Bullion and Jewellers Association).
</p>
${sourceBadge('IBJA — Indian Bullion and Jewellers Association')}
</section>

${readAlsoBox('See Also', `${metal.label} Price in India Today — National Average`, nationalUrl)}

<section>
${styledTable(
  `${metal.label} Price in All Cities of ${stateName} — ${dateStr}`,
  metalType === 'gold' ? ['City', `24K (per gram)`, `22K (per gram)`] : ['City', `Price (per gram)`, 'Purity'],
  tableRows,
  ['45%', '28%', '27%']
)}
</section>

${faqSection(faqs)}

</article>
`.trim();
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

  _buildNationalContent(metalType, allCitiesWithPrices) {
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const metal = this.METAL_CONFIG[metalType];
    const primaryVariant = metalType === 'gold' ? '24K' : '1g';
    const variantKeys = metalType === 'gold' ? ['24K', '22K', '18K'] : ['1g'];
    const valid = allCitiesWithPrices.filter(c => c.prices && c.prices[primaryVariant]);
    const avgPrice = valid.length
      ? Math.round(valid.reduce((s, c) => s + c.prices[primaryVariant], 0) / valid.length)
      : null;
    const avgDisplay = avgPrice ? `\u20b9${avgPrice.toLocaleString('en-IN')}` : 'N/A';
    const stateCount = [...new Set(valid.map(c => c.state_name))].filter(Boolean).length;
    const byState = {};
    valid.forEach(c => {
      if (!byState[c.state_name]) byState[c.state_name] = { prices: [], cities: 0 };
      byState[c.state_name].prices.push(c.prices[primaryVariant]);
      byState[c.state_name].cities++;
    });
    const stateRows = Object.entries(byState).sort((a, b) => a[0].localeCompare(b[0])).map(([state, data]) => {
      const avg = Math.round(data.prices.reduce((s, p) => s + p, 0) / data.prices.length);
      return [state, `\u20b9${avg.toLocaleString('en-IN')}`, data.cities.toString()];
    });
    const weights = [1, 5, 8, 10, 100];
    const weightRows = weights.map(g => [
      `${g}g`,
      ...variantKeys.map(v => {
        const sample = valid.find(c => c.prices[v]);
        return sample ? `\u20b9${(sample.prices[v] * g).toLocaleString('en-IN')}` : '\u2014';
      })
    ]);
    const faqs = [
      {
        q: `What is the ${metal.label} price in India today (${dateStr})?`,
        a: `The national average ${metal.label} price in India today is <strong>${avgDisplay} per gram</strong> for ${primaryVariant} ${metal.label}, as reported by IBJA on ${dateStr}.`
      },
      {
        q: `How is ${metal.label} price determined in India?`,
        a: `${metal.label} prices in India are primarily benchmarked by IBJA. The rate is influenced by international spot prices, USD/INR exchange rate, import duty, and GST.`
      },
      {
        q: `Is ${metal.label} price the same across all states in India?`,
        a: `The IBJA benchmark rate is uniform across India. However, retail prices can vary slightly due to state-level taxes, dealer margins, and transportation costs.`
      },
      {
        q: `What is GST on ${metal.label} in India?`,
        a: `${metal.label} attracts 3% GST in India on the purchase price. Making charges on jewellery also attract 5% GST separately.`
      },
      {
        q: `When is ${metal.label} price updated?`,
        a: `${metal.label} prices are updated every morning (typically by 9:00 AM IST) based on the IBJA daily rate announcement.`
      }
    ];
    return [
      priceHero({
        title: `${metal.label} Price in India Today (${dateStr})`,
        price: avgDisplay,
        unit: `avg per gram \u00b7 ${primaryVariant}`,
        change: null,
        direction: 'none',
        subtitle: `Updated daily \u00b7 Sourced from IBJA \u00b7 ${valid.length} cities \u00b7 ${stateCount} states tracked`,
        pills: [
          { value: valid.length, label: 'cities tracked' },
          { value: stateCount, label: 'states covered' },
          { value: 'Daily 9AM', label: 'update time' }
        ]
      }),
      articleSchema({
        headline: `${metal.label} Price in India Today \u2013 ${dateStr}`,
        description: `National average ${metal.label} price today is ${avgDisplay} per gram. Check rates across ${valid.length} cities in ${stateCount} states. Source: IBJA.`,
        datePublished: today.toISOString(),
        publisherName: 'HDF News'
      }),
      '<article>',
      '<section>',
      `<p style="font-size:15px;line-height:1.8;color:#374151;">The national average <strong>${metal.label} price in India</strong> today is <strong>${avgDisplay} per gram</strong> for ${primaryVariant} ${metal.label}. We track rates across <strong>${valid.length} cities in ${stateCount} states</strong>, sourced from the IBJA.</p>`,
      sourceBadge('IBJA \u2014 Indian Bullion and Jewellers Association'),
      '</section>',
      '<section>',
      styledTable(
        `${metal.label} Price by Variant \u2014 ${dateStr}`,
        ['Variant', 'Per Gram', 'Per 10 Grams'],
        variantKeys.map(v => {
          const sample = valid.find(c => c.prices[v]);
          const p = sample ? sample.prices[v] : null;
          return [v, p ? `\u20b9${p.toLocaleString('en-IN')}` : '\u2014', p ? `\u20b9${(p * 10).toLocaleString('en-IN')}` : '\u2014'];
        }),
        ['40%', '30%', '30%']
      ),
      '</section>',
      '<section>',
      styledTable(
        `${metal.label} Price by Weight in India`,
        ['Weight', ...variantKeys.map(v => `${v} (\u20b9)`)],
        weightRows
      ),
      infoBox('Prices shown are based on IBJA benchmark rates. Add 3% GST for actual purchase price. Making charges are additional.'),
      '</section>',
      '<section>',
      styledTable(
        `${metal.label} Price by State \u2014 ${dateStr}`,
        [`State`, `Avg Price (${primaryVariant}/g)`, 'Cities Tracked'],
        stateRows,
        ['50%', '25%', '25%']
      ),
      '</section>',
      faqSection(faqs),
      '</article>'
    ].join('\n');
  }
}

module.exports = { MetalsPostCreator };
