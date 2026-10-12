const express = require('express');
const db = require('../db');
const { requireLogin } = require('../middleware');
const { validateDevice } = require('../validate');

// Mounted at /companies/:companyId
const router = express.Router({ mergeParams: true });
router.use(requireLogin);

router.use((req, res, next) => {
  const id = Number(req.params.companyId);
  const company = Number.isInteger(id)
    ? db.prepare('SELECT id, name FROM companies WHERE id = ?').get(id)
    : null;
  if (!company) {
    return res.status(404).render('error', { title: 'Not found', message: 'Company not found.' });
  }
  req.company = company;
  next();
});

const back = (req, anchor) => `/companies/${req.company.id}#${anchor}`;
const notFound = (res, what) =>
  res.status(404).render('error', { title: 'Not found', message: `${what} not found.` });

// ---------------- Devices ----------------

function deviceForm(req, extra) {
  return {
    company: req.company,
    action: `/companies/${req.company.id}/devices`,
    title: 'Add device',
    heading: 'Add device',
    device: {},
    ...extra,
  };
}

function findDevice(req) {
  const did = Number(req.params.did);
  if (!Number.isInteger(did)) return null;
  return db
    .prepare('SELECT * FROM devices WHERE id = ? AND company_id = ?')
    .get(did, req.company.id);
}

router.get('/devices/new', (req, res) => {
  res.render('companies/device-form', deviceForm(req));
});

router.post('/devices', (req, res) => {
  const { values, error } = validateDevice(req.body);
  if (error) {
    return res.status(400).render('companies/device-form', deviceForm(req, { device: values, error }));
  }
  db.prepare(
    'INSERT INTO devices (company_id, name, device_type, identifier, notes) VALUES (?, ?, ?, ?, ?)'
  ).run(req.company.id, values.name, values.device_type || null, values.identifier || null, values.notes || null);
  req.flash('success', `Device "${values.name}" added.`);
  res.redirect(back(req, 'devices'));
});

router.get('/devices/:did/edit', (req, res) => {
  const device = findDevice(req);
  if (!device) return notFound(res, 'Device');
  res.render(
    'companies/device-form',
    deviceForm(req, {
      title: 'Edit device',
      heading: 'Edit device',
      action: `/companies/${req.company.id}/devices/${device.id}`,
      device,
    })
  );
});

router.post('/devices/:did', (req, res) => {
  const device = findDevice(req);
  if (!device) return notFound(res, 'Device');

  const { values, error } = validateDevice(req.body);
  if (error) {
    return res.status(400).render(
      'companies/device-form',
      deviceForm(req, {
        title: 'Edit device',
        heading: 'Edit device',
        action: `/companies/${req.company.id}/devices/${device.id}`,
        device: values,
        error,
      })
    );
  }
  db.prepare(
    'UPDATE devices SET name = ?, device_type = ?, identifier = ?, notes = ? WHERE id = ?'
  ).run(values.name, values.device_type || null, values.identifier || null, values.notes || null, device.id);
  req.flash('success', 'Device updated.');
  res.redirect(back(req, 'devices'));
});

// Retire or restore. Retired devices keep their audit history but can't be added to new audits.
router.post('/devices/:did/toggle', (req, res) => {
  const device = findDevice(req);
  if (!device) return notFound(res, 'Device');
  db.prepare('UPDATE devices SET active = 1 - active WHERE id = ?').run(device.id);
  req.flash('success', device.active ? `"${device.name}" retired.` : `"${device.name}" restored.`);
  res.redirect(back(req, 'devices'));
});

module.exports = router;
