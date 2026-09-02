// Zendesk adapter (mock). In-memory helpdesk seeded from fixtures/zendesk.json.
// Tickets created through the app during a session stay in memory until restart.

const fixture = require('../fixtures/zendesk.json');
const { daysAgoIso } = require('../fixtures/clock');

const TICKET_URL_BASE = 'https://helpdesk.example.com/tickets';

const orgs  = new Map();   // lower(name) -> { id, name }
const users = new Map();   // lower(email) -> { id, name, email, organization_id }
let nextOrgId = 5000, nextUserId = 70000, nextTicketId = 41000;

const tickets = fixture.tickets.map(t => {
  const email = t.requester_email.toLowerCase();
  if (!users.has(email)) users.set(email, { id: nextUserId++, name: t.requester_name, email });
  return {
    id: nextTicketId++,
    requester_id: users.get(email).id,
    subject: t.subject,
    status: t.status,
    created_at: daysAgoIso(t.created_days_ago),
    updated_at: daysAgoIso(t.updated_days_ago ?? t.created_days_ago),
  };
});

const isConfigured = () => true;

async function findOrCreateOrg(orgName) {
  const key = orgName.toLowerCase();
  if (orgs.has(key)) return { id: orgs.get(key).id, created: false };
  const org = { id: nextOrgId++, name: orgName };
  orgs.set(key, org);
  return { id: org.id, created: true };
}

async function findOrCreateUser(lead, orgId) {
  const key = lead.email.toLowerCase();
  if (users.has(key)) return { id: users.get(key).id, created: false };
  const user = {
    id: nextUserId++,
    name: [lead.first_name, lead.last_name].filter(Boolean).join(' ') || lead.email,
    email: key,
    organization_id: orgId || null,
  };
  users.set(key, user);
  return { id: user.id, created: true };
}

async function getTicketsByEmail(email) {
  const user = users.get(email.toLowerCase());
  if (!user) return [];
  return tickets
    .filter(t => t.requester_id === user.id)
    .map(t => ({ id: t.id, subject: t.subject, status: t.status, created_at: t.created_at, url: `${TICKET_URL_BASE}/${t.id}` }))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

async function createTicket({ subject, description, requesterEmail, requesterName, orgName }) {
  let orgId;
  if (orgName) orgId = (await findOrCreateOrg(orgName)).id;
  const { id: requesterId } = await findOrCreateUser({ email: requesterEmail, first_name: requesterName }, orgId);
  const now = new Date().toISOString();
  const ticket = { id: nextTicketId++, requester_id: requesterId, subject, status: 'new', created_at: now, updated_at: now, description };
  tickets.push(ticket);
  return { id: ticket.id, url: `${TICKET_URL_BASE}/${ticket.id}` };
}

async function pollRecentTickets(sinceUnixTimestamp) {
  const since = sinceUnixTimestamp * 1000;
  const recent = tickets.filter(t => new Date(t.updated_at).getTime() >= since);
  const userIds = new Set(recent.map(t => t.requester_id));
  return {
    tickets: recent,
    users: [...users.values()].filter(u => userIds.has(u.id)),
    endTime: Math.floor(Date.now() / 1000),
  };
}

module.exports = { isConfigured, findOrCreateOrg, findOrCreateUser, getTicketsByEmail, createTicket, pollRecentTickets };
