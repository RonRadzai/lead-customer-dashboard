// Unit tests for the auto-triage rule (src/triage.js).
// Run with: npm run test:server

const test = require('node:test');
const assert = require('node:assert');
const { triageNewUser, CATEGORY, addDays } = require('../src/triage');

const map = { 'Administrator': 'full_onboarding', 'Standard User': 'standard' };
const lookup = name => map[name];

test('administrator profile gets full onboarding and a 60-day follow-up by default', () => {
  const r = triageNewUser({ profileName: 'Administrator', dateEntered: '2026-03-01 09:00:00', lookupCategory: lookup });
  assert.strictEqual(r.training_category, CATEGORY.FULL_ONBOARDING);
  assert.strictEqual(r.needs_full_onboarding, true);
  assert.strictEqual(r.follow_up_due_at, '2026-04-30 09:00:00');
});

test('follow-up window is configurable', () => {
  const r = triageNewUser({ profileName: 'Administrator', dateEntered: '2026-03-01 09:00:00', lookupCategory: lookup, days: 30 });
  assert.strictEqual(r.follow_up_due_at, '2026-03-31 09:00:00');
});

test('standard profile gets no follow-up timer', () => {
  const r = triageNewUser({ profileName: 'Standard User', dateEntered: '2026-03-01 09:00:00', lookupCategory: lookup });
  assert.strictEqual(r.training_category, CATEGORY.STANDARD);
  assert.strictEqual(r.follow_up_due_at, null);
});

test('unmapped profile needs review', () => {
  const r = triageNewUser({ profileName: 'Volunteer Coordinator', dateEntered: '2026-03-01 09:00:00', lookupCategory: lookup });
  assert.strictEqual(r.training_category, CATEGORY.NEEDS_REVIEW);
  assert.strictEqual(r.follow_up_due_at, null);
});

test('unmapped profile that looks administrative still gets full onboarding', () => {
  const r = triageNewUser({ profileName: 'Org Admin', dateEntered: '2026-03-01 09:00:00', lookupCategory: lookup });
  assert.strictEqual(r.training_category, CATEGORY.FULL_ONBOARDING);
  assert.ok(r.follow_up_due_at);
});

test('missing profile or date is handled', () => {
  assert.strictEqual(triageNewUser({ profileName: null, dateEntered: null, lookupCategory: lookup }).training_category, CATEGORY.NEEDS_REVIEW);
  assert.strictEqual(triageNewUser({ profileName: 'Administrator', dateEntered: null, lookupCategory: lookup }).follow_up_due_at, null);
  assert.strictEqual(addDays('not a date', 5), null);
});
