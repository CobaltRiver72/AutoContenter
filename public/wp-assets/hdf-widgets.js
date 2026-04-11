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
        el.innerHTML = renderHero(
          (metal || fuel) + ' price in ' + city,
          price, unit,
          [{ value: price, label: unit }, { value: state || '', label: '' }],
          'Updated ' + timeAgo(data.price_date)
        );
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
