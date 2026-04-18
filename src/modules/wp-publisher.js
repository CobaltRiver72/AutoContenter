'use strict';

const MODULE = 'wp-publisher';

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

class WPPublisher {
  /**
   * @param {object} config
   * @param {import('better-sqlite3').Database} db
   * @param {object} logger
   */
  constructor(config, db, logger, siteId, siteCredentials) {
    this.config = config;
    this.db = db;
    this.siteId = siteId || 1;
    // Per-site log tagging.
    this.logger = (logger && typeof logger.forSite === 'function')
      ? logger.forSite(this.siteId)
      : logger;
    this._siteCredentials = siteCredentials || null;
    this.siteUrl = null;
    this.username = null;
    this.appPassword = null;
    this.categoryCache = {};
    this.postCache = {};
    this.ready = false;
  }

  /**
   * Read WP credentials from settings table and pre-load category cache.
   */
  async init() {
    try {
      // Read from settings table, falling back to env-based config
      const { getConfig } = require('../utils/config');
      const envConfig = getConfig();
      const getVal = (key, alias) => {
        const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
        if (row && row.value) return row.value;
        if (alias) {
          const aliasRow = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(alias);
          if (aliasRow && aliasRow.value) return aliasRow.value;
        }
        return envConfig[key] || (alias ? envConfig[alias] : null) || null;
      };

      // WP_SITE_URL (dashboard key) and WP_URL (env key) are aliases
      var creds = this._siteCredentials || {};
      this.siteUrl = creds.wp_url || getVal('WP_SITE_URL', 'WP_URL');
      this.username = creds.wp_username || getVal('WP_USERNAME');
      this.appPassword = creds.wp_app_password || getVal('WP_APP_PASSWORD');

      if (!this.siteUrl || !this.username || !this.appPassword) {
        this.logger.warn(MODULE, 'Missing WP credentials (WP_SITE_URL, WP_USERNAME, or WP_APP_PASSWORD). Publisher disabled.');
        this.ready = false;
        return;
      }

      // Strip trailing slash
      this.siteUrl = this.siteUrl.replace(/\/+$/, '');
      this.ready = true;

      // Pre-load category cache
      try {
        const cats = await this._wpFetch('GET', '/categories?per_page=100');
        if (Array.isArray(cats)) {
          for (const cat of cats) {
            this.categoryCache[cat.name.toLowerCase()] = cat.id;
          }
        }
        this.logger.info(MODULE, 'Initialized. ' + Object.keys(this.categoryCache).length + ' categories cached. Site: ' + this.siteUrl);
      } catch (err) {
        this.logger.warn(MODULE, 'Could not pre-load categories: ' + err.message + '. Will create on demand.');
      }
    } catch (err) {
      this.logger.error(MODULE, 'Init failed: ' + err.message);
      this.ready = false;
    }
  }

  isReady() {
    return this.ready;
  }

  /**
   * Get or create a WordPress category by name.
   */
  async getOrCreateCategory(name) {
    const key = name.toLowerCase();
    if (this.categoryCache[key]) return this.categoryCache[key];

    // Search existing
    try {
      const results = await this._wpFetch('GET', '/categories?search=' + encodeURIComponent(name));
      if (Array.isArray(results) && results.length > 0) {
        for (const cat of results) {
          if (cat.name.toLowerCase() === key) {
            this.categoryCache[key] = cat.id;
            return cat.id;
          }
        }
      }
    } catch (err) {
      this.logger.warn(MODULE, 'Category search failed for "' + name + '": ' + err.message);
    }

    // Create new
    try {
      const newCat = await this._wpFetch('POST', '/categories', { name: name, slug: slugify(name) });
      if (newCat && newCat.id) {
        this.categoryCache[key] = newCat.id;
        this.logger.info(MODULE, 'Created category: ' + name + ' (id=' + newCat.id + ')');
        return newCat.id;
      }
    } catch (err) {
      this.logger.error(MODULE, 'Failed to create category "' + name + '": ' + err.message);
    }

    return null;
  }

  /**
   * Find an existing post by slug.
   */
  async findPost(slug) {
    try {
      const results = await this._wpFetch('GET', '/posts?slug=' + encodeURIComponent(slug) + '&status=publish,draft,private&per_page=1');
      if (Array.isArray(results) && results.length > 0) {
        return { id: results[0].id, slug: results[0].slug, modified: results[0].modified };
      }
    } catch (err) {
      this.logger.warn(MODULE, 'findPost(' + slug + ') failed: ' + err.message);
    }
    return null;
  }

  /**
   * Create or update a WordPress post.
   *
   * Optional fields on `opts`:
   *  - authorId     (positive integer) — WP user ID for post.author. When
   *                  omitted/invalid, WordPress uses the API-authenticated
   *                  user (existing behavior).
   *  - categorySlug (string) — reserved for future use; if passed and it
   *                  resolves via the category cache, it is appended to the
   *                  category list. Unknown slugs are ignored silently.
   */
  async upsertPost(opts) {
    const { slug, title, content, categoryNames, metaDescription, status, meta, authorId, categorySlug } = opts;

    // Resolve category IDs
    const categoryIds = [];
    if (categoryNames && categoryNames.length > 0) {
      for (const name of categoryNames) {
        const catId = await this.getOrCreateCategory(name);
        if (catId) categoryIds.push(catId);
      }
    }

    // Optional explicit category slug (additive). Looked up via cache only —
    // we do not auto-create from a slug, since slugs don't map 1:1 to names.
    if (categorySlug && typeof categorySlug === 'string') {
      var slugKey = categorySlug.toLowerCase().trim();
      if (slugKey && this.categoryCache[slugKey]) {
        var slugCatId = this.categoryCache[slugKey];
        if (categoryIds.indexOf(slugCatId) === -1) categoryIds.push(slugCatId);
      }
    }

    const postData = {
      slug: slug,
      title: title,
      content: content,
      status: status || 'publish',
      excerpt: metaDescription || '',
      meta: Object.assign({}, meta || {}, {
        _yoast_wpseo_metadesc: metaDescription || '',
        rank_math_description: metaDescription || '',
      }),
    };

    // Optional explicit author — only set when caller passed a positive
    // integer. Leaving this unset preserves existing behavior (WP uses the
    // API-authenticated user as the post author).
    if (typeof authorId === 'number' && authorId > 0 && Number.isFinite(authorId) && Math.floor(authorId) === authorId) {
      postData.author = authorId;
    }

    // Optional admin-configured comment/ping status — empty string means
    // "let WordPress use its site default".
    var cfgCfg = require('../utils/config');
    var commentStatus = (cfgCfg.get('WP_COMMENT_STATUS') || '').toLowerCase().trim();
    var pingStatus = (cfgCfg.get('WP_PING_STATUS') || '').toLowerCase().trim();
    if (commentStatus === 'open' || commentStatus === 'closed') {
      postData.comment_status = commentStatus;
    }
    if (pingStatus === 'open' || pingStatus === 'closed') {
      postData.ping_status = pingStatus;
    }

    if (categoryIds.length > 0) {
      postData.categories = categoryIds;
    }

    const existing = await this.findPost(slug);

    if (existing) {
      // Update
      const result = await this._wpFetch('POST', '/posts/' + existing.id, postData);
      return { id: result.id, slug: result.slug, url: result.link, action: 'updated' };
    } else {
      // Create
      const result = await this._wpFetch('POST', '/posts', postData);
      return { id: result.id, slug: result.slug, url: result.link, action: 'created' };
    }
  }

  /**
   * Make an authenticated request to the WP REST API with retry on 429.
   */
  async _wpFetch(method, path, body) {
    const url = this.siteUrl + '/wp-json/wp/v2' + path;
    const authStr = Buffer.from(this.username + ':' + this.appPassword).toString('base64');

    const headers = {
      'Content-Type': 'application/json',
      'Authorization': 'Basic ' + authStr,
    };

    const maxRetries = 3;
    const baseDelay = 2000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const opts = {
          method: method,
          headers: headers,
        };
        if (body && (method === 'POST' || method === 'PUT')) {
          opts.body = JSON.stringify(body);
        }

        const res = await fetch(url, opts);

        if (res.status === 429 && attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt);
          this.logger.warn(MODULE, 'Rate limited (429). Retrying in ' + delay + 'ms (attempt ' + (attempt + 1) + '/' + maxRetries + ')');
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error('WP API ' + method + ' ' + path + ' returned ' + res.status + ': ' + errText.substring(0, 200));
        }

        return await res.json();
      } catch (err) {
        if (attempt < maxRetries && err.message && err.message.includes('429')) {
          const delay = baseDelay * Math.pow(2, attempt);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * Upload a media file to the WordPress Media Library.
   * Returns the attachment object { id, source_url, ... } on success.
   */
  async uploadMedia(buffer, filename, mimeType) {
    if (!this.ready) throw new Error('WP Publisher not ready');

    const url = this.siteUrl + '/wp-json/wp/v2/media';
    const authStr = Buffer.from(this.username + ':' + this.appPassword).toString('base64');

    const maxRetries = 3;
    const baseDelay = 2000;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + authStr,
            'Content-Disposition': 'attachment; filename="' + filename + '"',
            'Content-Type': mimeType || 'image/webp',
          },
          body: buffer,
        });

        if (res.status === 429 && attempt < maxRetries) {
          const delay = baseDelay * Math.pow(2, attempt);
          this.logger.warn(MODULE, 'Media upload rate limited. Retrying in ' + delay + 'ms');
          await new Promise(r => setTimeout(r, delay));
          continue;
        }

        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          throw new Error('WP media upload ' + res.status + ': ' + errText.substring(0, 200));
        }

        return await res.json();
      } catch (err) {
        if (attempt < maxRetries && err.message && err.message.includes('429')) {
          const delay = baseDelay * Math.pow(2, attempt);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw err;
      }
    }
    throw new Error('WP media upload: max retries exhausted');
  }

  /**
   * Test WordPress connection.
   */
  async testConnection() {
    if (!this.ready) {
      return { ok: false, error: 'WP Publisher not configured (missing credentials)' };
    }
    try {
      await this._wpFetch('GET', '/posts?per_page=1');
      return { ok: true, site: this.siteUrl };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Module health status.
   */
  getHealth() {
    return {
      module: MODULE,
      name: MODULE,
      status: this.ready ? 'ok' : 'warn',
      enabled: true,
      ready: this.ready,
      message: this.ready ? 'Connected to ' + this.siteUrl : 'Not configured',
    };
  }
}

module.exports = { WPPublisher };
