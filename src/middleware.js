const crypto = require('crypto');
const db = require('./db');
const { displayName, initials } = require('./users');

// Load the current user from the DB on every request, so deactivating
// an account (or changing its role) takes effect immediately.
function attachUser(req, res, next) {
  const id = req.session && req.session.userId;
  if (id) {
    const user = db
      .prepare('SELECT id, username, first_name, last_name, role, active FROM users WHERE id = ?')
      .get(id);
    if (user && user.active) {
      req.user = user;
      res.locals.user = {
        ...user,
        displayName: displayName(user),
        initials: initials(user),
        roleLabel: user.role === 'admin' ? 'Administrator' : 'Employee',
      };
    } else {
      delete req.session.userId;
    }
  }
  next();
}

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.role !== 'admin') {
    return res.status(403).render('error', { title: 'Forbidden', message: 'Admins only.' });
  }
  next();
}

// Simple session-bound CSRF token. Every POST form must include
// <input type="hidden" name="_csrf" value="{{csrfToken}}">
function csrf(req, res, next) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  res.locals.csrfToken = req.session.csrfToken;

  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const sent = String((req.body && req.body._csrf) || req.get('x-csrf-token') || '');
  const a = Buffer.from(sent);
  const b = Buffer.from(req.session.csrfToken);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).render('error', {
      title: 'Forbidden',
      message: 'Invalid or missing security token. Go back, refresh the page, and try again.',
    });
  }
  next();
}

// One-shot flash messages stored in the session.
function flash(req, res, next) {
  const f = req.session.flash;
  res.locals.flash = f ? { ...f, cls: f.type === 'error' ? 'danger' : 'success' } : null;
  delete req.session.flash;
  req.flash = (type, message) => {
    req.session.flash = { type, message };
  };
  next();
}

module.exports = { attachUser, requireLogin, requireAdmin, csrf, flash };

// Express 4 doesn't catch errors from async handlers; this passes them to the error handler.
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
module.exports.wrap = wrap;
