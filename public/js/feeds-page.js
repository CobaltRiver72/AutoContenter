/* ================================================================
   Feeds page — vanilla JS port of design/jsx/feeds.jsx.
   Renders the list of feeds for the active site as either a table
   (default) or a card grid. Filter + search are client-side for v1;
   bulk pause/resume/delete hit the backend endpoints that already
   exist. Clicking a row is a placeholder until the Feed detail
   redesign ships.
   ================================================================ */

(function () {
  'use strict';

  var _state = {
    feeds: [],
    stats: {},
    view: 'table',          // 'table' | 'cards'
    search: '',
    statusFilter: 'all',    // 'all' | 'active' | 'paused' | 'failed'
    sourceFilter: 'all',    // 'all' | 'firehose' | 'rss' | 'youtube' | 'keyword'
    selected: {},           // { [id]: true }
  };
  var _pollTimer = null;

  // ─── Helpers ────────────────────────────────────────────────────────────
  function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function api(path) {
    if (window.__dashboard && typeof window.__dashboard.fetchApi === 'function') {
      return window.__dashboard.fetchApi(path, { bypassCache: true });
    }
    return fetch(path, { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401) { window.location.href = '/login'; throw new Error('Unauthorized'); }
      return r.json();
    });
  }

  function apiPost(path) {
    if (window.__dashboard && typeof window.__dashboard.fetchApi === 'function') {
      return window.__dashboard.fetchApi(path, { method: 'POST' });
    }
    return fetch(path, { method: 'POST', credentials: 'same-origin' }).then(function (r) { return r.json(); });
  }

  function apiPut(path, body) {
    if (window.__dashboard && typeof window.__dashboard.fetchApi === 'function') {
      return window.__dashboard.fetchApi(path, { method: 'PUT', body: body });
    }
    return fetch(path, {
      method: 'PUT',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json(); });
  }

  function icon(name, size) {
    size = size || 14;
    return '<svg data-lucide="' + name + '" width="' + size + '" height="' + size + '" style="flex-shrink:0"></svg>';
  }

  function sparkline(data, w, h, color) {
    w = w || 80; h = h || 20; color = color || 'var(--sh-accent)';
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
      '<path d="' + fillPath + '" fill="' + color + '" fill-opacity="0.12"/>' +
      '<path d="' + linePath + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';
  }

  function relativeTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso.indexOf('T') === -1 ? iso.replace(' ', 'T') + 'Z' : iso);
    if (isNaN(d.getTime())) return '—';
    var diff = Date.now() - d.getTime();
    var m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm';
    var hr = Math.floor(m / 60);
    if (hr < 24) return hr + 'h';
    var days = Math.floor(hr / 24);
    if (days < 30) return days + 'd';
    return d.toLocaleDateString();
  }

  // Compute "active" / "paused" / "failed" from raw feed + stats.
  // Mirrors design/jsx/feeds.jsx:statusBadge input set (active, paused, failed).
  function _deriveStatus(feed, stats) {
    if (!feed.is_active) return 'paused';
    // "failed" = active but no article in > 2h AND feed was configured (had token).
    var last = stats && stats.lastArticleAt;
    if (last) {
      var ageHr = (Date.now() - new Date(last.replace(' ', 'T') + 'Z').getTime()) / 3600000;
      if (ageHr > 2 && (feed.has_firehose_token || feed.kind !== 'firehose')) return 'failed';
    }
    return 'active';
  }

  function _statusBadge(st) {
    var map = {
      active: { cls: 'sh-badge-green',   dot: 'sh-dot-green', label: 'Active' },
      paused: { cls: 'sh-badge-neutral', dot: 'sh-dot-gray',  label: 'Paused' },
      failed: { cls: 'sh-badge-red',     dot: 'sh-dot-red',   label: 'Failed' },
    };
    var m = map[st] || map.paused;
    return '<span class="sh-badge ' + m.cls + '"><span class="sh-dot ' + m.dot + '"></span>' + m.label + '</span>';
  }

  function _kindLabel(k) {
    if (k === 'firehose') return 'Firehose';
    if (k === 'rss')      return 'RSS';
    if (k === 'youtube')  return 'YouTube';
    if (k === 'keyword')  return 'Keyword';
    return k || '—';
  }

  function _queryOf(feed) {
    var sc = feed.source_config || {};
    return sc.query || sc.rule_value || sc.url || sc.term || '';
  }

  function _selectedIds() {
    var out = [];
    for (var id in _state.selected) if (_state.selected[id]) out.push(Number(id));
    return out;
  }

  // ─── Data ──────────────────────────────────────────────────────────────
  function refreshAll() {
    return api('/api/feeds').then(function (data) {
      _state.feeds = (data && data.feeds) || [];
      if (!_state.feeds.length) { render(); return null; }
      var ids = _state.feeds.map(function (f) { return f.id; }).join(',');
      return api('/api/feeds/stats?ids=' + ids).then(function (s) {
        _state.stats = (s && s.stats) || {};
        render();
      });
    }).catch(function (err) {
      console.warn('[feeds] load failed:', err && err.message);
    });
  }

  // ─── Filtering / sorting ───────────────────────────────────────────────
  function _visibleFeeds() {
    var q = (_state.search || '').trim().toLowerCase();
    return _state.feeds.filter(function (f) {
      if (_state.statusFilter !== 'all' && _deriveStatus(f, _state.stats[f.id]) !== _state.statusFilter) return false;
      if (_state.sourceFilter !== 'all' && f.kind !== _state.sourceFilter) return false;
      if (q) {
        var name = (f.name || '').toLowerCase();
        var qr = _queryOf(f).toLowerCase();
        if (name.indexOf(q) === -1 && qr.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  // ─── Rendering ─────────────────────────────────────────────────────────
  function render() {
    var root = document.getElementById('page-feeds');
    if (!root) return;
    root.classList.add('sh-root');

    var feeds = _visibleFeeds();
    var stats = _state.stats;

    // Totals line for header
    var totalFeeds = _state.feeds.length;
    var sum24 = 0, healthy = 0, failing = 0;
    for (var i = 0; i < _state.feeds.length; i++) {
      var st = stats[_state.feeds[i].id] || {};
      sum24 += st.articlesToday || 0;
      var s = _deriveStatus(_state.feeds[i], st);
      if (s === 'active') healthy++;
      if (s === 'failed') failing++;
    }

    var selCount = _selectedIds().length;

    root.innerHTML =
      '<div class="sh-page-head">' +
        '<div>' +
          '<h1 class="sh-page-title">Feeds</h1>' +
          '<div class="sh-page-sub">' +
            totalFeeds + ' feed' + (totalFeeds === 1 ? '' : 's') +
            ' · ' + sum24 + ' stories in last 24h · ' +
            '<span style="color:var(--sh-green)">' + healthy + ' healthy</span>' +
            (failing ? ' · <span style="color:var(--sh-red)">' + failing + ' failing</span>' : '') +
          '</div>' +
        '</div>' +
        '<div class="sh-page-actions">' +
          '<div class="sh-btn-group">' +
            '<button class="sh-btn' + (_state.view === 'table' ? ' sh-btn-active' : ' sh-btn-ghost') + '" data-click="feedsSetView" data-view="table" title="Table">' + icon('table-2', 14) + '</button>' +
            '<button class="sh-btn' + (_state.view === 'cards' ? ' sh-btn-active' : ' sh-btn-ghost') + '" data-click="feedsSetView" data-view="cards" title="Cards">' + icon('layout-grid', 14) + '</button>' +
          '</div>' +
          '<button class="sh-btn" data-click="feedsAdvancedFilter">' + icon('filter', 14) + 'Filter</button>' +
          '<button class="sh-btn sh-btn-primary" data-click="feedsNew">' + icon('plus', 14) + 'New feed</button>' +
        '</div>' +
      '</div>' +

      // Filter bar
      '<div class="sh-feeds-toolbar">' +
        '<div class="sh-input-wrap" style="flex:1;max-width:320px">' +
          '<span class="sh-input-icon">' + icon('search', 13) + '</span>' +
          '<input class="sh-input sh-input-search" type="text" placeholder="Search feeds or queries…" value="' + escapeHtml(_state.search) + '" data-input="feedsSearch"/>' +
        '</div>' +
        '<select class="sh-select" data-change="feedsStatusFilter">' +
          '<option value="all"' + (_state.statusFilter === 'all' ? ' selected' : '') + '>All statuses</option>' +
          '<option value="active"' + (_state.statusFilter === 'active' ? ' selected' : '') + '>Active</option>' +
          '<option value="paused"' + (_state.statusFilter === 'paused' ? ' selected' : '') + '>Paused</option>' +
          '<option value="failed"' + (_state.statusFilter === 'failed' ? ' selected' : '') + '>Failed</option>' +
        '</select>' +
        '<select class="sh-select" data-change="feedsSourceFilter">' +
          '<option value="all"' + (_state.sourceFilter === 'all' ? ' selected' : '') + '>All sources</option>' +
          '<option value="firehose"' + (_state.sourceFilter === 'firehose' ? ' selected' : '') + '>Firehose</option>' +
          '<option value="rss"' + (_state.sourceFilter === 'rss' ? ' selected' : '') + '>RSS</option>' +
          '<option value="youtube"' + (_state.sourceFilter === 'youtube' ? ' selected' : '') + '>YouTube</option>' +
          '<option value="keyword"' + (_state.sourceFilter === 'keyword' ? ' selected' : '') + '>Keyword</option>' +
        '</select>' +
        '<div style="flex:1"></div>' +
        (selCount ? (
          '<span style="font-size:12px;color:var(--sh-text-3)">' + selCount + ' selected</span>' +
          '<button class="sh-btn sh-btn-sm" data-click="feedsBulkPause">' + icon('pause', 12) + 'Pause</button>' +
          '<button class="sh-btn sh-btn-sm" data-click="feedsBulkResume">' + icon('play', 12) + 'Resume</button>' +
          '<button class="sh-btn sh-btn-sm sh-btn-danger" data-click="feedsBulkDelete">' + icon('trash-2', 12) + 'Delete</button>'
        ) : '') +
      '</div>' +

      (feeds.length === 0
        ? _emptyStateHtml(totalFeeds)
        : (_state.view === 'table' ? _renderTable(feeds) : _renderCards(feeds)));

    if (window.lucide && typeof window.lucide.createIcons === 'function') window.lucide.createIcons();
  }

  function _emptyStateHtml(totalFeeds) {
    if (totalFeeds === 0) {
      return '<div class="sh-card" style="padding:48px 24px;text-align:center">' +
        '<div style="font-size:40px;margin-bottom:10px;opacity:0.4">' + icon('rss', 40) + '</div>' +
        '<div style="font-size:16px;font-weight:500;margin-bottom:4px">No feeds yet</div>' +
        '<div style="font-size:13px;color:var(--sh-text-3);margin-bottom:16px">Create your first feed to start pulling articles in.</div>' +
        '<button class="sh-btn sh-btn-primary" data-click="feedsNew" style="margin:0 auto">' + icon('plus', 14) + 'New feed</button>' +
      '</div>';
    }
    return '<div class="sh-empty" style="border:1px solid var(--sh-border);border-radius:var(--sh-r-lg);background:var(--sh-surface)">No feeds match the current filters.</div>';
  }

  function _renderTable(feeds) {
    var rows = feeds.map(function (f) {
      var st = _state.stats[f.id] || {};
      var status = _deriveStatus(f, st);
      var pubRatio = (st.publishedToday || 0) + '/' + Math.max(st.publishedToday || 0, st.clustersTotal || 0);
      var last24 = st.articlesToday || 0;
      var health = status === 'active' ? 0.9 : (status === 'paused' ? 0 : 0.2);
      var trendColor = health > 0.7 ? 'var(--sh-green)' : (health > 0.3 ? 'var(--sh-amber)' : 'var(--sh-red)');
      // Synthetic 12-pt trend from articlesToday; flat line if zero.
      var trend = [];
      for (var t = 0; t < 12; t++) trend.push(Math.max(0, (last24 / 12 | 0) + Math.floor(Math.sin(t) * (last24 / 24))));

      var checked = !!_state.selected[f.id];
      return '<tr class="' + (checked ? 'sh-tr-selected' : '') + '" data-click="feedsOpenFeed" data-feed-id="' + f.id + '">' +
        '<td data-click="feedsToggleSelect" data-feed-id="' + f.id + '" style="width:36px">' +
          '<input type="checkbox" class="sh-check"' + (checked ? ' checked' : '') + ' data-click="feedsToggleSelect" data-feed-id="' + f.id + '"/>' +
        '</td>' +
        '<td>' +
          '<div style="font-weight:550;font-size:13.5px">' + escapeHtml(f.name) + '</div>' +
          '<div class="sh-mono" style="color:var(--sh-text-3);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:360px">' + escapeHtml(_queryOf(f) || '—') + '</div>' +
        '</td>' +
        '<td style="width:130px">' +
          '<div style="display:flex;align-items:center;gap:6px">' +
            sparkline(trend, 80, 20, trendColor) +
            '<span class="sh-tabular" style="font-size:12px;color:var(--sh-text-3)">' + Math.round(health * 100) + '%</span>' +
          '</div>' +
        '</td>' +
        '<td style="width:100px;font-size:12.5px;color:var(--sh-text-2)">' + escapeHtml(_kindLabel(f.kind)) + '</td>' +
        '<td style="width:90px">' + _statusBadge(status) + '</td>' +
        '<td class="sh-tabular" style="text-align:right;width:80px;font-size:13px">' + last24 + '</td>' +
        '<td class="sh-tabular" style="text-align:right;width:100px;font-size:13px;color:var(--sh-text-2)">' + pubRatio + '</td>' +
        '<td class="sh-tabular" style="text-align:right;width:70px;font-size:12px;color:var(--sh-text-3)">' + relativeTime(f.last_fetched_at) + '</td>' +
        '<td style="width:40px" data-click="feedsRowMenu" data-feed-id="' + f.id + '">' +
          '<button class="sh-btn sh-btn-sm sh-btn-ghost">' + icon('more-horizontal', 14) + '</button>' +
        '</td>' +
      '</tr>';
    }).join('');

    return '<div class="sh-card sh-feeds-table-wrap">' +
      '<table class="sh-table">' +
        '<thead><tr>' +
          '<th style="width:36px"><input type="checkbox" class="sh-check" data-click="feedsToggleSelectAll"/></th>' +
          '<th>Name / Query</th>' +
          '<th style="width:130px">Health</th>' +
          '<th style="width:100px">Source</th>' +
          '<th style="width:90px">Status</th>' +
          '<th style="width:80px;text-align:right">24h</th>' +
          '<th style="width:100px;text-align:right">Published</th>' +
          '<th style="width:70px;text-align:right">Last</th>' +
          '<th style="width:40px"></th>' +
        '</tr></thead>' +
        '<tbody>' + rows + '</tbody>' +
      '</table>' +
    '</div>';
  }

  function _renderCards(feeds) {
    var cards = feeds.map(function (f) {
      var st = _state.stats[f.id] || {};
      var status = _deriveStatus(f, st);
      var last24 = st.articlesToday || 0;
      var pubRatio = (st.publishedToday || 0) + '/' + Math.max(st.publishedToday || 0, st.clustersTotal || 0);
      var health = status === 'active' ? 0.9 : (status === 'paused' ? 0 : 0.2);
      var trendColor = health > 0.7 ? 'var(--sh-green)' : (health > 0.3 ? 'var(--sh-amber)' : 'var(--sh-red)');
      var trend = [];
      for (var t = 0; t < 12; t++) trend.push(Math.max(0, (last24 / 12 | 0) + Math.floor(Math.sin(t) * (last24 / 24))));
      return '<div class="sh-sites-card" style="padding:16px" data-click="feedsOpenFeed" data-feed-id="' + f.id + '">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
          '<span style="font-weight:600;font-size:14px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(f.name) + '</span>' +
          _statusBadge(status) +
        '</div>' +
        '<div class="sh-mono" style="color:var(--sh-text-3);margin-bottom:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(_queryOf(f) || '—') + '</div>' +
        sparkline(trend, 288, 32, trendColor) +
        '<div style="display:flex;gap:14px;font-size:12px;color:var(--sh-text-3);margin-top:10px">' +
          '<span><b class="sh-tabular" style="color:var(--sh-text)">' + last24 + '</b> stories</span>' +
          '<span>pub <b class="sh-tabular" style="color:var(--sh-text)">' + pubRatio + '</b></span>' +
          '<span style="margin-left:auto">' + relativeTime(f.last_fetched_at) + '</span>' +
        '</div>' +
      '</div>';
    }).join('');

    return '<div class="sh-sites-grid">' + cards + '</div>';
  }

  // ─── Action handlers ───────────────────────────────────────────────────
  function setView(v) { _state.view = v; render(); }
  function setSearch(v) { _state.search = v; render(); }
  function setStatusFilter(v) { _state.statusFilter = v; render(); }
  function setSourceFilter(v) { _state.sourceFilter = v; render(); }

  function toggleSelect(id) {
    _state.selected[id] = !_state.selected[id];
    if (!_state.selected[id]) delete _state.selected[id];
    render();
  }
  function toggleSelectAll() {
    var visible = _visibleFeeds();
    var allSelected = visible.every(function (f) { return _state.selected[f.id]; });
    if (allSelected) {
      _state.selected = {};
    } else {
      visible.forEach(function (f) { _state.selected[f.id] = true; });
    }
    render();
  }

  function openFeed(id) {
    // navigateTo(page, id) writes the id into the URL hash so a refresh
    // restores the same feed. Also still pokes state.currentFeedId for any
    // downstream module that hasn't yet been migrated to read the id arg
    // from load(id) — belt and suspenders.
    if (window.__dashboard && window.__dashboard.state) window.__dashboard.state.currentFeedId = id;
    if (window.__dashboard && typeof window.__dashboard.navigateTo === 'function') {
      window.__dashboard.navigateTo('feed-detail', id);
    } else {
      window.location.hash = 'feed-detail/' + id;
    }
  }

  function rowMenu(_id) {
    // TODO: popover with Pause / Rename / Duplicate / Delete. v1: no-op.
  }

  function newFeed() {
    // TODO: route to /create-feed when that screen lands. v1: fall back to
    // the legacy Feeds page's "+ New feed" form if one is exposed, else the
    // legacy Sites add form doesn't help — just show a toast.
    if (typeof window.__openCreateFeedFlow === 'function') {
      window.__openCreateFeedFlow();
    } else {
      alert('New feed creation flow is next on the list — using the legacy page for now.');
      window.location.hash = 'feeds?new=1';
    }
  }

  function bulkPause() {
    var ids = _selectedIds();
    if (!ids.length) return;
    if (!confirm('Pause ' + ids.length + ' feed' + (ids.length === 1 ? '' : 's') + '?')) return;
    // Use PUT with is_active=false so Pause flips the flag; previously this
    // pointed at /destroy which would have permanently deleted the feeds —
    // never ship that default.
    Promise.all(ids.map(function (id) { return apiPut('/api/feeds/' + id, { is_active: false }); }))
      .then(function () { _state.selected = {}; refreshAll(); });
  }
  function bulkResume() {
    var ids = _selectedIds();
    if (!ids.length) return;
    Promise.all(ids.map(function (id) { return apiPost('/api/feeds/' + id + '/activate'); }))
      .then(function () { _state.selected = {}; refreshAll(); });
  }
  function bulkDelete() {
    var ids = _selectedIds();
    if (!ids.length) return;
    if (!confirm('Delete ' + ids.length + ' feed' + (ids.length === 1 ? '' : 's') + '? This cannot be undone.')) return;
    Promise.all(ids.map(function (id) { return apiPost('/api/feeds/' + id + '/destroy'); }))
      .then(function () { _state.selected = {}; refreshAll(); });
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────
  function load() {
    var root = document.getElementById('page-feeds');
    if (!root) return;
    root.classList.add('sh-root');
    root.innerHTML = '<div class="sh-page-head"><div class="sh-skel" style="width:200px;height:24px"></div></div>' +
      '<div class="sh-skel" style="height:40px;margin-bottom:14px"></div>' +
      '<div class="sh-skel" style="height:300px"></div>';
    refreshAll();
    startPolling();
  }

  function startPolling() {
    stopPolling();
    _pollTimer = setInterval(function () {
      if (document.hidden) return;
      refreshAll();
    }, 45000);
    if (window.__dashboard && window.__dashboard.state && window.__dashboard.state.refreshTimers) {
      window.__dashboard.state.refreshTimers.push(_pollTimer);
    }
  }
  function stopPolling() { if (_pollTimer) clearInterval(_pollTimer); _pollTimer = null; }

  window.__feedsPage = {
    load: load,
    refreshAll: refreshAll,
    setView: setView,
    setSearch: setSearch,
    setStatusFilter: setStatusFilter,
    setSourceFilter: setSourceFilter,
    toggleSelect: toggleSelect,
    toggleSelectAll: toggleSelectAll,
    openFeed: openFeed,
    rowMenu: rowMenu,
    newFeed: newFeed,
    bulkPause: bulkPause,
    bulkResume: bulkResume,
    bulkDelete: bulkDelete,
    // Getter so create-feed-page.js can populate its "clone" row.
    getFeeds: function () { return _state.feeds.slice(); },
  };
}());
