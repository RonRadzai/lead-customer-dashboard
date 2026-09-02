import { useState, useEffect } from 'react';

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

const STATUS_COLORS = {
  pending:           { background: 'rgba(59,130,246,0.15)',   color: '#3b82f6' },
  escalated:         { background: 'rgba(239,68,68,0.15)',    color: '#ef4444' },
  'flagged for review': { background: 'rgba(245,158,11,0.15)', color: '#f59e0b' },
  solved:            { background: 'rgba(107,114,128,0.15)',  color: '#6b7280' },
};

export default function SupportHistorySection({ recordType, recordId }) {
  const [sessions, setSessions] = useState(null);
  const [loading, setLoading]   = useState(true);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/support-history/${recordType}/${recordId}`)
      .then(r => r.json())
      .then(data => {
        if (!cancelled) {
          setSessions(data.sessions || []);
          setUnavailable(!!data.unavailable);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSessions([]);
          setUnavailable(true);
          setLoading(false);
        }
      });
    return () => { cancelled = true; };
  }, [recordType, recordId]);

  return (
    <div className="detail-info-block">
      <div className="section-title">Support Session History</div>
      {loading && <p className="text-muted">Loading…</p>}
      {!loading && unavailable && (
        <p className="text-muted">Support sessions unavailable. The support-notes app is not configured or not reachable.</p>
      )}
      {!loading && !unavailable && sessions.length === 0 && (
        <p className="text-muted">No support sessions found for this contact.</p>
      )}
      {!loading && !unavailable && sessions.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {sessions.map(session => (
            <a
              key={session.id}
              href={session.note_url || undefined}
              target="_blank"
              rel="noopener noreferrer"
              style={{ textDecoration: 'none', color: 'inherit' }}
            >
              <div style={{
                padding: '10px 12px',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--bg-input)',
                border: '1px solid var(--border-color)',
                cursor: 'pointer',
              }}
                onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--accent-blue)'}
                onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border-color)'}
              >
                <div style={{ marginBottom: 4 }}>
                  <span style={{ fontWeight: 700, fontSize: 13 }}>
                    {formatDate(session.date_created)}
                  </span>
                </div>
                {session.issues && session.issues.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    {session.issues.map((issue, idx) => {
                      const style = STATUS_COLORS[issue.status?.toLowerCase()] || {};
                      return (
                        <div key={idx} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12 }}>
                          {issue.platform && (
                            <span style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>{issue.platform}</span>
                          )}
                          {issue.status && (
                            <span style={{
                              fontSize: 10, fontWeight: 700, letterSpacing: '0.04em',
                              padding: '1px 6px', borderRadius: 99, flexShrink: 0,
                              textTransform: 'uppercase', ...style,
                            }}>
                              {issue.status}
                            </span>
                          )}
                          {issue.description_snippet && (
                            <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {issue.description_snippet}
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>No issues recorded</span>
                )}
              </div>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
