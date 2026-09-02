// Support sessions adapter (mock). Same interface as real.js, data from fixtures/support-sessions.json.

const fixture = require('../fixtures/support-sessions.json');
const { daysAgoIso } = require('../fixtures/clock');

const isConfigured = () => true;

function materialize() {
  return fixture.sessions.map((s, i) => ({
    id: 3000 + i,
    customer_email: s.customer_email,
    customer_name: s.customer_name,
    org_name: s.org_name,
    date_created: daysAgoIso(s.days_ago),
    issues: s.issues,
  }));
}

async function listSessions() { return materialize(); }

async function searchSessions(email) {
  const e = email.toLowerCase();
  return materialize().filter(s => s.customer_email.toLowerCase() === e);
}

module.exports = { isConfigured, listSessions, searchSessions };
