const express = require('express');
const db = require('../db');
const { requireLogin, wrap } = require('../middleware');
const {
  findReport,
  panelData,
  addActiveDevices,
  addProcedureSteps,
  syncAuditDevices,
  ensureAuditSteps,
} = require('../audit-data');
const { buildAuditPdf } = require('../pdf');

const router = express.Router();
router.use(requireLogin);

// All signed-in employees can view and work on every report.

function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const allCompanies = () => db.prepare('SELECT id, name FROM companies ORDER BY name COLLATE NOCASE').all();

function notFound(res) {
  return res.status(404).render('error', { title: 'Not found', message: 'Report not found.' });
}

function newAuditView(extra = {}) {
  const companies = allCompanies();
  return { title: 'New audit', companies, hasCompanies: companies.length > 0, audit_date: today(), ...extra };
}

router.get('/new', (req, res) => {
  // Coming from a company's page ("New audit") pre-fills that company.
  const preselect = Number(req.query.company);
  const company = Number.isInteger(preselect)
    ? db.prepare('SELECT name FROM companies WHERE id = ?').get(preselect)
    : null;
  res.render('reports/new', newAuditView({ company_name: company ? company.name : '' }));
});

router.post('/', (req, res) => {
  const typedName = String(req.body.company || '').trim();
  const auditDate = String(req.body.audit_date || '').trim();

  // The company is picked by typing its name (names are unique). company_id is also accepted.
  let company = null;
  if (typedName) {
    company = db.prepare('SELECT id, name FROM companies WHERE name = ? COLLATE NOCASE').get(typedName);
  } else if (Number.isInteger(Number(req.body.company_id)) && Number(req.body.company_id) > 0) {
    company = db.prepare('SELECT id, name FROM companies WHERE id = ?').get(Number(req.body.company_id));
  }

  let error = null;
  if (!company) {
    error = typedName
      ? `No company called "${typedName}". Pick one from the list, or add it first.`
      : 'Please choose a company.';
  } else if (!validDate(auditDate)) {
    error = 'Please enter a valid audit date.';
  }

  if (error) {
    return res.status(400).render(
      'reports/new',
      newAuditView({ company_name: typedName, audit_date: auditDate || today(), error })
    );
  }

  // A new audit covers the company's active devices and gets a copy of the standard procedure.
  const id = db.transaction(() => {
    const reportId = Number(
      db
        .prepare('INSERT INTO audit_reports (company_id, created_by, audit_date) VALUES (?, ?, ?)')
        .run(company.id, req.user.id, auditDate).lastInsertRowid
    );
    addActiveDevices(reportId, company.id);
    addProcedureSteps(reportId);
    return reportId;
  })();

  req.flash('success', 'Draft audit created.');
  res.redirect(`/reports/${id}`);
});

// PDF of the audit: opens in the browser by default, ?download=1 saves it as a file.
router.get(
  '/:id/pdf',
  wrap(async (req, res) => {
    const report = findReport(Number(req.params.id));
    if (!report) return notFound(res);
    syncAuditDevices(report);
    ensureAuditSteps(report);

    const { buffer, filename } = await buildAuditPdf(report);
    const ascii = filename.replace(/[^\x20-\x7E]/g, '_');
    const disposition = req.query.download ? 'attachment' : 'inline';
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Length': String(buffer.length),
      'Content-Disposition': `${disposition}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Cache-Control': 'private, no-store',
    });
    res.send(buffer);
  })
);

// Set the audit's result: Pass or Failed, or reopen it (in progress). Editing is never locked.
const STATUS_MESSAGE = {
  pass: 'Audit marked as Pass.',
  fail: 'Audit marked as Failed.',
  in_progress: 'Audit reopened (in progress).',
};
router.post('/:id/status', (req, res) => {
  const report = findReport(Number(req.params.id));
  if (!report) return notFound(res);

  const next = req.body.status;
  if (!Object.hasOwn(STATUS_MESSAGE, next)) {
    req.flash('error', 'Unknown status.');
    return res.redirect(`/reports/${report.id}`);
  }
  db.prepare("UPDATE audit_reports SET status = ?, updated_at = datetime('now') WHERE id = ?").run(next, report.id);
  req.flash('success', STATUS_MESSAGE[next]);
  res.redirect(`/reports/${report.id}`);
});

// "Additional comments" printed at the end of the report.
const MAX_COMMENTS = 5000;
router.post('/:id/comments', (req, res) => {
  const report = findReport(Number(req.params.id));
  if (!report) return notFound(res);

  const comments = String(req.body.comments || '').replace(/\r\n?/g, '\n').trim();
  if (comments.length > MAX_COMMENTS) {
    req.flash('error', `Comments must be ${MAX_COMMENTS} characters or fewer (yours is ${comments.length}).`);
    return res.redirect(`/reports/${report.id}#comments`);
  }
  db.prepare("UPDATE audit_reports SET comments = ?, updated_at = datetime('now') WHERE id = ?").run(comments || null, report.id);
  req.flash('success', 'Comments saved.');
  res.redirect(`/reports/${report.id}#comments`);
});

router.get('/:id', (req, res) => {
  const report = findReport(Number(req.params.id));
  if (!report) return notFound(res);

  // An in-progress audit follows the company's device list; once marked Pass/Failed it stays as it was.
  syncAuditDevices(report);
  ensureAuditSteps(report);

  res.render('reports/show', { title: `Audit: ${report.company}`, ...panelData(report) });
});

module.exports = router;
