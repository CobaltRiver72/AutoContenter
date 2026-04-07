'use strict';

var session = require('express-session');
var bcrypt = require('bcryptjs');
var { getConfig } = require('../utils/config');

// In-memory reference to db (set via setupSession)
var _db = null;

/**
 * Configure express-session middleware.
 *
 * @param {object} [db] - Optional SQLite db instance for password hashing
 * @returns {import('express').RequestHandler} session middleware
 */
function setupSession(db) {
  var config = getConfig();
  var crypto = require('crypto');
  _db = db || null;

  // Generate or load a persistent session secret (NOT the dashboard password)
  var secret = null;

  if (_db) {
    try {
      var row = _db.prepare("SELECT value FROM settings WHERE key = 'SESSION_SECRET'").get();
      if (row && row.value) {
        secret = row.value;
      } else {
        secret = crypto.randomBytes(32).toString('hex');
        _db.prepare(
          "INSERT INTO settings (key, value, updated_at) VALUES ('SESSION_SECRET', ?, datetime('now')) " +
          "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
        ).run(secret);
      }
    } catch (e) {
      // Fall through to hash-based secret
    }
  }

  if (!secret) {
    secret = crypto.createHash('sha256')
      .update((config.DASHBOARD_PASSWORD || 'hdf-autopub') + __dirname + (process.env.HOME || ''))
      .digest('hex');
  }

  return session({
    secret: secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      httpOnly: true,
      secure: 'auto',
      sameSite: 'strict',
    },
  });
}

/**
 * Auth middleware.
 * If authenticated, calls next().
 * For HTML requests, redirects to /login.
 * For API/JSON requests, returns 401.
 */
function checkAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  }

  var acceptHeader = req.headers.accept || '';
  if (acceptHeader.indexOf('text/html') !== -1) {
    return res.redirect('/login');
  }

  return res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Verify a password against the stored bcrypt hash.
 * On first use, hashes the DASHBOARD_PASSWORD env var and stores it.
 *
 * @param {string} password - The submitted password
 * @returns {boolean}
 */
function verifyPassword(password) {
  var config = getConfig();
  var storedHash = null;

  // Try to get stored hash from SQLite
  if (_db) {
    try {
      var row = _db.prepare("SELECT value FROM settings WHERE key = 'DASHBOARD_PASSWORD_HASH'").get();
      if (row) storedHash = row.value;
    } catch (err) {
      // Fall through
    }
  }

  if (storedHash) {
    // Compare against stored bcrypt hash
    return bcrypt.compareSync(password, storedHash);
  }

  // No hash stored yet — compare against plain config password
  var configPassword = config.DASHBOARD_PASSWORD;
  if (!configPassword) return false;

  var matches = password === configPassword;

  // If match, hash and store for future use
  if (matches && _db) {
    try {
      var hash = bcrypt.hashSync(password, 10);
      _db.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES ('DASHBOARD_PASSWORD_HASH', ?, datetime('now')) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
      ).run(hash);
    } catch (err) {
      // Non-critical — will hash on next login
    }
  }

  return matches;
}

/**
 * Change the dashboard password.
 *
 * @param {string} currentPassword
 * @param {string} newPassword
 * @returns {{ success: boolean, error?: string }}
 */
function changePassword(currentPassword, newPassword) {
  if (!currentPassword || !newPassword) {
    return { success: false, error: 'Both current and new passwords are required' };
  }
  if (newPassword.length < 6) {
    return { success: false, error: 'New password must be at least 6 characters' };
  }
  if (!verifyPassword(currentPassword)) {
    return { success: false, error: 'Current password is incorrect' };
  }

  var hash = bcrypt.hashSync(newPassword, 10);
  if (_db) {
    _db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('DASHBOARD_PASSWORD_HASH', ?, datetime('now')) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
    ).run(hash);
  }

  return { success: true };
}

module.exports = {
  setupSession: setupSession,
  checkAuth: checkAuth,
  verifyPassword: verifyPassword,
  changePassword: changePassword,
};
