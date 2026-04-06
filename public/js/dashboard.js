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
    state.currentPage = page;

    // Update nav
    var links = $$('.nav-link[data-page]');
    for (var i = 0; i < links.length; i++) {
      links[i].classList.toggle('active', links[i].getAttribute('data-page') === page);
    }

    // Show/hide pages
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
      case 'settings': loadSettings(); break;
      case 'logs': loadLogs(); break;
    }

    // Close sidebar on mobile
    var sidebar = $('sidebar');
    if (sidebar) sidebar.classList.remove('open');
  }

  function initRouter() {
    var hash = window.location.hash.slice(1) || 'overview';
    navigateTo(hash);

    window.addEventListener('hashchange', function () {
      var hash = window.location.hash.slice(1) || 'overview';
      navigateTo(hash);
    });
  }

  // ─── Mobile Sidebar ────────────────────────────────────────────────────

  function initSidebar() {
    var hamburger = $('hamburger');
    var sidebarClose = $('sidebarClose');
    var sidebar = $('sidebar');

    if (hamburger) {
      hamburger.addEventListener('click', function () {
        sidebar.classList.toggle('open');
      });
    }

    if (sidebarClose) {
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
        } catch (err) {
          // Ignore parse errors
        }
      });

      state.sseConnection.addEventListener('article', function (e) {
        if (state.ssePaused) return;

        try {
          var article = JSON.parse(e.data);
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
      };
    }

    // Render feed filters
    renderFeedFilters();

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
        }
      })
      .catch(function () { /* silent */ });
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
      '</select>';

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

  function renderArticleCard(container, article, prepend) {
    var card = document.createElement('div');
    card.className = 'article-card';

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

    // Content preview
    var previewHtml = '';
    var fullContentHtml = '';
    if (article.content_markdown) {
      var stripped = stripMarkdown(article.content_markdown);
      var previewText = truncate(stripped, 200);
      previewHtml = '<div class="article-preview">' + escapeHtml(previewText) + '</div>';
      if (stripped.length > 200) {
        fullContentHtml = '<div class="article-full">' + escapeHtml(stripped) + '</div>';
      }
    }

    card.innerHTML =
      '<div class="article-card-top">' +
        '<div class="article-card-content">' +
          '<div class="article-title">' +
            '<a href="' + escapeHtml(article.url || '#') + '" target="_blank" rel="noopener">' +
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
        '<button class="article-select-btn" data-article-url="' + escapeHtml(article.url || '') + '">Select &#9654;</button>' +
      '</div>' +
      previewHtml +
      fullContentHtml;

    // Add select button click handler
    var selectBtn = card.querySelector('.article-select-btn');
    if (selectBtn) {
      selectBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        selectArticle(article, e.target);
      });
    }

    // Add expand button if there is full content
    if (fullContentHtml) {
      var expandBtn = document.createElement('button');
      expandBtn.className = 'expand-btn';
      expandBtn.textContent = 'Show more';
      expandBtn.addEventListener('click', function () {
        var fullDiv = card.querySelector('.article-full');
        if (fullDiv) {
          var isOpen = fullDiv.classList.contains('open');
          fullDiv.classList.toggle('open');
          expandBtn.textContent = isOpen ? 'Show more' : 'Show less';
        }
      });
      card.appendChild(expandBtn);
    }

    if (prepend) {
      container.insertBefore(card, container.firstChild);
    } else {
      container.appendChild(card);
    }
  }

  // ─── Select Article (Manual Draft) ──────────────────────────────────────

  function selectArticle(articleData, btn) {
    fetchApi('/api/drafts', {
      method: 'POST',
      body: {
        article_id: articleData.id || null,
        url: articleData.url,
        domain: articleData.domain,
        title: articleData.title,
        content_markdown: articleData.content_markdown || '',
        language: articleData.language,
        page_category: Array.isArray(articleData.page_category) ? articleData.page_category.join(', ') : (articleData.page_category || ''),
        publish_time: articleData.publish_time,
      }
    })
      .then(function (result) {
        if (result.success) {
          showToast('Draft created — fetching content...', 'success');
          if (btn) {
            btn.textContent = '\u2713 Selected';
            btn.classList.add('selected');
          }
          setTimeout(function () { navigateTo('published'); }, 1000);
        } else {
          showToast('Failed: ' + (result.error || result.message || 'Unknown error'), 'error');
        }
      })
      .catch(function (err) {
        showToast('Network error: ' + err.message, 'error');
      });
  }

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

    if (container) container.innerHTML = '<p class="placeholder-text">Loading...</p>';

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
      container.innerHTML = '<p class="placeholder-text">No clusters found</p>';
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
      .then(function () {
        showToast('Cluster #' + id + ' queued for publishing', 'success');
        loadClusters();
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
          '<div class="feed-empty-title">No drafts yet</div>' +
          '<div class="feed-empty-desc">Go to <a href="#feed">Live Feed</a> and click "Select" on an article to create a draft.</div>' +
        '</div>';
      return;
    }

    // Status filter tabs
    var counts = { all: drafts.length, fetching: 0, draft: 0, rewriting: 0, ready: 0, published: 0 };
    for (var c = 0; c < drafts.length; c++) {
      var st = drafts[c].status;
      if (counts[st] !== undefined) counts[st]++;
    }

    var filterHTML =
      '<div class="status-filters">' +
        '<button class="filter-btn active" data-filter="all">All (' + counts.all + ')</button>' +
        '<button class="filter-btn" data-filter="fetching">Fetching (' + counts.fetching + ')</button>' +
        '<button class="filter-btn" data-filter="draft">Draft (' + counts.draft + ')</button>' +
        '<button class="filter-btn" data-filter="rewriting">Rewriting (' + counts.rewriting + ')</button>' +
        '<button class="filter-btn" data-filter="ready">Ready (' + counts.ready + ')</button>' +
        '<button class="filter-btn" data-filter="published">Published (' + counts.published + ')</button>' +
      '</div>';

    var cardsHTML = '';
    for (var i = 0; i < drafts.length; i++) {
      cardsHTML += renderDraftCard(drafts[i]);
    }

    container.innerHTML = filterHTML + '<div class="drafts-list">' + cardsHTML + '</div>';

    // Attach filter listeners
    var filterBtns = container.querySelectorAll('.filter-btn');
    for (var f = 0; f < filterBtns.length; f++) {
      filterBtns[f].addEventListener('click', function () {
        var filter = this.getAttribute('data-filter');
        // Toggle active
        var siblings = container.querySelectorAll('.filter-btn');
        for (var s = 0; s < siblings.length; s++) siblings[s].classList.remove('active');
        this.classList.add('active');
        // Show/hide cards
        var cards = container.querySelectorAll('.draft-card');
        for (var d = 0; d < cards.length; d++) {
          if (filter === 'all' || cards[d].getAttribute('data-status') === filter) {
            cards[d].style.display = '';
          } else {
            cards[d].style.display = 'none';
          }
        }
      });
    }
  }

  function renderDraftCard(draft) {
    var statusColors = {
      fetching: '#f59e0b', draft: '#4a7aff', editing: '#8b5cf6',
      rewriting: '#a855f7', ready: '#22c55e', published: '#6b7280'
    };
    var statusColor = statusColors[draft.status] || '#6b7280';
    var isPulsing = draft.status === 'fetching' || draft.status === 'rewriting';
    var contentPreview = (draft.extracted_content || draft.source_content_markdown || '').substring(0, 200);

    var actionsHTML = '';

    if (draft.status === 'fetching') {
      actionsHTML += '<button class="btn btn-sm btn-secondary" onclick="window.__retryExtract(' + draft.id + ')">&#8635; Retry</button>';
    }
    if (draft.status === 'draft' || draft.status === 'editing' || draft.status === 'ready') {
      actionsHTML += '<button class="btn btn-sm btn-primary" onclick="window.__openEditor(' + draft.id + ')">&#9998; Edit Draft</button>';
    }
    if (draft.status === 'draft') {
      actionsHTML += '<button class="btn btn-sm btn-purple" onclick="window.__triggerRewrite(' + draft.id + ')">&#129302; Rewrite</button>';
    }
    if (draft.status === 'rewriting') {
      actionsHTML += '<button class="btn btn-sm btn-secondary" disabled>&#9203; Rewriting...</button>';
    }
    if (draft.status === 'ready') {
      actionsHTML += '<button class="btn btn-sm btn-secondary" onclick="window.__previewDraftHTML(' + draft.id + ')">&#128065; Preview</button>';
      actionsHTML += '<button class="btn btn-sm btn-secondary" onclick="window.__downloadDraftHTML(' + draft.id + ')">&#11015; Download</button>';
      actionsHTML += '<button class="btn btn-sm btn-green" onclick="window.__openEditor(' + draft.id + ')">&#128640; Publish</button>';
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
          '<span class="draft-mode">' + (draft.mode === 'auto' ? '&#129302; Auto' : '&#128100; Manual') + '</span>' +
          '<span class="draft-time">' + formatTime(draft.created_at) + '</span>' +
        '</div>' +
        '<h3 class="draft-title">' + escapeHtml(draft.extracted_title || draft.source_title || draft.source_url) + '</h3>' +
        '<div class="draft-meta">' +
          '<span class="domain-badge">' + escapeHtml(draft.source_domain || '--') + '</span>' +
          (draft.source_language ? '<span class="domain-badge">' + escapeHtml(draft.source_language.toUpperCase()) + '</span>' : '') +
          (draft.target_keyword ? '<span class="domain-badge" style="color:var(--green)">&#127919; ' + escapeHtml(draft.target_keyword) + '</span>' : '') +
          (draft.extraction_status === 'success' ? '<span style="color:var(--green);font-size:11px">&#9989; ' + (draft.extracted_content || '').length + ' chars</span>' : '') +
          (draft.extraction_status === 'failed' ? '<span style="color:var(--red);font-size:11px">&#10060; Extract failed</span>' : '') +
        '</div>' +
        (contentPreview ? '<p class="draft-preview">' + escapeHtml(truncate(contentPreview, 200)) + '</p>' : '') +
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

  window.__previewDraftHTML = function (id) {
    fetchApi('/api/drafts/' + id)
      .then(function (data) {
        var draft = data.data;
        if (draft && draft.rewritten_html) {
          var win = window.open('', '_blank');
          win.document.write(draft.rewritten_html);
          win.document.close();
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
      fetchApi('/api/drafts')
        .then(function (data) {
          var drafts = data.data || [];
          for (var i = 0; i < drafts.length; i++) {
            var card = document.querySelector('.draft-card[data-id="' + drafts[i].id + '"]');
            if (card && card.getAttribute('data-status') !== drafts[i].status) {
              card.outerHTML = renderDraftCard(drafts[i]);
            }
          }
          var inProgress = drafts.some(function (d) {
            return d.status === 'fetching' || d.status === 'rewriting';
          });
          if (!inProgress) {
            clearInterval(publishedPollInterval);
            publishedPollInterval = null;
          }
        })
        .catch(function () { /* silent */ });
    }, 3000);
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
        $('editor-title').textContent = 'Draft Editor \u2014 ' + (draft.extracted_title || draft.source_title || 'Untitled');
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

        // Settings tab
        $('setting-keyword').value = draft.target_keyword || '';
        $('setting-domain').value = draft.target_domain || '';
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
        $('editor-status').textContent = 'REWRITING...';
        $('editor-status').style.background = '#a855f7';
        $('ai-output-content').innerHTML = '<p style="color:#a855f7;">&#129302; AI is rewriting... This may take 30-60 seconds.</p>';

        fetchApi('/api/drafts/' + currentDraftId + '/rewrite', {
          method: 'POST',
          body: { custom_prompt: customPrompt }
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
              navigator.clipboard.writeText(data.xml).then(function () {
                showToast('Blogger XML copied to clipboard!', 'success');
              });
            } else {
              navigator.clipboard.writeText(html).then(function () {
                showToast('HTML copied (Blogger conversion not available)', 'info');
              });
            }
          })
          .catch(function () {
            navigator.clipboard.writeText(html).then(function () {
              showToast('HTML copied to clipboard', 'info');
            });
          });
      };
    }

    var previewTabBtn = $('editorPreviewTabBtn');
    if (previewTabBtn) {
      previewTabBtn.onclick = function () {
        var html = $('html-code-editor').value;
        if (!html) { showToast('No HTML to preview', 'error'); return; }
        var win = window.open('', '_blank');
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

        fetchApi('/api/drafts/' + currentDraftId + '/publish', {
          method: 'POST',
          body: { platform: platform, html: html }
        })
          .then(function (data) {
            if (data.success) {
              $('editor-status').textContent = 'PUBLISHED';
              $('editor-status').style.background = '#22c55e';
              showToast('Published!' + (data.url ? ' URL: ' + data.url : ''), 'success');
            } else {
              showToast('Publish failed: ' + (data.error || 'Unknown'), 'error');
              $('editor-status').textContent = 'READY';
              $('editor-status').style.background = '#22c55e';
            }
          })
          .catch(function (err) {
            showToast('Publish error: ' + err.message, 'error');
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
      }
    });
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
        .catch(function () { /* silent */ });
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
          updates[key] = val;
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
  }

  function renderSettingsForm(container, settings, config) {
    if (!container) return;

    var groups = {
      'Firehose': ['FIREHOSE_TOKEN'],
      'AI Models': ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'AI_PRIMARY_MODEL', 'AI_FALLBACK_MODEL'],
      'WordPress': ['WP_URL', 'WP_USERNAME', 'WP_APP_PASSWORD', 'WP_AUTHOR_ID', 'WP_DEFAULT_CATEGORY', 'WP_POST_STATUS'],
      'Pipeline': ['MIN_SOURCES_THRESHOLD', 'SIMILARITY_THRESHOLD', 'BUFFER_HOURS', 'MAX_PUBLISH_PER_HOUR', 'PUBLISH_COOLDOWN_MINUTES'],
      'Google Trends': ['TRENDS_ENABLED', 'TRENDS_GEO', 'TRENDS_POLL_MINUTES'],
      'InfraNodus': ['INFRANODUS_ENABLED', 'INFRANODUS_API_KEY'],
      'Source Tiers': ['TIER1_SOURCES', 'TIER2_SOURCES', 'TIER3_SOURCES'],
      'Dashboard': ['DASHBOARD_PASSWORD', 'PORT'],
    };

    var sensitiveKeys = {
      FIREHOSE_TOKEN: true,
      ANTHROPIC_API_KEY: true,
      OPENAI_API_KEY: true,
      WP_APP_PASSWORD: true,
      DASHBOARD_PASSWORD: true,
      INFRANODUS_API_KEY: true,
    };

    var booleanKeys = {
      TRENDS_ENABLED: true,
      INFRANODUS_ENABLED: true,
    };

    var html = '';

    var groupNames = Object.keys(groups);
    for (var g = 0; g < groupNames.length; g++) {
      var groupName = groupNames[g];
      var keys = groups[groupName];

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
          });
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

    // Filters
    if (moduleFilter) {
      moduleFilter.onchange = function () {
        state.logsPage = 1;
        loadLogs();
      };
    }
    if (levelFilter) {
      levelFilter.onchange = function () {
        state.logsPage = 1;
        loadLogs();
      };
    }

    // Auto-refresh every 10s
    clearPageTimers();
    state.refreshTimers.push(setInterval(function () {
      if (state.currentPage === 'logs') loadLogs();
    }, 10000));
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
  }

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
