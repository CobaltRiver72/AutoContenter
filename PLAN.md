# HDF News Auto-Publisher — Build Plan

## Overview
Node.js app on Hostinger Cloud Startup that monitors Ahrefs Firehose + Google Trends, detects trending stories via TF-IDF clustering, rewrites with Claude/OpenAI, and auto-publishes to WordPress. Includes full admin dashboard.

## Architecture
- **Single-process design:** Express server + SSE listener + Trends poller in one Node.js process
- **Database:** SQLite via better-sqlite3 (WAL mode, 6 tables)
- **AI:** Claude Sonnet (primary) + GPT-4o (fallback) for article rewriting
- **Dashboard:** Vanilla JS SPA with dark theme, served by Express

## Tech Stack
- Node.js 20+, CommonJS (require)
- Express 4.x + express-session
- eventsource (SSE client with custom headers)
- google-trends-api (free trending topics)
- natural (TF-IDF cosine similarity)
- better-sqlite3 (embedded database)
- axios (HTTP client)
- node-cron (scheduled tasks)
- winston (logging)
- dotenv (env config)

## 6-Step Pipeline
1. **Ingest:** Firehose SSE (real-time articles) + Google Trends (15-min polling)
2. **Buffer:** SQLite rolling 6-hour window with fingerprint extraction
3. **Detect:** TF-IDF cosine similarity → 2+ sources from different domains = cluster
4. **Boost:** Cross-check clusters against Google Trends watchlist → priority boost
5. **Rewrite:** Claude/OpenAI restructures article → SEO-optimized HTML + metadata
6. **Publish:** WordPress REST API with featured image upload + JSON-LD schema

## Database Schema (6 tables)
- `articles` — incoming Firehose articles with fingerprints
- `clusters` — detected story clusters with priority/status
- `published` — published WP posts with metadata
- `trends` — Google Trends watchlist entries
- `logs` — application logs for dashboard display
- `settings` — runtime config overrides (no redeploy needed)

## Build Strategy — 4 Parallel Agents

### Agent 1: Core Pipeline (8 files)
- `src/utils/config.js` — env loader + validation + runtime overrides
- `src/utils/db.js` — SQLite init + migrations + WAL mode
- `src/utils/logger.js` — Winston + SQLite dual logging
- `src/utils/authority.js` — domain tier scoring (1/2/3)
- `src/modules/firehose.js` — SSE client + reconnect + Last-Event-ID
- `src/modules/trends.js` — Google Trends poller + topic matching
- `src/modules/buffer.js` — rolling article buffer + fingerprinting
- `src/modules/similarity.js` — TF-IDF engine + cluster management

### Agent 2: AI + Publishing (3 files)
- `src/modules/rewriter.js` — Claude + OpenAI rewrite pipeline
- `src/modules/publisher.js` — WP REST API publisher + image handler
- `src/modules/scheduler.js` — rate limiter + priority queue

### Agent 3: Dashboard + API (6 files)
- `src/routes/auth.js` — session-based auth middleware
- `src/routes/api.js` — 18 JSON API endpoints
- `src/routes/dashboard.js` — static file serving + login routes
- `public/index.html` — SPA shell with sidebar + pages
- `public/css/dashboard.css` — dark theme styles
- `public/js/dashboard.js` — client-side JS (fetch API, SSE, routing)

### Agent 4: Integration (4 files) — runs after Agents 1-3
- `src/index.js` — entry point wiring all modules + event pipeline
- `package.json` — dependencies + scripts
- `.env.example` — documented config template
- `.gitignore` — node_modules, data, .env, logs

## Key Design Decisions
1. SQLite over external DB (Hostinger doesn't provide separate DB for Node)
2. TF-IDF over embeddings (fast, local, no API cost)
3. Free Google Trends npm over SerpApi ($75/mo savings)
4. Single process (Hostinger keeps it alive for HTTP serving)
5. CommonJS (Hostinger Node runner compatibility)
6. Dashboard works standalone even without API keys configured
7. Graceful degradation: every external service can fail independently

## Rate Limits
- Max 4 articles/hour published
- 10-minute cooldown between publishes
- Firehose reconnect: minimum 2 seconds between attempts
- Trends poll: every 15 minutes

## Deployment
1. Push to GitHub (private repo)
2. Hostinger hPanel → Node.js Apps → Connect repo
3. Set env vars in Hostinger dashboard
4. Auto-deploys on push to main
