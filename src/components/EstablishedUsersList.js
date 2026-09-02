import { useState, useEffect, useCallback } from 'react';
import MetaIcon from './MetaIcon';
import { SkeletonList, EmptyState } from './Skeleton';
import { formatShortDate } from '../utils/format';

export default function EstablishedUsersList({ filters, onFiltersChange, onSelectUser }) {
  const [users, setUsers]     = useState([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  const { search = '' } = filters || {};
  const setSearch = v => onFiltersChange(f => ({ ...f, search: v }));
  const [searchInput, setSearchInput] = useState(search);

  const isGlobalSearch = search.trim().length > 0;

  const fetchUsers = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      const res = await fetch(`/api/established-users?${params}`);
      if (!res.ok) throw new Error('Failed to load users');
      const data = await res.json();
      setUsers(data.users);
      setTotal(data.total);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [search]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  useEffect(() => {
    const interval = setInterval(() => fetchUsers(true), 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchUsers]);

  function handleExport() {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    window.open(`/api/established-users/export?${params}`, '_blank');
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Established Users</h1>
          <p>{total} user{total !== 1 ? 's' : ''} found</p>
        </div>
        <div className="flex gap-8">
          <button className="btn btn-secondary btn-sm" onClick={handleExport}>
            ⬇ Export CSV
          </button>
        </div>
      </div>

      <div style={{
        background: 'var(--bg-input)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--radius-sm)',
        padding: '10px 14px',
        fontSize: 13,
        color: 'var(--text-secondary)',
        marginBottom: 16,
      }}>
        Established users are anyone added before 1/1/2026, or added in 2026 or later who has been in the system for 6+ months.
        {isGlobalSearch && (
          <span style={{ marginLeft: 6, color: 'var(--accent-blue)', fontWeight: 500 }}>
            — Search is showing results across all users.
          </span>
        )}
      </div>

      <div className="filter-bar" style={{ maxWidth: 480 }}>
        <input
          type="text"
          className="search-input"
          placeholder="Search by name, email, org…"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && setSearch(searchInput)}
          style={{ flex: 1 }}
        />
        <button className="btn btn-secondary btn-sm" onClick={() => setSearch(searchInput)}>Search</button>
        {search && (
          <button className="btn btn-secondary btn-sm" onClick={() => { setSearchInput(''); setSearch(''); }}>Clear</button>
        )}
      </div>

      {error && <div className="error-state">{error}</div>}
      {loading ? (
        <SkeletonList count={6} />
      ) : users.length === 0 ? (
        <EmptyState
          icon={isGlobalSearch ? 'search' : 'users'}
          title={isGlobalSearch ? 'No users found' : 'No established users yet'}
          description={isGlobalSearch
            ? 'Try a different search term or broaden your filters.'
            : 'Users appear here once they are 6+ months old or were added before 2026.'}
        />
      ) : (
        <div className="record-list">
          {users.map(user => (
            <div key={user.id} className="record-card" onClick={() => onSelectUser(user)}>
              <div className="record-card-header">
                <span className="record-card-name">
                  {user.first_name} {user.last_name}
                  {user.org_name && <span className="record-card-org">· {user.org_name}</span>}
                  {user.organization_id && <span className="record-card-orgid">· {user.organization_id}</span>}
                </span>
                {user.org_count > 1 && (
                  <span className="badge badge-sm badge-neutral">{user.org_count} orgs</span>
                )}
                {isGlobalSearch && (
                  <span className={`badge badge-sm ${user.user_type === 'new_user' ? 'badge-accent' : 'badge-neutral'}`}>
                    {user.user_type === 'new_user' ? 'New User' : 'Established'}
                  </span>
                )}
              </div>
              <div className="record-card-trailing">
                {user.date_entered && (
                  <span className="record-card-trailing-date">Added {formatShortDate(user.date_entered)}</span>
                )}
              </div>
              <div className="record-card-meta">
                <span><MetaIcon name="mail" />{user.email}</span>
                {user.user_profile_name && <span>{user.user_profile_name}</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
