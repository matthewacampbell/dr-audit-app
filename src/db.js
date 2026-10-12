const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(__dirname, '..', 'data', 'app.db');

fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA_VERSION = 6;

function hasRows(table) {
  try {
    return !!db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
  } catch {
    return false; // table doesn't exist
  }
}

function columnsOf(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

function migrate() {
  const version = db.pragma('user_version', { simple: true });

  // v1 -> v2: devices now belong to a company, and audit_devices became a link
  // between a report and a device. The v1 device tables were never written to by
  // the app, so they can be recreated. Refuse to drop them if they hold data.
  if (version < 2) {
    const cols = db.prepare('PRAGMA table_info(audit_devices)').all().map((c) => c.name);
    if (cols.includes('name')) {
      if (['audit_devices', 'backup_times', 'screenshots'].some(hasRows)) {
        throw new Error(
          'Database migration needed, but the old device tables contain data. Back up data/app.db and ask for help before continuing.'
        );
      }
      db.exec('DROP TABLE IF EXISTS screenshots; DROP TABLE IF EXISTS backup_times; DROP TABLE audit_devices;');
    }
  }

  // v2 -> v3: backup times and screenshots were redesigned. Every audited device now has
  // one "backup" and one "failover" test (device_tests), and screenshots belong to a test.
  // The v2 tables were never written to by the app, so they can be recreated.
  if (version < 3) {
    const oldBackups = columnsOf('backup_times').length > 0;
    const oldShots = columnsOf('screenshots').length > 0 && !columnsOf('screenshots').includes('test_id');
    if (oldBackups || oldShots) {
      if (['backup_times', 'screenshots'].some(hasRows)) {
        throw new Error(
          'Database migration needed, but the old backup/screenshot tables contain data. Back up data/app.db and ask for help before continuing.'
        );
      }
      db.exec('DROP TABLE IF EXISTS screenshots; DROP TABLE IF EXISTS backup_times;');
    }
  }
}

// A sensible starting procedure. Replace it with your own on the Procedure page.
const DEFAULT_STEPS = [
  'Confirm the latest backup job completed successfully in the backup application',
  'Record the backup start and finish times and capture a screenshot as evidence',
  'Confirm backups are stored on the correct storage and there is enough free capacity',
  'Perform a test restore of a sample file or machine and confirm it opens correctly',
  'Confirm the offsite or replica copy is up to date',
  'Perform the failover test and confirm services start correctly on the replica',
  'Record the failover start and finish times and capture a screenshot as evidence',
  'Confirm normal operation is restored after the test',
];

// v4 -> v5: an audit's status became in_progress / pass / fail (it used to be draft / submitted),
// and "notes" became "comments". SQLite can't change a CHECK constraint in place, so the table is
// rebuilt. Old "submitted" audits get their result from their procedure steps (any fail -> fail,
// every step passed -> pass); anything else is reopened as in_progress.
function rebuildAuditReports() {
  const cols = columnsOf('audit_reports');
  if (cols.includes('comments') && !cols.includes('notes')) return; // already new
  db.pragma('foreign_keys = OFF');
  try {
    db.transaction(() => {
      db.exec(`
        CREATE TABLE audit_reports_new (
          id         INTEGER PRIMARY KEY AUTOINCREMENT,
          company_id INTEGER NOT NULL REFERENCES companies(id),
          created_by INTEGER NOT NULL REFERENCES users(id),
          audit_date TEXT NOT NULL DEFAULT (date('now')),
          status     TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'pass', 'fail')),
          comments   TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO audit_reports_new (id, company_id, created_by, audit_date, status, comments, created_at, updated_at)
        SELECT r.id, r.company_id, r.created_by, r.audit_date,
               CASE
                 WHEN r.status <> 'submitted' THEN 'in_progress'
                 WHEN EXISTS (SELECT 1 FROM audit_steps s WHERE s.report_id = r.id AND s.result = 'fail') THEN 'fail'
                 WHEN EXISTS (SELECT 1 FROM audit_steps s WHERE s.report_id = r.id)
                      AND NOT EXISTS (SELECT 1 FROM audit_steps s WHERE s.report_id = r.id AND s.result IS NULL) THEN 'pass'
                 ELSE 'in_progress'
               END,
               ${cols.includes('notes') ? 'r.notes' : 'NULL'}, r.created_at, r.updated_at
        FROM audit_reports r;
        DROP TABLE audit_reports;
        ALTER TABLE audit_reports_new RENAME TO audit_reports;
        CREATE INDEX IF NOT EXISTS idx_reports_company ON audit_reports(company_id);
      `);
    })();
    const broken = db.pragma('foreign_key_check');
    if (broken.length) throw new Error('Database upgrade left broken links: ' + JSON.stringify(broken.slice(0, 3)));
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function migrateAfterSchema(fromVersion) {
  // v3 -> v4: company account login + storage, and the audit procedure.
  if (!columnsOf('companies').includes('account_login')) {
    db.exec('ALTER TABLE companies ADD COLUMN account_login TEXT');
  }
  if (!columnsOf('companies').includes('storage')) {
    db.exec('ALTER TABLE companies ADD COLUMN storage TEXT');
  }
  rebuildAuditReports();
  // v5 -> v6: every user has a Name and Surname (shown on reports as "Completed by").
  // Existing users start without one and are shown by username until an admin fills it in.
  for (const col of ['first_name', 'last_name']) {
    if (!columnsOf('users').includes(col)) db.exec(`ALTER TABLE users ADD COLUMN ${col} TEXT`);
  }
  // Seed the starter procedure once (only while upgrading), so deleting every step stays deleted.
  if (fromVersion < 4 && !hasRows('procedure_steps')) {
    const insert = db.prepare('INSERT INTO procedure_steps (position, text) VALUES (?, ?)');
    DEFAULT_STEPS.forEach((text, i) => insert.run(i + 1, text));
  }
}

const fromVersion = db.pragma('user_version', { simple: true });
migrate();
// CREATE ... IF NOT EXISTS, so this is safe to run on every start.
db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
migrateAfterSchema(fromVersion);
db.pragma(`user_version = ${SCHEMA_VERSION}`);

module.exports = db;
