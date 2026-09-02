// Detail-page sections shared by LeadDetail and NewUserDetail:
// Meetings (with per-meeting notes), General Notes, Activity Log, Email History.
import { useState, useEffect, useRef } from 'react';
import { formatDateTime, formatRelative, formatAction } from '../utils/format';

// ─── Meeting Notes ──────────────────────────────────────────────────────────
function MeetingNotes({ meeting, recordType, recordId, onNoteAdded, currentUser, topics }) {
  const [content, setContent]           = useState('');
  const [topic, setTopic]               = useState('');
  const [saving, setSaving]             = useState(false);
  const [editingId, setEditingId]       = useState(null);
  const [editContent, setEditContent]   = useState('');
  const [localDeleted, setLocalDeleted] = useState(new Set());
  const [localEdits, setLocalEdits]     = useState({});

  async function handleSubmit(e) {
    e.preventDefault();
    if (!content.trim()) return;
    setSaving(true);
    try {
      const res = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record_type: recordType, record_id: recordId, content: content.trim(), author: currentUser?.name || 'Team', meeting_id: meeting.id, topic: topic || null }),
      });
      if (!res.ok) throw new Error('Failed to save note');
      const note = await res.json();
      setContent('');
      setTopic('');
      onNoteAdded(meeting.id, note);
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit(id) {
    const trimmed = editContent.trim();
    if (!trimmed) return;
    await fetch(`/api/notes/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: trimmed }) });
    setLocalEdits(e => ({ ...e, [id]: { content: trimmed } }));
    setEditingId(null);
  }

  async function deleteNote(id) {
    await fetch(`/api/notes/${id}`, { method: 'DELETE' });
    setLocalDeleted(s => new Set([...s, id]));
  }

  const visibleNotes = (meeting.notes || []).filter(n => !localDeleted.has(n.id));

  return (
    <div style={{ marginTop: 10 }}>
      {visibleNotes.length > 0 && (
        <div className="notes-thread" style={{ marginBottom: 8 }}>
          {visibleNotes.map(note => {
            const displayContent = localEdits[note.id]?.content ?? note.content;
            const isEditing = editingId === note.id;
            return (
            <div key={note.id} className="note-item" style={{ position: 'relative' }}>
              <div className="note-item-header">
                <span className="note-author">{note.author}</span>
                {note.topic && (
                  <span style={{ fontSize: 10, fontWeight: 700, padding: '1px 7px', borderRadius: 99,
                    background: 'rgba(139,92,246,0.15)', color: '#8b5cf6', marginLeft: 6 }}>
                    {note.topic}
                  </span>
                )}
                <span className="note-time">{formatRelative(note.created_at)}</span>
                <button onClick={() => { setEditingId(note.id); setEditContent(displayContent); }} title="Edit note"
                  style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--text-secondary)', fontSize: 12, padding: '0 3px', opacity: 0.5 }}>✏</button>
                <button onClick={() => deleteNote(note.id)} title="Move to recycle bin"
                  style={{ background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--text-secondary)', fontSize: 15, padding: '0 3px', lineHeight: 1, opacity: 0.4 }}>×</button>
              </div>
              {isEditing ? (
                <div style={{ marginTop: 4 }}>
                  <textarea value={editContent} onChange={e => setEditContent(e.target.value)} rows={2}
                    style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6,
                      fontSize: 13, border: '1px solid var(--border-color)', background: 'var(--bg-primary)',
                      color: 'var(--text-primary)', resize: 'vertical' }} autoFocus />
                  <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                    <button className="btn btn-primary btn-sm" onClick={() => saveEdit(note.id)} disabled={!editContent.trim()}>Save</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <div className="note-content">{displayContent}</div>
              )}
            </div>
            );
          })}
        </div>
      )}
      <form className="add-note-form" onSubmit={handleSubmit}>
        {topics && topics.length > 0 && (
          <select
            className="filter-select"
            value={topic}
            onChange={e => setTopic(e.target.value)}
            style={{ marginBottom: 6, width: '100%' }}
          >
            <option value="">— Topic (optional) —</option>
            {topics.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
          </select>
        )}
        <textarea placeholder="Add a note for this meeting…" value={content} onChange={e => setContent(e.target.value)} rows={2} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving || !content.trim()}>
          {saving ? 'Saving…' : 'Add Note'}
        </button>
      </form>
    </div>
  );
}

// ─── Meetings Section ───────────────────────────────────────────────────────
// Pass initialMeetingId to auto-expand and scroll to a specific meeting on load.
export function MeetingsSection({ meetings, recordType, recordId, onMeetingUpdated, onNoteAdded, currentUser, topics, initialMeetingId }) {
  const [expanded, setExpanded] = useState(() => initialMeetingId ? { [initialMeetingId]: true } : {});
  const [acting, setActing]     = useState(null);
  const rowRefs = useRef({});

  useEffect(() => {
    if (!initialMeetingId || meetings.length === 0) return;
    const el = rowRefs.current[initialMeetingId];
    if (el) {
      const container = el.closest('.page-container');
      if (container) {
        const offset = el.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop - 100;
        container.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
      } else {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }, [initialMeetingId, meetings]);

  function toggle(id) { setExpanded(e => ({ ...e, [id]: !e[id] })); }

  async function updateStatus(meetingId, status) {
    setActing(meetingId);
    try {
      await fetch(`/api/meetings/${meetingId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      onMeetingUpdated();
    } finally {
      setActing(null);
    }
  }

  const statusColor = { scheduled: 'var(--accent-purple)', completed: 'var(--accent-green)', canceled: 'var(--text-secondary)' };
  const statusLabel = { scheduled: 'Scheduled', completed: 'Completed', canceled: 'Canceled' };

  return (
    <div className="detail-info-block">
      <div className="section-title">Meetings</div>
      {meetings.length === 0 ? (
        <p className="text-muted">No meetings yet. Calendly events will appear here automatically.</p>
      ) : (
        meetings.map(m => (
          <div key={m.id} ref={el => { rowRefs.current[m.id] = el; }} style={{
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-sm)',
            marginBottom: 10,
            overflow: 'hidden',
          }}>
            <div
              onClick={() => toggle(m.id)}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                padding: '10px 14px', cursor: 'pointer',
                background: expanded[m.id] ? 'var(--bg-input)' : 'transparent',
              }}
            >
              <div>
                <span style={{ fontWeight: 600, fontSize: 14 }}>{m.event_name || 'Meeting'}</span>
                <span style={{ marginLeft: 10, fontSize: 13, color: 'var(--text-secondary)' }}>
                  {m.scheduled_at ? formatDateTime(m.scheduled_at) : '—'}
                </span>
                {m.source_calendar && (
                  <span className="badge badge-sm badge-neutral" style={{ marginLeft: 8 }}>{m.source_calendar === 'Zoom' ? 'Zoom' : `${m.source_calendar.split(' ')[0]}'s calendar`}</span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: statusColor[m.status] }}>
                  {statusLabel[m.status] || m.status}
                </span>
                {m.notes && m.notes.length > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                    {m.notes.length} note{m.notes.length !== 1 ? 's' : ''}
                  </span>
                )}
                <span style={{ color: 'var(--text-secondary)', fontSize: 12 }}>{expanded[m.id] ? '▲' : '▼'}</span>
              </div>
            </div>

            {expanded[m.id] && (
              <div style={{ padding: '12px 14px', borderTop: '1px solid var(--border-color)' }}>
                {m.status === 'scheduled' && (
                  <div className="flex gap-8" style={{ marginBottom: 12 }}>
                    <button className="btn btn-success btn-sm" disabled={acting === m.id} onClick={() => updateStatus(m.id, 'completed')}>
                      ✓ Mark Completed
                    </button>
                    <button className="btn btn-danger btn-sm" disabled={acting === m.id} onClick={() => updateStatus(m.id, 'canceled')}>
                      ✗ Cancel Meeting
                    </button>
                  </div>
                )}
                <MeetingNotes meeting={m} recordType={recordType} recordId={recordId} onNoteAdded={onNoteAdded} currentUser={currentUser} topics={topics} />
              </div>
            )}
          </div>
        ))
      )}
    </div>
  );
}

// ─── General Notes Section ──────────────────────────────────────────────────
export function NotesSection({ recordType, recordId, notes, onNoteAdded, onNoteDeleted, onNotesBulkDeleted, onNoteEdited, currentUser }) {
  const [content, setContent]         = useState('');
  const [saving, setSaving]           = useState(false);
  const [error, setError]             = useState(null);
  const [selected, setSelected]       = useState(new Set());
  const [editingId, setEditingId]     = useState(null);
  const [editContent, setEditContent] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    if (!content.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ record_type: recordType, record_id: recordId, content: content.trim(), author: currentUser?.name || 'Team' }),
      });
      if (!res.ok) throw new Error('Failed to save note');
      const note = await res.json();
      setContent('');
      onNoteAdded(note);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteNote(id) {
    await fetch(`/api/notes/${id}`, { method: 'DELETE' });
    onNoteDeleted(id);
  }

  async function saveEdit(id) {
    const trimmed = editContent.trim();
    if (!trimmed) return;
    const res = await fetch(`/api/notes/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ content: trimmed }) });
    if (res.ok) {
      const updated = await res.json();
      onNoteEdited && onNoteEdited(id, updated);
    }
    setEditingId(null);
  }

  function toggleId(id) {
    setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleAll() {
    setSelected(s => s.size === notes.length ? new Set() : new Set(notes.map(n => n.id)));
  }
  async function handleBulkDelete() {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (!window.confirm(`Move ${ids.length} note${ids.length !== 1 ? 's' : ''} to the recycle bin?`)) return;
    await fetch('/api/notes/bulk-soft-delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    onNotesBulkDeleted(ids);
    setSelected(new Set());
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="checkbox"
            checked={notes.length > 0 && selected.size === notes.length}
            ref={el => { if (el) el.indeterminate = selected.size > 0 && selected.size < notes.length; }}
            onChange={toggleAll}
            disabled={notes.length === 0}
            style={{ cursor: notes.length === 0 ? 'default' : 'pointer' }}
          />
          <span className="section-title" style={{ margin: 0 }}>General Notes</span>
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
      {notes.length === 0 ? (
        <p className="text-muted" style={{ marginBottom: 12 }}>No general notes yet.</p>
      ) : (
        <div className="notes-thread" style={{ marginBottom: 12 }}>
          {notes.map(note => {
            const isEditing = editingId === note.id;
            return (
            <div key={note.id} className="note-item" style={{ position: 'relative', display: 'flex', gap: 10 }}>
              <input
                type="checkbox"
                checked={selected.has(note.id)}
                onChange={() => toggleId(note.id)}
                style={{ marginTop: 3, flexShrink: 0, cursor: 'pointer' }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="note-item-header">
                  <span className="note-author">{note.author}</span>
                  <span className="note-time">{formatRelative(note.created_at)}</span>
                  <button onClick={() => { setEditingId(note.id); setEditContent(note.content); }} title="Edit note"
                    style={{ marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--text-secondary)', fontSize: 12, padding: '0 3px', opacity: 0.5 }}>✏</button>
                  <button onClick={() => handleDeleteNote(note.id)} title="Move to recycle bin"
                    style={{ background: 'none', border: 'none', cursor: 'pointer',
                      color: 'var(--text-secondary)', fontSize: 15, padding: '0 3px', lineHeight: 1, opacity: 0.4 }}>×</button>
                </div>
                {isEditing ? (
                  <div style={{ marginTop: 4 }}>
                    <textarea value={editContent} onChange={e => setEditContent(e.target.value)} rows={3}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', borderRadius: 6,
                        fontSize: 13, border: '1px solid var(--border-color)', background: 'var(--bg-primary)',
                        color: 'var(--text-primary)', resize: 'vertical' }} autoFocus />
                    <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
                      <button className="btn btn-primary btn-sm" onClick={() => saveEdit(note.id)} disabled={!editContent.trim()}>Save</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                    </div>
                  </div>
                ) : (
                  <div className="note-content">{note.content}</div>
                )}
              </div>
            </div>
            );
          })}
        </div>
      )}
      <form className="add-note-form" onSubmit={handleSubmit}>
        {error && <div className="error-state">{error}</div>}
        <textarea placeholder="Add a general note…" value={content} onChange={e => setContent(e.target.value)} rows={3} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={saving || !content.trim()}>
          {saving ? 'Saving…' : 'Add Note'}
        </button>
      </form>
    </div>
  );
}

// ─── Activity Log Section ───────────────────────────────────────────────────
export function ActivitySection({ activity, onActivityDeleted, onActivityBulkDeleted }) {
  const [selected, setSelected] = useState(new Set());

  async function handleDeleteActivity(id) {
    await fetch(`/api/activity/${id}`, { method: 'DELETE' });
    onActivityDeleted(id);
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
    onActivityBulkDeleted(ids);
    setSelected(new Set());
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <input
            type="checkbox"
            checked={activity.length > 0 && selected.size === activity.length}
            ref={el => { if (el) el.indeterminate = selected.size > 0 && selected.size < activity.length; }}
            onChange={toggleAll}
            disabled={activity.length === 0}
            style={{ cursor: activity.length === 0 ? 'default' : 'pointer' }}
          />
          <span className="section-title" style={{ margin: 0 }}>Activity Log</span>
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
        <p className="text-muted">No activity yet.</p>
      ) : (
        <div className="activity-log">
          {activity.map(item => {
            const isCanceled = item.action === 'meeting_canceled' ||
              (item.action === 'demo_scheduled' && item.details?.includes('— Canceled'));
            const displayDetails = isCanceled
              ? item.details?.replace(/ — Canceled$/, '')
              : item.details;
            return (
            <div key={item.id} className="activity-item">
              <input
                type="checkbox"
                checked={selected.has(item.id)}
                onChange={() => toggleId(item.id)}
                style={{ marginRight: 6, cursor: 'pointer' }}
              />
              <div className="activity-dot" />
              <div className="activity-content">
                <div className="activity-action">
                  <span style={isCanceled ? { textDecoration: 'line-through', opacity: 0.55 } : {}}>
                    {formatAction(isCanceled ? 'demo_scheduled' : item.action)}
                  </span>
                  {isCanceled && (
                    <span style={{ fontSize: 10, fontWeight: 700, marginLeft: 6,
                      padding: '1px 6px', borderRadius: 99,
                      background: 'rgba(239,68,68,0.15)', color: '#ef4444',
                      letterSpacing: '0.04em' }}>CANCELED</span>
                  )}
                </div>
                {displayDetails && !item.demo_scheduled_at && (
                  <div className="activity-details">{displayDetails}</div>
                )}
                {item.demo_scheduled_at && (
                  <div className="activity-meeting-date"
                    style={isCanceled ? { opacity: 0.5, textDecoration: 'line-through' } : {}}>
                    📅 {new Date(item.demo_scheduled_at).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </div>
                )}
                {item.performed_by && <div className="text-muted mt-4">by {item.performed_by}</div>}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="activity-time">{formatRelative(item.created_at)}</div>
                <button onClick={() => handleDeleteActivity(item.id)} title="Move to recycle bin"
                  style={{ background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--text-secondary)', fontSize: 15, padding: '0 3px',
                    lineHeight: 1, opacity: 0.4 }}>×</button>
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Email History ─────────────────────────────────────────────────────────
export function EmailHistorySection({ recordType, recordId }) {
  const [emails, setEmails]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/emails/${recordType}/${recordId}`)
      .then(r => r.json())
      .then(data => { if (!cancelled) { setEmails(Array.isArray(data) ? data : []); setLoading(false); } })
      .catch(() => { if (!cancelled) { setError('Could not load email history'); setLoading(false); } });
    return () => { cancelled = true; };
  }, [recordType, recordId]);

  return (
    <div className="detail-info-block">
      <div className="section-title">Email History</div>
      {loading && <p className="text-muted">Loading…</p>}
      {error   && <p className="text-muted">{error}</p>}
      {!loading && !error && emails.length === 0 && (
        <p className="text-muted">No emails found in Outlook for this contact.</p>
      )}
      {!loading && !error && emails.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {emails.map(msg => (
            <div key={msg.id} style={{
              display: 'flex', alignItems: 'baseline', gap: 10,
              padding: '7px 10px', borderRadius: 'var(--radius-sm)',
              background: 'var(--bg-input)', fontSize: 13,
            }}>
              <span style={{
                flexShrink: 0, fontWeight: 700, fontSize: 11,
                color: msg.direction === 'sent' ? 'var(--accent-blue)' : 'var(--accent-green)',
              }}>
                {msg.direction === 'sent' ? '→' : '←'}
              </span>
              <span style={{ flexShrink: 0, color: 'var(--text-secondary)', fontSize: 12, whiteSpace: 'nowrap' }}>
                {new Date(msg.date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </span>
              <span style={{ flexShrink: 0, color: 'var(--text-secondary)', fontSize: 12 }}>{msg.teamMember}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {msg.subject}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
