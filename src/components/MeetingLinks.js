import { useState } from 'react';

// Starter links shown to every user. Teams add their own via "+ Add Link" (stored in localStorage).
const BUILTIN_CALENDLY = [
  { owner: 'Sales Team',    label: 'Product Demo (30 min)',    desc: 'Link for new leads',                          url: 'https://calendly.com/example-sales/product-demo' },
  { owner: 'Sales Team',    label: 'Discovery Call',           desc: 'First conversation with a prospect',          url: 'https://calendly.com/example-sales/discovery-call' },
  { owner: 'Training Team', label: 'New User Training',        desc: 'Sent in the new-user welcome email',          url: 'https://calendly.com/example-training/new-user-training' },
  { owner: 'Training Team', label: 'Administrator Onboarding', desc: 'Full onboarding for administrator profiles',  url: 'https://calendly.com/example-training/admin-onboarding' },
  { owner: 'Training Team', label: 'Account Check-in',         desc: 'Existing customers',                          url: 'https://calendly.com/example-training/account-check-in' },
];

const STORAGE_KEY = 'lcd-custom-calendly-links';
const RECYCLE_KEY = 'lcd-recycle-bin-links';

function loadCustomLinks() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { return []; }
}

function saveCustomLinks(links) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(links));
}

const KNOWN_OWNERS = ['Sales Team', 'Training Team'];

// ── Add Link Modal ─────────────────────────────────────────────────────────
const EMPTY_FORM = { owner: '', label: '', desc: '', url: '' };

function AddLinkModal({ onSave, onClose }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [error, setError] = useState('');

  function set(field, val) {
    setForm(f => ({ ...f, [field]: val }));
    setError('');
  }

  function handleSubmit(e) {
    e.preventDefault();
    if (!form.owner.trim()) return setError('Owner is required.');
    if (!form.label.trim()) return setError('Meeting title is required.');
    if (!form.url.trim()) return setError('Calendly link is required.');
    if (!form.url.startsWith('https://')) return setError('URL must start with https://');
    onSave({ owner: form.owner.trim(), label: form.label.trim(), desc: form.desc.trim(), url: form.url.trim() });
  }

  const inputStyle = {
    width: '100%', padding: '8px 10px', borderRadius: 6, fontSize: 13,
    border: '1px solid var(--border-color)', background: 'var(--bg-primary)',
    color: 'var(--text-primary)', boxSizing: 'border-box',
  };
  const labelStyle = { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)', display: 'block', marginBottom: 4 };

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
    }} onClick={onClose}>
      <div style={{
        background: 'var(--bg-primary)', borderRadius: 12, padding: 24,
        width: 400, boxShadow: '0 8px 32px rgba(0,0,0,0.3)',
      }} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 20px', fontSize: 16 }}>Add Calendly Link</h3>
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={labelStyle}>Owner *</label>
            <input
              list="owner-suggestions"
              value={form.owner}
              onChange={e => set('owner', e.target.value)}
              placeholder="e.g. Training Team"
              style={inputStyle}
            />
            <datalist id="owner-suggestions">
              {KNOWN_OWNERS.map(o => <option key={o} value={o} />)}
            </datalist>
          </div>
          <div>
            <label style={labelStyle}>Meeting Title *</label>
            <input
              value={form.label}
              onChange={e => set('label', e.target.value)}
              placeholder="e.g. 30 Minute Intro"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Description <span style={{ fontWeight: 400 }}>(optional)</span></label>
            <input
              value={form.desc}
              onChange={e => set('desc', e.target.value)}
              placeholder="e.g. For returning customers"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Calendly URL *</label>
            <input
              value={form.url}
              onChange={e => set('url', e.target.value)}
              placeholder="https://calendly.com/..."
              style={inputStyle}
            />
          </div>
          {error && <div style={{ fontSize: 12, color: '#ef4444' }}>{error}</div>}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">Add Link</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Link Card ──────────────────────────────────────────────────────────────
function LinkCard({ item, copiedUrl, onCopy, onDelete }) {
  const copied = copiedUrl === item.url;
  return (
    <div style={{ position: 'relative', maxWidth: 300 }}>
      <div
        onClick={() => onCopy(item.url)}
        style={{
          display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
          padding: '14px 16px', borderRadius: 10, cursor: 'pointer',
          background: copied ? 'rgba(34,197,94,0.08)' : 'var(--bg-secondary)',
          border: `1px solid ${copied ? 'rgba(34,197,94,0.35)' : 'var(--border-color)'}`,
          transition: 'all 0.15s', gap: 10,
        }}
      >
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', marginBottom: item.desc ? 4 : 0 }}>
            {item.label}
          </div>
          {item.desc && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.4 }}>
              {item.desc}
            </div>
          )}
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, color: copied ? '#22c55e' : 'var(--accent-blue)', paddingTop: 4 }}>
          {copied ? '✓ Copied!' : 'Click to copy'}
        </div>
      </div>
      {onDelete && (
        <button
          onClick={onDelete}
          title="Remove this link"
          style={{
            position: 'absolute', top: 6, right: 6,
            background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-secondary)', fontSize: 14, lineHeight: 1,
            padding: '2px 4px', borderRadius: 4,
            opacity: 0.5,
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

// ── Link Section ───────────────────────────────────────────────────────────
function LinkSection({ title, links, copiedUrl, onCopy, onDelete, onAdd }) {
  const owners = [...new Set(links.map(l => l.owner))];

  return (
    <div className="detail-info-block">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div className="section-title" style={{ margin: 0 }}>{title}</div>
        {onAdd && (
          <button className="btn btn-secondary" style={{ fontSize: 12, padding: '4px 12px' }} onClick={onAdd}>
            + Add Link
          </button>
        )}
      </div>

      {owners.map((owner, i) => (
        <div key={owner}>
          <div style={{
            fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)',
            textTransform: 'uppercase', letterSpacing: '0.06em',
            margin: `${i > 0 ? 16 : 0}px 0 8px`,
          }}>
            {owner}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
            {links.filter(l => l.owner === owner).map(item => (
              <LinkCard
                key={item.url}
                item={item}
                copiedUrl={copiedUrl}
                onCopy={onCopy}
                onDelete={onDelete ? () => onDelete(item.url) : null}
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────
export default function MeetingLinks() {
  const [copiedUrl, setCopiedUrl] = useState(null);
  const [customLinks, setCustomLinks] = useState(loadCustomLinks);
  const [showModal, setShowModal] = useState(false);

  function handleCopy(url) {
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(url).then(() => {
        setCopiedUrl(url);
        setTimeout(() => setCopiedUrl(null), 1500);
      });
    } else {
      const el = document.createElement('textarea');
      el.value = url;
      el.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(el);
      el.select();
      document.execCommand('copy');
      document.body.removeChild(el);
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl(null), 1500);
    }
  }

  function handleAdd(link) {
    const updated = [...customLinks, link];
    setCustomLinks(updated);
    saveCustomLinks(updated);
    setShowModal(false);
  }

  function handleDelete(url) {
    const link = customLinks.find(l => l.url === url);
    if (link) {
      try {
        const recycled = JSON.parse(localStorage.getItem(RECYCLE_KEY) || '[]');
        recycled.push({ ...link, deleted_at: new Date().toISOString() });
        localStorage.setItem(RECYCLE_KEY, JSON.stringify(recycled));
      } catch {}
    }
    const updated = customLinks.filter(l => l.url !== url);
    setCustomLinks(updated);
    saveCustomLinks(updated);
  }

  const allCalendly = [...BUILTIN_CALENDLY, ...customLinks];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Meeting Links</h1>
          <p>Click any card to copy the link to your clipboard</p>
        </div>
      </div>

      <LinkSection
        title="Calendly"
        links={allCalendly}
        copiedUrl={copiedUrl}
        onCopy={handleCopy}
        onDelete={url => handleDelete(url)}
        onAdd={() => setShowModal(true)}
      />

      {showModal && <AddLinkModal onSave={handleAdd} onClose={() => setShowModal(false)} />}
    </div>
  );
}
