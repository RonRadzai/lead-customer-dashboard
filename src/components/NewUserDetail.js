import { useState, useEffect, useCallback } from 'react';
import SupportHistorySection from './SupportHistorySection';
import ZendeskTicketsSection from './ZendeskTicketsSection';
import { MeetingsSection, NotesSection, ActivitySection, EmailHistorySection } from './RecordSections';
import { formatDateTime, formatRelative } from '../utils/format';

// ─── Other Orgs Panel ──────────────────────────────────────────────────────
function OtherOrgsPanel({ otherOrgs, onNavigate }) {
  if (!otherOrgs || otherOrgs.length === 0) return null;
  return (
    <div className="detail-info-block">
      <div className="section-title">Also in {otherOrgs.length} other org{otherOrgs.length !== 1 ? 's' : ''}</div>
      <p className="text-muted" style={{ fontSize: 12, marginBottom: 10 }}>
        This person has accounts in multiple organizations.
      </p>
      {otherOrgs.map(org => (
        <div
          key={org.id}
          onClick={() => onNavigate && onNavigate(org.id)}
          style={{
            padding: '8px 10px',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-sm)',
            marginBottom: 6,
            cursor: onNavigate ? 'pointer' : 'default',
          }}
        >
          <div style={{ fontWeight: 600, fontSize: 13 }}>{org.org_name}</div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
            {org.organization_id && <span>#{org.organization_id}</span>}
            {org.meeting_count > 0 && (
              <span style={{ marginLeft: 8 }}>
                {org.meeting_count} meeting{org.meeting_count !== 1 ? 's' : ''}
                {org.last_meeting_at && ` · last ${formatRelative(org.last_meeting_at)}`}
              </span>
            )}
            {org.meeting_count === 0 && <span style={{ marginLeft: 8 }}>No meetings</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Onboarding Triage ─────────────────────────────────────────────────────
const CATEGORY_LABELS = { full_onboarding: 'Full onboarding', standard: 'Standard welcome', needs_review: 'Needs review' };

function TriagePanel({ user }) {
  const category = user.training_category || 'needs_review';
  const due = user.follow_up_due_at ? new Date(user.follow_up_due_at.replace(' ', 'T') + 'Z') : null;
  const daysLeft = due ? Math.ceil((due - Date.now()) / 86400000) : null;
  const overdue = daysLeft !== null && daysLeft < 0;
  return (
    <div className="detail-info-block">
      <div className="section-title">Onboarding Triage</div>
      <div className="detail-field">
        <label>Training Category</label>
        <div className="field-value">
          <span className={`badge badge-sm ${category === 'full_onboarding' ? 'badge-triage' : 'badge-neutral'}`}>
            {CATEGORY_LABELS[category] || category}
          </span>
        </div>
      </div>
      {due && (
        <div className="detail-field" style={{ marginTop: 10 }}>
          <label>Follow-up Due</label>
          <div className="field-value">
            {formatDateTime(user.follow_up_due_at)}
            <span className={`badge badge-sm ${overdue ? 'badge-lost' : 'badge-followup'}`} style={{ marginLeft: 8 }}>
              {overdue ? `${Math.abs(daysLeft)}d overdue` : `${daysLeft}d left`}
            </span>
          </div>
        </div>
      )}
      <p className="text-muted" style={{ fontSize: 12, marginTop: 10 }}>
        {category === 'full_onboarding'
          ? 'Administrator-type profile: full onboarding training plus a follow-up check-in.'
          : category === 'standard'
            ? 'Standard user profile: welcome email, no follow-up timer.'
            : 'Profile is not covered by a triage rule yet. Add one under Settings.'}
      </p>
    </div>
  );
}

// ─── NewUserDetail ─────────────────────────────────────────────────────────
export default function NewUserDetail({ userId, onBack, backLabel, isEstablished, onNavigateToUser, currentUser, initialMeetingId }) {
  const [user, setUser]         = useState(null);
  const [notes, setNotes]       = useState([]);
  const [meetings, setMeetings] = useState([]);
  const [activity, setActivity] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [actionError, setActionError] = useState(null);
  const [acting, setActing]     = useState(false);
  const [noteTopics, setNoteTopics] = useState([]);

  const fetchAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const [userRes, meetingsRes, topicsRes] = await Promise.all([
        fetch(`/api/new-users/${userId}`),
        fetch(`/api/meetings/new_user/${userId}`),
        fetch('/api/config/note-topics'),
      ]);
      if (!userRes.ok) throw new Error('User not found');
      const data = await userRes.json();
      const meetingsData = meetingsRes.ok ? await meetingsRes.json() : [];
      const topicsData = topicsRes.ok ? await topicsRes.json() : [];
      setUser(data);
      setNotes((data.notes || []).filter(n => !n.meeting_id));
      setMeetings(meetingsData);
      setActivity(data.activity_log || []);
      setNoteTopics(topicsData);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [userId]);

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

  async function handleDelete() {
    if (!window.confirm('Move this user to the recycle bin? They can be restored within 7 days.')) return;
    setActing(true); setActionError(null);
    try {
      const res = await fetch(`/api/new-users/${userId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete user');
      onBack();
    } catch (err) { setActionError(err.message); setActing(false); }
  }

  if (loading) return <div className="loading-state"><div className="loading-spinner" />Loading user…</div>;
  if (error) return <div className="error-state">{error}</div>;
  if (!user) return null;

  const otherOrgs = user.other_orgs || [];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
        <button className="back-btn" style={{ margin: 0 }} onClick={onBack}>← Back to {backLabel || 'New Users'}</button>
        {!isEstablished && (
          <button
            onClick={handleDelete}
            disabled={acting}
            className="back-btn"
            style={{ margin: 0, fontWeight: 400, opacity: 0.55 }}
          >
            Move to recycle bin
          </button>
        )}
      </div>

      {actionError && <div className="error-state">{actionError}</div>}

      <div className="page-header">
        <div>
          <h1>
            {user.first_name} {user.last_name}
            {isEstablished && (
              <span style={{
                fontSize: 11, fontWeight: 700, letterSpacing: '0.05em',
                padding: '3px 9px', borderRadius: 99, marginLeft: 10,
                background: 'rgba(16,185,129,0.15)', color: '#10b981',
                verticalAlign: 'middle', position: 'relative', top: -2,
              }}>ESTABLISHED</span>
            )}
          </h1>
          <p>
            {user.org_name}{user.user_profile_name ? ` · ${user.user_profile_name}` : ''}
            {otherOrgs.length > 0 && (
              <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-secondary)', fontWeight: 400 }}>
                · {otherOrgs.length + 1} orgs total
              </span>
            )}
          </p>
        </div>
      </div>

      <div className="detail-layout">
        {/* Left column */}
        <div>
          {/* User Info */}
          <div className="detail-info-block">
            <div className="section-title">User Info</div>
            <div className="detail-info-grid">
              <div className="detail-field">
                <label>Email</label>
                <div className="field-value"><a href={`mailto:${user.email}`}>{user.email}</a></div>
              </div>
              <div className="detail-field">
                <label>Organization</label>
                <div className="field-value">{user.org_name}</div>
              </div>
              {user.org_url && (
                <div className="detail-field">
                  <label>Org URL</label>
                  <div className="field-value"><a href={user.org_url} target="_blank" rel="noopener noreferrer">{user.org_url}</a></div>
                </div>
              )}
              <div className="detail-field">
                <label>Account #</label>
                <div className="field-value">{user.organization_id}</div>
              </div>
              {user.crm_org_id && (
                <div className="detail-field">
                  <label>CRM Org ID</label>
                  <div className="field-value">{user.crm_org_id}</div>
                </div>
              )}
              {user.user_profile_name && (
                <div className="detail-field">
                  <label>User Profile</label>
                  <div className="field-value">{user.user_profile_name}</div>
                </div>
              )}
              <div className="detail-field">
                <label>Date Entered</label>
                <div className="field-value">{formatDateTime(user.date_entered)}</div>
              </div>
              {user.last_login && (
                <div className="detail-field">
                  <label>Last Login</label>
                  <div className="field-value">{formatDateTime(user.last_login)}</div>
                </div>
              )}

              {user.assigned_to && (
                <div className="detail-field">
                  <label>Assigned To</label>
                  <div className="field-value">{user.assigned_to}</div>
                </div>
              )}
            </div>
          </div>

          {/* Meetings */}
          <MeetingsSection
            meetings={meetings}
            recordType="new_user"
            recordId={userId}
            onMeetingUpdated={fetchAll}
            onNoteAdded={handleMeetingNoteAdded}
            currentUser={currentUser}
            topics={noteTopics}
            initialMeetingId={initialMeetingId}
          />

          {/* Email History */}
          {!isEstablished && <EmailHistorySection recordType="new_user" recordId={userId} />}

          {/* Support History */}
          <SupportHistorySection recordType="new_user" recordId={userId} />

          {/* Zendesk Tickets */}
          <ZendeskTicketsSection recordType="new_user" recordId={userId} />

          {/* General Notes */}
          <div className="detail-info-block">
            <NotesSection
              recordType="new_user"
              recordId={userId}
              notes={notes}
              onNoteAdded={handleNoteAdded}
              onNoteDeleted={handleNoteDeleted}
              onNoteEdited={handleNoteEdited}
              onNotesBulkDeleted={handleNotesBulkDeleted}
              currentUser={currentUser}
            />
          </div>

          {/* Activity */}
          <div className="detail-info-block">
            <ActivitySection activity={activity} onActivityDeleted={handleActivityDeleted} onActivityBulkDeleted={handleActivityBulkDeleted} />
          </div>
        </div>

        {/* Right sidebar */}
        <div>
          <TriagePanel user={user} />
          {/* Other orgs panel — always shown if present */}
          <OtherOrgsPanel otherOrgs={otherOrgs} onNavigate={onNavigateToUser} />
        </div>
      </div>

    </div>
  );
}
