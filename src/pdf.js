// Builds the audit report PDF with pdfmake (pure JavaScript, no browser needed).
const fs = require('fs');
const path = require('path');
const pdfmake = require('pdfmake');

const db = require('./db');
const storage = require('./storage');
const { duration, display } = require('./format');

pdfmake.addFonts(require('pdfmake/fonts/Roboto'));
// The report never downloads anything, and may only read pdfmake's own font files.
const FONT_DIR = path.dirname(require.resolve('pdfmake/fonts/Roboto')) + path.sep;
pdfmake.setUrlAccessPolicy(() => false);
pdfmake.setLocalAccessPolicy((file) => path.resolve(file).startsWith(FONT_DIR));

const REPORT_TITLE = process.env.REPORT_TITLE || 'IronTree Simulation Report';
const ACCENT = '#1f4e79';
const MUTED = '#666666';
const PAGE_WIDTH = 515; // A4 width minus 40pt margins on each side

// Drop a file called logo.png (or logo.jpg) into public/img/ to put it on every report.
function loadLogo() {
  for (const name of ['logo.png', 'logo.jpg', 'logo.jpeg']) {
    const file = path.join(__dirname, '..', 'public', 'img', name);
    if (fs.existsSync(file)) {
      const type = name.endsWith('png') ? 'image/png' : 'image/jpeg';
      return `data:${type};base64,${fs.readFileSync(file).toString('base64')}`;
    }
  }
  return null;
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

const stamp = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function collect(report) {
  const contacts = db
    .prepare('SELECT name, phone, email FROM company_contacts WHERE company_id = ? ORDER BY id')
    .all(report.company_id);
  const company = db.prepare('SELECT account_login, storage FROM companies WHERE id = ?').get(report.company_id) || {};
  const steps = db
    .prepare('SELECT position, text, result, note FROM audit_steps WHERE report_id = ? ORDER BY position, id')
    .all(report.id);

  const devices = db
    .prepare(
      `SELECT ad.id, d.name, d.device_type, d.identifier, d.notes
       FROM audit_devices ad JOIN devices d ON d.id = ad.device_id
       WHERE ad.report_id = ? ORDER BY d.name COLLATE NOCASE`
    )
    .all(report.id);

  for (const dev of devices) {
    dev.tests = {};
    for (const kind of ['backup', 'failover']) {
      const t = db
        .prepare('SELECT id, started_at, finished_at FROM device_tests WHERE audit_device_id = ? AND kind = ?')
        .get(dev.id, kind);
      dev.tests[kind] = {
        started: t ? t.started_at : null,
        finished: t ? t.finished_at : null,
        duration: t ? duration(t.started_at, t.finished_at) : null,
        shots: t
          ? db.prepare('SELECT id, storage_key, content_type FROM screenshots WHERE test_id = ? ORDER BY id').all(t.id)
          : [],
      };
    }
  }
  return { contacts, company, steps, devices };
}

// Fetch every screenshot from storage (a few at a time). A missing file doesn't fail the report.
async function loadImages(devices) {
  const shots = devices.flatMap((d) => Object.values(d.tests).flatMap((t) => t.shots));
  const images = {};
  let next = 0;
  const worker = async () => {
    while (next < shots.length) {
      const shot = shots[next++];
      try {
        const { stream } = await storage.get(shot.storage_key);
        const buf = await streamToBuffer(stream);
        images[`shot${shot.id}`] = `data:${shot.content_type};base64,${buf.toString('base64')}`;
        shot.key = `shot${shot.id}`;
      } catch (err) {
        console.error(`PDF: could not load screenshot ${shot.id}:`, err.message);
        shot.missing = true;
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));
  return images;
}

const gray = (text) => ({ text, color: '#999999', italics: true });
const cell = (text) => (text ? { text } : gray('Not recorded'));

function testBlock(label, test) {
  const block = [
    { text: `${label} test`, style: 'h3' },
    {
      table: {
        widths: ['*', '*', '*'],
        body: [
          [
            { text: 'Start', style: 'th' },
            { text: 'Finish', style: 'th' },
            { text: 'Duration', style: 'th' },
          ],
          [cell(display(test.started)), cell(display(test.finished)), test.duration ? { text: test.duration, bold: true } : gray('Not recorded')],
        ],
      },
      layout: 'lightHorizontalLines',
    },
  ];

  if (!test.shots.length) {
    block.push({ text: 'No screenshot attached.', ...{ color: '#999999', italics: true }, margin: [0, 8, 0, 0] });
  }
  for (const shot of test.shots) {
    block.push(
      shot.missing
        ? { text: 'A screenshot could not be loaded from storage.', color: '#b00020', margin: [0, 8, 0, 0] }
        : { image: shot.key, fit: [PAGE_WIDTH, 560], margin: [0, 8, 0, 0] }
    );
  }
  return block;
}

async function buildAuditPdf(report) {
  const { contacts, company, steps, devices } = collect(report);
  const images = await loadImages(devices);
  const logo = loadLogo();
  if (logo) images.logo = logo;

  const inProgress = report.status === 'in_progress';
  const generated = stamp();

  const titleBlock = {
    columns: [
      {
        width: '*',
        stack: [
          { text: REPORT_TITLE, style: 'title' },
          { text: report.company, style: 'company' },
        ],
      },
      ...(logo ? [{ width: 130, image: 'logo', fit: [130, 60], alignment: 'right' }] : []),
    ],
    margin: [0, 0, 0, 14],
  };

  const detailRows = [
    ['Audit date', report.audit_date],
    ['Completed by', report.author],
    [
      'Result',
      report.status === 'pass'
        ? { text: 'PASS', color: '#1a7f37', bold: true }
        : report.status === 'fail'
          ? { text: 'FAILED', color: '#b00020', bold: true }
          : { text: 'In progress (not yet marked Pass or Failed)', color: '#b26a00', bold: true },
    ],
    ['Devices audited', String(devices.length)],
    ...(company.account_login ? [['Backup account login', company.account_login]] : []),
    ...(company.storage ? [['Storage', company.storage]] : []),
  ].map(([k, v]) => [{ text: k, bold: true, color: MUTED }, typeof v === 'string' ? { text: v } : v]);

  const content = [
    titleBlock,
    { table: { widths: [110, '*'], body: detailRows }, layout: 'noBorders' },
  ];

  if (contacts.length) {
    content.push(
      { text: 'Contact persons', style: 'h2' },
      {
        table: {
          widths: ['*', 130, '*'],
          headerRows: 1,
          body: [
            ['Contact person', 'Number', 'Email address'].map((t) => ({ text: t, style: 'th' })),
            ...contacts.map((c) => [c.name, c.phone || '', c.email || '']),
          ],
        },
        layout: 'lightHorizontalLines',
      }
    );
  }

  content.push({ text: 'Summary', style: 'h2' });
  if (devices.length) {
    content.push({
      table: {
        widths: ['*', 110, 110],
        headerRows: 1,
        body: [
          ['Device', 'Backup duration', 'Failover duration'].map((t) => ({ text: t, style: 'th' })),
          ...devices.map((d) => [
            {
              stack: [
                { text: d.name, bold: true },
                ...(d.device_type || d.identifier
                  ? [{ text: [d.device_type, d.identifier].filter(Boolean).join(' · '), fontSize: 8, color: MUTED }]
                  : []),
              ],
            },
            d.tests.backup.duration ? { text: d.tests.backup.duration } : gray('Not recorded'),
            d.tests.failover.duration ? { text: d.tests.failover.duration } : gray('Not recorded'),
          ]),
        ],
      },
      layout: 'lightHorizontalLines',
    });
  } else {
    content.push(gray('No devices were recorded for this audit.'));
  }

  // Procedure: every step with its Pass / Fail result.
  if (steps.length) {
    const pass = steps.filter((x) => x.result === 'pass').length;
    const fail = steps.filter((x) => x.result === 'fail').length;
    const resultCell = (r) =>
      r === 'pass'
        ? { text: 'PASS', bold: true, color: '#1a7f37' }
        : r === 'fail'
          ? { text: 'FAIL', bold: true, color: '#b00020' }
          : gray('Not marked');

    content.push(
      { text: 'Procedure', style: 'h2' },
      {
        text: [
          { text: `${pass} passed`, color: '#1a7f37', bold: true },
          '   ',
          { text: `${fail} failed`, color: fail ? '#b00020' : MUTED, bold: !!fail },
          '   ',
          { text: `${steps.length - pass - fail} not marked`, color: MUTED },
        ],
        margin: [0, 0, 0, 6],
      },
      {
        table: {
          widths: [22, '*', 62, 130],
          headerRows: 1,
          body: [
            ['#', 'Step', 'Result', 'Note'].map((t) => ({ text: t, style: 'th' })),
            ...steps.map((st, i) => [String(i + 1), st.text, resultCell(st.result), st.note || '']),
          ],
        },
        layout: 'lightHorizontalLines',
      }
    );
  }

  // One page (or more, if there are many screenshots) per device.
  for (const d of devices) {
    content.push({ text: d.name, style: 'h2', pageBreak: 'before' });
    const meta = [d.device_type, d.identifier].filter(Boolean).join(' · ');
    if (meta) content.push({ text: meta, color: MUTED, margin: [0, 0, 0, 2] });
    if (d.notes) content.push({ text: d.notes, margin: [0, 2, 0, 0] });
    content.push(...testBlock('Backup', d.tests.backup), ...testBlock('Failover', d.tests.failover));
  }

  // Additional comments: always the last section of the report.
  // (Kept together on one page unless the comments are very long, so the heading never sits alone.)
  content.push({
    stack: [
      { text: 'Additional comments', style: 'h2' },
      report.comments ? { text: report.comments, lineHeight: 1.2 } : gray('None.'),
    ],
    unbreakable: (report.comments || '').length < 1500,
  });

  const doc = {
    pageSize: 'A4',
    pageMargins: [40, 55, 40, 50],
    info: {
      title: `${REPORT_TITLE} - ${report.company} - ${report.audit_date}`,
      author: report.author,
      subject: `${REPORT_TITLE} for ${report.company}`,
    },
    defaultStyle: { font: 'Roboto', fontSize: 10 },
    styles: {
      title: { fontSize: 24, bold: true, color: ACCENT },
      company: { fontSize: 15, color: '#333333', margin: [0, 2, 0, 0] },
      h2: { fontSize: 14, bold: true, color: ACCENT, margin: [0, 18, 0, 6] },
      h3: { fontSize: 11, bold: true, color: '#333333', margin: [0, 14, 0, 4] },
      th: { bold: true, color: MUTED, fontSize: 9 },
    },
    images,
    header: (page) =>
      page === 1
        ? null
        : { text: `${report.company}  ·  ${REPORT_TITLE}  ·  ${report.audit_date}${inProgress ? '  ·  IN PROGRESS' : ''}`, margin: [40, 25, 40, 0], fontSize: 8, color: MUTED },
    footer: (page, pages) => ({
      columns: [
        { text: `Generated ${generated}`, alignment: 'left' },
        { text: `Page ${page} of ${pages}`, alignment: 'right' },
      ],
      margin: [40, 0, 40, 0],
      fontSize: 8,
      color: MUTED,
    }),
    content,
  };

  const buffer = await pdfmake.createPdf(doc).getBuffer();

  const safe = `${REPORT_TITLE} - ${report.company} - ${report.audit_date}`.replace(/[\\/:*?"<>|\r\n]+/g, '-').slice(0, 150);
  return { buffer: Buffer.from(buffer), filename: `${safe}.pdf` };
}

module.exports = { buildAuditPdf };
