// Loads an audit and builds the view data for its "devices" panel and device cards.
const db = require('./db');
const { displayNameSql } = require('./users');
const { duration, display } = require('./format');

const KINDS = [
  { kind: 'backup', label: 'Backup' },
  { kind: 'failover', label: 'Failover' },
];

function findReport(id) {
  if (!Number.isInteger(id)) return null;
  return db
    .prepare(
      `SELECT r.id, r.company_id, r.created_by, r.audit_date, r.status, r.comments,
              r.created_at, c.name AS company, ${displayNameSql('u')} AS author
       FROM audit_reports r
       JOIN companies c ON c.id = r.company_id
       JOIN users u ON u.id = r.created_by
       WHERE r.id = ?`
    )
    .get(id);
}

function findAuditDevice(reportId, adId) {
  if (!Number.isInteger(adId)) return null;
  return db
    .prepare('SELECT id, report_id FROM audit_devices WHERE id = ? AND report_id = ?')
    .get(adId, reportId);
}

// One device card: the device plus its backup and failover sections.
// `override` lets a route re-show what the user typed along with an error message.
function buildCard(report, ad, override = {}) {
  const tests = db.prepare('SELECT * FROM device_tests WHERE audit_device_id = ?').all(ad.id);
  const shots = db
    .prepare(
      `SELECT s.id, s.test_id, s.original_name
       FROM screenshots s JOIN device_tests t ON t.id = s.test_id
       WHERE t.audit_device_id = ? ORDER BY s.id`
    )
    .all(ad.id);

  const sections = KINDS.map(({ kind, label }) => {
    const t = tests.find((x) => x.kind === kind) || {};
    const typed = override.kind === kind ? override : null;
    const started = typed ? typed.started : t.started_at || '';
    const finished = typed ? typed.finished : t.finished_at || '';
    const dur = typed && typed.message ? null : duration(started, finished);
    return {
      reportId: report.id,
      adId: ad.id,
      kind,
      label,
      started: started || '',
      finished: finished || '',
      duration: dur,
      hasDuration: !!dur,
      message: typed ? typed.message : null,
      messageType: typed ? typed.messageType || 'error' : null,
      screenshots: shots
        .filter((s) => s.test_id === t.id)
        .map((s) => ({ ...s, reportId: report.id, adId: ad.id })),
      startedDisplay: display(started),
      finishedDisplay: display(finished),
    };
  });

  return {
    reportId: report.id,
    id: ad.id,
    name: ad.name,
    device_type: ad.device_type,
    identifier: ad.identifier,
    retired: !ad.active,
    sections,
  };
}

const deviceRow = (reportId, adId) =>
  db
    .prepare(
      `SELECT ad.id, ad.report_id, d.name, d.device_type, d.identifier, d.active
       FROM audit_devices ad JOIN devices d ON d.id = ad.device_id
       WHERE ad.id = ? AND ad.report_id = ?`
    )
    .get(adId, reportId);

function cardData(report, adId, override) {
  const ad = deviceRow(report.id, adId);
  return ad ? buildCard(report, ad, override) : null;
}

function panelData(report) {
  const rows = db
    .prepare(
      `SELECT ad.id, ad.report_id, d.name, d.device_type, d.identifier, d.active
       FROM audit_devices ad JOIN devices d ON d.id = ad.device_id
       WHERE ad.report_id = ?
       ORDER BY d.name COLLATE NOCASE`
    )
    .all(report.id);
  const cards = rows.map((ad) => buildCard(report, ad));
  return { report, cards, hasDevices: cards.length > 0, ...stepsData(report.id) };
}

// ---- Devices: an audit covers the company's ACTIVE devices ----

// Called when an audit is created.
function addActiveDevices(reportId, companyId) {
  db.prepare(
    `INSERT OR IGNORE INTO audit_devices (report_id, device_id)
     SELECT ?, id FROM devices WHERE company_id = ? AND active = 1`
  ).run(reportId, companyId);
}

// Keeps an IN-PROGRESS audit in step with the company page: newly added devices appear, and
// retired devices are dropped unless something was already recorded for them. Once a result
// (Pass / Failed) is marked, the audit is left exactly as it was.
function syncAuditDevices(report) {
  if (report.status !== 'in_progress') return;
  db.transaction(() => {
    addActiveDevices(report.id, report.company_id);
    db.prepare(
      `DELETE FROM audit_devices
       WHERE report_id = ?
         AND device_id IN (SELECT id FROM devices WHERE active = 0)
         AND NOT EXISTS (
           SELECT 1 FROM device_tests t
           WHERE t.audit_device_id = audit_devices.id
             AND (t.started_at IS NOT NULL OR t.finished_at IS NOT NULL
                  OR EXISTS (SELECT 1 FROM screenshots s WHERE s.test_id = t.id)))`
    ).run(report.id);
  })();
}

// ---- Procedure: pass/fail steps copied from the standard procedure ----

function addProcedureSteps(reportId) {
  db.prepare(
    `INSERT INTO audit_steps (report_id, position, text)
     SELECT ?, position, text FROM procedure_steps ORDER BY position`
  ).run(reportId);
}

// Audits created before the procedure existed (or while it was empty) get the steps once.
function ensureAuditSteps(report) {
  if (report.status !== 'in_progress') return;
  const n = db.prepare('SELECT COUNT(*) AS n FROM audit_steps WHERE report_id = ?').get(report.id).n;
  if (n === 0) addProcedureSteps(report.id);
}

function stepsData(reportId) {
  const rows = db
    .prepare('SELECT id, position, text, result, note FROM audit_steps WHERE report_id = ? ORDER BY position, id')
    .all(reportId);
  const steps = rows.map((r, i) => ({ ...r, number: i + 1, isPass: r.result === 'pass', isFail: r.result === 'fail' }));
  return { steps, hasSteps: steps.length > 0, stepSummary: summarizeSteps(steps) };
}

function summarizeSteps(steps) {
  const pass = steps.filter((s) => s.isPass).length;
  const fail = steps.filter((s) => s.isFail).length;
  return { total: steps.length, pass, fail, unmarked: steps.length - pass - fail, allDone: steps.length > 0 && pass + fail === steps.length };
}

module.exports = {
  KINDS,
  findReport,
  findAuditDevice,
  cardData,
  panelData,
  addActiveDevices,
  syncAuditDevices,
  addProcedureSteps,
  ensureAuditSteps,
  stepsData,
};
