// Times are stored as local wall-clock text (YYYY-MM-DDTHH:MM or YYYY-MM-DDTHH:MM:SS).
// Both ends are parsed the same way, so the difference is exact and unaffected by time zones.
function toMs(s) {
  if (!s) return null;
  const withSeconds = s.length === 16 ? `${s}:00` : s;
  const ms = Date.parse(`${withSeconds}Z`);
  return Number.isNaN(ms) ? null : ms;
}

function durationLabel(totalSeconds) {
  const d = Math.floor(totalSeconds / 86400);
  const h = Math.floor((totalSeconds % 86400) / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s || parts.length === 0) parts.push(`${s}s`);
  return parts.join(' ');
}

function duration(startedAt, finishedAt) {
  const a = toMs(startedAt);
  const b = toMs(finishedAt);
  if (a === null || b === null || b < a) return null;
  return durationLabel(Math.round((b - a) / 1000));
}

const display = (s) => (s ? s.replace('T', ' ') : '');

module.exports = { toMs, duration, display };
