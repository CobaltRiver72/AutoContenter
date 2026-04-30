'use strict';

const { EventEmitter } = require('events');
const cron = require('node-cron');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { fetchWithTimeout } = require('../utils/fetch-timeout');

const MODULE = 'lottery';
const MAX_RETRIES = 9;
const RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// PDF source URLs
const SOURCES = {
  sambad: 'https://www.lotterysambad.com/lotteryoldresultsdown.php?filename=',
  dhankesari: 'https://www.dhankesari.com/oldresultsdownload.php?filename=',
};

// ─── IST helpers ─────────────────────────────────────────────────────────────

function getISTDateStr() {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return now.toISOString().slice(0, 10);
}

function getISTDayOfWeek() {
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return now.getDay(); // 0=Sun … 6=Sat
}

// Format YYYY-MM-DD → DDMMYY for PDF filenames
function toPdfDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-');
  return d + m + y.slice(-2);
}

class LotteryModule extends EventEmitter {
  /**
   * @param {object} config - Frozen config object
   * @param {import('better-sqlite3').Database} db
   * @param {object} logger
   */
  constructor(config, db, logger) {
    super();
    this.config = config;
    this.db = db;
    this.logger = logger;

    this._cronJobs = [];
    this._retryTimers = {};
    this.enabled = false;
    this.status = 'disabled';
    this.error = null;

    this.stats = {
      totalFetched: 0,
      lastFetchAt: null,
    };

    this.postCreator = null;
    this._schedule = null; // loaded from lottery-schedule.json
  }

  setPostCreator(creator) {
    this.postCreator = creator;
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  async init() {
    try {
      this._loadSchedule();

      const tz = 'Asia/Kolkata';

      // 13:10 IST — 1pm draw (10 min after draw time)
      this._cronJobs.push(cron.schedule('10 13 * * *', () => {
        this._runCronFetch('1pm').catch(err => {
          this.logger.error(MODULE, '1pm cron failed: ' + err.message);
        });
      }, { timezone: tz }));

      // 18:10 IST — 6pm draw
      this._cronJobs.push(cron.schedule('10 18 * * *', () => {
        this._runCronFetch('6pm').catch(err => {
          this.logger.error(MODULE, '6pm cron failed: ' + err.message);
        });
      }, { timezone: tz }));

      // 20:10 IST — 8pm draw
      this._cronJobs.push(cron.schedule('10 20 * * *', () => {
        this._runCronFetch('8pm').catch(err => {
          this.logger.error(MODULE, '8pm cron failed: ' + err.message);
        });
      }, { timezone: tz }));

      // On startup: reschedule any draws from today that didn't complete
      this._recoverPendingDraws();

      this.enabled = true;
      this.status = 'ready';
      this.logger.info(MODULE, 'Lottery module initialized');
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      this.logger.warn(MODULE, 'Init failed: ' + err.message + '. Module disabled.');
    }
  }

  _loadSchedule() {
    const schedulePath = path.resolve(__dirname, '../data/lottery-schedule.json');
    if (!fs.existsSync(schedulePath)) {
      throw new Error('lottery-schedule.json not found at ' + schedulePath);
    }
    this._schedule = JSON.parse(fs.readFileSync(schedulePath, 'utf8'));
    this.logger.info(MODULE, 'Loaded draw schedule for slots: ' + Object.keys(this._schedule).join(', '));
  }

  // On startup, check if any of today's draw slots are still pending/failed
  // and have retries remaining — reschedule them
  _recoverPendingDraws() {
    try {
      const today = getISTDateStr();
      const pending = this.db.prepare(
        "SELECT draw_time, retry_count FROM lottery_results " +
        "WHERE draw_date = ? AND status NOT IN ('posted') AND retry_count < ?"
      ).all(today, MAX_RETRIES);

      for (const row of pending) {
        const slotDef = this._schedule[row.draw_time];
        if (!slotDef) continue;
        const [slotHour] = row.draw_time === '1pm' ? [13] : row.draw_time === '6pm' ? [18] : [20];
        const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
        const nowHour = nowIST.getHours();

        // Only recover if we're past the draw time (already should have fetched)
        // and not too late (within 3-hour retry window)
        if (nowHour >= slotHour && nowHour < slotHour + 3) {
          this.logger.info(MODULE, 'Recovering pending draw: ' + row.draw_time + ' (retry ' + row.retry_count + ')');
          this._scheduleRetry(row.draw_time, 30 * 1000); // retry in 30s on startup
        }
      }
    } catch (err) {
      this.logger.warn(MODULE, 'Startup draw recovery failed: ' + err.message);
    }
  }

  // ─── Cron trigger (main entry for each draw) ──────────────────────────────

  async _runCronFetch(drawTime) {
    const date = getISTDateStr();
    this.logger.info(MODULE, drawTime + ' draw triggered for ' + date);

    // Upsert a pending record so we can track this draw slot
    this._upsertResult(date, drawTime, { status: 'pending', retry_count: 0 });

    const success = await this.runFetch(drawTime, date, false);
    if (!success) {
      this._scheduleRetry(drawTime, RETRY_INTERVAL_MS);
    }
  }

  // ─── Core fetch + convert + post ─────────────────────────────────────────

  /**
   * Attempt to fetch PDF, convert to WEBP, and trigger post creation.
   * Returns true on success, false if PDF was not yet available.
   */
  async runFetch(drawTime, date, isManual = false) {
    const startTime = Date.now();
    const existing = this._getResult(date, drawTime);
    if (existing && existing.status === 'posted') {
      this.logger.info(MODULE, drawTime + ' draw for ' + date + ' already posted, skipping');
      return true;
    }

    const slotDef = this._schedule[drawTime];
    if (!slotDef) {
      this.logger.error(MODULE, 'Unknown draw time: ' + drawTime);
      return false;
    }

    const dayOfWeek = this._getDayOfWeek(date);
    const drawName = slotDef.draws[String(dayOfWeek)];
    const filename = slotDef.prefix + toPdfDateStr(date) + '.PDF';

    // Try Sambad first, then Dhankesari
    let pdfBuffer = null;
    let usedSource = null;

    for (const [source, baseUrl] of Object.entries(SOURCES)) {
      const url = baseUrl + filename;
      try {
        pdfBuffer = await this._downloadPdf(url);
        usedSource = source;
        this.logger.info(MODULE, 'PDF downloaded from ' + source + ': ' + filename);
        break;
      } catch (err) {
        this.logger.warn(MODULE, source + ' PDF not available (' + filename + '): ' + err.message);
      }
    }

    if (!pdfBuffer) {
      this._upsertResult(date, drawTime, {
        draw_name: drawName,
        status: 'error',
        error_message: 'PDF not available on Sambad or Dhankesari',
      });
      return false;
    }

    // Mark as fetched
    this._upsertResult(date, drawTime, {
      draw_name: drawName,
      source: usedSource,
      pdf_url: SOURCES[usedSource] + filename,
      status: 'fetched',
      error_message: null,
    });

    // Convert PDF to WEBP
    let webpBuffer = null;
    try {
      webpBuffer = await this._convertToWebp(pdfBuffer, filename.replace('.PDF', '').toLowerCase());
    } catch (err) {
      this.logger.warn(MODULE, 'PDF-to-WEBP conversion failed for ' + filename + ': ' + err.message);
      this._upsertResult(date, drawTime, {
        status: 'error',
        error_message: 'Conversion failed: ' + err.message,
      });
      return false;
    }

    this._upsertResult(date, drawTime, { status: 'converted' });

    // Upload WEBP to WordPress via Media API
    let wpAttachment = null;
    if (webpBuffer && this.postCreator && this.postCreator.wp && this.postCreator.wp.isReady()) {
      try {
        const wpFilename = 'lottery-' + date + '-' + drawTime + '.webp';
        wpAttachment = await this.postCreator.wp.uploadMedia(webpBuffer, wpFilename, 'image/webp');
        if (wpAttachment && wpAttachment.id) {
          this._upsertResult(date, drawTime, {
            wp_attachment_id: wpAttachment.id,
            image_url: wpAttachment.source_url || null,
          });
          this.logger.info(MODULE, 'WEBP uploaded to WP (id=' + wpAttachment.id + ')');
        }
      } catch (err) {
        this.logger.warn(MODULE, 'WP media upload failed: ' + err.message + ' — proceeding without image');
      }
    }

    // Trigger post creation
    if (this.postCreator) {
      try {
        const resultRow = this._getResult(date, drawTime);
        await this.postCreator.generateDrawPost(resultRow);
      } catch (err) {
        this.logger.error(MODULE, 'Post creation failed for ' + drawTime + ': ' + err.message);
        return false;
      }
    }

    this.stats.totalFetched++;
    this.stats.lastFetchAt = new Date().toISOString();

    try {
      this.db.prepare(
        'INSERT INTO fetch_log (module, fetch_type, cities_ok, cities_fail, duration_ms) VALUES (?, ?, 1, 0, ?)'
      ).run(MODULE, isManual ? 'manual' : 'scheduled', Date.now() - startTime);
    } catch (e) { /* non-fatal */ }

    return true;
  }

  // ─── Retry logic ──────────────────────────────────────────────────────────

  _scheduleRetry(drawTime, delayMs) {
    // Cancel any existing retry timer for this slot
    if (this._retryTimers[drawTime]) {
      clearTimeout(this._retryTimers[drawTime]);
      this._retryTimers[drawTime] = null;
    }

    const date = getISTDateStr();
    const row = this._getResult(date, drawTime);
    const currentRetry = row ? row.retry_count : 0;

    if (currentRetry >= MAX_RETRIES) {
      this.logger.warn(MODULE, drawTime + ' draw: max retries (' + MAX_RETRIES + ') reached for ' + date);
      return;
    }

    this.logger.info(MODULE, 'Scheduling retry ' + (currentRetry + 1) + '/' + MAX_RETRIES + ' for ' + drawTime + ' in ' + Math.round(delayMs / 1000) + 's');

    this._retryTimers[drawTime] = setTimeout(async () => {
      this._retryTimers[drawTime] = null;
      const retryDate = getISTDateStr(); // re-read in case day rolled over
      const retryRow = this._getResult(retryDate, drawTime);
      const newCount = (retryRow ? retryRow.retry_count : 0) + 1;
      this._upsertResult(retryDate, drawTime, { retry_count: newCount });

      this.logger.info(MODULE, 'Retry ' + newCount + '/' + MAX_RETRIES + ' for ' + drawTime + ' draw (' + retryDate + ')');
      const success = await this.runFetch(drawTime, retryDate, false).catch(err => {
        this.logger.error(MODULE, 'Retry fetch failed: ' + err.message);
        return false;
      });

      if (!success) {
        this._scheduleRetry(drawTime, RETRY_INTERVAL_MS);
      }
    }, delayMs);
  }

  // ─── PDF download ─────────────────────────────────────────────────────────

  async _downloadPdf(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/pdf,*/*',
          'Referer': 'https://www.lotterysambad.com/',
        },
        redirect: 'follow',
      });

      if (!res.ok) throw new Error('HTTP ' + res.status);

      const buf = Buffer.from(await res.arrayBuffer());

      // Validate PDF magic bytes
      if (buf.length < 100) throw new Error('Response too short (' + buf.length + ' bytes)');
      if (buf.slice(0, 4).toString() !== '%PDF') throw new Error('Not a valid PDF (bad magic bytes)');

      return buf;
    } finally {
      clearTimeout(timeout);
    }
  }

  // ─── PDF-to-WEBP conversion ───────────────────────────────────────────────

  async _convertToWebp(pdfBuffer, baseFilename) {
    // Method 1: Cloudinary
    const cloudCreds = this._getCloudinaryCreds();
    if (cloudCreds) {
      try {
        const webpBuf = await this._convertViaCloudinary(pdfBuffer, baseFilename, cloudCreds);
        if (webpBuf && webpBuf.length > 1000) {
          this.logger.info(MODULE, 'PDF converted via Cloudinary');
          return webpBuf;
        }
      } catch (err) {
        this.logger.warn(MODULE, 'Cloudinary conversion failed: ' + err.message + ' — trying CLI');
      }
    }

    // Method 2: Ghostscript CLI
    try {
      const webpBuf = await this._convertViaCLI(pdfBuffer, baseFilename, 'gs');
      if (webpBuf && webpBuf.length > 1000) {
        this.logger.info(MODULE, 'PDF converted via Ghostscript');
        return webpBuf;
      }
    } catch (err) {
      this.logger.warn(MODULE, 'Ghostscript failed: ' + err.message + ' — trying ImageMagick');
    }

    // Method 3: ImageMagick CLI
    try {
      const webpBuf = await this._convertViaCLI(pdfBuffer, baseFilename, 'convert');
      if (webpBuf && webpBuf.length > 1000) {
        this.logger.info(MODULE, 'PDF converted via ImageMagick');
        return webpBuf;
      }
    } catch (err) {
      this.logger.warn(MODULE, 'ImageMagick failed: ' + err.message);
    }

    throw new Error('All PDF-to-WEBP conversion methods failed. Install Ghostscript or configure Cloudinary.');
  }

  async _convertViaCloudinary(pdfBuffer, baseFilename, creds) {
    const { cloudName, apiKey, apiSecret } = creds;
    const publicId = 'lottery-tmp-' + baseFilename + '-' + Date.now();
    const ts = Math.floor(Date.now() / 1000);
    const sig = crypto.createHash('sha1')
      .update('public_id=' + publicId + '&timestamp=' + ts + apiSecret)
      .digest('hex');

    const uploadUrl = 'https://api.cloudinary.com/v1_1/' + cloudName + '/image/upload';
    const form = new FormData();
    form.append('file', new Blob([pdfBuffer], { type: 'application/pdf' }), baseFilename + '.pdf');
    form.append('public_id', publicId);
    form.append('timestamp', String(ts));
    form.append('api_key', apiKey);
    form.append('signature', sig);

    const uploadRes = await fetchWithTimeout(uploadUrl, { method: 'POST', body: form }, 60000);
    if (!uploadRes.ok) {
      const t = await uploadRes.text().catch(() => '');
      throw new Error('Cloudinary upload failed ' + uploadRes.status + ': ' + t.slice(0, 200));
    }
    const uploadData = await uploadRes.json();
    const returnedId = uploadData.public_id;

    // Fetch page 1 as WEBP
    const webpUrl = 'https://res.cloudinary.com/' + cloudName + '/image/upload/q_85,w_900,pg_1/' + returnedId + '.webp';
    const webpRes = await fetchWithTimeout(webpUrl, undefined, 60000);
    if (!webpRes.ok) throw new Error('Cloudinary WEBP fetch failed ' + webpRes.status);
    const webpBuf = Buffer.from(await webpRes.arrayBuffer());

    // Clean up Cloudinary asset
    const delTs = Math.floor(Date.now() / 1000);
    const delSig = crypto.createHash('sha1')
      .update('public_id=' + returnedId + '&timestamp=' + delTs + apiSecret)
      .digest('hex');
    const delForm = new FormData();
    delForm.append('public_id', returnedId);
    delForm.append('timestamp', String(delTs));
    delForm.append('api_key', apiKey);
    delForm.append('signature', delSig);
    fetchWithTimeout('https://api.cloudinary.com/v1_1/' + cloudName + '/image/destroy', {
      method: 'POST', body: delForm,
    }, 30000).catch(() => {});

    return webpBuf;
  }

  async _convertViaCLI(pdfBuffer, baseFilename, tool) {
    const { exec } = require('child_process');
    const os = require('os');

    // Write PDF to temp file
    const tmpDir = os.tmpdir();
    const tmpPdf = path.join(tmpDir, 'lottery-' + baseFilename + '-' + Date.now() + '.pdf');
    const tmpOut = path.join(tmpDir, 'lottery-' + baseFilename + '-' + Date.now() + '.webp');

    fs.writeFileSync(tmpPdf, pdfBuffer);

    return new Promise((resolve, reject) => {
      // Check tool exists
      exec('which ' + tool, (whichErr) => {
        if (whichErr) {
          fs.unlink(tmpPdf, () => {});
          return reject(new Error(tool + ' not found on PATH'));
        }

        let cmd;
        if (tool === 'gs') {
          const tmpPng = tmpOut.replace('.webp', '.png');
          cmd = 'gs -q -dNOPAUSE -dBATCH -dSAFER -dFirstPage=1 -dLastPage=1 -sDEVICE=png16m -r150 -sOutputFile=' +
            tmpPng + ' ' + tmpPdf + ' && convert ' + tmpPng + ' -resize 900x -quality 85 ' + tmpOut +
            ' && rm -f ' + tmpPng;
        } else {
          cmd = 'convert -density 150 -quality 85 "' + tmpPdf + '[0]" -resize 900x -flatten ' + tmpOut;
        }

        exec(cmd, { timeout: 60000 }, (err) => {
          fs.unlink(tmpPdf, () => {});
          if (err) {
            fs.unlink(tmpOut, () => {});
            return reject(new Error(tool + ' exec failed: ' + err.message));
          }
          if (!fs.existsSync(tmpOut)) {
            return reject(new Error(tool + ' produced no output file'));
          }
          const buf = fs.readFileSync(tmpOut);
          fs.unlink(tmpOut, () => {});
          resolve(buf);
        });
      });
    });
  }

  // ─── Cloudinary credentials ───────────────────────────────────────────────

  _getCloudinaryCreds() {
    const get = (key) => {
      const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      if (row && row.value) return row.value;
      return process.env[key] || null;
    };
    const cloudName = get('CLOUDINARY_CLOUD_NAME');
    const apiKey = get('CLOUDINARY_API_KEY');
    const apiSecret = get('CLOUDINARY_API_SECRET');
    if (!cloudName || !apiKey || !apiSecret) return null;
    return { cloudName, apiKey, apiSecret };
  }

  // ─── DB helpers ───────────────────────────────────────────────────────────

  _upsertResult(date, drawTime, fields) {
    const cols = ['draw_date', 'draw_time', ...Object.keys(fields)];
    const placeholders = cols.map(() => '?').join(', ');
    const setters = Object.keys(fields).map(k => k + ' = excluded.' + k).join(', ');
    this.db.prepare(
      'INSERT INTO lottery_results (' + cols.join(', ') + ') VALUES (' + placeholders + ') ' +
      'ON CONFLICT(draw_date, draw_time) DO UPDATE SET ' + setters
    ).run(date, drawTime, ...Object.values(fields));
  }

  _getResult(date, drawTime) {
    return this.db.prepare(
      'SELECT * FROM lottery_results WHERE draw_date = ? AND draw_time = ?'
    ).get(date, drawTime);
  }

  getResultsByDate(date) {
    return this.db.prepare(
      'SELECT * FROM lottery_results WHERE draw_date = ? ORDER BY draw_time ASC'
    ).all(date);
  }

  getRecentResults(limit) {
    return this.db.prepare(
      'SELECT * FROM lottery_results ORDER BY draw_date DESC, draw_time ASC LIMIT ?'
    ).all(limit || 30);
  }

  // ─── Summary and health ───────────────────────────────────────────────────

  getTodaySummary() {
    const today = getISTDateStr();
    const rows = this.getResultsByDate(today);
    const summary = {};
    for (const slot of ['1pm', '6pm', '8pm']) {
      const row = rows.find(r => r.draw_time === slot) || null;
      summary[slot] = row ? { status: row.status, draw_name: row.draw_name, wp_post_id: row.wp_post_id } : { status: 'pending' };
    }
    return { date: today, draws: summary };
  }

  getHealth() {
    return {
      module: MODULE,
      enabled: this.enabled,
      ready: this.status === 'ready',
      status: this.status,
      error: this.error,
      lastActivity: this.stats.lastFetchAt,
      stats: this.stats,
    };
  }

  // ─── Shutdown ─────────────────────────────────────────────────────────────

  async shutdown() {
    for (const job of this._cronJobs) job.stop();
    this._cronJobs = [];

    for (const key of Object.keys(this._retryTimers)) {
      if (this._retryTimers[key]) {
        clearTimeout(this._retryTimers[key]);
        this._retryTimers[key] = null;
      }
    }

    this.enabled = false;
    this.status = 'disabled';
    this.logger.info(MODULE, 'Lottery module shut down');
  }

  // ─── Utility ─────────────────────────────────────────────────────────────

  _getDayOfWeek(dateStr) {
    // Parse as UTC midnight then apply IST offset to get IST day-of-week
    // Immune to server timezone — matches getISTDayOfWeek() helper
    const utcMs = new Date(dateStr + 'T00:00:00Z').getTime();
    const istMs = utcMs + 5.5 * 60 * 60 * 1000;
    return new Date(istMs).getUTCDay(); // 0=Sun … 6=Sat
  }

  getSchedule() {
    return this._schedule;
  }
}

module.exports = { LotteryModule };
