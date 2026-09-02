// Fixtures store times as offsets from "now" so mock data always looks current.
// Offsets are rounded to the half hour so the same fixture yields tidy meeting times.

function atOffsetHours(hours) {
  const d = new Date(Date.now() + hours * 3600 * 1000);
  d.setUTCMinutes(d.getUTCMinutes() < 30 ? 0 : 30, 0, 0);
  return d;
}

function isoAtOffsetHours(hours) {
  return atOffsetHours(hours).toISOString();
}

function daysAgoIso(days) {
  return new Date(Date.now() - days * 86400 * 1000).toISOString();
}

module.exports = { atOffsetHours, isoAtOffsetHours, daysAgoIso };
