/* ================================================================
   Shared feed-form helpers — the Sources section (time window /
   languages / include / exclude domains) appears on BOTH the Feed
   Configuration tab (edit flow) AND the New Feed wizard (create flow).
   This module owns the pure render + validation pieces so both pages
   stay pixel-identical and diverge only in their state shape and
   action-name wiring.

   Usage:
     window.__shFeedForm.renderSourcesSection(cfg, opts)
       cfg = { timeRange, languages, includeDomains, excludeDomains }
       opts = {
         timeRangeAction,       // data-change value for the <select>
         langToggleAction,      // data-click value for each pill
         tagKeydownAction,      // data-keydown value for chip inputs
         tagPasteAction,        // data-paste value for chip inputs
         tagRemoveAction,       // data-click value for chip X buttons
         siteDefaultLanguages,  // string[] for the "inherit" hint
       }

   Backend contract (PR 5):
     source_config.time_range         — one of TIME_RANGE_OPTIONS.value
     source_config.allowed_languages  — ISO code array
     source_config.include_domains    — strings (wildcards like *.reuters.com OK)
     source_config.exclude_domains    — same shape
   ================================================================ */

(function () {
  'use strict';

  // Ten ISO codes — matches the UI set PR 5 shipped. Additional languages
  // can be set via direct PUT on the API; the UI intentionally keeps the
  // pill row short to avoid a full ISO-639 picker.
  var LANG_OPTIONS = [
    { value: 'en', label: 'English'    },
    { value: 'hi', label: 'Hindi'      },
    { value: 'es', label: 'Spanish'    },
    { value: 'fr', label: 'French'     },
    { value: 'de', label: 'German'     },
    { value: 'pt', label: 'Portuguese' },
    { value: 'it', label: 'Italian'    },
    { value: 'ja', label: 'Japanese'   },
    { value: 'zh', label: 'Chinese'    },
    { value: 'ar', label: 'Arabic'     },
  ];

  // Values match TIME_RANGE_MAP in src/utils/lucene-builder.js — do not
  // add entries here without adding them there too or the new value will
  // silently become a no-op.
  var TIME_RANGE_OPTIONS = [
    { value: 'any',        label: 'Any time'   },
    { value: 'past-hour',  label: 'Past hour'  },
    { value: 'past-day',   label: 'Past day'   },
    { value: 'past-week',  label: 'Past week'  },
    { value: 'past-month', label: 'Past month' },
    { value: 'past-year',  label: 'Past year'  },
  ];

  // Matches lucene-builder._cleanDomain plus a wildcard prefix (*.example.com).
  // Deliberately strict — anything that wouldn't produce a valid
  // domain-or-glob gets rejected client-side before hitting the API.
  var DOMAIN_RE = /^[*.]*[a-z0-9.-]+$/i;

  function isValidDomain(raw) {
    if (!raw || typeof raw !== 'string') return false;
    var s = raw.trim().toLowerCase();
    if (!s || s.length > 253) return false;
    return DOMAIN_RE.test(s);
  }

  function normalizeDomain(raw) {
    return String(raw || '').trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
  }

  function escapeHtml(str) {
    if (str == null) return '';
    var d = document.createElement('div');
    d.textContent = String(str);
    return d.innerHTML;
  }

  function renderLangPills(selected, opts) {
    opts = opts || {};
    var toggleAction = opts.langToggleAction || 'fdCfgToggleLang';
    var active = {};
    for (var i = 0; i < (selected || []).length; i++) active[selected[i]] = true;
    return LANG_OPTIONS.map(function (opt) {
      var on = !!active[opt.value];
      var style = on
        ? 'background:var(--sh-text);color:var(--sh-bg);border-color:var(--sh-text)'
        : '';
      return '<button type="button" class="sh-btn sh-btn-sm" style="' + style +
        '" data-click="' + escapeHtml(toggleAction) + '" data-lang="' + escapeHtml(opt.value) + '">' +
        escapeHtml(opt.label) + ' · ' + escapeHtml(opt.value) +
        '</button>';
    }).join('');
  }

  function renderTagChip(field, value, opts) {
    opts = opts || {};
    var removeAction = opts.tagRemoveAction || 'fdCfgRemoveTag';
    return '<span class="sh-fd-tag" style="display:inline-flex;align-items:center;gap:4px;padding:2px 6px 2px 10px;background:var(--sh-bg-2);border:1px solid var(--sh-border);border-radius:12px;font-size:12.5px;line-height:1.4">' +
      '<span class="sh-mono">' + escapeHtml(value) + '</span>' +
      '<button type="button" class="sh-btn-icon" style="padding:0 4px;background:transparent;border:none;color:var(--sh-text-3);cursor:pointer;font-size:14px;line-height:1" data-click="' + escapeHtml(removeAction) + '" data-field="' + escapeHtml(field) + '" data-value="' + escapeHtml(value) + '" aria-label="Remove ' + escapeHtml(value) + '">&times;</button>' +
    '</span>';
  }

  function renderTagInput(field, values, opts) {
    opts = opts || {};
    var keydownAction = opts.tagKeydownAction || 'fdCfgTagKey';
    var pasteAction   = opts.tagPasteAction   || 'fdCfgTagPaste';
    var chips = (values || []).map(function (v) { return renderTagChip(field, v, opts); }).join(' ');
    var placeholder = values && values.length
      ? 'Add another + Enter'
      : 'example.com or *.reuters.com, then Enter';
    return '<div class="sh-fd-tag-wrap" data-tag-field="' + escapeHtml(field) + '" ' +
      'style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:6px 8px;' +
      'min-height:36px;border:1px solid var(--sh-border);border-radius:6px;background:var(--sh-surface)">' +
      chips +
      (chips ? ' ' : '') +
      '<input type="text" data-keydown="' + escapeHtml(keydownAction) + '" data-paste="' + escapeHtml(pasteAction) + '" ' +
        'data-field="' + escapeHtml(field) + '" ' +
        'class="sh-fd-tag-input" ' +
        'style="flex:1;min-width:140px;border:none;outline:none;background:transparent;font-size:13px;padding:2px" ' +
        'placeholder="' + escapeHtml(placeholder) + '"/>' +
    '</div>';
  }

  // Renders the full Sources section HTML. Caller supplies the current cfg
  // (an object with timeRange, languages, includeDomains, excludeDomains)
  // plus action-name overrides so each page can wire its own event handlers
  // without colliding on delegation registries.
  function renderSourcesSection(cfg, opts) {
    opts = opts || {};
    var siteDefaults = ((opts.siteDefaultLanguages || ['en', 'hi']).join(', ')) || 'en, hi';
    var tr = (cfg && cfg.timeRange) || 'any';
    var langs = (cfg && cfg.languages) || [];
    var inc = (cfg && cfg.includeDomains) || [];
    var exc = (cfg && cfg.excludeDomains) || [];

    return '<div class="sh-eyebrow" style="margin-top:24px">Sources</div>' +
      // Time window
      '<div style="margin-bottom:14px">' +
        '<div style="font-size:13px;font-weight:500;margin-bottom:6px">Time window</div>' +
        '<select class="sh-select" data-change="' + escapeHtml(opts.timeRangeAction || 'fdCfgTimeRange') + '" style="width:100%;max-width:240px">' +
          TIME_RANGE_OPTIONS.map(function (o) {
            var sel = (o.value === tr) ? ' selected' : '';
            return '<option value="' + escapeHtml(o.value) + '"' + sel + '>' + escapeHtml(o.label) + '</option>';
          }).join('') +
        '</select>' +
        '<div class="sh-field-hint">How far back Firehose searches when your query matches.</div>' +
      '</div>' +

      // Languages
      '<div style="margin-bottom:14px">' +
        '<div style="font-size:13px;font-weight:500;margin-bottom:6px">Languages</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:6px">' + renderLangPills(langs, opts) + '</div>' +
        '<div class="sh-field-hint">Articles must match one of the selected languages.</div>' +
        ((!langs || !langs.length)
          ? '<div class="sh-field-hint" style="color:var(--sh-text-3);font-style:italic">Leave empty to inherit site default (currently: ' + escapeHtml(siteDefaults) + ')</div>'
          : '') +
      '</div>' +

      // Include domains
      '<div style="margin-bottom:14px">' +
        '<div style="font-size:13px;font-weight:500;margin-bottom:6px">Include domains</div>' +
        renderTagInput('includeDomains', inc, opts) +
        '<div class="sh-field-hint">Only articles from these domains. Leave empty for no restriction. Wildcards: *.reuters.com matches any Reuters subdomain.</div>' +
      '</div>' +

      // Exclude domains
      '<div style="margin-bottom:14px">' +
        '<div style="font-size:13px;font-weight:500;margin-bottom:6px">Exclude domains</div>' +
        renderTagInput('excludeDomains', exc, opts) +
        '<div class="sh-field-hint">Articles from these domains are dropped. Wildcards supported.</div>' +
      '</div>';
  }

  // Brief red flash on the given input to signal a rejected entry.
  function flashInputInvalid(input) {
    if (!input) return;
    var prevBorder = input.style.border;
    var prevBg = input.style.background;
    input.style.border = '1px solid var(--sh-red,#dc2626)';
    input.style.background = 'rgba(248,113,113,0.08)';
    setTimeout(function () {
      input.style.border = prevBorder;
      input.style.background = prevBg;
    }, 1800);
  }

  window.__shFeedForm = {
    LANG_OPTIONS: LANG_OPTIONS,
    TIME_RANGE_OPTIONS: TIME_RANGE_OPTIONS,
    isValidDomain: isValidDomain,
    normalizeDomain: normalizeDomain,
    renderLangPills: renderLangPills,
    renderTagChip: renderTagChip,
    renderTagInput: renderTagInput,
    renderSourcesSection: renderSourcesSection,
    flashInputInvalid: flashInputInvalid,
  };
}());
