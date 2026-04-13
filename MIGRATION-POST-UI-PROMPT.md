# MIGRATION POST UI/UX + SEMANTIC SEO OVERHAUL PROMPT

Feed this entire prompt to your AI IDE assistant.

---

## Context

We are upgrading the HTML output of `FuelPostCreator` and `MetalsPostCreator` to be:
1. **Visually polished** — LIVE badge, price-change color indicators, stat pills, callout boxes, responsive tables, FAQ accordion
2. **Semantically correct HTML** — proper heading hierarchy (H1→H2→H3), `<article>`, `<section>`, `<figure>`, `<time>`, `<table>` with `scope` + `caption`
3. **SEO-optimised** — JSON-LD structured data (Article + FAQPage + BreadcrumbList), keyword-rich headings, internal linking, date in H1, meta description string

Both `src/modules/fuel-post-creator.js` and `src/modules/metals-post-creator.js` need updating. The changes are **HTML/content only** — no changes to publishing logic, WP API calls, or cron wiring.

---

## Part 1 — Shared HTML Utilities (new file)

Create `src/utils/post-html.js` with these pure helper functions used by both creators:

```js
// src/utils/post-html.js

/**
 * Returns a styled LIVE badge with blinking dot
 */
function liveBadge() {
  return `<span class="hdf-live-badge" style="display:inline-flex;align-items:center;gap:6px;background:#fff0f0;border:1px solid #ff4444;border-radius:20px;padding:4px 12px;font-size:12px;font-weight:700;color:#cc0000;text-transform:uppercase;letter-spacing:0.5px;">
  <span style="width:8px;height:8px;border-radius:50%;background:#ff4444;display:inline-block;animation:hdf-blink 1.2s ease-in-out infinite;"></span>
  Live
</span>
<style>@keyframes hdf-blink{0%,100%{opacity:1}50%{opacity:0.2}}</style>`;
}

/**
 * Returns a styled price-change indicator
 * @param {number|null} change  — numeric change amount (can be null if unknown)
 * @param {string} direction    — 'up' | 'down' | 'none'
 */
function priceChangeBadge(change, direction) {
  const configs = {
    up:   { icon: '▲', color: '#1a7f37', bg: '#eafbee', border: '#a3e6b1', label: change ? `+₹${change}` : 'Increased' },
    down: { icon: '▼', color: '#d1242f', bg: '#fff0f0', border: '#ffb3b3', label: change ? `-₹${Math.abs(change)}` : 'Decreased' },
    none: { icon: '→', color: '#6e7781', bg: '#f6f8fa', border: '#d0d7de', label: 'No Change' },
  };
  const c = configs[direction] || configs.none;
  return `<span style="display:inline-flex;align-items:center;gap:5px;background:${c.bg};border:1px solid ${c.border};border-radius:20px;padding:4px 12px;font-size:13px;font-weight:600;color:${c.color};">
  ${c.icon} ${c.label}
</span>`;
}

/**
 * Returns a row of stat pills
 * @param {Array<{label:string, value:string|number}>} stats
 */
function statPills(stats) {
  const pills = stats.map(s =>
    `<span style="background:#f0f6ff;border:1px solid #cce0ff;border-radius:20px;padding:5px 14px;font-size:13px;color:#1d4ed8;font-weight:600;white-space:nowrap;">
      <strong>${s.value}</strong> ${s.label}
    </span>`
  ).join('');
  return `<div style="display:flex;flex-wrap:wrap;gap:8px;margin:12px 0;">${pills}</div>`;
}

/**
 * Returns a styled source badge
 */
function sourceBadge(sourceName) {
  return `<span style="background:#fffbe6;border:1px solid #ffe58f;border-radius:4px;padding:2px 8px;font-size:12px;color:#92400e;font-weight:600;">📊 Source: ${sourceName}</span>`;
}

/**
 * Returns a styled READ ALSO / callout box
 */
function readAlsoBox(label, linkText, url) {
  return `<div style="border-left:4px solid #2563eb;background:#f0f6ff;border-radius:0 8px 8px 0;padding:12px 16px;margin:20px 0;">
  <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:#6b7280;">${label}</span><br>
  <a href="${url}" style="color:#1d4ed8;font-weight:600;text-decoration:none;font-size:15px;">${linkText}</a>
</div>`;
}

/**
 * Returns a styled info box / note
 */
function infoBox(text) {
  return `<div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:14px 18px;margin:16px 0;font-size:14px;color:#0c4a6e;line-height:1.6;">
  💡 ${text}
</div>`;
}

/**
 * Returns an HTML table with HDF styling
 * @param {string} caption
 * @param {Array<string>} headers
 * @param {Array<Array<string>>} rows
 * @param {string[]} colWidths  — optional, e.g. ['50%','25%','25%']
 */
function styledTable(caption, headers, rows, colWidths = []) {
  const colgroup = colWidths.length
    ? `<colgroup>${colWidths.map(w => `<col style="width:${w}">`).join('')}</colgroup>`
    : '';
  const thead = headers.map((h, i) =>
    `<th scope="col" style="padding:12px 14px;text-align:${i===0?'left':'center'};font-size:13px;font-weight:700;letter-spacing:0.3px;">${h}</th>`
  ).join('');
  const tbody = rows.map((row, ri) => {
    const cells = row.map((cell, ci) =>
      `<td style="padding:11px 14px;text-align:${ci===0?'left':'center'};border-bottom:1px solid #f0f0f0;font-size:14px;">${cell}</td>`
    ).join('');
    return `<tr style="background:${ri%2===0?'#fff':'#fafafa'};" onmouseover="this.style.background='#f0f6ff'" onmouseout="this.style.background='${ri%2===0?'#fff':'#fafafa'}';">${cells}</tr>`;
  }).join('');
  return `<div style="overflow-x:auto;border-radius:10px;border:1px solid #e5e7eb;margin:20px 0;">
<table style="width:100%;border-collapse:collapse;font-family:inherit;" role="table">
${colgroup}
<caption style="caption-side:top;text-align:left;padding:12px 14px;font-size:15px;font-weight:700;color:#111827;background:#f9fafb;border-bottom:1px solid #e5e7eb;">${caption}</caption>
<thead><tr style="background:#1f2937;">${thead}</tr></thead>
<tbody>${tbody}</tbody>
</table>
</div>`;
}

/**
 * Returns an FAQ section with JSON-LD schema
 * @param {Array<{q:string, a:string}>} faqs
 */
function faqSection(faqs) {
  const items = faqs.map(f =>
    `<div style="border-bottom:1px solid #f0f0f0;padding:16px 0;" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question">
  <h3 style="margin:0 0 8px;font-size:15px;font-weight:700;color:#111827;" itemprop="name">${f.q}</h3>
  <div style="font-size:14px;color:#374151;line-height:1.7;" itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer">
    <div itemprop="text">${f.a}</div>
  </div>
</div>`
  ).join('');

  const jsonld = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": faqs.map(f => ({
      "@type": "Question",
      "name": f.q,
      "acceptedAnswer": { "@type": "Answer", "text": f.a }
    }))
  };

  return `<section style="margin:32px 0;" itemscope itemtype="https://schema.org/FAQPage">
<h2 style="font-size:20px;font-weight:700;color:#111827;border-bottom:2px solid #e5e7eb;padding-bottom:10px;margin-bottom:0;">Frequently Asked Questions</h2>
${items}
</section>
<script type="application/ld+json">${JSON.stringify(jsonld, null, 2)}</script>`;
}

/**
 * Returns Article JSON-LD schema
 */
function articleSchema({ headline, description, datePublished, dateModified, url, authorName, publisherName, publisherLogo }) {
  return `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    "headline": headline,
    "description": description,
    "datePublished": datePublished,
    "dateModified": dateModified || datePublished,
    "url": url || "",
    "author": { "@type": "Organization", "name": authorName || publisherName },
    "publisher": {
      "@type": "Organization",
      "name": publisherName,
      "logo": { "@type": "ImageObject", "url": publisherLogo || "" }
    }
  }, null, 2)}</script>`;
}

/**
 * Returns BreadcrumbList JSON-LD + visible breadcrumb nav
 * @param {Array<{name:string, url:string}>} crumbs — last item has no url needed
 */
function breadcrumbs(crumbs) {
  const visibleCrumbs = crumbs.map((c, i) => {
    const isLast = i === crumbs.length - 1;
    const item = isLast
      ? `<span style="color:#6b7280;">${c.name}</span>`
      : `<a href="${c.url}" style="color:#2563eb;text-decoration:none;">${c.name}</a>`;
    return item + (isLast ? '' : `<span style="color:#9ca3af;margin:0 6px;">›</span>`);
  }).join('');

  const jsonld = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": crumbs.map((c, i) => ({
      "@type": "ListItem",
      "position": i + 1,
      "name": c.name,
      "item": c.url || ""
    }))
  };

  return `<nav aria-label="Breadcrumb" style="font-size:13px;margin-bottom:20px;">
${visibleCrumbs}
</nav>
<script type="application/ld+json">${JSON.stringify(jsonld, null, 2)}</script>`;
}

/**
 * Returns a price hero card — the main above-the-fold price display
 */
function priceHero({ title, price, unit, change, direction, subtitle, pills, badgeExtra }) {
  return `<div style="background:linear-gradient(135deg,#1f2937 0%,#374151 100%);border-radius:14px;padding:28px 28px 22px;color:#fff;margin:0 0 24px;">
  <div style="display:flex;align-items:flex-start;justify-content:space-between;flex-wrap:wrap;gap:12px;">
    <div>
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">
        ${liveBadge()}
        ${badgeExtra || ''}
      </div>
      <h1 style="margin:0 0 6px;font-size:26px;font-weight:800;color:#fff;line-height:1.2;">${title}</h1>
      <p style="margin:0;font-size:13px;color:#9ca3af;">${subtitle}</p>
    </div>
    <div style="text-align:right;">
      <div style="font-size:38px;font-weight:800;color:#fff;line-height:1;">${price}</div>
      <div style="font-size:13px;color:#9ca3af;margin-top:4px;">${unit}</div>
      <div style="margin-top:10px;">${priceChangeBadge(change, direction)}</div>
    </div>
  </div>
  <div style="margin-top:16px;border-top:1px solid rgba(255,255,255,0.1);padding-top:14px;">
    ${statPills(pills)}
  </div>
</div>`;
}

module.exports = {
  liveBadge, priceChangeBadge, statPills, sourceBadge,
  readAlsoBox, infoBox, styledTable, faqSection,
  articleSchema, breadcrumbs, priceHero
};
```

---

## Part 2 — MetalsPostCreator Full Rewrite

Rewrite `src/modules/metals-post-creator.js`. Keep all existing method signatures and exports unchanged. Only the HTML generation methods change.

### 2.1 Import helpers at the top

```js
const {
  liveBadge, priceChangeBadge, statPills, sourceBadge,
  readAlsoBox, infoBox, styledTable, faqSection,
  articleSchema, breadcrumbs, priceHero
} = require('../utils/post-html');
```

### 2.2 `_buildCityContent(city, metalType, prices, allCities, stateUrl, nationalUrl)`

Replace the full method body with:

```js
_buildCityContent(city, metalType, prices, allCities, stateUrl, nationalUrl) {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' });
  const isoDate = today.toISOString();
  const metal = this.METAL_CONFIG[metalType];

  // Price data
  const primaryVariant = metal.variants[0]; // e.g. '24K'
  const primaryPrice = prices[primaryVariant];
  const priceDisplay = primaryPrice ? `₹${primaryPrice.toLocaleString('en-IN')}` : 'N/A';

  // Determine change direction (compare with yesterday if available, else 'none')
  // For now we default to 'none'; extend later with historical comparison
  const changeDirection = 'none';

  // Count unique states in city list
  const stateCount = [...new Set(allCities.map(c => c.state_name))].length;
  const cityCount = allCities.length;

  // Build variants table rows
  const variantRows = metal.variants.map(v => {
    const p = prices[v];
    return [v, p ? `₹${p.toLocaleString('en-IN')}` : '—', p ? `₹${(p/10).toLocaleString('en-IN')}` : '—'];
  });

  // Weight table rows (standard weights)
  const weights = [1, 5, 8, 10, 100];
  const weightRows = weights.map(g => {
    const p = primaryPrice;
    return [
      `${g}g`,
      ...metal.variants.map(v => prices[v] ? `₹${(prices[v]*g).toLocaleString('en-IN')}` : '—')
    ];
  });

  // State-level cities for context
  const stateCities = allCities.filter(c => c.state_name === city.state_name && c.city_name !== city.city_name).slice(0, 5);

  // FAQs
  const faqs = [
    {
      q: `What is the ${metal.name} price in ${city.city_name} today (${dateStr})?`,
      a: `The ${metal.name} (${primaryVariant}) price in ${city.city_name} today is <strong>${priceDisplay} per gram</strong>, sourced from IBJA (Indian Bullion and Jewellers Association).`
    },
    {
      q: `Is ${metal.name} price the same in all cities in ${city.state_name}?`,
      a: `${metal.name} prices can vary slightly between cities in ${city.state_name} depending on local taxes and dealer margins. The IBJA rate is a national benchmark, and local jewellers may charge slightly above or below this rate.`
    },
    {
      q: `Why does ${metal.name} price change daily?`,
      a: `${metal.name} prices fluctuate due to global commodity markets, USD/INR exchange rates, international demand, and macroeconomic factors. Indian prices are also influenced by import duties and GST.`
    },
    {
      q: `What is the difference between ${metal.variants.join(' and ')} ${metal.name}?`,
      a: metal.variants.length > 1
        ? `${metal.variants[0]} ${metal.name} has higher purity (${metal.variants[0]}) compared to ${metal.variants.slice(1).join(' and ')}, making it more expensive but also more pure.`
        : `${primaryVariant} ${metal.name} refers to the purity grade of ${metal.name}. Higher karat means higher purity.`
    },
    {
      q: `Where to buy ${metal.name} in ${city.city_name}?`,
      a: `You can buy ${metal.name} at certified jewellers, bank branches, post offices (India Post Gold), and reputed online platforms. Always check the BIS hallmark for purity certification.`
    }
  ];

  const content = `
${breadcrumbs([
  { name: 'Home', url: nationalUrl.replace(/\/[^/]+$/, '/') },
  { name: `${metal.name} Price`, url: nationalUrl },
  { name: city.state_name, url: stateUrl },
  { name: `${city.city_name} ${metal.name} Price Today` }
])}

${priceHero({
  title: `${metal.name} Price in ${city.city_name} Today (${dateStr})`,
  price: priceDisplay,
  unit: 'per gram (${primaryVariant})',
  change: null,
  direction: changeDirection,
  subtitle: `Updated daily · Sourced from IBJA · ${city.city_name}, ${city.state_name}`,
  pills: [
    { value: cityCount, label: 'cities tracked' },
    { value: stateCount, label: 'states covered' },
    { value: 'IBJA', label: 'source' }
  ]
})}

${articleSchema({
  headline: `${metal.name} Price in ${city.city_name} Today – ${dateStr}`,
  description: `Current ${metal.name} price in ${city.city_name} is ${priceDisplay} per gram (${primaryVariant}) on ${dateStr}. Compare all variants and weights.`,
  datePublished: isoDate,
  publisherName: 'HDF News'
})}

<article>

<section>
<p style="font-size:15px;line-height:1.8;color:#374151;">
The <strong>${metal.name} price in ${city.city_name}</strong> today is <strong>${priceDisplay} per gram</strong> for ${primaryVariant} ${metal.name}, as reported by the IBJA (Indian Bullion and Jewellers Association) on <time datetime="${today.toISOString().split('T')[0]}">${dateStr}</time>. Prices are updated every morning and reflect the national benchmark rate applicable across India, including ${city.city_name}.
</p>
${sourceBadge('IBJA — Indian Bullion and Jewellers Association')}
</section>

<section>
${styledTable(
  `${metal.name} Price by Variant in ${city.city_name} — ${dateStr}`,
  ['Variant', 'Per Gram', 'Per 10 Grams'],
  variantRows,
  ['40%', '30%', '30%']
)}
</section>

${readAlsoBox('Read Also', `${metal.name} Price in ${city.state_name} — All Cities`, stateUrl)}

<section>
${styledTable(
  `${metal.name} Price by Weight in ${city.city_name}`,
  ['Weight', ...metal.variants.map(v => `${v} (₹)`)],
  weightRows
)}
${infoBox(`Prices shown above are calculated using today's IBJA benchmark rate for ${city.city_name}. Actual purchase prices at jewellers may include GST (3%) and making charges.`)}
</section>

${stateCities.length > 0 ? `
<section>
<h2 style="font-size:20px;font-weight:700;color:#111827;margin-top:28px;">Nearby Cities in ${city.state_name}</h2>
<p style="font-size:14px;color:#6b7280;margin-bottom:12px;">Compare ${metal.name} prices in cities near ${city.city_name} in ${city.state_name}:</p>
<div style="display:flex;flex-wrap:wrap;gap:8px;">
${stateCities.map(c => `<a href="#" style="background:#f3f4f6;border:1px solid #e5e7eb;border-radius:6px;padding:8px 14px;font-size:13px;color:#374151;text-decoration:none;font-weight:500;">${c.city_name}</a>`).join('')}
</div>
</section>
` : ''}

<section>
<h2 style="font-size:20px;font-weight:700;color:#111827;margin-top:28px;">Factors Affecting ${metal.name} Price in ${city.city_name}</h2>
<p style="font-size:14px;color:#374151;line-height:1.8;">Several factors influence the ${metal.name} price in ${city.city_name} and across India:</p>
<ul style="font-size:14px;color:#374151;line-height:2;padding-left:20px;">
  <li><strong>Global commodity prices</strong> — International ${metal.name} spot prices (USD/troy oz) directly impact Indian rates</li>
  <li><strong>USD/INR exchange rate</strong> — A weaker rupee makes imported ${metal.name} more expensive</li>
  <li><strong>Import duties &amp; GST</strong> — India levies import duty + 3% GST on ${metal.name} purchases</li>
  <li><strong>Demand seasonality</strong> — Festivals, weddings, and harvest seasons drive higher demand in India</li>
  <li><strong>Inflation &amp; interest rates</strong> — ${metal.name} is a safe-haven asset; demand rises during economic uncertainty</li>
</ul>
</section>

${faqSection(faqs)}

</article>
`.trim();

  return content;
}
```

### 2.3 `_buildStateContent(stateName, metalType, citiesWithPrices, nationalUrl)`

Replace body with:

```js
_buildStateContent(stateName, metalType, citiesWithPrices, nationalUrl) {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' });
  const metal = this.METAL_CONFIG[metalType];
  const primaryVariant = metal.variants[0];

  const validCities = citiesWithPrices.filter(c => c.prices && c.prices[primaryVariant]);
  const avgPrice = validCities.length
    ? Math.round(validCities.reduce((s,c) => s + c.prices[primaryVariant], 0) / validCities.length)
    : null;
  const avgDisplay = avgPrice ? `₹${avgPrice.toLocaleString('en-IN')}` : 'N/A';
  const minCity = validCities.reduce((a,b) => (!a || b.prices[primaryVariant] < a.prices[primaryVariant]) ? b : a, null);
  const maxCity = validCities.reduce((a,b) => (!a || b.prices[primaryVariant] > a.prices[primaryVariant]) ? b : a, null);

  const tableRows = validCities.map(c => [
    c.city_name,
    `₹${c.prices[primaryVariant].toLocaleString('en-IN')}`,
    metal.variants.slice(1).map(v => c.prices[v] ? `₹${c.prices[v].toLocaleString('en-IN')}` : '—').join(' / ') || '—'
  ]);

  const faqs = [
    {
      q: `What is the ${metal.name} price in ${stateName} today?`,
      a: `The average ${metal.name} (${primaryVariant}) price in ${stateName} today is <strong>${avgDisplay} per gram</strong> across ${validCities.length} cities, as of ${dateStr}.`
    },
    {
      q: `Which city has the cheapest ${metal.name} in ${stateName}?`,
      a: minCity ? `${minCity.city_name} has the lowest ${metal.name} price in ${stateName} today at ₹${minCity.prices[primaryVariant].toLocaleString('en-IN')} per gram.` : 'Price data is being updated.'
    },
    {
      q: `Is ${metal.name} price different across cities in ${stateName}?`,
      a: `${metal.name} prices across cities in ${stateName} are generally benchmarked to the IBJA national rate. Minor variations can occur due to local dealer margins and taxes.`
    }
  ];

  return `
${breadcrumbs([
  { name: 'Home', url: nationalUrl.replace(/\/[^/]+$/, '/') },
  { name: `${metal.name} Price`, url: nationalUrl },
  { name: `${stateName} ${metal.name} Price Today` }
])}

${priceHero({
  title: `${metal.name} Price in ${stateName} Today (${dateStr})`,
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
  headline: `${metal.name} Price in ${stateName} Today – ${dateStr}`,
  description: `${metal.name} price in ${stateName} today averages ${avgDisplay} per gram. Check rates in all ${validCities.length} cities in ${stateName}.`,
  datePublished: today.toISOString(),
  publisherName: 'HDF News'
})}

<article>

<section>
<p style="font-size:15px;line-height:1.8;color:#374151;">
The average <strong>${metal.name} price in ${stateName}</strong> today is <strong>${avgDisplay} per gram</strong> for ${primaryVariant} ${metal.name} as on <time datetime="${today.toISOString().split('T')[0]}">${dateStr}</time>. We track ${metal.name} rates across <strong>${validCities.length} cities in ${stateName}</strong>, sourced from the IBJA (Indian Bullion and Jewellers Association).
</p>
${sourceBadge('IBJA — Indian Bullion and Jewellers Association')}
</section>

${readAlsoBox('See Also', `${metal.name} Price in India Today — National Average`, nationalUrl)}

<section>
${styledTable(
  `${metal.name} Price in All Cities of ${stateName} — ${dateStr}`,
  ['City', `${primaryVariant} (per gram)`, metal.variants.length > 1 ? metal.variants.slice(1).join(' / ') + ' (per gram)' : 'Purity'],
  tableRows,
  ['45%', '28%', '27%']
)}
</section>

${faqSection(faqs)}

</article>
`.trim();
}
```

### 2.4 `_buildNationalContent(metalType, allCitiesWithPrices)`

Replace body with:

```js
_buildNationalContent(metalType, allCitiesWithPrices) {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' });
  const metal = this.METAL_CONFIG[metalType];
  const primaryVariant = metal.variants[0];

  const valid = allCitiesWithPrices.filter(c => c.prices && c.prices[primaryVariant]);
  const avgPrice = valid.length
    ? Math.round(valid.reduce((s,c) => s + c.prices[primaryVariant], 0) / valid.length)
    : null;
  const avgDisplay = avgPrice ? `₹${avgPrice.toLocaleString('en-IN')}` : 'N/A';
  const stateCount = [...new Set(valid.map(c => c.state_name))].length;

  // Group by state for the state summary table
  const byState = {};
  valid.forEach(c => {
    if (!byState[c.state_name]) byState[c.state_name] = { prices: [], cities: [] };
    byState[c.state_name].prices.push(c.prices[primaryVariant]);
    byState[c.state_name].cities.push(c.city_name);
  });
  const stateRows = Object.entries(byState).sort((a,b) => a[0].localeCompare(b[0])).map(([state, data]) => {
    const avg = Math.round(data.prices.reduce((s,p) => s+p, 0) / data.prices.length);
    return [state, `₹${avg.toLocaleString('en-IN')}`, data.cities.length.toString()];
  });

  // Weight table
  const weights = [1, 5, 8, 10, 100];
  const weightRows = weights.map(g => [
    `${g}g`,
    ...metal.variants.map(v => {
      const sample = valid.find(c => c.prices[v]);
      return sample ? `₹${(sample.prices[v] * g).toLocaleString('en-IN')}` : '—';
    })
  ]);

  const faqs = [
    {
      q: `What is the ${metal.name} price in India today (${dateStr})?`,
      a: `The national average ${metal.name} price in India today is <strong>${avgDisplay} per gram</strong> for ${primaryVariant} ${metal.name}, as reported by IBJA on ${dateStr}.`
    },
    {
      q: `How is ${metal.name} price determined in India?`,
      a: `${metal.name} prices in India are primarily benchmarked by IBJA (Indian Bullion and Jewellers Association). The rate is influenced by international spot prices, USD/INR exchange rate, import duty, and GST.`
    },
    {
      q: `Is ${metal.name} price the same across all states in India?`,
      a: `The IBJA benchmark rate is uniform across India. However, retail prices can vary slightly due to state-level taxes, dealer margins, and transportation costs.`
    },
    {
      q: `What is GST on ${metal.name} in India?`,
      a: `${metal.name} attracts 3% GST in India on the purchase price. Making charges on jewellery also attract 5% GST separately.`
    },
    {
      q: `When is ${metal.name} price updated?`,
      a: `${metal.name} prices are updated every morning (typically by 9:00 AM IST) based on the IBJA daily rate announcement, which tracks international commodity markets.`
    }
  ];

  return `
${priceHero({
  title: `${metal.name} Price in India Today (${dateStr})`,
  price: avgDisplay,
  unit: `avg per gram · ${primaryVariant}`,
  change: null,
  direction: 'none',
  subtitle: `Updated daily · Sourced from IBJA · ${valid.length} cities · ${stateCount} states tracked`,
  pills: [
    { value: valid.length, label: 'cities tracked' },
    { value: stateCount, label: 'states covered' },
    { value: 'Daily 9AM', label: 'update time' }
  ]
})}

${articleSchema({
  headline: `${metal.name} Price in India Today – ${dateStr}`,
  description: `National average ${metal.name} price today is ${avgDisplay} per gram. Check ${metal.name} rates across ${valid.length} cities in ${stateCount} states. Source: IBJA.`,
  datePublished: today.toISOString(),
  publisherName: 'HDF News'
})}

<article>

<section>
<p style="font-size:15px;line-height:1.8;color:#374151;">
The national average <strong>${metal.name} price in India</strong> today is <strong>${avgDisplay} per gram</strong> for ${primaryVariant} ${metal.name}, unchanged from yesterday. We track ${metal.name} rates across <strong>${valid.length} cities in ${stateCount} states</strong>, sourced from the IBJA (Indian Bullion and Jewellers Association).
</p>
${sourceBadge('IBJA — Indian Bullion and Jewellers Association')}
</section>

<section>
${styledTable(
  `${metal.name} Price by Variant — ${dateStr}`,
  ['Variant', 'Per Gram', 'Per 10 Grams'],
  metal.variants.map(v => {
    const sample = valid.find(c => c.prices[v]);
    const p = sample ? sample.prices[v] : null;
    return [v, p ? `₹${p.toLocaleString('en-IN')}` : '—', p ? `₹${(p*10).toLocaleString('en-IN')}` : '—'];
  }),
  ['40%', '30%', '30%']
)}
</section>

<section>
${styledTable(
  `${metal.name} Price by Weight in India`,
  ['Weight', ...metal.variants.map(v => `${v} (₹)`)],
  weightRows
)}
${infoBox(`Prices shown are based on IBJA benchmark rates. Add 3% GST for actual purchase price. Making charges are additional.`)}
</section>

<section>
${styledTable(
  `${metal.name} Price by State — ${dateStr}`,
  ['State', `Avg Price (${primaryVariant}/g)`, 'Cities Tracked'],
  stateRows,
  ['50%', '25%', '25%']
)}
</section>

${faqSection(faqs)}

</article>
`.trim();
}
```

---

## Part 3 — FuelPostCreator Full Rewrite (same pattern)

Rewrite `src/modules/fuel-post-creator.js`. Keep all method signatures.

### 3.1 Import helpers

```js
const {
  liveBadge, priceChangeBadge, statPills, sourceBadge,
  readAlsoBox, infoBox, styledTable, faqSection,
  articleSchema, breadcrumbs, priceHero
} = require('../utils/post-html');
```

### 3.2 `_buildCityContent(city, prices, stateInfo, stateUrl, nationalUrl)`

Replace body with:

```js
_buildCityContent(city, prices, stateInfo, stateUrl, nationalUrl) {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' });

  const petrol = prices.petrol ? `₹${prices.petrol.toFixed(2)}` : 'N/A';
  const diesel = prices.diesel ? `₹${prices.diesel.toFixed(2)}` : 'N/A';
  const cng = prices.cng ? `₹${prices.cng.toFixed(2)}` : null;
  const lpg = prices.lpg ? `₹${prices.lpg.toFixed(2)}` : null;

  const fuelRows = [
    ['Petrol', petrol, stateInfo ? `${stateInfo.vatPetrol || '—'}%` : '—'],
    ['Diesel', diesel, stateInfo ? `${stateInfo.vatDiesel || '—'}%` : '—'],
    ...(cng ? [['CNG', cng, '—']] : []),
    ...(lpg ? [['LPG (14.2kg)', lpg, '—']] : []),
  ];

  // Litres calculation rows
  const litreRows = [1, 5, 10, 15, 20, 50].map(l => [
    `${l}L`,
    prices.petrol ? `₹${(prices.petrol * l).toFixed(2)}` : '—',
    prices.diesel ? `₹${(prices.diesel * l).toFixed(2)}` : '—'
  ]);

  const faqs = [
    {
      q: `What is the petrol price in ${city.city_name} today (${dateStr})?`,
      a: `The petrol price in ${city.city_name} today is <strong>${petrol} per litre</strong> as on ${dateStr}.`
    },
    {
      q: `What is the diesel price in ${city.city_name} today?`,
      a: `The diesel price in ${city.city_name} today is <strong>${diesel} per litre</strong> as on ${dateStr}.`
    },
    {
      q: `Why is petrol price different in ${city.city_name} vs other cities?`,
      a: `Fuel prices in ${city.city_name} are determined by the base price set by OMCs (Oil Marketing Companies) plus state VAT (${stateInfo?.vatPetrol || 'varies'}%), local body taxes, freight charges, and dealer commission. Each state and city may have slightly different rates.`
    },
    {
      q: `When do fuel prices change in ${city.city_name}?`,
      a: `Petrol and diesel prices in ${city.city_name} are revised at 6:00 AM every day by oil marketing companies like Indian Oil, HPCL, and BPCL based on international crude oil prices and forex rates.`
    },
    {
      q: `How to check today's fuel price in ${city.city_name}?`,
      a: `You can check today's fuel price in ${city.city_name} on HDF News (updated daily), or SMS "RSP" to 9224992249 (HPCL), or use the My HPCL / Indian Oil One apps.`
    }
  ];

  return `
${breadcrumbs([
  { name: 'Home', url: nationalUrl.replace(/\/[^/]+$/, '/') },
  { name: 'Fuel Prices', url: nationalUrl },
  { name: stateInfo ? stateInfo.name : city.state_name, url: stateUrl },
  { name: `${city.city_name} Fuel Price Today` }
])}

${priceHero({
  title: `Petrol & Diesel Price in ${city.city_name} Today (${dateStr})`,
  price: petrol,
  unit: 'petrol per litre',
  change: null,
  direction: 'none',
  subtitle: `Updated at 6 AM daily · ${city.city_name}, ${stateInfo ? stateInfo.name : city.state_name}`,
  pills: [
    { value: petrol, label: 'Petrol/L' },
    { value: diesel, label: 'Diesel/L' },
    ...(cng ? [{ value: cng, label: 'CNG/kg' }] : []),
  ]
})}

${articleSchema({
  headline: `Petrol Diesel Price in ${city.city_name} Today – ${dateStr}`,
  description: `Today's petrol price in ${city.city_name} is ${petrol}/litre and diesel is ${diesel}/litre as on ${dateStr}. Check live fuel rates.`,
  datePublished: today.toISOString(),
  publisherName: 'HDF News'
})}

<article>

<section>
<p style="font-size:15px;line-height:1.8;color:#374151;">
The <strong>petrol price in ${city.city_name}</strong> today is <strong>${petrol} per litre</strong> and <strong>diesel price in ${city.city_name}</strong> is <strong>${diesel} per litre</strong> as on <time datetime="${today.toISOString().split('T')[0]}">${dateStr}</time>. Prices are revised at 6:00 AM daily by Oil Marketing Companies (OMCs) based on international crude oil rates.
</p>
${sourceBadge('IOCL / HPCL / BPCL — Oil Marketing Companies')}
</section>

<section>
${styledTable(
  `Fuel Prices in ${city.city_name} — ${dateStr}`,
  ['Fuel Type', 'Price per Litre/Unit', `State VAT`],
  fuelRows,
  ['45%', '30%', '25%']
)}
</section>

${readAlsoBox('Read Also', `Petrol & Diesel Price in ${stateInfo ? stateInfo.name : city.state_name} — All Cities`, stateUrl)}

<section>
${styledTable(
  `Petrol & Diesel Cost Calculator for ${city.city_name}`,
  ['Volume', 'Petrol Cost', 'Diesel Cost'],
  litreRows,
  ['33%', '33%', '34%']
)}
${infoBox(`Prices above are calculated at today's ${city.city_name} rates. Actual pump prices may vary by ±₹0.10 due to rounding. Prices include all taxes and dealer commissions.`)}
</section>

${stateInfo ? `
<section>
<h2 style="font-size:20px;font-weight:700;color:#111827;margin-top:28px;">About Fuel Prices in ${stateInfo.name}</h2>
<p style="font-size:14px;color:#374151;line-height:1.8;">
${stateInfo.name} levies a VAT of <strong>${stateInfo.vatPetrol || '—'}%</strong> on petrol and <strong>${stateInfo.vatDiesel || '—'}%</strong> on diesel. 
${stateInfo.transportNote ? stateInfo.transportNote : ''}
${stateInfo.region ? `${city.city_name} is located in the ${stateInfo.region} region of India.` : ''}
</p>
</section>
` : ''}

${faqSection(faqs)}

</article>
`.trim();
}
```

### 3.3 `_buildStateContent(stateName, stateInfo, citiesWithPrices, nationalUrl)`

Replace body with:

```js
_buildStateContent(stateName, stateInfo, citiesWithPrices, nationalUrl) {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' });

  const valid = citiesWithPrices.filter(c => c.prices && (c.prices.petrol || c.prices.diesel));
  const avgPetrol = valid.filter(c => c.prices.petrol).length
    ? (valid.filter(c => c.prices.petrol).reduce((s,c) => s + c.prices.petrol, 0) / valid.filter(c => c.prices.petrol).length).toFixed(2)
    : null;
  const avgDiesel = valid.filter(c => c.prices.diesel).length
    ? (valid.filter(c => c.prices.diesel).reduce((s,c) => s + c.prices.diesel, 0) / valid.filter(c => c.prices.diesel).length).toFixed(2)
    : null;

  const tableRows = valid.sort((a,b) => a.city_name.localeCompare(b.city_name)).map(c => [
    c.city_name,
    c.prices.petrol ? `₹${c.prices.petrol.toFixed(2)}` : '—',
    c.prices.diesel ? `₹${c.prices.diesel.toFixed(2)}` : '—',
    c.prices.cng ? `₹${c.prices.cng.toFixed(2)}` : '—'
  ]);

  const faqs = [
    {
      q: `What is the petrol price in ${stateName} today?`,
      a: `The average petrol price in ${stateName} today is <strong>₹${avgPetrol}/litre</strong> across ${valid.length} cities, as on ${dateStr}.`
    },
    {
      q: `What is VAT on petrol in ${stateName}?`,
      a: stateInfo
        ? `${stateName} charges ${stateInfo.vatPetrol}% VAT on petrol and ${stateInfo.vatDiesel}% VAT on diesel.`
        : `Fuel VAT rates vary in ${stateName}. Check the state's commercial tax department for the latest rates.`
    },
    {
      q: `Which city has the cheapest petrol in ${stateName}?`,
      a: `Petrol prices across ${stateName} are generally uniform as they depend on the same state VAT rate. Minor differences can occur due to local body taxes.`
    }
  ];

  return `
${breadcrumbs([
  { name: 'Home', url: nationalUrl.replace(/\/[^/]+$/, '/') },
  { name: 'Fuel Prices', url: nationalUrl },
  { name: `${stateName} Fuel Prices Today` }
])}

${priceHero({
  title: `Petrol & Diesel Price in ${stateName} Today (${dateStr})`,
  price: avgPetrol ? `₹${avgPetrol}` : 'N/A',
  unit: 'avg petrol per litre',
  change: null,
  direction: 'none',
  subtitle: `${valid.length} cities tracked in ${stateName} · Updated 6 AM daily`,
  pills: [
    { value: avgPetrol ? `₹${avgPetrol}` : '—', label: 'Avg Petrol/L' },
    { value: avgDiesel ? `₹${avgDiesel}` : '—', label: 'Avg Diesel/L' },
    { value: valid.length, label: 'cities' }
  ]
})}

${articleSchema({
  headline: `Petrol Diesel Price in ${stateName} Today – ${dateStr}`,
  description: `Today's average petrol price in ${stateName} is ₹${avgPetrol}/litre. Check fuel rates in all ${valid.length} cities in ${stateName} on ${dateStr}.`,
  datePublished: today.toISOString(),
  publisherName: 'HDF News'
})}

<article>

<section>
<p style="font-size:15px;line-height:1.8;color:#374151;">
The average <strong>petrol price in ${stateName}</strong> today is <strong>₹${avgPetrol} per litre</strong> and diesel is <strong>₹${avgDiesel} per litre</strong> as on <time datetime="${today.toISOString().split('T')[0]}">${dateStr}</time>. We track live fuel prices in <strong>${valid.length} cities across ${stateName}</strong>.
</p>
${sourceBadge('IOCL / HPCL / BPCL — Oil Marketing Companies')}
</section>

${readAlsoBox('See Also', `Petrol & Diesel Price in India Today — National Rates`, nationalUrl)}

<section>
${styledTable(
  `Petrol & Diesel Price in All Cities of ${stateName} — ${dateStr}`,
  ['City', 'Petrol (₹/L)', 'Diesel (₹/L)', 'CNG (₹/kg)'],
  tableRows,
  ['40%', '20%', '20%', '20%']
)}
</section>

${faqSection(faqs)}

</article>
`.trim();
}
```

### 3.4 `_buildNationalContent(allCitiesWithPrices)`

Replace body with:

```js
_buildNationalContent(allCitiesWithPrices) {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-IN', { day:'numeric', month:'long', year:'numeric' });

  const valid = allCitiesWithPrices.filter(c => c.prices && c.prices.petrol);
  const avgPetrol = valid.length
    ? (valid.reduce((s,c) => s + c.prices.petrol, 0) / valid.length).toFixed(2)
    : null;
  const validDiesel = allCitiesWithPrices.filter(c => c.prices && c.prices.diesel);
  const avgDiesel = validDiesel.length
    ? (validDiesel.reduce((s,c) => s + c.prices.diesel, 0) / validDiesel.length).toFixed(2)
    : null;
  const stateCount = [...new Set(valid.map(c => c.state_name))].length;

  // State summary
  const byState = {};
  valid.forEach(c => {
    if (!byState[c.state_name]) byState[c.state_name] = { petrol: [], diesel: [], cities: 0 };
    byState[c.state_name].petrol.push(c.prices.petrol);
    byState[c.state_name].diesel.push(c.prices.diesel || 0);
    byState[c.state_name].cities++;
  });
  const stateRows = Object.entries(byState).sort((a,b) => a[0].localeCompare(b[0])).map(([state, data]) => {
    const avg = (data.petrol.reduce((s,p) => s+p,0) / data.petrol.length).toFixed(2);
    const avgD = data.diesel.filter(Boolean).length ? (data.diesel.filter(Boolean).reduce((s,p)=>s+p,0)/data.diesel.filter(Boolean).length).toFixed(2) : '—';
    return [state, `₹${avg}`, `₹${avgD}`, data.cities.toString()];
  });

  const faqs = [
    {
      q: `What is the petrol price in India today (${dateStr})?`,
      a: `The national average petrol price in India today is <strong>₹${avgPetrol} per litre</strong> across ${valid.length} cities, as on ${dateStr}.`
    },
    {
      q: `What is the diesel price in India today?`,
      a: `The national average diesel price in India today is <strong>₹${avgDiesel} per litre</strong> across major cities, as on ${dateStr}.`
    },
    {
      q: `Why do petrol prices differ across Indian states?`,
      a: `Petrol prices vary across states due to different VAT rates, local body taxes, and freight charges. States like Rajasthan and Maharashtra have higher VAT, leading to higher pump prices.`
    },
    {
      q: `When are fuel prices updated in India?`,
      a: `Oil Marketing Companies (IOCL, HPCL, BPCL) revise petrol and diesel prices at 6:00 AM IST every day, based on the 15-day average of international crude oil prices and USD/INR rates.`
    },
    {
      q: `Which state has the cheapest petrol in India?`,
      a: `States with lower VAT rates like Goa, Andaman & Nicobar Islands, and some northeastern states tend to have cheaper petrol. The difference can be ₹5–₹15 per litre compared to high-VAT states.`
    }
  ];

  return `
${priceHero({
  title: `Petrol & Diesel Price in India Today (${dateStr})`,
  price: avgPetrol ? `₹${avgPetrol}` : 'N/A',
  unit: 'avg petrol per litre',
  change: null,
  direction: 'none',
  subtitle: `${valid.length} cities · ${stateCount} states tracked · Updated 6 AM IST daily`,
  pills: [
    { value: avgPetrol ? `₹${avgPetrol}` : '—', label: 'Avg Petrol/L' },
    { value: avgDiesel ? `₹${avgDiesel}` : '—', label: 'Avg Diesel/L' },
    { value: valid.length, label: 'cities' },
    { value: stateCount, label: 'states' }
  ]
})}

${articleSchema({
  headline: `Petrol Diesel Price in India Today – ${dateStr}`,
  description: `Today's national average petrol price in India is ₹${avgPetrol}/litre. Check state-wise and city-wise fuel prices across ${valid.length} cities and ${stateCount} states.`,
  datePublished: today.toISOString(),
  publisherName: 'HDF News'
})}

<article>

<section>
<p style="font-size:15px;line-height:1.8;color:#374151;">
The national average <strong>petrol price in India</strong> today is <strong>₹${avgPetrol} per litre</strong> and <strong>diesel price</strong> is <strong>₹${avgDiesel} per litre</strong> as on <time datetime="${today.toISOString().split('T')[0]}">${dateStr}</time>. Fuel prices are revised at 6:00 AM daily by Oil Marketing Companies based on international crude oil markets and USD/INR exchange rates. We track live fuel rates across <strong>${valid.length} cities in ${stateCount} states</strong>.
</p>
${sourceBadge('IOCL / HPCL / BPCL — Oil Marketing Companies')}
</section>

<section>
${styledTable(
  `State-wise Petrol & Diesel Price in India — ${dateStr}`,
  ['State', 'Avg Petrol (₹/L)', 'Avg Diesel (₹/L)', 'Cities Tracked'],
  stateRows,
  ['40%', '20%', '20%', '20%']
)}
</section>

${faqSection(faqs)}

</article>
`.trim();
}
```

---

## Part 4 — Wire Price Change Direction

In both `FuelModule.runDailyFetch()` and `MetalsModule.runDailyFetch()`, after saving new prices, compare to previous day's prices:

- When saving a new price to the DB, also check the previous row for that city/metal
- Pass a `change` value and `direction` ('up'|'down'|'none') into the post creator methods
- Update the post creator method signatures to accept an optional `{ petrolChange, dieselChange }` / `{ priceChange }` parameter
- Pass these into `priceHero()` and `priceChangeBadge()` calls

This can be done in a follow-up; for now the hero defaults to `direction: 'none'` which is safe.

---

## Part 5 — Post Title Improvements

Update post title generation in both creators to include the date:

```js
// City post title
`Petrol & Diesel Price in ${city.city_name} Today (${dateStr}) — Per Litre`
`${metal.name} Price in ${city.city_name} Today (${dateStr}) — Per Gram`

// State post title
`Petrol & Diesel Price in ${stateName} Today (${dateStr}) — All Cities`
`${metal.name} Price in ${stateName} Today (${dateStr}) — All Cities`

// National post title
`Petrol & Diesel Price in India Today (${dateStr}) — State-wise Rates`
`${metal.name} Price in India Today (${dateStr}) — All States`
```

Update the `getPostTitle()` or equivalent method in each creator class.

---

## Part 6 — Testing

After implementation:

1. Call `POST /api/metals/fetch-test` (5 cities only)
2. Call `POST /api/metals/publish-test` or trigger one city post manually via the dashboard
3. View the published post on WordPress and verify:
   - Dark price hero card renders at top ✓
   - LIVE blinking badge visible ✓
   - Stat pills visible ✓
   - Both tables render and hover correctly ✓
   - FAQ section with proper Q&A ✓
   - JSON-LD schema present in page source ✓
   - Breadcrumb nav visible ✓
4. Check Google's Rich Results Test: https://search.google.com/test/rich-results
   - Paste the post URL → should show FAQPage + NewsArticle structured data valid ✓

---

## Summary of Files to Create/Modify

| File | Action |
|------|--------|
| `src/utils/post-html.js` | **CREATE** — shared HTML utility functions |
| `src/modules/metals-post-creator.js` | **MODIFY** — import helpers, rewrite all 3 `_build*Content()` methods |
| `src/modules/fuel-post-creator.js` | **MODIFY** — import helpers, rewrite all 3 `_build*Content()` methods |

No changes needed to: routes, cron, WP publisher, DB schema, or settings.
