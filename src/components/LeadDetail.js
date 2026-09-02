import { useState, useEffect, useCallback, useRef } from 'react';
import SupportHistorySection from './SupportHistorySection';
import { MeetingsSection, NotesSection, ActivitySection, EmailHistorySection } from './RecordSections';
import { formatDateTime } from '../utils/format';

const STAGE_ORDER = ['new_inquiry', 'contacted', 'demo_scheduled', 'attended_demo', 'follow_up', 'converted'];
const STAGE_LABELS = { new_inquiry: 'New Inquiry', contacted: 'Contacted', demo_scheduled: 'Demo Scheduled', attended_demo: 'Attended Demo', follow_up: 'Follow Up', converted: 'Converted' };
const LOST_REASONS = ['Not a fit', 'Budget constraints', 'Chose a competitor', 'No response', 'Timeline mismatch', 'Other'];

// ─── Pipeline Bar ──────────────────────────────────────────────────────────
function PipelineBar({ currentStage, onStageClick, pendingStage }) {
  const currentIdx = STAGE_ORDER.indexOf(currentStage);
  return (
    <div className="pipeline-bar">
      {STAGE_ORDER.map((stage, idx) => {
        const isActive = idx === currentIdx;
        const isPast = idx < currentIdx;
        return (
          <div
            key={stage}
            className={`pipeline-stage${isActive ? ' active' : isPast ? ' past' : ''}${!isActive && stage !== 'converted' ? ' clickable' : ''}`}
            style={!isActive && stage !== 'converted' ? { cursor: 'pointer' } : {}}
            onClick={() => !isActive && stage !== 'converted' && onStageClick && onStageClick(stage)}
            title={!isActive && stage !== 'converted' ? `Set stage to ${STAGE_LABELS[stage]}` : undefined}
          >
            {STAGE_LABELS[stage]}
            {pendingStage === stage && ' ✓'}
          </div>
        );
      })}
    </div>
  );
}

// ─── Ad Source (CSV import metadata) ───────────────────────────────────────
const PLATFORM_LABEL = { fb: 'Facebook', ig: 'Instagram', li: 'LinkedIn', google: 'Google', meta: 'Meta' };

function AdSourceSection({ lead }) {
  const hasAny = lead.platform || lead.campaign_name || lead.campaign_id ||
    lead.ad_name || lead.ad_id || lead.adset_name || lead.adset_id ||
    lead.form_name || lead.form_id || lead.external_lead_id ||
    lead.external_created_at || lead.inbox_url || lead.is_organic != null;
  if (!hasAny) return null;

  const platform = lead.platform ? (PLATFORM_LABEL[String(lead.platform).toLowerCase()] || lead.platform) : null;

  function Row({ label, value, mono }) {
    if (!value) return null;
    return (
      <div className="detail-field">
        <label>{label}</label>
        <div className="field-value" style={mono ? { fontFamily: 'var(--font-mono, monospace)', fontSize: 12 } : undefined}>{value}</div>
      </div>
    );
  }

  return (
    <div className="detail-info-block">
      <div className="section-title">Ad Source</div>
      <div className="detail-info-grid">
        <Row label="Platform" value={platform} />
        <Row label="Campaign" value={lead.campaign_name} />
        <Row label="Ad" value={lead.ad_name} />
        <Row label="Ad Set" value={lead.adset_name} />
        <Row label="Form" value={lead.form_name} />
        {lead.is_organic != null && (
          <Row label="Organic" value={lead.is_organic ? 'Yes' : 'No'} />
        )}
        {lead.external_created_at && (
          <Row label="Submitted" value={formatDateTime(lead.external_created_at)} />
        )}
        {lead.inbox_url && (
          <div className="detail-field">
            <label>Platform Inbox</label>
            <div className="field-value">
              <a href={lead.inbox_url} target="_blank" rel="noopener noreferrer">Open conversation ↗</a>
            </div>
          </div>
        )}
        <Row label="Lead ID" value={lead.external_lead_id} mono />
        <Row label="Campaign ID" value={lead.campaign_id} mono />
        <Row label="Ad Set ID" value={lead.adset_id} mono />
        <Row label="Ad ID" value={lead.ad_id} mono />
        <Row label="Form ID" value={lead.form_id} mono />
      </div>
    </div>
  );
}

// ─── LeadDetail ────────────────────────────────────────────────────────────
export default function LeadDetail({ leadId, onBack, currentUser }) {
  const [lead, setLead]         = useState(null);
  const [notes, setNotes]       = useState([]);
  const [meetings, setMeetings] = useState([]);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [teamMembers, setTeamMembers] = useState([]);

  const [stageSelect, setStageSelect]           = useState('');
  const [lostReason, setLostReason]             = useState('Not a fit');
  const [showLostForm, setShowLostForm]         = useState(false);
  const [showConvertConfirm, setShowConvertConfirm] = useState(false);
  const [actionError, setActionError]           = useState(null);
  const [acting, setActing]                     = useState(false);
  const attemptInFlight                         = useRef(false);
  const [customStages, setCustomStages]         = useState([]);
  const [pendingStage, setPendingStage]         = useState(null);
  const [noteTopics, setNoteTopics]             = useState([]);

  const fetchAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [leadRes, meetingsRes, teamRes, stagesRes, topicsRes] = await Promise.all([
        fetch(`/api/leads/${leadId}`),
        fetch(`/api/meetings/lead/${leadId}`),
        fetch('/api/team'),
        fetch('/api/config/lead-stages'),
        fetch('/api/config/note-topics'),
      ]);
      if (!leadRes.ok) throw new Error('Lead not found');
      const data = await leadRes.json();
      const meetingsData = meetingsRes.ok ? await meetingsRes.json() : [];
      const teamData = teamRes.ok ? await teamRes.json() : [];
      const stagesData = stagesRes.ok ? await stagesRes.json() : [];
      const topicsData = topicsRes.ok ? await topicsRes.json() : [];
      setLead(data);
      setNotes((data.notes || []).filter(n => !n.meeting_id));
      setMeetings(meetingsData);
      setActivity(data.activity_log || []);
      setTeamMembers(teamData.filter(m => m.active));
      setCustomStages(stagesData);
      setNoteTopics(topicsData);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [leadId]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  useEffect(() => {
    const interval = setInterval(() => fetchAll(true), 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchAll]);

  function handleNoteAdded(note) { setNotes(n => [...n, note]); }
  function handleNoteDeleted(id) { setNotes(n => n.filter(x => x.id !== id)); }
  function handleNoteEdited(id, updated) { setNotes(n => n.map(x => x.id === id ? { ...x, ...updated } : x)); }
  function handleActivityDeleted(id) { setActivity(a => a.filter(x => x.id !== id)); }
  function handleNotesBulkDeleted(ids) { const set = new Set(ids); setNotes(n => n.filter(x => !set.has(x.id))); }
  function handleActivityBulkDeleted(ids) { const set = new Set(ids); setActivity(a => a.filter(x => !set.has(x.id))); }
  function handleMeetingNoteAdded(meetingId, note) {
    setMeetings(ms => ms.map(m => m.id === meetingId ? { ...m, notes: [...(m.notes || []), note] } : m));
  }

  async function handleAssign(name) {
    const res = await fetch(`/api/leads/${leadId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assigned_to: name || null, performed_by: currentUser?.name || 'Team' }),
    });
    if (res.ok) setLead(l => ({ ...l, assigned_to: name || null }));
  }

  async function handleStageUpdate(stageOverride) {
    const targetStage = stageOverride || stageSelect;
    if (!targetStage) return;
    setActing(true); setActionError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/stage`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: targetStage, performed_by: currentUser?.name || 'Team' }) });
      if (!res.ok) throw new Error('Failed to update stage');
      setStageSelect('');
      setPendingStage(null);
      await fetchAll();
    } catch (err) { setActionError(err.message); }
    finally { setActing(false); }
  }

  async function handleReactivate() {
    setActing(true); setActionError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/stage`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: 'new_inquiry', performed_by: currentUser?.name || 'Team' }) });
      if (!res.ok) throw new Error('Failed to reactivate lead');
      await fetchAll();
    } catch (err) { setActionError(err.message); }
    finally { setActing(false); }
  }

  async function handleConvert() {
    setActing(true); setActionError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/convert`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ performed_by: currentUser?.name || 'Team' }) });
      if (!res.ok) throw new Error('Failed to convert lead');
      setShowConvertConfirm(false);
      await fetchAll();
    } catch (err) { setActionError(err.message); }
    finally { setActing(false); }
  }

  async function handleLost() {
    setActing(true); setActionError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/lost`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lost_reason: lostReason, performed_by: currentUser?.name || 'Team' }) });
      if (!res.ok) throw new Error('Failed to mark lead as lost');
      setShowLostForm(false);
      await fetchAll();
    } catch (err) { setActionError(err.message); }
    finally { setActing(false); }
  }

  async function handleDelete() {
    if (!window.confirm('Move this lead to the recycle bin? It can be restored within 7 days.')) return;
    setActing(true); setActionError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete lead');
      onBack();
    } catch (err) { setActionError(err.message); setActing(false); }
  }

  async function handleAttempt(delta) {
    if (attemptInFlight.current) return;
    attemptInFlight.current = true;
    setActing(true); setActionError(null);
    try {
      const res = await fetch(`/api/leads/${leadId}/attempt`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ delta, performed_by: currentUser?.name || 'Team' }),
      });
      if (!res.ok) throw new Error('Failed to update attempts');
      await fetchAll();
    } catch (err) { setActionError(err.message); }
    finally { attemptInFlight.current = false; setActing(false); }
  }

  if (loading) return <div className="loading-state"><div className="loading-spinner" />Loading lead…</div>;
  if (error) return <div className="error-state">{error}</div>;
  if (!lead) return null;

  const isCustomTerminal = customStages.some(s => s.value === lead.stage);
  const isTerminal = lead.stage === 'converted' || lead.stage === 'lost' || isCustomTerminal;
  const customTerminalStage = isCustomTerminal ? customStages.find(s => s.value === lead.stage) : null;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <button className="back-btn" style={{ margin: 0 }} onClick={onBack}>← Back to Leads</button>
        <button
          onClick={handleDelete}
          disabled={acting}
          className="back-btn"
          style={{ margin: 0, fontWeight: 400, opacity: 0.55 }}
        >
          Move to recycle bin
        </button>
      </div>

      <div className="page-header">
        <div>
          <h1>{lead.first_name} {lead.last_name}</h1>
          <p>{lead.org_name}{lead.source ? ` · via ${lead.source}` : ''}</p>
        </div>
      </div>

      {!isTerminal && (
        <>
          <PipelineBar currentStage={lead.stage} onStageClick={setPendingStage} pendingStage={pendingStage} />
          {pendingStage && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', marginBottom: 12, background: 'var(--bg-input)', border: '1px solid var(--border-color)', borderRadius: 'var(--radius-sm)' }}>
              <span style={{ fontSize: 13, color: 'var(--text-primary)' }}>
                Set stage to <strong>{STAGE_LABELS[pendingStage]}</strong>?
              </span>
              <button className="btn btn-primary btn-sm" onClick={() => handleStageUpdate(pendingStage)} disabled={acting}>Yes</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setPendingStage(null)}>Cancel</button>
            </div>
          )}
        </>
      )}
      {lead.stage === 'lost' && (
        <div className="urgency-banner red" style={{ marginBottom: 20 }}>✗ Lost{lead.lost_reason ? ` — ${lead.lost_reason}` : ''}</div>
      )}
      {lead.stage === 'converted' && (
        <div className="urgency-banner green" style={{ marginBottom: 20 }}>✓ Converted on {formatDateTime(lead.converted_at)}</div>
      )}
      {customTerminalStage && (
        <div className="urgency-banner" style={{ marginBottom: 20, background: 'rgba(100,100,100,0.12)', borderColor: 'rgba(100,100,100,0.3)', color: 'var(--text-secondary)' }}>
          ⚑ Marked as {customTerminalStage.label}
          <button className="btn btn-secondary btn-sm" style={{ marginLeft: 12 }} onClick={handleReactivate} disabled={acting}>
            Reactivate
          </button>
        </div>
      )}

      <div className="detail-layout">
        {/* Left column */}
        <div>
          {/* Contact Info — static */}
          <div className="detail-info-block">
            <div className="section-title">Contact Info</div>
            <div className="detail-info-grid">
              <div className="detail-field">
                <label>Email</label>
                <div className="field-value"><a href={`mailto:${lead.email}`}>{lead.email}</a></div>
              </div>
              {lead.phone && (
                <div className="detail-field">
                  <label>Phone</label>
                  <div className="field-value">{lead.phone}{lead.phone_extension ? ` x${lead.phone_extension}` : ''}</div>
                </div>
              )}
              <div className="detail-field">
                <label>Organization</label>
                <div className="field-value">{lead.org_name}</div>
              </div>
              {lead.org_website && (
                <div className="detail-field">
                  <label>Website</label>
                  <div className="field-value"><a href={lead.org_website} target="_blank" rel="noopener noreferrer">{lead.org_website}</a></div>
                </div>
              )}
              <div className="detail-field">
                <label>Assigned To</label>
                <select
                  className="filter-select"
                  value={lead.assigned_to || ''}
                  onChange={e => handleAssign(e.target.value)}
                >
                  <option value="">— Unassigned —</option>
                  {teamMembers.map(m => (
                    <option key={m.id} value={m.name}>{m.name}</option>
                  ))}
                </select>
              </div>
              <div className="detail-field">
                <label>Created</label>
                <div className="field-value">{formatDateTime(lead.created_at)}</div>
              </div>
              {lead.consent_to_contact ? (
                <div className="detail-field">
                  <label>Consent</label>
                  <div className="field-value" style={{ color: 'var(--accent-green)' }}>✓ Consented</div>
                </div>
              ) : null}
            </div>
            {lead.how_can_we_help && (
              <div style={{ marginTop: 14 }}>
                <div className="detail-field">
                  <label>How Can We Help</label>
                  <div className="field-value" style={{ marginTop: 4 }}>{lead.how_can_we_help}</div>
                </div>
              </div>
            )}
          </div>

          {/* Ad Source (populated from CSV import) */}
          <AdSourceSection lead={lead} />

          {/* Meetings */}
          <MeetingsSection
            meetings={meetings}
            recordType="lead"
            recordId={leadId}
            onMeetingUpdated={fetchAll}
            onNoteAdded={handleMeetingNoteAdded}
            currentUser={currentUser}
            topics={noteTopics}
          />

          {/* Email History */}
          <EmailHistorySection recordType="lead" recordId={leadId} />

          {/* Support History */}
          <SupportHistorySection recordType="lead" recordId={leadId} />

          {/* General Notes */}
          <div className="detail-info-block">
            <NotesSection recordType="lead" recordId={leadId} notes={notes} onNoteAdded={handleNoteAdded} onNoteDeleted={handleNoteDeleted} onNoteEdited={handleNoteEdited} onNotesBulkDeleted={handleNotesBulkDeleted} currentUser={currentUser} />
          </div>

          {/* Activity */}
          <div className="detail-info-block">
            <ActivitySection activity={activity} onActivityDeleted={handleActivityDeleted} onActivityBulkDeleted={handleActivityBulkDeleted} />
          </div>
        </div>

        {/* Right sidebar */}
        <div>
          {!isTerminal && (
            <div className="detail-info-block">
              <div className="section-title">Contact Attempts</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button className="btn btn-secondary btn-sm" onClick={() => handleAttempt(-1)} disabled={acting || (lead.contact_attempts || 0) === 0}>−</button>
                <div style={{ fontSize: 18, fontWeight: 600, minWidth: 28, textAlign: 'center' }}>
                  {lead.contact_attempts || 0}
                </div>
                <button className="btn btn-primary btn-sm" onClick={() => handleAttempt(1)} disabled={acting}>+</button>
                <span style={{ fontSize: 12, color: 'var(--text-secondary)', marginLeft: 6 }}>
                  attempt{(lead.contact_attempts || 0) !== 1 ? 's' : ''}
                </span>
              </div>
            </div>
          )}

          <div className="detail-info-block">
            <div className="section-title">Actions</div>
            {actionError && <div className="error-state">{actionError}</div>}

            {!isTerminal && (
              <>
                <div className="form-group">
                  <label>Update Stage</label>
                  <div className="flex gap-8">
                    <select value={stageSelect} onChange={e => setStageSelect(e.target.value)} style={{ flex: 1 }}>
                      <option value="">Select stage…</option>
                      {STAGE_ORDER.filter(s => s !== lead.stage && s !== 'converted').map(s => (
                        <option key={s} value={s}>{STAGE_LABELS[s]}</option>
                      ))}
                      {customStages.map(s => (
                        <option key={s.value} value={s.value}>{s.label}</option>
                      ))}
                    </select>
                    <button className="btn btn-primary btn-sm" onClick={() => handleStageUpdate()} disabled={!stageSelect || acting}>Set</button>
                  </div>
                </div>

                {!showConvertConfirm ? (
                  <button className="btn btn-success w-full" style={{ marginBottom: 8 }} onClick={() => setShowConvertConfirm(true)}>✓ Mark as Converted</button>
                ) : (
                  <div style={{ background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 'var(--radius-sm)', padding: 12, marginBottom: 8 }}>
                    <p style={{ fontSize: 13, marginBottom: 10, color: 'var(--text-primary)' }}>Confirm mark as converted?</p>
                    <div className="flex gap-8">
                      <button className="btn btn-success btn-sm" onClick={handleConvert} disabled={acting}>Confirm</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setShowConvertConfirm(false)}>Cancel</button>
                    </div>
                  </div>
                )}

                {!showLostForm ? (
                  <button className="btn btn-danger w-full" onClick={() => setShowLostForm(true)}>✗ Mark as Lost</button>
                ) : (
                  <div style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 'var(--radius-sm)', padding: 12 }}>
                    <div className="form-group" style={{ marginBottom: 10 }}>
                      <label>Lost Reason</label>
                      <select value={lostReason} onChange={e => setLostReason(e.target.value)}>
                        {LOST_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
                      </select>
                    </div>
                    <div className="flex gap-8">
                      <button className="btn btn-danger btn-sm" onClick={handleLost} disabled={acting}>Confirm</button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setShowLostForm(false)}>Cancel</button>
                    </div>
                  </div>
                )}
              </>
            )}

            {isTerminal && !isCustomTerminal && (
              <p className="text-muted">This lead is {lead.stage}. No further actions available.</p>
            )}
            {isCustomTerminal && (
              <p className="text-muted">This lead is marked as {customTerminalStage?.label}. Use Reactivate to move it back to New Inquiry.</p>
            )}

          </div>
        </div>
      </div>

    </div>
  );
}
