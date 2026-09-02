// Microsoft Graph adapter (mock). Same interface as real.js.
//   - shared-drive CSV: served from data/sample/new-users-import.csv, with DateEntered values
//     shifted so the newest row is always yesterday (the import stays believable on any day)
//   - Outlook mail metadata and calendar events: fixtures/outlook.json

const fs = require('fs');
const path = require('path');
const fixture = require('../fixtures/outlook.json');
const { atOffsetHours, daysAgoIso } = require('../fixtures/clock');
const { parseCsvLine, parseCsvDate } = require('../../csv');

const SAMPLE_CSV = path.join(__dirname, '..', '..', '..', 'data', 'sample', 'new-users-import.csv');

const isConfigured = () => true;

// One "version" per calendar day, so the importer runs once a day and then sees "unchanged".
function todayStamp() {
  return new Date().toISOString().slice(0, 10) + 'T06:00:00Z';
}

async function getFileMetadata() {
  const stat = fs.statSync(SAMPLE_CSV);
  return { name: path.basename(SAMPLE_CSV), size: stat.size, lastModifiedDateTime: todayStamp() };
}

// Shift every M/D/YYYY date in the DateEntered column by the same number of days.
function shiftDates(csvText) {
  const lines = csvText.split(/\r?\n/).filter(l => l.trim());
  const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'));
  const dateIdx = headers.indexOf('dateentered');
  if (dateIdx < 0) return csvText;

  const rows = lines.slice(1).map(l => parseCsvLine(l));
  const parsed = rows.map(r => parseCsvDate(r[dateIdx])).filter(Boolean).map(s => new Date(s.replace(' ', 'T') + 'Z'));
  if (parsed.length === 0) return csvText;

  const newest = Math.max(...parsed.map(d => d.getTime()));
  const yesterday = new Date();
  yesterday.setUTCHours(0, 0, 0, 0);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const shiftDays = Math.round((yesterday.getTime() - newest) / 86400000);

  const two = n => String(n).padStart(2, '0');
  const fmt = d => `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
  const quote = v => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

  const out = [lines[0]];
  for (const r of rows) {
    const iso = parseCsvDate(r[dateIdx]);
    if (iso) {
      const d = new Date(iso.replace(' ', 'T') + 'Z');
      d.setUTCDate(d.getUTCDate() + shiftDays);
      r[dateIdx] = fmt(d);
    }
    out.push(r.map(quote).join(','));
  }
  return out.join('\n');
}

async function downloadFile() {
  return shiftDates(fs.readFileSync(SAMPLE_CSV, 'utf8'));
}

async function getEmailHistory(teamMemberEmail, contactEmail) {
  const contact = contactEmail.toLowerCase();
  const member  = teamMemberEmail.toLowerCase();
  const sent = [], received = [];
  for (const m of fixture.emails) {
    if (m.contact.toLowerCase() !== contact || m.team_member.toLowerCase() !== member) continue;
    const when = daysAgoIso(m.days_ago);
    const msg = {
      id: `mock-mail-${m.team_member}-${m.contact}-${m.days_ago}-${m.direction}`,
      subject: m.subject,
      sentDateTime: when,
      receivedDateTime: when,
      from: { emailAddress: { address: m.direction === 'sent' ? member : contact } },
      toRecipients: [{ emailAddress: { address: m.direction === 'sent' ? contact : member } }],
    };
    (m.direction === 'sent' ? sent : received).push(msg);
  }
  return { sent, received };
}

async function getOutlookCalendarEvents(userEmail, startDateTime, endDateTime) {
  const min = new Date(startDateTime).getTime();
  const max = new Date(endDateTime).getTime();
  const user = userEmail.toLowerCase();
  const noZ = d => d.toISOString().replace('Z', '');
  return fixture.calendar
    .filter(e => e.host.toLowerCase() === user)
    .map(e => {
      const start = atOffsetHours(e.start_offset_hours);
      const end = new Date(start.getTime() + (e.duration_minutes || 30) * 60000);
      return {
        id: e.id,
        iCalUId: `${e.id}@mock`,
        subject: e.subject,
        start: { dateTime: noZ(start), timeZone: 'UTC' },
        end:   { dateTime: noZ(end),   timeZone: 'UTC' },
        isAllDay: false,
        isCancelled: false,
        organizer: { emailAddress: { name: e.host_name, address: e.host } },
        attendees: e.attendees.map(a => ({ emailAddress: { name: a.name, address: a.email } })),
        _t: start.getTime(),
      };
    })
    .filter(e => e._t >= min && e._t <= max)
    .map(({ _t, ...e }) => e);
}

module.exports = { isConfigured, getFileMetadata, downloadFile, getEmailHistory, getOutlookCalendarEvents };
