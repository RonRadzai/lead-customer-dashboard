import { useState, useEffect, useCallback } from 'react';
import MetaIcon from './MetaIcon';
import { SkeletonList, EmptyState } from './Skeleton';
import { formatShortDate } from '../utils/format';

export default function NewUsersList({ filters, onFiltersChange, onSelectUser }) {
  const [users, setUsers]     = useState([]);
  const [total, setTotal]     = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const { search = '', period = 'last_month' } = filters || {};
  const setSearch = v => onFiltersChange(f => ({ ...f, search: v }));
  const setPeriod = v => onFiltersChange(f => ({ ...f, period: v }));
  const [searchInput, setSearchInput] = useState(search);

  const [importing, setImporting]   = useState(false);
  const [importResult, setImportResult] = useState(null);

  const fetchUsers = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      params.set('period', period);

      const res = await fetch(`/api/new-users?${params}`);
      if (!res.ok) throw new Error('Failed to load users');
      const data = await res.json();
      setUsers(data.users);
      setTotal(data.total);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [search, period]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  useEffect(() => {
    const interval = setInterval(() => fetchUsers(true), 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchUsers]);

  function handleImportFile(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setImporting(true);
    setImportResult(null);
    const reader = new FileReader();
    reader.onload = async ev => {
      try {
        const res = await fetch('/api/new-users/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csv: ev.target.result }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Import failed');
        setImportResult(data);
        fetchUsers();
      } catch (err) {
        setImportResult({ error: err.message });
      } finally {
        setImporting(false);
      }
    };
    reader.readAsText(file);
  }

  function handleExport() {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    window.open(`/api/new-users/export?${params}`, '_blank');
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>New Users <span style={{ fontSize: '0.55em', fontWeight: 400, color: 'var(--text-muted)', verticalAlign: 'middle' }}>Added to Existing Customer Accounts</span></h1>
          <p>{total} user{total !== 1 ? 's' : ''} found</p>
        </div>
        <div className="flex gap-8">
          <button className="btn btn-secondary btn-sm" onClick={handleExport}>
            ⬇ Export CSV
          </button>
          <label className={`btn btn-primary btn-sm${importing ? ' disabled' : ''}`} style={{ cursor: importing ? 'default' : 'pointer' }}>
            {importing ? 'Importing…' : '⬆ Import CSV'}
            <input type="file" accept=".csv" style={{ display: 'none' }} onChange={handleImportFile} disabled={importing} />
          </label>
        </div>
      </div>

      {importResult && !importResult.error && (
        <div className="urgency-banner green" style={{ marginBottom: 16 }}>
          Import complete — {importResult.imported} added, {importResult.skipped} skipped
          {importResult.errors && importResult.errors.length > 0 && (
            <span style={{ marginLeft: 8, opacity: 0.8 }}>({importResult.errors.length} errors)</span>
          )}
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 12 }} onClick={() => setImportResult(null)}>×</button>
        </div>
      )}
      {importResult && importResult.error && (
        <div className="error-state" style={{ marginBottom: 16 }}>
          Import failed: {importResult.error}
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 12 }} onClick={() => setImportResult(null)}>×</button>
        </div>
      )}

      {/* Filters */}
      <div className="filter-bar">
        <input
          type="text"
          className="search-input"
          placeholder="Search name, email, org…"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && setSearch(searchInput)}
          style={{ flex: 1, minWidth: 200 }}
        />
        <button className="btn btn-secondary btn-sm" onClick={() => setSearch(searchInput)}>Search</button>
        {search && (
          <button className="btn btn-secondary btn-sm" onClick={() => { setSearchInput(''); setSearch(''); }}>Clear</button>
        )}
        <select value={period} onChange={e => setPeriod(e.target.value)} style={{ width: 160 }}>
          <option value="last7">Last 7 Days</option>
          <option value="today">Today</option>
          <option value="yesterday">Yesterday</option>
          <option value="last_month">Last 30 Days</option>
          <option value="all_new">All New Users</option>
        </select>
      </div>

      {error && <div className="error-state">{error}</div>}

      {loading ? (
        <SkeletonList count={8} />
      ) : users.length === 0 ? (
        <EmptyState
          icon="users"
          title="No new users"
          description="New users from CSV uploads appear here. Upload a CSV or check your filters."
        />
      ) : (
        (() => {
          const groups = [];
          let currentGroup = null;
          users.forEach(user => {
            const dateKey = user.date_entered ? user.date_entered.substring(0, 10) : '0000-00-00';
            if (!currentGroup || currentGroup.dateKey !== dateKey) {
              currentGroup = { dateKey, date: user.date_entered ? new Date(user.date_entered) : null, users: [] };
              groups.push(currentGroup);
            }
            currentGroup.users.push(user);
          });
          return groups.map(group => (
            <div key={group.dateKey} className="date-group">
              {group.date && (
                <div className="date-group-header">
                  <span className="date-sep-weekday">{group.date.toLocaleDateString('en-US', { weekday: 'long' })}</span>
                  <span className="date-sep-full">{group.date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}</span>
                </div>
              )}
              <div className="record-list">
                {group.users.map(user => {
                  return (
                    <div key={user.id} className="record-card" onClick={() => onSelectUser(user)}>
                      <div className="record-card-header">
                        <span className="record-card-name">
                          {user.first_name} {user.last_name}
                          {user.org_name && <span className="record-card-org">· {user.org_name}</span>}
                          {user.organization_id && <span className="record-card-orgid">· {user.organization_id}</span>}
                        </span>
                        <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                          {user.training_category === 'full_onboarding' && (
                            <span className="badge badge-sm badge-triage" title="Administrator-type profile: full onboarding training">Full onboarding</span>
                          )}
                          {user.follow_up_due_at && (
                            <span className="badge badge-sm badge-followup" title="Follow-up check-in due">Follow-up {formatShortDate(user.follow_up_due_at)}</span>
                          )}
                          {user.training_category === 'needs_review' && (
                            <span className="badge badge-sm badge-neutral" title="Profile not covered by a triage rule">Needs review</span>
                          )}
                          {user.org_count > 1 && (
                            <span className="badge badge-sm badge-neutral">{user.org_count} orgs</span>
                          )}
                        </span>
                      </div>
                      <div className="record-card-meta">
                        <span><MetaIcon name="mail" />{user.email}</span>
                        {user.user_profile_name && <span>{user.user_profile_name}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ));
        })()
      )}
    </div>
  );
}
