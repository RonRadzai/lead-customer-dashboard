// Zoom adapter (mock). Same interface as real.js, data from fixtures/zoom.json.

const fixture = require('../fixtures/zoom.json');
const { isoAtOffsetHours } = require('../fixtures/clock');

const isConfigured = () => true;

async function fetchMeetings({ minStartTime, maxStartTime }) {
  const min = new Date(minStartTime).getTime();
  const max = new Date(maxStartTime).getTime();
  return fixture.meetings
    .map(m => ({
      id: m.id,
      topic: m.topic,
      start_time: isoAtOffsetHours(m.start_offset_hours),
      duration: m.duration,
      join_url: `https://zoom.example.com/j/${m.id}`,
      host_name: m.host_name,
      status: m.start_offset_hours < 0 ? 'completed' : 'scheduled',
      participants: m.participants,
    }))
    .filter(m => {
      const t = new Date(m.start_time).getTime();
      return t >= min && t <= max;
    });
}

module.exports = { isConfigured, fetchMeetings };
