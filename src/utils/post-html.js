'use strict';

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
