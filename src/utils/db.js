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

    // Autopilot decisions log table
    db.exec(`
      CREATE TABLE IF NOT EXISTS autopilot_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cluster_id INTEGER,
        draft_title TEXT,
        approved INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )
    `);
    db.exec('CREATE INDEX IF NOT EXISTS idx_autopilot_decisions_created ON autopilot_decisions(created_at)');

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

    // ─── Seed autopilot + pipeline defaults (INSERT OR IGNORE — never overwrites) ─
    (function seedAutopilotDefaults() {
      var defaults = {
        AUTOPILOT_ENABLED: 'false',
        AUTOPILOT_DAILY_TARGET: '50',
        AUTOPILOT_START_HOUR: '6',
        AUTOPILOT_END_HOUR: '23',
        AUTOPILOT_WEEKENDS: 'true',
        AUTOPILOT_MIN_SIMILARITY: '0.70',
        AUTOPILOT_MIN_TIER: '0',
        AUTOPILOT_MIN_WORDS: '300',
        AUTOPILOT_BLOCKED_KEYWORDS: 'horoscope,rashifal,zodiac,numerology,angel number,wishes,greetings,lottery,panchang',
        AUTOPILOT_BLOCKED_DOMAINS: '',
        AUTOPILOT_ALLOWED_DOMAINS: '',
        AUTOPILOT_BLOCKED_CATEGORIES: '',
        AUTOPILOT_AUTO_CATEGORIZE: 'true',
        PUBLISH_LANGUAGE: 'en',
        REWRITE_LANGUAGE: 'en',
        FIREHOSE_SINCE: '1h',
        FIREHOSE_TIMEOUT: '300',
        FIREHOSE_RECONNECT_MIN: '2000',
        FIREHOSE_RECONNECT_MAX: '60000',
        FIREHOSE_ALLOWED_DOMAINS: '',
        FIREHOSE_BLOCKED_DOMAINS: '',
        FIREHOSE_ALLOWED_LANGS: 'en,hi',
        FIREHOSE_CUSTOM_TEMPLATES: '',
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
      };
      var insertDefault = db.prepare(
        "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))"
      );
      var keys = Object.keys(defaults);
      for (var i = 0; i < keys.length; i++) {
        insertDefault.run(keys[i], defaults[keys[i]]);
      }
    })();

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
