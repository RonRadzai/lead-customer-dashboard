// Calendly adapter (real). Personal access tokens, one per polled account.
// Interface: isConfigured(), accountCount(), fetchEvents({ minStartTime, maxStartTime })
//   -> [{ uri, name, start_time, status: 'active'|'canceled', invitees: [{ name, email }] }]

const fetch = require('node-fetch');

const API_BASE = (process.env.CALENDLY_API_BASE || 'https://api.calendly.com').replace(/\/$/, '');

// CALENDLY_API_TOKEN plus any CALENDLY_TOKEN_<NAME> so more accounts can be added without code changes.
function getTokens() {
  const tokens = new Set();
  if (process.env.CALENDLY_API_TOKEN) tokens.add(process.env.CALENDLY_API_TOKEN);
  for (const [key, val] of Object.entries(process.env)) {
    if (key.startsWith('CALENDLY_TOKEN_') && val) tokens.add(val);
  }
  return [...tokens];
}

const isConfigured = () => getTokens().length > 0;
const accountCount = () => getTokens().length;

const headersFor = token => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
const _userUriCache = {};

async function getUserUri(token) {
  if (_userUriCache[token]) return _userUriCache[token];
  const res = await fetch(`${API_BASE}/users/me`, { headers: headersFor(token) });
  if (!res.ok) throw new Error(`Calendly /users/me failed: ${res.status}`);
  const data = await res.json();
  _userUriCache[token] = data.resource.uri;
  return _userUriCache[token];
}

async function listScheduledEvents(token, userUri, minStartTime, maxStartTime, status) {
  const events = [];
  let pageToken = null;
  do {
    const params = new URLSearchParams({ user: userUri, min_start_time: minStartTime, max_start_time: maxStartTime, status, count: 100 });
    if (pageToken) params.set('page_token', pageToken);
    const res = await fetch(`${API_BASE}/scheduled_events?${params}`, { headers: headersFor(token) });
    if (!res.ok) throw new Error(`Calendly /scheduled_events (${status}) failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    events.push(...data.collection);
    pageToken = data.pagination?.next_page_token || null;
  } while (pageToken);
  return events;
}

async function listInvitees(token, eventUri) {
  const uuid = eventUri.split('/').pop();
  const res = await fetch(`${API_BASE}/scheduled_events/${uuid}/invitees?count=100`, { headers: headersFor(token) });
  if (!res.ok) throw new Error(`Calendly invitees failed: ${res.status}`);
  return (await res.json()).collection;
}

async function fetchEvents({ minStartTime, maxStartTime }) {
  const out = [];
  for (const token of getTokens()) {
    const userUri = await getUserUri(token);
    const [active, canceled] = await Promise.all([
      listScheduledEvents(token, userUri, minStartTime, maxStartTime, 'active'),
      listScheduledEvents(token, userUri, minStartTime, maxStartTime, 'canceled'),
    ]);
    for (const event of [...active, ...canceled]) {
      const invitees = await listInvitees(token, event.uri);
      out.push({
        uri: event.uri,
        name: event.name,
        start_time: event.start_time,
        status: event.status,
        invitees: invitees.map(i => ({ name: i.name || null, email: i.email || null })),
      });
    }
  }
  return out;
}

module.exports = { isConfigured, accountCount, fetchEvents };
