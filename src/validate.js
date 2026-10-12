const oneLine = (v) => String(v || '').trim().replace(/\s+/g, ' ');
const multiLine = (v) => String(v || '').trim();

function validateDevice(body) {
  const values = {
    name: oneLine(body.name),
    device_type: oneLine(body.device_type),
    identifier: oneLine(body.identifier),
    notes: multiLine(body.notes),
  };
  let error = null;
  if (!values.name) error = 'Device name is required.';
  else if (values.name.length > 100) error = 'Device name must be 100 characters or fewer.';
  else if (values.device_type.length > 50) error = 'Device type must be 50 characters or fewer.';
  else if (values.identifier.length > 100) error = 'Identifier must be 100 characters or fewer.';
  else if (values.notes.length > 1000) error = 'Notes must be 1000 characters or fewer.';
  return { values, error };
}

function validateContact(body) {
  const values = {
    name: oneLine(body.name),
    role: oneLine(body.role),
    email: oneLine(body.email),
    phone: oneLine(body.phone),
    notes: multiLine(body.notes),
  };
  let error = null;
  if (!values.name) error = 'Contact name is required.';
  else if (values.name.length > 100) error = 'Name must be 100 characters or fewer.';
  else if (values.role.length > 100) error = 'Role must be 100 characters or fewer.';
  else if (values.email && (values.email.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)))
    error = 'Please enter a valid email address.';
  else if (values.phone.length > 50) error = 'Phone must be 50 characters or fewer.';
  else if (values.notes.length > 500) error = 'Notes must be 500 characters or fewer.';
  return { values, error };
}

module.exports = { validateDevice, validateContact };

// Start/finish times from <input type="datetime-local">. Either may be left blank.
const { toMs } = require('./format');
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

function validateTimes(body) {
  const started = String(body.started_at || '').trim();
  const finished = String(body.finished_at || '').trim();
  const result = { started: started || null, finished: finished || null, error: null };

  const bad = (s) => s && (!TIME_RE.test(s) || toMs(s) === null);
  if (bad(started) || bad(finished)) {
    result.error = 'Please enter valid start and finish times.';
  } else if (started && finished && toMs(finished) < toMs(started)) {
    result.error = 'The finish time can\'t be before the start time.';
  }
  return result;
}

module.exports.validateTimes = validateTimes;

// Company form: name, notes, backup-application login (username only), storage, and a
// repeating list of contacts (person, phone number, email). Blank contact rows are ignored.
const toArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const MAX_CONTACTS = 20;

function validateCompany(body) {
  const values = {
    name: oneLine(body.name),
    notes: multiLine(body.notes),
    account_login: oneLine(body.account_login),
    storage: multiLine(body.storage),
  };

  const ids = toArray(body.contact_id);
  const names = toArray(body.contact_name);
  const phones = toArray(body.contact_phone);
  const emails = toArray(body.contact_email);
  const rows = Math.max(names.length, phones.length, emails.length);

  const contacts = [];
  for (let i = 0; i < rows; i++) {
    const c = {
      id: Number.isInteger(Number(ids[i])) && Number(ids[i]) > 0 ? Number(ids[i]) : null,
      name: oneLine(names[i]),
      phone: oneLine(phones[i]),
      email: oneLine(emails[i]),
    };
    if (c.name || c.phone || c.email) contacts.push(c);
  }

  let error = null;
  if (!values.name) error = 'Company name is required.';
  else if (values.name.length > 100) error = 'Company name must be 100 characters or fewer.';
  else if (values.notes.length > 1000) error = 'Notes must be 1000 characters or fewer.';
  else if (values.account_login.length > 100) error = 'Account login must be 100 characters or fewer.';
  else if (values.storage.length > 500) error = 'Storage must be 500 characters or fewer.';
  else if (contacts.length > MAX_CONTACTS) error = `A company can have up to ${MAX_CONTACTS} contacts.`;
  else {
    for (const c of contacts) {
      if (!c.name) { error = 'Each contact needs a person\'s name.'; break; }
      if (c.name.length > 100) { error = 'Contact names must be 100 characters or fewer.'; break; }
      if (c.phone.length > 50) { error = 'Phone numbers must be 50 characters or fewer.'; break; }
      if (c.email && (c.email.length > 150 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c.email))) {
        error = `"${c.email}" isn't a valid email address.`;
        break;
      }
    }
  }
  return { values, contacts, error };
}

module.exports.validateCompany = validateCompany;

// ---- Users ----
function validateUsername(value) {
  const username = String(value || '').trim();
  return /^[a-zA-Z0-9._-]{3,32}$/.test(username)
    ? { username, error: null }
    : { username, error: 'Username must be 3–32 characters: letters, numbers, dot, dash, underscore.' };
}

// bcrypt only uses the first 72 bytes, so longer passwords are refused instead of silently cut.
function validatePassword(password) {
  if (password.length < 10) return 'Password must be at least 10 characters.';
  if (Buffer.byteLength(password) > 72) return 'Password must be 72 bytes or fewer.';
  return null;
}

module.exports.validateUsername = validateUsername;
module.exports.validatePassword = validatePassword;

// Every user has a Name and a Surname; they're what the report shows under "Completed by".
function validatePersonName(body) {
  const first_name = oneLine(body.first_name);
  const last_name = oneLine(body.last_name);
  let error = null;
  if (!first_name) error = 'Name is required.';
  else if (!last_name) error = 'Surname is required.';
  else if (first_name.length > 50 || last_name.length > 50) error = 'Name and surname must each be 50 characters or fewer.';
  return { first_name, last_name, error };
}

module.exports.validatePersonName = validatePersonName;
