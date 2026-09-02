import { useState, useEffect } from 'react';

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const STATUS_STYLES = {
  open:    { background: 'rgba(239,68,68,0.15)',   color: '#ef4444' },
  solved:  { background: 'rgba(34,197,94,0.15)',   color: '#22c55e' },
  pending: { background: 'rgba(245,158,11,0.15)',  color: '#f59e0b' },
  closed:  { background: 'rgba(107,114,128,0.15)', color: '#6b7280' },
  new:     { background: 'rgba(139,92,246,0.15)',  color: '#8b5cf6' },
};

export default function ZendeskTicketsSection({ recordType, recordId }) {
  const [tickets, setTickets]         = useState(null);
  const [loading, setLoading]         = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [showForm, setShowForm]       = useState(false);
  const [subject, setSubject]         = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting]   = useState(false);
  const [submitError, setSubmitError] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/zendesk-tickets/${recordType}/${recordId}`);
      const data = await res.json();
      setTickets(data.tickets || []);
      setUnavailable(!!data.unavailable);
    } catch {
      setTickets([]);
      setUnavailable(true);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [recordType, recordId]); // eslint-disable-line

  async function handleSubmit(e) {
    e.preventDefault();
    if (!subject.trim() || !description.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/zendesk-tickets/${recordType}/${recordId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subject: subject.trim(), description: description.trim() }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || 'Failed to create ticket');
      }
      setSubject('');
      setDescription('');
      setShowForm(false);
      await load();
    } catch (err) {
      setSubmitError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="detail-info-block">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div className="section-title" style={{ margin: 0 }}>Zendesk Tickets</div>
        {!unavailable && !loading && (
          <button
            className="btn btn-secondary btn-sm"
            onClick={() => { setShowForm(f => !f); setSubmitError(null); }}
          >
            {showForm ? 'Cancel' : '+ Create Ticket'}
          </button>
        )}
      </div>

      {showForm && (
        <form onSubmit={handleSubmit} style={{ marginBottom: 14 }}>
          {submitError && <div className="error-state" style={{ marginBottom: 8 }}>{submitError}</div>}
          <div className="form-group">
            <label>Subject</label>
            <input
              className="form-control"
              value={subject}
              onChange={e => setSubject(e.target.value)}
              placeholder="Brief summary of the issue"
              required
            />
          </div>
          <div className="form-group">
            <label>Description</label>
            <textarea
              className="form-control"
              rows={3}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Describe the issue in detail"
              required
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary btn-sm"
            disabled={submitting || !subject.trim() || !description.trim()}
          >
            {submitting ? 'Creating…' : 'Create Ticket'}
          </button>
        </form>
      )}

      {loading && <p className="text-muted">Loading…</p>}
      {!loading && unavailable && (
        <p className="text-muted">Zendesk unavailable — credentials may not be configured.</p>
      )}
      {!loading && !unavailable && tickets.length === 0 && (
        <p className="text-muted">No Zendesk tickets found.</p>
      )}
      {!loading && !unavailable && tickets.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {tickets.map(t => {
            const style = STATUS_STYLES[t.status?.toLowerCase()] || {};
            return (
              <div key={t.id} style={{
                display: 'flex', alignItems: 'baseline', gap: 10,
                padding: '7px 10px', borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-input)', fontSize: 13,
              }}>
                <span style={{
                  fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
                  padding: '2px 7px', borderRadius: 99, flexShrink: 0,
                  textTransform: 'uppercase', ...style,
                }}>
                  {t.status}
                </span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.subject}>
                  {t.subject && t.subject.length > 80 ? t.subject.slice(0, 80) + '…' : t.subject}
                </span>
                <span style={{ flexShrink: 0, color: 'var(--text-secondary)', fontSize: 12 }}>
                  {formatDate(t.created_at)}
                </span>
                <a
                  href={t.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ flexShrink: 0, color: 'var(--accent-blue)', fontSize: 12 }}
                  title="Open in Zendesk"
                >
                  ↗
                </a>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
