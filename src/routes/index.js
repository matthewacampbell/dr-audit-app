const express = require('express');
const db = require('../db');
const { displayNameSql } = require('../users');
const { requireLogin } = require('../middleware');

const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const reports = db
    .prepare(
      `SELECT r.id, r.audit_date, r.status, r.company_id, c.name AS company, ${displayNameSql('u')} AS author
       FROM audit_reports r
       JOIN companies c ON c.id = r.company_id
       JOIN users u ON u.id = r.created_by
       ORDER BY r.audit_date DESC, r.id DESC
       LIMIT 100`
    )
    .all();

  res.render('dashboard', { title: 'Audit reports', reports });
});

module.exports = router;
