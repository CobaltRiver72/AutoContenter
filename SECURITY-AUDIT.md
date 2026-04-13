# HDF AutoPub — Security Audit

**Date:** 2026-04-12
**Branch audited:** `feature/infranodus-ui-and-batch-clusters`
**Scope:** 32 source files across `src/` and `public/`
**Method:** 6 parallel focused audits (auth, api.js, public+frontend, SSRF/HTTP, db+secrets+logging, pipeline workers)

## Summary

| Severity | Count |
|---|---|
| Critical | 8 |
| High | 18 |
| Medium | 19 |
| Low | 13 |
| **Total** | **58** |

**Verdict:** Solid foundations — prepared statements throughout, `httpOnly`+`sameSite=strict` cookies, bcrypt after first login, `assertSafeUrl` gatekeeper for most external fetches. But **8 critical issues** could each independently lead to full compromise, wasted AI spend, or stored credential theft. Do not expose to the open internet until the critical list is addressed.

---

## 🔴 Critical

### C1 — `publisher.uploadImage()` bypasses all SSRF defenses
**Location:** `src/modules/publisher.js:500-504`
**Issue:** `axios.get(imageUrl, { responseType: 'arraybuffer' })` — no `assertSafeUrl`, no `safeAxiosOptions`, no `maxContentLength`, no `maxRedirects`. Image URL comes from firehose markdown via `extractImageUrl()`.
**Exploit:** Malicious source markdown `![](http://169.254.169.254/latest/meta-data/iam/security-credentials/role-name)` → AWS IMDS creds fetched → uploaded to WordPress media library as a public attachment. Also works for `http://127.0.0.1:6379/` (Redis dump), internal admin panels, or a 50GB response → OOM.
**Fix:** Wire `uploadImage` through `assertSafeUrl` + `safeAxiosOptions({ maxContentLength: 10MB, maxRedirects: 3, timeout: 15000 })`.

### C2 — Image content-type fabricated from URL extension
**Location:** `src/modules/publisher.js:22-33, 507`
**Issue:** `guessMimeType()` trusts `path.extname(url)`. Response `Content-Type` never checked, bytes never sniffed. `Content-Disposition` filename and content-type sent to WordPress are derived purely from attacker URL.
**Exploit:** `https://evil.tld/payload.jpg?x=.svg` returning `<svg><script>alert(document.cookie)</script></svg>` → WordPress stores as SVG → stored XSS against any admin viewing media library.
**Fix:** Sniff magic bytes from response buffer; allowlist PNG/JPEG/GIF/WebP; reject SVG and unknown types.

### C3 — SQLite DB/WAL/SHM files have no permission hardening
**Location:** `src/utils/db.js:11-21`, default path `~/hdf-data/autopub.db`
**Issue:** No `fs.chmod(0o600)`. Parent dir created with default umask (0755). DB holds plaintext API keys, WP app password, FIREHOSE_TOKEN, SESSION_SECRET, bcrypt hashes.
**Exploit:** Any co-tenant or unprivileged user on the host reads `autopub.db` → full credential theft.
**Fix:** After `new Database(dbPath)`, `fs.chmodSync` dir to `0o700` and `.db`/`.db-wal`/`.db-shm` to `0o600` (non-Windows only).

### C4 — Stack traces with secrets persisted to the `logs` SQLite table
**Location:** `src/utils/logger.js:90-100`, `src/index.js:329-330`
**Issue:** Every `logger.error(...)` writes to the `logs` table via `writeToDb()`. Express error handler logs `err.stack` for every 5xx; axios errors can include Authorization headers. Table is readable via `GET /api/logs`.
**Exploit:** Any session holder reads every error string ever recorded → historical auth failures, SDK error echoes of prompts + keys.
**Fix:** Strip `stack` field before DB write (keep in file/console). Redact `Authorization:`, `Bearer ...`, `sk-...`, `fhm_...` patterns from `message`/`details` before `writeToDb`.

### C5 — Settings table stores all secrets in plaintext + `seedSettingsFromEnv` ignores rotations
**Location:** `src/utils/config.js:248-285`
**Issue:** All API keys seeded from env into `settings` via `INSERT OR IGNORE`. After first boot, `.env` rotations are silently ignored — DB copy is authoritative forever. Combined with C3, any local read = total compromise.
**Fix:** Either keep secrets env-only (don't seed), or encrypt values with a key derived outside the DB file. Switch to `INSERT ... ON CONFLICT DO UPDATE` for env-as-source-of-truth rotation.

### C6 — Publish loop lock race (unconditional UPDATE after SELECT)
**Location:** `src/workers/pipeline.js:493-496`
**Issue:** `SELECT … WHERE locked_by IS NULL OR lease_expires_at < datetime('now')` then `UPDATE drafts SET locked_by='publisher' WHERE id = ?` — no atomic CAS on the UPDATE.
**Exploit:** PM2 cluster mode or restart-during-publish → two workers both pass SELECT → both UPDATE → double-publish, double AI bill, duplicate WordPress posts.
**Fix:** Add `AND (locked_by IS NULL OR lease_expires_at < datetime('now'))` to the UPDATE and check `result.changes === 0` before proceeding. Extraction loop already does this (line 93); copy the pattern.

### C7 — Rewrite loop has same unconditional lock
**Location:** `src/workers/pipeline.js:255-258`
**Issue:** Unconditional `UPDATE drafts SET status='rewriting', locked_by='rewriter' WHERE id = ?`. `rewriteClusterManual()` and `rewriteAllExtractedClusters()` (line 444) fire-and-forget without locking at all.
**Exploit:** Admin double-clicks "Rewrite All" → two parallel Anthropic calls per cluster, final state is whichever raced last.
**Fix:** Same atomic CAS pattern as C6.

### C8 — No AbortController on in-flight external calls
**Location:** `src/workers/pipeline.js:104, 323, 548`
**Issue:** Extractor/rewriter/publisher HTTP requests have no abort signal. `shutdown()` clears locks but doesn't cancel requests. On crash-restart, in-flight requests keep running until socket timeout; after restart, recovered drafts are re-processed → same content billed twice.
**Exploit:** Crash-restart loop during a heavy rewrite burst → every draft billed N times.
**Fix:** Per-job `AbortController`, plumb signal into axios `{ signal }`, abort all on `shutdown()`.

---

## 🟠 High

### Auth & Sessions
- **H1** — No CSRF defense in depth. `sameSite: strict` is the only layer; `GET /logout` is CSRF-able. *Fix: add double-submit token, move logout to POST.* `src/index.js:310`
- **H2** — Default `MemoryStore` session backend leaks memory and wipes sessions on PM2 restart. *Fix: plug in `better-sqlite3-session-store`.* `src/routes/auth.js:47-60`

### api.js
- **H3** — `POST /api/wp-status` and `/test/wordpress` send Basic Auth (`WP_USERNAME:WP_APP_PASSWORD`) to whatever URL is stored as `WP_URL`, with no `assertSafeUrl`. Stolen session → set `WP_URL=https://attacker.example/` → app password exfiltrated. `api.js:1939, 2033, 2040`
- ~~**H4** — Batch endpoints with no cost cap or concurrency lock: `POST /drafts/publish-all-ready`, `/drafts/batch-fetch-images`, `/drafts/batch-rewrite`. Session hijack → drain Anthropic quota in seconds. *Fix: per-endpoint limiter + process-level boolean lock.* `api.js:2675, 2900, 3329`~~ **FIXED** — `AiCostGuard` wired into all four endpoints (cost=0 for non-AI); per-cluster lock for cluster rewrite; hourly sliding-window budget. `src/utils/ai-cost-guard.js`, `api.js`

### SSRF hardening (`src/utils/safe-http.js`)
- **H5** — IPv4 octal/hex/decimal encodings bypass `isBlockedIp`: `http://0177.0.0.1/`, `http://2130706433/`, `http://127.1/`. Pre-flight skips them because `net.isIP()` returns 0.
- **H6** — No port allowlist. Attacker targets `:6379`, `:25`, `:11211` on third parties for protocol smuggling or port scanning.
- ~~**H7** — AI/InfraNodus provider API keys leak if `err.config.headers` ever hits a generic error serializer. *Fix: centralized axios error sanitizer.*~~ **FIXED** — `sanitizeAxiosError()` in `src/utils/sanitize-axios-error.js`, re-exported via `safe-http.js`; applied to rewriter.js (3 sites), publisher.js `_wpRequest` (3 sites), infranodus.js (3 sites), api.js (9 sites)

### Frontend / CSP
- **H8** — Helmet CSP sets `script-src 'unsafe-inline'` AND `script-src-attr 'unsafe-inline'` (`src/index.js:244-250`). Neuters XSS mitigations entirely. *Fix: refactor inline `onclick=` to delegated listeners, drop `'unsafe-inline'`.*
- **H9** — CSP missing `frame-ancestors` directive. *Fix: add `frameAncestors: ["'none'"]`.*

### public.js
- **H10** — All 7 endpoints return `e.message` to anonymous clients. SQLite errors expose schema, malformed-date diagnostics. *Fix: log server-side, return generic `{ok:false,error:'internal'}`.* `public.js:63, 94, 131, 175, 206, 227, 251`

### PM2 / Process
- **H11** — `ecosystem.config.js` has no `user`/`uid` pinning. Runs as whoever starts it (often root). RCE in any module → full host.
- **H12** — `./logs/pm2-error.log` and `pm2-out.log` have no rotation. Disk-fill DoS over weeks; default world-readable.
- **H13** — `seedSettingsFromEnv` uses `INSERT OR IGNORE` → env rotations permanently ignored after first boot. (Overlaps C5.)

### Pipeline Resource Limits
- **H14** — Memory watchdog only checks `heapUsed`, ignores RSS. SQLite mmap + clustering queue live in RSS. Attacker floods 5MB markdown → heap stays <400MB, RSS hits 4GB → OOM. `src/index.js:375-398`
- **H15** — `_clusteringQueue` has no cap, no backpressure. `src/index.js:57`
- **H16** — Similarity worker thread input unbounded — oversized `fingerprint` blocks main event loop, OOMs worker → restart loop on same poisoned input.
- **H17** — Worker timeout (15s) rejects pending job but doesn't kill the worker. `src/modules/similarity.js:104-110`
- **H18** — Firehose reconnect: fixed 2s delay, no exponential backoff, no jitter. 401/500 from upstream → hot loop. `src/modules/firehose.js:60-181`

---

## 🟡 Medium

### api.js
- **M1** — `PUT /fuel/city` and `PUT /metals/city` pass array to `.run()` → always throws. `api.js:4190, 4211`
- **M2** — 30 routes return `err.message` without `sanitizeForClient`. `api.js:880, 899, 918, 937, 957, 1044, 1130, 1163, 1219, 1538, 1575, 1614, 1747, 4383, 4451, 4515, 4582`
- **M3** — `POST /firehose/connect` persists token with only prefix check. `api.js:2193-2266`
- **M4** — RapidAPI body echo reflected in JSON response (`api.js:1050, 1080`)
- ~~**M5** — `/clusters/:id/rewrite` and `/drafts/batch-rewrite` have no per-endpoint cost cap~~ **FIXED** — covered by H4 fix; per-cluster lock name allows parallel clusters while blocking double-click on same cluster

### SSRF / HTTP
- **M6** — `generateSeoFilename` uses `path.extname` on URL string (defense-in-depth)
- **M7** — Redirect re-validation URL rebuild mangles IPv6 brackets and non-default ports. `safe-http.js:214-220`
- **M8** — Extractor accepts any 200 response as HTML (no content-type check) → 5MB binary → JSDOM CPU DoS. `extractor.js:146-167`
- **M9** — InfraNodus axios call has no `maxContentLength`. `infranodus.js:52-64`

### DB / Secrets
- **M10** — `PUT /api/settings` rotates `WP_URL`/`FIREHOSE_TOKEN` with no re-auth. Stolen session = redirect publishing to attacker.
- **M11** — 2MB JSON body limit on settings → 400MB of writes under rate limit → disk fill via `settings` table. `src/index.js:286`
- **M12** — `data/` dir is 0755 (inconsistent with 0600 files)
- **M13** — `safeConfig` uses exclude-list; allowlist preferred

### Frontend
- **M14** — `win.document.write(html)` of editor content into popup. AI rewrite output executes with admin cookies. `dashboard.js:4246-4249`
- **M15** — Inline-edit uses unsanitized `city` in `innerHTML` and `onclick`. `dashboard.js:6301, 6346`

### Pipeline
- **M16** — EventSource has no per-event size cap. 2GB SSE event → OOM.
- **M17** — Stuck-draft recovery uses `-5 minutes` but lease is 8 minutes → races still-running worker. `pipeline.js:653-683`
- **M18** — Last-Event-ID CRLF injection from compromised firehose upstream

### Auth
- **M19** — Non-constant-time `===` password check on first login (before bcrypt bootstraps). `auth.js:112`

---

## 🟢 Low

- **L1** — `?error=1` in login URL leaks failure to referrer
- **L2** — `connect.sid` default cookie name (no `name:` override)
- **L3** — `escapeHtml` doesn't encode `'` — single-quoted attribute contexts fragile
- **L4** — Several `target="_blank"` without `rel="noopener noreferrer"` (`dashboard.js:1904, 2900, 3472, 3555, 5985, 6703`)
- **L5** — `count` interpolated raw into innerHTML (`dashboard.js:1523`)
- **L6** — `drafts/status?url=` no length cap
- **L7** — `check-urls` runs 500 sequential queries instead of single `IN (...)`
- **L8** — Jina URL string concatenation without `encodeURI`. `extractor-jina.js:45`
- **L9** — No per-host concurrency cap on extractor
- **L10** — WAL `synchronous=NORMAL` on secrets DB — power-loss risk
- **L11** — Migration `try/catch` swallows all errors (not just `duplicate column`)
- **L12** — `_closeEventSource` doesn't call `removeAllListeners` — listener leak on repeated reconnect
- **L13** — Trust proxy = 1 is fragile if deployment hops change. `src/index.js:267`

---

## 📋 Remediation Roadmap

### Week 1 — Must-fix-before-internet-exposure
1. **C1 + C2** — uploadImage SSRF + magic-byte sniffing + block SVG (`publisher.js`)
2. **C3** — `fs.chmod` DB + WAL + SHM + dir on boot (`db.js`)
3. **C4** — strip stacks from DB writes + redact regex (`logger.js`)
4. **C6 + C7** — atomic CAS on worker lock UPDATEs (`pipeline.js`)
5. **C8** — AbortController plumbing for rewriter/publisher/extractor (`pipeline.js` + `rewriter.js` + `publisher.js`)
6. **H3** — wrap WP test endpoints in `assertSafeUrl` (`api.js`)
7. **H5 + H6** — harden `isBlockedIp` against octal/hex/decimal, add port allowlist (`safe-http.js`)

### Week 2
- **C5** — decide secrets strategy (env-only vs encrypted-at-rest), fix `seedSettingsFromEnv`
- **H8 + H9** — refactor inline `onclick` handlers, drop `'unsafe-inline'` from CSP, add `frame-ancestors`
- **H10** — sanitize `public.js` error responses
- **H14 + H15** — memory watchdog on RSS, cap `_clusteringQueue`
- **H11 + H12** — PM2 run as non-root + log rotation
- **H1** — CSRF double-submit token
- **H2** — swap MemoryStore for `better-sqlite3-session-store`
- **H16 + H17** — bound similarity worker input, terminate-on-timeout
- **H18** — firehose reconnect exponential backoff + jitter
- ~~**H4** — cost caps on batch endpoints~~ **FIXED** (see above)

### Week 3 (Medium batch)
- **M1** → M19 — mostly 5-15 minute fixes each
- Focus: `sanitizeForClient` rollout, frontend XSS hardening, settings endpoint re-auth

### Backlog
- All Lows
- Threat model decision: single-admin internet exposure vs VPN-only vs multi-user?

---

## Appendix — Files Audited

| Agent | Files |
|---|---|
| Auth & sessions | `src/routes/auth.js`, `src/routes/dashboard.js`, `src/index.js` (auth middleware) |
| API routes | `src/routes/api.js` |
| Public + frontend | `src/routes/public.js`, `public/js/dashboard.js`, `public/index.html` |
| SSRF / HTTP | `src/utils/safe-http.js`, `src/modules/extractor.js`, `src/modules/extractor-jina.js`, `src/modules/publisher.js`, `src/modules/rewriter.js`, `src/modules/infranodus.js`, `src/modules/firehose.js` |
| DB / secrets / config / logging | `src/utils/db.js`, `src/utils/config.js`, `src/utils/logger.js`, `src/utils/draft-helpers.js`, `ecosystem.config.js`, `package.json`, `src/index.js` (boot) |
| Pipeline workers | `src/workers/pipeline.js`, `src/workers/similarity-worker.js`, `src/modules/similarity.js`, `src/modules/firehose.js`, `src/modules/buffer.js` |
