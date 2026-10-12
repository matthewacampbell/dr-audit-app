CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  first_name    TEXT,   -- "Name"; shown on reports as "Completed by"
  last_name     TEXT,   -- "Surname"
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('admin', 'employee')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS companies (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  notes         TEXT,
  account_login TEXT,   -- username only, for the company's backup application (never a password)
  storage       TEXT,   -- free text: what storage the company uses
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- People to contact at a company (name, phone and email are what the app shows; role/notes are legacy).
CREATE TABLE IF NOT EXISTS company_contacts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  role       TEXT,
  email      TEXT,
  phone      TEXT,
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A company's devices. They live on the company and are reused across audits.
-- "Retired" devices (active = 0) are kept for history but hidden from new audits.
CREATE TABLE IF NOT EXISTS devices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id),
  name        TEXT NOT NULL,
  device_type TEXT,
  identifier  TEXT,   -- serial number, IP, hostname, etc.
  notes       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_reports (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  created_by INTEGER NOT NULL REFERENCES users(id),
  audit_date TEXT NOT NULL DEFAULT (date('now')),
  -- in_progress until the auditor marks the result: pass or fail
  status     TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'pass', 'fail')),
  comments   TEXT,   -- "Additional comments", printed at the end of the report
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Which of the company's devices were audited in a given report.
-- Backup times and screenshots hang off this row, so they belong to one audit.
CREATE TABLE IF NOT EXISTS audit_devices (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES audit_reports(id) ON DELETE CASCADE,
  device_id INTEGER NOT NULL REFERENCES devices(id),
  notes     TEXT,
  UNIQUE (report_id, device_id)
);

-- One backup test and one failover test per device per audit.
-- Duration is not stored: it is always (finished_at - started_at).
-- Times are local wall-clock text, e.g. 2026-10-06T22:15 or 2026-10-06T22:15:30.
CREATE TABLE IF NOT EXISTS device_tests (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  audit_device_id INTEGER NOT NULL REFERENCES audit_devices(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('backup', 'failover')),
  started_at      TEXT,
  finished_at     TEXT,
  UNIQUE (audit_device_id, kind)
);

-- Evidence screenshots for a test. The image itself lives in storage (S3 or local disk);
-- storage_key is the object's name there.
CREATE TABLE IF NOT EXISTS screenshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  test_id       INTEGER NOT NULL REFERENCES device_tests(id) ON DELETE CASCADE,
  storage_key   TEXT NOT NULL,
  original_name TEXT,
  content_type  TEXT NOT NULL,
  size_bytes    INTEGER,
  uploaded_by   INTEGER REFERENCES users(id),
  uploaded_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The standard audit procedure. Each new audit copies these steps (so later edits
-- never change the steps of audits that were already done).
CREATE TABLE IF NOT EXISTS procedure_steps (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  position INTEGER NOT NULL,
  text     TEXT NOT NULL
);

-- A step in one specific audit, marked pass or fail (NULL = not marked yet).
CREATE TABLE IF NOT EXISTS audit_steps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id  INTEGER NOT NULL REFERENCES audit_reports(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  text       TEXT NOT NULL,
  result     TEXT CHECK (result IN ('pass', 'fail')),
  note       TEXT,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_auditsteps_report ON audit_steps(report_id);
CREATE INDEX IF NOT EXISTS idx_reports_company  ON audit_reports(company_id);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON company_contacts(company_id);
CREATE INDEX IF NOT EXISTS idx_devices_company  ON devices(company_id);
CREATE INDEX IF NOT EXISTS idx_auditdev_report  ON audit_devices(report_id);
CREATE INDEX IF NOT EXISTS idx_auditdev_device  ON audit_devices(device_id);
CREATE INDEX IF NOT EXISTS idx_tests_auditdev   ON device_tests(audit_device_id);
CREATE INDEX IF NOT EXISTS idx_shots_test       ON screenshots(test_id);
