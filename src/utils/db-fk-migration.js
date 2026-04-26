'use strict';

// One-time FK cascade migration. SQLite doesn't support
// ALTER TABLE ADD FOREIGN KEY, so each affected table gets recreated
// using the standard 12-step recipe:
//   1. PRAGMA foreign_keys=OFF
//   2. BEGIN
//   3. Snapshot existing indexes
//   4. CREATE TABLE __new_X (cols + FK clauses)
//   5. INSERT INTO __new_X (cols) SELECT cols FROM X
//   6. DROP TABLE X
//   7. ALTER __new_X RENAME TO X
//   8. Recreate indexes
//   9. COMMIT
//  10. PRAGMA foreign_keys=ON
//  11. PRAGMA foreign_key_check
//
// Idempotent: if a table already has the expected FK declared (via
// PRAGMA foreign_key_list), the recreate is skipped. Re-runs are no-ops.
//
// Per-table try/catch: a failure on one table doesn't break the boot.
// We log the failure with context and move on. The whole process runs
// inside the caller's runMigrations() try/catch as a final belt.
//
// Orphan cleanup runs FIRST so the INSERT INTO __new_X step doesn't trip
// the new FK constraints on stale rows pointing at non-existent parents.
// The cleanup count is logged so admins can see what was removed.

// ─── FK matrix ─────────────────────────────────────────────────────────────
// Each entry: { table, fks: [{ column, parent, onDelete }] }
// Order matters slightly — parents before children — but since we use
// PRAGMA foreign_keys=OFF during recreate, ordering only matters for the
// final foreign_key_check at the end.

var FK_MATRIX = [
  { table: 'articles', fks: [
    { column: 'feed_id',         parent: 'feeds',    onDelete: 'CASCADE'  },
    { column: 'cluster_id',      parent: 'clusters', onDelete: 'SET NULL' },
    { column: 'source_site_id',  parent: 'sites',    onDelete: 'CASCADE'  },
  ]},
  { table: 'clusters', fks: [
    { column: 'feed_id',             parent: 'feeds',    onDelete: 'CASCADE'  },
    { column: 'primary_article_id',  parent: 'articles', onDelete: 'SET NULL' },
  ]},
  { table: 'drafts', fks: [
    { column: 'cluster_id',         parent: 'clusters', onDelete: 'CASCADE'  },
    { column: 'feed_id',            parent: 'feeds',    onDelete: 'CASCADE'  },
    { column: 'site_id',            parent: 'sites',    onDelete: 'CASCADE'  },
    { column: 'source_article_id',  parent: 'articles', onDelete: 'SET NULL' },
  ]},
  { table: 'draft_versions', fks: [
    { column: 'draft_id',  parent: 'drafts', onDelete: 'CASCADE' },
    { column: 'site_id',   parent: 'sites',  onDelete: 'CASCADE' },
  ]},
  { table: 'published', fks: [
    { column: 'cluster_id',  parent: 'clusters', onDelete: 'RESTRICT' },
    { column: 'feed_id',     parent: 'feeds',    onDelete: 'SET NULL' },
    { column: 'site_id',     parent: 'sites',    onDelete: 'RESTRICT' },
  ]},
  { table: 'logs',                 fks: [{ column: 'site_id', parent: 'sites', onDelete: 'CASCADE' }] },
  { table: 'classification_log',   fks: [{ column: 'site_id', parent: 'sites', onDelete: 'CASCADE' }] },
  { table: 'wp_posts_log',         fks: [{ column: 'site_id', parent: 'sites', onDelete: 'CASCADE' }] },
  { table: 'wp_taxonomy_cache',    fks: [{ column: 'site_id', parent: 'sites', onDelete: 'CASCADE' }] },
  { table: 'publish_rules',        fks: [{ column: 'site_id', parent: 'sites', onDelete: 'CASCADE' }] },
];

// ─── Helpers ───────────────────────────────────────────────────────────────

function tableExists(db, name) {
  var row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return !!row;
}

function tableColumnNames(db, name) {
  return db.prepare("PRAGMA table_info(" + name + ")").all().map(function (r) { return r.name; });
}

function existingFks(db, name) {
  return db.prepare("PRAGMA foreign_key_list(" + name + ")").all();
}

// True if the table already has every FK we want (by column → parent pair).
// Existing FKs from prior schema decisions (e.g. infranodus_history.draft_id)
// are preserved — we only check that OUR target FKs are present.
function alreadyHasAllFks(db, table, fkSpec) {
  var existing = existingFks(db, table);
  var matchSet = {};
  existing.forEach(function (e) { matchSet[e['from'] + '→' + e.table] = true; });
  for (var i = 0; i < fkSpec.length; i++) {
    var key = fkSpec[i].column + '→' + fkSpec[i].parent;
    if (!matchSet[key]) return false;
  }
  return true;
}

// Build the CREATE TABLE statement for the new (FK-equipped) table.
// We start from the LIVE CREATE TABLE SQL in sqlite_master so we don't
// drop columns added by historical ALTER TABLE statements. The original
// SQL ends with `)` (sometimes followed by `WITHOUT ROWID` etc.); we
// inject our FOREIGN KEY clauses before the final `)`.
function buildNewCreateSql(db, table, newName, fkSpec) {
  var row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!row || !row.sql) {
    throw new Error('No CREATE TABLE SQL found for ' + table);
  }
  var oldSql = row.sql;

  // Replace the table name (handles both `CREATE TABLE name` and
  // `CREATE TABLE IF NOT EXISTS name`).
  var newSql = oldSql.replace(
    /CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?["`]?(\w+)["`]?/i,
    'CREATE TABLE ' + newName
  );

  // Build FK clauses.
  var fkClauses = fkSpec.map(function (f) {
    return 'FOREIGN KEY (' + f.column + ') REFERENCES ' + f.parent + '(id) ON DELETE ' + f.onDelete;
  }).join(', ');

  // Inject before the FINAL `)` of the column list. Avoid matching `)`
  // that's part of a default expression or check constraint by counting
  // parens — find the rightmost `)` that closes the outermost group.
  var depth = 0;
  var closeIdx = -1;
  for (var i = newSql.length - 1; i >= 0; i--) {
    var ch = newSql.charAt(i);
    if (ch === ')') { depth++; if (depth === 1) { closeIdx = i; break; } }
    if (ch === '(') depth--;
  }
  if (closeIdx === -1) throw new Error('Could not find closing `)` in CREATE TABLE for ' + table);

  // Insert ", <fk clauses>" right before the closing paren.
  newSql = newSql.slice(0, closeIdx) + ',\n  ' + fkClauses + '\n' + newSql.slice(closeIdx);
  return newSql;
}

function existingIndexes(db, table) {
  return db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL"
  ).all(table);
}

// Delete rows pointing at parents that no longer exist. SQLite would
// otherwise reject the post-migration foreign_key_check (or fail the
// INSERT INTO __new_X step under PRAGMA foreign_keys=ON, depending on
// version). Returns total count of orphans removed.
function cleanOrphans(db, fkSpec, table) {
  var total = 0;
  for (var i = 0; i < fkSpec.length; i++) {
    var col = fkSpec[i].column;
    var parent = fkSpec[i].parent;
    try {
      var sql = 'DELETE FROM ' + table + ' WHERE ' + col + ' IS NOT NULL ' +
        'AND ' + col + ' NOT IN (SELECT id FROM ' + parent + ')';
      var result = db.prepare(sql).run();
      total += result.changes;
    } catch (e) {
      // If the parent table doesn't exist (early bootstrap), skip cleanly.
      if (!/no such table/i.test(e.message)) throw e;
    }
  }
  return total;
}

// Recreate one table with FKs. Returns { skipped, recreated, orphansCleaned }.
function recreateTable(db, table, fkSpec) {
  if (!tableExists(db, table)) return { skipped: true, recreated: false, orphansCleaned: 0 };
  if (alreadyHasAllFks(db, table, fkSpec)) return { skipped: true, recreated: false, orphansCleaned: 0 };

  var orphansCleaned = cleanOrphans(db, fkSpec, table);

  var cols = tableColumnNames(db, table);
  if (cols.length === 0) throw new Error('No columns found for ' + table);
  var colList = cols.join(', ');

  var tempName = '__new_' + table + '_' + Date.now();
  var createSql = buildNewCreateSql(db, table, tempName, fkSpec);
  var indexes = existingIndexes(db, table);

  // The actual recreate runs in a transaction. PRAGMA foreign_keys is
  // already OFF (set at the call-site BEFORE invoking this function).
  var txn = db.transaction(function () {
    db.exec(createSql);
    db.exec('INSERT INTO ' + tempName + ' (' + colList + ') SELECT ' + colList + ' FROM ' + table);
    db.exec('DROP TABLE ' + table);
    db.exec('ALTER TABLE ' + tempName + ' RENAME TO ' + table);
    // Recreate indexes (RENAME TO preserves indexes attached to the
    // table, but we re-run their CREATE statements here as a defence
    // against drift in older SQLite versions).
    for (var i = 0; i < indexes.length; i++) {
      try { db.exec(indexes[i].sql); }
      catch (idxErr) {
        // Index might already exist post-rename — log + continue.
        if (!/already exists/i.test(idxErr.message)) throw idxErr;
      }
    }
  });
  txn();

  return { skipped: false, recreated: true, orphansCleaned: orphansCleaned };
}

// Top-level entry. Runs the whole migration with PRAGMA foreign_keys
// toggled OFF / ON around it. Per-table failures are logged but don't
// stop the loop — partial migration is better than a hard boot failure.
function migrateAddForeignKeys(db, logger) {
  var log = logger && typeof logger.log === 'function' ? logger : { log: console.log, warn: console.warn, error: console.error };

  // Save current FK enforcement state so we don't surprise callers.
  var fkBefore = db.pragma('foreign_keys', { simple: true });
  db.pragma('foreign_keys = OFF');

  var summary = { tables: 0, recreated: 0, skipped: 0, orphans: 0, failures: [] };

  try {
    for (var i = 0; i < FK_MATRIX.length; i++) {
      var spec = FK_MATRIX[i];
      summary.tables++;
      try {
        var r = recreateTable(db, spec.table, spec.fks);
        if (r.recreated) summary.recreated++;
        else summary.skipped++;
        summary.orphans += r.orphansCleaned;
        if (r.recreated) {
          log.log('[db-fks] ' + spec.table + ': recreated with FKs (' + r.orphansCleaned + ' orphan(s) removed)');
        }
      } catch (tErr) {
        summary.failures.push({ table: spec.table, error: tErr.message });
        log.warn('[db-fks] ' + spec.table + ': migration failed — ' + tErr.message);
      }
    }
  } finally {
    // Always re-enable FK enforcement, even if a recreate threw partway.
    // Production should always run with FKs ON; the OFF state was only
    // for the recreate window.
    db.pragma('foreign_keys = ON');
  }

  // Sanity check — list any FK violations introduced by the migration.
  // Empty result means clean.
  try {
    var violations = db.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) {
      log.warn('[db-fks] FK violations after migration: ' + JSON.stringify(violations.slice(0, 10)));
      summary.violations = violations.length;
    }
  } catch (_e) { /* PRAGMA foreign_key_check is read-only, can't really fail */ }

  if (summary.recreated > 0 || summary.orphans > 0) {
    log.log('[db-fks] Migration complete — recreated ' + summary.recreated + '/' + summary.tables +
      ' tables, removed ' + summary.orphans + ' orphan rows.');
  }

  // Restore the caller's prior FK setting only if they had it OFF before
  // (unusual). Default policy is FK enforcement ON post-migration.
  if (fkBefore === 0 && process.env.NODE_ENV !== 'production') {
    db.pragma('foreign_keys = OFF');
  }

  return summary;
}

module.exports = {
  migrateAddForeignKeys: migrateAddForeignKeys,
  // Exported for tests
  FK_MATRIX: FK_MATRIX,
  alreadyHasAllFks: alreadyHasAllFks,
  buildNewCreateSql: buildNewCreateSql,
  cleanOrphans: cleanOrphans,
  recreateTable: recreateTable,
};
