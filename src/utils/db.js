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

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');

  // Enable foreign keys
  db.pragma('foreign_keys = ON');

  // Reasonable busy timeout (5 seconds)
  db.pragma('busy_timeout = 5000');
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

    // Add extracted_content column if it doesn't exist
    try {
      db.exec('ALTER TABLE articles ADD COLUMN extracted_content TEXT');
    } catch (e) {
      // Column already exists — ignore
    }

    // Add new columns to published table if they don't exist
    try {
      db.exec('ALTER TABLE published ADD COLUMN word_count INTEGER DEFAULT 0');
    } catch (e) { /* already exists */ }
    try {
      db.exec('ALTER TABLE published ADD COLUMN target_keyword TEXT');
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

module.exports = {
  db,
  closeDb,
  runMigrations,
};
