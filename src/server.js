require('dotenv').config({ quiet: true });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const cron = require('node-cron');
const db = require('./database');
// External systems go through the adapter layer; MOCK_INTEGRATIONS picks real or mock (see src/integrations).
const integrations = require('./integrations');
const { calendly, zoom, zendesk, graph, supportSessions } = integrations;
const { parseCsvLine, detectDelimiter, parseCsvDate } = require('./csv');
const { triageNewUser } = require('./triage');

const app = express();
const PORT = process.env.PORT || 3002;

// Middleware
app.use(helmet({
  hsts: false,
  contentSecurityPolicy: false,
}));
app.use(cors());
app.use(express.json());

// Rate limiter for public web-to-lead endpoint
const webToLeadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  message: { error: 'Too many requests, please try again later.' }
});

// ─── Shared SQL fragments ────────────────────────────────────────────────────
// New User = date_entered within the last NEW_USER_WINDOW_MONTHS (default 6); everything else is Established.
const NEW_USER_WINDOW_MONTHS = Math.max(1, parseInt(process.env.NEW_USER_WINDOW_MONTHS, 10) || 6);
const newUserWindow = (col = 'date_entered') =>
  `${col} > datetime('now', '-${NEW_USER_WINDOW_MONTHS} months')`;
const establishedWindow = (col = 'date_entered') =>
  `${col} <= datetime('now', '-${NEW_USER_WINDOW_MONTHS} months')`;

// Short, human-readable meeting time for activity-log entries.
const fmtMeetingDate = iso =>
  new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

// External timestamps arrive as ISO strings; store them the way SQLite's datetime() emits them
// so string comparisons against datetime('now', ...) behave.
const toSqliteDateTime = v => {
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString().slice(0, 19).replace('T', ' ');
};

// 0/1 flag: is this row's linked new_user record Established? (leads/unmatched → 0)
const isEstablishedCase = (r) => `
        CASE
          WHEN ${r}.record_type = 'new_user' THEN (
            SELECT CASE WHEN ${newUserWindow()} THEN 0 ELSE 1 END
            FROM new_users WHERE id = ${r}.record_id
          )
          ELSE 0
        END`;

// Display name for a row linked to a lead or new_user.
const recordNameCase = (r) => `
        CASE WHEN ${r}.record_type = 'lead'     THEN (SELECT first_name || ' ' || last_name FROM leads     WHERE id = ${r}.record_id)
             WHEN ${r}.record_type = 'new_user' THEN (SELECT first_name || ' ' || last_name FROM new_users WHERE id = ${r}.record_id)
             ELSE NULL END`;

// Same, but meetings can also be 'unmatched' — fall back to the invitee name.
const contactNameCase = (r) => `
        CASE
          WHEN ${r}.record_type = 'lead'      THEN (SELECT first_name || ' ' || last_name FROM leads     WHERE id = ${r}.record_id)
          WHEN ${r}.record_type = 'new_user'  THEN (SELECT first_name || ' ' || last_name FROM new_users WHERE id = ${r}.record_id)
          WHEN ${r}.record_type = 'unmatched' THEN ${r}.invitee_name
        END`;

// Latest touch on a new_users row (aliased nu) across activity log, notes, meetings,
// helpdesk tickets, and support sessions.
const LAST_ACTIVITY_SQL = `
        (SELECT MAX(dt) FROM (
          SELECT MAX(al.created_at) as dt FROM activity_log al
          WHERE al.record_type = 'new_user' AND al.record_id = nu.id AND al.deleted_at IS NULL
            AND al.action NOT IN ('demo_scheduled','meeting_completed','meeting_canceled','note_added')
          UNION ALL
          SELECT MAX(n.created_at) FROM notes n
          WHERE n.record_type = 'new_user' AND n.record_id = nu.id AND n.deleted_at IS NULL
          UNION ALL
          SELECT MAX(m.scheduled_at) FROM meetings m
          WHERE m.record_type = 'new_user' AND m.record_id = nu.id AND m.deleted_at IS NULL
          UNION ALL
          SELECT MAX(zt.updated_at) FROM zendesk_tickets zt
          WHERE lower(zt.requester_email) = lower(nu.email)
          UNION ALL
          SELECT MAX(ls.date_created) FROM support_sessions ls
          WHERE lower(ls.customer_email) = lower(nu.email)
        )) as last_activity_at`;

// Any of those five sources touched within datetime('now', ?) — takes 5 copies of the
// same '-N days' parameter.
const RECENT_ACTIVITY_EXISTS_SQL = `
        (
          EXISTS (SELECT 1 FROM activity_log al
                  WHERE al.record_type = 'new_user' AND al.record_id = nu.id
                  AND al.deleted_at IS NULL AND al.created_at >= datetime('now', ?)
                  AND al.action NOT IN ('demo_scheduled','meeting_completed','meeting_canceled','note_added'))
          OR EXISTS (SELECT 1 FROM notes n
                     WHERE n.record_type = 'new_user' AND n.record_id = nu.id
                     AND n.deleted_at IS NULL AND n.created_at >= datetime('now', ?))
          OR EXISTS (SELECT 1 FROM meetings m
                     WHERE m.record_type = 'new_user' AND m.record_id = nu.id
                     AND m.deleted_at IS NULL AND m.scheduled_at >= datetime('now', ?))
          OR EXISTS (SELECT 1 FROM zendesk_tickets zt
                     WHERE lower(zt.requester_email) = lower(nu.email)
                     AND zt.updated_at >= datetime('now', ?))
          OR EXISTS (SELECT 1 FROM support_sessions ls
                     WHERE lower(ls.customer_email) = lower(nu.email)
                     AND ls.date_created >= datetime('now', ?))
        )`;

// A lead with no contact/response in STALE_LEAD_DAYS (default 10) no longer counts as active,
// regardless of stage — last_contacted_at if it's ever been set, else created_at (see
// /api/dashboard/stats and GET /api/leads).
const STALE_LEAD_DAYS = Math.max(1, parseInt(process.env.STALE_LEAD_DAYS, 10) || 10);
const STALE_LEAD_SQL = `
        COALESCE(last_contacted_at, created_at) < datetime('now', '-${STALE_LEAD_DAYS} days')`;

// 0/1 flag: does this lead count toward the Dashboard's Active Leads number?
const IS_ACTIVE_LEAD_SQL = `
        CASE WHEN stage NOT IN ('converted', 'lost')
              AND stage NOT IN (SELECT value FROM custom_lead_stages)
              AND NOT (${STALE_LEAD_SQL})
             THEN 1 ELSE 0 END`;

// ─── Small shared helpers ────────────────────────────────────────────────────
// Append the standard name/email/org LIKE filter. Pass the search term exactly as
// it should be matched (callers decide whether to trim).
function pushSearchFilter(where, params, search, prefix = '') {
  where.push(`(${prefix}first_name LIKE ? OR ${prefix}last_name LIKE ? OR ${prefix}email LIKE ? OR ${prefix}org_name LIKE ?)`);
  const s = `%${search}%`;
  params.push(s, s, s, s);
}

const getDefaultAssignee = () =>
  db.prepare(`SELECT value FROM app_config WHERE key = 'default_lead_assignee'`).get()?.value || null;

// Email lookup for the contact behind a lead/new_user record (used by the
// email-history and support-history endpoints).
function getContactRecord(record_type, record_id) {
  if (record_type === 'lead') {
    return db.prepare('SELECT email FROM leads WHERE id = ? AND deleted_at IS NULL').get(record_id);
  }
  if (record_type === 'new_user') {
    return db.prepare('SELECT email FROM new_users WHERE id = ? AND deleted_at IS NULL').get(record_id);
  }
  return undefined;
}

// ─── Helper: Import new users from parsed CSV text ───────────────────────────
function importNewUsersFromCsv(csvText) {
  const lines = csvText.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) return { imported: 0, skipped: 0, errors: [] };

  const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase().replace(/\s+/g, '_'));

  // Expected columns (case-insensitive, underscore-normalized)
  const col = name => headers.indexOf(name);
  const idxOrganizationId   = col('organizationid');
  const idxOrganization     = col('organization');
  const idxDateEntered      = col('dateentered');
  const idxUrl              = col('url');
  const idxFirstName        = col('firstname');
  const idxLastName         = col('lastname');
  const idxPrimaryEmail     = col('primaryemail');
  const idxUserProfileName  = col('userprofilename');
  const idxLastLogin        = col('last_login');
  const idxLastTransaction  = col('last_transaction_date');
  const idxUserProfileId    = col('userprofileid');

  const insertUser = db.prepare(`
    INSERT INTO new_users (
      organization_id, org_name, org_url,
      first_name, last_name, email,
      user_profile_name, user_profile_id,
      date_entered, last_login, last_transaction_date,
      training_category, follow_up_due_at, crm_org_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getOrg = db.prepare(
    'SELECT org_name, crm_org_id FROM organizations WHERE account_number = ?'
  );
  const getCategoryMap = db.prepare(
    'SELECT training_category FROM profile_training_map WHERE user_profile_name_value = ?'
  );
  const checkExists = db.prepare(
    'SELECT id FROM new_users WHERE email = ? AND organization_id = ?'
  );

  let imported = 0;
  let skipped = 0;
  const errors = [];

  const doImport = db.transaction(() => {
    for (let i = 1; i < lines.length; i++) {
      const fields = parseCsvLine(lines[i]);
      try {
        const organizationId = idxOrganizationId >= 0 ? fields[idxOrganizationId] : null;
        const email = idxPrimaryEmail >= 0 ? fields[idxPrimaryEmail] : null;

        if (!organizationId || !email) { skipped++; continue; }

        // Dedup: skip if email+org combo already exists
        if (checkExists.get(email, organizationId)) { skipped++; continue; }

        // Org lookup for canonical name and CRM id
        const orgRow = getOrg.get(organizationId);
        const orgName = orgRow ? orgRow.org_name : (idxOrganization >= 0 ? fields[idxOrganization] : '');
        const crmOrgId = orgRow ? (orgRow.crm_org_id || null) : null;

        const profileName = idxUserProfileName >= 0 ? fields[idxUserProfileName] : null;
        const dateEnteredIso = idxDateEntered >= 0 ? parseCsvDate(fields[idxDateEntered]) : null;

        // Auto-triage: category from the profile map; administrator-type profiles also get a follow-up deadline.
        const triage = triageNewUser({
          profileName,
          dateEntered: dateEnteredIso,
          lookupCategory: name => getCategoryMap.get(name)?.training_category,
        });

        insertUser.run(
          organizationId,
          orgName || '',
          idxUrl >= 0 ? (fields[idxUrl] || null) : null,
          idxFirstName >= 0 ? fields[idxFirstName] : '',
          idxLastName >= 0 ? fields[idxLastName] : '',
          email,
          profileName || null,
          idxUserProfileId >= 0 ? (fields[idxUserProfileId] || null) : null,
          dateEnteredIso,
          idxLastLogin >= 0 ? parseCsvDate(fields[idxLastLogin]) : null,
          idxLastTransaction >= 0 ? parseCsvDate(fields[idxLastTransaction]) : null,
          triage.training_category,
          triage.follow_up_due_at,
          crmOrgId
        );
        imported++;
      } catch (err) {
        errors.push(`Row ${i + 1}: ${err.message}`);
      }
    }
  });

  doImport();
  return { imported, skipped, errors };
}

// ─── Helper: Lead CSV column aliases (case-insensitive, underscored) ────────
const LEAD_COLUMN_ALIASES = {
  email:      ['email', 'email_address', 'e_mail', 'primary_email'],
  first_name: ['first_name', 'firstname', 'first', 'given_name'],
  last_name:  ['last_name', 'lastname', 'last', 'surname', 'family_name'],
  full_name:  ['full_name', 'fullname', 'name'],
  phone:      ['phone', 'phone_number', 'phone_num', 'mobile', 'telephone'],
  org_name:   ['organization', 'org', 'organization_name', 'company', 'company_name', 'employer', 'nonprofit_name', 'nonprofit'],
  how_can_we_help: ['message', 'notes', 'comments', 'how_can_we_help', 'inquiry'],
  // Ad-source metadata — captured for display on lead + detail page
  external_lead_id:    ['id', 'lead_id', 'external_id'],
  external_created_at: ['created_time', 'created_at', 'lead_created_at'],
  platform:            ['platform'],
  campaign_id:         ['campaign_id'],
  campaign_name:       ['campaign_name', 'campaign'],
  adset_id:            ['adset_id', 'ad_set_id'],
  adset_name:          ['adset_name', 'ad_set_name', 'adset'],
  ad_id:               ['ad_id'],
  ad_name:             ['ad_name', 'ad'],
  form_id:             ['form_id'],
  form_name:           ['form_name', 'form'],
  is_organic:          ['is_organic', 'organic'],
  inbox_url:           ['inbox_url', 'conversation_url'],
};

// Which fields to render on the preview/row card vs. which are just captured
const LEAD_AD_FIELDS = [
  'external_lead_id','external_created_at','platform',
  'campaign_id','campaign_name','adset_id','adset_name',
  'ad_id','ad_name','form_id','form_name','is_organic','inbox_url',
];

// Normalize platform codes to a friendly source label
function platformToSource(platform) {
  if (!platform) return null;
  const p = String(platform).toLowerCase().trim();
  if (p === 'fb' || p === 'facebook' || p === 'ig' || p === 'instagram' || p === 'meta') return 'Meta Ads';
  if (p === 'li' || p === 'linkedin') return 'LinkedIn Ads';
  if (p === 'google' || p === 'g_ads' || p === 'google_ads') return 'Google Ads';
  return null;
}

function normalizeHeader(h) {
  return String(h || '').toLowerCase().trim().replace(/[\s\-]+/g, '_');
}

function detectLeadColumns(headers) {
  const normalized = headers.map(normalizeHeader);
  const map = {};
  const detected = {};
  for (const [field, aliases] of Object.entries(LEAD_COLUMN_ALIASES)) {
    for (const alias of aliases) {
      const idx = normalized.indexOf(alias);
      if (idx >= 0) {
        map[field] = idx;
        detected[field] = headers[idx];
        break;
      }
    }
  }
  const unmapped = [];
  const usedIdxs = new Set(Object.values(map));
  headers.forEach((h, i) => { if (!usedIdxs.has(i)) unmapped.push(h); });
  return { map, detected, unmapped };
}

function splitFullName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return { first: '', last: '' };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

// ─── Helper: Parse lead CSV text → normalized rows + metadata ───────────────
function parseLeadCsv(csvText) {
  // Strip UTF-8 BOM if the client didn't
  if (csvText.charCodeAt(0) === 0xfeff) csvText = csvText.slice(1);
  const lines = csvText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length < 2) {
    return { error: 'CSV has no data rows.' };
  }

  const delimiter = detectDelimiter(lines[0]);
  const headers = parseCsvLine(lines[0], delimiter);
  const { map, detected, unmapped } = detectLeadColumns(headers);

  if (map.email === undefined) {
    return { error: 'No email column found. Expected one of: email, e-mail, email_address.' };
  }

  const detectedColumns = { ...detected };
  if (map.first_name === undefined && map.full_name !== undefined) {
    detectedColumns.first_name = `${detected.full_name} (split)`;
    detectedColumns.last_name = `${detected.full_name} (split)`;
  }

  const CORE_STAGES = new Set(['new_inquiry', 'contacted', 'demo_scheduled', 'attended_demo', 'follow_up', 'converted', 'lost']);
  const findLeadDup = db.prepare(
    `SELECT id, stage FROM leads WHERE LOWER(email) = LOWER(?) AND deleted_at IS NULL LIMIT 1`
  );
  const findNewUser = db.prepare(
    `SELECT id, org_name FROM new_users WHERE LOWER(first_name) = LOWER(?) AND LOWER(last_name) = LOWER(?) AND LOWER(email) = LOWER(?) AND deleted_at IS NULL LIMIT 1`
  );

  const rows = [];
  let invalidRows = 0;
  let duplicateLeads = 0;
  let matchedCustomers = 0;

  for (let i = 1; i < lines.length; i++) {
    const fields = parseCsvLine(lines[i], delimiter);
    const get = (f) => map[f] !== undefined ? (fields[map[f]] || '').trim() : '';

    let first_name = get('first_name');
    let last_name = get('last_name');
    if ((!first_name || !last_name) && map.full_name !== undefined) {
      const { first, last } = splitFullName(get('full_name'));
      if (!first_name) first_name = first;
      if (!last_name) last_name = last;
    }

    const email = get('email');
    const phone = get('phone');
    const org_name = get('org_name');
    const how_can_we_help = get('how_can_we_help');

    const errors = [];
    if (!email) errors.push('missing email');
    if (!first_name) errors.push('missing first name');

    let is_duplicate_lead = false;
    let is_terminal_duplicate = false;
    let duplicate_lead_stage = null;
    let matched_new_user = null;
    if (email && first_name) {
      const dup = findLeadDup.get(email);
      if (dup) {
        duplicateLeads++;
        if (CORE_STAGES.has(dup.stage)) {
          is_duplicate_lead = true;
        } else {
          is_terminal_duplicate = true;
          duplicate_lead_stage = dup.stage;
        }
      }
      const existing = findNewUser.get(first_name, last_name || '', email);
      if (existing) { matched_new_user = { id: existing.id, org_name: existing.org_name }; matchedCustomers++; }
    }

    if (errors.length > 0) invalidRows++;

    const adMeta = {};
    for (const f of LEAD_AD_FIELDS) {
      const val = get(f);
      if (val) adMeta[f] = val;
    }
    if (adMeta.is_organic !== undefined) {
      const v = String(adMeta.is_organic).toLowerCase();
      adMeta.is_organic = (v === 'true' || v === '1' || v === 'yes') ? 1 : 0;
    }

    rows.push({
      row_number: i + 1,
      first_name,
      last_name,
      email,
      phone,
      org_name,
      how_can_we_help,
      is_duplicate_lead,
      is_terminal_duplicate,
      duplicate_lead_stage,
      matched_new_user,
      errors,
      ...adMeta,
    });
  }

  const validRows = rows.filter(r => r.errors.length === 0).length;

  return {
    total_rows: rows.length,
    valid_rows: validRows,
    duplicate_leads: duplicateLeads,
    matched_customers: matchedCustomers,
    invalid_rows: invalidRows,
    detected_columns: detectedColumns,
    unmapped_headers: unmapped,
    rows,
  };
}

// ─── Helper: Log Activity ────────────────────────────────────────────────────
function logActivity(record_type, record_id, action, details, performed_by, meeting_id) {
  db.prepare(`
    INSERT INTO activity_log (record_type, record_id, action, details, performed_by, meeting_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(record_type, record_id, action, details || null, performed_by || null, meeting_id || null);
}

// ─── Helper: Stamp existing demo_scheduled entry as canceled ─────────────────
// Finds the activity row linked to this specific meeting_id and appends
// " — Canceled" to its details rather than creating a new row.
function markActivityCanceled(record_type, record_id, meetingId, fallbackDetails, performed_by) {
  const upd = db.prepare(`
    UPDATE activity_log SET details = details || ' — Canceled'
    WHERE id = (
      SELECT id FROM activity_log
      WHERE record_type = ? AND record_id = ? AND action = 'demo_scheduled'
        AND meeting_id = ? AND deleted_at IS NULL AND details NOT LIKE '% — Canceled'
      LIMIT 1
    )
  `).run(record_type, record_id, meetingId);
  if (upd.changes === 0) {
    const mtg = db.prepare(`SELECT scheduled_at FROM meetings WHERE id = ?`).get(meetingId);
    const dateStr = mtg?.scheduled_at
      ? new Date(mtg.scheduled_at).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' })
      : null;
    logActivity(record_type, record_id, 'meeting_canceled', dateStr ? `${fallbackDetails} — ${dateStr}` : fallbackDetails, performed_by, meetingId);
  }
}

// ─── Helper: Build simple CSV ────────────────────────────────────────────────
function buildCsv(rows, columns) {
  const header = columns.join(',');
  const lines = rows.map(row =>
    columns.map(col => {
      const val = row[col] == null ? '' : String(row[col]);
      // Escape quotes and wrap in quotes if contains comma/quote/newline
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        return '"' + val.replace(/"/g, '""') + '"';
      }
      return val;
    }).join(',')
  );
  return [header, ...lines].join('\n');
}

// ════════════════════════════════════════════════════════════════════════════
// LEADS ROUTES
// ════════════════════════════════════════════════════════════════════════════

// GET /api/leads — list leads with filters
app.get('/api/leads', (req, res) => {
  try {
    const { stage, assigned_to, source, search, sort, limit = 50, offset = 0 } = req.query;

    let where = ['deleted_at IS NULL'];
    let params = [];

    if (stage) {
      where.push('stage = ?');
      params.push(stage);
    }
    if (assigned_to) {
      where.push('assigned_to = ?');
      params.push(assigned_to);
    }
    if (source) {
      where.push('source = ?');
      params.push(source);
    }
    if (search) pushSearchFilter(where, params, search);

    const whereClause = 'WHERE ' + where.join(' AND ');

    let orderBy = 'ORDER BY created_at DESC';
    if (sort === 'oldest') orderBy = 'ORDER BY created_at ASC';
    else if (sort === 'last_activity') orderBy = 'ORDER BY updated_at DESC';

    const leads = db.prepare(`
      SELECT *, (${IS_ACTIVE_LEAD_SQL}) as is_active_lead FROM leads ${whereClause} ${orderBy} LIMIT ? OFFSET ?
    `).all(...params, Number(limit), Number(offset));

    const totalRow = db.prepare(`
      SELECT COUNT(*) as count FROM leads ${whereClause}
    `).get(...params);

    res.json({ leads, total: totalRow.count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leads/export — export leads as CSV (BEFORE /:id route)
app.get('/api/leads/export', (req, res) => {
  try {
    const { stage, assigned_to, source, search } = req.query;
    let where = ['deleted_at IS NULL'];
    let params = [];

    if (stage) { where.push('stage = ?'); params.push(stage); }
    if (assigned_to) { where.push('assigned_to = ?'); params.push(assigned_to); }
    if (source) { where.push('source = ?'); params.push(source); }
    if (search) pushSearchFilter(where, params, search);

    const whereClause = 'WHERE ' + where.join(' AND ');
    const leads = db.prepare(`SELECT * FROM leads ${whereClause} ORDER BY created_at DESC`).all(...params);

    const columns = [
      'id','first_name','last_name','email','phone','org_name','org_website',
      'source','stage','assigned_to','how_can_we_help','consent_to_contact',
      'platform','campaign_name','adset_name','ad_name','form_name','is_organic',
      'external_lead_id','external_created_at','campaign_id','adset_id','ad_id','form_id','inbox_url',
      'demo_scheduled_at','demo_completed_at','converted_at','created_at','updated_at'
    ];

    const csv = buildCsv(leads, columns);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="leads-export.csv"');
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/import/preview — parse CSV and return preview with dup/customer flags
app.post('/api/leads/import/preview', (req, res) => {
  try {
    const { csv } = req.body || {};
    if (!csv || typeof csv !== 'string') {
      return res.status(400).json({ error: 'CSV text is required.' });
    }
    const result = parseLeadCsv(csv);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/import/commit — insert previewed rows as new leads
app.post('/api/leads/import/commit', (req, res) => {
  try {
    const { rows, default_source, performed_by } = req.body || {};
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ error: 'rows array is required.' });
    }

    const defaultSource = (default_source && String(default_source).trim()) || 'Meta Ads';
    const defaultAssignee = getDefaultAssignee();
    const findLeadDup = db.prepare(
      `SELECT id FROM leads WHERE LOWER(email) = LOWER(?) AND deleted_at IS NULL LIMIT 1`
    );
    const insertLead = db.prepare(`
      INSERT INTO leads (
        first_name, last_name, email, phone, org_name,
        source, how_can_we_help, consent_to_contact, stage,
        external_lead_id, external_created_at, platform,
        campaign_id, campaign_name, adset_id, adset_name,
        ad_id, ad_name, form_id, form_name, is_organic, inbox_url,
        assigned_to
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'new_inquiry',
        ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let imported = 0;
    let skipped = 0;
    const errors = [];
    const createdIds = [];

    const doImport = db.transaction(() => {
      for (const row of rows) {
        try {
          const first_name = (row.first_name || '').trim();
          const last_name = (row.last_name || '').trim();
          const email = (row.email || '').trim();
          const org_name = (row.org_name || '').trim() || 'Unknown';
          const phone = (row.phone || '').trim() || null;
          const how_can_we_help = (row.how_can_we_help || '').trim() || null;

          if (!first_name || !email) { skipped++; continue; }
          if (!row.force_import && findLeadDup.get(email)) { skipped++; continue; }

          const platform = (row.platform || '').trim() || null;
          const source = platformToSource(platform) || defaultSource;
          const isOrganic = row.is_organic === 1 || row.is_organic === 0 ? row.is_organic : null;

          const result = insertLead.run(
            first_name, last_name, email, phone, org_name,
            source, how_can_we_help,
            (row.external_lead_id || '').trim() || null,
            (row.external_created_at || '').trim() || null,
            platform,
            (row.campaign_id || '').trim() || null,
            (row.campaign_name || '').trim() || null,
            (row.adset_id || '').trim() || null,
            (row.adset_name || '').trim() || null,
            (row.ad_id || '').trim() || null,
            (row.ad_name || '').trim() || null,
            (row.form_id || '').trim() || null,
            (row.form_name || '').trim() || null,
            isOrganic,
            (row.inbox_url || '').trim() || null,
            defaultAssignee,
          );
          createdIds.push({ id: result.lastInsertRowid, first_name, last_name });
          imported++;
        } catch (err) {
          errors.push(`Row ${row.row_number || '?'}: ${err.message}`);
        }
      }
    });

    doImport();

    for (const { id, first_name, last_name } of createdIds) {
      logActivity('lead', id, 'created', `Lead imported from CSV: ${first_name} ${last_name}`, performed_by || 'CSV Import');
    }

    res.json({ imported, skipped, errors });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leads/:id — single lead with notes and activity_log
app.get('/api/leads/:id', (req, res) => {
  try {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const notes = db.prepare(
      'SELECT * FROM notes WHERE record_type = ? AND record_id = ? AND deleted_at IS NULL ORDER BY created_at ASC'
    ).all('lead', req.params.id);

    const activity = db.prepare(`
      SELECT al.*,
        CASE WHEN al.action IN ('demo_scheduled', 'meeting_canceled') AND al.meeting_id IS NOT NULL THEN
          (SELECT scheduled_at FROM meetings WHERE id = al.meeting_id)
        END as demo_scheduled_at
      FROM activity_log al
      WHERE al.record_type = 'lead' AND al.record_id = ? AND al.deleted_at IS NULL
      ORDER BY al.created_at DESC
    `).all(req.params.id);

    res.json({ ...lead, notes, activity_log: activity });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads — create lead (manual)
app.post('/api/leads', (req, res) => {
  try {
    const {
      first_name, last_name, email, confirm_email, phone, phone_extension,
      org_name, org_website, source, how_can_we_help, consent_to_contact,
      assigned_to, stage
    } = req.body;

    if (!first_name || !last_name || !email || !org_name) {
      return res.status(400).json({ error: 'first_name, last_name, email, and org_name are required' });
    }

    const defaultAssignee = getDefaultAssignee();
    const result = db.prepare(`
      INSERT INTO leads (first_name, last_name, email, confirm_email, phone, phone_extension,
        org_name, org_website, source, how_can_we_help, consent_to_contact, assigned_to, stage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      first_name, last_name, email, confirm_email || null, phone || null, phone_extension || null,
      org_name, org_website || null, source || null, how_can_we_help || null,
      consent_to_contact ? 1 : 0, assigned_to || defaultAssignee, stage || 'new_inquiry'
    );

    logActivity('lead', result.lastInsertRowid, 'created', `Lead created: ${first_name} ${last_name}`, req.body.performed_by || 'System');

    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(lead);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/submit — public web-to-lead (rate limited)
app.post('/api/leads/submit', webToLeadLimiter, (req, res) => {
  try {
    const {
      first_name, last_name, email, confirm_email, phone, phone_extension,
      org_name, org_website, source, how_can_we_help, consent_to_contact
    } = req.body;

    if (!first_name || !last_name || !email || !org_name) {
      return res.status(400).json({ error: 'first_name, last_name, email, and org_name are required' });
    }

    const defaultAssignee = getDefaultAssignee();
    const result = db.prepare(`
      INSERT INTO leads (first_name, last_name, email, confirm_email, phone, phone_extension,
        org_name, org_website, source, how_can_we_help, consent_to_contact, assigned_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      first_name, last_name, email, confirm_email || null, phone || null, phone_extension || null,
      org_name, org_website || null, source || 'Website Form', how_can_we_help || null,
      consent_to_contact ? 1 : 0, defaultAssignee
    );

    logActivity('lead', result.lastInsertRowid, 'created', 'Lead submitted via web form', 'Web Form');

    res.status(201).json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/leads/:id — update lead fields
app.put('/api/leads/:id', (req, res) => {
  try {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const allowed = [
      'first_name','last_name','email','confirm_email','phone','phone_extension',
      'org_name','org_website','source','how_can_we_help','consent_to_contact',
      'assigned_to','calendly_event_uri','demo_scheduled_at',
      'demo_completed_at','onboard_scheduled_at','onboard_completed_at',
      'zendesk_user_id','zendesk_org_id','lost_reason'
    ];

    const updates = [];
    const params = [];
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        params.push(req.body[field]);
      }
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(req.params.id);

    db.prepare(`UPDATE leads SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/leads/:id/stage — update stage
app.put('/api/leads/:id/stage', (req, res) => {
  try {
    const { stage, performed_by } = req.body;
    if (!stage) return res.status(400).json({ error: 'stage is required' });

    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    const oldStage = lead.stage;
    // Advancing out of new_inquiry/lost/converted into any active stage counts as contact.
    const isContactEvent = stage !== oldStage && ['contacted', 'follow_up', 'demo_scheduled', 'attended_demo'].includes(stage);
    if (isContactEvent) {
      db.prepare('UPDATE leads SET stage = ?, last_contacted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(stage, req.params.id);
    } else {
      db.prepare('UPDATE leads SET stage = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(stage, req.params.id);
    }
    logActivity('lead', req.params.id, 'stage_changed', `Stage changed from ${oldStage} to ${stage}`, performed_by || 'Team');

    const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/:id/convert — mark as converted + sync to Zendesk
app.post('/api/leads/:id/convert', async (req, res) => {
  try {
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    // Zendesk sync before DB write — rollback is a no-op if this throws
    let zendeskOrgId = lead.zendesk_org_id || null;
    let zendeskUserId = lead.zendesk_user_id || null;
    try {
      if (lead.org_name && !zendeskOrgId) {
        const org = await zendesk.findOrCreateOrg(lead.org_name, lead.org_website);
        zendeskOrgId = org.id;
      }
      if (!zendeskUserId) {
        const user = await zendesk.findOrCreateUser(lead, zendeskOrgId);
        zendeskUserId = user.id;
      }
    } catch (zdErr) {
      console.error('Zendesk sync failed:', zdErr.message);
      return res.status(502).json({ error: `Zendesk sync failed: ${zdErr.message}` });
    }

    db.prepare(`
      UPDATE leads
      SET stage = 'converted', converted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
          zendesk_org_id = ?, zendesk_user_id = ?
      WHERE id = ?
    `).run(zendeskOrgId, zendeskUserId, req.params.id);

    logActivity('lead', req.params.id, 'converted', 'Lead marked as converted (Zendesk synced)', req.body.performed_by || 'Team');

    const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/:id/lost — mark as lost
app.post('/api/leads/:id/lost', (req, res) => {
  try {
    const { lost_reason, performed_by } = req.body;
    const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });

    db.prepare(`
      UPDATE leads SET stage = 'lost', lost_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(lost_reason || null, req.params.id);

    logActivity('lead', req.params.id, 'lost', `Lead marked as lost. Reason: ${lost_reason || 'N/A'}`, performed_by || 'Team');

    const updated = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/leads/:id — soft-delete (goes to recycle bin for 7 days)
app.delete('/api/leads/:id', (req, res) => {
  try {
    const lead = db.prepare('SELECT id FROM leads WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    db.prepare("UPDATE leads SET deleted_at = datetime('now') WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/leads/:id/attempt, /api/new-users/:id/attempt — bump contact_attempts by +1 or -1
function attemptHandler(table, recordType, notFoundMsg) {
  return (req, res) => {
    try {
      const delta = Number(req.body?.delta);
      if (delta !== 1 && delta !== -1) {
        return res.status(400).json({ error: 'delta must be 1 or -1' });
      }
      const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NULL`).get(req.params.id);
      if (!row) return res.status(404).json({ error: notFoundMsg });

      const next = Math.max(0, (row.contact_attempts || 0) + delta);
      if (delta > 0) {
        db.prepare(`UPDATE ${table} SET contact_attempts = ?, last_contacted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(next, req.params.id);
        logActivity(recordType, req.params.id, 'attempt_logged', `Contact attempt #${next} logged`, req.body.performed_by || 'Team');
      } else {
        db.prepare(`UPDATE ${table} SET contact_attempts = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(next, req.params.id);
        logActivity(recordType, req.params.id, 'attempt_reverted', `Contact attempt decremented to ${next}`, req.body.performed_by || 'Team');
      }

      res.json(db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id));
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  };
}
app.post('/api/leads/:id/attempt', attemptHandler('leads', 'lead', 'Lead not found'));

// ════════════════════════════════════════════════════════════════════════════
// NOTES ROUTES
// ════════════════════════════════════════════════════════════════════════════

// GET /api/notes/:record_type/:record_id
app.get('/api/notes/:record_type/:record_id', (req, res) => {
  try {
    const notes = db.prepare(
      'SELECT * FROM notes WHERE record_type = ? AND record_id = ? AND deleted_at IS NULL ORDER BY created_at ASC'
    ).all(req.params.record_type, req.params.record_id);
    res.json(notes);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notes — add note (optional meeting_id to link to a meeting, optional topic)
app.post('/api/notes', (req, res) => {
  try {
    const { record_type, record_id, content, author, meeting_id, topic } = req.body;
    if (!record_type || !record_id || !content || !author) {
      return res.status(400).json({ error: 'record_type, record_id, content, and author are required' });
    }

    const result = db.prepare(
      'INSERT INTO notes (record_type, record_id, content, author, meeting_id, topic) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(record_type, record_id, content, author, meeting_id || null, topic || null);

    if (!meeting_id) {
      logActivity(record_type, record_id, 'note_added', `Note added by ${author}`, author);
    }

    const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(note);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/notes/:id — edit content (and optionally topic)
app.put('/api/notes/:id', (req, res) => {
  try {
    const note = db.prepare('SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    const { content, topic } = req.body;
    if (content !== undefined && !content.trim()) return res.status(400).json({ error: 'Content cannot be empty' });
    const updates = [];
    const params = [];
    if (content !== undefined) { updates.push('content = ?'); params.push(content.trim()); }
    if (topic !== undefined)   { updates.push('topic = ?');   params.push(topic || null); }
    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    params.push(req.params.id);
    db.prepare(`UPDATE notes SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    res.json(db.prepare('SELECT * FROM notes WHERE id = ?').get(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/notes/:id — soft-delete (moves to recycle bin)
app.delete('/api/notes/:id', (req, res) => {
  try {
    const note = db.prepare('SELECT * FROM notes WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    db.prepare("UPDATE notes SET deleted_at = datetime('now') WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/activity/:id — soft-delete (moves to recycle bin)
app.delete('/api/activity/:id', (req, res) => {
  try {
    const item = db.prepare('SELECT * FROM activity_log WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Activity entry not found' });
    db.prepare("UPDATE activity_log SET deleted_at = datetime('now') WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/activity/bulk-soft-delete, /api/notes/bulk-soft-delete — soft-delete many
function bulkSoftDeleteHandler(table) {
  return (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
      if (ids.length === 0) return res.status(400).json({ error: 'ids must be a non-empty array of integers' });
      const placeholders = ids.map(() => '?').join(',');
      const result = db.prepare(
        `UPDATE ${table} SET deleted_at = datetime('now') WHERE deleted_at IS NULL AND id IN (${placeholders})`
      ).run(...ids);
      res.json({ ok: true, deleted: result.changes });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  };
}
app.post('/api/activity/bulk-soft-delete', bulkSoftDeleteHandler('activity_log'));
app.post('/api/notes/bulk-soft-delete', bulkSoftDeleteHandler('notes'));

// GET /api/recycle-bin — returns all soft-deleted items (and auto-purges >7 days)
const PURGE_CUTOFF = "datetime('now', '-7 days')";
const CHILD_TABLES = ['notes', 'activity_log', 'meetings'];

app.get('/api/recycle-bin', (req, res) => {
  try {
    // Cascade-delete child records for leads/users that are about to be hard-purged,
    // so no orphaned notes/activity/meetings are left behind.
    for (const [parentTable, recordType] of [['leads', 'lead'], ['new_users', 'new_user']]) {
      for (const child of CHILD_TABLES) {
        db.prepare(`DELETE FROM ${child} WHERE record_type = '${recordType}' AND record_id IN
          (SELECT id FROM ${parentTable} WHERE deleted_at IS NOT NULL AND deleted_at < ${PURGE_CUTOFF})`).run();
      }
    }
    // Purge individually soft-deleted notes/activity/meetings, then the parent records.
    for (const table of [...CHILD_TABLES, 'leads', 'new_users']) {
      db.prepare(`DELETE FROM ${table} WHERE deleted_at IS NOT NULL AND deleted_at < ${PURGE_CUTOFF}`).run();
    }

    const notes = db.prepare(`
      SELECT n.*, ${recordNameCase('n')} as record_name
      FROM notes n WHERE n.deleted_at IS NOT NULL ORDER BY n.deleted_at DESC
    `).all();

    const activity = db.prepare(`
      SELECT al.*, ${recordNameCase('al')} as record_name
      FROM activity_log al WHERE al.deleted_at IS NOT NULL ORDER BY al.deleted_at DESC
    `).all();

    const leads = db.prepare(`
      SELECT id, first_name, last_name, email, org_name, stage, source,
             campaign_name, ad_name, platform, deleted_at, created_at
      FROM leads WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC
    `).all();

    const users = db.prepare(`
      SELECT id, first_name, last_name, email, org_name, organization_id,
             training_category, contact_status, date_entered, deleted_at, created_at
      FROM new_users WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC
    `).all();

    const meetings = db.prepare(`
      SELECT m.*, ${contactNameCase('m')} as contact_name
      FROM meetings m WHERE m.deleted_at IS NOT NULL ORDER BY m.deleted_at DESC
    `).all();

    res.json({ notes, activity, leads, users, meetings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Recycle-bin type → table mapping shared by restore/bulk-delete/permanent-delete.
const BIN_TABLES = { note: 'notes', activity: 'activity_log', lead: 'leads', user: 'new_users', meeting: 'meetings' };

// POST /api/recycle-bin/restore/:type/:id
app.post('/api/recycle-bin/restore/:type/:id', (req, res) => {
  try {
    const { type, id } = req.params;
    const table = BIN_TABLES[type];
    if (!table) return res.status(400).json({ error: 'Unknown type' });
    const row = db.prepare(`SELECT id FROM ${table} WHERE id = ? AND deleted_at IS NOT NULL`).get(id);
    if (!row) return res.status(404).json({ error: 'Not found in recycle bin' });
    db.prepare(`UPDATE ${table} SET deleted_at = NULL WHERE id = ?`).run(id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

function cascadeDeleteChildren(recordType, ids) {
  const dbType = recordType === 'lead' ? 'lead' : 'new_user';
  const ph     = ids.map(() => '?').join(',');
  for (const child of CHILD_TABLES) {
    db.prepare(`DELETE FROM ${child} WHERE record_type = '${dbType}' AND record_id IN (${ph})`).run(...ids);
  }
}

// POST /api/recycle-bin/bulk-delete — permanently delete many items of one type
app.post('/api/recycle-bin/bulk-delete', (req, res) => {
  try {
    const { type, ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'ids must be a non-empty array' });
    }
    const table = BIN_TABLES[type];
    if (!table) return res.status(400).json({ error: 'Unknown type' });

    // Parameterized IN-clause
    const placeholders = ids.map(() => '?').join(',');
    const intIds = ids.map(Number).filter(n => Number.isInteger(n));
    if (intIds.length === 0) return res.status(400).json({ error: 'ids must be integers' });

    const purge = db.transaction(() => {
      if (type === 'lead' || type === 'user') cascadeDeleteChildren(type, intIds);
      db.prepare(`DELETE FROM ${table} WHERE deleted_at IS NOT NULL AND id IN (${placeholders})`).run(...intIds);
    });
    purge();
    res.json({ ok: true, deleted: intIds.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/recycle-bin/:type/:id — permanent delete
app.delete('/api/recycle-bin/:type/:id', (req, res) => {
  try {
    const { type, id } = req.params;
    const table = BIN_TABLES[type];
    if (!table) return res.status(400).json({ error: 'Unknown type' });
    if (type === 'lead' || type === 'user') cascadeDeleteChildren(type, [parseInt(id, 10)]);
    db.prepare(`DELETE FROM ${table} WHERE id = ? AND deleted_at IS NOT NULL`).run(id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Meetings API ─────────────────────────────────────────────────────────

// GET /api/meetings/all — all meetings enriched with contact info, filterable by date + status
// Must be defined BEFORE /:record_type/:record_id to prevent "all" matching :record_type
app.get('/api/meetings/all', (req, res) => {
  try {
    const { start, end, status } = req.query;
    const now = new Date();
    const weekStart = new Date(now);
    weekStart.setHours(0, 0, 0, 0);
    const dayOfWeek = weekStart.getDay();
    weekStart.setDate(weekStart.getDate() - (dayOfWeek === 0 ? 6 : dayOfWeek - 1));
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekEnd.getDate() + 7);

    const startParam = start || weekStart.toISOString();
    const endParam   = end   || weekEnd.toISOString();

    let sql = `
      SELECT
        m.id,
        m.record_type,
        m.record_id,
        m.scheduled_at,
        m.status,
        m.event_name,
        m.invitee_name,
        m.invitee_email,
        m.source_calendar,
        ${contactNameCase('m')} as contact_name,
        CASE
          WHEN m.record_type = 'lead'     THEN (SELECT org_name FROM leads     WHERE id = m.record_id)
          WHEN m.record_type = 'new_user' THEN (SELECT org_name FROM new_users WHERE id = m.record_id)
        END as org_name,
        ${isEstablishedCase('m')} as is_established
      FROM meetings m
      WHERE m.scheduled_at >= ? AND m.scheduled_at < ?
        AND m.deleted_at IS NULL
    `;
    const params = [startParam, endParam];

    if (status) {
      sql += ' AND m.status = ?';
      params.push(status);
    }

    sql += ' ORDER BY m.scheduled_at ASC';

    const rows = db.prepare(sql).all(...params);

    // Deduplicate: same invitee_email + scheduled_at within ±5 min → keep Calendly (source_calendar IS NULL) over Outlook.
    const deduped = [];
    for (const m of rows) {
      const mEmail = m.invitee_email?.toLowerCase();
      const mTime  = new Date(m.scheduled_at).getTime();
      if (!mEmail) { deduped.push(m); continue; }
      const idx = deduped.findIndex(x =>
        x.invitee_email?.toLowerCase() === mEmail &&
        Math.abs(new Date(x.scheduled_at).getTime() - mTime) <= 5 * 60 * 1000
      );
      if (idx === -1) {
        deduped.push(m);
      } else {
        // Calendly (no source_calendar) beats Outlook (has source_calendar)
        const mIsCalendly    = !m.source_calendar;
        const existIsCalendly = !deduped[idx].source_calendar;
        if (mIsCalendly && !existIsCalendly) deduped[idx] = m;
      }
    }

    res.json(deduped);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/meetings/:record_type/:record_id — meetings with embedded notes
app.get('/api/meetings/:record_type/:record_id', (req, res) => {
  try {
    const meetings = db.prepare(
      `SELECT * FROM meetings WHERE record_type = ? AND record_id = ? AND deleted_at IS NULL ORDER BY scheduled_at DESC`
    ).all(req.params.record_type, req.params.record_id);

    if (meetings.length === 0) return res.json([]);

    const meetingIds = meetings.map(m => m.id);
    const noteRows = db.prepare(
      `SELECT * FROM notes WHERE meeting_id IN (${meetingIds.map(() => '?').join(',')}) AND deleted_at IS NULL ORDER BY created_at ASC`
    ).all(...meetingIds);
    const notesByMeeting = {};
    for (const n of noteRows) {
      if (!notesByMeeting[n.meeting_id]) notesByMeeting[n.meeting_id] = [];
      notesByMeeting[n.meeting_id].push(n);
    }

    res.json(meetings.map(m => ({ ...m, notes: notesByMeeting[m.id] || [] })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/meetings/:id — update meeting status
app.put('/api/meetings/:id', (req, res) => {
  try {
    const { status } = req.body;
    if (!['scheduled', 'completed', 'canceled'].includes(status)) {
      return res.status(400).json({ error: 'status must be scheduled, completed, or canceled' });
    }
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

    const completedAt = status === 'completed' ? new Date().toISOString() : null;
    db.prepare(`UPDATE meetings SET status=?, completed_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(status, completedAt, req.params.id);

    // Mirror status back onto parent record
    if (meeting.record_type === 'new_user') {
      if (status === 'completed') {
        db.prepare(`UPDATE new_users SET contact_status='demo_completed', demo_completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(meeting.record_id);
      } else if (status === 'canceled') {
        db.prepare(`UPDATE new_users SET contact_status='contacted', calendly_event_uri=NULL, demo_scheduled_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND calendly_event_uri=?`).run(meeting.record_id, meeting.calendly_event_uri);
      }
    } else if (meeting.record_type === 'lead') {
      if (status === 'completed') {
        db.prepare(`UPDATE leads SET demo_completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(meeting.record_id);
      } else if (status === 'canceled') {
        db.prepare(`UPDATE leads SET stage='contacted', calendly_event_uri=NULL, demo_scheduled_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND calendly_event_uri=?`).run(meeting.record_id, meeting.calendly_event_uri);
      }
    }

    if (status === 'canceled') {
      markActivityCanceled(meeting.record_type, meeting.record_id, meeting.id, `Meeting "${meeting.event_name}" canceled`, 'Team');
    } else {
      logActivity(meeting.record_type, meeting.record_id, 'meeting_' + status, `Meeting "${meeting.event_name}" marked ${status}`, 'Team');
    }
    res.json(db.prepare('SELECT * FROM meetings WHERE id = ?').get(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/meetings/:id — soft-delete (moves to recycle bin)
// Calendly-synced meetings (calendly_event_uri set, no source_calendar) are protected — delete is rejected.
app.delete('/api/meetings/:id', (req, res) => {
  try {
    const meeting = db.prepare('SELECT * FROM meetings WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });
    if (meeting.calendly_event_uri && !meeting.source_calendar) {
      return res.status(403).json({ error: 'Calendly-synced meetings cannot be deleted here. Cancel them in Calendly.' });
    }
    db.prepare('UPDATE meetings SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/emails/:record_type/:record_id — email history from Outlook via Graph API
app.get('/api/emails/:record_type/:record_id', async (req, res) => {
  try {
    const { record_type, record_id } = req.params;
    const record = getContactRecord(record_type, record_id);
    if (!record) return res.status(404).json({ error: 'Record not found' });
    if (!record.email) return res.json([]);

    const teamMembers = db.prepare(
      "SELECT name, email FROM team_members WHERE active = 1 AND email IS NOT NULL AND email != ''"
    ).all();
    if (teamMembers.length === 0) return res.json([]);

    const allMessages = [];

    await Promise.all(teamMembers.map(async member => {
      try {
        const { sent, received } = await graph.getEmailHistory(member.email, record.email);
        sent.forEach(msg => allMessages.push({
          id: msg.id,
          direction: 'sent',
          subject: msg.subject || '(no subject)',
          date: msg.sentDateTime,
          teamMember: member.name,
        }));
        received.forEach(msg => allMessages.push({
          id: msg.id,
          direction: 'received',
          subject: msg.subject || '(no subject)',
          date: msg.receivedDateTime,
          teamMember: member.name,
        }));
      } catch (_) { /* skip mailboxes that fail */ }
    }));

    const seen = new Set();
    const cutoff = new Date(Date.now() - 548 * 86400 * 1000); // last 18 months
    const deduped = allMessages.filter(m => {
      if (seen.has(m.id)) return false;
      seen.add(m.id);
      return new Date(m.date) >= cutoff;
    });
    deduped.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json(deduped);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/support-history/:record_type/:record_id — support sessions for a contact
app.get('/api/support-history/:record_type/:record_id', async (req, res) => {
  try {
    const { record_type, record_id } = req.params;
    const record = getContactRecord(record_type, record_id);
    if (!record) return res.status(404).json({ error: 'Record not found' });
    if (!record.email) return res.json({ sessions: [] });
    if (!supportSessions.isConfigured()) return res.json({ sessions: [], unavailable: true });

    const frontendUrl = (process.env.SUPPORT_SESSIONS_FRONTEND_URL || '').replace(/\/$/, '');
    const sessions = (await supportSessions.searchSessions(record.email))
      .sort((a, b) => new Date(b.date_created) - new Date(a.date_created))
      .map(s => ({
        id:            s.id,
        date_created:  s.date_created,
        org_name:      s.org_name,
        customer_name: s.customer_name,
        note_url:      frontendUrl ? `${frontendUrl}/?session=${s.id}` : null,
        issues: (s.issues || []).map(i => ({
          platform:            i.platform,
          status:              i.status,
          description_snippet: i.description ? i.description.slice(0, 120) : '',
        })),
      }));

    res.json({ sessions });
  } catch (err) {
    res.json({ sessions: [], unavailable: true });
  }
});

// GET /api/zendesk-tickets/:record_type/:record_id — ticket history for a contact
app.get('/api/zendesk-tickets/:record_type/:record_id', async (req, res) => {
  try {
    if (!zendesk.isConfigured()) {
      return res.json({ tickets: [], unavailable: true });
    }
    const { record_type, record_id } = req.params;
    const record = db.prepare(
      `SELECT email, first_name, last_name, org_name FROM new_users WHERE id = ? AND deleted_at IS NULL`
    ).get(record_id);
    if (!record) return res.status(404).json({ error: 'Record not found' });
    if (!record.email) return res.json({ tickets: [] });

    const tickets = await zendesk.getTicketsByEmail(record.email);
    res.json({ tickets });
  } catch (err) {
    console.error('Zendesk tickets GET error:', err.message);
    res.json({ tickets: [], unavailable: true });
  }
});

// POST /api/zendesk-tickets/:record_type/:record_id — create a ticket for a contact
app.post('/api/zendesk-tickets/:record_type/:record_id', async (req, res) => {
  try {
    if (!zendesk.isConfigured()) {
      return res.status(503).json({ error: 'Zendesk credentials not configured' });
    }
    const { record_id } = req.params;
    const { subject, description } = req.body;
    if (!subject || !description) return res.status(400).json({ error: 'subject and description are required' });

    const record = db.prepare(
      `SELECT email, first_name, last_name, org_name FROM new_users WHERE id = ? AND deleted_at IS NULL`
    ).get(record_id);
    if (!record) return res.status(404).json({ error: 'Record not found' });

    const ticket = await zendesk.createTicket({
      subject,
      description,
      requesterEmail: record.email,
      requesterName:  [record.first_name, record.last_name].filter(Boolean).join(' ') || record.email,
      orgName:        record.org_name,
    });
    res.json(ticket);
  } catch (err) {
    console.error('Zendesk tickets POST error:', err.message);
    res.status(502).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// NEW USERS ROUTES
// ════════════════════════════════════════════════════════════════════════════

// POST /api/new-users/import — import from CSV text (BEFORE /:id)
app.post('/api/new-users/import', (req, res) => {
  try {
    const { csv } = req.body;
    if (!csv || typeof csv !== 'string') {
      return res.status(400).json({ error: 'csv field (string) is required' });
    }
    const result = importNewUsersFromCsv(csv);
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/new-users/export — export CSV (BEFORE /:id)
app.get('/api/new-users/export', (req, res) => {
  try {
    const { training_category, contact_status, search } = req.query;
    let where = ['deleted_at IS NULL'];
    let params = [];

    if (training_category) { where.push('training_category = ?'); params.push(training_category); }
    if (contact_status) { where.push('contact_status = ?'); params.push(contact_status); }
    if (search) pushSearchFilter(where, params, search);

    const whereClause = 'WHERE ' + where.join(' AND ');
    const users = db.prepare(`SELECT * FROM new_users ${whereClause} ORDER BY date_entered DESC`).all(...params);

    const columns = [
      'id','organization_id','org_name','org_url','first_name','last_name','email',
      'user_profile_name','date_entered','last_login','last_transaction_date',
      'training_category','follow_up_due_at','contact_status','demo_scheduled_at','demo_completed_at',
      'assigned_to','created_at','updated_at'
    ];

    const csv = buildCsv(users, columns);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="new-users-export.csv"');
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/new-users/overdue — users whose onboarding follow-up deadline has passed (BEFORE /:id)
app.get('/api/new-users/overdue', (req, res) => {
  try {
    const users = db.prepare(`
      SELECT * FROM new_users
      WHERE follow_up_due_at IS NOT NULL
        AND follow_up_due_at <= datetime('now')
        AND contact_status NOT IN ('demo_completed', 'no_action_needed')
        AND deleted_at IS NULL
      ORDER BY follow_up_due_at ASC
    `).all();
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/new-users/needs-review — training_category = needs_review (BEFORE /:id)
app.get('/api/new-users/needs-review', (req, res) => {
  try {
    const users = db.prepare(`
      SELECT * FROM new_users
      WHERE ${newUserWindow()}
        AND training_category = 'needs_review'
        AND deleted_at IS NULL
      ORDER BY date_entered DESC
    `).all();
    res.json(users);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/new-users — list with filters (only users inside the new-user window)
app.get('/api/new-users', (req, res) => {
  try {
    const { training_category, contact_status, search, period = 'last7', sort, limit = 50, offset = 0 } = req.query;

    let where = ['deleted_at IS NULL'];
    let params = [];

    // Base: only current new users (inside the new-user window)
    where.push(newUserWindow());

    if (search && search.trim()) {
      pushSearchFilter(where, params, search.trim());
    } else if (period !== 'all_new') {
      if (period === 'today') {
        where.push("date(date_entered) = date('now')");
      } else if (period === 'yesterday') {
        where.push("date(date_entered) = date('now', '-1 day')");
      } else if (period === 'last_month') {
        where.push("date(date_entered) >= date('now', '-30 days')");
      } else {
        // default: last7 — date() comparison so users on the 7th day aren't cut off by time-of-day
        where.push("date(date_entered) >= date('now', '-7 days')");
      }
    }

    if (training_category) { where.push('training_category = ?'); params.push(training_category); }
    if (contact_status) { where.push('contact_status = ?'); params.push(contact_status); }

    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';

    let orderBy = 'ORDER BY date_entered DESC';
    if (sort === 'oldest') orderBy = 'ORDER BY date_entered ASC';
    else if (sort === 'last_activity') orderBy = 'ORDER BY updated_at DESC';

    const users = db.prepare(`
      SELECT *,
        (SELECT COUNT(DISTINCT organization_id) FROM new_users nu2 WHERE lower(nu2.email) = lower(new_users.email) AND nu2.deleted_at IS NULL) as org_count
      FROM new_users ${whereClause} ${orderBy} LIMIT ? OFFSET ?
    `).all(...params, Number(limit), Number(offset));

    const totalRow = db.prepare(`
      SELECT COUNT(*) as count FROM new_users ${whereClause}
    `).get(...params);

    res.json({ users, total: totalRow.count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/new-users/:id — single user with notes, activity, and other orgs
app.get('/api/new-users/:id', (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM new_users WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const notes = db.prepare(
      'SELECT * FROM notes WHERE record_type = ? AND record_id = ? AND deleted_at IS NULL ORDER BY created_at ASC'
    ).all('new_user', req.params.id);

    const activity = db.prepare(`
      SELECT al.*,
        CASE WHEN al.action IN ('demo_scheduled', 'meeting_canceled') AND al.meeting_id IS NOT NULL THEN
          (SELECT scheduled_at FROM meetings WHERE id = al.meeting_id)
        END as demo_scheduled_at
      FROM activity_log al
      WHERE al.record_type = 'new_user' AND al.record_id = ? AND al.deleted_at IS NULL
      ORDER BY al.created_at DESC
    `).all(req.params.id);

    // Other org records for the same person (same email, different row)
    const other_orgs = db.prepare(`
      SELECT id, org_name, organization_id, crm_org_id, date_entered,
        (SELECT COUNT(*) FROM meetings WHERE record_type = 'new_user' AND record_id = nu2.id) as meeting_count,
        (SELECT MAX(scheduled_at) FROM meetings WHERE record_type = 'new_user' AND record_id = nu2.id) as last_meeting_at
      FROM new_users nu2
      WHERE lower(nu2.email) = lower(?) AND nu2.id != ? AND nu2.deleted_at IS NULL
      ORDER BY date_entered DESC
    `).all(user.email, req.params.id);

    res.json({ ...user, notes, activity_log: activity, other_orgs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/new-users/:id — update user
app.put('/api/new-users/:id', (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM new_users WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const allowed = [
      'org_name','org_url','first_name','last_name','email','user_profile_name',
      'user_profile_id','last_login','last_transaction_date','assigned_to',
      'calendly_event_uri','demo_scheduled_at','demo_completed_at','notified_at'
    ];

    const updates = [];
    const params = [];
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        updates.push(`${field} = ?`);
        params.push(req.body[field]);
      }
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });

    updates.push('updated_at = CURRENT_TIMESTAMP');
    params.push(req.params.id);

    db.prepare(`UPDATE new_users SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    const updated = db.prepare('SELECT * FROM new_users WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/new-users/:id/category — set training_category
app.put('/api/new-users/:id/category', (req, res) => {
  try {
    const { training_category, performed_by } = req.body;
    if (!training_category) return res.status(400).json({ error: 'training_category is required' });

    const user = db.prepare('SELECT * FROM new_users WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const old = user.training_category;
    // Re-run the follow-up rule: full onboarding gets a deadline, anything else clears it.
    const { follow_up_due_at } = triageNewUser({
      profileName: user.user_profile_name || 'manual',
      dateEntered: user.date_entered,
      lookupCategory: () => training_category,
    });
    db.prepare('UPDATE new_users SET training_category = ?, follow_up_due_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(training_category, follow_up_due_at, req.params.id);
    logActivity('new_user', req.params.id, 'category_changed', `Training category changed from ${old} to ${training_category}`, performed_by || 'Team');

    const updated = db.prepare('SELECT * FROM new_users WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const VALID_CONTACT_STATUSES = ['not_contacted', 'contacted', 'demo_scheduled', 'demo_completed', 'no_action_needed'];

// PUT /api/new-users/:id/status — update contact_status
app.put('/api/new-users/:id/status', (req, res) => {
  try {
    const { contact_status, performed_by } = req.body;
    if (!contact_status) return res.status(400).json({ error: 'contact_status is required' });
    if (!VALID_CONTACT_STATUSES.includes(contact_status)) return res.status(400).json({ error: `Invalid contact_status. Must be one of: ${VALID_CONTACT_STATUSES.join(', ')}` });

    const user = db.prepare('SELECT * FROM new_users WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const old = user.contact_status;
    const isContactEvent = contact_status !== old && contact_status !== 'not_contacted' && contact_status !== 'no_action_needed';
    if (isContactEvent) {
      db.prepare('UPDATE new_users SET contact_status = ?, last_contacted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(contact_status, req.params.id);
    } else {
      db.prepare('UPDATE new_users SET contact_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(contact_status, req.params.id);
    }
    logActivity('new_user', req.params.id, 'status_changed', `Contact status changed from ${old} to ${contact_status}`, performed_by || 'Team');

    const updated = db.prepare('SELECT * FROM new_users WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/new-users/:id — soft-delete (goes to recycle bin for 7 days)
app.delete('/api/new-users/:id', (req, res) => {
  try {
    const user = db.prepare('SELECT id FROM new_users WHERE id = ? AND deleted_at IS NULL').get(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    db.prepare("UPDATE new_users SET deleted_at = datetime('now') WHERE id = ?").run(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/new-users/:id/attempt — bump contact_attempts by +1 or -1
app.post('/api/new-users/:id/attempt', attemptHandler('new_users', 'new_user', 'User not found'));

// ════════════════════════════════════════════════════════════════════════════
// ESTABLISHED USERS ROUTES
// ════════════════════════════════════════════════════════════════════════════

// GET /api/established-users/recent-activity — established users with any activity in the last N days
app.get('/api/established-users/recent-activity', (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 365);
    const sinceParam = `-${days} days`;

    const users = db.prepare(`
      SELECT nu.*,
        (SELECT COUNT(DISTINCT organization_id) FROM new_users nu2
         WHERE lower(nu2.email) = lower(nu.email) AND nu2.deleted_at IS NULL) as org_count,
        ${LAST_ACTIVITY_SQL}
      FROM new_users nu
      WHERE nu.deleted_at IS NULL
        AND ${establishedWindow('nu.date_entered')}
        AND ${RECENT_ACTIVITY_EXISTS_SQL}
      ORDER BY last_activity_at DESC
    `).all(sinceParam, sinceParam, sinceParam, sinceParam, sinceParam);

    if (users.length === 0) return res.json({ users: [], total: 0 });

    // All user row IDs (may include multiple rows for the same email / multi-org users)
    const userIds = users.map(u => u.id);
    const ph = userIds.map(() => '?').join(',');

    // Standard activities tied to a specific record_id (meeting/note/activity log)
    const standardActivities = db.prepare(`
      SELECT 'activity' as type, al.record_id, al.action as label, NULL as extra, al.created_at as date
      FROM activity_log al
      WHERE al.record_type = 'new_user' AND al.record_id IN (${ph})
        AND al.deleted_at IS NULL AND al.created_at >= datetime('now', ?)
        AND al.action NOT IN ('demo_scheduled','meeting_completed','meeting_canceled','note_added')
      UNION ALL
      SELECT 'note', n.record_id, 'note_added', NULL, n.created_at
      FROM notes n
      WHERE n.record_type = 'new_user' AND n.record_id IN (${ph})
        AND n.deleted_at IS NULL AND n.created_at >= datetime('now', ?)
      UNION ALL
      SELECT 'meeting', m.record_id, COALESCE(m.event_name, 'Meeting'), m.status, m.scheduled_at
      FROM meetings m
      WHERE m.record_type = 'new_user' AND m.record_id IN (${ph})
        AND m.deleted_at IS NULL AND m.scheduled_at >= datetime('now', ?)
      ORDER BY date DESC
    `).all(...userIds, sinceParam, ...userIds, sinceParam, ...userIds, sinceParam);

    // External activities matched by email — one row per activity (no JOIN duplication).
    // org_name is returned so JS can match to the right org row for multi-org users.
    const externalActivities = db.prepare(`
      SELECT 'zendesk' as type, lower(zt.requester_email) as email, NULL as org_name,
             zt.subject as label, zt.status as extra, zt.updated_at as date
      FROM zendesk_tickets zt
      WHERE zt.updated_at >= datetime('now', ?)
        AND EXISTS (SELECT 1 FROM new_users nu WHERE lower(nu.email) = lower(zt.requester_email)
                    AND nu.id IN (${ph}) AND nu.deleted_at IS NULL)
      UNION ALL
      SELECT 'support', lower(ls.customer_email), ls.org_name,
             'Support session', NULL, ls.date_created
      FROM support_sessions ls
      WHERE ls.date_created >= datetime('now', ?)
        AND EXISTS (SELECT 1 FROM new_users nu WHERE lower(nu.email) = lower(ls.customer_email)
                    AND nu.id IN (${ph}) AND nu.deleted_at IS NULL)
      ORDER BY date DESC
    `).all(sinceParam, ...userIds, sinceParam, ...userIds);

    // Build email → user rows map (sorted by last_activity_at DESC from outer query)
    const emailToRows = {};
    for (const u of users) {
      const key = (u.email || '').toLowerCase();
      if (!emailToRows[key]) emailToRows[key] = [];
      emailToRows[key].push(u);
    }

    // Standard activities go to byUser by record_id directly
    const byUser = {};
    for (const act of standardActivities) {
      if (!byUser[act.record_id]) byUser[act.record_id] = [];
      byUser[act.record_id].push(act);
    }

    // External activities: assign to the user row whose org_name best matches
    for (const act of externalActivities) {
      const candidates = emailToRows[act.email] || [];
      let target = candidates[0]; // default: most recently active row
      if (candidates.length > 1 && act.org_name) {
        const orgMatch = candidates.find(u =>
          u.org_name && u.org_name.toLowerCase() === act.org_name.toLowerCase()
        );
        if (orgMatch) target = orgMatch;
      }
      if (!target) continue;
      if (!byUser[target.id]) byUser[target.id] = [];
      byUser[target.id].push({ type: act.type, record_id: target.id, label: act.label, extra: act.extra, date: act.date });
    }

    // Dedup by email: keep one entry per person.
    // Prefer the row that received external activities (org-matched), else the most recent row.
    // Merge all standard activities from every org row so none are missed.
    const seenEmails = new Set();
    const result = [];
    for (const u of users) {
      const key = (u.email || '').toLowerCase();
      if (!key || seenEmails.has(key)) continue;
      seenEmails.add(key);

      const group = emailToRows[key] || [];
      const chosen = group.find(gu => (byUser[gu.id] || []).some(a => a.type === 'support' || a.type === 'zendesk'))
        || group[0];

      // Merge standard activities from all org rows + external from the org-chosen row
      const merged = [];
      for (const gu of group) {
        for (const act of (byUser[gu.id] || [])) {
          if (act.type !== 'support' && act.type !== 'zendesk') merged.push(act);
        }
      }
      merged.push(...(byUser[chosen.id] || []).filter(a => a.type === 'support' || a.type === 'zendesk'));
      merged.sort((a, b) => new Date(b.date) - new Date(a.date));

      result.push({ ...chosen, recent_activities: merged.slice(0, 6) });
    }

    res.json({ users: result, total: result.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/established-users/recent-activity/export — CSV of users with recent interactions
app.get('/api/established-users/recent-activity/export', (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 365);
    const sinceParam = `-${days} days`;

    const users = db.prepare(`
      SELECT nu.first_name, nu.last_name, nu.email, nu.org_name,
        ${LAST_ACTIVITY_SQL}
      FROM new_users nu
      WHERE nu.deleted_at IS NULL
        AND ${establishedWindow('nu.date_entered')}
        AND ${RECENT_ACTIVITY_EXISTS_SQL}
      ORDER BY last_activity_at DESC
    `).all(sinceParam, sinceParam, sinceParam, sinceParam, sinceParam);

    const columns = ['first_name','last_name','email','org_name','last_activity_at'];
    const csv = buildCsv(users, columns);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="recent-interactions-${days}d.csv"`);
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/established-users/export — export CSV (BEFORE unparameterized routes)
app.get('/api/established-users/export', (req, res) => {
  try {
    const { search } = req.query;
    let where = ['nu.deleted_at IS NULL'];
    let params = [];

    if (search && search.trim()) {
      pushSearchFilter(where, params, search.trim(), 'nu.');
    } else {
      where.push(establishedWindow('nu.date_entered'));
    }
    const whereClause = 'WHERE ' + where.join(' AND ');
    const users = db.prepare(`
      SELECT nu.*,
        ${LAST_ACTIVITY_SQL}
      FROM new_users nu ${whereClause} ORDER BY nu.date_entered DESC
    `).all(...params);

    const columns = [
      'id','organization_id','org_name','org_url','first_name','last_name','email',
      'user_profile_name','date_entered','last_login','last_transaction_date',
      'training_category','contact_status','assigned_to','crm_org_id',
      'last_activity_at','created_at','updated_at'
    ];
    const csv = buildCsv(users, columns);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="established-users-export.csv"');
    res.send(csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/established-users — list established users; search returns all users with user_type
app.get('/api/established-users', (req, res) => {
  try {
    const { search, limit = 50, offset = 0 } = req.query;
    let where = ['deleted_at IS NULL'];
    let params = [];

    if (search && search.trim()) {
      // Global search: all users, return with user_type
      pushSearchFilter(where, params, search.trim());
    } else {
      // Default: established only (outside the new-user window)
      where.push(establishedWindow());
    }

    const whereClause = 'WHERE ' + where.join(' AND ');

    const users = db.prepare(`
      SELECT *,
        (SELECT COUNT(DISTINCT organization_id) FROM new_users nu2 WHERE lower(nu2.email) = lower(new_users.email) AND nu2.deleted_at IS NULL) as org_count,
        CASE WHEN ${newUserWindow()} THEN 'new_user' ELSE 'established' END as user_type
      FROM new_users ${whereClause}
      ORDER BY date_entered DESC
      LIMIT ? OFFSET ?
    `).all(...params, Number(limit), Number(offset));

    const totalRow = db.prepare(`
      SELECT COUNT(*) as count FROM new_users ${whereClause}
    `).get(...params);

    res.json({ users, total: totalRow.count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// DASHBOARD ROUTES
// ════════════════════════════════════════════════════════════════════════════

// GET /api/dashboard/stats
app.get('/api/dashboard/stats', (req, res) => {
  try {
    // Excludes leads stuck in 'contacted' with no further contact/response in 10+ days —
    // those were inflating the count without any real sign the prospect is still engaged.
    const total_active_leads = db.prepare(`
      SELECT COUNT(*) as count FROM leads
      WHERE deleted_at IS NULL AND (${IS_ACTIVE_LEAD_SQL}) = 1
    `).get().count;

    // Meetings this week: non-canceled rows in the meetings table (Calendly-synced + API-created),
    // plus manually-scheduled meetings that live only on leads/new_users (calendly_event_uri IS NULL).
    // Scheduled + completed both count; only 'canceled' is excluded.
    const meetings_this_week = db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM meetings m
          WHERE m.status != 'canceled'
            AND m.scheduled_at >= datetime('now', 'weekday 0', '-7 days')
            AND m.scheduled_at <  datetime('now', 'weekday 0', '+1 days')
            AND (
              (m.record_type = 'lead'     AND EXISTS (SELECT 1 FROM leads     WHERE id = m.record_id AND deleted_at IS NULL))
              OR (m.record_type = 'new_user' AND EXISTS (SELECT 1 FROM new_users WHERE id = m.record_id AND deleted_at IS NULL))
            )
        )
        + (SELECT COUNT(*) FROM leads
            WHERE calendly_event_uri IS NULL
              AND demo_scheduled_at IS NOT NULL
              AND demo_scheduled_at >= datetime('now', 'weekday 0', '-7 days')
              AND demo_scheduled_at <  datetime('now', 'weekday 0', '+1 days')
              AND deleted_at IS NULL
        )
        + (SELECT COUNT(*) FROM new_users
            WHERE calendly_event_uri IS NULL
              AND demo_scheduled_at IS NOT NULL
              AND demo_scheduled_at >= datetime('now', 'weekday 0', '-7 days')
              AND demo_scheduled_at <  datetime('now', 'weekday 0', '+1 days')
              AND deleted_at IS NULL
        ) AS count
    `).get().count;

    // Leads needing attention: in follow_up stage with no contact bump in 3+ days (or never contacted).
    const leads_need_attention = db.prepare(`
      SELECT COUNT(*) as count FROM leads
      WHERE stage = 'follow_up'
        AND deleted_at IS NULL
        AND (last_contacted_at IS NULL OR last_contacted_at < datetime('now', '-3 days'))
    `).get().count;

    const new_users_last_30_days = db.prepare(`
      SELECT COUNT(*) as count FROM new_users
      WHERE date_entered >= datetime('now', '-30 days')
        AND deleted_at IS NULL
    `).get().count;

    res.json({
      total_active_leads,
      meetings_this_week,
      leads_need_attention,
      new_users_last_30_days,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/activity — last 20 activity_log entries
app.get('/api/dashboard/activity', (req, res) => {
  try {
    const activity = db.prepare(`
      SELECT al.*,
        ${recordNameCase('al')} as record_name,
        ${isEstablishedCase('al')} as is_established,
        CASE
          WHEN al.action IN ('demo_scheduled', 'meeting_canceled') AND al.meeting_id IS NOT NULL THEN
            (SELECT scheduled_at FROM meetings WHERE id = al.meeting_id)
          ELSE NULL
        END as demo_scheduled_at
      FROM activity_log al
      WHERE al.deleted_at IS NULL
        AND (al.record_type != 'lead'     OR EXISTS (SELECT 1 FROM leads     WHERE id = al.record_id AND deleted_at IS NULL))
        AND (al.record_type != 'new_user' OR EXISTS (SELECT 1 FROM new_users WHERE id = al.record_id AND deleted_at IS NULL))
      ORDER BY al.created_at DESC
      LIMIT 20
    `).all();
    res.json(activity);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/meetings-week — meetings for the next 7 days (for the calendar strip)
app.get('/api/dashboard/meetings-week', (req, res) => {
  try {
    const meetings = db.prepare(`
      SELECT
        m.id,
        m.record_type,
        m.record_id,
        m.scheduled_at,
        m.status,
        m.event_name,
        m.invitee_name,
        m.invitee_email,
        m.source_calendar,
        ${contactNameCase('m')} as record_name,
        ${isEstablishedCase('m')} as is_established
      FROM meetings m
      WHERE m.status != 'canceled'
        AND m.deleted_at IS NULL
        AND m.scheduled_at >= datetime('now', 'start of day')
        AND m.scheduled_at <  datetime('now', 'start of day', '+7 days')
        AND (
          (m.record_type = 'lead'      AND EXISTS (SELECT 1 FROM leads     WHERE id = m.record_id AND deleted_at IS NULL))
          OR (m.record_type = 'new_user'  AND EXISTS (SELECT 1 FROM new_users WHERE id = m.record_id AND deleted_at IS NULL))
          OR m.record_type = 'unmatched'
        )
      ORDER BY m.scheduled_at ASC
    `).all();
    res.json(meetings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/outlook-calendar?email=...&start=...&end=...
// Returns the current user's Outlook calendar events for the given window.
// Requires Calendars.Read application permission on the Graph app registration.
app.get('/api/outlook-calendar', async (req, res) => {
  const { email, start, end } = req.query;
  if (!email || !start || !end) return res.status(400).json({ error: 'email, start, and end are required' });
  const member = db.prepare(
    `SELECT id FROM team_members WHERE lower(email) = lower(?) AND active = 1`
  ).get(email);
  if (!member) return res.status(403).json({ error: 'Calendar access is restricted to active team members' });
  if (!graph.isConfigured()) return res.json([]);
  try {
    const events = await graph.getOutlookCalendarEvents(email, start, end);
    res.json(events);
  } catch (err) {
    console.error('Outlook calendar fetch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// TEAM ROUTES
// ════════════════════════════════════════════════════════════════════════════

// GET /api/team
app.get('/api/team', (req, res) => {
  try {
    const members = db.prepare('SELECT * FROM team_members WHERE active = 1 ORDER BY name ASC').all();
    res.json(members);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/team
app.post('/api/team', (req, res) => {
  try {
    const { name, email, role } = req.body;
    if (!name || !email) return res.status(400).json({ error: 'name and email are required' });

    const result = db.prepare(
      'INSERT INTO team_members (name, email, role) VALUES (?, ?, ?)'
    ).run(name, email, role || null);

    const member = db.prepare('SELECT * FROM team_members WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(member);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/team/:id
app.put('/api/team/:id', (req, res) => {
  try {
    const { name, email, role, active } = req.body;
    const member = db.prepare('SELECT * FROM team_members WHERE id = ?').get(req.params.id);
    if (!member) return res.status(404).json({ error: 'Team member not found' });

    const updates = [];
    const params = [];

    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (email !== undefined) { updates.push('email = ?'); params.push(email); }
    if (role !== undefined) { updates.push('role = ?'); params.push(role); }
    if (active !== undefined) { updates.push('active = ?'); params.push(active ? 1 : 0); }

    if (updates.length === 0) return res.status(400).json({ error: 'No valid fields to update' });
    params.push(req.params.id);

    db.prepare(`UPDATE team_members SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    const updated = db.prepare('SELECT * FROM team_members WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// CONFIG ROUTES — Profile Training Map
// ════════════════════════════════════════════════════════════════════════════

// GET /api/config/lead-stages
app.get('/api/config/lead-stages', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM custom_lead_stages ORDER BY sort_order ASC, label ASC').all();
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/config/lead-stages — add new custom stage
app.post('/api/config/lead-stages', (req, res) => {
  try {
    const { label } = req.body;
    if (!label || !label.trim()) return res.status(400).json({ error: 'label is required' });
    const value = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    if (!value) return res.status(400).json({ error: 'label produced an empty value' });
    const existing = db.prepare('SELECT id FROM custom_lead_stages WHERE value = ?').get(value);
    if (existing) return res.status(409).json({ error: 'A stage with this name already exists' });
    const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM custom_lead_stages').get().m || 0;
    db.prepare('INSERT INTO custom_lead_stages (value, label, sort_order) VALUES (?, ?, ?)').run(value, label.trim(), maxOrder + 1);
    const row = db.prepare('SELECT * FROM custom_lead_stages WHERE value = ?').get(value);
    res.status(201).json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/config/lead-stages/:id — rename label
app.put('/api/config/lead-stages/:id', (req, res) => {
  try {
    const { label } = req.body;
    if (!label || !label.trim()) return res.status(400).json({ error: 'label is required' });
    const row = db.prepare('SELECT * FROM custom_lead_stages WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Stage not found' });
    db.prepare('UPDATE custom_lead_stages SET label = ? WHERE id = ?').run(label.trim(), req.params.id);
    res.json(db.prepare('SELECT * FROM custom_lead_stages WHERE id = ?').get(req.params.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/config/lead-stages/:id
app.delete('/api/config/lead-stages/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM custom_lead_stages WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Stage not found' });
    const inUse = db.prepare('SELECT COUNT(*) as count FROM leads WHERE stage = ? AND deleted_at IS NULL').get(row.value).count;
    if (inUse > 0) return res.status(409).json({ error: `Cannot delete — ${inUse} lead(s) are currently in this stage` });
    db.prepare('DELETE FROM custom_lead_stages WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Note Topics config ───────────────────────────────────────────────────

// GET /api/config/note-topics
app.get('/api/config/note-topics', (req, res) => {
  try {
    res.json(db.prepare('SELECT * FROM note_topics ORDER BY sort_order ASC, name ASC').all());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/config/note-topics — { name } → create
app.post('/api/config/note-topics', (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    const maxOrder = db.prepare('SELECT MAX(sort_order) as m FROM note_topics').get().m ?? 0;
    const result = db.prepare('INSERT INTO note_topics (name, sort_order) VALUES (?, ?)').run(name.trim(), maxOrder + 1);
    res.status(201).json(db.prepare('SELECT * FROM note_topics WHERE id = ?').get(result.lastInsertRowid));
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'A topic with this name already exists' });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/config/note-topics/:id — { name } → rename
app.put('/api/config/note-topics/:id', (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'name is required' });
    const row = db.prepare('SELECT * FROM note_topics WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Topic not found' });
    db.prepare('UPDATE note_topics SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
    res.json(db.prepare('SELECT * FROM note_topics WHERE id = ?').get(req.params.id));
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'A topic with this name already exists' });
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/config/note-topics/:id — only if no notes reference it
app.delete('/api/config/note-topics/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM note_topics WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Topic not found' });
    const inUse = db.prepare('SELECT COUNT(*) as count FROM notes WHERE topic = ? AND deleted_at IS NULL').get(row.name).count;
    if (inUse > 0) return res.status(409).json({ error: `Cannot delete — ${inUse} note(s) use this topic` });
    db.prepare('DELETE FROM note_topics WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/config/app — returns all app_config rows as { key: value } object
app.get('/api/config/app', (req, res) => {
  try {
    const rows = db.prepare('SELECT key, value FROM app_config').all();
    const config = {};
    for (const row of rows) config[row.key] = row.value;
    res.json(config);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/config/app/:key — upsert a single app config value
app.put('/api/config/app/:key', (req, res) => {
  try {
    const { value } = req.body;
    if (value === undefined) return res.status(400).json({ error: 'value is required' });
    db.prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)').run(req.params.key, value);
    res.json({ key: req.params.key, value });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/config/profile-map
app.get('/api/config/profile-map', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM profile_training_map ORDER BY user_profile_name_value ASC').all();
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/config/profile-map — add or update
app.post('/api/config/profile-map', (req, res) => {
  try {
    const { user_profile_name_value, training_category } = req.body;
    if (!user_profile_name_value || !training_category) {
      return res.status(400).json({ error: 'user_profile_name_value and training_category are required' });
    }

    db.prepare(`
      INSERT INTO profile_training_map (user_profile_name_value, training_category)
      VALUES (?, ?)
      ON CONFLICT(user_profile_name_value) DO UPDATE SET training_category = excluded.training_category
    `).run(user_profile_name_value, training_category);

    const row = db.prepare('SELECT * FROM profile_training_map WHERE user_profile_name_value = ?').get(user_profile_name_value);
    res.status(201).json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/config/profile-map/:id
app.delete('/api/config/profile-map/:id', (req, res) => {
  try {
    const row = db.prepare('SELECT * FROM profile_training_map WHERE id = ?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Mapping not found' });

    db.prepare('DELETE FROM profile_training_map WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ORGANIZATIONS ROUTES
// ════════════════════════════════════════════════════════════════════════════

// GET /api/orgs/search?q= — typeahead search by org name or account number
app.get('/api/orgs/search', (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) return res.json([]);

    const term = `%${q.trim()}%`;
    const rows = db.prepare(`
      SELECT account_number, org_name, crm_org_id
      FROM organizations
      WHERE org_name LIKE ? OR account_number LIKE ?
      ORDER BY org_name ASC
      LIMIT 20
    `).all(term, term);

    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orgs/lookup?account_number= — exact match by account number
app.get('/api/orgs/lookup', (req, res) => {
  try {
    const { account_number } = req.query;
    if (!account_number) return res.status(400).json({ error: 'account_number is required' });

    const org = db.prepare(
      'SELECT account_number, org_name, crm_org_id FROM organizations WHERE account_number = ?'
    ).get(account_number.trim());

    if (!org) return res.status(404).json({ error: 'Organization not found' });
    res.json(org);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SCHEDULED SYNC — daily new-user CSV from a shared drive (Microsoft Graph)
// ════════════════════════════════════════════════════════════════════════════

const SHARED_DRIVE_SITE_ID   = process.env.SHARED_DRIVE_SITE_ID;
const SHARED_DRIVE_FILE_PATH = process.env.SHARED_DRIVE_FILE_PATH;
const sharedDriveConfigured = () =>
  integrations.isMock || !!(graph.isConfigured() && SHARED_DRIVE_SITE_ID && SHARED_DRIVE_FILE_PATH);

async function runScheduledImport() {
  try {
    if (!sharedDriveConfigured()) {
      console.log('[sync] Shared-drive import not configured; skipping');
      return { imported: 0, skipped: 0, errors: ['config missing'] };
    }

    const meta = await graph.getFileMetadata(SHARED_DRIVE_SITE_ID, SHARED_DRIVE_FILE_PATH);

    // Change detection: the file's lastModifiedDateTime is the cursor.
    const state = db.prepare("SELECT last_cursor FROM poll_state WHERE service = 'shared_drive_csv'").get();
    const lastCursor = state ? state.last_cursor : '';
    if (lastCursor === meta.lastModifiedDateTime) {
      console.log('[sync] No changes detected, skipping import');
      return { imported: 0, skipped: 0, errors: [], unchanged: true };
    }

    console.log(`[sync] File changed (${meta.lastModifiedDateTime}), downloading…`);
    const csvText = await graph.downloadFile(SHARED_DRIVE_SITE_ID, SHARED_DRIVE_FILE_PATH);
    const result = importNewUsersFromCsv(csvText);
    console.log(`[sync] Done — imported: ${result.imported}, skipped: ${result.skipped}, errors: ${result.errors.length}`);

    db.prepare(`
      INSERT INTO poll_state (service, last_polled_at, last_cursor)
      VALUES ('shared_drive_csv', CURRENT_TIMESTAMP, ?)
      ON CONFLICT(service) DO UPDATE SET last_polled_at = CURRENT_TIMESTAMP, last_cursor = excluded.last_cursor
    `).run(meta.lastModifiedDateTime);

    return result;
  } catch (err) {
    console.error('[sync] Error during scheduled import:', err.message);
    return { imported: 0, skipped: 0, errors: [err.message] };
  }
}

// Run once on startup, then every 2 hours so users added during the day show up the same day
if (process.env.NODE_ENV !== 'test') {
  runScheduledImport().catch(err => console.error('[sync] Startup import error:', err.message));
  cron.schedule('0 */2 * * *', () =>
    runScheduledImport().catch(err => console.error('[sync] Cron import error:', err.message))
  );
}

// GET /api/sync/status — last sync info
app.get('/api/sync/status', async (req, res) => {
  try {
    const state = db.prepare("SELECT last_polled_at, last_cursor FROM poll_state WHERE service = 'shared_drive_csv'").get();
    const base = {
      last_synced_at: state ? state.last_polled_at : null,
      configured: sharedDriveConfigured(),
      mock: integrations.isMock,
      file_path: SHARED_DRIVE_FILE_PATH || (integrations.isMock ? 'data/sample/new-users-import.csv' : null),
    };
    if (!base.configured) return res.json({ ...base, graph_reachable: false, graph_error: 'Shared-drive import not configured' });
    try {
      const meta = await graph.getFileMetadata(SHARED_DRIVE_SITE_ID, SHARED_DRIVE_FILE_PATH);
      res.json({ ...base, graph_reachable: true, file_name: meta.name, file_size: meta.size, file_last_modified: meta.lastModifiedDateTime });
    } catch (err) {
      res.json({ ...base, graph_reachable: false, graph_error: err.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sync/run — force a manual re-import
app.post('/api/sync/run', async (req, res) => {
  try {
    db.prepare(`
      INSERT INTO poll_state (service, last_polled_at, last_cursor)
      VALUES ('shared_drive_csv', CURRENT_TIMESTAMP, '')
      ON CONFLICT(service) DO UPDATE SET last_cursor = ''
    `).run();
    const result = await runScheduledImport();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// CALENDLY POLLING
// ════════════════════════════════════════════════════════════════════════════

function upsertMeeting(recordType, recordId, eventUri, eventName, startTime, status, inviteeName = null, inviteeEmail = null, sourceCalendar = null) {
  const existing = db.prepare(
    `SELECT id FROM meetings WHERE calendly_event_uri = ? AND record_type = ? AND record_id = ?`
  ).get(eventUri, recordType, recordId);

  if (existing) {
    // Never regress a completed or canceled meeting back to scheduled — poller keeps seeing
    // active events (past meetings, or in-app cancels Calendly doesn't know about) and would
    // otherwise reset status on every poll cycle.
    db.prepare(`UPDATE meetings SET status=CASE WHEN status IN ('completed','canceled') THEN status ELSE ? END, event_name=?, scheduled_at=?, invitee_name=COALESCE(invitee_name,?), invitee_email=COALESCE(invitee_email,?), source_calendar=COALESCE(source_calendar,?), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(status, eventName, startTime, inviteeName, inviteeEmail, sourceCalendar, existing.id);
    return existing.id;
  } else {
    const result = db.prepare(`
      INSERT INTO meetings (record_type, record_id, event_name, calendly_event_uri, scheduled_at, status, invitee_name, invitee_email, source_calendar)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(recordType, recordId, eventName, eventUri, startTime, status, inviteeName, inviteeEmail, sourceCalendar);
    return result.lastInsertRowid;
  }
}

function upsertUnmatchedMeeting(eventUri, eventName, startTime, status, inviteeName, inviteeEmail, sourceCalendar = null) {
  const existing = db.prepare(
    `SELECT id FROM meetings WHERE calendly_event_uri = ? AND record_type = 'unmatched'`
  ).get(eventUri);

  if (existing) {
    db.prepare(`UPDATE meetings SET status=CASE WHEN status IN ('completed','canceled') THEN status ELSE ? END, event_name=?, scheduled_at=?, source_calendar=COALESCE(source_calendar,?), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(status, eventName, startTime, sourceCalendar, existing.id);
    return existing.id;
  } else {
    const result = db.prepare(`
      INSERT INTO meetings (record_type, record_id, event_name, calendly_event_uri, scheduled_at, status, invitee_name, invitee_email, source_calendar)
      VALUES ('unmatched', 0, ?, ?, ?, ?, ?, ?, ?)
    `).run(eventName, eventUri, startTime, status, inviteeName, inviteeEmail, sourceCalendar);
    return result.lastInsertRowid;
  }
}

function applyCalendlyEvent(event, invitees) {
  const isActive   = event.status === 'active';
  const isCanceled = event.status === 'canceled';
  const eventUri   = event.uri;
  const startTime  = event.start_time;
  const eventName  = event.name;
  const dateStr    = new Date(startTime).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

  let anyMatched = false;
  let firstInviteeName = null;
  let firstInviteeEmail = null;

  for (const invitee of invitees) {
    const email = (invitee.email || '').toLowerCase();
    if (!email) continue;

    if (!firstInviteeEmail) {
      firstInviteeName  = invitee.name || null;
      firstInviteeEmail = email;
    }

    // ── Leads ──
    const lead = db.prepare(
      `SELECT id, stage FROM leads WHERE lower(email) = ? AND deleted_at IS NULL AND stage NOT IN ('converted','lost')`
    ).get(email);

    if (lead) {
      anyMatched = true;
      const existingMeeting = db.prepare(
        `SELECT id, status FROM meetings WHERE calendly_event_uri=? AND record_type='lead' AND record_id=?`
      ).get(eventUri, lead.id);

      if (isActive) {
        const isNew = !existingMeeting;
        const meetingId = upsertMeeting('lead', lead.id, eventUri, eventName, startTime, 'scheduled', invitee.name, email);
        // Only auto-advance stage when the meeting is first discovered — re-polling the same
        // active event must not overwrite stage changes the team made since (e.g. back to contacted).
        if (isNew) {
          if (lead.stage === 'new_inquiry' || lead.stage === 'contacted') {
            db.prepare(`UPDATE leads SET stage='demo_scheduled', calendly_event_uri=?, demo_scheduled_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
              .run(eventUri, startTime, lead.id);
          }
          logActivity('lead', lead.id, 'demo_scheduled', `Meeting scheduled via Calendly: ${eventName} — ${dateStr}`, 'Calendly', meetingId);
          console.log(`[calendly] Lead #${lead.id} (${email}) → demo_scheduled (new)`);
        }
      } else if (isCanceled && existingMeeting && existingMeeting.status !== 'canceled') {
        db.prepare(`UPDATE meetings SET status='canceled', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(existingMeeting.id);
        db.prepare(`UPDATE leads SET stage='contacted', calendly_event_uri=NULL, demo_scheduled_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND calendly_event_uri=?`)
          .run(lead.id, eventUri);
        markActivityCanceled('lead', lead.id, existingMeeting.id, `Calendly meeting canceled: ${eventName}`, 'Calendly');
        console.log(`[calendly] Lead #${lead.id} (${email}) → meeting canceled`);
      }
    }

    // ── New Users ──
    const user = db.prepare(
      `SELECT id, contact_status FROM new_users WHERE lower(email) = ? AND deleted_at IS NULL`
    ).get(email);

    if (user) {
      anyMatched = true;
      const existingMeeting = db.prepare(
        `SELECT id, status FROM meetings WHERE calendly_event_uri=? AND record_type='new_user' AND record_id=?`
      ).get(eventUri, user.id);

      if (isActive) {
        const isNew = !existingMeeting;
        const meetingId = upsertMeeting('new_user', user.id, eventUri, eventName, startTime, 'scheduled', invitee.name, email);
        // Only auto-advance status when the meeting is first discovered — re-polling the same
        // active event must not overwrite status changes the team made since.
        if (isNew) {
          if (user.contact_status === 'not_contacted' || user.contact_status === 'contacted') {
            db.prepare(`UPDATE new_users SET contact_status='demo_scheduled', calendly_event_uri=?, demo_scheduled_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
              .run(eventUri, startTime, user.id);
          }
          logActivity('new_user', user.id, 'demo_scheduled', `Meeting scheduled via Calendly: ${eventName} — ${dateStr}`, 'Calendly', meetingId);
          console.log(`[calendly] New user #${user.id} (${email}) → demo_scheduled (new)`);
        }
      } else if (isCanceled && existingMeeting && existingMeeting.status !== 'canceled') {
        db.prepare(`UPDATE meetings SET status='canceled', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(existingMeeting.id);
        db.prepare(`UPDATE new_users SET contact_status='contacted', calendly_event_uri=NULL, demo_scheduled_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=? AND calendly_event_uri=?`)
          .run(user.id, eventUri);
        markActivityCanceled('new_user', user.id, existingMeeting.id, `Calendly meeting canceled: ${eventName}`, 'Calendly');
        console.log(`[calendly] New user #${user.id} (${email}) → meeting canceled`);
      }
    }
  }

  // ── Unmatched: no lead or new_user found for any invitee ──
  // Still store the meeting so it shows on the calendar.
  if (!anyMatched && firstInviteeEmail) {
    if (isActive) {
      upsertUnmatchedMeeting(eventUri, eventName, startTime, 'scheduled', firstInviteeName, firstInviteeEmail);
      console.log(`[calendly] Unmatched event stored: ${eventName} (${firstInviteeEmail})`);
    } else if (isCanceled) {
      const existing = db.prepare(`SELECT id FROM meetings WHERE calendly_event_uri=? AND record_type='unmatched'`).get(eventUri);
      if (existing) {
        db.prepare(`UPDATE meetings SET status='canceled', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(existing.id);
      }
    }
  }
}

function autoCompletePastMeetings() {
  const pastMeetings = db.prepare(`
    SELECT * FROM meetings
    WHERE status = 'scheduled'
      AND scheduled_at < datetime('now', '-1 hour')
      AND deleted_at IS NULL
  `).all();

  for (const meeting of pastMeetings) {
    const completedAt = new Date().toISOString();
    db.prepare(`UPDATE meetings SET status='completed', completed_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(completedAt, meeting.id);

    if (meeting.record_type === 'new_user') {
      // Only update contact_status for actual New Users, not Established Users
      const isNewUser = db.prepare(
        `SELECT 1 FROM new_users WHERE id=? AND ${newUserWindow()}`
      ).get(meeting.record_id);
      if (isNewUser) {
        db.prepare(`UPDATE new_users SET contact_status='demo_completed', demo_completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(meeting.record_id);
      }
    } else if (meeting.record_type === 'lead') {
      db.prepare(`UPDATE leads SET demo_completed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(meeting.record_id);
    }

    console.log(`[calendly] Auto-completed meeting #${meeting.id} "${meeting.event_name}" for ${meeting.record_type} #${meeting.record_id}`);
  }

  return pastMeetings.length;
}

async function runCalendlyPoll(minStartTime, maxStartTime) {
  if (!calendly.isConfigured()) {
    console.log('[calendly] No tokens configured, skipping');
    return { active: 0, canceled: 0 };
  }

  const autoCompleted = autoCompletePastMeetings();
  if (autoCompleted > 0) console.log(`[calendly] Auto-completed ${autoCompleted} past meeting(s)`);

  const min = minStartTime || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const max = maxStartTime || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  console.log(`[calendly] Polling ${calendly.accountCount()} account(s): ${min} → ${max}`);

  let active = 0, canceled = 0;
  try {
    const events = await calendly.fetchEvents({ minStartTime: min, maxStartTime: max });
    for (const event of events) {
      try {
        applyCalendlyEvent(event, event.invitees || []);
        if (event.status === 'canceled') canceled++; else active++;
      } catch (err) {
        console.error(`[calendly] Error on event ${event.uri}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[calendly] Error fetching events:', err.message);
  }

  db.prepare(`INSERT INTO poll_state (service, last_polled_at) VALUES ('calendly', CURRENT_TIMESTAMP)
    ON CONFLICT(service) DO UPDATE SET last_polled_at = CURRENT_TIMESTAMP`).run();

  console.log(`[calendly] Poll complete — ${active} active, ${canceled} canceled, ${autoCompleted} auto-completed`);
  return { active, canceled, auto_completed: autoCompleted };
}

// Run on startup + every 5 minutes
if (process.env.NODE_ENV !== 'test') {
  runCalendlyPoll().catch(err => console.error('[calendly] Startup poll error:', err.message));
  cron.schedule('*/5 * * * *', () =>
    runCalendlyPoll().catch(err => console.error('[calendly] Cron poll error:', err.message))
  );
}

// GET /api/calendly/status
app.get('/api/calendly/status', (req, res) => {
  const state = db.prepare(`SELECT last_polled_at FROM poll_state WHERE service = 'calendly'`).get();
  res.json({
    configured: calendly.isConfigured(),
    accounts: calendly.accountCount(),
    mock: integrations.isMock,
    last_polled_at: state?.last_polled_at || null,
  });
});

// POST /api/calendly/poll — manual trigger
app.post('/api/calendly/poll', async (req, res) => {
  try {
    const result = await runCalendlyPoll();
    const state = db.prepare(`SELECT last_polled_at FROM poll_state WHERE service = 'calendly'`).get();
    res.json({ success: true, ...result, last_polled_at: state?.last_polled_at });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/calendly/backfill — YTD historical backfill
app.post('/api/calendly/backfill', async (req, res) => {
  try {
    const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString();
    const yearEnd   = new Date(new Date().getFullYear(), 11, 31, 23, 59, 59).toISOString();
    console.log(`[calendly] Starting YTD backfill: ${yearStart} → ${yearEnd}`);
    const result = await runCalendlyPoll(yearStart, yearEnd);
    res.json({ success: true, ...result, range: { from: yearStart, to: yearEnd } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// OUTLOOK CALENDAR POLLING
// ════════════════════════════════════════════════════════════════════════════

// Team members' calendars are read through Graph; external attendees are matched to leads/users.
async function runOutlookCalendarPoll(minStartTime, maxStartTime) {
  if (!graph.isConfigured()) {
    console.log('[outlook] Graph not configured, skipping');
    return { matched: 0 };
  }
  const teamMembers = db.prepare(
    `SELECT email, name FROM team_members WHERE active = 1 AND email IS NOT NULL AND email != ''`
  ).all();

  if (teamMembers.length === 0) {
    console.log('[outlook] No team members with email configured, skipping');
    return { matched: 0 };
  }

  const teamEmails = new Set(teamMembers.map(m => m.email.toLowerCase()));
  // Optional TEAM_EMAIL_DOMAINS (comma-separated) marks whole domains as internal so unlisted
  // colleagues aren't mistaken for external contacts.
  const internalDomains = new Set(
    String(process.env.TEAM_EMAIL_DOMAINS || '').split(',').map(d => d.trim().toLowerCase()).filter(Boolean)
  );
  const start = minStartTime || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const end   = maxStartTime || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  console.log(`[outlook] Polling ${teamMembers.length} calendar(s): ${start} → ${end}`);

  let totalMatched = 0;

  for (const member of teamMembers) {
    try {
      const events = await graph.getOutlookCalendarEvents(member.email, start, end);
      let memberMatched = 0;
      for (const event of events) {
        const eventKey  = `outlook:${event.iCalUId || event.id}`;
        const startTime = event.start?.dateTime ? event.start.dateTime.replace(/(\.\d+)?$/, 'Z') : null;
        if (!startTime) continue;
        const eventName = event.subject || 'Meeting';

        // Build list of all participants (attendees + organizer) who are not on the team.
        // Organizer is separate from attendees in Graph API — meetings created by an external
        // person and sent to team members would otherwise appear as internal-only.
        const allParticipants = [
          ...(event.attendees || []).map(a => a.emailAddress),
          event.organizer?.emailAddress,
        ].filter(Boolean);
        const external = allParticipants
          .map(e => ({ name: e.name || null, email: (e.address || '').toLowerCase() }))
          .filter((a, i, arr) => a.email && !teamEmails.has(a.email) && !internalDomains.has(a.email.split('@')[1]) && arr.findIndex(x => x.email === a.email) === i);

        if (external.length === 0) continue; // purely internal, skip

        // Match the first external attendee found in leads or new_users — one entry per event
        let matched = false;
        for (const att of external) {
          const lead = db.prepare(
            `SELECT id FROM leads WHERE LOWER(email) = ? AND deleted_at IS NULL AND stage NOT IN ('converted','lost')`
          ).get(att.email);
          if (lead) {
            upsertMeeting('lead', lead.id, eventKey, eventName, startTime, 'scheduled', att.name, att.email, member.name);
            memberMatched++;
            matched = true;
            break;
          }
          const user = db.prepare(
            `SELECT id FROM new_users WHERE LOWER(email) = ? AND deleted_at IS NULL`
          ).get(att.email);
          if (user) {
            upsertMeeting('new_user', user.id, eventKey, eventName, startTime, 'scheduled', att.name, att.email, member.name);
            memberMatched++;
            matched = true;
            break;
          }
        }
        if (!matched) {
          const first = external[0];
          upsertUnmatchedMeeting(eventKey, eventName, startTime, 'scheduled', first.name, first.email, member.name);
          memberMatched++;
        }
      }
      totalMatched += memberMatched;
      console.log(`[outlook] ${member.email}: ${events.length} event(s), ${memberMatched} matched`);
    } catch (err) {
      console.error(`[outlook] Error polling ${member.email}: ${err.message}`);
    }
  }

  db.prepare(`INSERT INTO poll_state (service, last_polled_at) VALUES ('outlook_calendar', CURRENT_TIMESTAMP)
    ON CONFLICT(service) DO UPDATE SET last_polled_at = CURRENT_TIMESTAMP`).run();

  console.log(`[outlook] Poll complete — ${totalMatched} matched`);
  return { matched: totalMatched };
}

// Run on startup + every 5 minutes
if (process.env.NODE_ENV !== 'test') {
  runOutlookCalendarPoll().catch(err => console.error('[outlook] Startup poll error:', err.message));
  cron.schedule('*/5 * * * *', () =>
    runOutlookCalendarPoll().catch(err => console.error('[outlook] Cron poll error:', err.message))
  );
}

// GET /api/outlook/status
app.get('/api/outlook/status', (req, res) => {
  const teamCount = db.prepare(
    `SELECT COUNT(*) as count FROM team_members WHERE active = 1 AND email IS NOT NULL AND email != ''`
  ).get().count;
  const state = db.prepare(`SELECT last_polled_at FROM poll_state WHERE service = 'outlook_calendar'`).get();
  res.json({
    configured: graph.isConfigured() && teamCount > 0,
    team_members: teamCount,
    last_polled_at: state?.last_polled_at || null,
  });
});

// POST /api/outlook/poll — manual trigger
app.post('/api/outlook/poll', async (req, res) => {
  try {
    const result = await runOutlookCalendarPoll();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/outlook/backfill — YTD backfill
app.post('/api/outlook/backfill', async (req, res) => {
  try {
    const yearStart = new Date(new Date().getFullYear(), 0, 1).toISOString();
    const yearEnd   = new Date(new Date().getFullYear(), 11, 31, 23, 59, 59).toISOString();
    console.log(`[outlook] Starting YTD backfill: ${yearStart} → ${yearEnd}`);
    const result = await runOutlookCalendarPoll(yearStart, yearEnd);
    res.json({ success: true, ...result, range: { from: yearStart, to: yearEnd } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ZENDESK TICKET POLLER
// ════════════════════════════════════════════════════════════════════════════

async function runZendeskPoll() {
  if (!zendesk.isConfigured()) {
    console.log('[zendesk] Not configured, skipping');
    return { synced: 0, total: 0, endTime: null };
  }
  const state = db.prepare("SELECT last_cursor FROM poll_state WHERE service = 'zendesk_tickets'").get();
  // Default: 90 days ago as Unix timestamp
  const ninetyDaysAgo = Math.floor(Date.now() / 1000) - 90 * 24 * 60 * 60;
  const sinceTimestamp = state && state.last_cursor ? parseInt(state.last_cursor) : ninetyDaysAgo;

  const { tickets, users, endTime } = await zendesk.pollRecentTickets(sinceTimestamp);

  // Build requester_id → email map from sideloaded users
  const emailByZdUserId = {};
  for (const u of users) {
    if (u.email) emailByZdUserId[u.id] = u.email.toLowerCase();
  }

  const upsert = db.prepare(`
    INSERT INTO zendesk_tickets (zendesk_ticket_id, requester_email, subject, status, created_at, updated_at, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(zendesk_ticket_id) DO UPDATE SET
      requester_email = excluded.requester_email,
      subject = excluded.subject,
      status = excluded.status,
      updated_at = excluded.updated_at,
      last_synced_at = CURRENT_TIMESTAMP
  `);

  let synced = 0;
  db.transaction(() => {
    for (const t of tickets) {
      const email = emailByZdUserId[t.requester_id];
      if (!email) continue;
      upsert.run(t.id, email, t.subject || '(no subject)', t.status, toSqliteDateTime(t.created_at), toSqliteDateTime(t.updated_at));
      synced++;
    }
  })();

  if (endTime) {
    db.prepare(`
      INSERT INTO poll_state (service, last_polled_at, last_cursor)
      VALUES ('zendesk_tickets', CURRENT_TIMESTAMP, ?)
      ON CONFLICT(service) DO UPDATE SET last_polled_at = CURRENT_TIMESTAMP, last_cursor = excluded.last_cursor
    `).run(String(endTime));
  }

  console.log(`[zendesk] Poll complete — ${synced}/${tickets.length} tickets synced, cursor → ${endTime}`);
  return { synced, total: tickets.length, endTime };
}

// Run on startup + every 30 minutes
if (process.env.NODE_ENV !== 'test') {
  runZendeskPoll().catch(err => console.error('[zendesk] Startup poll error:', err.message));
  cron.schedule('*/30 * * * *', () =>
    runZendeskPoll().catch(err => console.error('[zendesk] Cron poll error:', err.message))
  );
}

// GET /api/zendesk/status
app.get('/api/zendesk/status', (req, res) => {
  const state = db.prepare(`SELECT last_polled_at FROM poll_state WHERE service = 'zendesk_tickets'`).get();
  res.json({
    configured: zendesk.isConfigured(),
    last_polled_at: state?.last_polled_at || null,
  });
});

// POST /api/zendesk/poll — manual trigger
app.post('/api/zendesk/poll', async (req, res) => {
  try {
    const result = await runZendeskPoll();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/zendesk/backfill — pull from a specific date (YYYY-MM-DD) and reset cursor
app.post('/api/zendesk/backfill', async (req, res) => {
  try {
    const { since } = req.body;
    const sinceTimestamp = since
      ? Math.floor(new Date(since).getTime() / 1000)
      : Math.floor(Date.now() / 1000) - 365 * 24 * 60 * 60;
    // Reset cursor so next regular poll starts fresh from this point
    db.prepare(`
      INSERT INTO poll_state (service, last_polled_at, last_cursor)
      VALUES ('zendesk_tickets', CURRENT_TIMESTAMP, ?)
      ON CONFLICT(service) DO UPDATE SET last_polled_at = CURRENT_TIMESTAMP, last_cursor = excluded.last_cursor
    `).run(String(sinceTimestamp));
    const result = await runZendeskPoll();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// SUPPORT SESSIONS POLLER — session history from the sibling support-notes app
// ════════════════════════════════════════════════════════════════════════════

async function runSupportSessionsPoll() {
  if (!supportSessions.isConfigured()) {
    console.log('[support-sessions] Not configured, skipping');
    return { synced: 0 };
  }
  const sessions = await supportSessions.listSessions();

  const upsert = db.prepare(`
    INSERT INTO support_sessions (session_id, customer_email, customer_name, org_name, date_created, last_synced_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(session_id) DO UPDATE SET
      customer_email = excluded.customer_email,
      customer_name = excluded.customer_name,
      org_name = excluded.org_name,
      date_created = excluded.date_created,
      last_synced_at = CURRENT_TIMESTAMP
  `);

  let synced = 0;
  db.transaction(() => {
    for (const sess of sessions) {
      if (!sess.customer_email) continue;
      upsert.run(sess.id, sess.customer_email.toLowerCase(), sess.customer_name || null, sess.org_name || null, toSqliteDateTime(sess.date_created));
      synced++;
    }
  })();

  db.prepare(`
    INSERT INTO poll_state (service, last_polled_at, last_cursor)
    VALUES ('support_sessions', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(service) DO UPDATE SET last_polled_at = CURRENT_TIMESTAMP, last_cursor = CURRENT_TIMESTAMP
  `).run();

  console.log(`[support-sessions] Poll complete — ${synced} sessions synced`);
  return { synced };
}

// Run on startup + every 30 minutes (skipped gracefully if the support-notes app is down)
if (process.env.NODE_ENV !== 'test') {
  runSupportSessionsPoll().catch(err => console.warn('[support-sessions] Startup poll skipped:', err.message));
  cron.schedule('*/30 * * * *', () =>
    runSupportSessionsPoll().catch(err => console.warn('[support-sessions] Cron poll skipped:', err.message))
  );
}

// GET /api/support-sessions/status
app.get('/api/support-sessions/status', (req, res) => {
  const state = db.prepare(`SELECT last_polled_at FROM poll_state WHERE service = 'support_sessions'`).get();
  res.json({ configured: supportSessions.isConfigured(), last_polled_at: state?.last_polled_at || null });
});

// POST /api/support-sessions/poll — manual trigger
app.post('/api/support-sessions/poll', async (req, res) => {
  try {
    const result = await runSupportSessionsPoll();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
// ZOOM POLLER — meetings on the team's Zoom account, matched by participant email
// ════════════════════════════════════════════════════════════════════════════

// Same matching rules as Calendly: first discovery of a scheduled meeting advances the
// lead/user; re-polling never overwrites stage changes the team made since.
function applyZoomMeeting(m) {
  const eventKey = `zoom:${m.id}`;
  const status   = m.status === 'completed' ? 'completed' : 'scheduled';
  let matched = false;

  for (const p of m.participants || []) {
    const email = (p.email || '').toLowerCase();
    if (!email) continue;

    const lead = db.prepare(
      `SELECT id, stage FROM leads WHERE lower(email) = ? AND deleted_at IS NULL AND stage NOT IN ('converted','lost')`
    ).get(email);
    if (lead) {
      matched = true;
      const isNew = !db.prepare(`SELECT id FROM meetings WHERE calendly_event_uri = ? AND record_type = 'lead' AND record_id = ?`).get(eventKey, lead.id);
      const meetingId = upsertMeeting('lead', lead.id, eventKey, m.topic, m.start_time, status, p.name, email, 'Zoom');
      db.prepare('UPDATE meetings SET zoom_meeting_id = ? WHERE id = ?').run(m.id, meetingId);
      if (isNew && status === 'scheduled') {
        if (lead.stage === 'new_inquiry' || lead.stage === 'contacted') {
          db.prepare(`UPDATE leads SET stage='demo_scheduled', zoom_meeting_id=?, demo_scheduled_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
            .run(m.id, m.start_time, lead.id);
        }
        logActivity('lead', lead.id, 'demo_scheduled', `Meeting scheduled via Zoom: ${m.topic} — ${fmtMeetingDate(m.start_time)}`, 'Zoom', meetingId);
      }
    }

    const user = db.prepare(`SELECT id, contact_status FROM new_users WHERE lower(email) = ? AND deleted_at IS NULL`).get(email);
    if (user) {
      matched = true;
      const isNew = !db.prepare(`SELECT id FROM meetings WHERE calendly_event_uri = ? AND record_type = 'new_user' AND record_id = ?`).get(eventKey, user.id);
      const meetingId = upsertMeeting('new_user', user.id, eventKey, m.topic, m.start_time, status, p.name, email, 'Zoom');
      db.prepare('UPDATE meetings SET zoom_meeting_id = ? WHERE id = ?').run(m.id, meetingId);
      if (isNew && status === 'scheduled') {
        if (user.contact_status === 'not_contacted' || user.contact_status === 'contacted') {
          db.prepare(`UPDATE new_users SET contact_status='demo_scheduled', zoom_meeting_id=?, demo_scheduled_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
            .run(m.id, m.start_time, user.id);
        }
        logActivity('new_user', user.id, 'demo_scheduled', `Meeting scheduled via Zoom: ${m.topic} — ${fmtMeetingDate(m.start_time)}`, 'Zoom', meetingId);
      }
    }
  }

  if (!matched) {
    const first = (m.participants || []).find(p => p.email);
    if (first) upsertUnmatchedMeeting(eventKey, m.topic, m.start_time, status, first.name || null, first.email.toLowerCase(), 'Zoom');
  }
  return matched;
}

async function runZoomPoll(minStartTime, maxStartTime) {
  if (!zoom.isConfigured()) {
    console.log('[zoom] Not configured, skipping');
    return { meetings: 0, matched: 0 };
  }
  const min = minStartTime || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const max = maxStartTime || new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();

  let total = 0, matched = 0;
  try {
    const meetings = await zoom.fetchMeetings({ minStartTime: min, maxStartTime: max });
    total = meetings.length;
    for (const m of meetings) {
      try { if (applyZoomMeeting(m)) matched++; }
      catch (err) { console.error(`[zoom] Error on meeting ${m.id}:`, err.message); }
    }
  } catch (err) {
    console.error('[zoom] Error fetching meetings:', err.message);
  }

  db.prepare(`INSERT INTO poll_state (service, last_polled_at) VALUES ('zoom', CURRENT_TIMESTAMP)
    ON CONFLICT(service) DO UPDATE SET last_polled_at = CURRENT_TIMESTAMP`).run();

  console.log(`[zoom] Poll complete — ${total} meeting(s), ${matched} matched`);
  return { meetings: total, matched };
}

// Run on startup + every 5 minutes
if (process.env.NODE_ENV !== 'test') {
  runZoomPoll().catch(err => console.error('[zoom] Startup poll error:', err.message));
  cron.schedule('*/5 * * * *', () =>
    runZoomPoll().catch(err => console.error('[zoom] Cron poll error:', err.message))
  );
}

// GET /api/zoom/status
app.get('/api/zoom/status', (req, res) => {
  const state = db.prepare(`SELECT last_polled_at FROM poll_state WHERE service = 'zoom'`).get();
  res.json({ configured: zoom.isConfigured(), mock: integrations.isMock, last_polled_at: state?.last_polled_at || null });
});

// POST /api/zoom/poll — manual trigger
app.post('/api/zoom/poll', async (req, res) => {
  try {
    const result = await runZoomPoll();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Serve React build (production only — skipped if build/ doesn't exist) ──
const buildPath = path.join(__dirname, '..', 'build');
if (fs.existsSync(buildPath)) {
  app.use(express.static(buildPath));
  app.get('/{*path}', (req, res) => res.sendFile(path.join(buildPath, 'index.html')));
}

// ─── Start Server ─────────────────────────────────────────────────────────
if (process.env.NODE_ENV !== 'test') {
  app.listen(PORT, () => {
    console.log(`API running on port ${PORT} (integrations: ${integrations.isMock ? 'mock' : 'real'})`);
  });
}

module.exports = app;
