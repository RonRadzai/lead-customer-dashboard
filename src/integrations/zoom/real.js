// Zoom adapter (real). Server-to-Server OAuth app (account_credentials grant).
// Interface: isConfigured(), fetchMeetings({ minStartTime, maxStartTime })
//   -> [{ id, topic, start_time, duration, join_url, host_name, status, participants: [{ name, email }] }]
//
// Scopes needed: user:read:admin, meeting:read:admin, report:read:admin (participants of past meetings).

const fetch = require('node-fetch');

const API_BASE  = (process.env.ZOOM_API_BASE || 'https://api.zoom.us/v2').replace(/\/$/, '');
const OAUTH_URL = process.env.ZOOM_OAUTH_URL || 'https://zoom.us/oauth/token';

const isConfigured = () =>
  !!(process.env.ZOOM_ACCOUNT_ID && process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET);

let _token = null;
let _tokenExpiresAt = 0;

async function getAccessToken() {
  if (_token && Date.now() < _tokenExpiresAt) return _token;
  const basic = Buffer.from(`${process.env.ZOOM_CLIENT_ID}:${process.env.ZOOM_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${OAUTH_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(process.env.ZOOM_ACCOUNT_ID)}`, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}` },
  });
  if (!res.ok) throw new Error(`Zoom OAuth token request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  _token = data.access_token;
  _tokenExpiresAt = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  return _token;
}

async function zoomGet(path) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${await getAccessToken()}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Zoom GET ${path} failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function listUsers() {
  const data = await zoomGet('/users?status=active&page_size=300');
  return (data?.users || []).map(u => ({
    id: u.id,
    name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email,
    email: u.email,
  }));
}

async function listMeetingsForUser(userId, type) {
  const data = await zoomGet(`/users/${encodeURIComponent(userId)}/meetings?type=${type}&page_size=300`);
  return data?.meetings || [];
}

// Upcoming meetings expose registrants; past meetings expose a participants report.
async function participantsFor(meeting, isPast) {
  try {
    if (isPast) {
      const data = await zoomGet(`/report/meetings/${meeting.id}/participants?page_size=300`);
      return (data?.participants || []).map(p => ({ name: p.name || null, email: (p.user_email || '').toLowerCase() || null }));
    }
    const data = await zoomGet(`/meetings/${meeting.id}/registrants?page_size=300`);
    return (data?.registrants || []).map(r => ({
      name: [r.first_name, r.last_name].filter(Boolean).join(' ') || null,
      email: (r.email || '').toLowerCase() || null,
    }));
  } catch {
    return [];
  }
}

async function fetchMeetings({ minStartTime, maxStartTime }) {
  const min = new Date(minStartTime).getTime();
  const max = new Date(maxStartTime).getTime();
  const out = [];
  for (const user of await listUsers()) {
    const [upcoming, previous] = await Promise.all([
      listMeetingsForUser(user.id, 'upcoming'),
      listMeetingsForUser(user.id, 'previous_meetings'),
    ]);
    const all = [...upcoming.map(x => ({ ...x, _past: false })), ...previous.map(x => ({ ...x, _past: true }))];
    for (const m of all) {
      if (!m.start_time) continue;
      const t = new Date(m.start_time).getTime();
      if (t < min || t > max) continue;
      out.push({
        id: String(m.id),
        topic: m.topic || 'Zoom Meeting',
        start_time: m.start_time,
        duration: m.duration || null,
        join_url: m.join_url || null,
        host_name: user.name,
        status: m._past ? 'completed' : 'scheduled',
        participants: await participantsFor(m, m._past),
      });
    }
  }
  return out;
}

module.exports = { isConfigured, fetchMeetings };
