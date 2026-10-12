const express = require('express');
const db = require('../db');
const { requireLogin } = require('../middleware');

// The standard audit procedure. Every new audit gets a copy of these steps, so editing them
// here never changes audits that were already done. Any signed-in employee can edit it.
const router = express.Router();
router.use(requireLogin);

const MAX_LEN = 300;

function listSteps() {
  const rows = db.prepare('SELECT id, position, text FROM procedure_steps ORDER BY position, id').all();
  return rows.map((r, i) => ({ ...r, number: i + 1, isFirst: i === 0, isLast: i === rows.length - 1 }));
}

// Keep positions as 1, 2, 3 ... with no gaps.
function renumber() {
  const update = db.prepare('UPDATE procedure_steps SET position = ? WHERE id = ?');
  db.prepare('SELECT id FROM procedure_steps ORDER BY position, id')
    .all()
    .forEach((r, i) => update.run(i + 1, r.id));
}

const cleanText = (v) => String(v || '').trim().replace(/\s+/g, ' ');

router.get('/', (req, res) => {
  const steps = listSteps();
  res.render('procedure/index', { title: 'Procedure', steps, hasSteps: steps.length > 0 });
});

router.post('/', (req, res) => {
  const text = cleanText(req.body.text);
  if (!text) {
    req.flash('error', 'Please type the step first.');
  } else if (text.length > MAX_LEN) {
    req.flash('error', `A step must be ${MAX_LEN} characters or fewer.`);
  } else {
    const next = (db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM procedure_steps').get().n);
    db.prepare('INSERT INTO procedure_steps (position, text) VALUES (?, ?)').run(next, text);
    req.flash('success', 'Step added. New audits will include it.');
  }
  res.redirect('/procedure');
});

router.post('/:id', (req, res) => {
  const id = Number(req.params.id);
  const text = cleanText(req.body.text);
  if (!text || text.length > MAX_LEN) {
    req.flash('error', `A step needs text, up to ${MAX_LEN} characters.`);
  } else {
    db.prepare('UPDATE procedure_steps SET text = ? WHERE id = ?').run(text, id);
    req.flash('success', 'Step updated.');
  }
  res.redirect('/procedure');
});

router.post('/:id/move', (req, res) => {
  const id = Number(req.params.id);
  const steps = db.prepare('SELECT id, position FROM procedure_steps ORDER BY position, id').all();
  const i = steps.findIndex((s) => s.id === id);
  const j = req.body.direction === 'up' ? i - 1 : req.body.direction === 'down' ? i + 1 : -1;
  if (i >= 0 && j >= 0 && j < steps.length) {
    db.transaction(() => {
      const update = db.prepare('UPDATE procedure_steps SET position = ? WHERE id = ?');
      update.run(steps[j].position, steps[i].id);
      update.run(steps[i].position, steps[j].id);
      renumber();
    })();
  }
  res.redirect('/procedure');
});

// Called by HTMX after a confirmation; HX-Refresh reloads the page so numbering updates.
router.post('/:id/delete', (req, res) => {
  db.transaction(() => {
    db.prepare('DELETE FROM procedure_steps WHERE id = ?').run(Number(req.params.id));
    renumber();
  })();
  if (req.get('HX-Request')) {
    req.flash('success', 'Step removed. Audits already started keep their copy.');
    res.set('HX-Refresh', 'true');
    return res.send('');
  }
  req.flash('success', 'Step removed.');
  res.redirect('/procedure');
});

module.exports = router;
