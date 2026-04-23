'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { getConfig } = require('./config');

const config = getConfig();

// Ensure data directory exists
const dataDir = config.DATA_DIR || path.resolve(__dirname, '..', '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = config.DB_PATH || path.join(dataDir, 'autopub.db');

let db;

try {
  db = new Database(dbPath);

  // ─── Security hardening: tighten permissions on DB files (C3 fix) ──
  // The DB holds plaintext API keys, WP credentials, FIREHOSE_TOKEN,
  // SESSION_SECRET, and bcrypt hashes. On multi-tenant hosts, default
  // umask (0755 dir / 0644 file) lets any local user read the DB and
  // strings-extract every secret. Chmod parent dir to 0700 and DB to
  // 0600. Never crash on failure — filesystems without chmod support
  // (e.g. Windows, some network mounts) should still allow boot.
  if (process.platform !== 'win32') {
    var filesToSecurePre = [
      { path: path.dirname(dbPath), mode: 0o700, label: 'data dir' },
      { path: dbPath, mode: 0o600, label: 'db file' },
    ];
    for (var si = 0; si < filesToSecurePre.length; si++) {
      var fp = filesToSecurePre[si];
      try {
        if (fs.existsSync(fp.path)) {
          fs.chmodSync(fp.path, fp.mode);
        }
      } catch (chmodErr) {
        console.warn('[db] could not chmod ' + fp.label + ' (' + fp.path + '): ' + chmodErr.message);
      }
    }
  }

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');

  // ─── Security hardening pass 2: chmod WAL + SHM files (C3 fix) ─────
  // WAL and SHM sidecars are created when journal_mode=WAL is set, so
  // they don't exist on first-ever boot until now. Tighten them to 0600
  // so they can't leak plaintext page data either.
  if (process.platform !== 'win32') {
    var walFiles = [
      { path: dbPath + '-wal', mode: 0o600, label: 'wal file' },
      { path: dbPath + '-shm', mode: 0o600, label: 'shm file' },
    ];
    for (var wi2 = 0; wi2 < walFiles.length; wi2++) {
      var wf = walFiles[wi2];
      try {
        if (fs.existsSync(wf.path)) {
          fs.chmodSync(wf.path, wf.mode);
        }
      } catch (chmodErr2) {
        console.warn('[db] could not chmod ' + wf.label + ' (' + wf.path + '): ' + chmodErr2.message);
      }
    }
  }

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Reasonable busy timeout (5 seconds)
  db.pragma('busy_timeout = 5000');

  // Performance tuning for 4GB server
  db.pragma('synchronous = NORMAL');      // Safe with WAL — 2x faster writes
  db.pragma('cache_size = -64000');        // 64MB page cache (default is 2MB)
  db.pragma('temp_store = MEMORY');        // Temp tables in RAM, not disk
  db.pragma('mmap_size = 268435456');      // Memory-map 256MB of DB for faster reads
} catch (err) {
  console.error('[db] Failed to open database:', err.message);
  process.exit(1);
}

// ─── Schema Migrations ──────────────────────────────────────────────────────

function runMigrations() {
  try {
    // Articles table
    db.exec(`
      CREATE TABLE IF NOT EXISTS articles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        firehose_event_id TEXT UNIQUE,
        url TEXT NOT NULL,
        domain TEXT NOT NULL,
        title TEXT,
        publish_time TEXT,
        content_markdown TEXT,
        fingerprint TEXT,
        cluster_id INTEGER,
        trends_matched INTEGER DEFAULT 0,
        authority_tier INTEGER DEFAULT 3,
        received_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.exec('CREATE INDEX IF NOT EXISTS idx_articles_received ON articles(received_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_articles_cluster ON articles(cluster_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_articles_domain ON articles(domain)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_articles_fingerprint ON articles(fingerprint)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_articles_url ON articles(url)');

    // Clusters table
    db.exec(`
      CREATE TABLE IF NOT EXISTS clusters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT,
        article_count INTEGER DEFAULT 0,
        avg_similarity REAL DEFAULT 0,
        primary_article_id INTEGER,
        trends_boosted INTEGER DEFAULT 0,
        trend_topic TEXT,
        priority TEXT DEFAULT 'normal',
        status TEXT DEFAULT 'detected',
        detected_at TEXT DEFAULT (datetime('now')),
        published_at TEXT
      )
    `);

    db.exec('CREATE INDEX IF NOT EXISTS idx_clusters_status ON clusters(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_clusters_detected ON clusters(detected_at)');

    // Published table
    db.exec(`
      CREATE TABLE IF NOT EXISTS published (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cluster_id INTEGER NOT NULL,
        wp_post_id INTEGER,
        wp_post_url TEXT,
        wp_image_id INTEGER,
        title TEXT,
        slug TEXT,
        word_count INTEGER,
        ai_model TEXT,
        tokens_used INTEGER,
        published_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.exec('CREATE INDEX IF NOT EXISTS idx_published_cluster ON published(cluster_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_published_date ON published(published_at)');

    // Trends table
    db.exec(`
      CREATE TABLE IF NOT EXISTS trends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        topic TEXT NOT NULL,
        trend_type TEXT NOT NULL,
        related_queries TEXT,
        traffic_volume TEXT,
        source_url TEXT,
        matched_cluster_id INTEGER,
        status TEXT DEFAULT 'watching',
        first_seen TEXT DEFAULT (datetime('now')),
        last_updated TEXT DEFAULT (datetime('now')),
        expires_at TEXT
      )
    `);

    db.exec('CREATE INDEX IF NOT EXISTS idx_trends_status ON trends(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_trends_expires ON trends(expires_at)');

    // Logs table
    db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        level TEXT NOT NULL,
        module TEXT,
        message TEXT NOT NULL,
        details TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);

    db.exec('CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at)');

    // Settings table
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // Migration: drop legacy autopilot_decisions table (AutoPilot page removed)
    db.exec('DROP TABLE IF EXISTS autopilot_decisions;');

    // Classification log table
    db.exec(`
      CREATE TABLE IF NOT EXISTS classification_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        draft_id INTEGER,
        cluster_id INTEGER,
        title TEXT,
        assigned_category TEXT,
        assigned_author TEXT,
        assigned_tags TEXT,
        layer_used TEXT,
        l1_category_score REAL,
        l1_author_score REAL,
        l2_ai_confidence REAL,
        match_reasons TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_classification_log_created ON classification_log(created_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_classification_log_author ON classification_log(assigned_author)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_classification_log_category ON classification_log(assigned_category)');

    // Add extracted_content column if it doesn't exist
    try {
      db.exec('ALTER TABLE articles ADD COLUMN extracted_content TEXT');
    } catch (e) {
      // Column already exists — ignore
    }

    // NOTE: faq_json + master prompt v2 columns (in_brief_json, body_markdown)
    // are added after the drafts CREATE TABLE statement below — the ALTER
    // TABLE migrations must run after the table exists, otherwise they
    // silently fail on a fresh database.

    // Add page_category and language columns to articles if they don't exist
    try {
      db.exec('ALTER TABLE articles ADD COLUMN page_category TEXT DEFAULT NULL');
    } catch (e) { /* already exists */ }
    try {
      db.exec('ALTER TABLE articles ADD COLUMN language TEXT DEFAULT NULL');
    } catch (e) { /* already exists */ }

    // Language column on clusters — used to keep en/hi clusters segregated
    try {
      db.exec('ALTER TABLE clusters ADD COLUMN language TEXT DEFAULT NULL');
    } catch (e) { /* already exists */ }

    db.exec('CREATE INDEX IF NOT EXISTS idx_articles_title ON articles(title)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_articles_language ON articles(language)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_clusters_language ON clusters(language)');

    // Add new columns to published table if they don't exist
    try {
      db.exec('ALTER TABLE published ADD COLUMN word_count INTEGER DEFAULT 0');
    } catch (e) { /* already exists */ }
    try {
      db.exec('ALTER TABLE published ADD COLUMN target_keyword TEXT');
    } catch (e) { /* already exists */ }
    try {
      db.exec('ALTER TABLE published ADD COLUMN excerpt TEXT');
    } catch (e) { /* already exists */ }
    try {
      db.exec('ALTER TABLE published ADD COLUMN meta_description TEXT');
    } catch (e) { /* already exists */ }

    // Drafts table (manual article selection + editor)
    db.exec(`
      CREATE TABLE IF NOT EXISTS drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_article_id INTEGER,
        source_url TEXT NOT NULL,
        source_domain TEXT,
        source_title TEXT,
        source_content_markdown TEXT,
        source_language TEXT,
        source_category TEXT,
        source_publish_time TEXT,
        extracted_content TEXT,
        extracted_title TEXT,
        extracted_excerpt TEXT,
        extracted_byline TEXT,
        extraction_status TEXT DEFAULT 'pending',
        extraction_error TEXT,
        target_keyword TEXT,
        target_domain TEXT,
        target_platform TEXT DEFAULT 'blogspot',
        target_language TEXT DEFAULT 'en+hi',
        schema_types TEXT DEFAULT 'NewsArticle,FAQPage,BreadcrumbList',
        featured_image TEXT,
        rewritten_html TEXT,
        rewritten_title TEXT,
        rewritten_word_count INTEGER,
        ai_model_used TEXT,
        status TEXT DEFAULT 'fetching',
        mode TEXT DEFAULT 'manual',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        published_at TEXT
      )
    `);

    db.exec('CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts(status)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_drafts_url ON drafts(source_url)');

    // UNIQUE constraint on source_url to prevent duplicates at scale
    try {
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_drafts_url_unique ON drafts(source_url)');
    } catch (e) {
      console.warn('[db] Could not create UNIQUE index on drafts.source_url — duplicates may exist');
    }

    // Add faq_json column to drafts (must run after CREATE TABLE drafts)
    try {
      db.exec('ALTER TABLE drafts ADD COLUMN faq_json TEXT DEFAULT NULL');
    } catch (e) { /* already exists */ }

    // Master Prompt v2 — structured fields
    // in_brief_json: JSON array of bullet strings (the v2 "IN BRIEF" block)
    // body_markdown: raw markdown body returned by the model (pre-conversion)
    try {
      db.exec('ALTER TABLE drafts ADD COLUMN in_brief_json TEXT DEFAULT NULL');
    } catch (e) { /* already exists */ }
    try {
      db.exec('ALTER TABLE drafts ADD COLUMN body_markdown TEXT DEFAULT NULL');
    } catch (e) { /* already exists */ }

    // Master Prompt v2 — Step 1 signals (parallel_facts/steps/comparison/...)
    // Stored as JSON object so we can audit what the model decided about
    // structure for each rewrite. Used by validateStructure() to enforce
    // table/list rendering when signals say so.
    try {
      db.exec('ALTER TABLE drafts ADD COLUMN ai_signals TEXT DEFAULT NULL');
    } catch (e) { /* already exists */ }

    // Draft versioning — pointer to current version in draft_versions
    try {
      db.exec('ALTER TABLE drafts ADD COLUMN current_version INTEGER DEFAULT 0');
    } catch (e) { /* already exists */ }

    // Draft versions — append-only history of every successful rewrite.
    // version starts at 1, monotonically increasing per draft_id.
    db.exec(`
      CREATE TABLE IF NOT EXISTS draft_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        draft_id INTEGER NOT NULL,
        version INTEGER NOT NULL,
        rewritten_title TEXT,
        rewritten_html TEXT,
        rewritten_word_count INTEGER,
        in_brief_json TEXT,
        body_markdown TEXT,
        faq_json TEXT,
        ai_signals TEXT,
        ai_model_used TEXT,
        ai_provider TEXT,
        ai_tokens_used INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(draft_id, version)
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_draft_versions_draft ON draft_versions(draft_id, version DESC)');

    // Add featured_image column to drafts if it doesn't exist
    try {
      db.exec('ALTER TABLE drafts ADD COLUMN featured_image TEXT DEFAULT NULL');
    } catch (e) { /* already exists */ }

    // Add extraction_method column to drafts if it doesn't exist
    try {
      db.exec('ALTER TABLE drafts ADD COLUMN extraction_method TEXT DEFAULT NULL');
    } catch (e) { /* already exists */ }

    // Add is_partial column to drafts if it doesn't exist
    try {
      db.exec('ALTER TABLE drafts ADD COLUMN is_partial INTEGER DEFAULT 0');
    } catch (e) { /* already exists */ }

    // Add AI tracking columns to drafts
    try {
      db.exec('ALTER TABLE drafts ADD COLUMN ai_provider TEXT DEFAULT NULL');
    } catch (e) { /* already exists */ }
    try {
      db.exec('ALTER TABLE drafts ADD COLUMN ai_tokens_used INTEGER DEFAULT 0');
    } catch (e) { /* already exists */ }

    // Add WP media tracking column to drafts
    try {
      db.exec('ALTER TABLE drafts ADD COLUMN wp_media_id INTEGER DEFAULT NULL');
    } catch (e) { /* already exists */ }

    // Add WP post ID tracking on drafts (for idempotent re-publish)
    try {
      db.exec('ALTER TABLE drafts ADD COLUMN wp_post_id INTEGER DEFAULT NULL');
    } catch (e) { /* already exists */ }
    try {
      db.exec('ALTER TABLE drafts ADD COLUMN wp_post_url TEXT DEFAULT NULL');
    } catch (e) { /* already exists */ }

    // Add retry / failure tracking columns to drafts
    try {
      db.exec('ALTER TABLE drafts ADD COLUMN retry_count INTEGER DEFAULT 0');
    } catch (e) { /* already exists */ }
    try {
      db.exec('ALTER TABLE drafts ADD COLUMN max_retries INTEGER DEFAULT 3');
    } catch (e) { /* already exists */ }
    try {
      db.exec('ALTER TABLE drafts ADD COLUMN error_message TEXT DEFAULT NULL');
    } catch (e) { /* already exists */ }
    try {
      db.exec('ALTER TABLE drafts ADD COLUMN last_error_at TEXT DEFAULT NULL');
    } catch (e) { /* already exists */ }
    try {
      db.exec('ALTER TABLE drafts ADD COLUMN failed_permanent INTEGER DEFAULT 0');
    } catch (e) { /* already exists */ }

    // Domain extraction config / stats table
    db.exec(`
      CREATE TABLE IF NOT EXISTS domains_config (
        domain TEXT PRIMARY KEY,
        total_attempts INTEGER DEFAULT 0,
        total_successes INTEGER DEFAULT 0,
        total_failures INTEGER DEFAULT 0,
        success_rate REAL DEFAULT 0,
        last_attempt_at TEXT,
        last_success_at TEXT,
        preferred_method TEXT DEFAULT NULL,
        is_blocked INTEGER DEFAULT 0,
        notes TEXT DEFAULT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )
    `);

    // ─── Cluster integration columns on drafts ────────────────────────────
    try {
      db.exec('ALTER TABLE drafts ADD COLUMN cluster_id INTEGER DEFAULT NULL');
    } catch (e) { /* already exists */ }

    try {
      db.exec('ALTER TABLE drafts ADD COLUMN cluster_role TEXT DEFAULT NULL');
    } catch (e) { /* already exists */ }

    // InfraNodus entity analysis — JSON string (mainTopics, missingEntities,
    // contentGaps, researchQuestions). Written by pipeline before rewrite and
    // surfaced in the dashboard draft editor.
    try {
      db.exec('ALTER TABLE drafts ADD COLUMN infranodus_data TEXT DEFAULT NULL');
    } catch (e) { /* already exists */ }

    // WP Taxonomy routing — per-draft overrides
    try { db.exec('ALTER TABLE drafts ADD COLUMN wp_category_ids TEXT DEFAULT NULL'); } catch (e) { /* already exists */ }
    try { db.exec('ALTER TABLE drafts ADD COLUMN wp_primary_cat_id INTEGER DEFAULT NULL'); } catch (e) { /* already exists */ }
    try { db.exec('ALTER TABLE drafts ADD COLUMN wp_tag_ids TEXT DEFAULT NULL'); } catch (e) { /* already exists */ }
    try { db.exec('ALTER TABLE drafts ADD COLUMN wp_author_id_override INTEGER DEFAULT NULL'); } catch (e) { /* already exists */ }
    try { db.exec('ALTER TABLE drafts ADD COLUMN wp_post_status_override TEXT DEFAULT NULL'); } catch (e) { /* already exists */ }

    // InfraNodus analysis history — one row per analysis run so users can
    // pull past data without it being overwritten by future runs.
    db.exec(`CREATE TABLE IF NOT EXISTS infranodus_history (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_id    INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
      source      TEXT NOT NULL DEFAULT 'article',  -- 'article' | 'entity' | 'merge'
      query       TEXT,                              -- entity keyword or article title
      data_json   TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_infranodus_history_draft ON infranodus_history(draft_id, created_at DESC)');

    // Index for cluster lookups
    db.exec('CREATE INDEX IF NOT EXISTS idx_drafts_cluster ON drafts(cluster_id)');

    // ─── Pipeline V2: Add worker columns (safe for existing DBs) ────────
    // SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN
    // So we check if each column exists first using PRAGMA table_info
    (function addPipelineV2Columns() {
      try {
        var tableInfo = db.prepare('PRAGMA table_info(drafts)').all();
        var existingColumns = {};
        for (var pi = 0; pi < tableInfo.length; pi++) {
          existingColumns[tableInfo[pi].name] = true;
        }

        var columnsToAdd = [
          { name: 'locked_by', type: 'TEXT DEFAULT NULL' },
          { name: 'locked_at', type: 'TEXT DEFAULT NULL' },
          { name: 'lease_expires_at', type: 'TEXT DEFAULT NULL' },
          { name: 'next_run_at', type: 'TEXT DEFAULT NULL' },
        ];

        for (var ci = 0; ci < columnsToAdd.length; ci++) {
          var col = columnsToAdd[ci];
          if (!existingColumns[col.name]) {
            try {
              db.exec('ALTER TABLE drafts ADD COLUMN ' + col.name + ' ' + col.type);
              console.log('[db] Added column: drafts.' + col.name);
            } catch (alterErr) {
              if (alterErr.message && alterErr.message.indexOf('duplicate column') === -1) {
                console.error('[db] Failed to add column ' + col.name + ':', alterErr.message);
              }
            }
          }
        }

        // ─── Performance indexes (safe with IF NOT EXISTS) ──────────
        db.exec('CREATE INDEX IF NOT EXISTS idx_drafts_status_next_run ON drafts(status, next_run_at)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_drafts_lease ON drafts(locked_by, lease_expires_at)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_drafts_cluster_status ON drafts(cluster_id, extraction_status)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_drafts_mode_status ON drafts(mode, status)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_drafts_extraction_pending ON drafts(extraction_status, status, locked_by)');
        // Covers the extraction worker pickup scan: status='fetching' AND lease expired
        db.exec('CREATE INDEX IF NOT EXISTS idx_drafts_pickup ON drafts(status, locked_by, lease_expires_at)');
        // Covers the publish loop scan: ready+primary drafts ordered by trends/created
        db.exec('CREATE INDEX IF NOT EXISTS idx_drafts_ready_primary ON drafts(status, cluster_role, mode, created_at)');

        console.log('[db] Pipeline V2 migration complete');
      } catch (migrationErr) {
        console.error('[db] Pipeline V2 migration error:', migrationErr.message);
      }
    })();

    // ═══════════════════════════════════════════════════════════════════
    // FUEL MODULE TABLES
    // ═══════════════════════════════════════════════════════════════════

    db.exec(`
      CREATE TABLE IF NOT EXISTS fuel_cities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        city_name TEXT NOT NULL,
        state TEXT NOT NULL,
        is_ut INTEGER DEFAULT 0,
        region TEXT,
        api3_city TEXT,
        is_top_city INTEGER DEFAULT 0,
        is_enabled INTEGER DEFAULT 1,
        has_post INTEGER DEFAULT 1,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(city_name, state)
      );

      CREATE INDEX IF NOT EXISTS idx_fuel_cities_state ON fuel_cities(state);
      CREATE INDEX IF NOT EXISTS idx_fuel_cities_enabled ON fuel_cities(is_enabled);

      CREATE TABLE IF NOT EXISTS fuel_prices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        city TEXT NOT NULL,
        state TEXT NOT NULL,
        petrol REAL,
        diesel REAL,
        price_date TEXT NOT NULL,
        source TEXT DEFAULT 'api3',
        fetched_at TEXT DEFAULT (datetime('now')),
        UNIQUE(city, price_date)
      );

      CREATE INDEX IF NOT EXISTS idx_fuel_prices_city ON fuel_prices(city);
      CREATE INDEX IF NOT EXISTS idx_fuel_prices_date ON fuel_prices(price_date);
      CREATE INDEX IF NOT EXISTS idx_fuel_prices_state_date ON fuel_prices(state, price_date);
      CREATE INDEX IF NOT EXISTS idx_fuel_prices_city_date ON fuel_prices(city, price_date);

      CREATE TABLE IF NOT EXISTS fuel_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        log_type TEXT DEFAULT 'info',
        source TEXT,
        message TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- ═══════════════════════════════════════════════════════════════════
      -- METALS MODULE TABLES
      -- ═══════════════════════════════════════════════════════════════════

      CREATE TABLE IF NOT EXISTS metals_cities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        city_name TEXT NOT NULL,
        state TEXT NOT NULL,
        api1_name TEXT,
        is_active INTEGER DEFAULT 1,
        UNIQUE(city_name)
      );

      CREATE INDEX IF NOT EXISTS idx_metals_cities_state ON metals_cities(state);

      CREATE TABLE IF NOT EXISTS metals_prices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        city TEXT NOT NULL,
        metal_type TEXT NOT NULL,
        price_24k REAL,
        price_22k REAL,
        price_18k REAL,
        price_1g REAL,
        price_date TEXT NOT NULL,
        source TEXT DEFAULT 'api1',
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(city, metal_type, price_date)
      );

      CREATE INDEX IF NOT EXISTS idx_metals_prices_city ON metals_prices(city);
      CREATE INDEX IF NOT EXISTS idx_metals_prices_date ON metals_prices(price_date);
      CREATE INDEX IF NOT EXISTS idx_metals_prices_metal_date ON metals_prices(metal_type, price_date);
      CREATE INDEX IF NOT EXISTS idx_metals_prices_city_metal ON metals_prices(city, metal_type);

      CREATE TABLE IF NOT EXISTS metals_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- ═══════════════════════════════════════════════════════════════════
      -- LOTTERY MODULE TABLES
      -- ═══════════════════════════════════════════════════════════════════

      CREATE TABLE IF NOT EXISTS lottery_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        draw_date TEXT NOT NULL,
        draw_time TEXT NOT NULL,
        draw_name TEXT,
        source TEXT DEFAULT 'sambad',
        pdf_url TEXT,
        wp_attachment_id INTEGER,
        image_url TEXT,
        wp_post_id INTEGER,
        wp_post_url TEXT,
        status TEXT DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        error_message TEXT,
        fetched_at TEXT DEFAULT (datetime('now')),
        UNIQUE(draw_date, draw_time)
      );

      CREATE INDEX IF NOT EXISTS idx_lottery_date ON lottery_results(draw_date);
      CREATE INDEX IF NOT EXISTS idx_lottery_status ON lottery_results(status);
      CREATE INDEX IF NOT EXISTS idx_lottery_date_time ON lottery_results(draw_date, draw_time);
    `);

    // ═══════════════════════════════════════════════════════════════════
    // WP POST LOG + FETCH LOG TABLES
    // ═══════════════════════════════════════════════════════════════════

    db.exec(`
      CREATE TABLE IF NOT EXISTS wp_posts_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        module TEXT NOT NULL,
        post_type TEXT NOT NULL,
        item_type TEXT NOT NULL,
        item_name TEXT NOT NULL,
        wp_post_id INTEGER,
        wp_slug TEXT,
        wp_url TEXT,
        wp_status TEXT,
        action TEXT,
        error_message TEXT,
        content_hash TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(module, item_type, post_type, item_name)
      );

      CREATE INDEX IF NOT EXISTS idx_wp_posts_module ON wp_posts_log(module);
      CREATE INDEX IF NOT EXISTS idx_wp_posts_type ON wp_posts_log(item_type, post_type);
      CREATE INDEX IF NOT EXISTS idx_wp_posts_action ON wp_posts_log(action);

      CREATE TABLE IF NOT EXISTS fetch_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        module TEXT NOT NULL,
        fetch_type TEXT DEFAULT 'scheduled',
        cities_ok INTEGER DEFAULT 0,
        cities_fail INTEGER DEFAULT 0,
        cities_skipped INTEGER DEFAULT 0,
        duration_ms INTEGER,
        error_message TEXT,
        details TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_fetch_log_module ON fetch_log(module, created_at);

      CREATE TABLE IF NOT EXISTS wp_taxonomy_cache (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        tax_type   TEXT NOT NULL,
        wp_id      INTEGER NOT NULL,
        name       TEXT NOT NULL,
        slug       TEXT NOT NULL DEFAULT '',
        parent_id  INTEGER DEFAULT 0,
        synced_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(tax_type, wp_id)
      );
      CREATE INDEX IF NOT EXISTS idx_wp_tax_type ON wp_taxonomy_cache(tax_type);

      CREATE TABLE IF NOT EXISTS publish_rules (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_name             TEXT NOT NULL,
        priority              INTEGER DEFAULT 0,
        match_source_domain   TEXT DEFAULT NULL,
        match_source_category TEXT DEFAULT NULL,
        match_title_keyword   TEXT DEFAULT NULL,
        wp_category_ids       TEXT DEFAULT NULL,
        wp_primary_cat_id     INTEGER DEFAULT NULL,
        wp_tag_ids            TEXT DEFAULT NULL,
        wp_author_id          INTEGER DEFAULT NULL,
        is_active             INTEGER DEFAULT 1,
        created_at            TEXT DEFAULT (datetime('now')),
        updated_at            TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_publish_rules_priority ON publish_rules(priority DESC, is_active);
    `);

    // ─── Bulk Config Import: snapshot table + publish_rules.source column ─
    // Phase A infrastructure for the JSON import feature. Snapshots back up
    // ONLY the keys/rows the importer owns (whitelist enforced in the import
    // engine, not at the schema level), so unrelated settings and manual
    // publish rules survive a rollback.
    db.exec(`
      CREATE TABLE IF NOT EXISTS config_snapshots (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        label           TEXT NOT NULL,
        settings_json   TEXT NOT NULL,
        publish_rules_json TEXT NOT NULL,
        created_by      TEXT,
        import_filename TEXT,
        is_baseline     INTEGER DEFAULT 0,
        created_at      TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_config_snapshots_created ON config_snapshots(created_at DESC);
    `);

    // Add is_baseline column to existing installs that predate the column.
    // is_baseline=1 marks the factory-default row that pruneSnapshots must
    // never delete. Marking by column (not hardcoded id=1) means TRUNCATE
    // + reseed still works correctly because the flag is data, not a
    // positional assumption about sqlite_sequence.
    try {
      db.exec("ALTER TABLE config_snapshots ADD COLUMN is_baseline INTEGER DEFAULT 0");
    } catch (e) { /* already exists */ }

    // Add 'source' column to publish_rules so we can distinguish manual rules
    // (created via UI) from imported rules. Rollback only touches imported.
    try {
      db.exec("ALTER TABLE publish_rules ADD COLUMN source TEXT DEFAULT 'manual'");
    } catch (e) { /* already exists */ }
    try {
      db.exec("ALTER TABLE publish_rules ADD COLUMN key TEXT");
    } catch (e) { /* already exists */ }
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_publish_rules_key ON publish_rules(key) WHERE key IS NOT NULL");

    // Day-zero baseline snapshot — guarantees rollback always has somewhere
    // to go, even on a brand-new install. Only created if no baseline exists
    // yet. Captures only the IMPORT_MANAGED_SETTING_KEYS, matching the
    // serialization the import engine uses.
    try {
      var baselineRow = db.prepare(
        "SELECT id FROM config_snapshots WHERE is_baseline = 1 LIMIT 1"
      ).get();
      if (!baselineRow) {
        var IMPORT_MANAGED_KEYS = require('./config-import-keys').IMPORT_MANAGED_SETTING_KEYS;
        var managedSettings = {};
        for (var mki = 0; mki < IMPORT_MANAGED_KEYS.length; mki++) {
          var k = IMPORT_MANAGED_KEYS[mki];
          var row = db.prepare("SELECT value FROM settings WHERE key = ?").get(k);
          if (row) managedSettings[k] = row.value;
        }
        var importedRules = db.prepare(
          "SELECT * FROM publish_rules WHERE source = 'import' AND key IS NOT NULL"
        ).all();
        var label = 'factory_default_' + new Date().toISOString().replace(/[:.]/g, '-');
        db.prepare(
          "INSERT INTO config_snapshots (label, settings_json, publish_rules_json, created_by, import_filename, is_baseline) " +
          "VALUES (?, ?, ?, ?, ?, 1)"
        ).run(label, JSON.stringify(managedSettings), JSON.stringify(importedRules), 'system', null);
        console.log('[db] Day-zero baseline snapshot created: ' + label);
      }
    } catch (snapErr) {
      console.warn('[db] Failed to create day-zero snapshot: ' + snapErr.message);
    }

    // One-time fix: clean known-wrong model IDs from settings
    var wrongModelIds = {
      'claude-opus-4-6-20250610': 'claude-opus-4-6',
      'claude-sonnet-4-6-20250610': 'claude-sonnet-4-6',
      'claude-opus-4-20250610': 'claude-opus-4-20250514',
      'claude-sonnet-4-20250610': 'claude-sonnet-4-20250514',
    };
    var wrongIds = Object.keys(wrongModelIds);
    for (var wi = 0; wi < wrongIds.length; wi++) {
      try {
        var fixResult = db.prepare(
          "UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = 'ANTHROPIC_MODEL' AND value = ?"
        ).run(wrongModelIds[wrongIds[wi]], wrongIds[wi]);
        if (fixResult.changes > 0) {
          console.log('[db] Fixed stale model ID: ' + wrongIds[wi] + ' → ' + wrongModelIds[wrongIds[wi]]);
        }
      } catch (e) { /* silent */ }
    }

    // ─── Fuel api3_city backfill migration ──────────────────────────────
    // Updates api3_city for cities that were seeded before api3_name overrides
    // were added to fuel-cities.json (district/alt-name API mappings).
    (function backfillFuelApi3() {
      const api3Fixes = [
        ['Amaravati',       'Guntur'],
        ['Kakinada',        'East Godavari'],
        ['Rajahmundry',     'East Godavari'],
        ['Tirupati',        'Chittoor'],
        ['Vijayawada',      'Krishna'],
        ['Visakhapatnam',   'Vishakhapatnam'],
        ['Itanagar',        'Papumpare'],
        ['Guwahati',        'Kamrup Metro'],
        ['Silchar',         'Cachar'],
        ['Bhilai',          'Durg'],
        ['Panaji',          'North Goa'],
        ['Margao',          'South Goa'],
        ['Gandhinagar',     'Gandhi Nagar'],
        ['Gurugram',        'Gurgaon'],
        ['Dharamshala',     'Kangra'],
        ['Jamshedpur',      'East Singhbhum'],
        ['Hubli',           'Dharwad'],
        ['Kochi',           'Ernakulam'],
        ['Mumbai',          'Mumbai City'],
        ['Imphal',          'East Imphal'],
        ['Shillong',        'East Khasi Hills'],
        ['Bhubaneswar',     'Khordha'],
        ['Rourkela',        'Sundargarh'],
        ['Tiruchirappalli', 'Tiruchchirappalli'],
        ['Karimnagar',      'Karim Nagar'],
        ['Agartala',        'West Tripura'],
        ['Kanpur',          'Kanpur Urban'],
        ['Noida',           'Gautam Budh Nagar'],
        ['Prayagraj',       'Allahabad'],
        ['Asansol',         'Paschim Bardhaman'],
        ['Durgapur',        'Paschim Bardhaman'],
        ['Siliguri',        'Darjeeling'],
        ['Port Blair',      'South Andaman'],
        ['Delhi',           'New Delhi'],
        ['Puducherry',      'Pondicherry'],
      ];
      try {
        var upd = db.prepare(
          "UPDATE fuel_cities SET api3_city = ? WHERE city_name = ? AND (api3_city IS NULL OR api3_city = '')"
        );
        var changed = 0;
        for (var i = 0; i < api3Fixes.length; i++) {
          var r = upd.run(api3Fixes[i][1], api3Fixes[i][0]);
          changed += r.changes;
        }
        if (changed > 0) {
          console.log('[db] Backfilled api3_city for ' + changed + ' fuel cities');
        }
      } catch (e) { /* fuel_cities may not exist yet — seeding runs later */ }

      // Fix metals Port Blair state name if already seeded
      try {
        var metFix = db.prepare(
          "UPDATE metals_cities SET state = 'Andaman and Nicobar Islands' WHERE city_name = 'Port Blair' AND state = 'Andaman and Nicobar'"
        );
        var mf = metFix.run();
        if (mf.changes > 0) {
          console.log('[db] Fixed metals Port Blair state name');
        }
      } catch (e) { /* metals_cities may not exist yet */ }
    })();

    // ─── Seed pipeline defaults (INSERT OR IGNORE — never overwrites) ─
    (function seedPipelineDefaults() {
      var defaults = {
        PUBLISH_LANGUAGE: 'en',
        REWRITE_LANGUAGE: 'en',
        EXTRACTION_POLL_MS: '500',
        EXTRACTION_TIMEOUT_MS: '10000',
        EXTRACTION_MAX_SIZE_MB: '5',
        CLUSTERING_DEBOUNCE_MS: '3000',
        CLUSTERING_MAX_WAIT_MS: '10000',
        CLUSTER_QUEUE_MAX: '500',
        MAX_BUFFER_FOR_SIMILARITY: '100',
        REWRITE_CONCURRENCY: '3',
        REWRITE_POLL_MS: '5000',
        LEASE_MINUTES: '8',
        REWRITE_MAX_RETRIES: '3',
        PUBLISH_POLL_MS: '30000',
        WP_TIMEOUT_MS: '60000',
        BATCH_PUBLISH_DELAY_MS: '2000',
        INFRANODUS_CACHE_TTL_MINUTES: '30',
        INFRANODUS_TEXT_LIMIT: '12000',
        INFRANODUS_AUTO_ANALYZE: 'true',
        INFRANODUS_GOOGLE_ENABLED: 'false',
        DEFAULT_AUTHOR_USERNAME: '',
        AUTHOR_ASSIGNMENT_ENABLED: 'true',
        CLASSIFIER_CONFIDENCE_THRESHOLD: '15',
        AUTO_CREATE_WP_TAGS: 'true',
        MAX_TAGS_PER_ARTICLE: '8',
        BLOCKED_TAGS: '',
        // Auto-Rewrite engine
        AUTO_REWRITE_ENABLED: 'false',
        AUTO_REWRITE_DAILY_LIMIT: '100',
        AUTO_REWRITE_HOURLY_LIMIT: '20',
        BACKLOG_MAX_AGE_HOURS: '72',
      };
      var insertDefault = db.prepare(
        "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
      );
      var keys = Object.keys(defaults);
      for (var i = 0; i < keys.length; i++) {
        insertDefault.run(keys[i], defaults[keys[i]]);
      }
    })();

    // ─── Back-fill source_language in drafts from articles table ─────────────
    // Firehose buffer stores language in articles.language but enqueue() was
    // not copying it to drafts.source_language. This one-time UPDATE repairs
    // all existing rows. Safe to run on every boot — WHERE source_language IS
    // NULL means already-filled rows are never touched again.
    try {
      var backfillResult = db.prepare(
        "UPDATE drafts " +
        "SET source_language = (SELECT a.language FROM articles a WHERE a.id = drafts.source_article_id AND a.language IS NOT NULL) " +
        "WHERE source_language IS NULL AND source_article_id IS NOT NULL"
      ).run();
      if (backfillResult.changes > 0) {
        console.log('[db] Back-filled source_language for ' + backfillResult.changes + ' drafts from articles table');
      }
    } catch (bfErr) {
      console.warn('[db] source_language back-fill skipped: ' + bfErr.message);
    }
    // ─── End back-fill ────────────────────────────────────────────────────────

    // ═══════════════════════════════════════════════════════════════════════════
    // Multi-Site Support — Phase 1 schema migration
    // ═══════════════════════════════════════════════════════════════════════════

    // ─── 1. Create `sites` table ─────────────────────────────────────────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS sites (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT NOT NULL,
        slug            TEXT NOT NULL,
        color           TEXT DEFAULT '#3b82f6',
        is_active       INTEGER DEFAULT 1,
        firehose_token  TEXT DEFAULT NULL,
        wp_url          TEXT DEFAULT NULL,
        wp_username     TEXT DEFAULT NULL,
        wp_app_password TEXT DEFAULT NULL,
        created_at      TEXT DEFAULT (datetime('now')),
        updated_at      TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_slug ON sites(slug)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_sites_active ON sites(is_active)');

    // ─── 2. Create `site_config` table (per-site key-value settings) ─────────
    db.exec(`
      CREATE TABLE IF NOT EXISTS site_config (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id    INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        key        TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(site_id, key)
      )
    `);
    // UNIQUE(site_id, key) already creates an implicit index covering both
    // (site_id) prefix and (site_id, key) lookups — no extra indexes needed.

    // ─── 3. Add site_id column to 7 existing tables ─────────────────────────
    var _siteIdTables = [
      'drafts', 'draft_versions', 'published', 'publish_rules',
      'wp_taxonomy_cache', 'classification_log', 'wp_posts_log'
    ];
    for (var _ti = 0; _ti < _siteIdTables.length; _ti++) {
      var _tbl = _siteIdTables[_ti];
      try {
        db.exec('ALTER TABLE ' + _tbl + ' ADD COLUMN site_id INTEGER DEFAULT 1');
      } catch (_e) { /* column already exists — safe to ignore */ }
      db.exec('CREATE INDEX IF NOT EXISTS idx_' + _tbl + '_site ON ' + _tbl + '(site_id)');
    }

    // ─── 3b. Tag articles with source_site_id (which site's firehose brought it)
    //         Articles don't "belong" to a site the way drafts do — the same
    //         article can cluster and fan out to multiple sites. But we need
    //         to know WHICH firehose received it so the Feed page can filter.
    try {
      db.exec('ALTER TABLE articles ADD COLUMN source_site_id INTEGER DEFAULT 1');
    } catch (_e) { /* column already exists — safe to ignore */ }
    db.exec('CREATE INDEX IF NOT EXISTS idx_articles_source_site ON articles(source_site_id)');

    // ─── 3c. Tag logs with site_id so /api/logs can be scoped per site.
    //         NULL = system-wide log (startup, scheduler tick, etc.).
    //         Major modules with their own siteId (feeds-pool, publisher,
    //         wp-publisher) write logs tagged via logger.forSite(siteId).
    try {
      db.exec('ALTER TABLE logs ADD COLUMN site_id INTEGER DEFAULT NULL');
    } catch (_e) { /* column already exists — safe to ignore */ }
    db.exec('CREATE INDEX IF NOT EXISTS idx_logs_site ON logs(site_id)');

    // ═══════════════════════════════════════════════════════════════════════════
    // Feeds — the sole source of truth for firehose ingestion and publish
    // gating. A Feed is a single config record that bundles:
    //   • source  — where articles come from (query, country, filters)
    //   • dest    — where they go on WP (category, author, tags, status)
    //   • quality — per-feed gates (daily limit, blocked keywords, min sources)
    //
    // Invariants:
    //   • Feed → Site is 1:1 (FK site_id NOT NULL)
    //   • One SSE connection per feed — every Feed has its own firehose_token
    //   • Per-feed clusters (no fan-out) — articles carry feed_id from ingest
    //   • Per-feed quality gates and per-feed auto-publish toggle
    // ═══════════════════════════════════════════════════════════════════════════
    db.exec(`
      CREATE TABLE IF NOT EXISTS feeds (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        site_id                 INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
        name                    TEXT NOT NULL,
        kind                    TEXT NOT NULL DEFAULT 'firehose',
        is_active               INTEGER DEFAULT 1,
        source_config           TEXT NOT NULL DEFAULT '{}',
        dest_config             TEXT NOT NULL DEFAULT '{}',
        quality_config          TEXT NOT NULL DEFAULT '{}',
        firehose_token          TEXT DEFAULT NULL,
        firehose_last_event_id  TEXT DEFAULT NULL,
        last_fetched_at         TEXT DEFAULT NULL,
        stories_count           INTEGER DEFAULT 0,
        drafts_count            INTEGER DEFAULT 0,
        published_count         INTEGER DEFAULT 0,
        created_at              TEXT DEFAULT (datetime('now')),
        updated_at              TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_feeds_site   ON feeds(site_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_feeds_active ON feeds(is_active)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_feeds_kind   ON feeds(kind)');

    // Tag every row in the per-feed pipeline with the originating feed. NULL
    // means "legacy row created before Feeds existed" — kept for historical
    // audit. Every new row created today stamps feed_id so the Feed detail
    // page can filter cleanly.
    var _feedIdTables = ['articles', 'clusters', 'drafts', 'published'];
    for (var _fti = 0; _fti < _feedIdTables.length; _fti++) {
      var _ftbl = _feedIdTables[_fti];
      try {
        db.exec('ALTER TABLE ' + _ftbl + ' ADD COLUMN feed_id INTEGER DEFAULT NULL');
      } catch (_e) { /* column already exists — safe to ignore */ }
      db.exec('CREATE INDEX IF NOT EXISTS idx_' + _ftbl + '_feed ON ' + _ftbl + '(feed_id)');
    }

    // Track Ahrefs-side identifiers so we can update and tear down what we
    // provisioned on the user's behalf. auto_provisioned=1 means "this app
    // created this tap, this app owns its deletion on feed delete".
    try { db.exec('ALTER TABLE feeds ADD COLUMN firehose_tap_id TEXT DEFAULT NULL'); } catch (_e) {}
    try { db.exec('ALTER TABLE feeds ADD COLUMN firehose_rule_id TEXT DEFAULT NULL'); } catch (_e) {}
    try { db.exec('ALTER TABLE feeds ADD COLUMN auto_provisioned INTEGER DEFAULT 0'); } catch (_e) {}

    // Running count of SSE error events since the last successful article.
    // Resets to 0 on article receipt; Failed page surfaces feeds where the
    // count >= 3 AND quality_config.notify_failure = true.
    try { db.exec('ALTER TABLE feeds ADD COLUMN consecutive_failures INTEGER DEFAULT 0'); } catch (_e) {}

    // ─── 4. Fix drafts unique index: UNIQUE(source_url) → UNIQUE(source_url, site_id)
    //        Same URL can exist as drafts for different sites in multi-site mode.
    //        Drop both the old non-unique and UNIQUE indexes — the new composite
    //        index covers source_url-only lookups via its leftmost prefix.
    try {
      db.exec('DROP INDEX IF EXISTS idx_drafts_url');
      db.exec('DROP INDEX IF EXISTS idx_drafts_url_unique');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_drafts_url_site_unique ON drafts(source_url, site_id)');
    } catch (_ue) {
      console.warn('[db] Could not update drafts unique index for multi-site: ' + _ue.message);
    }

    // ─── 5. Seed default site (id=1) from current settings ──────────────────
    //        Only runs when the sites table is empty (first migration).
    //        Pulls WP credentials and firehose token from the settings table.
    (function _seedDefaultSite() {
      var siteCount = db.prepare('SELECT COUNT(*) as c FROM sites').get().c;
      if (siteCount > 0) return; // already seeded

      // Read current credentials from settings table
      function _getS(k) {
        var row = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
        return (row && row.value) ? row.value : null;
      }

      db.prepare(
        'INSERT INTO sites (id, name, slug, color, is_active, firehose_token, wp_url, wp_username, wp_app_password) ' +
        'VALUES (1, ?, ?, ?, 1, ?, ?, ?, ?)'
      ).run(
        'Default Site', 'default', '#3b82f6',
        _getS('FIREHOSE_TOKEN'),
        _getS('WP_SITE_URL') || _getS('WP_URL'),
        _getS('WP_USERNAME'),
        _getS('WP_APP_PASSWORD')
      );

      // Copy per-site settings from global settings → site_config for site 1
      var _perSiteKeys = [
        'PUBLISH_LANGUAGE', 'REWRITE_LANGUAGE',
        'AUTO_REWRITE_ENABLED', 'AUTO_REWRITE_DAILY_LIMIT', 'AUTO_REWRITE_HOURLY_LIMIT',
        'AUTO_REWRITE_MIN_SIMILARITY', 'AUTO_REWRITE_MIN_SOURCES',
        'PUBLISH_RATE_COUNT', 'PUBLISH_RATE_UNIT',
        'MAX_PUBLISH_PER_HOUR', 'PUBLISH_COOLDOWN_MINUTES',
        'WP_AUTHOR_ID', 'WP_DEFAULT_CATEGORY', 'WP_ALWAYS_APPEND_CATEGORY_ID',
        'WP_POST_STATUS', 'WP_COMMENT_STATUS', 'WP_PING_STATUS',
        'DEFAULT_AUTHOR_USERNAME', 'DEFAULT_CATEGORY_SLUG',
        'AUTHOR_ASSIGNMENT_ENABLED', 'CLASSIFIER_CONFIDENCE_THRESHOLD',
        'AUTO_CREATE_WP_TAGS', 'MAX_TAGS_PER_ARTICLE', 'BLOCKED_TAGS',
        'WP_TIMEOUT_MS'
      ];

      var _insertSiteConfig = db.prepare(
        'INSERT OR IGNORE INTO site_config (site_id, key, value) VALUES (1, ?, ?)'
      );
      var _copiedCount = 0;
      for (var _ki = 0; _ki < _perSiteKeys.length; _ki++) {
        var _val = _getS(_perSiteKeys[_ki]);
        if (_val !== null) {
          _insertSiteConfig.run(_perSiteKeys[_ki], _val);
          _copiedCount++;
        }
      }

      // Copy firehose_last_event_id if it exists
      var _lastEvt = _getS('firehose_last_event_id');
      if (_lastEvt) {
        _insertSiteConfig.run('firehose_last_event_id', _lastEvt);
        _copiedCount++;
      }

      console.log('[db] Multi-site: seeded default site (id=1), copied ' + _copiedCount + ' settings to site_config');
    })();

    // ═══════════════════════════════════════════════════════════════════════════
    // End Multi-Site Phase 1 migration
    // ═══════════════════════════════════════════════════════════════════════════

    // ─── Article-level image capture ──────────────────────────────────────────
    // Firehose events carry an image URL in the payload (og:image / thumbnail
    // / media); previously we dropped it and waited for the extractor to
    // re-download the page and parse meta tags itself. That left every
    // "detected" cluster imageless in the Feed-detail preview. Store the
    // Firehose-supplied image at ingest so the UI can show it immediately,
    // and the extractor still gets to overwrite with a higher-quality pick
    // later (via drafts.featured_image).
    try { db.exec('ALTER TABLE articles ADD COLUMN image_url TEXT DEFAULT NULL'); } catch (_e) { /* column exists */ }

    // ─── Site Home performance indexes ────────────────────────────────────────
    // The per-site Overview screen fires 4 concurrent API calls on load:
    //   /api/sites/:id/stats        — published/queue/feeds/quality roll-ups
    //   /api/sites/:id/activity     — latest logs filtered by module + message
    //   /api/sites/:id/needs-review — detected clusters by quality
    //   /api/sites/:id/top-sources  — per-domain article count over last N days
    // better-sqlite3 is synchronous, so a single slow query blocks every other
    // request through the same Node process. These composite indexes make each
    // of those roll-ups use an index scan instead of a full-table sort, which
    // is what pushed /api/sites/1/stats past nginx's upstream timeout on prod.
    db.exec('CREATE INDEX IF NOT EXISTS idx_published_site_time    ON published(site_id, published_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_articles_source_recv   ON articles(source_site_id, received_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_clusters_feed_status   ON clusters(feed_id, status, detected_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_clusters_feed_detected ON clusters(feed_id, detected_at)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_drafts_cluster_site    ON drafts(cluster_id, site_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_logs_site_created      ON logs(site_id, created_at)');

    console.log('[db] Schema migrations completed successfully');
  } catch (err) {
    console.error('[db] Migration failed:', err.message);
    throw err;
  }
}

// Run migrations immediately on require
runMigrations();

/**
 * Graceful shutdown helper.
 */
function closeDb() {
  try {
    if (db && db.open) {
      db.close();
      console.log('[db] Database connection closed');
    }
  } catch (err) {
    console.error('[db] Error closing database:', err.message);
  }
}

/**
 * Recover drafts stuck in transient states (rewriting, fetching, publishing).
 * Called once on server startup.
 */
function recoverStuckDrafts(logger) {
  try {
    var stuck = db.prepare(
      "SELECT id, status, retry_count, max_retries, wp_post_id FROM drafts WHERE status IN ('fetching', 'rewriting', 'publishing')"
    ).all();

    for (var i = 0; i < stuck.length; i++) {
      var draft = stuck[i];
      var newRetry = (draft.retry_count || 0) + 1;
      var maxR = draft.max_retries || 3;

      if (newRetry >= maxR) {
        db.prepare(
          "UPDATE drafts SET status = 'failed', failed_permanent = 1, retry_count = ?, " +
          "error_message = ?, last_error_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
        ).run(newRetry, 'Stuck in ' + draft.status + ' after ' + newRetry + ' attempts (server restarted)', draft.id);
        if (logger) logger.warn('recovery', 'Draft ' + draft.id + ': permanently failed after ' + newRetry + ' stuck recoveries');
      } else {
        // For publishing-state drafts: if wp_post_id is already set the WP post was
        // created before the crash — mark 'published' to avoid creating a duplicate.
        var resetStatus;
        if (draft.status === 'publishing') {
          resetStatus = draft.wp_post_id ? 'published' : 'ready';
        } else {
          resetStatus = 'draft';
        }
        db.prepare(
          "UPDATE drafts SET status = ?, retry_count = ?, " +
          "error_message = ?, last_error_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
        ).run(resetStatus, newRetry, 'Recovered from stuck ' + draft.status + ' state (server restarted)', draft.id);
        if (logger) logger.info('recovery', 'Draft ' + draft.id + ': ' + draft.status + ' -> ' + resetStatus + (draft.wp_post_id ? ' (wp_post_id=' + draft.wp_post_id + ' preserved)' : '') + ' (attempt ' + newRetry + '/' + maxR + ')');
      }
    }

    if (stuck.length > 0 && logger) {
      logger.info('recovery', 'Recovered ' + stuck.length + ' stuck draft(s) on startup');
    }

    // ─── Recover drafts stuck in extraction_status = 'extracting' ──────
    // If extraction_status is 'extracting' but locked_by is NULL or lease expired,
    // the extraction was interrupted. Reset to 'pending' so they get re-queued.
    var stuckExtracting = db.prepare(
      "UPDATE drafts SET extraction_status = 'pending', " +
      "locked_by = NULL, locked_at = NULL, lease_expires_at = NULL, " +
      "updated_at = datetime('now') " +
      "WHERE extraction_status = 'extracting' " +
      "AND (locked_by IS NULL OR lease_expires_at < datetime('now'))"
    ).run();

    if (stuckExtracting.changes > 0) {
      if (logger) logger.info('recovery', 'Recovered ' + stuckExtracting.changes + ' drafts stuck in extracting state');
    }
  } catch (err) {
    console.error('[db] Stuck draft recovery failed:', err.message);
  }
}

module.exports = {
  db,
  closeDb,
  runMigrations,
  recoverStuckDrafts,
};
