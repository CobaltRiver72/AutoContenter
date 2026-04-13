# POST POLISH PROMPT — UI/UX CLEANUP + CONTENT COMPLETION

Feed this entire prompt to your AI IDE assistant.

---

## What Needs Fixing

Looking at the current live posts, four things remain:

1. **Duplicate breadcrumb** — theme renders one at top, our code adds a second inside post content. Remove ours.
2. **Hero title is lowercase** — "gold price in Bangalore" → "Gold Price in Bangalore"
3. **Missing content sections** — posts have hero + one paragraph + READ ALSO, then nothing. Need: variants table, state cities table, FAQ.
4. **Missing JSON-LD schema** — no Article or FAQPage structured data. Required for Google rich results.

---

## Fix 1 — Remove Duplicate Breadcrumb

In `src/modules/metals-post-creator.js` and `src/modules/fuel-post-creator.js`:

**Delete** the entire `<nav class="hdf-breadcrumb">...</nav>` block from ALL `_build*Content()` methods (city, state, national).

The WordPress theme already renders the correct breadcrumb. Ours is redundant and confusing.

---

## Fix 2 — Hero Title Capitalisation

In `hdf-widgets.js`, find the `national` and `price-box` widget renderers. Change:

```js
// BEFORE
`${metal || fuel} price in ${city}`

// AFTER  
const titleMetal = (metal || fuel || '').replace(/\b\w/g, c => c.toUpperCase());
`${titleMetal} Price in ${city}`
```

Also fix the `renderHero()` call in `price-box` widget:

```js
// BEFORE
title: `${metal || fuel} price in ${city}`,

// AFTER
title: `${titleMetal} Price in ${city}`,
```

---

## Fix 3 — Add Missing Content Sections to Metals Post Creator

In `src/modules/metals-post-creator.js`, update `_buildCityContent()` to include all sections after the hero widget.

Replace the current `_buildCityContent()` return value with this complete structure:

```js
_buildCityContent(city, metalType, prices, allCities, stateUrl, nationalUrl) {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const isoDate = today.toISOString().split('T')[0];
  const metal = this.METAL_CONFIG[metalType];
  const primaryVariant = metal.variants[0];
  const primaryPrice = prices[primaryVariant];
  const priceDisplay = primaryPrice ? `₹${primaryPrice.toLocaleString('en-IN')}` : 'N/A';
  const cityCount = allCities.length;
  const stateCount = [...new Set(allCities.map(c => c.state_name))].length;

  // Build static variants table rows (SEO snapshot inside widget)
  const variantRows = metal.variants.map(v => {
    const p = prices[v];
    const per10 = p ? `₹${(p * 10).toLocaleString('en-IN')}` : '—';
    return `<tr><td>${v} ${metal.name}</td><td>${p ? `₹${p.toLocaleString('en-IN')}` : '—'}</td><td>${per10}</td></tr>`;
  }).join('');

  // Static nearby cities (SEO snapshot)
  const nearbyCities = allCities
    .filter(c => c.state_name === city.state_name && c.city_name !== city.city_name)
    .slice(0, 8);
  const nearbyRows = nearbyCities.map(c => {
    const p = prices[primaryVariant];
    return `<tr><td>${c.city_name}</td><td>${p ? `₹${p.toLocaleString('en-IN')}` : '—'}</td></tr>`;
  }).join('');

  // FAQ data
  const faqs = [
    {
      q: `What is ${metal.name} price in ${city.city_name} today?`,
      a: `The ${metal.name} (${primaryVariant}) price in ${city.city_name} today is ${priceDisplay} per gram as on ${dateStr}, sourced from IBJA.`
    },
    {
      q: `Is ${metal.name} price the same across all cities in ${city.state_name}?`,
      a: `The IBJA benchmark rate is uniform nationally. Minor variations can occur at local jewellers due to dealer margins and local body taxes.`
    },
    {
      q: `Why does ${metal.name} price change daily?`,
      a: `${metal.name} prices change due to international commodity markets, USD/INR exchange rates, import duties, and RBI monetary policy decisions.`
    },
    {
      q: `What is GST on ${metal.name} in India?`,
      a: `${metal.name} attracts 3% GST in India on the purchase price. Making charges on jewellery attract an additional 5% GST.`
    },
    {
      q: `Where to buy ${metal.name} in ${city.city_name}?`,
      a: `Buy ${metal.name} at BIS-hallmarked jewellers, bank branches, India Post Gold, or reputed platforms like Tanishq, Malabar Gold, or Joyalukkas. Always check for BIS 916/999 hallmark.`
    }
  ];

  const faqJsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": faqs.map(f => ({
      "@type": "Question",
      "name": f.q,
      "acceptedAnswer": { "@type": "Answer", "text": f.a }
    }))
  });

  const articleJsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    "headline": `${metal.name} Price in ${city.city_name} Today — ${dateStr}`,
    "description": `${metal.name} price in ${city.city_name} today is ${priceDisplay} per gram (${primaryVariant}) on ${dateStr}. Check all variants and nearby cities. Source: IBJA.`,
    "datePublished": today.toISOString(),
    "dateModified": today.toISOString(),
    "author": { "@type": "Organization", "name": "HDF News" },
    "publisher": { "@type": "Organization", "name": "HDF News" }
  });

  return `
<script type="application/ld+json">${articleJsonLd}</script>
<script type="application/ld+json">${faqJsonLd}</script>

<div data-hdf="price-box" data-module="metals" data-city="${city.city_name}" data-metal="${metalType}">
  <p><strong>${metal.name} price in ${city.city_name} today</strong> is <strong>${priceDisplay} per gram</strong> (${primaryVariant}) as on ${dateStr}. Source: IBJA.</p>
</div>

<article>

<p>The <strong>${metal.name} price in ${city.city_name}</strong> today is <strong>${priceDisplay} per gram</strong> for ${primaryVariant} ${metal.name} as on <time datetime="${isoDate}">${dateStr}</time>, sourced from IBJA (Indian Bullion and Jewellers Association). We track ${metal.name} prices daily across <strong>${cityCount} cities in ${stateCount} states</strong>.</p>

<span class="hdf-source">📊 Source: IBJA — Indian Bullion and Jewellers Association</span>

<h2>${metal.name} Price by Variant in ${city.city_name} — ${dateStr}</h2>

<div data-hdf="price-table" data-module="metals" data-state="${city.state_name}" data-metal="${metalType}">
  <div class="hdf-table-wrap">
    <table class="hdf-table">
      <caption>${metal.name} variants in ${city.city_name} today</caption>
      <thead><tr><th>Variant</th><th>Per Gram</th><th>Per 10 Grams</th></tr></thead>
      <tbody>${variantRows}</tbody>
    </table>
  </div>
</div>

<div class="hdf-callout">
  <div class="hdf-callout-label">Read Also</div>
  <a href="${stateUrl}">${metal.name} Price in ${city.state_name} Today — All Cities (${dateStr})</a>
</div>

<h2>${metal.name} Price in Cities Near ${city.city_name} — ${city.state_name}</h2>

<div data-hdf="price-table" data-module="metals" data-state="${city.state_name}" data-metal="${metalType}">
  <div class="hdf-table-wrap">
    <table class="hdf-table">
      <caption>${metal.name} price in ${city.state_name} cities</caption>
      <thead><tr><th>City</th><th>${primaryVariant} (per gram)</th></tr></thead>
      <tbody>${nearbyRows}</tbody>
    </table>
  </div>
</div>

<div class="hdf-info">💡 Prices shown are IBJA benchmark rates. Actual purchase price at jewellers includes 3% GST and making charges. Always verify before purchase.</div>

<h2>Factors Affecting ${metal.name} Price in ${city.city_name}</h2>
<p>The <strong>${metal.name} price in ${city.city_name}</strong> is influenced by the same national factors that drive rates across India — international commodity spot prices (USD/troy oz), the USD/INR exchange rate, import duty (currently 15%), and 3% GST. Local jeweller margins and seasonal demand during festivals and weddings can add minor premiums above the IBJA benchmark.</p>

<section class="hdf-faq" itemscope itemtype="https://schema.org/FAQPage">
<h2>Frequently Asked Questions</h2>
${faqs.map(f => `
<div class="hdf-faq-item" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question">
  <h3 itemprop="name">${f.q}</h3>
  <div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer">
    <p itemprop="text">${f.a}</p>
  </div>
</div>`).join('')}
</section>

</article>`.trim();
}
```

---

## Fix 4 — State Post Content

Replace `_buildStateContent()` in `metals-post-creator.js`:

```js
_buildStateContent(stateName, metalType, citiesWithPrices, nationalUrl) {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const isoDate = today.toISOString().split('T')[0];
  const metal = this.METAL_CONFIG[metalType];
  const primaryVariant = metal.variants[0];

  const valid = citiesWithPrices.filter(c => c.prices && c.prices[primaryVariant]);
  const avgPrice = valid.length
    ? Math.round(valid.reduce((s, c) => s + c.prices[primaryVariant], 0) / valid.length)
    : null;
  const avgDisplay = avgPrice ? `₹${avgPrice.toLocaleString('en-IN')}` : 'N/A';

  // Static city rows for SEO
  const cityRows = valid.sort((a, b) => a.city_name.localeCompare(b.city_name)).map(c => {
    const p = c.prices[primaryVariant];
    return `<tr><td>${c.city_name}</td><td>₹${p.toLocaleString('en-IN')}</td></tr>`;
  }).join('');

  const faqs = [
    {
      q: `What is ${metal.name} price in ${stateName} today?`,
      a: `The average ${metal.name} (${primaryVariant}) price in ${stateName} today is ${avgDisplay} per gram as on ${dateStr}, tracked across ${valid.length} cities.`
    },
    {
      q: `Which city has the cheapest ${metal.name} in ${stateName}?`,
      a: `${metal.name} prices across ${stateName} are benchmarked to the IBJA national rate. Minor differences between cities occur due to local dealer margins.`
    },
    {
      q: `Is ${metal.name} price in ${stateName} different from other states?`,
      a: `The IBJA rate is uniform nationally. State-level differences arise only from local body taxes or dealer premiums, typically within ₹50–₹100 per gram.`
    }
  ];

  const articleJsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    "headline": `${metal.name} Price in ${stateName} Today — ${dateStr}`,
    "description": `${metal.name} price in ${stateName} today averages ${avgDisplay} per gram. Check rates in all ${valid.length} cities in ${stateName}.`,
    "datePublished": today.toISOString(),
    "dateModified": today.toISOString(),
    "author": { "@type": "Organization", "name": "HDF News" },
    "publisher": { "@type": "Organization", "name": "HDF News" }
  });

  const faqJsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": faqs.map(f => ({
      "@type": "Question", "name": f.q,
      "acceptedAnswer": { "@type": "Answer", "text": f.a }
    }))
  });

  return `
<script type="application/ld+json">${articleJsonLd}</script>
<script type="application/ld+json">${faqJsonLd}</script>

<div data-hdf="national" data-module="metals" data-metal="${metalType}">
  <p>Average <strong>${metal.name} price in ${stateName}</strong> today is <strong>${avgDisplay} per gram</strong> (${primaryVariant}) as on ${dateStr}. Source: IBJA.</p>
</div>

<article>

<p>The average <strong>${metal.name} price in ${stateName}</strong> today is <strong>${avgDisplay} per gram</strong> for ${primaryVariant} ${metal.name} as on <time datetime="${isoDate}">${dateStr}</time>. We track ${metal.name} rates across <strong>${valid.length} cities in ${stateName}</strong>, sourced from IBJA.</p>

<span class="hdf-source">📊 Source: IBJA — Indian Bullion and Jewellers Association</span>

<div class="hdf-callout">
  <div class="hdf-callout-label">See Also</div>
  <a href="${nationalUrl}">${metal.name} Price in India Today — National Average (${dateStr})</a>
</div>

<h2>${metal.name} Price in All Cities of ${stateName} — ${dateStr}</h2>

<div data-hdf="price-table" data-module="metals" data-state="${stateName}" data-metal="${metalType}">
  <div class="hdf-table-wrap">
    <table class="hdf-table">
      <caption>${metal.name} price in ${stateName} — all cities</caption>
      <thead><tr><th>City</th><th>${primaryVariant} (per gram)</th></tr></thead>
      <tbody>${cityRows}</tbody>
    </table>
  </div>
</div>

<section class="hdf-faq" itemscope itemtype="https://schema.org/FAQPage">
<h2>Frequently Asked Questions</h2>
${faqs.map(f => `
<div class="hdf-faq-item" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question">
  <h3 itemprop="name">${f.q}</h3>
  <div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer">
    <p itemprop="text">${f.a}</p>
  </div>
</div>`).join('')}
</section>

</article>`.trim();
}
```

---

## Fix 5 — National Post Content

Replace `_buildNationalContent()` in `metals-post-creator.js`:

```js
_buildNationalContent(metalType, allCitiesWithPrices) {
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const isoDate = today.toISOString().split('T')[0];
  const metal = this.METAL_CONFIG[metalType];
  const primaryVariant = metal.variants[0];

  const valid = allCitiesWithPrices.filter(c => c.prices && c.prices[primaryVariant]);
  const avgPrice = valid.length
    ? Math.round(valid.reduce((s, c) => s + c.prices[primaryVariant], 0) / valid.length)
    : null;
  const avgDisplay = avgPrice ? `₹${avgPrice.toLocaleString('en-IN')}` : 'N/A';
  const stateCount = [...new Set(valid.map(c => c.state_name))].length;

  // State summary rows
  const byState = {};
  valid.forEach(c => {
    if (!byState[c.state_name]) byState[c.state_name] = [];
    byState[c.state_name].push(c.prices[primaryVariant]);
  });
  const stateRows = Object.entries(byState)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([state, prices]) => {
      const avg = Math.round(prices.reduce((s, p) => s + p, 0) / prices.length);
      return `<tr><td>${state}</td><td>₹${avg.toLocaleString('en-IN')}</td><td>${prices.length}</td></tr>`;
    }).join('');

  const faqs = [
    {
      q: `What is ${metal.name} price in India today (${dateStr})?`,
      a: `The national average ${metal.name} (${primaryVariant}) price in India today is ${avgDisplay} per gram as on ${dateStr}, sourced from IBJA.`
    },
    {
      q: `How is ${metal.name} price set in India?`,
      a: `${metal.name} prices in India are benchmarked by IBJA (Indian Bullion and Jewellers Association) based on international spot prices, USD/INR exchange rate, import duty, and GST.`
    },
    {
      q: `What is the best time to buy ${metal.name} in India?`,
      a: `${metal.name} prices tend to be lower in non-festive periods (February–March, July–August). However, ${metal.name} is primarily a long-term store of value — timing short-term fluctuations is difficult.`
    },
    {
      q: `What is GST on ${metal.name} in India?`,
      a: `${metal.name} attracts 3% GST in India. Making charges attract an additional 5% GST. Import duty is currently 15%.`
    },
    {
      q: `How often is ${metal.name} price updated in India?`,
      a: `IBJA updates ${metal.name} rates every morning. International spot prices change continuously — Indian rates reflect the morning fix based on overnight global markets.`
    }
  ];

  const articleJsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    "headline": `${metal.name} Price in India Today — ${dateStr}`,
    "description": `National average ${metal.name} price in India today is ${avgDisplay} per gram. Check state-wise rates across ${valid.length} cities and ${stateCount} states.`,
    "datePublished": today.toISOString(),
    "dateModified": today.toISOString(),
    "author": { "@type": "Organization", "name": "HDF News" },
    "publisher": { "@type": "Organization", "name": "HDF News" }
  });

  const faqJsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "FAQPage",
    "mainEntity": faqs.map(f => ({
      "@type": "Question", "name": f.q,
      "acceptedAnswer": { "@type": "Answer", "text": f.a }
    }))
  });

  return `
<script type="application/ld+json">${articleJsonLd}</script>
<script type="application/ld+json">${faqJsonLd}</script>

<div data-hdf="national" data-module="metals" data-metal="${metalType}">
  <p>National average <strong>${metal.name} price in India</strong> today is <strong>${avgDisplay} per gram</strong> (${primaryVariant}) as on ${dateStr}. Source: IBJA.</p>
</div>

<article>

<p>The national average <strong>${metal.name} price in India</strong> today is <strong>${avgDisplay} per gram</strong> for ${primaryVariant} ${metal.name} as on <time datetime="${isoDate}">${dateStr}</time>. We track ${metal.name} rates across <strong>${valid.length} cities in ${stateCount} states</strong>, sourced from IBJA (Indian Bullion and Jewellers Association).</p>

<span class="hdf-source">📊 Source: IBJA — Indian Bullion and Jewellers Association</span>

<h2>${metal.name} Price by State in India — ${dateStr}</h2>

<div data-hdf="ranking" data-module="metals" data-metal="${metalType}" data-sort="asc" data-limit="30" data-label="State-wise ${metal.name} Price in India Today">
  <div class="hdf-table-wrap">
    <table class="hdf-table">
      <caption>${metal.name} price across Indian states</caption>
      <thead><tr><th>State</th><th>Avg Price (per gram)</th><th>Cities Tracked</th></tr></thead>
      <tbody>${stateRows}</tbody>
    </table>
  </div>
</div>

<h2>Top 10 Cities with Cheapest ${metal.name} in India Today</h2>

<div data-hdf="ranking" data-module="metals" data-metal="${metalType}" data-sort="asc" data-limit="10" data-label="Cheapest ${metal.name} Cities in India — ${dateStr}">
  <p>Loading cheapest ${metal.name} cities...</p>
</div>

<div class="hdf-info">💡 ${metal.name} prices shown are IBJA benchmark rates. Actual purchase price includes 3% GST and making charges. Rates are updated every morning.</div>

<section class="hdf-faq" itemscope itemtype="https://schema.org/FAQPage">
<h2>Frequently Asked Questions</h2>
${faqs.map(f => `
<div class="hdf-faq-item" itemscope itemprop="mainEntity" itemtype="https://schema.org/Question">
  <h3 itemprop="name">${f.q}</h3>
  <div itemscope itemprop="acceptedAnswer" itemtype="https://schema.org/Answer">
    <p itemprop="text">${f.a}</p>
  </div>
</div>`).join('')}
</section>

</article>`.trim();
}
```

---

## Fix 6 — Apply Same Pattern to Fuel Post Creator

In `src/modules/fuel-post-creator.js`, apply the exact same fixes:

1. **Remove** all `<nav class="hdf-breadcrumb">` blocks from all three `_build*Content()` methods
2. **Add** `articleJsonLd` and `faqJsonLd` `<script>` blocks at the top of each post
3. **Add** FAQ section at the bottom of each post using `.hdf-faq` / `.hdf-faq-item` classes
4. **Add** a second `data-hdf="price-table"` widget for nearby cities (state cities) in city posts
5. **Add** `<div class="hdf-info">` note about prices including taxes

Use the same FAQ structure as metals but with fuel-appropriate questions:
```js
const faqs = [
  { q: `What is petrol price in ${city.city_name} today?`, a: `...` },
  { q: `What is diesel price in ${city.city_name} today?`, a: `...` },
  { q: `Why do fuel prices differ across cities?`, a: `...` },
  { q: `When are fuel prices revised in India?`, a: `Fuel prices are revised at 6:00 AM IST daily by IOCL, HPCL, and BPCL based on 15-day average crude oil prices and USD/INR rates.` },
  { q: `How to check today's fuel price in ${city.city_name}?`, a: `Check today's ${city.city_name} fuel price on this page (updated daily), or SMS RSP to 9224992249 (HPCL), or use the Indian Oil One or My HPCL app.` },
];
```

---

## Fix 7 — Update hdf-widgets.js Hero Title

In `public/wp-assets/hdf-widgets.js`, find the `price-box` widget handler and fix title casing:

```js
async 'price-box'(el) {
  const { module, city, metal, fuel } = el.dataset;
  const data = await fetchData('price', { module, city, metal: metal || fuel });
  const price = module === 'metals' ? fmt(data.price_per_gram) : fmt(data.price);
  const unit = module === 'metals' ? 'per gram' : 'per litre';
  
  // Fix: proper title case
  const metalLabel = (metal || fuel || '').charAt(0).toUpperCase() + (metal || fuel || '').slice(1);
  const cityLabel = city.split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  
  el.innerHTML = renderHero(
    `${metalLabel} Price in ${cityLabel}`,
    price, unit,
    [{ value: price, label: unit }, { value: data.state_name, label: '' }],
    `Updated ${timeAgo(data.fetched_at)}`
  );
},
```

---

## Summary

| File | Changes |
|------|---------|
| `src/modules/metals-post-creator.js` | Remove breadcrumbs · Add JSON-LD · Add variants table widget · Add FAQ |
| `src/modules/fuel-post-creator.js` | Remove breadcrumbs · Add JSON-LD · Add FAQ |
| `public/wp-assets/hdf-widgets.js` | Fix title capitalisation in price-box widget |

**After deploying:** Republish a few posts from the dashboard to regenerate content, then check Google Rich Results Test (https://search.google.com/test/rich-results) with any post URL — should show FAQPage + NewsArticle passing.
