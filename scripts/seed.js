require('dotenv').config();
const bcrypt = require('bcryptjs');
const db = require('../src/db');

const username = process.env.ADMIN_USERNAME || 'admin';
const password = process.env.ADMIN_PASSWORD;
const firstName = (process.env.ADMIN_FIRST_NAME || '').trim() || null;
const lastName = (process.env.ADMIN_LAST_NAME || '').trim() || null;

if (!password || password.length < 10) {
  console.error('Set ADMIN_PASSWORD (min 10 characters) in .env before seeding.');
  process.exit(1);
}

const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
if (existing) {
  console.log(`Admin "${username}" already exists, skipping.`);
} else {
  db.prepare("INSERT INTO users (username, first_name, last_name, password_hash, role) VALUES (?, ?, ?, ?, 'admin')").run(
    username,
    firstName,
    lastName,
    bcrypt.hashSync(password, 12)
  );
  console.log(`Created admin user "${username}".`);
  if (!firstName || !lastName) console.log('Tip: add your name and surname under Users -> Edit, so reports show who completed them.');
}

if (process.argv.includes('--sample')) {
  const insert = db.prepare('INSERT OR IGNORE INTO companies (name) VALUES (?)');
  ['Acme Corp', 'Globex Ltd', 'Initech'].forEach((n) => insert.run(n));
  console.log('Added sample companies.');
}
