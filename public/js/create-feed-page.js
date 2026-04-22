/* ================================================================
   Create Feed — vanilla JS port of design/jsx/create-feed.jsx.
   Two steps: template picker → one-page form with live preview.
   Submits to POST /api/feeds; preview panel polls /api/feeds/preview
   as the query / source settings change.
   ================================================================ */

(function () {
  'use strict';

  var TEMPLATES = [
    { id: 'breaking',  name: 'Breaking news',     sub: 'Low threshold, fast refresh, high volume', icon: 'zap',      meta: 'min src 1 · sim .65 · 5m',  minSrc: 1, sim: 65 },
    { id: 'editorial', name: 'Deep clusters',     sub: '≥ 4 sources, editorial quality',           icon: 'book-open', meta: 'min src 4 · sim .78 · 30m', minSrc: 4, sim: 78 },
    { id: 'deals',     name: 'Price alerts',      sub: 'Deal & discount content',                  icon: 'gift',     meta: 'min src 1 · sim .60 · 15m', minSrc: 1, sim: 60 },
    { id: 'reviews',   name: 'Review aggregator', sub: 'Product reviews, high similarity',         icon: 'sparkles', meta: 'min src 3 · sim .82 · 1h',  minSrc: 3, sim: 82 },
    { id: 'niche',     name: 'Topic tracker',     sub: 'Niche keyword, slower cadence',            icon: 'target',   meta: 'min src 2 · sim .75 · 1h',  minSrc: 2, sim: 75 },
    { id: 'blank',     name: 'Start blank',       sub: 'Configure everything yourself',            icon: 'plus',     meta: 'empty',                     minSrc: 2, sim: 72 },
  ];

  var SOURCE_KINDS = [
    { id: 'firehose',  label: 'Firehose',   enabled: true  },
    { id: 'rss',       label: 'RSS',        enabled: false },
    { id: 'sitemap',   label: 'Sitemap',    enabled: false },
    { id: 'gnews',     label: 'Google News', enabled: false },
    { id: 'api',       label: 'Custom API', enabled: false },
  ];

  var _state = {
    step: 'pick',      // 'pick' | 'form'
    picked: null,      // TEMPLATES entry | null
    name: '',
    kind: 'firehose',
    query: '',
    minSrc: 2,
    sim: 72,
    queueReview: true,
    autoPub: false,
    preview: null,     // { raw, clusters, sources, samples }
    previewLoading: false,
    submitting: false,
    existingFeeds: [], // cached for clone row
  };
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
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(path, opts).then(function (r) { return r.json(); });
  }

  function activeSiteId() {
    if (window.__dashboard && window.__dashboard.state) return window.__dashboard.state.activeSiteId || 1;
    return 1;
  }

  function goTo(route) {
    if (window.__dashboard && typeof window.__dashboard.navigateTo === 'function') {
      window.__dashboard.navigateTo(route);
    } else {
      window.location.hash = route;
    }
  }

  // ─── Rendering ─────────────────────────────────────────────────────────
  function render() {
    var root = document.getElementById('page-create-feed');
    if (!root) return;
    root.classList.add('sh-root');
    if (_state.step === 'pick') { _renderPick(root); }
    else { _renderForm(root); }
    if (window.lucide && typeof window.lucide.createIcons === 'function') window.lucide.createIcons();
  }

  function _renderPick(root) {
    // Clone row sources feed names from _state.existingFeeds (populated once
    // per load via load()). Cross-page cache from __feedsPage.getFeeds()
    // wins if the user just visited the Feeds screen.
    var fromFeedsPage = (window.__feedsPage && typeof window.__feedsPage.getFeeds === 'function')
      ? window.__feedsPage.getFeeds() : [];
    var existingFeeds = fromFeedsPage.length ? fromFeedsPage : _state.existingFeeds;
    var cloneCandidates = existingFeeds.slice(0, 3).map(function (f) { return f.name; });

    var templateCards = TEMPLATES.map(function (t) {
      var isBlank = t.id === 'blank';
      return '<button class="sh-tpl-card' + (isBlank ? ' sh-tpl-card-blank' : '') + '" data-click="createFeedPickTemplate" data-template-id="' + t.id + '">' +
        '<div class="sh-tpl-icon">' + icon(t.icon, 16) + '</div>' +
        '<div class="sh-tpl-name">' + escapeHtml(t.name) + '</div>' +
        '<div class="sh-tpl-sub">' + escapeHtml(t.sub) + '</div>' +
        '<div class="sh-mono sh-tpl-meta">' + escapeHtml(t.meta) + '</div>' +
      '</button>';
    }).join('');

    var cloneButtons = cloneCandidates.length
      ? cloneCandidates.map(function (n) {
          return '<button class="sh-btn" data-click="createFeedCloneName" data-name="' + escapeHtml(n) + '">' + icon('copy', 12) + escapeHtml(n) + '</button>';
        }).join('')
      : '<div style="font-size:12.5px;color:var(--sh-text-3)">No existing feeds yet.</div>';

    root.innerHTML =
      '<div class="sh-page-head">' +
        '<div>' +
          '<h1 class="sh-page-title">New feed</h1>' +
          '<div class="sh-page-sub"><span>Start from a template, or clone an existing feed — you can tweak everything after.</span></div>' +
        '</div>' +
        '<div class="sh-page-actions">' +
          '<button class="sh-btn" data-click="createFeedCancel">Cancel</button>' +
        '</div>' +
      '</div>' +
      '<div class="sh-eyebrow">Templates</div>' +
      '<div class="sh-tpl-grid">' + templateCards + '</div>' +
      '<div class="sh-eyebrow" style="margin-top:28px">Or clone an existing feed</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap">' + cloneButtons + '</div>';
  }

  function _renderForm(root) {
    var p = _state.preview || {};
    var pRaw = p.raw != null ? p.raw : '—';
    var pClusters = p.clusters != null ? p.clusters : '—';
    var pSources = p.sources != null ? p.sources : '—';
    var samples = Array.isArray(p.samples) ? p.samples : [];

    var sourceTabs = SOURCE_KINDS.map(function (s) {
      var isActive = _state.kind === s.id;
      var disabledAttr = s.enabled ? '' : ' disabled title="Coming soon"';
      var cls = 'sh-btn sh-btn-sm' + (isActive ? ' sh-btn-active' : '') + (s.enabled ? '' : ' sh-btn-disabled');
      return '<button class="' + cls + '" data-click="createFeedSetKind" data-kind="' + s.id + '"' + disabledAttr + '>' + escapeHtml(s.label) + '</button>';
    }).join('');

    var samplesHtml;
    if (_state.previewLoading) {
      samplesHtml = '<div class="sh-empty" style="padding:20px">Loading preview…</div>';
    } else if (samples.length === 0) {
      samplesHtml = '<div class="sh-empty" style="padding:20px;font-size:12.5px">' +
        (_state.query ? 'No recent matches in the last 14 days. Try broadening the query.' : 'Enter a query to see sample clusters.') +
      '</div>';
    } else {
      samplesHtml = samples.slice(0, 3).map(function (s, i) {
        return '<div style="padding:10px 0;border-top:' + (i === 0 ? 'none' : '1px solid var(--sh-border)') + '">' +
          '<div style="font-size:13px;font-weight:500;line-height:1.35">' + escapeHtml(s.title || 'Untitled') + '</div>' +
          '<div class="sh-mono" style="font-size:11px;color:var(--sh-text-3);margin-top:2px">' +
            escapeHtml(s.domain || '') + (s.received_at ? ' · ' + escapeHtml(_relTime(s.received_at)) : '') +
          '</div>' +
        '</div>';
      }).join('');
    }

    var canSubmit = _state.name.trim().length > 0 && _state.kind === 'firehose';

    root.innerHTML =
      '<div class="sh-page-head">' +
        '<div>' +
          '<h1 class="sh-page-title">New feed</h1>' +
          '<div class="sh-page-sub"><span>' +
            (_state.picked ? 'Starting from <b>' + escapeHtml(_state.picked.name) + '</b>. ' : '') +
            'All settings are editable after creation.' +
          '</span></div>' +
        '</div>' +
        '<div class="sh-page-actions">' +
          '<button class="sh-btn" data-click="createFeedBack">' + icon('arrow-left', 14) + 'Back</button>' +
          '<button class="sh-btn sh-btn-primary" data-click="createFeedSubmit"' + (canSubmit ? '' : ' disabled') + '>' +
            (_state.submitting ? 'Creating…' : 'Create feed' + icon('arrow-right', 14)) +
          '</button>' +
        '</div>' +
      '</div>' +

      '<div class="sh-form-grid">' +
        '<div class="sh-form-col">' +
          // Feed name
          '<div class="sh-field">' +
            '<div class="sh-field-label">Feed name</div>' +
            '<input class="sh-input" placeholder="e.g. ev-launches-2026" value="' + escapeHtml(_state.name) + '" data-input="createFeedName"/>' +
          '</div>' +

          // Source picker
          '<div class="sh-field">' +
            '<div class="sh-field-label">Source</div>' +
            '<div style="display:flex;gap:6px;flex-wrap:wrap">' + sourceTabs + '</div>' +
            (_state.kind !== 'firehose'
              ? '<div class="sh-field-hint" style="color:var(--sh-amber)">' + escapeHtml(_kindLabelFor(_state.kind)) + ' connector is coming soon — only Firehose is currently wired up.</div>'
              : '') +
          '</div>' +

          // Query
          '<div class="sh-field">' +
            '<div class="sh-field-label">Query</div>' +
            '<input class="sh-input sh-mono" placeholder=\'"electric vehicle" launch 2026\' value="' + escapeHtml(_state.query) + '" data-input="createFeedQuery" style="height:36px"/>' +
            '<div class="sh-field-hint">AND / OR / quoted phrases supported. Empty query matches everything.</div>' +
          '</div>' +

          // Clustering
          '<div class="sh-field">' +
            '<div class="sh-field-label">Clustering</div>' +
            '<div style="margin-bottom:14px">' +
              '<div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:13px">' +
                '<span style="color:var(--sh-text-2)">Minimum sources</span>' +
                '<span class="sh-tabular" style="color:var(--sh-text-3)">' + _state.minSrc + '</span>' +
              '</div>' +
              '<input type="range" class="sh-range" min="1" max="10" value="' + _state.minSrc + '" data-input="createFeedMinSrc"/>' +
            '</div>' +
            '<div>' +
              '<div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:13px">' +
                '<span style="color:var(--sh-text-2)">Similarity threshold</span>' +
                '<span class="sh-tabular" style="color:var(--sh-text-3)">' + (_state.sim / 100).toFixed(2) + '</span>' +
              '</div>' +
              '<input type="range" class="sh-range" min="50" max="100" value="' + _state.sim + '" data-input="createFeedSim"/>' +
            '</div>' +
          '</div>' +

          // Publishing toggles
          '<div class="sh-field">' +
            '<div class="sh-field-label">Publishing</div>' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
              '<span style="font-size:13px">Queue for review</span>' +
              '<input type="checkbox" class="sh-toggle" ' + (_state.queueReview ? 'checked' : '') + ' data-change="createFeedQueue"/>' +
            '</div>' +
            '<div style="display:flex;justify-content:space-between;align-items:center">' +
              '<span style="font-size:13px">Auto-publish when quality ≥ 0.8</span>' +
              '<input type="checkbox" class="sh-toggle" ' + (_state.autoPub ? 'checked' : '') + ' data-change="createFeedAutoPub"/>' +
            '</div>' +
          '</div>' +
        '</div>' +

        // Live preview column
        '<div>' +
          '<div class="sh-card" style="position:sticky;top:20px">' +
            '<div class="sh-card-head">' +
              '<div class="sh-card-title">Live preview</div>' +
              '<span class="sh-badge sh-badge-accent"><span class="sh-dot" style="background:var(--sh-accent)"></span>Live</span>' +
            '</div>' +
            '<div style="padding:20px">' +
              '<div style="display:flex;gap:20px;margin-bottom:18px">' +
                '<div>' +
                  '<div class="sh-eyebrow" style="padding:0">Raw / 14d</div>' +
                  '<div style="font-size:26px;font-weight:600;letter-spacing:-0.02em;margin-top:2px" class="sh-tabular">' + pRaw + '</div>' +
                '</div>' +
                '<div>' +
                  '<div class="sh-eyebrow" style="padding:0">Clusters</div>' +
                  '<div style="font-size:26px;font-weight:600;letter-spacing:-0.02em;margin-top:2px;color:var(--sh-green)" class="sh-tabular">' + pClusters + '</div>' +
                '</div>' +
                '<div>' +
                  '<div class="sh-eyebrow" style="padding:0">Sources</div>' +
                  '<div style="font-size:26px;font-weight:600;letter-spacing:-0.02em;margin-top:2px;color:var(--sh-text-3)" class="sh-tabular">' + pSources + '</div>' +
                '</div>' +
              '</div>' +
              '<div class="sh-eyebrow" style="padding:0;margin-bottom:8px">Sample clusters</div>' +
              samplesHtml +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    // Focus the name field on first entry into the form for quick typing.
    var nameInput = root.querySelector('[data-input="createFeedName"]');
    if (nameInput && !nameInput.dataset.focused) {
      nameInput.dataset.focused = '1';
      setTimeout(function () { nameInput.focus(); }, 50);
    }
  }

  function _kindLabelFor(id) {
    for (var i = 0; i < SOURCE_KINDS.length; i++) if (SOURCE_KINDS[i].id === id) return SOURCE_KINDS[i].label;
    return id;
  }

  function _relTime(iso) {
    var d = new Date(iso.indexOf('T') === -1 ? iso.replace(' ', 'T') + 'Z' : iso);
    if (isNaN(d.getTime())) return iso;
    var diff = Date.now() - d.getTime();
    var m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    var hr = Math.floor(m / 60);
    if (hr < 24) return hr + 'h ago';
    var days = Math.floor(hr / 24);
    return days + 'd ago';
  }

  // ─── Preview ───────────────────────────────────────────────────────────
  // Debounced preview fetch. The POST body mirrors the form's source_config
  // so the server-side /api/feeds/preview route estimates how many recent
  // articles match without committing to a real feed yet.
  function _schedulePreview() {
    clearTimeout(_previewTimer);
    _previewTimer = setTimeout(_runPreview, 300);
  }

  function _runPreview() {
    if (_state.kind !== 'firehose') {
      _state.preview = null;
      return render();
    }
    _state.previewLoading = true;
    render();

    var body = {
      source_config: {
        query: _state.query,
        site_id: activeSiteId(),
      }
    };
    api('/api/feeds/preview', { method: 'POST', body: body })
      .then(function (resp) {
        _state.previewLoading = false;
        if (!resp || !resp.ok) { _state.preview = { raw: 0, clusters: 0, sources: 0, samples: [] }; render(); return; }
        var matches = resp.matches || [];
        var raw = resp.total || matches.length;
        // Simple cluster estimate: scale down by minSrc + sim. Same intuition
        // as the JSX demo math — not a real cluster count, but moves with the
        // controls so admins can feel the knobs working.
        var clusters = Math.max(0, Math.floor(raw / Math.max(1, _state.minSrc * 1.4 + (_state.sim - 50) / 10)));
        var sourcesSet = {};
        for (var i = 0; i < matches.length; i++) if (matches[i].domain) sourcesSet[matches[i].domain] = true;
        _state.preview = {
          raw: raw,
          clusters: clusters,
          sources: Object.keys(sourcesSet).length,
          samples: matches,
        };
        render();
      })
      .catch(function () {
        _state.previewLoading = false;
        _state.preview = null;
        render();
      });
  }

  // ─── Action handlers ───────────────────────────────────────────────────
  function pickTemplate(id) {
    var t = null;
    for (var i = 0; i < TEMPLATES.length; i++) if (TEMPLATES[i].id === id) { t = TEMPLATES[i]; break; }
    if (!t) return;
    _state.picked = t;
    _state.minSrc = t.minSrc;
    _state.sim = t.sim;
    _state.step = 'form';
    _state.preview = null;
    render();
    _schedulePreview();
  }

  function cloneName(n) {
    _state.name = (n || '') + '-copy';
    _state.picked = null;
    _state.step = 'form';
    render();
    _schedulePreview();
  }

  function back() {
    _state.step = 'pick';
    render();
  }

  function cancel() {
    goTo('feeds');
  }

  function setField(field, value) {
    _state[field] = value;
    // Slider / query changes should refresh the preview.
    if (field === 'query' || field === 'minSrc' || field === 'sim') _schedulePreview();
  }

  function setKind(kind) {
    var def = null;
    for (var i = 0; i < SOURCE_KINDS.length; i++) if (SOURCE_KINDS[i].id === kind) { def = SOURCE_KINDS[i]; break; }
    if (def && !def.enabled) {
      // Keep the user on firehose but update UI so the "coming soon" hint
      // explains why. Flip state.kind so they see the disabled styling flash.
      _state.kind = kind;
    } else {
      _state.kind = kind;
    }
    render();
  }

  function submit() {
    if (_state.submitting) return;
    var name = _state.name.trim();
    if (!name) { alert('Feed name is required.'); return; }
    if (_state.kind !== 'firehose') {
      alert(_kindLabelFor(_state.kind) + ' connector is coming soon. Stick with Firehose for now.');
      return;
    }
    _state.submitting = true;
    render();

    var body = {
      site_id: activeSiteId(),
      name: name,
      kind: 'firehose',
      is_active: true,
      source_config: {
        query: _state.query,
      },
      dest_config: {},
      quality_config: {
        min_sources: _state.minSrc,
        similarity_threshold: _state.sim / 100,
        queue_for_review: _state.queueReview,
        auto_publish: _state.autoPub,
        auto_publish_quality: 0.8,
      },
    };

    api('/api/feeds', { method: 'POST', body: body })
      .then(function (resp) {
        _state.submitting = false;
        if (!resp || !resp.ok) {
          alert('Could not create feed: ' + ((resp && resp.error) || 'unknown error'));
          render();
          return;
        }
        // Land on the feeds list so the new row shows up.
        _reset();
        goTo('feeds');
      })
      .catch(function (err) {
        _state.submitting = false;
        alert('Create failed: ' + (err && err.message));
        render();
      });
  }

  function _reset() {
    _state.step = 'pick';
    _state.picked = null;
    _state.name = '';
    _state.kind = 'firehose';
    _state.query = '';
    _state.minSrc = 2;
    _state.sim = 72;
    _state.queueReview = true;
    _state.autoPub = false;
    _state.preview = null;
    _state.submitting = false;
    // Keep existingFeeds across resets — it's remote data, harmless to reuse.
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────
  function load() {
    var root = document.getElementById('page-create-feed');
    if (!root) return;
    _reset();
    root.classList.add('sh-root');
    render();
    // Background fetch so the clone row populates on first visit without
    // requiring the user to hit Feeds first.
    api('/api/feeds').then(function (r) {
      _state.existingFeeds = (r && r.feeds) || [];
      if (_state.step === 'pick' && _state.existingFeeds.length) render();
    }).catch(function () {});
  }

  window.__createFeed = {
    load: load,
    pickTemplate: pickTemplate,
    cloneName: cloneName,
    back: back,
    cancel: cancel,
    setField: setField,
    setKind: setKind,
    submit: submit,
  };

  // Provide the hook Feeds list uses to open this flow from its "New feed"
  // button. Keeps feeds-page.js decoupled from the routing layer.
  window.__openCreateFeedFlow = function () { goTo('create-feed'); };
}());
