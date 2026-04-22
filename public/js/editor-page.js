/* ================================================================
   Cluster editor — vanilla JS port of design/jsx/editor.jsx.
   Full-bleed 3-pane layout (sources | article | context) with a
   contextual action bar at the bottom. Driven by a cluster id set
   on window.__dashboard.state.currentClusterId before navigation.
   ================================================================ */

(function () {
  'use strict';

  var _state = {
    clusterId: null,
    cluster: null,
    articles: [],            // source articles
    drafts: [],              // all drafts for this cluster
    draft: null,             // primary / selected draft
    activeArticleId: null,   // highlighted source
    viewMode: 'rewrite',     // 'rewrite' | 'source' — what the middle pane shows
    sourceContent: {},       // article_id -> { loading, content, title, byline, url, extracted }
    ctx: 'write',            // 'write' | 'preview' | 'coverage'
    tone: 'Neutral',
    length: 'Medium',
    addCitations: true,
    seoFocus: false,
    previewDevice: 'desktop',
    entities: null,          // InfraNodus entity coverage
    site: null,              // active site for publish target
    saving: false,
    regenerating: false,
    loading: false,
    error: null,
    regenerateError: null,   // last error from /api/clusters/:id/rewrite — shown in the AI edit pane
    aiConfig: null,          // {provider, hasAnthropicKey, hasOpenaiKey, hasOpenrouterKey} — loaded once
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
    var d = new Date(iso.indexOf('T') === -1 ? iso.replace(' ', 'T') + 'Z' : iso);
    if (isNaN(d.getTime())) return '—';
    var diff = Date.now() - d.getTime();
    var m = Math.floor(diff / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    var hr = Math.floor(m / 60);
    if (hr < 24) return hr + 'h ago';
    return Math.floor(hr / 24) + 'd ago';
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

  // Lightweight markdown → HTML for rendering draft body. Handles headings,
  // paragraphs, bold/italic, links, and bare <mark>. Not a full parser —
  // drafts usually come out of the server already sanitised, so this is a
  // fallback for plain-markdown fields.
  function renderMarkdown(src) {
    if (!src) return '';
    if (/<(p|h[1-6]|ul|ol|li|blockquote|figure)[\s>]/i.test(src)) return src; // already HTML
    var s = escapeHtml(src);
    s = s.replace(/^###### (.*)$/gm, '<h6>$1</h6>');
    s = s.replace(/^##### (.*)$/gm, '<h5>$1</h5>');
    s = s.replace(/^#### (.*)$/gm, '<h4>$1</h4>');
    s = s.replace(/^### (.*)$/gm, '<h3>$1</h3>');
    s = s.replace(/^## (.*)$/gm, '<h2>$1</h2>');
    s = s.replace(/^# (.*)$/gm, '<h1>$1</h1>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // Paragraphs: split on double-newline, wrap in <p>.
    var parts = s.split(/\n{2,}/);
    return parts.map(function (p) {
      if (/^<(h[1-6]|ul|ol|blockquote|figure)/.test(p.trim())) return p;
      return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
    }).join('\n');
  }

  // ─── Data loading ──────────────────────────────────────────────────────
  function refresh() {
    if (!_state.clusterId) return Promise.resolve();
    _state.loading = true;

    // Fetch AI config once per editor session — the write pane uses it to
    // surface a "No AI key configured" warning instead of letting the user
    // click Regenerate and get a cryptic failure from the server.
    if (!_state.aiConfig) {
      api('/api/ai/settings').then(function (c) {
        if (c && c.success) {
          _state.aiConfig = {
            provider: c.provider || null,
            hasAnthropicKey: !!c.hasAnthropicKey,
            hasOpenaiKey:    !!c.hasOpenaiKey,
            hasOpenrouterKey:!!c.hasOpenrouterKey,
          };
          render();
        }
      }).catch(function () { /* silent — warning just won't appear */ });
    }

    return Promise.all([
      api('/api/clusters/' + _state.clusterId).catch(function () { return null; }),
      api('/api/drafts?cluster_id=' + _state.clusterId + '&per_page=20').catch(function () { return null; }),
    ]).then(function (res) {
      var cResp = res[0], dResp = res[1];
      _state.cluster = cResp && (cResp.cluster || cResp);
      _state.articles = (cResp && cResp.articles) || [];
      _state.drafts = (dResp && (dResp.drafts || dResp.data || [])) || [];

      // Prefer a "ready" or "published" draft; otherwise the newest.
      var preferred = _state.drafts.find(function (d) { return d.status === 'ready' || d.status === 'published'; });
      var primary = preferred || _state.drafts[0] || null;
      _state.activeArticleId = _state.articles.length ? _state.articles[0].id : null;

      var afterDraft = primary
        ? api('/api/drafts/' + primary.id).then(function (r) { _state.draft = (r && (r.draft || r)) || primary; })
        : Promise.resolve();

      return afterDraft;
    }).then(function () {
      // Active site for publish target
      var sites = (window.__dashboard && window.__dashboard.state && window.__dashboard.state.sites) || [];
      var activeId = (window.__dashboard && window.__dashboard.state && window.__dashboard.state.activeSiteId) || 1;
      _state.site = sites.find(function (s) { return s.id === activeId; }) || { name: 'site', id: activeId };
      _state.loading = false;
      render();
      if (_state.draft && _state.ctx === 'coverage') _fetchEntities();
    }).catch(function (err) {
      _state.loading = false;
      _state.error = err && err.message;
      render();
    });
  }

  function _fetchEntities() {
    if (!_state.draft) return;
    api('/api/drafts/' + _state.draft.id + '/infranodus').then(function (r) {
      if (r && (r.entities || r.coverage)) {
        _state.entities = r.entities || r.coverage;
      } else {
        _state.entities = [];
      }
      render();
    }).catch(function () {
      _state.entities = [];
      render();
    });
  }

  // ─── Rendering ─────────────────────────────────────────────────────────
  function render() {
    var root = document.getElementById('page-editor');
    if (!root) return;
    root.classList.add('sh-root', 'sh-root-editor');

    if (_state.loading && !_state.cluster) {
      root.innerHTML = '<div class="sh-empty" style="padding:48px">Loading cluster…</div>';
      return;
    }
    if (!_state.cluster) {
      root.innerHTML = '<div class="sh-empty" style="padding:48px">Cluster not found. ' +
        '<a href="#clusters" style="color:var(--sh-accent-text)">Back to clusters</a></div>';
      return;
    }

    root.innerHTML =
      '<div class="sh-ed-shell">' +
        _renderHeader() +
        '<div class="sh-ed-panes">' +
          _renderSourcesPane() +
          _renderArticlePane() +
          _renderContextPane() +
        '</div>' +
        _renderActionBar() +
      '</div>';

    if (window.lucide && typeof window.lucide.createIcons === 'function') window.lucide.createIcons();
  }

  function _renderHeader() {
    var c = _state.cluster;
    var d = _state.draft;
    var title = (d && (d.rewritten_title || d.title)) || c.topic || 'Untitled';
    var quality = c.avg_similarity ? c.avg_similarity.toFixed(2) : null;
    var saved = d && d.updated_at ? relTime(d.updated_at) : null;

    return '<div class="sh-ed-header">' +
      '<button class="sh-btn sh-btn-ghost sh-btn-sm" data-click="editorBack">' + icon('arrow-left', 15) + '</button>' +
      '<div style="flex:1;min-width:0">' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          '<span class="sh-mono" style="font-size:11px;color:var(--sh-text-3)">#' + c.id + '</span>' +
          '<span style="font-size:14px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(title) + '</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;margin-top:2px;font-size:11.5px;color:var(--sh-text-3);flex-wrap:wrap">' +
          (quality ? '<span class="sh-badge sh-badge-green">quality ' + quality + '</span>' : '') +
          (_state.articles.length ? '<span>·</span><span>' + _state.articles.length + ' sources</span>' : '') +
          (saved ? '<span>·</span><span>Saved ' + saved + '</span>' : '') +
          (d && d.status ? '<span>·</span><span>' + escapeHtml(d.status) + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:6px">' +
        '<button class="sh-btn sh-btn-sm" data-click="editorSaveDraft"' + (_state.saving ? ' disabled' : '') + '>' + icon('save', 13) + (_state.saving ? 'Saving…' : 'Save draft') + '</button>' +
        '<button class="sh-btn sh-btn-sm">' + icon('more-horizontal', 13) + '</button>' +
      '</div>' +
    '</div>';
  }

  function _renderSourcesPane() {
    var items = _state.articles;
    if (!items.length) {
      return '<div class="sh-ed-sources"><div class="sh-empty" style="padding:20px;font-size:12px">No source articles linked to this cluster.</div></div>';
    }
    var head =
      '<div class="sh-ed-sources-head">' +
        '<span class="sh-eyebrow" style="padding:0">Sources</span>' +
        '<span class="sh-badge sh-badge-neutral">' + items.length + '</span>' +
      '</div>';
    var rows = items.map(function (a, i) {
      var isActive = a.id === _state.activeArticleId;
      var style = 'padding:12px 14px;border-bottom:' + (i < items.length - 1 ? '1px solid var(--sh-border)' : 'none') + ';' +
        'border-left:' + (isActive ? '3px solid var(--sh-accent)' : '3px solid transparent') + ';' +
        'background:' + (isActive ? 'var(--sh-surface)' : 'transparent') + ';cursor:pointer';
      return '<div data-click="editorSelectArticle" data-article-id="' + a.id + '" style="' + style + '">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">' +
          favicon(a.domain, 14) +
          '<span style="font-size:12.5px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escapeHtml(a.domain || '') + '</span>' +
          '<span style="flex:1"></span>' +
          '<a href="' + escapeHtml(a.url || '#') + '" target="_blank" rel="noopener" data-click="editorNoop" style="color:var(--sh-text-4);display:inline-flex">' + icon('external-link', 11) + '</a>' +
        '</div>' +
        '<div style="font-size:12.5px;line-height:1.4;color:var(--sh-text-2)">' + escapeHtml(a.title || 'Untitled') + '</div>' +
        (a.id ? '<div class="sh-mono" style="font-size:10.5px;color:var(--sh-text-4);margin-top:3px">#' + _state.cluster.id + '-' + _encodeRef(a.id) + '</div>' : '') +
      '</div>';
    }).join('');
    return '<div class="sh-ed-sources">' + head + rows + '</div>';
  }

  function _encodeRef(n) {
    // Match the JSX mock style: "#14025-a", "-b", ..., falling back to -N for bigger indices.
    var idx = _state.articles.findIndex(function (a) { return a.id === n; });
    if (idx < 0) return String(n);
    if (idx < 26) return String.fromCharCode(97 + idx);
    return String(idx + 1);
  }

  function _renderArticlePane() {
    if (_state.viewMode === 'source') return _renderSourceView();
    return _renderRewriteView();
  }

  function _renderRewriteView() {
    var d = _state.draft;
    var title = (d && (d.rewritten_title || d.title)) || _state.cluster.topic || 'Untitled';
    var subtitle = (d && (d.rewritten_subtitle || d.subtitle)) || '';
    var body = d && (d.rewritten_html || d.rewritten_markdown || d.body);

    var bodyHtml;
    if (!d) {
      bodyHtml = '<div class="sh-empty" style="padding:48px 20px;margin:40px 0;border:1px dashed var(--sh-border-2);border-radius:var(--sh-r-lg)">' +
        'No rewrite yet. ' +
        '<button class="sh-btn sh-btn-primary sh-btn-sm" data-click="editorRegenerate" style="margin-top:12px">' +
          icon('sparkles', 13) + 'Generate rewrite' +
        '</button>' +
      '</div>';
    } else if (!body) {
      bodyHtml = '<div class="sh-empty" style="padding:32px 0">Draft exists but has no rewritten body yet. Click <b>Regenerate</b> in the AI edit panel to run the pipeline.</div>';
    } else {
      bodyHtml = '<div class="sh-ed-article-body">' + renderMarkdown(body) + '</div>';
    }

    return '<div class="sh-ed-article">' +
      '<div class="sh-ed-article-inner">' +
        '<div class="sh-eyebrow" style="padding:0;margin-bottom:10px">Rewritten article</div>' +
        '<h1 class="sh-ed-article-title">' + escapeHtml(title) + '</h1>' +
        (subtitle ? '<div class="sh-ed-article-sub">' + escapeHtml(subtitle) + '</div>' : '') +
        '<div class="sh-ed-article-hero">' + icon('image', 32) + '</div>' +
        bodyHtml +
      '</div>' +
    '</div>';
  }

  // Middle pane when a source is clicked — shows the source's extracted body
  // so the editor can verify what the AI had to work with before regenerating.
  function _renderSourceView() {
    var articleId = _state.activeArticleId;
    var src = _state.sourceContent[articleId];
    var article = _state.articles.find(function (a) { return a.id === articleId; });
    if (!article) {
      return '<div class="sh-ed-article"><div class="sh-ed-article-inner">' +
        '<div class="sh-empty" style="padding:48px 0">No source selected.</div>' +
      '</div></div>';
    }

    var header =
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap">' +
        '<button class="sh-btn sh-btn-sm" data-click="editorShowRewrite">' + icon('arrow-left', 13) + 'Back to rewrite</button>' +
        '<span class="sh-eyebrow" style="padding:0">Source</span>' +
        favicon(article.domain, 14) +
        '<span style="font-size:12.5px;font-weight:500">' + escapeHtml(article.domain || '') + '</span>' +
        '<span style="flex:1"></span>' +
        '<a class="sh-btn sh-btn-sm" href="' + escapeHtml(article.url || '#') + '" target="_blank" rel="noopener">' +
          icon('external-link', 12) + 'Open original' +
        '</a>' +
      '</div>';

    var body;
    if (!src) {
      body = '<div class="sh-empty" style="padding:32px 0">Loading source…</div>';
    } else if (src.loading) {
      body = '<div class="sh-empty" style="padding:32px 0">Loading extracted content…</div>';
    } else if (!src.content) {
      body = '<div class="sh-empty" style="padding:48px 20px;margin:24px 0;border:1px dashed var(--sh-border-2);border-radius:var(--sh-r-lg)">' +
        'No content captured yet for this source.<br>' +
        '<span style="font-size:12.5px;color:var(--sh-text-3)">The extractor runs when the cluster is picked up for rewrite. Open the original in a new tab to read it directly.</span>' +
      '</div>';
    } else {
      // Extractor output is markdown; Firehose content is markdown or plain.
      body = '<div class="sh-ed-article-body">' + renderMarkdown(src.content) + '</div>';
    }

    var stamp = src && !src.loading
      ? '<div style="font-size:11.5px;color:var(--sh-text-4);margin-top:16px;padding-top:12px;border-top:1px solid var(--sh-border)">' +
          (src.extracted ? 'Content extracted by pipeline.' : 'Raw snippet from Firehose — full extraction runs at rewrite time.') +
        '</div>'
      : '';

    return '<div class="sh-ed-article">' +
      '<div class="sh-ed-article-inner">' +
        header +
        '<h1 class="sh-ed-article-title">' + escapeHtml((src && src.title) || article.title || 'Untitled') + '</h1>' +
        (src && src.byline ? '<div class="sh-ed-article-sub">By ' + escapeHtml(src.byline) + '</div>' : '') +
        body +
        stamp +
      '</div>' +
    '</div>';
  }

  function _renderContextPane() {
    var tabs = [
      { id: 'preview',  label: 'Preview',  icon: 'eye' },
      { id: 'coverage', label: 'Coverage', icon: 'target' },
      { id: 'write',    label: 'AI edit',  icon: 'sparkles' },
    ];
    var tabsHtml = tabs.map(function (t) {
      var active = _state.ctx === t.id;
      var style = 'flex:1;padding:10px 0;font-size:12.5px;font-weight:500;' +
        'background:' + (active ? 'var(--sh-surface)' : 'transparent') + ';' +
        'color:' + (active ? 'var(--sh-text)' : 'var(--sh-text-3)') + ';' +
        'border:none;border-bottom:' + (active ? '2px solid var(--sh-accent)' : '2px solid transparent') + ';' +
        'cursor:pointer;display:flex;align-items:center;justify-content:center;gap:6px';
      return '<button data-click="editorSetCtx" data-ctx="' + t.id + '" style="' + style + '">' +
        icon(t.icon, 13) + t.label +
      '</button>';
    }).join('');

    var pane;
    if (_state.ctx === 'preview')  pane = _renderPreviewPane();
    else if (_state.ctx === 'coverage') pane = _renderCoveragePane();
    else                           pane = _renderWritePane();

    return '<div class="sh-ed-ctx">' +
      '<div class="sh-ed-ctx-tabs">' + tabsHtml + '</div>' +
      '<div class="sh-ed-ctx-body">' + pane + '</div>' +
    '</div>';
  }

  function _renderPreviewPane() {
    var d = _state.draft;
    var title = (d && (d.rewritten_title || d.title)) || _state.cluster.topic || 'Untitled';
    var subtitle = (d && (d.rewritten_subtitle || d.subtitle)) || '';
    var siteName = (_state.site && _state.site.name) || 'site';
    var deviceBtns = [
      { id: 'desktop', label: 'Desktop' },
      { id: 'mobile',  label: 'Mobile' },
    ].map(function (b) {
      var active = _state.previewDevice === b.id;
      return '<button class="sh-btn sh-btn-sm' + (active ? ' sh-btn-active' : '') + '" ' +
        'data-click="editorSetPreviewDevice" data-device="' + b.id + '" ' +
        'style="flex:1;justify-content:center">' + b.label + '</button>';
    }).join('');

    return '<div class="sh-eyebrow" style="padding:0;margin-bottom:10px">Preview · ' + escapeHtml(siteName) + '</div>' +
      '<div class="sh-ed-preview-card">' +
        '<div style="font-size:15px;font-weight:600;margin-bottom:6px">' + escapeHtml(title) + '</div>' +
        '<div class="sh-ed-preview-hero"></div>' +
        '<div style="color:var(--sh-text-3);line-height:1.5;font-size:12px">' + escapeHtml(subtitle || 'Preview subtitle goes here…') + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:6px;margin-top:10px">' + deviceBtns + '</div>';
  }

  function _renderCoveragePane() {
    var ents = _state.entities;
    if (ents === null) {
      return '<div class="sh-empty" style="padding:20px;font-size:12.5px">Loading entity coverage…</div>';
    }
    if (!Array.isArray(ents) || !ents.length) {
      return '<div class="sh-eyebrow" style="padding:0;margin-bottom:12px">Entity coverage <span class="sh-badge sh-badge-neutral" style="margin-left:6px">InfraNodus</span></div>' +
        '<div class="sh-empty" style="padding:12px;font-size:12.5px;border:1px dashed var(--sh-border);border-radius:var(--sh-r-md)">' +
          'No entity graph for this draft yet. Run an analysis from the legacy Failed/Clusters page, or hook it into the rewrite worker.' +
        '</div>';
    }

    var missing = ents.filter(function (e) { return e.count === 0 || e.ok === false; });
    var rows = ents.map(function (e) {
      var ok = !(e.count === 0 || e.ok === false);
      var dot = ok ? 'sh-dot-green' : 'sh-dot-red';
      return '<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--sh-border);font-size:13px">' +
        '<span class="sh-dot ' + dot + '"></span>' +
        '<span style="flex:1;color:' + (ok ? 'var(--sh-text)' : 'var(--sh-red)') + ';font-weight:' + (ok ? 400 : 500) + '">' + escapeHtml(e.entity || e.e || '') + '</span>' +
        '<span class="sh-tabular" style="font-size:12px;color:var(--sh-text-3)">' + (e.count != null ? e.count : (e.c || 0)) + '</span>' +
      '</div>';
    }).join('');

    var missingBlock = missing.length
      ? '<div style="margin-top:12px;padding:12px;background:var(--sh-red-soft);border-radius:var(--sh-r-md);border:1px solid #f5b5b5">' +
          '<div style="font-size:12px;font-weight:600;color:var(--sh-red);margin-bottom:6px">' + missing.length + ' missing entit' + (missing.length === 1 ? 'y' : 'ies') + '</div>' +
          '<button class="sh-btn sh-btn-sm" style="width:100%;justify-content:center" data-click="editorInsertFirstMissing">' +
            icon('plus', 12) + 'Insert &quot;' + escapeHtml(missing[0].entity || missing[0].e || '') + '&quot;' +
          '</button>' +
        '</div>'
      : '';

    return '<div style="display:flex;align-items:center;gap:6px;margin-bottom:12px">' +
        '<span class="sh-eyebrow" style="padding:0">Entity coverage</span>' +
        '<span class="sh-badge sh-badge-neutral">InfraNodus</span>' +
      '</div>' +
      '<div>' + rows + '</div>' +
      missingBlock;
  }

  function _renderWritePane() {
    var toneBtns = ['Neutral', 'Editorial', 'Conversational'].map(function (t) {
      var active = _state.tone === t;
      return '<button class="sh-btn sh-btn-sm' + (active ? ' sh-btn-active' : '') + '" data-click="editorSetTone" data-tone="' + t + '">' + t + '</button>';
    }).join('');
    var lenBtns = ['Short', 'Medium', 'Long'].map(function (t) {
      var active = _state.length === t;
      return '<button class="sh-btn sh-btn-sm' + (active ? ' sh-btn-active' : '') + '" data-click="editorSetLength" data-length="' + t + '">' + t + '</button>';
    }).join('');

    // Banner: AI keys missing. Shows once /api/ai/settings has reported
    // which providers have saved keys; hidden while still loading.
    var banner = '';
    var cfg = _state.aiConfig;
    if (cfg && !cfg.hasAnthropicKey && !cfg.hasOpenaiKey && !cfg.hasOpenrouterKey) {
      banner +=
        '<div style="padding:10px 12px;margin-bottom:12px;background:rgba(245,157,56,0.12);border:1px solid rgba(245,157,56,0.5);border-radius:8px;font-size:12.5px;line-height:1.4;color:var(--sh-text)">' +
          '<b>No AI key configured.</b> Regenerate will fail until you add a key under <a href="#settings" style="color:var(--sh-accent-text);font-weight:500">Pipeline settings → AI Rewrite</a> (Anthropic, OpenAI, or OpenRouter).' +
        '</div>';
    } else if (cfg && cfg.provider) {
      var hasActive = (cfg.provider === 'anthropic' && cfg.hasAnthropicKey) ||
                      (cfg.provider === 'openai' && cfg.hasOpenaiKey) ||
                      (cfg.provider === 'openrouter' && cfg.hasOpenrouterKey);
      if (!hasActive) {
        banner +=
          '<div style="padding:10px 12px;margin-bottom:12px;background:rgba(245,157,56,0.12);border:1px solid rgba(245,157,56,0.5);border-radius:8px;font-size:12.5px;line-height:1.4;color:var(--sh-text)">' +
            '<b>Primary provider (' + escapeHtml(cfg.provider) + ') has no key.</b> Configure it under <a href="#settings" style="color:var(--sh-accent-text);font-weight:500">Pipeline settings → AI Rewrite</a>, or switch the primary provider.' +
          '</div>';
      }
    }

    // Banner: most recent regenerate error. Stays visible until user
    // dismisses or runs another regenerate.
    if (_state.regenerateError) {
      banner +=
        '<div style="padding:10px 12px;margin-bottom:12px;background:rgba(239,68,68,0.10);border:1px solid rgba(239,68,68,0.5);border-radius:8px;font-size:12.5px;line-height:1.4;color:var(--sh-text)">' +
          '<div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start">' +
            '<div><b>Regenerate failed.</b><br>' + escapeHtml(_state.regenerateError) + '</div>' +
            '<button class="sh-btn sh-btn-sm" data-click="editorDismissRegenerateError" style="flex-shrink:0">Dismiss</button>' +
          '</div>' +
        '</div>';
    }

    return banner +
      '<div class="sh-eyebrow" style="padding:0;margin-bottom:10px">Rewrite controls</div>' +
      '<div style="font-size:12px;color:var(--sh-text-2);margin-bottom:6px">Tone</div>' +
      '<div style="display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap">' + toneBtns + '</div>' +
      '<div style="font-size:12px;color:var(--sh-text-2);margin-bottom:6px">Length</div>' +
      '<div style="display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap">' + lenBtns + '</div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-top:1px solid var(--sh-border)">' +
        '<span style="font-size:13px">Add citations</span>' +
        '<input type="checkbox" class="sh-toggle" ' + (_state.addCitations ? 'checked' : '') + ' data-change="editorToggleCitations"/>' +
      '</div>' +
      '<div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-top:1px solid var(--sh-border)">' +
        '<span style="font-size:13px">SEO focus</span>' +
        '<input type="checkbox" class="sh-toggle" ' + (_state.seoFocus ? 'checked' : '') + ' data-change="editorToggleSeo"/>' +
      '</div>' +
      '<button class="sh-btn sh-btn-accent" style="width:100%;margin-top:12px;justify-content:center" data-click="editorRegenerate"' + (_state.regenerating ? ' disabled' : '') + '>' +
        icon('sparkles', 13) + (_state.regenerating ? 'Regenerating…' : 'Regenerate') +
      '</button>';
  }

  function _renderActionBar() {
    var ctxLabel = _state.ctx === 'write' ? 'AI edit' : _state.ctx === 'coverage' ? 'Coverage' : 'Preview';
    var leftGroup;
    if (_state.ctx === 'preview') {
      leftGroup =
        '<button class="sh-btn sh-btn-sm" data-click="editorCopyHtml">' + icon('copy', 12) + 'Copy HTML</button>' +
        '<button class="sh-btn sh-btn-sm" data-click="editorExportHtml">' + icon('download', 12) + 'Export</button>';
    } else if (_state.ctx === 'coverage') {
      leftGroup = '<button class="sh-btn sh-btn-sm" data-click="editorSeeGraph">' + icon('git-branch', 12) + 'See graph</button>';
    } else {
      leftGroup = '<button class="sh-btn sh-btn-sm" data-click="editorRegenerate"' + (_state.regenerating ? ' disabled' : '') + '>' + icon('sparkles', 12) + (_state.regenerating ? 'Regenerating…' : 'Regenerate') + '</button>';
    }

    var target = (_state.site && _state.site.name) || 'site';
    var canPublish = _state.draft && (_state.draft.status === 'ready' || _state.draft.status === 'draft');
    var disAttr = canPublish ? '' : ' disabled';

    return '<div class="sh-ed-actionbar">' +
      '<div style="font-size:12px;color:var(--sh-text-3)">' +
        '<span style="color:var(--sh-accent-text)">●</span> in ' + ctxLabel +
      '</div>' +
      '<div style="flex:1"></div>' +
      leftGroup +
      '<div style="width:1px;background:var(--sh-border);height:20px;margin:0 4px"></div>' +
      // Split publish button — main click publishes to the active site,
      // chevron will open a per-site picker in a later pass.
      '<div class="sh-btn-split">' +
        '<button class="sh-btn sh-btn-primary sh-btn-main sh-btn-sm" data-click="editorPublish"' + disAttr + '>' +
          icon('send', 12) + 'Publish to ' + escapeHtml(target) +
        '</button>' +
        '<button class="sh-btn sh-btn-primary sh-btn-drop sh-btn-sm" data-click="editorPublishMenu"' + disAttr + ' title="Choose target site">' +
          icon('chevron-down', 12) +
        '</button>' +
      '</div>' +
    '</div>';
  }

  // ─── Actions ───────────────────────────────────────────────────────────
  function back() {
    if (window.__dashboard && typeof window.__dashboard.navigateTo === 'function') {
      window.__dashboard.navigateTo('feed-detail');
    } else {
      window.location.hash = 'feed-detail';
    }
  }
  function setCtx(id) {
    _state.ctx = id;
    render();
    if (id === 'coverage' && _state.entities === null && _state.draft) _fetchEntities();
  }
  function setPreviewDevice(id) { _state.previewDevice = id; render(); }
  function setTone(t) { _state.tone = t; render(); }
  function setLength(t) { _state.length = t; render(); }
  function toggleCitations(v) { _state.addCitations = !!v; }
  function toggleSeo(v) { _state.seoFocus = !!v; }
  // Clicking a source in the left pane flips the middle pane into "source"
  // view showing the extracted content for that source. Click the
  // "← Back to rewrite" button (wired via editorShowRewrite) to flip back.
  function selectArticle(id) {
    _state.activeArticleId = id;
    _state.viewMode = 'source';
    _loadSourceContent(id);
    render();
  }

  function showRewrite() {
    _state.viewMode = 'rewrite';
    render();
  }

  // Lazy-load the extracted content for one source. Order of preference:
  //   1. drafts[i].extracted_content when that source already has a draft
  //      (richest — extractor-parsed article body)
  //   2. article.content_markdown (raw Firehose snippet — always present)
  //   3. "no content captured" empty state
  // Cached per article id so re-selecting doesn't refetch.
  // Strip legacy-shape payloads that used to slip through the ingest path
  // as stringified JSON. If the content is an empty wrapper or parses to
  // an object with a `chunks`/`paragraphs` field, we treat it as empty so
  // the source view shows the clean empty state. Plain markdown / text
  // passes through unchanged.
  function _cleanSourceContent(raw) {
    if (!raw || typeof raw !== 'string') return '';
    var s = raw.trim();
    if (!s) return '';
    if (s === '{"chunks":[]}' || s === '{}' || s === '[]') return '';
    if (s.charAt(0) === '{' || s.charAt(0) === '[') {
      try {
        var parsed = JSON.parse(s);
        if (parsed && typeof parsed === 'object') {
          var arr = parsed.chunks || parsed.paragraphs || parsed.blocks;
          if (Array.isArray(arr) && arr.length === 0) return '';
          // If it parses as a chunk-shaped object, try to extract text.
          if (Array.isArray(arr) && arr.length) {
            var parts = arr.map(function (ch) {
              if (typeof ch === 'string') return ch;
              return (ch && (ch.text || ch.content || ch.value)) || '';
            }).filter(Boolean);
            if (parts.length) return parts.join('\n\n');
          }
        }
      } catch (_e) { /* not JSON — fall through and treat as text */ }
    }
    return raw;
  }

  function _loadSourceContent(articleId) {
    if (!articleId || _state.sourceContent[articleId]) return;
    var article = _state.articles.find(function (a) { return a.id === articleId; });
    if (!article) return;

    // Initial seed from what's already loaded in _state (the articles list
    // has content_markdown from Firehose). Guard against leftover bad data:
    // some older articles were stored as literal JSON wrappers like
    // '{"chunks":[]}' before the ingest path learned to extract text from
    // structured Firehose payloads. Surface those as empty so the UI
    // renders the "no content captured" state instead of rendering the JSON.
    _state.sourceContent[articleId] = {
      loading: false,
      url: article.url,
      title: article.title,
      byline: null,
      content: _cleanSourceContent(article.content_markdown),
      extracted: false,
    };

    // If there's a matching draft, fetch its full record so we pick up the
    // extractor's richer output (drafts.extracted_content, extracted_title,
    // extracted_byline). Skip the fetch if we know no draft exists yet.
    var draftRow = _state.drafts.find(function (d) {
      return (d.source_article_id && d.source_article_id === articleId) ||
             (d.source_url && d.source_url === article.url);
    });
    if (!draftRow) return;

    _state.sourceContent[articleId].loading = true;
    render();
    api('/api/drafts/' + draftRow.id).then(function (r) {
      var full = r && (r.draft || r);
      if (full && (full.extracted_content || full.source_content_markdown)) {
        _state.sourceContent[articleId] = {
          loading: false,
          url: full.source_url || article.url,
          title: full.extracted_title || article.title,
          byline: full.extracted_byline || null,
          content: _cleanSourceContent(full.extracted_content || full.source_content_markdown || article.content_markdown),
          extracted: !!full.extracted_content,
        };
      } else if (_state.sourceContent[articleId]) {
        _state.sourceContent[articleId].loading = false;
      }
      render();
    }).catch(function () {
      if (_state.sourceContent[articleId]) {
        _state.sourceContent[articleId].loading = false;
        render();
      }
    });
  }

  function saveDraft() {
    // The in-page draft is read-only for v1 — this is a placeholder that
    // confirms the action. Real edits (contenteditable) land in a follow-up.
    _state.saving = true; render();
    setTimeout(function () { _state.saving = false; render(); }, 400);
  }

  function regenerate() {
    if (!_state.clusterId || _state.regenerating) return;
    _state.regenerating = true;
    _state.regenerateError = null;
    render();
    api('/api/clusters/' + _state.clusterId + '/rewrite', {
      method: 'POST',
      body: { tone: _state.tone.toLowerCase(), length: _state.length.toLowerCase(),
              add_citations: _state.addCitations, seo_focus: _state.seoFocus },
    }).then(function (r) {
      _state.regenerating = false;
      if (r && r.success === false) {
        _state.regenerateError = r.error || 'Unknown error from server';
        render();
        return;
      }
      // Server returned success — pull the new draft body in.
      return refresh();
    }).catch(function (err) {
      _state.regenerating = false;
      _state.regenerateError = (err && err.message) || 'Request failed';
      render();
    });
  }

  function dismissRegenerateError() { _state.regenerateError = null; render(); }

  function publish() {
    if (!_state.clusterId) return;
    if (!confirm('Publish cluster #' + _state.clusterId + ' to ' + ((_state.site && _state.site.name) || 'site') + '?')) return;
    api('/api/clusters/' + _state.clusterId + '/publish', { method: 'POST' }).then(function (r) {
      if (!r || r.success === false) { alert('Publish failed: ' + ((r && r.error) || 'unknown')); return; }
      alert('Queued for publishing.');
      refresh();
    });
  }

  function copyHtml() {
    var body = _state.draft && (_state.draft.rewritten_html || renderMarkdown(_state.draft.rewritten_markdown || _state.draft.body || ''));
    if (!body) return alert('No draft body to copy yet.');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(body).then(function () { /* silent */ });
    } else {
      // Fallback for older browsers.
      var ta = document.createElement('textarea');
      ta.value = body; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
  }

  function exportHtml() {
    var title = (_state.draft && (_state.draft.rewritten_title || _state.draft.title)) || _state.cluster.topic || 'draft';
    var body = _state.draft && (_state.draft.rewritten_html || renderMarkdown(_state.draft.rewritten_markdown || _state.draft.body || ''));
    if (!body) return alert('No draft body to export yet.');
    var doc = '<!doctype html><meta charset="utf-8"><title>' + escapeHtml(title) + '</title><body>' + body;
    var blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = String(title).replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.html';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function seeGraph() {
    if (_state.draft) window.open('/api/drafts/' + _state.draft.id + '/infranodus?format=graph', '_blank', 'noopener');
  }

  function insertFirstMissing() {
    // Phase 1 stub — the legacy /failed page has "Add to content" flow, but
    // doing it here requires wiring the entity-insert endpoint + re-render.
    alert('Insert-from-coverage lands with the AI-edit pipeline wiring.');
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────
  function load(clusterId) {
    var root = document.getElementById('page-editor');
    if (!root) return;

    if (clusterId) _state.clusterId = clusterId;
    else if (window.__dashboard && window.__dashboard.state) _state.clusterId = window.__dashboard.state.currentClusterId || null;

    if (!_state.clusterId) {
      root.classList.add('sh-root', 'sh-root-editor');
      root.innerHTML = '<div class="sh-empty" style="padding:48px">No cluster selected.</div>';
      return;
    }

    // Reset everything except clusterId
    _state.cluster = null; _state.articles = []; _state.drafts = []; _state.draft = null;
    _state.ctx = 'write'; _state.entities = null;
    root.classList.add('sh-root', 'sh-root-editor');
    root.innerHTML = '<div class="sh-empty" style="padding:48px">Loading…</div>';

    refresh();
  }

  function publishMenu() {
    // Chevron dropdown on the split Publish button — for v1 we just list
    // the active site. Multi-site targets land with a real menu component.
    var sites = (window.__dashboard && window.__dashboard.state && window.__dashboard.state.sites) || [];
    if (sites.length <= 1) return publish();
    var names = sites.map(function (s, i) { return (i + 1) + ') ' + s.name; }).join('\n');
    var pick = prompt('Publish to which site?\n' + names, '1');
    var idx = Math.max(1, Math.min(sites.length, parseInt(pick, 10) || 1)) - 1;
    if (window.__dashboard && window.__dashboard.state) window.__dashboard.state.activeSiteId = sites[idx].id;
    _state.site = sites[idx];
    publish();
  }

  window.__editorPage = {
    load: load,
    back: back,
    setCtx: setCtx,
    setPreviewDevice: setPreviewDevice,
    setTone: setTone,
    setLength: setLength,
    toggleCitations: toggleCitations,
    toggleSeo: toggleSeo,
    selectArticle: selectArticle,
    showRewrite: showRewrite,
    saveDraft: saveDraft,
    regenerate: regenerate,
    dismissRegenerateError: dismissRegenerateError,
    publish: publish,
    publishMenu: publishMenu,
    copyHtml: copyHtml,
    exportHtml: exportHtml,
    seeGraph: seeGraph,
    insertFirstMissing: insertFirstMissing,
  };
}());
