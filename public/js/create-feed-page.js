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
    // Sources section (PR 6). Maps 1:1 to the backend keys the
    // Configuration tab on existing feeds already consumes:
    //   timeRange        → source_config.time_range (string enum)
    //   languages        → source_config.allowed_languages (ISO codes)
    //   includeDomains   → source_config.include_domains (string[])
    //   excludeDomains   → source_config.exclude_domains (string[])
    timeRange: 'any',
    languages: [],
    includeDomains: [],
    excludeDomains: [],
    activeTagField: null,       // restored on post-render focus pass
    siteDefaultLanguages: ['en', 'hi'], // fetched async; fallback on boot
    preview: null,              // { raw, clusters, sources, samples }
    previewLoading: false,
    submitting: false,
    submitError: null,          // last POST /api/feeds error, shown inline
    existingFeeds: [],          // cached for clone row
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
  //
  // Focus-bounce fix: every re-render rewrites root.innerHTML, which destroys
  // the currently-focused input. Without restoration the old code stamped the
  // Name input on every render, so typing in Query → preview fires → render
  // → cursor bounces to Name. Now we snapshot document.activeElement BEFORE
  // the rewrite (keyed on data-input attribute), then find the same logical
  // field AFTER the rewrite and restore focus + cursor position.
  //
  // Initial-focus policy: only once per entry into the form step (tracked by
  // _state._didInitialFocus, which back() resets). Picker step has no focus
  // target.
  function render() {
    var root = document.getElementById('page-create-feed');
    if (!root) return;
    root.classList.add('sh-root');

    // Snapshot focus state before innerHTML rewrite destroys it.
    var prevFocus = null;
    var active = document.activeElement;
    if (active && root.contains(active) && active.dataset && active.dataset.input) {
      prevFocus = {
        key: active.dataset.input,
        start: typeof active.selectionStart === 'number' ? active.selectionStart : null,
        end:   typeof active.selectionEnd   === 'number' ? active.selectionEnd   : null,
      };
    }

    if (_state.step === 'pick') { _renderPick(root); }
    else { _renderForm(root); }
    if (window.lucide && typeof window.lucide.createIcons === 'function') window.lucide.createIcons();

    // Restore focus if we captured one.
    if (prevFocus) {
      var next = root.querySelector('[data-input="' + prevFocus.key + '"]');
      if (next) {
        next.focus();
        try {
          if (prevFocus.start != null && prevFocus.end != null) {
            next.setSelectionRange(prevFocus.start, prevFocus.end);
          }
        } catch (_selErr) { /* not every input supports selection (e.g. number) */ }
      }
    } else if (_state.step === 'form' && _state.activeTagField) {
      // Tag inputs (include/exclude domains) don't carry data-input — they
      // use data-keydown + data-field. After a chip add/remove re-render,
      // restore focus to the tag input the user was typing in.
      var tagInput = root.querySelector(
        'input[data-keydown="createFeedTagKey"][data-field="' + _state.activeTagField + '"]'
      );
      if (tagInput) tagInput.focus();
    } else if (_state.step === 'form' && !_state._didInitialFocus) {
      // First landing on the form — focus Name once. Defer with setTimeout
      // so any pending layout work (Lucide icons, etc.) doesn't steal focus
      // back immediately.
      _state._didInitialFocus = true;
      var nameInput = root.querySelector('[data-input="createFeedName"]');
      if (nameInput) setTimeout(function () { nameInput.focus(); }, 0);
    }
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

    // Inline error banner — populated after submit() failures so the user
    // sees the server-side message next to the Create button instead of
    // a transient alert().
    var errorBanner = _state.submitError
      ? '<div class="sh-card" style="margin:12px 0;padding:12px 14px;background:rgba(248,113,113,0.08);border:1px solid rgba(248,113,113,0.4);color:var(--sh-red,#dc2626);font-size:13px;line-height:1.45;border-radius:8px">' +
          '<strong>Could not create feed.</strong> ' + escapeHtml(_state.submitError) +
        '</div>'
      : '';

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
      errorBanner +

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
            '<div class="sh-field-hint">Search terms. Use &quot;quotes&quot; for exact phrases, AND/OR/NOT for logic. Leave empty when filtering by domains, languages, or time window alone.</div>' +
          '</div>' +

          // Sources section (PR 6) — delegates to shared-feed-form.js so
          // this matches the Configuration tab on existing feeds pixel-
          // for-pixel. Action names are createFeed* so dashboard.js can
          // route them to window.__createFeed without colliding with the
          // feed-detail page's fdCfg* handlers.
          '<div class="sh-field">' +
            window.__shFeedForm.renderSourcesSection({
              timeRange:       _state.timeRange,
              languages:       _state.languages,
              includeDomains:  _state.includeDomains,
              excludeDomains:  _state.excludeDomains,
            }, {
              timeRangeAction:       'createFeedTimeRange',
              langToggleAction:      'createFeedToggleLang',
              tagKeydownAction:      'createFeedTagKey',
              tagPasteAction:        'createFeedTagPaste',
              tagRemoveAction:       'createFeedRemoveTag',
              siteDefaultLanguages:  _state.siteDefaultLanguages,
            }) +
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

    // Initial focus is handled in render() using _state._didInitialFocus so
    // every subsequent render (e.g. live-preview refresh) does NOT re-focus
    // the Name field and bounce the caret out of whatever input the user is
    // currently typing in.
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
        // PR 6 — include the Sources fields so the preview count actually
        // reacts to domain / language / time-range adjustments. The
        // /api/feeds/preview backend already accepts these keys.
        time_range:         _state.timeRange || 'any',
        allowed_languages:  (_state.languages || []).slice(),
        include_domains:    (_state.includeDomains || []).slice(),
        exclude_domains:    (_state.excludeDomains || []).slice(),
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
    // Reset the initial-focus flag so re-entering the form auto-focuses Name
    // once (but still only once — subsequent renders preserve whatever the
    // user is currently typing in).
    _state._didInitialFocus = false;
    render();
  }

  function cancel() {
    goTo('feeds');
  }

  function setField(field, value) {
    _state[field] = value;
    // Slider / query / source-filter changes should refresh the preview.
    if (field === 'query' || field === 'minSrc' || field === 'sim' ||
        field === 'timeRange') {
      _schedulePreview();
    }
  }

  // ─── Sources section setters (PR 6) ────────────────────────────────────

  function setTimeRange(value) {
    var allowed = { any:1, 'past-hour':1, 'past-day':1, 'past-week':1, 'past-month':1, 'past-year':1 };
    if (!allowed[value]) return;
    _state.timeRange = value;
    _schedulePreview();
    // Deliberate: no render() — the <select> already shows the new value
    // and re-rendering here would unfocus anything the user is typing in.
  }

  function toggleLang(code) {
    if (!code || typeof code !== 'string') return;
    var arr = (_state.languages || []).slice();
    var idx = arr.indexOf(code);
    if (idx === -1) arr.push(code); else arr.splice(idx, 1);
    _state.languages = arr;
    _schedulePreview();
    render();
  }

  function _addDomainTag(field, raw, inputEl) {
    var cleaned = window.__shFeedForm.normalizeDomain(raw);
    if (!window.__shFeedForm.isValidDomain(cleaned)) {
      window.__shFeedForm.flashInputInvalid(inputEl);
      return false;
    }
    var curr = (_state[field] || []).slice();
    if (curr.indexOf(cleaned) === -1) curr.push(cleaned);
    _state[field] = curr;
    return true;
  }

  function removeTag(field, value) {
    _state.activeTagField = field;
    var curr = (_state[field] || []).slice();
    var idx = curr.indexOf(value);
    if (idx !== -1) curr.splice(idx, 1);
    _state[field] = curr;
    _schedulePreview();
    render();
  }

  // Keydown on a tag input: Enter/comma confirm, Backspace-on-empty pop.
  function onTagKeydown(el, e) {
    var field = el.getAttribute('data-field');
    if (!field) return;
    _state.activeTagField = field;
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      var raw = el.value;
      if (!raw || !raw.trim()) return;
      if (_addDomainTag(field, raw, el)) {
        el.value = '';
        _schedulePreview();
        render();
      }
    } else if (e.key === 'Backspace' && !el.value) {
      var curr = (_state[field] || []).slice();
      if (curr.length === 0) return;
      curr.pop();
      _state[field] = curr;
      _schedulePreview();
      render();
    }
  }

  // Paste on a tag input: split on commas / newlines, add each valid token
  // as its own chip. Falls back to default paste behavior for single-token
  // payloads so the user can edit before committing.
  function onTagPaste(el, e) {
    var field = el.getAttribute('data-field');
    if (!field) return;
    var clip = (e.clipboardData || window.clipboardData);
    if (!clip) return;
    var text = clip.getData('text');
    if (!text) return;
    if (text.indexOf(',') === -1 && text.indexOf('\n') === -1) return;
    e.preventDefault();
    _state.activeTagField = field;
    var tokens = text.split(/[,\n]+/).map(function (s) { return s.trim(); }).filter(Boolean);
    var addedAny = false;
    for (var i = 0; i < tokens.length; i++) {
      if (_addDomainTag(field, tokens[i], el)) addedAny = true;
    }
    if (addedAny) {
      el.value = '';
      _schedulePreview();
      render();
    }
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
        // PR 6 — Sources section. Use PR 5's backend key names verbatim
        // so the new feed's filters take effect immediately without an
        // edit-step round-trip.
        time_range:         _state.timeRange || 'any',
        allowed_languages:  (_state.languages || []).slice(),
        include_domains:    (_state.includeDomains || []).slice(),
        exclude_domains:    (_state.excludeDomains || []).slice(),
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

    // Clear any stale error banner from a prior attempt so we only show
    // fresh failures.
    _state.submitError = null;

    api('/api/feeds', { method: 'POST', body: body })
      .then(function (resp) {
        _state.submitting = false;
        if (!resp || !resp.ok) {
          _state.submitError = (resp && resp.error) || 'unknown error';
          render();
          return;
        }
        // Land on the feeds list so the new row shows up.
        _reset();
        goTo('feeds');
      })
      .catch(function (err) {
        _state.submitting = false;
        _state.submitError = (err && err.message) || 'network error';
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
    _state.timeRange = 'any';
    _state.languages = [];
    _state.includeDomains = [];
    _state.excludeDomains = [];
    _state.activeTagField = null;
    _state.preview = null;
    _state.submitting = false;
    _state.submitError = null;
    _state._didInitialFocus = false;
    // Keep existingFeeds and siteDefaultLanguages across resets — they're
    // remote data, harmless to reuse.
  }

  // Fetch the active site's ALLOWED_LANGUAGES so the "inherit" hint under
  // the language pill row shows the real default (falls back to ['en','hi']).
  function _fetchSiteDefaults() {
    var siteId = activeSiteId();
    if (!siteId) return;
    api('/api/sites/' + siteId + '/config').then(function (r) {
      if (!r || !r.ok || !r.config) return;
      var raw = r.config.ALLOWED_LANGUAGES;
      if (!raw) return;
      var arr = String(raw).split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
      if (arr.length) {
        _state.siteDefaultLanguages = arr;
        if (_state.step === 'form') render();
      }
    }).catch(function () { /* keep default */ });
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
    _fetchSiteDefaults();
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
    // PR 6 — Sources section setters
    setTimeRange: setTimeRange,
    toggleLang: toggleLang,
    removeTag: removeTag,
    onTagKeydown: onTagKeydown,
    onTagPaste: onTagPaste,
  };

  // Provide the hook Feeds list uses to open this flow from its "New feed"
  // button. Keeps feeds-page.js decoupled from the routing layer.
  window.__openCreateFeedFlow = function () { goTo('create-feed'); };
}());
