// SQLite schema, indexes, and reference-data seeding.
// The database file is created on first require. `npm run seed` rebuilds it with sample data.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { parseCsvLine } = require('./csv');

const ROOT = path.join(__dirname, '..');
const DB_PATH = path.resolve(ROOT, process.env.DB_PATH || path.join('data', 'app.db'));

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  -- Prospects moving through the sales pipeline.
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL,
    confirm_email TEXT,
    phone TEXT,
    phone_extension TEXT,
    org_name TEXT NOT NULL,
    org_website TEXT,
    source TEXT,
    how_can_we_help TEXT,
    consent_to_contact INTEGER DEFAULT 0,
    stage TEXT DEFAULT 'new_inquiry',
    lost_reason TEXT,
    assigned_to TEXT,
    calendly_event_uri TEXT,
    zoom_meeting_id TEXT,
    demo_scheduled_at DATETIME,
    demo_completed_at DATETIME,
    onboard_scheduled_at DATETIME,
    onboard_completed_at DATETIME,
    converted_at DATETIME,
    zendesk_user_id INTEGER,
    zendesk_org_id INTEGER,
    -- Ad-platform metadata captured from CSV imports
    external_lead_id TEXT,
    external_created_at DATETIME,
    platform TEXT,
    campaign_id TEXT,
    campaign_name TEXT,
    adset_id TEXT,
    adset_name TEXT,
    ad_id TEXT,
    ad_name TEXT,
    form_id TEXT,
    form_name TEXT,
    is_organic INTEGER,
    inbox_url TEXT,
    last_contacted_at DATETIME,
    contact_attempts INTEGER DEFAULT 0,
    deleted_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  -- Users added to existing customer accounts (from the daily CSV import).
  -- "New" vs "established" is decided by date_entered at query time, not stored.
  CREATE TABLE IF NOT EXISTS new_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    organization_id TEXT NOT NULL,
    org_name TEXT NOT NULL,
    org_url TEXT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT NOT NULL,
    user_profile_name TEXT,
    user_profile_id TEXT,
    date_entered DATETIME NOT NULL,
    last_login DATETIME,
    last_transaction_date DATETIME,
    training_category TEXT DEFAULT 'needs_review',
    follow_up_due_at DATETIME,
    contact_status TEXT DEFAULT 'not_contacted',
    demo_scheduled_at DATETIME,
    demo_completed_at DATETIME,
    calendly_event_uri TEXT,
    zoom_meeting_id TEXT,
    assigned_to TEXT,
    notified_at DATETIME,
    crm_org_id TEXT,
    last_contacted_at DATETIME,
    contact_attempts INTEGER DEFAULT 0,
    deleted_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_type TEXT NOT NULL,
    record_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    author TEXT NOT NULL,
    meeting_id INTEGER,
    topic TEXT,
    deleted_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_type TEXT NOT NULL,
    record_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    details TEXT,
    performed_by TEXT,
    meeting_id INTEGER DEFAULT NULL,
    deleted_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS team_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    role TEXT,
    active INTEGER DEFAULT 1
  );

  -- Auto-triage rules: user profile name -> training category (see src/triage.js).
  CREATE TABLE IF NOT EXISTS profile_training_map (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_profile_name_value TEXT NOT NULL UNIQUE,
    training_category TEXT NOT NULL
  );

  -- One row per background poller: last run time and an opaque cursor.
  CREATE TABLE IF NOT EXISTS poll_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service TEXT NOT NULL UNIQUE,
    last_polled_at DATETIME,
    last_cursor TEXT
  );

  -- Local cache of helpdesk tickets, matched to contacts by requester email.
  CREATE TABLE IF NOT EXISTS zendesk_tickets (
    zendesk_ticket_id INTEGER PRIMARY KEY,
    requester_email TEXT,
    subject TEXT,
    status TEXT,
    created_at TEXT,
    updated_at TEXT,
    last_synced_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_zendesk_tickets_email ON zendesk_tickets(lower(requester_email));
  CREATE INDEX IF NOT EXISTS idx_zendesk_tickets_updated ON zendesk_tickets(updated_at);

  -- Local cache of support sessions from the sibling support-notes app.
  CREATE TABLE IF NOT EXISTS support_sessions (
    session_id INTEGER PRIMARY KEY,
    customer_email TEXT,
    customer_name TEXT,
    org_name TEXT,
    date_created TEXT,
    last_synced_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_support_sessions_email ON support_sessions(lower(customer_email));
  CREATE INDEX IF NOT EXISTS idx_support_sessions_date ON support_sessions(date_created);

  -- Meetings from every calendar source. calendly_event_uri doubles as the
  -- external key for Zoom ("zoom:<id>") and Outlook ("outlook:<id>") events.
  CREATE TABLE IF NOT EXISTS meetings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    record_type TEXT NOT NULL,
    record_id INTEGER NOT NULL,
    event_name TEXT,
    calendly_event_uri TEXT,
    zoom_meeting_id TEXT,
    scheduled_at DATETIME,
    completed_at DATETIME,
    status TEXT DEFAULT 'scheduled',
    invitee_name TEXT,
    invitee_email TEXT,
    source_calendar TEXT,
    deleted_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(calendly_event_uri, record_type, record_id)
  );

  -- Customer accounts, used to enrich imported users with a canonical name and CRM id.
  CREATE TABLE IF NOT EXISTS organizations (
    account_number TEXT PRIMARY KEY,
    org_name TEXT NOT NULL,
    crm_org_id TEXT
  );

  -- Team-defined terminal stages (e.g. Test, Spam) in addition to the fixed pipeline.
  CREATE TABLE IF NOT EXISTS custom_lead_stages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    value TEXT NOT NULL UNIQUE,
    label TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS note_topics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL,
    sort_order INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_new_users_email      ON new_users(lower(email));
  CREATE INDEX IF NOT EXISTS idx_new_users_deleted    ON new_users(deleted_at);
  CREATE INDEX IF NOT EXISTS idx_leads_stage_deleted  ON leads(stage, deleted_at);
  CREATE INDEX IF NOT EXISTS idx_activity_log_record  ON activity_log(record_type, record_id);
  CREATE INDEX IF NOT EXISTS idx_notes_record         ON notes(record_type, record_id);
`);

// ─── Reference data (idempotent) ─────────────────────────────────────────────

const seedIfEmpty = (table, fn) => {
  const { count } = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get();
  if (count === 0) fn();
};

seedIfEmpty('custom_lead_stages', () => {
  const ins = db.prepare('INSERT OR IGNORE INTO custom_lead_stages (value, label, sort_order) VALUES (?, ?, ?)');
  ins.run('test', 'Test', 0);
  ins.run('spam', 'Spam', 1);
});

// Default triage rules. Administrator-type profiles get full onboarding plus the follow-up timer.
seedIfEmpty('profile_training_map', () => {
  const ins = db.prepare('INSERT OR IGNORE INTO profile_training_map (user_profile_name_value, training_category) VALUES (?, ?)');
  ins.run('Administrator', 'full_onboarding');
  ins.run('Standard User', 'standard');
  ins.run('Read Only', 'standard');
});

seedIfEmpty('note_topics', () => {
  const ins = db.prepare('INSERT OR IGNORE INTO note_topics (name, sort_order) VALUES (?, ?)');
  ['Demo', 'Training Session', 'Check-in', 'Onboarding', 'Technical Issue', 'General'].forEach((name, i) => ins.run(name, i));
});

db.prepare(`INSERT OR IGNORE INTO app_config (key, value) VALUES ('default_lead_assignee', '')`).run();

// Organizations lookup table from the sample CSV (account_number, org_name, crm_org_id).
seedIfEmpty('organizations', () => {
  const orgsPath = path.join(ROOT, 'data', 'sample', 'organizations.csv');
  if (!fs.existsSync(orgsPath)) return;
  const lines = fs.readFileSync(orgsPath, 'utf8').split(/\r?\n/);
  const insertOrg = db.prepare('INSERT OR IGNORE INTO organizations (account_number, org_name, crm_org_id) VALUES (?, ?, ?)');
  const seedOrgs = db.transaction(() => {
    let inserted = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const [accountNumber, orgName, crmOrgId] = parseCsvLine(line);
      if (!accountNumber) continue;
      insertOrg.run(accountNumber, orgName, crmOrgId || null);
      inserted++;
    }
    return inserted;
  });
  console.log(`[db] Seeded ${seedOrgs()} organizations from data/sample/organizations.csv`);
});

module.exports = db;
