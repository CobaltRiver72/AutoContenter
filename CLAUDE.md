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
  modules/
    firehose.js         — Ahrefs SSE stream
    buffer.js           — deduplication before clustering
    similarity.js       — TF-IDF cosine clustering
    extractor.js        — Readability + Google Cache content extraction
    extractor-jina.js   — Jina AI fallback extractor
    rewriter.js         — AI rewrite (Claude/OpenAI/OpenRouter), master prompt lives here
    publisher.js        — WordPress REST API publish
    trends.js           — Google Trends integration
    infranodus.js       — InfraNodus graph API
  routes/
    api.js              — all API routes
    auth.js             — login/session
    dashboard.js        — dashboard routes
  utils/
    db.js               — SQLite schema + migrations
    draft-helpers.js    — extractDraftContent(), rewriteDraftContent()
    config.js           — settings loader
    markdown-to-html.js — MD to HTML converter
    logger.js           — structured logger
  workers/
    pipeline.js         — auto pipeline worker
    similarity-worker.js — clustering worker
public/
  index.html            — dashboard UI
```

## DB tables
- `articles` — raw Firehose articles
- `clusters` — grouped article clusters
- `drafts` — one row per source URL, holds extracted + rewritten content
- `draft_versions` — append-only rewrite history (version, draft_id)
- `published` — publish log

## Key rules
- Always use `better-sqlite3` sync API, never async DB calls
- Language detection: `/[\u0900-\u097F]{3,}/` = Hindi, else English
- Cross-language clusters allowed — output English if ANY article is English
- Master AI prompt is the `SYSTEM_PROMPT` constant in `rewriter.js`
- `rewriteDraftContent()` in `draft-helpers.js` is the single rewrite entry point — never bypass it
- Never skip local test before pushing to GitHub

## Cancelled / out-of-scope
- Blogspot platform: will NEVER be added. WordPress only.
- Indian Vehicle Data SEO feature: cancelled, do not implement.
