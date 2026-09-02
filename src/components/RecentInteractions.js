import { useState, useEffect, useCallback } from 'react';
import { SkeletonList, EmptyState } from './Skeleton';
import { toDate, formatShortDate } from '../utils/format';

const ACTION_LABELS = {
  created:          'Record created',
  stage_changed:    'Stage changed',
  converted:        'Converted',
  lost:             'Marked lost',
  attempt_logged:   'Contact attempt',
  attempt_reverted: 'Attempt reverted',
  note_added:       'Note added',
  category_changed: 'Category changed',
  status_changed:   'Status changed',
  demo_scheduled:   'Demo scheduled',
  meeting_completed:'Meeting completed',
  meeting_canceled: 'Meeting canceled',
};

function activityLabel(act) {
  if (act.type === 'note')     return 'Note added';
  if (act.type === 'meeting')  return act.label || 'Meeting';
  if (act.type === 'zendesk')  return act.label || 'Zendesk ticket';
  if (act.type === 'support')  return act.label || 'Support session';
  return ACTION_LABELS[act.label] || act.label;
}

const TYPE_COLOR = {
  meeting:  'var(--accent-blue)',
  note:     '#22c55e',
  zendesk:  '#f59e0b',
  support:  '#a855f7',
  activity: 'var(--text-muted)',
};

const DAY_OPTIONS = [7, 14, 30, 60, 90];

function UserTable({ users, onSelectUser }) {
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th style={{ width: 110 }}>Date</th>
            <th>Name</th>
            <th>Org</th>
            <th>Activity</th>
          </tr>
        </thead>
        <tbody>
          {users.map(user => (
            <tr key={user.id} className="tbl-row" onClick={() => onSelectUser(user)}>
              <td className="tbl-date">{formatShortDate(user.last_activity_at)}</td>
              <td>
                <div className="tbl-name">{user.first_name} {user.last_name}</div>
                <div className="tbl-sub">{user.email}</div>
              </td>
              <td>
                {user.org_name || <span className="text-muted">—</span>}
                {user.org_count > 1 && (
                  <span className="badge badge-sm badge-neutral" style={{ marginLeft: 6 }}>{user.org_count} orgs</span>
                )}
              </td>
              <td>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {(user.recent_activities || []).map((act, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                      <span style={{
                        width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                        background: TYPE_COLOR[act.type] || 'var(--text-muted)',
                      }} />
                      <span style={{ color: 'var(--text-secondary)' }}>
                        {activityLabel(act)}
                        {act.type === 'meeting' && act.extra && (
                          <span style={{ marginLeft: 4, color: 'var(--text-muted)' }}>({act.extra})</span>
                        )}
                        {act.type === 'zendesk' && act.extra && (
                          <span style={{ marginLeft: 4, color: 'var(--text-muted)', fontStyle: 'italic' }}>{act.extra}</span>
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function RecentInteractions({ onSelectUser }) {
  const [activityDays, setActivityDays] = useState(7);
  const [users, setUsers]               = useState([]);
  const [loading, setLoading]           = useState(true);
  const [error, setError]               = useState(null);
  const [searchInput, setSearchInput]   = useState('');
  const [searchQuery, setSearchQuery]   = useState('');

  const filteredUsers = searchQuery.trim()
    ? users.filter(u => {
        const q = searchQuery.toLowerCase();
        return (u.first_name + ' ' + u.last_name).toLowerCase().includes(q)
          || (u.email || '').toLowerCase().includes(q)
          || (u.org_name || '').toLowerCase().includes(q);
      })
    : users;

  const fetchActivity = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/established-users/recent-activity?days=${activityDays}`);
      if (!res.ok) throw new Error('Failed to load recent interactions');
      const data = await res.json();
      setUsers(data.users);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [activityDays]);

  useEffect(() => { fetchActivity(); }, [fetchActivity]);

  useEffect(() => {
    const interval = setInterval(() => fetchActivity(true), 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchActivity]);

  const now = new Date();
  const upcomingUsers = filteredUsers.filter(u => toDate(u.last_activity_at) > now);
  const recentUsers   = filteredUsers.filter(u => toDate(u.last_activity_at) <= now);
  const displayTotal  = filteredUsers.length;

  function handleExport() {
    window.open(`/api/established-users/recent-activity/export?days=${activityDays}`, '_blank');
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Recent Interactions</h1>
          <p>{displayTotal} user{displayTotal !== 1 ? 's' : ''} with recent activity</p>
        </div>
        <button className="btn btn-secondary btn-sm" onClick={handleExport}>⬇ Export CSV</button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <span style={{ color: 'var(--text-secondary)' }}>Last</span>
          <select
            value={activityDays}
            onChange={e => setActivityDays(Number(e.target.value))}
            style={{
              fontSize: 13,
              padding: '3px 8px',
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
          </select>
        </div>
      </div>

      <div className="filter-bar" style={{ maxWidth: 480, marginBottom: 16 }}>
        <input
          type="text"
          className="search-input"
          placeholder="Filter by name, email, org…"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && setSearchQuery(searchInput)}
          style={{ flex: 1 }}
        />
        <button className="btn btn-secondary btn-sm" onClick={() => setSearchQuery(searchInput)}>Search</button>
        {searchQuery && (
          <button className="btn btn-secondary btn-sm" onClick={() => { setSearchInput(''); setSearchQuery(''); }}>Clear</button>
        )}
      </div>

      {error && <div className="error-state">{error}</div>}
      {loading ? (
        <SkeletonList count={6} />
      ) : filteredUsers.length === 0 ? (
        <EmptyState
          icon="activity"
          title="No recent interactions"
          description={searchQuery
            ? 'No users match that search.'
            : `No established users had meetings, notes, or tracked interactions in the last ${activityDays} day${activityDays !== 1 ? 's' : ''}.`}
        />
      ) : (
        <>
          {upcomingUsers.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                Upcoming ({upcomingUsers.length})
              </div>
              <UserTable users={upcomingUsers} onSelectUser={onSelectUser} />
            </div>
          )}
          {recentUsers.length > 0 && (
            <div>
              {upcomingUsers.length > 0 && (
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                  Recent ({recentUsers.length})
                </div>
              )}
              <UserTable users={recentUsers} onSelectUser={onSelectUser} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
