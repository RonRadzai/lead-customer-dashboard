#!/usr/bin/env node
// Rebuild the SQLite database from scratch with deterministic sample data.
//
//   npm run seed
//
// Deletes the existing database file, recreates the schema (src/database.js), and
// inserts fictional organizations, people, leads, users, meetings, notes, tickets,
// and support sessions. Dates are relative to "now" so the dashboard always looks
// current; a fixed PRNG seed keeps the output identical for a given day.

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.resolve(ROOT, process.env.DB_PATH || path.join('data', 'app.db'));
for (const suffix of ['', '-wal', '-shm']) {
  try { fs.unlinkSync(DB_PATH + suffix); } catch { /* not there */ }
}

const db = require('../src/database');
const { triageNewUser } = require('../src/triage');

// ── Deterministic PRNG (mulberry32) ─────────────────────────────────────────
let state = 20260901;
function rand() {
  state |= 0; state = (state + 0x6D2B79F5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (a, b) => a + Math.floor(rand() * (b - a + 1));

// ── Time helpers ────────────────────────────────────────────────────────────
const now = new Date();
function at(daysAgo, hour = 10, minute = 0) {
  const d = new Date(now);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}
const sql = d => d.toISOString().slice(0, 19).replace('T', ' ');
const ago = (days, h = 10, m = 0) => sql(at(days, h, m));
const monthsAgo = (months, h = 10, m = 0) => sql(at(Math.round(months * 30.4), h, m));

// ── Reference lookups ───────────────────────────────────────────────────────
const orgByAccount = Object.fromEntries(
  db.prepare('SELECT account_number, org_name, crm_org_id FROM organizations').all().map(o => [o.account_number, o])
);
const lookupCategory = name =>
  db.prepare('SELECT training_category FROM profile_training_map WHERE user_profile_name_value = ?').get(name)?.training_category;

// ── Insert helpers ──────────────────────────────────────────────────────────
const insertActivity = db.prepare(`
  INSERT INTO activity_log (record_type, record_id, action, details, performed_by, meeting_id, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);
const insertNote = db.prepare(`
  INSERT INTO notes (record_type, record_id, content, author, meeting_id, topic, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);
const insertMeeting = db.prepare(`
  INSERT INTO meetings (record_type, record_id, event_name, calendly_event_uri, zoom_meeting_id, scheduled_at, completed_at, status,
                        invitee_name, invitee_email, source_calendar, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

const log = (type, id, action, details, by, when, meetingId = null) =>
  insertActivity.run(type, id, action, details, by, meetingId, when);

function addMeeting({ type, id, name, email, event, uri = null, zoomId = null, when, status, source = null, note = null, topic = null, by = 'Team' }) {
  const completedAt = status === 'completed' ? sql(new Date(new Date(when.replace(' ', 'T') + 'Z').getTime() + 45 * 60000)) : null;
  // Pollers store scheduled_at as ISO strings; match that so sorting and MAX() stay consistent.
  const scheduledIso = new Date(when.replace(' ', 'T') + 'Z').toISOString();
  const res = insertMeeting.run(type, id, event, uri, zoomId, scheduledIso, completedAt, status, name, email, source, when, when);
  const meetingId = Number(res.lastInsertRowid);
  const label = source === 'Zoom' ? 'Zoom' : source ? 'Outlook' : 'Calendly';
  log(type, id, 'demo_scheduled', `Meeting scheduled via ${label}: ${event}`, label, when, meetingId);
  if (status === 'completed') log(type, id, 'meeting_completed', `Meeting "${event}" marked completed`, 'Team', completedAt, meetingId);
  if (note) insertNote.run(type, id, note, by, meetingId, topic, completedAt || when);
  return meetingId;
}

// ═══════════════════════════════════════════════════════════════════════════
// Team
// ═══════════════════════════════════════════════════════════════════════════
const TEAM = [
  ['Avery Chen',      'avery.chen@example.com',      'Sales'],
  ['Jordan Blake',    'jordan.blake@example.com',    'Marketing'],
  ['Priya Natarajan', 'priya.natarajan@example.com', 'Training'],
  ['Sam Okafor',      'sam.okafor@example.com',      'Sales'],
];
const insTeam = db.prepare('INSERT INTO team_members (name, email, role, active) VALUES (?, ?, ?, 1)');
TEAM.forEach(t => insTeam.run(...t));
db.prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES ('default_lead_assignee', 'Avery Chen')`).run();

// ═══════════════════════════════════════════════════════════════════════════
// Leads: every pipeline stage plus lost and a custom terminal stage
// ═══════════════════════════════════════════════════════════════════════════
const insLead = db.prepare(`
  INSERT INTO leads (first_name, last_name, email, phone, org_name, org_website, source, how_can_we_help, consent_to_contact,
                     stage, lost_reason, assigned_to, demo_scheduled_at, demo_completed_at, converted_at, zendesk_org_id, zendesk_user_id,
                     platform, campaign_name, adset_name, ad_name, form_name, is_organic,
                     last_contacted_at, contact_attempts, created_at, updated_at)
  VALUES (@first, @last, @email, @phone, @org, @site, @source, @help, 1,
          @stage, @lost_reason, @assigned, @demo_at, @demo_done, @converted_at, @zd_org, @zd_user,
          @platform, @campaign, @adset, @ad, @form, @organic,
          @last_contacted, @attempts, @created, @updated)`);

const leadDefaults = {
  phone: null, site: null, lost_reason: null, demo_at: null, demo_done: null, converted_at: null, zd_org: null, zd_user: null,
  platform: null, campaign: null, adset: null, ad: null, form: null, organic: null, last_contacted: null, attempts: 0,
};

const LEADS = [
  { first: 'Marisol', last: 'Vega', email: 'marisol.vega@example.com', phone: '555-0142', org: 'Willow Creek Historical Society', site: 'https://willowcreek.example.org',
    source: 'Website Form', help: 'We want to replace paper pledge cards for our annual gala and take donations online.', stage: 'contacted', assigned: 'Avery Chen',
    created: 8, last_contacted: 6, attempts: 1 },
  { first: 'Theo', last: 'Lindqvist', email: 'theo.lindqvist@example.com', phone: '555-0187', org: 'Pinecone Preschool Cooperative', site: 'https://pinecone.example.org',
    source: 'Referral', help: 'Tuition payments and a spring fundraiser. Currently using spreadsheets.', stage: 'demo_scheduled', assigned: 'Sam Okafor',
    created: 12, last_contacted: 9, attempts: 2 },
  { first: 'Rafael', last: 'Duarte', email: 'rafael.duarte@example.com', org: 'Riverbend Rowing Club', site: 'https://riverbend.example.org',
    source: 'Website Form', help: 'Membership dues and regatta registrations.', stage: 'new_inquiry', assigned: 'Sam Okafor', created: 1 },
  { first: 'Priyanka', last: 'Rao', email: 'priyanka.rao@example.com', phone: '555-0119', org: 'Sunfield Senior Center',
    source: 'Website Form', help: 'Looking for recurring giving options for our meal program.', stage: 'new_inquiry', assigned: 'Avery Chen', created: 0 },
  { first: 'Bea', last: 'Castellanos', email: 'bea.castellanos@example.com', org: 'Oakhaven Refugee Welcome', site: 'https://oakhaven.example.org',
    source: 'Conference', help: 'Met at the regional nonprofit summit. Interested in event ticketing.', stage: 'demo_scheduled', assigned: 'Sam Okafor',
    created: 15, last_contacted: 4, attempts: 1 },
  { first: 'Kwame', last: 'Mensah', email: 'kwame.mensah@example.com', phone: '555-0163', org: 'Brightwater Swim Foundation', site: 'https://brightwater.example.org',
    source: 'Referral', help: 'Scholarship donations and swim-a-thon pledges.', stage: 'follow_up', assigned: 'Avery Chen',
    created: 25, last_contacted: 5, attempts: 3, demo_done: 9 },
  { first: 'Elena', last: 'Petrova', email: 'elena.petrova@example.com', org: 'Maple Street Makerspace',
    source: 'Meta Ads', help: 'Class registrations and member donations.', stage: 'follow_up', assigned: 'Sam Okafor',
    created: 40, last_contacted: 12, attempts: 2, demo_done: 20,
    platform: 'fb', campaign: 'Spring Nonprofit Outreach', adset: 'Makerspaces 25-54', ad: 'Carousel v2', form: 'Learn More Form', organic: 0 },
  { first: 'Tobias', last: 'Reinholt', email: 'tobias.reinholt@example.com', phone: '555-0128', org: 'Fernridge Trail Conservancy', site: 'https://fernridge.example.org',
    source: 'Website Form', help: 'Trail adoption program with recurring gifts.', stage: 'converted', assigned: 'Avery Chen',
    created: 60, last_contacted: 18, attempts: 4, demo_done: 35, converted_at: 18, zd_org: 5001, zd_user: 70101 },
  { first: 'Amara', last: 'Osei', email: 'amara.osei@example.com', org: 'Hollowbrook Music Camp', site: 'https://hollowbrook.example.org',
    source: 'Referral', help: 'Camp tuition and an instrument fund.', stage: 'converted', assigned: 'Sam Okafor',
    created: 90, last_contacted: 50, attempts: 3, demo_done: 70, converted_at: 50, zd_org: 5002, zd_user: 70102 },
  { first: 'Lucia', last: 'Moretti', email: 'lucia.moretti@example.com', org: 'Starling Point Library Friends',
    source: 'Website Form', help: 'Book sale payments.', stage: 'lost', lost_reason: 'Chose a competitor', assigned: 'Avery Chen',
    created: 70, last_contacted: 55, attempts: 2 },
  { first: 'Declan', last: 'Murphy', email: 'declan.murphy@example.com', org: 'Granite Bay Sailing Scholars',
    source: 'Conference', help: 'Scholarship auction.', stage: 'lost', lost_reason: 'Budget constraints', assigned: 'Sam Okafor',
    created: 45, last_contacted: 30, attempts: 3 },
  { first: 'Sofia', last: 'Alvarez', email: 'sofia.alvarez@example.com', org: 'Juniper Grove Garden Collective',
    source: 'Meta Ads', help: 'Plot rentals and seed-library donations.', stage: 'new_inquiry', assigned: 'Avery Chen', created: 3,
    platform: 'ig', campaign: 'Spring Nonprofit Outreach', adset: 'Community Gardens', ad: 'Reel: Grow Together', form: 'Learn More Form', organic: 0 },
  { first: 'Nikolai', last: 'Ivanov', email: 'nikolai.ivanov@example.com', phone: '555-0177', org: 'Ashford Pet Adoption League', site: 'https://ashfordpets.example.org',
    source: 'Referral', help: 'Adoption fees and a monthly sponsor-a-pet program.', stage: 'contacted', assigned: 'Sam Okafor',
    created: 5, last_contacted: 2, attempts: 2 },
  { first: 'Hannah', last: 'Kowalczyk', email: 'hannah.kowalczyk@example.com', org: 'Silverpine Ski Patrol Fund',
    source: 'Website Form', help: 'Equipment fund drive before the season.', stage: 'demo_scheduled', assigned: 'Avery Chen',
    created: 6, last_contacted: 3, attempts: 1 },
  { first: 'Yara', last: 'Nasser', email: 'yara.nasser@example.com', org: 'Cranberry Bog Nature Center',
    source: 'Website Form', help: 'Admission tickets and memberships.', stage: 'contacted', assigned: 'Sam Okafor',
    created: 20, last_contacted: 16, attempts: 2 },
  { first: 'Peter', last: 'Okonjo', email: 'peter.okonjo@example.com', org: 'Thistledown Quilting Guild',
    source: 'Website Form', help: 'Test submission, please ignore.', stage: 'spam', assigned: 'Avery Chen', created: 4 },
  { first: 'Clara', last: 'Beaumont', email: 'clara.beaumont@example.com', org: 'Beacon Rock Search and Rescue',
    source: 'LinkedIn Ads', help: 'Annual appeal and volunteer gear sponsorships.', stage: 'new_inquiry', assigned: 'Avery Chen', created: 2,
    platform: 'li', campaign: 'Emergency Services Outreach', adset: 'SAR Volunteers', ad: 'Single Image A', form: 'Contact Us', organic: 0 },
  { first: 'Mateo', last: 'Herrera', email: 'mateo.herrera@example.com', phone: '555-0151', org: 'Dovetail Woodworkers Guild',
    source: 'Referral', help: 'Workshop fees and a tool-library fund.', stage: 'follow_up', assigned: 'Avery Chen',
    created: 30, last_contacted: 1, attempts: 3, demo_done: 14 },
];

const leadIds = {};
for (const L of LEADS) {
  const row = { ...leadDefaults, ...L };
  const created = ago(L.created, between(8, 16), between(0, 59));
  const params = {
    ...row,
    created,
    updated: L.last_contacted != null ? ago(L.last_contacted, 11) : created,
    last_contacted: L.last_contacted != null ? ago(L.last_contacted, 11, between(0, 59)) : null,
    demo_at: L.demo_done != null ? ago(L.demo_done, 15) : null,
    demo_done: L.demo_done != null ? ago(L.demo_done, 15, 45) : null,
    converted_at: L.converted_at != null ? ago(L.converted_at, 16) : null,
  };
  const id = Number(insLead.run(params).lastInsertRowid);
  leadIds[L.email] = id;

  log('lead', id, 'created', `Lead created: ${L.first} ${L.last}`, L.source === 'Website Form' ? 'Web Form' : L.assigned, created);
  if (L.stage !== 'new_inquiry' && L.stage !== 'spam') {
    log('lead', id, 'stage_changed', 'Stage changed from new_inquiry to contacted', L.assigned, ago(L.created - 1, 14));
  }
  if (L.demo_done != null) {
    addMeeting({ type: 'lead', id, name: `${L.first} ${L.last}`, email: L.email, event: 'Product Demo (30 min)',
      uri: `https://api.calendly.com/scheduled_events/seed-lead-${id}`, when: ago(L.demo_done, 15), status: 'completed',
      note: 'Walked through donation forms and reporting. Main question was recurring gifts and receipt customization.', topic: 'Demo', by: L.assigned });
    log('lead', id, 'stage_changed', 'Stage changed from demo_scheduled to follow_up', L.assigned, ago(L.demo_done, 16));
  }
  if (L.stage === 'converted') {
    log('lead', id, 'converted', 'Lead marked as converted (helpdesk synced)', L.assigned, params.converted_at);
  }
  if (L.stage === 'lost') {
    log('lead', id, 'lost', `Lead marked as lost. Reason: ${L.lost_reason}`, L.assigned, ago(L.last_contacted, 12));
  }
  if (L.stage === 'spam') {
    log('lead', id, 'stage_changed', 'Stage changed from new_inquiry to spam', 'Jordan Blake', ago(L.created - 1, 9));
  }
  if (L.attempts > 0) {
    for (let i = 1; i <= L.attempts; i++) {
      log('lead', id, 'attempt_logged', `Contact attempt #${i} logged`, L.assigned, ago(Math.max((L.last_contacted ?? 1) + (L.attempts - i) * 3, 0), 11, 15));
    }
  }
}

// Lead-specific history
insertNote.run('lead', leadIds['marisol.vega@example.com'], 'Spoke briefly by phone. Board meets next Tuesday; wants a demo before then.', 'Avery Chen', null, 'General', ago(6, 15, 20));
insertNote.run('lead', leadIds['kwame.mensah@example.com'], 'Sent pricing summary and the recurring-giving one-pager. Follow up after their board vote.', 'Avery Chen', null, 'Check-in', ago(5, 16, 5));
insertNote.run('lead', leadIds['mateo.herrera@example.com'], 'Ready to sign once the treasurer reviews the fee schedule.', 'Avery Chen', null, 'Check-in', ago(1, 13, 40));
log('lead', leadIds['kwame.mensah@example.com'], 'note_added', 'Note added by Avery Chen', 'Avery Chen', ago(5, 16, 5));
log('lead', leadIds['mateo.herrera@example.com'], 'note_added', 'Note added by Avery Chen', 'Avery Chen', ago(1, 13, 40));

// Manually scheduled demo (no external calendar) so the week strip has a non-synced meeting
addMeeting({ type: 'lead', id: leadIds['hannah.kowalczyk@example.com'], name: 'Hannah Kowalczyk', email: 'hannah.kowalczyk@example.com',
  event: 'Product Demo (30 min)', when: sql(at(-3, 17, 0)), status: 'scheduled' });
db.prepare('UPDATE leads SET demo_scheduled_at = ? WHERE id = ?').run(sql(at(-3, 17, 0)), leadIds['hannah.kowalczyk@example.com']);

// A scheduled Calendly demo that the mock Calendly feed reports as canceled on the first poll
addMeeting({ type: 'lead', id: leadIds['bea.castellanos@example.com'], name: 'Bea Castellanos', email: 'bea.castellanos@example.com',
  event: 'Product Demo (30 min)', uri: 'https://api.calendly.com/scheduled_events/mock-cal-1006', when: sql(at(-2, 16, 0)), status: 'scheduled' });
db.prepare(`UPDATE leads SET calendly_event_uri = 'https://api.calendly.com/scheduled_events/mock-cal-1006', demo_scheduled_at = ? WHERE id = ?`)
  .run(sql(at(-2, 16, 0)), leadIds['bea.castellanos@example.com']);

// ═══════════════════════════════════════════════════════════════════════════
// Users on existing customer accounts (new + established)
// ═══════════════════════════════════════════════════════════════════════════
const insUser = db.prepare(`
  INSERT INTO new_users (organization_id, org_name, org_url, first_name, last_name, email, user_profile_name, user_profile_id,
                         date_entered, last_login, training_category, follow_up_due_at, contact_status, crm_org_id,
                         last_contacted_at, contact_attempts, assigned_to, created_at, updated_at)
  VALUES (@account, @org, @url, @first, @last, @email, @profile, @profile_id,
          @entered, @last_login, @category, @follow_up, @status, @crm,
          @last_contacted, @attempts, @assigned, @entered, @entered)`);

const PROFILE_IDS = { 'Administrator': 'P-ADMIN', 'Standard User': 'P-STD', 'Read Only': 'P-RO', 'Volunteer Coordinator': 'P-VOL', 'Billing Contact': 'P-BILL' };

function addUser({ first, last, email, account, profile, entered, status = 'not_contacted', established = false, attempts = 0, lastContacted = null, assigned = 'Priya Natarajan' }) {
  const org = orgByAccount[account];
  const triage = triageNewUser({ profileName: profile, dateEntered: entered, lookupCategory });
  const res = insUser.run({
    account, org: org.org_name, url: `https://${org.org_name.toLowerCase().replace(/[^a-z]+/g, '')}.example.org`,
    first, last, email, profile, profile_id: PROFILE_IDS[profile] || null,
    entered, last_login: rand() > 0.35 ? entered : null,
    category: triage.training_category,
    // Established users finished onboarding long ago; only current new users carry a live deadline.
    follow_up: established ? null : triage.follow_up_due_at,
    status, crm: org.crm_org_id, last_contacted: lastContacted, attempts, assigned,
  });
  const id = Number(res.lastInsertRowid);
  log('new_user', id, 'created', `Imported from daily CSV (${profile})`, 'CSV Import', entered);
  if (triage.needs_full_onboarding && !established) {
    log('new_user', id, 'category_changed', `Auto-triage: administrator profile flagged for full onboarding, follow-up due ${triage.follow_up_due_at.slice(0, 10)}`, 'Auto-triage', entered);
  }
  return id;
}

const userIds = {};
const NEW_USERS = [
  { first: 'Dana',    last: 'Whitfield',  email: 'dana.whitfield@example.com',   account: '100234', profile: 'Administrator',          entered: ago(0, 9, 5) },
  { first: 'Luis',    last: 'Aranda',     email: 'luis.aranda@example.com',      account: '100311', profile: 'Standard User',          entered: ago(1, 8, 42), status: 'contacted', lastContacted: ago(0, 10, 12), attempts: 1 },
  { first: 'Omar',    last: 'Haddad',     email: 'omar.haddad@example.com',      account: '100519', profile: 'Administrator',          entered: ago(1, 14, 18) },
  { first: 'Chloe',   last: 'Bennett',    email: 'chloe.bennett@example.com',    account: '100472', profile: 'Read Only',              entered: ago(2, 11, 30), status: 'contacted', lastContacted: ago(1, 9, 0), attempts: 1 },
  { first: 'Ravi',    last: 'Subramanian', email: 'ravi.subramanian@example.com', account: '100633', profile: 'Administrator',         entered: ago(3, 16, 7), status: 'contacted', lastContacted: ago(2, 10, 30), attempts: 1 },
  { first: 'Mei',     last: 'Tanaka',     email: 'mei.tanaka@example.com',       account: '100701', profile: 'Volunteer Coordinator',  entered: ago(3, 9, 55) },
  { first: 'Jonas',   last: 'Weber',      email: 'jonas.weber@example.com',      account: '100845', profile: 'Standard User',          entered: ago(5, 13, 12), status: 'demo_completed', lastContacted: ago(2, 15, 0), attempts: 1 },
  { first: 'Fatima',  last: 'Zahra',      email: 'fatima.zahra@example.com',     account: '100788', profile: 'Administrator',          entered: ago(9, 10, 26), status: 'demo_completed', lastContacted: ago(4, 14, 0), attempts: 2 },
  { first: 'Aiden',   last: 'Gallagher',  email: 'aiden.gallagher@example.com',  account: '100902', profile: 'Standard User',          entered: ago(12, 15, 44) },
  { first: 'Zoe',     last: 'Martin',     email: 'zoe.martin@example.com',       account: '100977', profile: 'Billing Contact',        entered: ago(14, 8, 15) },
  { first: 'Samuel',  last: 'Adeyemi',    email: 'samuel.adeyemi@example.com',   account: '101040', profile: 'Administrator',          entered: ago(21, 12, 3), status: 'contacted', lastContacted: ago(18, 11, 0), attempts: 2 },
  { first: 'Isabela', last: 'Costa',      email: 'isabela.costa@example.com',    account: '101126', profile: 'Standard User',          entered: ago(27, 9, 48), status: 'no_action_needed' },
  // Administrator added 70 days ago whose 60-day follow-up is now overdue
  { first: 'Marcus',  last: 'Hill',       email: 'marcus.hill@example.com',      account: '100472', profile: 'Administrator',          entered: ago(70, 10, 10), status: 'contacted', lastContacted: ago(64, 10, 0), attempts: 1 },
];
NEW_USERS.forEach(u => { userIds[u.email] = addUser(u); });

const ESTABLISHED = [
  { first: 'Grace',  last: 'Oyelaran', email: 'grace.oyelaran@example.com', account: '100311', profile: 'Administrator', months: 14 },
  { first: 'Hank',   last: 'Morrow',   email: 'hank.morrow@example.com',    account: '100472', profile: 'Administrator', months: 20 },
  { first: 'Ingrid', last: 'Solberg',  email: 'ingrid.solberg@example.com', account: '100633', profile: 'Standard User', months: 9 },
  { first: 'Wren',   last: 'Takahashi', email: 'wren.takahashi@example.com', account: '100788', profile: 'Administrator', months: 26 },
  { first: 'Wren',   last: 'Takahashi', email: 'wren.takahashi@example.com', account: '100472', profile: 'Standard User', months: 11 }, // multi-org
  { first: 'Yusuf',  last: 'Demir',    email: 'yusuf.demir@example.com',    account: '100845', profile: 'Administrator', months: 16 },
  { first: 'Nadia',  last: 'Petrov',   email: 'nadia.petrov@example.com',   account: '100234', profile: 'Standard User', months: 10 },
  { first: 'Oliver', last: 'Grant',    email: 'oliver.grant@example.com',   account: '100519', profile: 'Read Only',     months: 22 },
  { first: 'Leila',  last: 'Farouk',   email: 'leila.farouk@example.com',   account: '100902', profile: 'Administrator', months: 13 },
  { first: 'Bram',   last: 'De Vries', email: 'bram.devries@example.com',   account: '100977', profile: 'Standard User', months: 30 },
  { first: 'Sunita', last: 'Mehra',    email: 'sunita.mehra@example.com',   account: '101040', profile: 'Administrator', months: 8 },
  { first: 'Carlos', last: 'Mendes',   email: 'carlos.mendes@example.com',  account: '101126', profile: 'Standard User', months: 18 },
  { first: 'Emily',  last: 'Watson',   email: 'emily.watson@example.com',   account: '100701', profile: 'Administrator', months: 25 },
  { first: 'Kenji',  last: 'Sato',     email: 'kenji.sato@example.com',     account: '100633', profile: 'Read Only',     months: 12 },
  { first: 'Aisha',  last: 'Bello',    email: 'aisha.bello@example.com',    account: '100845', profile: 'Standard User', months: 15 },
  { first: 'Viktor', last: 'Novak',    email: 'viktor.novak@example.com',   account: '100234', profile: 'Administrator', months: 28 },
];
for (const u of ESTABLISHED) {
  const id = addUser({ ...u, entered: monthsAgo(u.months, between(8, 16), between(0, 59)), status: 'demo_completed', established: true, attempts: between(1, 3) });
  if (!userIds[u.email]) userIds[u.email] = id;
}

// ── User history: completed trainings, notes, status changes ────────────────
const uid = email => userIds[email];

addMeeting({ type: 'new_user', id: uid('jonas.weber@example.com'), name: 'Jonas Weber', email: 'jonas.weber@example.com', event: 'New User Training',
  uri: 'https://api.calendly.com/scheduled_events/seed-user-jonas', when: ago(2, 15), status: 'completed',
  note: 'Covered the basics: logging in, running the donor report, exporting to spreadsheet.', topic: 'Training Session', by: 'Priya Natarajan' });
addMeeting({ type: 'new_user', id: uid('fatima.zahra@example.com'), name: 'Fatima Zahra', email: 'fatima.zahra@example.com', event: 'Administrator Onboarding Session',
  zoomId: '88010000001', uri: 'zoom:88010000001', source: 'Zoom', when: ago(4, 14), status: 'completed',
  note: 'Full admin onboarding done. Set up two additional users and the receipt template. Schedule 60-day check-in.', topic: 'Onboarding', by: 'Priya Natarajan' });
addMeeting({ type: 'new_user', id: uid('grace.oyelaran@example.com'), name: 'Grace Oyelaran', email: 'grace.oyelaran@example.com', event: 'Account Check-in',
  uri: 'https://api.calendly.com/scheduled_events/seed-user-grace', when: ago(6, 13, 30), status: 'completed',
  note: 'Reviewed year-to-date giving. Wants help with the tribute-gift option.', topic: 'Check-in', by: 'Avery Chen' });
addMeeting({ type: 'new_user', id: uid('leila.farouk@example.com'), name: 'Leila Farouk', email: 'leila.farouk@example.com', event: 'Reporting Walkthrough',
  uri: 'outlook:seed-leila-1', source: 'Avery Chen', when: ago(3, 17), status: 'completed',
  note: 'Showed the custom report builder. Follow up with the saved-report template.', topic: 'Training Session', by: 'Avery Chen' });
addMeeting({ type: 'new_user', id: uid('marcus.hill@example.com'), name: 'Marcus Hill', email: 'marcus.hill@example.com', event: 'Administrator Onboarding Session',
  uri: 'https://api.calendly.com/scheduled_events/seed-user-marcus', when: ago(64, 10), status: 'completed',
  note: 'Onboarding complete. Left a 60-day follow-up on the calendar.', topic: 'Onboarding', by: 'Priya Natarajan' });

const noteAt = (email, content, author, topic, when) => {
  insertNote.run('new_user', uid(email), content, author, null, topic, when);
  log('new_user', uid(email), 'note_added', `Note added by ${author}`, author, when);
};
noteAt('grace.oyelaran@example.com', 'Board approved the peer-to-peer campaign. She will need the campaign pages walkthrough next month.', 'Avery Chen', 'General', ago(3, 11, 20));
noteAt('nadia.petrov@example.com', 'Asked about text-to-give for the harvest dinner. Sent the setup guide.', 'Jordan Blake', 'General', ago(1, 16, 45));
noteAt('emily.watson@example.com', 'Renewed for another year. Interested in the volunteer scheduling add-on.', 'Sam Okafor', 'Check-in', ago(5, 10, 5));
noteAt('luis.aranda@example.com', 'Welcome email sent; training booked for tomorrow.', 'Priya Natarajan', 'Onboarding', ago(0, 10, 12));
noteAt('ravi.subramanian@example.com', 'Left a voicemail about the administrator onboarding session.', 'Priya Natarajan', 'Onboarding', ago(2, 10, 30));

for (const email of ['luis.aranda@example.com', 'chloe.bennett@example.com', 'ravi.subramanian@example.com', 'samuel.adeyemi@example.com', 'marcus.hill@example.com']) {
  const u = db.prepare('SELECT last_contacted_at FROM new_users WHERE id = ?').get(uid(email));
  log('new_user', uid(email), 'status_changed', 'Contact status changed from not_contacted to contacted', 'Priya Natarajan', u.last_contacted_at);
}
log('new_user', uid('isabela.costa@example.com'), 'status_changed', 'Contact status changed from not_contacted to no_action_needed', 'Priya Natarajan', ago(26, 9, 30));

// ═══════════════════════════════════════════════════════════════════════════
// Older helpdesk tickets and support sessions (recent ones arrive through the mock pollers)
// ═══════════════════════════════════════════════════════════════════════════
const insTicket = db.prepare(`
  INSERT INTO zendesk_tickets (zendesk_ticket_id, requester_email, subject, status, created_at, updated_at, last_synced_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)`);
[
  [40901, 'grace.oyelaran@example.com', 'Import donor list from previous system', 'closed', 120, 110],
  [40902, 'leila.farouk@example.com',   'Question about custom report filters',   'closed', 95, 93],
  [40903, 'viktor.novak@example.com',   'Add a new user to our account',          'closed', 150, 149],
  [40904, 'emily.watson@example.com',   'Receipt footer text update',             'solved', 40, 37],
].forEach(([id, email, subject, status, c, u]) => insTicket.run(id, email, subject, status, ago(c, 14), ago(u, 15), ago(u, 15)));

const insSession = db.prepare(`
  INSERT INTO support_sessions (session_id, customer_email, customer_name, org_name, date_created, last_synced_at)
  VALUES (?, ?, ?, ?, ?, ?)`);
[
  [2001, 'grace.oyelaran@example.com', 'Grace Oyelaran', 'Cedar Hollow Animal Rescue', 118],
  [2002, 'emily.watson@example.com',   'Emily Watson',   'Ridgeview Volunteer Fire Auxiliary', 41],
  [2003, 'carlos.mendes@example.com',  'Carlos Mendes',  'Stonebridge Scholars Fund', 77],
].forEach(([id, email, name, org, d]) => insSession.run(id, email, name, org, ago(d, 15), ago(d, 15)));

// ═══════════════════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════════════════
const count = t => db.prepare(`SELECT COUNT(*) as n FROM ${t}`).get().n;
console.log(`Seeded ${path.relative(ROOT, DB_PATH)}`);
console.log(`  organizations:     ${count('organizations')}`);
console.log(`  team members:      ${count('team_members')}`);
console.log(`  leads:             ${count('leads')}`);
console.log(`  users (new + est): ${count('new_users')}`);
console.log(`  meetings:          ${count('meetings')}`);
console.log(`  notes:             ${count('notes')}`);
console.log(`  activity entries:  ${count('activity_log')}`);
console.log(`  helpdesk tickets:  ${count('zendesk_tickets')}`);
console.log(`  support sessions:  ${count('support_sessions')}`);
console.log('Start the app with `npm run dev`. Background pollers add upcoming meetings and recent tickets from the mock adapters.');
db.close();
