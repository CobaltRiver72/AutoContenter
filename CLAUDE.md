# HDF AutoPub

Node.js news autopublisher. Fetches articles via Ahrefs Firehose SSE, clusters by TF-IDF similarity, rewrites via AI, publishes to WordPress.

## Stack
- Runtime: Node.js, Express
- DB: SQLite via better-sqlite3
- Entry: `src/index.js` → `npm run dev`
- Process manager: PM2 (`npm run prod`)

## Source map
```
src/
  index.js              — app entry, mounts routes, boots modules
  middleware/
    site-scope.js       — reads X-Site-Id header → req.siteId (default 1, 0 = All Sites)
  modules/
    firehose.js         — Ahrefs SSE stream
    firehose-pool.js    — multi-site firehose connection pool
    feeds-pool.js       — per-feed fetch orchestration (rate limit, retry)
    publisher.js        — WordPress REST API publish
    publisher-pool.js   — multi-site publish orchestration
    wp-publisher.js     — alternate WP publisher path
    wp-taxonomy.js      — WP categories/authors/tags cache + sync
    buffer.js           — deduplication before clustering
    similarity.js       — TF-IDF cosine clustering
    extractor.js        — Readability + Google Cache content extraction
    extractor-jina.js   — Jina AI fallback extractor
    rewriter.js         — AI rewrite (Claude/OpenAI/OpenRouter), master prompt lives here
    content-classifier.js — L1 dictionary + L2 AI category/author/tag assignment
    autopilot.js        — auto-publish decision engine
    trends.js           — Google Trends integration
    infranodus.js       — InfraNodus graph API
    fuel.js / fuel-posts.js     — fuel-prices vertical + WP post generation
    metals.js / metals-posts.js — metals vertical
    lottery.js / lottery-posts.js — lottery vertical
  routes/
    api.js              — all API routes (~190 endpoints)
    auth.js             — login/session
    dashboard.js        — dashboard routes
    public.js           — public/unauthenticated endpoints
  utils/
    db.js               — SQLite schema + migrations
    draft-helpers.js    — extractDraftContent(), rewriteDraftContent()
    config.js           — settings loader
    site-config.js      — per-site config helpers (getSite, updateSite)
    markdown-to-html.js — MD to HTML converter
    logger.js           — structured logger (writes to logs table with site_id)
    publish-rule-engine.js — IF/THEN rule evaluator
    lucene-builder.js   — Firehose Lucene query DSL
    firehose-admin.js   — Firehose rule CRUD helpers
    post-html.js, categories.js, authority.js, api-helpers.js,
      sanitize-axios-error.js, ai-cost-guard.js, safe-http.js,
      config-import-{keys,validator,engine}.js — misc helpers
  workers/
    pipeline.js         — auto pipeline worker
    similarity-worker.js — clustering worker
public/
  index.html            — dashboard shell (21 page sections)
  js/
    dashboard.js        — SPA core: router, state, fetchApi, CLICK_ACTIONS
    site-home.js        — Per-site Overview page (+ sidebar site switcher)
    sites-page.js       — All-sites landing grid
    feeds-page.js       — Feeds list (table/board)
    create-feed-page.js — New-feed wizard
    feed-detail-page.js — Single-feed detail
    editor-page.js      — Cluster/draft editor
    site-settings-page.js — Per-site settings
    lucide.min.js       — icons
  css/
    dashboard.css       — legacy global styles
    site-home.css       — redesign tokens scoped under .sh-root
  wp-assets/            — client-side JS/CSS shipped into WordPress
```

## DB tables
- `sites` — multi-site root (one row per WordPress install)
- `site_config` — per-site key/value settings
- `feeds` — per-site feed definitions (source/dest/quality config)
- `articles` — raw Firehose articles (scoped via `source_site_id`, `feed_id`)
- `clusters` — grouped article clusters (scoped via `feed_id` + drafts.site_id)
- `drafts` — one row per source URL, holds extracted + rewritten content (scoped via `site_id`)
- `draft_versions` — append-only rewrite history (version, draft_id)
- `published` — publish log (scoped via `site_id`)
- `publish_rules` — per-site IF/THEN automations
- `logs` — structured log (scoped via `site_id`, NULL = system-wide)
- `fuel_*`, `metals_*`, `lottery_*` — data-feed verticals
- `autopilot_decisions`, `classification_log`, `wp_posts_log`, `wp_taxonomy_cache`
- `config_snapshots` — import/export rollback points
- `fetch_log`, `settings`, `domains_config`, `infranodus_history`

## Key rules
- Always use `better-sqlite3` sync API, never async DB calls
- Language detection: `/[\u0900-\u097F]{3,}/` = Hindi, else English
- Cross-language clusters allowed — output English if ANY article is English
- Master AI prompt is the `SYSTEM_PROMPT` constant in `rewriter.js`
- `rewriteDraftContent()` in `draft-helpers.js` is the single rewrite entry point — never bypass it
- Never skip local test before pushing to GitHub
- Strict CSP: `script-src 'self'; script-src-attr 'none'` — no inline handlers. Use `data-click="action"` + CLICK_ACTIONS registry in `dashboard.js`
- All site-scoped fetches auto-inject `X-Site-Id` via `fetchApi`; back-end reads via `req.siteId` (site-scope middleware)
- New CSS must be scoped to a root class (see `.sh-root` in `site-home.css`) to avoid collision with legacy `dashboard.css`

## Cancelled / out-of-scope
- Blogspot platform: will NEVER be added. WordPress only.
- Indian Vehicle Data SEO feature: cancelled, do not implement.
- Standalone Clusters page (removed — surfaced via Site Home / Feed Detail instead)
