# AI Security Fixes (H4, H7, M5) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three open AI-related findings from `SECURITY-AUDIT.md` — H4 (no cost cap on batch AI endpoints), H7 (API keys leak through axios error serializer), M5 (single-cluster rewrite has no concurrency guard) — without breaking existing rewrite/publish flows.

**Architecture:**
1. A single small utility `src/utils/sanitize-axios-error.js` returns a redacted `{ message, status, code }` view of any axios error. All existing error-logging sites that touch axios errors switch to it.
2. A single small utility `src/utils/ai-cost-guard.js` provides (a) per-endpoint boolean process-locks that reject overlapping calls and (b) a sliding 60-minute counter whose limit comes from the existing `settings` table (`MAX_AI_REWRITES_PER_HOUR`, default 60). The four batch/manual AI endpoints in `api.js` wrap their bodies in `guard.acquire(name)` / `guard.release(name)`.
3. No DB schema change. No new dependencies. No test framework is added — this codebase has none. Verification is syntax check (`node -c`) + a scripted acquire/release smoke test + a manual curl.

**Tech Stack:** Node.js, Express, better-sqlite3 (sync), axios 1.14, existing `config.getSetting()` / `config.setSetting()` for settings.

**Reference files:**
- `src/routes/api.js` — four target endpoints at lines 2689, 2914, 3343, 3372
- `src/utils/safe-http.js` — where `sanitizeAxiosError` will be re-exported from
- `src/utils/config.js` — for `MAX_AI_REWRITES_PER_HOUR` default seed
- `SECURITY-AUDIT.md` — H4, H7, M5 full descriptions

---

## File Structure

**Files to create:**
- `src/utils/sanitize-axios-error.js` — single function, ~40 lines
- `src/utils/ai-cost-guard.js` — a small class with `acquire`/`release`/`status`, ~80 lines
- `scripts/smoke-ai-cost-guard.js` — standalone smoke test (no framework), ~30 lines

**Files to modify:**
- `src/utils/safe-http.js` — re-export `sanitizeAxiosError`
- `src/utils/config.js` — seed `MAX_AI_REWRITES_PER_HOUR = 60` default in `seedSettingsFromEnv`
- `src/routes/api.js` — wire the guard into four endpoints, swap raw error logging to sanitizer in WP / RapidAPI catch blocks (~9 sites)
- `src/modules/rewriter.js` — swap `err.message` logging to sanitizer in primary/fallback catch blocks (3 sites)
- `src/modules/publisher.js` — swap the WP `err.response.data` serializer in `_wpRequest` error path to sanitizer
- `src/modules/infranodus.js` — swap `err.message` logging to sanitizer in `analyzeText` and `enhanceArticle`

---

## Task 1: `sanitizeAxiosError()` helper

**Files:**
- Create: `src/utils/sanitize-axios-error.js`
- Modify: `src/utils/safe-http.js` (add re-export at the bottom)

**Why this exists:** An axios error holds the original request config on `err.config`, including `err.config.headers.Authorization`. A generic `logger.error(err)` or `JSON.stringify(err)` serializes that header directly to logs — and before C4 was fixed, straight into the `logs` SQLite table. Even after C4, the file + console logger still sees the raw object. We also want to strip any upstream response body that echoes an `Authorization` or `x-api-key` value back. A single helper means there is one right answer.

- [ ] **Step 1.1: Create the helper**

Write `src/utils/sanitize-axios-error.js`:

```js
'use strict';

/**
 * Reduce an axios error (or any Error) to a log-safe object with no
 * request config, no headers, no Authorization tokens, and no
 * response body that might echo credentials.
 *
 * Output shape is always: { message, status, code, url, method, data }
 * where `data` is a scrubbed slice of the upstream response body (if any).
 *
 * Usage:
 *   logger.error('rewriter', 'Primary failed: ' + sanitizeAxiosError(err).message);
 *   // or
 *   logger.error('rewriter', 'Primary failed', sanitizeAxiosError(err));
 */

var SECRET_PATTERNS = [
  /sk-ant-[a-zA-Z0-9_\-]{10,}/g,
  /sk-or-v1-[a-zA-Z0-9_\-]{10,}/g,
  /sk-[a-zA-Z0-9_\-]{20,}/g,
  /Bearer\s+[a-zA-Z0-9_\-\.]{10,}/gi,
  /fhm_[a-zA-Z0-9_\-]{10,}/g,
  /Basic\s+[A-Za-z0-9+/=]{10,}/gi,
];

function scrubString(s) {
  if (typeof s !== 'string') return s;
  var out = s;
  for (var i = 0; i < SECRET_PATTERNS.length; i++) {
    out = out.replace(SECRET_PATTERNS[i], '[REDACTED]');
  }
  return out;
}

function sanitizeAxiosError(err) {
  if (!err) return { message: 'unknown error' };

  var out = {
    message: scrubString(err.message || String(err)),
    status: null,
    code: err.code || null,
    url: null,
    method: null,
    data: null,
  };

  if (err.response) {
    out.status = err.response.status || null;
    // Response body can contain anything. Take at most 500 chars and
    // scrub before including.
    var body = err.response.data;
    if (body != null) {
      var bodyStr;
      try { bodyStr = typeof body === 'string' ? body : JSON.stringify(body); }
      catch (e) { bodyStr = '[unserializable]'; }
      out.data = scrubString(bodyStr).slice(0, 500);
    }
  }

  if (err.config) {
    // URL and method are safe; headers are NOT.
    out.url = scrubString(err.config.url || '');
    out.method = (err.config.method || '').toUpperCase() || null;
  }

  return out;
}

module.exports = { sanitizeAxiosError: sanitizeAxiosError };
```

- [ ] **Step 1.2: Re-export from safe-http.js**

Open `src/utils/safe-http.js`, find the existing `module.exports = { ... }` block, and add `sanitizeAxiosError` to it:

```js
// At the top of safe-http.js (near the other requires):
var { sanitizeAxiosError } = require('./sanitize-axios-error');

// In module.exports, add:
module.exports = {
  assertSafeUrl: assertSafeUrl,
  safeAxiosOptions: safeAxiosOptions,
  isBlockedIp: isBlockedIp,
  sanitizeAxiosError: sanitizeAxiosError,   // ← new
};
```

Do not remove any existing exports.

- [ ] **Step 1.3: Syntax check**

Run:
```bash
node -c src/utils/sanitize-axios-error.js && node -c src/utils/safe-http.js && echo OK
```
Expected: `OK`.

- [ ] **Step 1.4: Unit smoke test**

Run inline (no test framework — paste the block into a terminal):
```bash
node -e "
var { sanitizeAxiosError } = require('./src/utils/sanitize-axios-error');
var err = new Error('Request failed with status 401');
err.code = 'ERR_BAD_REQUEST';
err.config = { url: 'https://api.anthropic.com/v1/messages', method: 'post',
               headers: { Authorization: 'Bearer sk-ant-abc123xyz789secret' } };
err.response = { status: 401, data: { error: 'Invalid key sk-ant-abc123xyz789secret' } };
var s = sanitizeAxiosError(err);
console.log(JSON.stringify(s, null, 2));
if (JSON.stringify(s).indexOf('sk-ant-') !== -1) { console.error('LEAK'); process.exit(1); }
if (JSON.stringify(s).indexOf('Authorization') !== -1) { console.error('LEAK HEADER'); process.exit(1); }
console.log('PASS');
"
```
Expected output ends with `PASS` — no `sk-ant-` or `Authorization` substring anywhere in the serialized result.

- [ ] **Step 1.5: Commit**

```bash
git add src/utils/sanitize-axios-error.js src/utils/safe-http.js
git commit -m "feat(security): add sanitizeAxiosError helper for H7

Strips request headers and scrubs Bearer/sk-ant/sk-or/Basic tokens
from axios error message and response body before logging. Used by
rewriter, publisher, infranodus, and api.js catch blocks in later
tasks. Closes first half of H7."
```

---

## Task 2: `ai-cost-guard.js` — per-endpoint lock + hourly counter

**Files:**
- Create: `src/utils/ai-cost-guard.js`

**Why this exists:** H4 and M5 both need (a) a boolean "is this endpoint already running?" lock so double-clicks and script loops don't fan-out, and (b) an hourly ceiling so a hijacked session can't drain the Anthropic/OpenAI quota even over minutes. A per-process in-memory counter is enough — this app runs in a single Node process (see `ecosystem.config.js`), and a restart resetting the counter is acceptable (a restart takes ~5s and the attacker's session still has to beat rate-limit middleware to get there).

- [ ] **Step 2.1: Create the module**

Write `src/utils/ai-cost-guard.js`:

```js
'use strict';

/**
 * In-process concurrency + cost guard for AI-spending endpoints.
 *
 * Two layers:
 *   1. Per-endpoint boolean lock — at most one body of work with a given
 *      name ("batch-rewrite", "cluster-rewrite", "publish-all",
 *      "batch-fetch-images") can be active at a time. Double-click or
 *      a scripted retry loop gets "already running" instead of a
 *      parallel AI spend.
 *   2. Sliding 60-minute counter across ALL endpoints combined —
 *      acquire() bumps the counter by `cost` (default 1), refuses if
 *      the next bump would exceed `hourlyLimit`. Each entry ages out
 *      after 60 minutes.
 *
 * The counter is intentionally cross-endpoint: a hijacked session
 * should not get 60 batch rewrites AND 60 cluster rewrites per hour.
 *
 * Construct once at boot, reuse. `hourlyLimit` is read lazily on
 * every call so Settings UI changes take effect without a restart.
 */

class AiCostGuard {
  constructor(opts) {
    opts = opts || {};
    this._getLimit = opts.getLimit || function () { return 60; };
    this._locks = Object.create(null);
    this._ledger = []; // array of { at: ms, cost: n, name: string }
  }

  _prune() {
    var cutoff = Date.now() - 60 * 60 * 1000;
    while (this._ledger.length && this._ledger[0].at < cutoff) {
      this._ledger.shift();
    }
  }

  _currentSpend() {
    this._prune();
    var total = 0;
    for (var i = 0; i < this._ledger.length; i++) total += this._ledger[i].cost;
    return total;
  }

  /**
   * Try to acquire the lock + budget slot.
   * Returns { ok: true } on success, or
   *         { ok: false, reason: 'locked' | 'budget', detail: string } on failure.
   */
  acquire(name, cost) {
    cost = (typeof cost === 'number' && cost > 0) ? cost : 1;

    if (this._locks[name]) {
      return { ok: false, reason: 'locked',
               detail: 'Endpoint "' + name + '" is already running. Wait for it to finish.' };
    }

    var limit = this._getLimit();
    var spent = this._currentSpend();
    if (spent + cost > limit) {
      return { ok: false, reason: 'budget',
               detail: 'Hourly AI budget exceeded (' + spent + '/' + limit +
                       '). Wait for the oldest call to age out or raise MAX_AI_REWRITES_PER_HOUR in Settings.' };
    }

    this._locks[name] = true;
    this._ledger.push({ at: Date.now(), cost: cost, name: name });
    return { ok: true };
  }

  release(name) {
    delete this._locks[name];
  }

  status() {
    this._prune();
    return {
      locks: Object.keys(this._locks),
      spentLastHour: this._currentSpend(),
      limit: this._getLimit(),
      entries: this._ledger.length,
    };
  }
}

module.exports = { AiCostGuard: AiCostGuard };
```

- [ ] **Step 2.2: Syntax check**

```bash
node -c src/utils/ai-cost-guard.js && echo OK
```
Expected: `OK`.

- [ ] **Step 2.3: Unit smoke test**

```bash
node -e "
var { AiCostGuard } = require('./src/utils/ai-cost-guard');
var g = new AiCostGuard({ getLimit: function () { return 3; } });

// Lock works
var a = g.acquire('batch-rewrite'); if (!a.ok) { console.error('fail 1'); process.exit(1); }
var b = g.acquire('batch-rewrite'); if (b.ok || b.reason !== 'locked') { console.error('fail 2'); process.exit(1); }
g.release('batch-rewrite');

// Budget limit works
g.acquire('a'); g.acquire('b');
// now spent = 3 (a,b from this block + the earlier a that was released — counter persists)
// Wait: spent includes released entries (by design, ledger ≠ locks).
var d = g.acquire('c');
if (d.ok) { console.error('fail 3 — should have been rejected by budget'); process.exit(1); }
if (d.reason !== 'budget') { console.error('fail 4 — wrong reason ' + d.reason); process.exit(1); }
console.log('status:', JSON.stringify(g.status()));
console.log('PASS');
"
```
Expected: ends with `PASS` and a status line like `{\"locks\":[\"a\",\"b\"],\"spentLastHour\":3,\"limit\":3,\"entries\":3}`.

- [ ] **Step 2.4: Commit**

```bash
git add src/utils/ai-cost-guard.js
git commit -m "feat(security): add AiCostGuard for H4/M5

Per-endpoint boolean lock + sliding 60-minute cross-endpoint cost
counter. Limit is read lazily from a getLimit callback so Settings
changes take effect without restart. Wired into api.js in later tasks."
```

---

## Task 3: Default setting `MAX_AI_REWRITES_PER_HOUR`

**Files:**
- Modify: `src/utils/config.js` — `seedSettingsFromEnv` block

**Why this exists:** The guard reads its limit lazily via `config.getSetting('MAX_AI_REWRITES_PER_HOUR')`. If the key is missing from the `settings` table, the fallback is the hardcoded default (60). Seeding gives admins a row to edit in Settings UI.

- [ ] **Step 3.1: Add the seed row**

Open `src/utils/config.js`. Find `seedSettingsFromEnv` (around line 248). Inside the existing list of `INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)` calls, add:

```js
insertSetting.run('MAX_AI_REWRITES_PER_HOUR', '60');
```

Place it alphabetically or at the end of the AI-related seeds — match whatever local convention the file uses.

- [ ] **Step 3.2: Syntax check + boot test**

```bash
node -c src/utils/config.js && echo OK
```
Expected: `OK`.

Start the app once to let the seed run, then verify the row exists:
```bash
node -e "
var Database = require('better-sqlite3');
var os = require('os');
var path = require('path');
var db = new Database(path.join(os.homedir(), 'hdf-data', 'autopub.db'));
console.log(db.prepare(\"SELECT key, value FROM settings WHERE key = 'MAX_AI_REWRITES_PER_HOUR'\").get());
"
```
Expected: `{ key: 'MAX_AI_REWRITES_PER_HOUR', value: '60' }` (or whatever the admin has since changed it to).

- [ ] **Step 3.3: Commit**

```bash
git add src/utils/config.js
git commit -m "feat(config): seed MAX_AI_REWRITES_PER_HOUR default

Provides a row in the settings table so admins can tune the AI
budget cap from the Settings UI instead of editing code. Used by
ai-cost-guard in the next tasks."
```

---

## Task 4: Instantiate `AiCostGuard` in api.js, wire into `/drafts/batch-rewrite` (H4)

**Files:**
- Modify: `src/routes/api.js`
  - Near top of `createApiRouter(deps)` (after existing requires, ~line 70): instantiate the guard
  - `POST /drafts/batch-rewrite` at line 3343: wrap body

**Why:** `batch-rewrite` is the single biggest AI-cost exposure — it fan-outs to every cluster in `draft` status at once. A hijacked session hitting it in a loop can run up thousands of dollars in minutes.

- [ ] **Step 4.1: Instantiate the guard at the top of createApiRouter**

Open `src/routes/api.js`. After line 70 (the `deps` destructure), add:

```js
  var { AiCostGuard } = require('../utils/ai-cost-guard');
  var { getSetting } = require('../utils/config');
  var aiGuard = new AiCostGuard({
    getLimit: function () {
      var v = parseInt(getSetting('MAX_AI_REWRITES_PER_HOUR'), 10);
      return (isNaN(v) || v <= 0) ? 60 : v;
    },
  });
```

If `getSetting` is not exported from `src/utils/config.js`, find whatever export the existing `api.js` uses to read settings (search for `getSetting\|getConfig` in api.js) and use that. Do not add a new config API if one exists.

- [ ] **Step 4.2: Wrap `POST /drafts/batch-rewrite`**

Replace the current body of the route at line 3343:

```js
  router.post('/drafts/batch-rewrite', async function (req, res) {
    var slot = aiGuard.acquire('batch-rewrite');
    if (!slot.ok) {
      return res.status(429).json({
        success: false,
        error: slot.detail,
        reason: slot.reason,
      });
    }
    try {
      if (!scheduler || typeof scheduler.rewriteAllExtractedClusters !== 'function') {
        return res.status(500).json({ success: false, error: 'Pipeline not available or missing rewriteAllExtractedClusters method' });
      }

      var result = await scheduler.rewriteAllExtractedClusters();

      logger.info('api', 'Batch rewrite: queued=' + result.queued + ', failed=' + result.failed);

      res.json({
        success: true,
        message: 'Batch rewrite started',
        stats: {
          clustersQueued: result.queued,
          clustersFailed: result.failed,
          errors: (result.errors || []).slice(0, 5),
        },
      });
    } catch (err) {
      logger.error('api', 'Batch rewrite failed: ' + err.message);
      res.status(500).json({ success: false, error: sanitizeForClient(err, 'Batch rewrite failed') });
    } finally {
      aiGuard.release('batch-rewrite');
    }
  });
```

Note: the guard is released in `finally` so both the happy path and the error path release it, but the rewrite cost stays charged against the hourly budget either way — that's intentional. If you want failed rewrites to refund the budget slot, that's a separate policy decision and not in scope here.

- [ ] **Step 4.3: Syntax check + smoke test**

```bash
node -c src/routes/api.js && echo OK
```
Expected: `OK`.

Start the dev server and hit the endpoint twice in quick succession with `xh` or `curl`:
```bash
npm run dev &
sleep 3
# First call starts the job
curl -s -X POST -b "connect.sid=<YOUR_SESSION>" http://localhost:3000/api/drafts/batch-rewrite | head
# Second call (should be rejected as 'locked' if the first is still running)
curl -s -X POST -b "connect.sid=<YOUR_SESSION>" http://localhost:3000/api/drafts/batch-rewrite
```
Expected on the second call: HTTP 429 with `{"success":false,"error":"Endpoint \"batch-rewrite\" is already running...","reason":"locked"}`.

Kill the dev server after verifying.

- [ ] **Step 4.4: Commit**

```bash
git add src/routes/api.js
git commit -m "fix(security): wire AiCostGuard into /drafts/batch-rewrite (H4)

Per-endpoint lock + hourly budget cap. A hijacked session hitting
the endpoint in a loop now gets 429 locked on the second call and
the hourly counter refuses further calls once MAX_AI_REWRITES_PER_HOUR
is reached. Budget resets via sliding 60-minute window."
```

---

## Task 5: Wire guard into `POST /clusters/:clusterId/rewrite` (M5)

**Files:**
- Modify: `src/routes/api.js` — route at line 3372

**Why:** M5 is the per-cluster twin of H4. The batch-rewrite lock does not cover this endpoint — double-clicking "Rewrite" on a cluster card still fires two parallel AI calls. We also want per-cluster calls to share the same hourly budget pool as batch calls (that's why the guard is cross-endpoint by design — see Task 2).

- [ ] **Step 5.1: Wrap the route**

Replace the current body of `POST /clusters/:clusterId/rewrite` at line 3372:

```js
  router.post('/clusters/:clusterId/rewrite', async function (req, res) {
    var clusterId = parseId(req.params.clusterId);
    if (!clusterId) return res.status(400).json({ success: false, error: 'Invalid cluster id' });

    // Per-cluster lock name so two *different* clusters can still rewrite in
    // parallel — only the SAME cluster is blocked from double-click.
    var lockName = 'cluster-rewrite:' + clusterId;
    var slot = aiGuard.acquire(lockName);
    if (!slot.ok) {
      return res.status(429).json({
        success: false,
        error: slot.detail,
        reason: slot.reason,
      });
    }
    try {
      if (!scheduler || typeof scheduler.rewriteClusterManual !== 'function') {
        return res.status(500).json({ success: false, error: 'Pipeline not available' });
      }

      var result = await scheduler.rewriteClusterManual(clusterId);

      res.json({
        success: true,
        message: 'Rewrite started for cluster #' + clusterId,
        primaryDraftId: result.primaryDraftId,
      });
    } catch (err) {
      logger.error('api', 'Cluster rewrite failed: ' + err.message);
      res.status(500).json({ success: false, error: sanitizeForClient(err, 'Cluster rewrite failed') });
    } finally {
      aiGuard.release(lockName);
    }
  });
```

- [ ] **Step 5.2: Syntax check**

```bash
node -c src/routes/api.js && echo OK
```
Expected: `OK`.

- [ ] **Step 5.3: Commit**

```bash
git add src/routes/api.js
git commit -m "fix(security): wire AiCostGuard into cluster rewrite (M5)

Per-cluster lock name so two different clusters can still rewrite
in parallel, but double-clicking the same cluster gets 429 locked.
Shares the global hourly budget pool with batch-rewrite."
```

---

## Task 6: Wire guard into `POST /drafts/publish-all-ready` (H4)

**Files:**
- Modify: `src/routes/api.js` — route at line 2689

**Why:** `publish-all-ready` does NOT call the AI rewriter directly — it only pushes already-rewritten drafts to WordPress. But it DOES call `publisher.uploadImage()`, which hits arbitrary external image URLs one per draft, and can itself be abused as an SSRF amplifier or a way to burn through the C1 image-bytes cap. More importantly, a double-click fans out the loop and can cause WP duplicate-post errors. We wrap it with the guard's lock (but use a separate `cost: 0` so it doesn't eat the AI budget).

- [ ] **Step 6.1: Wrap the route**

The existing route is synchronous with a fire-and-forget async IIFE. We need the lock released when the IIFE finishes, NOT when the outer function returns. Modify the structure:

```js
  router.post('/drafts/publish-all-ready', function (req, res) {
    var slot = aiGuard.acquire('publish-all-ready', 0); // cost: 0 — not an AI spend
    if (!slot.ok) {
      return res.status(429).json({
        success: false,
        error: slot.detail,
        reason: slot.reason,
      });
    }

    try {
      var publisherMod = deps.publisher || (deps.scheduler && deps.scheduler.publisher);
      if (publisherMod && !publisherMod.enabled && typeof publisherMod.reinit === 'function') {
        publisherMod.reinit();
      }
      if (!publisherMod || !publisherMod.enabled) {
        aiGuard.release('publish-all-ready');
        return res.status(400).json({ success: false, error: 'WordPress publisher not configured. Set WP credentials in Settings.' });
      }

      var readyDrafts = db.prepare(
        "SELECT id FROM drafts WHERE status = 'ready' AND cluster_role = 'primary' " +
        "AND rewritten_html IS NOT NULL AND LENGTH(rewritten_html) > 100"
      ).all();

      if (readyDrafts.length === 0) {
        aiGuard.release('publish-all-ready');
        return res.json({ success: true, queued: 0, message: 'No ready articles found' });
      }

      // Respond immediately; the background loop owns the lock until it finishes.
      res.json({ success: true, queued: readyDrafts.length, message: 'Publishing ' + readyDrafts.length + ' drafts' });

      (async function () {
        try {
          for (var i = 0; i < readyDrafts.length; i++) {
            // ... EXISTING LOOP BODY UNCHANGED ...
          }
        } catch (bgErr) {
          logger.error('api', 'publish-all-ready background loop failed: ' + bgErr.message);
        } finally {
          aiGuard.release('publish-all-ready');
        }
      })();
    } catch (err) {
      aiGuard.release('publish-all-ready');
      logger.error('api', 'publish-all-ready setup failed: ' + err.message);
      res.status(500).json({ success: false, error: sanitizeForClient(err, 'publish-all-ready failed') });
    }
  });
```

**Important:** Preserve the existing loop body between the `for (var i = 0; ...)` and the `}` — do not rewrite it. Only add the surrounding structure and the `try/finally { aiGuard.release }` around the IIFE.

- [ ] **Step 6.2: Syntax check**

```bash
node -c src/routes/api.js && echo OK
```
Expected: `OK`.

- [ ] **Step 6.3: Commit**

```bash
git add src/routes/api.js
git commit -m "fix(security): wire AiCostGuard into publish-all-ready (H4)

Uses cost=0 so it doesn't eat the AI budget (it only publishes
already-rewritten drafts). The lock is held by the background IIFE
and released in the IIFE's finally block, so double-clicks during
a publish run are rejected with 429 locked."
```

---

## Task 7: Wire guard into `POST /drafts/batch-fetch-images` (H4)

**Files:**
- Modify: `src/routes/api.js` — route at line 2914

**Why:** Same shape as Task 6 — no AI spend, but fires hundreds of outbound axios calls through `assertSafeUrl` for up to 500 drafts. A hijacked session double-click triggers a parallel SSRF fan-out. `cost: 0` again.

- [ ] **Step 7.1: Wrap the route**

Same pattern as Task 6:

```js
  router.post('/drafts/batch-fetch-images', function (req, res) {
    var slot = aiGuard.acquire('batch-fetch-images', 0);
    if (!slot.ok) {
      return res.status(429).json({
        success: false,
        error: slot.detail,
        reason: slot.reason,
      });
    }

    try {
      var missingImages = db.prepare(
        "SELECT id, source_url, source_domain FROM drafts " +
        "WHERE (featured_image IS NULL OR featured_image = '') " +
        "AND extraction_status IN ('success', 'cache', 'fallback') " +
        "AND status != 'failed' " +
        "ORDER BY created_at DESC " +
        "LIMIT 500"
      ).all();

      if (missingImages.length === 0) {
        aiGuard.release('batch-fetch-images');
        return res.json({ success: true, message: 'All articles already have images', count: 0 });
      }

      logger.info('api', 'Batch image fetch: starting for ' + missingImages.length + ' articles');

      res.json({ success: true, queued: missingImages.length, message: 'Fetching images for ' + missingImages.length + ' articles' });

      (async function () {
        try {
          // ... EXISTING async loop body UNCHANGED ...
        } catch (bgErr) {
          logger.error('api', 'batch-fetch-images background loop failed: ' + bgErr.message);
        } finally {
          aiGuard.release('batch-fetch-images');
        }
      })();
    } catch (err) {
      aiGuard.release('batch-fetch-images');
      logger.error('api', 'batch-fetch-images setup failed: ' + err.message);
      res.status(500).json({ success: false, error: sanitizeForClient(err, 'batch-fetch-images failed') });
    }
  });
```

Same rule: **do not rewrite the existing async loop body** — wrap around it.

- [ ] **Step 7.2: Syntax check**

```bash
node -c src/routes/api.js && echo OK
```
Expected: `OK`.

- [ ] **Step 7.3: Commit**

```bash
git add src/routes/api.js
git commit -m "fix(security): wire AiCostGuard into batch-fetch-images (H4)

cost=0 lock prevents double-click fan-out of 500 outbound image
fetches. Uses the same release-in-IIFE-finally pattern as
publish-all-ready."
```

---

## Task 8: Swap raw axios error logging in `rewriter.js` → `sanitizeAxiosError` (H7)

**Files:**
- Modify: `src/modules/rewriter.js`

**Why:** The rewriter module logs `err.message` today (safe in isolation), but the catch sites pass the full error object into the logger in a few places. Switching to `sanitizeAxiosError(err)` is defense-in-depth — if someone later changes the logger signature to accept an object, nothing leaks.

- [ ] **Step 8.1: Add the require**

Near the top of `src/modules/rewriter.js` (after the existing requires), add:
```js
var { sanitizeAxiosError } = require('../utils/safe-http');
```

- [ ] **Step 8.2: Replace error logging in primary-failed catch**

Find the primary-failed catch block (around line 966):
```js
this.logger.error('rewriter', 'PRIMARY FAILED (' + provider + '): ' + primaryErr.message);
```
Replace with:
```js
this.logger.error('rewriter', 'PRIMARY FAILED (' + provider + '): ' + sanitizeAxiosError(primaryErr).message);
```

- [ ] **Step 8.3: Replace error logging in fallback-failed catch**

Find the fallback-failed catch block (around line 1011):
```js
self.logger.error('rewriter', 'FALLBACK FAILED (' + fbProvider + '): ' + fbErr.message);
```
Replace with:
```js
self.logger.error('rewriter', 'FALLBACK FAILED (' + fbProvider + '): ' + sanitizeAxiosError(fbErr).message);
```

- [ ] **Step 8.4: Replace error logging in init**

Find the init catch (around line 697):
```js
this.logger.error('rewriter', 'Init failed: ' + err.message);
```
Replace with:
```js
this.logger.error('rewriter', 'Init failed: ' + sanitizeAxiosError(err).message);
```

- [ ] **Step 8.5: Syntax check + smoke test**

```bash
node -c src/modules/rewriter.js && echo OK
```
Expected: `OK`.

Test the logger still receives sanitized output by injecting a fake error:
```bash
node -e "
var { sanitizeAxiosError } = require('./src/utils/safe-http');
var err = new Error('Invalid key: sk-ant-abc123xyz789');
err.config = { headers: { Authorization: 'Bearer sk-ant-abc123xyz789' } };
console.log('PRIMARY FAILED: ' + sanitizeAxiosError(err).message);
"
```
Expected: `PRIMARY FAILED: Invalid key: [REDACTED]` (no `sk-ant-` substring).

- [ ] **Step 8.6: Commit**

```bash
git add src/modules/rewriter.js
git commit -m "fix(security): sanitize axios errors in rewriter logs (H7)

Replaces err.message with sanitizeAxiosError(err).message in the
primary/fallback/init catch blocks. Defense in depth: even if the
logger signature changes later, Bearer/sk-ant/sk-or tokens in the
error string are pre-scrubbed."
```

---

## Task 9: Swap raw axios error logging in `publisher.js` → `sanitizeAxiosError` (H7)

**Files:**
- Modify: `src/modules/publisher.js` — `_wpRequest` error path

**Why:** `_wpRequest` serializes `err.response.data.message || err.response.data.code` into log lines. A malicious WP plugin or man-in-the-middle could echo an `Authorization` header back in `err.response.data` and leak it. The error string also gets re-thrown and hits the pipeline logger.

- [ ] **Step 9.1: Add the require**

Near the top of `src/modules/publisher.js` (the `safe-http` import already exists — just add `sanitizeAxiosError` to the destructure):
```js
var { assertSafeUrl, safeAxiosOptions, sanitizeAxiosError } = require('../utils/safe-http');
```

- [ ] **Step 9.2: Replace the `_wpRequest` error serializers**

Find each of the three `.catch` blocks in `_wpRequest` (Method 1 / Method 2 / Method 3, around lines 369, 387, 403). Each currently does something like:
```js
var status1 = err1.response ? err1.response.status : null;
var msg1 = err1.response && err1.response.data ? (err1.response.data.message || err1.response.data.code || '') : err1.message;
self.logger.warn('publisher', 'Method 1 failed: ' + (status1 || '') + ' ' + msg1);
errors.push({ method: '?rest_route= + header', status: status1, message: msg1 });
```
Replace `msg1` with a sanitized version:
```js
var safe1 = sanitizeAxiosError(err1);
var status1 = safe1.status;
var msg1 = safe1.message;
self.logger.warn('publisher', 'Method 1 failed: ' + (status1 || '') + ' ' + msg1);
errors.push({ method: '?rest_route= + header', status: status1, message: msg1 });
```
Do the same for `err2`/`msg2` and `err3`/`msg3`.

- [ ] **Step 9.3: Syntax check**

```bash
node -c src/modules/publisher.js && echo OK
```
Expected: `OK`.

- [ ] **Step 9.4: Commit**

```bash
git add src/modules/publisher.js
git commit -m "fix(security): sanitize axios errors in publisher logs (H7)

_wpRequest's three method-fallback catch blocks now run every
axios error through sanitizeAxiosError() before logging or
pushing into the errors array. WP response bodies that echo
Authorization or sk-* tokens are scrubbed."
```

---

## Task 10: Swap raw axios error logging in `infranodus.js` → `sanitizeAxiosError` (H7)

**Files:**
- Modify: `src/modules/infranodus.js`

**Why:** InfraNodus adds its API key as `Authorization: Bearer <key>` on every request. A failure inside `axios.post('.../graphAndStatements')` produces an error whose `err.config.headers.Authorization` contains the raw key. Today the catch blocks log `err.message` only, which is safe — but so was rewriter.js, and we still hardened it for the same reason.

- [ ] **Step 10.1: Add the require**

Near the top of `src/modules/infranodus.js`, add:
```js
var { sanitizeAxiosError } = require('../utils/safe-http');
```

- [ ] **Step 10.2: Replace `err.message` in analyzeText catch**

Find the catch block at line 69:
```js
this.logger.error(MODULE, 'Analysis failed: ' + err.message);
```
Replace with:
```js
this.logger.error(MODULE, 'Analysis failed: ' + sanitizeAxiosError(err).message);
```

- [ ] **Step 10.3: Check for other catch blocks**

Run:
```bash
grep -n "logger\.(error|warn).*err\.message" src/modules/infranodus.js
```
Expected: may show 0, 1, or more results. For each, replace `err.message` with `sanitizeAxiosError(err).message`.

- [ ] **Step 10.4: Syntax check**

```bash
node -c src/modules/infranodus.js && echo OK
```
Expected: `OK`.

- [ ] **Step 10.5: Commit**

```bash
git add src/modules/infranodus.js
git commit -m "fix(security): sanitize axios errors in infranodus logs (H7)

InfraNodus sends Authorization: Bearer <key> on every request. If
axios ever surfaces the request headers through the error object,
the sanitizer scrubs the Bearer token before it hits the log."
```

---

## Task 11: Swap raw axios error serializers in `api.js` → `sanitizeAxiosError` (H7)

**Files:**
- Modify: `src/routes/api.js` — 9 sites

**Why:** These are the most dangerous sites because `api.js` is where `JSON.stringify(err.response.data)` is used most aggressively. An upstream that echoes the `Authorization` header in the response body leaks directly to dashboard users via `err.message`-in-response.

- [ ] **Step 11.1: `sanitizeAxiosError` already available**

It's re-exported from `safe-http.js` which is already imported at line 67. Just expand the destructure:
```js
var { assertSafeUrl, safeAxiosOptions, sanitizeAxiosError } = require('../utils/safe-http');
```

- [ ] **Step 11.2: Replace each of the 9 sites**

For each location in this list:
- `api.js:1965` — WP msg serializer (`err.response.data.message || err.response.data.code`)
- `api.js:2073` — WP msg serializer
- `api.js:2105, 2134, 2160, 2185` — RapidAPI `'API error ' + err.response.status + ': ' + JSON.stringify(err.response.data)`
- `api.js:2260, 2267` — firehose-connect `JSON.stringify(err.response.data)`
- `api.js:3758` — WP error
- `api.js:3802` — RapidAPI error

Replace the pattern:
```js
var msg = err.response ? 'API error ' + err.response.status + ': ' + JSON.stringify(err.response.data) : err.message;
```
with:
```js
var safe = sanitizeAxiosError(err);
var msg = safe.status ? 'API error ' + safe.status + ': ' + (safe.data || safe.message) : safe.message;
```

For the WP-specific shape:
```js
var wpMsg = err.response && err.response.data ? (err.response.data.message || err.response.data.code || '') : err.message;
```
replace with:
```js
var safeWp = sanitizeAxiosError(err);
var wpMsg = safeWp.data || safeWp.message;
```

**Work site by site — do not `sed -i` the whole file.** Each site has slightly different surrounding context (some push into an array, some return in a JSON response, some go into a log line). Preserve the downstream use.

- [ ] **Step 11.3: Syntax check**

```bash
node -c src/routes/api.js && echo OK
```
Expected: `OK`.

- [ ] **Step 11.4: Grep verification**

```bash
grep -n "JSON\.stringify(err\.response" src/routes/api.js
```
Expected: 0 matches. If any remain, repeat step 11.2 on the missed site.

```bash
grep -n "err\.response.*\.message.*err\.response.*\.code" src/routes/api.js
```
Expected: 0 matches.

- [ ] **Step 11.5: Commit**

```bash
git add src/routes/api.js
git commit -m "fix(security): sanitize axios errors across api.js (H7)

Replaces 9 raw err.response.data serializers (WP + RapidAPI +
firehose-connect) with sanitizeAxiosError(). Upstream responses
that echo Authorization or sk-* tokens are scrubbed before they
reach the dashboard JSON response or the server log."
```

---

## Task 12: Final verification + SECURITY-AUDIT.md update

**Files:**
- Modify: `SECURITY-AUDIT.md` — mark H4, H7, M5 as completed

- [ ] **Step 12.1: Full syntax sweep**

```bash
for f in src/utils/sanitize-axios-error.js src/utils/ai-cost-guard.js \
         src/utils/safe-http.js src/utils/config.js \
         src/routes/api.js src/modules/rewriter.js \
         src/modules/publisher.js src/modules/infranodus.js; do
  node -c "$f" || { echo "FAIL: $f"; exit 1; }
done
echo "ALL SYNTAX OK"
```
Expected: `ALL SYNTAX OK`.

- [ ] **Step 12.2: Boot smoke test**

```bash
npm run dev &
PID=$!
sleep 5
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/api/health || true
kill $PID
```
Expected: HTTP 200 from `/api/health` (or whatever the health endpoint is — check `api.js` if unsure). The server should start without throwing about missing modules.

- [ ] **Step 12.3: Mark findings as fixed in SECURITY-AUDIT.md**

Edit `SECURITY-AUDIT.md`. Find H4, H7, and M5. Prepend `✅ ` to each heading and append a short "Fixed: 2026-04-XX via `src/utils/ai-cost-guard.js` + `src/utils/sanitize-axios-error.js` — see commits in range `<first>..<last>`" line under each one.

Do NOT renumber the other findings or touch the Critical section.

- [ ] **Step 12.4: Commit**

```bash
git add SECURITY-AUDIT.md
git commit -m "docs(security): mark H4, H7, M5 as fixed

H4 (cost cap on batch AI endpoints), M5 (single-cluster rewrite
concurrency guard), and H7 (axios error credential leakage) are
closed by the ai-cost-guard and sanitize-axios-error utilities
plus their wiring into api.js / rewriter.js / publisher.js /
infranodus.js."
```

---

## Self-Review

**Spec coverage:**
- **H4 — batch rewrite no cost cap:** Tasks 2, 3, 4, 6, 7 ✅
- **H4 — publish-all-ready no lock:** Task 6 ✅
- **H4 — batch-fetch-images no lock:** Task 7 ✅
- **M5 — cluster rewrite no cost cap:** Task 5 ✅
- **H7 — axios error key leakage:** Tasks 1, 8, 9, 10, 11 ✅

**Placeholder scan:** No TBDs, no "implement later", no "similar to Task N" without repeating the code. Each step gives actual code or exact commands. Task 6 and Task 7 say "EXISTING LOOP BODY UNCHANGED" — that is not a placeholder, it is an explicit instruction to preserve the existing body, which the executing engineer can read directly from the current api.js at the referenced line.

**Type consistency:**
- `AiCostGuard.acquire(name, cost?)` returns `{ ok: boolean, reason?: string, detail?: string }` — used consistently in Tasks 4, 5, 6, 7.
- `sanitizeAxiosError(err)` returns `{ message, status, code, url, method, data }` — used consistently in Tasks 8, 9, 10, 11.
- Lock names are consistent: `batch-rewrite`, `cluster-rewrite:<id>`, `publish-all-ready`, `batch-fetch-images`.

---

## Risks & Tradeoffs

1. **Budget counter is in-memory only.** A restart resets the hourly ledger. That's acceptable because (a) the app is a single Node process and (b) the alternative — persisting to the `settings` table — adds write amplification and a migration. If the threat model ever includes "attacker can restart the server repeatedly," we revisit this with a `ai_cost_ledger` SQLite table.

2. **Failed rewrites still consume the budget.** By design. An attacker with a hijacked session can otherwise intentionally fail calls to dodge the cap. If this surprises admins, add a settings toggle `AI_BUDGET_REFUND_ON_FAILURE=true` in a later iteration.

3. **Cross-endpoint budget pool.** Intentional — a hijacked session should not get 60 batch rewrites AND 60 cluster rewrites AND 60 single-draft rewrites per hour. If legitimate operators complain, split per-endpoint via a `costBucket` parameter later.

4. **`sanitizeAxiosError` regex-based.** If a future API introduces a new key format (e.g. `pk-live-...`), it won't be scrubbed by default. Mitigation: the helper has ONE list of patterns at the top of the file, easy to extend. Not worth a pluggable registry now.

5. **No automated tests.** HDF AutoPub has no test framework. The smoke tests in each task are inline `node -e` snippets that run in 2 seconds. If a test framework is added later (Jest, node:test), port these smoke tests to it then — don't add the framework now.
