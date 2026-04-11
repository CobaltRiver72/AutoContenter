'use strict';

var express = require('express');
var cors = require('cors');
var router = express.Router();

var publicCors = cors({ origin: '*', methods: ['GET'] });
router.use(publicCors);

module.exports = function(db) {

  // GET /api/public/price?module=fuel&city=Mumbai
  // GET /api/public/price?module=metals&city=Mumbai&metal=gold
  router.get('/price', function(req, res) {
    var mod = req.query.module;
    var city = req.query.city;
    var metal = req.query.metal;
    if (!city) return res.json({ ok: false, error: 'city required' });
    try {
      var row, yesterday, delta = null, delta_pct = null;
      if (mod === 'metals' && metal) {
        row = db.prepare(
          'SELECT mp.city, mc.state, mp.metal_type, mp.price_24k, mp.price_22k, mp.price_18k, mp.price_1g, mp.price_date ' +
          'FROM metals_prices mp ' +
          'JOIN metals_cities mc ON mp.city = mc.city_name ' +
          'WHERE mp.city = ? AND mp.metal_type = ? AND mp.price_date = date(\'now\', \'localtime\') ' +
          'ORDER BY mp.price_date DESC LIMIT 1'
        ).get(city, metal);
        yesterday = db.prepare(
          'SELECT price_24k, price_1g FROM metals_prices ' +
          'WHERE city = ? AND metal_type = ? AND price_date = date(\'now\', \'-1 day\', \'localtime\') LIMIT 1'
        ).get(city, metal);
        if (row && yesterday) {
          var tp = metal === 'gold' ? row.price_24k : row.price_1g;
          var yp = metal === 'gold' ? yesterday.price_24k : yesterday.price_1g;
          if (tp && yp) {
            delta = Math.round((tp - yp) * 100) / 100;
            delta_pct = Math.round((delta / yp) * 10000) / 100;
          }
        }
      } else if (mod === 'fuel') {
        row = db.prepare(
          'SELECT fp.city, fp.state, fp.petrol, fp.diesel, fp.price_date ' +
          'FROM fuel_prices fp ' +
          'WHERE fp.city = ? AND fp.price_date = date(\'now\', \'localtime\') ' +
          'LIMIT 1'
        ).get(city);
        yesterday = db.prepare(
          'SELECT petrol, diesel FROM fuel_prices ' +
          'WHERE city = ? AND price_date = date(\'now\', \'-1 day\', \'localtime\') LIMIT 1'
        ).get(city);
        if (row && yesterday) {
          var tp2 = row.petrol, yp2 = yesterday.petrol;
          if (tp2 && yp2) {
            delta = Math.round((tp2 - yp2) * 100) / 100;
            delta_pct = Math.round((delta / yp2) * 10000) / 100;
          }
        }
      }
      if (!row) return res.json({ ok: false, data: null });
      res.json({ ok: true, data: Object.assign({}, row, { delta: delta, delta_pct: delta_pct }), ts: Date.now() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/public/state?module=metals&state=Maharashtra&metal=gold
  // GET /api/public/state?module=fuel&state=Maharashtra
  router.get('/state', function(req, res) {
    var mod = req.query.module;
    var state = req.query.state;
    var metal = req.query.metal;
    if (!state) return res.json({ ok: false, error: 'state required' });
    try {
      var rows;
      if (mod === 'metals' && metal) {
        rows = db.prepare(
          'SELECT mp.city AS city_name, mc.state, mp.metal_type, mp.price_24k, mp.price_22k, mp.price_18k, mp.price_1g, mp.price_date ' +
          'FROM metals_prices mp ' +
          'JOIN metals_cities mc ON mp.city = mc.city_name ' +
          'WHERE mc.state = ? AND mp.metal_type = ? AND mp.price_date = date(\'now\', \'localtime\') ' +
          'ORDER BY mp.city ASC'
        ).all(state, metal);
      } else if (mod === 'fuel') {
        rows = db.prepare(
          'SELECT fp.city, fp.state, fp.petrol, fp.diesel, fp.price_date ' +
          'FROM fuel_prices fp ' +
          'WHERE fp.state = ? AND fp.price_date = date(\'now\', \'localtime\') ' +
          'ORDER BY fp.city ASC'
        ).all(state);
      }
      res.json({ ok: true, data: rows || [], ts: Date.now() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/public/ranking?module=metals&metal=gold&sort=asc&limit=10
  // GET /api/public/ranking?module=fuel&fuel=petrol&sort=asc&limit=10
  router.get('/ranking', function(req, res) {
    var mod = req.query.module;
    var metal = req.query.metal;
    var fuel = req.query.fuel || 'petrol';
    var sort = req.query.sort === 'desc' ? 'DESC' : 'ASC';
    var limit = Math.min(parseInt(req.query.limit) || 10, 50);
    try {
      var rows;
      if (mod === 'metals' && metal) {
        var priceCol = metal === 'gold' ? 'mp.price_24k' : 'mp.price_1g';
        rows = db.prepare(
          'SELECT mp.city AS city_name, mc.state, ' + priceCol + ' AS price, mp.price_date ' +
          'FROM metals_prices mp ' +
          'JOIN metals_cities mc ON mp.city = mc.city_name ' +
          'WHERE mp.metal_type = ? AND mp.price_date = date(\'now\', \'localtime\') ' +
          'AND ' + priceCol + ' > 0 ' +
          'ORDER BY ' + priceCol + ' ' + sort + ' LIMIT ?'
        ).all(metal, limit);
      } else if (mod === 'fuel') {
        var fuelCol = fuel === 'diesel' ? 'fp.diesel' : 'fp.petrol';
        rows = db.prepare(
          'SELECT fp.city AS city_name, fp.state, ' + fuelCol + ' AS price, fp.price_date ' +
          'FROM fuel_prices fp ' +
          'JOIN fuel_cities fc ON fp.city = fc.city_name ' +
          'WHERE fp.price_date = date(\'now\', \'localtime\') ' +
          'AND ' + fuelCol + ' > 0 AND fc.is_enabled = 1 ' +
          'ORDER BY ' + fuelCol + ' ' + sort + ' LIMIT ?'
        ).all(limit);
      }
      res.json({ ok: true, data: rows || [], ts: Date.now() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/public/national?module=metals&metal=gold
  // GET /api/public/national?module=fuel
  router.get('/national', function(req, res) {
    var mod = req.query.module;
    var metal = req.query.metal;
    try {
      var summary;
      if (mod === 'metals' && metal) {
        var priceCol = metal === 'gold' ? 'price_24k' : 'price_1g';
        summary = db.prepare(
          'SELECT AVG(' + priceCol + ') AS avg_price, ' +
          'MIN(' + priceCol + ') AS min_price, ' +
          'MAX(' + priceCol + ') AS max_price, ' +
          'COUNT(DISTINCT city) AS city_count, ' +
          '(SELECT COUNT(DISTINCT state) FROM metals_cities WHERE is_active = 1) AS state_count, ' +
          'MAX(price_date) AS last_updated ' +
          'FROM metals_prices ' +
          'WHERE metal_type = ? AND price_date = date(\'now\', \'localtime\') AND ' + priceCol + ' > 0'
        ).get(metal);
      } else if (mod === 'fuel') {
        var petrol = db.prepare(
          'SELECT AVG(petrol) AS petrol_avg, MIN(petrol) AS min_price, MAX(petrol) AS max_price, ' +
          'COUNT(DISTINCT city) AS city_count, MAX(price_date) AS last_updated ' +
          'FROM fuel_prices WHERE price_date = date(\'now\', \'localtime\') AND petrol > 0'
        ).get();
        var diesel = db.prepare(
          'SELECT AVG(diesel) AS diesel_avg FROM fuel_prices ' +
          'WHERE price_date = date(\'now\', \'localtime\') AND diesel > 0'
        ).get();
        summary = {
          petrol_avg: petrol ? petrol.petrol_avg : null,
          diesel_avg: diesel ? diesel.diesel_avg : null,
          city_count: petrol ? petrol.city_count : 0,
          min_price: petrol ? petrol.min_price : null,
          max_price: petrol ? petrol.max_price : null,
          last_updated: petrol ? petrol.last_updated : null,
        };
      }
      res.json({ ok: true, data: summary || {}, ts: Date.now() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/public/history?module=metals&city=Mumbai&metal=gold&days=30
  // GET /api/public/history?module=fuel&city=Mumbai&days=30
  router.get('/history', function(req, res) {
    var mod = req.query.module;
    var city = req.query.city;
    var metal = req.query.metal;
    var days = Math.min(parseInt(req.query.days) || 30, 90);
    if (!city) return res.json({ ok: false, error: 'city required' });
    try {
      var rows;
      if (mod === 'metals' && metal) {
        rows = db.prepare(
          'SELECT price_date, price_24k, price_22k, price_18k, price_1g ' +
          'FROM metals_prices ' +
          'WHERE city = ? AND metal_type = ? AND price_date >= date(\'now\', \'-' + days + ' days\', \'localtime\') ' +
          'ORDER BY price_date ASC'
        ).all(city, metal);
      } else if (mod === 'fuel') {
        rows = db.prepare(
          'SELECT price_date, petrol, diesel ' +
          'FROM fuel_prices ' +
          'WHERE city = ? AND price_date >= date(\'now\', \'-' + days + ' days\', \'localtime\') ' +
          'ORDER BY price_date ASC'
        ).all(city);
      }
      res.json({ ok: true, data: rows || [], ts: Date.now() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/public/cross-metal?city=Mumbai
  router.get('/cross-metal', function(req, res) {
    var city = req.query.city;
    if (!city) return res.json({ ok: false, error: 'city required' });
    try {
      var today = "date('now', 'localtime')";
      var result = {};
      var metals = ['gold', 'silver', 'platinum'];
      for (var i = 0; i < metals.length; i++) {
        var m = metals[i];
        var row = db.prepare(
          'SELECT price_24k, price_22k, price_18k, price_1g, price_date ' +
          'FROM metals_prices WHERE city = ? AND metal_type = ? AND price_date = date(\'now\', \'localtime\') LIMIT 1'
        ).get(city, m);
        if (row) result[m] = row;
      }
      res.json({ ok: true, data: result, ts: Date.now() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  // GET /api/public/state-cities?state=Maharashtra&module=metals&metal=gold
  // GET /api/public/state-cities?state=Maharashtra&module=fuel
  router.get('/state-cities', function(req, res) {
    var mod = req.query.module;
    var state = req.query.state;
    var metal = req.query.metal;
    if (!state) return res.json({ ok: false, error: 'state required' });
    try {
      var rows;
      if (mod === 'metals') {
        rows = db.prepare(
          'SELECT city_name FROM metals_cities WHERE state = ? AND is_active = 1 ORDER BY city_name ASC'
        ).all(state);
      } else if (mod === 'fuel') {
        rows = db.prepare(
          'SELECT city_name FROM fuel_cities WHERE state = ? AND is_enabled = 1 ORDER BY city_name ASC'
        ).all(state);
      }
      res.json({ ok: true, data: (rows || []).map(function(r) { return r.city_name; }), ts: Date.now() });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });

  return router;
};
