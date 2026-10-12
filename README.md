# DRAAS REPORTS

Express + Handlebars + SQLite. Employees sign in and (in later steps) create device audit reports.

## Run it

```bash
npm install
cp .env.example .env      # then edit SESSION_SECRET and ADMIN_PASSWORD
npm run seed              # creates the first admin (add -- --sample for demo companies)
npm run dev               # http://localhost:3000
```

## Layout

- `src/server.js` - app setup (sessions, CSRF, security headers, Handlebars)
- `src/schema.sql` - all tables (users, companies, reports, devices, backup times, screenshots)
- `src/middleware.js` - auth, admin check, CSRF, flash messages
- `src/routes/` - `auth.js` (login/logout), `admin.js` (user management, admin only), `index.js` (dashboard), `companies.js` (company list + company page), `company-details.js` (contacts and devices), `reports.js` (audits + device panel)
- `views/` - Handlebars templates (`layouts/main.handlebars` wraps every page)
- `scripts/seed.js` - first admin + optional sample companies

## Data model

Devices belong to a **company** and are reused across audits. An audit picks which of the company's devices it covers (`audit_devices`); backup times and screenshots attach to that row, so they belong to one audit. Retiring a device hides it from new audits but keeps its history.

The app upgrades older databases automatically on start (see `src/db.js`).

## Screenshot storage

Screenshots are stored outside the database. Set `STORAGE_DRIVER` in `.env`:

- `local` (default): files go in `UPLOAD_DIR` (`./uploads`).
- `s3`: any S3-compatible server. Fill in the `S3_*` settings, then run `npm run check-storage` to confirm it can write, read and delete.

The database only stores each file's key, so you can switch drivers later. Images are never public: they're streamed through `/screenshots/:id` to signed-in users only. Uploads are checked to be real PNG/JPEG/WebP images, rotated upright, stripped of metadata, and capped at 1920px wide (10 MB max upload, 10 per test).

Back up `data/` **and** either `uploads/` or your S3 bucket.

## PDF reports

`/reports/:id/pdf` opens the audit as a PDF in the browser; add `?download=1` to save it as a file. The PDF is built by `src/pdf.js` with pdfmake (pure JavaScript, no browser or extra install needed): a summary page, then one section per device with its backup/failover times, durations and screenshots.

To put your logo on every report, save it as `public/img/logo.png` (or `logo.jpg`).

## Look and feel

The UI uses Bootstrap 5.3.8 and Bootstrap Icons, loaded from the jsDelivr CDN (pinned versions with integrity hashes, set in `views/layouts/main.handlebars`). Browsers need to be able to reach `cdn.jsdelivr.net`. HTMX is served from your own server.

- Colours and spacing live in the variables at the top of `public/css/app.css`.
- The name shown in the sidebar comes from `APP_NAME` in `.env` (default "DRAAS REPORTS").
- The moon/sun button in the sidebar switches between dark and light, and remembers the choice per browser.
- Sidebar items are in `views/layouts/main.handlebars`; each page's top card is the `page-header` partial.

## Companies, devices and audits

- A company has details (backup-application account login, storage, notes) and any number of contact persons (name, number, email). All of it is added, edited and removed on the **Add / Edit company** pages.
- **Devices live on the company page.** A new audit includes the company's *active* devices, and a draft audit follows the company page (new devices appear; retired devices drop out unless something was already recorded for them). Submitted audits are frozen.
- New audits are started by typing the company's name (the box searches as you type).

## Procedure

`/procedure` holds the standard pass/fail steps (a starter set is created the first time the app upgrades; replace it with your own). Each new audit gets its own copy to mark Pass or Fail, with an optional note, and the results appear in the PDF. Editing the procedure never changes audits already started. Any signed-in employee can edit it.

## Screenshots

On an audit, click the dashed box under Backup or Failover and press Ctrl+V (Cmd+V on a Mac) to upload a screenshot straight from the clipboard. "Or choose a file" is there as a fallback.

## Audit result, comments and users

- An audit is **In progress** until you mark it **Pass** or **Failed** (and you can Reopen it). Once a result is marked, the audit's device list stops following the company page.
- "Additional comments" at the bottom of an audit are printed as the last section of the PDF.
- The PDF title comes from `REPORT_TITLE` in `.env` (default "IronTree Simulation Report").
- Every user has a username and password, plus a **Name** and **Surname**. The name and surname are shown on reports under **Completed by** (the person who started the audit), in the sidebar, and on the PDF. Users without a name yet are shown by username until an admin fills it in (**Users -> Edit**). `ADMIN_FIRST_NAME` / `ADMIN_LAST_NAME` in `.env` set the first admin's name when seeding.
- Admins can edit a user's name, username and role and reset their password (**Users -> Edit**). Resetting a password, or disabling a user, signs them out everywhere. You can't change your own role or disable yourself.

## Where data is stored

- **The database** is one SQLite file, `data/app.db` (set by `DATABASE_PATH`), on the machine running the app. It holds everything except the screenshot image files: users, companies, contacts, devices, audits, times, procedure results, comments and login sessions.
- **Screenshots** go to `UPLOAD_DIR` or your S3 bucket (`STORAGE_DRIVER`).
- Back up **both**. To copy the database safely, stop the app first (or use SQLite's `.backup` command) so the `-wal` file isn't missed.

## Rules to remember

- Every POST form needs `<input type="hidden" name="_csrf" value="{{csrfToken}}">`.
- Inside `{{#each}}`, reach the page-level token with `{{../csrfToken}}`.
- Set `COOKIE_SECURE=true` once you serve over HTTPS, and `TRUST_PROXY=true` behind a reverse proxy.

## Next steps

3. ~~Company list + "New audit" flow~~ (done)
4. ~~Company page + add/remove devices on an audit (HTMX)~~ (done)
5. ~~Backup + failover times and screenshots (S3 or local storage)~~ (done)
6. ~~Report PDF (view in browser or download)~~ (done)
