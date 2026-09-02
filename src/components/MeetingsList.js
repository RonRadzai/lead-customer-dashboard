import { useState, useEffect, useCallback } from 'react';

// Where a meeting came from: Calendly rows have no source_calendar; Zoom is tagged 'Zoom';
// Outlook rows carry the team member whose calendar it was read from.
const sourceLabel = m =>
  !m.source_calendar ? 'Calendly' : m.source_calendar === 'Zoom' ? 'Zoom' : `${m.source_calendar.split(' ')[0]}'s Outlook`;

const DAY_OPTIONS = [7, 14, 30, 60, 90];

function getLastNDaysRange(n) {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - n);
  return {
    start: start.toISOString().slice(0, 10),
    end:   end.toISOString().slice(0, 10),
  };
}

function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

const STATUS_COLORS = {
  scheduled: { background: 'rgba(139,92,246,0.15)', color: '#8b5cf6' },
  completed:  { background: 'rgba(34,197,94,0.15)',  color: '#22c55e' },
  canceled:   { background: 'rgba(107,114,128,0.15)', color: '#6b7280' },
};

export default function MeetingsList({ onNavigate, onOpenLead, onOpenUser }) {
  const [meetings, setMeetings] = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [statusFilter, setStatusFilter] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [quickDays, setQuickDays] = useState(7);

  const initial = getLastNDaysRange(7);
  const [startDate, setStartDate] = useState(initial.start);
  const [endDate, setEndDate]     = useState(initial.end);

  function handleQuickDays(n) {
    setQuickDays(n);
    const { start, end } = getLastNDaysRange(n);
    setStartDate(start);
    setEndDate(end);
  }

  function handleStartDate(v) { setStartDate(v); setQuickDays(''); }
  function handleEndDate(v)   { setEndDate(v);   setQuickDays(''); }

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        start: new Date(startDate).toISOString(),
        end:   new Date(endDate + 'T23:59:59').toISOString(),
      });
      if (statusFilter) params.set('status', statusFilter);
      const res = await fetch(`/api/meetings/all?${params}`);
      if (!res.ok) throw new Error('Failed to load meetings');
      setMeetings(await res.json());
      setSelected(new Set());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate, statusFilter]);

  useEffect(() => { load(); }, [load]);

  function handleRowClick(m) {
    if (m.record_type === 'unmatched' || !m.record_id) return;
    if (m.record_type === 'lead') {
      onOpenLead({ id: m.record_id });
    } else {
      onOpenUser({ id: m.record_id, is_established: !!m.is_established, meetingId: m.id });
    }
  }

  function toggleSelect(id) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const deletableMeetings = meetings.filter(m => !(m.calendly_event_uri && !m.source_calendar));

  function toggleAll() {
    setSelected(prev => prev.size === deletableMeetings.length ? new Set() : new Set(deletableMeetings.map(m => m.id)));
  }

  async function deleteSelected() {
    if (selected.size === 0) return;
    if (!window.confirm(`Move ${selected.size} meeting${selected.size !== 1 ? 's' : ''} to the recycle bin?`)) return;
    await Promise.all(Array.from(selected).map(id =>
      fetch(`/api/meetings/${id}`, { method: 'DELETE' })
    ));
    load();
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Meetings</h1>
          <p>All meetings across leads and users (Calendly, Zoom, and Outlook)</p>
        </div>
        <button className="btn btn-secondary" onClick={() => onNavigate('dashboard')}>
          ← Dashboard
        </button>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 18, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <span style={{ color: 'var(--text-secondary)' }}>Last</span>
          <select
            value={quickDays}
            onChange={e => handleQuickDays(Number(e.target.value))}
            style={{
              fontSize: 13, padding: '3px 8px',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-input)',
              color: 'var(--text-primary)',
              cursor: 'pointer',
            }}
          >
            {DAY_OPTIONS.map(d => (
              <option key={d} value={d}>{d} days</option>
            ))}
            {quickDays === '' && <option value="">Custom</option>}
          </select>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 13, color: 'var(--text-secondary)' }}>From</label>
          <input
            type="date"
            className="form-control"
            style={{ width: 150, padding: '5px 8px' }}
            value={startDate}
            onChange={e => handleStartDate(e.target.value)}
          />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <label style={{ fontSize: 13, color: 'var(--text-secondary)' }}>To</label>
          <input
            type="date"
            className="form-control"
            style={{ width: 150, padding: '5px 8px' }}
            value={endDate}
            onChange={e => handleEndDate(e.target.value)}
          />
        </div>
        <select
          className="filter-select"
          value={statusFilter}
          onChange={e => setStatusFilter(e.target.value)}
          style={{ width: 150 }}
        >
          <option value="">All statuses</option>
          <option value="scheduled">Scheduled</option>
          <option value="completed">Completed</option>
          <option value="canceled">Canceled</option>
        </select>
      </div>

      {loading && (
        <div className="loading-state">
          <div className="loading-spinner" />
          Loading meetings…
        </div>
      )}
      {error && <div className="error-state">{error}</div>}

      {!loading && !error && meetings.length === 0 && (
        <div style={{ padding: '40px 0', textAlign: 'center', color: 'var(--text-secondary)', fontSize: 14 }}>
          No meetings found for this date range.
        </div>
      )}

      {!loading && !error && meetings.length > 0 && (
        <div className="detail-info-block" style={{ padding: 0, overflow: 'hidden' }}>
          {selected.size > 0 && (
            <div style={{ padding: '8px 14px', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{selected.size} selected</span>
              <button
                onClick={deleteSelected}
                style={{
                  fontSize: 12, padding: '4px 10px', borderRadius: 6,
                  border: '1px solid rgba(239,68,68,0.4)', background: 'rgba(239,68,68,0.08)',
                  color: '#ef4444', cursor: 'pointer', fontWeight: 600,
                }}
              >
                Delete Selected ({selected.size})
              </button>
            </div>
          )}
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: 'var(--bg-input)', borderBottom: '1px solid var(--border-color)' }}>
                <th style={{ padding: '10px 14px', width: 32 }}>
                  <input
                    type="checkbox"
                    checked={deletableMeetings.length > 0 && selected.size === deletableMeetings.length}
                    ref={el => { if (el) el.indeterminate = selected.size > 0 && selected.size < deletableMeetings.length; }}
                    onChange={toggleAll}
                    style={{ cursor: 'pointer' }}
                  />
                </th>
                <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary)', fontSize: 12 }}>Date / Time</th>
                <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary)', fontSize: 12 }}>Customer</th>
                <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary)', fontSize: 12 }}>Org</th>
                <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary)', fontSize: 12 }}>Event</th>
                <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary)', fontSize: 12 }}>Calendar</th>
                <th style={{ padding: '10px 14px', textAlign: 'left', fontWeight: 600, color: 'var(--text-secondary)', fontSize: 12 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {meetings.map(m => {
                const isClickable = m.record_type !== 'unmatched' && m.record_id;
                const statusStyle = STATUS_COLORS[m.status] || {};
                const isDeletable = !(m.calendly_event_uri && !m.source_calendar);
                return (
                  <tr
                    key={m.id}
                    style={{
                      borderBottom: '1px solid var(--border-color)',
                      opacity: m.status === 'canceled' ? 0.6 : 1,
                    }}
                    onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-input)'; }}
                    onMouseLeave={e => { e.currentTarget.style.background = ''; }}
                  >
                    <td style={{ padding: '10px 14px', width: 32 }} onClick={e => e.stopPropagation()}>
                      {isDeletable && (
                        <input
                          type="checkbox"
                          checked={selected.has(m.id)}
                          onChange={() => toggleSelect(m.id)}
                          style={{ cursor: 'pointer' }}
                        />
                      )}
                    </td>
                    <td style={{ padding: '10px 14px', whiteSpace: 'nowrap', cursor: isClickable ? 'pointer' : 'default' }} onClick={() => isClickable && handleRowClick(m)}>
                      {formatDateTime(m.scheduled_at)}
                    </td>
                    <td style={{ padding: '10px 14px', cursor: isClickable ? 'pointer' : 'default' }} onClick={() => isClickable && handleRowClick(m)}>
                      <div style={{ fontWeight: isClickable ? 600 : 400 }}>
                        {m.contact_name || m.invitee_name || '—'}
                      </div>
                      {!m.contact_name && m.invitee_email && (
                        <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{m.invitee_email}</div>
                      )}
                    </td>
                    <td style={{ padding: '10px 14px', color: 'var(--text-secondary)', cursor: isClickable ? 'pointer' : 'default' }} onClick={() => isClickable && handleRowClick(m)}>
                      {m.org_name || '—'}
                    </td>
                    <td style={{ padding: '10px 14px', color: 'var(--text-secondary)', cursor: isClickable ? 'pointer' : 'default' }} onClick={() => isClickable && handleRowClick(m)}>
                      {m.event_name || '—'}
                    </td>
                    <td style={{ padding: '10px 14px', color: 'var(--text-secondary)', fontSize: 12, cursor: isClickable ? 'pointer' : 'default' }} onClick={() => isClickable && handleRowClick(m)}>
                      {sourceLabel(m)}
                    </td>
                    <td style={{ padding: '10px 14px', cursor: isClickable ? 'pointer' : 'default' }} onClick={() => isClickable && handleRowClick(m)}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, letterSpacing: '0.04em',
                        padding: '2px 8px', borderRadius: 99,
                        textTransform: 'uppercase',
                        ...statusStyle,
                      }}>
                        {m.status}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
