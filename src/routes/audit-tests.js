const crypto = require('crypto');
const path = require('path');
const express = require('express');
const multer = require('multer');
const sharp = require('sharp');

const db = require('../db');
const storage = require('../storage');
const { requireLogin, wrap } = require('../middleware');
const { validateTimes } = require('../validate');
const { findReport, findAuditDevice, cardData, stepsData } = require('../audit-data');

// Mounted at /reports/:reportId. Every route returns the refreshed device card for HTMX.
const router = express.Router({ mergeParams: true });
router.use(requireLogin);

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per upload
const MAX_SHOTS_PER_TEST = 10;
const FORMATS = { jpeg: ['image/jpeg', 'jpg'], png: ['image/png', 'png'], webp: ['image/webp', 'webp'] };

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });

// Parse the upload, but turn upload errors into a message instead of an error page.
function uploadOne(req, res, next) {
  upload.single('screenshot')(req, res, (err) => {
    if (err) {
      req.uploadError =
        err.code === 'LIMIT_FILE_SIZE'
          ? 'That file is larger than 10 MB.'
          : 'The upload failed. Please try again.';
    }
    next();
  });
}

// Resolve /reports/:reportId/devices/:adId/... and the optional :kind.
function load(req, res) {
  const report = findReport(Number(req.params.reportId));
  const ad = report && findAuditDevice(report.id, Number(req.params.adId));
  const kind = req.params.kind;
  const kindOk = kind === undefined || kind === 'backup' || kind === 'failover';
  if (!report || !ad || !kindOk) {
    res.status(404).render('error', { title: 'Not found', message: 'Not found.' });
    return null;
  }
  return { report, ad, kind };
}

function sendCard(res, report, adId, override) {
  res.render('partials/device-card', { layout: false, ...cardData(report, adId, override) });
}

const ensureTest = (adId, kind) => {
  db.prepare('INSERT OR IGNORE INTO device_tests (audit_device_id, kind) VALUES (?, ?)').run(adId, kind);
  return db.prepare('SELECT id FROM device_tests WHERE audit_device_id = ? AND kind = ?').get(adId, kind);
};

// Save start/finish times for a backup or failover test.
router.post('/devices/:adId/tests/:kind', (req, res) => {
  const ctx = load(req, res);
  if (!ctx) return;
  const { report, ad, kind } = ctx;

  const t = validateTimes(req.body);
  if (t.error) {
    // Send back what was typed, plus the error, so nothing is lost.
    return sendCard(res, report, ad.id, {
      kind,
      started: String(req.body.started_at || ''),
      finished: String(req.body.finished_at || ''),
      message: t.error,
    });
  }

  db.prepare(
    `INSERT INTO device_tests (audit_device_id, kind, started_at, finished_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (audit_device_id, kind)
     DO UPDATE SET started_at = excluded.started_at, finished_at = excluded.finished_at`
  ).run(ad.id, kind, t.started, t.finished);

  sendCard(res, report, ad.id);
});

// Upload a screenshot for a test.
router.post(
  '/devices/:adId/tests/:kind/screenshots',
  uploadOne,
  wrap(async (req, res) => {
    const ctx = load(req, res);
    if (!ctx) return;
    const { report, ad, kind } = ctx;
    const fail = (message) => sendCard(res, report, ad.id, { kind, ...currentValues(ad.id, kind), message });

    if (req.uploadError) return fail(req.uploadError);
    if (!req.file) return fail('Please choose an image to upload.');

    const test = ensureTest(ad.id, kind);
    const count = db.prepare('SELECT COUNT(*) AS n FROM screenshots WHERE test_id = ?').get(test.id).n;
    if (count >= MAX_SHOTS_PER_TEST) return fail(`You can attach up to ${MAX_SHOTS_PER_TEST} screenshots per test.`);

    // Check it really is an image, fix its rotation, drop metadata, and cap its width.
    let processed;
    try {
      const img = sharp(req.file.buffer, { failOn: 'error', limitInputPixels: 50_000_000 });
      const meta = await img.metadata();
      if (!FORMATS[meta.format]) throw new Error('unsupported format');
      const out = await img.rotate().resize({ width: 1920, withoutEnlargement: true }).toBuffer();
      processed = { buffer: out, format: meta.format };
    } catch {
      return fail('That file isn\'t a valid PNG, JPEG, or WebP image.');
    }

    const [contentType, ext] = FORMATS[processed.format];
    const key = `screenshots/${report.id}/${crypto.randomUUID()}.${ext}`;

    try {
      await storage.put(key, processed.buffer, contentType);
    } catch (err) {
      console.error('Storage put failed:', err);
      return fail('Could not save the screenshot to storage. Try again, or ask an admin to check the storage settings.');
    }

    try {
      db.prepare(
        `INSERT INTO screenshots (test_id, storage_key, original_name, content_type, size_bytes, uploaded_by)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(test.id, key, path.basename(req.file.originalname || '').slice(0, 200), contentType, processed.buffer.length, req.user.id);
    } catch (err) {
      await storage.remove(key).catch(() => {});
      throw err;
    }

    sendCard(res, report, ad.id);
  })
);

// Delete a screenshot (database row first, then the stored file).
router.post(
  '/devices/:adId/screenshots/:sid/delete',
  wrap(async (req, res) => {
    const ctx = load(req, res);
    if (!ctx) return;
    const { report, ad } = ctx;

    const shot = db
      .prepare(
        `SELECT s.id, s.storage_key FROM screenshots s
         JOIN device_tests t ON t.id = s.test_id
         WHERE s.id = ? AND t.audit_device_id = ?`
      )
      .get(Number(req.params.sid), ad.id);

    if (shot) {
      db.prepare('DELETE FROM screenshots WHERE id = ?').run(shot.id);
      await storage.remove(shot.storage_key).catch((err) => console.error(`Could not delete stored file ${shot.storage_key}:`, err));
    }
    sendCard(res, report, ad.id);
  })
);

// ---- Procedure steps (pass / fail + optional note) ----

function findStep(reportId, stepId) {
  if (!Number.isInteger(stepId)) return null;
  return db
    .prepare('SELECT id, position, text, result, note FROM audit_steps WHERE id = ? AND report_id = ?')
    .get(stepId, reportId);
}

// The "5 passed, 1 failed ..." line is refreshed out-of-band whenever a step changes.
const sendSummary = (res, reportId) =>
  res.render('partials/proc-summary', { layout: false, oob: true, stepSummary: stepsData(reportId).stepSummary });

// Mark a step pass/fail and/or change its note. The row already shows what was typed or
// clicked, so only the summary is sent back.
router.post('/steps/:stepId', (req, res) => {
  const report = findReport(Number(req.params.reportId));
  const step = report && findStep(report.id, Number(req.params.stepId));
  if (!step) return res.status(404).type('text').send('Not found');

  const result = ['pass', 'fail'].includes(req.body.result) ? req.body.result : null;
  const note = String(req.body.note || '').trim().slice(0, 300);
  db.prepare("UPDATE audit_steps SET result = ?, note = ?, updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(
    result,
    note || null,
    req.user.id,
    step.id
  );
  sendSummary(res, report.id);
});

// Un-mark a step. Returns the refreshed row (so the buttons un-highlight) plus the summary.
router.post('/steps/:stepId/clear', (req, res) => {
  const report = findReport(Number(req.params.reportId));
  const step = report && findStep(report.id, Number(req.params.stepId));
  if (!step) return res.status(404).type('text').send('Not found');

  db.prepare("UPDATE audit_steps SET result = NULL, updated_by = ?, updated_at = datetime('now') WHERE id = ?").run(
    req.user.id,
    step.id
  );
  const data = stepsData(report.id);
  const row = data.steps.find((x) => x.id === step.id);
  res.render('partials/proc-clear', { layout: false, report, ...row, stepSummary: data.stepSummary });
});

function currentValues(adId, kind) {
  const t = db.prepare('SELECT started_at, finished_at FROM device_tests WHERE audit_device_id = ? AND kind = ?').get(adId, kind);
  return { started: (t && t.started_at) || '', finished: (t && t.finished_at) || '' };
}

module.exports = router;
