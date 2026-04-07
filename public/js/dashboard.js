(function () {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  //  HDF AutoPub Dashboard — Client-Side SPA
  // ═══════════════════════════════════════════════════════════════════════════

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

  function fetchApi(url, options) {
    options = options || {};
    options.credentials = 'same-origin';
    if (!options.headers) options.headers = {};

    if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }

    return fetch(url, options).then(function (res) {
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
    });
  }

  // ─── Router ─────────────────────────────────────────────────────────────

  function navigateTo(page) {
    // Clear timers from the previous page before switching
    clearPageTimers();

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
      case 'published': loadPublished(); break;
      case 'settings': loadSettings(); loadAISettings(); break;
      case 'logs': loadLogs(); break;
    }

    // Close sidebar on mobile
    var sidebar = $('sidebar');
    if (sidebar) sidebar.classList.remove('open');
  }

  function initRouter() {
    var hash = window.location.hash.slice(1) || 'overview';
    navigateTo(hash);

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
            '<a href="' + escapeHtml(article.url || '#') + '" target="_blank" rel="noopener" onclick="event.stopPropagation();">' +
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
    if (!bar) return;
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
      '<button class="btn btn-sm" style="background:#10b981;color:#fff;border:none;white-space:nowrap;" onclick="window.__goToPublished();this.parentElement.remove();">Go to Published</button>' +
      '<button style="background:none;border:none;color:#666;cursor:pointer;font-size:18px;padding:4px;" onclick="this.parentElement.remove();">&times;</button>';
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

    // Refresh button
    var refreshBtn = $('rulesRefreshBtn');
    if (refreshBtn) {
      refreshBtn.onclick = function () {
        loadFirehoseStatus();
        loadFirehoseRules();
        showToast('Refreshed', 'info');
      };
    }
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
              '<button class="btn btn-sm btn-secondary" onclick="window.__editRule(\'' + escapeHtml(String(r.id)) + '\',\'' + escapeHtml((r.tag || '').replace(/'/g, "\\'")) + '\',\'' + escapeHtml((r.value || '').replace(/'/g, "\\'")) + '\',' + (r.quality !== false) + ')">Edit</button>' +
              '<button class="btn btn-sm btn-danger" onclick="window.__deleteRule(\'' + escapeHtml(String(r.id)) + '\')">Delete</button>' +
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
          '<div class="cluster-header" onclick="window.__toggleCluster(' + c.id + ')">' +
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
              (canPublish ? '<button class="btn btn-sm btn-success" onclick="event.stopPropagation(); window.__publishCluster(' + c.id + ')">Publish</button>' : '') +
              (canSkip ? '<button class="btn btn-sm btn-secondary" onclick="event.stopPropagation(); window.__skipCluster(' + c.id + ')">Skip</button>' : '') +
              ((c.status === 'queued' || c.status === 'published') ? '<button class="btn btn-sm" style="background:#6366f1;color:#fff;border:none;" onclick="event.stopPropagation(); window.__goToPublished()">&#128221; View Drafts</button>' : '') +
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

  // ─── Published Page (Drafts + Auto-Published) ──────────────────────────

  var publishedPollInterval = null;

  function loadPublished() {
    var container = $('publishedList');
    var pagination = $('publishedPagination');

    if (container) container.innerHTML = '<p class="placeholder-text">Loading...</p>';
    if (pagination) pagination.innerHTML = '';

    fetchApi('/api/drafts')
      .then(function (data) {
        var drafts = data.data || [];
        renderDraftsView(container, drafts);
        startPublishedPolling();
      })
      .catch(function (err) {
        if (container) container.innerHTML = '<p class="placeholder-text">Failed to load</p>';
        showToast('Failed to load drafts: ' + err.message, 'error');
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

    // Separate cluster drafts from manual drafts
    var clusterMap = {};
    var manualDrafts = [];
    for (var i = 0; i < drafts.length; i++) {
      var d = drafts[i];
      if (d.cluster_id) {
        if (!clusterMap[d.cluster_id]) clusterMap[d.cluster_id] = { drafts: [], primary: null };
        clusterMap[d.cluster_id].drafts.push(d);
        if (d.cluster_role === 'primary') clusterMap[d.cluster_id].primary = d;
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

    var filterHTML =
      '<div class="published-toolbar">' +
        // ─── Row 1: Filter buttons ───────────────────────────────
        '<div class="status-filters">' +
          '<button class="filter-btn active" data-filter="all">All (' + counts.all + ')</button>' +
          '<button class="filter-btn" data-filter="cluster">&#128218; Clusters (' + clusterIds.length + ')</button>' +
          '<button class="filter-btn" data-filter="manual">&#128100; Manual (' + manualDrafts.length + ')</button>' +
          '<span class="filter-divider"></span>' +
          '<button class="filter-btn" data-filter="fetching">Fetching (' + counts.fetching + ')</button>' +
          '<button class="filter-btn" data-filter="draft">Extracted (' + counts.draft + ')</button>' +
          '<button class="filter-btn" data-filter="rewriting">Rewriting (' + counts.rewriting + ')</button>' +
          '<button class="filter-btn" data-filter="ready">Ready (' + counts.ready + ')</button>' +
          '<button class="filter-btn" data-filter="published">Published (' + counts.published + ')</button>' +
          (counts.failed > 0 ? '<button class="filter-btn" data-filter="failed">&#10060; Failed (' + counts.failed + ')</button>' : '') +
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
          '<button class="action-btn action-btn-ai" id="batchRewriteBtn"' +
            (readyForRewriteCount === 0 ? ' disabled title="No clusters ready — extract articles first"' : '') + '>' +
            '<span class="action-btn-icon">&#129302;</span>' +
            '<span class="action-btn-text">Rewrite All Extracted</span>' +
            (readyForRewriteCount > 0 ? '<span class="action-btn-badge action-btn-badge-purple">' + readyForRewriteCount + '</span>' : '') +
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

    container.innerHTML = filterHTML + '<div class="drafts-list">' + cardsHTML + '</div>';

    // Attach filter listeners
    var filterBtns = container.querySelectorAll('.filter-btn');
    for (var f = 0; f < filterBtns.length; f++) {
      filterBtns[f].addEventListener('click', function () {
        var filter = this.getAttribute('data-filter');
        var siblings = container.querySelectorAll('.filter-btn');
        for (var s = 0; s < siblings.length; s++) siblings[s].classList.remove('active');
        this.classList.add('active');

        var groups = container.querySelectorAll('.cluster-group');
        var singles = container.querySelectorAll('.draft-card');
        var dividers = container.querySelectorAll('.section-divider');

        for (var g = 0; g < groups.length; g++) {
          if (filter === 'all' || filter === 'cluster') {
            groups[g].style.display = '';
          } else if (filter === 'manual') {
            groups[g].style.display = 'none';
          } else {
            var hasMatch = groups[g].querySelector('[data-status="' + filter + '"]');
            groups[g].style.display = hasMatch ? '' : 'none';
          }
        }
        for (var dd = 0; dd < singles.length; dd++) {
          var cardStatus = singles[dd].getAttribute('data-status');
          if (filter === 'all' || filter === 'manual') {
            singles[dd].style.display = '';
          } else if (filter === 'cluster') {
            singles[dd].style.display = 'none';
          } else {
            singles[dd].style.display = (cardStatus === filter) ? '' : 'none';
          }
        }
        for (var dv = 0; dv < dividers.length; dv++) {
          dividers[dv].style.display = (filter === 'all') ? '' : 'none';
        }
      });
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
    var contentPreview = extractReadableText(rawContent).substring(0, isPrimary ? 300 : 150);

    var extractedChars = (draft.extracted_content || '').length;
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
      actionsHTML += '<button class="btn btn-xs btn-secondary" onclick="window.__retryExtract(' + draft.id + ')">&#8635; Retry</button>';
    }
    if (isPrimary && (draft.status === 'draft' || draft.status === 'failed')) {
      actionsHTML += '<button class="btn btn-xs btn-purple" onclick="window.__triggerRewrite(' + draft.id + ')">&#129302; Rewrite</button>';
    }
    if (isPrimary && draft.status !== 'fetching' && draft.status !== 'rewriting') {
      actionsHTML += '<button class="btn btn-xs btn-secondary" onclick="window.__openEditor(' + draft.id + ')">&#9998; Edit</button>';
    }
    if (isPrimary && (draft.status === 'ready' || draft.status === 'published')) {
      actionsHTML += '<button class="btn btn-xs btn-secondary" onclick="window.__previewDraftHTML(' + draft.id + ')">&#128065; Preview</button>';
    }
    if (isPrimary && draft.status === 'ready') {
      actionsHTML += '<button class="btn btn-xs btn-green" onclick="window.__openEditor(' + draft.id + ')">&#128640; Publish</button>';
    }
    if (draft.status === 'failed') {
      actionsHTML += '<button class="btn btn-xs btn-secondary" onclick="window.__retryDraft(' + draft.id + ')">&#8635; Retry</button>';
    }

    var errorHTML = '';
    if (draft.error_message) {
      errorHTML = '<div class="compact-error">&#10060; ' + escapeHtml(draft.error_message) +
        (draft.retry_count ? ' (attempt ' + draft.retry_count + '/' + (draft.max_retries || 3) + ')' : '') + '</div>';
    }

    var cardClass = isPrimary ? 'compact-card compact-primary' : 'compact-card compact-source cluster-source-card';
    if (draft.status === 'published') cardClass += ' compact-published';
    if (draft.status === 'failed') cardClass += ' compact-failed';

    return '<div class="' + cardClass + '" data-id="' + draft.id + '" data-status="' + escapeHtml(draft.status) + '">' +
      '<div class="compact-card-left">' +
        '<div class="compact-card-header">' +
          '<span class="compact-status' + (isPulsing ? ' pulsing' : '') + '" style="background:' + statusColor + '">' + statusLabel + '</span>' +
          (isPrimary ? '<span class="compact-role-primary">&#11088; Primary</span>' : '<span class="compact-role-source">&#128279; Source</span>') +
          '<span class="compact-domain">' + escapeHtml(draft.source_domain || '') + '</span>' +
          extractInfo + aiInfo + wordCountInfo +
        '</div>' +
        '<div class="compact-title">' + escapeHtml(draft.extracted_title || draft.source_title || draft.source_url) + '</div>' +
        (contentPreview ? '<p class="compact-preview">' + escapeHtml(truncate(contentPreview, isPrimary ? 300 : 150)) + '</p>' : '') +
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
      actionsHTML += '<button class="btn btn-sm btn-secondary" onclick="window.__retryExtract(' + draft.id + ')">&#8635; Retry</button>';
    }
    if (draft.status !== 'fetching' && (draft.extraction_status === 'failed' || draft.is_partial)) {
      actionsHTML += '<button class="btn btn-sm btn-secondary" onclick="window.__retryExtract(' + draft.id + ')">&#8635; Retry Extract</button>';
    }
    if (draft.status !== 'fetching' && draft.status !== 'rewriting') {
      actionsHTML += '<button class="btn btn-sm btn-primary" onclick="window.__openEditor(' + draft.id + ')">&#9998; Edit Draft</button>';
    }
    if (draft.status === 'failed' && !draft.failed_permanent) {
      actionsHTML += '<button class="btn btn-sm btn-secondary" onclick="window.__retryDraft(' + draft.id + ')">&#8635; Reset &amp; Retry</button>';
    }
    if (draft.status === 'draft' || draft.status === 'failed') {
      actionsHTML += '<button class="btn btn-sm btn-purple" onclick="window.__triggerRewrite(' + draft.id + ')">&#129302; Rewrite</button>';
    }
    if (draft.status === 'rewriting') {
      actionsHTML += '<button class="btn btn-sm btn-secondary" disabled>&#9203; Rewriting...</button>';
    }
    if (draft.status === 'ready' || draft.status === 'published') {
      actionsHTML += '<button class="btn btn-sm btn-secondary" onclick="window.__previewDraftHTML(' + draft.id + ')">&#128065; Preview</button>';
      actionsHTML += '<button class="btn btn-sm btn-secondary" onclick="window.__downloadDraftHTML(' + draft.id + ')">&#11015; Download</button>';
    }
    if (draft.status === 'ready') {
      actionsHTML += '<button class="btn btn-sm btn-green" onclick="window.__openEditor(' + draft.id + ')">&#128640; Publish</button>';
    }
    if (draft.status === 'published') {
      actionsHTML += '<button class="btn btn-sm btn-secondary" onclick="window.__openEditor(' + draft.id + ')">' + (draft.wp_post_id ? '&#8635; Update on WP' : '&#8635; Re-Publish') + '</button>';
    }
    actionsHTML += '<button class="btn btn-sm btn-danger" onclick="window.__deleteDraft(' + draft.id + ')">&#128465;</button>';

    var imageHTML = '';
    if (draft.featured_image) {
      imageHTML = '<div class="draft-card-image"><img src="' + escapeHtml(draft.featured_image) + '" alt="" onerror="this.parentElement.style.display=\'none\'"></div>';
    }

    return '<div class="draft-card' + (draft.featured_image ? ' has-image' : '') + '" data-id="' + draft.id + '" data-status="' + escapeHtml(draft.status) + '">' +
      imageHTML +
      '<div class="draft-card-body">' +
        '<div class="draft-header">' +
          '<span class="draft-status-badge' + (isPulsing ? ' pulsing' : '') + '" style="background:' + statusColor + '">' +
            escapeHtml(draft.status.toUpperCase()) +
          '</span>' +
          '<span class="draft-mode">&#128100; Manual</span>' +
          '<span class="draft-time">' + formatTime(draft.created_at) + '</span>' +
        '</div>' +
        '<h3 class="draft-title">' + escapeHtml(draft.extracted_title || draft.source_title || draft.source_url) + '</h3>' +
        '<div class="draft-meta">' +
          '<span class="domain-badge">' + escapeHtml(draft.source_domain || '--') + '</span>' +
          (draft.source_language ? '<span class="domain-badge">' + escapeHtml(draft.source_language.toUpperCase()) + '</span>' : '') +
          (draft.target_keyword ? '<span class="domain-badge" style="color:var(--green)">&#127919; ' + escapeHtml(draft.target_keyword) + '</span>' : '') +
          (draft.extraction_status === 'success' ? '<span style="color:var(--green);font-size:11px">&#9989; ' + formatCharCount((draft.extracted_content || '').length) + '</span>' : '') +
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
        if (data.success) { showToast('Draft reset for retry', 'info'); setTimeout(loadPublished, 1000); }
        else showToast('Retry failed: ' + (data.error || 'Unknown'), 'error');
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

  function startPublishedPolling() {
    if (publishedPollInterval) clearInterval(publishedPollInterval);
    publishedPollInterval = setInterval(function () {
      if (state.currentPage !== 'published') {
        clearInterval(publishedPollInterval);
        publishedPollInterval = null;
        return;
      }
      // Re-render the entire Published page to pick up status changes in cluster groups
      fetchApi('/api/drafts')
        .then(function (data) {
          var drafts = data.data || [];
          var hasActive = drafts.some(function (d) {
            return d.status === 'fetching' || d.status === 'rewriting' || d.status === 'ready';
          });

          // Full re-render to correctly update cluster groups and progress bars
          renderDraftsView(drafts);

          if (!hasActive) {
            clearInterval(publishedPollInterval);
            publishedPollInterval = null;
          }
        })
        .catch(function () { /* silent */ });
    }, 5000);
  }

  // ─── Content Editor ─────────────────────────────────────────────────────

  var currentDraftId = null;
  var currentDraft = null;

  window.__openEditor = function (draftId) {
    openEditor(draftId);
  };

  function openEditor(draftId) {
    currentDraftId = draftId;

    fetchApi('/api/drafts/' + draftId)
      .then(function (data) {
        var draft = data.data;
        currentDraft = draft;

        // Populate top bar
        var editorTitleText = 'Draft Editor \u2014 ' + (draft.extracted_title || draft.source_title || 'Untitled');
        if (draft.cluster_id) {
          editorTitleText = '\uD83D\uDCDA Cluster #' + draft.cluster_id + ' \u2014 ' + (draft.extracted_title || draft.source_title || 'Untitled');
        }
        $('editor-title').textContent = editorTitleText;
        $('editor-status').textContent = draft.status.toUpperCase();
        $('editor-status').style.background = getStatusColor(draft.status);

        // Source tab — featured image + meta
        var featImgHTML = '';
        if (draft.featured_image) {
          featImgHTML = '<div class="editor-featured-image">' +
            '<img src="' + escapeHtml(draft.featured_image) + '" alt="Featured image" onerror="this.style.display=\'none\'">' +
            '</div>';
        }
        featImgHTML += '<div class="editor-featured-url">' +
          '<label><strong>Featured Image URL:</strong>' +
          '<input type="text" id="editor-featured-input" value="' + escapeHtml(draft.featured_image || '') + '" placeholder="https://..." style="width:100%;margin-top:4px;padding:6px 10px;background:var(--bg-main);border:1px solid var(--border);border-radius:var(--radius);color:var(--text-primary);font-size:0.8rem">' +
          '</label></div>';

        $('source-meta').innerHTML = featImgHTML +
          '<div style="margin-top:10px">' +
          '<strong>Source:</strong> <a href="' + escapeHtml(draft.source_url) + '" target="_blank" style="color:var(--accent)">' + escapeHtml(draft.source_domain || draft.source_url) + '</a>' +
          ' | <strong>Language:</strong> ' + escapeHtml(draft.source_language || '--') +
          ' | <strong>Category:</strong> ' + escapeHtml(draft.source_category || '--') +
          ' | <strong>Extraction:</strong> ' + escapeHtml(draft.extraction_status || '--') +
          (draft.extracted_content ? ' | <strong>Length:</strong> ' + draft.extracted_content.length + ' chars' : '') +
          '</div>';

        // Save featured image on blur
        var featInput = $('editor-featured-input');
        if (featInput) {
          featInput.addEventListener('change', function () {
            fetchApi('/api/drafts/' + draftId, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ featured_image: featInput.value })
            }).then(function () { showToast('Featured image updated', 'info'); })
              .catch(function () { showToast('Failed to save image URL', 'error'); });
          });
        }

        $('source-content').textContent = draft.extracted_content || draft.source_content_markdown || 'No content extracted.';

        // ─── Cluster Sources Panel ───────────────────────────────
        var clusterSourcesContainer = $('cluster-sources-panel');
        if (clusterSourcesContainer) clusterSourcesContainer.remove();

        if (draft.cluster_id) {
          var sourcesPanel = document.createElement('div');
          sourcesPanel.id = 'cluster-sources-panel';
          sourcesPanel.style.cssText = 'margin-top:16px;border-top:1px solid var(--border);padding-top:16px;';
          sourcesPanel.innerHTML =
            '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;cursor:pointer" onclick="this.parentElement.querySelector(\'.cluster-editor-sources\').style.display = this.parentElement.querySelector(\'.cluster-editor-sources\').style.display === \'none\' ? \'\' : \'none\'; this.querySelector(\'.toggle-arrow\').textContent = this.parentElement.querySelector(\'.cluster-editor-sources\').style.display === \'none\' ? \'\\u25B8\' : \'\\u25BE\'">' +
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
                var sdChars = (sd.extracted_content || '').length;

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
                    '<div style="font-weight:600;font-size:13px;margin-bottom:4px;color:var(--text-primary)">' +
                      '<a href="' + escapeHtml(sd.source_url || '#') + '" target="_blank" style="color:var(--accent);text-decoration:none">' +
                        escapeHtml(sd.extracted_title || sd.source_title || sd.source_url || 'Untitled') +
                      '</a>' +
                    '</div>' +
                    (sdContent ?
                      '<div style="font-size:12px;color:var(--text-secondary);line-height:1.4;max-height:80px;overflow:hidden">' +
                        escapeHtml(sdContent.substring(0, 300)) +
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
        }

        // Reset tabs to defaults
        resetEditorTabs();

        // Show editor
        $('editor-overlay').style.display = 'flex';
      })
      .catch(function (err) {
        showToast('Failed to load draft: ' + err.message, 'error');
      });
  }

  function closeEditor() {
    $('editor-overlay').style.display = 'none';
    currentDraftId = null;
    currentDraft = null;
    loadPublished();
  }

  function resetEditorTabs() {
    // Reset left tabs
    var leftTabs = document.querySelectorAll('.editor-left .editor-tab');
    for (var i = 0; i < leftTabs.length; i++) leftTabs[i].classList.toggle('active', leftTabs[i].getAttribute('data-tab') === 'source');
    $('tab-source').style.display = '';
    $('tab-settings').style.display = 'none';
    // Reset right tabs
    var rightTabs = document.querySelectorAll('.editor-right .editor-tab');
    for (var j = 0; j < rightTabs.length; j++) rightTabs[j].classList.toggle('active', rightTabs[j].getAttribute('data-tab') === 'ai-output');
    $('tab-ai-output').style.display = '';
    $('tab-html-editor').style.display = 'none';
    $('tab-preview').style.display = 'none';
  }

  function getStatusColor(status) {
    var colors = { fetching: '#f59e0b', draft: '#4a7aff', editing: '#8b5cf6', rewriting: '#a855f7', ready: '#22c55e', published: '#6b7280' };
    return colors[status] || '#6b7280';
  }

  function updatePreviewIframe(html) {
    if (!html) return;
    var iframe = $('preview-iframe');
    if (!iframe) return;
    var doc = iframe.contentDocument || iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();
  }

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

    var tabMap = { source: 'tab-source', settings: 'tab-settings', 'ai-output': 'tab-ai-output', 'html-editor': 'tab-html-editor', preview: 'tab-preview' };
    var target = $(tabMap[tab]);
    if (target) target.style.display = '';

    if (tab === 'preview') {
      updatePreviewIframe($('html-code-editor').value);
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
          { value: 'gpt-4o', label: 'GPT-4o (Balanced)' },
          { value: 'gpt-4o-mini', label: 'GPT-4o Mini (Fast)' },
          { value: 'gpt-4.1', label: 'GPT-4.1 (Latest)' },
          { value: 'gpt-4.1-mini', label: 'GPT-4.1 Mini (Latest Fast)' },
          { value: 'gpt-4.1-nano', label: 'GPT-4.1 Nano (Cheapest)' },
          { value: 'o3', label: 'O3 (Reasoning)' },
          { value: 'o3-mini', label: 'O3 Mini (Reasoning Fast)' },
          { value: 'o4-mini', label: 'O4 Mini (Latest Reasoning)' },
        ],
        openrouter: [
          { value: 'qwen/qwen3.6-plus:free', label: 'Qwen 3.6 Plus (Free Best)' },
          { value: 'stepfun/step-3.5-flash:free', label: 'Step 3.5 Flash (Free Fast)' },
          { value: 'nvidia/nemotron-3-super-120b-a12b:free', label: 'Nemotron 3 Super (Free 120B)' },
          { value: 'meta-llama/llama-3.3-70b-instruct:free', label: 'Llama 3.3 70B (Free Meta)' },
          { value: 'openai/gpt-oss-120b:free', label: 'GPT-OSS 120B (Free)' },
          { value: 'arcee-ai/trinity-large-preview:free', label: 'Trinity Large (Free Creative)' },
          { value: 'z-ai/glm-4.5-air:free', label: 'GLM 4.5 Air (Free)' },
          { value: 'minimax/minimax-m2.5:free', label: 'MiniMax M2.5 (Free)' },
          { value: 'qwen/qwen3-coder:free', label: 'Qwen3 Coder 480B (Free)' },
          { value: 'qwen/qwen3-next-80b-a3b-instruct:free', label: 'Qwen3 Next 80B (Free)' },
        ],
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
        if (modelSelect && AI_MODELS[prov]) {
          var optHtml = '';
          for (var m = 0; m < AI_MODELS[prov].length; m++) {
            optHtml += '<option value="' + AI_MODELS[prov][m].value + '">' + AI_MODELS[prov][m].label + '</option>';
          }
          modelSelect.innerHTML = optHtml;
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
        var win = window.open('', '_blank');
        if (!win) { showToast('Popup blocked by browser', 'error'); return; }
        win.document.write(html);
        win.document.close();
      };
    }

    var publishBtn = $('editorPublishBtn');
    if (publishBtn) {
      publishBtn.onclick = function () {
        if (!currentDraftId) return;
        var platform = $('setting-platform').value;
        var html = $('html-code-editor').value;
        if (!html) { showToast('No HTML content to publish', 'error'); return; }
        if (!confirm('Publish this draft to ' + platform + '?')) return;

        $('editor-status').textContent = 'PUBLISHING...';
        $('editor-status').style.background = '#f59e0b';

        // Save editor settings first (platform, keyword, etc) then publish
        saveEditorSettings();

        fetchApi('/api/drafts/' + currentDraftId + '/publish', {
          method: 'POST',
          body: { platform: platform, html: html }
        })
          .then(function (data) {
            if (data.success) {
              $('editor-status').textContent = 'PUBLISHED';
              $('editor-status').style.background = '#22c55e';
              showToast('Published!' + (data.url ? ' URL: ' + data.url : ''), 'success');
              // Hide error log on success
              var logPanel = $('editorWpLog');
              if (logPanel) logPanel.style.display = 'none';
            } else {
              showToast('Publish failed: ' + (data.error || 'Unknown'), 'error');
              $('editor-status').textContent = 'READY';
              $('editor-status').style.background = '#22c55e';
              // Auto-show WP error log on failure
              var logPanel = $('editorWpLog');
              if (logPanel) {
                logPanel.style.display = '';
                loadWpErrorLog('editorWpLogContent');
              }
            }
          })
          .catch(function (err) {
            showToast('Publish error: ' + err.message, 'error');
            $('editor-status').textContent = 'READY';
            $('editor-status').style.background = '#22c55e';
            // Auto-show WP error log on network error
            var logPanel = $('editorWpLog');
            if (logPanel) {
              logPanel.style.display = '';
              loadWpErrorLog('editorWpLogContent');
            }
          });
      };
    }
  }

  function saveEditorSettings() {
    if (!currentDraftId) return;
    var schemaTypes = [];
    var checkboxes = document.querySelectorAll('#draft-settings-form .checkbox-group input:checked');
    for (var i = 0; i < checkboxes.length; i++) schemaTypes.push(checkboxes[i].value);

    fetchApi('/api/drafts/' + currentDraftId, {
      method: 'PUT',
      body: {
        target_keyword: $('setting-keyword').value,
        target_domain: $('setting-domain').value,
        target_platform: $('setting-platform').value,
        target_language: $('setting-language').value,
        schema_types: schemaTypes.join(','),
        custom_ai_instructions: $('setting-custom-prompt') ? $('setting-custom-prompt').value : '',
      }
    }).catch(function (err) { showToast('Failed to save settings', 'error'); });
  }

  function pollEditorRewriteStatus(draftId) {
    var interval = setInterval(function () {
      fetchApi('/api/drafts/' + draftId)
        .then(function (data) {
          var draft = data.data;
          if (draft.status === 'ready' && draft.rewritten_html) {
            clearInterval(interval);
            currentDraft = draft;
            $('editor-status').textContent = 'READY';
            $('editor-status').style.background = '#22c55e';
            $('ai-output-content').innerHTML =
              '<p style="color:var(--green);">\u2705 Rewrite complete \u2014 ' + (draft.rewritten_word_count || '?') + ' words (' + (draft.ai_model_used || 'AI') + ')</p>' +
              '<p>Switch to "HTML Editor" to review, or "Preview" to see the final page.</p>';
            $('html-code-editor').value = draft.rewritten_html;
            updatePreviewIframe(draft.rewritten_html);
          } else if (draft.status === 'draft') {
            clearInterval(interval);
            $('editor-status').textContent = 'DRAFT';
            $('editor-status').style.background = '#4a7aff';
            $('ai-output-content').innerHTML = '<p style="color:var(--red);">Rewrite failed. Check logs for details.</p>';
          }
        })
        .catch(function () { clearInterval(interval); });
    }, 3000);
    // Timeout after 2 minutes
    setTimeout(function () { clearInterval(interval); }, 120000);
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
      'Source Tiers': ['TIER1_SOURCES', 'TIER2_SOURCES', 'TIER3_SOURCES'],
      'Dashboard': ['PORT'],
    };

    var sensitiveKeys = {
      FIREHOSE_TOKEN: true,
      WP_APP_PASSWORD: true,
      DASHBOARD_PASSWORD: true,
      INFRANODUS_API_KEY: true,
    };

    var booleanKeys = {
      TRENDS_ENABLED: true,
      INFRANODUS_ENABLED: true,
      ALLOW_SAME_DOMAIN_CLUSTERS: true,
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
        fetchApi('/api/test/infranodus', { method: 'POST' })
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
        el = $('openai-model'); if (el) el.value = data.openaiModel || 'gpt-4o';
        el = $('openrouter-key');
        if (el && data.openrouterKey) el.placeholder = data.openrouterKey;
        el = $('openrouter-model'); if (el) el.value = data.openrouterModel || 'qwen/qwen3.6-plus:free';
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
    var apiKey = keyInput ? keyInput.value.trim() : '';

    if (!apiKey || apiKey.length < 10) {
      if (statusEl) { statusEl.textContent = 'Enter an API key first'; statusEl.style.color = '#f59e0b'; }
      return;
    }

    if (statusEl) { statusEl.textContent = 'Testing...'; statusEl.style.color = '#888'; }

    fetchApi('/api/ai/test', { method: 'POST', body: { provider: provider, apiKey: apiKey } })
      .then(function (data) {
        if (data.success) {
          if (statusEl) { statusEl.textContent = 'Key is valid! Response: ' + (data.response || 'OK'); statusEl.style.color = '#10b981'; }
        } else {
          if (statusEl) { statusEl.textContent = 'Invalid: ' + (data.error || 'Unknown error'); statusEl.style.color = '#ef4444'; }
        }
      })
      .catch(function (err) {
        if (statusEl) { statusEl.textContent = 'Test failed: ' + err.message; statusEl.style.color = '#ef4444'; }
      });
  }

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

  // ─── Init ───────────────────────────────────────────────────────────────

  function init() {
    initSidebar();
    initRouter();
    initEditorButtons();
    initWpDiagButtons();
  }

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
