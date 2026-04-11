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
  // _buildFuelFaq
  // =========================================================================

  _buildFuelFaq(cityOrState, petrol, diesel, vatInfo, dateStr) {
    const faqs = [
      { q: 'What is the petrol price in ' + cityOrState + ' today?',
        a: 'The petrol price in ' + cityOrState + ' today is <strong>' + petrol + ' per litre</strong> as on ' + dateStr + '.' },
      ...(diesel ? [{ q: 'What is the diesel price in ' + cityOrState + ' today?',
        a: 'The diesel price in ' + cityOrState + ' today is <strong>' + diesel + ' per litre</strong> as on ' + dateStr + '.' }] : []),
      { q: 'What is VAT on petrol in ' + cityOrState + '?',
        a: 'The VAT on petrol in ' + cityOrState + ' is <strong>' + vatInfo + '</strong>. In addition, the central government levies excise duty and there are dealer commissions and transportation charges.' },
      { q: 'When are fuel prices updated in ' + cityOrState + '?',
        a: 'Petrol and diesel prices in ' + cityOrState + ' are revised at 6:00 AM every day by Indian Oil, HPCL, and BPCL based on international crude oil prices and forex rates.' },
      { q: 'How can I check today\'s fuel price in ' + cityOrState + '?',
        a: 'You can check today\'s fuel price in ' + cityOrState + ' on this page \u2014 prices are updated daily at 6 AM. You can also SMS "RSP" to 9224992249 (HPCL) or use the Indian Oil One app.' },
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

  // =========================================================================
  // _buildCityContent
  // =========================================================================

  _buildCityContent(city, prices, stateInfo, stateUrl, nationalUrl) {
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const petrol = prices.petrol ? '\u20b9' + prices.petrol.toFixed(2) : 'N/A';
    const diesel = prices.diesel ? '\u20b9' + prices.diesel.toFixed(2) : 'N/A';
    const vatInfo = stateInfo ? stateInfo.vat : 'varies';
    const stateNote = stateInfo && stateInfo.note ? stateInfo.note : '';

    const cityFaqs = [
      { q: 'What is petrol price in ' + city.city_name + ' today?', a: 'The petrol price in ' + city.city_name + ' today is ' + petrol + ' per litre as on ' + dateStr + ', revised at 6:00 AM by IOCL/HPCL/BPCL.' },
      { q: 'What is diesel price in ' + city.city_name + ' today?', a: 'The diesel price in ' + city.city_name + ' today is ' + diesel + ' per litre as on ' + dateStr + ', revised at 6:00 AM by Oil Marketing Companies.' },
      { q: 'Why do fuel prices differ across cities?', a: 'Fuel prices differ due to state VAT rates, local body taxes, and transportation costs from refineries. ' + city.state_name + ' levies ' + vatInfo + ' on fuel.' },
      { q: 'When are fuel prices revised in India?', a: 'Fuel prices are revised at 6:00 AM IST daily by IOCL, HPCL, and BPCL based on 15-day average crude oil prices and USD/INR rates.' },
      { q: 'How to check today\'s fuel price in ' + city.city_name + '?', a: 'Check today\'s ' + city.city_name + ' fuel price on this page (updated daily), or SMS RSP to 9224992249 (HPCL), or use the Indian Oil One or My HPCL app.' }
    ];
    const cityFaqItems = cityFaqs.map(function(f) {
      return '<div class="hdf-faq-item" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question"><h3 itemprop="name">' + f.q + '</h3><div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer"><p itemprop="text">' + f.a + '</p></div></div>';
    }).join('\n');
    const cityArticleJsonLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'NewsArticle', 'headline': 'Petrol Diesel Price in ' + city.city_name + ' Today \u2014 ' + dateStr, 'description': 'Petrol price in ' + city.city_name + ' today is ' + petrol + '/L and diesel is ' + diesel + '/L as on ' + dateStr + '.', 'datePublished': today.toISOString(), 'dateModified': today.toISOString(), 'author': { '@type': 'Organization', 'name': 'HDF News' }, 'publisher': { '@type': 'Organization', 'name': 'HDF News' } });
    const cityFaqJsonLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', 'mainEntity': cityFaqs.map(function(f) { return { '@type': 'Question', 'name': f.q, 'acceptedAnswer': { '@type': 'Answer', 'text': f.a } }; }) });

    const petrolFloat = prices.petrol || 0;
    const dieselFloat = prices.diesel || 0;

    return [
      '<script type="application/ld+json">' + cityArticleJsonLd + '</script>',
      '<script type="application/ld+json">' + cityFaqJsonLd + '</script>',
      '',
      '<div data-hdf="price-box" data-module="fuel" data-city="' + city.city_name + '">',
      '  <p><strong>Petrol price in ' + city.city_name + ' today</strong> is <strong>' + petrol + ' per litre</strong> and diesel is <strong>' + diesel + ' per litre</strong> as on ' + dateStr + '.</p>',
      '</div>',
      '',
      '<article>',
      '',
      '<p>The <strong>petrol price in ' + city.city_name + '</strong> today is <strong>' + petrol + ' per litre</strong> and <strong>diesel price in ' + city.city_name + '</strong> is <strong>' + diesel + ' per litre</strong> as on <time datetime="' + today.toISOString().split('T')[0] + '">' + dateStr + '</time>. Prices are revised at 6:00 AM daily by Oil Marketing Companies (OMCs) based on international crude oil rates.</p>',
      '',
      '<span class="hdf-source">\ud83d\udcca Source: IOCL / HPCL / BPCL \u2014 Oil Marketing Companies</span>',
      '',
      '<h2>Fuel Prices in ' + city.city_name + ' \u2014 ' + dateStr + '</h2>',
      '',
      '<div data-hdf="price-table" data-module="fuel" data-state="' + city.state_name + '">',
      '  <div class="hdf-table-wrap"><table class="hdf-table"><caption>Fuel prices in ' + city.state_name + ' cities</caption>',
      '  <thead><tr><th>City</th><th>Petrol (\u20b9/L)</th><th>Diesel (\u20b9/L)</th></tr></thead>',
      '  <tbody><tr><td>' + city.city_name + '</td><td>' + petrol + '</td><td>' + diesel + '</td></tr></tbody>',
      '  </table></div>',
      '</div>',
      '',
      '<h2>Full Tank Fill-Up Cost in ' + city.city_name + '</h2>',
      '<div data-hdf="fill-up" data-city="' + city.city_name + '" data-petrol="' + petrolFloat.toFixed(2) + '" data-diesel="' + dieselFloat.toFixed(2) + '">',
      '  <div class="hdf-table-wrap"><table class="hdf-table"><caption>Fill-up cost in ' + city.city_name + '</caption>',
      '  <thead><tr><th>Vehicle</th><th style="text-align:center">Petrol Cost</th><th style="text-align:center">Diesel Cost</th></tr></thead>',
      '  <tbody>',
      '    <tr><td>Bike (12L)</td><td style="text-align:center">' + (petrolFloat ? '\u20b9' + (petrolFloat * 12).toFixed(2) : '\u2014') + '</td><td style="text-align:center">' + (dieselFloat ? '\u20b9' + (dieselFloat * 12).toFixed(2) : '\u2014') + '</td></tr>',
      '    <tr><td>Small Car (35L)</td><td style="text-align:center">' + (petrolFloat ? '\u20b9' + (petrolFloat * 35).toFixed(2) : '\u2014') + '</td><td style="text-align:center">' + (dieselFloat ? '\u20b9' + (dieselFloat * 35).toFixed(2) : '\u2014') + '</td></tr>',
      '    <tr><td>Mid-Size Car (45L)</td><td style="text-align:center">' + (petrolFloat ? '\u20b9' + (petrolFloat * 45).toFixed(2) : '\u2014') + '</td><td style="text-align:center">' + (dieselFloat ? '\u20b9' + (dieselFloat * 45).toFixed(2) : '\u2014') + '</td></tr>',
      '    <tr><td>Large SUV (65L)</td><td style="text-align:center">' + (petrolFloat ? '\u20b9' + (petrolFloat * 65).toFixed(2) : '\u2014') + '</td><td style="text-align:center">' + (dieselFloat ? '\u20b9' + (dieselFloat * 65).toFixed(2) : '\u2014') + '</td></tr>',
      '  </tbody></table></div>',
      '</div>',
      '',
      '<h2>Petrol &amp; Diesel Price History in ' + city.city_name + ' \u2014 Last 30 Days</h2>',
      '<div data-hdf="price-history" data-module="fuel" data-city="' + city.city_name + '" data-days="30">',
      '  <p>Petrol: ' + petrol + ' | Diesel: ' + diesel + ' as on ' + dateStr + '. Full 30-day history loads dynamically.</p>',
      '</div>',
      '',
      '<h2>Petrol Price Trend Chart \u2014 ' + city.city_name + '</h2>',
      '<div data-hdf="price-chart" data-module="fuel" data-city="' + city.city_name + '" data-days="30">',
      '  <div class="hdf-chart-wrap"><p style="font-size:13px;color:#6b7280">Chart loading\u2026</p></div>',
      '</div>',
      '',
      '<div class="hdf-callout">',
      '  <div class="hdf-callout-label">Read Also</div>',
      '  <a href="' + stateUrl + '">Petrol &amp; Diesel Price in ' + city.state_name + ' \u2014 All Cities (' + dateStr + ')</a>',
      '</div>',
      '',
      stateNote ? '<h2>About Fuel Prices in ' + city.state_name + '</h2><p>' + city.state_name + ' levies <strong>' + vatInfo + '</strong> on fuel. ' + stateNote + '</p>' : '',
      '',
      '<h2>Other Cities in ' + city.state_name + '</h2>',
      '<div data-hdf="city-pills" data-module="fuel" data-state="' + city.state_name + '" data-prefix="petrol-price-in">',
      '  <p>Explore fuel prices in other ' + city.state_name + ' cities \u2014 loads dynamically.</p>',
      '</div>',
      '',
      '<div class="hdf-info">\ud83d\udca1 Fuel prices shown are retail pump prices inclusive of all taxes and dealer commission. Prices revised daily at 6:00 AM IST.</div>',
      '',
      '<section class="hdf-faq" itemscope itemtype="https://schema.org/FAQPage">',
      '<h2>Frequently Asked Questions</h2>',
      cityFaqItems,
      '</section>',
      '',
      '</article>'
    ].join('\n').trim();
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
    const avgPetrol = petrolCities.length
      ? (petrolCities.reduce((s, c) => s + c.prices.petrol, 0) / petrolCities.length).toFixed(2)
      : null;
    const vatInfo = stateInfo ? stateInfo.vat : 'varies';

    const stateCityRows = valid.map(function(c) {
      return '<tr><td>' + c.city_name + '</td><td>' + (c.prices.petrol ? '\u20b9' + c.prices.petrol.toFixed(2) : '\u2014') + '</td><td>' + (c.prices.diesel ? '\u20b9' + c.prices.diesel.toFixed(2) : '\u2014') + '</td></tr>';
    }).join('');

    const stateFuelFaqs = [
      { q: 'What is petrol price in ' + stateName + ' today?', a: 'The average petrol price in ' + stateName + ' today is ' + (avgPetrol ? '\u20b9' + avgPetrol + ' per litre' : 'N/A') + ' as on ' + dateStr + ', tracked across ' + valid.length + ' cities.' },
      { q: 'Why do fuel prices differ between cities in ' + stateName + '?', a: 'Fuel prices differ between cities due to transportation costs from refineries, local body taxes, and dealer margins. ' + stateName + ' levies ' + vatInfo + ' on fuel.' },
      { q: 'When are fuel prices revised in India?', a: 'Fuel prices are revised at 6:00 AM IST daily by IOCL, HPCL, and BPCL based on 15-day average crude oil prices and USD/INR rates.' }
    ];
    const stateFuelFaqItems = stateFuelFaqs.map(function(f) {
      return '<div class="hdf-faq-item" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question"><h3 itemprop="name">' + f.q + '</h3><div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer"><p itemprop="text">' + f.a + '</p></div></div>';
    }).join('\n');
    const stateArticleJsonLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'NewsArticle', 'headline': 'Petrol Diesel Price in ' + stateName + ' Today \u2014 ' + dateStr, 'description': 'Average petrol price in ' + stateName + ' today is ' + (avgPetrol ? '\u20b9' + avgPetrol + '/L' : 'N/A') + '. Check rates in all ' + valid.length + ' cities.', 'datePublished': today.toISOString(), 'dateModified': today.toISOString(), 'author': { '@type': 'Organization', 'name': 'HDF News' }, 'publisher': { '@type': 'Organization', 'name': 'HDF News' } });
    const stateFuelFaqJsonLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', 'mainEntity': stateFuelFaqs.map(function(f) { return { '@type': 'Question', 'name': f.q, 'acceptedAnswer': { '@type': 'Answer', 'text': f.a } }; }) });

    return [
      '<script type="application/ld+json">' + stateArticleJsonLd + '</script>',
      '<script type="application/ld+json">' + stateFuelFaqJsonLd + '</script>',
      '',
      '<div data-hdf="national" data-module="fuel">',
      '  <p>Average <strong>petrol price in ' + stateName + '</strong> today is ' + (avgPetrol ? '<strong>\u20b9' + avgPetrol + ' per litre</strong>' : 'loading...') + ' as on ' + dateStr + '.</p>',
      '</div>',
      '',
      '<article>',
      '',
      '<p>The average <strong>petrol price in ' + stateName + '</strong> today is ' + (avgPetrol ? '<strong>\u20b9' + avgPetrol + ' per litre</strong>' : 'being updated') + ' as on <time datetime="' + today.toISOString().split('T')[0] + '">' + dateStr + '</time>. We track live fuel prices in <strong>' + valid.length + ' cities across ' + stateName + '</strong>. ' + stateName + ' levies <strong>' + vatInfo + '</strong> on fuel.</p>',
      '',
      '<span class="hdf-source">\ud83d\udcca Source: IOCL / HPCL / BPCL \u2014 Oil Marketing Companies</span>',
      '',
      '<div class="hdf-callout">',
      '  <div class="hdf-callout-label">See Also</div>',
      '  <a href="' + nationalUrl + '">Petrol &amp; Diesel Price in India Today \u2014 National Rates</a>',
      '</div>',
      '',
      '<h2>Petrol &amp; Diesel Price in All Cities of ' + stateName + ' \u2014 ' + dateStr + '</h2>',
      '',
      '<div data-hdf="price-table" data-module="fuel" data-state="' + stateName + '">',
      '  <div class="hdf-table-wrap"><table class="hdf-table"><caption>Fuel prices in cities of ' + stateName + '</caption>',
      '  <thead><tr><th>City</th><th>Petrol (\u20b9/L)</th><th>Diesel (\u20b9/L)</th></tr></thead>',
      '  <tbody>' + stateCityRows + '</tbody></table></div>',
      '</div>',
      '',
      '<h2>VAT &amp; Taxes on Fuel in ' + stateName + '</h2>',
      '<p>' + stateName + ' levies <strong>' + vatInfo + '</strong> on petrol and diesel. In addition to state VAT, the central government levies excise duty. The final retail price includes dealer commission (~\u20b92\u20134/L) and transportation charges that vary by city.</p>',
      '',
      '<div class="hdf-info">\ud83d\udca1 Fuel prices shown are retail pump prices inclusive of all taxes and dealer commission. Prices revised daily at 6:00 AM IST.</div>',
      '',
      '<section class="hdf-faq" itemscope itemtype="https://schema.org/FAQPage">',
      '<h2>Frequently Asked Questions</h2>',
      stateFuelFaqItems,
      '</section>',
      '',
      '</article>'
    ].join('\n').trim();
  }

  _buildNationalContent(allCitiesWithPrices) {
    const today = new Date();
    const dateStr = today.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
    const valid = allCitiesWithPrices.filter(c => c.prices && c.prices.petrol);
    const avgPetrol = valid.length
      ? (valid.reduce((s, c) => s + c.prices.petrol, 0) / valid.length).toFixed(2)
      : null;
    const validDiesel = allCitiesWithPrices.filter(c => c.prices && c.prices.diesel);
    const avgDiesel = validDiesel.length
      ? (validDiesel.reduce((s, c) => s + c.prices.diesel, 0) / validDiesel.length).toFixed(2)
      : null;
    const stateCount = [...new Set(valid.map(c => c.state_name))].filter(Boolean).length;

    const natFuelFaqs = [
      { q: 'What is petrol price in India today?', a: 'The national average petrol price in India today is ' + (avgPetrol ? '\u20b9' + avgPetrol + ' per litre' : 'N/A') + ' as on ' + dateStr + ', sourced from IOCL/HPCL/BPCL.' },
      { q: 'What is diesel price in India today?', a: 'The national average diesel price in India today is ' + (avgDiesel ? '\u20b9' + avgDiesel + ' per litre' : 'N/A') + ' as on ' + dateStr + ', sourced from IOCL/HPCL/BPCL.' },
      { q: 'Why do fuel prices differ across Indian states?', a: 'Fuel prices vary across India due to different state VAT rates (6% to 36%+), local body taxes, freight charges from refineries, and dealer commissions.' },
      { q: 'When are fuel prices revised in India?', a: 'Fuel prices are revised at 6:00 AM IST daily by IOCL, HPCL, and BPCL based on 15-day average international crude oil prices and USD/INR exchange rates.' },
      { q: 'How to check today\'s fuel price in my city?', a: 'Check today\'s fuel price on this page (updated daily), or SMS RSP to 9224992249 (HPCL), or use the Indian Oil One or My HPCL app.' }
    ];
    const natFuelFaqItems = natFuelFaqs.map(function(f) {
      return '<div class="hdf-faq-item" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question"><h3 itemprop="name">' + f.q + '</h3><div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer"><p itemprop="text">' + f.a + '</p></div></div>';
    }).join('\n');
    const natArticleJsonLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'NewsArticle', 'headline': 'Petrol Diesel Price in India Today \u2014 ' + dateStr, 'description': 'National average petrol price in India today is ' + (avgPetrol ? '\u20b9' + avgPetrol + '/L' : 'N/A') + ' and diesel is ' + (avgDiesel ? '\u20b9' + avgDiesel + '/L' : 'N/A') + ' as on ' + dateStr + '.', 'datePublished': today.toISOString(), 'dateModified': today.toISOString(), 'author': { '@type': 'Organization', 'name': 'HDF News' }, 'publisher': { '@type': 'Organization', 'name': 'HDF News' } });
    const natFuelFaqJsonLd = JSON.stringify({ '@context': 'https://schema.org', '@type': 'FAQPage', 'mainEntity': natFuelFaqs.map(function(f) { return { '@type': 'Question', 'name': f.q, 'acceptedAnswer': { '@type': 'Answer', 'text': f.a } }; }) });

    return [
      '<script type="application/ld+json">' + natArticleJsonLd + '</script>',
      '<script type="application/ld+json">' + natFuelFaqJsonLd + '</script>',
      '',
      '<div data-hdf="national" data-module="fuel">',
      '  <p><strong>Petrol price in India today</strong> (national average) is ' + (avgPetrol ? '<strong>\u20b9' + avgPetrol + ' per litre</strong>' : 'loading...') + ' and diesel is ' + (avgDiesel ? '<strong>\u20b9' + avgDiesel + ' per litre</strong>' : 'loading...') + ' as on ' + dateStr + '.</p>',
      '</div>',
      '',
      '<article>',
      '',
      '<p>The national average <strong>petrol price in India</strong> today is ' + (avgPetrol ? '<strong>\u20b9' + avgPetrol + ' per litre</strong>' : 'being updated') + ' and <strong>diesel price</strong> is ' + (avgDiesel ? '<strong>\u20b9' + avgDiesel + ' per litre</strong>' : 'being updated') + ' as on <time datetime="' + today.toISOString().split('T')[0] + '">' + dateStr + '</time>. Fuel prices are revised at 6:00 AM daily by Oil Marketing Companies based on international crude oil markets. We track live fuel rates across <strong>' + valid.length + ' cities in ' + stateCount + ' states</strong>.</p>',
      '',
      '<span class="hdf-source">\ud83d\udcca Source: IOCL / HPCL / BPCL \u2014 Oil Marketing Companies</span>',
      '',
      '<h2>State-wise Petrol &amp; Diesel Price in India \u2014 ' + dateStr + '</h2>',
      '',
      '<div data-hdf="ranking" data-module="fuel" data-fuel="petrol" data-sort="asc" data-limit="20" data-label="Petrol Price by City in India \u2014 ' + dateStr + '">',
      '  <p>Live fuel price ranking loading...</p>',
      '</div>',
      '',
      '<h2>Why Do Fuel Prices Differ Across Indian States?</h2>',
      '<p>Petrol and diesel prices vary across India primarily because of state VAT rates, which range from 6% (Andaman &amp; Nicobar) to 36%+ (Rajasthan). In addition, local body taxes, freight charges from refineries, and dealer commissions add to the final retail price. States with refineries nearby (e.g., Gujarat, Tamil Nadu) generally have lower transport costs.</p>',
      '',
      '<div class="hdf-info">\ud83d\udca1 Fuel prices shown are retail pump prices inclusive of all taxes and dealer commission. Prices revised daily at 6:00 AM IST.</div>',
      '',
      '<section class="hdf-faq" itemscope itemtype="https://schema.org/FAQPage">',
      '<h2>Frequently Asked Questions</h2>',
      natFuelFaqItems,
      '</section>',
      '',
      '</article>'
    ].join('\n').trim();
  }
}

module.exports = { FuelPostCreator };
