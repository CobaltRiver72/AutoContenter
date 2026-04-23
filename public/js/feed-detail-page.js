/* ================================================================
   Feed detail — vanilla JS port of design/jsx/feed-detail.jsx.
   Four tabs: Stories / Configuration / Settings / Published.
   Feed id arrives via window.__dashboard.state.currentFeedId (set
   by feeds-page.js when a row is clicked). The page itself fetches
   feed + stats + clusters and drives all four tabs from that data.
   ================================================================ */

(function () {
  'use strict';

  var _state = {
    feedId: null,
    feed: null,
    stats: null,
    clusters: [],
    tab: 'stories',       // 'stories' | 'config' | 'settings' | 'published'
    selectedClusterId: null,
    hideBelow: false,
    saving: false,
    loading: false,
    // editable shadows used by Configuration / Settings tabs so we can
    // diff against the source-of-truth _state.feed on save
    cfg: { query: '', minSrc: 2, sim: 72, bufferHours: 2.5, allowSameDomain: true },
    setg: { name: '', description: '', autoPub: false, notifyFail: true },
  };
  var _pollTimer = null;
  var _previewTimer = null;

  // ─── Helpers ────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    if (str == null) return '';
    var d = document.createElement('div'); d.textContent = String(str); return d.innerHTML;
  }
  function icon(name, size) {
    size = size || 14;
    return '<svg data-lucide="' + name + '" width="' + size + '" height="' + size + '" style="flex-shrink:0"></svg>';
  }
  function api(path, opts) {
    if (window.__dashboard && typeof window.__dashboard.fetchApi === 'function') {
      return window.__dashboard.fetchApi(path, opts || {});
    }
    opts = opts || {}; opts.credentials = 'same-origin';
    return fetch(path, opts).then(function (r) { return r.json(); });
  }
  function relTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso.indexOf('T') === -1 ? iso.replace(' ', 'T') + 'Z' : iso);
    if (isNaN(d.getTime())) return '—';
    var diff = Date.now() - d.getTime();
    var m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    var hr = Math.floor(m / 60);
    if (hr < 24) return hr + 'h ago';
    var days = Math.floor(hr / 24);
    return days + 'd ago';
  }
  function favicon(domain, size) {
    size = size || 14;
    var letter = (domain || '?').charAt(0).toUpperCase();
    var hue = 0;
    for (var i = 0; i < (domain || '').length; i++) hue = (hue + domain.charCodeAt(i)) % 360;
    return '<span style="width:' + size + 'px;height:' + size +
      'px;border-radius:3px;background:hsl(' + hue + ',45%,55%);color:white;' +
      'display:inline-flex;align-items:center;justify-content:center;' +
      'font-size:' + Math.round(size * 0.6) + 'px;font-weight:600;flex-shrink:0">' +
      escapeHtml(letter) + '</span>';
  }
  function statusBadge(st) {
    var map = {
      active: { cls: 'sh-badge-green',   dot: 'sh-dot-green', label: 'Active' },
      paused: { cls: 'sh-badge-neutral', dot: 'sh-dot-gray',  label: 'Paused' },
      failed: { cls: 'sh-badge-red',     dot: 'sh-dot-red',   label: 'Failed' },
    };
    var m = map[st] || map.paused;
    return '<span class="sh-badge ' + m.cls + '"><span class="sh-dot ' + m.dot + '"></span>' + m.label + '</span>';
  }
  function _kindLabel(k) {
    var m = { firehose: 'Firehose', rss: 'RSS', youtube: 'YouTube', keyword: 'Keyword' };
    return m[k] || k || '—';
  }
  function _queryOf(feed) {
    var sc = (feed && feed.source_config) || {};
    return sc.query || sc.rule_value || sc.url || sc.term || '';
  }
  function _deriveStatus(feed, stats) {
    if (!feed) return 'paused';
    if (!feed.is_active) return 'paused';
    var last = stats && stats.lastArticleAt;
    if (last) {
      var ageHr = (Date.now() - new Date(last.replace(' ', 'T') + 'Z').getTime()) / 3600000;
      if (ageHr > 2 && (feed.has_firehose_token || feed.kind !== 'firehose')) return 'failed';
    }
    return 'active';
  }

  // ─── Data loading ──────────────────────────────────────────────────────
  function refreshFeed() {
    if (!_state.feedId) return Promise.resolve();
    return Promise.all([
      api('/api/feeds/' + _state.feedId).catch(function () { return null; }),
      api('/api/feeds/stats?ids=' + _state.feedId).catch(function () { return null; }),
      api('/api/clusters?feed_id=' + _state.feedId + '&per_page=50').catch(function () { return null; }),
    ]).then(function (res) {
      var feedResp = res[0], statsResp = res[1], clustersResp = res[2];
      _state.feed = feedResp && feedResp.feed;
      _state.stats = statsResp && statsResp.stats && statsResp.stats[_state.feedId];
      _state.clusters = (clustersResp && (clustersResp.clusters || clustersResp.data)) || [];
      if (!_state.selectedClusterId && _state.clusters.length) _state.selectedClusterId = _state.clusters[0].id;

      // Seed editable shadows
      if (_state.feed) {
        var sc = _state.feed.source_config || {};
        var qc = _state.feed.quality_config || {};
        _state.cfg = {
          query:  sc.query || '',
          minSrc: qc.min_sources || 2,
          sim:    Math.round((qc.similarity_threshold || 0.72) * 100),
          bufferHours:     (typeof qc.buffer_hours === 'number') ? qc.buffer_hours : 2.5,
          allowSameDomain: (typeof qc.allow_same_domain_clusters === 'boolean') ? qc.allow_same_domain_clusters : true,
        };
        _state.setg = {
          name: _state.feed.name || '',
          description: (_state.feed.dest_config && _state.feed.dest_config.description) || '',
          autoPub: !!qc.auto_publish,
          notifyFail: qc.notify_failure !== false,
        };
      }
      render();
    });
  }

  // Preview endpoint for Configuration tab (hourly bar chart + numbers).
  // Piggybacks on /api/feeds/preview which returns recent matches; we bucket
  // them client-side. Good enough for the live-preview feel the JSX implies.
  function _cfgPreview() {
    if (!_state.feedId || !_state.feed) return;
    var body = { source_config: { query: _state.cfg.query, site_id: _state.feed.site_id } };
    return api('/api/feeds/preview', { method: 'POST', body: body }).then(function (r) {
      if (!r || !r.ok) return null;
      var matches = r.matches || [];
      // 24 hourly buckets.
      var now = Date.now();
      var bins = new Array(24); for (var i = 0; i < 24; i++) bins[i] = 0;
      for (var j = 0; j < matches.length; j++) {
        var t = new Date(matches[j].received_at.replace(' ', 'T') + 'Z').getTime();
        var hourAgo = Math.floor((now - t) / 3600000);
        if (hourAgo >= 0 && hourAgo < 24) bins[23 - hourAgo]++;
      }
      var passing = Math.max(1, Math.floor(matches.length / Math.max(1, _state.cfg.minSrc * 1.4 + (_state.cfg.sim - 50) / 10)));
      return { raw: r.total || matches.length, passing: passing, below: Math.max(0, (r.total || matches.length) - passing), bins: bins };
    });
  }

  // ─── Rendering ─────────────────────────────────────────────────────────
  function render() {
    var root = document.getElementById('page-feed-detail');
    if (!root) return;
    root.classList.add('sh-root');

    if (!_state.feed && !_state.loading) {
      root.innerHTML = '<div class="sh-empty" style="border:1px solid var(--sh-border);border-radius:var(--sh-r-lg);background:var(--sh-surface);padding:48px">Feed not found or still loading.</div>';
      return;
    }

    root.innerHTML =
      _renderHeader() +
      _renderTabs() +
      (_state.tab === 'stories'   ? _renderStoriesTab()   :
       _state.tab === 'config'    ? _renderConfigTab()    :
       _state.tab === 'settings'  ? _renderSettingsTab()  :
       _renderPublishedTab());

    if (window.lucide && typeof window.lucide.createIcons === 'function') window.lucide.createIcons();
  }

  function _renderHeader() {
    var f = _state.feed; if (!f) return '';
    var status = _deriveStatus(f, _state.stats);
    var q = _queryOf(f);
    var pauseLabel = f.is_active ? 'Pause' : 'Resume';
    var pauseIcon = f.is_active ? 'pause' : 'play';
    return '<div style="display:flex;align-items:flex-start;gap:16px;margin-bottom:20px">' +
      '<button class="sh-btn sh-btn-ghost sh-btn-sm" data-click="fdBack">' + icon('arrow-left', 16) + '</button>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">' +
          '<h1 class="sh-page-title" style="font-size:20px">' + escapeHtml(f.name) + '</h1>' +
          statusBadge(status) +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:10px;font-size:12.5px;color:var(--sh-text-3);flex-wrap:wrap">' +
          (q ? '<span class="sh-mono" style="padding:1px 8px;background:var(--sh-bg-2);border-radius:4px;border:1px solid var(--sh-border)">' + escapeHtml(q) + '</span>' : '') +
          '<span>·</span>' +
          '<span>' + escapeHtml(_kindLabel(f.kind)) + '</span>' +
          '<span>·</span>' +
          '<span>Updated ' + relTime(f.last_fetched_at) + '</span>' +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:6px">' +
        '<button class="sh-btn" data-click="fdTogglePause">' + icon(pauseIcon, 14) + pauseLabel + '</button>' +
      '</div>' +
    '</div>';
  }

  function _renderTabs() {
    var clusterCount = _state.clusters.length;
    function t(id, label, badge) {
      var active = _state.tab === id ? ' sh-tab-active' : '';
      var badgeHtml = badge != null ? ' <span class="sh-badge sh-badge-neutral" style="margin-left:4px;font-size:10.5px">' + badge + '</span>' : '';
      return '<button class="sh-tab' + active + '" data-click="fdSetTab" data-tab="' + id + '">' + label + badgeHtml + '</button>';
    }
    return '<div class="sh-tabs">' +
      t('stories',   'Stories', clusterCount) +
      t('config',    'Configuration') +
      t('settings',  'Settings') +
      t('published', 'Published') +
    '</div>';
  }

  // ─── Stories tab ───────────────────────────────────────────────────────
  function _renderStoriesTab() {
    var clusters = _state.clusters.slice();
    // Derive `below` flag by comparing article_count against feed threshold.
    var minSrc = _state.cfg.minSrc || 2;
    for (var i = 0; i < clusters.length; i++) {
      clusters[i]._below = (clusters[i].article_count || 0) < minSrc;
    }
    var belowCount = clusters.filter(function (c) { return c._below; }).length;
    var visible = _state.hideBelow ? clusters.filter(function (c) { return !c._below; }) : clusters;
    var selected = null;
    for (var j = 0; j < clusters.length; j++) if (clusters[j].id === _state.selectedClusterId) { selected = clusters[j]; break; }

    var rowsHtml = visible.length === 0
      ? '<div class="sh-empty" style="padding:48px">No clusters yet for this feed.</div>'
      : visible.map(function (c, i) {
          var isSel = c.id === _state.selectedClusterId;
          var bgStyle = isSel ? 'background:var(--sh-accent-soft);border-left:3px solid var(--sh-accent)' : 'border-left:3px solid transparent';
          var badge = c._below
            ? '<span class="sh-badge sh-badge-neutral">' + (c.article_count || 0) + ' src · below</span>'
            : '<span class="sh-badge sh-badge-green">' + (c.article_count || 0) + ' sources</span>';
          return '<div class="sh-fd-clrow" data-click="fdSelectCluster" data-cluster-id="' + c.id +
            '" style="padding:12px 14px;border-bottom:' + (i < visible.length - 1 ? '1px solid var(--sh-border)' : 'none') + ';cursor:pointer;' + bgStyle + '">' +
            '<div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">' +
              '<span class="sh-mono" style="color:var(--sh-text-3);font-size:11px">#' + c.id + '</span>' +
              '<span style="color:var(--sh-text-4);font-size:11px">·</span>' +
              '<span style="font-size:11px;color:var(--sh-text-3)">' + relTime(c.detected_at) + '</span>' +
              '<div style="flex:1"></div>' +
              badge +
            '</div>' +
            '<div style="font-size:13.5px;font-weight:' + (isSel ? 550 : 450) + ';line-height:1.35;color:' + (c._below ? 'var(--sh-text-3)' : 'var(--sh-text)') + '">' + escapeHtml(c.topic || 'Untitled cluster') + '</div>' +
          '</div>';
        }).join('');

    var previewHtml = selected
      ? _renderClusterPreview(selected)
      : '<div class="sh-empty" style="padding:48px">Select a cluster to preview.</div>';

    return '<div>' +
      // Action bar
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap">' +
        '<div style="font-size:13px;color:var(--sh-text-2)">' +
          '<b class="sh-tabular">' + visible.length + '</b> clusters' +
          (!_state.hideBelow ? '<span style="color:var(--sh-text-3)"> · ' + belowCount + ' below threshold</span>' : '') +
        '</div>' +
        '<label style="display:flex;align-items:center;gap:6px;font-size:12.5px;color:var(--sh-text-2);cursor:pointer">' +
          '<input type="checkbox" class="sh-check" ' + (_state.hideBelow ? 'checked' : '') + ' data-change="fdToggleHideBelow"/>' +
          'Hide below-threshold' +
        '</label>' +
        '<div style="flex:1"></div>' +
        '<button class="sh-btn sh-btn-sm" data-click="fdQueueSelected" disabled title="Batch queueing coming soon">' + icon('send', 12) + 'Queue selected</button>' +
      '</div>' +

      // Split layout
      '<div class="sh-fd-split">' +
        '<div class="sh-card" style="overflow:hidden;display:flex;flex-direction:column">' +
          '<div style="overflow-y:auto;flex:1;max-height:640px">' + rowsHtml + '</div>' +
        '</div>' +
        '<div class="sh-card" style="display:flex;flex-direction:column;overflow:hidden">' + previewHtml + '</div>' +
      '</div>' +
    '</div>';
  }

  function _renderClusterPreview(c) {
    // /api/clusters now enriches each cluster with source_domains (array of
    // up to 8 distinct hostnames) and source_image (drafts.featured_image if
    // extracted, else the Firehose-supplied articles.image_url). When neither
    // field has content we show the empty-state, not a fake "Loading…".
    var domains = Array.isArray(c.source_domains) ? c.source_domains : [];
    var domainsHtml = domains.length
      ? domains.map(function (d) {
          return '<div class="sh-fd-pill">' + favicon(d, 14) + '<span>' + escapeHtml(d) + '</span></div>';
        }).join('')
      : '<div style="color:var(--sh-text-3);font-size:12px">No sources indexed yet.</div>';

    // Cover image. CSP blocks inline onerror handlers, so a broken image URL
    // shows a broken-image glyph; acceptable trade-off. We delegate error
    // recovery to the existing image-fallback helper registered below (see
    // wireImageFallback) which runs on 'error' events captured at the root.
    var imgHtml = c.source_image
      ? '<div class="sh-fd-img-wrap" style="border-radius:10px;overflow:hidden;margin-bottom:14px;background:var(--sh-surface-2);aspect-ratio:16/9">' +
          '<img src="' + escapeHtml(c.source_image) + '" alt="" loading="lazy" referrerpolicy="no-referrer" ' +
          'class="sh-fd-cover-img" ' +
          'style="width:100%;height:100%;object-fit:cover;display:block">' +
        '</div>'
      : '<div class="sh-fd-img-placeholder">' + icon('image', 24) +
        '<div style="color:var(--sh-text-3);font-size:12px;margin-top:6px">No cover image yet — extracts on publish.</div></div>';

    return '<div style="padding:20px;overflow-y:auto;flex:1;max-height:600px">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">' +
        '<span class="sh-mono" style="color:var(--sh-text-3);font-size:11.5px;letter-spacing:0.02em;text-transform:uppercase">Cluster #' + c.id + '</span>' +
        (c.avg_similarity ? '<span class="sh-badge sh-badge-green">quality ' + c.avg_similarity.toFixed(2) + '</span>' : '') +
      '</div>' +
      '<h2 style="font-size:19px;font-weight:600;letter-spacing:-0.01em;line-height:1.25;margin:0 0 12px">' + escapeHtml(c.topic || 'Untitled') + '</h2>' +
      imgHtml +
      '<div class="sh-eyebrow" style="margin-bottom:8px">Sources (' + (c.article_count || 0) + ')</div>' +
      '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px">' + domainsHtml + '</div>' +
      '<div class="sh-eyebrow" style="margin-bottom:8px">Summary</div>' +
      '<div style="font-size:13.5px;line-height:1.6;color:var(--sh-text-2)">' +
        escapeHtml(c.summary || ('Cluster of ' + (c.article_count || 0) + ' articles. Open in editor to generate a rewrite or preview the full payload.')) +
      '</div>' +
    '</div>' +
    '<div style="padding:14px;border-top:1px solid var(--sh-border);background:var(--sh-surface-2);display:flex;gap:8px;justify-content:flex-end">' +
      '<button class="sh-btn sh-btn-sm" data-click="fdSkipCluster" data-cluster-id="' + c.id + '">Skip</button>' +
      '<button class="sh-btn sh-btn-sm" data-click="fdOpenClusterEditor" data-cluster-id="' + c.id + '">Open in editor' + icon('arrow-right', 12) + '</button>' +
      '<button class="sh-btn sh-btn-sm sh-btn-accent" data-click="fdPublishCluster" data-cluster-id="' + c.id + '">' + icon('send', 12) + 'Send to publish</button>' +
    '</div>';
  }

  // ─── Configuration tab ─────────────────────────────────────────────────
  function _renderConfigTab() {
    var cfg = _state.cfg;
    return '<div class="sh-fd-cfg-grid">' +
      '<div>' +
        '<div class="sh-eyebrow">Query</div>' +
        '<input class="sh-input sh-mono" value="' + escapeHtml(cfg.query) + '" data-input="fdCfgQuery" style="height:36px;font-size:13px"/>' +
        '<div class="sh-field-hint">AND / OR / quoted phrases supported</div>' +

        '<div class="sh-eyebrow" style="margin-top:24px">Clustering</div>' +
        '<div style="margin-bottom:14px">' +
          '<div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:13px">' +
            '<span>Minimum sources</span>' +
            '<span class="sh-tabular" style="color:var(--sh-text-3)">' + cfg.minSrc + '</span>' +
          '</div>' +
          '<input type="range" class="sh-range" min="1" max="10" value="' + cfg.minSrc + '" data-input="fdCfgMinSrc"/>' +
        '</div>' +
        '<div>' +
          '<div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:13px">' +
            '<span>Similarity threshold</span>' +
            '<span class="sh-tabular" style="color:var(--sh-text-3)">' + (cfg.sim / 100).toFixed(2) + '</span>' +
          '</div>' +
          '<input type="range" class="sh-range" min="50" max="100" value="' + cfg.sim + '" data-input="fdCfgSim"/>' +
        '</div>' +

        '<div style="margin-top:14px">' +
          '<div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:13px">' +
            '<span>Buffer window (hours)</span>' +
            '<span class="sh-tabular" style="color:var(--sh-text-3)">' + cfg.bufferHours + 'h</span>' +
          '</div>' +
          '<input type="number" class="sh-input" min="0.5" max="48" step="0.5" value="' + cfg.bufferHours + '" data-input="fdCfgBufferHours" style="width:100%;max-width:140px"/>' +
          '<div class="sh-field-hint">How far back to look when clustering. Shorter = fresher only; longer = catches slow-rolling stories.</div>' +
        '</div>' +

        '<div style="margin-top:14px;display:flex;align-items:flex-start;justify-content:space-between;gap:12px">' +
          '<div style="flex:1">' +
            '<div style="font-size:13px;font-weight:500">Allow same-domain clusters</div>' +
            '<div class="sh-field-hint" style="margin-top:4px">When on, multiple articles from the same outlet can cluster together. Turn off to require cross-source confirmation.</div>' +
          '</div>' +
          '<input type="checkbox" class="sh-toggle" ' + (cfg.allowSameDomain ? 'checked' : '') + ' data-change="fdCfgAllowSame"/>' +
        '</div>' +

        '<div style="margin-top:28px;display:flex;gap:8px">' +
          '<button class="sh-btn sh-btn-primary" data-click="fdSaveConfig"' + (_state.saving ? ' disabled' : '') + '>' + (_state.saving ? 'Saving…' : 'Save changes') + '</button>' +
          '<button class="sh-btn" data-click="fdResetConfig">Reset</button>' +
        '</div>' +
      '</div>' +

      '<div>' +
        '<div class="sh-card">' +
          '<div class="sh-card-head">' +
            '<div class="sh-card-title">Live preview</div>' +
            '<span class="sh-badge sh-badge-neutral">last 14d · recomputed</span>' +
          '</div>' +
          '<div style="padding:20px" id="fd-cfg-preview">' +
            '<div class="sh-empty">Adjust the knobs to see a preview…</div>' +
          '</div>' +
        '</div>' +
        '<div class="sh-card" style="margin-top:14px;padding:16px;background:var(--sh-accent-soft);border-color:#f5c8a8">' +
          '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
            '<span style="color:var(--sh-accent-text)">' + icon('sparkles', 14) + '</span>' +
            '<span style="font-size:13px;font-weight:600;color:var(--sh-accent-text)">Suggestion</span>' +
          '</div>' +
          '<div style="font-size:13px;color:var(--sh-text-2);line-height:1.5">' +
            (cfg.minSrc >= 3
              ? 'Raising similarity to <b>' + Math.min(85, cfg.sim + 5) + '%</b> filters near-duplicate coverage without losing sources.'
              : 'Raising min sources to <b>2</b> drops spammy single-outlet stories without much volume loss.') +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function _refreshConfigPreview() {
    var el = document.getElementById('fd-cfg-preview');
    if (!el) return;
    el.innerHTML = '<div class="sh-empty">Computing…</div>';
    _cfgPreview().then(function (p) {
      if (!p) { el.innerHTML = '<div class="sh-empty">Preview unavailable.</div>'; return; }
      var barsW = 340, barsH = 60;
      var max = Math.max.apply(null, p.bins.concat([1]));
      var bw = barsW / p.bins.length - 1;
      var bars = '';
      for (var i = 0; i < p.bins.length; i++) {
        var bh = (p.bins[i] / max) * (barsH - 2);
        bars += '<rect x="' + (i * (bw + 1)).toFixed(2) + '" y="' + (barsH - bh).toFixed(2) +
          '" width="' + bw.toFixed(2) + '" height="' + bh.toFixed(2) + '" fill="var(--sh-accent)" rx="1"/>';
      }
      el.innerHTML =
        '<div style="display:flex;gap:24px;margin-bottom:20px">' +
          '<div>' +
            '<div class="sh-eyebrow" style="padding:0">Raw</div>' +
            '<div style="font-size:28px;font-weight:600;letter-spacing:-0.02em;margin-top:2px" class="sh-tabular">' + p.raw + '</div>' +
          '</div>' +
          '<div>' +
            '<div class="sh-eyebrow" style="padding:0">Passing</div>' +
            '<div style="font-size:28px;font-weight:600;letter-spacing:-0.02em;margin-top:2px;color:var(--sh-green)" class="sh-tabular">' + p.passing + '</div>' +
          '</div>' +
          '<div>' +
            '<div class="sh-eyebrow" style="padding:0">Below</div>' +
            '<div style="font-size:28px;font-weight:600;letter-spacing:-0.02em;margin-top:2px;color:var(--sh-text-4)" class="sh-tabular">' + p.below + '</div>' +
          '</div>' +
        '</div>' +
        '<svg width="' + barsW + '" height="' + barsH + '" style="display:block;max-width:100%">' + bars + '</svg>' +
        '<div style="font-size:11px;color:var(--sh-text-3);margin-top:6px">stories / hour · last 24h</div>';
    });
  }

  // ─── Settings tab ──────────────────────────────────────────────────────
  function _renderSettingsTab() {
    var s = _state.setg;
    return '<div style="max-width:680px">' +
      '<div class="sh-card"><div style="padding:20px">' +
        '<div style="font-size:14px;font-weight:600;margin-bottom:10px">Feed name</div>' +
        '<input class="sh-input" value="' + escapeHtml(s.name) + '" data-input="fdSetName"/>' +
        '<div style="font-size:14px;font-weight:600;margin-top:20px;margin-bottom:10px">Description</div>' +
        '<textarea class="sh-input" style="height:70px;resize:vertical;padding:10px;font-family:inherit" data-input="fdSetDescription">' + escapeHtml(s.description) + '</textarea>' +
      '</div></div>' +

      '<div class="sh-card" style="margin-top:14px"><div style="padding:20px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">' +
          '<span style="font-size:14px;font-weight:600">Auto-publish when quality ≥ 0.8</span>' +
          '<input type="checkbox" class="sh-toggle" ' + (s.autoPub ? 'checked' : '') + ' data-change="fdSetAutoPub"/>' +
        '</div>' +
        '<div style="font-size:12.5px;color:var(--sh-text-3)">High-quality clusters publish automatically; the rest queue for review.</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px;margin-bottom:6px">' +
          '<span style="font-size:14px;font-weight:600">Notify on failure</span>' +
          '<input type="checkbox" class="sh-toggle" ' + (s.notifyFail ? 'checked' : '') + ' data-change="fdSetNotify"/>' +
        '</div>' +
        '<div style="font-size:12.5px;color:var(--sh-text-3)">Flag the Failed page when this feed misses 3+ fetches in a row.</div>' +

        '<div style="margin-top:20px;display:flex;gap:8px">' +
          '<button class="sh-btn sh-btn-primary" data-click="fdSaveSettings"' + (_state.saving ? ' disabled' : '') + '>' + (_state.saving ? 'Saving…' : 'Save changes') + '</button>' +
        '</div>' +
      '</div></div>' +

      '<div class="sh-card" style="margin-top:14px;border-color:#f5b5b5"><div style="padding:20px">' +
        '<div style="font-size:14px;font-weight:600;color:var(--sh-red);margin-bottom:6px">Danger zone</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center">' +
          '<div>' +
            '<div style="font-size:13px;font-weight:500">Delete this feed</div>' +
            '<div style="font-size:12px;color:var(--sh-text-3)">Removes the feed and all its clusters. Cannot be undone.</div>' +
          '</div>' +
          '<button class="sh-btn sh-btn-danger" data-click="fdDelete">' + icon('trash-2', 14) + 'Delete feed</button>' +
        '</div>' +
      '</div></div>' +
    '</div>';
  }

  // ─── Published tab ─────────────────────────────────────────────────────
  function _renderPublishedTab() {
    var pubCount = (_state.stats && _state.stats.publishedToday) || 0;
    return '<div class="sh-empty" style="padding:48px;text-align:center">' +
      '<div style="color:var(--sh-text-4);margin-bottom:8px">' + icon('check-circle', 28) + '</div>' +
      '<div style="font-size:14px;font-weight:500;color:var(--sh-text-2)">' + pubCount + ' clusters published from this feed today</div>' +
      '<div style="font-size:12.5px;margin-top:4px">Full history on the <a href="#published" style="color:var(--sh-accent-text);text-decoration:underline">Published</a> screen.</div>' +
    '</div>';
  }

  // ─── Actions ───────────────────────────────────────────────────────────
  function setTab(id) {
    _state.tab = id;
    render();
    if (id === 'config') _refreshConfigPreview();
  }
  function setSelectedCluster(id) { _state.selectedClusterId = id; render(); }
  function toggleHideBelow(v) { _state.hideBelow = !!v; render(); }

  function back() {
    if (window.__dashboard && typeof window.__dashboard.navigateTo === 'function') window.__dashboard.navigateTo('feeds');
    else window.location.hash = 'feeds';
  }

  function togglePause() {
    if (!_state.feed) return;
    var nextActive = !_state.feed.is_active;
    _state.saving = true; render();
    api('/api/feeds/' + _state.feedId, { method: 'PUT', body: { is_active: nextActive } })
      .then(refreshFeed)
      .then(function () { _state.saving = false; render(); });
  }

  function setCfg(field, value) {
    _state.cfg[field] = value;
    // Schedule a preview refresh while typing / sliding.
    clearTimeout(_previewTimer);
    _previewTimer = setTimeout(_refreshConfigPreview, 300);
    // Don't full re-render on every keystroke; surgical update of the slider label keeps focus.
    var slot = document.querySelector('[data-input="fdCfgMinSrc"]');
    if (field === 'minSrc' && slot && slot.nextElementSibling) {}
  }
  function saveConfig() {
    if (!_state.feed) return;
    _state.saving = true; render();
    var body = {
      source_config: Object.assign({}, _state.feed.source_config, { query: _state.cfg.query }),
      quality_config: Object.assign({}, _state.feed.quality_config, {
        min_sources: _state.cfg.minSrc,
        similarity_threshold: _state.cfg.sim / 100,
        buffer_hours: Number(_state.cfg.bufferHours) || 2.5,
        allow_same_domain_clusters: !!_state.cfg.allowSameDomain,
      }),
    };
    api('/api/feeds/' + _state.feedId, { method: 'PUT', body: body })
      .then(function (r) {
        _state.saving = false;
        if (!r || !r.ok) { alert('Save failed: ' + ((r && r.error) || 'unknown')); return render(); }
        return refreshFeed();
      });
  }
  function resetConfig() {
    if (!_state.feed) return;
    var sc = _state.feed.source_config || {}, qc = _state.feed.quality_config || {};
    _state.cfg = { query: sc.query || '', minSrc: qc.min_sources || 2, sim: Math.round((qc.similarity_threshold || 0.72) * 100) };
    render();
  }

  function setSetg(field, value) { _state.setg[field] = value; }
  function saveSettings() {
    if (!_state.feed) return;
    _state.saving = true; render();
    var body = {
      name: _state.setg.name.trim() || _state.feed.name,
      dest_config:    Object.assign({}, _state.feed.dest_config,    { description: _state.setg.description }),
      quality_config: Object.assign({}, _state.feed.quality_config, {
        auto_publish: _state.setg.autoPub,
        notify_failure: _state.setg.notifyFail,
      }),
    };
    api('/api/feeds/' + _state.feedId, { method: 'PUT', body: body })
      .then(function (r) {
        _state.saving = false;
        if (!r || !r.ok) { alert('Save failed: ' + ((r && r.error) || 'unknown')); return render(); }
        return refreshFeed();
      });
  }
  function deleteFeed() {
    if (!_state.feed) return;
    if (!confirm('Delete feed "' + _state.feed.name + '"? This removes the feed and all its clusters.')) return;
    api('/api/feeds/' + _state.feedId + '/destroy', { method: 'POST' })
      .then(function (r) {
        if (!r || !r.ok) { alert('Delete failed: ' + ((r && r.error) || 'unknown')); return; }
        back();
      });
  }

  function openClusterEditor(clusterId) {
    if (window.__dashboard && window.__dashboard.state) window.__dashboard.state.currentClusterId = clusterId;
    if (window.__dashboard && typeof window.__dashboard.navigateTo === 'function') {
      window.__dashboard.navigateTo('editor');
    } else {
      window.location.hash = 'editor';
    }
  }
  function publishCluster(clusterId) {
    if (!confirm('Queue cluster #' + clusterId + ' for publishing?')) return;
    api('/api/clusters/' + clusterId + '/publish', { method: 'POST' })
      .then(function (r) {
        if (!r || r.success === false) { alert('Publish failed: ' + ((r && r.error) || 'unknown')); return; }
        alert('Cluster queued.');
        refreshFeed();
      });
  }
  function skipCluster(clusterId) {
    if (!confirm('Skip cluster #' + clusterId + '?')) return;
    api('/api/clusters/' + clusterId + '/skip', { method: 'POST' })
      .then(function () { refreshFeed(); });
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────
  // CSP-safe broken-image fallback. The `error` event doesn't bubble, so we
  // use capture phase once per page to catch any failing <img.sh-fd-cover-img>
  // and swap the parent wrapper for the generic placeholder.
  var _imgErrorWired = false;
  function _wireImageFallback(root) {
    if (_imgErrorWired) return;
    _imgErrorWired = true;
    root.addEventListener('error', function (e) {
      var t = e.target;
      if (t && t.tagName === 'IMG' && t.classList && t.classList.contains('sh-fd-cover-img')) {
        var wrap = t.parentElement;
        if (wrap) wrap.innerHTML = '<div class="sh-fd-img-placeholder" style="height:100%;display:flex;align-items:center;justify-content:center">' +
          '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" style="color:var(--sh-text-4)">' +
          '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>' +
          '</svg></div>';
      }
    }, true);
  }

  function load(feedId) {
    var root = document.getElementById('page-feed-detail');
    if (!root) return;
    _wireImageFallback(root);

    // feedId can come as explicit arg or via dashboard.state.currentFeedId
    if (feedId) _state.feedId = feedId;
    else if (window.__dashboard && window.__dashboard.state) _state.feedId = window.__dashboard.state.currentFeedId || null;

    if (!_state.feedId) {
      root.classList.add('sh-root');
      root.innerHTML = '<div class="sh-empty" style="padding:48px">No feed selected.</div>';
      return;
    }

    _state.tab = 'stories';
    _state.selectedClusterId = null;
    _state.feed = null;
    _state.clusters = [];
    _state.loading = true;
    root.classList.add('sh-root');
    root.innerHTML = '<div class="sh-skel" style="width:240px;height:24px;margin-bottom:20px"></div>' +
      '<div class="sh-skel" style="height:40px;margin-bottom:14px"></div>' +
      '<div class="sh-skel" style="height:400px"></div>';

    refreshFeed().then(function () {
      _state.loading = false;
      render();
    });
    startPolling();
  }

  function startPolling() {
    stopPolling();
    _pollTimer = setInterval(function () {
      if (document.hidden) return;
      if (_state.tab === 'stories') refreshFeed();
    }, 45000);
    if (window.__dashboard && window.__dashboard.state && window.__dashboard.state.refreshTimers) {
      window.__dashboard.state.refreshTimers.push(_pollTimer);
    }
  }
  function stopPolling() { if (_pollTimer) clearInterval(_pollTimer); _pollTimer = null; }

  window.__feedDetail = {
    load: load,
    back: back,
    setTab: setTab,
    setSelectedCluster: setSelectedCluster,
    toggleHideBelow: toggleHideBelow,
    togglePause: togglePause,
    setCfg: setCfg,
    saveConfig: saveConfig,
    resetConfig: resetConfig,
    setSetg: setSetg,
    saveSettings: saveSettings,
    deleteFeed: deleteFeed,
    openClusterEditor: openClusterEditor,
    publishCluster: publishCluster,
    skipCluster: skipCluster,
  };
}());
