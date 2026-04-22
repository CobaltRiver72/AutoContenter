/* ================================================================
   Site settings — vanilla JS port of design/jsx/site-settings.jsx.
   Five tabs: Connection / Publishing / Categories & tags / Images / Users.
   Publishing is the detailed view (matches JSX); the other four
   render the design's empty-state placeholder for now.
   Publishing-tab state persists via /api/sites/:id/config.
   ================================================================ */

(function () {
  'use strict';

  // Default rule set the JSX shows — used as a seed when the site has no
  // stored rules yet.
  var SEED_RULES = [
    { id: 'r_min_sources',   cond: 'cluster has ≥ 4 sources',            act: 'auto-publish',            on: true },
    { id: 'r_quality',       cond: 'quality score ≥ 0.8',                act: 'auto-publish',            on: true },
    { id: 'r_review_tag',    cond: 'matches tag: review',                 act: 'skip auto · queue',       on: true },
    { id: 'r_ford',          cond: 'title contains brand: Ford',          act: 'add category: Ford',     on: true },
    { id: 'r_deals',         cond: 'title contains "deal" or "discount"', act: 'add category: Deals',    on: false },
  ];

  var DAYS = ['Mo','Tu','We','Th','Fr','Sa','Su'];

  var _state = {
    siteId: null,
    site: null,
    tab: 'publish',
    loading: false,
    saving: false,
    cfg: {
      postStatus:    'draft',
      author:        'auto',
      featuredImage: 'auto',
      canonical:     'self',
      days:          [true, true, true, true, true, false, false],
      windowStart:   '08:00',
      windowEnd:     '22:00',
      rules:         SEED_RULES,
    },
    wpCheck: null,    // { ok, wp_url, at }
  };

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
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    var diff = Date.now() - d.getTime();
    var m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    var hr = Math.floor(m / 60);
    if (hr < 24) return hr + 'h ago';
    return Math.floor(hr / 24) + 'd ago';
  }
  function siteAvatar(name, color, size) {
    size = size || 40;
    var letter = (name || '?').charAt(0).toUpperCase();
    var bg;
    if (color && color.indexOf('#') === 0) {
      bg = 'linear-gradient(135deg,' + color + ',' + color + 'cc)';
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

  // ─── Data loading ──────────────────────────────────────────────────────
  function refresh() {
    if (!_state.siteId) return Promise.resolve();
    _state.loading = true;
    return Promise.all([
      api('/api/sites/' + _state.siteId).catch(function () { return null; }),
      api('/api/sites/' + _state.siteId + '/config').catch(function () { return null; }),
    ]).then(function (res) {
      var siteResp = res[0], cfgResp = res[1];
      _state.site = siteResp && (siteResp.site || siteResp);

      var config = (cfgResp && cfgResp.config) || {};
      // Pull our UI state from the config key/value store, falling back to
      // defaults when the site hasn't customised anything yet.
      _state.cfg.postStatus    = config.SITE_POST_STATUS       || 'draft';
      _state.cfg.author        = config.SITE_AUTHOR_MODE       || 'auto';
      _state.cfg.featuredImage = config.SITE_FEATURED_IMAGE_MODE || 'auto';
      _state.cfg.canonical     = config.SITE_CANONICAL_MODE    || 'self';

      var sched = _safeJson(config.SITE_PUBLISH_SCHEDULE);
      if (sched) {
        if (Array.isArray(sched.days) && sched.days.length === 7) _state.cfg.days = sched.days;
        if (sched.windowStart) _state.cfg.windowStart = sched.windowStart;
        if (sched.windowEnd)   _state.cfg.windowEnd   = sched.windowEnd;
      }

      var rules = _safeJson(config.SITE_AUTOMATION_RULES);
      if (Array.isArray(rules) && rules.length) _state.cfg.rules = rules;

      _state.loading = false;
      render();
    });
  }

  function _safeJson(s) {
    if (!s || typeof s !== 'string') return null;
    try { return JSON.parse(s); } catch (_e) { return null; }
  }

  function _saveConfig(patch) {
    _state.saving = true; render();
    return api('/api/sites/' + _state.siteId + '/config', { method: 'PUT', body: { config: patch } })
      .then(function (r) {
        _state.saving = false;
        if (!r || !r.ok) alert('Save failed: ' + ((r && r.error) || 'unknown'));
        render();
      })
      .catch(function (err) {
        _state.saving = false;
        alert('Save failed: ' + (err && err.message));
        render();
      });
  }

  function testWp() {
    _state.wpCheck = { checking: true };
    render();
    api('/api/sites/' + _state.siteId + '/test-wp', { method: 'POST' })
      .then(function (r) {
        _state.wpCheck = { ok: !!(r && r.ok), message: (r && (r.message || r.error)) || '', at: new Date().toISOString() };
        render();
      }).catch(function (err) {
        _state.wpCheck = { ok: false, message: err && err.message, at: new Date().toISOString() };
        render();
      });
  }

  // ─── Rendering ─────────────────────────────────────────────────────────
  function render() {
    var root = document.getElementById('page-site-settings');
    if (!root) return;
    root.classList.add('sh-root');

    if (_state.loading && !_state.site) {
      root.innerHTML = '<div class="sh-empty" style="padding:48px">Loading…</div>';
      return;
    }
    if (!_state.site) {
      root.innerHTML = '<div class="sh-empty" style="padding:48px">No site selected. <a href="#sites" style="color:var(--sh-accent-text)">Pick one</a>.</div>';
      return;
    }

    root.innerHTML =
      _renderHeader() +
      _renderTabs() +
      (_state.tab === 'publish' ? _renderPublishingTab() : _renderEmptyTab(_state.tab));

    if (window.lucide && typeof window.lucide.createIcons === 'function') window.lucide.createIcons();
  }

  function _renderHeader() {
    var s = _state.site;
    return '<div class="sh-page-head">' +
      '<div style="display:flex;align-items:center;gap:14px">' +
        siteAvatar(s.name, s.color, 40) +
        '<div>' +
          '<h1 class="sh-page-title">' + escapeHtml(s.name) + '</h1>' +
          '<div class="sh-page-sub"><span>Site settings</span></div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function _renderTabs() {
    var tabs = [
      { id: 'conn',    label: 'Connection' },
      { id: 'publish', label: 'Publishing' },
      { id: 'cat',     label: 'Categories & tags' },
      { id: 'img',     label: 'Images' },
      { id: 'users',   label: 'Users' },
    ];
    return '<div class="sh-tabs">' + tabs.map(function (t) {
      var active = _state.tab === t.id ? ' sh-tab-active' : '';
      return '<button class="sh-tab' + active + '" data-click="ssSetTab" data-tab="' + t.id + '">' + escapeHtml(t.label) + '</button>';
    }).join('') + '</div>';
  }

  function _renderEmptyTab(tabId) {
    var labels = { conn: 'Connection', cat: 'Categories & tags', img: 'Images', users: 'Users' };
    var label = labels[tabId] || tabId;
    return '<div class="sh-empty" style="padding:48px;text-align:center">' +
      '<div style="color:var(--sh-text-4);margin-bottom:8px">' + icon('settings', 28) + '</div>' +
      '<div style="font-size:14px;font-weight:500;color:var(--sh-text-2)">' + escapeHtml(label) + ' settings</div>' +
      '<div style="font-size:12.5px;margin-top:4px">Coming soon — Publishing is the detailed view for now.</div>' +
    '</div>';
  }

  function _renderPublishingTab() {
    return '<div class="sh-ss-grid">' +
      _renderLeftColumn() +
      _renderRightColumn() +
    '</div>';
  }

  function _renderLeftColumn() {
    var c = _state.cfg;

    function _select(id, current, options) {
      return '<select class="sh-select" style="width:100%" data-change="ssSelectCfg" data-field="' + id + '">' +
        options.map(function (o) {
          var sel = (o.value === current) ? ' selected' : '';
          return '<option value="' + o.value + '"' + sel + '>' + escapeHtml(o.label) + '</option>';
        }).join('') +
      '</select>';
    }

    var dayBtns = DAYS.map(function (d, i) {
      var on = c.days[i];
      var style = on ? 'background:var(--sh-text);color:var(--sh-bg);border-color:var(--sh-text);width:36px;justify-content:center' : 'width:36px;justify-content:center';
      return '<button class="sh-btn sh-btn-sm" style="' + style + '" data-click="ssToggleDay" data-day="' + i + '">' + d + '</button>';
    }).join('');

    return '<div>' +
      // Default post settings
      '<div style="font-size:14px;font-weight:600;margin-bottom:12px">Default post settings</div>' +
      '<div class="sh-card">' +
        '<div style="padding:20px;display:grid;grid-template-columns:140px 1fr;row-gap:14px;align-items:center;font-size:13px">' +
          '<span style="color:var(--sh-text-2)">Post status</span>' +
          _select('postStatus', c.postStatus, [
            { value: 'draft',     label: 'Draft' },
            { value: 'publish',   label: 'Published' },
            { value: 'future',    label: 'Scheduled' },
          ]) +
          '<span style="color:var(--sh-text-2)">Author</span>' +
          _select('author', c.author, [
            { value: 'auto',  label: 'Auto-assign by feed' },
            { value: 'admin', label: 'Site admin' },
          ]) +
          '<span style="color:var(--sh-text-2)">Featured image</span>' +
          _select('featuredImage', c.featuredImage, [
            { value: 'auto', label: 'Auto from sources' },
            { value: 'ai',   label: 'AI-generated' },
            { value: 'none', label: 'None' },
          ]) +
          '<span style="color:var(--sh-text-2)">Canonical</span>' +
          _select('canonical', c.canonical, [
            { value: 'self',   label: 'Self' },
            { value: 'first',  label: 'First source' },
          ]) +
        '</div>' +
      '</div>' +

      // Publish schedule
      '<div style="font-size:14px;font-weight:600;margin:28px 0 12px">Publish schedule</div>' +
      '<div class="sh-card">' +
        '<div style="padding:20px">' +
          '<div style="font-size:12px;color:var(--sh-text-3);margin-bottom:8px">Active days</div>' +
          '<div style="display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap">' + dayBtns + '</div>' +
          '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">' +
            '<div>' +
              '<div style="font-size:12px;color:var(--sh-text-3);margin-bottom:4px">Window start</div>' +
              '<input class="sh-input" value="' + escapeHtml(c.windowStart) + '" data-input="ssSchedStart" style="width:100%"/>' +
            '</div>' +
            '<div>' +
              '<div style="font-size:12px;color:var(--sh-text-3);margin-bottom:4px">Window end</div>' +
              '<input class="sh-input" value="' + escapeHtml(c.windowEnd) + '" data-input="ssSchedEnd" style="width:100%"/>' +
            '</div>' +
          '</div>' +

          '<div style="margin-top:16px;display:flex;gap:8px">' +
            '<button class="sh-btn sh-btn-primary sh-btn-sm" data-click="ssSavePublish"' + (_state.saving ? ' disabled' : '') + '>' +
              (_state.saving ? 'Saving…' : 'Save publishing settings') +
            '</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  function _renderRightColumn() {
    var rules = _state.cfg.rules || [];
    var activeCount = rules.filter(function (r) { return r.on; }).length;

    var rulesHtml = rules.map(function (r, i) {
      var style = 'display:flex;align-items:center;gap:12px;padding:12px 16px;' +
        'border-bottom:' + (i < rules.length - 1 ? '1px solid var(--sh-border)' : 'none') + ';' +
        'opacity:' + (r.on ? 1 : 0.5);
      return '<div style="' + style + '">' +
        '<div style="flex:1;font-size:13px">' +
          '<span style="color:var(--sh-text-3);font-weight:500;margin-right:4px">IF</span>' +
          '<span>' + escapeHtml(r.cond) + '</span>' +
          '<span style="color:var(--sh-text-4);margin:0 6px;display:inline-flex;vertical-align:middle">' + icon('arrow-right', 12) + '</span>' +
          '<span style="color:var(--sh-text-3);font-weight:500;margin-right:4px">THEN</span>' +
          '<span style="font-weight:550">' + escapeHtml(r.act) + '</span>' +
        '</div>' +
        '<input type="checkbox" class="sh-toggle"' + (r.on ? ' checked' : '') + ' data-change="ssToggleRule" data-rule-id="' + escapeHtml(r.id) + '"/>' +
        '<button class="sh-btn sh-btn-ghost sh-btn-sm" data-click="ssRuleMenu" data-rule-id="' + escapeHtml(r.id) + '">' + icon('more-horizontal', 13) + '</button>' +
      '</div>';
    }).join('');

    // Connection block
    var s = _state.site;
    var wpUrl = s.wp_url || 'not configured';
    var wpOk = !!s.has_wp;
    var wpBadge = wpOk
      ? '<span class="sh-badge sh-badge-green" style="margin-left:auto"><span class="sh-dot sh-dot-green"></span>OK</span>'
      : '<span class="sh-badge sh-badge-amber" style="margin-left:auto"><span class="sh-dot sh-dot-amber"></span>Not set</span>';

    var checkResult;
    if (_state.wpCheck && _state.wpCheck.checking) {
      checkResult = 'Checking…';
    } else if (_state.wpCheck) {
      checkResult = 'Last checked ' + relTime(_state.wpCheck.at) + ' · ' + (_state.wpCheck.ok ? 'OK' : 'Failed: ' + escapeHtml(_state.wpCheck.message || ''));
    } else {
      checkResult = 'WordPress · AutoHub plugin';
    }

    return '<div>' +
      // Automation rules
      '<div style="display:flex;align-items:center;margin-bottom:12px">' +
        '<span style="font-size:14px;font-weight:600">Automation rules</span>' +
        '<span class="sh-badge sh-badge-neutral" style="margin-left:8px">' + activeCount + ' active</span>' +
        '<div style="flex:1"></div>' +
        '<button class="sh-btn sh-btn-sm" data-click="ssAddRule">' + icon('plus', 12) + 'Add rule</button>' +
      '</div>' +
      '<div class="sh-card">' + (rulesHtml || '<div class="sh-empty" style="padding:24px">No rules yet.</div>') + '</div>' +

      // Connection
      '<div style="font-size:14px;font-weight:600;margin:28px 0 12px">Connection</div>' +
      '<div class="sh-card" style="padding:16px">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">' +
          '<span class="sh-mono" style="font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(wpUrl) + (wpUrl.indexOf('http') === 0 ? '/wp-json' : '') + '</span>' +
          wpBadge +
        '</div>' +
        '<div style="font-size:12px;color:var(--sh-text-3)">' + checkResult + '</div>' +
        '<div style="margin-top:12px;display:flex;gap:6px">' +
          '<button class="sh-btn sh-btn-sm" data-click="ssTestWp"' + (_state.wpCheck && _state.wpCheck.checking ? ' disabled' : '') + '>' + icon('refresh-ccw', 12) + 'Test connection</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  // ─── Actions ───────────────────────────────────────────────────────────
  function setTab(id) { _state.tab = id; render(); }
  function selectCfg(field, value) { _state.cfg[field] = value; /* lazy save via Save button */ render(); }
  function setSchedStart(v) { _state.cfg.windowStart = v; }
  function setSchedEnd(v)   { _state.cfg.windowEnd = v; }
  function toggleDay(i) {
    _state.cfg.days[i] = !_state.cfg.days[i];
    render();
  }
  function savePublish() {
    var patch = {
      SITE_POST_STATUS:         _state.cfg.postStatus,
      SITE_AUTHOR_MODE:         _state.cfg.author,
      SITE_FEATURED_IMAGE_MODE: _state.cfg.featuredImage,
      SITE_CANONICAL_MODE:      _state.cfg.canonical,
      SITE_PUBLISH_SCHEDULE:    JSON.stringify({
        days: _state.cfg.days,
        windowStart: _state.cfg.windowStart,
        windowEnd: _state.cfg.windowEnd,
      }),
      SITE_AUTOMATION_RULES:    JSON.stringify(_state.cfg.rules),
    };
    _saveConfig(patch);
  }
  function toggleRule(id, on) {
    for (var i = 0; i < _state.cfg.rules.length; i++) {
      if (_state.cfg.rules[i].id === id) _state.cfg.rules[i].on = on;
    }
    // Persist immediately — toggling a rule should feel instant.
    _saveConfig({ SITE_AUTOMATION_RULES: JSON.stringify(_state.cfg.rules) });
  }
  function addRule() {
    var cond = prompt('Rule condition (e.g. "title contains brand: Ford"):');
    if (!cond) return;
    var act = prompt('Rule action (e.g. "auto-publish", "add category: X"):');
    if (!act) return;
    _state.cfg.rules.push({ id: 'r_' + Date.now(), cond: cond.trim(), act: act.trim(), on: true });
    _saveConfig({ SITE_AUTOMATION_RULES: JSON.stringify(_state.cfg.rules) });
  }
  function ruleMenu(id) {
    if (!confirm('Delete rule?')) return;
    _state.cfg.rules = _state.cfg.rules.filter(function (r) { return r.id !== id; });
    _saveConfig({ SITE_AUTOMATION_RULES: JSON.stringify(_state.cfg.rules) });
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────
  function load(siteId) {
    var root = document.getElementById('page-site-settings');
    if (!root) return;

    if (siteId) _state.siteId = siteId;
    else if (window.__dashboard && window.__dashboard.state) _state.siteId = window.__dashboard.state.activeSiteId || 1;

    root.classList.add('sh-root');
    root.innerHTML = '<div class="sh-skel" style="width:200px;height:24px;margin-bottom:20px"></div>' +
      '<div class="sh-skel" style="height:320px"></div>';
    refresh();
  }

  window.__siteSettings = {
    load: load,
    setTab: setTab,
    selectCfg: selectCfg,
    setSchedStart: setSchedStart,
    setSchedEnd: setSchedEnd,
    toggleDay: toggleDay,
    savePublish: savePublish,
    toggleRule: toggleRule,
    addRule: addRule,
    ruleMenu: ruleMenu,
    testWp: testWp,
  };
}());
