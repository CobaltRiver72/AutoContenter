/* ================================================================
   Site Home (Overview) — vanilla JS port of design/jsx/site-home.jsx.
   Takes over #page-overview. All rendering goes via innerHTML + delegated
   `data-click=` handlers registered in dashboard.js CLICK_ACTIONS.
   Reads from existing endpoints where possible (§A in WIRING-overview.md);
   fields that need new endpoints (activity trend, quality avg, etc.) show
   fallback placeholders until those pipelines land.
   ================================================================ */

(function () {
  'use strict';

  // ─── Inline SVG icons (subset used by Site Home) ───────────────────────
  var SVG_PATHS = {
    check:    '<path d="m5 12 5 5L20 7"/>',
    cluster:  '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8 6h8M6 8v8M18 8v8M8 18h8"/>',
    sparkles: '<path d="M12 3v18M3 12h18" opacity="0.3"/><path d="M12 3 14 9l6 2-6 2-2 6-2-6-6-2 6-2 2-6Z"/>',
    alert:    '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18.2a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
    feed:     '<path d="M4 4h12a4 4 0 0 1 4 4v12"/><path d="M4 10a10 10 0 0 1 10 10"/><circle cx="5" cy="19" r="1.5"/>',
    external: '<path d="M15 3h6v6M10 14 21 3M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/>',
    plus:     '<path d="M12 5v14M5 12h14"/>',
    arrowR:   '<path d="M5 12h14M12 5l7 7-7 7"/>'
  };

  function icon(name, size, strokeWidth, extraStyle) {
    size = size || 14;
    strokeWidth = strokeWidth || 1.75;
    extraStyle = extraStyle || '';
    return '<svg width="' + size + '" height="' + size +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="' + strokeWidth +
      '" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;' + extraStyle + '">' +
      (SVG_PATHS[name] || '') + '</svg>';
  }

  // ─── Helpers ────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    if (str == null) return '';
    var div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
  }

  // Site avatar: deterministic gradient from the site's color (if set) or a
  // hashed hue. First letter on top. Matches design/jsx/shared.jsx:SiteAvatar.
  function siteAvatar(siteName, color, size) {
    size = size || 28;
    var letter = (siteName || '?').charAt(0).toUpperCase();
    var bg;
    if (color && color.indexOf('#') === 0) {
      bg = 'linear-gradient(135deg,' + color + ',' + color + 'cc)';
    } else if (color) {
      bg = color;
    } else {
      var hue = 0;
      for (var i = 0; i < (siteName || '').length; i++) hue = (hue + siteName.charCodeAt(i)) % 360;
      bg = 'linear-gradient(135deg,hsl(' + hue + ',55%,50%),hsl(' + ((hue + 30) % 360) + ',55%,60%))';
    }
    var cls = size >= 40 ? 'sh-avatar sh-avatar-lg' : 'sh-avatar';
    return '<span class="' + cls + '" style="background:' + bg +
      ';width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.42) + 'px">' +
      escapeHtml(letter) + '</span>';
  }

  // Favicon placeholder: colored square with first letter. Real favicons
  // would be fetched via s2/favicons — deferred.
  function favicon(domain, size) {
    size = size || 16;
    var letter = (domain || '?').charAt(0).toUpperCase();
    var hue = 0;
    for (var i = 0; i < (domain || '').length; i++) hue = (hue + domain.charCodeAt(i)) % 360;
    return '<span style="width:' + size + 'px;height:' + size +
      'px;border-radius:3px;background:hsl(' + hue + ',45%,55%);color:white;' +
      'display:inline-flex;align-items:center;justify-content:center;' +
      'font-size:' + Math.round(size * 0.6) + 'px;font-weight:600;flex-shrink:0">' +
      escapeHtml(letter) + '</span>';
  }

  // Sparkline SVG. Ported verbatim from design/jsx/shared.jsx:Sparkline.
  function sparkline(data, w, h, color, fill) {
    w = w || 100; h = h || 24; color = color || 'var(--sh-accent)';
    fill = fill !== false;
    if (!data || !data.length) return '';
    var max = Math.max.apply(null, data.concat([1]));
    var min = Math.min.apply(null, data.concat([0]));
    var range = max - min || 1;
    var pts = [];
    for (var i = 0; i < data.length; i++) {
      var x = (i / Math.max(1, data.length - 1)) * (w - 2) + 1;
      var y = h - 2 - ((data[i] - min) / range) * (h - 4);
      pts.push([x, y]);
    }
    var linePath = pts.map(function (p, j) { return (j ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2); }).join(' ');
    var fillPath = linePath + ' L ' + (w - 1) + ' ' + (h - 1) + ' L 1 ' + (h - 1) + ' Z';
    return '<svg width="' + w + '" height="' + h + '" style="display:block">' +
      (fill ? '<path d="' + fillPath + '" fill="' + color + '" fill-opacity="0.12"/>' : '') +
      '<path d="' + linePath + '" fill="none" stroke="' + color +
      '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  function relativeTime(iso) {
    if (!iso) return '';
    var d = new Date(iso.indexOf('T') === -1 ? iso.replace(' ', 'T') + 'Z' : iso);
    if (isNaN(d.getTime())) return '';
    var diff = Date.now() - d.getTime();
    var m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    var hr = Math.floor(m / 60);
    if (hr < 24) return hr + 'h ago';
    var days = Math.floor(hr / 24);
    if (days < 7) return days + 'd ago';
    return d.toLocaleDateString();
  }

  // ─── API wrappers ──────────────────────────────────────────────────────
  // Use dashboard's fetchApi if exposed (inherits caching + X-Site-Id + auth
  // redirect on 401); otherwise fall back to plain fetch with X-Site-Id.
  function api(path) {
    if (window.__dashboard && typeof window.__dashboard.fetchApi === 'function') {
      return window.__dashboard.fetchApi(path, { bypassCache: true });
    }
    var siteId = _currentSiteId();
    return fetch(path, {
      credentials: 'same-origin',
      headers: { 'X-Site-Id': String(siteId) }
    }).then(function (r) {
      if (r.status === 401) { window.location.href = '/login'; throw new Error('Unauthorized'); }
      return r.json();
    });
  }

  function _currentSiteId() {
    if (window.__dashboard && window.__dashboard.state) return window.__dashboard.state.activeSiteId || 1;
    var sel = document.getElementById('site-selector');
    return sel ? (parseInt(sel.value, 10) || 1) : 1;
  }

  function _currentSite() {
    var sid = _currentSiteId();
    var sites = (window.__dashboard && window.__dashboard.state && window.__dashboard.state.sites) || [];
    for (var i = 0; i < sites.length; i++) if (sites[i].id === sid) return sites[i];
    return null;
  }

  // ─── Event styling (activity feed) ─────────────────────────────────────
  var EVENT_STYLES = {
    published: { icon: 'check',    color: 'var(--sh-green)',  label: 'Published' },
    clustered: { icon: 'cluster',  color: 'var(--sh-accent)', label: 'Clustered' },
    rewritten: { icon: 'sparkles', color: 'var(--sh-blue)',   label: 'Rewritten' },
    failed:    { icon: 'alert',    color: 'var(--sh-red)',    label: 'Failed'    },
    fetched:   { icon: 'feed',     color: 'var(--sh-text-3)', label: 'Fetched'   }
  };

  // Classify a log row into an activity event. Mirrors §B.2 of WIRING-overview.md.
  // STRICT patterns only — any unrecognised log (including generic errors like
  // "Failed to fetch sources stats") is dropped so the feed stays focused on
  // pipeline milestones, matching the JSX design's event set.
  function _classifyLog(row) {
    var msg = row.message || '';
    var m;
    if ((m = /^Published cluster #(\d+) -> WP post #(\d+)/.exec(msg))) {
      return { kind: 'published', cluster_id: +m[1], wp_post_id: +m[2],
               title: 'Cluster #' + m[1] + ' published', sub: 'WP post #' + m[2] };
    }
    if ((m = /^Publish failed for cluster #(\d+)(?::\s*(.+))?$/.exec(msg))) {
      return { kind: 'failed', cluster_id: +m[1],
               title: 'Publish failed: cluster #' + m[1], sub: m[2] || '' };
    }
    if ((m = /^Rewrite failed for cluster #(\d+)(?::\s*(.+))?$/.exec(msg))) {
      return { kind: 'failed', cluster_id: +m[1],
               title: 'Rewrite failed: cluster #' + m[1], sub: m[2] || '' };
    }
    if ((m = /^Rewrite complete: cluster #(\d+) -> "(.+)"$/.exec(msg))) {
      return { kind: 'rewritten', cluster_id: +m[1], title: m[2] };
    }
    if ((m = /^Cluster (\d+) ready: "(.*?)" \((\d+) articles\)/.exec(msg))) {
      return { kind: 'clustered', cluster_id: +m[1], title: m[2], sub: m[3] + ' sources' };
    }
    if ((m = /^Extracted #(\d+) -> (.+)$/.exec(msg))) {
      return { kind: 'fetched', title: 'Article extracted', sub: m[2] };
    }
    return null;
  }

  // ─── Module state ──────────────────────────────────────────────────────
  var _state = {
    loaded: false,
    stats: null,
    feeds: null,
    clusters: null,
    sources: null,
    activity: null,
    pollTimer: null,
  };

  // ─── Rendering ─────────────────────────────────────────────────────────

  function _skeletonHtml() {
    var skel = function (w, h) { return '<div class="sh-skel" style="width:' + w + ';height:' + h + 'px"></div>'; };
    return [
      '<div class="sh-page-head">',
      '  <div style="display:flex;align-items:center;gap:14px">',
      '    ' + skel('44px', 44),
      '    <div>',
      '      ' + skel('220px', 22),
      '      <div style="margin-top:6px">' + skel('160px', 14) + '</div>',
      '    </div>',
      '  </div>',
      '</div>',
      '<div class="sh-stats-grid">',
      '  ' + skel('100%', 88),
      '  ' + skel('100%', 88),
      '  ' + skel('100%', 88),
      '  ' + skel('100%', 88),
      '</div>',
      '<div class="sh-main-grid">',
      '  ' + skel('100%', 360),
      '  ' + skel('100%', 360),
      '</div>'
    ].join('\n');
  }

  function renderAll() {
    var root = document.getElementById('page-overview');
    if (!root) return;
    root.classList.add('sh-root');

    var site = _currentSite();
    var stats = _state.stats;
    var feedsData = _state.feeds;
    var clustersData = _state.clusters;
    var sources = _state.sources;
    var activity = _state.activity;

    // ── Header ──────────────────────────────────────────────────────
    var siteName = (site && site.name) || (stats && stats.siteId ? 'Site #' + stats.siteId : 'Site');
    var siteColor = (site && site.color) || null;
    var wpUrl = (site && site.wp_url) || '';
    var wpOk  = stats && stats.health && stats.health.wp === 'configured';
    var fhOk  = stats && stats.health && stats.health.firehose === 'ok';

    // Match JSX design: ONE status badge + plain subtitle text. The JSX
    // shows `Connected · WordPress 6.4 · AutoHub plugin 2.1.0`; when WP isn't
    // set up yet we flip to an amber `Setup needed · Connect WordPress to start
    // publishing` to nudge configuration without adding a second badge.
    var statusBadge, statusText;
    if (wpOk) {
      statusBadge = '<span class="sh-badge sh-badge-green"><span class="sh-dot sh-dot-green"></span>Connected</span>';
      statusText  = 'WordPress · AutoHub plugin' + (fhOk ? ' · Firehose live' : '');
    } else {
      statusBadge = '<span class="sh-badge sh-badge-amber"><span class="sh-dot sh-dot-amber"></span>Setup needed</span>';
      statusText  = 'Connect WordPress to start publishing';
    }

    var header =
      '<div class="sh-page-head">' +
        '<div style="display:flex;align-items:center;gap:14px;min-width:0">' +
          siteAvatar(siteName, siteColor, 44) +
          '<div style="min-width:0">' +
            '<h1 class="sh-page-title">' + escapeHtml(siteName) + '</h1>' +
            '<div class="sh-page-sub">' +
              statusBadge +
              '<span>·</span>' +
              '<span>' + escapeHtml(statusText) + '</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<div class="sh-page-actions">' +
          (wpUrl ? '<button class="sh-btn" data-click="siteHomeVisitSite" data-url="' + escapeHtml(wpUrl) + '">' + icon('external', 14) + 'Visit site</button>' : '') +
          '<button class="sh-btn sh-btn-primary" data-click="siteHomeNewFeed">' + icon('plus', 14) + 'New feed</button>' +
        '</div>' +
      '</div>';

    // ── Stat cards ──────────────────────────────────────────────────
    var publishedToday = stats ? stats.publishedToday : '—';
    var draftsReady    = stats ? stats.draftsReady    : '—';
    var draftsPending  = stats ? stats.draftsPending  : 0;
    var draftsFailed   = stats ? stats.draftsFailed   : 0;

    var activeFeeds = '—';
    if (feedsData && Array.isArray(feedsData.feeds)) {
      activeFeeds = feedsData.feeds.filter(function (f) { return f.is_active; }).length;
    } else if (feedsData && Array.isArray(feedsData)) {
      activeFeeds = feedsData.filter(function (f) { return f.is_active; }).length;
    }

    var clustersInQueue = '—';
    var clustersNeedingReview = 0;
    if (clustersData) {
      clustersInQueue = clustersData.total || (clustersData.clusters || []).length;
      clustersNeedingReview = (clustersData.clusters || []).filter(function (c) {
        return (c.avg_similarity || 0) < 0.8;
      }).length;
    }

    // Quality avg: compute from the clusters we have (best-effort).
    var qualityAvg = '—';
    if (clustersData && clustersData.clusters && clustersData.clusters.length) {
      var vals = clustersData.clusters
        .map(function (c) { return c.avg_similarity; })
        .filter(function (v) { return typeof v === 'number' && v > 0; });
      if (vals.length) {
        var sum = 0;
        for (var vi = 0; vi < vals.length; vi++) sum += vals[vi];
        qualityAvg = (sum / vals.length).toFixed(2);
      }
    }

    // statCard — matches JSX design/jsx/site-home.jsx:Stat (label, big value,
    // optional coloured sub, optional sparkline). Sparkline data comes from
    // _buildTrend() below; when no history is available it renders a flat
    // near-zero line so the card layout stays parity with the JSX design.
    function statCard(label, value, sub, subColor, trendData, trendColor) {
      var spark = '';
      if (trendData && trendData.length) {
        spark = '<div class="sh-stat-spark">' + sparkline(trendData, 260, 28, trendColor || 'var(--sh-accent)') + '</div>';
      }
      return '<div class="sh-card-flat" style="padding:16px">' +
        '<div class="sh-stat-label">' + escapeHtml(label) + '</div>' +
        '<div style="display:flex;align-items:baseline;gap:8px;margin-top:6px">' +
          '<div class="sh-stat-value sh-tabular">' + escapeHtml(String(value)) + '</div>' +
          (sub ? '<div class="sh-stat-sub" style="color:' + (subColor || 'var(--sh-text-3)') + '">' + escapeHtml(sub) + '</div>' : '') +
        '</div>' +
        spark +
      '</div>';
    }

    // Derive a 12-point sparkline from the activity log (client-side bucket).
    // `kind` picks which event type to count; returns a 12-element int array
    // covering the last 12 hours. Not perfect — the log is capped at ~50 rows —
    // but visually consistent with the JSX design until the server-side
    // trend endpoint lands (WIRING-overview.md §B.1).
    function _buildTrend(kind) {
      var out = [0,0,0,0,0,0,0,0,0,0,0,0];
      if (!_state.activity) return out;
      var now = Date.now();
      for (var i = 0; i < _state.activity.length; i++) {
        var e = _state.activity[i];
        if (kind && e.kind !== kind) continue;
        if (!e.created_at) continue;
        var t = new Date(e.created_at.indexOf('T') === -1
          ? e.created_at.replace(' ', 'T') + 'Z'
          : e.created_at).getTime();
        if (isNaN(t)) continue;
        var ageHr = (now - t) / 3600000;
        if (ageHr < 0 || ageHr > 12) continue;
        var idx = 11 - Math.floor(ageHr); // 0 = 12h ago, 11 = now
        if (idx >= 0 && idx < 12) out[idx]++;
      }
      return out;
    }

    // Sub-text wording matches JSX design exactly so the two UIs read the same.
    var publishedSub = null, publishedSubColor = null;
    if (draftsFailed > 0) { publishedSub = draftsFailed + ' failed'; publishedSubColor = 'var(--sh-red)'; }

    var queueSub, queueSubColor;
    if (clustersNeedingReview > 0) { queueSub = clustersNeedingReview + ' need review'; queueSubColor = 'var(--sh-amber)'; }
    else                           { queueSub = 'all clear'; queueSubColor = 'var(--sh-green)'; }

    var feedsSub, feedsSubColor;
    if (activeFeeds === 0 || activeFeeds === '—') { feedsSub = 'add your first feed'; feedsSubColor = 'var(--sh-text-3)'; }
    else                                          { feedsSub = 'all healthy'; feedsSubColor = 'var(--sh-text-3)'; }

    var qualitySample = (clustersData && clustersData.clusters && clustersData.clusters.length) || 0;
    var qualitySub = qualitySample > 0 ? ('last ' + qualitySample + ' articles') : 'no data yet';

    var publishedTrend = _buildTrend('published');
    var queueTrend     = _buildTrend('clustered');
    var qualityTrend   = _buildTrend('rewritten');

    var stats_html =
      '<div class="sh-stats-grid">' +
        statCard('Published today', publishedToday, publishedSub, publishedSubColor, publishedTrend, 'var(--sh-green)') +
        statCard('In queue',        clustersInQueue, queueSub,   queueSubColor,   queueTrend,    'var(--sh-blue)') +
        statCard('Active feeds',    activeFeeds,    feedsSub,    feedsSubColor) +
        statCard('Quality avg',     qualityAvg,     qualitySub,  'var(--sh-text-3)', qualityTrend, 'var(--sh-green)') +
      '</div>';

    // ── Activity column ─────────────────────────────────────────────
    var activityRows = '';
    if (!activity) {
      activityRows = '<div class="sh-empty">Loading activity…</div>';
    } else if (!activity.length) {
      activityRows = '<div class="sh-empty">No activity yet — waiting for the first article.</div>';
    } else {
      activityRows = activity.slice(0, 15).map(function (e) {
        var style = EVENT_STYLES[e.kind] || EVENT_STYLES.fetched;
        var title = e.title || e.message || style.label;
        var when = relativeTime(e.created_at);
        return '<div class="sh-activity-row">' +
          '<div class="sh-activity-icon" style="color:' + style.color + '">' +
            icon(style.icon, 14, 2) +
          '</div>' +
          '<div style="flex:1;min-width:0">' +
            '<div style="display:flex;align-items:baseline;gap:6px">' +
              '<span style="font-size:12px;font-weight:600;color:' + style.color + '">' + style.label + '</span>' +
              '<span style="font-size:12px;color:var(--sh-text-4)">·</span>' +
              '<span style="font-size:12px;color:var(--sh-text-3)">' + escapeHtml(when) + '</span>' +
            '</div>' +
            '<div class="sh-activity-title">' + escapeHtml(title) + '</div>' +
            (e.sub ? '<div class="sh-activity-sub">' + escapeHtml(e.sub) + '</div>' : '') +
          '</div>' +
        '</div>';
      }).join('');
    }

    var activity_html =
      '<div class="sh-card">' +
        '<div class="sh-card-head">' +
          '<div class="sh-card-title">Activity</div>' +
          '<select class="sh-select" data-change="siteHomeFilterActivity">' +
            '<option value="all">All events</option>' +
            '<option value="publishes">Publishes only</option>' +
            '<option value="failures">Failures only</option>' +
          '</select>' +
        '</div>' +
        '<div>' + activityRows + '</div>' +
      '</div>';

    // ── Needs review card ───────────────────────────────────────────
    var reviewList = (clustersData && clustersData.clusters) || [];
    var topReview = reviewList.slice().sort(function (a, b) {
      return (a.avg_similarity || 0) - (b.avg_similarity || 0);
    }).slice(0, 3);

    var reviewHtml;
    if (!topReview.length) {
      reviewHtml = '<div class="sh-empty">Nothing queued.</div>';
    } else {
      reviewHtml = topReview.map(function (c, i) {
        var border = i < topReview.length - 1 ? ';border-bottom:1px solid var(--sh-border)' : '';
        return '<div style="padding:10px 20px;cursor:pointer' + border + '" data-click="siteHomeOpenCluster" data-cluster-id="' + c.id + '">' +
          '<div style="font-size:13px;font-weight:450;line-height:1.35;margin-bottom:4px">' + escapeHtml(c.topic || ('Cluster #' + c.id)) + '</div>' +
          '<div style="display:flex;align-items:center;gap:8px;font-size:11.5px;color:var(--sh-text-3)">' +
            '<span>' + (c.article_count || 0) + ' sources</span>' +
            '<span>·</span>' +
            '<span>quality ' + (c.avg_similarity ? c.avg_similarity.toFixed(2) : '—') + '</span>' +
          '</div>' +
        '</div>';
      }).join('');
    }

    var needsReviewTotal = (clustersData && clustersData.total) || reviewList.length;
    var review_html =
      '<div class="sh-card">' +
        '<div class="sh-card-head">' +
          '<div class="sh-card-title">Needs review</div>' +
          (needsReviewTotal ? '<span class="sh-badge sh-badge-amber">' + needsReviewTotal + '</span>' : '') +
        '</div>' +
        '<div style="padding:4px 0">' + reviewHtml + '</div>' +
        '<div style="padding:10px 20px;border-top:1px solid var(--sh-border);background:var(--sh-surface-2)">' +
          '<button class="sh-btn sh-btn-sm" style="width:100%;justify-content:center" data-click="siteHomeReviewAll">Review all ' + needsReviewTotal + ' →</button>' +
        '</div>' +
      '</div>';

    // ── Top sources ─────────────────────────────────────────────────
    // /api/sources/stats returns `domains: [...]` — each row has domain + total.
    var sourcesList = (sources && (sources.domains || sources.topDomains)) || [];
    var sourcesHtml;
    if (!sourcesList.length) {
      sourcesHtml = '<div class="sh-empty">No sources yet.</div>';
    } else {
      sourcesHtml = sourcesList.slice(0, 4).map(function (r) {
        return '<div style="display:flex;align-items:center;gap:10px;padding:6px 0">' +
          favicon(r.domain, 16) +
          '<span style="font-size:13px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(r.domain) + '</span>' +
          '<span class="sh-tabular" style="font-size:12px;color:var(--sh-text-3)">' + (r.total || r.count || 0) + '</span>' +
        '</div>';
      }).join('');
    }

    var sources_html =
      '<div class="sh-card" style="margin-top:12px">' +
        '<div class="sh-card-head">' +
          '<div class="sh-card-title">Top sources (7d)</div>' +
        '</div>' +
        '<div style="padding:8px 20px 16px">' + sourcesHtml + '</div>' +
      '</div>';

    // ── Compose ─────────────────────────────────────────────────────
    root.innerHTML =
      header +
      stats_html +
      '<div class="sh-main-grid">' +
        activity_html +
        '<div>' +
          review_html +
          sources_html +
        '</div>' +
      '</div>';
  }

  // ─── Data loading ──────────────────────────────────────────────────────
  function refreshAll() {
    var siteId = _currentSiteId();

    var sitesLoad = (window.__dashboard && window.__dashboard.state && window.__dashboard.state.sites && window.__dashboard.state.sites.length)
      ? Promise.resolve(null)
      : api('/api/sites').then(function (data) {
          if (window.__dashboard && window.__dashboard.state) window.__dashboard.state.sites = (data && data.sites) || [];
          return null;
        }).catch(function () { return null; });

    var statsP = api('/api/sites/' + siteId + '/stats').catch(function () { return null; });
    var feedsP = api('/api/feeds').catch(function () { return null; });
    var clustersP = api('/api/clusters?status=detected&per_page=20').catch(function () { return null; });
    var sourcesP = api('/api/sources/stats').catch(function () { return null; });
    var logsP   = api('/api/logs?per_page=50').catch(function () { return null; });

    return Promise.all([sitesLoad, statsP, feedsP, clustersP, sourcesP, logsP]).then(function (results) {
      _state.stats    = results[1];
      _state.feeds    = results[2];
      _state.clusters = results[3];
      _state.sources  = results[4];

      // Convert logs → activity events (pattern match on message).
      var logs = (results[5] && (results[5].data || results[5].logs)) || [];
      var events = [];
      for (var i = 0; i < logs.length; i++) {
        var kind = _classifyLog(logs[i]);
        if (!kind) continue;
        events.push({
          kind: kind.kind,
          title: kind.title || logs[i].message,
          sub: kind.sub || '',
          created_at: logs[i].created_at,
          cluster_id: kind.cluster_id,
          wp_post_id: kind.wp_post_id
        });
      }
      _state.activity = events;
      _state.loaded = true;
      renderAll();
    });
  }

  // ─── Public API ────────────────────────────────────────────────────────
  function load() {
    var root = document.getElementById('page-overview');
    if (!root) return;
    root.classList.add('sh-root');
    if (!_state.loaded) root.innerHTML = _skeletonHtml();
    refreshAll();
    _startPolling();
  }

  function _startPolling() {
    _stopPolling();
    _state.pollTimer = setInterval(function () {
      if (document.hidden) return;
      refreshAll();
    }, 30000);
    // Hand the timer to the dashboard so clearPageTimers() tidies it up on nav away.
    if (window.__dashboard && window.__dashboard.state && window.__dashboard.state.refreshTimers) {
      window.__dashboard.state.refreshTimers.push(_state.pollTimer);
    }
  }

  function _stopPolling() {
    if (_state.pollTimer) clearInterval(_state.pollTimer);
    _state.pollTimer = null;
  }

  // Activity filter: for now just locally filters the already-loaded events.
  // When the dedicated /api/sites/:id/activity endpoint lands, swap to a
  // server-side filter so "Failures only" scans further back than 50 rows.
  function setActivityFilter(value) {
    if (!_state.activity) return;
    var original = _state.activity;
    if (value === 'all') {
      renderAll();
      return;
    }
    _state.activity = original.filter(function (e) {
      if (value === 'publishes') return e.kind === 'published';
      if (value === 'failures')  return e.kind === 'failed';
      return true;
    });
    renderAll();
    _state.activity = original; // restore so next poll isn't pre-filtered
  }

  function visitSite(url) {
    if (url) window.open(url, '_blank', 'noopener');
  }

  function openCluster(clusterId) {
    if (!clusterId) return;
    if (window.__dashboard && window.__dashboard.state) window.__dashboard.state.currentClusterId = clusterId;
    if (window.__dashboard && typeof window.__dashboard.navigateTo === 'function') {
      window.__dashboard.navigateTo('editor');
    } else {
      window.location.hash = 'editor';
    }
  }

  function reviewAll() {
    if (window.__dashboard && typeof window.__dashboard.navigateTo === 'function') {
      window.__dashboard.navigateTo('clusters');
    } else {
      window.location.hash = 'clusters';
    }
  }

  function newFeed() {
    if (window.__dashboard && typeof window.__dashboard.navigateTo === 'function') {
      window.__dashboard.navigateTo('create-feed');
    } else {
      window.location.hash = 'create-feed';
    }
  }

  // ─── Sidebar site switcher ─────────────────────────────────────────────
  // The new sidebar header is a clickable site button with an avatar + name +
  // "N sites" subtitle. Clicking opens a popover listing all sites; picking
  // one calls dashboard.switchSite(). Kept here (not in dashboard.js) so the
  // whole new-UI visual layer lives in one file.

  var _sbDropdownOpen = false;

  function updateSidebarSwitcher() {
    var sites = (window.__dashboard && window.__dashboard.state && window.__dashboard.state.sites) || [];
    var curId = _currentSiteId();
    var cur = null;
    for (var i = 0; i < sites.length; i++) if (sites[i].id === curId) { cur = sites[i]; break; }

    var name = cur ? cur.name : (curId === 0 ? 'All sites' : 'Site');
    var avatarEl = document.getElementById('sh-sb-avatar');
    var nameEl   = document.getElementById('sh-sb-site-name');
    var subEl    = document.getElementById('sh-sb-site-sub');

    if (avatarEl) {
      avatarEl.textContent = (name || '?').charAt(0).toUpperCase();
      if (cur && cur.color && cur.color.indexOf('#') === 0) {
        avatarEl.style.background = 'linear-gradient(135deg,' + cur.color + ',' + cur.color + 'cc)';
      }
    }
    if (nameEl) nameEl.textContent = name;
    if (subEl)  subEl.textContent  = sites.length + ' site' + (sites.length === 1 ? '' : 's');

    // Keep the topbar breadcrumb's site segment in sync.
    var crumbEl = document.getElementById('topbar-site-crumb');
    if (crumbEl) crumbEl.textContent = name;

    _renderSidebarDropdown(sites, curId);
  }

  function _renderSidebarDropdown(sites, curId) {
    var el = document.getElementById('sh-sb-dropdown');
    if (!el) return;

    var html = '<div class="sh-sb-dropdown-label">Your sites</div>';
    for (var i = 0; i < sites.length; i++) {
      var s = sites[i];
      var letter = (s.name || '?').charAt(0).toUpperCase();
      var bg = (s.color && s.color.indexOf('#') === 0)
        ? 'linear-gradient(135deg,' + s.color + ',' + s.color + 'cc)'
        : 'linear-gradient(135deg,#ff6524,#ff9052)';
      var isActive = s.id === curId;
      var statusDot = s.has_wp ? '' : '<span class="sh-sb-dropdown-dot" title="WordPress not configured"></span>';
      var check = isActive ? '<svg data-lucide="check" class="sh-sb-dropdown-check" width="14" height="14"></svg>' : '';
      html += '<button class="sh-sb-dropdown-item' + (isActive ? ' active' : '') + '" data-click="pickSiteFromSidebar" data-site-id="' + s.id + '">' +
        '<span class="sh-sb-avatar" style="background:' + bg + '">' + escapeHtml(letter) + '</span>' +
        '<div class="sh-sb-dropdown-item-meta">' +
          '<div class="sh-sb-dropdown-item-name">' + escapeHtml(s.name) + '</div>' +
          '<div class="sh-sb-dropdown-item-sub">' + (s.has_wp ? 'Connected' : 'Setup needed') + '</div>' +
        '</div>' +
        statusDot +
        check +
      '</button>';
    }
    html += '<div class="sh-sb-dropdown-divider"></div>';
    html += '<button class="sh-sb-dropdown-item" data-click="pickSiteFromSidebar" data-site-id="0">' +
      '<svg data-lucide="grid-3x3" width="18" height="18" style="color:var(--text-tertiary)"></svg>' +
      '<div class="sh-sb-dropdown-item-meta"><div class="sh-sb-dropdown-item-name">All sites</div></div>' +
      (curId === 0 ? '<svg data-lucide="check" class="sh-sb-dropdown-check" width="14" height="14"></svg>' : '') +
    '</button>';
    html += '<button class="sh-sb-dropdown-item" data-click="goToSitesPage">' +
      '<svg data-lucide="plus" width="18" height="18" style="color:var(--text-tertiary)"></svg>' +
      '<div class="sh-sb-dropdown-item-meta"><div class="sh-sb-dropdown-item-name">Connect site</div></div>' +
    '</button>';

    el.innerHTML = html;
    // Re-run lucide so the new svg[data-lucide] tags render.
    if (window.lucide && typeof window.lucide.createIcons === 'function') window.lucide.createIcons();
  }

  function toggleSidebarSwitcher() {
    var dd = document.getElementById('sh-sb-dropdown');
    var btn = document.getElementById('sh-sb-site-btn');
    if (!dd || !btn) return;
    _sbDropdownOpen = !_sbDropdownOpen;
    dd.classList.toggle('hidden', !_sbDropdownOpen);
    btn.setAttribute('aria-expanded', _sbDropdownOpen ? 'true' : 'false');
  }

  function closeSidebarSwitcher() {
    var dd = document.getElementById('sh-sb-dropdown');
    var btn = document.getElementById('sh-sb-site-btn');
    _sbDropdownOpen = false;
    if (dd) dd.classList.add('hidden');
    if (btn) btn.setAttribute('aria-expanded', 'false');
  }

  function pickSite(siteId) {
    closeSidebarSwitcher();
    if (window.__dashboard && typeof window.__dashboard.state === 'object') {
      // Reuse dashboard's switchSite via the existing topbar selector to keep
      // the in-flight + dirty-form guards intact.
      var sel = document.getElementById('site-selector');
      if (sel) {
        sel.value = String(siteId);
        // Fire the change event so dashboard's initSiteSwitcher picks it up.
        var evt = new Event('change', { bubbles: true });
        sel.dispatchEvent(evt);
        return;
      }
    }
    // Fallback: just reload with the new site id as a hash hint.
    window.location.reload();
  }

  // Close on outside click. Attached once per page load (idempotent via flag).
  if (!window.__sh_sb_outsideBound) {
    document.addEventListener('mousedown', function (e) {
      if (!_sbDropdownOpen) return;
      var sw = document.getElementById('sh-sb-switcher');
      if (sw && !sw.contains(e.target)) closeSidebarSwitcher();
    });
    window.__sh_sb_outsideBound = true;
  }

  // ─── Public API ────────────────────────────────────────────────────────
  window.__siteHome = {
    load: load,
    refreshAll: refreshAll,
    setActivityFilter: setActivityFilter,
    visitSite: visitSite,
    openCluster: openCluster,
    reviewAll: reviewAll,
    newFeed: newFeed,
    updateSidebarSwitcher: updateSidebarSwitcher,
    toggleSidebarSwitcher: toggleSidebarSwitcher,
    pickSite: pickSite
  };
}());
