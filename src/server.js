require('dotenv').config();

const path = require('path');
const express = require('express');
const { engine } = require('express-handlebars');
const session = require('express-session');
const SqliteStore = require('better-sqlite3-session-store')(session);
const helmet = require('helmet');

const db = require('./db');
const storage = require('./storage');
const { attachUser, csrf, flash } = require('./middleware');

const isProd = process.env.NODE_ENV === 'production';
const sessionSecret = process.env.SESSION_SECRET;

if (!sessionSecret || sessionSecret.length < 32) {
  if (isProd) {
    console.error('SESSION_SECRET must be set to a random string of at least 32 characters.');
    process.exit(1);
  }
  console.warn('WARNING: using an insecure dev session secret. Set SESSION_SECRET in .env.');
}

const app = express();

if (process.env.TRUST_PROXY === 'true') app.set('trust proxy', 1);

// Handlebars
app.engine(
  'handlebars',
  engine({
    defaultLayout: 'main',
    layoutsDir: path.join(__dirname, '..', 'views', 'layouts'),
    partialsDir: path.join(__dirname, '..', 'views', 'partials'),
    helpers: {
      eq: (a, b) => a === b,
    },
  })
);
app.set('view engine', 'handlebars');
app.set('views', path.join(__dirname, '..', 'views'));

// Security headers. Bootstrap and Bootstrap Icons load from the jsDelivr CDN.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", 'https://cdn.jsdelivr.net'],
        scriptSrc: ["'self'", 'https://cdn.jsdelivr.net'],
        fontSrc: ["'self'", 'https://cdn.jsdelivr.net'],
        imgSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        'upgrade-insecure-requests': isProd ? [] : null,
      },
    },
  })
);

app.use(express.static(path.join(__dirname, '..', 'public')));
// HTMX is served from our own server (no CDN needed).
app.use('/vendor/htmx', express.static(path.join(__dirname, '..', 'node_modules', 'htmx.org', 'dist')));
app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    name: 'audit.sid',
    secret: sessionSecret || 'dev-only-insecure-secret-change-me',
    resave: false,
    saveUninitialized: false,
    store: new SqliteStore({
      client: db,
      expired: { clear: true, intervalMs: 15 * 60 * 1000 },
    }),
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
      maxAge: 8 * 60 * 60 * 1000, // 8 hours
    },
  })
);

app.use(flash);
app.use(csrf);
app.use(attachUser);

// Name shown in the sidebar, and which sidebar item to highlight.
app.use((req, res, next) => {
  res.locals.appName = process.env.APP_NAME || 'DRAAS REPORTS';
  const p = req.path;
  let nav = '';
  if (p === '/reports/new') nav = 'audit-new';
  else if (p === '/' || p.startsWith('/reports')) nav = 'audits';
  else if (p === '/companies/new') nav = 'company-new';
  else if (p.startsWith('/companies')) nav = 'companies';
  else if (p.startsWith('/procedure')) nav = 'procedure';
  else if (p.startsWith('/admin')) nav = 'users';
  res.locals.nav = nav;
  next();
});

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/index'));
app.use('/admin', require('./routes/admin'));
app.use('/companies', require('./routes/companies'));
app.use('/companies/:companyId', require('./routes/company-details'));
app.use('/reports', require('./routes/reports'));
app.use('/reports/:reportId', require('./routes/audit-tests'));
app.use('/screenshots', require('./routes/screenshots'));
app.use('/procedure', require('./routes/procedure'));

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'Page not found.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { title: 'Error', message: 'Something went wrong.' });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Audit app running on http://localhost:${port}`);
  console.log(`Screenshot storage: ${storage.describe()}`);
});
