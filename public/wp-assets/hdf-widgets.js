/**
 * HDF Price Widgets
 * Finds [data-hdf] elements in post content and hydrates them with live data.
 * Replace HDF_API_BASE with your Node.js app URL.
 */
(function () {
  'use strict';
  var API = (window.HDF_API_BASE || '') + '/api/public';

  function fmt(n, decimals) {
    decimals = decimals == null ? 2 : decimals;
    if (n == null || isNaN(n)) return '\u2014';
    return '\u20b9' + Number(n).toLocaleString('en-IN', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  }

  function timeAgo(iso) {
    if (!iso) return '';
    var diff = Date.now() - new Date(iso).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 2) return 'just now';
    if (mins < 60) return mins + 'm ago';
    return Math.floor(mins / 60) + 'h ago';
  }

  // ── Chart.js lazy-loader ────────────────────────────────────────────────
  // Loads Chart.js from CDN on first need; queues callbacks so multiple
  // charts on the same page don't race to inject duplicate script tags.
  var _chartJsReady = typeof Chart !== 'undefined';
  var _chartJsQueue = [];

  function requireChartJs(cb) {
    if (_chartJsReady) { cb(); return; }
    _chartJsQueue.push(cb);
    if (_chartJsQueue.length > 1) return; // already loading
    var s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js';
    s.onload = function () {
      _chartJsReady = true;
      _chartJsQueue.forEach(function (fn) { fn(); });
      _chartJsQueue = [];
    };
    s.onerror = function () {
      console.warn('HDF: failed to load Chart.js from CDN');
      _chartJsQueue = [];
    };
    document.head.appendChild(s);
  }

  function fetchData(endpoint, params) {
    var qs = Object.keys(params).filter(function(k) { return params[k] != null; }).map(function(k) {
      return encodeURIComponent(k) + '=' + encodeURIComponent(params[k]);
    }).join('&');
    var url = API + '/' + endpoint + '?' + qs;
    return fetch(url).then(function(res) {
      if (!res.ok) throw new Error(res.status);
      return res.json();
    }).then(function(json) {
      if (!json.ok) throw new Error('no data');
      return json.data;
    });
  }

  function renderTable(caption, headers, rows) {
    var ths = headers.map(function(h, i) {
      return '<th' + (i > 0 ? ' style="text-align:center"' : '') + '>' + h + '</th>';
    }).join('');
    var trs = rows.map(function(r) {
      return '<tr>' + r.map(function(c, i) {
        return '<td' + (i > 0 ? ' style="text-align:center"' : '') + '>' + (c == null ? '\u2014' : c) + '</td>';
      }).join('') + '</tr>';
    }).join('');
    return '<div class="hdf-table-wrap"><table class="hdf-table" role="table">' +
      '<caption>' + caption + '</caption>' +
      '<thead><tr>' + ths + '</tr></thead>' +
      '<tbody>' + trs + '</tbody>' +
      '</table></div>';
  }

  function renderHero(title, price, unit, pills, subtitle) {
    var pillsHtml = pills.map(function(p) {
      return '<span class="hdf-pill"><strong>' + p.value + '</strong> ' + p.label + '</span>';
    }).join('');
    return '<div class="hdf-hero">' +
      '<div class="hdf-hero-top">' +
      '<div><span class="hdf-live"><i></i>Live</span>' +
      '<div style="font-size:20px;font-weight:800;margin-top:10px;color:#fff">' + title + '</div>' +
      '<div class="hdf-hero-meta">' + subtitle + '</div></div>' +
      '<div><div class="hdf-hero-price">' + price + '</div>' +
      '<div class="hdf-hero-unit">' + unit + '</div></div>' +
      '</div>' +
      '<div class="hdf-hero-pills">' + pillsHtml + '</div>' +
      '</div>';
  }

  var widgets = {

    'price-box': function(el) {
      var mod = el.dataset.module;
      var city = el.dataset.city;
      var metal = el.dataset.metal;
      var fuel = el.dataset.fuel;
      return fetchData('price', { module: mod, city: city, metal: metal || fuel }).then(function(data) {
        var price, unit, state;
        if (mod === 'metals') {
          var p = metal === 'gold' ? data.price_24k : data.price_1g;
          price = fmt(p, 0);
          unit = 'per gram';
          state = data.state;
        } else {
          price = fmt(data.petrol);
          unit = 'petrol per litre';
          state = data.state;
        }
        var metalLabel = (metal || fuel || '').charAt(0).toUpperCase() + (metal || fuel || '').slice(1);
        var cityLabel = city.split(' ').map(function(w) { return w.charAt(0).toUpperCase() + w.slice(1); }).join(' ');
        var heroHtml = renderHero(
          metalLabel + ' Price in ' + cityLabel,
          price, unit,
          [{ value: price, label: unit }, { value: state || '', label: '' }],
          'Updated ' + timeAgo(data.price_date)
        );
        var deltaHtml = '';
        if (data.delta != null) {
          var d = data.delta;
          var pct = data.delta_pct != null ? ' (' + (d > 0 ? '+' : '') + data.delta_pct + '%)' : '';
          if (d > 0) deltaHtml = '<span class="hdf-delta up">\u25b2 \u20b9' + Math.abs(d).toFixed(2) + pct + ' from yesterday</span>';
          else if (d < 0) deltaHtml = '<span class="hdf-delta down">\u25bc \u20b9' + Math.abs(d).toFixed(2) + pct + ' from yesterday</span>';
          else deltaHtml = '<span class="hdf-delta flat">\u2192 No change from yesterday</span>';
        }
        var variantHtml = '';
        if (mod === 'metals' && metal === 'gold' && data.price_22k && data.price_18k) {
          variantHtml = '<div class="hdf-variant-pills">' +
            '<span class="hdf-variant-pill active">24K: ' + fmt(data.price_24k, 0) + '</span>' +
            '<span class="hdf-variant-pill">22K: ' + fmt(data.price_22k, 0) + '</span>' +
            '<span class="hdf-variant-pill">18K: ' + fmt(data.price_18k, 0) + '</span>' +
            '</div>';
        }
        el.innerHTML = heroHtml + deltaHtml + variantHtml;
      });
    },

    'price-table': function(el) {
      var mod = el.dataset.module;
      var state = el.dataset.state;
      var metal = el.dataset.metal;
      var today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
      return fetchData('state', { module: mod, state: state, metal: metal }).then(function(rows) {
        var headers, tableRows;
        if (mod === 'metals') {
          headers = ['City', (metal || 'Metal') + ' (per gram)', 'Date'];
          tableRows = rows.map(function(r) {
            var p = metal === 'gold' ? r.price_24k : r.price_1g;
            return [r.city_name, fmt(p, 0), r.price_date];
          });
        } else {
          headers = ['City', 'Petrol (\u20b9/L)', 'Diesel (\u20b9/L)'];
          tableRows = rows.map(function(r) {
            return [r.city, fmt(r.petrol), fmt(r.diesel)];
          });
        }
        el.innerHTML = renderTable((metal || 'Fuel') + ' Price in ' + state + ' \u2014 ' + today, headers, tableRows);
      });
    },

    'ranking': function(el) {
      var mod = el.dataset.module;
      var metal = el.dataset.metal;
      var fuel = el.dataset.fuel;
      var sort = el.dataset.sort || 'asc';
      var limit = el.dataset.limit || 10;
      var label = el.dataset.label;
      var today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
      return fetchData('ranking', { module: mod, metal: metal || fuel, fuel: fuel, sort: sort, limit: limit }).then(function(rows) {
        var isMetals = mod === 'metals';
        var headers = ['#', 'City', 'State', isMetals ? 'Price (per gram)' : 'Price (per litre)', ''];
        var tableRows = rows.map(function(r, i) {
          var price = isMetals ? fmt(r.price, 0) : fmt(r.price);
          var tag = i === 0
            ? '<span class="hdf-tag cheap">Lowest</span>'
            : (i === rows.length - 1 && sort === 'asc' ? '<span class="hdf-tag exp">Highest</span>' : '');
          return ['<span class="hdf-rank">' + (i + 1) + '</span>', r.city_name, r.state, '<span class="hdf-price-cell">' + price + '</span>', tag];
        });
        el.innerHTML = renderTable(
          label || ((sort === 'asc' ? 'Cheapest' : 'Most Expensive') + ' ' + (metal || fuel) + ' Cities \u2014 ' + today),
          headers, tableRows
        );
      });
    },

    'national': function(el) {
      var mod = el.dataset.module;
      var metal = el.dataset.metal;
      var today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
      return fetchData('national', { module: mod, metal: metal }).then(function(data) {
        if (mod === 'metals') {
          var avg = fmt(data.avg_price, 0);
          el.innerHTML = renderHero(
            (metal || 'Metal') + ' Price in India Today',
            avg, 'avg per gram',
            [
              { value: data.city_count || 0, label: 'cities' },
              { value: data.state_count || 0, label: 'states' },
              { value: fmt(data.min_price, 0), label: 'lowest' },
              { value: fmt(data.max_price, 0), label: 'highest' }
            ],
            today + ' \u00b7 Source: IBJA'
          );
        } else {
          el.innerHTML = renderHero(
            'Petrol & Diesel Price in India Today',
            fmt(data.petrol_avg), 'avg petrol/litre',
            [
              { value: fmt(data.petrol_avg), label: 'Petrol/L' },
              { value: fmt(data.diesel_avg), label: 'Diesel/L' },
              { value: data.city_count || 0, label: 'cities' }
            ],
            today + ' \u00b7 IOCL / HPCL / BPCL'
          );
        }
      });
    },

    'price-history': function(el) {
      var mod = el.dataset.module;
      var city = el.dataset.city;
      var metal = el.dataset.metal;
      var fuel = el.dataset.fuel;
      var days = el.dataset.days || 30;
      return fetchData('history', { module: mod, city: city, metal: metal || fuel, days: days }).then(function(rows) {
        if (!rows || !rows.length) return;
        var isMetals = mod === 'metals';
        var reversed = rows.slice().reverse();
        var headers, tableRows;
        if (isMetals) {
          headers = ['Date', 'Price (per gram)', 'Change'];
          tableRows = reversed.map(function(r, i) {
            var price = metal === 'gold' ? r.price_24k : r.price_1g;
            var prevRow = reversed[i + 1];
            var prev = prevRow ? (metal === 'gold' ? prevRow.price_24k : prevRow.price_1g) : null;
            var delta = (price && prev) ? price - prev : null;
            var badge = delta == null ? '\u2014'
              : delta > 0 ? '<span class="hdf-delta up">\u25b2 \u20b9' + Math.abs(delta).toFixed(2) + '</span>'
              : delta < 0 ? '<span class="hdf-delta down">\u25bc \u20b9' + Math.abs(delta).toFixed(2) + '</span>'
              : '<span class="hdf-delta flat">\u2192 No change</span>';
            return [r.price_date, fmt(price, 0), badge];
          });
        } else {
          headers = ['Date', 'Petrol (\u20b9/L)', 'Diesel (\u20b9/L)'];
          tableRows = reversed.map(function(r) {
            return [r.price_date, fmt(r.petrol), fmt(r.diesel)];
          });
        }
        el.innerHTML = renderTable((isMetals ? (metal || 'Metal') : 'Fuel') + ' Price History \u2014 Last ' + days + ' Days', headers, tableRows);
      });
    },

    'price-chart': function(el) {
      var mod = el.dataset.module;
      var city = el.dataset.city;
      var metal = el.dataset.metal;
      var fuel = el.dataset.fuel;
      var days = el.dataset.days || 30;
      return fetchData('history', { module: mod, city: city, metal: metal || fuel, days: days }).then(function(rows) {
        if (!rows || !rows.length) return;
        var isMetals = mod === 'metals';
        var labels = rows.map(function(r) { return r.price_date; });
        var dataPoints = isMetals
          ? rows.map(function(r) { return metal === 'gold' ? r.price_24k : r.price_1g; })
          : rows.map(function(r) { return r.petrol; });
        var canvas = document.createElement('canvas');
        var label = isMetals ? ((metal || 'Metal') + ' (\u20b9/g)') : 'Petrol (\u20b9/L)';
        el.innerHTML = '<div class="hdf-chart-wrap"><h3>' + label + ' trend \u2014 ' + city + ' (last ' + days + ' days)</h3></div>';
        el.querySelector('.hdf-chart-wrap').appendChild(canvas);
        requireChartJs(function () {
          new Chart(canvas, {
            type: 'line',
            data: {
              labels: labels,
              datasets: [{ label: label, data: dataPoints, borderColor: '#1d4ed8', backgroundColor: 'rgba(29,78,216,0.07)', borderWidth: 2, pointRadius: 2, fill: true, tension: 0.3 }]
            },
            options: {
              responsive: true,
              plugins: { legend: { display: false } },
              scales: {
                x: { ticks: { maxTicksLimit: 7, font: { size: 11 } } },
                y: { ticks: { font: { size: 11 } } }
              }
            }
          });
        });
      });
    },

    'fill-up': function(el) {
      var city = el.dataset.city || '';
      var petrol = parseFloat(el.dataset.petrol) || 0;
      var diesel = parseFloat(el.dataset.diesel) || 0;
      var tanks = [
        { name: 'Bike (12L)',         size: 12 },
        { name: 'Small Car (35L)',    size: 35 },
        { name: 'Mid-Size Car (45L)', size: 45 },
        { name: 'Large SUV (65L)',    size: 65 },
      ];
      var rows = tanks.map(function(t) {
        return [t.name,
          petrol ? '\u20b9' + (petrol * t.size).toFixed(2) : '\u2014',
          diesel ? '\u20b9' + (diesel * t.size).toFixed(2) : '\u2014'];
      });
      el.innerHTML = renderTable('Full Tank Fill-Up Cost in ' + city, ['Vehicle', 'Petrol Cost', 'Diesel Cost'], rows);
      return Promise.resolve();
    },

    'city-pills': function(el) {
      var mod = el.dataset.module;
      var state = el.dataset.state;
      var prefix = el.dataset.prefix || '';
      return fetchData('state-cities', { module: mod, state: state }).then(function(cities) {
        if (!cities || !cities.length) return;
        var links = cities.map(function(name) {
          var slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
          var href = prefix ? '/' + prefix + '-' + slug + '-today/' : '/' + slug + '/';
          return '<a href="' + href + '">' + name + '</a>';
        }).join('');
        el.innerHTML = '<div class="hdf-city-pills">' + links + '</div>';
      });
    },

    'cross-metal': function(el) {
      var city = el.dataset.city;
      return fetchData('cross-metal', { city: city }).then(function(data) {
        var metals = [
          { key: 'gold',     label: 'Gold',     price: data.gold     ? data.gold.price_24k : null, unit: '24K / gram' },
          { key: 'silver',   label: 'Silver',   price: data.silver   ? data.silver.price_1g : null, unit: 'per gram' },
          { key: 'platinum', label: 'Platinum', price: data.platinum ? data.platinum.price_1g : null, unit: 'per gram' },
        ];
        var cards = metals.map(function(m) {
          return '<div class="hdf-cross-metal-card">' +
            '<div class="hdf-cmc-label">' + m.label + '</div>' +
            '<div class="hdf-cmc-price">' + fmt(m.price, 0) + '</div>' +
            '<div class="hdf-cmc-unit">' + m.unit + '</div>' +
            '</div>';
        }).join('');
        el.innerHTML = '<div class="hdf-cross-metal">' + cards + '</div>';
      });
    }

  };

  function hydrate() {
    document.querySelectorAll('[data-hdf]').forEach(function(el) {
      var type = el.dataset.hdf;
      if (!widgets[type]) return;
      el.setAttribute('data-loading', '1');
      el.classList.add('hdf-widget');
      widgets[type](el).then(function() {
        el.removeAttribute('data-loading');
      }).catch(function(e) {
        console.warn('HDF widget error:', type, e.message);
        el.removeAttribute('data-loading');
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', hydrate);
  } else {
    hydrate();
  }
})();
