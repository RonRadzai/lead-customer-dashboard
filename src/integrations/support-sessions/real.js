// Support sessions adapter (real). Pulls session history from a sibling internal
// support-notes application over its REST API.
// Interface: isConfigured(), listSessions(), searchSessions(email)
//   session: { id, customer_email, customer_name, org_name, date_created, issues: [{ platform, status, description }] }

const fetch = require('node-fetch');

const apiBase = () => (process.env.SUPPORT_SESSIONS_API_URL || '').replace(/\/$/, '');
const isConfigured = () => !!apiBase();

const timeoutSignal = ms => (AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);

async function listSessions() {
  const res = await fetch(`${apiBase()}/api/sessions`, { signal: timeoutSignal(10000) });
  if (!res.ok) throw new Error(`Support sessions API -> ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : (data.sessions || []);
}

async function searchSessions(email) {
  const res = await fetch(`${apiBase()}/api/search?query=${encodeURIComponent(email)}`, { signal: timeoutSignal(5000) });
  if (!res.ok) throw new Error(`Support sessions search -> ${res.status}`);
  const data = await res.json();
  const sessions = Array.isArray(data) ? data : (data.sessions || []);
  return sessions.filter(s => s.customer_email?.toLowerCase() === email.toLowerCase());
}

module.exports = { isConfigured, listSessions, searchSessions };
