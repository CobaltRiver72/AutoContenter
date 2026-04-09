'use strict';

/**
 * Jina AI Reader — third-tier extraction fallback.
 *
 * Calls https://r.jina.ai/{url} which returns clean markdown extracted from
 * any URL. Free tier works without authentication at low rate limits;
 * authenticated calls (Bearer JINA_API_KEY) get higher quotas + better quality.
 *
 * Used by draft-helpers.extractDraftContent() AFTER Layer 1 (direct fetch +
 * Readability) and Layer 2 (Google Cache / Archive.org) have failed, but
 * BEFORE the partial Firehose-data fallback. Jina returns full extracted
 * content, so it is preferable to the partial Firehose data fallback.
 */

var axios = require('axios');
var { assertSafeUrl, safeAxiosOptions } = require('../utils/safe-http');

var MODULE = 'extractor-jina';
var JINA_BASE = 'https://r.jina.ai/';
var FETCH_TIMEOUT_MS = 20000;
var MAX_CONTENT_LENGTH = 5 * 1024 * 1024;

/**
 * Fetch a URL via the Jina AI Reader.
 *
 * @param {string} url - The article URL to extract.
 * @param {object} config - Frozen config snapshot. Reads JINA_API_KEY (optional).
 * @param {object} logger - Logger with .info / .warn methods.
 * @returns {Promise<{title: string|null, content: string, sourceUrl: string|null, length: number}|null>}
 *   Returns null on any failure (caller should fall through to next layer).
 */
async function fetchViaJina(url, config, logger) {
  if (!url) return null;

  // SSRF pre-flight on the *target* URL (the URL we ask Jina to read).
  // The Jina endpoint itself is hardcoded to r.jina.ai which is fine.
  try {
    assertSafeUrl(url);
  } catch (e) {
    if (logger) logger.warn(MODULE, 'Skipping unsafe URL: ' + e.message);
    return null;
  }

  var jinaUrl = JINA_BASE + url;
  var apiKey = (config && config.JINA_API_KEY) || '';

  var headers = {
    'Accept': 'text/plain, text/markdown, */*',
    'User-Agent': 'hdf-news-autopub/1.0',
  };
  if (apiKey) {
    headers['Authorization'] = 'Bearer ' + apiKey;
  }

  var startedAt = Date.now();
  try {
    var res = await axios.get(jinaUrl, safeAxiosOptions({
      timeout: FETCH_TIMEOUT_MS,
      maxContentLength: MAX_CONTENT_LENGTH,
      headers: headers,
      maxRedirects: 3,
      validateStatus: function (status) { return status >= 200 && status < 300; },
      responseType: 'text',
      transformResponse: [function (data) { return data; }],
    }));

    var body = res && res.data;
    if (typeof body !== 'string' || body.length < 100) {
      if (logger) logger.warn(MODULE, 'Jina returned ' + (body ? body.length : 0) + ' chars for ' + url);
      return null;
    }

    var parsed = parseJinaResponse(body);

    // Require enough content for a real article — anything less is noise.
    if (!parsed.content || parsed.content.length < 200) {
      if (logger) logger.warn(MODULE, 'Jina content too short (' + (parsed.content || '').length + ' chars) for ' + url);
      return null;
    }

    if (logger) {
      logger.info(MODULE, 'Jina success: ' + parsed.content.length + ' chars in ' + (Date.now() - startedAt) + 'ms for ' + url);
    }

    return {
      title: parsed.title || null,
      content: parsed.content,
      sourceUrl: parsed.sourceUrl || url,
      length: parsed.content.length,
    };
  } catch (err) {
    var msg = err && err.message ? err.message : String(err);
    var status = err && err.response && err.response.status;
    if (logger) logger.warn(MODULE, 'Jina fetch failed (' + (status || 'network') + '): ' + msg);
    return null;
  }
}

/**
 * Parse Jina's text response. The format is:
 *   Title: <title>
 *   URL Source: <original url>
 *   Markdown Content:
 *   <markdown body...>
 *
 * Older / unauthenticated responses sometimes return raw markdown with no
 * header. We accept both shapes.
 */
function parseJinaResponse(body) {
  var title = null;
  var sourceUrl = null;
  var content = body;

  // Header parsing — only valid if the body actually starts with "Title:".
  var lines = body.split(/\r?\n/);
  if (lines.length > 3 && /^Title:/i.test(lines[0])) {
    var headerEnd = -1;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^Title:/i.test(line)) {
        title = line.replace(/^Title:\s*/i, '').trim();
      } else if (/^URL Source:/i.test(line)) {
        sourceUrl = line.replace(/^URL Source:\s*/i, '').trim();
      } else if (/^Markdown Content:/i.test(line)) {
        headerEnd = i + 1;
        break;
      } else if (line.trim() === '' && i > 0) {
        // Blank line before "Markdown Content:" — keep scanning.
        continue;
      }
    }
    if (headerEnd > 0) {
      content = lines.slice(headerEnd).join('\n').trim();
    }
  }

  return {
    title: title,
    sourceUrl: sourceUrl,
    content: content,
  };
}

module.exports = {
  fetchViaJina: fetchViaJina,
  parseJinaResponse: parseJinaResponse,
};
