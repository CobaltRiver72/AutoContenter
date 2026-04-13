'use strict';

/**
 * SSRF defense for outbound HTTP fetches.
 *
 * Threat model: an authenticated dashboard user submits a URL via
 * /api/drafts/manual-import, /api/drafts (single create), or any other
 * endpoint that ultimately calls fetchHtml / extractor._fetchAndExtract.
 * Without defense, that user could ask our server to:
 *
 *   - http://127.0.0.1/admin           (other services on the box)
 *   - http://10.0.0.1/                 (internal infra behind NAT)
 *   - http://169.254.169.254/latest/   (AWS/GCP IMDS — credential theft)
 *   - file:///etc/passwd               (different scheme entirely)
 *
 * Two layers of defense:
 *
 *   1. `assertSafeUrl(url)` — pre-flight check on the URL string. Rejects
 *      non-http(s) schemes and IP-literal hosts inside the blocked ranges.
 *      Pre-flight is needed because Node skips DNS for IP literals — our
 *      lookup hook never gets called.
 *
 *   2. `safeHttpAgent` / `safeHttpsAgent` — http(s).Agent instances whose
 *      `lookup` option intercepts DNS resolution. After the kernel resolves
 *      `evil.example.com → 127.0.0.1`, we throw before connect(). This
 *      defends against DNS rebinding and "innocent" hostnames pointing at
 *      private space. The agents are also used by axios for any redirects
 *      it follows internally, so a 302 from a public host to a private one
 *      is also caught.
 *
 * Use both together. `assertSafeUrl(url)` first, then pass the agents into
 * axios via `safeAxiosOptions()` (which also installs a `beforeRedirect`
 * hook that re-validates each hop in case the redirect target is itself an
 * IP literal — DNS lookup wouldn't catch that).
 */

var dns = require('dns');
var net = require('net');
var http = require('http');
var https = require('https');

/**
 * Allowed destination ports. Empty string means "default port for scheme"
 * (http→80, https→443) — URL.port is '' when the URL omits an explicit port.
 * Blocks common internal-service ports like 6379 (Redis), 25 (SMTP),
 * 11211 (memcached), 9200 (Elasticsearch), etc.
 */
var ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

/**
 * Detect IPv4 addresses in non-canonical forms that `net.isIP` misses:
 *   octal:   0177.0.0.1
 *   hex:     0x7f.0.0.1
 *   decimal: 2130706433
 *   short:   127.1
 * Returns the normalized dotted-quad form (e.g. '127.0.0.1') if the input
 * looks like ANY IPv4 encoding, or null if not. Used by assertSafeUrl to
 * reject bypass attempts before DNS is ever consulted.
 */
function normalizeIPv4(host) {
  if (typeof host !== 'string' || host.length === 0) return null;

  // Single number → 32-bit integer form (e.g. "2130706433")
  if (/^\d+$/.test(host)) {
    var n = parseInt(host, 10);
    if (!isFinite(n) || n < 0 || n > 0xFFFFFFFF) return null;
    return [(n >>> 24) & 0xFF, (n >>> 16) & 0xFF, (n >>> 8) & 0xFF, n & 0xFF].join('.');
  }

  // Dotted forms — 2, 3, or 4 parts, each possibly decimal/octal/hex
  var parts = host.split('.');
  if (parts.length < 2 || parts.length > 4) return null;

  function parsePart(s) {
    if (s.length === 0) return null;
    if (/^0x[0-9a-f]+$/i.test(s)) {
      var h = parseInt(s.slice(2), 16);
      return isFinite(h) ? h : null;
    }
    if (/^0[0-7]+$/.test(s)) {
      var o = parseInt(s, 8);
      return isFinite(o) ? o : null;
    }
    if (/^\d+$/.test(s)) {
      var d = parseInt(s, 10);
      return isFinite(d) ? d : null;
    }
    return null;
  }

  var nums = parts.map(parsePart);
  if (nums.indexOf(null) !== -1) return null;

  // Expand short-form
  // 4 parts: a.b.c.d — each 0-255
  // 3 parts: a.b.c → a.b.0..255 where c is 16-bit (0-65535)
  // 2 parts: a.b   → a.0.0..255 where b is 24-bit (0-16777215)
  var a, b, c;
  if (nums.length === 4) {
    if (nums.some(function (x) { return x < 0 || x > 255; })) return null;
    return nums.join('.');
  } else if (nums.length === 3) {
    a = nums[0]; b = nums[1]; c = nums[2];
    if (a < 0 || a > 255 || b < 0 || b > 255 || c < 0 || c > 0xFFFF) return null;
    return [a, b, (c >>> 8) & 0xFF, c & 0xFF].join('.');
  } else if (nums.length === 2) {
    a = nums[0]; b = nums[1];
    if (a < 0 || a > 255 || b < 0 || b > 0xFFFFFF) return null;
    return [a, (b >>> 16) & 0xFF, (b >>> 8) & 0xFF, b & 0xFF].join('.');
  }
  return null;
}

/**
 * IPv4 ranges that must never be reachable from a fetched URL.
 * Each entry is `[firstOctet, secondOctetMin?, secondOctetMax?]`.
 *
 *   0.0.0.0/8         this network
 *   10.0.0.0/8        RFC1918 private
 *   100.64.0.0/10     CGN
 *   127.0.0.0/8       loopback
 *   169.254.0.0/16    link-local (incl. AWS/GCP metadata 169.254.169.254)
 *   172.16.0.0/12     RFC1918 private
 *   192.0.0.0/24      IETF protocol assignments
 *   192.0.2.0/24      TEST-NET-1
 *   192.168.0.0/16    RFC1918 private
 *   198.18.0.0/15     network benchmark
 *   198.51.100.0/24   TEST-NET-2
 *   203.0.113.0/24    TEST-NET-3
 *   224.0.0.0/4       multicast
 *   240.0.0.0/4       reserved (incl. broadcast)
 */
function isBlockedIp(ip) {
  if (typeof ip !== 'string') return true;

  if (net.isIPv4(ip)) {
    var parts = ip.split('.');
    if (parts.length !== 4) return true;
    var a = parseInt(parts[0], 10);
    var b = parseInt(parts[1], 10);
    var c = parseInt(parts[2], 10);

    if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(c)) return true;

    if (a === 0) return true;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0) return true;          // includes 192.0.2.0/24
    if (a === 192 && b === 168) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a === 198 && b === 51 && c === 100) return true;
    if (a === 203 && b === 0 && c === 113) return true;
    if (a >= 224) return true;                       // multicast + reserved
    return false;
  }

  if (net.isIPv6(ip)) {
    // Conservative: block ALL IPv6. safeLookup forces family=4 so we
    // never encounter a public IPv6 in practice; this branch only fires
    // for IP-literal hostnames in URLs (e.g. http://[::1]/). Building a
    // proper IPv6 deny-list (::1, fc00::/7, fe80::/10, ::ffff:0:0/96,
    // 64:ff9b::/96, 2002::/16, ff00::/8 …) is significant work and our
    // sources are all IPv4-reachable, so we punt until there's a need.
    return true;
  }

  return true; // unknown format → block
}

/**
 * dns.lookup-compatible function passed into the http(s).Agent. Resolves
 * the hostname normally, then aborts with ESSRF if any resolved address
 * falls inside a blocked range.
 *
 * Two call shapes from Node / undici / follow-redirects:
 *   - `(hostname, callback)` — single address
 *   - `(hostname, { family, all, ... }, callback)` — when `all: true`
 *     the result is an Array<{ address, family }> instead of a string.
 *
 * We block if ANY returned address is unsafe (a hostname that
 * round-robins between public and private IPs would still be
 * exploitable otherwise).
 */
function safeLookup(hostname, options, callback) {
  var opts = options;
  var cb = callback;
  if (typeof options === 'function') {
    cb = options;
    opts = {};
  }
  // Force IPv4 — see isBlockedIp() comment. We don't have an IPv6 range
  // table yet, so we sidestep the problem by never asking the resolver
  // for AAAA records. Hostnames that are IPv6-only would return ENOTFOUND
  // (acceptable: news sources are all dual-stack or IPv4).
  opts = Object.assign({}, opts, { family: 4 });
  dns.lookup(hostname, opts, function (err, address, family) {
    if (err) return cb(err);

    // Array form (`all: true`)
    if (Array.isArray(address)) {
      for (var i = 0; i < address.length; i++) {
        var entry = address[i];
        var addr = entry && entry.address;
        if (!addr || isBlockedIp(addr)) {
          var blockErr = new Error('SSRF: blocked address ' + addr + ' for ' + hostname);
          blockErr.code = 'ESSRF';
          return cb(blockErr);
        }
      }
      return cb(null, address);
    }

    // Single-address form
    if (isBlockedIp(address)) {
      var singleErr = new Error('SSRF: blocked address ' + address + ' for ' + hostname);
      singleErr.code = 'ESSRF';
      return cb(singleErr);
    }
    cb(null, address, family);
  });
}

// Shared keep-alive agents. One pool per protocol; all callers share them
// so connection reuse works across modules.
var safeHttpAgent = new http.Agent({
  keepAlive: true,
  lookup: safeLookup,
});

var safeHttpsAgent = new https.Agent({
  keepAlive: true,
  lookup: safeLookup,
});

/**
 * Pre-flight: throw if the URL is structurally unsafe (bad scheme, IP
 * literal in a blocked range). Call this BEFORE handing the URL to axios.
 */
function assertSafeUrl(rawUrl) {
  var parsed;
  try {
    parsed = new URL(rawUrl);
  } catch (e) {
    var parseErr = new Error('Invalid URL: ' + rawUrl);
    parseErr.code = 'ESSRF';
    throw parseErr;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    var schemeErr = new Error('Blocked URL scheme: ' + parsed.protocol);
    schemeErr.code = 'ESSRF';
    throw schemeErr;
  }

  if (!ALLOWED_PORTS.has(parsed.port)) {
    var errPort = new Error('URL rejected: port ' + parsed.port + ' not in allowlist');
    errPort.code = 'BLOCKED_PORT';
    throw errPort;
  }

  var host = parsed.hostname;
  if (!host) {
    var hostErr = new Error('URL has no hostname: ' + rawUrl);
    hostErr.code = 'ESSRF';
    throw hostErr;
  }

  // Catch IPv4 literals in non-canonical encodings (octal, hex, decimal,
  // short-form) that `net.isIP` returns 0 for. glibc's resolver happily
  // normalizes these to the real IP at connect time, so without this
  // pre-flight they'd bypass the isBlockedIp check below.
  var normalized = normalizeIPv4(host);
  if (normalized !== null) {
    if (isBlockedIp(normalized)) {
      var errNorm = new Error('URL rejected: IPv4 literal ' + host + ' normalizes to blocked IP ' + normalized);
      errNorm.code = 'BLOCKED_IP';
      throw errNorm;
    }
    // Even if the normalized IP isn't blocked, reject any non-canonical
    // encoding. Keeps outbound traffic predictable and closes off future
    // bypasses against new resolver quirks.
    if (host !== normalized) {
      var errNC = new Error('URL rejected: non-canonical IPv4 encoding ' + host + ' (use ' + normalized + ' instead)');
      errNC.code = 'NON_CANONICAL_IP';
      throw errNC;
    }
  }

  if (net.isIP(host) && isBlockedIp(host)) {
    var ipErr = new Error('SSRF: blocked literal IP ' + host);
    ipErr.code = 'ESSRF';
    throw ipErr;
  }
}

/**
 * Returns axios options with the safe agents wired in plus a redirect hook.
 * Spread the result over your existing options:
 *
 *   await axios.get(url, Object.assign({ timeout: 15000 }, safeAxiosOptions()));
 *
 * The `beforeRedirect` hook is called by follow-redirects (axios's redirect
 * implementation) on every hop. We rebuild the URL from the redirect target
 * and re-run assertSafeUrl so a public host can't 302 us to an IP literal.
 */
function safeAxiosOptions(extra) {
  var opts = extra ? Object.assign({}, extra) : {};
  opts.httpAgent = safeHttpAgent;
  opts.httpsAgent = safeHttpsAgent;
  opts.beforeRedirect = function (options) {
    var protocol = options.protocol || 'http:';
    var hostname = options.hostname || options.host || '';
    var port = options.port ? ':' + options.port : '';
    var path = options.pathname || options.path || '/';
    assertSafeUrl(protocol + '//' + hostname + port + path);
  };
  return opts;
}

var { sanitizeAxiosError } = require('./sanitize-axios-error');

module.exports = {
  isBlockedIp: isBlockedIp,
  safeLookup: safeLookup,
  safeHttpAgent: safeHttpAgent,
  safeHttpsAgent: safeHttpsAgent,
  assertSafeUrl: assertSafeUrl,
  safeAxiosOptions: safeAxiosOptions,
  sanitizeAxiosError: sanitizeAxiosError,
};
