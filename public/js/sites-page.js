/* ================================================================
   Sites page — vanilla JS port of design/jsx/sites.jsx.
   Renders the landing grid of site cards; clicking a card switches
   the active site and navigates to its Overview. The old CRUD form
   from dashboard.js (_sitesShowForm) remains reachable via the
   "+ Connect site" tile for Phase 1.
   ================================================================ */

(function () {
  'use strict';

  var _state = { sites: [], stats: {} };
  var _pollTimer = null;

  // ─── Helpers (shared with site-home.js where possible) ─────────────────
  function escapeHtml(str) {
    if (str == null) return '';
    var div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
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

  function siteAvatar(name, color, size) {
    size = size || 40;
    var letter = (name || '?').charAt(0).toUpperCase();
    var bg;
    if (color && color.indexOf('#') === 0) {
      bg = 'linear-gradient(135deg,' + color + ',' + color + 'cc)';
    } else if (color) {
      bg = color;
    } else {
      var hue = 0;
      for (var i = 0; i < (name || '').length; i++) hue = (hue + name.charCodeAt(i)) % 360;
      bg = 'linear-gradient(135deg,hsl(' + hue + ',55%,50%),hsl(' + ((hue + 30) % 360) + ',55%,60%))';
    }
    var cls = size >= 40 ? 'sh-avatar sh-avatar-lg' : 'sh-avatar';
    return '<span class="' + cls + '" style="background:' + bg +
      ';width:' + size + 'px;height:' + size + 'px;font-size:' + Math.round(size * 0.42) + 'px">' +
      escapeHtml(letter) + '</span>';
  }

  function sparkline(data, w, h, color) {
    w = w || 260; h = h || 32; color = color || 'var(--sh-accent)';
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
    return '<svg width="' + w + '" height="' + h + '" style="display:block;width:100%;height:' + h + 'px">' +
      '<path d="' + fillPath + '" fill="' + color + '" fill-opacity="0.12"/>' +
      '<path d="' + linePath + '" fill="none" stroke="' + color + '" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '</svg>';
  }

  function icon(name, size) {
    size = size || 14;
    // Reuse lucide — the SVGs are rewritten at page init by /js/lucide.min.js.
    return '<svg data-lucide="' + name + '" width="' + size + '" height="' + size + '" style="flex-shrink:0"></svg>';
  }

  // ─── Rendering ─────────────────────────────────────────────────────────
  function render() {
    var root = document.getElementById('page-sites');
    if (!root) return;
    root.classList.add('sh-root');

    var sites = _state.sites || [];

    var cardsHtml = sites.map(function (s) {
      var stats = _state.stats[s.id] || {};
      var pubToday = stats.publishedToday != null ? stats.publishedToday : '—';
      var fhHealthy = stats.health && stats.health.firehose === 'ok';
      var wpOk = !!s.has_wp;
      var health = wpOk ? (fhHealthy ? 95 : (s.has_firehose ? 65 : 50)) : 15;

      // Synthetic 12-point trend from what we have. Flat at 0 if no pubs.
      var trendVal = typeof stats.publishedToday === 'number' ? stats.publishedToday : 0;
      var trend = [];
      for (var t = 0; t < 12; t++) trend.push(Math.max(0, trendVal + (Math.sin(t) * trendVal * 0.3) | 0));

      var statusBadge = wpOk
        ? '<span class="sh-badge sh-badge-green"><span class="sh-dot sh-dot-green"></span>Live</span>'
        : '<span class="sh-badge sh-badge-red"><span class="sh-dot sh-dot-red"></span>Auth</span>';

      var healthColor = health > 70 ? 'var(--sh-green)' : (health > 30 ? 'var(--sh-amber)' : 'var(--sh-red)');
      var authBanner = wpOk ? '' :
        '<div class="sh-sites-authbar">' +
          icon('alert-triangle', 14) +
          '<span>WordPress not configured</span>' +
          '<button class="sh-btn sh-btn-sm" data-click="sitesEditSite" data-site-id="' + s.id + '" style="margin-left:auto">Connect</button>' +
        '</div>';

      return '<button class="sh-sites-card" data-click="sitesOpenSite" data-site-id="' + s.id + '">' +
        '<div style="padding:18px">' +
          '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">' +
            siteAvatar(s.name, s.color, 40) +
            '<div style="flex:1;min-width:0;text-align:left">' +
              '<div style="font-weight:600;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(s.name) + '</div>' +
              '<div style="font-size:12px;color:var(--sh-text-3);margin-top:1px">WordPress</div>' +
            '</div>' +
            statusBadge +
          '</div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px">' +
            '<div>' +
              '<div class="sh-stat-label">Today</div>' +
              '<div style="font-size:20px;font-weight:600;letter-spacing:-0.02em;margin-top:2px" class="sh-tabular">' + escapeHtml(String(pubToday)) + '</div>' +
            '</div>' +
            '<div>' +
              '<div class="sh-stat-label">Feeds</div>' +
              '<div style="font-size:20px;font-weight:600;letter-spacing:-0.02em;margin-top:2px" class="sh-tabular">' + escapeHtml(String(stats.feedsActive != null ? stats.feedsActive : (stats.draftsReady != null ? stats.draftsReady : '—'))) + '</div>' +
            '</div>' +
            '<div>' +
              '<div class="sh-stat-label">Health</div>' +
              '<div style="font-size:20px;font-weight:600;letter-spacing:-0.02em;margin-top:2px;color:' + healthColor + '" class="sh-tabular">' + health + '%</div>' +
            '</div>' +
          '</div>' +
          '<div style="margin-top:14px;padding-top:14px;border-top:1px solid var(--sh-border)">' +
            sparkline(trend, 260, 32, health > 30 ? 'var(--sh-accent)' : 'var(--sh-red)') +
            '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--sh-text-3);margin-top:4px">' +
              '<span>12 h ago</span><span>now</span>' +
            '</div>' +
          '</div>' +
        '</div>' +
        authBanner +
      '</button>';
    }).join('');

    // Add-tile
    var addTile =
      '<button class="sh-sites-add" data-click="sitesAddSite">' +
        '<div class="sh-sites-add-icon">' + icon('plus', 18) + '</div>' +
        '<div style="font-size:14px;font-weight:500;color:var(--sh-text-2)">Connect a site</div>' +
        '<div style="font-size:12px;color:var(--sh-text-3);margin-top:3px">WordPress</div>' +
      '</button>';

    root.innerHTML =
      '<div class="sh-page-head">' +
        '<div>' +
          '<h1 class="sh-page-title">Sites</h1>' +
          '<div class="sh-page-sub">' +
            '<span>Each site is a workspace with its own feeds, clusters, and published content.</span>' +
          '</div>' +
        '</div>' +
        '<div class="sh-page-actions">' +
          '<button class="sh-btn" data-click="sitesRefresh">' + icon('refresh-ccw', 14) + 'Refresh</button>' +
          '<button class="sh-btn sh-btn-primary" data-click="sitesAddSite">' + icon('plus', 14) + 'Connect site</button>' +
        '</div>' +
      '</div>' +
      '<div class="sh-sites-grid">' +
        cardsHtml +
        addTile +
      '</div>' +
      // Legacy add/edit form injects here when user clicks Connect/Edit.
      '<div id="sites-form-wrap" style="margin-top:24px"></div>';

    // Let lucide rewrite new <svg data-lucide=..> tags.
    if (window.lucide && typeof window.lucide.createIcons === 'function') window.lucide.createIcons();
  }

  // ─── Data loading ──────────────────────────────────────────────────────
  function refreshAll() {
    return api('/api/sites').then(function (data) {
      _state.sites = (data && data.sites) || [];
      if (window.__dashboard && window.__dashboard.state) window.__dashboard.state.sites = _state.sites;

      // Fetch per-site stats in parallel.
      var promises = _state.sites.map(function (s) {
        return api('/api/sites/' + s.id + '/stats')
          .then(function (st) { _state.stats[s.id] = st; })
          .catch(function () { _state.stats[s.id] = {}; });
      });
      return Promise.all(promises);
    }).then(function () {
      render();
      // Keep the sidebar switcher fresh.
      if (window.__siteHome && typeof window.__siteHome.updateSidebarSwitcher === 'function') {
        window.__siteHome.updateSidebarSwitcher();
      }
    }).catch(function (err) {
      console.warn('[sites] load failed:', err && err.message);
    });
  }

  // ─── Public API ────────────────────────────────────────────────────────
  function load() {
    var root = document.getElementById('page-sites');
    if (!root) return;
    root.classList.add('sh-root');
    root.innerHTML = '<div class="sh-page-head"><div class="sh-skel" style="width:200px;height:24px"></div></div>' +
      '<div class="sh-sites-grid">' +
        '<div class="sh-skel" style="height:240px"></div>' +
        '<div class="sh-skel" style="height:240px"></div>' +
        '<div class="sh-skel" style="height:240px"></div>' +
      '</div>';
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

  function openSite(siteId) {
    // Switch via the legacy select → dashboard.switchSite keeps guards intact.
    var sel = document.getElementById('site-selector');
    if (sel) {
      sel.value = String(siteId);
      var evt = new Event('change', { bubbles: true });
      sel.dispatchEvent(evt);
      // After switch, land on the site's overview.
      setTimeout(function () {
        if (window.__dashboard && typeof window.__dashboard.navigateTo === 'function') {
          window.__dashboard.navigateTo('overview');
        } else {
          window.location.hash = 'overview';
        }
      }, 30);
    }
  }

  function addSite() {
    // Reuse the existing form flow from dashboard.js.
    if (typeof window._sitesShowForm === 'function') {
      window._sitesShowForm(null);
    } else {
      // Fallback: navigate to legacy sites CRUD URL anchor.
      alert('Site connect flow is loading — try again in a moment.');
    }
  }

  function editSite(siteId) {
    if (typeof window._sitesShowForm === 'function') {
      window._sitesShowForm(siteId);
    }
  }

  window.__sitesPage = {
    load: load,
    refreshAll: refreshAll,
    openSite: openSite,
    addSite: addSite,
    editSite: editSite
  };
}());
