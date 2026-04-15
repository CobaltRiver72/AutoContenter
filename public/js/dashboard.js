// ─── Theme bootstrap (runs before first paint) ───────────────────────────────
(function () {
  var saved = null;
  try { saved = localStorage.getItem('hdf-theme'); } catch (e) {}
  var theme = (saved === 'light' || saved === 'dark') ? saved : 'dark';
  document.documentElement.setAttribute('data-theme', theme);
})();

(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  //  HDF AutoPub Dashboard — Client-Side SPA
  // ═══════════════════════════════════════════════════════════════════════════

  // ─── CSRF auto-inject (H1) ──────────────────────────────────────────────
  // Patch window.fetch so every mutating call to /api/* automatically carries
  // the X-CSRF-Token header read from the _csrf readable cookie set at login.
  (function () {
    var _origFetch = window.fetch;
    window.fetch = function (url, options) {
      options = options || {};
      var method = (options.method || 'GET').toUpperCase();
      var urlStr = typeof url === 'string' ? url : (url && url.url) || '';
      if (urlStr.indexOf('/api/') === 0 && ['POST', 'PUT', 'DELETE', 'PATCH'].indexOf(method) !== -1) {
        var csrfMatch = document.cookie.match(/(?:^|;\s*)_csrf=([^;]+)/);
        if (csrfMatch) {
          options.headers = options.headers || {};
          options.headers['X-CSRF-Token'] = decodeURIComponent(csrfMatch[1]);
        }
      }
      return _origFetch.apply(this, arguments);
    };
  }());

  // ─── State ──────────────────────────────────────────────────────────────

  var state = {
    currentPage: 'overview',
    sseConnection: null,
    ssePaused: false,
    feedArticles: [],
    feedCount: 0,
    feedHourlyCount: 0,
    feedHourlyStart: Date.now(),
    feedFilterDomain: '',
    feedFilterLang: '',
    refreshTimers: [],
    clustersPage: 1,
    publishedPage: 1,
    logsPage: 1,
  };

  // Multi-select state for Live Feed
  var selectedArticles = {};
  var selectedCount = 0;

  // Draft status tracking for Live Feed cards
  var draftStatusCache = {};
  var pendingAddUrls = {};
  var showOnlyNew = false;

  // ─── Multi-select state for Published page ────────────────────────────
  var _selectedDraftIds = {};
  var _selectedDraftCount = 0;
  var _selectModeActive = false;

  // ─── Published page UI state (preserved across re-renders) ────────────
  var _publishedFilter = 'all';
  var _loadPublishedInFlight = false;

  // ─── Rule Templates ────────────────────────────────────────────────────

  // ─── Firehose Lucene Rule Reference ──────────────────────────────────
  // TEXT fields (tokenized, case-insensitive): added, removed, title, added_anchor, removed_anchor
  // KEYWORD fields (exact, case-sensitive): url, domain, page_category, page_type, language, publish_time
  // page_category values are hierarchical: /News, /News/Technology_News, /Sports, /Sports/Cricket, etc.
  // Wildcards on KEYWORD fields: forward slashes MUST be escaped with backslash → page_category:\/News*
  // In JS strings: double-escape → page_category:\\/News*
  // language is KEYWORD (exact): language:en (no quotes needed)
  // title is TEXT (tokenized): title:cricket (case-insensitive, no quotes needed for single words)
  // Phrases in TEXT fields: title:"virat kohli" (quotes required for multi-word phrases)

  var RULE_TEMPLATES = {
    cricket: {
      tag: 'cricket-ipl',
      value: '(page_category:\\/News* OR page_category:\\/Sports*) AND language:en AND (title:ipl OR title:cricket OR title:virat OR title:"virat kohli" OR title:dhoni OR title:"ms dhoni" OR title:rohit OR title:"rohit sharma" OR title:"world cup" OR title:bcci OR title:"playing 11" OR title:kabaddi OR title:football)'
    },
    finance: {
      tag: 'finance-markets',
      value: '(page_category:\\/News* OR page_category:\\/Business_and_Industrial*) AND language:en AND (title:sensex OR title:nifty OR title:ipo OR title:"stock market" OR title:gold OR title:silver OR title:rupee OR title:rbi OR title:"mutual fund")'
    },
    entertainment: {
      tag: 'entertainment',
      value: '(page_category:\\/News* OR page_category:\\/Arts_and_Entertainment*) AND language:en AND (title:bollywood OR title:"box office" OR title:ott OR title:netflix OR title:"web series" OR title:trailer OR title:"release date" OR title:"shah rukh" OR title:salman OR title:akshay)'
    },
    technology: {
      tag: 'tech-phones',
      value: '(page_category:\\/News* OR page_category:\\/Computers_and_Electronics*) AND language:en AND (title:jio OR title:airtel OR title:samsung OR title:iphone OR title:whatsapp OR title:android OR title:"phone launch" OR title:5g OR title:oneplus OR title:realme)'
    },
    politics: {
      tag: 'politics-govt',
      value: '(page_category:\\/News* OR page_category:\\/Law_and_Government*) AND language:en AND (title:"pm modi" OR title:bjp OR title:congress OR title:"supreme court" OR title:budget OR title:election OR title:rbi OR title:parliament)'
    },
    automotive: {
      tag: 'automotive',
      value: '(page_category:\\/News* OR page_category:\\/Autos_and_Vehicles*) AND language:en AND (title:tata OR title:mahindra OR title:maruti OR title:hyundai OR title:honda OR title:"electric car" OR title:"bike launch" OR title:nexon OR title:thar OR title:scorpio)'
    },
    jobs: {
      tag: 'sarkari-result',
      value: '(page_category:\\/News* OR page_category:\\/Jobs_and_Education*) AND language:en AND (title:"sarkari result" OR title:upsc OR title:ssc OR title:"railway recruitment" OR title:"admit card" OR title:"answer key" OR title:"exam date" OR title:"cut off" OR title:"government job")'
    }
  };

  // ─── Helpers ────────────────────────────────────────────────────────────

  function $(id) {
    return document.getElementById(id);
  }

  function $$(selector) {
    return document.querySelectorAll(selector);
  }

  function formatTime(iso) {
    if (!iso) return '--';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      var now = new Date();
      var diffMs = now - d;
      var diffMin = Math.floor(diffMs / 60000);

      if (diffMin < 1) return 'Just now';
      if (diffMin < 60) return diffMin + 'm ago';
      var diffHrs = Math.floor(diffMin / 60);
      if (diffHrs < 24) return diffHrs + 'h ago';

      return d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    } catch (e) {
      return iso;
    }
  }

  function formatDateTime(iso) {
    if (!iso) return '--';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return iso;
      return d.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch (e) {
      return iso;
    }
  }

  function escapeHtml(str) {
    if (!str) return '';
    var div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  /**
   * Render an InfraNodus graphSummary string as structured, readable HTML.
   *
   * The extendedGraphSummary format is XML-like:
   *   <Main Concepts (...)>: name (d|b|t), ... </MainConcepts>
   *   <TopicalGaps> ... </TopicalGaps>
   *   <ConceptualGateways> ... </ConceptualGateways>
   *   <Relations> a <- -> b  a -> b ... </Relations>
   *   <DiversityStatistics> Key: val ... </DiversityStatistics>
   *
   * Falls back to styled plain text for natural-language summaries.
   */
  function renderGraphSummary(text) {
    if (!text) return '';

    var isStructured = text.indexOf('</MainConcepts>') !== -1 ||
                       text.indexOf('<Main Concepts') !== -1 ||
                       text.indexOf('</DiversityStatistics>') !== -1;

    if (!isStructured) {
      return '<div class="gs-plain">' + escapeHtml(text) + '</div>';
    }

    var html = '<div class="gs-summary">';

    // ── Main Concepts ──────────────────────────────────────────────────
    var mcMatch = text.match(/<Main Concepts[^>]*>:?\s*([\s\S]*?)\s*<\/MainConcepts>/i);
    if (mcMatch && mcMatch[1].trim()) {
      var concepts = [];
      var cRe = /([\w][\w\s\-']*?)\s*\(\s*([^)]*)\)/g;
      var cm;
      while ((cm = cRe.exec(mcMatch[1])) !== null) {
        var parts = cm[2].split('|').map(function (p) { return p.trim(); });
        var name = cm[1].trim();
        if (name) concepts.push({ name: name, degree: parts[0] || '0', betweenness: parseFloat(parts[1] || '0') });
      }
      if (concepts.length) {
        // Sort by degree descending so most connected appear first
        concepts.sort(function (a, b) { return (parseInt(b.degree) || 0) - (parseInt(a.degree) || 0); });
        html += '<div class="gs-section">' +
          '<div class="gs-section-title"><span class="gs-icon">&#127760;</span>Main Concepts</div>' +
          '<div class="gs-concepts">';
        concepts.forEach(function (c) {
          var bwLabel = c.betweenness > 0 ? c.betweenness.toFixed(2) : null;
          html += '<span class="gs-concept">' +
            '<span class="gs-concept-name">' + escapeHtml(c.name) + '</span>' +
            '<span class="gs-concept-metric" title="degree (connections)">d:' + escapeHtml(c.degree) + '</span>' +
            (bwLabel ? '<span class="gs-concept-metric gs-metric-bw" title="betweenness (bridge score)">b:' + bwLabel + '</span>' : '') +
          '</span>';
        });
        html += '</div></div>';
      }
    }

    // ── Topical Gaps ───────────────────────────────────────────────────
    var gapMatch = text.match(/<TopicalGaps>([\s\S]*?)<\/TopicalGaps>/i);
    if (gapMatch && gapMatch[1].trim()) {
      var gaps = gapMatch[1].trim().split(/[,;]+/).map(function (g) { return g.trim(); }).filter(Boolean);
      if (gaps.length) {
        html += '<div class="gs-section">' +
          '<div class="gs-section-title"><span class="gs-icon">&#128262;</span>Topical Gaps</div>' +
          '<div class="gs-tags">';
        gaps.forEach(function (g) { html += '<span class="gs-tag gs-tag-gap">' + escapeHtml(g) + '</span>'; });
        html += '</div></div>';
      }
    }

    // ── Conceptual Gateways ────────────────────────────────────────────
    var gwMatch = text.match(/<ConceptualGateways>([\s\S]*?)<\/ConceptualGateways>/i);
    if (gwMatch && gwMatch[1].trim()) {
      var gws = gwMatch[1].trim().split(/[,;]+/).map(function (g) { return g.trim(); }).filter(Boolean);
      if (gws.length) {
        html += '<div class="gs-section">' +
          '<div class="gs-section-title"><span class="gs-icon">&#128279;</span>Conceptual Gateways</div>' +
          '<div class="gs-tags">';
        gws.forEach(function (g) { html += '<span class="gs-tag gs-tag-gateway">' + escapeHtml(g) + '</span>'; });
        html += '</div></div>';
      }
    }

    // ── Relations ─────────────────────────────────────────────────────
    var relMatch = text.match(/<Relations>([\s\S]*?)<\/Relations>/i);
    if (relMatch && relMatch[1].trim()) {
      var relItems = [];
      var tokens = relMatch[1].trim().split(/\s+/);
      var ti = 0;
      while (ti < tokens.length) {
        // Collect left-side words until an arrow token
        var leftParts = [];
        while (ti < tokens.length && tokens[ti] !== '<-' && tokens[ti] !== '->') {
          leftParts.push(tokens[ti++]);
        }
        var left = leftParts.join(' ').trim();
        if (ti >= tokens.length) break;

        var arrowType;
        if (tokens[ti] === '<-' && tokens[ti + 1] === '->') {
          arrowType = 'bi'; ti += 2;
        } else if (tokens[ti] === '->') {
          arrowType = 'fwd'; ti++;
        } else if (tokens[ti] === '<-') {
          arrowType = 'rev'; ti++;
        } else {
          ti++; continue;
        }

        // Collect right-side words until next arrow or end
        var rightParts = [];
        while (ti < tokens.length && tokens[ti] !== '<-' && tokens[ti] !== '->') {
          rightParts.push(tokens[ti++]);
        }
        var right = rightParts.join(' ').trim();

        if (left && right) relItems.push({ from: left, type: arrowType, to: right });
      }

      if (relItems.length) {
        html += '<div class="gs-section">' +
          '<div class="gs-section-title"><span class="gs-icon">&#128257;</span>Relations</div>' +
          '<div class="gs-relations">';
        relItems.forEach(function (r) {
          var arrowHtml = r.type === 'bi' ? '<span class="gs-arrow gs-arrow-bi">&#8596;</span>' :
                          r.type === 'fwd' ? '<span class="gs-arrow gs-arrow-fwd">&#8594;</span>' :
                                             '<span class="gs-arrow gs-arrow-rev">&#8592;</span>';
          html += '<div class="gs-relation">' +
            '<span class="gs-rel-node">' + escapeHtml(r.from) + '</span>' +
            arrowHtml +
            '<span class="gs-rel-node">' + escapeHtml(r.to) + '</span>' +
          '</div>';
        });
        html += '</div></div>';
      }
    }

    // ── Diversity Statistics ───────────────────────────────────────────
    var statsMatch = text.match(/<DiversityStatistics>([\s\S]*?)<\/DiversityStatistics>/i);
    if (statsMatch && statsMatch[1].trim()) {
      var statsText = statsMatch[1].trim();

      // Known key-value patterns (ordered longest-first to avoid partial matches)
      var kvKeys = [
        'Entropy of top nodes distribution among clusters',
        'Ratio of top nodes Influence / betweenness',
        'Betweenness / influence per cluster',
        'Ratio of top topical clusters',
        'Modularity Score',
        'Modularity',
      ];
      var kvShort = {
        'Entropy of top nodes distribution among clusters': 'Entropy',
        'Ratio of top nodes Influence / betweenness':       'Influence/betweenness',
        'Betweenness / influence per cluster':              'Betweenness/cluster',
        'Ratio of top topical clusters':                    'Topical clusters ratio',
        'Modularity Score':                                 'Modularity score',
        'Modularity':                                       'Modularity',
      };
      var kvValues = {};
      var remaining = statsText;
      kvKeys.forEach(function (k) {
        var re = new RegExp(k.replace(/[/\\()]/g, '\\$&') + '\\s*:\\s*([\\w\\.\\-]+)', 'i');
        var m = remaining.match(re);
        if (m) { kvValues[k] = m[1]; remaining = remaining.replace(m[0], ' ').trim(); }
      });

      // Standalone badge statements (what's left after stripping kv pairs)
      var badges = remaining.split(/\s{2,}|(?<=[a-z])(?=[A-Z])/)
        .map(function (s) { return s.trim(); })
        .filter(function (s) { return s.length > 4 && !/^\d+$/.test(s); });

      var hasAny = Object.keys(kvValues).length > 0 || badges.length > 0;
      if (hasAny) {
        html += '<div class="gs-section">' +
          '<div class="gs-section-title"><span class="gs-icon">&#128202;</span>Graph Diversity</div>' +
          '<div class="gs-stats-grid">';

        kvKeys.forEach(function (k) {
          if (kvValues[k] === undefined) return;
          var valClass = '';
          var numVal = parseFloat(kvValues[k]);
          if (k === 'Modularity' && !isNaN(numVal)) {
            valClass = numVal === 0 ? 'gs-val-warn' : numVal < 0.3 ? 'gs-val-warn' : 'gs-val-ok';
          }
          html += '<div class="gs-stat-item">' +
            '<span class="gs-stat-key">' + escapeHtml(kvShort[k]) + '</span>' +
            '<span class="gs-stat-val ' + valClass + '">' + escapeHtml(kvValues[k]) + '</span>' +
          '</div>';
        });

        if (badges.length) {
          html += '<div class="gs-stat-badges">';
          badges.forEach(function (b) {
            html += '<span class="gs-stat-badge">' + escapeHtml(b) + '</span>';
          });
          html += '</div>';
        }

        html += '</div></div>';
      }
    }

    html += '</div>';
    return html;
  }

  /**
   * Extract readable text from content_markdown that might be JSON chunks format.
   */
  function extractReadableText(raw) {
    if (!raw || typeof raw !== 'string') return '';
    var trimmed = raw.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
      return trimmed
        .replace(/[#*_\[\]()>`~|\\]/g, ' ')
        .replace(/!\[.*?\]\(.*?\)/g, '')
        .replace(/\[([^\]]*)\]\(.*?\)/g, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    }
    try {
      var parsed = JSON.parse(trimmed);
      var texts = [];
      extractTextsFromObj(parsed, texts);
      var result = texts.join(' ').replace(/\s+/g, ' ').trim();
      return result || '[Content available]';
    } catch (e) {
      return trimmed.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
  }

  function extractTextsFromObj(obj, result) {
    if (!obj) return;
    if (typeof obj === 'string') { var cl = obj.trim(); if (cl.length > 2) result.push(cl); return; }
    if (Array.isArray(obj)) { for (var i = 0; i < obj.length; i++) extractTextsFromObj(obj[i], result); return; }
    if (typeof obj === 'object') {
      var pKeys = ['text', 'content', 'value', 'body', 'title', 'description', 'summary'];
      for (var k = 0; k < pKeys.length; k++) { if (obj[pKeys[k]]) extractTextsFromObj(obj[pKeys[k]], result); }
      var cKeys = ['chunks', 'items', 'children', 'data', 'results', 'blocks', 'paragraphs'];
      for (var c = 0; c < cKeys.length; c++) { if (obj[cKeys[c]]) extractTextsFromObj(obj[cKeys[c]], result); }
    }
  }

  function formatCharCount(chars) {
    if (chars >= 10000) return Math.round(chars / 1000) + 'k chars';
    if (chars >= 1000) return (chars / 1000).toFixed(1) + 'k chars';
    return chars + ' chars';
  }

  function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.slice(0, len) + '...' : str;
  }

  function stripMarkdown(str) {
    if (!str) return '';
    return str.replace(/[#*_\[\]()>~|\\]/g, '').replace(/\s+/g, ' ').trim();
  }

  function showToast(message, type) {
    type = type || 'info';
    var container = $('toastContainer');
    if (!container) return;
    var toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 3600);
  }

  // ─── API client with TTL cache + in-flight dedupe + invalidation ────────
  // Revisiting a page within a few seconds returns cached data instantly.
  // Concurrent calls to the same GET URL share one network request.
  // Any POST/PUT/DELETE to /api/foo/... invalidates every GET /api/foo cache entry.
  var _apiCache = new Map(); // url -> { data, fetchedAt }
  var _apiInflight = new Map(); // url -> Promise
  var _API_DEFAULT_TTL_MS = 10000;

  function _apiInvalidate(mutationUrl) {
    var match = mutationUrl.match(/^(\/api\/[^/?]+)/);
    if (!match) { _apiCache.clear(); return; }
    var prefix = match[1];
    var toDelete = [];
    _apiCache.forEach(function (_v, k) { if (k.indexOf(prefix) === 0) toDelete.push(k); });
    for (var i = 0; i < toDelete.length; i++) _apiCache.delete(toDelete[i]);
  }

  // Global helper: refresh buttons call this before re-running a loadX()
  // so the user always gets fresh data when they explicitly hit Refresh.
  function forceApiRefresh(prefix) {
    if (prefix) _apiInvalidate(prefix);
    else _apiCache.clear();
  }

  function fetchApi(url, options) {
    options = options || {};
    options.credentials = 'same-origin';
    if (!options.headers) options.headers = {};

    var method = (options.method || 'GET').toUpperCase();
    var isGet = method === 'GET';
    var cacheMs = options.cacheMs != null ? options.cacheMs : (isGet ? _API_DEFAULT_TTL_MS : 0);
    var bypass = options.bypassCache === true;

    if (isGet && cacheMs > 0 && !bypass) {
      var cached = _apiCache.get(url);
      if (cached && (Date.now() - cached.fetchedAt) < cacheMs) {
        return Promise.resolve(cached.data);
      }
      var inflight = _apiInflight.get(url);
      if (inflight) return inflight;
    }

    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }

    var promise = fetch(url, options).then(function (res) {
      if (res.status === 401) {
        window.location.href = '/login';
        throw new Error('Unauthorized');
      }
      if (!res.ok) {
        return res.json().then(function (data) {
          throw new Error(data.error || 'Request failed (' + res.status + ')');
        }).catch(function (e) {
          if (e.message.indexOf('Unexpected') !== -1) {
            throw new Error('Request failed (' + res.status + ')');
          }
          throw e;
        });
      }
      return res.json();
    }).then(function (data) {
      if (isGet && cacheMs > 0) {
        _apiCache.set(url, { data: data, fetchedAt: Date.now() });
      } else if (!isGet) {
        _apiInvalidate(url);
      }
      _apiInflight.delete(url);
      return data;
    }).catch(function (err) {
      _apiInflight.delete(url);
      throw err;
    });

    if (isGet && cacheMs > 0 && !bypass) _apiInflight.set(url, promise);
    return promise;
  }

  // ─── Router ─────────────────────────────────────────────────────────────

  function navigateTo(page) {
    // Clear timers from the previous page before switching
    clearPageTimers();

    // Close editor overlay if it's open. Without this, sidebar nav clicks
    // while the editor is visible leave the fixed-position #editor-overlay
    // on top of every subsequent page, blocking all clicks underneath.
    var editorOverlay = document.getElementById('editor-overlay');
    if (editorOverlay && editorOverlay.style.display !== 'none') {
      editorOverlay.style.display = 'none';
      currentDraftId = null;
      currentDraft = null;
      try { sessionStorage.removeItem('hdf_editor'); } catch (e) {}
    }

    // Close SSE connection when leaving feed page
    if (state.currentPage === 'feed' && state.sseConnection) {
      state.sseConnection.close();
      state.sseConnection = null;
    }

    state.currentPage = page;

    // Keep URL hash in sync
    if (window.location.hash.slice(1) !== page) {
      window.location.hash = page;
    }

    // Update topbar page title
    var pageTitleEl = document.getElementById('page-title');
    if (pageTitleEl) {
      var PAGE_TITLES = {
        overview: 'Overview', feed: 'Live Feed', rules: 'Firehose Rules',
        trends: 'Trends', clusters: 'Clusters', failed: 'Failed Drafts',
        published: 'Published', settings: 'Settings',
        'wp-settings': 'WordPress Settings', logs: 'Logs',
        sources: 'Sources', fuel: 'Fuel Prices', metals: 'Metals',
        lottery: 'Lottery', autopilot: 'Autopilot'
      };
      pageTitleEl.textContent = PAGE_TITLES[page] || page.charAt(0).toUpperCase() + page.slice(1);
    }

    // Update nav
    var links = $$('.nav-link[data-page]');
    for (var i = 0; i < links.length; i++) {
      links[i].classList.toggle('active', links[i].getAttribute('data-page') === page);
    }

    // Hide ALL pages, then show the target
    var pages = $$('.page');
    for (var j = 0; j < pages.length; j++) {
      var pageId = pages[j].id.replace('page-', '');
      pages[j].classList.toggle('hidden', pageId !== page);
    }

    // Load page data
    switch (page) {
      case 'overview': loadOverview(); break;
      case 'feed': initFeed(); break;
      case 'rules': loadRules(); break;
      case 'trends': loadTrends(); break;
      case 'clusters': loadClusters(); break;
      case 'ready': navigateTo('autopilot'); break; // redirected to Autopilot queue
      case 'failed': loadFailedDrafts(); break;
      case 'published':
        // Reset to page 1 when user navigates fresh to Published page
        // (vs. in-page reloads triggered by save/publish/delete actions)
        _publishedPage = 1;
        loadPublished();
        break;
      case 'settings': loadSettings(); loadAISettings(); loadFuelMetalsSettings(); loadPipelineEngineSettings(); break;
      case 'wp-settings': loadWPPublishingSettings(); loadWPTaxonomy(); loadPublishRules(); initBulkImport(); loadActiveConfigViewer(); break;
      case 'logs': loadLogs(); break;
      case 'sources': loadSourcesPage(); break;
      case 'fuel': loadFuelPage(); break;
      case 'metals': loadMetalsPage(); break;
      case 'lottery': loadLotteryPage(); break;
      case 'autopilot': loadAutopilot(); break;
    }

    // Close sidebar on mobile
    var sidebar = $('sidebar');
    if (sidebar) sidebar.classList.remove('open');

    if (typeof updateBatchActions === 'function') updateBatchActions();
    _refreshIcons();
  }

  function initRouter() {
    var hash = window.location.hash.slice(1) || 'overview';
    navigateTo(hash);

    // Restore editor state after refresh
    try {
      var saved = sessionStorage.getItem('hdf_editor');
      if (saved) {
        var editorState = JSON.parse(saved);
        if (editorState && editorState.draftId) {
          // Small delay so the page data loads first, then reopen editor
          setTimeout(function () {
            openEditor(editorState.draftId);
          }, 400);
        }
      }
    } catch (e) {}

    // Handle browser back/forward
    window.addEventListener('hashchange', function () {
      var hash = window.location.hash.slice(1) || 'overview';
      if (hash !== state.currentPage) {
        navigateTo(hash);
      }
    });

    // Explicit click handlers on sidebar nav links (belt-and-suspenders)
    var navLinks = $$('.nav-link[data-page]');
    for (var i = 0; i < navLinks.length; i++) {
      navLinks[i].addEventListener('click', function (e) {
        var page = this.getAttribute('data-page');
        if (page) {
          e.preventDefault();
          navigateTo(page);
        }
      });
    }
  }

  // ─── Mobile Sidebar ────────────────────────────────────────────────────

  function initSidebar() {
    var hamburger = $('hamburger');
    var sidebarClose = $('sidebarClose');
    var sidebar = $('sidebar');

    if (hamburger && sidebar) {
      hamburger.addEventListener('click', function () {
        sidebar.classList.toggle('open');
      });
    }

    if (sidebarClose && sidebar) {
      sidebarClose.addEventListener('click', function () {
        sidebar.classList.remove('open');
      });
    }
  }

  // ─── Overview Page ──────────────────────────────────────────────────────

  function loadOverview() {
    fetchStats();
    fetchStatus();
    fetchHealth();

    clearPageTimers();
    state.refreshTimers.push(setInterval(function () {
      if (document.hidden) return;
      fetchStats();
      fetchStatus();
      fetchHealth();
    }, 30000));
  }

  function fetchHealth() {
    fetchApi('/api/health')
      .then(function (data) {
        if (!data.modules) return;
        for (var i = 0; i < data.modules.length; i++) {
          var m = data.modules[i];
          var card = $('health-' + m.module);
          if (!card) continue;

          var dot = card.querySelector('.health-dot');
          var detail = card.querySelector('.health-detail');

          if (dot) {
            dot.className = 'health-dot';
            if (m.status === 'connected') dot.classList.add('health-green');
            else if (m.status === 'degraded') dot.classList.add('health-yellow');
            else if (m.status === 'error') dot.classList.add('health-red');
            else dot.classList.add('health-grey');
          }

          if (detail) {
            var statusLabel = m.status === 'connected' ? 'OK' : m.status;
            if (m.status === 'disabled') statusLabel = 'Off';
            if (m.error) statusLabel = m.error.substring(0, 30);

            // Add stats info
            if (m.module === 'firehose' && m.stats && m.stats.articlesReceived) {
              statusLabel = m.stats.articlesReceived + ' arts';
            } else if (m.module === 'buffer' && m.stats && m.stats.count !== undefined) {
              statusLabel = m.stats.count + ' buf';
            } else if (m.module === 'rewriter' && m.status === 'degraded') {
              statusLabel = 'Partial';
            } else if (m.module === 'publisher' && m.status === 'disabled') {
              statusLabel = 'No WP';
            } else if (m.module === 'extractor' && m.stats) {
              statusLabel = (m.stats.totalExtracted || 0) + ' ext';
            } else if (m.module === 'scheduler' && m.stats) {
              statusLabel = 'Q:' + (m.stats.queueSize || 0);
            }

            detail.textContent = statusLabel;
          }
        }
      })
      .catch(function () { /* silent */ });
  }

  function fetchStats() {
    fetchApi('/api/stats')
      .then(function (data) {
        $('statArticlesToday').textContent = data.articlesToday || 0;
        $('statClustersToday').textContent = data.clustersToday || 0;
        $('statPublishedToday').textContent = data.publishedToday || 0;
        $('statTotalArticles').textContent = data.totalArticles || 0;

        renderHourlyChart(data.hourlyArticles || []);
      })
      .catch(function (err) {
        showToast('Failed to load stats: ' + err.message, 'error');
      });
  }

  function fetchStatus() {
    fetchApi('/api/status')
      .then(function (data) {
        // Firehose status dot - use .connected property (boolean)
        var fhDot = $('firehoseStatus');
        if (fhDot && data.firehose) {
          fhDot.className = 'status-dot';
          if (data.firehose.connected) fhDot.classList.add('connected');
          else if (data.firehose.stopped || !data.firehose.tokenConfigured) { /* leave gray */ }
          else fhDot.classList.add('reconnecting');
        }

        // Trends status dot - use .enabled property
        var trDot = $('trendsStatus');
        if (trDot && data.trends) {
          trDot.className = 'status-dot';
          if (!data.trends.enabled) { /* leave gray */ }
          else if (data.trends.running) trDot.classList.add('connected');
          else trDot.classList.add('reconnecting');

          if (data.trends.lastPoll) {
            $('lastTrendsPoll').textContent = 'Trends: ' + formatTime(data.trends.lastPoll);
          }
        }

        // Buffer count
        if (data.buffer && data.buffer.count !== undefined) {
          $('bufferCount').textContent = 'Buffer: ' + data.buffer.count;
        }

        // System status table
        renderSystemStatus(data);
      })
      .catch(function () {
        // Silent fail for status polling
      });
  }

  function renderSystemStatus(data) {
    var container = $('systemStatus');
    if (!container) return;

    var rows = [];

    if (data.firehose) {
      rows.push(['Firehose State', data.firehose.connected ? 'connected' : (data.firehose.state || 'stopped')]);
      if (data.firehose.articlesReceived !== undefined)
        rows.push(['Firehose Articles Received', data.firehose.articlesReceived]);
      if (data.firehose.reconnects !== undefined)
        rows.push(['Firehose Reconnects', data.firehose.reconnects]);
    }
    if (data.trends) {
      rows.push(['Trends State', data.trends.enabled ? (data.trends.running ? 'polling' : 'idle') : 'disabled']);
      if (data.trends.watchlistSize !== undefined)
        rows.push(['Trends Watchlist Size', data.trends.watchlistSize]);
      if (data.trends.lastPoll)
        rows.push(['Last Trends Poll', formatDateTime(data.trends.lastPoll)]);
    }
    if (data.scheduler) {
      if (data.scheduler.queueSize !== undefined)
        rows.push(['Scheduler Queue', data.scheduler.queueSize]);
      if (data.scheduler.publishedThisHour !== undefined)
        rows.push(['Published This Hour', data.scheduler.publishedThisHour]);
    }
    if (data.buffer) {
      if (data.buffer.count !== undefined)
        rows.push(['Buffer Articles', data.buffer.count]);
      if (data.buffer.oldestAge !== undefined)
        rows.push(['Buffer Oldest', data.buffer.oldestAge]);
    }

    if (rows.length === 0) {
      container.innerHTML = '<p class="placeholder-text">No status data available</p>';
      return;
    }

    var html = '<table><tbody>';
    for (var i = 0; i < rows.length; i++) {
      html += '<tr><td class="status-key">' + escapeHtml(String(rows[i][0])) +
              '</td><td class="status-value">' + escapeHtml(String(rows[i][1])) + '</td></tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  // ─── Hourly Chart (SVG) ────────────────────────────────────────────────

  function renderHourlyChart(hourlyData) {
    var container = $('hourlyChart');
    if (!container) return;

    // Build 24-hour slots
    var now = new Date();
    var slots = [];
    for (var h = 23; h >= 0; h--) {
      var d = new Date(now);
      d.setMinutes(0, 0, 0);
      d.setHours(d.getHours() - h);
      var key = d.toISOString().slice(0, 13) + ':00:00';
      slots.push({ hour: key, label: d.getHours() + ':00', count: 0 });
    }

    // Fill in data
    var dataMap = {};
    for (var i = 0; i < hourlyData.length; i++) {
      dataMap[hourlyData[i].hour] = hourlyData[i].count;
    }
    for (var j = 0; j < slots.length; j++) {
      if (dataMap[slots[j].hour]) slots[j].count = dataMap[slots[j].hour];
    }

    var maxCount = 1;
    for (var k = 0; k < slots.length; k++) {
      if (slots[k].count > maxCount) maxCount = slots[k].count;
    }

    // SVG dimensions
    var width = 800;
    var height = 160;
    var paddingTop = 10;
    var paddingBottom = 24;
    var paddingLeft = 4;
    var barAreaHeight = height - paddingTop - paddingBottom;
    var barWidth = Math.floor((width - paddingLeft * 2) / slots.length) - 2;
    var gap = 2;

    var svg = '<svg viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg">';

    for (var s = 0; s < slots.length; s++) {
      var barHeight = slots[s].count > 0
        ? Math.max(3, Math.round((slots[s].count / maxCount) * barAreaHeight))
        : 0;
      var x = paddingLeft + s * (barWidth + gap);
      var y = paddingTop + barAreaHeight - barHeight;

      if (barHeight > 0) {
        svg += '<rect class="bar" x="' + x + '" y="' + y + '" width="' + barWidth +
               '" height="' + barHeight + '" rx="2">' +
               '<title>' + escapeHtml(slots[s].label) + ': ' + slots[s].count + ' articles</title></rect>';
      }

      // Count label on top of bar
      if (slots[s].count > 0) {
        svg += '<text class="bar-label" x="' + (x + barWidth / 2) + '" y="' + (y - 4) + '">' +
               slots[s].count + '</text>';
      }

      // Hour label (show every 3rd)
      if (s % 3 === 0) {
        svg += '<text class="axis-label" x="' + (x + barWidth / 2) + '" y="' + (height - 4) + '">' +
               escapeHtml(slots[s].label) + '</text>';
      }
    }

    svg += '</svg>';
    container.innerHTML = svg;
  }

  // ─── Live Feed Page ─────────────────────────────────────────────────────

  function initFeed() {
    var feedList = $('feedList');
    var feedCounter = $('feedCounter');
    var pauseBtn = $('feedPauseBtn');
    var clearBtn = $('feedClearBtn');

    if (!feedList) return;

    // Check firehose status for empty state
    fetchApi('/api/status').then(function (statusData) {
      if (state.feedArticles.length === 0 && feedList.children.length === 0) {
        var firehoseOk = statusData.firehose && statusData.firehose.connected;
        if (!firehoseOk) {
          feedList.innerHTML =
            '<div class="feed-empty">' +
              '<div class="feed-empty-icon">&#9889;</div>' +
              '<div class="feed-empty-title">Firehose not connected</div>' +
              '<div class="feed-empty-desc">Go to <a href="#rules">Firehose Rules</a> to add your token and connect.</div>' +
            '</div>';
        } else {
          feedList.innerHTML =
            '<div class="feed-empty">' +
              '<div class="feed-empty-icon">&#9203;</div>' +
              '<div class="feed-empty-title">No articles yet</div>' +
              '<div class="feed-empty-desc">Waiting for Firehose data...</div>' +
            '</div>';
        }
      }
    }).catch(function () { /* silent */ });

    // Reset hourly counter if over an hour old
    if (Date.now() - state.feedHourlyStart > 3600000) {
      state.feedHourlyCount = 0;
      state.feedHourlyStart = Date.now();
    }

    // Connect to SSE if not already
    if (!state.sseConnection) {
      state.sseConnection = new EventSource('/api/feed/live');

      state.sseConnection.addEventListener('initial-batch', function (e) {
        try {
          var articles = JSON.parse(e.data);
          for (var i = 0; i < articles.length; i++) {
            state.feedArticles.push(articles[i]);
            if (shouldShowArticle(articles[i])) {
              renderArticleCard(feedList, articles[i], false);
            }
          }
          state.feedCount = state.feedArticles.length;
          updateFeedCounter();
          // Clear empty state
          var emptyState = feedList.querySelector('.feed-empty');
          if (emptyState && articles.length > 0) feedList.removeChild(emptyState);
          // Load draft statuses for batch
          loadDraftStatuses();
        } catch (err) {
          // Ignore parse errors
        }
      });

      state.sseConnection.addEventListener('article', function (e) {
        if (state.ssePaused) return;

        try {
          var article = JSON.parse(e.data);

          // Don't update the visible feed while search is active
          if (searchActive) {
            state.feedArticles.unshift(article);
            if (state.feedArticles.length > 500) state.feedArticles.pop();
            state.feedCount++;
            updateFeedCounter();
            return;
          }

          state.feedArticles.unshift(article);
          state.feedCount++;
          state.feedHourlyCount++;

          // Reset hourly counter if needed
          if (Date.now() - state.feedHourlyStart > 3600000) {
            state.feedHourlyCount = 1;
            state.feedHourlyStart = Date.now();
          }

          // Limit DOM nodes
          if (state.feedArticles.length > 500) {
            state.feedArticles = state.feedArticles.slice(0, 500);
          }

          // Clear empty state if present
          var emptyState = feedList.querySelector('.feed-empty');
          if (emptyState) feedList.innerHTML = '';

          // Apply filters
          if (shouldShowArticle(article)) {
            renderArticleCard(feedList, article, true);
          }

          // Check if this article is already in drafts
          if (article.url && !draftStatusCache[article.url]) {
            fetchApi('/api/drafts/status?url=' + encodeURIComponent(article.url))
              .then(function (d) {
                // Support both response formats:
                // New: { draft: { draft_id, status, wp_post_url } }
                // Old: { exists: true, draft_id, status, wp_post_url }
                var draftData = d.draft || (d.exists ? { draft_id: d.draft_id, status: d.status, wp_post_url: d.wp_post_url } : null);
                if (draftData) {
                  draftStatusCache[article.url] = draftData;
                  var c = document.querySelector('.article-card[data-article-url="' + CSS.escape(article.url) + '"]');
                  if (c) updateCardStatusBadge(c, article.url);
                }
              }).catch(function () {});
          }

          // Remove excess DOM children
          while (feedList.children.length > 500) {
            feedList.removeChild(feedList.lastChild);
          }

          updateFeedCounter();
        } catch (err) {
          // Ignore parse errors
        }
      });

      state.sseConnection.onerror = function () {
        // EventSource reconnects automatically
      };
    }

    // Pause/Resume
    if (pauseBtn) {
      pauseBtn.onclick = function () {
        state.ssePaused = !state.ssePaused;
        pauseBtn.textContent = state.ssePaused ? 'Resume' : 'Pause';
        pauseBtn.classList.toggle('btn-secondary', state.ssePaused);
      };
    }

    // Clear
    if (clearBtn) {
      clearBtn.onclick = function () {
        feedList.innerHTML = '';
        state.feedArticles = [];
        state.feedCount = 0;
        state.feedHourlyCount = 0;
        state.feedHourlyStart = Date.now();
        updateFeedCounter();
        clearSelection();
      };
    }

    // Bulk action bar buttons
    var bulkSelectAllBtn = $('bulkSelectAllBtn');
    var bulkClearSelBtn = $('bulkClearBtn');
    var bulkFetchBtn = $('bulkFetchBtn');
    if (bulkSelectAllBtn) { bulkSelectAllBtn.onclick = function () { selectAllVisible(); }; }
    if (bulkClearSelBtn) { bulkClearSelBtn.onclick = function () { clearSelection(); }; }
    if (bulkFetchBtn) { bulkFetchBtn.onclick = function () { bulkFetchAndAddToDrafts(); }; }

    // Render feed filters and search
    renderFeedFilters();
    initFeedSearch();

    // Load initial articles from buffer
    fetchApi('/api/feed?page=1')
      .then(function (data) {
        if (data.data && data.data.length > 0) {
          // Clear empty state
          var emptyState = feedList.querySelector('.feed-empty');
          if (emptyState) feedList.innerHTML = '';

          for (var i = 0; i < data.data.length; i++) {
            if (shouldShowArticle(data.data[i])) {
              renderArticleCard(feedList, data.data[i], false);
            }
          }
          if (feedCounter) feedCounter.textContent = data.total + ' total';
          // Load draft statuses after initial feed load
          loadDraftStatuses();
        }
      })
      .catch(function () { /* silent */ });

    // Refresh transient statuses every 10s (fetching, rewriting, adding)
    var statusRefreshTimer = setInterval(function () {
      if (document.hidden) return;
      if (state.currentPage !== 'feed') return;
      var hasTransient = false;
      var cacheKeys = Object.keys(draftStatusCache);
      for (var ti = 0; ti < cacheKeys.length; ti++) {
        var st = draftStatusCache[cacheKeys[ti]] && draftStatusCache[cacheKeys[ti]].status;
        if (st === 'fetching' || st === 'rewriting') { hasTransient = true; break; }
      }
      if (Object.keys(pendingAddUrls).length > 0) hasTransient = true;
      if (hasTransient) loadDraftStatuses();
    }, 10000);
    state.refreshTimers.push(statusRefreshTimer);
  }

  function shouldShowArticle(article) {
    if (state.feedFilterDomain && article.domain) {
      if (article.domain.toLowerCase().indexOf(state.feedFilterDomain.toLowerCase()) === -1) {
        return false;
      }
    }
    if (state.feedFilterLang && article.language) {
      if (article.language !== state.feedFilterLang) {
        return false;
      }
    }
    // "Show Only New" filter — hide articles already in drafts
    if (showOnlyNew && article.url && draftStatusCache[article.url]) {
      return false;
    }
    return true;
  }

  function updateFeedCounter() {
    var feedCounter = $('feedCounter');
    if (feedCounter) {
      feedCounter.textContent = state.feedCount + ' articles | ' + state.feedHourlyCount + ' this hour';
    }
  }

  function renderFeedFilters() {
    var pageHeader = document.querySelector('#page-feed .page-header');
    if (!pageHeader) return;

    // Check if filters already added
    if (document.getElementById('feedFiltersRow')) return;

    var filtersDiv = document.createElement('div');
    filtersDiv.id = 'feedFiltersRow';
    filtersDiv.className = 'feed-filters';
    filtersDiv.style.marginBottom = '12px';
    filtersDiv.innerHTML =
      '<div class="feed-search-row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">' +
        '<input type="text" id="feedSearchKeyword" placeholder="Search titles by keyword..." ' +
          'style="flex:1;min-width:220px;font-size:13px;padding:6px 12px;background:var(--input-bg,#1a1a2e);color:var(--text-primary,#fff);border:1px solid var(--border,#2a2a4a);border-radius:4px">' +
        '<button id="feedSearchBtn" class="btn btn-sm btn-primary" style="white-space:nowrap">Search</button>' +
        '<button id="feedSearchClear" class="btn btn-sm btn-secondary" style="white-space:nowrap;display:none">Clear</button>' +
      '</div>' +
      '<div id="feedSearchResults" style="display:none;margin-bottom:8px">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">' +
          '<span id="feedSearchCount" style="font-size:12px;color:var(--text-muted,#888)"></span>' +
          '<span id="feedSearchSource" style="font-size:11px;color:var(--text-muted,#666)"></span>' +
        '</div>' +
      '</div>' +
      '<div class="feed-filter-row" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' +
        '<input type="text" id="feedFilterDomain" placeholder="Filter by domain..." style="width:180px;font-size:12px;padding:5px 10px">' +
        '<select id="feedFilterLang" style="font-size:12px;padding:5px 10px">' +
          '<option value="">All Languages</option>' +
          '<option value="en">English</option>' +
          '<option value="hi">Hindi</option>' +
          '<option value="ta">Tamil</option>' +
          '<option value="te">Telugu</option>' +
          '<option value="bn">Bengali</option>' +
          '<option value="mr">Marathi</option>' +
          '<option value="gu">Gujarati</option>' +
          '<option value="kn">Kannada</option>' +
          '<option value="ml">Malayalam</option>' +
          '<option value="pa">Punjabi</option>' +
        '</select>' +
        '<button id="feedFilterNew" class="filter-toggle-btn" style="margin-left:6px">' + (showOnlyNew ? '&#128308; New Only' : '&#9898; All Articles') + '</button>' +
      '</div>';

    // Insert after page header
    pageHeader.parentNode.insertBefore(filtersDiv, pageHeader.nextSibling);

    var domainInput = $('feedFilterDomain');
    var langSelect = $('feedFilterLang');

    if (domainInput) {
      domainInput.addEventListener('input', function () {
        state.feedFilterDomain = domainInput.value;
        reRenderFeed();
      });
    }

    if (langSelect) {
      langSelect.addEventListener('change', function () {
        state.feedFilterLang = langSelect.value;
        reRenderFeed();
      });
    }

    var newBtn = $('feedFilterNew');
    if (newBtn) {
      if (showOnlyNew) newBtn.classList.add('active');
      newBtn.addEventListener('click', function () {
        showOnlyNew = !showOnlyNew;
        newBtn.className = 'filter-toggle-btn' + (showOnlyNew ? ' active' : '');
        newBtn.innerHTML = showOnlyNew ? '&#128308; New Only' : '&#9898; All Articles';
        reRenderFeed();
      });
    }
  }

  // ─── Keyword Search for Live Feed ───────────────────────────────────────

  var searchActive = false;

  function initFeedSearch() {
    var searchInput = $('feedSearchKeyword');
    var searchBtn = $('feedSearchBtn');
    var clearBtn = $('feedSearchClear');

    if (!searchInput || !searchBtn) return;

    searchBtn.addEventListener('click', function () {
      performFeedSearch(searchInput.value.trim());
    });

    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        performFeedSearch(searchInput.value.trim());
      }
    });

    if (clearBtn) {
      clearBtn.addEventListener('click', function () {
        searchInput.value = '';
        clearFeedSearch();
      });
    }
  }

  function performFeedSearch(query) {
    if (!query || query.length < 2) {
      showToast('Enter at least 2 characters to search', 'warning');
      return;
    }

    var clearBtn = $('feedSearchClear');
    var resultsDiv = $('feedSearchResults');
    var countSpan = $('feedSearchCount');
    var sourceSpan = $('feedSearchSource');

    // Client-side search in loaded feed articles
    var keywords = query.toLowerCase().split(/\s+/).filter(Boolean);
    var localMatches = state.feedArticles.filter(function (article) {
      var title = (article.title || '').toLowerCase();
      return keywords.every(function (kw) { return title.indexOf(kw) !== -1; });
    });

    searchActive = true;
    if (clearBtn) clearBtn.style.display = '';
    if (resultsDiv) resultsDiv.style.display = '';
    if (countSpan) countSpan.textContent = 'Searching...';

    // Also search the database
    fetchApi('/api/articles/search?q=' + encodeURIComponent(query) + '&limit=100')
      .then(function (data) {
        var dbResults = data.articles || [];

        // Merge and deduplicate by URL
        var seen = {};
        var merged = [];
        var i;

        for (i = 0; i < localMatches.length; i++) {
          var lKey = localMatches[i].url || localMatches[i].firehose_event_id;
          if (!seen[lKey]) { seen[lKey] = true; merged.push(localMatches[i]); }
        }
        for (i = 0; i < dbResults.length; i++) {
          var dKey = dbResults[i].url || dbResults[i].firehose_event_id;
          if (!seen[dKey]) { seen[dKey] = true; merged.push(dbResults[i]); }
        }

        var feedList = $('feedList');
        if (feedList) {
          feedList.innerHTML = '';
          if (merged.length === 0) {
            feedList.innerHTML = '<p class="placeholder-text">No articles found matching "' + escapeHtml(query) + '"</p>';
          } else {
            for (i = 0; i < merged.length; i++) {
              renderArticleCard(feedList, merged[i], false);
            }
          }
        }

        if (countSpan) countSpan.textContent = merged.length + ' article(s) found for "' + query + '"';
        if (sourceSpan) sourceSpan.textContent = localMatches.length + ' from live feed, ' + dbResults.length + ' from database';

        // Offer to create Firehose rule
        if (merged.length > 0 && countSpan && countSpan.parentNode) {
          var existingRuleBtn = countSpan.parentNode.querySelector('.create-rule-btn');
          if (existingRuleBtn) existingRuleBtn.remove();
          var ruleBtn = document.createElement('button');
          ruleBtn.className = 'btn btn-sm btn-secondary create-rule-btn';
          ruleBtn.style.marginLeft = '8px';
          ruleBtn.textContent = 'Create Firehose Rule';
          ruleBtn.onclick = function () { createFirehoseRuleFromSearch(query); };
          countSpan.parentNode.appendChild(ruleBtn);
        }
      })
      .catch(function (err) {
        var feedList = $('feedList');
        if (feedList) {
          feedList.innerHTML = '';
          for (var k = 0; k < localMatches.length; k++) {
            renderArticleCard(feedList, localMatches[k], false);
          }
        }
        if (countSpan) countSpan.textContent = localMatches.length + ' article(s) found (local only)';
      });
  }

  function clearFeedSearch() {
    searchActive = false;
    var clearBtn = $('feedSearchClear');
    var resultsDiv = $('feedSearchResults');
    if (clearBtn) clearBtn.style.display = 'none';
    if (resultsDiv) resultsDiv.style.display = 'none';
    reRenderFeed();
  }

  function createFirehoseRuleFromSearch(query) {
    var keywords = query.split(/\s+/).filter(Boolean);
    var titleClauses = keywords.map(function (kw) {
      return kw.indexOf(' ') !== -1 ? 'title:"' + kw + '"' : 'title:' + kw.toLowerCase();
    });
    var ruleValue = 'language:en AND (' + titleClauses.join(' OR ') + ')';
    var tag = 'search-' + keywords.slice(0, 3).join('-').toLowerCase().replace(/[^a-z0-9-]/g, '');

    var tagInput = $('ruleTagInput');
    var queryInput = $('ruleQueryInput');

    if (tagInput && queryInput) {
      tagInput.value = tag;
      queryInput.value = ruleValue;
      showToast('Rule populated — review and click "Add Rule" to activate', 'info');
      var ruleForm = document.querySelector('.rule-form');
      if (ruleForm) ruleForm.scrollIntoView({ behavior: 'smooth' });
    } else {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(ruleValue).then(function () {
          showToast('Lucene rule copied to clipboard', 'success');
        }).catch(function () {
          showToast('Rule: ' + ruleValue, 'info');
        });
      } else {
        showToast('Rule: ' + ruleValue, 'info');
      }
    }
  }

  function reRenderFeed() {
    var feedList = $('feedList');
    if (!feedList) return;
    feedList.innerHTML = '';
    for (var i = 0; i < state.feedArticles.length; i++) {
      if (shouldShowArticle(state.feedArticles[i])) {
        renderArticleCard(feedList, state.feedArticles[i], false);
      }
    }
  }

  // ─── Draft Status Tracking for Live Feed ─────────────────────────────

  function loadDraftStatuses() {
    var urls = [];
    for (var i = 0; i < state.feedArticles.length; i++) {
      var url = state.feedArticles[i].url;
      if (url && !draftStatusCache[url]) urls.push(url);
    }
    if (urls.length === 0) return;

    fetchApi('/api/drafts/check-urls', { method: 'POST', body: { urls: urls } })
      .then(function (data) {
        if (data.drafts) {
          var keys = Object.keys(data.drafts);
          for (var i = 0; i < keys.length; i++) draftStatusCache[keys[i]] = data.drafts[keys[i]];
          updateAllCardStatuses();
        }
      })
      .catch(function () { /* silent */ });
  }

  function updateAllCardStatuses() {
    var cards = document.querySelectorAll('.article-card[data-article-url]');
    for (var i = 0; i < cards.length; i++) {
      var url = cards[i].getAttribute('data-article-url');
      if (url) updateCardStatusBadge(cards[i], url);
    }
  }

  function updateCardStatusBadge(card, url) {
    // Remove old small badge if present (we're using the button now)
    var existing = card.querySelector('.draft-status-badge');
    if (existing) existing.remove();

    var status = draftStatusCache[url] || null;
    var pending = pendingAddUrls[url] || false;
    if (!status && !pending) return;

    // ─── Replace the Select button with a permanent status label ───
    var selectBtn = card.querySelector('.article-select-btn, .btn-selected, .btn-added, .btn-published, .btn-status-fetching, .btn-status-rewriting, .btn-status-ready, .btn-status-failed');
    if (!selectBtn) return;

    selectBtn.disabled = true;
    selectBtn.style.cursor = 'default';
    selectBtn.removeAttribute('onclick');

    if (pending) {
      selectBtn.className = 'btn-status-fetching';
      selectBtn.textContent = 'Adding...';
    } else if (status.status === 'published' || status.wp_post_url) {
      selectBtn.className = 'btn-published';
      selectBtn.innerHTML = '&#10003; Published';
    } else if (status.status === 'ready') {
      selectBtn.className = 'btn-status-ready';
      selectBtn.innerHTML = '&#10003; Ready';
    } else if (status.status === 'rewriting') {
      selectBtn.className = 'btn-status-rewriting';
      selectBtn.textContent = 'Rewriting...';
    } else if (status.status === 'fetching') {
      selectBtn.className = 'btn-status-fetching';
      selectBtn.textContent = 'Extracting...';
    } else if (status.status === 'failed') {
      selectBtn.className = 'btn-status-failed';
      selectBtn.innerHTML = '&#10007; Failed';
    } else {
      // Default: draft or any other status = "In Drafts"
      selectBtn.className = 'btn-added';
      selectBtn.innerHTML = '&#10003; In Drafts';
    }

    // ─── Show draft ID on the button for tracking ───
    if (status && status.draft_id) {
      selectBtn.title = 'Draft #' + status.draft_id + ' — ' + (status.status || 'draft');
    }

    // ─── Card-level visual treatment ───
    card.classList.remove('card-in-drafts', 'card-published', 'card-failed');
    if (status) {
      if (status.status === 'published' || status.wp_post_url) {
        card.classList.add('card-published');
      } else if (status.status === 'failed') {
        card.classList.add('card-failed');
      } else {
        card.classList.add('card-in-drafts');
      }
    } else if (pending) {
      card.classList.add('card-in-drafts');
    }
  }

  function renderArticleCard(container, article, prepend) {
    var artKey = article.url || article.firehose_event_id || article.id || '';
    var isSelected = !!selectedArticles[artKey];

    var card = document.createElement('div');
    card.className = 'article-card' + (isSelected ? ' feed-card-selected' : '');
    card.setAttribute('data-article-key', artKey);
    card.setAttribute('data-article-url', article.url || '');

    var tierClass = 'badge-tier' + (article.authority_tier || 3);
    var tierLabel = 'T' + (article.authority_tier || 3);

    // Build category badges
    var categoryHtml = '';
    if (article.page_category) {
      var cats = Array.isArray(article.page_category) ? article.page_category : [article.page_category];
      for (var c = 0; c < cats.length; c++) {
        categoryHtml += '<span class="domain-badge">' + escapeHtml(cats[c]) + '</span>';
      }
    }

    // Language badge
    var langHtml = '';
    if (article.language) {
      langHtml = '<span class="domain-badge">' + escapeHtml(article.language.toUpperCase()) + '</span>';
    }

    // Rule tag badge
    var ruleTagHtml = '';
    if (article.query_id) {
      ruleTagHtml = '<span class="badge badge-detected">' + escapeHtml(article.query_id) + '</span>';
    }

    // Content preview — handle JSON content_markdown ({"chunks":...})
    var previewHtml = '';
    var fullContentHtml = '';
    if (article.content_markdown) {
      var rawContent = article.content_markdown;

      // Detect JSON content_markdown and extract text from chunks
      if (typeof rawContent === 'string' && (rawContent.charAt(0) === '{' || rawContent.charAt(0) === '[')) {
        try {
          var parsed = JSON.parse(rawContent);
          var parts = [];

          // Helper: recursively extract text from any structure
          function extractTexts(obj) {
            if (!obj) return;
            if (typeof obj === 'string') { parts.push(obj); return; }
            if (Array.isArray(obj)) {
              for (var ai = 0; ai < obj.length; ai++) extractTexts(obj[ai]);
              return;
            }
            if (typeof obj === 'object') {
              // Prioritize known text fields
              if (obj.text) parts.push(obj.text);
              else if (obj.content) parts.push(typeof obj.content === 'string' ? obj.content : '');
              else if (obj.value) parts.push(typeof obj.value === 'string' ? obj.value : '');
              // Recurse into chunks array
              if (obj.chunks && Array.isArray(obj.chunks)) {
                for (var ci = 0; ci < obj.chunks.length; ci++) {
                  extractTexts(obj.chunks[ci]);
                }
              }
              // Recurse into paragraphs, blocks, sections
              var arrayKeys = ['paragraphs', 'blocks', 'sections', 'items', 'children'];
              for (var ki = 0; ki < arrayKeys.length; ki++) {
                if (obj[arrayKeys[ki]] && Array.isArray(obj[arrayKeys[ki]])) {
                  extractTexts(obj[arrayKeys[ki]]);
                }
              }
            }
          }

          extractTexts(parsed);
          if (parts.length > 0) {
            rawContent = parts.join(' ').replace(/\s+/g, ' ').trim();
          } else {
            // Could not extract any text — show nothing rather than raw JSON
            rawContent = '';
          }
        } catch (e) {
          // Not valid JSON — if it starts with { but is truncated, hide it
          if (rawContent.indexOf('"chunks"') !== -1 || rawContent.indexOf('"text"') !== -1) {
            rawContent = ''; // Truncated JSON, don't show garbage
          }
          // Otherwise use as-is (might be markdown starting with a heading)
        }
      }

      if (rawContent) {
        var stripped = stripMarkdown(rawContent);
        var previewText = truncate(stripped, 200);
        previewHtml = '<div class="article-preview">' + escapeHtml(previewText) + '</div>';
        if (stripped.length > 200) {
          fullContentHtml = '<div class="article-full">' + escapeHtml(stripped) + '</div>';
        }
      }
    }

    // Determine button state: check draft status cache FIRST
    var knownStatus = article.url ? draftStatusCache[article.url] : null;
    var isPending = article.url ? pendingAddUrls[article.url] : false;
    var selectBtnClass, selectBtnText;

    if (isPending) {
      selectBtnClass = 'btn-status-fetching';
      selectBtnText = 'Adding...';
    } else if (knownStatus) {
      if (knownStatus.status === 'published' || knownStatus.wp_post_url) {
        selectBtnClass = 'btn-published';
        selectBtnText = '&#10003; Published';
      } else if (knownStatus.status === 'ready') {
        selectBtnClass = 'btn-status-ready';
        selectBtnText = '&#10003; Ready';
      } else if (knownStatus.status === 'rewriting') {
        selectBtnClass = 'btn-status-rewriting';
        selectBtnText = 'Rewriting...';
      } else if (knownStatus.status === 'fetching') {
        selectBtnClass = 'btn-status-fetching';
        selectBtnText = 'Extracting...';
      } else if (knownStatus.status === 'failed') {
        selectBtnClass = 'btn-status-failed';
        selectBtnText = '&#10007; Failed';
      } else {
        selectBtnClass = 'btn-added';
        selectBtnText = '&#10003; In Drafts';
      }
    } else if (isSelected) {
      selectBtnClass = 'btn-selected';
      selectBtnText = '&#10003; Selected';
    } else {
      selectBtnClass = 'article-select-btn';
      selectBtnText = 'Select &#9654;';
    }

    card.innerHTML =
      '<div class="article-card-top">' +
        '<div class="article-card-content">' +
          '<div class="article-title">' +
            '<a href="' + escapeHtml(article.url || '#') + '" target="_blank" rel="noopener" data-click="stopOnly">' +
              escapeHtml(truncate(article.title || article.url || 'Untitled', 120)) +
            '</a>' +
          '</div>' +
          '<div class="article-meta">' +
            '<span class="domain-badge">' + escapeHtml(article.domain || '--') + '</span>' +
            '<span class="badge ' + tierClass + '">' + tierLabel + '</span>' +
            langHtml +
            categoryHtml +
            ruleTagHtml +
            (article.trends_matched ? '<span class="badge badge-matched">Trend</span>' : '') +
            '<span>' + formatTime(article.publish_time || article.received_at) + '</span>' +
          '</div>' +
        '</div>' +
        '<button class="' + selectBtnClass + '">' + selectBtnText + '</button>' +
      '</div>' +
      previewHtml +
      fullContentHtml;

    // Store article data on card for selectAll
    card._articleData = article;

    // Click card or button to toggle selection
    var selectBtn = card.querySelector('.article-select-btn, .btn-selected, .btn-added, .btn-published, .btn-status-fetching, .btn-status-rewriting, .btn-status-ready, .btn-status-failed');
    if (selectBtn && !knownStatus && !isPending) {
      selectBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        toggleSelectArticle(artKey, article, card);
      });
    }
    card.addEventListener('click', function (e) {
      // Don't toggle if user clicked a link or expand button
      if (e.target.tagName === 'A' || e.target.classList.contains('expand-btn')) return;
      // Don't toggle if article is already in pipeline
      var artUrl = article && article.url;
      if (artUrl && (draftStatusCache[artUrl] || pendingAddUrls[artUrl])) return;
      toggleSelectArticle(artKey, article, card);
    });

    // Add expand button if there is full content
    if (fullContentHtml) {
      var expandBtn = document.createElement('button');
      expandBtn.className = 'expand-btn';
      expandBtn.textContent = 'Show more';
      expandBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var fullDiv = card.querySelector('.article-full');
        if (fullDiv) {
          var isOpen = fullDiv.classList.contains('open');
          fullDiv.classList.toggle('open');
          expandBtn.textContent = isOpen ? 'Show more' : 'Show less';
        }
      });
      card.appendChild(expandBtn);
    }

    // Apply status treatment if article is already in pipeline
    if (article.url) {
      updateCardStatusBadge(card, article.url);
      // Also set disabled on button if pre-rendered as status
      if (knownStatus || isPending) {
        if (selectBtn) selectBtn.disabled = true;
      }
    }

    if (prepend) {
      container.insertBefore(card, container.firstChild);
    } else {
      container.appendChild(card);
    }
  }

  // ─── Multi-Select for Live Feed ──────────────────────────────────────────

  function toggleSelectArticle(key, article, card) {
    // Skip articles already in drafts or pending
    var artUrl = article && article.url;
    if (artUrl && (draftStatusCache[artUrl] || pendingAddUrls[artUrl])) return;

    if (selectedArticles[key]) {
      delete selectedArticles[key];
      selectedCount--;
      if (card) {
        card.classList.remove('feed-card-selected');
        var btn = card.querySelector('.btn-selected, .article-select-btn');
        if (btn) { btn.className = 'article-select-btn'; btn.innerHTML = 'Select &#9654;'; }
      }
    } else {
      selectedArticles[key] = article;
      selectedCount++;
      if (card) {
        card.classList.add('feed-card-selected');
        var btn2 = card.querySelector('.article-select-btn, .btn-selected');
        if (btn2) { btn2.className = 'btn-selected'; btn2.innerHTML = '&#10003; Selected'; }
      }
    }
    updateBulkActionBar();
  }

  function clearSelection() {
    selectedArticles = {};
    selectedCount = 0;
    var cards = document.querySelectorAll('.feed-card-selected');
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.remove('feed-card-selected');
      var btn = cards[i].querySelector('.btn-selected');
      if (btn) { btn.className = 'article-select-btn'; btn.innerHTML = 'Select &#9654;'; }
    }
    updateBulkActionBar();
  }

  function selectAllVisible() {
    var feedList = $('feedList');
    if (!feedList) return;
    var cards = feedList.querySelectorAll('.article-card');
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      var key = card.getAttribute('data-article-key');
      var article = card._articleData;
      if (key && article && !selectedArticles[key]) {
        // Skip already-added articles
        var artUrl = article.url;
        if (artUrl && (draftStatusCache[artUrl] || pendingAddUrls[artUrl])) continue;
        selectedArticles[key] = article;
        selectedCount++;
        card.classList.add('feed-card-selected');
        var btn = card.querySelector('.article-select-btn');
        if (btn) { btn.className = 'btn-selected'; btn.innerHTML = '&#10003; Selected'; }
      }
    }
    updateBulkActionBar();
  }

  function updateBulkActionBar() {
    var bar = $('bulkActionBar');
    var countEl = $('bulkCount');
    if (bar) {
      if (selectedCount > 0) {
        bar.style.display = 'flex';
        var addedCount = Object.keys(draftStatusCache).length;
        var label = selectedCount + ' selected';
        if (addedCount > 0) label += ' | ' + addedCount + ' already in drafts';
        if (countEl) countEl.textContent = label;
      } else {
        bar.style.display = 'none';
      }
    }
    if (typeof updateBatchActions === 'function') updateBatchActions();
  }

  function bulkFetchAndAddToDrafts() {
    var keys = Object.keys(selectedArticles);
    if (keys.length === 0) { showToast('No articles selected', 'warning'); return; }

    var btn = $('bulkFetchBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Fetching ' + keys.length + ' articles...'; btn.style.opacity = '0.7'; }

    var articles = [];
    for (var i = 0; i < keys.length; i++) {
      var a = selectedArticles[keys[i]];
      // Mark pending immediately for optimistic UI
      if (a.url) {
        pendingAddUrls[a.url] = true;
        var pendingCard = document.querySelector('.article-card[data-article-url="' + CSS.escape(a.url) + '"]');
        if (pendingCard) updateCardStatusBadge(pendingCard, a.url);
      }
      articles.push({
        article_id: a.id || null,
        url: a.url || '',
        domain: a.domain || '',
        title: a.title || 'Untitled',
        content_markdown: a.content_markdown || '',
        language: a.language || null,
        page_category: Array.isArray(a.page_category) ? a.page_category.join(', ') : (a.page_category || ''),
        publish_time: a.publish_time || null,
      });
    }

    fetchApi('/api/drafts/bulk-create', { method: 'POST', body: { articles: articles } })
      .then(function (data) {
        if (data.success) {
          // Update cache from urlMap returned by API
          if (data.urlMap) {
            var mapKeys = Object.keys(data.urlMap);
            for (var j = 0; j < mapKeys.length; j++) {
              // If not already in cache, mark as fetching (newly created)
              // If already in cache (duplicate), keep existing status
              if (!draftStatusCache[mapKeys[j]]) {
                draftStatusCache[mapKeys[j]] = { draft_id: data.urlMap[mapKeys[j]], status: 'fetching' };
              }
              delete pendingAddUrls[mapKeys[j]];
            }
          }
          // Clear pending for any articles not in urlMap; force status check if needed
          var needsRefresh = false;
          for (var k = 0; k < articles.length; k++) {
            if (articles[k].url) {
              delete pendingAddUrls[articles[k].url];
              if (!draftStatusCache[articles[k].url]) needsRefresh = true;
            }
          }
          if (needsRefresh) loadDraftStatuses();
          updateAllCardStatuses();
          var msg = '';
          if (data.created > 0) {
            msg = data.created + ' article(s) added to drafts!';
            if (data.skipped > 0) msg += ' (' + data.skipped + ' already in pipeline)';
          } else if (data.skipped > 0) {
            msg = 'All ' + data.skipped + ' article(s) already in your pipeline — no duplicates added.';
          } else {
            msg = 'No articles were added.';
          }
          showToast(msg, data.created > 0 ? 'success' : 'warning');
          clearSelection();
          showGoToPublishedPrompt(data.created);
        } else {
          // Clear pending on failure
          for (var m = 0; m < articles.length; m++) {
            if (articles[m].url) delete pendingAddUrls[articles[m].url];
          }
          updateAllCardStatuses();
          showToast('Failed: ' + (data.error || 'Unknown'), 'error');
        }
      })
      .catch(function (err) {
        for (var n = 0; n < articles.length; n++) {
          if (articles[n].url) delete pendingAddUrls[articles[n].url];
        }
        updateAllCardStatuses();
        showToast('Failed: ' + err.message, 'error');
      })
      .finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = 'Fetch & Add to Drafts'; btn.style.opacity = '1'; }
      });
  }

  function showGoToPublishedPrompt(count) {
    var toast = document.createElement('div');
    toast.className = 'bulk-success-toast';
    toast.innerHTML =
      '<div>' +
        '<div style="color:#10b981;font-weight:bold;font-size:14px;">' + count + ' articles added!</div>' +
        '<div style="color:#888;font-size:12px;margin-top:4px;">Content extraction started in background.</div>' +
      '</div>' +
      '<button class="btn btn-sm" style="background:#10b981;color:#fff;border:none;white-space:nowrap;" data-click="goToPublishedAndDismiss">Go to Published</button>' +
      '<button style="background:none;border:none;color:#666;cursor:pointer;font-size:18px;padding:4px;" data-click="dismissParent">&times;</button>';
    document.body.appendChild(toast);
    setTimeout(function () { if (toast.parentElement) toast.remove(); }, 10000);
  }

  window.__goToPublished = function () { navigateTo('published'); };

  // ─── Firehose Rules Page ───────────────────────────────────────────────

  function loadRules() {
    loadFirehoseStatus();
    loadFirehoseRules();
    initRuleTemplates();
    initRuleSaveConnect();
    initRuleAdd();
    loadFirehoseStatsWidget();
    loadFirehoseConnSettings();
    loadLangFilter();
    loadDomainFilters();

    // Refresh button
    var refreshBtn = $('rulesRefreshBtn');
    if (refreshBtn) {
      refreshBtn.onclick = function () {
        forceApiRefresh();
        loadFirehoseStatus();
        loadFirehoseRules();
        loadFirehoseStatsWidget();
        showToast('Refreshed', 'info');
      };
    }

    // Firehose connection settings save button (new card)
    var fhConnSaveBtn = document.querySelector('#page-rules .card:nth-of-type(4) button');
    // Use explicit id approach instead
    var fhSaveAll = document.getElementById('fh-conn-save');
    if (fhSaveAll) fhSaveAll.onclick = saveFirehoseConnSettings;

    // Lang filter save
    var langSaveBtn = $('fh-lang-save');
    if (langSaveBtn) langSaveBtn.onclick = saveLangFilter;

    // Domain filters save
    var domainSaveBtn = $('fh-domain-save');
    if (domainSaveBtn) domainSaveBtn.onclick = saveDomainFilters;
  }

  function loadFirehoseStatus() {
    fetchApi('/api/firehose/status')
      .then(function (data) {
        var dot = $('firehoseConnDot');
        var text = $('firehoseConnText');
        var preview = $('firehoseTokenPreview');

        if (dot) {
          dot.className = 'status-dot';
          if (data.connected) {
            dot.classList.add('connected');
          } else if (data.reconnecting) {
            dot.classList.add('reconnecting');
          }
          // else stays gray (stopped / no token)
        }

        if (text) {
          if (data.connected) {
            text.textContent = 'Connected';
            text.style.color = 'var(--green)';
          } else if (data.reconnecting) {
            text.textContent = 'Reconnecting...';
            text.style.color = 'var(--yellow)';
          } else if (data.tokenConfigured) {
            text.textContent = 'Disconnected';
            text.style.color = 'var(--red)';
          } else {
            text.textContent = 'No token configured';
            text.style.color = 'var(--text-muted)';
          }
        }

        if (preview) {
          if (data.tokenPreview) {
            preview.textContent = 'Token: ...' + escapeHtml(data.tokenPreview);
          } else {
            preview.textContent = '';
          }
        }
      })
      .catch(function (err) {
        var text = $('firehoseConnText');
        if (text) {
          text.textContent = 'Error loading status';
          text.style.color = 'var(--red)';
        }
      });
  }

  function loadFirehoseRules() {
    var container = $('rulesList');
    if (!container) return;

    container.innerHTML = '<p class="placeholder-text">Loading...</p>';

    fetchApi('/api/firehose/rules')
      .then(function (data) {
        var rules = data.rules || data.data || data || [];
        if (!Array.isArray(rules)) rules = [];

        if (rules.length === 0) {
          container.innerHTML = '<p class="placeholder-text">No rules configured. Add one below.</p>';
          return;
        }

        var html = '<table class="rules-table"><thead><tr>' +
          '<th>ID</th><th>Tag</th><th>Lucene Query</th><th>Quality</th><th>Actions</th>' +
          '</tr></thead><tbody>';

        for (var i = 0; i < rules.length; i++) {
          var r = rules[i];
          html += '<tr id="rule-row-' + escapeHtml(String(r.id)) + '">' +
            '<td>' + escapeHtml(String(r.id || '--')) + '</td>' +
            '<td>' + escapeHtml(r.tag || '--') + '</td>' +
            '<td class="rule-query">' + escapeHtml(r.value || '--') + '</td>' +
            '<td>' + (r.quality !== false ? 'Yes' : 'No') + '</td>' +
            '<td class="rule-actions">' +
              '<button class="btn btn-sm btn-secondary" data-click="editRule" data-id="' + esc(String(r.id)) + '" data-tag="' + esc(r.tag || '') + '" data-value="' + esc(r.value || '') + '" data-quality="' + (r.quality !== false ? '1' : '0') + '">Edit</button>' +
              '<button class="btn btn-sm btn-danger" data-click="deleteRule" data-id="' + esc(String(r.id)) + '">Delete</button>' +
            '</td>' +
          '</tr>';
        }

        html += '</tbody></table>';
        container.innerHTML = html;
      })
      .catch(function (err) {
        container.innerHTML = '<p class="placeholder-text">Failed to load rules: ' + escapeHtml(err.message) + '</p>';
      });
  }

  window.__editRule = function (id, tag, value, quality) {
    var row = $('rule-row-' + id);
    if (!row) return;

    row.innerHTML =
      '<td>' + escapeHtml(String(id)) + '</td>' +
      '<td><input type="text" id="edit-tag-' + id + '" value="' + escapeHtml(tag) + '" style="width:100%"></td>' +
      '<td><textarea id="edit-value-' + id + '" rows="3" style="width:100%;font-family:monospace;font-size:11.5px;resize:vertical">' + escapeHtml(value) + '</textarea></td>' +
      '<td><label style="display:flex;align-items:center;gap:4px"><input type="checkbox" id="edit-quality-' + id + '"' + (quality ? ' checked' : '') + '> Yes</label></td>' +
      '<td class="rule-actions">' +
        '<button class="btn btn-sm btn-success" id="edit-save-' + id + '">Save</button>' +
        '<button class="btn btn-sm btn-secondary" id="edit-cancel-' + id + '">Cancel</button>' +
      '</td>';

    $('edit-save-' + id).onclick = function () {
      var newTag = $('edit-tag-' + id).value;
      var newValue = $('edit-value-' + id).value;
      var newQuality = $('edit-quality-' + id).checked;

      fetchApi('/api/firehose/rules/' + id, {
        method: 'PUT',
        body: { tag: newTag, value: newValue, quality: newQuality }
      })
        .then(function () {
          showToast('Rule updated', 'success');
          loadFirehoseRules();
        })
        .catch(function (err) {
          showToast('Failed to update rule: ' + err.message, 'error');
        });
    };

    $('edit-cancel-' + id).onclick = function () {
      loadFirehoseRules();
    };
  };

  window.__deleteRule = function (id) {
    if (!confirm('Delete rule #' + id + '? This cannot be undone.')) return;

    fetchApi('/api/firehose/rules/' + id, { method: 'DELETE' })
      .then(function () {
        showToast('Rule deleted', 'success');
        loadFirehoseRules();
      })
      .catch(function (err) {
        showToast('Failed to delete rule: ' + err.message, 'error');
      });
  };

  function initRuleTemplates() {
    var templateSelect = $('ruleTemplate');
    if (!templateSelect) return;

    templateSelect.onchange = function () {
      var key = templateSelect.value;
      if (!key || !RULE_TEMPLATES[key]) return;

      var tagInput = $('ruleTagInput');
      var queryInput = $('ruleQueryInput');

      if (tagInput) tagInput.value = RULE_TEMPLATES[key].tag;
      if (queryInput) queryInput.value = RULE_TEMPLATES[key].value;
    };
  }

  function initRuleSaveConnect() {
    var saveBtn = $('firehoseSaveBtn');
    var tokenInput = $('firehoseTokenInput');
    var keyHint = $('firehoseKeyHint');
    if (!saveBtn || !tokenInput) return;

    // Live hint based on input prefix
    tokenInput.addEventListener('input', function () {
      if (!keyHint) return;
      var val = tokenInput.value.trim();
      if (val.indexOf('fhm_') === 0) {
        keyHint.textContent = 'Management Key detected — will auto-discover your tap token.';
        keyHint.style.color = 'var(--accent)';
      } else if (val.indexOf('fh_') === 0) {
        keyHint.textContent = 'Tap Token detected — will save and connect directly.';
        keyHint.style.color = 'var(--green)';
      } else if (val.length > 0) {
        keyHint.textContent = 'Unrecognized prefix. Expected fhm_ (management) or fh_ (tap token).';
        keyHint.style.color = 'var(--yellow)';
      } else {
        keyHint.textContent = 'Paste your Management Key (fhm_...) and we\'ll auto-discover your tap token. Or paste a Tap Token (fh_...) directly.';
        keyHint.style.color = 'var(--text-muted)';
      }
    });

    saveBtn.onclick = function () {
      var token = tokenInput.value.trim();
      if (!token) {
        showToast('Please enter a key', 'warning');
        return;
      }

      saveBtn.disabled = true;
      var isMgmt = token.indexOf('fhm_') === 0;
      saveBtn.textContent = isMgmt ? 'Discovering taps...' : 'Saving...';

      fetchApi('/api/firehose/connect', {
        method: 'POST',
        body: { token: token }
      })
        .then(function (data) {
          var msg = data.message || 'Connected!';
          if (data.tokenPreview) msg += ' (Token: ' + data.tokenPreview + ')';
          showToast(msg, 'success');
          tokenInput.value = '';
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save & Connect';
          if (keyHint) {
            keyHint.textContent = 'Paste your Management Key (fhm_...) and we\'ll auto-discover your tap token. Or paste a Tap Token (fh_...) directly.';
            keyHint.style.color = 'var(--text-muted)';
          }
          // Reload status after a short delay
          setTimeout(function () {
            loadFirehoseStatus();
            loadFirehoseRules();
          }, 2000);
        })
        .catch(function (err) {
          showToast('Failed: ' + err.message, 'error');
          saveBtn.disabled = false;
          saveBtn.textContent = 'Save & Connect';
        });
    };
  }

  function initRuleAdd() {
    var addBtn = $('ruleAddBtn');
    if (!addBtn) return;

    addBtn.onclick = function () {
      var tagInput = $('ruleTagInput');
      var queryInput = $('ruleQueryInput');
      var qualityInput = $('ruleQualityInput');

      var tag = tagInput ? tagInput.value.trim() : '';
      var value = queryInput ? queryInput.value.trim() : '';
      var quality = qualityInput ? qualityInput.checked : true;

      if (!value) {
        showToast('Please enter a Lucene query', 'warning');
        return;
      }

      addBtn.disabled = true;
      addBtn.textContent = 'Adding...';

      fetchApi('/api/firehose/rules', {
        method: 'POST',
        body: { value: value, tag: tag, quality: quality }
      })
        .then(function () {
          showToast('Rule added', 'success');
          if (tagInput) tagInput.value = '';
          if (queryInput) queryInput.value = '';
          if (qualityInput) qualityInput.checked = true;
          var templateSelect = $('ruleTemplate');
          if (templateSelect) templateSelect.value = '';
          addBtn.disabled = false;
          addBtn.textContent = 'Add Rule';
          loadFirehoseRules();
        })
        .catch(function (err) {
          showToast('Failed to add rule: ' + err.message, 'error');
          addBtn.disabled = false;
          addBtn.textContent = 'Add Rule';
        });
    };
  }

  // ─── Trends Page ────────────────────────────────────────────────────────

  function loadTrends() {
    var realtimeList = $('trendsRealtime');
    var dailyList = $('trendsDaily');
    var pollBtn = $('trendsPollBtn');

    if (realtimeList) realtimeList.innerHTML = '<p class="placeholder-text">Loading...</p>';
    if (dailyList) dailyList.innerHTML = '<p class="placeholder-text">Loading...</p>';

    // Check if trends is disabled
    fetchApi('/api/status').then(function (data) {
      var notice = $('trendsDisabledNotice');
      if (data.trends && !data.trends.enabled) {
        if (notice) notice.style.display = '';
      } else {
        if (notice) notice.style.display = 'none';
      }
    }).catch(function () { /* silent */ });

    fetchApi('/api/trends')
      .then(function (data) {
        var realtime = [];
        var daily = [];

        if (data.data) {
          for (var i = 0; i < data.data.length; i++) {
            if (data.data[i].trend_type === 'realtime') {
              realtime.push(data.data[i]);
            } else {
              daily.push(data.data[i]);
            }
          }
        }

        renderTrendList(realtimeList, realtime);
        renderTrendList(dailyList, daily);
      })
      .catch(function (err) {
        if (realtimeList) realtimeList.innerHTML = '<p class="placeholder-text">Failed to load</p>';
        if (dailyList) dailyList.innerHTML = '<p class="placeholder-text">Failed to load</p>';
        showToast('Failed to load trends: ' + err.message, 'error');
      });

    // Poll Now button
    if (pollBtn) {
      pollBtn.onclick = function () {
        pollBtn.disabled = true;
        pollBtn.textContent = 'Polling...';
        fetchApi('/api/test/trends', { method: 'POST' })
          .then(function (data) {
            showToast('Trends poll complete', 'success');
            pollBtn.disabled = false;
            pollBtn.textContent = 'Poll Now';
            loadTrends();
          })
          .catch(function (err) {
            showToast('Trends poll failed: ' + err.message, 'error');
            pollBtn.disabled = false;
            pollBtn.textContent = 'Poll Now';
          });
      };
    }
  }

  function renderTrendList(container, trends) {
    if (!container) return;

    if (trends.length === 0) {
      container.innerHTML = '<p class="placeholder-text">No trends found</p>';
      return;
    }

    var html = '';
    for (var i = 0; i < trends.length; i++) {
      var t = trends[i];
      var statusClass = 'badge-' + (t.status || 'watching');
      html +=
        '<div class="trend-item">' +
          '<div>' +
            '<div class="trend-topic">' + escapeHtml(t.topic) + '</div>' +
            '<div class="trend-volume">' +
              (t.traffic_volume ? escapeHtml(t.traffic_volume) + ' searches' : '') +
              (t.source_url ? ' &middot; <a href="' + escapeHtml(t.source_url) + '" target="_blank" style="color:var(--accent)">source</a>' : '') +
            '</div>' +
          '</div>' +
          '<div>' +
            '<span class="badge ' + statusClass + '">' + escapeHtml(t.status || 'watching') + '</span>' +
          '</div>' +
        '</div>';
    }
    container.innerHTML = html;
  }

  // ─── Clusters Page ──────────────────────────────────────────────────────

  function loadClusters() {
    var container = $('clustersList');
    var pagination = $('clustersPagination');
    var statusFilter = $('clusterStatusFilter');
    var statsContainer = $('clusterStats');

    if (container) container.innerHTML = '<p class="placeholder-text">Loading...</p>';

    // Fetch cluster stats
    fetchApi('/api/clusters/stats')
      .then(function (stats) {
        if (statsContainer) {
          statsContainer.innerHTML =
            '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;margin-bottom:16px">' +
              '<div class="stat-card-mini"><div class="stat-value">' + (stats.totalClusters || 0) + '</div><div class="stat-label">Total Clusters</div></div>' +
              '<div class="stat-card-mini"><div class="stat-value">' + (stats.detected || 0) + '</div><div class="stat-label">Detected</div></div>' +
              '<div class="stat-card-mini"><div class="stat-value">' + (stats.published || 0) + '</div><div class="stat-label">Published</div></div>' +
              '<div class="stat-card-mini"><div class="stat-value">' + (stats.avgArticlesPerCluster || '--') + '</div><div class="stat-label">Avg Articles</div></div>' +
              '<div class="stat-card-mini"><div class="stat-value">' + (stats.bufferSize || 0) + '</div><div class="stat-label">Buffer Articles</div></div>' +
              '<div class="stat-card-mini"><div class="stat-value">' + (stats.uniqueDomains || 0) + '</div><div class="stat-label">Unique Domains</div></div>' +
            '</div>';
        }
      })
      .catch(function () { /* silent — stats are optional */ });

    var filterValue = statusFilter ? statusFilter.value : '';
    var url = '/api/clusters?page=' + state.clustersPage +
              (filterValue ? '&status=' + encodeURIComponent(filterValue) : '');

    fetchApi(url)
      .then(function (data) {
        renderClusters(container, data.data || []);
        renderPagination(pagination, data.total, data.page, data.perPage, function (page) {
          state.clustersPage = page;
          loadClusters();
        });
      })
      .catch(function (err) {
        if (container) container.innerHTML = '<p class="placeholder-text">Failed to load clusters</p>';
        showToast('Failed to load clusters: ' + err.message, 'error');
      });

    // Filter change
    if (statusFilter) {
      statusFilter.onchange = function () {
        state.clustersPage = 1;
        loadClusters();
      };
    }
  }

  function renderClusters(container, clusters) {
    if (!container) return;

    if (clusters.length === 0) {
      container.innerHTML =
        '<div class="empty-state">' +
          '<h3>No Clusters Yet</h3>' +
          '<p>Clusters are created automatically when 2+ articles from different sources cover the same topic within the buffer window.</p>' +
          '<div class="empty-state-tips">' +
            '<p><strong>How clustering works:</strong></p>' +
            '<ul>' +
              '<li>Articles arrive from the Firehose in real-time</li>' +
              '<li>Each article is fingerprinted (title + content + category)</li>' +
              '<li>The similarity engine compares new articles against recent ones using TF-IDF</li>' +
              '<li>When similarity exceeds the threshold, a cluster is formed</li>' +
              '<li>Clusters can be auto-published or manually reviewed here</li>' +
            '</ul>' +
            '<p><strong>Tips to get clusters:</strong></p>' +
            '<ul>' +
              '<li>Make sure the Firehose is connected and streaming articles</li>' +
              '<li>Use broad Firehose rules that capture articles from multiple domains</li>' +
              '<li>Lower the Similarity Threshold in Settings (try 0.15-0.20)</li>' +
              '<li>Increase the Buffer Window to give more time for matches</li>' +
              '<li>Breaking news stories cluster fastest (multiple outlets cover them)</li>' +
            '</ul>' +
          '</div>' +
        '</div>';
      return;
    }

    var html = '';
    for (var i = 0; i < clusters.length; i++) {
      var c = clusters[i];
      var statusClass = 'badge-' + (c.status || 'detected');
      var canPublish = c.status === 'detected' || c.status === 'failed';
      var canSkip = c.status !== 'published' && c.status !== 'skipped';

      html +=
        '<div class="cluster-card" data-cluster-id="' + c.id + '">' +
          '<div class="cluster-header" data-click="toggleCluster" data-cluster-id="' + c.id + '">' +
            '<span class="cluster-expand" id="expand-' + c.id + '">&#9654;</span>' +
            '<div class="cluster-info">' +
              '<div class="cluster-topic">' + escapeHtml(c.topic || 'Cluster #' + c.id) + '</div>' +
              '<div class="cluster-meta">' +
                '<span>' + (c.article_count || 0) + ' articles</span>' +
                '<span>Similarity: ' + (c.avg_similarity ? c.avg_similarity.toFixed(2) : '--') + '</span>' +
                (c.trends_boosted ? '<span class="badge badge-matched">Trend Boosted</span>' : '') +
                '<span>' + formatTime(c.detected_at) + '</span>' +
              '</div>' +
            '</div>' +
            '<div class="cluster-actions">' +
              '<span class="badge ' + statusClass + '">' + escapeHtml(c.status || 'detected') + '</span>' +
              (canPublish ? '<button class="btn btn-sm btn-success" data-click="publishCluster" data-cluster-id="' + c.id + '">Publish</button>' : '') +
              (canSkip ? '<button class="btn btn-sm btn-secondary" data-click="skipCluster" data-cluster-id="' + c.id + '">Skip</button>' : '') +
              ((c.status === 'queued' || c.status === 'published') ? '<button class="btn btn-sm" style="background:#6366f1;color:#fff;border:none;" data-click="goToPublished">&#128221; View Drafts</button>' : '') +
            '</div>' +
          '</div>' +
          '<div class="cluster-body" id="cluster-body-' + c.id + '">' +
            '<p class="placeholder-text">Loading articles...</p>' +
          '</div>' +
        '</div>';
    }
    container.innerHTML = html;
  }

  window.__toggleCluster = function (id) {
    var body = $('cluster-body-' + id);
    var expand = $('expand-' + id);
    if (!body) return;

    var isOpen = body.classList.contains('open');
    body.classList.toggle('open');
    if (expand) expand.classList.toggle('open');

    if (!isOpen && body.innerHTML.indexOf('Loading') !== -1) {
      fetchApi('/api/clusters/' + id)
        .then(function (data) {
          var articles = data.articles || [];
          if (articles.length === 0) {
            body.innerHTML = '<p class="placeholder-text">No articles in this cluster</p>';
            return;
          }

          var html = '<ul class="cluster-articles">';
          for (var i = 0; i < articles.length; i++) {
            var a = articles[i];
            var tierClass = 'badge-tier' + (a.authority_tier || 3);
            html += '<li>' +
              '<span class="badge ' + tierClass + '">T' + (a.authority_tier || 3) + '</span> ' +
              '<span class="domain-badge">' + escapeHtml(a.domain || '--') + '</span> ' +
              '<a href="' + escapeHtml(a.url || '#') + '" target="_blank" rel="noopener" style="color:var(--accent)">' +
                escapeHtml(truncate(a.title || a.url || 'Untitled', 100)) +
              '</a> ' +
              '<span style="color:var(--text-muted)">' + formatTime(a.received_at) + '</span>' +
            '</li>';
          }
          html += '</ul>';
          body.innerHTML = html;
        })
        .catch(function () {
          body.innerHTML = '<p class="placeholder-text">Failed to load articles</p>';
        });
    }
  };

  window.__publishCluster = function (id) {
    if (!confirm('Publish cluster #' + id + '?')) return;

    fetchApi('/api/clusters/' + id + '/publish', { method: 'POST' })
      .then(function (data) {
        if (data.success) {
          showToast('Cluster queued — ' + (data.draftsCreated || data.totalDrafts || 0) + ' drafts created. View in Published page.', 'success');
          loadClusters();
          setTimeout(function () { navigateTo('published'); }, 2000);
        }
      })
      .catch(function (err) {
        showToast('Failed to publish: ' + err.message, 'error');
      });
  };

  window.__skipCluster = function (id) {
    var reason = prompt('Reason for skipping (optional):') || 'Manually skipped';

    fetchApi('/api/clusters/' + id + '/skip', {
      method: 'POST',
      body: { reason: reason },
    })
      .then(function () {
        showToast('Cluster #' + id + ' skipped', 'info');
        loadClusters();
      })
      .catch(function (err) {
        showToast('Failed to skip: ' + err.message, 'error');
      });
  };

  // ─── Ready to Publish Page ─────────────────────────────────────────────

  var readyCurrentPage = 1;
  var _loadReadyInFlight = false;
  var failedCurrentPage = 1;
  var _loadFailedInFlight = false;

  function loadReady(page) {
    if (_loadReadyInFlight) return;
    _loadReadyInFlight = true;

    if (typeof page === 'number' && page > 0) readyCurrentPage = page;

    var container = $('readyList');
    var pagination = $('readyPagination');

    var refreshBtn = $('readyRefreshBtn');
    if (refreshBtn && !refreshBtn.__wired) {
      refreshBtn.__wired = true;
      refreshBtn.addEventListener('click', function () { loadReady(); });
    }
    var publishAllBtn = $('publishAllReadyBtn');
    if (publishAllBtn && !publishAllBtn.__wired) {
      publishAllBtn.__wired = true;
      publishAllBtn.addEventListener('click', function () { window.__publishAllReady(); });
    }

    if (container) container.innerHTML = '<p class="placeholder-text">Loading...</p>';
    if (pagination) pagination.innerHTML = '';

    fetchApi('/api/drafts/ready?page=' + readyCurrentPage)
      .then(function (data) {
        renderReadyTable(container, data.data || []);
        updateReadyBadge(data.total || 0);

        if (pagination && typeof renderPagination === 'function') {
          var totalPages = Math.ceil((data.total || 0) / (data.perPage || 20));
          renderPaginationById('readyPagination', data.page || 1, totalPages, loadReady);
        }
      })
      .catch(function (err) {
        if (container) container.innerHTML = '<p class="placeholder-text">Failed to load: ' + escapeHtml(err.message) + '</p>';
      })
      .finally(function () {
        _loadReadyInFlight = false;
      });
  }

  function renderReadyTable(container, rows) {
    if (!container) return;

    if (!rows || rows.length === 0) {
      container.innerHTML =
        '<div class="feed-empty">' +
          '<div class="feed-empty-icon">&#9889;</div>' +
          '<div class="feed-empty-title">No articles ready to publish yet</div>' +
          '<div class="feed-empty-desc">Articles appear here after AI rewrite completes.</div>' +
        '</div>';
      return;
    }

    var html = '<table class="data-table">' +
      '<thead>' +
        '<tr>' +
          '<th>Title</th>' +
          '<th>Source Domain</th>' +
          '<th>Words</th>' +
          '<th>AI Model</th>' +
          '<th>Rewritten At</th>' +
          '<th>Mode</th>' +
          '<th>Actions</th>' +
        '</tr>' +
      '</thead>' +
      '<tbody>';

    for (var i = 0; i < rows.length; i++) {
      var d = rows[i];
      var title = d.rewritten_title || d.topic || d.source_domain || 'Untitled';
      var words = d.rewritten_word_count ? (d.rewritten_word_count + ' words') : '&mdash;';
      var model = d.ai_model_used || '&mdash;';
      var rewrittenAt = d.updated_at ? new Date(d.updated_at).toLocaleString() : '&mdash;';
      var mode = d.mode === 'manual_import'
        ? '<span class="badge badge-manual">Manual</span>'
        : '<span class="badge badge-auto">Auto</span>';
      var trendsBadge = d.trends_boosted ? ' <span class="badge badge-trend">&#128293; Trending</span>' : '';

      html += '<tr>' +
        '<td><strong>' + escapeHtml(String(title).substring(0, 80)) + '</strong>' + trendsBadge + '</td>' +
        '<td>' + escapeHtml(d.source_domain || '') + '</td>' +
        '<td>' + words + '</td>' +
        '<td>' + escapeHtml(model) + '</td>' +
        '<td>' + rewrittenAt + '</td>' +
        '<td>' + mode + '</td>' +
        '<td>' +
          '<button class="btn btn-sm btn-primary" data-click="publishReady" data-draft-id="' + d.id + '">Publish Now</button> ' +
          '<button class="btn btn-sm" data-click="openEditor" data-draft-id="' + d.id + '">Preview</button>' +
        '</td>' +
      '</tr>';
    }

    html += '</tbody></table>';
    container.innerHTML = html;
  }

  function updateReadyBadge(total) {
    var badge = $('ready-badge');
    if (!badge) return;
    if (total > 0) {
      badge.textContent = total;
      badge.style.display = 'inline';
    } else {
      badge.textContent = '';
      badge.style.display = 'none';
    }
  }

  var _publishInFlight = {};
  window.__publishReady = function (draftId) {
    if (_publishInFlight[draftId]) return;
    if (!confirm('Publish this article to WordPress now?')) return;
    _publishInFlight[draftId] = true;
    fetchApi('/api/drafts/' + draftId + '/publish', { method: 'POST' })
      .then(function (data) {
        delete _publishInFlight[draftId];
        if (data.success) {
          var msg = data.wasDeleted
            ? 'WP post was deleted — re-published as new post!'
            : 'Published successfully!';
          showToast(msg, 'success');
          loadReady();
        } else {
          showToast('Publish failed: ' + (data.error || 'Unknown error'), 'error');
        }
      })
      .catch(function (err) {
        delete _publishInFlight[draftId];
        showToast('Publish failed: ' + err.message, 'error');
      });
  };

  window.__publishAllReady = function () {
    if (!confirm('Publish ALL ready articles to WordPress now? This will ignore the hourly rate limit.')) return;
    fetchApi('/api/drafts/publish-all-ready', { method: 'POST' })
      .then(function (data) {
        if (data.success) {
          showToast('Publishing ' + (data.queued || 0) + ' articles in the background...', 'success');
          setTimeout(function () { loadReady(); }, 3000);
        } else {
          showToast('Failed: ' + (data.error || 'Unknown error'), 'error');
        }
      })
      .catch(function (err) {
        showToast('Failed: ' + err.message, 'error');
      });
  };

  // ─── Failed Drafts Page ────────────────────────────────────────────────

  function loadFailedDrafts(page) {
    if (_loadFailedInFlight) return;
    _loadFailedInFlight = true;

    if (typeof page === 'number' && page > 0) failedCurrentPage = page;

    var container = $('failedList');
    var pagination = $('failedPagination');

    var refreshBtn = $('failedRefreshBtn');
    if (refreshBtn && !refreshBtn.__wired) {
      refreshBtn.__wired = true;
      refreshBtn.addEventListener('click', function () { loadFailedDrafts(); });
    }
    var retryAllBtn = $('retryAllFailedBtn');
    if (retryAllBtn && !retryAllBtn.__wired) {
      retryAllBtn.__wired = true;
      retryAllBtn.addEventListener('click', function () {
        if (!confirm('Reset all failed drafts? Those with rewritten content go to Ready; others go back to Draft for rewrite.')) return;
        fetchApi('/api/drafts/retry-all-failed', { method: 'POST' })
          .then(function (data) {
            if (data.success) {
              showToast('Reset ' + data.count + ' drafts (' + data.toReady + ' to ready, ' + data.toDraft + ' to draft)', 'success');
              loadFailedDrafts();
              loadReady();
            } else {
              showToast('Bulk retry failed: ' + (data.error || 'Unknown'), 'error');
            }
          })
          .catch(function (err) { showToast('Bulk retry failed: ' + err.message, 'error'); });
      });
    }

    if (container) container.innerHTML = '<p class="placeholder-text">Loading...</p>';
    if (pagination) pagination.innerHTML = '';

    fetchApi('/api/drafts/failed?page=' + failedCurrentPage)
      .then(function (data) {
        renderFailedTable(container, data.data || []);
        updateFailedBadge(data.total || 0);
        if (pagination && typeof renderPagination === 'function') {
          renderPagination(pagination, data.total || 0, data.page || 1, data.perPage || 20, function (p) {
            loadFailedDrafts(p);
          });
        }
      })
      .catch(function (err) {
        if (container) container.innerHTML = '<p class="placeholder-text">Failed to load: ' + escapeHtml(err.message) + '</p>';
      })
      .finally(function () { _loadFailedInFlight = false; });
  }

  function renderFailedTable(container, rows) {
    if (!container) return;
    if (!rows || rows.length === 0) {
      container.innerHTML =
        '<div class="feed-empty">' +
          '<div class="feed-empty-icon">&#9888;</div>' +
          '<div class="feed-empty-title">No failed drafts</div>' +
          '<div class="feed-empty-desc">All caught up.</div>' +
        '</div>';
      return;
    }

    var html = '<table class="data-table">' +
      '<thead><tr>' +
        '<th>Title</th>' +
        '<th>Domain</th>' +
        '<th>Error</th>' +
        '<th>Retries</th>' +
        '<th>Failed At</th>' +
        '<th>Actions</th>' +
      '</tr></thead><tbody>';

    for (var i = 0; i < rows.length; i++) {
      var d = rows[i];
      var title = d.rewritten_title || d.topic || d.source_domain || 'Untitled';
      var errorMsg = d.error_message ? d.error_message.substring(0, 120) : 'Unknown error';
      var failedAt = d.updated_at ? new Date(d.updated_at).toLocaleString() : '&mdash;';
      var retryLabel = d.has_rewritten_html ? 'Retry Publish' : 'Retry Rewrite';

      html += '<tr>' +
        '<td><strong>' + escapeHtml(String(title).substring(0, 80)) + '</strong></td>' +
        '<td>' + escapeHtml(d.source_domain || '') + '</td>' +
        '<td style="color:var(--danger,#f87171);font-size:12px;">' + escapeHtml(errorMsg) + '</td>' +
        '<td>' + (d.retry_count || 0) + '</td>' +
        '<td>' + failedAt + '</td>' +
        '<td>' +
          '<button class="btn btn-sm btn-warning" data-click="retryFailedDraft" data-draft-id="' + d.id + '">' + retryLabel + '</button>' +
        '</td>' +
      '</tr>';
    }

    html += '</tbody></table>';
    container.innerHTML = html;
  }

  function updateFailedBadge(total) {
    var badge = $('failed-badge');
    if (!badge) return;
    if (total > 0) {
      badge.textContent = total;
      badge.style.display = 'inline';
    } else {
      badge.textContent = '';
      badge.style.display = 'none';
    }
  }

  window.__retryFailedDraft = function (draftId) {
    fetchApi('/api/drafts/' + draftId + '/retry', { method: 'POST' })
      .then(function (data) {
        if (data.success) {
          var msg = data.newStatus === 'ready' ? 'Draft reset to Ready — publish when ready' : 'Draft reset to Draft — rewrite will be triggered';
          showToast(msg, 'success');
          loadFailedDrafts();
          if (data.newStatus === 'ready') loadReady();
        } else {
          showToast('Retry failed: ' + (data.error || 'Unknown'), 'error');
        }
      })
      .catch(function (err) { showToast('Retry failed: ' + err.message, 'error'); });
  };

  // ─── Published Page (Drafts + Auto-Published) ──────────────────────────

  var publishedPollInterval = null;
  var _lastPublishedHash = null;
  var _publishedPage = 1;
  var _publishedPerPage = (function () {
    var stored = parseInt(localStorage.getItem('hdf_published_per_page'), 10);
    var allowed = [10, 25, 50, 100];
    return allowed.indexOf(stored) !== -1 ? stored : 50;
  })();

  function _publishedQs() {
    return '?page=' + _publishedPage + '&perPage=' + _publishedPerPage;
  }

  function loadPublished() {
    // Guard: never run two loadPublished() calls in parallel.
    // Without this, rapid nav clicks (or polling races) caused empty/partial
    // renders and ghost listeners.
    if (_loadPublishedInFlight) return;
    _loadPublishedInFlight = true;

    _selectedDraftIds = {};
    _selectedDraftCount = 0;
    _selectModeActive = false;
    // Force a full re-render on explicit loads — polling uses this hash to
    // skip re-renders when data hasn't changed.
    _lastPublishedHash = null;

    var container = $('publishedList');
    var pagination = $('publishedPagination');

    if (container) container.innerHTML = '<p class="placeholder-text">Loading...</p>';
    if (pagination) pagination.innerHTML = '';

    fetchApi('/api/drafts' + _publishedQs())
      .then(function (data) {
        var drafts = data.data || [];
        renderDraftsView(container, drafts);
        // Pagination footer
        var total = data.total || drafts.length;
        var totalPages = Math.max(1, Math.ceil(total / _publishedPerPage));
        renderPaginationById('publishedPagination', _publishedPage, totalPages, function (p) {
          _publishedPage = p;
          forceApiRefresh('/api/drafts');
          loadPublished();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        });
        startPublishedPolling();
      })
      .catch(function (err) {
        if (container) container.innerHTML = '<p class="placeholder-text">Failed to load</p>';
        showToast('Failed to load drafts: ' + err.message, 'error');
      })
      .finally(function () {
        _loadPublishedInFlight = false;
      });
  }

  function renderDraftsView(container, drafts) {
    if (!container) return;

    if (drafts.length === 0) {
      container.innerHTML =
        '<div class="feed-empty">' +
          '<div class="feed-empty-icon">&#128221;</div>' +
          '<div class="feed-empty-title">No articles in pipeline</div>' +
          '<div class="feed-empty-desc">Go to <a href="#feed">Live Feed</a> to select articles, or wait for auto-clusters from the Firehose.</div>' +
        '</div>';
      return;
    }

    // Separate cluster drafts from manual drafts and imported (manual_import) drafts.
    // Note: legacy "manual" tab = drafts without cluster_id AND not from manual_import.
    // The new "imported" tab is its own list with mode='manual_import'.
    var clusterMap = {};
    var manualDrafts = [];
    var importedDrafts = [];
    for (var i = 0; i < drafts.length; i++) {
      var d = drafts[i];
      if (d.cluster_id) {
        if (!clusterMap[d.cluster_id]) clusterMap[d.cluster_id] = { drafts: [], primary: null };
        clusterMap[d.cluster_id].drafts.push(d);
        if (d.cluster_role === 'primary') clusterMap[d.cluster_id].primary = d;
      } else if (d.mode === 'manual_import') {
        importedDrafts.push(d);
      } else {
        manualDrafts.push(d);
      }
    }
    var clusterIds = Object.keys(clusterMap).sort(function (a, b) { return Number(b) - Number(a); });

    // Count statuses
    var counts = { all: drafts.length, fetching: 0, draft: 0, rewriting: 0, ready: 0, published: 0, failed: 0 };
    for (var c = 0; c < drafts.length; c++) {
      var st = drafts[c].status;
      if (counts[st] !== undefined) counts[st]++;
    }

    // ─── Count stats for buttons and progress bar ────────────────
    var unextractedCount = counts.fetching + counts.failed;
    var extractedCount = counts.draft + counts.rewriting + counts.ready + counts.published;
    var totalExtractionTarget = counts.all;
    var extractionPercent = totalExtractionTarget > 0 ? Math.round((extractedCount / totalExtractionTarget) * 100) : 0;

    // Count clusters ready for rewrite (all sources extracted, not yet rewritten)
    var readyForRewriteCount = 0;
    for (var rci = 0; rci < clusterIds.length; rci++) {
      var rcGroup = clusterMap[clusterIds[rci]];
      var rcDrafts = rcGroup.drafts;
      var allExtracted = true;
      var hasRewrite = false;
      for (var rdi = 0; rdi < rcDrafts.length; rdi++) {
        if (rcDrafts[rdi].extraction_status !== 'success' && rcDrafts[rdi].extraction_status !== 'cached' && rcDrafts[rdi].extraction_status !== 'fallback') {
          allExtracted = false;
        }
        if (rcDrafts[rdi].cluster_role === 'primary' && rcDrafts[rdi].rewritten_html) {
          hasRewrite = true;
        }
      }
      if (allExtracted && !hasRewrite) readyForRewriteCount++;
    }

    var sizes = [10, 25, 50, 100];
    var perPageOptions = '';
    for (var psi = 0; psi < sizes.length; psi++) {
      perPageOptions += '<option value="' + sizes[psi] + '"' +
        (sizes[psi] === _publishedPerPage ? ' selected' : '') + '>' + sizes[psi] + '</option>';
    }

    var filterHTML =
      '<div class="published-toolbar">' +
        // ─── Row 1: Filter buttons ───────────────────────────────
        '<div class="status-filters">' +
          '<button class="filter-btn active" data-filter="all">All (' + counts.all + ')</button>' +
          '<button class="filter-btn" data-filter="cluster">&#128218; Clusters (' + clusterIds.length + ')</button>' +
          '<button class="filter-btn" data-filter="manual">&#128100; Manual (' + manualDrafts.length + ')</button>' +
          '<button class="filter-btn" data-filter="imported">&#128229; Imported (' + importedDrafts.length + ')</button>' +
          '<span class="filter-divider"></span>' +
          '<button class="filter-btn" data-filter="fetching">Fetching (' + counts.fetching + ')</button>' +
          '<button class="filter-btn" data-filter="draft">Extracted (' + counts.draft + ')</button>' +
          '<button class="filter-btn" data-filter="rewriting">Rewriting (' + counts.rewriting + ')</button>' +
          '<button class="filter-btn" data-filter="ready">Ready (' + counts.ready + ')</button>' +
          '<button class="filter-btn" data-filter="published">Published (' + counts.published + ')</button>' +
          (counts.failed > 0 ? '<button class="filter-btn" data-filter="failed">&#10060; Failed (' + counts.failed + ')</button>' : '') +
          '<span class="filter-divider"></span>' +
          '<label class="per-page-label">Show ' +
            '<select id="publishedPerPageSel" class="per-page-select">' + perPageOptions + '</select>' +
          ' per page</label>' +
        '</div>' +

        // ─── Row 2: Extraction Progress Bar ──────────────────────
        '<div class="extraction-progress-section">' +
          '<div class="extraction-progress-header">' +
            '<span class="extraction-progress-label">Extraction Progress</span>' +
            '<span class="extraction-progress-stats">' +
              '<span class="ep-stat ep-extracted">' + extractedCount + ' extracted</span>' +
              '<span class="ep-stat ep-fetching">' + counts.fetching + ' fetching</span>' +
              (counts.failed > 0 ? '<span class="ep-stat ep-failed">' + counts.failed + ' failed</span>' : '') +
              '<span class="ep-stat ep-total">' + counts.all + ' total</span>' +
            '</span>' +
          '</div>' +
          '<div class="extraction-progress-bar">' +
            '<div class="ep-bar-published" style="width:' + (totalExtractionTarget > 0 ? Math.round(counts.published / totalExtractionTarget * 100) : 0) + '%"></div>' +
            '<div class="ep-bar-ready" style="width:' + (totalExtractionTarget > 0 ? Math.round((counts.ready + counts.rewriting) / totalExtractionTarget * 100) : 0) + '%"></div>' +
            '<div class="ep-bar-extracted" style="width:' + (totalExtractionTarget > 0 ? Math.round(counts.draft / totalExtractionTarget * 100) : 0) + '%"></div>' +
            '<div class="ep-bar-fetching" style="width:' + (totalExtractionTarget > 0 ? Math.round(counts.fetching / totalExtractionTarget * 100) : 0) + '%"></div>' +
            '<div class="ep-bar-failed" style="width:' + (totalExtractionTarget > 0 ? Math.round(counts.failed / totalExtractionTarget * 100) : 0) + '%"></div>' +
          '</div>' +
          '<div class="extraction-progress-percent">' + extractionPercent + '% complete</div>' +
        '</div>' +

        // ─── Row 3: Action Buttons ───────────────────────────────
        '<div class="batch-actions-bar">' +
          '<button id="select-mode-btn" class="action-btn action-btn-select" data-click="toggleSelectMode">' +
            '&#9745; Select' +
          '</button>' +
          '<button class="action-btn action-btn-primary" id="batchExtractBtn">' +
            '<span class="action-btn-icon">&#9889;</span>' +
            '<span class="action-btn-text">Extract All</span>' +
            (unextractedCount > 0 ? '<span class="action-btn-badge">' + unextractedCount + '</span>' : '') +
          '</button>' +
          (counts.failed > 0 ?
            '<button class="action-btn action-btn-danger" id="batchRetryFailedBtn">' +
              '<span class="action-btn-icon">&#128260;</span>' +
              '<span class="action-btn-text">Retry Failed</span>' +
              '<span class="action-btn-badge action-btn-badge-red">' + counts.failed + '</span>' +
            '</button>' : '') +
          (counts.failed > 0 ?
            '<button class="action-btn action-btn-delete" data-click="batchDeleteFailed">' +
              '<span class="action-btn-icon">&#128465;</span>' +
              '<span class="action-btn-text">Delete Failed</span>' +
              '<span class="action-btn-badge action-btn-badge-red">' + counts.failed + '</span>' +
            '</button>' : '') +
          '<button class="action-btn action-btn-ai" id="batchRewriteBtn"' +
            (readyForRewriteCount === 0 ? ' disabled title="No clusters ready — extract articles first"' : '') + '>' +
            '<span class="action-btn-icon">&#129302;</span>' +
            '<span class="action-btn-text">Rewrite All Extracted</span>' +
            (readyForRewriteCount > 0 ? '<span class="action-btn-badge action-btn-badge-purple">' + readyForRewriteCount + '</span>' : '') +
          '</button>' +
          '<button class="action-btn action-btn-image" id="batchFetchImagesBtn">' +
            '<span class="action-btn-icon">&#128247;</span>' +
            '<span class="action-btn-text">Fetch Images</span>' +
          '</button>' +
          '<button type="button" class="action-btn btn-import-urls" id="btn-manual-import" data-click="openManualImportModal">' +
            '<span class="action-btn-icon">&#128229;</span>' +
            '<span class="action-btn-text">Import URLs</span>' +
          '</button>' +
        '</div>' +
      '</div>';

    // Render cluster groups
    var cardsHTML = '';
    for (var ci = 0; ci < clusterIds.length; ci++) {
      try {
        cardsHTML += renderClusterGroup(clusterIds[ci], clusterMap[clusterIds[ci]]);
      } catch (renderErr) {
        console.error('Failed to render cluster #' + clusterIds[ci], renderErr);
        var fallbackDrafts = clusterMap[clusterIds[ci]].drafts;
        for (var fb = 0; fb < fallbackDrafts.length; fb++) {
          cardsHTML += renderDraftCard(fallbackDrafts[fb]);
        }
      }
    }

    // Manual drafts section
    if (manualDrafts.length > 0 && clusterIds.length > 0) {
      cardsHTML += '<div class="section-divider"><span>Manual Drafts</span></div>';
    }
    for (var mi = 0; mi < manualDrafts.length; mi++) {
      cardsHTML += renderDraftCard(manualDrafts[mi]);
    }

    // Imported (manual_import) section
    if (importedDrafts.length > 0) {
      cardsHTML += '<div class="section-divider"><span>Imported URLs</span></div>';
    }
    for (var ii = 0; ii < importedDrafts.length; ii++) {
      cardsHTML += renderDraftCard(importedDrafts[ii]);
    }

    var multiSelectBarHTML =
      '<div id="multi-select-bar" class="multi-select-bar">' +
        '<div class="multi-select-bar-inner">' +
          '<span class="select-count-label"><span class="select-count">0</span> selected</span>' +
          '<button class="action-btn action-btn-select-all" data-click="selectAllDrafts">Select All</button>' +
          '<button class="action-btn action-btn-deselect" data-click="deselectAllDrafts">Deselect All</button>' +
          '<button class="action-btn action-btn-danger" data-click="deleteSelectedDrafts">&#128465; Delete Selected</button>' +
        '</div>' +
      '</div>';

    container.innerHTML = filterHTML + '<div class="drafts-list">' + cardsHTML + '</div>' + multiSelectBarHTML;

    // ─── Apply a filter to the rendered list (used by click handler + restore-after-poll) ───
    function applyPublishedFilter(filter) {
      var siblings = container.querySelectorAll('.filter-btn');
      for (var s = 0; s < siblings.length; s++) {
        if (siblings[s].getAttribute('data-filter') === filter) {
          siblings[s].classList.add('active');
        } else {
          siblings[s].classList.remove('active');
        }
      }

      var groups = container.querySelectorAll('.cluster-group');
      var singles = container.querySelectorAll('.draft-card');
      var dividers = container.querySelectorAll('.section-divider');

      for (var g = 0; g < groups.length; g++) {
        if (filter === 'all' || filter === 'cluster') {
          groups[g].style.display = '';
        } else if (filter === 'manual' || filter === 'imported') {
          groups[g].style.display = 'none';
        } else {
          var hasMatch = groups[g].querySelector('[data-status="' + filter + '"]');
          groups[g].style.display = hasMatch ? '' : 'none';
        }
      }
      for (var dd = 0; dd < singles.length; dd++) {
        var cardStatus = singles[dd].getAttribute('data-status');
        var cardMode = singles[dd].getAttribute('data-mode');
        if (filter === 'all') {
          singles[dd].style.display = '';
        } else if (filter === 'manual') {
          // Legacy "manual" tab: drafts without cluster_id and NOT manual_import
          singles[dd].style.display = (cardMode !== 'manual_import') ? '' : 'none';
        } else if (filter === 'imported') {
          // New "imported" tab: only manual_import drafts
          singles[dd].style.display = (cardMode === 'manual_import') ? '' : 'none';
        } else if (filter === 'cluster') {
          singles[dd].style.display = 'none';
        } else {
          singles[dd].style.display = (cardStatus === filter) ? '' : 'none';
        }
      }
      // Dividers are only meaningful when "all" or "manual"/"imported" sections are visible
      for (var dv = 0; dv < dividers.length; dv++) {
        var divLabel = (dividers[dv].textContent || '').toLowerCase();
        if (filter === 'all') {
          dividers[dv].style.display = '';
        } else if (filter === 'manual' && divLabel.indexOf('manual') !== -1 && divLabel.indexOf('imported') === -1) {
          dividers[dv].style.display = '';
        } else if (filter === 'imported' && divLabel.indexOf('imported') !== -1) {
          dividers[dv].style.display = '';
        } else {
          dividers[dv].style.display = 'none';
        }
      }
    }

    // Attach filter listeners
    var filterBtns = container.querySelectorAll('.filter-btn');
    for (var f = 0; f < filterBtns.length; f++) {
      filterBtns[f].addEventListener('click', function () {
        var filter = this.getAttribute('data-filter');
        _publishedFilter = filter;
        applyPublishedFilter(filter);
      });
    }

    // Per-page selector — persists to localStorage and reloads with new page size.
    var perPageSel = container.querySelector('#publishedPerPageSel');
    if (perPageSel) {
      perPageSel.addEventListener('change', function () {
        var n = parseInt(this.value, 10);
        if (!n) return;
        _publishedPerPage = n;
        _publishedPage = 1;
        try { localStorage.setItem('hdf_published_per_page', String(n)); } catch (e) {}
        forceApiRefresh('/api/drafts');
        loadPublished();
      });
    }

    // Restore the previously-active filter after polling re-renders the DOM
    if (_publishedFilter && _publishedFilter !== 'all') {
      applyPublishedFilter(_publishedFilter);
    }

    // ─── Batch Extract button handler ──────────────────────────────
    var batchExtractBtn = container.querySelector('#batchExtractBtn');
    if (batchExtractBtn) {
      batchExtractBtn.addEventListener('click', function () {
        var btn = this;
        if (btn.disabled) return;
        btn.disabled = true;
        btn.querySelector('.action-btn-text').textContent = 'Queuing...';
        btn.classList.add('action-btn-loading');

        fetchApi('/api/drafts/batch-extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ include_failed: false })
        })
        .then(function (data) {
          if (data.success) {
            btn.querySelector('.action-btn-text').textContent = 'Queued ' + data.stats.totalReQueued;
            btn.classList.remove('action-btn-loading');
            btn.classList.add('action-btn-success');
            setTimeout(function () { loadPublished(); }, 2000);
            setTimeout(function () {
              btn.disabled = false;
              btn.classList.remove('action-btn-success');
              btn.querySelector('.action-btn-text').textContent = 'Extract All';
            }, 5000);
          } else {
            btn.querySelector('.action-btn-text').textContent = data.error || 'Failed';
            btn.classList.remove('action-btn-loading');
            setTimeout(function () {
              btn.disabled = false;
              btn.querySelector('.action-btn-text').textContent = 'Extract All';
            }, 3000);
          }
        })
        .catch(function () {
          btn.querySelector('.action-btn-text').textContent = 'Error';
          btn.classList.remove('action-btn-loading');
          btn.disabled = false;
        });
      });
    }

    // ─── Retry Failed button handler ───────────────────────────────
    var batchRetryBtn = container.querySelector('#batchRetryFailedBtn');
    if (batchRetryBtn) {
      batchRetryBtn.addEventListener('click', function () {
        var btn = this;
        if (btn.disabled) return;
        btn.disabled = true;
        btn.querySelector('.action-btn-text').textContent = 'Retrying...';
        btn.classList.add('action-btn-loading');

        fetchApi('/api/drafts/batch-extract', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ include_failed: true })
        })
        .then(function (data) {
          if (data.success) {
            btn.querySelector('.action-btn-text').textContent = 'Retrying ' + data.stats.failedReQueued;
            btn.classList.remove('action-btn-loading');
            btn.classList.add('action-btn-success');
            setTimeout(function () { loadPublished(); }, 2000);
            setTimeout(function () {
              btn.disabled = false;
              btn.classList.remove('action-btn-success');
              btn.querySelector('.action-btn-text').textContent = 'Retry Failed';
            }, 5000);
          } else {
            btn.querySelector('.action-btn-text').textContent = data.error || 'Failed';
            btn.classList.remove('action-btn-loading');
            setTimeout(function () {
              btn.disabled = false;
              btn.querySelector('.action-btn-text').textContent = 'Retry Failed';
            }, 3000);
          }
        })
        .catch(function () {
          btn.querySelector('.action-btn-text').textContent = 'Error';
          btn.classList.remove('action-btn-loading');
          btn.disabled = false;
        });
      });
    }

    // ─── Rewrite All Extracted button handler ──────────────────────
    var batchRewriteBtn = container.querySelector('#batchRewriteBtn');
    if (batchRewriteBtn) {
      batchRewriteBtn.addEventListener('click', function () {
        var btn = this;
        if (btn.disabled) return;
        btn.disabled = true;
        btn.querySelector('.action-btn-text').textContent = 'Starting rewrites...';
        btn.classList.add('action-btn-loading');

        fetchApi('/api/drafts/batch-rewrite', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        })
        .then(function (data) {
          if (data.success) {
            var stats = data.stats;
            btn.querySelector('.action-btn-text').textContent = 'Rewriting ' + stats.clustersQueued + ' clusters';
            btn.classList.remove('action-btn-loading');
            btn.classList.add('action-btn-success');
            setTimeout(function () { loadPublished(); }, 3000);
            setTimeout(function () {
              btn.disabled = false;
              btn.classList.remove('action-btn-success');
              btn.querySelector('.action-btn-text').textContent = 'Rewrite All Extracted';
            }, 8000);
          } else {
            btn.querySelector('.action-btn-text').textContent = data.error || 'Failed';
            btn.classList.remove('action-btn-loading');
            setTimeout(function () {
              btn.disabled = false;
              btn.querySelector('.action-btn-text').textContent = 'Rewrite All Extracted';
            }, 3000);
          }
        })
        .catch(function () {
          btn.querySelector('.action-btn-text').textContent = 'Error';
          btn.classList.remove('action-btn-loading');
          btn.disabled = false;
        });
      });
    }

    // ─── Fetch Images button handler ────────────────────────────────
    var fetchImagesBtn = container.querySelector('#batchFetchImagesBtn');
    if (fetchImagesBtn) {
      fetchImagesBtn.addEventListener('click', function () {
        if (!confirm('Fetch missing featured images for all extracted articles?')) return;
        var btn = this;
        btn.disabled = true;
        btn.querySelector('.action-btn-text').textContent = 'Fetching...';

        fetchApi('/api/drafts/batch-fetch-images', { method: 'POST' })
          .then(function (data) {
            if (data.success) {
              showToast(data.message, 'success');
            } else {
              showToast('Image fetch failed: ' + (data.error || 'Unknown'), 'error');
            }
            btn.disabled = false;
            btn.querySelector('.action-btn-text').textContent = 'Fetch Images';
          })
          .catch(function (err) {
            showToast('Image fetch error: ' + err.message, 'error');
            btn.disabled = false;
            btn.querySelector('.action-btn-text').textContent = 'Fetch Images';
          });
      });
    }

    // Attach cluster expand/collapse
    var toggleBtns = container.querySelectorAll('.cluster-sources-toggle');
    for (var t = 0; t < toggleBtns.length; t++) {
      toggleBtns[t].addEventListener('click', function () {
        var targetId = this.getAttribute('data-target');
        var sourcesList = document.getElementById(targetId);
        if (sourcesList) {
          var isHidden = sourcesList.style.display === 'none';
          sourcesList.style.display = isHidden ? '' : 'none';
          this.textContent = isHidden
            ? '\u25BE Hide sources'
            : '\u25B8 Show ' + sourcesList.children.length + ' source article' + (sourcesList.children.length !== 1 ? 's' : '');
        }
      });
    }
  }

  /**
   * Render a cluster group: header + progress bar + primary card + collapsible sources
   */
  function renderClusterGroup(clusterId, group) {
    var drafts = group.drafts;
    var primary = group.primary || drafts[0];
    var sources = drafts.filter(function (d) { return d.id !== primary.id; });

    var total = drafts.length;
    var extracted = 0, rewriting = 0, ready = 0, published = 0, failed = 0, fetching = 0;
    for (var i = 0; i < drafts.length; i++) {
      switch (drafts[i].status) {
        case 'fetching': fetching++; break;
        case 'draft': extracted++; break;
        case 'rewriting': rewriting++; break;
        case 'ready': ready++; break;
        case 'published': published++; break;
        case 'failed': failed++; break;
        default: fetching++;
      }
    }

    var clusterStatusColor, clusterStatusLabel, clusterStatus;
    if (published === total) {
      clusterStatus = 'published'; clusterStatusColor = '#22c55e'; clusterStatusLabel = 'Published';
    } else if (ready > 0) {
      clusterStatus = 'ready'; clusterStatusColor = '#22c55e'; clusterStatusLabel = 'Ready to Publish';
    } else if (rewriting > 0) {
      clusterStatus = 'rewriting'; clusterStatusColor = '#a855f7'; clusterStatusLabel = 'AI Rewriting...';
    } else if (extracted > 0 && fetching === 0) {
      clusterStatus = 'extracted'; clusterStatusColor = '#4a7aff'; clusterStatusLabel = 'Extracted';
    } else if (fetching > 0) {
      clusterStatus = 'fetching'; clusterStatusColor = '#f59e0b'; clusterStatusLabel = 'Extracting ' + (total - fetching) + '/' + total;
    } else if (failed === total) {
      clusterStatus = 'failed'; clusterStatusColor = '#ef4444'; clusterStatusLabel = 'Failed';
    } else {
      clusterStatus = 'processing'; clusterStatusColor = '#f59e0b'; clusterStatusLabel = 'Processing...';
    }

    var progressHTML =
      '<div class="cluster-progress-bar">' +
        (published > 0 ? '<div class="progress-segment progress-published" style="width:' + (published / total * 100) + '%"></div>' : '') +
        (ready > 0 ? '<div class="progress-segment progress-ready" style="width:' + (ready / total * 100) + '%"></div>' : '') +
        (rewriting > 0 ? '<div class="progress-segment progress-rewriting" style="width:' + (rewriting / total * 100) + '%"></div>' : '') +
        (extracted > 0 ? '<div class="progress-segment progress-extracted" style="width:' + (extracted / total * 100) + '%"></div>' : '') +
        (fetching > 0 ? '<div class="progress-segment progress-fetching" style="width:' + (fetching / total * 100) + '%"></div>' : '') +
        (failed > 0 ? '<div class="progress-segment progress-failed" style="width:' + (failed / total * 100) + '%"></div>' : '') +
      '</div>';

    var primaryTitle = primary.extracted_title || primary.source_title || primary.source_url || 'Untitled Cluster';
    var wpLinkHTML = '';
    if (primary.wp_post_url) {
      wpLinkHTML = '<a href="' + escapeHtml(primary.wp_post_url) + '" target="_blank" class="cluster-wp-link">&#128279; View on WordPress</a>';
    }

    var headerHTML =
      '<div class="cluster-group-header">' +
        '<div class="cluster-header-top">' +
          '<span class="cluster-id-badge">&#128218; Cluster #' + clusterId + '</span>' +
          '<span class="cluster-status-pill" style="background:' + clusterStatusColor + '">' + clusterStatusLabel + '</span>' +
          '<span class="cluster-article-count">' + total + ' source' + (total !== 1 ? 's' : '') + '</span>' +
          wpLinkHTML +
          '<button class="cluster-delete-btn" data-click="deleteCluster" data-cluster-id="' + clusterId + '" title="Delete this cluster and all its drafts">&#128465;</button>' +
        '</div>' +
        '<h3 class="cluster-header-title">' + escapeHtml(primaryTitle) + '</h3>' +
        progressHTML +
      '</div>';

    var primaryCardHTML = renderDraftCardCompact(primary, true);

    var sourcesHTML = '';
    if (sources.length > 0) {
      var sourcesListId = 'cluster-sources-' + clusterId;
      sourcesHTML =
        '<button class="cluster-sources-toggle" data-target="' + sourcesListId + '">' +
          '\u25B8 Show ' + sources.length + ' source article' + (sources.length !== 1 ? 's' : '') +
        '</button>' +
        '<div id="' + sourcesListId + '" class="cluster-sources-list" style="display:none;">';
      for (var s = 0; s < sources.length; s++) {
        sourcesHTML += renderDraftCardCompact(sources[s], false);
      }
      sourcesHTML += '</div>';
    }

    return '<div class="cluster-group" data-cluster="' + clusterId + '" data-status="' + clusterStatus + '">' +
      headerHTML + primaryCardHTML + sourcesHTML +
    '</div>';
  }

  /**
   * Compact draft card for cluster groups.
   */
  function renderDraftCardCompact(draft, isPrimary) {
    var statusColors = {
      fetching: '#f59e0b', draft: '#4a7aff', editing: '#8b5cf6',
      rewriting: '#a855f7', ready: '#22c55e', published: '#22c55e', failed: '#ef4444'
    };
    var statusLabels = {
      fetching: 'Extracting...', draft: 'Extracted', editing: 'Editing',
      rewriting: 'AI Rewriting...', ready: 'Ready', published: 'Published', failed: 'Failed'
    };
    var statusColor = statusColors[draft.status] || '#6b7280';
    var statusLabel = statusLabels[draft.status] || draft.status;
    var isPulsing = draft.status === 'fetching' || draft.status === 'rewriting';

    var rawContent = draft.extracted_content || draft.source_content_markdown || '';
    var contentPreview = extractReadableText(rawContent).substring(0, isPrimary ? 800 : 400);

    var extractedChars = draft.extracted_chars != null ? draft.extracted_chars : (draft.extracted_content || '').length;
    var extractInfo = '';
    if (draft.extraction_status === 'success' || draft.extraction_status === 'cached') {
      extractInfo = '<span class="compact-meta-tag tag-success">&#9989; ' + formatCharCount(extractedChars) + '</span>';
    } else if (draft.extraction_status === 'failed') {
      extractInfo = '<span class="compact-meta-tag tag-error">&#10060; Extract failed</span>';
    } else if (draft.extraction_status === 'pending') {
      extractInfo = '<span class="compact-meta-tag tag-pending">&#9203; Pending</span>';
    }

    var aiInfo = '';
    if (isPrimary && draft.ai_model_used) {
      var modelName = draft.ai_model_used
        .replace('claude-haiku-4-5-20251001', 'Haiku 4.5')
        .replace('claude-sonnet-4-20250514', 'Sonnet 4')
        .replace('claude-sonnet-4-6', 'Sonnet 4.6')
        .replace('claude-opus-4-20250514', 'Opus 4')
        .replace('claude-opus-4-6', 'Opus 4.6')
        .replace('gpt-4o', 'GPT-4o');
      aiInfo = '<span class="compact-meta-tag tag-ai">&#129302; ' + escapeHtml(modelName) + '</span>';
    }

    var wordCountInfo = '';
    if (isPrimary && draft.rewritten_word_count && draft.rewritten_word_count > 0) {
      wordCountInfo = '<span class="compact-meta-tag">' + draft.rewritten_word_count + ' words</span>';
    }

    var actionsHTML = '';
    if (draft.status === 'fetching') {
      actionsHTML += '<button class="btn btn-xs btn-secondary" data-click="retryExtract" data-draft-id="' + draft.id + '">&#8635; Retry</button>';
    }
    if (isPrimary && (draft.status === 'draft' || draft.status === 'failed')) {
      actionsHTML += '<button class="btn btn-xs btn-purple" data-click="triggerRewrite" data-draft-id="' + draft.id + '">&#129302; Rewrite</button>';
    }
    if (isPrimary && draft.status !== 'fetching' && draft.status !== 'rewriting') {
      actionsHTML += '<button class="btn btn-xs btn-secondary" data-click="openEditor" data-draft-id="' + draft.id + '">&#9998; Edit</button>';
    }
    if (isPrimary && (draft.status === 'ready' || draft.status === 'published')) {
      actionsHTML += '<button class="btn btn-xs btn-secondary" data-click="previewDraftHTML" data-draft-id="' + draft.id + '">&#128065; Preview</button>';
    }
    if (isPrimary && draft.status === 'ready') {
      actionsHTML += '<button class="btn btn-xs btn-green" data-click="openEditor" data-draft-id="' + draft.id + '">&#128640; Publish</button>';
    }
    if (draft.status === 'failed') {
      actionsHTML += '<button class="btn btn-xs btn-secondary" data-click="retryDraft" data-draft-id="' + draft.id + '">&#8635; Retry</button>';
    }
    // Always show delete (except for published)
    if (draft.status !== 'published') {
      actionsHTML += '<button class="btn btn-xs btn-outline-danger" data-click="deleteDraft" data-draft-id="' + draft.id + '" title="Delete draft">&#128465;</button>';
    }

    var errorHTML = '';
    if (draft.error_message) {
      errorHTML = '<div class="compact-error">&#10060; ' + escapeHtml(draft.error_message) +
        (draft.retry_count ? ' (attempt ' + draft.retry_count + '/' + (draft.max_retries || 3) + ')' : '') + '</div>';
    }

    var cardClass = isPrimary ? 'compact-card compact-primary' : 'compact-card compact-source cluster-source-card';
    if (draft.status === 'published') cardClass += ' compact-published';
    if (draft.status === 'failed') cardClass += ' compact-failed';

    return '<div class="' + cardClass + '" data-id="' + draft.id + '" data-status="' + escapeHtml(draft.status) + '" data-mode="' + escapeHtml(draft.mode || '') + '">' +
      (draft.status !== 'published' ?
        '<input type="checkbox" class="draft-select-checkbox" data-draft-id="' + draft.id + '" ' +
          'data-click="toggleDraftSelect" data-draft-id="' + draft.id + '" ' +
          'style="' + (_selectModeActive ? '' : 'display:none') + '" ' +
          (_selectedDraftIds[draft.id] ? 'checked' : '') +
        '/>'
        : '') +
      '<div class="compact-card-left">' +
        '<div class="compact-card-header">' +
          '<span class="compact-status' + (isPulsing ? ' pulsing' : '') + '" style="background:' + statusColor + '">' + statusLabel + '</span>' +
          (isPrimary ? '<span class="compact-role-primary">&#11088; Primary</span>' : '<span class="compact-role-source">&#128279; Source</span>') +
          '<span class="compact-domain">' + escapeHtml(draft.source_domain || '') + '</span>' +
          extractInfo + aiInfo + wordCountInfo +
        '</div>' +
        (draft.featured_image ?
          '<div class="compact-thumb" style="float:right;margin-left:8px">' +
            '<img src="' + escapeHtml(draft.featured_image) + '" ' +
              'style="width:60px;height:45px;border-radius:4px;object-fit:cover" ' +
              'data-error="hideParent" />' +
          '</div>' : '') +
        '<div class="compact-title">' +
          (draft.mode === 'manual_import' ? '<span class="badge-manual-import" title="Manually imported">&#128229; MANUAL IMPORT</span>' : '') +
          escapeHtml(draft.extracted_title || draft.source_title || draft.source_url) +
        '</div>' +
        (contentPreview ? '<p class="compact-preview">' + escapeHtml(contentPreview) + '</p>' : '') +
        errorHTML +
      '</div>' +
      (actionsHTML ? '<div class="compact-card-actions">' + actionsHTML + '</div>' : '') +
    '</div>';
  }

  /**
   * Render a manual (non-cluster) draft card.
   */
  function renderDraftCard(draft) {
    var statusColors = {
      fetching: '#f59e0b', draft: '#4a7aff', editing: '#8b5cf6',
      rewriting: '#a855f7', ready: '#22c55e', published: '#6b7280', failed: '#ef4444'
    };
    var statusColor = statusColors[draft.status] || '#6b7280';
    var isPulsing = draft.status === 'fetching' || draft.status === 'rewriting';
    var rawContent = draft.extracted_content || draft.source_content_markdown || '';
    var contentPreview = extractReadableText(rawContent).substring(0, 250);

    var actionsHTML = '';

    if (draft.status === 'fetching') {
      actionsHTML += '<button class="btn btn-sm btn-secondary" data-click="retryExtract" data-draft-id="' + draft.id + '">&#8635; Retry</button>';
    }
    if (draft.status !== 'fetching' && (draft.extraction_status === 'failed' || draft.is_partial)) {
      actionsHTML += '<button class="btn btn-sm btn-secondary" data-click="retryExtract" data-draft-id="' + draft.id + '">&#8635; Retry Extract</button>';
    }
    if (draft.status !== 'fetching' && draft.status !== 'rewriting') {
      actionsHTML += '<button class="btn btn-sm btn-primary" data-click="openEditor" data-draft-id="' + draft.id + '">&#9998; Edit Draft</button>';
    }
    if (draft.status === 'failed' && !draft.failed_permanent) {
      actionsHTML += '<button class="btn btn-sm btn-secondary" data-click="retryDraft" data-draft-id="' + draft.id + '">&#8635; Reset &amp; Retry</button>';
    }
    if (draft.status === 'draft' || draft.status === 'failed') {
      actionsHTML += '<button class="btn btn-sm btn-purple" data-click="triggerRewrite" data-draft-id="' + draft.id + '">&#129302; Rewrite</button>';
    }
    if (draft.status === 'rewriting') {
      actionsHTML += '<button class="btn btn-sm btn-secondary" disabled>&#9203; Rewriting...</button>';
    }
    if (draft.status === 'ready' || draft.status === 'published') {
      actionsHTML += '<button class="btn btn-sm btn-secondary" data-click="previewDraftHTML" data-draft-id="' + draft.id + '">&#128065; Preview</button>';
      actionsHTML += '<button class="btn btn-sm btn-secondary" data-click="downloadDraftHTML" data-draft-id="' + draft.id + '">&#11015; Download</button>';
    }
    if (draft.status === 'ready') {
      actionsHTML += '<button class="btn btn-sm btn-green" data-click="openEditor" data-draft-id="' + draft.id + '">&#128640; Publish</button>';
    }
    if (draft.status === 'published') {
      actionsHTML += '<button class="btn btn-sm btn-secondary" data-click="openEditor" data-draft-id="' + draft.id + '">' + (draft.wp_post_id ? '&#8635; Update on WP' : '&#8635; Re-Publish') + '</button>';
    }
    actionsHTML += '<button class="btn btn-sm btn-danger" data-click="deleteDraft" data-draft-id="' + draft.id + '">&#128465;</button>';

    var imageHTML = '';
    if (draft.featured_image) {
      imageHTML = '<div class="draft-card-image"><img src="' + escapeHtml(draft.featured_image) + '" alt="" data-error="hideParent"></div>';
    }

    var manualImportBadge = (draft.mode === 'manual_import')
      ? '<span class="badge-manual-import" title="Manually imported &mdash; not pushed to WordPress">&#128229; MANUAL IMPORT</span>'
      : '';

    return '<div class="draft-card' + (draft.featured_image ? ' has-image' : '') + '" data-id="' + draft.id + '" data-status="' + escapeHtml(draft.status) + '" data-mode="' + escapeHtml(draft.mode || '') + '">' +
      imageHTML +
      '<div class="draft-card-body">' +
        '<div class="draft-header">' +
          '<span class="draft-status-badge' + (isPulsing ? ' pulsing' : '') + '" style="background:' + statusColor + '">' +
            escapeHtml(draft.status.toUpperCase()) +
          '</span>' +
          '<span class="draft-mode">&#128100; Manual</span>' +
          '<span class="draft-time">' + formatTime(draft.created_at) + '</span>' +
        '</div>' +
        '<h3 class="draft-title">' + manualImportBadge + escapeHtml(draft.extracted_title || draft.source_title || draft.source_url) + '</h3>' +
        '<div class="draft-meta">' +
          '<span class="domain-badge">' + escapeHtml(draft.source_domain || '--') + '</span>' +
          (draft.source_language ? '<span class="domain-badge">' + escapeHtml(draft.source_language.toUpperCase()) + '</span>' : '') +
          (draft.target_keyword ? '<span class="domain-badge" style="color:var(--green)">&#127919; ' + escapeHtml(draft.target_keyword) + '</span>' : '') +
          (draft.extraction_status === 'success' ? '<span style="color:var(--green);font-size:11px">&#9989; ' + formatCharCount(draft.extracted_chars != null ? draft.extracted_chars : (draft.extracted_content || '').length) + '</span>' : '') +
          (draft.extraction_status === 'failed' ? '<span style="color:var(--red);font-size:11px">&#10060; Extract failed</span>' : '') +
          (draft.ai_model_used ? '<span class="ai-badge">' + escapeHtml(draft.ai_model_used.replace('claude-', '').replace('gpt-', 'GPT-').split('-20')[0]) + '</span>' : '') +
        '</div>' +
        (draft.error_message ? '<div class="draft-error-msg" style="font-size:11px;color:#ef4444;margin-top:4px;padding:4px 8px;background:rgba(239,68,68,0.1);border-radius:4px;">&#10060; ' + escapeHtml(draft.error_message) + '</div>' : '') +
        (contentPreview ? '<p class="draft-preview">' + escapeHtml(truncate(contentPreview, 250)) + '</p>' : '') +
        '<div class="draft-actions">' + actionsHTML + '</div>' +
      '</div>' +
    '</div>';
  }

  // Draft action handlers (global for onclick)
  window.__retryExtract = function (id) {
    fetchApi('/api/drafts/' + id + '/extract', { method: 'POST' })
      .then(function () { showToast('Extraction re-triggered', 'info'); setTimeout(loadPublished, 2000); })
      .catch(function (err) { showToast('Failed: ' + err.message, 'error'); });
  };

  window.__triggerRewrite = function (id) {
    fetchApi('/api/drafts/' + id + '/rewrite', { method: 'POST' })
      .then(function (data) {
        if (data.success) { showToast('AI rewrite started...', 'info'); setTimeout(loadPublished, 3000); }
        else showToast('Rewrite failed: ' + data.error, 'error');
      })
      .catch(function (err) { showToast('Rewrite failed: ' + err.message, 'error'); });
  };

  window.__retryDraft = function (id) {
    fetchApi('/api/drafts/' + id + '/retry', { method: 'POST' })
      .then(function (data) {
        if (data.success) {
          showToast('Draft reset for retry', 'info');
          setTimeout(loadPublished, 1000);
          // Refresh failed badge after a short delay
          setTimeout(function () {
            fetchApi('/api/drafts/failed?page=1').then(function (d) { updateFailedBadge(d.total || 0); }).catch(function () {});
          }, 1500);
        } else {
          showToast('Retry failed: ' + (data.error || 'Unknown'), 'error');
        }
      })
      .catch(function (err) { showToast('Retry failed: ' + err.message, 'error'); });
  };

  window.__previewDraftHTML = function (id) {
    fetchApi('/api/drafts/' + id)
      .then(function (data) {
        var draft = data.data;
        if (draft && draft.rewritten_html) {
          // Use a sandboxed iframe blob to prevent XSS from AI-generated content
          var blob = new Blob([draft.rewritten_html], { type: 'text/html' });
          var url = URL.createObjectURL(blob);
          var win = window.open(url, '_blank');
          if (!win) { showToast('Popup blocked by browser', 'error'); }
          setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
        } else {
          showToast('No rewritten HTML available', 'error');
        }
      })
      .catch(function (err) { showToast('Error: ' + err.message, 'error'); });
  };

  window.__downloadDraftHTML = function (id) {
    fetchApi('/api/drafts/' + id)
      .then(function (data) {
        var draft = data.data;
        if (draft && draft.rewritten_html) {
          var slug = (draft.target_keyword || draft.extracted_title || 'article').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
          var blob = new Blob([draft.rewritten_html], { type: 'text/html' });
          var url = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = url; a.download = slug + '.html'; a.click();
          URL.revokeObjectURL(url);
        }
      })
      .catch(function (err) { showToast('Error: ' + err.message, 'error'); });
  };

  window.__deleteDraft = function (id) {
    if (!confirm('Delete this draft?')) return;
    fetchApi('/api/drafts/' + id, { method: 'DELETE' })
      .then(function () { showToast('Draft deleted', 'info'); loadPublished(); })
      .catch(function (err) { showToast('Error: ' + err.message, 'error'); });
  };

  // ─── Delete entire cluster (all drafts) ──────────────────────────
  window.__deleteCluster = function (clusterId, event) {
    if (event) event.stopPropagation();
    if (!confirm('Delete Cluster #' + clusterId + ' and ALL its drafts?\n\nThis cannot be undone.')) return;

    fetchApi('/api/clusters/' + clusterId + '/drafts', { method: 'DELETE' })
      .then(function (data) {
        if (data.success) {
          showToast('Cluster #' + clusterId + ' deleted (' + data.draftsDeleted + ' drafts removed)', 'success');
          loadPublished();
        } else {
          showToast(data.error || 'Failed to delete cluster', 'error');
        }
      })
      .catch(function (err) {
        showToast('Error: ' + err.message, 'error');
      });
  };

  // ─── Batch delete all failed drafts ──────────────────────────────
  window.__batchDeleteFailed = function () {
    if (!confirm('Delete ALL failed drafts?\n\nThis will permanently remove every draft that failed extraction. This cannot be undone.')) return;

    fetchApi('/api/drafts/batch-failed', { method: 'DELETE' })
      .then(function (data) {
        if (data.success) {
          showToast('Deleted ' + data.deletedCount + ' failed drafts', 'success');
          loadPublished();
        } else {
          showToast(data.error || 'Failed', 'error');
        }
      })
      .catch(function (err) {
        showToast('Error: ' + err.message, 'error');
      });
  };

  // ─── Multi-select helpers ──────────────────────────────────────────────

  window.__toggleSelectMode = function () {
    _selectModeActive = !_selectModeActive;
    _selectedDraftIds = {};
    _selectedDraftCount = 0;
    _updateSelectUI();
  };

  window.__toggleDraftSelect = function (draftId, event) {
    if (event) event.stopPropagation();
    draftId = parseInt(draftId, 10);
    if (_selectedDraftIds[draftId]) {
      delete _selectedDraftIds[draftId];
      _selectedDraftCount--;
    } else {
      _selectedDraftIds[draftId] = true;
      _selectedDraftCount++;
    }
    _updateSelectUI();
  };

  window.__selectAllDrafts = function () {
    var checkboxes = document.querySelectorAll('.draft-select-checkbox');
    for (var i = 0; i < checkboxes.length; i++) {
      var id = parseInt(checkboxes[i].dataset.draftId, 10);
      if (!isNaN(id)) {
        _selectedDraftIds[id] = true;
        checkboxes[i].checked = true;
      }
    }
    _selectedDraftCount = Object.keys(_selectedDraftIds).length;
    _updateSelectUI();
  };

  window.__deselectAllDrafts = function () {
    _selectedDraftIds = {};
    _selectedDraftCount = 0;
    var checkboxes = document.querySelectorAll('.draft-select-checkbox');
    for (var i = 0; i < checkboxes.length; i++) { checkboxes[i].checked = false; }
    _updateSelectUI();
  };

  window.__deleteSelectedDrafts = function () {
    var count = Object.keys(_selectedDraftIds).length;
    if (count === 0) return;

    if (!confirm('Delete ' + count + ' selected draft(s)? This cannot be undone. Published articles will be skipped.')) {
      return;
    }

    var allIds = [];
    for (var k in _selectedDraftIds) {
      if (_selectedDraftIds[k]) allIds.push(parseInt(k, 10));
    }
    if (allIds.length === 0) return;

    // Split into chunks of 500 to respect backend limits
    var CHUNK_SIZE = 500;
    var chunks = [];
    for (var i = 0; i < allIds.length; i += CHUNK_SIZE) {
      chunks.push(allIds.slice(i, i + CHUNK_SIZE));
    }

    var totalDeleted = 0;
    var totalSkipped = 0;
    var totalErrors = 0;
    var currentChunk = 0;

    if (chunks.length > 1) {
      showToast('Deleting ' + allIds.length + ' drafts in ' + chunks.length + ' batches...', 'info');
    }

    function processNextChunk() {
      if (currentChunk >= chunks.length) {
        var msg = 'Deleted ' + totalDeleted + ' draft(s)';
        if (totalSkipped > 0) msg += ' (' + totalSkipped + ' published skipped)';
        if (totalErrors > 0) msg += ' (' + totalErrors + ' errors)';
        showToast(msg, totalErrors > 0 ? 'warning' : 'success');
        _selectedDraftIds = {};
        _selectedDraftCount = 0;
        _selectModeActive = false;
        loadPublished();
        return;
      }

      var chunk = chunks[currentChunk];
      currentChunk++;

      if (chunks.length > 1) {
        showToast('Batch ' + currentChunk + '/' + chunks.length + ' — deleting ' + chunk.length + ' drafts...', 'info');
      }

      fetchApi('/api/drafts/batch-delete', {
        method: 'POST',
        body: { ids: chunk }
      })
        .then(function (data) {
          if (data.success) {
            totalDeleted += (data.deletedCount || 0);
            totalSkipped += (data.skippedPublished || 0);
          } else {
            totalErrors += chunk.length;
          }
          setTimeout(processNextChunk, 200);
        })
        .catch(function (err) {
          totalErrors += chunk.length;
          setTimeout(processNextChunk, 200);
        });
    }

    processNextChunk();
  };

  function _updateSelectUI() {
    var bar = document.getElementById('multi-select-bar');
    if (bar) {
      if (_selectedDraftCount > 0) {
        bar.classList.add('visible');
        var countEl = bar.querySelector('.select-count');
        if (countEl) countEl.textContent = _selectedDraftCount;
      } else {
        bar.classList.remove('visible');
      }
    }

    var allCheckboxes = document.querySelectorAll('.draft-select-checkbox');
    for (var i = 0; i < allCheckboxes.length; i++) {
      var id = parseInt(allCheckboxes[i].dataset.draftId, 10);
      allCheckboxes[i].checked = !!_selectedDraftIds[id];
      if (_selectModeActive) {
        allCheckboxes[i].style.display = '';
      } else {
        allCheckboxes[i].style.display = 'none';
      }
    }

    var toggleBtn = document.getElementById('select-mode-btn');
    if (toggleBtn) {
      if (_selectModeActive) {
        toggleBtn.classList.add('active');
        toggleBtn.innerHTML = '&#10005; Cancel Select';
      } else {
        toggleBtn.classList.remove('active');
        toggleBtn.innerHTML = '&#9745; Select';
      }
    }

    if (typeof updateBatchActions === 'function') updateBatchActions();
  }

  function startPublishedPolling() {
    if (publishedPollInterval) {
      clearInterval(publishedPollInterval);
      publishedPollInterval = null;
    }
    publishedPollInterval = setInterval(function () {
      if (state.currentPage !== 'published') {
        clearInterval(publishedPollInterval);
        publishedPollInterval = null;
        return;
      }
      if (document.hidden) return;

      // Step 1 — hit the tiny digest endpoint (~30 bytes/draft instead of
      // ~500). Hash the response and bail out if nothing changed. The full
      // drafts fetch + render only happens on a real state change.
      fetchApi('/api/drafts/status-digest', { cacheMs: 0 })
        .then(function (digest) {
          var rows = digest.data || [];
          var hasActive = !!digest.hasActive;
          var hash = rows.length + ':' + rows.map(function (r) {
            return r.id + ':' + r.status + ':' + (r.updated_at || '');
          }).join('|');

          if (hash === _lastPublishedHash) {
            if (!hasActive) {
              clearInterval(publishedPollInterval);
              publishedPollInterval = null;
            }
            return;
          }
          _lastPublishedHash = hash;

          // Step 2 — digest says something changed, fetch the full list and
          // re-render. Uses the same renderDraftsView path as the initial load.
          return fetchApi('/api/drafts' + _publishedQs(), { cacheMs: 0 }).then(function (data) {
            var drafts = data.data || [];
            var pollContainer = $('publishedList');
            renderDraftsView(pollContainer, drafts);
            // Keep pagination in sync if total changed (new drafts arrived, etc.)
            var total = data.total || drafts.length;
            var totalPages = Math.max(1, Math.ceil(total / _publishedPerPage));
            renderPaginationById('publishedPagination', _publishedPage, totalPages, function (p) {
              _publishedPage = p;
              forceApiRefresh('/api/drafts');
              loadPublished();
              window.scrollTo({ top: 0, behavior: 'smooth' });
            });
            if (!hasActive) {
              clearInterval(publishedPollInterval);
              publishedPollInterval = null;
            }
          });
        })
        .catch(function () { /* silent */ });
    }, 5000);
    state.refreshTimers.push(publishedPollInterval);
  }

  // ─── Content Editor ─────────────────────────────────────────────────────

  var currentDraftId = null;
  var _rewritePollInterval = null;
  var currentDraft = null;
  // Last entity search results keyed by draftId — used by "Apply to Rewrite"
  var _entitySearchResults = {};

  window.__openEditor = function (draftId) {
    openEditor(draftId);
  };

  function openEditor(draftId) {
    currentDraftId = draftId;
    // Persist so refresh reopens the same editor
    try {
      sessionStorage.setItem('hdf_editor', JSON.stringify({ draftId: draftId, page: state.currentPage }));
    } catch (e) {}

    fetchApi('/api/drafts/' + draftId)
      .then(function (data) {
        var draft = data.data;
        currentDraft = draft;

        // Populate taxonomy override selects — always run immediately so WP
        // Publish tab is never blank, then refresh once taxonomy is loaded.
        _populateEditorTaxonomy(draft);
        if (!_wpTaxonomy) {
          loadWPTaxonomy(function() { _populateEditorTaxonomy(draft); });
        }

        // Populate top bar
        var editorTitleText = 'Draft Editor \u2014 ' + (draft.extracted_title || draft.source_title || 'Untitled');
        if (draft.cluster_id) {
          editorTitleText = '\uD83D\uDCDA Cluster #' + draft.cluster_id + ' \u2014 ' + (draft.extracted_title || draft.source_title || 'Untitled');
        }
        $('editor-title').textContent = editorTitleText;
        $('editor-status').textContent = draft.status.toUpperCase();
        $('editor-status').style.background = getStatusColor(draft.status);

        // Source tab — featured image picker + meta
        $('source-meta').innerHTML = buildImagePickerHTML(draft) +
          '<div style="margin-top:10px;font-size:12px;color:var(--text-muted)">' +
          '<strong style="color:var(--text-secondary)">Source:</strong> <a href="' + escapeHtml(draft.source_url) + '" target="_blank" style="color:var(--accent)">' + escapeHtml(draft.source_domain || draft.source_url) + '</a>' +
          ' &nbsp;|&nbsp; <strong style="color:var(--text-secondary)">Lang:</strong> ' + escapeHtml(draft.source_language || '--') +
          ' &nbsp;|&nbsp; <strong style="color:var(--text-secondary)">Extraction:</strong> ' + escapeHtml(draft.extraction_status || '--') +
          (draft.extracted_content ? ' &nbsp;|&nbsp; ' + draft.extracted_content.length + ' chars' : '') +
          '</div>';
        initImagePicker(draftId, draft);

        $('source-content').textContent = draft.extracted_content || draft.source_content_markdown || 'No content extracted.';

        // ─── Cluster Sources Panel ───────────────────────────────
        var clusterSourcesContainer = $('cluster-sources-panel');
        if (clusterSourcesContainer) clusterSourcesContainer.remove();

        if (draft.cluster_id) {
          var sourcesPanel = document.createElement('div');
          sourcesPanel.id = 'cluster-sources-panel';
          sourcesPanel.style.cssText = 'margin-top:16px;border-top:1px solid var(--border);padding-top:16px;';
          sourcesPanel.innerHTML =
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer" data-click="toggleClusterSources">' +
              '<span class="toggle-arrow" style="font-size:14px">\u25B8</span>' +
              '<strong style="color:var(--accent)">Cluster #' + draft.cluster_id + ' Sources</strong>' +
              '<span style="color:var(--text-muted);font-size:12px">(loading...)</span>' +
            '</div>' +
            '<div class="cluster-editor-sources" style="display:none;"></div>';

          var sourceContentEl = $('source-content');
          if (sourceContentEl && sourceContentEl.parentElement) {
            sourceContentEl.parentElement.appendChild(sourcesPanel);
          }

          fetchApi('/api/drafts?cluster_id=' + draft.cluster_id)
            .then(function (clusterData) {
              var allDrafts = (clusterData.data || []).filter(function (d) { return d.id !== draft.id; });
              var countSpan = sourcesPanel.querySelector('span:last-of-type');
              if (countSpan) countSpan.textContent = '(' + allDrafts.length + ' source' + (allDrafts.length !== 1 ? 's' : '') + ')';

              var sourcesList = sourcesPanel.querySelector('.cluster-editor-sources');
              if (allDrafts.length === 0) {
                sourcesList.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">No other sources in this cluster.</p>';
                return;
              }

              var html = '';
              for (var si = 0; si < allDrafts.length; si++) {
                var sd = allDrafts[si];
                var sdContent = extractReadableText(sd.extracted_content || sd.source_content_markdown || '');
                var sdStatusColor = sd.extraction_status === 'success' ? 'var(--green)' :
                                    sd.extraction_status === 'failed' ? 'var(--red)' : 'var(--text-muted)';
                var sdChars = sd.extracted_chars != null ? sd.extracted_chars : (sd.extracted_content || '').length;

                html +=
                  '<div style="border:1px solid var(--border);border-radius:var(--radius);padding:12px;margin-bottom:8px;background:var(--bg-card)">' +
                    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">' +
                      '<span style="font-size:11px;padding:2px 8px;border-radius:10px;background:rgba(255,255,255,0.05);color:var(--text-muted)">' +
                        escapeHtml(sd.source_domain || '') +
                      '</span>' +
                      '<span style="font-size:11px;color:' + sdStatusColor + '">' +
                        (sd.extraction_status === 'success' ? formatCharCount(sdChars) :
                         sd.extraction_status === 'failed' ? 'Failed' : (sd.extraction_status || 'pending')) +
                      '</span>' +
                      (sd.cluster_role === 'primary' ?
                        '<span style="font-size:10px;padding:1px 6px;background:#f59e0b;color:#000;border-radius:8px">Primary</span>' : '') +
                    '</div>' +
                    (sd.featured_image ?
                      '<div style="margin-bottom:8px">' +
                        '<img src="' + escapeHtml(sd.featured_image) + '" ' +
                          'style="max-width:120px;max-height:80px;border-radius:6px;object-fit:cover" ' +
                          'data-error="hideSelf" />' +
                      '</div>' : '') +
                    '<div style="font-weight:600;font-size:13px;margin-bottom:4px;color:var(--text-primary)">' +
                      '<a href="' + escapeHtml(sd.source_url || '#') + '" target="_blank" style="color:var(--accent);text-decoration:none">' +
                        escapeHtml(sd.extracted_title || sd.source_title || sd.source_url || 'Untitled') +
                      '</a>' +
                    '</div>' +
                    (sdContent ?
                      '<div class="source-article-content" style="font-size:12px;color:var(--text-secondary);line-height:1.6;white-space:pre-wrap;max-height:120px;overflow:hidden;position:relative;cursor:pointer" ' +
                        'data-click="toggleExpandContent">' +
                        escapeHtml(sdContent) +
                        '<div class="expand-label" style="position:sticky;bottom:0;left:0;right:0;text-align:center;padding:4px;background:linear-gradient(transparent,var(--bg-card) 40%);color:var(--accent);font-size:11px;font-weight:600">' +
                          '\u25BC Show full content (' + formatCharCount(sdContent.length) + ')' +
                        '</div>' +
                      '</div>' : '') +
                  '</div>';
              }

              sourcesList.innerHTML = html;
            })
            .catch(function () {
              var countSpan = sourcesPanel.querySelector('span:last-of-type');
              if (countSpan) countSpan.textContent = '(failed to load)';
            });
        }

        // ─── InfraNodus Entity Analysis Tab ─────────────────────
        var infraTab = $('tab-infranodus');
        if (infraTab) {
          infraTab.innerHTML =
            '<div class="infra-panel" id="infra-panel-' + draftId + '">' +
              '<div class="infra-header">' +
                '<span class="infra-icon">&#128300;</span>' +
                '<span>InfraNodus Entity Analysis</span>' +
                '<span class="infra-badge" id="infra-badge-' + draftId + '"></span>' +
              '</div>' +
              '<div class="infra-body" id="infra-body-' + draftId + '">' +
                '<div class="infra-loading">Fetching analysis...</div>' +
              '</div>' +
            '</div>' +
            // ─── Entity Search Box ───────────────────────────────
            '<div class="infra-entity-search-box">' +
              '<div class="infra-entity-search-header">' +
                '<span class="infra-icon">&#128269;</span>' +
                '<span>Entity Deep Search</span>' +
                '<span class="infra-entity-search-hint">Type a word or phrase and fetch all InfraNodus data for it</span>' +
              '</div>' +
              '<div class="infra-entity-search-row">' +
                '<input type="text" id="infra-entity-input-' + draftId + '" class="infra-entity-input" placeholder="e.g. climate change, bitcoin, Modi..." maxlength="200" />' +
                '<button class="btn btn-sm btn-infra-fetch" id="infra-entity-fetch-btn-' + draftId + '" data-click="searchEntityInfra" data-draft-id="' + draftId + '">Fetch</button>' +
              '</div>' +
              '<div class="infra-entity-results" id="infra-entity-results-' + draftId + '"></div>' +
            '</div>';
        }
        loadInfraData(draftId);

        // Settings tab
        $('setting-keyword').value = draft.target_keyword || '';
        $('setting-domain').value = draft.target_domain || '';
        // Default to wordpress if WP credentials are configured, unless draft was explicitly set
        var defaultPlatform = 'blogspot';
        fetchApi('/api/wp-status').then(function (wpData) {
          if (wpData && wpData.configured) defaultPlatform = 'wordpress';
          $('setting-platform').value = draft.target_platform === 'blogspot' ? defaultPlatform : (draft.target_platform || defaultPlatform);
        }).catch(function () {
          $('setting-platform').value = draft.target_platform || 'blogspot';
        });
        $('setting-platform').value = draft.target_platform || 'blogspot';
        $('setting-language').value = draft.target_language || 'en+hi';
        $('setting-custom-prompt').value = '';

        // Schema checkboxes
        var schemaTypes = (draft.schema_types || 'NewsArticle,FAQPage,BreadcrumbList').split(',');
        var checkboxes = document.querySelectorAll('#draft-settings-form .checkbox-group input');
        for (var i = 0; i < checkboxes.length; i++) {
          checkboxes[i].checked = schemaTypes.indexOf(checkboxes[i].value) !== -1;
        }

        // AI Output / HTML Editor
        if (draft.rewritten_html) {
          $('ai-output-content').innerHTML =
            '<p style="color:var(--green);margin-bottom:12px;">\u2705 AI rewrite complete (' +
            (draft.rewritten_word_count || '?') + ' words, ' + (draft.ai_model_used || '?') + ')</p>' +
            '<p>Switch to "HTML Editor" tab to view/edit the code, or "Preview" to see the final page.</p>';
          $('html-code-editor').value = draft.rewritten_html;
          updatePreviewIframe(draft.rewritten_html);
        } else {
          $('ai-output-content').innerHTML = '<p class="placeholder-text">No AI output yet. Go to Settings tab and click "Rewrite with AI".</p>';
          $('html-code-editor').value = '';
          updatePreviewIframe('');
        }

        // Versions bar
        loadVersions(draftId);

        // Reset tabs to defaults
        resetEditorTabs();

        // Init AI Edit tab buttons (idempotent — runs each time editor opens)
        initAiEditTab();

        // Show editor
        $('editor-overlay').style.display = 'flex';
      })
      .catch(function (err) {
        showToast('Failed to load draft: ' + err.message, 'error');
      });
  }

  // ─── Image Picker (Source Tab) ────────────────────────────────────────

  // Extract all unique <img src="..."> URLs from draft's HTML fields
  function extractImagesFromDraft(draft) {
    var seen = {};
    var imgs = [];
    function scanHtml(html) {
      if (!html) return;
      var re = /<img[^>]+src=["']([^"']+)["']/gi;
      var m;
      while ((m = re.exec(html)) !== null) {
        var url = m[1];
        if (url && url.startsWith('http') && !seen[url]) {
          seen[url] = true;
          imgs.push(url);
        }
      }
    }
    // Check featured_image first (ensure it appears first in grid)
    if (draft.featured_image && draft.featured_image.startsWith('http')) {
      seen[draft.featured_image] = true;
      imgs.push(draft.featured_image);
    }
    scanHtml(draft.extracted_content);
    scanHtml(draft.rewritten_html);
    return imgs;
  }

  function buildImagePickerHTML(draft) {
    var currentImg = draft.featured_image || '';
    var isPublished = !!(draft.wp_post_id);
    var html = '<div class="imgpicker-wrap">' +
      '<div class="imgpicker-header">' +
        '<span class="imgpicker-label">&#128444;&#65039; Featured Image</span>' +
        (isPublished
          ? '<span class="imgpicker-wp-badge">&#10003; On WordPress #' + draft.wp_post_id + '</span>'
          : '') +
      '</div>' +
      // Current image preview
      '<div class="imgpicker-current" id="imgpicker-current">' +
        (currentImg
          ? '<img src="' + escapeHtml(currentImg) + '" class="imgpicker-preview" id="imgpicker-preview" alt="Featured image">'
          : '<div class="imgpicker-no-image">No image selected</div>') +
      '</div>' +
      // URL input row
      '<div class="imgpicker-url-row">' +
        '<input type="text" id="editor-featured-input" class="imgpicker-url-input" value="' + escapeHtml(currentImg) + '" placeholder="https://... image URL" />' +
        '<button class="btn btn-xs btn-secondary" id="imgpicker-set-url-btn">Set</button>' +
      '</div>' +
      // Action row
      '<div class="imgpicker-actions">' +
        '<button class="btn btn-xs btn-secondary" id="imgpicker-browse-btn">&#128247; Article Images</button>' +
        (draft.cluster_id ? '<button class="btn btn-xs btn-secondary" id="imgpicker-cluster-btn">&#128196; Cluster Images</button>' : '') +
        (isPublished
          ? '<button class="btn btn-xs btn-primary" id="imgpicker-wp-btn">&#9650; Upload &amp; Set on WordPress</button>'
          : '<button class="btn btn-xs btn-secondary" id="imgpicker-wp-btn">&#9650; Upload to WordPress</button>') +
      '</div>' +
      // Article images grid (hidden until browse is clicked)
      '<div class="imgpicker-grid-wrap" id="imgpicker-grid-wrap" style="display:none;">' +
        '<div class="imgpicker-grid-label">Images from this article — click to select</div>' +
        '<div class="imgpicker-grid" id="imgpicker-grid"></div>' +
      '</div>' +
      // Cluster images grid (hidden until cluster btn is clicked)
      '<div class="imgpicker-grid-wrap" id="imgpicker-cluster-wrap" style="display:none;">' +
        '<div class="imgpicker-grid-label" id="imgpicker-cluster-label">Loading cluster images…</div>' +
        '<div id="imgpicker-cluster-content"></div>' +
      '</div>' +
      // WP upload status
      '<div class="imgpicker-wp-status" id="imgpicker-wp-status" style="display:none;"></div>' +
    '</div>';
    return html;
  }

  function initImagePicker(draftId, draft) {
    var browseBtn      = document.getElementById('imgpicker-browse-btn');
    var clusterBtn     = document.getElementById('imgpicker-cluster-btn');
    var wpBtn          = document.getElementById('imgpicker-wp-btn');
    var setUrlBtn      = document.getElementById('imgpicker-set-url-btn');
    var urlInput       = document.getElementById('editor-featured-input');
    var gridWrap       = document.getElementById('imgpicker-grid-wrap');
    var grid           = document.getElementById('imgpicker-grid');
    var clusterWrap    = document.getElementById('imgpicker-cluster-wrap');
    var clusterContent = document.getElementById('imgpicker-cluster-content');
    var clusterLabel   = document.getElementById('imgpicker-cluster-label');
    var status         = document.getElementById('imgpicker-wp-status');

    // Set URL button — save to DB + update preview
    if (setUrlBtn && urlInput) {
      setUrlBtn.addEventListener('click', function () {
        var url = urlInput.value.trim();
        if (!url) return;
        setSelectedImage(draftId, url);
      });
      urlInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') setSelectedImage(draftId, urlInput.value.trim());
      });
    }

    // Helper: clicking a thumb in ANY grid selects the image
    function wireGridClicks(container) {
      container.addEventListener('click', function (e) {
        var thumb = e.target.closest('.imgpicker-thumb');
        if (!thumb) return;
        var src = thumb.dataset.src;
        if (!src) return;
        // Remove active from all thumbs in all grids
        document.querySelectorAll('.imgpicker-thumb').forEach(function (t) { t.classList.remove('active'); });
        thumb.classList.add('active');
        if (urlInput) urlInput.value = src;
        updateImagePreview(src);
        setSelectedImage(draftId, src);
      });
    }

    // Browse article images (from draft's own extracted/rewritten content)
    if (browseBtn && grid && gridWrap) {
      browseBtn.addEventListener('click', function () {
        var isOpen = gridWrap.style.display !== 'none';
        if (isOpen) {
          gridWrap.style.display = 'none';
          browseBtn.innerHTML = '&#128247; Article Images';
          return;
        }
        // Close cluster grid if open
        if (clusterWrap) clusterWrap.style.display = 'none';
        if (clusterBtn) clusterBtn.innerHTML = '&#128196; Cluster Images';

        var images = extractImagesFromDraft(draft);
        if (!images.length) {
          grid.innerHTML = '<p class="imgpicker-cluster-empty">No images found in article content.</p>';
        } else {
          var currentUrl = (urlInput && urlInput.value.trim()) || draft.featured_image || '';
          grid.innerHTML = images.map(function (src) {
            var active = src === currentUrl ? ' active' : '';
            return '<div class="imgpicker-thumb' + active + '" data-src="' + escapeHtml(src) + '">' +
              '<img src="' + escapeHtml(src) + '" loading="lazy" alt="" />' +
            '</div>';
          }).join('');
          wireGridClicks(grid);
        }
        gridWrap.style.display = '';
        browseBtn.innerHTML = '&#10005; Close';
      });
    }

    // Cluster images button — fetches images from ALL articles in the cluster
    if (clusterBtn && clusterWrap && clusterContent) {
      var _clusterLoaded = false;
      clusterBtn.addEventListener('click', function () {
        var isOpen = clusterWrap.style.display !== 'none';
        if (isOpen) {
          clusterWrap.style.display = 'none';
          clusterBtn.innerHTML = '&#128196; Cluster Images';
          return;
        }
        // Close article grid if open
        if (gridWrap) gridWrap.style.display = 'none';
        if (browseBtn) browseBtn.innerHTML = '&#128247; Article Images';

        clusterWrap.style.display = '';
        clusterBtn.innerHTML = '&#10005; Close Cluster';

        if (_clusterLoaded) return; // already fetched, just show cached result
        if (clusterLabel) clusterLabel.textContent = 'Loading images from cluster articles…';
        clusterContent.innerHTML = '';

        fetchApi('/api/drafts/' + draftId + '/cluster-images')
          .then(function (resp) {
            _clusterLoaded = true;
            if (!resp || !resp.success) {
              clusterContent.innerHTML = '<p class="imgpicker-cluster-empty">Failed to load cluster images.</p>';
              if (clusterLabel) clusterLabel.textContent = 'Cluster images';
              return;
            }
            var groups = resp.groups || [];
            if (!groups.length) {
              clusterContent.innerHTML = '<p class="imgpicker-cluster-empty">No images found in cluster articles.</p>';
              if (clusterLabel) clusterLabel.textContent = 'Cluster images (0)';
              return;
            }
            if (clusterLabel) clusterLabel.textContent = resp.total + ' image' + (resp.total !== 1 ? 's' : '') + ' across ' + resp.clusterArticleCount + ' articles — click to select';

            var currentUrl = (urlInput && urlInput.value.trim()) || draft.featured_image || '';
            var html = '';
            groups.forEach(function (group) {
              html += '<div class="imgpicker-cluster-source">' +
                '<span class="src-domain">' + escapeHtml(group.domain) + '</span>' +
                '<span>— ' + escapeHtml(group.title) + '</span>' +
              '</div>' +
              '<div class="imgpicker-grid">' +
              group.images.map(function (src) {
                var active = src === currentUrl ? ' active' : '';
                return '<div class="imgpicker-thumb' + active + '" data-src="' + escapeHtml(src) + '">' +
                  '<img src="' + escapeHtml(src) + '" loading="lazy" alt="" />' +
                '</div>';
              }).join('') +
              '</div>';
            });
            clusterContent.innerHTML = html;
            wireGridClicks(clusterContent);
          })
          .catch(function (err) {
            _clusterLoaded = false; // allow retry
            clusterContent.innerHTML = '<p class="imgpicker-cluster-empty">Error: ' + (err.message || 'network error') + '</p>';
            if (clusterLabel) clusterLabel.textContent = 'Cluster images';
          });
      });
    }

    // Upload to WP button
    if (wpBtn) {
      wpBtn.addEventListener('click', function () {
        var url = (urlInput && urlInput.value.trim()) || draft.featured_image || '';
        if (!url) { showToast('No image URL selected', 'warn'); return; }
        updateWpImage(draftId, url, wpBtn, status);
      });
    }
  }

  function updateImagePreview(src) {
    var preview = document.getElementById('imgpicker-preview');
    var currentDiv = document.getElementById('imgpicker-current');
    if (!currentDiv) return;
    if (!preview) {
      currentDiv.innerHTML = '<img src="' + escapeHtml(src) + '" class="imgpicker-preview" id="imgpicker-preview" alt="Featured image">';
    } else {
      preview.src = src;
    }
  }

  function setSelectedImage(draftId, url) {
    if (!url) return;
    fetchApi('/api/drafts/' + draftId, {
      method: 'PUT',
      body: { featured_image: url },
    }).then(function () {
      updateImagePreview(url);
      showToast('Image saved', 'success');
    }).catch(function () { showToast('Failed to save image', 'error'); });
  }

  function updateWpImage(draftId, imageUrl, btn, statusEl) {
    if (btn) { btn.disabled = true; btn.textContent = 'Uploading…'; }
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Uploading image to WordPress…'; statusEl.className = 'imgpicker-wp-status'; }

    fetchApi('/api/drafts/' + draftId + '/update-wp-image', {
      method: 'POST',
      body: { imageUrl: imageUrl },
    }).then(function (resp) {
      if (resp && resp.success) {
        var msg, toastMsg;
        if (resp.wpUpdated) {
          msg = '✓ Image uploaded and set as featured image on WordPress (media #' + resp.wpMediaId + ')';
          toastMsg = 'WP featured image updated';
        } else if (resp.wpPostMissing) {
          msg = '✓ Image uploaded to WP media library (media #' + resp.wpMediaId + ') — WP post was deleted, so featured_media not set.';
          toastMsg = 'Image uploaded — WP post was deleted';
        } else if (resp.wpError) {
          msg = '✓ Image uploaded (media #' + resp.wpMediaId + ') but could not set on WP post: ' + resp.wpError;
          toastMsg = 'Image uploaded, post update failed';
        } else {
          msg = '✓ Image uploaded to WordPress media library (media #' + resp.wpMediaId + '). Will be used on next publish.';
          toastMsg = 'Image uploaded to WP media';
        }
        if (statusEl) { statusEl.textContent = msg; statusEl.className = 'imgpicker-wp-status success'; }
        if (btn) { btn.disabled = false; btn.textContent = resp.wpUpdated ? '✓ Updated on WordPress' : '⬆ Upload to WordPress'; }
        showToast(toastMsg, 'success');
      } else {
        var err = (resp && resp.error) || 'Upload failed';
        if (statusEl) { statusEl.textContent = '✗ ' + err; statusEl.className = 'imgpicker-wp-status error'; }
        if (btn) { btn.disabled = false; btn.textContent = '⬆ Upload to WordPress'; }
        showToast(err, 'error');
      }
    }).catch(function (err) {
      if (statusEl) { statusEl.textContent = '✗ ' + (err.message || String(err)); statusEl.className = 'imgpicker-wp-status error'; }
      if (btn) { btn.disabled = false; btn.textContent = '⬆ Upload to WordPress'; }
      showToast('Upload error: ' + (err.message || ''), 'error');
    });
  }

  window.__updateWpImage = updateWpImage;

  // ─── WP Taxonomy & Routing Rules ──────────────────────────────────────────

  var _wpTaxonomy = null; // { categories, tags, authors, synced_at }

  function loadWPTaxonomy(cb) {
    fetchApi('/api/wp/taxonomy')
      .then(function (data) {
        if (data && data.success) {
          _wpTaxonomy = data;
          _populateTaxonomySelects();
          var statusEl = document.getElementById('wpTaxSyncStatus');
          if (statusEl && data.synced_at) statusEl.textContent = 'Last synced: ' + data.synced_at.slice(0, 16).replace('T', ' ');

          // Update tab button labels with counts
          var catBtn = document.querySelector('[data-tax-tab="category"]');
          var tagBtn = document.querySelector('[data-tax-tab="tag"]');
          var authBtn = document.querySelector('[data-tax-tab="author"]');
          if (catBtn) catBtn.textContent = 'Categories (' + (data.categories || []).length + ')';
          if (tagBtn) tagBtn.textContent = 'Tags (' + (data.tags || []).length + ')';
          if (authBtn) authBtn.textContent = 'Authors (' + (data.authors || []).length + ')';

          var wrap = document.getElementById('wpTaxCacheWrap');
          if (wrap) {
            wrap.style.display = '';
            window.__showTaxTab('category');
          }
          if (cb) cb(data);
        } else {
          if (cb) cb(null);
        }
      })
      .catch(function () { if (cb) cb(null); });
  }

  window.__showTaxTab = function (taxType) {
    if (!_wpTaxonomy) { return; }
    var wrap = document.getElementById('wpTaxTableWrap');
    if (!wrap) return;

    // Update active state on tab buttons
    document.querySelectorAll('[data-tax-tab]').forEach(function (btn) {
      var isActive = btn.getAttribute('data-tax-tab') === taxType;
      btn.classList.toggle('btn-primary', isActive);
      btn.classList.toggle('btn-secondary', !isActive);
    });

    var key = taxType === 'category' ? 'categories' : taxType === 'tag' ? 'tags' : 'authors';
    var items = _wpTaxonomy[key] || [];
    var typeLabel = taxType === 'category' ? 'categories' : taxType === 'tag' ? 'tags' : 'authors';

    if (!items.length) {
      wrap.innerHTML = '<p style="color:#888;font-size:12px;padding:6px 0;">No ' + typeLabel + ' found. ' +
        (taxType === 'author' ? 'Ensure your WP credentials have permission to list users.' : 'Click Sync to refresh.') + '</p>';
      return;
    }

    wrap.innerHTML = '<table class="data-table" style="font-size:12px;">' +
      '<thead><tr>' +
      '<th>Name</th>' +
      (taxType !== 'author' ? '<th>Slug</th>' : '') +
      '<th style="width:60px">ID</th>' +
      '</tr></thead><tbody>' +
      items.map(function (item) {
        return '<tr>' +
          '<td>' + escapeHtml(item.name) + '</td>' +
          (taxType !== 'author' ? '<td style="color:var(--text-muted);">/' + escapeHtml(item.slug) + '</td>' : '') +
          '<td style="color:var(--text-muted);">' + item.wp_id + '</td>' +
          '</tr>';
      }).join('') +
      '</tbody></table>';
  };

  function _populateTaxonomySelects() {
    if (!_wpTaxonomy) return;
    var cats = _wpTaxonomy.categories || [];
    var tags = _wpTaxonomy.tags || [];
    var authors = _wpTaxonomy.authors || [];

    function fillSelect(selId, items, placeholder) {
      var sel = document.getElementById(selId);
      if (!sel) return;
      var prevVals = Array.from(sel.selectedOptions || []).map(function(o){ return o.value; });
      sel.innerHTML = (placeholder ? '<option value="">' + placeholder + '</option>' : '') +
        items.map(function (item) {
          return '<option value="' + item.wp_id + '"' + (prevVals.indexOf(String(item.wp_id)) !== -1 ? ' selected' : '') + '>' +
            escapeHtml(item.name) + (item.slug ? ' (/' + item.slug + ')' : '') + '</option>';
        }).join('');
    }

    // Settings rule editor
    fillSelect('ruleEditorCategories', cats, null);
    fillSelect('ruleEditorPrimaryCat', cats, '— same as first selected —');
    fillSelect('ruleEditorTags', tags, null);
    fillSelect('ruleEditorAuthor', authors, '— use global default —');

    // Editor overlay taxonomy override
    fillSelect('editor-wp-categories', cats, null);
    fillSelect('editor-wp-primary-cat', cats, '— same as first selected —');
    fillSelect('editor-wp-tags', tags, null);
    fillSelect('editor-wp-author', authors, '— use rule/default —');
  }

  function syncWPTaxonomy() {
    var btn = document.getElementById('wpTaxSyncBtn');
    var statusEl = document.getElementById('wpTaxSyncStatus');
    if (btn) { btn.disabled = true; btn.textContent = 'Syncing\u2026'; }
    if (statusEl) statusEl.textContent = '';
    fetchApi('/api/wp/taxonomy/sync', { method: 'POST' })
      .then(function (data) {
        if (btn) { btn.disabled = false; btn.textContent = '\u21BA Sync from WordPress'; }
        if (data && data.success) {
          showToast('Synced: ' + data.categories + ' categories, ' + data.tags + ' tags, ' + data.authors + ' authors', 'success');
          if (data.errors && data.errors.length) showToast('Warnings: ' + data.errors.join('; '), 'warn');
          loadWPTaxonomy();
          loadPublishRules();
        } else {
          showToast((data && data.error) || 'Sync failed', 'error');
          if (statusEl) statusEl.textContent = 'Sync failed';
        }
      })
      .catch(function (err) {
        if (btn) { btn.disabled = false; btn.textContent = '\u21BA Sync from WordPress'; }
        showToast('Sync error: ' + (err.message || ''), 'error');
      });
  }

  function loadPublishRules() {
    var container = document.getElementById('publishRulesList');
    if (!container) return;
    fetchApi('/api/publish-rules')
      .then(function (data) {
        if (!data || !data.success) return;
        var rules = data.rules || [];
        if (!rules.length) {
          container.innerHTML = '<p style="color:#888;font-size:12px;padding:8px 0;">No rules yet. Add one to start routing articles.</p>';
          return;
        }
        container.innerHTML = rules.map(function (r) {
          var cats = r.wp_category_ids ? JSON.parse(r.wp_category_ids) : [];
          var tags = r.wp_tag_ids ? JSON.parse(r.wp_tag_ids) : [];
          var matchParts = [];
          if (r.match_source_domain) matchParts.push('domain: ' + r.match_source_domain);
          if (r.match_source_category) matchParts.push('category: ' + r.match_source_category);
          if (r.match_title_keyword) matchParts.push('keyword: ' + r.match_title_keyword);
          var sourceBadge = r.source === 'import'
            ? '<span title="Created via Bulk Config Import" style="background:rgba(16,185,129,0.15);color:#4ade80;font-size:10px;padding:2px 6px;border-radius:3px;border:1px solid rgba(16,185,129,0.3);">imported</span>'
            : '';
          var keyBadge = r.key
            ? '<span style="background:rgba(100,116,139,0.15);color:#94a3b8;font-size:10px;padding:2px 6px;border-radius:3px;font-family:monospace;">' + escapeHtml(r.key) + '</span>'
            : '';
          return '<div style="background:#161b22;border:1px solid #30363d;border-radius:6px;padding:10px 14px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:flex-start;">' +
            '<div>' +
              '<div style="display:flex;gap:8px;align-items:center;margin-bottom:4px;flex-wrap:wrap;">' +
                '<span style="background:#1d4ed8;color:#fff;font-size:10px;padding:2px 6px;border-radius:3px;">P' + r.priority + '</span>' +
                '<strong style="font-size:13px;">' + escapeHtml(r.rule_name) + '</strong>' +
                sourceBadge +
                keyBadge +
                (!r.is_active ? '<span style="color:#888;font-size:11px;">(disabled)</span>' : '') +
              '</div>' +
              (matchParts.length ? '<div style="font-size:11px;color:#888;margin-bottom:3px;">Match: ' + matchParts.join(' &amp; ') + '</div>' : '<div style="font-size:11px;color:#888;margin-bottom:3px;">Default rule (matches all)</div>') +
              '<div style="font-size:11px;color:#6e7681;">' +
                (cats.length ? 'Categories: ' + cats.join(', ') + (r.wp_primary_cat_id ? ' [primary: ' + r.wp_primary_cat_id + ']' : '') + ' &nbsp;' : '') +
                (tags.length ? 'Tags: ' + tags.join(', ') + ' &nbsp;' : '') +
                (r.wp_author_id ? 'Author: ' + r.wp_author_id : '') +
              '</div>' +
            '</div>' +
            '<div style="display:flex;gap:6px;flex-shrink:0;">' +
              '<button class="btn btn-xs btn-secondary" data-click="editPublishRule" data-rule-id="' + r.id + '">Edit</button>' +
              '<button class="btn btn-xs" style="background:rgba(239,68,68,0.15);color:#f87171;border:none;" data-click="deletePublishRule" data-rule-id="' + r.id + '">Delete</button>' +
            '</div>' +
          '</div>';
        }).join('');
      })
      .catch(function () {});
  }

  function openRuleEditor(ruleId) {
    var editor = document.getElementById('publishRuleEditor');
    if (!editor) return;
    document.getElementById('ruleEditorId').value = ruleId || '';
    if (!ruleId) {
      // New rule — clear form
      ['ruleEditorName','ruleEditorDomain','ruleEditorSrcCat','ruleEditorKeyword'].forEach(function(id){ var el=document.getElementById(id); if(el) el.value=''; });
      document.getElementById('ruleEditorPriority').value = '10';
      var catSel = document.getElementById('ruleEditorCategories');
      var tagSel = document.getElementById('ruleEditorTags');
      if (catSel) Array.from(catSel.options).forEach(function(o){ o.selected=false; });
      if (tagSel) Array.from(tagSel.options).forEach(function(o){ o.selected=false; });
    } else {
      fetchApi('/api/publish-rules')
        .then(function (data) {
          var rule = (data.rules || []).find(function(r){ return r.id === ruleId; });
          if (!rule) return;
          document.getElementById('ruleEditorName').value = rule.rule_name || '';
          document.getElementById('ruleEditorPriority').value = rule.priority || 0;
          document.getElementById('ruleEditorDomain').value = rule.match_source_domain || '';
          document.getElementById('ruleEditorSrcCat').value = rule.match_source_category || '';
          document.getElementById('ruleEditorKeyword').value = rule.match_title_keyword || '';
          var catIds = rule.wp_category_ids ? JSON.parse(rule.wp_category_ids) : [];
          var tagIds = rule.wp_tag_ids ? JSON.parse(rule.wp_tag_ids) : [];
          var catSel = document.getElementById('ruleEditorCategories');
          var tagSel = document.getElementById('ruleEditorTags');
          var primSel = document.getElementById('ruleEditorPrimaryCat');
          var authSel = document.getElementById('ruleEditorAuthor');
          if (catSel) Array.from(catSel.options).forEach(function(o){ o.selected = catIds.indexOf(Number(o.value)) !== -1; });
          if (tagSel) Array.from(tagSel.options).forEach(function(o){ o.selected = tagIds.indexOf(Number(o.value)) !== -1; });
          if (primSel) primSel.value = rule.wp_primary_cat_id || '';
          if (authSel) authSel.value = rule.wp_author_id || '';
        });
    }
    editor.style.display = '';
    editor.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function savePublishRule() {
    var ruleId = document.getElementById('ruleEditorId').value;
    var catSel = document.getElementById('ruleEditorCategories');
    var tagSel = document.getElementById('ruleEditorTags');
    var catIds = catSel ? Array.from(catSel.selectedOptions).map(function(o){ return Number(o.value); }) : [];
    var tagIds = tagSel ? Array.from(tagSel.selectedOptions).map(function(o){ return Number(o.value); }) : [];
    var primCat = document.getElementById('ruleEditorPrimaryCat').value;
    var author = document.getElementById('ruleEditorAuthor').value;

    var body = {
      rule_name:            document.getElementById('ruleEditorName').value,
      priority:             Number(document.getElementById('ruleEditorPriority').value) || 0,
      match_source_domain:  document.getElementById('ruleEditorDomain').value || null,
      match_source_category:document.getElementById('ruleEditorSrcCat').value || null,
      match_title_keyword:  document.getElementById('ruleEditorKeyword').value || null,
      wp_category_ids:      catIds.length ? JSON.stringify(catIds) : null,
      wp_primary_cat_id:    primCat ? Number(primCat) : (catIds[0] || null),
      wp_tag_ids:           tagIds.length ? JSON.stringify(tagIds) : null,
      wp_author_id:         author ? Number(author) : null,
      is_active:            1,
    };

    var url = ruleId ? '/api/publish-rules/' + ruleId : '/api/publish-rules';
    var method = ruleId ? 'PUT' : 'POST';

    fetchApi(url, { method: method, body: body })
      .then(function (data) {
        if (data && data.success) {
          showToast(ruleId ? 'Rule updated' : 'Rule created', 'success');
          document.getElementById('publishRuleEditor').style.display = 'none';
          loadPublishRules();
        } else {
          showToast((data && data.error) || 'Save failed', 'error');
        }
      })
      .catch(function (err) { showToast('Error: ' + err.message, 'error'); });
  }

  function deletePublishRule(ruleId) {
    if (!confirm('Delete this rule?')) return;
    fetchApi('/api/publish-rules/' + ruleId, { method: 'DELETE' })
      .then(function (data) {
        if (data && data.success) { showToast('Rule deleted', 'success'); loadPublishRules(); }
        else showToast('Delete failed', 'error');
      })
      .catch(function (err) { showToast('Error: ' + err.message, 'error'); });
  }

  function _populateEditorTaxonomy(draft) {
    _populateTaxonomySelects(); // ensure options are filled
    var catSel = document.getElementById('editor-wp-categories');
    var primSel = document.getElementById('editor-wp-primary-cat');
    var tagSel = document.getElementById('editor-wp-tags');
    var authSel = document.getElementById('editor-wp-author');

    var catIds = [];
    if (draft.wp_category_ids) { try { catIds = JSON.parse(draft.wp_category_ids); } catch(e){} }
    var tagIds = [];
    if (draft.wp_tag_ids) { try { tagIds = JSON.parse(draft.wp_tag_ids); } catch(e){} }

    if (catSel) Array.from(catSel.options).forEach(function(o){ o.selected = catIds.indexOf(Number(o.value)) !== -1; });
    if (tagSel) Array.from(tagSel.options).forEach(function(o){ o.selected = tagIds.indexOf(Number(o.value)) !== -1; });
    if (primSel && draft.wp_primary_cat_id) primSel.value = String(draft.wp_primary_cat_id);
    if (authSel && draft.wp_author_id_override) authSel.value = String(draft.wp_author_id_override);
    var statusSel = document.getElementById('editor-wp-post-status');
    if (statusSel && draft.wp_post_status_override) statusSel.value = draft.wp_post_status_override;

    // Build resolved preview
    var resolvedEl = document.getElementById('editor-taxonomy-resolved');
    if (resolvedEl) {
      var tax = _wpTaxonomy || {};
      var cats = tax.categories || [];
      var tags = tax.tags || [];
      var authors = tax.authors || [];

      var hasOverride = catIds.length || tagIds.length || draft.wp_primary_cat_id || draft.wp_author_id_override;
      if (!cats.length && !tags.length && !authors.length) {
        resolvedEl.innerHTML = '<span style="color:#555;">No taxonomy synced yet — sync first to populate these selects.</span>';
      } else if (hasOverride) {
        var catNames = catIds.map(function(id){ var c = cats.find(function(x){ return x.wp_id === id; }); return c ? escapeHtml(c.name) : id; });
        var primCat = cats.find(function(x){ return x.wp_id === draft.wp_primary_cat_id; });
        var tagNames = tagIds.map(function(id){ var t = tags.find(function(x){ return x.wp_id === id; }); return t ? escapeHtml(t.name) : id; });
        var auth = authors.find(function(x){ return x.wp_id === draft.wp_author_id_override; });
        resolvedEl.innerHTML =
          '<strong style="color:#4ade80;">&#10003; Override active</strong><br>' +
          (catNames.length ? '<span>Categories: ' + catNames.join(', ') + '</span><br>' : '') +
          (primCat ? '<span>Primary (permalink): /' + escapeHtml(primCat.slug) + '/</span><br>' : '') +
          (tagNames.length ? '<span>Tags: ' + tagNames.join(', ') + '</span><br>' : '') +
          (auth ? '<span>Author: ' + escapeHtml(auth.name) + '</span>' : '');
      } else {
        resolvedEl.innerHTML = '<span style="color:#f59e0b;">&#9656; No override — will use matching rule or global default at publish time.</span>';
      }
    }

    // Wire Save and Clear buttons (idempotent)
    var saveBtn = document.getElementById('editor-wp-publish-save');
    var clearBtn = document.getElementById('editor-wp-publish-clear');
    var savedLabel = document.getElementById('editor-wp-publish-saved');

    if (saveBtn && !saveBtn._wired) {
      saveBtn._wired = true;
      saveBtn.addEventListener('click', function () {
        saveEditorSettings();
        if (savedLabel) { savedLabel.style.display = ''; setTimeout(function(){ savedLabel.style.display = 'none'; }, 2000); }
        // Refresh resolved preview after save
        fetchApi('/api/drafts/' + currentDraftId).then(function(d){ if(d && d.data) _populateEditorTaxonomy(d.data); }).catch(function(){});
      });
    }
    if (clearBtn && !clearBtn._wired) {
      clearBtn._wired = true;
      clearBtn.addEventListener('click', function () {
        if (catSel) Array.from(catSel.options).forEach(function(o){ o.selected = false; });
        if (tagSel) Array.from(tagSel.options).forEach(function(o){ o.selected = false; });
        if (primSel) primSel.value = '';
        if (authSel) authSel.value = '';
        saveEditorSettings();
        if (savedLabel) { savedLabel.style.display = ''; setTimeout(function(){ savedLabel.style.display = 'none'; }, 2000); }
        fetchApi('/api/drafts/' + currentDraftId).then(function(d){ if(d && d.data) _populateEditorTaxonomy(d.data); }).catch(function(){});
      });
    }
  }

  window.__syncWPTaxonomy = syncWPTaxonomy;
  window.__addPublishRule = function () { openRuleEditor(null); };
  window.__editPublishRule = function (el) { openRuleEditor(Number(el.dataset.ruleId)); };
  window.__deletePublishRule = function (el) { deletePublishRule(Number(el.dataset.ruleId)); };
  window.__savePublishRule = savePublishRule;
  window.__cancelPublishRule = function () { var e = document.getElementById('publishRuleEditor'); if(e) e.style.display='none'; };

  function closeEditor() {
    if (_rewritePollInterval) { clearInterval(_rewritePollInterval); _rewritePollInterval = null; }
    // Exit full view mode before closing
    var panels = document.querySelector('.editor-panels');
    if (panels) panels.classList.remove('aiedit-fullview');
    var expandBtn = document.getElementById('aiedit-expand-btn');
    if (expandBtn) { expandBtn.classList.remove('active'); expandBtn.innerHTML = '&#x26F6; Full View'; }
    // Clear persisted editor state
    try { sessionStorage.removeItem('hdf_editor'); } catch (e) {}
    $('editor-overlay').style.display = 'none';
    currentDraftId = null;
    currentDraft = null;
    loadPublished();
  }

  // ─── InfraNodus Entity Analysis Panel ─────────────────────────────
  function loadInfraData(draftId) {
    var body = document.getElementById('infra-body-' + draftId);
    var badge = document.getElementById('infra-badge-' + draftId);
    if (!body) return;

    fetchApi('/api/drafts/' + draftId + '/infranodus')
      .then(function (data) {
        if (!data.hasInfraData) {
          if (badge) { badge.textContent = 'No data'; badge.className = 'infra-badge infra-badge-empty'; }
          body.innerHTML =
            '<p class="infra-empty">No InfraNodus analysis for this draft yet.</p>' +
            '<p class="infra-empty" style="font-size:12px;color:#555;">The pipeline runs analysis automatically when InfraNodus is enabled. You can also trigger it manually.</p>' +
            '<button class="btn btn-sm btn-outline" data-click="runInfraAnalysis" data-draft-id="' + draftId + '">&#128300; Run Analysis Now</button>';
          _updateInfraStatusBar(null);
          return;
        }

        var d = data.infraData || {};
        var topicCount  = (d.mainTopics  || []).length;
        var entityCount = (d.missingEntities || []).length;
        var hasKeyword  = !!d.targetKeyword;

        if (badge) {
          badge.textContent = topicCount + ' topics · ' + entityCount + ' entities' + (hasKeyword ? ' · SEO' : '');
          badge.className = 'infra-badge infra-badge-active';
        }

        var html = '';

        // ── Keyword banner ────────────────────────────────────────────
        if (hasKeyword) {
          html += '<div class="infra-kw-banner">&#127919; Target keyword: <strong>' + escapeHtml(d.targetKeyword) + '</strong></div>';
        }

        // ── Three AI advice cards (article + keyword SEO) ─────────────
        var hasAdvice = d.advice || d.rankingAdvice || d.intentAdvice || d.gapAdvice;
        if (hasAdvice) {
          html += '<div class="infra-advice-grid">';
          if (d.advice) {
            html += '<div class="infra-advice-card infra-advice-article">' +
              '<div class="infra-advice-card-title">&#128203; Article Analysis</div>' +
              '<div class="infra-advice-card-body">' + escapeHtml(d.advice) + '</div>' +
            '</div>';
          }
          if (d.rankingAdvice) {
            html += '<div class="infra-advice-card infra-advice-ranking">' +
              '<div class="infra-advice-card-title">&#128200; What Currently Ranks</div>' +
              '<div class="infra-advice-card-body">' + escapeHtml(d.rankingAdvice) + '</div>' +
            '</div>';
          }
          if (d.intentAdvice) {
            html += '<div class="infra-advice-card infra-advice-intent">' +
              '<div class="infra-advice-card-title">&#128269; What Readers Want</div>' +
              '<div class="infra-advice-card-body">' + escapeHtml(d.intentAdvice) + '</div>' +
            '</div>';
          }
          if (d.gapAdvice) {
            html += '<div class="infra-advice-card infra-advice-gap">' +
              '<div class="infra-advice-card-title">&#127919; Content Opportunity</div>' +
              '<div class="infra-advice-card-body">' + escapeHtml(d.gapAdvice) + '</div>' +
            '</div>';
          }
          html += '</div>';
        }

        // ── Graph Summary (parsed) ────────────────────────────────────
        if (d.graphSummary) {
          html += '<div class="infra-section"><h4>Knowledge Graph Summary</h4>' + renderGraphSummary(d.graphSummary) + '</div>';
        }

        // ── Tag sections ──────────────────────────────────────────────
        if (d.mainTopics && d.mainTopics.length) {
          html += '<div class="infra-section"><h4>Main Topics</h4><div class="infra-tags">';
          d.mainTopics.forEach(function (t) { html += '<span class="infra-tag infra-tag-topic">' + escapeHtml(t) + '</span>'; });
          html += '</div></div>';
        }
        if (d.relatedQueries && d.relatedQueries.length) {
          html += '<div class="infra-section"><h4>Related Search Queries</h4><div class="infra-tags">';
          d.relatedQueries.forEach(function (q) { html += '<span class="infra-tag infra-tag-query">' + escapeHtml(q) + '</span>'; });
          html += '</div></div>';
        }
        if (d.demandTopics && d.demandTopics.length) {
          html += '<div class="infra-section"><h4>High-Demand Topics (underserved)</h4><div class="infra-tags">';
          d.demandTopics.forEach(function (t) { html += '<span class="infra-tag infra-tag-demand">' + escapeHtml(t) + '</span>'; });
          html += '</div></div>';
        }
        if (d.missingEntities && d.missingEntities.length) {
          html += '<div class="infra-section"><h4>Bridge Concepts (entities in gaps)</h4><div class="infra-tags">';
          d.missingEntities.forEach(function (e) { html += '<span class="infra-tag infra-tag-entity">' + escapeHtml(e) + '</span>'; });
          html += '</div></div>';
        }

        // ── Lists ──────────────────────────────────────────────────────
        var hasLists = (d.contentGaps && d.contentGaps.length) ||
                       (d.demandGaps && d.demandGaps.length) ||
                       (d.researchQuestions && d.researchQuestions.length);
        if (hasLists) {
          html += '<div class="infra-entity-lists">';
          if (d.contentGaps && d.contentGaps.length) {
            html += '<div class="infra-list-block"><h4>Content Gaps</h4><ul class="infra-gaps">';
            d.contentGaps.forEach(function (g) { html += '<li>' + escapeHtml(g) + '</li>'; });
            html += '</ul></div>';
          }
          if (d.demandGaps && d.demandGaps.length) {
            html += '<div class="infra-list-block"><h4>Demand Gaps</h4><ul class="infra-gaps infra-gaps-demand">';
            d.demandGaps.forEach(function (g) { html += '<li>' + escapeHtml(g) + '</li>'; });
            html += '</ul></div>';
          }
          if (d.researchQuestions && d.researchQuestions.length) {
            html += '<div class="infra-list-block"><h4>Research Questions</h4><ul class="infra-questions">';
            d.researchQuestions.forEach(function (q) { html += '<li>' + escapeHtml(q) + '</li>'; });
            html += '</ul></div>';
          }
          html += '</div>';
        }

        // ── Bigrams + Clusters ─────────────────────────────────────────
        if (d.bigrams && d.bigrams.length) {
          html += '<div class="infra-section"><h4>Top Co-occurring Concepts</h4><div class="infra-bigrams">';
          d.bigrams.forEach(function (b) { html += '<span class="infra-bigram">' + escapeHtml(b) + '</span>'; });
          html += '</div></div>';
        }
        if (d.clusterDescriptions && d.clusterDescriptions.length) {
          html += '<div class="infra-section"><h4>Topic Cluster Descriptions</h4>';
          d.clusterDescriptions.forEach(function (c, i) {
            html += '<div class="infra-cluster-desc"><span class="infra-cluster-num">C' + (i + 1) + '</span>' + escapeHtml(c) + '</div>';
          });
          html += '</div>';
        }

        // ── Meta row ──────────────────────────────────────────────────
        html += '<div class="infra-section infra-meta">' +
          '<span>Rewrite model: <strong>' + escapeHtml(data.aiModel || 'unknown') + '</strong></span>' +
          '<span style="color:#374151;font-size:11px;">' + escapeHtml(d.analyzedAt || '') + '</span>' +
          '<button class="btn btn-sm btn-outline" data-click="runInfraAnalysis" data-draft-id="' + draftId + '">&#128300; Re-run</button>' +
          '</div>';

        body.innerHTML = html;
        _updateInfraStatusBar(d);
      })
      .catch(function (err) {
        body.innerHTML = '<p class="infra-error">Failed to load: ' + escapeHtml(err.message || String(err)) + '</p>';
        _updateInfraStatusBar(null);
      });
  }

  function _updateInfraStatusBar(infra) {
    var bar = $('infra-status-bar');
    if (!bar) return;
    if (!infra || !(infra.mainTopics || []).length) {
      bar.style.display = 'block';
      bar.innerHTML =
        '<div class="infra-status-bar-inner infra-status-empty">' +
          '<span>&#128300; No InfraNodus analysis — AI will rewrite without entity context.</span>' +
          '<button class="btn btn-xs btn-outline" data-click="switchToInfraTab">Run Analysis</button>' +
        '</div>';
    } else {
      var t = (infra.mainTopics || []).length;
      var e = (infra.missingEntities || []).length;
      bar.style.display = 'block';
      bar.innerHTML =
        '<div class="infra-status-bar-inner infra-status-ready">' +
          '<span>&#128300; InfraNodus ready — <strong>' + t + ' topics</strong>, <strong>' + e + ' entities</strong> will enrich this rewrite.</span>' +
          '<button class="btn btn-xs btn-outline" data-click="switchToInfraTab">View</button>' +
        '</div>';
    }
  }

  function toggleInfraPanel(draftId) {
    // No-op: InfraNodus is now a full tab, nothing to toggle.
    // Kept for backward-compat with any lingering onclick references.
  }

  function runInfraAnalysis(draftId) {
    var body = document.getElementById('infra-body-' + draftId);
    if (!body) return;
    body.innerHTML = '<div class="infra-loading">&#128300; Running InfraNodus analysis...</div>';

    fetchApi('/api/drafts/' + draftId + '/analyze', { method: 'POST' })
      .then(function (data) {
        if (data && data.success) {
          loadInfraData(draftId);
        } else {
          body.innerHTML = '<p class="infra-error">' + escapeHtml((data && data.error) || 'Analysis failed') + '</p>';
        }
      })
      .catch(function (err) {
        body.innerHTML = '<p class="infra-error">' + escapeHtml(err.message || String(err)) + '</p>';
      });
  }

  function searchEntityInfra(draftId) {
    var input = document.getElementById('infra-entity-input-' + draftId);
    var results = document.getElementById('infra-entity-results-' + draftId);
    var btn = document.getElementById('infra-entity-fetch-btn-' + draftId);
    if (!input || !results) return;

    var entity = input.value.trim();
    if (!entity) {
      results.innerHTML = '<p class="infra-entity-error">Please enter a word or phrase to search.</p>';
      return;
    }

    results.innerHTML =
      '<div class="infra-entity-loading">' +
        '<div class="infra-entity-loading-spinner"></div>' +
        '<span>Running 7 InfraNodus API calls for <strong>' + escapeHtml(entity) + '</strong>&#8230;</span>' +
      '</div>';
    if (btn) { btn.disabled = true; btn.textContent = 'Fetching...'; }

    fetchApi('/api/infranodus/entity-search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entity: entity }),
    })
      .then(function (resp) {
        if (!resp.success || !resp.data) {
          results.innerHTML = '<p class="infra-entity-error">' + escapeHtml((resp && resp.error) || 'No data returned') + '</p>';
          return;
        }
        var d = resp.data;
        var html = '<div class="infra-entity-result-header">Deep analysis for: <strong>' + escapeHtml(d.entity) + '</strong></div>';

        // ── BLOCK 1: Three AI Advice panels side by side ──────────────────
        var hasAdvice = d.rankingAdvice || d.intentAdvice || d.gapAdvice;
        if (hasAdvice) {
          html += '<div class="infra-advice-grid">';
          if (d.rankingAdvice) {
            html += '<div class="infra-advice-card infra-advice-ranking">' +
              '<div class="infra-advice-card-title">&#128200; What Currently Ranks</div>' +
              '<div class="infra-advice-card-body">' + escapeHtml(d.rankingAdvice) + '</div>' +
            '</div>';
          }
          if (d.intentAdvice) {
            html += '<div class="infra-advice-card infra-advice-intent">' +
              '<div class="infra-advice-card-title">&#128269; What Readers Want</div>' +
              '<div class="infra-advice-card-body">' + escapeHtml(d.intentAdvice) + '</div>' +
            '</div>';
          }
          if (d.gapAdvice) {
            html += '<div class="infra-advice-card infra-advice-gap">' +
              '<div class="infra-advice-card-title">&#127919; Content Opportunity Gap</div>' +
              '<div class="infra-advice-card-body">' + escapeHtml(d.gapAdvice) + '</div>' +
            '</div>';
          }
          html += '</div>';
        }

        // ── BLOCK 2: Knowledge Graph Summary (parsed & structured) ───────
        if (d.graphSummary) {
          html += '<div class="infra-section"><h4>Knowledge Graph Summary</h4>' +
            renderGraphSummary(d.graphSummary) +
          '</div>';
        }

        // ── BLOCK 3: Tags row — topics + related queries + demand topics ──
        if (d.mainTopics && d.mainTopics.length) {
          html += '<div class="infra-section"><h4>Main Topics (from entity analysis)</h4><div class="infra-tags">';
          d.mainTopics.forEach(function (t) {
            html += '<span class="infra-tag infra-tag-topic">' + escapeHtml(t) + '</span>';
          });
          html += '</div></div>';
        }

        if (d.relatedQueries && d.relatedQueries.length) {
          html += '<div class="infra-section"><h4>Related Search Queries (reader intent)</h4><div class="infra-tags">';
          d.relatedQueries.forEach(function (q) {
            html += '<span class="infra-tag infra-tag-query">' + escapeHtml(q) + '</span>';
          });
          html += '</div></div>';
        }

        if (d.demandTopics && d.demandTopics.length) {
          html += '<div class="infra-section"><h4>High-Demand Topics (searched but underserved)</h4><div class="infra-tags">';
          d.demandTopics.forEach(function (t) {
            html += '<span class="infra-tag infra-tag-demand">' + escapeHtml(t) + '</span>';
          });
          html += '</div></div>';
        }

        if (d.missingEntities && d.missingEntities.length) {
          html += '<div class="infra-section"><h4>Bridge Concepts (entities in knowledge gaps)</h4><div class="infra-tags">';
          d.missingEntities.forEach(function (e) {
            html += '<span class="infra-tag infra-tag-entity">' + escapeHtml(e) + '</span>';
          });
          html += '</div></div>';
        }

        // ── BLOCK 4: Lists — gaps, questions, demand gaps ─────────────────
        var hasLists = (d.contentGaps && d.contentGaps.length) ||
                       (d.demandGaps && d.demandGaps.length) ||
                       (d.researchQuestions && d.researchQuestions.length);
        if (hasLists) {
          html += '<div class="infra-entity-lists">';
          if (d.contentGaps && d.contentGaps.length) {
            html += '<div class="infra-list-block"><h4>Content Gaps</h4><ul class="infra-gaps">';
            d.contentGaps.forEach(function (g) { html += '<li>' + escapeHtml(g) + '</li>'; });
            html += '</ul></div>';
          }
          if (d.demandGaps && d.demandGaps.length) {
            html += '<div class="infra-list-block"><h4>Demand Gaps (supply vs. demand)</h4><ul class="infra-gaps infra-gaps-demand">';
            d.demandGaps.forEach(function (g) { html += '<li>' + escapeHtml(g) + '</li>'; });
            html += '</ul></div>';
          }
          if (d.researchQuestions && d.researchQuestions.length) {
            html += '<div class="infra-list-block"><h4>Research Questions</h4><ul class="infra-questions">';
            d.researchQuestions.forEach(function (q) { html += '<li>' + escapeHtml(q) + '</li>'; });
            html += '</ul></div>';
          }
          html += '</div>';
        }

        // ── BLOCK 5: Bigrams + Cluster Descriptions ───────────────────────
        if (d.bigrams && d.bigrams.length) {
          html += '<div class="infra-section"><h4>Top Co-occurring Concepts (bigrams)</h4><div class="infra-bigrams">';
          d.bigrams.forEach(function (b) {
            html += '<span class="infra-bigram">' + escapeHtml(b) + '</span>';
          });
          html += '</div></div>';
        }

        if (d.clusterDescriptions && d.clusterDescriptions.length) {
          html += '<div class="infra-section"><h4>Topic Cluster Descriptions</h4>';
          d.clusterDescriptions.forEach(function (c, i) {
            html += '<div class="infra-cluster-desc"><span class="infra-cluster-num">C' + (i + 1) + '</span>' + escapeHtml(c) + '</div>';
          });
          html += '</div>';
        }

        // ── Empty fallback ────────────────────────────────────────────────
        if (!hasAdvice && !d.mainTopics.length && !d.relatedQueries.length) {
          html += '<p class="infra-empty">No meaningful data returned. Try a broader or different search term.</p>';
        }

        // ── Apply to Rewrite button ───────────────────────────────────
        // Stores result so applyEntityToDraft() can read it without
        // re-fetching or encoding the whole object into a data attribute.
        _entitySearchResults[draftId] = d;
        html +=
          '<div class="infra-apply-bar">' +
            '<div class="infra-apply-bar-info">' +
              '<span class="infra-apply-bar-icon">&#128300;</span>' +
              '<span>This data is <strong>not yet used by AI</strong>. Click Apply to wire it into the next rewrite.</span>' +
            '</div>' +
            '<button class="btn btn-infra-apply" data-click="applyEntityToDraft" data-draft-id="' + draftId + '">&#9989; Apply to Rewrite</button>' +
          '</div>' +
          '<div class="infra-entity-meta">&#9203; ' + escapeHtml(d.analyzedAt || '') + ' &nbsp;&#183;&nbsp; 7 API calls in parallel</div>';
        results.innerHTML = html;
      })
      .catch(function (err) {
        results.innerHTML = '<p class="infra-entity-error">Search failed: ' + escapeHtml(err.message || String(err)) + '</p>';
      })
      .finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = 'Fetch'; }
      });
  }

  function applyEntityToDraft(draftId) {
    var entityData = _entitySearchResults[draftId];
    if (!entityData) {
      showToast('No entity search result to apply. Run a search first.', 'error');
      return;
    }

    var btn = document.querySelector('[data-click="applyEntityToDraft"][data-draft-id="' + draftId + '"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Applying...'; }

    fetchApi('/api/drafts/' + draftId + '/infranodus-merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityData: entityData }),
    })
      .then(function (resp) {
        if (resp.success) {
          showToast('&#128300; Entity data applied — AI will use it on next rewrite', 'success');
          // Update the apply bar to reflect applied state
          if (btn) {
            btn.textContent = '&#9989; Applied';
            btn.classList.add('btn-infra-applied');
            btn.closest('.infra-apply-bar').querySelector('.infra-apply-bar-info span:last-child').innerHTML =
              'Entity data <strong>merged into this draft</strong>. AI will use it when you click Rewrite.';
          }
          // Refresh the analysis panel so it shows the merged data
          loadInfraData(draftId);
        } else {
          showToast((resp && resp.error) || 'Apply failed', 'error');
          if (btn) { btn.disabled = false; btn.textContent = '&#9989; Apply to Rewrite'; }
        }
      })
      .catch(function (err) {
        showToast('Apply failed: ' + (err.message || String(err)), 'error');
        if (btn) { btn.disabled = false; btn.textContent = '&#9989; Apply to Rewrite'; }
      });
  }

  // Wire up Enter key on entity search inputs (delegated — runs after editor opens)
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var el = e.target;
    if (!el || !el.classList.contains('infra-entity-input')) return;
    var id = el.id.replace('infra-entity-input-', '');
    if (id) searchEntityInfra(id);
  });

  window.__switchToInfraTab = function () {
    var btn = document.querySelector('.editor-tab[data-panel="right"][data-tab="infranodus"]');
    if (btn) btn.click();
  };

  window.__loadInfraData = loadInfraData;
  window.__toggleInfraPanel = toggleInfraPanel;
  window.__runInfraAnalysis = runInfraAnalysis;
  window.__searchEntityInfra = searchEntityInfra;
  window.__applyEntityToDraft = applyEntityToDraft;

  // ─── AI Edit Tab ───────────────────────────────────────────────────

  // Holds the current draft id while editor is open (re-uses currentDraft)
  function _aiEditDraftId() {
    return currentDraft && currentDraft.id ? String(currentDraft.id) : null;
  }

  // Load HTML from AI Output tab or HTML Editor into the editor pane
  function initAiEditTab() {
    var loadBtn  = document.getElementById('aiedit-load-btn');
    // Guard: only wire listeners once per DOM element lifetime
    if (loadBtn && loadBtn.dataset.init) return;

    var saveBtn    = document.getElementById('aiedit-save-btn');
    var expandBtn  = document.getElementById('aiedit-expand-btn');
    var patchBtn   = document.getElementById('aiedit-patch-btn');
    var checkBtn   = document.getElementById('aiedit-check-btn');
    var instrInput = document.getElementById('aiedit-instruction');

    if (loadBtn) { loadBtn.dataset.init = '1';
      loadBtn.addEventListener('click', function () {
        var htmlEditor = document.getElementById('html-code-editor');
        var aiOut = document.getElementById('ai-output-content');
        var content = document.getElementById('aiedit-content');
        if (!content) return;
        // Prefer HTML editor if it has content, else fall back to AI output
        var src = (htmlEditor && htmlEditor.value.trim()) ? htmlEditor.value.trim()
          : (aiOut ? aiOut.innerHTML : '');
        if (!src) { showToast('No content loaded yet. Run AI Rewrite first.', 'warn'); return; }
        content.innerHTML = src;
        updateAiEditWordCount();
        showToast('Content loaded into editor', 'info');
        // Auto-check coverage after loading
        checkEntityCoverage();
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', function () {
        var content = document.getElementById('aiedit-content');
        var htmlEditor = document.getElementById('html-code-editor');
        if (!content || !htmlEditor) return;
        var html = content.innerHTML;
        htmlEditor.value = html;
        // Switch to HTML editor tab
        var htmlTab = document.querySelector('.editor-tab[data-tab="html-editor"]');
        if (htmlTab) htmlTab.click();
        showToast('Saved to HTML Editor', 'success');
      });
    }

    if (patchBtn) {
      patchBtn.addEventListener('click', function () {
        applyAIPatch();
      });
    }

    if (instrInput) {
      instrInput.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') applyAIPatch();
      });
    }

    if (checkBtn) {
      checkBtn.addEventListener('click', function () {
        checkEntityCoverage();
      });
    }

    if (expandBtn) {
      expandBtn.addEventListener('click', function () {
        var panels = document.querySelector('.editor-panels');
        if (!panels) return;
        var isExpanded = panels.classList.toggle('aiedit-fullview');
        expandBtn.classList.toggle('active', isExpanded);
        expandBtn.innerHTML = isExpanded ? '&#x2715; Exit Full View' : '&#x26F6; Full View';
      });
    }

    // Live word count
    var contentEl = document.getElementById('aiedit-content');
    if (contentEl) {
      contentEl.addEventListener('input', function () { updateAiEditWordCount(); });
    }

    // Quick-action chip clicks
    var chipsEl = document.getElementById('aiedit-quick-chips');
    if (chipsEl) {
      chipsEl.addEventListener('click', function (e) {
        var chip = e.target.closest('.aiedit-chip');
        if (!chip) return;
        var instr = chip.dataset.instruction;
        if (!instr) return;
        var instrInput = document.getElementById('aiedit-instruction');
        if (instrInput) { instrInput.value = instr; instrInput.focus(); }
      });
    }
  }

  function updateAiEditWordCount() {
    var contentEl = document.getElementById('aiedit-content');
    var wcEl = document.getElementById('aiedit-wordcount');
    if (!contentEl || !wcEl) return;
    var text = contentEl.innerText || contentEl.textContent || '';
    var words = text.trim().split(/\s+/).filter(function (w) { return w.length > 0; }).length;
    wcEl.textContent = words + ' word' + (words !== 1 ? 's' : '');
  }

  function applyAIPatch() {
    var draftId = _aiEditDraftId();
    if (!draftId) { showToast('No draft open', 'error'); return; }

    var content = document.getElementById('aiedit-content');
    var instrInput = document.getElementById('aiedit-instruction');
    var patchBtn = document.getElementById('aiedit-patch-btn');
    var statusEl = document.getElementById('aiedit-patch-status');

    if (!content || !instrInput) return;
    var html = content.innerHTML.trim();
    if (!html || html.length < 10) { showToast('Load content first', 'warn'); return; }
    var instruction = instrInput.value.trim();
    if (!instruction) { showToast('Enter an editing instruction first', 'warn'); return; }

    if (patchBtn) { patchBtn.disabled = true; patchBtn.innerHTML = '<span class="aiedit-spinner"></span> Editing…'; }
    if (statusEl) { statusEl.style.display = 'block'; statusEl.textContent = 'Sending to AI…'; }

    fetchApi('/api/drafts/' + draftId + '/ai-patch', {
      method: 'POST',
      body: { html: html, instruction: instruction },
    })
      .then(function (resp) {
        if (resp && resp.success && resp.html) {
          content.innerHTML = resp.html;
          updateAiEditWordCount();
          if (statusEl) statusEl.textContent = '✓ Edit applied. Check Coverage to see entity impact.';
          instrInput.value = '';
          showToast('AI edit applied', 'success');
          // Re-check coverage after patch
          checkEntityCoverage();
        } else {
          if (statusEl) statusEl.textContent = '✗ ' + ((resp && resp.error) || 'AI patch failed');
          showToast((resp && resp.error) || 'AI patch failed', 'error');
        }
      })
      .catch(function (err) {
        if (statusEl) statusEl.textContent = '✗ ' + (err.message || String(err));
        showToast('AI patch error: ' + (err.message || String(err)), 'error');
      })
      .finally(function () {
        if (patchBtn) { patchBtn.disabled = false; patchBtn.innerHTML = '&#129302; AI Edit'; }
      });
  }

  // ─── Entity Coverage Checker ───────────────────────────────────────

  function checkEntityCoverage() {
    var draftId = _aiEditDraftId();
    var coverageBody = document.getElementById('aiedit-coverage-body');
    if (!coverageBody) return;

    // Get the content HTML
    var content = document.getElementById('aiedit-content');
    var html = content ? content.innerHTML : '';
    if (!html || html.trim().length < 10) {
      coverageBody.innerHTML = '<p class="aiedit-empty">Load content first using the toolbar above.</p>';
      return;
    }

    // Strip tags for plain-text matching
    var plainText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase();

    // Get infranodus data from the draft
    if (!draftId) { coverageBody.innerHTML = '<p class="aiedit-empty">No draft loaded.</p>'; return; }

    fetchApi('/api/drafts/' + draftId + '/infranodus')
      .then(function (resp) {
        var d = (resp && resp.infraData) || null;
        if (!d) {
          coverageBody.innerHTML = '<p class="aiedit-empty">No InfraNodus data for this draft yet. Run analysis in the InfraNodus tab first.</p>';
          return;
        }
        renderEntityCoverage(d, plainText, coverageBody, draftId);
      })
      .catch(function (err) {
        coverageBody.innerHTML = '<p class="aiedit-empty" style="color:#ef4444">Failed to load InfraNodus data: ' + escapeHtml(err.message || '') + '</p>';
      });
  }

  // Parse InfraNodus bigram string "word1 <-> word2 [weight='N']"
  // Returns { word1, word2, display, aiLabel } or null if not a bigram
  function _parseBigram(str) {
    var m = str.match(/^(.+?)\s*<->\s*(.+?)(?:\s*\[.*\])?$/);
    if (!m) return null;
    var w1 = m[1].trim().toLowerCase();
    var w2 = m[2].trim().toLowerCase();
    return {
      word1: w1,
      word2: w2,
      display: w1 + ' + ' + w2,
      aiLabel: '"' + w1 + '" and "' + w2 + '"'
    };
  }

  // Check if a plain word/phrase is in text (case-insensitive)
  function _inText(text, phrase) {
    return text.indexOf(phrase.toLowerCase().replace(/[-_]/g, ' ')) !== -1;
  }

  function renderEntityCoverage(d, plainText, coverageBody, draftId) {
    // ── 1. Collect single-word/phrase topics ──────────────────────────────
    var singlePresent = [];
    var singleMissing = [];
    var seen = {};

    function checkSingle(arr) {
      if (!arr || !arr.length) return;
      arr.forEach(function (e) {
        if (!e || typeof e !== 'string') return;
        // Skip bigram-format strings — handled separately below
        if (e.indexOf('<->') !== -1) return;
        var key = e.toLowerCase();
        if (seen[key]) return;
        seen[key] = true;
        if (_inText(plainText, e)) singlePresent.push(e);
        else singleMissing.push(e);
      });
    }
    checkSingle(d.mainTopics);
    checkSingle(d.missingEntities);

    // ── 2. Parse bigrams: "word1 <-> word2 [weight='N']" ──────────────────
    // A bigram is "present" when BOTH words appear anywhere in the text.
    var bigramPresent = [];
    var bigramMissing = [];
    var seenBigram = {};

    function checkBigrams(arr) {
      if (!arr || !arr.length) return;
      arr.forEach(function (raw) {
        if (!raw || typeof raw !== 'string') return;
        var bg = _parseBigram(raw);
        if (!bg) return;
        var key = bg.word1 + '|' + bg.word2;
        if (seenBigram[key]) return;
        seenBigram[key] = true;
        var bothPresent = _inText(plainText, bg.word1) && _inText(plainText, bg.word2);
        if (bothPresent) bigramPresent.push(bg);
        else bigramMissing.push(bg);
      });
    }
    checkBigrams(d.bigrams);
    // mainTopics / missingEntities may also contain bigram-format strings
    checkBigrams(d.mainTopics);
    checkBigrams(d.missingEntities);

    var totalSingle = singlePresent.length + singleMissing.length;
    var totalBigram = bigramPresent.length + bigramMissing.length;
    var totalAll = totalSingle + totalBigram;

    if (totalAll === 0) {
      coverageBody.innerHTML = '<p class="aiedit-empty">No entities found in InfraNodus data. Run analysis in the InfraNodus tab first.</p>';
      return;
    }

    var presentAll = singlePresent.length + bigramPresent.length;
    var ratio = Math.round((presentAll / totalAll) * 100);
    var barClass = ratio >= 70 ? '' : (ratio >= 40 ? 'warn' : 'low');
    var ratioColor = ratio >= 70 ? '#22c55e' : (ratio >= 40 ? '#eab308' : '#ef4444');

    var html = '';

    // Summary bar
    html += '<div class="aiedit-coverage-summary">' +
      '<div class="aiedit-coverage-summary-label">' +
        '<span>Entity Coverage</span>' +
        '<strong style="color:' + ratioColor + '">' + ratio + '%</strong>' +
      '</div>' +
      '<div class="aiedit-coverage-bar-bg">' +
        '<div class="aiedit-coverage-bar-fill ' + barClass + '" style="width:' + ratio + '%"></div>' +
      '</div>' +
      '<div style="font-size:11px; color:var(--text-muted); margin-top:4px;">' +
        presentAll + ' of ' + totalAll + ' entities/concepts found in content' +
      '</div>' +
    '</div>';

    // ── Present ──────────────────────────────────────────────────────────
    if (singlePresent.length || bigramPresent.length) {
      html += '<div class="aiedit-entity-section">' +
        '<div class="aiedit-entity-section-title">&#9989; In Content (' + presentAll + ')</div>' +
        '<div class="aiedit-entity-list">';
      singlePresent.forEach(function (e) {
        html += '<span class="aiedit-entity-tag present">&#10003; ' + escapeHtml(e) + '</span>';
      });
      bigramPresent.forEach(function (bg) {
        html += '<span class="aiedit-entity-tag present" title="Concept pair both present">&#10003; ' + escapeHtml(bg.display) + '</span>';
      });
      html += '</div></div>';
    }

    // ── Missing single entities ──────────────────────────────────────────
    var missingCount = singleMissing.length + bigramMissing.length;
    if (missingCount) {
      html += '<div class="aiedit-entity-section">' +
        '<div class="aiedit-entity-section-title">&#10060; Missing (' + missingCount + ')</div>' +
        '<div class="aiedit-entity-list">';

      singleMissing.forEach(function (e) {
        html += '<span class="aiedit-entity-tag missing">' + escapeHtml(e) +
          '<button class="aiedit-add-btn" title="Add via AI" ' +
            'data-click="addEntityToContent" data-entity="' + escapeHtml(e) + '" data-draft-id="' + draftId + '">' +
            '+ Add</button></span>';
      });

      bigramMissing.forEach(function (bg) {
        html += '<span class="aiedit-entity-tag missing" title="Both words missing or not co-occurring">' +
          escapeHtml(bg.display) +
          '<button class="aiedit-add-btn" title="Add via AI" ' +
            'data-click="addEntityToContent" data-entity="' + escapeHtml(bg.aiLabel) + '" data-draft-id="' + draftId + '">' +
            '+ Add</button></span>';
      });

      html += '</div>';

      if (missingCount > 1) {
        html += '<div class="aiedit-add-all-bar">' +
          '<span class="note">Use AI to naturally weave in all missing entities</span>' +
          '<button class="btn btn-xs btn-purple" data-click="addAllMissingEntities" data-draft-id="' + draftId + '">' +
            '&#129302; Add All Missing' +
          '</button>' +
        '</div>';
      }
      html += '</div>';
    }

    // ── SEO Advice ────────────────────────────────────────────────────────
    var hasSeo = d.rankingAdvice || d.intentAdvice || d.gapAdvice;
    if (hasSeo) {
      html += '<div class="aiedit-intel-section">' +
        '<div class="aiedit-intel-title">&#128200; SEO Intelligence' +
          (d.targetKeyword ? ' <span style="color:#a855f7;font-weight:normal;text-transform:none;font-size:11px;">— ' + escapeHtml(d.targetKeyword) + '</span>' : '') +
        '</div>' +
        '<div class="aiedit-seo-grid">';
      if (d.rankingAdvice) {
        html += '<div class="aiedit-seo-card ranking">' +
          '<div class="aiedit-seo-card-label">&#128269; What ranks</div>' +
          escapeHtml(d.rankingAdvice.slice(0, 180)) + (d.rankingAdvice.length > 180 ? '…' : '') +
          '<button class="aiedit-use-btn" style="display:block;margin-top:5px;" ' +
            'data-instr="Adjust the article to better match what currently ranks well: ' + escapeHtml(d.rankingAdvice.slice(0, 120).replace(/"/g, "'")) + '">Use</button>' +
        '</div>';
      }
      if (d.intentAdvice) {
        html += '<div class="aiedit-seo-card intent">' +
          '<div class="aiedit-seo-card-label">&#127919; Search intent</div>' +
          escapeHtml(d.intentAdvice.slice(0, 180)) + (d.intentAdvice.length > 180 ? '…' : '') +
          '<button class="aiedit-use-btn" style="display:block;margin-top:5px;" ' +
            'data-instr="Rewrite to better match reader search intent: ' + escapeHtml(d.intentAdvice.slice(0, 120).replace(/"/g, "'")) + '">Use</button>' +
        '</div>';
      }
      if (d.gapAdvice) {
        html += '<div class="aiedit-seo-card gap">' +
          '<div class="aiedit-seo-card-label">&#128161; Content gap</div>' +
          escapeHtml(d.gapAdvice.slice(0, 180)) + (d.gapAdvice.length > 180 ? '…' : '') +
          '<button class="aiedit-use-btn" style="display:block;margin-top:5px;" ' +
            'data-instr="Add a new section covering this SEO content gap: ' + escapeHtml(d.gapAdvice.slice(0, 120).replace(/"/g, "'")) + '">Use</button>' +
        '</div>';
      }
      html += '</div></div>';
    }

    // ── Content Gaps ──────────────────────────────────────────────────────
    if (d.contentGaps && d.contentGaps.length) {
      html += '<div class="aiedit-intel-section">' +
        '<div class="aiedit-intel-title">&#128269; Content Gaps</div>';
      d.contentGaps.slice(0, 6).forEach(function (gap) {
        var instr = 'Add a section or paragraph about: ' + gap;
        html += '<div class="aiedit-gap-item">' +
          '<span class="aiedit-gap-text">' + escapeHtml(gap) + '</span>' +
          '<button class="aiedit-use-btn" data-instr="' + escapeHtml(instr) + '">Use</button>' +
        '</div>';
      });
      html += '</div>';
    }

    // ── Research Questions ────────────────────────────────────────────────
    if (d.researchQuestions && d.researchQuestions.length) {
      html += '<div class="aiedit-intel-section">' +
        '<div class="aiedit-intel-title">&#10067; Research Questions</div>';
      d.researchQuestions.slice(0, 5).forEach(function (q) {
        var instr = 'Add a paragraph that clearly answers this question: ' + q;
        html += '<div class="aiedit-gap-item">' +
          '<span class="aiedit-gap-text">' + escapeHtml(q) + '</span>' +
          '<button class="aiedit-use-btn" data-instr="' + escapeHtml(instr) + '">Use</button>' +
        '</div>';
      });
      html += '</div>';
    }

    // ── Related Queries ───────────────────────────────────────────────────
    if (d.relatedQueries && d.relatedQueries.length) {
      html += '<div class="aiedit-intel-section">' +
        '<div class="aiedit-intel-title">&#128279; Related Queries</div>' +
        '<div class="aiedit-query-chips">';
      d.relatedQueries.slice(0, 8).forEach(function (q) {
        var instr = 'Naturally mention and address the related query: "' + q + '"';
        html += '<button class="aiedit-query-chip" data-instr="' + escapeHtml(instr) + '">' + escapeHtml(q) + '</button>';
      });
      html += '</div></div>';
    }

    // ── Demand Topics ─────────────────────────────────────────────────────
    if (d.demandTopics && d.demandTopics.length) {
      html += '<div class="aiedit-intel-section">' +
        '<div class="aiedit-intel-title">&#128293; High-Demand Topics</div>' +
        '<div class="aiedit-query-chips">';
      d.demandTopics.slice(0, 6).forEach(function (t) {
        var instr = 'Add content about this high-demand topic: "' + t + '"';
        html += '<button class="aiedit-query-chip" data-instr="' + escapeHtml(instr) + '">' + escapeHtml(t) + '</button>';
      });
      html += '</div></div>';
    }

    coverageBody.innerHTML = html;

    // Wire up all "Use" buttons and query chips in the coverage panel
    coverageBody.querySelectorAll('[data-instr]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var instrInput = document.getElementById('aiedit-instruction');
        if (instrInput) { instrInput.value = btn.dataset.instr; instrInput.focus(); }
        showToast('Instruction set — click AI Edit to apply', 'info');
      });
    });

    // Inject keyword quick-action chip if we have a target keyword
    if (d.targetKeyword) {
      var chipsEl = document.getElementById('aiedit-quick-chips');
      if (chipsEl && !chipsEl.querySelector('.keyword-chip')) {
        var kwChip = document.createElement('button');
        kwChip.className = 'aiedit-chip keyword-chip';
        kwChip.dataset.instruction = 'Optimize the article to better target the keyword "' + d.targetKeyword + '". Use it naturally in headings and the first paragraph without keyword stuffing.';
        kwChip.textContent = '&#128269; Target: ' + d.targetKeyword;
        kwChip.innerHTML = '&#128269; Target: ' + escapeHtml(d.targetKeyword);
        chipsEl.appendChild(kwChip);
      }
    }
  }

  function addEntityToContent(entity, draftId) {
    var instrInput = document.getElementById('aiedit-instruction');
    if (!instrInput) return;
    // Context-aware instruction — if entity looks like a concept pair, phrase it differently
    var instr = entity.indexOf('"') !== -1
      ? 'Naturally weave in the concept pair ' + entity + ' into the article where they appear together meaningfully.'
      : 'Naturally weave the entity "' + entity + '" into the article where it fits best without disrupting the flow.';
    instrInput.value = instr;
    // Auto-apply immediately
    applyAIPatch();
  }

  function addAllMissingEntities(draftId) {
    // Collect every missing entity from the coverage panel
    var missing = [];
    document.querySelectorAll('.aiedit-entity-tag.missing').forEach(function (el) {
      var addBtn = el.querySelector('.aiedit-add-btn');
      if (addBtn && addBtn.dataset.entity) missing.push(addBtn.dataset.entity);
    });
    if (!missing.length) { showToast('No missing entities found', 'info'); return; }

    var instrInput = document.getElementById('aiedit-instruction');
    if (!instrInput) return;

    // Build a single instruction covering all missing entities
    instrInput.value = 'Naturally weave ALL of these missing entities into the article — each where it fits best without disrupting flow: ' + missing.join(', ');

    // Apply immediately — no manual "AI Edit" click needed
    applyAIPatch();
  }

  // Expose for dispatch table
  window.__applyAIPatch = applyAIPatch;
  window.__checkEntityCoverage = checkEntityCoverage;
  window.__addEntityToContent = addEntityToContent;
  window.__addAllMissingEntities = addAllMissingEntities;
  window.__initAiEditTab = initAiEditTab;

  // ─── Batch Action Bar (Manual Cluster from Feed / Drafts) ─────────
  function _getBatchSelectionCount() {
    if (state.currentPage === 'feed') return selectedCount;
    if (state.currentPage === 'published') return _selectedDraftCount;
    return 0;
  }

  function updateBatchActions() {
    var count = _getBatchSelectionCount();
    var bar = document.getElementById('batch-action-bar');
    var isOnDraftsPage = state.currentPage === 'published';
    var btnAction = isOnDraftsPage ? 'mergeIntoCluster' : 'createManualCluster';
    var btnLabel = isOnDraftsPage ? 'Merge into Cluster' : 'Create Cluster';
    var label = isOnDraftsPage ? 'drafts selected' : 'articles selected';

    if (count >= 2 && (state.currentPage === 'feed' || state.currentPage === 'published')) {
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'batch-action-bar';
        bar.className = 'batch-action-bar';
        document.body.appendChild(bar);
      }
      bar.innerHTML =
        '<span id="batch-count">' + count + ' ' + label + '</span>' +
        '<input type="text" id="batch-cluster-topic" placeholder="Cluster topic (optional)" class="batch-input" />' +
        '<button class="btn btn-primary btn-sm" data-click="' + btnAction + '">' + btnLabel + '</button>' +
        '<button class="btn btn-outline btn-sm" data-click="clearBatchSelection">Clear</button>';
      bar.style.display = 'flex';
    } else if (bar) {
      bar.style.display = 'none';
    }
  }

  function createManualCluster() {
    var articleIds = [];
    for (var k in selectedArticles) {
      if (Object.prototype.hasOwnProperty.call(selectedArticles, k)) {
        var a = selectedArticles[k];
        if (a && a.id != null) {
          var idNum = parseInt(a.id, 10);
          if (!isNaN(idNum)) articleIds.push(idNum);
        }
      }
    }
    var topicEl = document.getElementById('batch-cluster-topic');
    var topic = topicEl ? topicEl.value : '';

    if (articleIds.length < 2) {
      showToast('Select at least 2 articles', 'error');
      return;
    }

    fetchApi('/api/clusters/manual', {
      method: 'POST',
      body: { articleIds: articleIds, topic: topic || undefined }
    })
      .then(function (data) {
        if (data && data.success) {
          showToast('Cluster created: ' + data.articleCount + ' articles → Cluster #' + data.clusterId, 'success');
          clearBatchSelection();
          navigateTo('clusters');
        } else {
          showToast((data && data.error) || 'Failed to create cluster', 'error');
        }
      })
      .catch(function (err) {
        showToast('Failed: ' + (err.message || String(err)), 'error');
      });
  }

  function mergeIntoCluster() {
    var draftIds = [];
    for (var k in _selectedDraftIds) {
      if (_selectedDraftIds[k]) {
        var idNum = parseInt(k, 10);
        if (!isNaN(idNum)) draftIds.push(idNum);
      }
    }
    var topicEl = document.getElementById('batch-cluster-topic');
    var topic = topicEl ? topicEl.value : '';

    if (draftIds.length < 2) {
      showToast('Select at least 2 drafts', 'error');
      return;
    }

    fetchApi('/api/clusters/manual-from-drafts', {
      method: 'POST',
      body: { draftIds: draftIds, topic: topic || undefined }
    })
      .then(function (data) {
        if (data && data.success) {
          var msg = 'Cluster #' + data.clusterId + ' created from ' + data.draftCount + ' drafts';
          if (data.movedFromClusters) msg += ' (' + data.movedFromClusters + ' moved from existing clusters)';
          showToast(msg, 'success');
          clearBatchSelection();
          navigateTo('clusters');
        } else {
          showToast((data && data.error) || 'Failed to create cluster', 'error');
        }
      })
      .catch(function (err) {
        showToast('Failed: ' + (err.message || String(err)), 'error');
      });
  }

  function clearBatchSelection() {
    if (state.currentPage === 'feed' && typeof clearSelection === 'function') {
      clearSelection();
    }
    if (state.currentPage === 'published') {
      _selectedDraftIds = {};
      _selectedDraftCount = 0;
      var cbs = document.querySelectorAll('.draft-select-checkbox');
      for (var i = 0; i < cbs.length; i++) { cbs[i].checked = false; }
      if (typeof _updateSelectUI === 'function') _updateSelectUI();
    }
    var bar = document.getElementById('batch-action-bar');
    if (bar) bar.style.display = 'none';
  }

  window.__updateBatchActions = updateBatchActions;
  window.__createManualCluster = createManualCluster;
  window.__mergeIntoCluster = mergeIntoCluster;
  window.__clearBatchSelection = clearBatchSelection;

  // ─── Draft Versions ────────────────────────────────────────────────
  // Loads version history into the editor's version bar. Shows the bar
  // only if at least one version exists. Restoring an old version creates
  // a new version row (so restores are also tracked).
  function loadVersions(draftId) {
    var bar = $('editor-version-bar');
    var sel = $('editor-version-select');
    var restoreBtn = $('editor-version-restore');
    var currentTag = $('editor-version-current-tag');
    if (!bar || !sel) return;

    fetchApi('/api/drafts/' + draftId + '/versions')
      .then(function (res) {
        if (!res || !res.success) {
          bar.style.display = 'none';
          return;
        }
        var versions = res.versions || [];
        var currentVersion = res.current_version || 0;

        if (versions.length === 0) {
          bar.style.display = 'none';
          return;
        }

        bar.style.display = 'flex';
        sel.innerHTML = '';
        for (var i = 0; i < versions.length; i++) {
          var v = versions[i];
          var label = 'v' + v.version + ' \u2014 ' +
                      (v.rewritten_word_count || '?') + ' words \u2014 ' +
                      (v.ai_model_used || '?') + ' \u2014 ' +
                      (v.created_at || '');
          var opt = document.createElement('option');
          opt.value = String(v.version);
          opt.textContent = label;
          if (v.version === currentVersion) opt.selected = true;
          sel.appendChild(opt);
        }

        if (currentTag) currentTag.textContent = 'current: v' + currentVersion;

        // Show restore only when a non-current version is selected
        function syncRestore() {
          var picked = parseInt(sel.value, 10);
          if (restoreBtn) {
            restoreBtn.style.display = (picked && picked !== currentVersion) ? '' : 'none';
          }
        }
        sel.onchange = function () {
          var picked = parseInt(sel.value, 10);
          syncRestore();
          if (!picked) return;
          // Preview the picked version inline (HTML editor + preview iframe)
          sel.disabled = true;
          if (currentTag) currentTag.textContent = 'loading v' + picked + '...';
          fetchApi('/api/drafts/' + draftId + '/versions/' + picked)
            .then(function (vr) {
              sel.disabled = false;
              if (currentTag) currentTag.textContent = picked === currentVersion ? 'current: v' + currentVersion : 'viewing v' + picked + ' (current: v' + currentVersion + ')';
              if (!vr || !vr.success || !vr.version) {
                showToast('Version data not found', 'error');
                return;
              }
              var html = vr.version.rewritten_html || '';
              var htmlEd = $('html-code-editor');
              if (htmlEd) htmlEd.value = html;
              updatePreviewIframe(html);
            })
            .catch(function (err) {
              sel.disabled = false;
              if (currentTag) currentTag.textContent = 'current: v' + currentVersion;
              showToast('Failed to load version: ' + (err && err.message ? err.message : 'network error'), 'error');
            });
        };
        syncRestore();

        if (restoreBtn) {
          restoreBtn.onclick = function () {
            var picked = parseInt(sel.value, 10);
            if (!picked || picked === currentVersion) return;
            if (!confirm('Restore version ' + picked + '? This creates a new version on top of the current one.')) return;
            fetchApi('/api/drafts/' + draftId + '/versions/' + picked + '/restore', { method: 'POST' })
              .then(function (rr) {
                if (!rr || !rr.success) {
                  showToast('Restore failed', 'error');
                  return;
                }
                showToast('Restored v' + picked + ' as v' + rr.new_version, 'success');
                // Reload editor + version list
                openEditor(draftId);
              })
              .catch(function (err) {
                showToast('Restore failed: ' + err.message, 'error');
              });
          };
        }
      })
      .catch(function () {
        bar.style.display = 'none';
      });
  }

  var EDITOR_TAB_MAP = {
    source: 'tab-source',
    settings: 'tab-settings',
    'ai-output': 'tab-ai-output',
    'html-editor': 'tab-html-editor',
    preview: 'tab-preview',
    'ai-edit': 'tab-ai-edit',
    infranodus: 'tab-infranodus',
    'wp-publish': 'tab-wp-publish'
  };
  var EDITOR_DEFAULT_TABS = { source: true, 'ai-output': true };

  function resetEditorTabs() {
    var leftTabs = document.querySelectorAll('.editor-left .editor-tab');
    for (var i = 0; i < leftTabs.length; i++) leftTabs[i].classList.toggle('active', leftTabs[i].getAttribute('data-tab') === 'source');
    var rightTabs = document.querySelectorAll('.editor-right .editor-tab');
    for (var j = 0; j < rightTabs.length; j++) rightTabs[j].classList.toggle('active', rightTabs[j].getAttribute('data-tab') === 'ai-output');
    for (var key in EDITOR_TAB_MAP) {
      var el = $(EDITOR_TAB_MAP[key]);
      if (el) el.style.display = EDITOR_DEFAULT_TABS[key] ? '' : 'none';
    }
  }

  function getStatusColor(status) {
    var colors = { fetching: '#f59e0b', draft: '#4a7aff', editing: '#8b5cf6', rewriting: '#a855f7', ready: '#22c55e', published: '#6b7280' };
    return colors[status] || '#6b7280';
  }

  function updatePreviewIframe(html) {
    var iframe = $('preview-iframe');
    if (!iframe) return;
    // Wrap the rewritten HTML in a minimal CSS shell so the v2 structured
    // blocks (.hdf-in-brief, .hdf-body, .hdf-faqs) render attractively in
    // the preview iframe. WordPress themes style these on the live site.
    var css =
      'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;' +
      'max-width:720px;margin:24px auto;padding:0 24px;line-height:1.65;color:#1a1a1a;background:#fff}' +
      'h1,h2,h3{font-weight:700;color:#111;line-height:1.3}' +
      'h2{font-size:22px;margin:28px 0 12px}' +
      'h3{font-size:17px;margin:20px 0 8px}' +
      'p{margin:0 0 14px;font-size:16px}' +
      'a{color:#4a7aff;text-decoration:none}' +
      'a:hover{text-decoration:underline}' +
      '.hdf-in-brief{background:#f4f6fb;border-left:4px solid #4a7aff;padding:14px 18px;' +
      'margin:20px 0;border-radius:6px}' +
      '.hdf-in-brief h2{margin:0 0 8px;font-size:13px;text-transform:uppercase;' +
      'letter-spacing:0.06em;color:#4a7aff}' +
      '.hdf-in-brief ul{margin:0;padding-left:20px}' +
      '.hdf-in-brief li{margin:6px 0;font-size:15px}' +
      '.hdf-body{margin:20px 0}' +
      '.hdf-faqs{margin-top:36px;border-top:2px solid #eee;padding-top:20px}' +
      '.hdf-faqs > h2{font-size:20px;margin-top:0}' +
      '.hdf-faq-item{margin:16px 0;padding:14px 16px;background:#fafafa;border-radius:6px}' +
      '.hdf-faq-item h3{margin:0 0 6px;font-size:15px;color:#222}' +
      '.hdf-faq-item p{margin:0;font-size:14px;color:#444}';
    iframe.srcdoc =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><style>' + css + '</style></head><body>' +
      html + '</body></html>';
  }

  // Click-to-expand compact previews (delegated)
  document.addEventListener('click', function (e) {
    var preview = e.target.closest('.compact-preview');
    if (preview) {
      e.stopPropagation();
      preview.classList.toggle('expanded');
    }
  });

  // Tab switching (delegated)
  document.addEventListener('click', function (e) {
    if (!e.target.classList.contains('editor-tab')) return;
    var panel = e.target.getAttribute('data-panel');
    var tab = e.target.getAttribute('data-tab');
    if (!panel || !tab) return;

    // Deactivate sibling tabs
    var siblings = e.target.parentElement.querySelectorAll('.editor-tab');
    for (var i = 0; i < siblings.length; i++) siblings[i].classList.remove('active');
    e.target.classList.add('active');

    // Show/hide content
    var parent = panel === 'left' ? document.querySelector('.editor-left') : document.querySelector('.editor-right');
    var contents = parent.querySelectorAll('.editor-tab-content');
    for (var j = 0; j < contents.length; j++) contents[j].style.display = 'none';

    var target = $(EDITOR_TAB_MAP[tab]);
    if (target) target.style.display = '';

    if (tab === 'preview') {
      updatePreviewIframe($('html-code-editor').value);
    }

    // Exit full view when switching away from AI Edit tab
    if (tab !== 'ai-edit') {
      var panels = document.querySelector('.editor-panels');
      if (panels && panels.classList.contains('aiedit-fullview')) {
        panels.classList.remove('aiedit-fullview');
        var expandBtn = document.getElementById('aiedit-expand-btn');
        if (expandBtn) { expandBtn.classList.remove('active'); expandBtn.innerHTML = '&#x26F6; Full View'; }
      }
    }
  });

  // Editor button handlers (attached once on init)
  function initEditorButtons() {
    var backBtn = $('editorBackBtn');
    if (backBtn) backBtn.onclick = closeEditor;

    var rewriteBtn = $('editorRewriteBtn');
    if (rewriteBtn) {
      rewriteBtn.onclick = function () {
        if (!currentDraftId) return;
        saveEditorSettings();

        var customPrompt = $('setting-custom-prompt').value.trim();
        var reqBody = { custom_prompt: customPrompt };

        // Per-article AI overrides
        var editorProvider = $('editor-provider');
        var editorModel = $('editor-model');
        if (editorProvider && editorProvider.value !== 'default') {
          reqBody.provider = editorProvider.value;
          if (editorModel && editorModel.value) {
            reqBody.model = editorModel.value;
          }
        }

        $('editor-status').textContent = 'REWRITING...';
        $('editor-status').style.background = '#a855f7';
        $('ai-output-content').innerHTML = '<p style="color:#a855f7;">&#129302; AI is rewriting... This may take 30-60 seconds.</p>';

        fetchApi('/api/drafts/' + currentDraftId + '/rewrite', {
          method: 'POST',
          body: reqBody
        })
          .then(function (data) {
            if (data.success) pollEditorRewriteStatus(currentDraftId);
            else {
              $('ai-output-content').innerHTML = '<p style="color:var(--red);">Rewrite failed: ' + escapeHtml(data.error || 'Unknown') + '</p>';
              $('editor-status').textContent = 'DRAFT';
              $('editor-status').style.background = '#4a7aff';
            }
          })
          .catch(function (err) {
            $('ai-output-content').innerHTML = '<p style="color:var(--red);">Network error: ' + escapeHtml(err.message) + '</p>';
          });
      };
    }

    // Editor provider/model toggle
    var editorProviderEl = $('editor-provider');
    if (editorProviderEl) {
      var AI_MODELS = {
        anthropic: [
          { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (Fast)' },
          { value: 'claude-sonnet-4-20250514', label: 'Claude Sonnet 4' },
          { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (Balanced)' },
          { value: 'claude-opus-4-20250514', label: 'Claude Opus 4' },
          { value: 'claude-opus-4-6', label: 'Claude Opus 4.6 (Best)' },
        ],
        openai: [
          { value: 'gpt-4o-mini', label: 'GPT-4o Mini (Fast)' },
          { value: 'gpt-4.1', label: 'GPT-4.1 (Latest)' },
          { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini (Latest Fast)' },
          { value: 'gpt-4.1-nano', label: 'GPT-4.1 Nano (Cheapest)' },
          { value: 'o3', label: 'O3 (Reasoning)' },
          { value: 'o3-mini', label: 'O3 Mini (Reasoning Fast)' },
          { value: 'o4-mini', label: 'O4 Mini (Latest Reasoning)' },
        ],
        // OpenRouter populated dynamically from /api/ai/models (cached on window)
        openrouter: [],
      };
      // Helper: render a list of models into the editor-model <select>
      var renderEditorModelOptions = function (modelSelect, list) {
        if (!modelSelect) return;
        var optHtml = '';
        for (var m = 0; m < list.length; m++) {
          optHtml += '<option value="' + list[m].value + '">' + list[m].label + '</option>';
        }
        modelSelect.innerHTML = optHtml || '<option value="">No models available</option>';
      };

      editorProviderEl.addEventListener('change', function () {
        var prov = editorProviderEl.value;
        var modelChoice = $('editor-model-choice');
        var modelSelect = $('editor-model');
        if (prov === 'default') {
          if (modelChoice) modelChoice.style.display = 'none';
          return;
        }
        if (modelChoice) modelChoice.style.display = '';

        if (prov === 'openrouter') {
          // Use cached list if available
          if (window.__openrouterModels && window.__openrouterModels.length > 0) {
            AI_MODELS.openrouter = window.__openrouterModels.map(function (m) {
              return { value: m.id, label: m.name + (m.tier ? ' — ' + m.tier : '') };
            });
            renderEditorModelOptions(modelSelect, AI_MODELS.openrouter);
          } else {
            // Fetch on demand — show loading state, then populate when ready
            if (modelSelect) modelSelect.innerHTML = '<option value="">Loading free models…</option>';
            __loadOpenRouterModels().then(function () {
              if (window.__openrouterModels && window.__openrouterModels.length > 0) {
                AI_MODELS.openrouter = window.__openrouterModels.map(function (m) {
                  return { value: m.id, label: m.name + (m.tier ? ' — ' + m.tier : '') };
                });
              }
              renderEditorModelOptions(modelSelect, AI_MODELS.openrouter);
            }).catch(function () {
              renderEditorModelOptions(modelSelect, []);
            });
          }
          return;
        }

        // Anthropic / OpenAI — static lists
        if (AI_MODELS[prov]) {
          renderEditorModelOptions(modelSelect, AI_MODELS[prov]);
        }
      });
    }

    var saveBtn = $('editorSaveBtn');
    if (saveBtn) {
      saveBtn.onclick = function () {
        if (!currentDraftId) return;
        var html = $('html-code-editor').value;
        fetchApi('/api/drafts/' + currentDraftId, { method: 'PUT', body: { status: 'ready' } })
          .then(function () { return fetchApi('/api/drafts/' + currentDraftId + '/html', { method: 'PUT', body: { html: html } }); })
          .then(function () { showToast('Draft saved', 'success'); })
          .catch(function (err) { showToast('Save failed: ' + err.message, 'error'); });
      };
    }

    var downloadBtn = $('editorDownloadBtn');
    if (downloadBtn) {
      downloadBtn.onclick = function () {
        var html = $('html-code-editor').value;
        if (!html) { showToast('No HTML to download', 'error'); return; }
        var keyword = $('setting-keyword').value || 'article';
        var slug = keyword.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
        var blob = new Blob([html], { type: 'text/html' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a'); a.href = url; a.download = slug + '.html'; a.click();
        URL.revokeObjectURL(url);
      };
    }

    var copyBloggerBtn = $('editorCopyBloggerBtn');
    if (copyBloggerBtn) {
      copyBloggerBtn.onclick = function () {
        var html = $('html-code-editor').value;
        if (!html) { showToast('No HTML to convert', 'error'); return; }
        fetchApi('/api/drafts/' + currentDraftId + '/blogger-xml', { method: 'POST', body: { html: html } })
          .then(function (data) {
            if (data.success && data.xml) {
              navigator.clipboard.writeText(data.xml)
                .then(function () { showToast('Blogger XML copied to clipboard!', 'success'); })
                .catch(function () { showToast('Clipboard access denied', 'error'); });
            } else {
              navigator.clipboard.writeText(html)
                .then(function () { showToast('HTML copied (Blogger conversion not available)', 'info'); })
                .catch(function () { showToast('Clipboard access denied', 'error'); });
            }
          })
          .catch(function () {
            navigator.clipboard.writeText(html)
              .then(function () { showToast('HTML copied to clipboard', 'info'); })
              .catch(function () { showToast('Clipboard access denied', 'error'); });
          });
      };
    }

    var previewTabBtn = $('editorPreviewTabBtn');
    if (previewTabBtn) {
      previewTabBtn.onclick = function () {
        var html = $('html-code-editor').value;
        if (!html) { showToast('No HTML to preview', 'error'); return; }
        var blob = new Blob([html], { type: 'text/html' });
        var blobUrl = URL.createObjectURL(blob);
        var win = window.open(blobUrl, '_blank', 'noopener,noreferrer');
        if (!win) { URL.revokeObjectURL(blobUrl); showToast('Popup blocked by browser', 'error'); return; }
        setTimeout(function () { URL.revokeObjectURL(blobUrl); }, 10000);
      };
    }

    var publishBtn = $('editorPublishBtn');
    if (publishBtn) {
      // Set initial label based on whether draft is already on WP
      if (currentDraft && currentDraft.wp_post_id) {
        publishBtn.innerHTML = '&#8635; Update on WP';
      } else {
        publishBtn.innerHTML = '&#128640; Publish';
      }

      publishBtn.onclick = function () {
        if (publishBtn.disabled) return;
        if (!currentDraftId) return;
        var platform = $('setting-platform').value;
        var html = $('html-code-editor').value;
        if (!html) { showToast('No HTML content to publish', 'error'); return; }
        var isUpdate = !!(currentDraft && currentDraft.wp_post_id);
        var confirmMsg = isUpdate
          ? 'Update the existing WordPress post with new content?'
          : 'Publish this draft to ' + platform + '?';
        if (!confirm(confirmMsg)) return;

        publishBtn.disabled = true;
        publishBtn.textContent = isUpdate ? 'Updating...' : 'Publishing...';
        $('editor-status').textContent = 'PUBLISHING...';
        $('editor-status').style.background = '#f59e0b';

        // Save editor settings first (platform, keyword, etc) then publish
        saveEditorSettings();

        fetchApi('/api/drafts/' + currentDraftId + '/publish', {
          method: 'POST',
          body: { platform: platform, html: html }
        })
          .then(function (data) {
            publishBtn.disabled = false;
            if (data.success) {
              $('editor-status').textContent = 'PUBLISHED';
              $('editor-status').style.background = '#22c55e';
              publishBtn.innerHTML = '&#8635; Update on WP';
              // Update currentDraft so next click shows correct label
              if (currentDraft) currentDraft.wp_post_id = data.wpPostId || currentDraft.wp_post_id;
              var msg = data.wasDeleted
                ? 'WP post was deleted — re-published as new post!' + (data.url ? ' ' + data.url : '')
                : (data.isUpdate ? 'Updated on WordPress!' : 'Published!') + (data.url ? ' ' + data.url : '');
              showToast(msg, 'success');
              var logPanel = $('editorWpLog');
              if (logPanel) logPanel.style.display = 'none';
            } else {
              publishBtn.innerHTML = isUpdate ? '&#8635; Update on WP' : '&#128640; Publish';
              showToast('Publish failed: ' + (data.error || 'Unknown'), 'error');
              $('editor-status').textContent = 'READY';
              $('editor-status').style.background = '#22c55e';
              var logPanel = $('editorWpLog');
              if (logPanel) {
                logPanel.style.display = '';
                loadWpErrorLog('editorWpLogContent');
              }
            }
          })
          .catch(function (err) {
            publishBtn.disabled = false;
            publishBtn.innerHTML = isUpdate ? '&#8635; Update on WP' : '&#128640; Publish';
            showToast('Publish error: ' + err.message, 'error');
            $('editor-status').textContent = 'READY';
            $('editor-status').style.background = '#22c55e';
            var logPanel = $('editorWpLog');
            if (logPanel) {
              logPanel.style.display = '';
              loadWpErrorLog('editorWpLogContent');
            }
          });
      };
    }

    // WP Publish panel button — delegates to the same publish flow as bottom bar
    var wpPublishPanelBtn = $('wpPublishPanelBtn');
    if (wpPublishPanelBtn) {
      wpPublishPanelBtn.onclick = function () {
        var bottomPublishBtn = $('editorPublishBtn');
        if (bottomPublishBtn) bottomPublishBtn.click();
      };
    }

    // AI Recommendation button — calls POST /api/drafts/:id/recommend which
    // re-runs the classifier + resolveTaxonomy against the current draft
    // and returns a live preview of who would author/categorize this article
    // if the Publish button were clicked right now.
    var recommendBtn = $('editor-recommend-btn');
    if (recommendBtn) {
      recommendBtn.onclick = function () {
        if (!currentDraftId) return;
        var resultEl = $('editor-recommend-result');
        recommendBtn.disabled = true;
        recommendBtn.innerHTML = '<svg data-lucide="loader" class="icon"></svg> Analyzing...';
        _refreshIcons();

        fetchApi('/api/drafts/' + currentDraftId + '/recommend', { method: 'POST', cacheMs: 0 })
          .then(function (resp) {
            recommendBtn.disabled = false;
            recommendBtn.innerHTML = '<svg data-lucide="sparkles" class="icon"></svg> Get AI Recommendation';
            _refreshIcons();
            if (!resp.ok) {
              showToast('Recommendation failed: ' + (resp.error || 'unknown'), 'error');
              return;
            }
            _renderEditorRecommendation(resp);
            if (resultEl) resultEl.style.display = '';
          })
          .catch(function (err) {
            recommendBtn.disabled = false;
            recommendBtn.innerHTML = '<svg data-lucide="sparkles" class="icon"></svg> Get AI Recommendation';
            _refreshIcons();
            showToast('Recommendation failed: ' + err.message, 'error');
          });
      };
    }

    // Queue for Autopilot button — saves WP overrides then marks draft ready
    var queueBtn = $('editorQueueBtn');
    if (queueBtn) {
      queueBtn.onclick = function () {
        if (queueBtn.disabled) return;
        if (!currentDraftId) return;
        var html = $('html-code-editor').value;
        if (!html) { showToast('No HTML content — run AI Rewrite first', 'error'); return; }
        if (!confirm('Queue this article for Autopilot? It will be published automatically on the next publish cycle.')) return;

        queueBtn.disabled = true;
        queueBtn.textContent = 'Queuing...';

        // Save WP overrides first so they persist when autopilot publishes
        saveEditorSettings();

        fetchApi('/api/drafts/' + currentDraftId + '/queue', { method: 'POST' })
          .then(function (data) {
            queueBtn.disabled = false;
            if (data.ok) {
              queueBtn.innerHTML = '<svg data-lucide="check" class="icon"></svg> Queued';
              $('editor-status').textContent = 'READY';
              $('editor-status').style.background = '#22c55e';
              if (currentDraft) currentDraft.status = 'ready';
              showToast('Queued for Autopilot — will publish on next cycle', 'success');
              _refreshIcons();
            } else {
              queueBtn.innerHTML = '<svg data-lucide="list-plus" class="icon"></svg> Queue for Autopilot';
              showToast('Queue failed: ' + (data.error || 'Unknown'), 'error');
              _refreshIcons();
            }
          })
          .catch(function (err) {
            queueBtn.disabled = false;
            queueBtn.innerHTML = '<svg data-lucide="list-plus" class="icon"></svg> Queue for Autopilot';
            showToast('Queue failed: ' + err.message, 'error');
            _refreshIcons();
          });
      };
    }
  }

  // Renders the POST /api/drafts/:id/recommend response into the
  // #editor-recommend-result container. Shows two sections:
  //   1. Classifier's raw suggestion (what the keyword scoring thinks)
  //   2. Resolved routing (what would ACTUALLY happen at publish time,
  //      which accounts for per-draft overrides + matching publish rules +
  //      slug-based fallbacks + numeric global defaults)
  // Adds an "Apply to override selects" button that writes the suggestion
  // into the form fields (WP categories/tags/author) WITHOUT saving.
  function _renderEditorRecommendation(resp) {
    var resultEl = $('editor-recommend-result');
    if (!resultEl) return;

    var cs = resp.classifier_suggestion || {};
    var rv = resp.resolved || {};

    var sourceLabel;
    if (rv.source === 'draft_override') sourceLabel = 'Per-draft override active';
    else if (rv.source === 'rule_engine') sourceLabel = 'Will use publish rule match / fallback';
    else sourceLabel = 'Will use global defaults';

    var html = '';

    // Header: what the publisher would actually do right now
    html += '<div class="recommend-resolved">';
    html += '<div class="recommend-section-title"><svg data-lucide="target" class="icon"></svg> What Publish would do right now</div>';
    html += '<div class="recommend-source-pill">' + escapeHtml(sourceLabel) + '</div>';
    html += '<table class="recommend-table"><tbody>';
    html += '<tr><td>Author</td><td><strong>' + escapeHtml(rv.author_name || '(none)') + '</strong>' +
      (rv.author_id ? ' <span class="recommend-id">#' + rv.author_id + '</span>' : '') + '</td></tr>';
    html += '<tr><td>Categories</td><td>' +
      (rv.category_names && rv.category_names.length
        ? rv.category_names.map(function (n) { return '<strong>' + escapeHtml(n) + '</strong>'; }).join(', ')
        : '<em>(none)</em>') + '</td></tr>';
    if (rv.primary_category_name) {
      html += '<tr><td>Primary</td><td><strong>' + escapeHtml(rv.primary_category_name) + '</strong> <small>(drives the permalink)</small></td></tr>';
    }
    html += '<tr><td>Tags</td><td>' +
      (rv.tag_names && rv.tag_names.length
        ? rv.tag_names.map(function (n) { return '<span class="recommend-chip">' + escapeHtml(n) + '</span>'; }).join(' ')
        : '<em>(none)</em>') + '</td></tr>';
    if (rv.post_status) {
      html += '<tr><td>Status</td><td><strong>' + escapeHtml(rv.post_status) + '</strong> <small>(override)</small></td></tr>';
    }
    html += '</tbody></table>';
    html += '</div>';

    // Classifier suggestion (the raw Layer-1 scoring result)
    html += '<div class="recommend-classifier">';
    html += '<div class="recommend-section-title"><svg data-lucide="brain" class="icon"></svg> Classifier suggestion <small>(keyword scoring)</small></div>';
    html += '<table class="recommend-table"><tbody>';
    if (cs.author) {
      var authConf = cs.author.confident ? '<span class="recommend-badge recommend-ok">confident</span>' : '<span class="recommend-badge recommend-weak">low confidence</span>';
      var authCache = cs.author.existed_on_wp ? '' : ' <span class="recommend-badge recommend-warn">not in WP cache</span>';
      html += '<tr><td>Author</td><td><strong>' + escapeHtml(cs.author.display_name) + '</strong> ' +
        '<code>@' + escapeHtml(cs.author.slug) + '</code> ' +
        '<span class="recommend-score">score ' + cs.author.score + '</span> ' + authConf + authCache + '</td></tr>';
    } else {
      html += '<tr><td>Author</td><td><em>No confident match</em></td></tr>';
    }
    if (cs.category) {
      var catConf = cs.category.confident ? '<span class="recommend-badge recommend-ok">confident</span>' : '<span class="recommend-badge recommend-weak">low confidence</span>';
      var catCache = cs.category.existed_on_wp ? '' : ' <span class="recommend-badge recommend-warn">not in WP cache</span>';
      html += '<tr><td>Category</td><td><strong>' + escapeHtml(cs.category.display_name) + '</strong> ' +
        '<code>' + escapeHtml(cs.category.slug) + '</code> ' +
        '<span class="recommend-score">score ' + cs.category.score + '</span> ' + catConf + catCache + '</td></tr>';
    } else {
      html += '<tr><td>Category</td><td><em>No confident match</em></td></tr>';
    }
    if (cs.tags && cs.tags.length) {
      html += '<tr><td>Tags</td><td>' + cs.tags.map(function (t) {
        var cls = t.existed_on_wp ? 'recommend-chip recommend-chip-ok' : 'recommend-chip recommend-chip-new';
        return '<span class="' + cls + '">' + escapeHtml(t.name) + '</span>';
      }).join(' ') + '</td></tr>';
    } else {
      html += '<tr><td>Tags</td><td><em>None matched</em></td></tr>';
    }
    if (cs.match_reasons && cs.match_reasons.length) {
      html += '<tr><td>Why</td><td class="recommend-reasons">' +
        cs.match_reasons.map(function (r) { return escapeHtml(r); }).join(' &middot; ') + '</td></tr>';
    }
    html += '</tbody></table>';
    html += '</div>';

    // Apply button
    html += '<div class="recommend-actions">';
    html += '<button class="btn btn-sm btn-primary" id="editor-recommend-apply-btn" type="button">' +
      '<svg data-lucide="check" class="icon"></svg> Apply to Override Selects</button>';
    html += '<small style="color:var(--text-tertiary);font-size:11px;">Fills the category/tag/author selects below. You still have to click <strong>Save Override</strong>.</small>';
    html += '</div>';

    resultEl.innerHTML = html;
    _refreshIcons();

    // Wire the apply button
    var applyBtn = $('editor-recommend-apply-btn');
    if (applyBtn) {
      applyBtn.onclick = function () {
        _applyRecommendationToSelects(resp);
      };
    }
  }

  // Fills the WP override selects with the classifier's suggestion + the
  // rule engine's tag matches. Does NOT save — admin still needs to click
  // "Save Override" to persist. Skips any ID that isn't in the loaded
  // select options (means taxonomy isn't synced for that one).
  function _applyRecommendationToSelects(resp) {
    var cs = resp.classifier_suggestion || {};
    var rv = resp.resolved || {};

    // Categories — prefer the classifier's single suggestion (with its slug→ID
    // resolution) but also accept the rule engine's list if classifier empty
    var catSel = $('editor-wp-categories');
    var primSel = $('editor-wp-primary-cat');
    var chosenCatIds = [];
    if (cs.category && cs.category.wp_id) {
      chosenCatIds = [cs.category.wp_id];
    } else if (rv.category_ids && rv.category_ids.length) {
      chosenCatIds = rv.category_ids.slice();
    }
    if (catSel && chosenCatIds.length) {
      Array.from(catSel.options).forEach(function (o) {
        o.selected = chosenCatIds.indexOf(Number(o.value)) !== -1;
      });
    }
    if (primSel && chosenCatIds.length) {
      primSel.value = String(chosenCatIds[0]);
    }

    // Tags — use the classifier's matched tags (converted to WP ids where possible)
    var tagSel = $('editor-wp-tags');
    var chosenTagIds = (cs.tags || [])
      .filter(function (t) { return t.wp_id; })
      .map(function (t) { return t.wp_id; });
    if (chosenTagIds.length === 0 && rv.tag_ids && rv.tag_ids.length) {
      chosenTagIds = rv.tag_ids.slice();
    }
    if (tagSel && chosenTagIds.length) {
      Array.from(tagSel.options).forEach(function (o) {
        o.selected = chosenTagIds.indexOf(Number(o.value)) !== -1;
      });
    }

    // Author — prefer classifier slug-resolved ID, fall back to rule-engine's
    var authSel = $('editor-wp-author');
    var chosenAuthId = (cs.author && cs.author.wp_id) || rv.author_id || null;
    if (authSel && chosenAuthId) {
      authSel.value = String(chosenAuthId);
    }

    showToast('Recommendation applied to override selects. Click "Save Override" to persist.', 'success');
  }

  function saveEditorSettings() {
    if (!currentDraftId) return;
    var schemaTypes = [];
    var checkboxes = document.querySelectorAll('#draft-settings-form .checkbox-group input:checked');
    for (var i = 0; i < checkboxes.length; i++) schemaTypes.push(checkboxes[i].value);

    var editorCatSel = document.getElementById('editor-wp-categories');
    var editorTagSel = document.getElementById('editor-wp-tags');
    var editorCatIds = editorCatSel ? Array.from(editorCatSel.selectedOptions).map(function(o){ return Number(o.value); }) : [];
    var editorTagIds = editorTagSel ? Array.from(editorTagSel.selectedOptions).map(function(o){ return Number(o.value); }) : [];
    var editorPrimCat = document.getElementById('editor-wp-primary-cat');
    var editorAuthor = document.getElementById('editor-wp-author');

    fetchApi('/api/drafts/' + currentDraftId, {
      method: 'PUT',
      body: {
        target_keyword: $('setting-keyword').value,
        target_domain: $('setting-domain').value,
        target_platform: $('setting-platform').value,
        target_language: $('setting-language').value,
        schema_types: schemaTypes.join(','),
        custom_ai_instructions: $('setting-custom-prompt') ? $('setting-custom-prompt').value : '',
        wp_category_ids: editorCatIds.length ? JSON.stringify(editorCatIds) : null,
        wp_primary_cat_id: editorPrimCat && editorPrimCat.value ? Number(editorPrimCat.value) : null,
        wp_tag_ids: editorTagIds.length ? JSON.stringify(editorTagIds) : null,
        wp_author_id_override: editorAuthor && editorAuthor.value ? Number(editorAuthor.value) : null,
        wp_post_status_override: (function() { var s = document.getElementById('editor-wp-post-status'); return s && s.value ? s.value : null; })(),
      }
    }).catch(function (err) { showToast('Failed to save settings', 'error'); });
  }

  function pollEditorRewriteStatus(draftId) {
    if (_rewritePollInterval) { clearInterval(_rewritePollInterval); _rewritePollInterval = null; }
    _rewritePollInterval = setInterval(function () {
      fetchApi('/api/drafts/' + draftId)
        .then(function (data) {
          var draft = data.data;
          if (draft.status === 'ready' && draft.rewritten_html) {
            clearInterval(_rewritePollInterval); _rewritePollInterval = null;
            currentDraft = draft;
            $('editor-status').textContent = 'READY';
            $('editor-status').style.background = '#22c55e';
            $('ai-output-content').innerHTML =
              '<p style="color:var(--green);">\u2705 Rewrite complete \u2014 ' + (draft.rewritten_word_count || '?') + ' words (' + (draft.ai_model_used || 'AI') + ')</p>' +
              '<p>Switch to "HTML Editor" to review, or "Preview" to see the final page.</p>';
            $('html-code-editor').value = draft.rewritten_html;
            updatePreviewIframe(draft.rewritten_html);
          } else if (draft.status === 'draft') {
            clearInterval(_rewritePollInterval); _rewritePollInterval = null;
            $('editor-status').textContent = 'DRAFT';
            $('editor-status').style.background = '#4a7aff';
            $('ai-output-content').innerHTML = '<p style="color:var(--red);">Rewrite failed. Check logs for details.</p>';
          }
        })
        .catch(function () { clearInterval(_rewritePollInterval); _rewritePollInterval = null; });
    }, 3000);
    // Timeout after 2 minutes
    setTimeout(function () { if (_rewritePollInterval) { clearInterval(_rewritePollInterval); _rewritePollInterval = null; } }, 120000);
  }

  // ─── Settings Page ──────────────────────────────────────────────────────

  function loadSettings() {
    var form = $('settingsForm');
    var actions = $('settingsActions');
    var saveBtn = $('settingsSaveBtn');

    if (form) form.innerHTML = '<p class="placeholder-text">Loading...</p>';
    if (actions) actions.style.display = 'none';

    fetchApi('/api/settings')
      .then(function (data) {
        renderSettingsForm(form, data.settings || {}, data.config || {});
        if (actions) actions.style.display = '';
      })
      .catch(function (err) {
        if (form) form.innerHTML = '<p class="placeholder-text">Failed to load settings</p>';
        showToast('Failed to load settings: ' + err.message, 'error');
      });

    // Save
    if (saveBtn) {
      saveBtn.onclick = function () {
        var inputs = form.querySelectorAll('[data-setting-key]');
        var updates = {};
        for (var i = 0; i < inputs.length; i++) {
          var key = inputs[i].getAttribute('data-setting-key');
          var val = inputs[i].type === 'checkbox' ? (inputs[i].checked ? 'true' : 'false') : inputs[i].value;
          // Skip masked/placeholder sensitive values (user didn't change them)
          if (inputs[i].type === 'password') {
            if (!val || val === '' || val.indexOf('\u2022') !== -1 || val.indexOf('••••') !== -1) {
              continue;
            }
          }
          updates[key] = val;
        }

        if (Object.keys(updates).length === 0) {
          showToast('No changes to save', 'info');
          return;
        }

        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';

        fetchApi('/api/settings', { method: 'PUT', body: updates })
          .then(function () {
            showToast('Settings saved', 'success');
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Settings';
          })
          .catch(function (err) {
            showToast('Failed to save: ' + err.message, 'error');
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Settings';
          });
      };
    }

    // Test buttons
    initTestButtons();

    // Security — password change
    var changeBtn = $('changePasswordBtn');
    if (changeBtn) {
      changeBtn.onclick = function () {
        var curPwd = $('security-current-password').value;
        var newPwd = $('security-new-password').value;
        var confirmPwd = $('security-confirm-password').value;
        var statusEl = $('security-status');

        statusEl.style.display = 'none';
        if (!curPwd || !newPwd) {
          statusEl.style.display = '';
          statusEl.style.background = '#451a1a'; statusEl.style.color = '#fca5a5';
          statusEl.textContent = 'Please fill in all fields';
          return;
        }
        if (newPwd !== confirmPwd) {
          statusEl.style.display = '';
          statusEl.style.background = '#451a1a'; statusEl.style.color = '#fca5a5';
          statusEl.textContent = 'New passwords do not match';
          return;
        }
        if (newPwd.length < 6) {
          statusEl.style.display = '';
          statusEl.style.background = '#451a1a'; statusEl.style.color = '#fca5a5';
          statusEl.textContent = 'Password must be at least 6 characters';
          return;
        }

        changeBtn.disabled = true;
        changeBtn.textContent = 'Changing...';

        fetchApi('/api/auth/change-password', {
          method: 'POST',
          body: { currentPassword: curPwd, newPassword: newPwd }
        }).then(function () {
          statusEl.style.display = '';
          statusEl.style.background = '#052e16'; statusEl.style.color = '#86efac';
          statusEl.textContent = 'Password changed successfully';
          $('security-current-password').value = '';
          $('security-new-password').value = '';
          $('security-confirm-password').value = '';
          changeBtn.disabled = false;
          changeBtn.textContent = 'Change Password';
        }).catch(function (err) {
          statusEl.style.display = '';
          statusEl.style.background = '#451a1a'; statusEl.style.color = '#fca5a5';
          statusEl.textContent = err.message || 'Failed to change password';
          changeBtn.disabled = false;
          changeBtn.textContent = 'Change Password';
        });
      };
    }
  }

  function renderSettingsForm(container, settings, config) {
    if (!container) return;

    // Standard groups (AI is handled by its own section now)
    var standardGroups = {
      'Firehose': ['FIREHOSE_TOKEN'],
      'WordPress': ['WP_URL', 'WP_USERNAME', 'WP_APP_PASSWORD', 'WP_AUTHOR_ID', 'WP_DEFAULT_CATEGORY', 'WP_POST_STATUS'],
      'Pipeline': ['MIN_SOURCES_THRESHOLD', 'SIMILARITY_THRESHOLD', 'BUFFER_HOURS', 'ALLOW_SAME_DOMAIN_CLUSTERS', 'MAX_PUBLISH_PER_HOUR', 'PUBLISH_COOLDOWN_MINUTES'],
      'Google Trends': ['TRENDS_ENABLED', 'TRENDS_GEO', 'TRENDS_POLL_MINUTES'],
      'InfraNodus': ['INFRANODUS_ENABLED', 'INFRANODUS_API_KEY'],
      'Jina AI Reader (Extraction Fallback)': ['JINA_ENABLED', 'JINA_API_KEY'],
      'Source Tiers': ['TIER1_SOURCES', 'TIER2_SOURCES', 'TIER3_SOURCES'],
      'Dashboard': ['PORT'],
    };

    var sensitiveKeys = {
      FIREHOSE_TOKEN: true,
      WP_APP_PASSWORD: true,
      DASHBOARD_PASSWORD: true,
      INFRANODUS_API_KEY: true,
      JINA_API_KEY: true,
    };

    var booleanKeys = {
      TRENDS_ENABLED: true,
      INFRANODUS_ENABLED: true,
      ALLOW_SAME_DOMAIN_CLUSTERS: true,
      JINA_ENABLED: true,
    };

    var html = '';

    var groupNames = Object.keys(standardGroups);
    for (var g = 0; g < groupNames.length; g++) {
      var groupName = groupNames[g];
      var keys = standardGroups[groupName];

      html += '<div class="settings-group">';
      html += '<div class="settings-group-title">' + escapeHtml(groupName) + '</div>';

      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        var currentValue = settings[key] !== undefined ? settings[key] : '';
        var configValue = config[key] !== undefined ? config[key] : '';

        // For arrays, join back to CSV
        var displayValue = currentValue || (Array.isArray(configValue) ? configValue.join(', ') : String(configValue || ''));
        var isSensitive = sensitiveKeys[key];
        var isBoolean = booleanKeys[key];

        if (isBoolean) {
          // Render as checkbox
          var isChecked = String(displayValue).toLowerCase() === 'true' || displayValue === '1' || displayValue === true;
          html += '<div class="settings-row">' +
            '<label class="settings-label">' + escapeHtml(key) + '</label>' +
            '<label style="display:flex;align-items:center;gap:6px;color:var(--text-secondary)">' +
              '<input type="checkbox" data-setting-key="' + escapeHtml(key) + '"' + (isChecked ? ' checked' : '') + '> Enabled' +
            '</label>' +
          '</div>';
        } else if (key.indexOf('SOURCES') !== -1) {
          // CSV fields get textarea
          html += '<div class="settings-row">' +
            '<label class="settings-label">' + escapeHtml(key) + '</label>' +
            '<textarea data-setting-key="' + escapeHtml(key) + '" rows="2" style="resize:vertical">' +
              escapeHtml(displayValue) +
            '</textarea>' +
          '</div>';
        } else {
          var inputType = isSensitive ? 'password' : 'text';
          html += '<div class="settings-row">' +
            '<label class="settings-label">' + escapeHtml(key) + '</label>' +
            '<input type="' + inputType + '" data-setting-key="' + escapeHtml(key) + '" value="' + escapeHtml(displayValue) + '"' +
            (isSensitive ? ' placeholder="' + (currentValue || configValue ? '(configured)' : '(not set)') + '"' : '') +
            '>' +
          '</div>';
        }
      }

      html += '</div>';
    }

    container.innerHTML = html;
  }

  function initTestButtons() {
    var testFirehose = $('testFirehoseBtn');
    var testTrends = $('testTrendsBtn');
    var testWp = $('testWpBtn');

    if (testFirehose) {
      testFirehose.onclick = function () {
        testFirehose.disabled = true;
        testFirehose.textContent = 'Testing...';
        fetchApi('/api/test/firehose', { method: 'POST' })
          .then(function (data) {
            showToast(
              'Firehose: Token ' + (data.tokenConfigured ? 'configured' : 'NOT set') +
              ', State: ' + (data.status.state || '--'),
              data.tokenConfigured ? 'success' : 'warning'
            );
            testFirehose.disabled = false;
            testFirehose.textContent = 'Test Firehose';
          })
          .catch(function (err) {
            showToast('Firehose test failed: ' + err.message, 'error');
            testFirehose.disabled = false;
            testFirehose.textContent = 'Test Firehose';
          });
      };
    }

    if (testTrends) {
      testTrends.onclick = function () {
        testTrends.disabled = true;
        testTrends.textContent = 'Testing...';
        fetchApi('/api/test/trends', { method: 'POST' })
          .then(function (data) {
            var count = data.results ? (Array.isArray(data.results) ? data.results.length : 'done') : 0;
            showToast('Trends poll complete: ' + count + ' results', 'success');
            testTrends.disabled = false;
            testTrends.textContent = 'Test Trends';
          })
          .catch(function (err) {
            showToast('Trends test failed: ' + err.message, 'error');
            testTrends.disabled = false;
            testTrends.textContent = 'Test Trends';
          });
      };
    }

    var testInfra = $('testInfranodusBtn');
    if (testInfra) {
      testInfra.onclick = function () {
        testInfra.disabled = true;
        testInfra.textContent = 'Testing...';
        // Pass the key currently in the form field so the user can test before saving.
        // If the field is empty or shows a masked placeholder, fall back to the saved key.
        var keyInput = document.querySelector('[data-setting-key="INFRANODUS_API_KEY"]');
        var rawVal = keyInput ? keyInput.value.trim() : '';
        var body = (rawVal && rawVal.indexOf('\u2022') === -1 && rawVal.indexOf('••••') === -1) ? { apiKey: rawVal } : {};
        fetchApi('/api/test/infranodus', { method: 'POST', body: body })
          .then(function (data) {
            showToast(data.message || (data.success ? 'InfraNodus OK' : 'InfraNodus disabled'), data.success ? 'success' : 'warning');
            testInfra.disabled = false;
            testInfra.textContent = 'Test InfraNodus';
          })
          .catch(function (err) {
            showToast('InfraNodus test failed: ' + err.message, 'error');
            testInfra.disabled = false;
            testInfra.textContent = 'Test InfraNodus';
          });
      };
    }

    var testJina = $('testJinaBtn');
    if (testJina) {
      testJina.onclick = function () {
        testJina.disabled = true;
        testJina.textContent = 'Testing...';

        // Pull current key from the form (might be unsaved). Skip masked placeholders.
        var keyInput = document.querySelector('[data-setting-key="JINA_API_KEY"]');
        var rawKey = keyInput ? keyInput.value : '';
        var body = {};
        if (rawKey && rawKey.indexOf('\u2022') === -1 && rawKey.indexOf('••••') === -1) {
          body.api_key = rawKey;
        }

        fetchApi('/api/settings/test-jina', { method: 'POST', body: body })
          .then(function (data) {
            if (data.success) {
              showToast(
                'Jina OK \u2014 ' + (data.content_length || 0) + ' chars in ' + (data.elapsed_ms || 0) + 'ms' +
                (data.has_key ? ' (authenticated)' : ' (anonymous tier)'),
                'success'
              );
            } else {
              showToast('Jina test failed: ' + (data.error || 'unknown'), 'error');
            }
            testJina.disabled = false;
            testJina.textContent = 'Test Jina Reader';
          })
          .catch(function (err) {
            showToast('Jina test failed: ' + err.message, 'error');
            testJina.disabled = false;
            testJina.textContent = 'Test Jina Reader';
          });
      };
    }

    if (testWp) {
      testWp.onclick = function () {
        testWp.disabled = true;
        testWp.textContent = 'Testing...';
        fetchApi('/api/test/wordpress', { method: 'POST' })
          .then(function (data) {
            showToast(data.message || 'WordPress connection OK', 'success');
            testWp.disabled = false;
            testWp.textContent = 'Test WordPress';
          })
          .catch(function (err) {
            showToast('WordPress test failed: ' + err.message, 'error');
            testWp.disabled = false;
            testWp.textContent = 'Test WordPress';
            // Auto-open diagnostics panel on failure
            var diagPanel = $('wpDiagPanel');
            var errorLog = $('wpErrorLog');
            if (diagPanel) {
              diagPanel.style.display = '';
              loadWpDiagnostics();
            }
            if (errorLog) {
              errorLog.style.display = '';
              loadWpErrorLog('wpErrorLogContent');
            }
          });
      };
    }
  }

  // ─── WordPress Diagnostics & Error Log ──────────────────────────────────

  function loadWpDiagnostics() {
    var content = $('wpDiagContent');
    if (!content) return;
    content.innerHTML = '<p class="placeholder-text">Running diagnostics...</p>';

    fetchApi('/api/wp-status')
      .then(function (data) {
        var html = '';

        // Config status
        html += '<div class="wp-diag-check ' + (data.configured ? 'wp-diag-ok' : 'wp-diag-fail') + '">' +
          '<span class="wp-diag-icon">' + (data.configured ? '&#9989;' : '&#10060;') + '</span>' +
          '<span class="wp-diag-label">Credentials</span>' +
          '<span class="wp-diag-msg">' + (data.configured ? 'All WP credentials set' : 'Missing credentials') + '</span>' +
        '</div>';

        if (data.wpUrl) {
          html += '<div class="wp-diag-check wp-diag-ok">' +
            '<span class="wp-diag-icon">&#128279;</span>' +
            '<span class="wp-diag-label">WP URL</span>' +
            '<span class="wp-diag-msg">' + escapeHtml(data.wpUrl) + '</span>' +
          '</div>';
        }

        html += '<div class="wp-diag-check ' + (data.publisherEnabled ? 'wp-diag-ok' : 'wp-diag-fail') + '">' +
          '<span class="wp-diag-icon">' + (data.publisherEnabled ? '&#9989;' : '&#10060;') + '</span>' +
          '<span class="wp-diag-label">Publisher</span>' +
          '<span class="wp-diag-msg">Status: ' + escapeHtml(data.publisherStatus || 'unknown') +
            (data.publisherError ? ' — Error: ' + escapeHtml(data.publisherError) : '') + '</span>' +
        '</div>';

        html += '<div class="wp-diag-check wp-diag-ok">' +
          '<span class="wp-diag-icon">&#128221;</span>' +
          '<span class="wp-diag-label">Post Status</span>' +
          '<span class="wp-diag-msg">' + escapeHtml(data.postStatus || 'draft') + '</span>' +
        '</div>';

        // Connection checks
        var checks = data.checks || {};
        var checkOrder = ['credentials', 'restApi', 'auth', 'permissions'];
        for (var i = 0; i < checkOrder.length; i++) {
          var key = checkOrder[i];
          var check = checks[key];
          if (!check) continue;
          html += '<div class="wp-diag-check ' + (check.ok ? 'wp-diag-ok' : 'wp-diag-fail') + '">' +
            '<span class="wp-diag-icon">' + (check.ok ? '&#9989;' : '&#10060;') + '</span>' +
            '<span class="wp-diag-label">' + escapeHtml(key) + '</span>' +
            '<span class="wp-diag-msg">' + escapeHtml(check.message || '') + '</span>' +
          '</div>';
        }

        content.innerHTML = html;
      })
      .catch(function (err) {
        content.innerHTML = '<p style="color:var(--red)">Diagnostics failed: ' + escapeHtml(err.message) + '</p>';
      });
  }

  function loadWpErrorLog(containerId) {
    var content = $(containerId);
    if (!content) return;
    content.innerHTML = '<p class="placeholder-text">Loading...</p>';

    fetchApi('/api/wp-logs?limit=50')
      .then(function (data) {
        var logs = data.logs || [];
        if (logs.length === 0) {
          content.innerHTML = '<p class="wp-log-empty">No WordPress errors logged yet.</p>';
          return;
        }

        var html = '';
        for (var i = 0; i < logs.length; i++) {
          var log = logs[i];
          var time = log.created_at ? log.created_at.replace('T', ' ').substring(0, 19) : '';
          var levelClass = 'wp-log-level-' + (log.level || 'info');
          html += '<div class="wp-log-entry">' +
            '<span class="wp-log-time">' + escapeHtml(time) + '</span>' +
            '<span class="wp-log-level ' + levelClass + '">' + escapeHtml(log.level || 'info') + '</span>' +
            '<span class="wp-log-message">' + escapeHtml(log.message || '') + '</span>' +
          '</div>';
        }

        content.innerHTML = html;
      })
      .catch(function (err) {
        content.innerHTML = '<p style="color:var(--red)">Failed to load WP logs: ' + escapeHtml(err.message) + '</p>';
      });
  }

  // ─── AI Settings (dedicated section) ──────────────────────────────────

  function loadAISettings() {
    fetchApi('/api/ai/settings')
      .then(function (data) {
        if (!data.success) return;
        var el;
        el = $('ai-provider'); if (el) el.value = data.provider || 'openrouter';
        el = $('anthropic-key');
        if (el && data.anthropicKey) el.placeholder = data.anthropicKey;
        el = $('anthropic-model');
        if (el && data.anthropicModel) {
          el.value = data.anthropicModel;
          // Check if the model is valid (exists in dropdown)
          if (el.selectedIndex === -1 || el.value !== data.anthropicModel) {
            showToast('Warning: Invalid Anthropic model "' + data.anthropicModel + '" was saved. Resetting to default.', 'warning');
            el.selectedIndex = 0;
          }
        }
        el = $('openai-key');
        if (el && data.openaiKey) el.placeholder = data.openaiKey;
        el = $('openai-model'); if (el) el.value = data.openaiModel || 'gpt-4o-mini';
        el = $('openrouter-key');
        if (el && data.openrouterKey) el.placeholder = data.openrouterKey;
        window.__lastSavedOpenrouterModel = data.openrouterModel || 'meta-llama/llama-3.3-70b-instruct:free';
        el = $('openrouter-model'); if (el) el.value = window.__lastSavedOpenrouterModel;
        el = $('ai-fallback'); if (el) el.checked = data.enableFallback !== false;
        el = $('ai-max-tokens'); if (el) el.value = data.maxTokens || 4096;
        el = $('ai-temperature'); if (el) el.value = data.temperature !== undefined ? data.temperature : 0.7;
        updateAIProviderVisibility();
      })
      .catch(function (err) {
        console.error('Failed to load AI settings:', err);
      });

    // Wire events
    var providerEl = $('ai-provider');
    if (providerEl) providerEl.onchange = updateAIProviderVisibility;

    var saveBtn = $('saveAiSettingsBtn');
    if (saveBtn) saveBtn.onclick = saveAISettings;

    var testAntBtn = $('testAnthropicBtn');
    if (testAntBtn) testAntBtn.onclick = function () { testApiKey('anthropic'); };

    var testOaiBtn = $('testOpenaiBtn');
    if (testOaiBtn) testOaiBtn.onclick = function () { testApiKey('openai'); };

    var testOrBtn = $('testOpenrouterBtn');
    if (testOrBtn) testOrBtn.onclick = function () { testApiKey('openrouter'); };

    var valAntBtn = $('anthropic-validate');
    if (valAntBtn) valAntBtn.onclick = function () { validateRewriteCapability('anthropic'); };

    var valOaiBtn = $('openai-validate');
    if (valOaiBtn) valOaiBtn.onclick = function () { validateRewriteCapability('openai'); };

    var valOrBtn = $('openrouter-validate');
    if (valOrBtn) valOrBtn.onclick = function () { validateRewriteCapability('openrouter'); };

    // Load OpenRouter models dynamically (cached 1h server-side)
    __loadOpenRouterModels().then(function () {
      // Re-apply saved model selection after dropdown is populated
      var orEl = $('openrouter-model');
      if (orEl && window.__lastSavedOpenrouterModel) {
        orEl.value = window.__lastSavedOpenrouterModel;
      }
    });

    // Wire refresh button
    var orRefreshBtn = $('openrouter-refresh-btn');
    if (orRefreshBtn) orRefreshBtn.onclick = __refreshOpenRouterModels;
  }

  function saveAISettings() {
    var banner = $('ai-status-banner');
    var payload = {
      provider: $('ai-provider') ? $('ai-provider').value : 'openrouter',
      anthropicModel: $('anthropic-model') ? $('anthropic-model').value : undefined,
      openaiModel: $('openai-model') ? $('openai-model').value : undefined,
      openrouterModel: $('openrouter-model') ? $('openrouter-model').value : undefined,
      enableFallback: $('ai-fallback') ? $('ai-fallback').checked : true,
      maxTokens: $('ai-max-tokens') ? parseInt($('ai-max-tokens').value, 10) : undefined,
      temperature: $('ai-temperature') ? parseFloat($('ai-temperature').value) : undefined,
    };

    // Only send API keys if user typed a new one
    var antKeyInput = $('anthropic-key');
    if (antKeyInput && antKeyInput.value && antKeyInput.value.length > 10) {
      payload.anthropicKey = antKeyInput.value.trim();
    }
    var oaiKeyInput = $('openai-key');
    if (oaiKeyInput && oaiKeyInput.value && oaiKeyInput.value.length > 10) {
      payload.openaiKey = oaiKeyInput.value.trim();
    }
    var orKeyInput = $('openrouter-key');
    if (orKeyInput && orKeyInput.value && orKeyInput.value.length > 10) {
      payload.openrouterKey = orKeyInput.value.trim();
    }

    fetchApi('/api/ai/settings', { method: 'POST', body: payload })
      .then(function (data) {
        if (banner) {
          banner.style.display = 'block';
          banner.style.background = 'rgba(16,185,129,0.15)';
          banner.style.color = '#10b981';
          banner.textContent = 'AI settings saved successfully!';
          setTimeout(function () { banner.style.display = 'none'; }, 3000);
        }
        showToast('AI settings saved', 'success');
      })
      .catch(function (err) {
        if (banner) {
          banner.style.display = 'block';
          banner.style.background = 'rgba(239,68,68,0.15)';
          banner.style.color = '#ef4444';
          banner.textContent = 'Save failed: ' + err.message;
        }
        showToast('AI settings save failed: ' + err.message, 'error');
      });
  }

  function testApiKey(provider) {
    var statusEl = $(provider + '-key-status');
    var keyInput = $(provider + '-key');
    var modelInput = $(provider + '-model');
    var apiKey = keyInput ? keyInput.value.trim() : '';
    var model = modelInput ? modelInput.value : '';

    if (!apiKey || apiKey.length < 10) {
      if (statusEl) { statusEl.textContent = 'Enter an API key first'; statusEl.style.color = '#f59e0b'; }
      return;
    }

    if (statusEl) { statusEl.textContent = 'Testing...'; statusEl.style.color = '#888'; }

    fetchApi('/api/ai/test', { method: 'POST', body: { provider: provider, apiKey: apiKey, model: model } })
      .then(function (data) {
        if (data.success) {
          if (statusEl) {
            statusEl.textContent = 'Key valid! Model: ' + (data.model || model || '') + ' — Response: ' + (data.response || 'OK');
            statusEl.style.color = '#10b981';
          }
        } else {
          if (statusEl) { statusEl.textContent = 'Invalid: ' + (data.error || 'Unknown error'); statusEl.style.color = '#ef4444'; }
        }
      })
      .catch(function (err) {
        if (statusEl) { statusEl.textContent = 'Test failed: ' + err.message; statusEl.style.color = '#ef4444'; }
      });
  }

  function validateRewriteCapability(provider) {
    var statusEl = $(provider + '-key-status');
    var keyInput = $(provider + '-key');
    var modelInput = $(provider + '-model');
    var apiKey = keyInput ? keyInput.value.trim() : '';
    var model = modelInput ? modelInput.value : '';

    if (!apiKey || apiKey.length < 10) {
      if (statusEl) { statusEl.textContent = 'Enter an API key first'; statusEl.style.color = '#f59e0b'; }
      return;
    }

    if (statusEl) { statusEl.textContent = 'Validating rewrite capability...'; statusEl.style.color = '#888'; }

    fetchApi('/api/ai/validate-rewrite', { method: 'POST', body: { provider: provider, apiKey: apiKey, model: model } })
      .then(function (data) {
        if (data.success) {
          if (statusEl) {
            statusEl.textContent = 'Rewrite capable! ' + (data.response || '');
            statusEl.style.color = '#10b981';
          }
        } else {
          if (statusEl) { statusEl.textContent = 'Rewrite failed: ' + (data.error || 'Unknown error'); statusEl.style.color = '#ef4444'; }
        }
      })
      .catch(function (err) {
        if (statusEl) { statusEl.textContent = 'Validate failed: ' + err.message; statusEl.style.color = '#ef4444'; }
      });
  }

  // ─── Dynamic OpenRouter Model Loading ────────────────────────────────
  // OpenRouter constantly adds/removes free models, so we fetch the live list
  // from /api/ai/models (cached server-side for 1h) instead of hardcoding.

  function __loadOpenRouterModels() {
    return fetchApi('/api/ai/models')
      .then(function (data) {
        var orModels = (data && data.models && data.models.openrouter) || [];
        window.__openrouterModels = orModels;
        var sel = $('openrouter-model');
        if (!sel) return;
        var currentValue = sel.value;
        sel.innerHTML = '';
        if (orModels.length === 0) {
          var o = document.createElement('option');
          o.value = '';
          o.textContent = '— No free models available — click Refresh —';
          sel.appendChild(o);
          return;
        }
        for (var i = 0; i < orModels.length; i++) {
          var m = orModels[i];
          var opt = document.createElement('option');
          opt.value = m.id;
          opt.textContent = m.name + (m.tier ? ' — ' + m.tier : '');
          sel.appendChild(opt);
        }
        // Restore previous selection if still available
        var matched = false;
        for (var j = 0; j < orModels.length; j++) {
          if (orModels[j].id === currentValue) { matched = true; break; }
        }
        if (currentValue && matched) sel.value = currentValue;
      })
      .catch(function (err) {
        console.error('Failed to load OpenRouter models:', err);
      });
  }

  function __refreshOpenRouterModels() {
    showToast('Refreshing OpenRouter model list...', 'info');
    fetchApi('/api/ai/openrouter-models/refresh', { method: 'POST' })
      .then(function (data) {
        if (data.success) {
          return __loadOpenRouterModels().then(function () {
            showToast('Loaded ' + data.count + ' free models', 'success');
          });
        } else {
          showToast('Refresh failed: ' + (data.error || 'Unknown'), 'error');
        }
      })
      .catch(function (err) {
        showToast('Network error: ' + err.message, 'error');
      });
  }
  window.__refreshOpenRouterModels = __refreshOpenRouterModels;

  function updateAIProviderVisibility() {
    var provider = $('ai-provider') ? $('ai-provider').value : 'openrouter';
    var antBlock = $('anthropic-settings');
    var oaiBlock = $('openai-settings');
    var orBlock = $('openrouter-settings');

    // Show all blocks so user can configure keys for fallback
    if (antBlock) antBlock.style.display = 'block';
    if (oaiBlock) oaiBlock.style.display = 'block';
    if (orBlock) orBlock.style.display = 'block';

    // Reset all to dimmed
    var blocks = [antBlock, oaiBlock, orBlock];
    for (var i = 0; i < blocks.length; i++) {
      if (blocks[i]) { blocks[i].style.borderLeft = '3px solid #333'; blocks[i].style.opacity = '0.7'; }
    }

    // Highlight primary
    var primaryBlock = provider === 'anthropic' ? antBlock : provider === 'openrouter' ? orBlock : oaiBlock;
    var primaryColor = provider === 'anthropic' ? '#a78bfa' : provider === 'openrouter' ? '#f59e0b' : '#10b981';
    if (primaryBlock) { primaryBlock.style.borderLeft = '3px solid ' + primaryColor; primaryBlock.style.opacity = '1'; }
  }

  function initWpDiagButtons() {
    var diagBtn = $('wpDiagBtn');
    var diagPanel = $('wpDiagPanel');
    var diagRefresh = $('wpDiagRefreshBtn');
    var errorLog = $('wpErrorLog');
    var logRefresh = $('wpLogRefreshBtn');

    if (diagBtn && diagPanel) {
      diagBtn.onclick = function () {
        var visible = diagPanel.style.display !== 'none';
        diagPanel.style.display = visible ? 'none' : '';
        if (errorLog) errorLog.style.display = visible ? 'none' : '';
        if (!visible) {
          loadWpDiagnostics();
          loadWpErrorLog('wpErrorLogContent');
        }
      };
    }

    if (diagRefresh) {
      diagRefresh.onclick = function () { loadWpDiagnostics(); };
    }

    if (logRefresh) {
      logRefresh.onclick = function () { loadWpErrorLog('wpErrorLogContent'); };
    }

    // Editor WP Log buttons
    var editorLogBtn = $('editorWpLogBtn');
    var editorLogPanel = $('editorWpLog');
    var editorLogClose = $('editorWpLogClose');

    if (editorLogBtn && editorLogPanel) {
      editorLogBtn.onclick = function () {
        var visible = editorLogPanel.style.display !== 'none';
        editorLogPanel.style.display = visible ? 'none' : '';
        if (!visible) loadWpErrorLog('editorWpLogContent');
      };
    }

    if (editorLogClose && editorLogPanel) {
      editorLogClose.onclick = function () {
        editorLogPanel.style.display = 'none';
      };
    }
  }

  // ─── InfraNodus Debug Panel ──────────────────────────────────────────────

  function initInfraDebugPanel() {
    var btn        = $('editorInfraDebugBtn');
    var panel      = $('editorInfraDebug');
    var refresh    = $('editorInfraRefreshBtn');
    var close      = $('editorInfraCloseBtn');
    var cacheClear = $('editorInfraCacheClearBtn');

    if (btn && panel) {
      btn.onclick = function () {
        var visible = panel.style.display !== 'none';
        panel.style.display = visible ? 'none' : '';
        if (!visible) renderInfraDebug();
      };
    }
    if (refresh) { refresh.onclick = renderInfraDebug; }
    if (close && panel) { close.onclick = function () { panel.style.display = 'none'; }; }
    if (cacheClear) {
      cacheClear.onclick = function () {
        cacheClear.disabled = true;
        cacheClear.textContent = 'Clearing...';
        fetchApi('/api/infranodus/cache-clear', { method: 'POST' })
          .then(function (data) {
            showToast('Cache cleared (' + (data.clearedEntries || 0) + ' entries). Re-running analysis...', 'info');
            cacheClear.disabled = false;
            cacheClear.textContent = '&#128465; Clear Cache';
            // Re-run analysis for current draft automatically
            if (currentDraftId) {
              var body = document.getElementById('infra-body-' + currentDraftId);
              if (body) body.innerHTML = '<div class="infra-loading">&#128300; Re-running analysis...</div>';
              fetchApi('/api/drafts/' + currentDraftId + '/analyze', { method: 'POST' })
                .then(function () {
                  loadInfraData(currentDraftId);
                  renderInfraDebug();
                })
                .catch(function (err) {
                  showToast('Re-analysis failed: ' + err.message, 'error');
                  renderInfraDebug();
                });
            }
          })
          .catch(function (err) {
            showToast('Cache clear failed: ' + err.message, 'error');
            cacheClear.disabled = false;
            cacheClear.textContent = '&#128465; Clear Cache';
          });
      };
    }
  }

  function renderInfraDebug() {
    var content = $('editorInfraDebugContent');
    if (!content) return;
    content.innerHTML = '<p class="infra-debug-empty">Loading...</p>';

    var draftId = currentDraftId;

    // Fetch module health + draft analysis in parallel
    Promise.all([
      fetchApi('/api/health'),
      draftId ? fetchApi('/api/drafts/' + draftId + '/infranodus') : Promise.resolve(null)
    ]).then(function (results) {
      var health = results[0];
      var draftResult = results[1];

      // Find InfraNodus module entry
      var infraHealth = null;
      var modules = health.modules || [];
      for (var i = 0; i < modules.length; i++) {
        if (modules[i].module === 'infranodus') { infraHealth = modules[i]; break; }
      }

      var infraData = draftResult && draftResult.infraData ? draftResult.infraData : null;
      var aiModel   = draftResult ? draftResult.aiModel : null;

      // ── Build issues list ─────────────────────────────────────────────────
      var issues = [];

      if (!infraHealth) {
        issues.push({ type: 'error', icon: '✖', text: 'InfraNodus module not found in health check. Server may need restart.' });
      } else {
        if (!infraHealth.enabled) {
          issues.push({ type: 'error', icon: '✖', text: 'Module is DISABLED. Go to Settings → InfraNodus → set INFRANODUS_ENABLED = true.' });
        }
        if (infraHealth.enabled && !infraHealth.ready) {
          issues.push({ type: 'error', icon: '✖', text: 'Module is enabled but NOT ready. Check your API key and restart.' });
        }
        if (infraHealth.error) {
          issues.push({ type: 'error', icon: '✖', text: 'Module error: ' + infraHealth.error });
        }
        if (infraHealth.enabled && infraHealth.ready && !infraHealth.lastActivity) {
          issues.push({ type: 'warn', icon: '⚠', text: 'Module is ready but has never run an analysis. Open a draft and click "Run Analysis".' });
        }
      }

      if (!draftId) {
        issues.push({ type: 'info', icon: 'ℹ', text: 'No draft is open. Open a draft to see its analysis data.' });
      } else if (!infraData) {
        if (infraHealth && infraHealth.enabled && infraHealth.ready) {
          issues.push({ type: 'warn', icon: '⚠', text: 'No analysis data for this draft yet. Click "Run Analysis" in the InfraNodus tab or wait for the pipeline to process it.' });
        } else {
          issues.push({ type: 'warn', icon: '⚠', text: 'No analysis data for this draft. Enable InfraNodus first, then run analysis.' });
        }
      } else {
        var topicCount = (infraData.mainTopics || []).length;
        var entityCount = (infraData.missingEntities || []).length;
        if (topicCount === 0 && entityCount === 0) {
          issues.push({ type: 'warn', icon: '⚠', text: 'Analysis returned 0 topics and 0 entities. Click "Clear Cache" to force a fresh re-analysis with the fixed dual-endpoint call (graphAndStatements + graphAndAdvice).' });
        } else {
          issues.push({ type: 'ok', icon: '✔', text: 'Analysis looks good — ' + topicCount + ' topics and ' + entityCount + ' entities will enrich the next rewrite.' });
        }
        if (!infraData.advice) {
          issues.push({ type: 'warn', icon: '⚠', text: 'No AI advice in last result. InfraNodus may not have returned aiAdvice[0].text — check your API key quota.' });
        }
      }

      // ── Render ────────────────────────────────────────────────────────────
      var h = '';

      // Issues section (full width)
      h += '<div class="infra-debug-section infra-debug-issues">';
      h += '<div class="infra-debug-section-title">Issues Detected</div>';
      if (issues.length === 0) {
        h += '<div class="infra-issue issue-ok"><i class="infra-issue-icon">✔</i> No issues detected.</div>';
      }
      for (var j = 0; j < issues.length; j++) {
        var iss = issues[j];
        h += '<div class="infra-issue issue-' + iss.type + '">' +
          '<i class="infra-issue-icon">' + iss.icon + '</i>' +
          '<span>' + escapeHtml(iss.text) + '</span>' +
          '</div>';
      }
      h += '</div>';

      // Module health section
      h += '<div class="infra-debug-section">';
      h += '<div class="infra-debug-section-title">Module Health</div>';
      if (infraHealth) {
        var statusClass = infraHealth.status === 'connected' ? 'ok' : infraHealth.status === 'error' ? 'bad' : 'warn';
        h += row('Status',       '<span class="dv ' + statusClass + '">' + escapeHtml(infraHealth.status || '?') + '</span>');
        h += row('Enabled',      infraHealth.enabled  ? '<span class="dv ok">yes</span>'  : '<span class="dv bad">no</span>');
        h += row('Ready',        infraHealth.ready    ? '<span class="dv ok">yes</span>'  : '<span class="dv bad">no</span>');
        h += row('Analyses run', escapeHtml(String((infraHealth.stats && infraHealth.stats.analysesRun) || 0)));
        h += row('Last activity', infraHealth.lastActivity ? escapeHtml(infraHealth.lastActivity.replace('T', ' ').slice(0, 19)) : '<span class="dv warn">never</span>');
        if (infraHealth.error) {
          h += row('Error', '<span class="dv bad">' + escapeHtml(infraHealth.error) + '</span>');
        }
      } else {
        h += '<div class="infra-debug-row"><span class="dk">—</span><span class="dv bad">Not available</span></div>';
      }
      h += '</div>';

      // Draft analysis section
      h += '<div class="infra-debug-section">';
      h += '<div class="infra-debug-section-title">This Draft\'s Analysis</div>';
      if (!draftId) {
        h += '<div class="infra-debug-row"><span class="dk">—</span><span class="dv warn">No draft open</span></div>';
      } else if (!infraData) {
        h += row('Has data', '<span class="dv bad">none</span>');
        h += row('Draft ID', escapeHtml(String(draftId)));
        if (aiModel) h += row('Last AI model', escapeHtml(aiModel));
      } else {
        h += row('Has data',   '<span class="dv ok">yes</span>');
        h += row('Analyzed at', escapeHtml((infraData.analyzedAt || '?').replace('T', ' ').slice(0, 19)));
        h += row('Chars sent', escapeHtml(String(infraData.charsSent || '?')));
        h += row('Topics',     escapeHtml(String((infraData.mainTopics || []).length)));
        h += row('Entities',   escapeHtml(String((infraData.missingEntities || []).length)));
        h += row('Content gaps', escapeHtml(String((infraData.contentGaps || []).length)));
        h += row('Research Qs', escapeHtml(String((infraData.researchQuestions || []).length)));
        h += row('Advice',     infraData.advice    ? '<span class="dv ok">yes</span>' : '<span class="dv warn">none</span>');
        h += row('Graph summary', infraData.graphSummary ? '<span class="dv ok">yes</span>' : '<span class="dv warn">none</span>');
        if (aiModel) h += row('Used in rewrite', escapeHtml(aiModel));
      }
      h += '</div>';

      // Raw topics (only if data exists)
      if (infraData && (infraData.mainTopics || []).length > 0) {
        h += '<div class="infra-debug-section">';
        h += '<div class="infra-debug-section-title">Main Topics</div>';
        h += '<div style="color:#c7d2fe;line-height:1.6;">' + (infraData.mainTopics || []).map(function(t){ return escapeHtml(t); }).join(', ') + '</div>';
        h += '</div>';
      }

      // Advice snippet
      if (infraData && infraData.advice) {
        h += '<div class="infra-debug-section">';
        h += '<div class="infra-debug-section-title">AI Advice Snippet</div>';
        h += '<div style="color:#94a3b8;line-height:1.5;font-style:italic;">"' + escapeHtml(infraData.advice.slice(0, 300)) + (infraData.advice.length > 300 ? '…' : '') + '"</div>';
        h += '</div>';
      }

      content.innerHTML = h;
    }).catch(function (err) {
      content.innerHTML = '<p class="infra-debug-empty" style="color:#f87171;">Failed to load: ' + escapeHtml(err.message || String(err)) + '</p>';
    });

    function row(label, valueHtml) {
      return '<div class="infra-debug-row"><span class="dk">' + label + '</span><span class="dv">' + valueHtml + '</span></div>';
    }
  }

  // ─── Logs Page ──────────────────────────────────────────────────────────

  function loadLogs() {
    var container = $('logsList');
    var pagination = $('logsPagination');
    var moduleFilter = $('logModuleFilter');
    var levelFilter = $('logLevelFilter');

    if (container) container.innerHTML = '<p class="placeholder-text">Loading...</p>';

    var params = 'page=' + state.logsPage;
    if (moduleFilter && moduleFilter.value) params += '&module=' + encodeURIComponent(moduleFilter.value);
    if (levelFilter && levelFilter.value) params += '&level=' + encodeURIComponent(levelFilter.value);

    fetchApi('/api/logs?' + params)
      .then(function (data) {
        renderLogs(container, data.data || []);
        renderPagination(pagination, data.total, data.page, data.perPage, function (page) {
          state.logsPage = page;
          loadLogs();
        });
      })
      .catch(function (err) {
        if (container) container.innerHTML = '<p class="placeholder-text">Failed to load logs</p>';
        showToast('Failed to load logs: ' + err.message, 'error');
      });

    // Filters — only attach once (onchange = assignment, not addEventListener)
    if (moduleFilter && !moduleFilter._logsHandlerSet) {
      moduleFilter._logsHandlerSet = true;
      moduleFilter.onchange = function () {
        state.logsPage = 1;
        loadLogs();
      };
    }
    if (levelFilter && !levelFilter._logsHandlerSet) {
      levelFilter._logsHandlerSet = true;
      levelFilter.onchange = function () {
        state.logsPage = 1;
        loadLogs();
      };
    }

    // Auto-refresh every 10s — only create if no existing timer
    if (!state.refreshTimers.length) {
      state.refreshTimers.push(setInterval(function () {
        if (document.hidden) return;
        if (state.currentPage === 'logs') loadLogs();
      }, 10000));
    }
  }

  function renderLogs(container, logs) {
    if (!container) return;

    if (logs.length === 0) {
      container.innerHTML = '<p class="placeholder-text">No logs found</p>';
      return;
    }

    var html = '';
    for (var i = 0; i < logs.length; i++) {
      var log = logs[i];
      var levelClass = 'level-' + (log.level || 'info');
      var timeStr = log.created_at ? formatDateTime(log.created_at) : '--';

      html +=
        '<div class="log-entry">' +
          '<span class="log-time">' + escapeHtml(timeStr) + '</span>' +
          '<span class="log-level ' + levelClass + '">' + escapeHtml((log.level || 'info').toUpperCase()) + '</span>' +
          '<span class="log-module">' + escapeHtml(log.module || '--') + '</span>' +
          '<span class="log-message">' + escapeHtml(log.message || '') +
            (log.details ? ' <span style="color:var(--text-muted)">' + escapeHtml(truncate(log.details, 200)) + '</span>' : '') +
          '</span>' +
        '</div>';
    }
    container.innerHTML = html;
  }

  // ─── Pagination Helper ──────────────────────────────────────────────────

  function renderPagination(container, total, currentPage, perPage, onPageChange) {
    if (!container) return;

    var totalPages = Math.ceil(total / perPage) || 1;
    if (totalPages <= 1) {
      container.innerHTML = '';
      return;
    }

    var html = '';

    // Previous button
    html += '<button ' + (currentPage <= 1 ? 'disabled' : '') +
            ' data-page="' + (currentPage - 1) + '">&laquo; Prev</button>';

    // Page numbers
    var startPage = Math.max(1, currentPage - 2);
    var endPage = Math.min(totalPages, currentPage + 2);

    if (startPage > 1) {
      html += '<button data-page="1">1</button>';
      if (startPage > 2) html += '<span class="page-info">...</span>';
    }

    for (var p = startPage; p <= endPage; p++) {
      html += '<button data-page="' + p + '"' +
              (p === currentPage ? ' class="active"' : '') + '>' + p + '</button>';
    }

    if (endPage < totalPages) {
      if (endPage < totalPages - 1) html += '<span class="page-info">...</span>';
      html += '<button data-page="' + totalPages + '">' + totalPages + '</button>';
    }

    // Next button
    html += '<button ' + (currentPage >= totalPages ? 'disabled' : '') +
            ' data-page="' + (currentPage + 1) + '">Next &raquo;</button>';

    html += '<span class="page-info">' + total + ' total</span>';

    container.innerHTML = html;

    // Attach click handlers
    var buttons = container.querySelectorAll('button[data-page]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function () {
        var page = parseInt(this.getAttribute('data-page'), 10);
        if (page && !this.disabled) {
          onPageChange(page);
        }
      });
    }
  }

  // ─── Timer Cleanup ─────────────────────────────────────────────────────

  function clearPageTimers() {
    for (var i = 0; i < state.refreshTimers.length; i++) {
      clearInterval(state.refreshTimers[i]);
    }
    state.refreshTimers = [];
  }

  // ─── Manual URL Import Feature ────────────────────────────────────────

  function __parseManualImportUrls() {
    var textarea = document.getElementById('manual-import-urls');
    if (!textarea) return [];
    var raw = textarea.value || '';
    var lines = raw.split(/\r?\n/);
    var urls = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].trim();
      if (!line) continue;
      // Basic URL sanity check — backend does the real validation
      if (line.length > 3 && (line.indexOf('.') !== -1 || /^https?:\/\//i.test(line))) {
        urls.push(line);
      }
    }
    return urls;
  }

  function __updateManualImportCount() {
    var urls = __parseManualImportUrls();
    var countEl = document.getElementById('manual-import-count');
    if (countEl) {
      var n = urls.length;
      countEl.textContent = n + ' valid URL' + (n === 1 ? '' : 's') + ' detected';
      countEl.style.color = n > 100 ? '#ef4444' : '#888';
    }
    var submitBtn = document.getElementById('manual-import-submit');
    if (submitBtn) {
      submitBtn.disabled = urls.length === 0 || urls.length > 100;
    }
  }

  function __openManualImportModal() {
    var modal = document.getElementById('manual-import-modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    var textarea = document.getElementById('manual-import-urls');
    if (textarea) {
      textarea.value = '';
      textarea.focus();
    }
    __updateManualImportCount();
    var result = document.getElementById('manual-import-result');
    if (result) {
      result.classList.add('hidden');
      result.innerHTML = '';
    }
  }

  function __closeManualImportModal() {
    var modal = document.getElementById('manual-import-modal');
    if (modal) modal.classList.add('hidden');
  }

  function __submitManualImport() {
    var urls = __parseManualImportUrls();
    if (urls.length === 0) {
      showToast('Paste at least one URL', 'warning');
      return;
    }
    if (urls.length > 100) {
      showToast('Maximum 100 URLs per import', 'error');
      return;
    }

    var submitBtn = document.getElementById('manual-import-submit');
    var resultEl = document.getElementById('manual-import-result');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Importing...';
    }

    fetchApi('/api/drafts/manual-import', { method: 'POST', body: { urls: urls } })
      .then(function (data) {
        if (data.success) {
          if (resultEl) {
            resultEl.classList.remove('hidden');
            resultEl.innerHTML =
              '<div class="result-success">' +
              '<strong>&#10003; ' + data.imported + ' URLs queued for extraction.</strong><br>' +
              (data.skipped > 0 ? '<small>' + data.skipped + ' skipped (already exist or errors)</small><br>' : '') +
              (data.invalid > 0 ? '<small>' + data.invalid + ' invalid URLs ignored</small><br>' : '') +
              '<small>They will appear in the Published list as extraction completes.</small>' +
              '</div>';
          }
          showToast('Imported ' + data.imported + ' URLs &mdash; check Published tab', 'success');

          // Refresh published list so user can see new items coming in
          if (typeof loadPublished === 'function') {
            setTimeout(loadPublished, 1000);
            setTimeout(loadPublished, 5000);
            setTimeout(loadPublished, 15000);
          }

          // Clear textarea for next batch
          var textarea = document.getElementById('manual-import-urls');
          if (textarea) textarea.value = '';
          __updateManualImportCount();
        } else {
          if (resultEl) {
            resultEl.classList.remove('hidden');
            resultEl.innerHTML = '<div class="result-error">Import failed: ' + escapeHtml(data.error || 'Unknown error') + '</div>';
          }
          showToast('Import failed: ' + (data.error || 'Unknown'), 'error');
        }
      })
      .catch(function (err) {
        showToast('Network error: ' + err.message, 'error');
        if (resultEl) {
          resultEl.classList.remove('hidden');
          resultEl.innerHTML = '<div class="result-error">Network error: ' + escapeHtml(err.message || 'Unknown') + '</div>';
        }
      })
      .then(function () {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Import URLs';
        }
      });
  }

  // Legacy window aliases — still referenced from dev tooling and a few
  // internal call sites. The delegated CLICK_ACTIONS registry calls the
  // inner functions directly via closure, so these are not needed for the
  // dashboard UI itself.
  window.__openManualImportModal = __openManualImportModal;
  window.__closeManualImportModal = __closeManualImportModal;
  window.__submitManualImport = __submitManualImport;
  window.__updateManualImportCount = __updateManualImportCount;

  function initManualImport() {
    // Ctrl/Cmd+Enter inside textarea submits
    var textarea = document.getElementById('manual-import-urls');
    if (textarea) {
      textarea.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          __submitManualImport();
        }
      });
    }
    // Esc closes modal
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        var modal = document.getElementById('manual-import-modal');
        if (modal && !modal.classList.contains('hidden')) {
          __closeManualImportModal();
        }
      }
    });
  }

  // ─── Per-city fetch ──────────────────────────────────────────────────────

  async function fetchSingleFuelCity(cityName, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    try {
      var res = await fetch('/api/fuel/fetch-city', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city_name: cityName }),
      });
      var data = await res.json();
      if (data.success) {
        showToast('✅ ' + cityName + ': ₹' + (data.price ? data.price.petrol : '—') + ' / ₹' + (data.price ? data.price.diesel : '—'), 'success');
        loadFuelPage();
      } else {
        showToast('❌ ' + cityName + ': ' + data.error, 'error');
      }
    } catch (e) {
      showToast('❌ ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '⚡'; }
    }
  }

  async function fetchSingleMetalsCity(cityName, btn) {
    if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
    try {
      var res = await fetch('/api/metals/fetch-city', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city_name: cityName }),
      });
      var data = await res.json();
      if (data.success) {
        showToast('✅ Metals fetched for ' + cityName, 'success');
        loadMetalsPage();
      } else {
        showToast('❌ ' + cityName + ': ' + data.error, 'error');
      }
    } catch (e) {
      showToast('❌ ' + e.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '⚡'; }
    }
  }

  // ─── Test fetch (quick validation) ─────────────────────────────────────

  async function testFuelFetch(btn) {
    if (btn) { btn.disabled = true; btn.textContent = '🧪 Testing...'; }
    try {
      var res = await fetch('/api/fuel/fetch-test', { method: 'POST' });
      var data = await res.json();
      if (data.success) {
        var msg = data.results.map(function(r) {
          return r.city + ': ' + (r.ok ? '₹' + r.petrol + '/' + r.diesel : '❌ ' + r.error);
        }).join('\n');
        showToast('Test results:\n' + msg, 'success');
        loadFuelPage();
      } else {
        showToast('❌ ' + data.error, 'error');
      }
    } catch (e) { showToast('❌ ' + e.message, 'error'); }
    finally { if (btn) { btn.disabled = false; btn.textContent = '🧪 Test (5 cities)'; } }
  }

  async function testMetalsFetch(btn) {
    if (btn) { btn.disabled = true; btn.textContent = '🧪 Testing...'; }
    try {
      var res = await fetch('/api/metals/fetch-test', { method: 'POST' });
      var data = await res.json();
      if (data.success) {
        var msg = data.message;
        if (data.sample && data.sample.length > 0) {
          msg += '\nSample: ' + data.sample.map(function(s) { return s.city + ' ₹' + s.price_24k; }).join(', ');
        }
        showToast('✅ ' + msg, 'success');
        loadMetalsPage();
      } else {
        showToast('❌ ' + data.error, 'error');
      }
    } catch (e) { showToast('❌ ' + e.message, 'error'); }
    finally { if (btn) { btn.disabled = false; btn.textContent = '🧪 Test (Gold)'; } }
  }

  // ─── Diagnostics ───────────────────────────────────────────────────────

  async function runDiagnostics() {
    var el = document.getElementById('diagnostics-result');
    if (!el) return;
    el.innerHTML = '⏳ Checking...';
    try {
      var res = await fetch('/api/diagnostics');
      var data = await res.json();
      var html = '<table class="data-table"><thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead><tbody>';
      data.checks.forEach(function(c) {
        html += '<tr><td>' + esc(c.name) + '</td>';
        html += '<td>' + (c.ok ? '<span class="text-green">✅ OK</span>' : '<span class="text-red">❌ FAIL</span>') + '</td>';
        html += '<td class="text-sm">' + esc(c.detail) + '</td></tr>';
      });
      html += '</tbody></table>';
      el.innerHTML = html;
    } catch (e) { el.textContent = '❌ ' + e.message; }
  }

  // ─── Legacy window aliases ──────────────────────────────────────────────
  // Kept for parity with older integrations / dev-console use. The
  // delegated event registry dispatches directly to the closures inside
  // this IIFE, so dashboard HTML no longer relies on window.* lookups.

  window.saveFuelMetalsSettings  = saveFuelMetalsSettings;
  window.saveWPPublishingSettings = saveWPPublishingSettings;
  window.testWPConnection        = testWPConnection;
  window.loadFuelPage            = loadFuelPage;
  window.loadMetalsPage          = loadMetalsPage;
  window.filterFuelCities        = filterFuelCities;
  window.triggerFuelFetch        = triggerFuelFetch;
  window.triggerFuelPosts        = triggerFuelPosts;
  window.triggerMetalsFetch      = triggerMetalsFetch;
  window.triggerMetalsPosts      = triggerMetalsPosts;
  window.switchMetal             = switchMetal;
  window.loadSourcesPage         = loadSourcesPage;
  window.filterSourcesTable      = filterSourcesTable;
  window.sortSourcesTable        = sortSourcesTable;
  window.fetchSingleFuelCity     = fetchSingleFuelCity;
  window.fetchSingleMetalsCity   = fetchSingleMetalsCity;
  window.testFuelFetch           = testFuelFetch;
  window.testMetalsFetch         = testMetalsFetch;
  window.runDiagnostics          = runDiagnostics;

  // ─── Delegated events (CSP-safe replacement for inline on*= handlers) ───
  // Helmet CSP sets `script-src-attr 'none'` (H8), which blocks every
  // inline `on*=` attribute. DOM events route through three delegated
  // listeners that look up `data-click` / `data-input` / `data-change`
  // on the closest ancestor and dispatch to a registry entry. Each entry
  // reads its own `data-*` args off the element. `error` events are
  // captured separately (they don't bubble).

  var CLICK_ACTIONS = {
    'testFuelApi':             function () { testFuelApi(); },
    'testMetalsApi':           function () { testMetalsApi(); },
    'saveFuelMetalsSettings':  function () { saveFuelMetalsSettings(); },
    'testWPConnection':        function () { testWPConnection(); },
    'saveWPPublishingSettings':function () { saveWPPublishingSettings(); },
    'switchImportTab':         function (el) { switchImportTab(el.dataset.tab); },
    'runImport':               function (el) { runImport(el.dataset.module, el.dataset.format, el.dataset.dry === '1'); },
    'runDiagnostics':          function () { runDiagnostics(); },
    'loadSourcesPage':         function () { loadSourcesPage(); },
    'sortSourcesTable':        function (el) { sortSourcesTable(el.dataset.col); },
    'testFuelFetch':           function (el) { testFuelFetch(el); },
    'triggerFuelFetch':        function () { triggerFuelFetch(); },
    'triggerFuelPosts':        function () { triggerFuelPosts(); },
    'loadFuelPage':            function () { forceApiRefresh('/api/fuel'); loadFuelPage(); },
    'switchFuelTab':           function (el) { switchFuelTab(el.dataset.tab); },
    'toggleFuelCity':          function (el) { toggleFuelCity(el.dataset.city, Number(el.dataset.enable)); },
    'fetchSingleFuelCity':     function (el) { fetchSingleFuelCity(el.dataset.city, el); },
    'startEditFuelPrice':      function (el) {
      var ds = el.dataset;
      startEditFuelPrice(ds.city, ds.state, Number(ds.petrol), Number(ds.diesel), ds.date);
    },
    'saveEditFuelPrice':       function (el) { saveEditFuelPrice(el.dataset.city, el.dataset.date); },
    'testMetalsFetch':         function (el) { testMetalsFetch(el); },
    'triggerMetalsFetch':      function (el) { triggerMetalsFetch(el); },
    'triggerMetalsPosts':      function () { triggerMetalsPosts(); },
    'loadMetalsPage':          function () { forceApiRefresh('/api/metals'); loadMetalsPage(); },
    'switchMetal':             function (el) { switchMetal(el.dataset.metal); },
    'switchMetalsTab':         function (el) { switchMetalsTab(el.dataset.tab); },
    'toggleMetalsCity':        function (el) { toggleMetalsCity(el.dataset.city, Number(el.dataset.enable)); },
    'fetchSingleMetalsCity':   function (el) { fetchSingleMetalsCity(el.dataset.city, el); },
    'startEditMetalsPrice':    function (el) { startEditMetalsPrice(el.dataset.city, el.dataset.metal); },
    'saveEditMetalsPrice':     function (el) { saveEditMetalsPrice(el.dataset.city, el.dataset.metal, el.dataset.date); },
    'loadMetalsCitiesExtended':function () { loadMetalsCitiesExtended(); },
    'regeneratePost':          function (el) {
      var ds = el.dataset;
      regeneratePost(ds.module, ds.itemType, ds.postType, ds.itemName);
    },
    'openManualImportModal':   function () { __openManualImportModal(); },
    'closeManualImportModal':  function () { __closeManualImportModal(); },
    'closeBulkImportModal':    function () { __closeBulkImportModal(); },
    'showTaxTab':              function (el) { window.__showTaxTab(el.getAttribute('data-tax')); },
    'togglePipelineEngine':    function () {
      var b = document.getElementById('pipelineEngineBody');
      var a = document.getElementById('pipelineEngineArrow');
      if (!b) return;
      var hidden = b.style.display === 'none';
      b.style.display = hidden ? '' : 'none';
      if (a) a.textContent = hidden ? '\u25BC' : '\u25B6';
    },
    'submitManualImport':      function () { __submitManualImport(); },
    'editRule':                function (el) {
      var ds = el.dataset;
      __editRule(ds.id, ds.tag, ds.value, ds.quality === '1');
    },
    'deleteRule':              function (el) { __deleteRule(el.dataset.id); },
    'toggleCluster':           function (el) { __toggleCluster(Number(el.dataset.clusterId)); },
    'publishCluster':          function (el, e) { e.stopPropagation(); __publishCluster(Number(el.dataset.clusterId)); },
    'skipCluster':             function (el, e) { e.stopPropagation(); __skipCluster(Number(el.dataset.clusterId)); },
    'deleteCluster':           function (el, e) { e.stopPropagation(); __deleteCluster(Number(el.dataset.clusterId), e); },
    'goToPublished':           function (el, e) { if (e) e.stopPropagation(); __goToPublished(); },
    'goToPublishedAndDismiss': function (el) { __goToPublished(); if (el.parentElement) el.parentElement.remove(); },
    'toggleClusterSources':    function (el) { toggleClusterSources(el); },
    'toggleExpandContent':     function (el) { toggleExpandContent(el); },
    'publishReady':            function (el) { __publishReady(Number(el.dataset.draftId)); },
    'rejectQueued':            function (el) {
      var id = Number(el.dataset.draftId);
      if (!confirm('Reject this draft? It will be marked as failed.')) return;
      fetchApi('/api/autopilot/queue/' + id + '/reject', { method: 'POST' })
        .then(function () { showToast('Draft rejected', 'success'); loadAutopilotQueue(); })
        .catch(function (e) { showToast('Reject failed: ' + e.message, 'error'); });
    },
    'openEditor':              function (el) { __openEditor(Number(el.dataset.draftId)); },
    'retryFailedDraft':        function (el) { __retryFailedDraft(Number(el.dataset.draftId)); },
    'retryExtract':            function (el) { __retryExtract(Number(el.dataset.draftId)); },
    'triggerRewrite':          function (el) { __triggerRewrite(Number(el.dataset.draftId)); },
    'previewDraftHTML':        function (el) { __previewDraftHTML(Number(el.dataset.draftId)); },
    'retryDraft':              function (el) { __retryDraft(Number(el.dataset.draftId)); },
    'deleteDraft':             function (el) { __deleteDraft(Number(el.dataset.draftId)); },
    'downloadDraftHTML':       function (el) { __downloadDraftHTML(Number(el.dataset.draftId)); },
    'toggleDraftSelect':       function (el, e) { __toggleDraftSelect(Number(el.dataset.draftId), e); },
    'runInfraAnalysis':        function (el) { __runInfraAnalysis(Number(el.dataset.draftId)); },
    'searchEntityInfra':       function (el) { __searchEntityInfra(String(el.dataset.draftId)); },
    'applyEntityToDraft':      function (el) { __applyEntityToDraft(String(el.dataset.draftId)); },
    'addEntityToContent':      function (el) { __addEntityToContent(el.dataset.entity, String(el.dataset.draftId)); },
    'addAllMissingEntities':   function (el) { __addAllMissingEntities(String(el.dataset.draftId)); },
    'syncWPTaxonomy':   function () { window.__syncWPTaxonomy(); },
    'addPublishRule':   function () { window.__addPublishRule(); },
    'editPublishRule':  function (el) { window.__editPublishRule(el); },
    'deletePublishRule':function (el) { window.__deletePublishRule(el); },
    'savePublishRule':  function () { window.__savePublishRule(); },
    'cancelPublishRule':function () { window.__cancelPublishRule(); },
    'switchToInfraTab':        function () { __switchToInfraTab(); },
    'toggleSelectMode':        function () { __toggleSelectMode(); },
    'batchDeleteFailed':       function () { __batchDeleteFailed(); },
    'selectAllDrafts':         function () { __selectAllDrafts(); },
    'deselectAllDrafts':       function () { __deselectAllDrafts(); },
    'deleteSelectedDrafts':    function () { __deleteSelectedDrafts(); },
    'clearBatchSelection':     function () { __clearBatchSelection(); },
    'mergeIntoCluster':        function () { __mergeIntoCluster(); },
    'createManualCluster':     function () { __createManualCluster(); },
    'dismissParent':           function (el) { if (el.parentElement) el.parentElement.remove(); },
    'stopOnly':                function (el, e) { e.stopPropagation(); },
    'switchLotteryTab':        function (el) { window.__switchLotteryTab(el.dataset.tab); }
  };

  var INPUT_ACTIONS = {
    'filterSourcesTable':       function (el) { filterSourcesTable(el.value); },
    'filterFuelCities':         function () { filterFuelCities(); },
    'filterMetalsCities':       function () { filterMetalsCities(); },
    'loadFuelPosts':            function () { loadFuelPosts(); },
    'loadMetalsPosts':          function () { loadMetalsPosts(); },
    'updateManualImportCount':  function () { __updateManualImportCount(); }
  };

  var CHANGE_ACTIONS = {
    'filterFuelCities':   function () { filterFuelCities(); },
    'filterMetalsCities': function () { filterMetalsCities(); },
    'loadFuelPosts':      function () { loadFuelPosts(); },
    'loadMetalsPosts':    function () { loadMetalsPosts(); }
  };

  var ERROR_ACTIONS = {
    'hideSelf':   function (el) { el.style.display = 'none'; },
    'hideParent': function (el) { if (el.parentElement) el.parentElement.style.display = 'none'; }
  };

  function _dispatchEvent(registry, attr) {
    return function (e) {
      var el = e.target && e.target.closest && e.target.closest('[' + attr + ']');
      if (!el) return;
      var handler = registry[el.getAttribute(attr)];
      if (handler) handler(el, e);
    };
  }

  function bindDelegatedEvents() {
    document.addEventListener('click',  _dispatchEvent(CLICK_ACTIONS,  'data-click'));
    document.addEventListener('input',  _dispatchEvent(INPUT_ACTIONS,  'data-input'));
    document.addEventListener('change', _dispatchEvent(CHANGE_ACTIONS, 'data-change'));
    // error events don't bubble — observe in the capture phase so a single
    // document listener still sees per-element failures (e.g. broken img).
    document.addEventListener('error', function (e) {
      var el = e.target;
      if (!el || !el.getAttribute) return;
      var action = el.getAttribute('data-error');
      if (!action) return;
      var handler = ERROR_ACTIONS[action];
      if (handler) handler(el, e);
    }, true);
  }

  // Extracted from an inline onclick that toggled the cluster-editor
  // sources pane and rotated its caret.
  function toggleClusterSources(headerEl) {
    if (!headerEl || !headerEl.parentElement) return;
    var pane = headerEl.parentElement.querySelector('.cluster-editor-sources');
    var arrow = headerEl.querySelector('.toggle-arrow');
    if (!pane || !arrow) return;
    var hidden = pane.style.display === 'none';
    pane.style.display = hidden ? '' : 'none';
    arrow.textContent = hidden ? '\u25BE' : '\u25B8';
  }

  // Extracted from an inline onclick that expanded/collapsed a clipped
  // source-article block inside the cluster sources pane.
  function toggleExpandContent(el) {
    if (!el) return;
    var label = el.querySelector('.expand-label');
    if (el.style.maxHeight === '120px' || el.style.maxHeight === '') {
      el.style.maxHeight = 'none';
      if (label) label.textContent = '\u25B2 Collapse';
      return;
    }
    el.style.maxHeight = '120px';
    if (label) {
      var n = el.textContent.length;
      var lbl = n >= 10000 ? Math.round(n / 1000) + 'k chars'
              : n >= 1000 ? (n / 1000).toFixed(1) + 'k chars'
              : n + ' chars';
      label.textContent = '\u25BC Show full content (' + lbl + ')';
    }
  }

  // ─── Init ───────────────────────────────────────────────────────────────

  function _applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    var sunEl = document.getElementById('theme-icon-sun');
    var moonEl = document.getElementById('theme-icon-moon');
    if (sunEl)  sunEl.style.display  = theme === 'dark'  ? 'none' : '';
    if (moonEl) moonEl.style.display = theme === 'light' ? 'none' : '';
    try { localStorage.setItem('hdf-theme', theme); } catch (e) {}
  }

  function _refreshIcons() {
    if (window.lucide) window.lucide.createIcons();
  }

  function initThemeToggle() {
    var btn = document.getElementById('theme-toggle');
    if (!btn) return;
    // Sync icon visibility to current theme (already set by bootstrap IIFE) without re-writing localStorage
    var current = document.documentElement.getAttribute('data-theme') || 'dark';
    var sunEl = document.getElementById('theme-icon-sun');
    var moonEl = document.getElementById('theme-icon-moon');
    if (sunEl)  sunEl.style.display  = current === 'dark'  ? 'none' : '';
    if (moonEl) moonEl.style.display = current === 'light' ? 'none' : '';
    btn.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      _applyTheme(next);
    });
  }

  function init() {
    bindDelegatedEvents();
    initSidebar();
    initRouter();
    initEditorButtons();
    initWpDiagButtons();
    initInfraDebugPanel();
    initManualImport();
    initThemeToggle();
    _refreshIcons();
    // Pre-fetch OpenRouter models so the editor's model picker works even
    // before the user visits the Settings page. Cached server-side for 1h.
    __loadOpenRouterModels();
  }

  // ─── Fuel Page ──────────────────────────────────────────────────────────

  var _fuelCitiesData = [];
  var _fuelStatesData = [];

  function loadFuelPage() {
    fetchApi('/api/fuel/summary').then(function(data) {
      var set = function(id, val) { var el = $(id); if (el) el.textContent = val; };
      set('fuel-total-cities', data.total || 0);
      set('fuel-fetched-today', data.fetched || 0);
      set('fuel-missing-today', data.missing || 0);
      set('fuel-last-fetch', data.lastFetchAt ? timeAgo(data.lastFetchAt) : 'Never');

      // Show last fetch result detail
      var lfr = data.lastFetchResult;
      var target = document.getElementById('fuel-last-fetch-detail');
      if (target && lfr) {
        var lfrHtml = '<div class="mini-panel"><strong>Last Fetch:</strong> ' + timeAgo(lfr.time) + ' (' + lfr.type + ')';
        lfrHtml += ' — <span class="text-green">' + lfr.ok + ' OK</span>';
        if (lfr.fail > 0) {
          lfrHtml += ', <span class="text-red">' + lfr.fail + ' failed</span>';
          if (lfr.details && lfr.details.failedCities) {
            lfrHtml += '<br><span class="text-sm text-muted">Failed: ' + lfr.details.failedCities.map(escapeHtml).join(', ') + '</span>';
          }
        }
        lfrHtml += '</div>';
        target.innerHTML = lfrHtml;
      } else if (target) {
        target.innerHTML = '';
      }
    });

    fetchApi('/api/fuel/states').then(function(data) {
      _fuelStatesData = data.data || [];
      var tbody = $('fuel-states-tbody');
      if (!tbody) return;
      var sel = $('fuel-state-filter');
      if (sel && sel.options.length <= 1) {
        _fuelStatesData.forEach(function(s) {
          var o = document.createElement('option');
          o.value = s.state; o.textContent = s.state;
          sel.appendChild(o);
        });
      }
      tbody.innerHTML = _fuelStatesData.map(function(s) {
        return '<tr><td>' + escapeHtml(s.state) + '</td><td>' + s.total_cities +
          '</td><td style="color:#10b981">' + (s.fetched || 0) +
          '</td><td>' + (s.avg_petrol ? '₹' + s.avg_petrol : '—') +
          '</td><td>' + (s.avg_diesel ? '₹' + s.avg_diesel : '—') + '</td></tr>';
      }).join('');
    }).catch(function(e) { showToast('Failed to load fuel states: ' + e.message, 'error'); });

    fetchApi('/api/fuel/cities').then(function(data) {
      _fuelCitiesData = data.data || [];
      renderFuelCities(_fuelCitiesData);
    }).catch(function(e) { showToast('Failed to load fuel cities: ' + e.message, 'error'); });

    fetchApi('/api/fuel/history?city=Delhi&days=30').then(function(data) {
      renderFuelNationalChart(data);
    }).catch(function() {});

    switchFuelTab('overview');
    _loadFuelOverviewActivity();
  }

  function renderFuelCities(cities) {
    var tbody = $('fuel-cities-tbody');
    if (!tbody) return;
    if (!cities.length) { tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#888">No data</td></tr>'; return; }
    tbody.innerHTML = cities.map(function(c) {
      var pColor = c.petrol > 0 ? 'var(--text)' : '#ef4444';
      var dColor = c.diesel > 0 ? 'var(--text)' : '#ef4444';
      var pd = c.price_date || '';
      var p = c.petrol || '';
      var d = c.diesel || '';
      var cityEsc = escapeHtml(c.city_name);
      var stateEsc = escapeHtml(c.state);
      var enabled = c.is_enabled !== 0;
      return '<tr data-fuel-city="' + cityEsc + '">' +
        '<td><strong>' + cityEsc + '</strong></td>' +
        '<td>' + stateEsc + '</td>' +
        '<td class="col-petrol" style="color:' + pColor + '">' + (c.petrol ? '₹' + Number(c.petrol).toFixed(2) : '—') + '</td>' +
        '<td class="col-diesel" style="color:' + dColor + '">' + (c.diesel ? '₹' + Number(c.diesel).toFixed(2) : '—') + '</td>' +
        '<td><span style="font-size:11px;background:var(--bg3);padding:2px 6px;border-radius:4px;">' + (c.source || '—') + '</span></td>' +
        '<td style="font-size:12px;color:#888">' + (pd || '—') + '</td>' +
        '<td><button class="btn-icon" data-click="toggleFuelCity" data-city="' + cityEsc + '" data-enable="' + (enabled ? '0' : '1') + '" title="Toggle enabled">' + (enabled ? '✅' : '❌') + '</button></td>' +
        '<td class="col-actions">' +
          '<button class="btn-icon" title="Fetch this city" data-click="fetchSingleFuelCity" data-city="' + cityEsc + '">⚡</button>' +
          '<button class="btn-icon" title="Edit prices" data-click="startEditFuelPrice" data-city="' + cityEsc + '" data-state="' + stateEsc + '" data-petrol="' + p + '" data-diesel="' + d + '" data-date="' + pd + '">✏️</button>' +
        '</td></tr>';
    }).join('');
  }

  function filterFuelCities() {
    var state = ($('fuel-state-filter') || {}).value || '';
    var search = ($('fuel-city-search') || {}).value || '';
    var filtered = _fuelCitiesData.filter(function(c) {
      if (state && c.state !== state) return false;
      if (search && c.city_name.toLowerCase().indexOf(search.toLowerCase()) === -1) return false;
      return true;
    });
    renderFuelCities(filtered);
  }

  function renderFuelNationalChart(data) {
    var canvas = document.getElementById('fuel-national-chart');
    if (!canvas || !window.Chart) return;
    if (canvas._chartInstance) canvas._chartInstance.destroy();
    canvas._chartInstance = new Chart(canvas, {
      type: 'line',
      data: {
        labels: data.labels || [],
        datasets: [
          { label: 'Petrol', data: data.petrol || [], borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.1)', tension: 0.3, fill: true },
          { label: 'Diesel', data: data.diesel || [], borderColor: '#3b82f6', backgroundColor: 'rgba(59,130,246,0.1)', tension: 0.3, fill: true },
        ]
      },
      options: {
        maintainAspectRatio: false,
        plugins: { legend: { position: 'top' } },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.05)' } },
          y: { grid: { color: 'rgba(255,255,255,0.05)' } }
        }
      }
    });
  }

  async function triggerFuelFetch() {
    var btn = $('fuelFetchBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Fetching...'; }
    try {
      var res = await fetch('/api/fuel/fetch', { method: 'POST' });
      var data = await res.json();
      if (data.success) {
        showToast('✅ ' + data.message, 'success');
      } else {
        showToast('❌ ' + (data.error || 'Fetch failed'), 'error');
      }
    } catch (err) {
      showToast('❌ Error: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '⚡ Fetch All Prices'; }
      loadFuelPage();
    }
  }

  // ─── Metals Page ────────────────────────────────────────────────────────

  var _currentMetal = 'gold';
  var _metalsCitiesData = [];

  function loadMetalsPage() {
    fetchMetalsData(_currentMetal);
    switchMetalsTab('overview');
    _loadMetalsOverviewActivity();
  }

  function switchMetal(metal) {
    _currentMetal = metal;
    ['gold','silver','platinum'].forEach(function(m) {
      var btn = $('metal-btn-' + m);
      if (!btn) return;
      if (m === metal) {
        btn.style.background = m === 'gold' ? '#f59e0b' : m === 'silver' ? '#9ca3af' : '#a78bfa';
        btn.style.color = '#000';
        btn.className = 'btn btn-sm';
      } else {
        btn.style.background = '';
        btn.style.color = '';
        btn.className = 'btn btn-sm btn-ghost';
      }
    });
    fetchMetalsData(metal);
  }

  function fetchMetalsData(metal) {
    fetchApi('/api/metals/summary').then(function(data) {
      var set = function(id, val) { var el = $(id); if (el) el.textContent = val; };
      var metalData = data[metal] || data;
      set('metals-total-cities', metalData.total || data.total || 0);
      set('metals-fetched-today', metalData.fetched || data.fetched || 0);
      set('metals-avg-price', metalData.avgPrice ? '₹' + Number(metalData.avgPrice).toLocaleString() : '—');
      set('metals-last-fetch', data.lastFetchAt ? timeAgo(data.lastFetchAt) : 'Never');

      // Show last fetch result detail
      var lfr = data.lastFetchResult;
      var target = document.getElementById('metals-last-fetch-detail');
      if (target && lfr) {
        var lfrHtml = '<div class="mini-panel"><strong>Last Fetch:</strong> ' + timeAgo(lfr.time) + ' (' + lfr.type + ')';
        lfrHtml += ' — <span class="text-green">' + lfr.ok + ' OK</span>';
        if (lfr.fail > 0) lfrHtml += ', <span class="text-red">' + lfr.fail + ' failed</span>';
        if (lfr.details && lfr.details.perMetal) lfrHtml += '<br><span class="text-sm text-muted">' + JSON.stringify(lfr.details.perMetal) + '</span>';
        lfrHtml += '</div>';
        target.innerHTML = lfrHtml;
      } else if (target) {
        target.innerHTML = '';
      }
    });

    fetchApi('/api/metals/cities?metal=' + metal).then(function(data) {
      _metalsCitiesData = data.data || [];
      var tbody = $('metals-cities-tbody');
      if (!tbody) return;
      if (!_metalsCitiesData.length) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#888">No data</td></tr>'; return; }
      tbody.innerHTML = _metalsCitiesData.filter(function(c) {
        return c.price_24k > 0 || c.price_1g > 0;
      }).slice(0, 50).map(function(c) {
        return '<tr><td><strong>' + escapeHtml(c.city_name) + '</strong></td>' +
          '<td>' + (c.price_24k ? '₹' + Number(c.price_24k).toLocaleString() : '—') + '</td>' +
          '<td>' + (c.price_22k ? '₹' + Number(c.price_22k).toLocaleString() : '—') + '</td>' +
          '<td>' + (c.price_18k ? '₹' + Number(c.price_18k).toLocaleString() : '—') + '</td>' +
          '<td>' + (c.price_1g ? '₹' + Number(c.price_1g).toFixed(2) : '—') + '</td></tr>';
      }).join('');
    }).catch(function(e) { showToast('Failed to load metals cities: ' + e.message, 'error'); });

    var chartTitle = $('metals-chart-title');
    if (chartTitle) chartTitle.textContent = metal.charAt(0).toUpperCase() + metal.slice(1) + ' National Trend (30d)';

    fetchApi('/api/metals/history?city=Delhi&metal=' + metal + '&days=30').then(function(data) {
      var canvas = document.getElementById('metals-national-chart');
      if (!canvas || !window.Chart) return;
      if (canvas._chartInstance) canvas._chartInstance.destroy();
      var priceKey = metal === 'gold' ? 'price_24k' : 'price_1g';
      var label = metal === 'gold' ? '24K per 10g' : 'Per gram';
      var color = metal === 'gold' ? '#f59e0b' : metal === 'silver' ? '#9ca3af' : '#a78bfa';
      canvas._chartInstance = new Chart(canvas, {
        type: 'line',
        data: {
          labels: data.labels || [],
          datasets: [{
            label: label,
            data: data[priceKey] || [],
            borderColor: color,
            backgroundColor: color + '22',
            tension: 0.3, fill: true
          }]
        },
        options: {
          maintainAspectRatio: false,
          plugins: { legend: { position: 'top' } },
          scales: {
            x: { grid: { color: 'rgba(255,255,255,0.05)' } },
            y: { grid: { color: 'rgba(255,255,255,0.05)' } }
          }
        }
      });
    }).catch(function() {});
  }

  async function triggerMetalsFetch(btn) {
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Fetching...'; }
    try {
      var res = await fetch('/api/metals/fetch', { method: 'POST' });
      var data = await res.json();
      if (data.success) {
        showToast('✅ ' + data.message, 'success');
      } else {
        showToast('❌ ' + (data.error || 'Fetch failed'), 'error');
      }
    } catch (err) {
      showToast('❌ Error: ' + err.message, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '⚡ Fetch All Prices'; }
      loadMetalsPage();
    }
  }

  // ─── Fuel & Metals Settings ─────────────────────────────────────────────

  function loadFuelMetalsSettings() {
    fetchApi('/api/settings').then(function(data) {
      var s = data.settings || {};
      var el;
      el = $('fuel-rapidapi-key');
      if (el) el.placeholder = s.FUEL_RAPIDAPI_KEY ? '(key saved — enter new key to change)' : 'Enter RapidAPI key';
      el = $('metals-rapidapi-key');
      if (el) el.placeholder = s.METALS_RAPIDAPI_KEY ? '(key saved — enter new key to change)' : 'Enter RapidAPI key';
    }).catch(function() {});
  }

  function saveFuelMetalsSettings() {
    var fuelKey = $('fuel-rapidapi-key');
    var metalsKey = $('metals-rapidapi-key');
    var updates = {};
    if (fuelKey && fuelKey.value && fuelKey.value.indexOf('••') === -1) {
      updates.FUEL_RAPIDAPI_KEY = fuelKey.value;
    }
    if (metalsKey && metalsKey.value && metalsKey.value.indexOf('••') === -1) {
      updates.METALS_RAPIDAPI_KEY = metalsKey.value;
    }
    if (!Object.keys(updates).length) { showToast('No changes to save', 'info'); return; }
    fetchApi('/api/settings', { method: 'PUT', body: updates })
      .then(function() { showToast('API keys saved', 'success'); })
      .catch(function(err) { showToast('Save failed: ' + err.message, 'error'); });
  }

  function testFuelApi() {
    var statusEl = $('fuel-key-status');
    var keyInput = $('fuel-rapidapi-key');
    var typedKey = keyInput && keyInput.value && keyInput.value.indexOf('••') === -1 ? keyInput.value.trim() : '';
    var url = '/api/fuel/ping-api' + (typedKey ? '?key=' + encodeURIComponent(typedKey) : '');
    if (statusEl) { statusEl.textContent = 'Testing...'; statusEl.style.color = '#888'; }
    fetchApi(url)
      .then(function(data) {
        if (!statusEl) return;
        if (data.ok) {
          statusEl.textContent = '✓ Key valid — RapidAPI connected';
          statusEl.style.color = '#10b981';
        } else {
          statusEl.textContent = '✗ ' + (data.error || ('HTTP ' + data.status));
          statusEl.style.color = '#ef4444';
        }
      })
      .catch(function(e) {
        if (statusEl) { statusEl.textContent = '✗ ' + e.message; statusEl.style.color = '#ef4444'; }
      });
  }

  function testMetalsApi() {
    var statusEl = $('metals-key-status');
    var keyInput = $('metals-rapidapi-key');
    var typedKey = keyInput && keyInput.value && keyInput.value.indexOf('••') === -1 ? keyInput.value.trim() : '';
    var url = '/api/metals/ping-api' + (typedKey ? '?key=' + encodeURIComponent(typedKey) : '');
    if (statusEl) { statusEl.textContent = 'Testing...'; statusEl.style.color = '#888'; }
    fetchApi(url)
      .then(function(data) {
        if (!statusEl) return;
        if (data.ok) {
          statusEl.textContent = '✓ Key valid — RapidAPI connected';
          statusEl.style.color = '#10b981';
        } else {
          statusEl.textContent = '✗ ' + (data.error || ('HTTP ' + data.status));
          statusEl.style.color = '#ef4444';
        }
      })
      .catch(function(e) {
        if (statusEl) { statusEl.textContent = '✗ ' + e.message; statusEl.style.color = '#ef4444'; }
      });
  }

  window.testFuelApi = testFuelApi;
  window.testMetalsApi = testMetalsApi;

  // ─── Post Generation Triggers ──────────────────────────────────────────

  function triggerFuelPosts() {
    if (!confirm('Generate/update all fuel WordPress posts?')) return;
    var btn = $('fuelPostsBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating...'; }
    fetchApi('/api/fuel/generate-posts', { method: 'POST', body: { fuelType: 'both' } })
      .then(function(data) {
        if (data.ok) {
          showToast('Fuel post generation started in background', 'success');
        } else {
          showToast('Error: ' + (data.error || 'Unknown'), 'error');
        }
      })
      .catch(function(err) { showToast('Error: ' + err.message, 'error'); })
      .finally(function() { if (btn) { btn.disabled = false; btn.textContent = '📝 Generate Posts'; } });
  }

  function triggerMetalsPosts() {
    if (!confirm('Generate/update all metals WordPress posts?')) return;
    var btn = $('metalsPostsBtn');
    if (btn) { btn.disabled = true; btn.textContent = '⏳ Generating...'; }
    fetchApi('/api/metals/generate-posts', { method: 'POST', body: { metalType: 'all' } })
      .then(function(data) {
        if (data.ok) {
          showToast('Metals post generation started in background', 'success');
        } else {
          showToast('Error: ' + (data.error || 'Unknown'), 'error');
        }
      })
      .catch(function(err) { showToast('Error: ' + err.message, 'error'); })
      .finally(function() { if (btn) { btn.disabled = false; btn.textContent = '📝 Generate Posts'; } });
  }

  function testWPConnection() {
    var el = $('wp-test-result');
    if (el) { el.textContent = 'Testing...'; el.style.color = '#888'; }
    fetchApi('/api/wp/test', { method: 'POST' })
      .then(function(data) {
        if (el) {
          el.textContent = data.ok ? '✅ Connected to ' + data.site : '❌ ' + (data.error || 'Failed');
          el.style.color = data.ok ? '#10b981' : '#ef4444';
        }
      })
      .catch(function(err) {
        if (el) { el.textContent = '❌ ' + err.message; el.style.color = '#ef4444'; }
      });
  }

  function saveWPPublishingSettings() {
    var updates = {};
    var siteUrl = $('wp-site-url');
    var username = $('wp-pub-username');
    var password = $('wp-pub-password');
    if (siteUrl && siteUrl.value && siteUrl.value.indexOf('••') === -1) updates.WP_SITE_URL = siteUrl.value;
    if (username && username.value && username.value.indexOf('••') === -1) updates.WP_USERNAME = username.value;
    if (password && password.value && password.value.indexOf('••') === -1) updates.WP_APP_PASSWORD = password.value;

    // Post defaults — read every time (they're already visible as real values)
    var postStatus = $('wp-post-status');
    var authorId = $('wp-author-id');
    var defCat = $('wp-default-category');
    var defAuthorUser = $('wp-default-author-username');
    var commentStatus = $('wp-comment-status');
    var pingStatus = $('wp-ping-status');
    if (postStatus) updates.WP_POST_STATUS = postStatus.value;
    if (authorId && authorId.value) updates.WP_AUTHOR_ID = authorId.value;
    if (defCat && defCat.value) updates.WP_DEFAULT_CATEGORY = defCat.value;
    if (defAuthorUser) updates.DEFAULT_AUTHOR_USERNAME = defAuthorUser.value;
    if (commentStatus) updates.WP_COMMENT_STATUS = commentStatus.value;
    if (pingStatus) updates.WP_PING_STATUS = pingStatus.value;

    if (!Object.keys(updates).length) { showToast('No changes to save', 'info'); return; }
    fetchApi('/api/settings', { method: 'PUT', body: updates })
      .then(function() { showToast('WordPress settings saved', 'success'); })
      .catch(function(err) { showToast('Save failed: ' + err.message, 'error'); });
  }

  function loadWPPublishingSettings() {
    fetchApi('/api/settings').then(function(data) {
      var s = data.settings || {};
      var el;
      el = $('wp-site-url');
      if (el) el.value = s.WP_SITE_URL || s.WP_URL || '';
      el = $('wp-pub-username');
      if (el) el.placeholder = s.WP_USERNAME ? '(saved — enter new to change)' : 'WordPress username';
      el = $('wp-pub-password');
      if (el) el.placeholder = s.WP_APP_PASSWORD ? '(saved — enter new to change)' : 'App password';

      // Post defaults — all safe to show as plain values
      el = $('wp-post-status');
      if (el) el.value = s.WP_POST_STATUS || 'draft';
      el = $('wp-author-id');
      if (el) el.value = s.WP_AUTHOR_ID || '';
      el = $('wp-default-category');
      if (el) el.value = s.WP_DEFAULT_CATEGORY || '';
      el = $('wp-default-author-username');
      if (el) el.value = s.DEFAULT_AUTHOR_USERNAME || '';
      el = $('wp-comment-status');
      if (el) el.value = s.WP_COMMENT_STATUS || '';
      el = $('wp-ping-status');
      if (el) el.value = s.WP_PING_STATUS || '';
    }).catch(function() {});
  }

  // ─── Bulk Config Import ──────────────────────────────────────────────────
  // Frontend wiring for the JSON-based bulk-import system. Endpoints live
  // behind BULK_IMPORT_ENABLED; the UI reads/writes that flag through the
  // same /api/settings PUT path as the rest of the settings page so admins
  // never need to touch the DB or env vars.

  var _bulkImportSelectedFile = null;
  var _bulkImportPreviewId = null;
  var _bulkImportEnabled = false;
  var _lastSnapshotList = [];

  function initBulkImport() {
    if ($('bulk-import-section')._wired) {
      // Re-wired, just refresh the dynamic data
      _refreshBulkImportStatus();
      _loadBulkImportSnapshots();
      return;
    }
    $('bulk-import-section')._wired = true;

    var fileInput = $('bulk-import-file');
    if (fileInput) {
      fileInput.addEventListener('change', function () {
        if (!this.files || this.files.length === 0) {
          _bulkImportSelectedFile = null;
          $('bulk-import-filename').textContent = 'No file selected';
          $('bulk-import-preview-btn').disabled = true;
          return;
        }
        var f = this.files[0];
        if (f.size > 5 * 1024 * 1024) {
          showToast('File is larger than 5 MB — rejected', 'error');
          this.value = '';
          return;
        }
        _bulkImportSelectedFile = f;
        $('bulk-import-filename').textContent = f.name + ' (' + Math.round(f.size / 1024) + ' KB)';
        $('bulk-import-preview-btn').disabled = !_bulkImportEnabled;
      });
    }

    var toggleBtn = $('bulk-import-toggle-btn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', function () {
        var newVal = _bulkImportEnabled ? 'false' : 'true';
        toggleBtn.disabled = true;
        fetchApi('/api/settings', { method: 'PUT', body: { BULK_IMPORT_ENABLED: newVal } })
          .then(function () {
            _bulkImportEnabled = (newVal === 'true');
            _renderBulkImportStatus();
            showToast('Bulk import ' + (_bulkImportEnabled ? 'enabled' : 'disabled'), 'success');
            if (_bulkImportEnabled) _loadBulkImportSnapshots();
          })
          .catch(function (err) { showToast('Toggle failed: ' + err.message, 'error'); })
          .finally(function () { toggleBtn.disabled = false; });
      });
    }

    var previewBtn = $('bulk-import-preview-btn');
    if (previewBtn) previewBtn.addEventListener('click', _bulkImportPreview);

    var exportBtn = $('bulk-import-export-btn');
    if (exportBtn) exportBtn.addEventListener('click', _bulkImportExport);

    var templateBtn = $('bulk-import-template-btn');
    if (templateBtn) templateBtn.addEventListener('click', _bulkImportDownloadTemplate);

    var applyBtn = $('bulk-import-apply-btn');
    if (applyBtn) applyBtn.addEventListener('click', _bulkImportApply);

    _refreshBulkImportStatus();
    _loadBulkImportSnapshots();
  }

  function _refreshBulkImportStatus() {
    fetchApi('/api/settings', { cacheMs: 0 }).then(function (data) {
      var s = data.settings || {};
      var v = s.BULK_IMPORT_ENABLED;
      _bulkImportEnabled = (v === true || v === 'true' || v === 1 || v === '1');
      _renderBulkImportStatus();
    }).catch(function (err) {
      // Was silently swallowed — surface it in the console so future debugging
      // sees the failure. The card still renders in its "Disabled" state.
      console.warn('[bulk-import] _refreshBulkImportStatus failed:', err && err.message);
    });
  }

  function _renderBulkImportStatus() {
    var pill = $('bulk-import-status-pill');
    var btn = $('bulk-import-toggle-btn');
    var previewBtn = $('bulk-import-preview-btn');
    var exportBtn = $('bulk-import-export-btn');
    if (pill) {
      pill.textContent = _bulkImportEnabled ? 'Enabled' : 'Disabled';
      pill.className = 'status-pill ' + (_bulkImportEnabled ? 'status-enabled' : 'status-disabled');
    }
    if (btn) {
      btn.textContent = _bulkImportEnabled ? 'Disable' : 'Enable';
      btn.className = 'btn btn-sm ' + (_bulkImportEnabled ? 'btn-warning' : 'btn-primary');
    }
    if (previewBtn) previewBtn.disabled = !_bulkImportEnabled || !_bulkImportSelectedFile;
    if (exportBtn) exportBtn.disabled = !_bulkImportEnabled;
  }

  function _bulkImportPreview() {
    if (!_bulkImportSelectedFile || !_bulkImportEnabled) return;
    var btn = $('bulk-import-preview-btn');
    btn.disabled = true;
    btn.textContent = 'Validating...';

    var fd = new FormData();
    fd.append('file', _bulkImportSelectedFile);

    var resetBtn = function () {
      btn.disabled = false;
      btn.innerHTML = '<svg data-lucide="eye" class="icon"></svg> Preview Changes';
      _refreshIcons();
    };

    // fetchApi passes FormData through untouched (it only JSON-wraps plain
    // objects) so multipart uploads go through the same error-handling and
    // auth-redirect path as every other API call.
    fetchApi('/api/config/import/preview', { method: 'POST', body: fd, cacheMs: 0 })
      .then(function (resp) {
        resetBtn();
        if (!resp.ok) {
          var msgs = (resp.errors || []).map(function (e) { return (e.path ? '[' + e.path + '] ' : '') + e.message; }).join('\n');
          showToast('Preview failed:\n' + (msgs || resp.error || 'unknown'), 'error');
          return;
        }
        _bulkImportPreviewId = resp.preview_id;
        _renderBulkImportPreview(resp);
      })
      .catch(function (err) {
        resetBtn();
        showToast('Preview failed: ' + err.message, 'error');
      });
  }

  function _renderBulkImportPreview(resp) {
    var modal = $('bulk-import-modal');
    var summary = $('bulk-import-modal-summary');
    var fullDiff = $('bulk-import-modal-fulldiff-pre');
    var title = $('bulk-import-modal-title');
    if (!modal || !summary) return;

    if (title) title.textContent = 'Preview Changes: ' + (resp.filename || 'config.json');

    var changes = resp.changes || {};
    var html = '<div class="bulk-import-summary">';

    // Defaults
    var defAfter = changes.defaults && changes.defaults.after ? Object.keys(changes.defaults.after) : [];
    if (defAfter.length > 0) {
      html += '<div class="bulk-import-summary-row">';
      html += '<span class="bi-icon">&#10003;</span> <strong>Defaults:</strong> ' + defAfter.length + ' setting(s) will change';
      html += '</div>';
    }

    // Authors
    var a = changes.authors || {};
    if ((a.added || []).length || (a.updated || []).length) {
      html += '<div class="bulk-import-summary-row"><span class="bi-icon">&#10003;</span> <strong>Authors:</strong> ' +
        (a.added || []).length + ' new, ' + (a.updated || []).length + ' updated, ' + (a.unchanged || []).length + ' unchanged</div>';
    }

    // Categories
    var c = changes.categories || {};
    if ((c.added || []).length || (c.updated || []).length) {
      html += '<div class="bulk-import-summary-row"><span class="bi-icon">&#10003;</span> <strong>Categories:</strong> ' +
        (c.added || []).length + ' new, ' + (c.updated || []).length + ' updated';
      if ((c.missing_on_wp || []).length) {
        html += ' <span class="bi-warn">(' + c.missing_on_wp.length + ' will be auto-created on WordPress)</span>';
      }
      html += '</div>';
    }

    // Tags
    var t = changes.tags || {};
    if (t.added || t.updated || t.removed) {
      html += '<div class="bulk-import-summary-row"><span class="bi-icon">&#10003;</span> <strong>Tags:</strong> ' +
        t.added + ' new, ' + t.updated + ' updated, ' + t.removed + ' removed</div>';
    }

    // Routing hints
    var rh = changes.routing_hints || {};
    var rhTotal = (rh.domains_changed || 0) + (rh.source_categories_changed || 0) + (rh.category_to_author_changed || 0);
    if (rhTotal > 0) {
      html += '<div class="bulk-import-summary-row"><span class="bi-icon">&#10003;</span> <strong>Routing hints:</strong> ' + rhTotal + ' change(s)</div>';
    }

    // Publish rules
    var pr = changes.publish_rules || {};
    if ((pr.added || []).length || (pr.updated || []).length) {
      html += '<div class="bulk-import-summary-row"><span class="bi-icon">&#10003;</span> <strong>Publish rules:</strong> ' +
        (pr.added || []).length + ' new, ' + (pr.updated || []).length + ' updated</div>';
    }

    // Modules
    var m = changes.modules || {};
    if (m.after) {
      html += '<div class="bulk-import-summary-row"><span class="bi-icon">&#10003;</span> <strong>Module routing:</strong> stored (forward-compat, not yet active)</div>';
    }

    if (html === '<div class="bulk-import-summary">') {
      html += '<div class="bulk-import-summary-row" style="color:#888;">No changes detected — this file matches the current state.</div>';
    }
    html += '</div>';

    // Warnings
    var warnings = resp.warnings || [];
    if (warnings.length > 0) {
      html += '<div class="bulk-import-warnings">';
      html += '<div class="bulk-import-warnings-header">&#9888; Warnings (' + warnings.length + ')</div>';
      html += '<ul>';
      for (var wi = 0; wi < warnings.length; wi++) {
        html += '<li><strong>' + escapeHtml(warnings[wi].path || '') + '</strong> ' + escapeHtml(warnings[wi].message) + '</li>';
      }
      html += '</ul></div>';
    }

    summary.innerHTML = html;

    if (fullDiff) {
      try { fullDiff.textContent = JSON.stringify(changes, null, 2); }
      catch (e) { fullDiff.textContent = '(failed to serialize diff)'; }
    }

    modal.classList.remove('hidden');
    _refreshIcons();
  }

  window.__closeBulkImportModal = function () {
    var modal = $('bulk-import-modal');
    if (modal) modal.classList.add('hidden');
  };

  function _bulkImportApply() {
    if (!_bulkImportPreviewId) {
      showToast('No preview to apply — re-upload the file', 'error');
      return;
    }
    var btn = $('bulk-import-apply-btn');
    btn.disabled = true;
    btn.textContent = 'Applying...';

    fetchApi('/api/config/import/apply', {
      method: 'POST',
      body: { preview_id: _bulkImportPreviewId },
    })
      .then(function (resp) {
        btn.disabled = false;
        btn.innerHTML = '<svg data-lucide="check" class="icon"></svg> Apply Changes';
        _refreshIcons();
        if (!resp.ok) {
          showToast('Apply failed: ' + (resp.error || (resp.errors && resp.errors[0] && resp.errors[0].message) || 'unknown'), 'error');
          // Server consumes the preview cache on read, so the preview_id is
          // now invalid — clear it AND close the modal so the user has to
          // re-upload. Otherwise they get stuck in a "Preview expired" loop.
          _bulkImportPreviewId = null;
          window.__closeBulkImportModal();
          return;
        }
        window.__closeBulkImportModal();
        _bulkImportPreviewId = null;
        _showUndoToast(resp);
        // Refresh EVERY section that might have changed. forceApiRefresh
        // just invalidates the cache; we also need to re-fetch + re-render.
        _loadBulkImportSnapshots();
        forceApiRefresh('/api/settings');
        forceApiRefresh('/api/publish-rules');
        forceApiRefresh('/api/wp/taxonomy');
        if (typeof loadPublishRules === 'function') loadPublishRules();
        if (typeof loadWPPublishingSettings === 'function') loadWPPublishingSettings();
        if (typeof loadWPTaxonomy === 'function') loadWPTaxonomy();
        if (typeof loadActiveConfigViewer === 'function') loadActiveConfigViewer();
      })
      .catch(function (err) {
        btn.disabled = false;
        btn.innerHTML = '<svg data-lucide="check" class="icon"></svg> Apply Changes';
        _refreshIcons();
        showToast('Apply failed: ' + err.message, 'error');
      });
  }

  function _showUndoToast(resp) {
    var sum = resp.summary || {};
    var parts = [];
    if (sum.authors_added || sum.authors_updated)
      parts.push((sum.authors_added + sum.authors_updated) + ' authors');
    if (sum.categories_added || sum.categories_updated)
      parts.push((sum.categories_added + sum.categories_updated) + ' categories');
    if (sum.tags_changed) parts.push(sum.tags_changed + ' tags');
    if (sum.publish_rules_added || sum.publish_rules_updated)
      parts.push((sum.publish_rules_added + sum.publish_rules_updated) + ' rules');
    if (sum.defaults_changed) parts.push(sum.defaults_changed + ' defaults');
    if (sum.routing_hints_changed) parts.push(sum.routing_hints_changed + ' routing hints');
    var breakdown = parts.length ? parts.join(' · ') : 'nothing changed';

    var container = $('toastContainer');
    if (!container) return;
    var toast = document.createElement('div');
    toast.className = 'toast toast-success bulk-import-undo-toast';
    toast.innerHTML =
      '<div style="display:flex;align-items:center;gap:12px;">' +
        '<div>' +
          '<div style="font-weight:600;">\u2713 Config imported</div>' +
          '<div style="font-size:11px;opacity:0.85;">' + escapeHtml(breakdown) + '</div>' +
          '<div style="font-size:10px;opacity:0.6;margin-top:2px;">Snapshot #' + resp.snapshot_id + ' captured the previous state</div>' +
        '</div>' +
        '<button class="btn btn-xs btn-secondary bulk-undo-btn" type="button">Undo</button>' +
      '</div>';
    container.appendChild(toast);

    var undoBtn = toast.querySelector('.bulk-undo-btn');
    var snapshotId = resp.snapshot_id;
    var dismissed = false;
    var timer = setTimeout(function () {
      dismissed = true;
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 60000);

    undoBtn.addEventListener('click', function () {
      if (dismissed) return;
      undoBtn.disabled = true;
      undoBtn.textContent = 'Restoring...';
      // applyImport captures a snapshot BEFORE it mutates, so the
      // snapshot_id in the response points to the pre-import state.
      // Restoring it reverts the import cleanly.
      fetchApi('/api/config/import/rollback/' + snapshotId, { method: 'POST' })
        .then(function (r) {
          if (r.ok) {
            showToast('Reverted to snapshot #' + snapshotId + ' (import UNDONE)', 'success');
            _loadBulkImportSnapshots();
            forceApiRefresh('/api/settings');
            forceApiRefresh('/api/publish-rules');
            forceApiRefresh('/api/wp/taxonomy');
            if (typeof loadPublishRules === 'function') loadPublishRules();
            if (typeof loadWPPublishingSettings === 'function') loadWPPublishingSettings();
            if (typeof loadActiveConfigViewer === 'function') loadActiveConfigViewer();
          } else {
            showToast('Undo failed: ' + (r.error || 'unknown'), 'error');
          }
        })
        .catch(function (err) { showToast('Undo failed: ' + err.message, 'error'); })
        .finally(function () {
          clearTimeout(timer);
          if (toast.parentNode) toast.parentNode.removeChild(toast);
        });
    });
  }

  function _bulkImportExport() {
    if (!_bulkImportEnabled) {
      showToast('Enable bulk import first', 'info');
      return;
    }
    // Plain anchor download — easier than fetching as blob since the server
    // already sets Content-Disposition.
    window.location.href = '/api/config/export';
  }

  function _bulkImportDownloadTemplate() {
    var template = {
      version: '1.0',
      generated_at: new Date().toISOString(),
      notes: 'Blank template — fill in the sections you need and remove the rest.',
      defaults: {
        post_status: 'draft',
        comment_status: '',
        ping_status: '',
        default_author_username: '',
        default_category_slug: ''
      },
      authors: [
        { username: 'example-author', display_name: 'Example Author', beats: ['general'], keywords: { 'sample': 5 } }
      ],
      categories: [
        { slug: 'general', display_name: 'General', default_author_username: 'example-author', keywords: { 'news': 5 } }
      ],
      tags: { 'sample term': 'Sample Tag' },
      routing_hints: { domains: {}, source_categories: {}, category_to_author: {} },
      publish_rules: [
        {
          key: 'example_rule',
          name: 'Example rule',
          priority: 100,
          is_active: true,
          match: { source_domain: 'example.com', source_category: null, title_keyword: null },
          assign: { category_slugs: ['general'], primary_category_slug: 'general', tag_slugs: [], author_username: 'example-author' }
        }
      ]
    };
    var blob = new Blob([JSON.stringify(template, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'hdf-config-template.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function _loadBulkImportSnapshots() {
    var container = $('bulk-import-snapshots-list');
    if (!container) return;
    if (!_bulkImportEnabled) {
      container.innerHTML = '<p class="placeholder-text" style="font-size:12px;">Enable bulk import to see snapshots.</p>';
      return;
    }
    fetchApi('/api/config/import/snapshots', { cacheMs: 0 })
      .then(function (resp) {
        _lastSnapshotList = (resp && resp.data) || [];
        if (!resp.ok || !resp.data || resp.data.length === 0) {
          container.innerHTML = '<p class="placeholder-text" style="font-size:12px;">No snapshots yet.</p>';
          return;
        }
        var html = '';
        for (var i = 0; i < resp.data.length; i++) {
          var s = resp.data[i];
          var when = s.created_at ? timeAgo(s.created_at + 'Z') : '';
          var byline = s.created_by ? ' · ' + escapeHtml(s.created_by) : '';
          var fname = s.import_filename ? ' · ' + escapeHtml(s.import_filename) : '';
          // Human-readable label — "before_import_..." becomes "Undo import"
          var humanLabel = s.label;
          if (s.label.indexOf('before_import') === 0) {
            humanLabel = '↶ Before import';
          } else if (s.label.indexOf('factory_default') === 0) {
            humanLabel = '⊘ Factory default';
          }
          html += '<div class="bulk-snapshot-row">';
          html += '<span class="bulk-snapshot-id">#' + s.id + '</span>';
          html += '<span class="bulk-snapshot-label" title="' + escapeHtml(s.label) + '">' + escapeHtml(humanLabel) + '</span>';
          html += '<span class="bulk-snapshot-meta">' + when + byline + fname + '</span>';
          html += '<button class="btn btn-xs btn-secondary" data-snapshot-restore="' + s.id + '">Restore</button>';
          html += '</div>';
        }
        container.innerHTML = html;
        var restoreBtns = container.querySelectorAll('[data-snapshot-restore]');
        for (var ri = 0; ri < restoreBtns.length; ri++) {
          restoreBtns[ri].addEventListener('click', function () {
            var sid = parseInt(this.getAttribute('data-snapshot-restore'), 10);
            _bulkImportRestore(sid);
          });
        }
      })
      .catch(function (err) {
        container.innerHTML = '<p class="placeholder-text" style="font-size:12px;color:var(--danger);">Failed: ' + escapeHtml(err.message) + '</p>';
      });
  }

  function _bulkImportRestore(snapshotId) {
    // Snapshots labeled "before_import_*" represent the state BEFORE an
    // import. Restoring them UNDOES that import. Make the confirm text
    // crystal clear so admins don't click Restore expecting to "load" the
    // imported rules.
    var snap = (_lastSnapshotList || []).filter(function (s) { return s.id === snapshotId; })[0];
    var label = snap ? snap.label : 'snapshot #' + snapshotId;
    var msg = 'Revert to ' + label + '?\n\n';
    if (label.indexOf('before_import') === 0) {
      msg += 'This snapshot is the state BEFORE an import. Restoring it will UNDO that import — your imported rules, keyword dictionaries, and defaults will be replaced with their previous values.\n\n';
    } else if (label.indexOf('factory_default') === 0) {
      msg += 'This will reset import-managed settings to their initial state — all your imported rules and dictionaries will be cleared.\n\n';
    } else {
      msg += 'This will replace your current import-managed settings and rules with the ones in this snapshot.\n\n';
    }
    msg += 'Note: Categories/tags created on WordPress by previous imports will NOT be deleted — only your local routing config is restored.';
    if (!confirm(msg)) return;
    fetchApi('/api/config/import/rollback/' + snapshotId, { method: 'POST' })
      .then(function (r) {
        if (r.ok) {
          showToast('Restored to snapshot #' + snapshotId, 'success');
          _loadBulkImportSnapshots();
          forceApiRefresh('/api/settings');
          forceApiRefresh('/api/publish-rules');
          forceApiRefresh('/api/wp/taxonomy');
          if (typeof loadPublishRules === 'function') loadPublishRules();
          if (typeof loadWPPublishingSettings === 'function') loadWPPublishingSettings();
          if (typeof loadActiveConfigViewer === 'function') loadActiveConfigViewer();
        } else {
          showToast('Restore failed: ' + (r.error || 'unknown'), 'error');
        }
      })
      .catch(function (err) { showToast('Restore failed: ' + err.message, 'error'); });
  }

  // ─── Active Configuration Viewer ────────────────────────────────────────
  // Renders the full live state of the import system as a human-readable
  // report on the WP Settings page. Fetches /api/config/export (the same
  // endpoint the Export button hits) so it's always in sync with what the
  // engine would actually write out.
  function loadActiveConfigViewer() {
    var container = $('active-config-viewer');
    if (!container) return;
    container.innerHTML = '<p class="placeholder-text" style="font-size:12px;">Loading...</p>';

    var refreshBtn = $('active-config-refresh-btn');
    if (refreshBtn && !refreshBtn._wired) {
      refreshBtn._wired = true;
      refreshBtn.addEventListener('click', function () {
        forceApiRefresh('/api/config');
        loadActiveConfigViewer();
      });
    }

    fetch('/api/config/export', { credentials: 'same-origin' })
      .then(function (r) {
        if (r.status === 404) {
          container.innerHTML = '<p class="placeholder-text" style="font-size:12px;color:var(--warning);">Bulk import is disabled. Enable it above to see the active configuration.</p>';
          return null;
        }
        if (!r.ok) throw new Error('Failed to load config (HTTP ' + r.status + ')');
        return r.json();
      })
      .then(function (cfg) {
        if (!cfg) return;
        container.innerHTML = _renderActiveConfig(cfg);
        _refreshIcons();
      })
      .catch(function (err) {
        container.innerHTML = '<p class="placeholder-text" style="font-size:12px;color:var(--danger);">' + escapeHtml(err.message) + '</p>';
      });
  }

  function _renderActiveConfig(cfg) {
    var out = '';
    var hasAny = false;

    // 0. Health banner — shows at a glance which sections are configured
    //    vs empty. Admins who see "only defaults set" know immediately that
    //    their JSON upload never applied (or was rolled back).
    var health = _renderConfigHealth(cfg);
    out += health.html;
    var nonDefaultsCount = health.populatedSections - (Object.keys(cfg.defaults || {}).length ? 1 : 0);
    var hasImportedData = nonDefaultsCount > 0;
    if (!hasImportedData && Object.keys(cfg.defaults || {}).length > 0) {
      // User has manually-set defaults but no imported content. Warn them.
      out += '<div class="cfg-empty-warning">' +
        '<strong>&#9888; Only global defaults are set.</strong> ' +
        'No authors, categories, tags, or publish rules have been imported yet. ' +
        'If you uploaded a JSON file but don\'t see your data here, click <strong>Preview Changes</strong> in the Bulk Config Import card above, then <strong>Apply Changes</strong> in the modal. ' +
        'Do <strong>NOT</strong> click Restore after applying — that UNDOES the import.' +
        '</div>';
    }

    // 1. Authors Overview — per-author roll-up of everything routed to them
    //    (beats, mapped categories, publish rules by match type, tag coverage,
    //    keyword count + top). Shown first because it's the admin's primary
    //    mental model: "who writes what".
    var authorsOverview = _renderAuthorsOverview(cfg);
    if (authorsOverview) {
      hasAny = true;
      out += authorsOverview;
    }

    // 2. Defaults
    var defs = cfg.defaults || {};
    var defKeys = Object.keys(defs);
    if (defKeys.length) {
      hasAny = true;
      out += _configCard('Global Defaults',
        '<table class="config-table"><tbody>' +
        defKeys.map(function (k) {
          return '<tr><td class="cfg-key">' + escapeHtml(k) + '</td><td class="cfg-val">' + escapeHtml(defs[k]) + '</td></tr>';
        }).join('') +
        '</tbody></table>'
      );
    }

    // 3. Authors
    var authors = cfg.authors || [];
    if (authors.length) {
      hasAny = true;
      var authorRows = authors.map(function (a) {
        var kwCount = Object.keys(a.keywords || {}).length;
        var beats = (a.beats || []).join(', ');
        var topKeywords = Object.keys(a.keywords || {}).slice(0, 8).map(function (k) {
          return '<span class="cfg-kw-chip">' + escapeHtml(k) + '<small>' + a.keywords[k] + '</small></span>';
        }).join('');
        var overflow = kwCount > 8 ? '<span class="cfg-kw-more">+' + (kwCount - 8) + ' more</span>' : '';
        return '<tr>' +
          '<td class="cfg-user">' + escapeHtml(a.username) + (a.display_name ? '<small>' + escapeHtml(a.display_name) + '</small>' : '') + '</td>' +
          '<td>' + escapeHtml(beats) + '</td>' +
          '<td>' + kwCount + '</td>' +
          '<td class="cfg-kw-cell">' + topKeywords + overflow + '</td>' +
          '</tr>';
      }).join('');
      out += _configCard('Authors (' + authors.length + ')',
        '<table class="config-table"><thead><tr><th>Username</th><th>Beats</th><th>#KW</th><th>Top keywords</th></tr></thead><tbody>' +
        authorRows + '</tbody></table>'
      );
    }

    // 3. Categories
    var cats = cfg.categories || [];
    if (cats.length) {
      hasAny = true;
      var catRows = cats.map(function (c) {
        var kwCount = Object.keys(c.keywords || {}).length;
        var topKeywords = Object.keys(c.keywords || {}).slice(0, 8).map(function (k) {
          return '<span class="cfg-kw-chip">' + escapeHtml(k) + '<small>' + c.keywords[k] + '</small></span>';
        }).join('');
        var overflow = kwCount > 8 ? '<span class="cfg-kw-more">+' + (kwCount - 8) + ' more</span>' : '';
        return '<tr>' +
          '<td class="cfg-user">' + escapeHtml(c.slug) + '</td>' +
          '<td>' + escapeHtml(c.default_author_username || '—') + '</td>' +
          '<td>' + kwCount + '</td>' +
          '<td class="cfg-kw-cell">' + topKeywords + overflow + '</td>' +
          '</tr>';
      }).join('');
      out += _configCard('Categories (' + cats.length + ')',
        '<table class="config-table"><thead><tr><th>Slug</th><th>Default author</th><th>#KW</th><th>Top keywords</th></tr></thead><tbody>' +
        catRows + '</tbody></table>'
      );
    }

    // 4. Tags (grouped by canonical)
    var tags = cfg.tags || {};
    var tagKeys = Object.keys(tags);
    if (tagKeys.length) {
      hasAny = true;
      var canonGroups = {};
      tagKeys.forEach(function (raw) {
        var canon = tags[raw];
        (canonGroups[canon] = canonGroups[canon] || []).push(raw);
      });
      var canonSorted = Object.keys(canonGroups).sort();
      var tagRows = canonSorted.map(function (canon) {
        return '<tr><td class="cfg-canon">' + escapeHtml(canon) + '</td><td class="cfg-raws">' +
          canonGroups[canon].map(function (r) { return '<code>' + escapeHtml(r) + '</code>'; }).join(' ') +
          '</td></tr>';
      }).join('');
      out += _configCard('Tag Normalization (' + tagKeys.length + ' raw → ' + canonSorted.length + ' canonical)',
        '<table class="config-table"><thead><tr><th>Canonical tag</th><th>Raw terms</th></tr></thead><tbody>' +
        tagRows + '</tbody></table>'
      );
    }

    // 5. Routing hints
    var rh = cfg.routing_hints || {};
    var rhKeys = ['domains', 'source_categories', 'category_to_author'];
    var rhTotal = rhKeys.reduce(function (a, k) { return a + Object.keys(rh[k] || {}).length; }, 0);
    if (rhTotal > 0) {
      hasAny = true;
      var rhBody = '';
      rhKeys.forEach(function (k) {
        var obj = rh[k] || {};
        var keys = Object.keys(obj);
        if (!keys.length) return;
        var label = k === 'domains' ? 'Domain hints' : k === 'source_categories' ? 'Source category hints' : 'Category → author fallback';
        rhBody += '<div class="cfg-subsection"><h5>' + label + ' (' + keys.length + ')</h5>';
        rhBody += '<table class="config-table"><tbody>';
        rhBody += keys.map(function (kk) {
          return '<tr><td class="cfg-key">' + escapeHtml(kk) + '</td><td class="cfg-arrow">→</td><td>' + escapeHtml(obj[kk]) + '</td></tr>';
        }).join('');
        rhBody += '</tbody></table></div>';
      });
      out += _configCard('Routing Hints', rhBody);
    }

    // 6. Publish rules
    var rules = cfg.publish_rules || [];
    if (rules.length) {
      hasAny = true;
      var sorted = rules.slice().sort(function (a, b) { return (b.priority || 0) - (a.priority || 0); });
      var ruleRows = sorted.map(function (r) {
        var m = r.match || {};
        var a = r.assign || {};
        var matchParts = [];
        if (m.source_domain) matchParts.push('<strong>domain</strong>=' + escapeHtml(m.source_domain));
        if (m.source_category) matchParts.push('<strong>src_cat</strong>=' + escapeHtml(m.source_category));
        if (m.title_keyword) matchParts.push('<strong>title</strong>~' + escapeHtml(m.title_keyword));
        var matchText = matchParts.length ? matchParts.join(' & ') : '<em style="color:var(--text-tertiary);">any</em>';
        var assignParts = [];
        if (a.author_username) assignParts.push('<strong>→</strong> ' + escapeHtml(a.author_username));
        if (a.category_slugs && a.category_slugs.length) assignParts.push('<strong>cats:</strong> ' + a.category_slugs.map(escapeHtml).join(', '));
        if (a.tag_slugs && a.tag_slugs.length) assignParts.push('<strong>tags:</strong> ' + a.tag_slugs.map(escapeHtml).join(', '));
        var activeBadge = r.is_active === false ? '<span class="cfg-badge cfg-badge-off">off</span>' : '';
        return '<tr>' +
          '<td class="cfg-pri"><span class="cfg-prio-pill">P' + (r.priority || 0) + '</span></td>' +
          '<td class="cfg-key-cell"><code>' + escapeHtml(r.key || '—') + '</code>' + activeBadge + '<br><small>' + escapeHtml(r.name || '') + '</small></td>' +
          '<td>' + matchText + '</td>' +
          '<td>' + (assignParts.join(' · ') || '<em>none</em>') + '</td>' +
          '</tr>';
      }).join('');
      out += _configCard('Publish Rules (' + rules.length + ', by priority)',
        '<table class="config-table config-rules"><thead><tr><th>Pri</th><th>Key</th><th>Match IF</th><th>Assign THEN</th></tr></thead><tbody>' +
        ruleRows + '</tbody></table>'
      );
    }

    // 7. Modules (forward-compat)
    var mods = cfg.modules;
    if (mods && typeof mods === 'object' && Object.keys(mods).length) {
      hasAny = true;
      out += _configCard('Module Routing (stored, not yet active)',
        '<pre class="cfg-raw">' + escapeHtml(JSON.stringify(mods, null, 2)) + '</pre>'
      );
    }

    if (!hasAny) {
      out = '<p class="placeholder-text" style="font-size:12px;">No configuration imported yet. Upload a JSON file above to get started.</p>';
    }

    return out;
  }

  function _configCard(title, body) {
    return '<div class="cfg-card"><div class="cfg-card-title">' + escapeHtml(title) + '</div>' + body + '</div>';
  }

  // Quick-glance health banner — shows 7 pills, one per config section, each
  // green (populated) or grey (empty). Makes it instantly obvious which parts
  // of the import actually landed vs. which are still empty.
  function _renderConfigHealth(cfg) {
    var sections = [
      { key: 'defaults',      label: 'Defaults',    count: Object.keys(cfg.defaults || {}).length },
      { key: 'authors',       label: 'Authors',     count: (cfg.authors || []).length },
      { key: 'categories',    label: 'Categories',  count: (cfg.categories || []).length },
      { key: 'tags',          label: 'Tags',        count: Object.keys(cfg.tags || {}).length },
      { key: 'routing_hints', label: 'Routing',     count:
          Object.keys((cfg.routing_hints || {}).domains || {}).length +
          Object.keys((cfg.routing_hints || {}).source_categories || {}).length +
          Object.keys((cfg.routing_hints || {}).category_to_author || {}).length
      },
      { key: 'publish_rules', label: 'Rules',       count: (cfg.publish_rules || []).length },
      { key: 'modules',       label: 'Modules',     count: cfg.modules && typeof cfg.modules === 'object' ? Object.keys(cfg.modules).length : 0 },
    ];
    var populatedSections = 0;
    var pills = sections.map(function (s) {
      var cls = s.count > 0 ? 'cfg-health-pill cfg-health-ok' : 'cfg-health-pill cfg-health-empty';
      if (s.count > 0) populatedSections++;
      var glyph = s.count > 0 ? '\u2713' : '\u2014';
      return '<span class="' + cls + '">' + glyph + ' ' + s.label + ' <strong>' + s.count + '</strong></span>';
    }).join('');
    return {
      html: '<div class="cfg-health-banner">' + pills + '</div>',
      populatedSections: populatedSections,
    };
  }

  // ─── Authors Overview ────────────────────────────────────────────────────
  // Per-author roll-up: cross-references authors[] with categories[],
  // routing_hints.category_to_author, and publish_rules[] to build a
  // "who writes what" dashboard. Shows each author as a box with:
  //   - their beats (self-declared)
  //   - categories with their username as default_author_username
  //   - publish rules targeting them, split into domain-based + title-based
  //   - union of all tag_slugs they're assigned
  //   - keyword count + top 10 scoring keywords
  function _renderAuthorsOverview(cfg) {
    var authors = cfg.authors || [];
    if (!authors.length) return '';

    var categories = cfg.categories || [];
    var publishRules = cfg.publish_rules || [];
    var routingHints = cfg.routing_hints || {};
    var catToAuthor = routingHints.category_to_author || {};

    // Build a reverse index: username → { mappedCategories, domainRules, titleRules, srcCatRules, tagsUnion, routingHintCats }
    var byAuthor = {};
    authors.forEach(function (a) {
      byAuthor[a.username] = {
        mappedCategories: [],
        routingHintCats:  [],
        domainRules:      [],
        titleRules:       [],
        srcCatRules:      [],
        tagsUnion:        {},
      };
    });

    // Categories with default_author_username → mappedCategories
    categories.forEach(function (c) {
      if (c.default_author_username && byAuthor[c.default_author_username]) {
        byAuthor[c.default_author_username].mappedCategories.push(c.slug);
      }
    });

    // routing_hints.category_to_author — category → author fallback
    Object.keys(catToAuthor).forEach(function (catSlug) {
      var author = catToAuthor[catSlug];
      if (byAuthor[author]) byAuthor[author].routingHintCats.push(catSlug);
    });

    // publish_rules — split by match type
    publishRules.forEach(function (r) {
      var a = r.assign || {};
      var m = r.match || {};
      if (!a.author_username || !byAuthor[a.author_username]) return;
      var bucket = byAuthor[a.author_username];
      var ruleSummary = {
        key:        r.key,
        priority:   r.priority || 0,
        categories: (a.category_slugs || []).slice(),
        tags:       (a.tag_slugs || []).slice(),
      };
      if (m.source_domain) {
        ruleSummary.domain = m.source_domain;
        bucket.domainRules.push(ruleSummary);
      } else if (m.title_keyword) {
        ruleSummary.titleKeyword = m.title_keyword;
        bucket.titleRules.push(ruleSummary);
      } else if (m.source_category) {
        ruleSummary.sourceCategory = m.source_category;
        bucket.srcCatRules.push(ruleSummary);
      }
      // Union tags
      (a.tag_slugs || []).forEach(function (t) { bucket.tagsUnion[t] = true; });
    });

    // Render each author box
    var boxes = authors.map(function (a) {
      var bucket = byAuthor[a.username];
      var keywordsObj = a.keywords || {};
      var keywordsCount = Object.keys(keywordsObj).length;

      // Top 10 keywords sorted by score descending
      var topKw = Object.keys(keywordsObj)
        .sort(function (x, y) { return (keywordsObj[y] || 0) - (keywordsObj[x] || 0); })
        .slice(0, 10);

      var beats = (a.beats || []).slice();
      var allTags = Object.keys(bucket.tagsUnion).sort();
      var domainList = bucket.domainRules.slice().sort(function (x, y) { return y.priority - x.priority; });
      var titleList = bucket.titleRules.slice().sort(function (x, y) { return y.priority - x.priority; });

      // Color-code by author so each box is visually distinct
      var hue = _hashToHue(a.username);

      var html = '<div class="author-box" style="border-left-color: hsl(' + hue + ', 70%, 55%);">';
      html += '<div class="author-box-header">';
      html += '<div class="author-box-name">' + escapeHtml(a.display_name || a.username) + '</div>';
      html += '<div class="author-box-slug">@' + escapeHtml(a.username) + '</div>';
      html += '</div>';

      html += '<div class="author-box-body">';

      // Row: Beats
      html += _authorRow('Beats', beats.length
        ? beats.map(function (b) { return '<span class="author-chip author-chip-beat">' + escapeHtml(b) + '</span>'; }).join('')
        : '<em class="author-empty">none</em>');

      // Row: Mapped categories (primary)
      var allCats = bucket.mappedCategories.slice();
      bucket.routingHintCats.forEach(function (c) { if (allCats.indexOf(c) === -1) allCats.push(c); });
      html += _authorRow('Categories', allCats.length
        ? allCats.map(function (c) { return '<span class="author-chip author-chip-cat">' + escapeHtml(c) + '</span>'; }).join('')
        : '<em class="author-empty">none</em>');

      // Row: Domain rules
      if (domainList.length) {
        var domainHtml = domainList.map(function (r) {
          var tagStr = r.tags.length ? ' <small>+ tags: ' + r.tags.map(escapeHtml).join(', ') + '</small>' : '';
          var catStr = r.categories.length ? ' → ' + r.categories.map(escapeHtml).join(', ') : '';
          return '<div class="author-rule-line">' +
            '<span class="author-prio-pill">P' + r.priority + '</span> ' +
            '<code>' + escapeHtml(r.domain) + '</code>' + catStr + tagStr +
            '</div>';
        }).join('');
        html += _authorRow('Domain rules (' + domainList.length + ')', domainHtml);
      }

      // Row: Title keyword rules
      if (titleList.length) {
        var titleHtml = titleList.map(function (r) {
          var tagStr = r.tags.length ? ' <small>+ tags: ' + r.tags.map(escapeHtml).join(', ') + '</small>' : '';
          var catStr = r.categories.length ? ' → ' + r.categories.map(escapeHtml).join(', ') : '';
          return '<div class="author-rule-line">' +
            '<span class="author-prio-pill">P' + r.priority + '</span> ' +
            'title ~ "<code>' + escapeHtml(r.titleKeyword) + '</code>"' + catStr + tagStr +
            '</div>';
        }).join('');
        html += _authorRow('Title rules (' + titleList.length + ')', titleHtml);
      }

      // Row: Source-category rules
      if (bucket.srcCatRules.length) {
        var srcHtml = bucket.srcCatRules.map(function (r) {
          var catStr = r.categories.length ? ' → ' + r.categories.map(escapeHtml).join(', ') : '';
          return '<div class="author-rule-line">' +
            '<span class="author-prio-pill">P' + r.priority + '</span> ' +
            'src_cat ~ "<code>' + escapeHtml(r.sourceCategory) + '</code>"' + catStr +
            '</div>';
        }).join('');
        html += _authorRow('Source-category rules', srcHtml);
      }

      // Row: Tag coverage
      if (allTags.length) {
        html += _authorRow('Tags handled', allTags.map(function (t) {
          return '<span class="author-chip author-chip-tag">' + escapeHtml(t) + '</span>';
        }).join(''));
      }

      // Row: Keyword scoring
      var kwLabel = keywordsCount + ' keywords';
      var kwBody = keywordsCount
        ? topKw.map(function (k) {
            return '<span class="author-chip author-chip-kw">' + escapeHtml(k) + '<small>' + keywordsObj[k] + '</small></span>';
          }).join('') + (keywordsCount > 10 ? ' <span class="author-empty">+' + (keywordsCount - 10) + ' more</span>' : '')
        : '<em class="author-empty">no scoring dictionary</em>';
      html += _authorRow(kwLabel, kwBody);

      html += '</div></div>';
      return html;
    }).join('');

    // Summary strip at the top
    var totalRules = publishRules.length;
    var totalMappedCats = categories.filter(function (c) { return !!c.default_author_username; }).length;
    var summary =
      '<div class="author-overview-summary">' +
        '<strong>' + authors.length + '</strong> authors · ' +
        '<strong>' + totalMappedCats + '</strong> category→author mappings · ' +
        '<strong>' + totalRules + '</strong> publish rules' +
      '</div>';

    return _configCard('Authors Overview',
      summary + '<div class="author-box-grid">' + boxes + '</div>'
    );
  }

  function _authorRow(label, body) {
    return '<div class="author-row">' +
      '<div class="author-row-label">' + escapeHtml(label) + '</div>' +
      '<div class="author-row-body">' + body + '</div>' +
      '</div>';
  }

  // Stable color per username so each author box has its own hue.
  // Not cryptographic — just a fast fold of char codes.
  function _hashToHue(str) {
    var hash = 0;
    for (var i = 0; i < str.length; i++) hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    return Math.abs(hash) % 360;
  }

  // ─── Shared helpers (Day 3) ──────────────────────────────────────────────

  function timeAgo(dateStr) {
    if (!dateStr) return 'Never';
    var diff = Date.now() - new Date(dateStr).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    return Math.floor(hrs / 24) + 'd ago';
  }

  function esc(s) {
    return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function durFmt(ms) {
    if (!ms) return '—';
    if (ms < 60000) return Math.round(ms / 1000) + 's';
    return Math.round(ms / 60000) + 'm ' + Math.round((ms % 60000) / 1000) + 's';
  }

  function renderPosts(tbodyId, data, module) {
    var tbody = document.getElementById(tbodyId);
    if (!tbody) return;
    if (!data.length) { tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">No posts yet</td></tr>'; return; }
    tbody.innerHTML = data.map(function(p) {
      var typeColor = p.item_type === 'petrol' ? 'badge-petrol' : p.item_type === 'diesel' ? 'badge-diesel' :
        p.item_type === 'gold' ? 'badge-gold' : p.item_type === 'silver' ? 'badge-silver' : 'badge-platinum';
      var dotClass = p.wp_status === 'publish' ? 'dot-green' : p.wp_status === 'draft' ? 'dot-yellow' : 'dot-red';
      return '<tr class="' + (p.action === 'failed' ? 'row-error' : '') + '">' +
        '<td><strong>' + esc(p.item_name) + '</strong></td>' +
        '<td><span class="badge ' + typeColor + '">' + esc(p.item_type) + '</span></td>' +
        '<td><span class="badge badge-tier">' + esc(p.post_type) + '</span></td>' +
        '<td><span class="dot ' + dotClass + '"></span>' + esc(p.wp_status || 'unknown') + '</td>' +
        '<td>' + esc(p.action || '—') + (p.error_message ? ' <span class="text-red text-sm" title="' + esc(p.error_message) + '">⚠</span>' : '') + '</td>' +
        '<td class="text-muted text-sm" title="' + esc(p.created_at) + '">' + timeAgo(p.created_at) + '</td>' +
        '<td>' +
          (p.wp_url && /^https?:\/\//i.test(p.wp_url) ? '<a href="' + esc(p.wp_url) + '" target="_blank" rel="noopener noreferrer" class="btn-icon" title="Open WP">🔗</a>' : '') +
          '<button class="btn-icon" title="Regenerate" data-click="regeneratePost" data-module="' + esc(module) + '" data-item-type="' + esc(p.item_type) + '" data-post-type="' + esc(p.post_type) + '" data-item-name="' + esc(p.item_name) + '">🔄</button>' +
        '</td></tr>';
    }).join('');
  }

  function renderPaginationById(containerId, currentPage, totalPages, onPage) {
    var el = document.getElementById(containerId);
    if (!el) return;
    if (totalPages <= 1) { el.innerHTML = ''; return; }
    var html = '';
    if (currentPage > 1) html += '<button class="btn-page" data-p="' + (currentPage-1) + '">← Prev</button>';
    var start = Math.max(1, currentPage-2), end = Math.min(totalPages, currentPage+2);
    for (var i = start; i <= end; i++) {
      html += '<button class="btn-page' + (i === currentPage ? ' active' : '') + '" data-p="' + i + '">' + i + '</button>';
    }
    if (currentPage < totalPages) html += '<button class="btn-page" data-p="' + (currentPage+1) + '">Next →</button>';
    el.innerHTML = html;
    el.onclick = function(e) {
      var p = e.target.dataset && e.target.dataset.p;
      if (p) onPage(parseInt(p));
    };
  }

  async function regeneratePost(module, itemType, postType, itemName) {
    if (!confirm('Regenerate ' + itemType + ' ' + postType + ' post for ' + itemName + '?')) return;
    try {
      var res = await fetch('/api/posts/regenerate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ module: module, item_type: itemType, post_type: postType, item_name: itemName })
      });
      var data = await res.json();
      if (data.ok) {
        showToast('✅ ' + (data.result && data.result.action ? data.result.action : 'done') + ': ' + itemName);
        if (module === 'fuel') loadFuelPosts();
        else loadMetalsPosts();
      } else {
        showToast('❌ ' + (data.error || 'Failed'), 'error');
      }
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
  }
  window.regeneratePost = regeneratePost;

  // ─── Fuel Tab System ────────────────────────────────────────────────────

  function switchFuelTab(tab) {
    document.querySelectorAll('#fuel-tabs .tab').forEach(function(b) { b.classList.remove('active'); });
    var activeBtn = document.querySelector('#fuel-tabs [data-tab="' + tab + '"]');
    if (activeBtn) activeBtn.classList.add('active');
    document.querySelectorAll('#page-fuel .tab-content').forEach(function(el) { el.style.display = 'none'; });
    var tabEl = document.getElementById('fuel-tab-' + tab);
    if (tabEl) tabEl.style.display = '';
    if (tab === 'posts') loadFuelPosts();
    if (tab === 'logs') loadFuelFetchLog();
    if (tab === 'quality') loadFuelDataQuality();
  }
  window.switchFuelTab = switchFuelTab;

  var _fuelPostsPage = 1;

  function loadFuelPosts(page) {
    _fuelPostsPage = page || 1;
    var type = (document.getElementById('fuel-posts-type-filter') || {}).value || '';
    var tier = (document.getElementById('fuel-posts-tier-filter') || {}).value || '';
    var status = (document.getElementById('fuel-posts-status-filter') || {}).value || '';
    var search = (document.getElementById('fuel-posts-search') || {}).value || '';

    var params = 'module=fuel&page=' + _fuelPostsPage + '&limit=50';
    if (type) params += '&item_type=' + encodeURIComponent(type);
    if (tier) params += '&post_type=' + encodeURIComponent(tier);
    if (status) params += '&action=' + encodeURIComponent(status);
    if (search) params += '&search=' + encodeURIComponent(search);

    fetchApi('/api/posts/list?' + params).then(function(json) {
      renderPosts('fuel-posts-tbody', json.data || [], 'fuel');
      renderPaginationById('fuel-posts-pagination', json.page, json.pages, loadFuelPosts);
    }).catch(function() {});

    fetchApi('/api/posts/stats').then(function(data) {
      var f = data.fuel || {};
      var set = function(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
      set('fuel-posts-total', f.total || 0);
      set('fuel-posts-updated-today', f.updated_today || 0);
      set('fuel-posts-failed', f.failed || 0);
    }).catch(function() {});
  }
  window.loadFuelPosts = loadFuelPosts;

  function loadFuelFetchLog() {
    fetchApi('/api/fetch-log?module=fuel&limit=30').then(function(json) {
      var tbody = document.getElementById('fuel-fetch-log-tbody');
      if (!tbody) return;
      var rows = json.data || [];
      if (!rows.length) { tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No fetch history yet</td></tr>'; return; }
      tbody.innerHTML = rows.map(function(l) {
        var details = {};
        try { details = JSON.parse(l.details || '{}'); } catch (e) {}
        var failed = details.failedCities && details.failedCities.length > 0 ? details.failedCities.join(', ') : '—';
        return '<tr>' +
          '<td class="text-muted text-sm" title="' + esc(l.created_at) + '">' + timeAgo(l.created_at) + '</td>' +
          '<td><span class="badge badge-' + esc(l.fetch_type || 'scheduled') + '">' + esc(l.fetch_type || 'scheduled') + '</span></td>' +
          '<td class="text-green">' + (l.cities_ok || 0) + '</td>' +
          '<td class="' + (l.cities_fail > 0 ? 'text-red' : 'text-muted') + '">' + (l.cities_fail || 0) + '</td>' +
          '<td class="text-muted">' + durFmt(l.duration_ms) + '</td>' +
          '<td class="text-sm text-muted" style="max-width:200px;overflow:hidden;text-overflow:ellipsis;">' + esc(failed) + '</td>' +
          '</tr>';
      }).join('');
    }).catch(function() {});
  }

  function loadFuelDataQuality() {
    fetchApi('/api/fuel/data-quality').then(function(q) {
      // Coverage table
      var tbody = document.getElementById('fuel-coverage-tbody');
      if (tbody && q.coverageByState) {
        tbody.innerHTML = q.coverageByState.map(function(s) {
          var pct = s.total > 0 ? Math.round(s.fetched / s.total * 100) : 0;
          var color = pct >= 80 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444';
          return '<tr><td>' + esc(s.state) + '</td><td>' + s.total + '</td><td style="color:' + color + '">' + s.fetched +
            '</td><td style="color:' + color + '">' + pct + '%</td>' +
            '<td><div class="bar-bg"><div class="bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div></td></tr>';
        }).join('');
      }
      // Stale cities
      var staleEl = document.getElementById('fuel-stale-cities');
      if (staleEl) {
        if (!q.staleCities || !q.staleCities.length) {
          staleEl.innerHTML = '<span class="text-green">✅ All cities have recent data</span>';
        } else {
          staleEl.innerHTML = q.staleCities.map(function(c) {
            return '<span class="pill pill-warn">' + esc(c.city_name) + ' (' + esc(c.state) + ') — ' + (c.days_since || '?') + 'd</span>';
          }).join('');
        }
      }
      // Source chart
      if (q.sourceBreakdown && window.Chart) {
        var ctx = document.getElementById('fuel-source-chart');
        if (ctx) {
          if (ctx._chartInstance) ctx._chartInstance.destroy();
          var labels = Object.keys(q.sourceBreakdown);
          var values = Object.values(q.sourceBreakdown);
          var colors = { api3: '#10b981', derived: '#3b82f6', carryforward: '#f59e0b', manual: '#a78bfa', imported: '#6b7280', autofill: '#f59e0b' };
          ctx._chartInstance = new Chart(ctx, {
            type: 'doughnut',
            data: { labels: labels, datasets: [{ data: values, backgroundColor: labels.map(function(l) { return colors[l] || '#6b7280'; }) }] },
            options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { color: '#9ca3af', font: { size: 11 } } } } }
          });
        }
      }
    }).catch(function() {});
  }

  // ─── Metals Tab System ──────────────────────────────────────────────────

  function switchMetalsTab(tab) {
    document.querySelectorAll('#metals-tabs .tab').forEach(function(b) { b.classList.remove('active'); });
    var activeBtn = document.querySelector('#metals-tabs [data-tab="' + tab + '"]');
    if (activeBtn) activeBtn.classList.add('active');
    document.querySelectorAll('#page-metals .tab-content').forEach(function(el) { el.style.display = 'none'; });
    var tabEl = document.getElementById('metals-tab-' + tab);
    if (tabEl) tabEl.style.display = '';
    if (tab === 'cities') loadMetalsCitiesExtended();
    if (tab === 'posts') loadMetalsPosts();
    if (tab === 'logs') loadMetalsFetchLog();
    if (tab === 'quality') loadMetalsDataQuality();
  }
  window.switchMetalsTab = switchMetalsTab;

  var _metalsPostsPage = 1;

  function loadMetalsPosts(page) {
    _metalsPostsPage = page || 1;
    var type = (document.getElementById('metals-posts-type-filter') || {}).value || '';
    var tier = (document.getElementById('metals-posts-tier-filter') || {}).value || '';
    var status = (document.getElementById('metals-posts-status-filter') || {}).value || '';
    var search = (document.getElementById('metals-posts-search') || {}).value || '';

    var params = 'module=metals&page=' + _metalsPostsPage + '&limit=50';
    if (type) params += '&item_type=' + encodeURIComponent(type);
    if (tier) params += '&post_type=' + encodeURIComponent(tier);
    if (status) params += '&action=' + encodeURIComponent(status);
    if (search) params += '&search=' + encodeURIComponent(search);

    fetchApi('/api/posts/list?' + params).then(function(json) {
      renderPosts('metals-posts-tbody', json.data || [], 'metals');
      renderPaginationById('metals-posts-pagination', json.page, json.pages, loadMetalsPosts);
    }).catch(function() {});

    fetchApi('/api/posts/stats').then(function(data) {
      var m = data.metals || {};
      var set = function(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; };
      set('metals-posts-total', m.total || 0);
      set('metals-posts-updated-today', m.updated_today || 0);
      set('metals-posts-failed', m.failed || 0);
    }).catch(function() {});
  }
  window.loadMetalsPosts = loadMetalsPosts;

  function loadMetalsCitiesExtended() {
    fetchApi('/api/metals/cities?metal=' + (_currentMetal || 'gold')).then(function(data) {
      var rows = data.data || [];
      var sel = document.getElementById('metals-state-filter');
      if (sel && sel.options.length <= 1) {
        var states = [...new Set(rows.map(function(r) { return r.state; }))].sort();
        states.forEach(function(s) { var o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o); });
      }
      _metalsCitiesData = rows;
      renderMetalsCitiesExtended(rows);
    }).catch(function() {});
  }

  function filterMetalsCities() {
    var state = (document.getElementById('metals-state-filter') || {}).value || '';
    var search = (document.getElementById('metals-city-search') || {}).value || '';
    var filtered = _metalsCitiesData.filter(function(c) {
      if (state && c.state !== state) return false;
      if (search && c.city_name.toLowerCase().indexOf(search.toLowerCase()) === -1) return false;
      return true;
    });
    renderMetalsCitiesExtended(filtered);
  }
  window.filterMetalsCities = filterMetalsCities;

  function renderMetalsCitiesExtended(cities) {
    var tbody = document.getElementById('metals-cities-extended-tbody');
    if (!tbody) return;
    if (!cities.length) { tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted">No data</td></tr>'; return; }
    var metal = _currentMetal || 'gold';
    tbody.innerHTML = cities.slice(0, 200).map(function(c) {
      var activeToggle = c.is_active ? '✅' : '❌';
      var priceDisplay = metal === 'gold'
        ? (c.price_24k ? '₹' + Number(c.price_24k).toLocaleString('en-IN') : '—') + '</td><td>' +
          (c.price_22k ? '₹' + Number(c.price_22k).toLocaleString('en-IN') : '—') + '</td><td>' +
          (c.price_18k ? '₹' + Number(c.price_18k).toLocaleString('en-IN') : '—') + '</td><td>' +
          (c.price_1g ? '₹' + Number(c.price_1g).toFixed(2) : '—')
        : '—</td><td>—</td><td>—</td><td>' + (c.price_1g ? '₹' + Number(c.price_1g).toFixed(2) : '—');
      return '<tr data-metals-city="' + esc(c.city_name) + '">' +
        '<td><strong>' + esc(c.city_name) + '</strong></td>' +
        '<td>' + esc(c.state) + '</td>' +
        '<td>' + priceDisplay + '</td>' +
        '<td><span class="text-sm text-muted">' + esc(c.source || '—') + '</span></td>' +
        '<td><button class="btn-icon" data-click="toggleMetalsCity" data-city="' + esc(c.city_name) + '" data-enable="' + (c.is_active ? '0' : '1') + '" title="Toggle active">' + activeToggle + '</button></td>' +
        '<td>' +
          '<button class="btn-icon" title="Fetch this city" data-click="fetchSingleMetalsCity" data-city="' + esc(c.city_name) + '">⚡</button>' +
          '<button class="btn-icon" title="Edit prices" data-click="startEditMetalsPrice" data-city="' + esc(c.city_name) + '" data-metal="' + metal + '">✏️</button>' +
        '</td></tr>';
    }).join('');
  }

  function loadMetalsFetchLog() {
    fetchApi('/api/fetch-log?module=metals&limit=30').then(function(json) {
      var tbody = document.getElementById('metals-fetch-log-tbody');
      if (!tbody) return;
      var rows = json.data || [];
      if (!rows.length) { tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">No fetch history yet</td></tr>'; return; }
      tbody.innerHTML = rows.map(function(l) {
        var details = {};
        try { details = JSON.parse(l.details || '{}'); } catch (e) {}
        var perMetal = details.perMetal ? JSON.stringify(details.perMetal) : '—';
        return '<tr>' +
          '<td class="text-muted text-sm" title="' + esc(l.created_at) + '">' + timeAgo(l.created_at) + '</td>' +
          '<td><span class="badge badge-' + esc(l.fetch_type || 'scheduled') + '">' + esc(l.fetch_type || 'scheduled') + '</span></td>' +
          '<td class="text-green">' + (l.cities_ok || 0) + '</td>' +
          '<td class="text-muted">' + durFmt(l.duration_ms) + '</td>' +
          '<td class="text-sm text-muted">' + esc(perMetal) + '</td>' +
          '</tr>';
      }).join('');
    }).catch(function() {});
  }

  function loadMetalsDataQuality() {
    fetchApi('/api/metals/data-quality?metal=' + (_currentMetal || 'gold')).then(function(q) {
      var tbody = document.getElementById('metals-coverage-tbody');
      if (tbody && q.coverageByState) {
        tbody.innerHTML = q.coverageByState.map(function(s) {
          var pct = s.total > 0 ? Math.round(s.fetched / s.total * 100) : 0;
          var color = pct >= 80 ? '#10b981' : pct >= 50 ? '#f59e0b' : '#ef4444';
          return '<tr><td>' + esc(s.state) + '</td><td>' + s.total + '</td><td style="color:' + color + '">' + s.fetched +
            '</td><td style="color:' + color + '">' + pct + '%</td>' +
            '<td><div class="bar-bg"><div class="bar-fill" style="width:' + pct + '%;background:' + color + '"></div></div></td></tr>';
        }).join('');
      }
      var staleEl = document.getElementById('metals-stale-cities');
      if (staleEl) {
        if (!q.staleCities || !q.staleCities.length) {
          staleEl.innerHTML = '<span class="text-green">✅ All cities have recent data</span>';
        } else {
          staleEl.innerHTML = q.staleCities.map(function(c) {
            return '<span class="pill pill-warn">' + esc(c.city_name) + ' (' + esc(c.state) + ') — ' + (c.days_since || '?') + 'd</span>';
          }).join('');
        }
      }
      if (q.sourceBreakdown && window.Chart) {
        var ctx = document.getElementById('metals-source-chart');
        if (ctx) {
          if (ctx._chartInstance) ctx._chartInstance.destroy();
          var labels = Object.keys(q.sourceBreakdown);
          var values = Object.values(q.sourceBreakdown);
          var colors = { api1: '#10b981', carryforward: '#f59e0b', manual: '#a78bfa', imported: '#6b7280' };
          ctx._chartInstance = new Chart(ctx, {
            type: 'doughnut',
            data: { labels: labels, datasets: [{ data: values, backgroundColor: labels.map(function(l) { return colors[l] || '#6b7280'; }) }] },
            options: { responsive: true, plugins: { legend: { position: 'bottom', labels: { color: '#9ca3af', font: { size: 11 } } } } }
          });
        }
      }
    }).catch(function() {});
  }

  // ─── Inline price edit — Fuel ────────────────────────────────────────────

  function startEditFuelPrice(city, state, petrol, diesel, priceDate) {
    var row = document.querySelector('tr[data-fuel-city="' + city + '"]');
    if (!row) return;
    row.classList.add('editing');
    row.querySelector('.col-petrol').innerHTML = '<input type="number" step="0.01" min="30" max="300" value="' + (petrol || '') + '" class="edit-input" id="efp-' + city + '">';
    row.querySelector('.col-diesel').innerHTML = '<input type="number" step="0.01" min="20" max="300" value="' + (diesel || '') + '" class="edit-input" id="efd-' + city + '">';
    row.querySelector('.col-actions').innerHTML =
      '<button class="btn-icon text-green" data-click="saveEditFuelPrice" data-city="' + escapeHtml(city) + '" data-date="' + priceDate + '" title="Save">💾</button>' +
      '<button class="btn-icon text-red" data-click="loadFuelPage" title="Cancel">✖</button>';
  }
  window.startEditFuelPrice = startEditFuelPrice;

  async function saveEditFuelPrice(city, priceDate) {
    var petrol = parseFloat((document.getElementById('efp-' + city) || {}).value) || null;
    var diesel = parseFloat((document.getElementById('efd-' + city) || {}).value) || null;
    try {
      var res = await fetch('/api/fuel/price', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city: city, price_date: priceDate, petrol: petrol, diesel: diesel })
      });
      var data = await res.json();
      if (data.ok) { showToast('✅ Price updated for ' + city); loadFuelPage(); }
      else showToast('❌ ' + data.error, 'error');
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
  }
  window.saveEditFuelPrice = saveEditFuelPrice;

  function toggleFuelCity(city, active) {
    fetch('/api/fuel/city', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city_name: city, is_enabled: active })
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.ok) { showToast((active ? '✅ Enabled' : '❌ Disabled') + ' ' + city); loadFuelPage(); }
      else showToast('❌ ' + d.error, 'error');
    }).catch(function(e) { showToast('Error: ' + e.message, 'error'); });
  }
  window.toggleFuelCity = toggleFuelCity;

  // ─── Inline price edit — Metals ─────────────────────────────────────────

  function startEditMetalsPrice(city, metal) {
    var row = document.querySelector('tr[data-metals-city="' + city + '"]');
    if (!row) return;
    var today = new Date().toISOString().slice(0, 10);
    row.classList.add('editing');
    var actionsCell = row.querySelector('td:last-child');
    if (actionsCell) {
      actionsCell.innerHTML =
        '<input type="number" step="0.01" class="edit-input" placeholder="24K" id="em24-' + city + '" style="width:60px">' +
        '<input type="number" step="0.01" class="edit-input" placeholder="1g" id="em1g-' + city + '" style="width:55px;margin-left:4px">' +
        '<button class="btn-icon text-green" data-click="saveEditMetalsPrice" data-city="' + escapeHtml(city) + '" data-metal="' + metal + '" data-date="' + today + '" title="Save">💾</button>' +
        '<button class="btn-icon text-red" data-click="loadMetalsCitiesExtended" title="Cancel">✖</button>';
    }
  }
  window.startEditMetalsPrice = startEditMetalsPrice;

  async function saveEditMetalsPrice(city, metal, priceDate) {
    var p24k = parseFloat((document.getElementById('em24-' + city) || {}).value) || null;
    var p1g  = parseFloat((document.getElementById('em1g-' + city) || {}).value) || null;
    try {
      var res = await fetch('/api/metals/price', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city: city, metal_type: metal, price_date: priceDate, price_24k: p24k, price_1g: p1g })
      });
      var data = await res.json();
      if (data.ok) { showToast('✅ Price updated for ' + city); loadMetalsCitiesExtended(); }
      else showToast('❌ ' + data.error, 'error');
    } catch (e) { showToast('Error: ' + e.message, 'error'); }
  }
  window.saveEditMetalsPrice = saveEditMetalsPrice;

  function toggleMetalsCity(city, active) {
    fetch('/api/metals/city', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city_name: city, is_active: active })
    }).then(function(r) { return r.json(); }).then(function(d) {
      if (d.ok) { showToast((active ? '✅ Enabled' : '❌ Disabled') + ' ' + city); loadMetalsCitiesExtended(); }
      else showToast('❌ ' + d.error, 'error');
    }).catch(function(e) { showToast('Error: ' + e.message, 'error'); });
  }
  window.toggleMetalsCity = toggleMetalsCity;

  // ─── Update loadFuelPage to add overview activity panels ─────────────────

  function _loadFuelOverviewActivity() {
    fetchApi('/api/fetch-log?module=fuel&limit=5').then(function(json) {
      var el = document.getElementById('fuel-overview-fetchlog');
      if (!el) return;
      var rows = json.data || [];
      if (!rows.length) { el.innerHTML = '<span class="text-muted">No fetch history</span>'; return; }
      el.innerHTML = rows.map(function(l) {
        return '<div style="padding:4px 0;border-bottom:1px solid #1f2937;">' +
          '<span class="badge badge-' + esc(l.fetch_type || 'scheduled') + '">' + esc(l.fetch_type || 'sched') + '</span> ' +
          '<span class="text-green">' + (l.cities_ok || 0) + ' ok</span>' +
          (l.cities_fail > 0 ? ' <span class="text-red">' + l.cities_fail + ' fail</span>' : '') +
          ' <span class="text-muted">' + durFmt(l.duration_ms) + '</span>' +
          ' <span class="text-muted text-sm">' + timeAgo(l.created_at) + '</span></div>';
      }).join('');
    }).catch(function() {});
    fetchApi('/api/posts/list?module=fuel&limit=5').then(function(json) {
      var el = document.getElementById('fuel-overview-postlog');
      if (!el) return;
      var rows = json.data || [];
      if (!rows.length) { el.innerHTML = '<span class="text-muted">No posts yet</span>'; return; }
      el.innerHTML = rows.map(function(p) {
        return '<div style="padding:4px 0;border-bottom:1px solid #1f2937;">' +
          '<span class="badge badge-' + esc(p.item_type) + '">' + esc(p.item_type) + '</span> ' +
          esc(p.item_name) + ' <span class="text-muted text-sm">' + esc(p.action) + ' · ' + timeAgo(p.created_at) + '</span></div>';
      }).join('');
    }).catch(function() {});
  }

  function _loadMetalsOverviewActivity() {
    fetchApi('/api/fetch-log?module=metals&limit=5').then(function(json) {
      var el = document.getElementById('metals-overview-fetchlog');
      if (!el) return;
      var rows = json.data || [];
      if (!rows.length) { el.innerHTML = '<span class="text-muted">No fetch history</span>'; return; }
      el.innerHTML = rows.map(function(l) {
        return '<div style="padding:4px 0;border-bottom:1px solid #1f2937;">' +
          '<span class="badge badge-' + esc(l.fetch_type || 'scheduled') + '">' + esc(l.fetch_type || 'sched') + '</span> ' +
          '<span class="text-green">' + (l.cities_ok || 0) + ' ok</span>' +
          ' <span class="text-muted">' + durFmt(l.duration_ms) + '</span>' +
          ' <span class="text-muted text-sm">' + timeAgo(l.created_at) + '</span></div>';
      }).join('');
    }).catch(function() {});
    fetchApi('/api/posts/list?module=metals&limit=5').then(function(json) {
      var el = document.getElementById('metals-overview-postlog');
      if (!el) return;
      var rows = json.data || [];
      if (!rows.length) { el.innerHTML = '<span class="text-muted">No posts yet</span>'; return; }
      el.innerHTML = rows.map(function(p) {
        return '<div style="padding:4px 0;border-bottom:1px solid #1f2937;">' +
          '<span class="badge badge-' + esc(p.item_type) + '">' + esc(p.item_type) + '</span> ' +
          esc(p.item_name) + ' <span class="text-muted text-sm">' + esc(p.action) + ' · ' + timeAgo(p.created_at) + '</span></div>';
      }).join('');
    }).catch(function() {});
  }

  // ─── Import (CSV + JSON) ──────────────────────────────────────────────────

  function switchImportTab(tab) {
    var csvPanel = document.getElementById('importPanelCsv');
    var jsonPanel = document.getElementById('importPanelJson');
    var csvBtn  = document.getElementById('importTabCsv');
    var jsonBtn = document.getElementById('importTabJson');
    if (tab === 'csv') {
      csvPanel.style.display  = 'grid';
      jsonPanel.style.display = 'none';
      csvBtn.style.background  = 'rgba(255,255,255,0.12)';
      csvBtn.style.color       = '#fff';
      csvBtn.style.fontWeight  = '600';
      jsonBtn.style.background = 'transparent';
      jsonBtn.style.color      = '#888';
      jsonBtn.style.fontWeight = '500';
    } else {
      csvPanel.style.display  = 'none';
      jsonPanel.style.display = 'grid';
      jsonBtn.style.background = 'rgba(255,255,255,0.12)';
      jsonBtn.style.color      = '#fff';
      jsonBtn.style.fontWeight = '600';
      csvBtn.style.background  = 'transparent';
      csvBtn.style.color       = '#888';
      csvBtn.style.fontWeight  = '500';
    }
  }

  function runImport(type, format, dryRun) {
    var inputId   = type + format.charAt(0).toUpperCase() + format.slice(1) + 'File';
    var fileInput = document.getElementById(inputId);
    if (!fileInput || !fileInput.files.length) {
      showImportResult('error', '❌ Please select a .' + format + ' file first.');
      return;
    }
    var file = fileInput.files[0];
    if (!file.name.toLowerCase().endsWith('.' + format)) {
      showImportResult('error', '❌ Please select a .' + format + ' file.');
      return;
    }
    showImportResult('loading', (dryRun ? 'Dry-running' : 'Importing') + ' ' + escapeHtml(file.name) + ' (' + (file.size / 1024).toFixed(0) + ' KB)…');

    var reader = new FileReader();
    reader.onerror = function () { showImportResult('error', '❌ Could not read file.'); };
    reader.onload = function (e) {
      var endpoint = format === 'csv' ? '/api/import/' + type : '/api/import/' + type + '-json';
      var body;
      if (format === 'csv') {
        body = JSON.stringify({ csv: e.target.result });
      } else {
        var parsed;
        try { parsed = JSON.parse(e.target.result); }
        catch (err) { showImportResult('error', '❌ Invalid JSON: ' + escapeHtml(err.message)); return; }

        // ── Goodreturns scraper format ─────────────────────────────────────
        // { source, fuel:"diesel", scraped_date, cities:{ CityName:{ daily_history:[{date,price}] } } }
        if (!Array.isArray(parsed) && typeof parsed === 'object' && parsed !== null &&
            parsed.cities && typeof parsed.cities === 'object' && !Array.isArray(parsed.cities)) {
          var fuelType = (parsed.fuel || '').toLowerCase();   // 'petrol' or 'diesel'
          var grSource = parsed.source || 'goodreturns';
          var rows = [];
          Object.keys(parsed.cities).forEach(function (cityName) {
            var hist = (parsed.cities[cityName].daily_history) || [];
            hist.forEach(function (entry) {
              if (!entry.date || entry.price == null) return;
              var row = { city: cityName, price_date: entry.date, source: grSource };
              if (fuelType === 'petrol')      row.petrol = entry.price;
              else if (fuelType === 'diesel') row.diesel = entry.price;
              else { row.petrol = entry.price; row.diesel = entry.price; }
              rows.push(row);
            });
          });
          parsed = rows;
        }

        // ── Generic envelope unwrapping ────────────────────────────────────
        // { data:[...] }, { items:[...] }, { results:[...] }, etc.
        if (!Array.isArray(parsed) && typeof parsed === 'object' && parsed !== null) {
          var wrapperKeys = ['data', 'items', 'results', 'records', 'rows', 'prices'];
          var unwrapped = null;
          for (var wi = 0; wi < wrapperKeys.length; wi++) {
            if (Array.isArray(parsed[wrapperKeys[wi]])) { unwrapped = parsed[wrapperKeys[wi]]; break; }
          }
          parsed = unwrapped || [parsed];   // last resort: single object → one-row array
        }

        if (!Array.isArray(parsed) || !parsed.length) {
          showImportResult('error', '❌ Could not find an array of rows in this JSON file.');
          return;
        }
        body = JSON.stringify({ rows: parsed });
      }
      fetch(endpoint + (dryRun ? '?dry=1' : ''), {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: body,
      })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (data.ok) {
          var s = data.stats;
          var warnHtml = (s.errors && s.errors.length)
            ? '<details style="margin-top:6px;"><summary style="cursor:pointer;font-size:12px;color:#f87171;">' + s.errors.length + ' warnings — click to expand</summary>' +
              '<pre style="font-size:11px;margin-top:4px;white-space:pre-wrap;color:#f87171;">' + escapeHtml(s.errors.slice(0, 20).join('\n')) + (s.errors.length > 20 ? '\n…and ' + (s.errors.length - 20) + ' more' : '') + '</pre></details>'
            : '';
          showImportResult('success',
            '✅ ' + escapeHtml(data.message) + '<br>' +
            '<small style="color:#86efac;">Total: ' + s.total + ' · Inserted: ' + s.inserted + ' · Skipped: ' + s.skipped + '</small>' +
            warnHtml
          );
        } else {
          showImportResult('error', '❌ ' + escapeHtml(data.error || 'Unknown error'));
        }
      })
      .catch(function (err) {
        showImportResult('error', '❌ Network error: ' + escapeHtml(err.message));
      });
    };
    reader.readAsText(file);
  }

  function showImportResult(type, html) {
    var div = document.getElementById('import-result');
    if (!div) return;
    div.style.display = 'block';
    var styles = {
      success: 'background:rgba(74,222,128,0.1);border:1px solid rgba(74,222,128,0.3);',
      error:   'background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);',
      loading: 'background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);',
    };
    div.style.cssText = 'margin-top:12px;padding:12px 16px;border-radius:8px;font-size:13px;line-height:1.6;' + (styles[type] || styles.loading);
    div.innerHTML = html;
  }

  window.runImport = runImport;
  window.switchImportTab = switchImportTab;

  // ─── Sources Analytics Page ───────────────────────────────────────────────

  var _sourcesData = null;
  var _sourcesSortKey = 'total';
  var _sourcesSortDir = -1;

  function loadSourcesPage() {
    fetchApi('/api/sources/stats')
      .then(function(data) {
        _sourcesData = data;
        renderSourcesSummary(data.summary);
        renderSourcesLangChart(data.langTotals);
        renderSourcesCatChart(data.categoryTotals);
        renderSourcesTable(data.domains, data.sparklines);
        renderSourcesStaleList(data.staleDomains);
        renderSourcesNewList(data.newToday);
      })
      .catch(function(err) {
        console.error('Sources stats failed:', err);
      });

    loadTierManager();

    var tierSaveBtn = $('tierSaveBtn');
    if (tierSaveBtn) tierSaveBtn.onclick = saveTierManager;
  }

  function loadTierManager() {
    fetchApi('/api/settings')
      .then(function (res) {
        var s = res.settings || {};
        var t1 = $('tier1-domains');
        var t2 = $('tier2-domains');
        var t3 = $('tier3-domains');
        if (t1) t1.value = (s.TIER1_SOURCES || '').split(',').filter(Boolean).join('\n');
        if (t2) t2.value = (s.TIER2_SOURCES || '').split(',').filter(Boolean).join('\n');
        if (t3) t3.value = (s.TIER3_SOURCES || '').split(',').filter(Boolean).join('\n');

        var info = $('tier-active-domains');
        if (info) {
          var t1count = (s.TIER1_SOURCES || '').split(',').filter(Boolean).length;
          var t2count = (s.TIER2_SOURCES || '').split(',').filter(Boolean).length;
          var t3count = (s.TIER3_SOURCES || '').split(',').filter(Boolean).length;
          info.textContent = 'T1: ' + t1count + ' domains · T2: ' + t2count + ' domains · T3: ' + t3count + ' domains';
        }
      });
  }

  function saveTierManager() {
    var btn = $('tierSaveBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    var t1el = $('tier1-domains');
    var t2el = $('tier2-domains');
    var t3el = $('tier3-domains');
    var toList = function (el) {
      return (el ? el.value : '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean).join(',');
    };
    fetchApi('/api/settings', {
      method: 'PUT',
      body: { TIER1_SOURCES: toList(t1el), TIER2_SOURCES: toList(t2el), TIER3_SOURCES: toList(t3el) }
    })
      .then(function () { showToast('Source tiers saved', 'success'); loadTierManager(); })
      .catch(function (e) { showToast('Save failed: ' + e.message, 'error'); })
      .finally(function () { if (btn) { btn.disabled = false; btn.textContent = 'Save Tiers'; } });
  }

  function renderSourcesSummary(s) {
    var set = function(id, val) { var el = $(id); if (el) el.textContent = val; };
    set('src-total-domains',  s.totalDomains.toLocaleString());
    set('src-total-articles', s.totalArticles.toLocaleString());
    set('src-stale-domains',  s.staleDomainCount);
    set('src-new-today',      s.newDomainCount);
  }

  function renderSourcesLangChart(langTotals) {
    var canvas = document.getElementById('sources-lang-chart');
    if (!canvas || !window.Chart) return;
    if (canvas._chartInstance) canvas._chartInstance.destroy();
    var labels = langTotals.map(function(r) { return (r.language || 'unknown').toUpperCase(); });
    var values = langTotals.map(function(r) { return r.count; });
    var colors = ['#4a7aff','#10b981','#f59e0b','#ef4444','#8b5cf6','#6b7280'];
    canvas._chartInstance = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels: labels,
        datasets: [{ data: values, backgroundColor: colors.slice(0, labels.length), borderWidth: 0 }]
      },
      options: { plugins: { legend: { position: 'right' } }, maintainAspectRatio: false }
    });
  }

  function renderSourcesCatChart(catTotals) {
    var canvas = document.getElementById('sources-cat-chart');
    if (!canvas || !window.Chart) return;
    if (canvas._chartInstance) canvas._chartInstance.destroy();
    var top10 = catTotals.slice(0, 10);
    var labels = top10.map(function(r) { return r.category; });
    var values = top10.map(function(r) { return r.count; });
    canvas._chartInstance = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: labels,
        datasets: [{ label: 'Articles', data: values, backgroundColor: '#4a7aff', borderRadius: 4 }]
      },
      options: {
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        maintainAspectRatio: false,
        scales: { x: { grid: { color: 'rgba(255,255,255,0.05)' } }, y: { grid: { display: false } } }
      }
    });
  }

  function renderSourcesTable(domains, sparklines) {
    var sparkMap = {};
    (sparklines || []).forEach(function(r) {
      if (!sparkMap[r.domain]) sparkMap[r.domain] = {};
      sparkMap[r.domain][r.day] = r.count;
    });
    var days = [];
    for (var i = 6; i >= 0; i--) {
      var d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }

    var sorted = (domains || []).slice().sort(function(a, b) {
      var av = a[_sourcesSortKey] || 0;
      var bv = b[_sourcesSortKey] || 0;
      if (typeof av === 'string') return _sourcesSortDir * av.localeCompare(bv);
      return _sourcesSortDir * (bv - av);
    });

    var search = ($('sources-domain-search') || {}).value || '';
    if (search) {
      sorted = sorted.filter(function(r) { return r.domain.toLowerCase().includes(search.toLowerCase()); });
    }

    var tbody = $('sources-domain-tbody');
    if (!tbody) return;
    if (!sorted.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#888;">No data yet</td></tr>';
      return;
    }

    var rows = sorted.map(function(r) {
      var lastMs = r.last_seen ? Date.now() - new Date(r.last_seen).getTime() : Infinity;
      var lastLabel = r.last_seen ? timeAgo(r.last_seen) : 'never';
      var freshColor = lastMs < 3600000 ? '#10b981' : lastMs < 86400000 ? '#f59e0b' : '#ef4444';

      var spark = '';
      if (sparkMap[r.domain]) {
        var vals = days.map(function(d) { return sparkMap[r.domain][d] || 0; });
        var maxV = Math.max.apply(null, vals) || 1;
        var bars = vals.map(function(v, i) {
          var h = Math.max(2, Math.round((v / maxV) * 24));
          var x = i * 9;
          var y = 24 - h;
          return '<rect x="' + x + '" y="' + y + '" width="7" height="' + h + '" fill="#4a7aff" rx="1"/>';
        }).join('');
        spark = '<svg width="63" height="24" style="display:block">' + bars + '</svg>';
      } else {
        spark = '<span style="color:#555;font-size:11px;">—</span>';
      }

      var cats = (r.categories || '').split(',').filter(Boolean).slice(0, 3)
        .map(function(c) { return '<span style="background:var(--bg3);border-radius:4px;padding:1px 5px;font-size:11px;margin-right:2px;">' + escapeHtml(c) + '</span>'; }).join('');

      return '<tr>' +
        '<td><a href="https://' + escapeHtml(r.domain) + '" target="_blank" style="color:var(--accent)">' + escapeHtml(r.domain) + '</a></td>' +
        '<td><strong>' + r.total.toLocaleString() + '</strong></td>' +
        '<td style="color:#4a7aff">' + (r.en_count || 0).toLocaleString() + '</td>' +
        '<td style="color:#10b981">' + (r.hi_count || 0).toLocaleString() + '</td>' +
        '<td>' + (r.cluster_rate || 0) + '%</td>' +
        '<td>' + (r.draft_rate || 0) + '%</td>' +
        '<td>' + (cats || '<span style="color:#555">—</span>') + '</td>' +
        '<td style="color:' + freshColor + '">' + lastLabel + '</td>' +
        '<td>' + spark + '</td>' +
        '</tr>';
    }).join('');
    tbody.innerHTML = rows;
  }

  function filterSourcesTable(val) {
    if (_sourcesData) renderSourcesTable(_sourcesData.domains, _sourcesData.sparklines);
  }

  function sortSourcesTable(key) {
    if (_sourcesSortKey === key) {
      _sourcesSortDir *= -1;
    } else {
      _sourcesSortKey = key;
      _sourcesSortDir = -1;
    }
    if (_sourcesData) renderSourcesTable(_sourcesData.domains, _sourcesData.sparklines);
  }

  function renderSourcesStaleList(stale) {
    var el = $('sources-stale-list');
    if (!el) return;
    if (!stale || !stale.length) { el.innerHTML = '<p style="color:#888">All domains active ✓</p>'; return; }
    el.innerHTML = stale.map(function(r) {
      return '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">' +
        '<span style="color:var(--text)">' + escapeHtml(r.domain) + '</span>' +
        '<span style="color:#ef4444;font-size:12px;">' + timeAgo(r.last_seen) + ' ago · ' + r.total + ' total</span>' +
        '</div>';
    }).join('');
  }

  function renderSourcesNewList(newDomains) {
    var el = $('sources-new-list');
    if (!el) return;
    if (!newDomains || !newDomains.length) { el.innerHTML = '<p style="color:#888">No new domains today</p>'; return; }
    el.innerHTML = newDomains.map(function(r) {
      return '<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border)">' +
        '<span style="color:var(--text)">' + escapeHtml(r.domain) + '</span>' +
        '<span style="color:#10b981;font-size:12px;">' + r.count + ' articles</span>' +
        '</div>';
    }).join('');
  }

  // ─── Autopilot page ──────────────────────────────────────────────────────

  function loadAutopilot() {
    loadAutopilotStatus();
    loadAutoRewriteStatus();
    loadAutopilotSettings();
    loadAutoRewriteSettings();
    loadAutopilotQueue();
    loadAutopilotDecisions();

    var refreshBtn = $('autopilotRefreshBtn');
    if (refreshBtn) refreshBtn.onclick = function () { forceApiRefresh(); loadAutopilot(); showToast('Refreshed', 'info'); };

    var simBtn = $('autopilotSimulateBtn');
    if (simBtn) simBtn.onclick = runAutopilotSimulate;

    var saveBtn = $('autopilotSettingsSaveBtn');
    if (saveBtn) saveBtn.onclick = saveAutopilotSettings;

    var arSaveBtn = $('autoRewriteSaveBtn');
    if (arSaveBtn) arSaveBtn.onclick = saveAutoRewriteSettings;

    var cleanupBtn = $('cleanupStaleBtn');
    if (cleanupBtn && !cleanupBtn.__wired) {
      cleanupBtn.__wired = true;
      cleanupBtn.onclick = function () {
        if (!confirm('Delete all stuck/failed drafts older than the configured max age?')) return;
        fetchApi('/api/drafts/cleanup-stale', { method: 'POST' })
          .then(function (d) { showToast('Deleted ' + (d.deleted || 0) + ' stale drafts', 'success'); loadAutopilotQueue(); })
          .catch(function (e) { showToast('Cleanup failed: ' + e.message, 'error'); });
      };
    }

    var queueRefreshBtn = $('queueRefreshBtn');
    if (queueRefreshBtn && !queueRefreshBtn.__wired) {
      queueRefreshBtn.__wired = true;
      queueRefreshBtn.onclick = function () { forceApiRefresh('/api/autopilot'); loadAutopilotQueue(); };
    }

    var queuePublishAllBtn = $('queuePublishAllBtn');
    if (queuePublishAllBtn && !queuePublishAllBtn.__wired) {
      queuePublishAllBtn.__wired = true;
      queuePublishAllBtn.onclick = function () { window.__publishAllReady(); };
    }
  }

  function runAutopilotSimulate() {
    var btn = $('autopilotSimulateBtn');
    var box = $('autopilot-simulate-result');
    if (btn) { btn.disabled = true; btn.textContent = 'Simulating...'; }
    if (box) box.style.display = 'none';

    fetchApi('/api/autopilot/simulate')
      .then(function (res) {
        var d = res.data || res;
        if (!box) return;
        box.style.display = 'block';

        // Queue stats row
        var q = d.queue || {};
        var qHtml = '<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:14px;">' +
          _simStat(q.ready || 0, 'Ready to Publish', '#22c55e') +
          _simStat(q.rewriting || 0, 'Rewriting', '#f59e0b') +
          _simStat(q.draft || 0, 'Extracted', '#3b82f6') +
          _simStat(q.failed || 0, 'Failed', '#ef4444') +
          _simStat(q.published || 0, 'Published', '#6b7280') +
          '</div>';

        if (!d.candidate) {
          box.innerHTML = '<div class="card" style="border-left:4px solid #f59e0b;padding:16px;">' +
            qHtml +
            '<div style="color:#f59e0b;font-weight:600;font-size:14px;">⚠️ ' + (d.message || 'No ready clusters') + '</div>' +
            '<div style="margin-top:8px;font-size:13px;color:var(--text-muted);">To test: articles need to flow through Firehose → get clustered → extracted → rewritten.</div>' +
            '</div>';
          return;
        }

        var dec = d.decision || {};
        var approved = dec.approved === true;
        var borderColor = approved ? '#22c55e' : '#ef4444';
        var icon = approved ? '✅' : '❌';
        var label = approved ? 'WOULD PUBLISH' : 'WOULD SKIP';
        var labelColor = approved ? '#22c55e' : '#ef4444';

        var candidate = d.candidate;
        box.innerHTML = '<div class="card" style="border-left:4px solid ' + borderColor + ';padding:16px;">' +
          qHtml +
          '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;">' +
            '<span style="font-size:22px;">' + icon + '</span>' +
            '<span style="font-size:16px;font-weight:700;color:' + labelColor + ';">' + label + '</span>' +
          '</div>' +
          '<div style="font-size:14px;font-weight:600;margin-bottom:8px;">' + escapeHtml(candidate.title) + '</div>' +
          '<div style="display:flex;gap:20px;flex-wrap:wrap;font-size:12px;color:var(--text-muted);margin-bottom:10px;">' +
            '<span>📝 ' + (candidate.wordCount || 0) + ' words</span>' +
            '<span>🔗 ' + escapeHtml(candidate.sourceDomain || '—') + '</span>' +
            '<span>📊 similarity: ' + ((candidate.similarity || 0) * 100).toFixed(0) + '%</span>' +
            '<span>🆔 Draft #' + candidate.draftId + ' / Cluster #' + candidate.clusterId + '</span>' +
          '</div>' +
          (dec.reason ? '<div style="font-size:13px;padding:8px 12px;border-radius:6px;background:var(--bg-secondary);color:' + labelColor + ';">' +
            '<strong>Reason:</strong> ' + escapeHtml(dec.reason) + '</div>' : '') +
          (dec.checks ? _renderChecks(dec.checks) : '') +
          '</div>';
      })
      .catch(function (e) {
        if (box) { box.style.display = 'block'; box.innerHTML = '<div class="card" style="color:#ef4444;">Simulate failed: ' + e.message + '</div>'; }
      })
      .finally(function () {
        if (btn) { btn.disabled = false; btn.textContent = '🧪 Simulate'; }
      });
  }

  function _simStat(val, label, color) {
    return '<div style="text-align:center;min-width:70px;">' +
      '<div style="font-size:20px;font-weight:700;color:' + color + ';">' + val + '</div>' +
      '<div style="font-size:11px;color:var(--text-muted);">' + label + '</div>' +
      '</div>';
  }

  function _renderChecks(checks) {
    if (!checks || !Object.keys(checks).length) return '';
    var rows = Object.keys(checks).map(function (k) {
      var c = checks[k];
      var pass = c.pass !== false;
      return '<tr>' +
        '<td style="padding:4px 8px;font-size:12px;">' + escapeHtml(k) + '</td>' +
        '<td style="padding:4px 8px;font-size:12px;color:' + (pass ? '#22c55e' : '#ef4444') + ';font-weight:600;">' + (pass ? '✓ pass' : '✗ fail') + '</td>' +
        '<td style="padding:4px 8px;font-size:12px;color:var(--text-muted);">' + escapeHtml(String(c.value || '')) + '</td>' +
        '<td style="padding:4px 8px;font-size:12px;color:var(--text-muted);">' + (c.threshold !== undefined ? 'threshold: ' + c.threshold : '') + '</td>' +
        '</tr>';
    });
    return '<div style="margin-top:10px;overflow-x:auto;">' +
      '<table style="width:100%;border-collapse:collapse;">' +
      '<thead><tr style="border-bottom:1px solid var(--border-color);">' +
      '<th style="padding:4px 8px;font-size:11px;text-align:left;color:var(--text-muted);">Check</th>' +
      '<th style="padding:4px 8px;font-size:11px;text-align:left;color:var(--text-muted);">Result</th>' +
      '<th style="padding:4px 8px;font-size:11px;text-align:left;color:var(--text-muted);">Value</th>' +
      '<th style="padding:4px 8px;font-size:11px;text-align:left;color:var(--text-muted);">Threshold</th>' +
      '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
  }

  function loadAutopilotStatus() {
    fetchApi('/api/autopilot/status')
      .then(function (res) {
        var s = res.data || res;
        var dot = $('autopilot-status-dot');
        var reason = $('autopilot-status-reason');
        var statusLabel = $('autopilot-status-label');
        var todayEl = $('autopilot-published-today');
        var limitEl = $('autopilot-daily-limit');
        var toggleBtn = $('autopilotToggleBtn');
        if (!dot) return;

        var active = s.active;
        var enabled = s.enabled;
        dot.className = 'status-dot ' + (active ? 'connected' : '');
        if (reason) reason.textContent = active ? (s.nextPublishETA ? 'Next: ' + s.nextPublishETA : 'Active') : (enabled ? 'Outside window' : 'Disabled');
        if (statusLabel) statusLabel.textContent = '';
        if (todayEl) todayEl.textContent = s.publishedToday !== undefined ? s.publishedToday : '—';
        if (limitEl) limitEl.textContent = s.dailyTarget || '—';

        if (toggleBtn) {
          toggleBtn.textContent = enabled ? 'ON' : 'OFF';
          toggleBtn.className = 'btn btn-sm ' + (enabled ? 'btn-warning' : 'btn-primary');
          toggleBtn.onclick = function () { toggleAutopilot(!enabled); };
        }
      })
      .catch(function () {
        var reason = $('autopilot-status-reason');
        if (reason) reason.textContent = 'Status unavailable';
      });
  }

  function toggleAutopilot(enable) {
    fetchApi('/api/autopilot/toggle', { method: 'POST', body: { enable: enable } })
      .then(function () {
        showToast('Auto-Publish ' + (enable ? 'enabled' : 'disabled'), 'success');
        loadAutopilotStatus();
      })
      .catch(function (e) { showToast('Toggle failed: ' + e.message, 'error'); });
  }

  function loadAutoRewriteStatus() {
    fetchApi('/api/auto-rewrite/status')
      .then(function (res) {
        var s = res.data || res;
        var dot = $('auto-rewrite-status-dot');
        var sub = $('auto-rewrite-status-sub');
        var toggleBtn = $('autoRewriteToggleBtn');
        var todayStat = $('auto-rewrite-today-stat');
        var pendingStat = $('auto-rewrite-pending-stat');

        var enabled = s.enabled === true || s.enabled === 'true';
        if (dot) dot.className = 'status-dot ' + (enabled ? 'connected' : '');
        if (sub) sub.textContent = enabled
          ? (s.rewrittenToday || 0) + '/' + (s.dailyLimit || '?') + ' today'
          : 'Disabled';
        if (todayStat) todayStat.textContent = s.rewrittenToday !== undefined ? s.rewrittenToday : '—';
        if (pendingStat) pendingStat.textContent = s.pendingClusters !== undefined ? s.pendingClusters : '—';

        if (toggleBtn) {
          toggleBtn.textContent = enabled ? 'ON' : 'OFF';
          toggleBtn.className = 'btn btn-sm ' + (enabled ? 'btn-warning' : 'btn-primary');
          toggleBtn.onclick = function () { toggleAutoRewrite(!enabled); };
        }
      })
      .catch(function () {});
  }

  function toggleAutoRewrite(enable) {
    fetchApi('/api/auto-rewrite/toggle', { method: 'POST' })
      .then(function () {
        showToast('Auto-Rewrite ' + (enable ? 'enabled' : 'disabled'), 'success');
        loadAutoRewriteStatus();
      })
      .catch(function (e) { showToast('Toggle failed: ' + e.message, 'error'); });
  }

  var _apSettingKeys = [
    'AUTOPILOT_START_HOUR', 'AUTOPILOT_END_HOUR', 'AUTOPILOT_WEEKENDS',
    'AUTOPILOT_DAILY_TARGET', 'AUTOPILOT_MIN_WORDS', 'AUTOPILOT_MIN_SIMILARITY',
    'AUTOPILOT_MIN_TIER', 'PUBLISH_LANGUAGE', 'AUTOPILOT_BLOCKED_KEYWORDS',
    'AUTOPILOT_BLOCKED_CATEGORIES', 'AUTOPILOT_BLOCKED_DOMAINS', 'AUTOPILOT_ALLOWED_DOMAINS'
  ];

  function loadAutopilotSettings() {
    fetchApi('/api/settings')
      .then(function (data) {
        var settings = data.settings || {};
        _apSettingKeys.forEach(function (key) {
          var el = document.querySelector('#page-autopilot [data-setting-key="' + key + '"]');
          if (el && settings[key] !== undefined) el.value = settings[key];
        });
      });
  }

  function saveAutopilotSettings() {
    var btn = $('autopilotSettingsSaveBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    var body = {};
    _apSettingKeys.forEach(function (key) {
      var el = document.querySelector('#page-autopilot [data-setting-key="' + key + '"]');
      if (el) body[key] = el.value;
    });
    fetchApi('/api/settings', { method: 'PUT', body: body })
      .then(function () { showToast('Autopilot settings saved', 'success'); })
      .catch(function (e) { showToast('Save failed: ' + e.message, 'error'); })
      .finally(function () { if (btn) { btn.disabled = false; btn.textContent = 'Save Autopilot Settings'; } });
  }

  var _arSettingKeys = [
    'AUTO_REWRITE_DAILY_LIMIT', 'AUTO_REWRITE_HOURLY_LIMIT',
    'AUTO_REWRITE_MIN_SOURCES', 'AUTO_REWRITE_MIN_SIMILARITY',
    'AUTO_REWRITE_BLOCKED_KEYWORDS',
  ];

  function loadAutoRewriteSettings() {
    fetchApi('/api/settings')
      .then(function (data) {
        var settings = data.settings || {};
        _arSettingKeys.forEach(function (key) {
          var el = document.querySelector('#page-autopilot [data-setting-key="' + key + '"]');
          if (el && settings[key] !== undefined) el.value = settings[key];
        });
      });
  }

  function saveAutoRewriteSettings() {
    var btn = $('autoRewriteSaveBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    var body = {};
    _arSettingKeys.forEach(function (key) {
      var el = document.querySelector('#page-autopilot [data-setting-key="' + key + '"]');
      if (el) body[key] = el.value;
    });
    fetchApi('/api/settings', { method: 'PUT', body: body })
      .then(function () { showToast('Auto-Rewrite settings saved', 'success'); loadAutoRewriteStatus(); })
      .catch(function (e) { showToast('Save failed: ' + e.message, 'error'); })
      .finally(function () { if (btn) { btn.disabled = false; btn.textContent = 'Save'; } });
  }

  var _queueCurrentPage = 1;
  function loadAutopilotQueue(page) {
    if (typeof page === 'number' && page > 0) _queueCurrentPage = page;
    var container = $('autopilot-queue-list');
    var pagination = $('autopilot-queue-pagination');
    var countLabel = $('queue-count-label');
    if (container) container.innerHTML = '<p class="placeholder-text">Loading...</p>';

    fetchApi('/api/autopilot/queue?page=' + _queueCurrentPage)
      .then(function (data) {
        var rows = data.data || [];
        var total = data.total || 0;
        if (countLabel) countLabel.textContent = '(' + total + ')';

        if (!rows.length) {
          if (container) container.innerHTML = '<div class="feed-empty">' +
            '<div class="feed-empty-icon">&#9889;</div>' +
            '<div class="feed-empty-title">Queue is empty</div>' +
            '<div class="feed-empty-desc">AI-rewritten articles will appear here once ready.</div>' +
            '</div>';
          return;
        }

        var html = '<div style="overflow-x:auto;"><table class="data-table"><thead><tr>' +
          '<th>Title</th><th>Domain</th><th>Words</th><th>Similarity</th><th>Sources</th><th>Language</th><th>Actions</th>' +
          '</tr></thead><tbody>';

        rows.forEach(function (d) {
          var title = d.rewritten_title || '(untitled)';
          var sim = d.avg_similarity ? (parseFloat(d.avg_similarity) * 100).toFixed(0) + '%' : '—';
          var trend = d.trends_boosted ? ' <span class="badge badge-trend">&#128293;</span>' : '';
          html += '<tr>' +
            '<td><strong>' + escapeHtml(String(title).substring(0, 70)) + '</strong>' + trend + '</td>' +
            '<td>' + escapeHtml(d.source_domain || '') + '</td>' +
            '<td>' + (d.rewritten_word_count || '—') + '</td>' +
            '<td>' + sim + '</td>' +
            '<td>' + (d.article_count || 1) + '</td>' +
            '<td>' + escapeHtml(d.language || 'en') + '</td>' +
            '<td style="white-space:nowrap;">' +
              '<button class="btn btn-sm btn-primary" data-click="publishReady" data-draft-id="' + d.id + '">Publish</button> ' +
              '<button class="btn btn-sm btn-ghost" data-click="rejectQueued" data-draft-id="' + d.id + '">Reject</button> ' +
              '<button class="btn btn-sm" data-click="openEditor" data-draft-id="' + d.id + '">Preview</button>' +
            '</td>' +
          '</tr>';
        });

        html += '</tbody></table></div>';
        if (container) container.innerHTML = html;

        if (pagination) {
          var totalPages = Math.ceil(total / (data.perPage || 20));
          renderPaginationById('autopilot-queue-pagination', data.page || 1, totalPages, loadAutopilotQueue);
        }
      })
      .catch(function (err) {
        if (container) container.innerHTML = '<p class="placeholder-text">Failed to load queue: ' + escapeHtml(err.message) + '</p>';
      });
  }

  function loadAutopilotDecisions() {
    var container = $('autopilot-decisions-list');
    if (!container) return;
    fetchApi('/api/autopilot/decisions?limit=30')
      .then(function (res) {
        var data = res.data || res;
        if (!Array.isArray(data) || !data.length) {
          container.innerHTML = '<p class="placeholder-text">No decisions recorded yet.</p>';
          return;
        }
        container.innerHTML = '<div style="overflow-x:auto;"><table class="data-table"><thead><tr>' +
          '<th>Time</th><th>Title</th><th>Decision</th><th>Reason</th>' +
          '</tr></thead><tbody>' +
          data.map(function (d) {
            var badge = d.approved
              ? '<span style="color:#10b981;font-weight:600;">PUBLISH</span>'
              : '<span style="color:#ef4444;font-weight:600;">SKIP</span>';
            return '<tr>' +
              '<td style="white-space:nowrap;color:var(--text-muted);font-size:12px;">' + timeAgo(d.created_at) + '</td>' +
              '<td>' + escapeHtml(d.draft_title || '—') + '</td>' +
              '<td>' + badge + '</td>' +
              '<td style="font-size:12px;color:var(--text-muted);">' + escapeHtml(d.reason || '') + '</td>' +
              '</tr>';
          }).join('') +
          '</tbody></table></div>';
      })
      .catch(function () { container.innerHTML = '<p class="placeholder-text">Failed to load decisions.</p>'; });
  }

  // ─── Pipeline Engine settings (Settings page) ─────────────────────────────

  var _pipelineSettingKeys = [
    'EXTRACTION_POLL_MS', 'PUBLISH_POLL_MS', 'REWRITE_CONCURRENCY', 'REWRITE_MAX_RETRIES',
    'LEASE_MINUTES', 'MAX_PUBLISH_PER_HOUR', 'PUBLISH_COOLDOWN_MINUTES',
    'CLUSTERING_DEBOUNCE_MS', 'CLUSTERING_MAX_WAIT_MS', 'CLUSTER_QUEUE_MAX',
    'MAX_TOKENS', 'TEMPERATURE', 'WP_TIMEOUT_MS'
  ];

  function loadPipelineEngineSettings() {
    fetchApi('/api/settings')
      .then(function (data) {
        var settings = data.settings || {};
        _pipelineSettingKeys.forEach(function (key) {
          var el = document.querySelector('#pipeline-engine-section [data-setting-key="' + key + '"]');
          if (el && settings[key] !== undefined) el.value = settings[key];
        });
      });

    var saveBtn = $('pipelineEngineSaveBtn');
    if (saveBtn) saveBtn.onclick = savePipelineEngineSettings;
  }

  function savePipelineEngineSettings() {
    var btn = $('pipelineEngineSaveBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }
    var body = {};
    _pipelineSettingKeys.forEach(function (key) {
      var el = document.querySelector('#pipeline-engine-section [data-setting-key="' + key + '"]');
      if (el) body[key] = el.value;
    });
    fetchApi('/api/settings', { method: 'PUT', body: body })
      .then(function () { showToast('Pipeline settings saved', 'success'); })
      .catch(function (e) { showToast('Save failed: ' + e.message, 'error'); })
      .finally(function () { if (btn) { btn.disabled = false; btn.textContent = 'Save Pipeline Settings'; } });
  }

  // ─── Firehose page enhancements ───────────────────────────────────────────

  function loadFirehoseStatsWidget() {
    var el = $('firehose-stats-widget');
    if (!el) return;
    fetchApi('/api/firehose/status')
      .then(function (data) {
        var s = data.stats || {};
        el.innerHTML =
          fhStat((s.articlesReceived || 0).toLocaleString(), 'Received') +
          fhStat((s.articlesQueued || 0).toLocaleString(), 'Queued') +
          fhStat((s.articlesDroppedByLanguage || 0).toLocaleString(), 'Dropped (Lang)') +
          fhStat((s.articlesDroppedByDomain || 0).toLocaleString(), 'Dropped (Domain)') +
          fhStat((s.reconnects || 0), 'Reconnects') +
          fhStat((s.parseErrors || 0), 'Parse Errors');
      })
      .catch(function () { if (el) el.innerHTML = '<p class="placeholder-text">Stats unavailable</p>'; });
  }

  function fhStat(val, label) {
    return '<div class="fh-stat"><div class="fh-stat-val">' + val + '</div><div class="fh-stat-label">' + label + '</div></div>';
  }

  var _fhConnKeys = ['FIREHOSE_SINCE', 'FIREHOSE_TIMEOUT', 'FIREHOSE_RECONNECT_MIN', 'FIREHOSE_RECONNECT_MAX'];

  function loadFirehoseConnSettings() {
    fetchApi('/api/settings')
      .then(function (data) {
        var settings = data.settings || {};
        _fhConnKeys.forEach(function (key) {
          var el = document.querySelector('[data-setting-key="' + key + '"]');
          if (el && settings[key] !== undefined) el.value = settings[key];
        });
      });
  }

  function saveFirehoseConnSettings() {
    var body = {};
    _fhConnKeys.forEach(function (key) {
      var el = document.querySelector('[data-setting-key="' + key + '"]');
      if (el) body[key] = el.value;
    });
    fetchApi('/api/settings', { method: 'PUT', body: body })
      .then(function () { showToast('Connection settings saved', 'success'); })
      .catch(function (e) { showToast('Save failed: ' + e.message, 'error'); });
  }

  function loadLangFilter() {
    fetchApi('/api/settings')
      .then(function (data) {
        var val = (data.settings || {}).FIREHOSE_ALLOWED_LANGS || 'en,hi';
        var langs = val.split(',').map(function (l) { return l.trim(); });
        var checkboxes = document.querySelectorAll('#fh-lang-checkboxes input[type=checkbox]');
        checkboxes.forEach(function (cb) { cb.checked = langs.indexOf(cb.value) !== -1; });
      });
  }

  function saveLangFilter() {
    var checked = document.querySelectorAll('#fh-lang-checkboxes input[type=checkbox]:checked');
    var langs = [];
    checked.forEach(function (cb) { langs.push(cb.value); });
    if (!langs.length) { showToast('Select at least one language', 'error'); return; }
    fetchApi('/api/settings', { method: 'PUT', body: { FIREHOSE_ALLOWED_LANGS: langs.join(',') } })
      .then(function () { showToast('Language filter saved', 'success'); })
      .catch(function (e) { showToast('Save failed: ' + e.message, 'error'); });
  }

  function loadDomainFilters() {
    fetchApi('/api/settings')
      .then(function (data) {
        var s = data.settings || {};
        var blocked = $('fh-blocked-domains');
        var allowed = $('fh-allowed-domains');
        if (blocked) blocked.value = (s.FIREHOSE_BLOCKED_DOMAINS || '').split(',').filter(Boolean).join('\n');
        if (allowed) allowed.value = (s.FIREHOSE_ALLOWED_DOMAINS || '').split(',').filter(Boolean).join('\n');
      });
  }

  function saveDomainFilters() {
    var blockedEl = $('fh-blocked-domains');
    var allowedEl = $('fh-allowed-domains');
    var blockedVal = (blockedEl ? blockedEl.value : '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean).join(',');
    var allowedVal = (allowedEl ? allowedEl.value : '').split('\n').map(function (l) { return l.trim(); }).filter(Boolean).join(',');
    fetchApi('/api/settings', { method: 'PUT', body: { FIREHOSE_BLOCKED_DOMAINS: blockedVal, FIREHOSE_ALLOWED_DOMAINS: allowedVal } })
      .then(function () { showToast('Domain filters saved', 'success'); })
      .catch(function (e) { showToast('Save failed: ' + e.message, 'error'); });
  }

  // ─── Lottery page ──────────────────────────────────────────────────────────

  function loadLotteryPage() {
    loadLotterySlots();

    var refreshBtn = $('lotteryRefreshBtn');
    if (refreshBtn) refreshBtn.onclick = function () { forceApiRefresh('/api/lottery'); loadLotteryPage(); showToast('Refreshed', 'info'); };

    var fetchAllBtn = $('lotteryFetchAllBtn');
    if (fetchAllBtn) fetchAllBtn.onclick = function () {
      fetchAllBtn.disabled = true;
      fetchAllBtn.textContent = 'Fetching...';
      fetchApi('/api/lottery/fetch', { method: 'POST' })
        .then(function (res) {
          showToast((res.data && res.data.message) || 'Fetch triggered', 'success');
          setTimeout(loadLotterySlots, 1200);
        })
        .catch(function (e) { showToast('Fetch failed: ' + e.message, 'error'); })
        .finally(function () { fetchAllBtn.disabled = false; fetchAllBtn.textContent = '⚡ Fetch All'; });
    };

    var genBtn = $('lotteryGenPostsBtn');
    if (genBtn) genBtn.onclick = function () {
      genBtn.disabled = true;
      genBtn.textContent = 'Generating...';
      fetchApi('/api/lottery/generate-posts', { method: 'POST' })
        .then(function (res) {
          showToast((res.data && res.data.message) || 'Posts generated', 'success');
          setTimeout(loadLotterySlots, 1200);
        })
        .catch(function (e) { showToast('Generate failed: ' + e.message, 'error'); })
        .finally(function () { genBtn.disabled = false; genBtn.textContent = '📝 Generate Posts'; });
    };
  }

  function loadLotterySlots() {
    fetchApi('/api/lottery/summary')
      .then(function (res) {
        var summary = res.data || res;
        var draws = summary.draws || {};
        var date = summary.date || '—';

        // Update stat bar
        var fetched = ['1pm', '6pm', '8pm'].filter(function (k) {
          return draws[k] && draws[k].status === 'success';
        }).length;
        var posted = ['1pm', '6pm', '8pm'].filter(function (k) {
          return draws[k] && draws[k].wp_post_id;
        }).length;
        var elDate = $('lottery-stat-date');
        var elFetched = $('lottery-stat-fetched');
        var elPosted = $('lottery-stat-posted');
        if (elDate) elDate.textContent = date;
        if (elFetched) elFetched.textContent = fetched + '/3';
        if (elPosted) elPosted.textContent = posted + '/3';

        // Draw cards
        var slots = [
          { key: '1pm', label: '1 PM Draw', icon: '🌅' },
          { key: '6pm', label: '6 PM Draw', icon: '🌆' },
          { key: '8pm', label: '8 PM Draw', icon: '🌙' },
        ];
        var wrap = $('lottery-draws-wrap');
        if (!wrap) return;
        wrap.innerHTML = slots.map(function (s) {
          var draw = draws[s.key] || { status: 'pending' };
          var statusColor = draw.status === 'success' ? '#22c55e'
            : draw.status === 'failed' ? '#ef4444'
            : draw.status === 'fetching' ? '#f59e0b'
            : '#6b7280';
          var statusLabel = draw.status === 'success' ? '✅ Fetched'
            : draw.status === 'failed' ? '❌ Failed'
            : draw.status === 'fetching' ? '⏳ Fetching...'
            : '⏰ Pending';
          var wpLine = draw.wp_post_id
            ? '<div style="font-size:12px;margin-bottom:10px;color:#3b82f6;">WP Post #' + draw.wp_post_id + '</div>'
            : '<div style="font-size:12px;margin-bottom:10px;color:#6b7280;">No WP post yet</div>';
          var nameLine = draw.draw_name
            ? '<div style="font-size:12px;color:#94a3b8;margin-top:2px;">' + draw.draw_name + '</div>'
            : '';
          return '<div class="card" style="text-align:center;padding:22px;">'
            + '<div style="font-size:30px;margin-bottom:8px;">' + s.icon + '</div>'
            + '<div style="font-size:15px;font-weight:700;">' + s.label + '</div>'
            + nameLine
            + '<div style="color:' + statusColor + ';font-weight:600;margin:10px 0 4px;">' + statusLabel + '</div>'
            + wpLine
            + '<button class="btn btn-sm btn-outline" onclick="window.__fetchLotterySlot(\'' + s.key + '\')">Fetch ' + s.key + '</button>'
            + '</div>';
        }).join('');
      })
      .catch(function (e) {
        var wrap = $('lottery-draws-wrap');
        if (wrap) wrap.innerHTML = '<div style="color:#ef4444;padding:16px;">Error loading summary: ' + e.message + '</div>';
      });
  }

  window.__fetchLotterySlot = function (drawTime) {
    showToast('Fetching ' + drawTime + ' draw...', 'info');
    fetchApi('/api/lottery/fetch/' + drawTime, { method: 'POST' })
      .then(function (res) {
        showToast((res.data && res.data.message) || 'Done', 'success');
        setTimeout(loadLotterySlots, 900);
      })
      .catch(function (e) { showToast('Fetch failed: ' + e.message, 'error'); });
  };

  function loadLotteryRecent() {
    fetchApi('/api/lottery/recent?limit=30')
      .then(function (res) {
        var rows = res.data || res;
        if (!Array.isArray(rows)) rows = [];
        var tbody = $('lottery-recent-tbody');
        if (!tbody) return;
        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;color:#888">No results yet</td></tr>';
          return;
        }
        tbody.innerHTML = rows.map(function (r) {
          var statusColor = r.status === 'success' ? '#22c55e' : r.status === 'failed' ? '#ef4444' : '#6b7280';
          var wpCell = r.wp_post_id ? '#' + r.wp_post_id : '—';
          return '<tr>'
            + '<td>' + (r.draw_date || '—') + '</td>'
            + '<td>' + (r.draw_time || '—') + '</td>'
            + '<td>' + (r.draw_name || '—') + '</td>'
            + '<td>' + (r.source || '—') + '</td>'
            + '<td style="color:' + statusColor + ';font-weight:600;">' + (r.status || '—') + '</td>'
            + '<td>' + wpCell + '</td>'
            + '<td>' + (r.retry_count != null ? r.retry_count : '—') + '</td>'
            + '<td>' + (r.fetched_at ? r.fetched_at.slice(0, 16) : '—') + '</td>'
            + '</tr>';
        }).join('');
      });
  }

  function loadLotteryLogs() {
    fetchApi('/api/lottery/logs?limit=50')
      .then(function (res) {
        var rows = res.data || res;
        if (!Array.isArray(rows)) rows = [];
        var tbody = $('lottery-logs-tbody');
        if (!tbody) return;
        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#888">No logs yet</td></tr>';
          return;
        }
        tbody.innerHTML = rows.map(function (r) {
          var color = r.error_message ? '#ef4444' : '';
          return '<tr style="color:' + color + ';">'
            + '<td style="white-space:nowrap;">' + (r.created_at ? r.created_at.slice(0, 16) : '—') + '</td>'
            + '<td>' + (r.fetch_type || '—') + '</td>'
            + '<td>' + (r.cities_ok != null ? r.cities_ok : '—') + '</td>'
            + '<td>' + (r.duration_ms != null ? r.duration_ms + 'ms' : '—') + '</td>'
            + '<td style="word-break:break-word;max-width:200px;">' + (r.error_message || '') + '</td>'
            + '<td style="word-break:break-word;max-width:300px;">' + (r.details || '') + '</td>'
            + '</tr>';
        }).join('');
      });
  }

  window.__switchLotteryTab = function (tab) {
    document.querySelectorAll('#lottery-tabs .tab').forEach(function (b) {
      b.classList.toggle('active', b.dataset.tab === tab);
    });
    var tabs = { today: 'lottery-tab-today', recent: 'lottery-tab-recent', logs: 'lottery-tab-logs' };
    Object.keys(tabs).forEach(function (k) {
      var el = $(tabs[k]);
      if (el) el.style.display = k === tab ? '' : 'none';
    });
    if (tab === 'recent') loadLotteryRecent();
    if (tab === 'logs') loadLotteryLogs();
  };

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
