'use strict';

const MODULE = 'fuel-posts';
const crypto = require('crypto');
const {
  liveBadge, priceChangeBadge, statPills, sourceBadge,
  readAlsoBox, infoBox, styledTable, faqSection,
  articleSchema, breadcrumbs, priceHero
} = require('../utils/post-html');

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
  // wp_posts_log helper
  // =========================================================================

  _logPost(postType, itemType, itemName, result, contentHash) {
    try {
      this.db.prepare(`
        INSERT INTO wp_posts_log (module, post_type, item_type, item_name, wp_post_id, wp_slug, wp_url, wp_status, action, content_hash)
        VALUES ('fuel', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(module, item_type, post_type, item_name) DO UPDATE SET
          wp_post_id = excluded.wp_post_id, wp_url = excluded.wp_url,
          wp_status = excluded.wp_status, action = excluded.action,
          content_hash = excluded.content_hash, created_at = datetime('now')
      `).run(postType, itemType, itemName, result.id || null, result.slug || null,
        result.url || null, result.status || 'publish', result.action || 'updated', contentHash || null);
    } catch (e) {
      this.logger.warn(MODULE, 'wp_posts_log insert failed: ' + e.message);
    }
  }

  _logPostFailed(postType, itemType, itemName, errorMsg) {
    try {
      this.db.prepare(`
        INSERT INTO wp_posts_log (module, post_type, item_type, item_name, action, error_message)
        VALUES ('fuel', ?, ?, ?, 'failed', ?)
        ON CONFLICT(module, item_type, post_type, item_name) DO UPDATE SET
          action = 'failed', error_message = excluded.error_message, created_at = datetime('now')
      `).run(postType, itemType, itemName, errorMsg);
    } catch (e) { /* silent */ }
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
    const title = 'Petrol & Diesel Price in ' + city + ' Today (' + dateStr + ') — Per Litre';
    let metaDescription = fuelLabel + ' price in ' + city + ' today is ₹' + fmtPrice(price) + '/litre (' + dateStr + '). Compare with other ' + state + ' cities, view 30-day chart, and check daily rate history.';
    if (metaDescription.length > 160) {
      metaDescription = metaDescription.substring(0, 157) + '...';
    }

    // Build alt fuel slug for cross-link
    const altSlug = slugify(altFuel + '-price-in-' + city + '-today');

    // -----------------------------------------------------------------------
    // Build HTML content
    // -----------------------------------------------------------------------

    const prices = {
      petrol: row.petrol || null,
      diesel: row.diesel || null,
      cng: null,  // extend later if CNG data available
      lpg: null,
    };
    const cityObj = { city_name: city, state_name: state };
    const stateSlug = slugify(fuelType + '-price-in-' + state + '-today');
    const nationalSlug = slugify(fuelType + '-price-in-india-today');
    const stateUrl = '/' + stateSlug + '/';
    const nationalUrl = '/' + nationalSlug + '/';
    const html = this._buildCityContent(cityObj, prices, stateInfo, stateUrl, nationalUrl);

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

    const contentHash = crypto.createHash('md5').update(html).digest('hex');
    this._logPost('city', fuelType, city, result, contentHash);
    return result.action;
  }

  // =========================================================================
  // _buildCityContent
  // =========================================================================

  _buildCityContent(city, prices, stateInfo, stateUrl, nationalUrl) {
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const petrol = prices.petrol ? '\u20b9' + prices.petrol.toFixed(2) : 'N/A';
    const diesel = prices.diesel ? '\u20b9' + prices.diesel.toFixed(2) : 'N/A';
    const cng = prices.cng ? '\u20b9' + prices.cng.toFixed(2) : null;
    const fuelRows = [
      ['Petrol', petrol, stateInfo ? (stateInfo.vat || '\u2014') : '\u2014'],
      ['Diesel', diesel, stateInfo ? (stateInfo.vat || '\u2014') : '\u2014'],
      ...(cng ? [['CNG', cng, '\u2014']] : []),
    ];
    const litreRows = [1, 5, 10, 15, 20, 50].map(l => [
      l + 'L',
      prices.petrol ? '\u20b9' + (prices.petrol * l).toFixed(2) : '\u2014',
      prices.diesel ? '\u20b9' + (prices.diesel * l).toFixed(2) : '\u2014'
    ]);
    const faqs = [
      {
        q: 'What is the petrol price in ' + city.city_name + ' today (' + dateStr + ')?',
        a: 'The petrol price in ' + city.city_name + ' today is <strong>' + petrol + ' per litre</strong> as on ' + dateStr + '.'
      },
      {
        q: 'What is the diesel price in ' + city.city_name + ' today?',
        a: 'The diesel price in ' + city.city_name + ' today is <strong>' + diesel + ' per litre</strong> as on ' + dateStr + '.'
      },
      {
        q: 'Why is petrol price different in ' + city.city_name + ' vs other cities?',
        a: 'Fuel prices in ' + city.city_name + ' are determined by the base price set by OMCs plus state VAT (' + (stateInfo ? stateInfo.vat : 'varies') + '), local body taxes, freight charges, and dealer commission.'
      },
      {
        q: 'When do fuel prices change in ' + city.city_name + '?',
        a: 'Petrol and diesel prices in ' + city.city_name + ' are revised at 6:00 AM every day by Indian Oil, HPCL, and BPCL based on international crude oil prices and forex rates.'
      },
      {
        q: 'How to check today\'s fuel price in ' + city.city_name + '?',
        a: 'You can check today\'s fuel price in ' + city.city_name + ' on HDF News (updated daily), or SMS "RSP" to 9224992249 (HPCL), or use the Indian Oil One app.'
      }
    ];
    const parts = [
      breadcrumbs([
        { name: 'Home', url: nationalUrl.replace(/\/[^/]+\/$/, '/') },
        { name: 'Fuel Prices', url: nationalUrl },
        { name: city.state_name, url: stateUrl },
        { name: city.city_name + ' Fuel Price Today' }
      ]),
      priceHero({
        title: 'Petrol & Diesel Price in ' + city.city_name + ' Today (' + dateStr + ')',
        price: petrol,
        unit: 'petrol per litre',
        change: null,
        direction: 'none',
        subtitle: 'Updated at 6 AM daily \u00b7 ' + city.city_name + ', ' + city.state_name,
        pills: [
          { value: petrol, label: 'Petrol/L' },
          { value: diesel, label: 'Diesel/L' },
          ...(cng ? [{ value: cng, label: 'CNG/kg' }] : [])
        ]
      }),
      articleSchema({
        headline: 'Petrol Diesel Price in ' + city.city_name + ' Today \u2013 ' + dateStr,
        description: 'Today\'s petrol price in ' + city.city_name + ' is ' + petrol + '/litre and diesel is ' + diesel + '/litre as on ' + dateStr + '.',
        datePublished: today.toISOString(),
        publisherName: 'HDF News'
      }),
      '<article>',
      '<section>',
      '<p style="font-size:15px;line-height:1.8;color:#374151;">The <strong>petrol price in ' + city.city_name + '</strong> today is <strong>' + petrol + ' per litre</strong> and <strong>diesel price in ' + city.city_name + '</strong> is <strong>' + diesel + ' per litre</strong> as on <time datetime="' + today.toISOString().split('T')[0] + '">' + dateStr + '</time>. Prices are revised at 6:00 AM daily by Oil Marketing Companies (OMCs).</p>',
      sourceBadge('IOCL / HPCL / BPCL \u2014 Oil Marketing Companies'),
      '</section>',
      '<section>',
      styledTable('Fuel Prices in ' + city.city_name + ' \u2014 ' + dateStr, ['Fuel Type', 'Price per Litre/Unit', 'State VAT'], fuelRows, ['45%', '30%', '25%']),
      '</section>',
      readAlsoBox('Read Also', 'Petrol & Diesel Price in ' + city.state_name + ' \u2014 All Cities', stateUrl),
      '<section>',
      styledTable('Petrol & Diesel Cost Calculator for ' + city.city_name, ['Volume', 'Petrol Cost', 'Diesel Cost'], litreRows, ['33%', '33%', '34%']),
      infoBox('Prices above are calculated at today\'s ' + city.city_name + ' rates. Actual pump prices may vary by \u00b10.10 due to rounding. Prices include all taxes and dealer commissions.'),
      '</section>',
      stateInfo && stateInfo.note ? '<section><h2 style="font-size:20px;font-weight:700;color:#111827;margin-top:28px;">About Fuel Prices in ' + city.state_name + '</h2><p style="font-size:14px;color:#374151;line-height:1.8;">' + city.state_name + ' levies <strong>' + (stateInfo.vat || '\u2014') + '</strong> on fuel. ' + stateInfo.note + '</p></section>' : '',
      faqSection(faqs),
      '</article>'
    ];
    return parts.join('\n');
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

    const citiesWithPrices = stateCities.map(c => ({
      city_name: c.city_name,
      state_name: state,
      prices: {
        petrol: c.petrol || null,
        diesel: c.diesel || null,
        cng: null,
      }
    }));
    const nationalSlug2 = slugify(fuelType + '-price-in-india-today');
    const nationalUrl = '/' + nationalSlug2 + '/';
    const html = this._buildStateContent(state, stateInfo, citiesWithPrices, nationalUrl);

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

    const contentHash = crypto.createHash('md5').update(html).digest('hex');
    this._logPost('state', fuelType, state, result, contentHash);
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

    // All individual cities with today's prices
    const allCities = this.db.prepare(
      'SELECT fc.city_name, fc.state, fp.petrol, fp.diesel FROM fuel_cities fc ' +
      'INNER JOIN fuel_prices fp ON fc.city_name = fp.city AND fp.price_date = ? ' +
      'WHERE fc.is_enabled = 1'
    ).all(today);

    const slug = slugify(fuelType + '-price-in-india-today');
    const title = fuelLabel + ' Price in India Today (' + dateStr + ') — State-wise Rates';
    let metaDescription = fuelLabel + ' price in India today: national avg ₹' + fmtPrice(nationalPriceFmt) + '/L (' + dateStr + '). State-wise rates, major cities, and 30-day trend chart.';
    if (metaDescription.length > 160) {
      metaDescription = metaDescription.substring(0, 157) + '...';
    }

    const allCitiesWithPrices = allCities.map(c => ({
      city_name: c.city_name,
      state_name: c.state,
      prices: {
        petrol: c.petrol || null,
        diesel: c.diesel || null,
      }
    }));
    const html = this._buildNationalContent(allCitiesWithPrices);

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

    const contentHash = crypto.createHash('md5').update(html).digest('hex');
    this._logPost('national', fuelType, 'India', result, contentHash);
    return result.action;
  }

  _buildStateContent(stateName, stateInfo, citiesWithPrices, nationalUrl) {
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const valid = citiesWithPrices.filter(c => c.prices && (c.prices.petrol || c.prices.diesel));
    const petrolCities = valid.filter(c => c.prices.petrol);
    const dieselCities = valid.filter(c => c.prices.diesel);
    const avgPetrol = petrolCities.length ? (petrolCities.reduce((s, c) => s + c.prices.petrol, 0) / petrolCities.length).toFixed(2) : null;
    const avgDiesel = dieselCities.length ? (dieselCities.reduce((s, c) => s + c.prices.diesel, 0) / dieselCities.length).toFixed(2) : null;
    const tableRows = valid.sort((a, b) => a.city_name.localeCompare(b.city_name)).map(c => [
      c.city_name,
      c.prices.petrol ? '\u20b9' + c.prices.petrol.toFixed(2) : '\u2014',
      c.prices.diesel ? '\u20b9' + c.prices.diesel.toFixed(2) : '\u2014',
      c.prices.cng ? '\u20b9' + c.prices.cng.toFixed(2) : '\u2014'
    ]);
    const faqs = [
      {
        q: 'What is the petrol price in ' + stateName + ' today?',
        a: 'The average petrol price in ' + stateName + ' today is <strong>\u20b9' + avgPetrol + '/litre</strong> across ' + valid.length + ' cities, as on ' + dateStr + '.'
      },
      {
        q: 'What is VAT on petrol in ' + stateName + '?',
        a: stateInfo ? stateName + ' charges ' + stateInfo.vat + ' on petrol and diesel.' : 'Fuel VAT rates vary in ' + stateName + '. Check the state\'s commercial tax department for the latest rates.'
      },
      {
        q: 'Which city has the cheapest petrol in ' + stateName + '?',
        a: 'Petrol prices across ' + stateName + ' are generally uniform as they depend on the same state VAT rate. Minor differences can occur due to local body taxes.'
      }
    ];
    return [
      breadcrumbs([
        { name: 'Home', url: nationalUrl.replace(/\/[^/]+\/$/, '/') },
        { name: 'Fuel Prices', url: nationalUrl },
        { name: stateName + ' Fuel Prices Today' }
      ]),
      priceHero({
        title: 'Petrol & Diesel Price in ' + stateName + ' Today (' + dateStr + ')',
        price: avgPetrol ? '\u20b9' + avgPetrol : 'N/A',
        unit: 'avg petrol per litre',
        change: null,
        direction: 'none',
        subtitle: valid.length + ' cities tracked in ' + stateName + ' \u00b7 Updated 6 AM daily',
        pills: [
          { value: avgPetrol ? '\u20b9' + avgPetrol : '\u2014', label: 'Avg Petrol/L' },
          { value: avgDiesel ? '\u20b9' + avgDiesel : '\u2014', label: 'Avg Diesel/L' },
          { value: valid.length, label: 'cities' }
        ]
      }),
      articleSchema({
        headline: 'Petrol Diesel Price in ' + stateName + ' Today \u2013 ' + dateStr,
        description: 'Today\'s average petrol price in ' + stateName + ' is \u20b9' + avgPetrol + '/litre. Check fuel rates in all ' + valid.length + ' cities in ' + stateName + ' on ' + dateStr + '.',
        datePublished: today.toISOString(),
        publisherName: 'HDF News'
      }),
      '<article>',
      '<section>',
      '<p style="font-size:15px;line-height:1.8;color:#374151;">The average <strong>petrol price in ' + stateName + '</strong> today is <strong>\u20b9' + avgPetrol + ' per litre</strong> and diesel is <strong>\u20b9' + avgDiesel + ' per litre</strong> as on <time datetime="' + today.toISOString().split('T')[0] + '">' + dateStr + '</time>. We track live fuel prices in <strong>' + valid.length + ' cities across ' + stateName + '</strong>.</p>',
      sourceBadge('IOCL / HPCL / BPCL \u2014 Oil Marketing Companies'),
      '</section>',
      readAlsoBox('See Also', 'Petrol & Diesel Price in India Today \u2014 National Rates', nationalUrl),
      '<section>',
      styledTable('Petrol & Diesel Price in All Cities of ' + stateName + ' \u2014 ' + dateStr, ['City', 'Petrol (\u20b9/L)', 'Diesel (\u20b9/L)', 'CNG (\u20b9/kg)'], tableRows, ['40%', '20%', '20%', '20%']),
      '</section>',
      faqSection(faqs),
      '</article>'
    ].join('\n');
  }

  _buildNationalContent(allCitiesWithPrices) {
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const valid = allCitiesWithPrices.filter(c => c.prices && c.prices.petrol);
    const validDiesel = allCitiesWithPrices.filter(c => c.prices && c.prices.diesel);
    const avgPetrol = valid.length ? (valid.reduce((s, c) => s + c.prices.petrol, 0) / valid.length).toFixed(2) : null;
    const avgDiesel = validDiesel.length ? (validDiesel.reduce((s, c) => s + c.prices.diesel, 0) / validDiesel.length).toFixed(2) : null;
    const stateCount = [...new Set(valid.map(c => c.state_name))].filter(Boolean).length;
    const byState = {};
    valid.forEach(c => {
      if (!byState[c.state_name]) byState[c.state_name] = { petrol: [], diesel: [], cities: 0 };
      byState[c.state_name].petrol.push(c.prices.petrol);
      if (c.prices.diesel) byState[c.state_name].diesel.push(c.prices.diesel);
      byState[c.state_name].cities++;
    });
    const stateRows = Object.entries(byState).sort((a, b) => a[0].localeCompare(b[0])).map(([state, data]) => {
      const avg = (data.petrol.reduce((s, p) => s + p, 0) / data.petrol.length).toFixed(2);
      const avgD = data.diesel.length ? (data.diesel.reduce((s, p) => s + p, 0) / data.diesel.length).toFixed(2) : '\u2014';
      return [state, '\u20b9' + avg, '\u20b9' + avgD, data.cities.toString()];
    });
    const faqs = [
      {
        q: 'What is the petrol price in India today (' + dateStr + ')?',
        a: 'The national average petrol price in India today is <strong>\u20b9' + avgPetrol + ' per litre</strong> across ' + valid.length + ' cities, as on ' + dateStr + '.'
      },
      {
        q: 'What is the diesel price in India today?',
        a: 'The national average diesel price in India today is <strong>\u20b9' + avgDiesel + ' per litre</strong> across major cities, as on ' + dateStr + '.'
      },
      {
        q: 'Why do petrol prices differ across Indian states?',
        a: 'Petrol prices vary across states due to different VAT rates, local body taxes, and freight charges. States like Rajasthan and Maharashtra have higher VAT, leading to higher pump prices.'
      },
      {
        q: 'When are fuel prices updated in India?',
        a: 'Oil Marketing Companies (IOCL, HPCL, BPCL) revise petrol and diesel prices at 6:00 AM IST every day, based on the 15-day average of international crude oil prices and USD/INR rates.'
      },
      {
        q: 'Which state has the cheapest petrol in India?',
        a: 'States with lower VAT rates like Goa, Andaman &amp; Nicobar Islands, and some northeastern states tend to have cheaper petrol. The difference can be \u20b95\u2013\u20b915 per litre compared to high-VAT states.'
      }
    ];
    return [
      priceHero({
        title: 'Petrol & Diesel Price in India Today (' + dateStr + ')',
        price: avgPetrol ? '\u20b9' + avgPetrol : 'N/A',
        unit: 'avg petrol per litre',
        change: null,
        direction: 'none',
        subtitle: valid.length + ' cities \u00b7 ' + stateCount + ' states tracked \u00b7 Updated 6 AM IST daily',
        pills: [
          { value: avgPetrol ? '\u20b9' + avgPetrol : '\u2014', label: 'Avg Petrol/L' },
          { value: avgDiesel ? '\u20b9' + avgDiesel : '\u2014', label: 'Avg Diesel/L' },
          { value: valid.length, label: 'cities' },
          { value: stateCount, label: 'states' }
        ]
      }),
      articleSchema({
        headline: 'Petrol Diesel Price in India Today \u2013 ' + dateStr,
        description: 'Today\'s national average petrol price in India is \u20b9' + avgPetrol + '/litre. Check state-wise and city-wise fuel prices across ' + valid.length + ' cities and ' + stateCount + ' states.',
        datePublished: today.toISOString(),
        publisherName: 'HDF News'
      }),
      '<article>',
      '<section>',
      '<p style="font-size:15px;line-height:1.8;color:#374151;">The national average <strong>petrol price in India</strong> today is <strong>\u20b9' + avgPetrol + ' per litre</strong> and <strong>diesel price</strong> is <strong>\u20b9' + avgDiesel + ' per litre</strong> as on <time datetime="' + today.toISOString().split('T')[0] + '">' + dateStr + '</time>. We track live fuel rates across <strong>' + valid.length + ' cities in ' + stateCount + ' states</strong>.</p>',
      sourceBadge('IOCL / HPCL / BPCL \u2014 Oil Marketing Companies'),
      '</section>',
      '<section>',
      styledTable('State-wise Petrol & Diesel Price in India \u2014 ' + dateStr, ['State', 'Avg Petrol (\u20b9/L)', 'Avg Diesel (\u20b9/L)', 'Cities Tracked'], stateRows, ['40%', '20%', '20%', '20%']),
      '</section>',
      faqSection(faqs),
      '</article>'
    ].join('\n');
  }
}

module.exports = { FuelPostCreator };
