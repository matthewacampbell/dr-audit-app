const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAdmin } = require('../middleware');
const { validateUsername, validatePassword, validatePersonName } = require('../validate');
const { displayName } = require('../users');

const router = express.Router();
router.use(requireAdmin);

const isUniqueError = (err) => String(err.code).startsWith('SQLITE_CONSTRAINT');

// Sign a user out everywhere (used after a password reset or when an account is disabled).
// `exceptSid` keeps one session alive, e.g. the admin's own when they reset their own password.
function endSessions(userId, exceptSid) {
  try {
    if (exceptSid) {
      db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ? AND sid <> ?").run(userId, exceptSid);
    } else {
      db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(userId);
    }
  } catch (err) {
    console.error('Could not end sessions for user', userId, err.message);
  }
}

function listUsers(currentUserId) {
  return db
    .prepare('SELECT id, username, first_name, last_name, role, active, created_at FROM users')
    .all()
    .map((u) => ({
      ...u,
      fullName: `${u.first_name || ''} ${u.last_name || ''}`.trim(),
      isActive: !!u.active,
      isSelf: u.id === currentUserId,
    }))
    .sort((a, b) => (a.fullName || a.username).localeCompare(b.fullName || b.username, undefined, { sensitivity: 'base' }));
}

function usersView(req, extra = {}) {
  const users = listUsers(req.user.id);
  return { title: 'Users', users, missingNames: users.filter((u) => !u.fullName).length, ...extra };
}

function findUser(req, res) {
  const id = Number(req.params.id);
  const user = Number.isInteger(id)
    ? db.prepare('SELECT id, username, first_name, last_name, role, active, created_at FROM users WHERE id = ?').get(id)
    : null;
  if (!user) {
    res.status(404).render('error', { title: 'Not found', message: 'User not found.' });
    return null;
  }
  return user;
}

function editView(req, user, extra = {}) {
  return {
    title: `Edit ${displayName(user)}`,
    target: {
      ...user,
      displayName: displayName(user),
      isSelf: user.id === req.user.id,
      isAdminRole: user.role === 'admin',
      isEmployeeRole: user.role !== 'admin',
    },
    ...extra,
  };
}

router.get('/users', (req, res) => {
  res.render('admin/users', usersView(req));
});

router.post('/users', (req, res) => {
  const names = validatePersonName(req.body);
  const { username, error: nameError } = validateUsername(req.body.username);
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'employee';

  // On a mistake, show the form again with what was typed (but never the password).
  const fail = (message) =>
    res.status(400).render(
      'admin/users',
      usersView(req, { error: message, form: { first_name: names.first_name, last_name: names.last_name, username, isAdmin: role === 'admin' } })
    );

  const error = names.error || nameError || validatePassword(password);
  if (error) return fail(error);

  try {
    db.prepare('INSERT INTO users (username, first_name, last_name, password_hash, role) VALUES (?, ?, ?, ?, ?)').run(
      username,
      names.first_name,
      names.last_name,
      bcrypt.hashSync(password, 12),
      role
    );
  } catch (err) {
    if (isUniqueError(err)) return fail('That username already exists.');
    throw err;
  }
  req.flash('success', `${names.first_name} ${names.last_name} added as "${username}".`);
  res.redirect('/admin/users');
});

router.post('/users/:id/toggle', (req, res) => {
  const user = findUser(req, res);
  if (!user) return;
  if (user.id === req.user.id) {
    req.flash('error', "You can't disable your own account.");
    return res.redirect('/admin/users');
  }
  const nowActive = user.active ? 0 : 1;
  db.prepare('UPDATE users SET active = ? WHERE id = ?').run(nowActive, user.id);
  if (!nowActive) endSessions(user.id);
  req.flash('success', nowActive ? `${displayName(user)} enabled.` : `${displayName(user)} disabled and signed out.`);
  res.redirect('/admin/users');
});

// ---- Edit a user (username, role) ----

router.get('/users/:id/edit', (req, res) => {
  const user = findUser(req, res);
  if (!user) return;
  res.render('admin/user-edit', editView(req, user));
});

router.post('/users/:id', (req, res) => {
  const user = findUser(req, res);
  if (!user) return;

  const names = validatePersonName(req.body);
  const { username, error: nameError } = validateUsername(req.body.username);
  // You can't change your own role, so an admin can never remove their own admin access by accident.
  const role = user.id === req.user.id ? user.role : req.body.role === 'admin' ? 'admin' : 'employee';

  const fail = (message) =>
    res.status(400).render(
      'admin/user-edit',
      editView(req, { ...user, first_name: names.first_name, last_name: names.last_name, username, role }, { error: message })
    );
  const error = names.error || nameError;
  if (error) return fail(error);

  try {
    db.prepare('UPDATE users SET first_name = ?, last_name = ?, username = ?, role = ? WHERE id = ?').run(
      names.first_name,
      names.last_name,
      username,
      role,
      user.id
    );
  } catch (err) {
    if (isUniqueError(err)) return fail('That username already exists.');
    throw err;
  }
  req.flash('success', `${names.first_name} ${names.last_name} updated.`);
  res.redirect('/admin/users');
});

// ---- Reset a user's password ----

router.post('/users/:id/password', (req, res) => {
  const user = findUser(req, res);
  if (!user) return;

  const password = String(req.body.new_password || '');
  const confirm = String(req.body.confirm_password || '');
  const error = password !== confirm ? "The two passwords don't match." : validatePassword(password);
  if (error) {
    return res.status(400).render('admin/user-edit', editView(req, user, { passwordError: error }));
  }

  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 12), user.id);
  // Anyone signed in as this user is signed out (except the admin's own current session).
  endSessions(user.id, user.id === req.user.id ? req.sessionID : null);
  req.flash('success', `Password reset for ${displayName(user)}. They have been signed out everywhere.`);
  res.redirect('/admin/users');
});

module.exports = router;
