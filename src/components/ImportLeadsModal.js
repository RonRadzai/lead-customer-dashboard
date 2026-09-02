import { useState } from 'react';

export default function ImportLeadsModal({ isOpen, onClose, onImported }) {
  const [step, setStep] = useState('upload');
  const [fileName, setFileName] = useState('');
  const [previewData, setPreviewData] = useState(null);
  const [defaultSource, setDefaultSource] = useState('Meta Ads');
  const [uncheckedRows, setUncheckedRows] = useState(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  if (!isOpen) return null;

  function resetAndClose() {
    setStep('upload');
    setFileName('');
    setPreviewData(null);
    setDefaultSource('Meta Ads');
    setUncheckedRows(new Set());
    setLoading(false);
    setError(null);
    setResult(null);
    onClose();
  }

  function decodeCsvBuffer(buffer) {
    const bytes = new Uint8Array(buffer);
    let encoding = 'utf-8';
    let offset = 0;
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
      encoding = 'utf-16le';
      offset = 2;
    } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
      encoding = 'utf-16be';
      offset = 2;
    } else if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      offset = 3;
    }
    return new TextDecoder(encoding).decode(bytes.subarray(offset));
  }

  function handleFile(e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    setFileName(file.name);
    setError(null);
    setLoading(true);

    const reader = new FileReader();
    reader.onload = async ev => {
      try {
        const csvText = decodeCsvBuffer(ev.target.result);
        const res = await fetch('/api/leads/import/preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csv: csvText }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Preview failed');
        // Pre-uncheck any rows that are duplicates or have errors
        const unchecked = new Set();
        data.rows.forEach(r => {
          if (r.is_duplicate_lead || r.is_terminal_duplicate || r.errors.length > 0) unchecked.add(r.row_number);
        });
        setUncheckedRows(unchecked);
        setPreviewData(data);
        setStep('preview');
      } catch (err) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };
    reader.onerror = () => {
      setError('Failed to read file');
      setLoading(false);
    };
    reader.readAsArrayBuffer(file);
  }

  function toggleRow(rowNumber) {
    setUncheckedRows(prev => {
      const next = new Set(prev);
      if (next.has(rowNumber)) next.delete(rowNumber);
      else next.add(rowNumber);
      return next;
    });
  }

  async function handleCommit() {
    if (!previewData) return;
    const rowsToImport = previewData.rows
      .filter(r => !uncheckedRows.has(r.row_number) && r.errors.length === 0)
      .map(r => r.is_terminal_duplicate ? { ...r, force_import: true } : r);
    if (rowsToImport.length === 0) {
      setError('No rows selected to import.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/leads/import/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows: rowsToImport, default_source: defaultSource }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');
      setResult(data);
      setStep('result');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function handleDone() {
    onImported && onImported();
    resetAndClose();
  }

  const selectedCount = previewData
    ? previewData.rows.filter(r => !uncheckedRows.has(r.row_number) && r.errors.length === 0).length
    : 0;

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && resetAndClose()}>
      <div className="modal" style={{ maxWidth: step === 'preview' ? 1000 : 560, width: '95%' }}>
        <div className="modal-header">
          <h2>
            {step === 'upload' && 'Import Leads from CSV'}
            {step === 'preview' && 'Preview Import'}
            {step === 'result' && 'Import Complete'}
          </h2>
          <button className="modal-close" onClick={resetAndClose}>×</button>
        </div>

        {error && <div className="error-state" style={{ margin: '0 0 12px' }}>{error}</div>}

        {step === 'upload' && (
          <div>
            <p style={{ marginTop: 0, color: 'var(--text-secondary, #64748b)' }}>
              Upload a CSV exported from Meta Ads, LinkedIn, or similar sources.
              Common columns (email, full_name, nonprofit_name, phone) plus ad metadata
              (platform, campaign_name, ad_name, adset_name, form_name, IDs, inbox_url) are auto-detected.
            </p>
            <label
              style={{
                display: 'block', border: '2px dashed #cbd5e1', borderRadius: 8,
                padding: '32px 16px', textAlign: 'center', cursor: loading ? 'default' : 'pointer',
                background: '#f8fafc', color: '#475569',
              }}
            >
              {loading ? 'Parsing…' : (fileName ? `Selected: ${fileName}` : 'Click to select a CSV file')}
              <input
                type="file"
                accept=".csv,text/csv"
                style={{ display: 'none' }}
                onChange={handleFile}
                disabled={loading}
              />
            </label>
            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={resetAndClose}>Cancel</button>
            </div>
          </div>
        )}

        {step === 'preview' && previewData && (
          <div>
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 12, fontSize: 14 }}>
              <span><strong>{previewData.valid_rows}</strong> valid rows</span>
              <span><strong>{previewData.duplicate_leads}</strong> duplicates (will skip)</span>
              <span><strong>{previewData.matched_customers}</strong> match existing customers</span>
              {previewData.invalid_rows > 0 && (
                <span style={{ color: '#b91c1c' }}>
                  <strong>{previewData.invalid_rows}</strong> invalid
                </span>
              )}
            </div>

            <div className="form-group">
              <label>Source (applied to all imported leads)</label>
              <input
                type="text"
                value={defaultSource}
                onChange={e => setDefaultSource(e.target.value)}
                style={{ maxWidth: 300 }}
              />
            </div>

            {previewData.unmapped_headers && previewData.unmapped_headers.length > 0 && (
              <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>
                Unmapped columns (ignored): {previewData.unmapped_headers.join(', ')}
              </div>
            )}

            <div style={{ maxHeight: 400, overflow: 'auto', border: '1px solid #e2e8f0', borderRadius: 6 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead style={{ background: '#f8fafc', position: 'sticky', top: 0 }}>
                  <tr>
                    <th style={thStyle}></th>
                    <th style={thStyle}>Name</th>
                    <th style={thStyle}>Email</th>
                    <th style={thStyle}>Org</th>
                    <th style={thStyle}>Ad Source</th>
                    <th style={thStyle}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {previewData.rows.map(row => {
                    const hasError = row.errors.length > 0;
                    const isDup = row.is_duplicate_lead;
                    const isTerminalDup = row.is_terminal_duplicate;
                    const isCustomer = !!row.matched_new_user;
                    const checked = !uncheckedRows.has(row.row_number);
                    const muted = isDup || hasError;
                    const adBits = [row.platform, row.campaign_name, row.ad_name].filter(Boolean);
                    return (
                      <tr key={row.row_number} style={{ opacity: muted ? 0.55 : 1, borderTop: '1px solid #f1f5f9' }}>
                        <td style={tdStyle}>
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={hasError}
                            onChange={() => toggleRow(row.row_number)}
                          />
                        </td>
                        <td style={tdStyle}>{row.first_name} {row.last_name}</td>
                        <td style={tdStyle}>{row.email || <em>—</em>}</td>
                        <td style={tdStyle}>{row.org_name || '—'}</td>
                        <td style={{ ...tdStyle, fontSize: 12, color: '#64748b' }}>
                          {adBits.length > 0 ? adBits.join(' · ') : '—'}
                        </td>
                        <td style={tdStyle}>
                          {hasError && <span className="badge badge-lost">INVALID</span>}
                          {!hasError && isDup && <span className="badge badge-lost">DUPLICATE</span>}
                          {!hasError && isTerminalDup && (
                            <span className="badge" style={{ background: '#f59e0b', color: '#fff' }} title="Check to re-import as a new lead">
                              EXISTS AS {row.duplicate_lead_stage.toUpperCase()}
                            </span>
                          )}
                          {!hasError && !isDup && !isTerminalDup && isCustomer && (
                            <span className="badge badge-converted" title={`Existing user at ${row.matched_new_user.org_name}`}>
                              CUSTOMER: {row.matched_new_user.org_name}
                            </span>
                          )}
                          {!hasError && !isDup && !isTerminalDup && !isCustomer && (
                            <span className="badge badge-new_inquiry">NEW</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="modal-footer">
              <button className="btn btn-secondary" onClick={resetAndClose} disabled={loading}>Cancel</button>
              <button
                className="btn btn-primary"
                onClick={handleCommit}
                disabled={loading || selectedCount === 0}
              >
                {loading ? 'Importing…' : `Import ${selectedCount} lead${selectedCount === 1 ? '' : 's'}`}
              </button>
            </div>
          </div>
        )}

        {step === 'result' && result && (
          <div>
            <div className="urgency-banner green" style={{ marginBottom: 12 }}>
              Import complete — {result.imported} added, {result.skipped} skipped
              {result.errors && result.errors.length > 0 && (
                <span style={{ marginLeft: 8, opacity: 0.8 }}>({result.errors.length} errors)</span>
              )}
            </div>
            {result.errors && result.errors.length > 0 && (
              <div style={{ fontSize: 12, color: '#b91c1c', maxHeight: 160, overflow: 'auto' }}>
                {result.errors.map((err, i) => <div key={i}>{err}</div>)}
              </div>
            )}
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={handleDone}>Done</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const thStyle = { textAlign: 'left', padding: '8px 10px', fontWeight: 600, borderBottom: '1px solid #e2e8f0' };
const tdStyle = { padding: '6px 10px', verticalAlign: 'middle' };
