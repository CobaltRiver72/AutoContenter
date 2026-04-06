'use strict';

var express = require('express');
var path = require('path');
var { getConfig } = require('../utils/config');

/**
 * Create the dashboard router for login/logout and SPA serving.
 *
 * @returns {import('express').Router}
 */
function createDashboardRouter() {
  var router = express.Router();

  // ─── GET / — Serve SPA if authenticated ────────────────────────────────────

  router.get('/', function (req, res) {
    if (req.session && req.session.authenticated) {
      return res.sendFile(path.resolve(__dirname, '..', '..', 'public', 'index.html'));
    }
    return res.redirect('/login');
  });

  // ─── GET /login — Login page ──────────────────────────────────────────────

  router.get('/login', function (req, res) {
    var errorMsg = req.query.error === '1' ? 'Invalid password. Try again.' : '';

    var html = '<!DOCTYPE html>\n' +
      '<html lang="en">\n' +
      '<head>\n' +
      '  <meta charset="UTF-8">\n' +
      '  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
      '  <title>HDF AutoPub - Login</title>\n' +
      '  <style>\n' +
      '    * { margin: 0; padding: 0; box-sizing: border-box; }\n' +
      '    body {\n' +
      '      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;\n' +
      '      background: #0a0a0f;\n' +
      '      color: #e2e8f0;\n' +
      '      display: flex;\n' +
      '      align-items: center;\n' +
      '      justify-content: center;\n' +
      '      min-height: 100vh;\n' +
      '    }\n' +
      '    .login-card {\n' +
      '      background: #111118;\n' +
      '      border: 1px solid #1e1e2e;\n' +
      '      border-radius: 12px;\n' +
      '      padding: 40px;\n' +
      '      width: 100%;\n' +
      '      max-width: 380px;\n' +
      '      box-shadow: 0 8px 32px rgba(0,0,0,0.4);\n' +
      '    }\n' +
      '    .login-card h1 {\n' +
      '      font-size: 22px;\n' +
      '      font-weight: 600;\n' +
      '      text-align: center;\n' +
      '      margin-bottom: 6px;\n' +
      '      color: #f1f5f9;\n' +
      '    }\n' +
      '    .login-card .subtitle {\n' +
      '      text-align: center;\n' +
      '      color: #64748b;\n' +
      '      font-size: 14px;\n' +
      '      margin-bottom: 28px;\n' +
      '    }\n' +
      '    .login-card label {\n' +
      '      display: block;\n' +
      '      font-size: 13px;\n' +
      '      color: #94a3b8;\n' +
      '      margin-bottom: 6px;\n' +
      '      font-weight: 500;\n' +
      '    }\n' +
      '    .login-card input[type="password"] {\n' +
      '      width: 100%;\n' +
      '      padding: 10px 14px;\n' +
      '      background: #0a0a0f;\n' +
      '      border: 1px solid #2d2d3d;\n' +
      '      border-radius: 8px;\n' +
      '      color: #e2e8f0;\n' +
      '      font-size: 15px;\n' +
      '      outline: none;\n' +
      '      transition: border-color 0.2s;\n' +
      '    }\n' +
      '    .login-card input[type="password"]:focus {\n' +
      '      border-color: #3b82f6;\n' +
      '    }\n' +
      '    .login-card button {\n' +
      '      width: 100%;\n' +
      '      margin-top: 20px;\n' +
      '      padding: 10px 0;\n' +
      '      background: #3b82f6;\n' +
      '      color: #fff;\n' +
      '      border: none;\n' +
      '      border-radius: 8px;\n' +
      '      font-size: 15px;\n' +
      '      font-weight: 500;\n' +
      '      cursor: pointer;\n' +
      '      transition: background 0.2s;\n' +
      '    }\n' +
      '    .login-card button:hover {\n' +
      '      background: #2563eb;\n' +
      '    }\n' +
      '    .error-msg {\n' +
      '      background: #451a1a;\n' +
      '      color: #fca5a5;\n' +
      '      border: 1px solid #7f1d1d;\n' +
      '      border-radius: 6px;\n' +
      '      padding: 8px 12px;\n' +
      '      font-size: 13px;\n' +
      '      margin-bottom: 16px;\n' +
      '      text-align: center;\n' +
      '    }\n' +
      '  </style>\n' +
      '</head>\n' +
      '<body>\n' +
      '  <div class="login-card">\n' +
      '    <h1>HDF AutoPub</h1>\n' +
      '    <p class="subtitle">News Auto-Publisher Dashboard</p>\n' +
      (errorMsg ? '    <div class="error-msg">' + errorMsg + '</div>\n' : '') +
      '    <form method="POST" action="/login">\n' +
      '      <label for="password">Dashboard Password</label>\n' +
      '      <input type="password" id="password" name="password" placeholder="Enter password" autofocus required>\n' +
      '      <button type="submit">Sign In</button>\n' +
      '    </form>\n' +
      '  </div>\n' +
      '</body>\n' +
      '</html>';

    res.type('html').send(html);
  });

  // ─── POST /login — Validate password ──────────────────────────────────────

  router.post('/login', express.urlencoded({ extended: false }), function (req, res) {
    var { verifyPassword } = require('./auth');
    var password = req.body.password || '';

    if (password && verifyPassword(password)) {
      req.session.authenticated = true;
      return res.redirect('/');
    }

    return res.redirect('/login?error=1');
  });

  // ─── GET /logout — Destroy session ────────────────────────────────────────

  router.get('/logout', function (req, res) {
    if (req.session) {
      req.session.destroy(function () {
        res.redirect('/login');
      });
    } else {
      res.redirect('/login');
    }
  });

  return router;
}

module.exports = createDashboardRouter;
