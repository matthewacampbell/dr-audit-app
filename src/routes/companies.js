const express = require('express');
const db = require('../db');
const { displayNameSql } = require('../users');
const { requireLogin } = require('../middleware');
const { validateCompany } = require('../validate');

const router = express.Router();
router.use(requireLogin); // any signed-in employee can add and edit companies

const isUniqueError = (err) => String(err.code).startsWith('SQLITE_CONSTRAINT');

// The form always shows at least one (blank) contact row.
const rowsFor = (contacts) => (contacts.length ? contacts : [{}]);

function formView(extra) {
  return { company: {}, contacts: [{}], ...extra };
}

router.get('/', (req, res) => {
  const q = String(req.query.q || '').trim().slice(0, 100);
  // Escape LIKE wildcards so searching for "50%" or "a_b" works literally.
  const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;

  const companies = db
    .prepare(
      `SELECT c.id, c.name, c.notes,
              (SELECT COUNT(*) FROM company_contacts k WHERE k.company_id = c.id) AS contact_count,
              (SELECT COUNT(*) FROM devices d WHERE d.company_id = c.id AND d.active = 1) AS device_count,
              (SELECT COUNT(*) FROM audit_reports r WHERE r.company_id = c.id) AS report_count
       FROM companies c
       WHERE @q = ''
          OR c.name LIKE @like ESCAPE '\\'
          OR c.id IN (SELECT company_id FROM company_contacts
                      WHERE name LIKE @like ESCAPE '\\' OR email LIKE @like ESCAPE '\\')
       ORDER BY c.name COLLATE NOCASE`
    )
    .all({ q, like });
  res.render('companies/index', { title: 'Companies', companies, q, searched: q !== '' });
});

router.get('/new', (req, res) => {
  res.render(
    'companies/form',
    formView({ title: 'Add company', heading: 'Add company', action: '/companies', isNew: true })
  );
});

router.post('/', (req, res) => {
  const { values, contacts, error } = validateCompany(req.body);
  const renderForm = (msg) =>
    res.status(400).render(
      'companies/form',
      formView({
        title: 'Add company',
        heading: 'Add company',
        action: '/companies',
        isNew: true,
        company: values,
        contacts: rowsFor(contacts),
        error: msg,
      })
    );
  if (error) return renderForm(error);

  let id;
  try {
    db.transaction(() => {
      id = Number(
        db
          .prepare('INSERT INTO companies (name, notes, account_login, storage) VALUES (?, ?, ?, ?)')
          .run(values.name, values.notes || null, values.account_login || null, values.storage || null)
          .lastInsertRowid
      );
      const insert = db.prepare('INSERT INTO company_contacts (company_id, name, phone, email) VALUES (?, ?, ?, ?)');
      for (const c of contacts) insert.run(id, c.name, c.phone || null, c.email || null);
    })();
  } catch (err) {
    if (isUniqueError(err)) return renderForm('A company with that name already exists.');
    throw err;
  }

  req.flash('success', `Company "${values.name}" added.`);
  if (req.body.next === 'audit') return res.redirect(`/reports/new?company=${id}`);
  res.redirect(`/companies/${id}`);
});

function findCompany(req, res) {
  const id = Number(req.params.id);
  const company = Number.isInteger(id)
    ? db.prepare('SELECT id, name, notes, account_login, storage, created_at FROM companies WHERE id = ?').get(id)
    : null;
  if (!company) {
    res.status(404).render('error', { title: 'Not found', message: 'Company not found.' });
  }
  return company;
}

// Company page: details, contacts, devices, and (last) every audit done for the company.
router.get('/:id', (req, res) => {
  const company = findCompany(req, res);
  if (!company) return;

  const contacts = db
    .prepare('SELECT id, name, phone, email FROM company_contacts WHERE company_id = ? ORDER BY id')
    .all(company.id);

  const devices = db
    .prepare(
      `SELECT d.id, d.name, d.device_type, d.identifier, d.notes, d.active,
              (SELECT COUNT(*) FROM audit_devices ad WHERE ad.device_id = d.id) AS audit_count
       FROM devices d
       WHERE d.company_id = ?
       ORDER BY d.active DESC, d.name COLLATE NOCASE`
    )
    .all(company.id)
    .map((d) => ({ ...d, isActive: !!d.active }));

  const audits = db
    .prepare(
      `SELECT r.id, r.audit_date, r.status, ${displayNameSql('u')} AS author,
              (SELECT COUNT(*) FROM audit_devices ad WHERE ad.report_id = r.id) AS device_count
       FROM audit_reports r
       JOIN users u ON u.id = r.created_by
       WHERE r.company_id = ?
       ORDER BY r.audit_date DESC, r.id DESC`
    )
    .all(company.id);

  res.render('companies/show', {
    title: company.name,
    company,
    contacts,
    devices,
    activeDeviceCount: devices.filter((d) => d.isActive).length,
    audits,
  });
});

router.get('/:id/edit', (req, res) => {
  const company = findCompany(req, res);
  if (!company) return;
  const contacts = db
    .prepare('SELECT id, name, phone, email FROM company_contacts WHERE company_id = ? ORDER BY id')
    .all(company.id);

  res.render(
    'companies/form',
    formView({
      title: 'Edit company',
      heading: 'Edit company',
      action: `/companies/${company.id}`,
      isNew: false,
      company,
      contacts: rowsFor(contacts),
    })
  );
});

router.post('/:id', (req, res) => {
  const company = findCompany(req, res);
  if (!company) return;

  const { values, contacts, error } = validateCompany(req.body);
  const renderForm = (msg) =>
    res.status(400).render(
      'companies/form',
      formView({
        title: 'Edit company',
        heading: 'Edit company',
        action: `/companies/${company.id}`,
        isNew: false,
        company: { id: company.id, ...values },
        contacts: rowsFor(contacts),
        error: msg,
      })
    );
  if (error) return renderForm(error);

  try {
    db.transaction(() => {
      db.prepare('UPDATE companies SET name = ?, notes = ?, account_login = ?, storage = ? WHERE id = ?').run(
        values.name,
        values.notes || null,
        values.account_login || null,
        values.storage || null,
        company.id
      );

      // Sync contacts: update the ones that still exist, add new rows, delete removed ones.
      const existing = new Set(
        db.prepare('SELECT id FROM company_contacts WHERE company_id = ?').all(company.id).map((r) => r.id)
      );
      const keep = new Set();
      const update = db.prepare('UPDATE company_contacts SET name = ?, phone = ?, email = ? WHERE id = ? AND company_id = ?');
      const insert = db.prepare('INSERT INTO company_contacts (company_id, name, phone, email) VALUES (?, ?, ?, ?)');
      for (const c of contacts) {
        if (c.id && existing.has(c.id)) {
          update.run(c.name, c.phone || null, c.email || null, c.id, company.id);
          keep.add(c.id);
        } else {
          insert.run(company.id, c.name, c.phone || null, c.email || null);
        }
      }
      const remove = db.prepare('DELETE FROM company_contacts WHERE id = ? AND company_id = ?');
      for (const id of existing) if (!keep.has(id)) remove.run(id, company.id);
    })();
  } catch (err) {
    if (isUniqueError(err)) return renderForm('A company with that name already exists.');
    throw err;
  }

  req.flash('success', `Company "${values.name}" updated.`);
  res.redirect(`/companies/${company.id}`);
});

module.exports = router;
