import { useState, useEffect } from 'react';

// ─── Team Members ──────────────────────────────────────────────────────────
function TeamSection() {
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);

  // Add form
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState({ name: '', email: '', role: '' });
  const [saving, setSaving]   = useState(false);

  // Edit state
  const [editId, setEditId]   = useState(null);
  const [editForm, setEditForm] = useState({ name: '', email: '', role: '' });

  useEffect(() => { loadMembers(); }, []);

  async function loadMembers() {
    setLoading(true);
    try {
      const res = await fetch('/api/team');
      if (!res.ok) throw new Error('Failed to load team');
      setMembers(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(addForm),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || 'Failed to add member');
      }
      setAddForm({ name: '', email: '', role: '' });
      setShowAdd(false);
      await loadMembers();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  function startEdit(member) {
    setEditId(member.id);
    setEditForm({ name: member.name, email: member.email, role: member.role || '' });
  }

  async function handleEdit(e) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/team/${editId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm),
      });
      if (!res.ok) throw new Error('Failed to update member');
      setEditId(null);
      await loadMembers();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDeactivate(id) {
    try {
      await fetch(`/api/team/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: 0 }),
      });
      await loadMembers();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="settings-section">
      <h2>Team Members</h2>
      {error && <div className="error-state">{error}</div>}

      {loading ? (
        <div className="loading-state" style={{ padding: 20 }}>
          <div className="loading-spinner" />
        </div>
      ) : (
        <>
          {members.length === 0 ? (
            <p className="text-muted" style={{ marginBottom: 12 }}>No team members yet.</p>
          ) : (
            <table className="data-table" style={{ marginBottom: 16 }}>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Role</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {members.map(m => (
                  editId === m.id ? (
                    <tr key={m.id}>
                      <td>
                        <input type="text" value={editForm.name}
                          onChange={e => setEditForm(f => ({ ...f, name: e.target.value }))} />
                      </td>
                      <td>
                        <input type="email" value={editForm.email}
                          onChange={e => setEditForm(f => ({ ...f, email: e.target.value }))} />
                      </td>
                      <td>
                        <input type="text" value={editForm.role}
                          onChange={e => setEditForm(f => ({ ...f, role: e.target.value }))} />
                      </td>
                      <td>
                        <div className="flex gap-8">
                          <button className="btn btn-primary btn-sm" onClick={handleEdit} disabled={saving}>
                            Save
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setEditId(null)}>
                            Cancel
                          </button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr key={m.id}>
                      <td>{m.name}</td>
                      <td>{m.email}</td>
                      <td>{m.role || <span className="text-muted">—</span>}</td>
                      <td>
                        <div className="flex gap-8">
                          <button className="btn btn-secondary btn-sm" onClick={() => startEdit(m)}>
                            Edit
                          </button>
                          <button className="btn btn-danger btn-sm" onClick={() => handleDeactivate(m.id)}>
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                ))}
              </tbody>
            </table>
          )}

          {!showAdd ? (
            <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(true)}>
              + Add Team Member
            </button>
          ) : (
            <form onSubmit={handleAdd} style={{
              background: 'var(--bg-input)',
              border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-sm)',
              padding: 16,
            }}>
              <div className="form-grid-2">
                <div className="form-group">
                  <label>Name *</label>
                  <input type="text" value={addForm.name}
                    onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))} required />
                </div>
                <div className="form-group">
                  <label>Email *</label>
                  <input type="email" value={addForm.email}
                    onChange={e => setAddForm(f => ({ ...f, email: e.target.value }))} required />
                </div>
              </div>
              <div className="form-group">
                <label>Role</label>
                <input type="text" value={addForm.role}
                  onChange={e => setAddForm(f => ({ ...f, role: e.target.value }))}
                  placeholder="e.g. Sales Rep, Manager" />
              </div>
              <div className="flex gap-8">
                <button type="submit" className="btn btn-primary btn-sm" disabled={saving}>
                  {saving ? 'Saving…' : 'Add Member'}
                </button>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setShowAdd(false)}>
                  Cancel
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </div>
  );
}

// ─── Custom Lead Stages ────────────────────────────────────────────────────
const CORE_STAGES = [
  { value: 'new_inquiry', label: 'New Inquiry' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'demo_scheduled', label: 'Demo Scheduled' },
  { value: 'attended_demo', label: 'Attended Demo' },
  { value: 'follow_up', label: 'Follow Up' },
  { value: 'converted', label: 'Converted' },
  { value: 'lost', label: 'Lost' },
];

function LeadStagesSection() {
  const [stages, setStages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [showAdd, setShowAdd] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [saving, setSaving] = useState(false);

  const [editId, setEditId] = useState(null);
  const [editLabel, setEditLabel] = useState('');

  useEffect(() => { loadStages(); }, []);

  async function loadStages() {
    setLoading(true);
    try {
      const res = await fetch('/api/config/lead-stages');
      if (!res.ok) throw new Error('Failed to load stages');
      setStages(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd(e) {
    e.preventDefault();
    if (!newLabel.trim()) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch('/api/config/lead-stages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: newLabel.trim() }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || 'Failed to add stage');
      }
      setNewLabel(''); setShowAdd(false);
      await loadStages();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleEdit(e) {
    e.preventDefault();
    if (!editLabel.trim()) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch(`/api/config/lead-stages/${editId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: editLabel.trim() }),
      });
      if (!res.ok) throw new Error('Failed to rename stage');
      setEditId(null);
      await loadStages();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(stage) {
    if (!window.confirm(`Delete the "${stage.label}" stage?`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/config/lead-stages/${stage.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || 'Failed to delete stage');
      }
      await loadStages();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="settings-section">
      <h2>Lead Stages</h2>
      <p className="text-muted" style={{ marginBottom: 16 }}>
        Core pipeline stages are fixed. Add custom terminal stages (like Test or Spam) that remove a lead from the active pipeline.
      </p>
      {error && <div className="error-state">{error}</div>}

      <div style={{ marginBottom: 20 }}>
        <div className="section-title" style={{ fontSize: 12, marginBottom: 8 }}>Core Pipeline Stages (fixed)</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {CORE_STAGES.map(s => (
            <span key={s.value} className={`badge badge-${s.value}`} style={{ opacity: 0.75 }}>{s.label}</span>
          ))}
        </div>
      </div>

      <div className="section-title" style={{ fontSize: 12, marginBottom: 8 }}>Custom Terminal Stages</div>
      {loading ? (
        <div className="loading-state" style={{ padding: 12 }}><div className="loading-spinner" /></div>
      ) : (
        <>
          {stages.length === 0 ? (
            <p className="text-muted" style={{ marginBottom: 12 }}>No custom stages yet.</p>
          ) : (
            <table className="data-table" style={{ marginBottom: 16 }}>
              <thead>
                <tr>
                  <th>Label</th>
                  <th>Value (slug)</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {stages.map(s => (
                  editId === s.id ? (
                    <tr key={s.id}>
                      <td colSpan={2}>
                        <input
                          type="text"
                          value={editLabel}
                          onChange={e => setEditLabel(e.target.value)}
                          autoFocus
                        />
                      </td>
                      <td>
                        <div className="flex gap-8">
                          <button className="btn btn-primary btn-sm" onClick={handleEdit} disabled={saving}>Save</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setEditId(null)}>Cancel</button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr key={s.id}>
                      <td><strong>{s.label}</strong></td>
                      <td><code style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{s.value}</code></td>
                      <td>
                        <div className="flex gap-8">
                          <button className="btn btn-secondary btn-sm" onClick={() => { setEditId(s.id); setEditLabel(s.label); }}>Rename</button>
                          <button className="btn btn-danger btn-sm" onClick={() => handleDelete(s)}>Delete</button>
                        </div>
                      </td>
                    </tr>
                  )
                ))}
              </tbody>
            </table>
          )}

          {!showAdd ? (
            <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(true)}>+ Add Custom Stage</button>
          ) : (
            <form onSubmit={handleAdd} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="text"
                value={newLabel}
                onChange={e => setNewLabel(e.target.value)}
                placeholder="e.g. Not Qualified"
                autoFocus
                style={{ flex: 1 }}
              />
              <button type="submit" className="btn btn-primary btn-sm" disabled={saving || !newLabel.trim()}>
                {saving ? 'Adding…' : 'Add'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setShowAdd(false); setNewLabel(''); }}>
                Cancel
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
}

// ─── Shared-drive CSV import ─────────────────────────────────────────────
function SyncSection() {
  const [status, setStatus]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [result, setResult]   = useState(null);
  const [error, setError]     = useState(null);

  useEffect(() => { loadStatus(); }, []);

  async function loadStatus() {
    setLoading(true);
    try {
      const res = await fetch('/api/sync/status');
      setStatus(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch('/api/sync/run', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sync failed');
      setResult(data);
      await loadStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setSyncing(false);
    }
  }

  function fmt(iso) {
    if (!iso) return 'Never';
    const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
    return d.toLocaleString();
  }

  return (
    <div className="settings-section">
      <div className="section-title">Shared Drive CSV Import</div>
      {loading ? (
        <div style={{ color: '#888' }}>Loading sync status…</div>
      ) : (
        <div>
          <div style={{ marginBottom: 8, fontSize: 13 }}>
            <strong>Last synced:</strong> {fmt(status?.last_synced_at)}
            {status?.mock && (
              <span style={{ marginLeft: 8, color: '#888' }}>(mock adapter: reading {status.file_path})</span>
            )}
          </div>
          {status?.graph_reachable === false && (
            <div style={{ color: '#e53e3e', marginBottom: 8, fontSize: 13 }}>
              Shared drive unreachable: {status.graph_error}
            </div>
          )}
          {status?.graph_reachable === true && (
            <div style={{ marginBottom: 8, fontSize: 13, color: '#555' }}>
              File: {status.file_name} &mdash; last modified {fmt(status.file_last_modified)}
            </div>
          )}
          {result && (
            <div style={{ marginBottom: 8, fontSize: 13, color: result.unchanged ? '#888' : '#2d6a4f' }}>
              {result.unchanged
                ? 'No changes detected — file unchanged since last sync.'
                : `Imported ${result.imported} new users, skipped ${result.skipped} existing.`}
              {result.errors?.length > 0 && (
                <span style={{ color: '#e53e3e' }}> {result.errors.length} error(s).</span>
              )}
            </div>
          )}
          {error && <div style={{ color: '#e53e3e', marginBottom: 8, fontSize: 13 }}>{error}</div>}
          <button
            className="btn btn-secondary"
            onClick={handleSync}
            disabled={syncing}
          >
            {syncing ? 'Syncing…' : 'Sync Now'}
          </button>
          <span style={{ marginLeft: 10, fontSize: 12, color: '#888' }}>
            Auto-syncs every 2 hours
          </span>
        </div>
      )}
    </div>
  );
}

// ─── Background poller status (Calendly, Zoom, Outlook, Zendesk, Support Sessions) ─
function PollerRow({ label, cadence, statusUrl, pollUrl }) {
  const [status, setStatus]   = useState(null);
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);
  const [result, setResult]   = useState(null);
  const [error, setError]     = useState(null);

  useEffect(() => { loadStatus(); }, [statusUrl]); // eslint-disable-line

  async function loadStatus() {
    setLoading(true);
    try {
      const res = await fetch(statusUrl);
      setStatus(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handlePoll() {
    setPolling(true);
    setResult(null);
    setError(null);
    try {
      const res = await fetch(pollUrl, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Poll failed');
      setResult(data);
      await loadStatus();
    } catch (err) {
      setError(err.message);
    } finally {
      setPolling(false);
    }
  }

  function fmt(iso) {
    if (!iso) return 'Never';
    const d = new Date(iso.endsWith('Z') ? iso : iso + 'Z');
    return d.toLocaleString();
  }

  return (
    <tr>
      <td>
        <div style={{ fontWeight: 600 }}>{label}</div>
        <div style={{ fontSize: 12, color: '#888' }}>Auto-polls every {cadence}</div>
      </td>
      <td style={{ fontSize: 13 }}>
        {loading ? 'Loading…' : fmt(status?.last_polled_at)}
        {status?.configured === false && (
          <div style={{ color: '#e53e3e', fontSize: 12 }}>Not configured</div>
        )}
      </td>
      <td style={{ fontSize: 12 }}>
        {error && <span style={{ color: '#e53e3e' }}>{error}</span>}
        {result && !error && <span style={{ color: '#2d6a4f' }}>Poll complete</span>}
      </td>
      <td>
        <button className="btn btn-secondary btn-sm" onClick={handlePoll} disabled={polling || loading}>
          {polling ? 'Polling…' : 'Poll Now'}
        </button>
      </td>
    </tr>
  );
}

function PollersStatusSection() {
  return (
    <div className="settings-section">
      <div className="section-title">Background Sync Status</div>
      <table className="data-table" style={{ marginBottom: 8 }}>
        <thead>
          <tr>
            <th>Service</th>
            <th>Last Polled</th>
            <th></th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <PollerRow label="Calendly Meetings" cadence="5 min" statusUrl="/api/calendly/status" pollUrl="/api/calendly/poll" />
          <PollerRow label="Zoom Meetings" cadence="5 min" statusUrl="/api/zoom/status" pollUrl="/api/zoom/poll" />
          <PollerRow label="Outlook Calendar" cadence="5 min" statusUrl="/api/outlook/status" pollUrl="/api/outlook/poll" />
          <PollerRow label="Zendesk Tickets" cadence="30 min" statusUrl="/api/zendesk/status" pollUrl="/api/zendesk/poll" />
          <PollerRow label="Support Sessions" cadence="30 min" statusUrl="/api/support-sessions/status" pollUrl="/api/support-sessions/poll" />
        </tbody>
      </table>
    </div>
  );
}

// ─── Default Lead Assignee ─────────────────────────────────────────────────
function DefaultAssigneeSection() {
  const [members, setMembers] = useState([]);
  const [current, setCurrent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([
      fetch('/api/team').then(r => r.json()),
      fetch('/api/config/app').then(r => r.json()),
    ]).then(([team, config]) => {
      setMembers(team);
      setCurrent(config.default_lead_assignee || '');
    }).catch(err => setError(err.message));
  }, []);

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      const res = await fetch('/api/config/app/default_lead_assignee', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: current }),
      });
      if (!res.ok) throw new Error('Failed to save');
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="settings-section">
      <h2>Default Lead Assignee</h2>
      <p style={{ color: '#666', marginBottom: 16 }}>
        New leads (manual and web form) are automatically assigned to this team member when no assignee is specified.
      </p>
      {error && <div className="error-message">{error}</div>}
      <form onSubmit={handleSave} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <select
          value={current}
          onChange={e => setCurrent(e.target.value)}
          style={{ minWidth: 200 }}
        >
          <option value="">— Unassigned —</option>
          {members.map(m => (
            <option key={m.id} value={m.name}>{m.name}</option>
          ))}
        </select>
        <button type="submit" className="btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        {saved && <span style={{ color: '#22c55e' }}>Saved</span>}
      </form>
    </div>
  );
}

// ─── Note Topics ──────────────────────────────────────────────────────────
function NoteTopicsSection() {
  const [topics, setTopics] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [saving, setSaving] = useState(false);

  const [editId, setEditId] = useState(null);
  const [editName, setEditName] = useState('');

  useEffect(() => { loadTopics(); }, []);

  async function loadTopics() {
    setLoading(true);
    try {
      const res = await fetch('/api/config/note-topics');
      if (!res.ok) throw new Error('Failed to load topics');
      setTopics(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd(e) {
    e.preventDefault();
    if (!newName.trim()) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch('/api/config/note-topics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName.trim() }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || 'Failed to add topic');
      }
      setNewName(''); setShowAdd(false);
      await loadTopics();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleEdit(e) {
    e.preventDefault();
    if (!editName.trim()) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch(`/api/config/note-topics/${editId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: editName.trim() }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || 'Failed to rename topic');
      }
      setEditId(null);
      await loadTopics();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(topic) {
    if (!window.confirm(`Delete the "${topic.name}" topic?`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/config/note-topics/${topic.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || 'Failed to delete topic');
      }
      await loadTopics();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="settings-section">
      <h2>Note Topics</h2>
      <p className="text-muted" style={{ marginBottom: 16 }}>
        Topics appear as an optional dropdown on meeting notes, so the team can categorize the discussion.
      </p>
      {error && <div className="error-state">{error}</div>}

      {loading ? (
        <div className="loading-state" style={{ padding: 12 }}><div className="loading-spinner" /></div>
      ) : (
        <>
          {topics.length === 0 ? (
            <p className="text-muted" style={{ marginBottom: 12 }}>No topics yet.</p>
          ) : (
            <table className="data-table" style={{ marginBottom: 16 }}>
              <thead>
                <tr>
                  <th>Topic Name</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {topics.map(t => (
                  editId === t.id ? (
                    <tr key={t.id}>
                      <td>
                        <input
                          type="text"
                          value={editName}
                          onChange={e => setEditName(e.target.value)}
                          autoFocus
                        />
                      </td>
                      <td>
                        <div className="flex gap-8">
                          <button className="btn btn-primary btn-sm" onClick={handleEdit} disabled={saving}>Save</button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setEditId(null)}>Cancel</button>
                        </div>
                      </td>
                    </tr>
                  ) : (
                    <tr key={t.id}>
                      <td><strong>{t.name}</strong></td>
                      <td>
                        <div className="flex gap-8">
                          <button className="btn btn-secondary btn-sm" onClick={() => { setEditId(t.id); setEditName(t.name); }}>Rename</button>
                          <button className="btn btn-danger btn-sm" onClick={() => handleDelete(t)}>Delete</button>
                        </div>
                      </td>
                    </tr>
                  )
                ))}
              </tbody>
            </table>
          )}

          {!showAdd ? (
            <button className="btn btn-primary btn-sm" onClick={() => setShowAdd(true)}>+ Add Topic</button>
          ) : (
            <form onSubmit={handleAdd} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="text"
                value={newName}
                onChange={e => setNewName(e.target.value)}
                placeholder="e.g. Renewal Discussion"
                autoFocus
                style={{ flex: 1 }}
              />
              <button type="submit" className="btn btn-primary btn-sm" disabled={saving || !newName.trim()}>
                {saving ? 'Adding…' : 'Add'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setShowAdd(false); setNewName(''); }}>
                Cancel
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
}

// ─── Onboarding Triage Rules (profile -> training category) ────────────────
const TRIAGE_CATEGORIES = [
  { value: 'full_onboarding', label: 'Full onboarding + follow-up timer' },
  { value: 'standard',        label: 'Standard welcome' },
  { value: 'needs_review',    label: 'Needs review' },
];

function TriageRulesSection() {
  const [rules, setRules]       = useState([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState(null);
  const [profile, setProfile]   = useState('');
  const [category, setCategory] = useState('full_onboarding');
  const [saving, setSaving]     = useState(false);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/config/profile-map');
      if (!res.ok) throw new Error('Failed to load triage rules');
      setRules(await res.json());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(e) {
    e.preventDefault();
    if (!profile.trim()) return;
    setSaving(true); setError(null);
    try {
      const res = await fetch('/api/config/profile-map', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_profile_name_value: profile.trim(), training_category: category }),
      });
      if (!res.ok) throw new Error('Failed to save rule');
      setProfile('');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(rule) {
    if (!window.confirm(`Remove the rule for "${rule.user_profile_name_value}"?`)) return;
    setError(null);
    try {
      const res = await fetch(`/api/config/profile-map/${rule.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to delete rule');
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  const labelFor = v => TRIAGE_CATEGORIES.find(c => c.value === v)?.label || v;

  return (
    <div className="settings-section">
      <h2>Onboarding Triage Rules</h2>
      <p className="text-muted" style={{ marginBottom: 16 }}>
        Imported users are categorized by profile name. Profiles mapped to full onboarding also get a follow-up
        deadline (FOLLOW_UP_DEADLINE_DAYS, default 60 days). Unmapped profiles containing "admin" are treated as administrators.
      </p>
      {error && <div className="error-state">{error}</div>}
      {loading ? (
        <div className="loading-state" style={{ padding: 12 }}><div className="loading-spinner" /></div>
      ) : (
        <>
          <table className="data-table" style={{ marginBottom: 16 }}>
            <thead>
              <tr>
                <th>User Profile</th>
                <th>Training Category</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rules.map(r => (
                <tr key={r.id}>
                  <td><strong>{r.user_profile_name_value}</strong></td>
                  <td>{labelFor(r.training_category)}</td>
                  <td><button className="btn btn-danger btn-sm" onClick={() => handleDelete(r)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <form onSubmit={handleSave} style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="text"
              value={profile}
              onChange={e => setProfile(e.target.value)}
              placeholder="Profile name, e.g. Billing Contact"
              style={{ flex: 1, minWidth: 220 }}
            />
            <select value={category} onChange={e => setCategory(e.target.value)}>
              {TRIAGE_CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
            <button type="submit" className="btn btn-primary btn-sm" disabled={saving || !profile.trim()}>
              {saving ? 'Saving…' : 'Add / Update'}
            </button>
          </form>
        </>
      )}
    </div>
  );
}

// ─── Settings ──────────────────────────────────────────────────────────────
export default function Settings() {
  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Manage team members and configuration</p>
        </div>
      </div>
      <TeamSection />
      <DefaultAssigneeSection />
      <LeadStagesSection />
      <NoteTopicsSection />
      <TriageRulesSection />
      <SyncSection />
      <PollersStatusSection />
    </div>
  );
}
