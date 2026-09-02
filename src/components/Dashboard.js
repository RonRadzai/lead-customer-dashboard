import { useState, useEffect, useCallback } from 'react';
import { EmptyState } from './Skeleton';
import MetaIcon from './MetaIcon';
import { formatRelative, formatAction } from '../utils/format';

function StatCard({ value, label, colorClass, onClick }) {
  return (
    <div className={`stat-card ${colorClass}`} style={onClick ? { cursor: 'pointer' } : {}} onClick={onClick}>
      <div className="stat-value">{value ?? '—'}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

function WeekStrip({ meetings, outlookEvents = [], onOpenLead, onOpenUser, onDeleteMeeting }) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const days = [];
  const cursor = new Date(today);
  while (days.length < 5) {
    if (cursor.getDay() !== 0 && cursor.getDay() !== 6) days.push(new Date(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }

  // Deduplicate Calendly meetings by invitee_email + start time (±5 min).
  // The same person can book via multiple Calendly links (personal page + team page),
  // producing different event URIs for the same actual meeting. Also handles the case
  // where the same URI is matched to both a lead and a new_user row.
  // Keep best match: lead > new_user > unmatched.
  const RECORD_PRIORITY = { lead: 1, new_user: 2, unmatched: 3 };
  const dedupedMeetings = [];
  meetings.forEach(m => {
    const mTime = new Date(m.scheduled_at).getTime();
    const mEmail = m.invitee_email?.toLowerCase();
    if (!mEmail) { dedupedMeetings.push(m); return; }
    const existingIdx = dedupedMeetings.findIndex(x =>
      x.invitee_email?.toLowerCase() === mEmail &&
      Math.abs(new Date(x.scheduled_at).getTime() - mTime) <= 5 * 60 * 1000
    );
    if (existingIdx === -1) {
      dedupedMeetings.push(m);
    } else if ((RECORD_PRIORITY[m.record_type] ?? 99) < (RECORD_PRIORITY[dedupedMeetings[existingIdx].record_type] ?? 99)) {
      dedupedMeetings[existingIdx] = m;
    }
  });

  const byDay = {};
  dedupedMeetings.forEach(m => {
    const key = new Date(m.scheduled_at).toDateString();
    if (!byDay[key]) byDay[key] = [];
    byDay[key].push({ ...m, _source: 'calendly' });
  });
  // Graph returns dateTime without 'Z'; appending it makes JS parse as UTC → convert to browser local time
  const parseOutlookDt = dt => new Date(dt.endsWith('Z') ? dt : dt + 'Z');
  outlookEvents.forEach(e => {
    const key = parseOutlookDt(e.start.dateTime).toDateString();
    if (!byDay[key]) byDay[key] = [];
    // Skip if a Calendly event covers the same slot AND same person — Calendly takes precedence.
    // Both conditions required: same time (±5 min) AND invitee email matches an Outlook attendee/organizer.
    const outTime = parseOutlookDt(e.start.dateTime).getTime();
    const outEmails = new Set([
      ...(e.attendees || []).map(a => a.emailAddress?.address?.toLowerCase()).filter(Boolean),
      e.organizer?.emailAddress?.address?.toLowerCase(),
    ].filter(Boolean));
    const isDupe = byDay[key].some(existing =>
      existing._source === 'calendly' &&
      Math.abs(new Date(existing.scheduled_at).getTime() - outTime) <= 5 * 60 * 1000 &&
      existing.invitee_email && outEmails.has(existing.invitee_email.toLowerCase())
    );
    if (!isDupe) byDay[key].push({ ...e, _source: 'outlook' });
  });

  // Sort each day's items by time
  Object.values(byDay).forEach(list =>
    list.sort((a, b) => {
      const ta = a._source === 'outlook' ? parseOutlookDt(a.start.dateTime) : new Date(a.scheduled_at);
      const tb = b._source === 'outlook' ? parseOutlookDt(b.start.dateTime) : new Date(b.scheduled_at);
      return ta - tb;
    })
  );

  const todayStr = today.toDateString();
  const todayMonth = today.getMonth();

  return (
    <div className="week-strip">
      <span className="section-title" style={{ margin: 0, display: 'block' }}>Upcoming Meetings</span>
      <div className="week-strip-days">
        {days.map(day => {
          const key = day.toDateString();
          const dayItems = byDay[key] || [];
          const isToday = key === todayStr;
          const crossesMonth = day.getMonth() !== todayMonth;
          return (
            <div key={key} className={`week-day-col${isToday ? ' today' : ''}`}>
              <div className="week-day-header">
                {crossesMonth && (
                  <span className="week-day-month">{day.toLocaleDateString('en-US', { month: 'short' })}</span>
                )}
                <span className="week-day-name">{day.toLocaleDateString('en-US', { weekday: 'short' })}</span>
                <span className="week-day-num">{day.getDate()}</span>
              </div>
              <div className="week-day-meetings">
                {dayItems.map(item => {
                  if (item._source === 'outlook') {
                    const time = parseOutlookDt(item.start.dateTime).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                    return (
                      <div key={`outlook-${item.id}`} className="meeting-chip outlook-chip" style={{ cursor: 'default' }}>
                        <div className="meeting-chip-time">{time}</div>
                        <div className="meeting-chip-name">{item.subject || '(No title)'}</div>
                        <span className="badge badge-sm badge-outlook">Outlook</span>
                      </div>
                    );
                  }
                  const m = item;
                  const time = new Date(m.scheduled_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                  const isUnmatched = m.record_type === 'unmatched';
                  const isCalendly = m.calendly_event_uri && !m.source_calendar;
                  const handleClick = isUnmatched ? undefined : () => {
                    if (m.record_type === 'lead') onOpenLead({ id: m.record_id });
                    else onOpenUser({ id: m.record_id, is_established: m.is_established });
                  };
                  return (
                    <div key={m.id} className={`meeting-chip${m.status === 'completed' ? ' completed' : ''}${m.status === 'canceled' ? ' canceled' : ''}${isUnmatched ? ' unmatched' : ''}`} onClick={handleClick} style={{ position: 'relative', ...(isUnmatched ? { cursor: 'default' } : undefined) }}>
                      {!isCalendly && (
                      <button
                        onClick={e => { e.stopPropagation(); onDeleteMeeting && onDeleteMeeting(m.id); }}
                        title="Remove from calendar"
                        style={{
                          position: 'absolute', top: 4, right: 4,
                          background: 'none', border: 'none', cursor: 'pointer',
                          color: 'var(--text-secondary)', fontSize: 13, lineHeight: 1,
                          padding: '1px 3px', borderRadius: 3, opacity: 0.5,
                        }}
                      >×</button>
                      )}
                      <div className="meeting-chip-time">{time}</div>
                      <div className="meeting-chip-name">{m.record_name || m.invitee_email}</div>
                      {m.event_name && (
                        <div className="meeting-chip-event">{m.event_name}</div>
                      )}
                      {m.source_calendar && (
                        <span className="badge badge-sm badge-neutral">{m.source_calendar === 'Zoom' ? 'Zoom' : `${m.source_calendar.split(' ')[0]}'s calendar`}</span>
                      )}
                      {m.status === 'canceled' && (
                        <div className="meeting-chip-canceled-label">Canceled</div>
                      )}
                      {m.record_type === 'lead' && (
                        <span className="badge badge-sm badge-record-lead">Lead</span>
                      )}
                      {m.record_type === 'new_user' && !m.is_established && (
                        <span className="badge badge-sm badge-record-new">New User</span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function Dashboard({ onNavigate, onAddLead, onImportCsv, onOpenLead, onOpenUser, currentUser }) {
  const [stats, setStats]         = useState(null);
  const [activity, setActivity]   = useState([]);
  const [upcomingMeetings, setUpcomingMeetings] = useState([]);
  const [outlookEvents, setOutlookEvents] = useState([]);
  const [selected, setSelected]   = useState(new Set());
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);

  async function handleDeleteActivity(id) {
    await fetch(`/api/activity/${id}`, { method: 'DELETE' });
    setActivity(a => a.filter(x => x.id !== id));
    setSelected(s => { const n = new Set(s); n.delete(id); return n; });
  }

  function toggleId(id) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  function toggleAll() {
    setSelected(s => s.size === activity.length ? new Set() : new Set(activity.map(a => a.id)));
  }

  async function handleBulkDelete() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (!window.confirm(`Move ${ids.length} activity ${ids.length === 1 ? 'entry' : 'entries'} to the recycle bin?`)) return;
    await fetch('/api/activity/bulk-soft-delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    setActivity(a => a.filter(x => !selected.has(x.id)));
    setSelected(new Set());
  }

  const loadDashboard = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true);
      const start = new Date(); start.setHours(0, 0, 0, 0);
      const end   = new Date(start); end.setDate(end.getDate() + 7);

      const fetches = [
        fetch('/api/dashboard/stats'),
        fetch('/api/dashboard/activity'),
        fetch('/api/dashboard/meetings-week'),
      ];
      if (currentUser?.email) {
        fetches.push(fetch(
          `/api/outlook-calendar?email=${encodeURIComponent(currentUser.email)}&start=${start.toISOString()}&end=${end.toISOString()}`
        ));
      }

      const results = await Promise.all(fetches);
      if (!results[0].ok || !results[1].ok || !results[2].ok) throw new Error('Failed to load dashboard data');

      const [s, a, m] = await Promise.all([results[0].json(), results[1].json(), results[2].json()]);
      setStats(s);
      setActivity(a);
      setUpcomingMeetings(m);

      if (currentUser?.email && results[3]) {
        const outlook = results[3].ok ? await results[3].json() : [];
        setOutlookEvents(Array.isArray(outlook) ? outlook : []);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [currentUser]);

  useEffect(() => { loadDashboard(); }, [loadDashboard]);

  useEffect(() => {
    const interval = setInterval(() => loadDashboard(true), 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, [loadDashboard]);

  if (loading) {
    return (
      <div className="loading-state">
        <div className="loading-spinner" />
        Loading dashboard…
      </div>
    );
  }

  if (error) {
    return <div className="error-state">{error}</div>;
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p>Overview of your leads and new users</p>
        </div>
        <div className="flex gap-8">
          <button className="btn btn-primary" onClick={onAddLead}>
            + Add New Lead
          </button>
          <button className="btn btn-secondary" onClick={onImportCsv}>
            ⬆ Import CSV
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="stats-grid">
        <StatCard
          value={stats?.total_active_leads}
          label="Active Leads"
          colorClass="blue"
          onClick={() => onNavigate('leads')}
        />
<StatCard
          value={stats?.new_users_last_30_days}
          label="New Users Added (30 Days)"
          colorClass="red"
          onClick={() => onNavigate('new-users')}
        />
        <StatCard
          value={stats?.meetings_this_week}
          label="Meetings This Week"
          colorClass="purple"
          onClick={() => onNavigate('meetings')}
        />
      </div>

      {/* Upcoming Meetings — 7-day strip */}
      <WeekStrip
        meetings={upcomingMeetings}
        outlookEvents={outlookEvents}
        onOpenLead={onOpenLead}
        onOpenUser={onOpenUser}
        onDeleteMeeting={async (id) => {
          await fetch(`/api/meetings/${id}`, { method: 'DELETE' });
          setUpcomingMeetings(prev => prev.filter(m => m.id !== id));
        }}
      />

      {/* Recent Activity */}
      <div className="detail-info-block">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label className="checkbox-row" style={{ margin: 0 }}>
              <input
                type="checkbox"
                checked={activity.length > 0 && selected.size === activity.length}
                ref={el => { if (el) el.indeterminate = selected.size > 0 && selected.size < activity.length; }}
                onChange={toggleAll}
                disabled={activity.length === 0}
              />
            </label>
            <span className="section-title" style={{ margin: 0 }}>Recent Activity</span>
          </div>
          {selected.size > 0 && (
            <button
              onClick={handleBulkDelete}
              style={{
                fontSize: 12, padding: '4px 10px', borderRadius: 6,
                border: '1px solid rgba(239,68,68,0.4)', background: 'rgba(239,68,68,0.08)',
                color: '#ef4444', cursor: 'pointer', fontWeight: 600,
              }}
            >
              Delete Selected ({selected.size})
            </button>
          )}
        </div>
        {activity.length === 0 ? (
          <EmptyState
            icon="sparkle"
            title="All caught up"
            description="You have no urgent items. New leads and overdue tasks will show up here automatically."
          />
        ) : (
          <div className="activity-log">
            {activity.map(item => {
              const handleClick = (e) => {
                if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
                if (item.record_type === 'lead') onOpenLead({ id: item.record_id });
                else onOpenUser({ id: item.record_id, is_established: item.is_established });
              };
              const isCanceled = item.action === 'meeting_canceled' ||
                (item.action === 'demo_scheduled' && item.details?.includes('— Canceled'));
              const displayDetails = isCanceled
                ? item.details?.replace(/ — Canceled$/, '')
                : item.details;
              return (
              <div key={item.id} className="activity-item" onClick={handleClick}
                style={{ cursor: 'pointer' }}>
                <label className="checkbox-row" style={{ margin: 0 }} onClick={e => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() => toggleId(item.id)}
                  />
                </label>
                <div className="activity-dot" />
                <div className="activity-content">
                  {item.record_name && (
                    <div className="activity-person">{item.record_name}</div>
                  )}
                  <div className="activity-action">
                    <span style={isCanceled ? { textDecoration: 'line-through', opacity: 0.55 } : {}}>
                      {formatAction(isCanceled ? 'demo_scheduled' : item.action)}
                    </span>
                    {isCanceled && (
                      <span className="badge badge-sm badge-lost" style={{ marginLeft: 6 }}>Canceled</span>
                    )}
                    {item.action !== 'meeting_completed' && (
                      item.record_type === 'lead' ? (
                        <span className="badge badge-sm badge-record-lead" style={{ marginLeft: 6 }}>Lead</span>
                      ) : item.is_established ? (
                        <span className="badge badge-sm badge-record-established" style={{ marginLeft: 6 }}>Established</span>
                      ) : (
                        <span className="badge badge-sm badge-record-new" style={{ marginLeft: 6 }}>New User</span>
                      )
                    )}
                  </div>
                  {displayDetails && !item.demo_scheduled_at && (
                    <div className="activity-details">{displayDetails}</div>
                  )}
                  {item.demo_scheduled_at && (
                    <div className="activity-meeting-date"
                      style={isCanceled ? { opacity: 0.5, textDecoration: 'line-through' } : {}}>
                      <MetaIcon name="calendar" /> {new Date(item.demo_scheduled_at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </div>
                  )}
                  {item.performed_by && (
                    <div className="text-muted mt-4">by {item.performed_by}</div>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div className="activity-time">{formatRelative(item.created_at)}</div>
                  <button
                    onClick={e => { e.stopPropagation(); handleDeleteActivity(item.id); }}
                    title="Move to recycle bin"
                    style={{ background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--text-secondary)', fontSize: 15, padding: '0 3px',
                      lineHeight: 1, opacity: 0.4 }}
                  >×</button>
                </div>
              </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
