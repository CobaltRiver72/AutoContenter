'use strict';

const MODULE = 'lottery-posts';
const crypto = require('crypto');
const _cfg = require('../utils/config');

// Read admin-configured post status — respect Settings → WP_POST_STATUS.
function _wpPostStatus() {
  var v = (_cfg.get('WP_POST_STATUS') || '').toLowerCase().trim();
  var allowed = ['publish', 'draft', 'pending', 'private'];
  return allowed.indexOf(v) !== -1 ? v : 'publish';
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function fmtDateLong(dateStr) {
  // YYYY-MM-DD → "12 April 2026"
  const d = new Date(dateStr + 'T00:00:00');
  const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  return d.getDate() + ' ' + months[d.getMonth()] + ' ' + d.getFullYear();
}

function fmtDateSlug(dateStr) {
  // YYYY-MM-DD → "12-04-2026"
  const [y, m, d] = dateStr.split('-');
  return d + '-' + m + '-' + y;
}

const TIME_LABELS = {
  '1pm': '1:00 PM',
  '6pm': '6:00 PM',
  '8pm': '8:00 PM',
};

const DRAW_SLOTS = ['1pm', '6pm', '8pm'];

// ---------------------------------------------------------------------------
// LotteryPostCreator
// ---------------------------------------------------------------------------

class LotteryPostCreator {
  /**
   * @param {object} lottery - LotteryModule instance
   * @param {object} wpPublisher - WPPublisher instance
   * @param {import('better-sqlite3').Database} db
   * @param {object} logger
   */
  constructor(lottery, wpPublisher, db, logger) {
    this.lottery = lottery;
    this.wp = wpPublisher;
    this.db = db;
    this.logger = logger;
  }

  // =========================================================================
  // wp_posts_log helper
  // =========================================================================

  _logPost(drawTime, drawDate, result, contentHash) {
    try {
      this.db.prepare(`
        INSERT INTO wp_posts_log (module, post_type, item_type, item_name, wp_post_id, wp_slug, wp_url, wp_status, action, content_hash)
        VALUES ('lottery', 'draw', ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(module, item_type, post_type, item_name) DO UPDATE SET
          wp_post_id = excluded.wp_post_id, wp_url = excluded.wp_url,
          wp_status = excluded.wp_status, action = excluded.action,
          content_hash = excluded.content_hash, created_at = datetime('now')
      `).run(
        drawTime,
        drawDate,
        result.id || null,
        result.slug || null,
        result.url || null,
        result.status || _wpPostStatus(),
        result.action || 'updated',
        contentHash || null
      );
    } catch (e) {
      this.logger.warn(MODULE, 'wp_posts_log insert failed: ' + e.message);
    }
  }

  _logPostFailed(drawTime, drawDate, errorMsg) {
    try {
      this.db.prepare(`
        INSERT INTO wp_posts_log (module, post_type, item_type, item_name, action, error_message)
        VALUES ('lottery', 'draw', ?, ?, 'failed', ?)
        ON CONFLICT(module, item_type, post_type, item_name) DO UPDATE SET
          action = 'failed', error_message = excluded.error_message, created_at = datetime('now')
      `).run(drawTime, drawDate, errorMsg);
    } catch (e) { /* silent */ }
  }

  // =========================================================================
  // generateDrawPost — called by LotteryModule after successful fetch+convert
  // =========================================================================

  async generateDrawPost(resultRow) {
    if (!this.wp.isReady()) {
      this.logger.warn(MODULE, 'WP publisher not ready, skipping post generation');
      return null;
    }
    if (!resultRow) {
      this.logger.warn(MODULE, 'generateDrawPost called with null resultRow');
      return null;
    }

    const { draw_date, draw_time, draw_name, image_url, wp_attachment_id, source } = resultRow;
    const timeLabel = TIME_LABELS[draw_time] || draw_time;
    const dateStr = fmtDateLong(draw_date);
    const dateSlug = fmtDateSlug(draw_date);

    const slug = 'lottery-sambad-result-' + dateSlug + '-' + draw_time;
    const title = 'Lottery Sambad Result ' + dateStr + ' ' + timeLabel + ' — ' + (draw_name || 'Today\'s Result');

    const metaDescription = 'Lottery Sambad ' + draw_name + ' result for ' + dateStr + ' ' + timeLabel + '. Check today\'s winning numbers, prize structure, and how to claim your prize.';

    // Get related draws for cross-links
    const allTodayResults = this.lottery.getResultsByDate(draw_date);

    const html = this._buildContent({
      draw_date, draw_time, draw_name, image_url, source,
      dateStr, timeLabel, slug, allTodayResults,
    });

    const contentHash = crypto.createHash('md5').update(html).digest('hex');

    try {
      const wpResult = await this.wp.upsertPost({
        slug,
        title,
        content: html,
        categoryNames: ['Lottery Results'],
        metaDescription,
        status: _wpPostStatus(),
        meta: {
          _hdf_lottery_draw_date: draw_date,
          _hdf_lottery_draw_time: draw_time,
          _hdf_lottery_draw_name: draw_name || '',
          _hdf_lottery_source: source || 'sambad',
          _hdf_lottery_meta_desc: metaDescription,
        },
      });

      // Set featured image if we have a WP attachment
      if (wp_attachment_id && wpResult && wpResult.id) {
        try {
          await this._setFeaturedImage(wpResult.id, wp_attachment_id);
        } catch (imgErr) {
          this.logger.warn(MODULE, 'Featured image set failed: ' + imgErr.message);
        }
      }

      // Update lottery_results with post info
      this.db.prepare(
        "UPDATE lottery_results SET wp_post_id = ?, wp_post_url = ?, status = 'posted' WHERE draw_date = ? AND draw_time = ?"
      ).run(wpResult.id || null, wpResult.url || null, draw_date, draw_time);

      this._logPost(draw_time, draw_date, wpResult, contentHash);
      this.logger.info(MODULE, 'Post ' + wpResult.action + ': ' + title + ' (id=' + wpResult.id + ')');
      return wpResult;
    } catch (err) {
      this._logPostFailed(draw_time, draw_date, err.message);
      this.logger.error(MODULE, 'Post failed for ' + draw_time + ' ' + draw_date + ': ' + err.message);
      throw err;
    }
  }

  // =========================================================================
  // Set featured image on WP post
  // =========================================================================

  async _setFeaturedImage(postId, attachmentId) {
    await this.wp._wpFetch('POST', '/posts/' + postId, { featured_media: attachmentId });
  }

  // =========================================================================
  // HTML builder
  // =========================================================================

  _buildContent({ draw_date, draw_time, draw_name, image_url, source, dateStr, timeLabel, slug, allTodayResults }) {
    const lines = [];
    const isoDate = draw_date + 'T00:00:00+05:30';
    const drawNameSafe = draw_name || 'Today\'s Result';
    const sourceName = source === 'dhankesari' ? 'Dhankesari' : 'Lottery Sambad';

    // ── JSON-LD: BreadcrumbList ────────────────────────────────────────────
    lines.push('<script type="application/ld+json">');
    lines.push(JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      'itemListElement': [
        { '@type': 'ListItem', 'position': 1, 'name': 'Home', 'item': '/' },
        { '@type': 'ListItem', 'position': 2, 'name': 'Lottery Results', 'item': '/lottery-results/' },
        { '@type': 'ListItem', 'position': 3, 'name': drawNameSafe + ' Result — ' + dateStr, 'item': '/' + slug + '/' },
      ],
    }));
    lines.push('</script>');

    // ── JSON-LD: NewsArticle ───────────────────────────────────────────────
    lines.push('<script type="application/ld+json">');
    lines.push(JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'NewsArticle',
      'headline': 'Lottery Sambad Result ' + dateStr + ' ' + timeLabel + ' — ' + drawNameSafe,
      'description': 'Check ' + drawNameSafe + ' lottery result for ' + dateStr + ' ' + timeLabel + '. Today\'s winning numbers and prize details.',
      'datePublished': isoDate,
      'dateModified': new Date().toISOString(),
      'image': image_url ? [image_url] : [],
      'author': { '@type': 'Organization', 'name': 'HDF News' },
      'publisher': { '@type': 'Organization', 'name': 'HDF News' },
      'keywords': ['lottery sambad', drawNameSafe.toLowerCase(), 'lottery result today', 'lottery result ' + dateStr.toLowerCase()],
    }));
    lines.push('</script>');

    // ── Draw navigation ───────────────────────────────────────────────────
    lines.push('<div class="hdf-draw-nav">');
    for (const slot of DRAW_SLOTS) {
      const slotResult = allTodayResults.find(r => r.draw_time === slot);
      const slotLabel = TIME_LABELS[slot];
      const slotSlug = 'lottery-sambad-result-' + fmtDateSlug(draw_date) + '-' + slot;
      if (slotResult && slotResult.wp_post_url) {
        const cls = slot === draw_time ? ' hdf-active' : '';
        lines.push('<a href="/' + slotSlug + '/" class="hdf-draw-link' + cls + '">' + slotLabel + '</a>');
      } else {
        const cls = slot === draw_time ? ' hdf-active' : '';
        lines.push('<span class="hdf-draw-link' + cls + '">' + slotLabel + '</span>');
      }
    }
    lines.push('</div>');

    // ── Article wrapper ───────────────────────────────────────────────────
    lines.push('<article class="hdf-lottery-article">');

    // ── Result header ─────────────────────────────────────────────────────
    lines.push('<div class="hdf-result-header">');
    lines.push('<h2>' + drawNameSafe + ' Result — <time datetime="' + isoDate + '">' + dateStr + '</time></h2>');
    lines.push('<div class="hdf-result-meta">');
    lines.push('<span>Draw Time: <strong>' + timeLabel + '</strong></span>');
    lines.push('<span>State: <strong>Nagaland</strong></span>');
    lines.push('<span>Ticket Price: <strong>₹6</strong></span>');
    lines.push('</div>');
    lines.push('</div>');

    // ── Result image ──────────────────────────────────────────────────────
    lines.push('<div class="hdf-result-image-section">');
    if (image_url) {
      lines.push('<figure class="hdf-result-figure">');
      lines.push('<img src="' + image_url + '" alt="' + drawNameSafe + ' Result ' + dateStr + ' ' + timeLabel + ' — Official Winning Numbers" width="900" loading="eager" fetchpriority="high">');
      lines.push('<figcaption>Official result from <a href="https://www.lotterysambad.com/" rel="noopener noreferrer" target="_blank">' + sourceName + '</a></figcaption>');
      lines.push('</figure>');
      lines.push('<div class="hdf-result-actions">');
      lines.push('<a href="' + image_url + '" download class="hdf-btn hdf-btn-outline">Save Result Image</a>');
      lines.push('</div>');
    } else {
      lines.push('<p class="hdf-result-pending">The result image will appear here once available. Please check back after ' + timeLabel + ' IST.</p>');
    }
    lines.push('</div>');

    // ── Prize structure ───────────────────────────────────────────────────
    lines.push('<div class="hdf-prize-section">');
    lines.push('<h3>Prize Structure — ' + drawNameSafe + '</h3>');
    lines.push('<table class="hdf-prize-table">');
    lines.push('<thead><tr><th>Prize</th><th>Amount</th><th>Winners</th></tr></thead>');
    lines.push('<tbody>');
    const prizes = [
      ['1st Prize', '₹1,00,00,000', '1'],
      ['Consolation Prize', '₹1,000', '10'],
      ['2nd Prize', '₹9,000', '10'],
      ['3rd Prize', '₹500', '10'],
      ['4th Prize', '₹250', '10'],
      ['5th Prize', '₹120', '10'],
    ];
    for (const [name, amount, winners] of prizes) {
      lines.push('<tr><td>' + name + '</td><td>' + amount + '</td><td>' + winners + '</td></tr>');
    }
    lines.push('</tbody></table>');
    lines.push('</div>');

    // ── How to check ──────────────────────────────────────────────────────
    lines.push('<div class="hdf-how-to-check">');
    lines.push('<h3>How to Check Your Lottery Sambad Result</h3>');
    lines.push('<ol>');
    lines.push('<li>Find your Lottery Sambad ticket for the <strong>' + timeLabel + '</strong> draw.</li>');
    lines.push('<li>Compare your ticket number with the winning numbers in the image above.</li>');
    lines.push('<li>Check all prize tiers — your number may appear in multiple categories.</li>');
    lines.push('<li>If you have won, keep your ticket safe and note the prize amount.</li>');
    lines.push('<li>Visit the official Lottery Sambad office to claim your prize within 30 days.</li>');
    lines.push('</ol>');
    lines.push('</div>');

    // ── Related results ───────────────────────────────────────────────────
    const otherDraws = allTodayResults.filter(r => r.draw_time !== draw_time && r.status === 'posted' && r.wp_post_url);
    if (otherDraws.length > 0) {
      lines.push('<div class="hdf-related-section">');
      lines.push('<h3>Other Lottery Results Today (' + dateStr + ')</h3>');
      lines.push('<ul class="hdf-related-list">');
      for (const other of otherDraws) {
        const otherSlug = 'lottery-sambad-result-' + fmtDateSlug(draw_date) + '-' + other.draw_time;
        const otherLabel = TIME_LABELS[other.draw_time] || other.draw_time;
        lines.push('<li><a href="/' + otherSlug + '/">' + (other.draw_name || 'Lottery Sambad') + ' Result ' + otherLabel + '</a></li>');
      }
      lines.push('</ul>');
      lines.push('</div>');
    }

    // ── FAQ ───────────────────────────────────────────────────────────────
    const faqs = [
      {
        q: 'What is the ' + drawNameSafe + ' result for today ' + dateStr + '?',
        a: 'The ' + drawNameSafe + ' result for ' + dateStr + ' ' + timeLabel + ' is published above. Check the winning numbers image for all prize details.',
      },
      {
        q: 'What time is the Lottery Sambad ' + draw_time.toUpperCase() + ' draw?',
        a: 'The Lottery Sambad ' + timeLabel + ' draw result is declared at ' + timeLabel + ' IST daily.',
      },
      {
        q: 'How do I check if I won the ' + drawNameSafe + ' lottery?',
        a: 'Compare your ticket number with the official result image shown on this page. Check all prize tiers.',
      },
      {
        q: 'Where can I claim my Lottery Sambad prize?',
        a: 'Prizes up to ₹10,000 can be claimed at any authorized retailer. Higher prizes must be claimed at the Lottery Sambad office in Nagaland. Claims must be made within 30 days.',
      },
      {
        q: 'Is Lottery Sambad legal and official?',
        a: 'Yes. Lottery Sambad is an official government lottery operated by the Nagaland State Lotteries department under the Lottery Regulation Act.',
      },
      {
        q: 'What is the ticket price for ' + drawNameSafe + '?',
        a: 'The ticket price for Lottery Sambad (including ' + drawNameSafe + ') is ₹6 per ticket.',
      },
    ];

    // FAQ JSON-LD
    lines.push('<script type="application/ld+json">');
    lines.push(JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'FAQPage',
      'mainEntity': faqs.map(f => ({
        '@type': 'Question',
        'name': f.q,
        'acceptedAnswer': { '@type': 'Answer', 'text': f.a },
      })),
    }));
    lines.push('</script>');

    lines.push('<div class="hdf-faq-section">');
    lines.push('<h3>Frequently Asked Questions</h3>');
    for (const faq of faqs) {
      lines.push('<details class="hdf-faq-item">');
      lines.push('<summary>' + faq.q + '</summary>');
      lines.push('<p>' + faq.a + '</p>');
      lines.push('</details>');
    }
    lines.push('</div>');

    // ── Disclaimer ────────────────────────────────────────────────────────
    lines.push('<div class="hdf-disclaimer">');
    lines.push('<p><strong>Disclaimer:</strong> This page displays results sourced from the official Lottery Sambad website. We are not affiliated with Nagaland State Lotteries. Please verify results on the <a href="https://www.lotterysambad.com/" rel="noopener noreferrer" target="_blank">official website</a> before claiming prizes.</p>');
    lines.push('</div>');

    lines.push('</article>');
    return lines.join('\n');
  }
}

module.exports = { LotteryPostCreator };
