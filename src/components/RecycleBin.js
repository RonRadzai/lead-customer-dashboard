import { useState, useEffect, useCallback } from 'react';
import { EmptyState } from './Skeleton';

const RECYCLE_KEY = 'lcd-recycle-bin-links';
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function daysRemaining(deletedAt) {
  const expiry = new Date(deletedAt).getTime() + SEVEN_DAYS_MS;
  const ms = expiry - Date.now();
  if (ms <= 0) return 0;
  const days = Math.floor(ms / (1000 * 60 * 60 * 24));
  const hours = Math.floor((ms % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  return days > 0 ? `${days}d` : `${hours}h`;
}

function formatDeletedAt(dateStr) {
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function ExpiryBadge({ deletedAt }) {
  const remaining = daysRemaining(deletedAt);
  const urgent = typeof remaining === 'string' && remaining.endsWith('h');
  return (
    <span style={{
      fontSize: 11, padding: '2px 7px', borderRadius: 99, fontWeight: 600,
      background: urgent ? 'rgba(239,68,68,0.12)' : 'rgba(156,163,175,0.15)',
      color: urgent ? '#ef4444' : 'var(--text-secondary)',
    }}>
      {remaining === 0 ? 'Expiring…' : `Expires in ${remaining}`}
    </span>
  );
}

function BinRow({ checked, onToggle, onRestore, children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
      padding: '12px 14px', borderRadius: 8,
      background: 'var(--bg-secondary)', border: '1px solid var(--border-color)',
      gap: 12,
    }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        style={{ marginTop: 3, cursor: 'pointer' }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
      <button className="btn btn-secondary" style={{ fontSize: 12, padding: '3px 10px', flexShrink: 0 }} onClick={onRestore}>
        Restore
      </button>
    </div>
  );
}

function SectionHeader({ title, items, selected, onToggleAll, onBulkDelete }) {
  const allChecked = items.length > 0 && selected.size === items.length;
  const someChecked = selected.size > 0 && selected.size < items.length;
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <input
          type="checkbox"
          checked={allChecked}
          ref={el => { if (el) el.indeterminate = someChecked; }}
          onChange={onToggleAll}
          disabled={items.length === 0}
          style={{ cursor: items.length === 0 ? 'default' : 'pointer' }}
        />
        <span className="section-title" style={{ margin: 0 }}>{title}</span>
        {items.length > 0 && (
          <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {selected.size > 0 ? `${selected.size} of ${items.length} selected` : `${items.length} item${items.length !== 1 ? 's' : ''}`}
          </span>
        )}
      </div>
      {selected.size > 0 && (
        <button
          onClick={onBulkDelete}
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
  );
}

function EmptySection() {
  return <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: 13 }}>Nothing here.</p>;
}

// ── localStorage helpers for meeting links ─────────────────────────────────
function loadRecycledLinks() {
  try {
    const raw = JSON.parse(localStorage.getItem(RECYCLE_KEY) || '[]');
    const live = raw.filter(l => Date.now() - new Date(l.deleted_at).getTime() < SEVEN_DAYS_MS);
    if (live.length !== raw.length) localStorage.setItem(RECYCLE_KEY, JSON.stringify(live));
    return live;
  } catch { return []; }
}

function saveRecycledLinks(links) {
  localStorage.setItem(RECYCLE_KEY, JSON.stringify(links));
}

// ── Main page ──────────────────────────────────────────────────────────────
export default function RecycleBin() {
  const [notes, setNotes]         = useState([]);
  const [activity, setActivity]   = useState([]);
  const [leads, setLeads]         = useState([]);
  const [users, setUsers]         = useState([]);
  const [meetings, setMeetings]   = useState([]);
  const [links, setLinks]         = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState(null);

  // Per-section selection state (Sets of ids)
  const [selNotes, setSelNotes]         = useState(new Set());
  const [selActivity, setSelActivity]   = useState(new Set());
  const [selLeads, setSelLeads]         = useState(new Set());
  const [selUsers, setSelUsers]         = useState(new Set());
  const [selMeetings, setSelMeetings]   = useState(new Set());
  const [selLinks, setSelLinks]         = useState(new Set());

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/recycle-bin');
      if (!res.ok) throw new Error('Failed to load recycle bin');
      const data = await res.json();
      setNotes(data.notes || []);
      setActivity(data.activity || []);
      setLeads(data.leads || []);
      setUsers(data.users || []);
      setMeetings(data.meetings || []);
      setLinks(loadRecycledLinks());
      setSelNotes(new Set()); setSelActivity(new Set());
      setSelLeads(new Set()); setSelUsers(new Set());
      setSelMeetings(new Set()); setSelLinks(new Set());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  function toggleId(setter) {
    return (id) => setter(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll(setter, items) {
    return () => setter(prev => prev.size === items.length ? new Set() : new Set(items.map(i => i.id ?? i.url)));
  }

  async function restoreDb(type, id) {
    await fetch(`/api/recycle-bin/restore/${type}/${id}`, { method: 'POST' });
    load();
  }

  async function bulkDeleteDb(type, selected, label) {
    const ids = Array.from(selected);
    if (ids.length === 0) return;
    if (!window.confirm(`Permanently delete ${ids.length} ${label}? This cannot be undone.`)) return;
    await fetch('/api/recycle-bin/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, ids }),
    });
    load();
  }

  function restoreLink(url) {
    const recycled = loadRecycledLinks();
    const link = recycled.find(l => l.url === url);
    if (!link) return;
    const active = (() => {
      try { return JSON.parse(localStorage.getItem('lcd-custom-calendly-links') || '[]'); }
      catch { return []; }
    })();
    const { deleted_at, ...clean } = link;
    active.push(clean);
    localStorage.setItem('lcd-custom-calendly-links', JSON.stringify(active));
    const updated = recycled.filter(l => l.url !== url);
    saveRecycledLinks(updated);
    setLinks(updated);
    setSelLinks(prev => { const n = new Set(prev); n.delete(url); return n; });
  }

  function bulkDeleteLinks() {
    const urls = Array.from(selLinks);
    if (urls.length === 0) return;
    if (!window.confirm(`Permanently delete ${urls.length} link${urls.length !== 1 ? 's' : ''}? This cannot be undone.`)) return;
    const updated = loadRecycledLinks().filter(l => !selLinks.has(l.url));
    saveRecycledLinks(updated);
    setLinks(updated);
    setSelLinks(new Set());
  }

  const isEmpty = notes.length === 0 && activity.length === 0 && leads.length === 0 && users.length === 0 && meetings.length === 0 && links.length === 0;

  if (loading) return (
    <div className="loading-state"><div className="loading-spinner" />Loading…</div>
  );
  if (error) return <div className="error-state">{error}</div>;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Recycle Bin</h1>
          <p>Items are permanently deleted after 7 days.</p>
        </div>
      </div>

      {isEmpty && (
        <EmptyState
          icon="trash"
          title="Recycle bin is empty"
          description="Deleted leads, users, meetings, notes, activity entries, and custom meeting links will appear here."
        />
      )}

      {/* Leads */}
      {!isEmpty && (
        <div className="detail-info-block">
          <SectionHeader
            title="Leads"
            items={leads}
            selected={selLeads}
            onToggleAll={toggleAll(setSelLeads, leads)}
            onBulkDelete={() => bulkDeleteDb('lead', selLeads, selLeads.size === 1 ? 'lead' : 'leads')}
          />
          {leads.length === 0 ? <EmptySection /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {leads.map(l => {
                const adBits = [l.platform, l.campaign_name, l.ad_name].filter(Boolean);
                return (
                  <BinRow
                    key={l.id}
                    checked={selLeads.has(l.id)}
                    onToggle={() => toggleId(setSelLeads)(l.id)}
                    onRestore={() => restoreDb('lead', l.id)}
                  >
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 4 }}>
                      {l.first_name} {l.last_name}
                      {l.org_name && <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}> — {l.org_name}</span>}
                    </div>
                    <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                      {l.email && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>✉ {l.email}</span>}
                      {adBits.length > 0 && (
                        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{adBits.join(' · ')}</span>
                      )}
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Deleted {formatDeletedAt(l.deleted_at)}</span>
                      <ExpiryBadge deletedAt={l.deleted_at} />
                    </div>
                  </BinRow>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Users */}
      {!isEmpty && (
        <div className="detail-info-block">
          <SectionHeader
            title="Users"
            items={users}
            selected={selUsers}
            onToggleAll={toggleAll(setSelUsers, users)}
            onBulkDelete={() => bulkDeleteDb('user', selUsers, selUsers.size === 1 ? 'user' : 'users')}
          />
          {users.length === 0 ? <EmptySection /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {users.map(u => (
                <BinRow
                  key={u.id}
                  checked={selUsers.has(u.id)}
                  onToggle={() => toggleId(setSelUsers)(u.id)}
                  onRestore={() => restoreDb('user', u.id)}
                >
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 4 }}>
                    {u.first_name} {u.last_name}
                    {u.org_name && <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}> — {u.org_name}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    {u.email && <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>✉ {u.email}</span>}
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Deleted {formatDeletedAt(u.deleted_at)}</span>
                    <ExpiryBadge deletedAt={u.deleted_at} />
                  </div>
                </BinRow>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Meetings */}
      {!isEmpty && (
        <div className="detail-info-block">
          <SectionHeader
            title="Meetings"
            items={meetings}
            selected={selMeetings}
            onToggleAll={toggleAll(setSelMeetings, meetings)}
            onBulkDelete={() => bulkDeleteDb('meeting', selMeetings, selMeetings.size === 1 ? 'meeting' : 'meetings')}
          />
          {meetings.length === 0 ? <EmptySection /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {meetings.map(m => (
                <BinRow
                  key={m.id}
                  checked={selMeetings.has(m.id)}
                  onToggle={() => toggleId(setSelMeetings)(m.id)}
                  onRestore={() => restoreDb('meeting', m.id)}
                >
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 4 }}>
                    {m.event_name || 'Meeting'}
                    {m.contact_name && <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}> — {m.contact_name}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    {m.scheduled_at && (
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        {new Date(m.scheduled_at + (m.scheduled_at.endsWith('Z') ? '' : 'Z')).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })}
                      </span>
                    )}
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Deleted {formatDeletedAt(m.deleted_at)}</span>
                    <ExpiryBadge deletedAt={m.deleted_at} />
                  </div>
                </BinRow>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Notes */}
      {!isEmpty && (
        <div className="detail-info-block">
          <SectionHeader
            title="Notes"
            items={notes}
            selected={selNotes}
            onToggleAll={toggleAll(setSelNotes, notes)}
            onBulkDelete={() => bulkDeleteDb('note', selNotes, selNotes.size === 1 ? 'note' : 'notes')}
          />
          {notes.length === 0 ? <EmptySection /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {notes.map(n => (
                <BinRow
                  key={n.id}
                  checked={selNotes.has(n.id)}
                  onToggle={() => toggleId(setSelNotes)(n.id)}
                  onRestore={() => restoreDb('note', n.id)}
                >
                  <div style={{ fontSize: 13, color: 'var(--text-primary)', marginBottom: 4 }}>
                    {n.content.length > 120 ? n.content.slice(0, 120) + '…' : n.content}
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    {n.record_name && (
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        {n.record_type === 'lead' ? 'Lead' : 'User'}: {n.record_name}
                      </span>
                    )}
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Deleted {formatDeletedAt(n.deleted_at)}</span>
                    <ExpiryBadge deletedAt={n.deleted_at} />
                  </div>
                </BinRow>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Activity Log */}
      {!isEmpty && (
        <div className="detail-info-block">
          <SectionHeader
            title="Activity Log Entries"
            items={activity}
            selected={selActivity}
            onToggleAll={toggleAll(setSelActivity, activity)}
            onBulkDelete={() => bulkDeleteDb('activity', selActivity, selActivity.size === 1 ? 'activity entry' : 'activity entries')}
          />
          {activity.length === 0 ? <EmptySection /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {activity.map(a => (
                <BinRow
                  key={a.id}
                  checked={selActivity.has(a.id)}
                  onToggle={() => toggleId(setSelActivity)(a.id)}
                  onRestore={() => restoreDb('activity', a.id)}
                >
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 4 }}>
                    {a.action.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
                    {a.details && <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}> — {a.details}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    {a.record_name && (
                      <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        {a.record_type === 'lead' ? 'Lead' : 'User'}: {a.record_name}
                      </span>
                    )}
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Deleted {formatDeletedAt(a.deleted_at)}</span>
                    <ExpiryBadge deletedAt={a.deleted_at} />
                  </div>
                </BinRow>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Custom Meeting Links (localStorage-only) */}
      {!isEmpty && (
        <div className="detail-info-block">
          <SectionHeader
            title="Custom Meeting Links"
            items={links.map(l => ({ id: l.url }))}
            selected={selLinks}
            onToggleAll={() => setSelLinks(prev => prev.size === links.length ? new Set() : new Set(links.map(l => l.url)))}
            onBulkDelete={bulkDeleteLinks}
          />
          {links.length === 0 ? <EmptySection /> : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {links.map(l => (
                <BinRow
                  key={l.url}
                  checked={selLinks.has(l.url)}
                  onToggle={() => toggleId(setSelLinks)(l.url)}
                  onRestore={() => restoreLink(l.url)}
                >
                  <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)', marginBottom: 4 }}>
                    {l.label}
                    {l.owner && <span style={{ fontWeight: 400, color: 'var(--text-secondary)' }}> — {l.owner}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Deleted {formatDeletedAt(l.deleted_at)}</span>
                    <ExpiryBadge deletedAt={l.deleted_at} />
                  </div>
                </BinRow>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
