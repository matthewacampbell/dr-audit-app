const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../db');

const router = express.Router();

// Used so a login for an unknown user takes about as long as a real one.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) =>
    res.status(429).render('login', {
      title: 'Sign in',
      error: 'Too many attempts. Please wait 15 minutes and try again.',
    }),
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'Sign in' });
});

router.post('/login', loginLimiter, (req, res, next) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');

  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  const ok = bcrypt.compareSync(password, row ? row.password_hash : DUMMY_HASH);

  if (!row || !row.active || !ok) {
    return res.status(401).render('login', {
      title: 'Sign in',
      error: 'Invalid username or password.',
      username,
    });
  }

  // New session ID on login prevents session fixation.
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.userId = row.id;
    req.session.save((err2) => {
      if (err2) return next(err2);
      res.redirect('/');
    });
  });
});

router.post('/logout', (req, res, next) => {
  req.session.destroy((err) => {
    if (err) return next(err);
    res.clearCookie('audit.sid');
    res.redirect('/login');
  });
});

module.exports = router;
