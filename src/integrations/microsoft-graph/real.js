// Microsoft Graph adapter (real). OAuth2 client credentials with token caching.
// Covers three uses: shared-drive CSV download, Outlook mail metadata, Outlook calendar.
// Interface: isConfigured(), getFileMetadata, downloadFile, getEmailHistory, getOutlookCalendarEvents

const fetch = require('node-fetch');

const TENANT_ID     = process.env.GRAPH_TENANT_ID;
const CLIENT_ID     = process.env.GRAPH_CLIENT_ID;
const CLIENT_SECRET = process.env.GRAPH_CLIENT_SECRET;
const API_BASE      = (process.env.GRAPH_API_BASE || 'https://graph.microsoft.com/v1.0').replace(/\/$/, '');
const LOGIN_BASE    = (process.env.GRAPH_LOGIN_BASE || 'https://login.microsoftonline.com').replace(/\/$/, '');

const isConfigured = () => !!(TENANT_ID && CLIENT_ID && CLIENT_SECRET);

const EARLY_REFRESH_MS = 5 * 60 * 1000;
let _tokenCache = null;

async function getAccessToken() {
  if (_tokenCache && _tokenCache.expires_at - EARLY_REFRESH_MS > Date.now()) return _tokenCache.access_token;
  if (!isConfigured()) throw new Error('Graph credentials missing: set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET');

  const body = new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials',
  });
  const res = await fetch(`${LOGIN_BASE}/${TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Graph token request failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  _tokenCache = { access_token: data.access_token, expires_at: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}

function encodePath(p) {
  const trimmed = String(p).replace(/^\//, '');
  return '/' + trimmed.split('/').map(encodeURIComponent).join('/');
}

async function graphFetch(url, options = {}) {
  const token = await getAccessToken();
  return fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` } });
}

// ── Shared-drive file (the daily new-user CSV) ──────────────────────────────

async function getFileMetadata(siteId, filePath) {
  const res = await graphFetch(`${API_BASE}/sites/${siteId}/drive/root:${encodePath(filePath)}?$select=name,size,lastModifiedDateTime`);
  if (!res.ok) throw new Error(`Graph file metadata failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return { name: data.name, size: data.size, lastModifiedDateTime: data.lastModifiedDateTime };
}

// CSV exports are usually UTF-8, but files that started life in a spreadsheet are often
// Windows-1252. Decoding those as UTF-8 destroys accented characters, so try strict UTF-8
// first and fall back only when the bytes are not valid UTF-8.
function decodeCsvBuffer(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { return new TextDecoder('windows-1252').decode(buffer); }
}

async function downloadFile(siteId, filePath) {
  const res = await graphFetch(`${API_BASE}/sites/${siteId}/drive/root:${encodePath(filePath)}:/content`);
  if (!res.ok) throw new Error(`Graph file download failed: ${res.status} ${await res.text()}`);
  return decodeCsvBuffer(await res.arrayBuffer());
}

// ── Outlook mail metadata (Mail.ReadBasic.All) ──────────────────────────────
// Only envelope fields are requested; message bodies are never read.

async function getEmailHistory(teamMemberEmail, contactEmail) {
  const url =
    `${API_BASE}/users/${encodeURIComponent(teamMemberEmail)}/messages` +
    `?$search="${contactEmail}"` +
    `&$select=id,subject,sentDateTime,receivedDateTime,from,toRecipients&$top=50`;
  const res = await graphFetch(url);
  const messages = res.ok ? ((await res.json()).value || []) : [];

  const contactLower = contactEmail.toLowerCase();
  const memberLower  = teamMemberEmail.toLowerCase();
  const sent = [], received = [];
  for (const msg of messages) {
    const fromAddr = (msg.from?.emailAddress?.address || '').toLowerCase();
    const toAddrs  = (msg.toRecipients || []).map(r => (r.emailAddress?.address || '').toLowerCase());
    if (fromAddr === memberLower && toAddrs.includes(contactLower)) sent.push(msg);
    else if (fromAddr === contactLower) received.push(msg);
  }
  return { sent, received };
}

// ── Outlook calendar (Calendars.Read) ───────────────────────────────────────

async function getOutlookCalendarEvents(userEmail, startDateTime, endDateTime) {
  const url =
    `${API_BASE}/users/${encodeURIComponent(userEmail)}/calendarView` +
    `?startDateTime=${encodeURIComponent(startDateTime)}&endDateTime=${encodeURIComponent(endDateTime)}` +
    `&$select=id,iCalUId,subject,start,end,isAllDay,isCancelled,attendees,organizer` +
    `&$orderby=start/dateTime&$top=100`;
  const res = await graphFetch(url, { headers: { Prefer: 'outlook.timezone="UTC"' } });
  if (!res.ok) throw new Error(`Graph calendar fetch failed for ${userEmail}: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return (data.value || []).filter(e => !e.isCancelled && !e.isAllDay);
}

module.exports = { isConfigured, getFileMetadata, downloadFile, getEmailHistory, getOutlookCalendarEvents };
