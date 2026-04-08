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

  var host = parsed.hostname;
  if (!host) {
    var hostErr = new Error('URL has no hostname: ' + rawUrl);
    hostErr.code = 'ESSRF';
    throw hostErr;
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

module.exports = {
  isBlockedIp: isBlockedIp,
  safeLookup: safeLookup,
  safeHttpAgent: safeHttpAgent,
  safeHttpsAgent: safeHttpsAgent,
  assertSafeUrl: assertSafeUrl,
  safeAxiosOptions: safeAxiosOptions,
};
