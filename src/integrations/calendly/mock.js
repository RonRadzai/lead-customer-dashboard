// Calendly adapter (mock). Same interface as real.js, data from fixtures/calendly.json.

const fixture = require('../fixtures/calendly.json');
const { isoAtOffsetHours } = require('../fixtures/clock');

const isConfigured = () => true;
const accountCount = () => 1;

async function fetchEvents({ minStartTime, maxStartTime }) {
  const min = new Date(minStartTime).getTime();
  const max = new Date(maxStartTime).getTime();
  return fixture.events
    .map(e => ({
      uri: `https://api.calendly.com/scheduled_events/${e.id}`,
      name: e.name,
      start_time: isoAtOffsetHours(e.start_offset_hours),
      status: e.status,
      invitees: e.invitees,
    }))
    .filter(e => {
      const t = new Date(e.start_time).getTime();
      return t >= min && t <= max;
    });
}

module.exports = { isConfigured, accountCount, fetchEvents };
