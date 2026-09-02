// Zendesk adapter (real). OAuth2 client-credentials grant; token cached in memory.
// Interface: isConfigured(), findOrCreateOrg, findOrCreateUser, getTicketsByEmail, createTicket, pollRecentTickets

const fetch = require('node-fetch');

const subdomain = () => process.env.ZENDESK_SUBDOMAIN;
const origin    = () => `https://${subdomain()}.zendesk.com`;
const base      = () => `${origin()}/api/v2`;

const isConfigured = () =>
  !!(process.env.ZENDESK_SUBDOMAIN && process.env.ZENDESK_CLIENT_ID && process.env.ZENDESK_CLIENT_SECRET);

let cachedToken = null;
let cachedTokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt) return cachedToken;
  const res = await fetch(`${origin()}/oauth/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: process.env.ZENDESK_CLIENT_ID,
      client_secret: process.env.ZENDESK_CLIENT_SECRET,
      scope: 'read write',
    }),
  });
  if (!res.ok) throw new Error(`Zendesk OAuth token request -> ${res.status}: ${await res.text()}`);
  const data = await res.json();
  cachedToken = data.access_token;
  // Some OAuth clients omit expires_in; refresh every 25 minutes regardless.
  const ttlSeconds = data.expires_in || 25 * 60;
  cachedTokenExpiresAt = Date.now() + (ttlSeconds - 60) * 1000;
  return cachedToken;
}

async function authHeader() { return `Bearer ${await getAccessToken()}`; }

async function zdGet(path) {
  const res = await fetch(`${base()}${path}`, { headers: { Authorization: await authHeader() } });
  if (!res.ok) throw new Error(`Zendesk GET ${path} -> ${res.status}`);
  return res.json();
}

async function zdPost(path, body) {
  const res = await fetch(`${base()}${path}`, {
    method: 'POST',
    headers: { Authorization: await authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Zendesk POST ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

// Returns { id, created }
async function findOrCreateOrg(orgName, orgWebsite) {
  const data = await zdGet(`/organizations/search?name=${encodeURIComponent(orgName)}`);
  const match = (data.organizations || []).find(o => o.name.toLowerCase() === orgName.toLowerCase());
  if (match) return { id: match.id, created: false };

  const domainNames = orgWebsite ? [orgWebsite.replace(/^https?:\/\//, '').split('/')[0]] : [];
  const created = await zdPost('/organizations', { organization: { name: orgName, domain_names: domainNames } });
  return { id: created.organization.id, created: true };
}

// Returns { id, created }
async function findOrCreateUser(lead, orgId) {
  const data = await zdGet(`/users/search?query=email:${encodeURIComponent(lead.email)}`);
  const existing = (data.users || [])[0];
  if (existing) return { id: existing.id, created: false };

  const name = [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email;
  const user = { name, email: lead.email, role: 'end-user' };
  if (lead.phone) user.phone = lead.phone;
  if (orgId) user.organization_id = orgId;
  const created = await zdPost('/users', { user });
  return { id: created.user.id, created: true };
}

// Tickets requested by this email in the last 18 months, newest first.
async function getTicketsByEmail(email) {
  const searchData = await zdGet(`/users/search.json?query=email:${encodeURIComponent(email)}`);
  const user = (searchData.users || [])[0];
  if (!user) return [];

  const since = new Date(Date.now() - 548 * 86400 * 1000).toISOString();
  const ticketsData = await zdGet(`/users/${user.id}/tickets/requested.json?created_after=${encodeURIComponent(since)}`);
  return (ticketsData.tickets || [])
    .map(t => ({ id: t.id, subject: t.subject, status: t.status, created_at: t.created_at, url: `${origin()}/tickets/${t.id}` }))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

// Returns { id, url } of the created ticket
async function createTicket({ subject, description, requesterEmail, requesterName, orgName }) {
  let orgId;
  if (orgName) {
    try { orgId = (await findOrCreateOrg(orgName)).id; } catch (_) { /* proceed without org */ }
  }

  const searchData = await zdGet(`/users/search.json?query=email:${encodeURIComponent(requesterEmail)}`);
  let requesterId;
  const existing = (searchData.users || [])[0];
  if (existing) {
    requesterId = existing.id;
  } else {
    const userBody = { name: requesterName || requesterEmail, email: requesterEmail, role: 'end-user' };
    if (orgId) userBody.organization_id = orgId;
    requesterId = (await zdPost('/users.json', { user: userBody })).user.id;
  }

  const ticket = (await zdPost('/tickets.json', {
    ticket: { requester_id: requesterId, subject, comment: { body: description, public: false } },
  })).ticket;
  return { id: ticket.id, url: `${origin()}/tickets/${ticket.id}` };
}

// Incremental export of tickets updated since a Unix timestamp.
// Returns { tickets, users (sideloaded), endTime (cursor for the next poll) }.
async function pollRecentTickets(sinceUnixTimestamp) {
  const results = { tickets: [], users: [], endTime: null };
  let url = `${base()}/incremental/tickets.json?start_time=${sinceUnixTimestamp}&include=users`;
  while (url) {
    const res = await fetch(url, { headers: { Authorization: await authHeader() } });
    if (res.status === 422) break; // start_time too recent (< 1 min ago)
    if (!res.ok) throw new Error(`Zendesk incremental tickets -> ${res.status}`);
    const data = await res.json();
    results.tickets.push(...(data.tickets || []));
    results.users.push(...(data.users || []));
    results.endTime = data.end_time || results.endTime;
    url = data.end_of_stream ? null : (data.next_page || null);
  }
  return results;
}

module.exports = { isConfigured, findOrCreateOrg, findOrCreateUser, getTicketsByEmail, createTicket, pollRecentTickets };
