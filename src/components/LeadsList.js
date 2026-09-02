import { useState, useEffect, useCallback } from 'react';
import MetaIcon from './MetaIcon';
import ImportLeadsModal from './ImportLeadsModal';
import { SkeletonList, EmptyState } from './Skeleton';

const STAGES = [
  { value: '', label: 'All Stages' },
  { value: 'new_inquiry', label: 'New Inquiry' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'demo_scheduled', label: 'Demo Scheduled' },
  { value: 'attended_demo', label: 'Attended Demo' },
  { value: 'follow_up', label: 'Follow Up' },
  { value: 'converted', label: 'Converted' },
  { value: 'lost', label: 'Lost' },
];

const SOURCES = ['Website Form', 'Referral', 'Event', 'Manual Entry'];
const OTHER_LEADS_PAGE_SIZE = 50;

function StageBadge({ stage }) {
  if (!stage) return null;
  return (
    <span className={`badge badge-${stage}`}>
      {stage.replace(/_/g, ' ')}
    </span>
  );
}


// ─── Add Lead Modal ────────────────────────────────────────────────────────
function AddLeadModal({ onClose, onSaved, teamMembers }) {
  const [form, setForm] = useState({
    first_name: '', last_name: '', email: '', phone: '',
    org_name: '', org_website: '', source: 'Manual Entry',
    how_can_we_help: '', assigned_to: '', consent_to_contact: false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState(null);

  function handleChange(e) {
    const { name, value, type, checked } = e.target;
    setForm(f => ({ ...f, [name]: type === 'checkbox' ? checked : value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/leads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Failed to create lead');
      }
      const lead = await res.json();
      onSaved(lead);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2>Add New Lead</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>
        {error && <div className="error-state">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="form-grid-2">
            <div className="form-group">
              <label>First Name *</label>
              <input type="text" name="first_name" value={form.first_name}
                onChange={handleChange} required />
            </div>
            <div className="form-group">
              <label>Last Name *</label>
              <input type="text" name="last_name" value={form.last_name}
                onChange={handleChange} required />
            </div>
          </div>
          <div className="form-group">
            <label>Email *</label>
            <input type="email" name="email" value={form.email}
              onChange={handleChange} required />
          </div>
          <div className="form-grid-2">
            <div className="form-group">
              <label>Phone</label>
              <input type="tel" name="phone" value={form.phone} onChange={handleChange} />
            </div>
            <div className="form-group">
              <label>Organization Name *</label>
              <input type="text" name="org_name" value={form.org_name}
                onChange={handleChange} required />
            </div>
          </div>
          <div className="form-group">
            <label>Organization Website</label>
            <input type="url" name="org_website" value={form.org_website} onChange={handleChange} />
          </div>
          <div className="form-grid-2">
            <div className="form-group">
              <label>Source</label>
              <select name="source" value={form.source} onChange={handleChange}>
                {SOURCES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Assigned To</label>
              <select name="assigned_to" value={form.assigned_to} onChange={handleChange}>
                <option value="">— Unassigned —</option>
                {teamMembers.map(m => (
                  <option key={m.id} value={m.name}>{m.name}</option>
                ))}
              </select>
            </div>
          </div>
          <div className="form-group">
            <label>How Can We Help?</label>
            <textarea name="how_can_we_help" value={form.how_can_we_help}
              onChange={handleChange} rows={3} />
          </div>
          <div className="form-group">
            <label className="checkbox-row">
              <input type="checkbox" name="consent_to_contact"
                checked={form.consent_to_contact} onChange={handleChange} />
              <span>Consent to contact</span>
            </label>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Add Lead'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── LeadsList ─────────────────────────────────────────────────────────────
export default function LeadsList({ filters, onFiltersChange, onSelectLead, openAddModal, onAddModalClosed, openImportModal, onImportModalClosed }) {
  const [leads, setLeads]           = useState([]);
  const [total, setTotal]           = useState(0);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [teamMembers, setTeamMembers] = useState([]);
  const [customStages, setCustomStages] = useState([]);
  const [showAdd, setShowAdd]       = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [otherLeadsShown, setOtherLeadsShown] = useState(OTHER_LEADS_PAGE_SIZE);

  const { stage = '', assignedTo = '', search = '', sort = 'newest' } = filters || {};
  const setStage      = v => onFiltersChange(f => ({ ...f, stage: v }));
  const setAssignedTo = v => onFiltersChange(f => ({ ...f, assignedTo: v }));
  const setSearch     = v => onFiltersChange(f => ({ ...f, search: v }));
  const setSort       = v => onFiltersChange(f => ({ ...f, sort: v }));
  const [searchInput, setSearchInput] = useState(search);

  // Reset "Other Leads" pagination on filter/sort changes, but not on the silent
  // 2-min background refresh — that would collapse the list out from under the user.
  useEffect(() => { setOtherLeadsShown(OTHER_LEADS_PAGE_SIZE); }, [stage, assignedTo, search, sort]);

  const fetchLeads = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (stage) params.set('stage', stage);
      if (assignedTo) params.set('assigned_to', assignedTo);
      if (search) params.set('search', search);
      if (sort) params.set('sort', sort);
      // Default API limit is 50 — the list has no "Load More" control, so without this
      // the Active Leads box can silently miss leads older than the newest 50.
      params.set('limit', '500');

      const res = await fetch(`/api/leads?${params}`);
      if (!res.ok) throw new Error('Failed to load leads');
      const data = await res.json();
      setLeads(data.leads);
      setTotal(data.total);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [stage, assignedTo, search, sort]);

  useEffect(() => { fetchLeads(); }, [fetchLeads]);

  useEffect(() => {
    const interval = setInterval(() => fetchLeads(true), 2 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchLeads]);

  useEffect(() => {
    fetch('/api/team').then(r => r.json()).then(setTeamMembers).catch(() => {});
    fetch('/api/config/lead-stages').then(r => r.json()).then(setCustomStages).catch(() => {});
  }, []);

  // Open add modal when parent signals it
  useEffect(() => {
    if (openAddModal) {
      setShowAdd(true);
      onAddModalClosed && onAddModalClosed();
    }
  }, [openAddModal, onAddModalClosed]);

  // Open import modal when parent signals it
  useEffect(() => {
    if (openImportModal) {
      setShowImport(true);
      onImportModalClosed && onImportModalClosed();
    }
  }, [openImportModal, onImportModalClosed]);

  function handleExport() {
    const params = new URLSearchParams();
    if (stage) params.set('stage', stage);
    if (assignedTo) params.set('assigned_to', assignedTo);
    if (search) params.set('search', search);
    window.open(`/api/leads/export?${params}`, '_blank');
  }

  function handleLeadSaved() {
    setShowAdd(false);
    fetchLeads();
  }

  async function handleDeleteLead(e, lead) {
    e.stopPropagation();
    if (!window.confirm(`Move "${lead.first_name} ${lead.last_name}" to the recycle bin?`)) return;
    const res = await fetch(`/api/leads/${lead.id}`, { method: 'DELETE' });
    if (res.ok) fetchLeads();
    else setError('Failed to delete lead');
  }

  function renderLeadsTable(list) {
    return (
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Org</th>
              <th>Stage</th>
              <th>Assigned To</th>
              <th>Source</th>
              <th className="tbl-th-center">Attempts</th>
              <th
                className="tbl-th-sortable"
                onClick={() => setSort(sort === 'newest' ? 'oldest' : 'newest')}
              >
                Date Added {sort === 'newest' ? '↓' : sort === 'oldest' ? '↑' : ''}
              </th>
              <th style={{ width: 40 }}></th>
            </tr>
          </thead>
          <tbody>
            {list.map(lead => (
              <tr key={lead.id} className="tbl-row" onClick={() => onSelectLead(lead)}>
                <td>
                  <div className="tbl-name">{lead.first_name} {lead.last_name}</div>
                  <div className="tbl-sub">{lead.email}</div>
                </td>
                <td>{lead.org_name || <span className="text-muted">—</span>}</td>
                <td><StageBadge stage={lead.stage} /></td>
                <td>{lead.assigned_to || <span className="badge badge-sm" style={{ background: 'rgba(239,68,68,0.1)', color: '#ef4444', border: '1px solid rgba(239,68,68,0.25)' }}>Unassigned</span>}</td>
                <td>{lead.source || <span className="text-muted">—</span>}</td>
                <td className="tbl-center">
                  {(lead.contact_attempts || 0) > 0
                    ? <span className="badge badge-sm badge-neutral">{lead.contact_attempts}</span>
                    : <span className="text-muted">—</span>}
                </td>
                <td className="tbl-date">
                  {lead.created_at
                    ? new Date(lead.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                    : '—'}
                </td>
                <td className="tbl-action" onClick={e => e.stopPropagation()}>
                  <button
                    onClick={e => handleDeleteLead(e, lead)}
                    title="Move to recycle bin"
                    className="btn-row-delete"
                  >
                    <MetaIcon name="trash" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Leads</h1>
          <p>{total} lead{total !== 1 ? 's' : ''} found</p>
        </div>
        <div className="flex gap-8">
          <button className="btn btn-secondary btn-sm" onClick={() => setShowImport(true)}>
            ⬆ Import CSV
          </button>
          <button className="btn btn-secondary btn-sm" onClick={handleExport}>
            ⬇ Export CSV
          </button>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            + Add New Lead
          </button>
        </div>
      </div>

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
        <select value={stage} onChange={e => setStage(e.target.value)} style={{ width: 180 }}>
          {STAGES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
          {customStages.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <select value={assignedTo} onChange={e => setAssignedTo(e.target.value)} style={{ width: 160 }}>
          <option value="">All Assignees</option>
          {teamMembers.map(m => <option key={m.id} value={m.name}>{m.name}</option>)}
        </select>
        <select value={sort} onChange={e => setSort(e.target.value)} style={{ width: 150 }}>
          <option value="newest">Newest First</option>
          <option value="oldest">Oldest First</option>
          <option value="last_activity">Last Activity</option>
        </select>
      </div>

      {error && <div className="error-state">{error}</div>}

      {loading ? (
        <SkeletonList count={6} />
      ) : leads.length === 0 ? (
        <EmptyState
          icon="inbox"
          title={stage || assignedTo || search ? 'No leads match your filters' : 'No leads yet'}
          description={stage || assignedTo || search ? 'Try clearing some filters to see more results.' : 'Leads you add manually or import from a CSV will appear here.'}
          action={!stage && !assignedTo && !search ? <button className="btn btn-primary" onClick={() => setShowAdd(true)}>Add Lead</button> : null}
        />
      ) : (() => {
        const activeLeads = leads.filter(lead => lead.is_active_lead === 1);
        const otherLeads = leads.filter(lead => lead.is_active_lead !== 1);
        // The Active Leads box always shows its full set (it's meant to match the
        // Dashboard count exactly); only the long tail below it gets paginated.
        const pagedList = activeLeads.length === 0 ? leads : otherLeads;
        const paged = pagedList.slice(0, otherLeadsShown);
        const remaining = pagedList.length - paged.length;
        const loadMore = remaining > 0 && (
          <div className="load-more-row">
            <button className="btn btn-secondary btn-sm" onClick={() => setOtherLeadsShown(n => n + OTHER_LEADS_PAGE_SIZE)}>
              Load More ({remaining} remaining)
            </button>
          </div>
        );

        if (activeLeads.length === 0) {
          return (
            <>
              <div className="leads-section-label">No leads currently match Active Leads (no contact in 10+ days)</div>
              {renderLeadsTable(paged)}
              {loadMore}
            </>
          );
        }
        return (
          <>
            <div className="active-leads-box">
              <div className="active-leads-box-header">
                <strong>Active Leads</strong> — matches the Dashboard. Excludes leads with no contact in 10+ days.
              </div>
              {renderLeadsTable(activeLeads)}
            </div>
            {otherLeads.length > 0 && (
              <>
                <div className="leads-section-label">Other Leads</div>
                {renderLeadsTable(paged)}
                {loadMore}
              </>
            )}
          </>
        );
      })()}

      {showAdd && (
        <AddLeadModal
          onClose={() => setShowAdd(false)}
          onSaved={handleLeadSaved}
          teamMembers={teamMembers}
        />
      )}

      <ImportLeadsModal
        isOpen={showImport}
        onClose={() => setShowImport(false)}
        onImported={fetchLeads}
      />
    </div>
  );
}
