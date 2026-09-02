import { useState, useEffect, useRef } from 'react';
import './App.css';
import Dashboard from './components/Dashboard';
import LeadsList from './components/LeadsList';
import LeadDetail from './components/LeadDetail';
import NewUsersList from './components/NewUsersList';
import NewUserDetail from './components/NewUserDetail';
import EstablishedUsersList from './components/EstablishedUsersList';
import Settings from './components/Settings';
import MeetingLinks from './components/MeetingLinks';
import MeetingsList from './components/MeetingsList';
import RecentInteractions from './components/RecentInteractions';
import RecycleBin from './components/RecycleBin';

// Optional link to the sibling support-notes app (set REACT_APP_SUPPORT_SESSIONS_URL at build time).
const SUPPORT_SESSIONS_URL = process.env.REACT_APP_SUPPORT_SESSIONS_URL || '';

// ─── URL hash helpers ──────────────────────────────────────────────────────
function parseHash() {
  const raw = window.location.hash.slice(1) || 'dashboard';
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  const view = segments[0] || 'dashboard';
  const id   = segments[1] ? parseInt(segments[1], 10) : null;
  const params = new URLSearchParams(queryPart || '');
  return { view, id, params };
}

function buildHash(view, id, filters) {
  let hash = view;
  if (id) hash += `/${id}`;
  const entries = Object.entries(filters || {}).filter(([, v]) => v);
  if (entries.length) hash += '?' + new URLSearchParams(Object.fromEntries(entries)).toString();
  return hash;
}

const DEFAULT_LEADS_FILTERS       = { stage: '', assignedTo: '', search: '', sort: 'newest' };
const DEFAULT_USERS_FILTERS       = { search: '', period: 'last_month' };
const DEFAULT_ESTABLISHED_FILTERS = { search: '' };

function filtersFromParams(params, defaults) {
  const out = { ...defaults };
  for (const key of Object.keys(defaults)) {
    if (params.has(key)) out[key] = params.get(key);
  }
  return out;
}

// ─── Sidebar ──────────────────────────────────────────────────────────────
const NAV_ICONS = {
  dashboard:   <><path d="M3 12 12 3l9 9" /><path d="M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10" /></>,
  leads:       <><rect x="8" y="4" width="8" height="4" rx="1" /><path d="M9 12h6M9 16h6" /><path d="M16 6h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2" /></>,
  newUsers:    <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  established: <><path d="M3 21h18" /><path d="M5 21V7l7-4 7 4v14" /><path d="M9 9h1M9 13h1M9 17h1M14 9h1M14 13h1M14 17h1" /></>,
  calendar:           <><rect x="3" y="4" width="18" height="18" rx="2" ry="2" /><line x1="16" y1="2" x2="16" y2="6" /><line x1="8" y1="2" x2="8" y2="6" /><line x1="3" y1="10" x2="21" y2="10" /></>,
  recentInteractions: <><polyline points="22 12 18 12 15 21 9 3 6 12 2 12" /></>,
  meetings:    <><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>,
  recycle:     <><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /></>,
  settings:    <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h.01a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h.01a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v.01a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>,
  supportSessions: <><path d="M4 12v-1a8 8 0 0 1 16 0v1" /><path d="M2 12h2a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" /><path d="M20 12h2a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z" /><path d="M21 17c0 3-3 4-6 4h-2" /></>,
};

function NavIcon({ name }) {
  return (
    <svg
      className="nav-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {NAV_ICONS[name]}
    </svg>
  );
}

// ─── Identity Modal ───────────────────────────────────────────────────────
function IdentityModal({ onConfirm }) {
  const [members, setMembers]     = useState([]);
  const [loading, setLoading]     = useState(true);
  const [selected, setSelected]   = useState(null);
  const [showManual, setShowManual] = useState(false);
  const [manualName, setManualName]   = useState('');
  const [manualEmail, setManualEmail] = useState('');

  useEffect(() => {
    fetch('/api/team')
      .then(r => r.json())
      .then(data => { setMembers(data); setLoading(false); })
      .catch(() => { setShowManual(true); setLoading(false); });
  }, []);

  function handleConfirm() {
    if (showManual) {
      if (!manualName.trim()) return;
      onConfirm({ name: manualName.trim(), email: manualEmail.trim() });
    } else if (selected) {
      onConfirm({ name: selected.name, email: selected.email || '' });
    }
  }

  const canConfirm = showManual ? manualName.trim() : !!selected;

  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
    }}>
      <div style={{
        background: 'var(--bg-card)', borderRadius: 'var(--radius)',
        padding: 32, width: 380, maxWidth: '90vw',
        boxShadow: '0 20px 60px rgba(0,0,0,0.4)',
      }}>
        <h2 style={{ margin: '0 0 6px', fontSize: 20 }}>Who are you?</h2>
        <p style={{ margin: '0 0 20px', color: 'var(--text-secondary)', fontSize: 14 }}>
          Select your name so notes and activity are attributed to you.
        </p>
        {loading && <p className="text-muted">Loading team…</p>}
        {!loading && !showManual && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
            {members.map(m => (
              <div key={m.id} onClick={() => setSelected(m)} style={{
                padding: '10px 14px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
                border: `2px solid ${selected?.id === m.id ? 'var(--accent-blue)' : 'var(--border-color)'}`,
                background: selected?.id === m.id ? 'rgba(59,130,246,0.08)' : 'var(--bg-input)',
                fontSize: 14, fontWeight: selected?.id === m.id ? 600 : 400,
              }}>
                {m.name}
                {m.role && <span style={{ color: 'var(--text-secondary)', fontWeight: 400, marginLeft: 8, fontSize: 12 }}>{m.role}</span>}
              </div>
            ))}
            <div onClick={() => setShowManual(true)} style={{
              padding: '10px 14px', borderRadius: 'var(--radius-sm)', cursor: 'pointer',
              border: '1px dashed var(--border-color)', color: 'var(--text-secondary)',
              fontSize: 13, textAlign: 'center',
            }}>
              Not listed? Enter manually
            </div>
          </div>
        )}
        {!loading && showManual && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
            <input className="form-control" placeholder="Your name" value={manualName}
              onChange={e => setManualName(e.target.value)} autoFocus />
            <input className="form-control" placeholder="Your email (optional)" value={manualEmail}
              onChange={e => setManualEmail(e.target.value)} />
            {members.length > 0 && (
              <button className="btn btn-secondary btn-sm"
                onClick={() => { setShowManual(false); setManualName(''); setManualEmail(''); }}>
                ← Back to team list
              </button>
            )}
          </div>
        )}
        <button className="btn btn-primary" style={{ width: '100%' }}
          onClick={handleConfirm} disabled={!canConfirm}>
          Continue
        </button>
      </div>
    </div>
  );
}

function Sidebar({ currentView, onNavigate, darkMode, onToggleDark, currentUser, onSwitchUser }) {
  const navItems = [
    { id: 'dashboard',          icon: 'dashboard',   label: 'Dashboard' },
    { id: 'leads',              icon: 'leads',       label: 'Leads' },
    { id: 'new-users',          icon: 'newUsers',    label: 'New Users' },
    { id: 'established-users',    icon: 'established',        label: 'Established Users' },
    { id: 'recent-interactions',  icon: 'recentInteractions', label: 'Recent Interactions' },
    { id: 'meetings',             icon: 'calendar',           label: 'Meetings' },
    { id: 'meeting-links',      icon: 'meetings',    label: 'Meeting Links' },
    { id: 'recycle-bin',        icon: 'recycle',     label: 'Recycle Bin' },
    { id: 'settings',           icon: 'settings',    label: 'Settings' },
  ];

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <img src="/favicon.svg" alt="" className="sidebar-logo-img" />
        <h2>Lead Dashboard</h2>
      </div>
      <nav className="sidebar-nav">
        {navItems.map(item => (
          <div
            key={item.id}
            className={`nav-item${currentView === item.id ? ' active' : ''}`}
            onClick={() => onNavigate(item.id)}
          >
            <NavIcon name={item.icon} />
            {item.label}
          </div>
        ))}
        {SUPPORT_SESSIONS_URL && (
          <a
            href={SUPPORT_SESSIONS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="nav-item"
            style={{ textDecoration: 'none' }}
          >
            <NavIcon name="supportSessions" />
            Support Sessions
          </a>
        )}
      </nav>
      <div className="sidebar-footer">
        {currentUser && (
          <div style={{ marginBottom: 10, paddingBottom: 10, borderBottom: '1px solid var(--border-color)' }}>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 2 }}>Signed in as</div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
              <span style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text-primary)' }}>
                {currentUser.name}
              </span>
              <button onClick={onSwitchUser} style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: '2px 4px',
                color: 'var(--text-secondary)', fontSize: 11, flexShrink: 0, borderRadius: 4,
              }}>
                Switch
              </button>
            </div>
          </div>
        )}
        <div className="theme-control">
          <span className="theme-label">
            Theme <span className="theme-icon">{darkMode ? '🌙' : '☀️'}</span>
          </span>
          <label className="theme-toggle-switch">
            <input type="checkbox" checked={darkMode} onChange={onToggleDark} />
            <span className="theme-toggle-track">
              <span className="theme-toggle-thumb" />
            </span>
          </label>
        </div>
      </div>
    </aside>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────
function App() {
  const initial = parseHash();
  const VALID_VIEWS = ['dashboard','leads','lead-detail','new-users','new-user-detail','established-users','established-user-detail','recent-interactions','meetings','meeting-links','recycle-bin','settings'];
  const initView = VALID_VIEWS.includes(initial.view) ? initial.view : 'dashboard';

  const [view, setView]                   = useState(initView);
  const [selectedLeadId, setSelectedLeadId] = useState(
    initView === 'lead-detail' ? initial.id : null
  );
  const [selectedUserId, setSelectedUserId] = useState(
    (initView === 'new-user-detail' || initView === 'established-user-detail') ? initial.id : null
  );
  // Track which list the user came from so the detail page back-button goes to the right place
  const [userDetailSource, setUserDetailSource] = useState('new-users');
  const [initialMeetingId, setInitialMeetingId] = useState(null);
  const [leadsOpenAdd, setLeadsOpenAdd]     = useState(false);
  const [leadsOpenImport, setLeadsOpenImport] = useState(false);

  const [leadsFilters, setLeadsFilters]         = useState(filtersFromParams(initial.params, DEFAULT_LEADS_FILTERS));
  const [usersFilters, setUsersFilters]         = useState(filtersFromParams(initial.params, DEFAULT_USERS_FILTERS));
  const [establishedFilters, setEstablishedFilters] = useState(filtersFromParams(initial.params, DEFAULT_ESTABLISHED_FILTERS));

  const [currentUser, setCurrentUser] = useState(() => {
    try { return JSON.parse(localStorage.getItem('lcd-user')) || null; }
    catch { return null; }
  });

  function handleIdentityConfirm(user) {
    localStorage.setItem('lcd-user', JSON.stringify(user));
    setCurrentUser(user);
  }

  function handleSwitchUser() {
    localStorage.removeItem('lcd-user');
    setCurrentUser(null);
  }

  const [darkMode, setDarkMode] = useState(() => localStorage.getItem('lcd-theme') === 'dark');
  const toggleDarkMode = () =>
    setDarkMode(d => {
      const next = !d;
      localStorage.setItem('lcd-theme', next ? 'dark' : 'light');
      return next;
    });
  useEffect(() => {
    document.body.classList.toggle('dark', darkMode);
  }, [darkMode]);

  // ── Sync state to URL whenever view/id/filters change ──────────────────
  // Page changes (view/id) push a history entry; filter-only changes replace the
  // current entry so the back button always returns to the previous page, not to
  // every intermediate filter/search state.
  const lastPage = useRef({ view: initView, id: initial.id || null });

  useEffect(() => {
    const id = view === 'lead-detail'              ? selectedLeadId
             : view === 'new-user-detail'           ? selectedUserId
             : view === 'established-user-detail'   ? selectedUserId
             : null;
    const isPageChange = view !== lastPage.current.view || id !== lastPage.current.id;
    lastPage.current = { view, id };
    const filters = view === 'leads'             ? leadsFilters
                  : view === 'new-users'         ? usersFilters
                  : view === 'established-users' ? establishedFilters
                  : {};
    const hash = buildHash(view, id, filters);
    if ('#' + hash !== window.location.hash) {
      if (isPageChange) {
        window.history.pushState(null, '', '#' + hash);
      } else {
        window.history.replaceState(null, '', '#' + hash);
      }
    }
  }, [view, selectedLeadId, selectedUserId, leadsFilters, usersFilters, establishedFilters]);

  // ── Listen to browser back/forward ────────────────────────────────────
  useEffect(() => {
    function onPop() {
      const { view: v, id, params } = parseHash();
      setView(v);
      if (v === 'lead-detail')             setSelectedLeadId(id);
      if (v === 'new-user-detail')         setSelectedUserId(id);
      if (v === 'established-user-detail') setSelectedUserId(id);
      setLeadsFilters(filtersFromParams(params, DEFAULT_LEADS_FILTERS));
      setUsersFilters(filtersFromParams(params, DEFAULT_USERS_FILTERS));
      setEstablishedFilters(filtersFromParams(params, DEFAULT_ESTABLISHED_FILTERS));
    }
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const sidebarView = view === 'lead-detail'             ? 'leads'
                    : view === 'new-user-detail'          ? 'new-users'
                    : view === 'established-user-detail'  ? (userDetailSource || 'established-users')
                    : view;

  function navigate(target) {
    setView(target);
    setSelectedLeadId(null);
    setSelectedUserId(null);
    setLeadsOpenAdd(false);
    setLeadsOpenImport(false);
  }

  function openLeadDetail(lead) {
    setSelectedLeadId(lead.id);
    setView('lead-detail');
  }

  // Lists reached via these sources show users as Established on the detail page.
  const isEstablishedSource = source => source === 'established-users' || source === 'recent-interactions';

  function openUserDetail(user, source) {
    setSelectedUserId(user.id);
    setUserDetailSource(source || 'new-users');
    setInitialMeetingId(user.meetingId || null);
    setView(isEstablishedSource(source) ? 'established-user-detail' : 'new-user-detail');
  }

  function openUserDetailById(userId, source) {
    setSelectedUserId(userId);
    setUserDetailSource(source || 'new-users');
    setView(isEstablishedSource(source) ? 'established-user-detail' : 'new-user-detail');
  }

  function handleDashboardAddLead() {
    setView('leads');
    setLeadsOpenAdd(true);
  }

  function handleDashboardImportCsv() {
    setView('leads');
    setLeadsOpenImport(true);
  }

  const isEstablishedDetail = view === 'established-user-detail';

  return (
    <div className={`app-layout${darkMode ? ' dark' : ''}`}>
      {!currentUser && <IdentityModal onConfirm={handleIdentityConfirm} />}
      <Sidebar
        currentView={sidebarView}
        onNavigate={navigate}
        darkMode={darkMode}
        onToggleDark={toggleDarkMode}
        currentUser={currentUser}
        onSwitchUser={handleSwitchUser}
      />
      <main className="main-content">
        <div className="page-container">
          {view === 'dashboard' && (
            <Dashboard
              onNavigate={navigate}
              onAddLead={handleDashboardAddLead}
              onImportCsv={handleDashboardImportCsv}
              onOpenLead={openLeadDetail}
              onOpenUser={u => openUserDetail(u, u.is_established ? 'established-users' : 'new-users')}
              currentUser={currentUser}
            />
          )}
          {view === 'leads' && (
            <LeadsList
              filters={leadsFilters}
              onFiltersChange={setLeadsFilters}
              onSelectLead={openLeadDetail}
              openAddModal={leadsOpenAdd}
              onAddModalClosed={() => setLeadsOpenAdd(false)}
              openImportModal={leadsOpenImport}
              onImportModalClosed={() => setLeadsOpenImport(false)}
            />
          )}
          {view === 'lead-detail' && (
            <LeadDetail leadId={selectedLeadId} onBack={() => setView('leads')} currentUser={currentUser} />
          )}
          {view === 'new-users' && (
            <NewUsersList
              filters={usersFilters}
              onFiltersChange={setUsersFilters}
              onSelectUser={u => openUserDetail(u, 'new-users')}
            />
          )}
          {(view === 'new-user-detail' || view === 'established-user-detail') && (
            <NewUserDetail
              userId={selectedUserId}
              onBack={() => navigate(userDetailSource)}
              backLabel={
                userDetailSource === 'established-users'   ? 'Established Users' :
                userDetailSource === 'recent-interactions' ? 'Recent Interactions' :
                'New Users'
              }
              isEstablished={isEstablishedDetail}
              onNavigateToUser={id => openUserDetailById(id, userDetailSource)}
              currentUser={currentUser}
              initialMeetingId={initialMeetingId}
            />
          )}
          {view === 'established-users' && (
            <EstablishedUsersList
              filters={establishedFilters}
              onFiltersChange={setEstablishedFilters}
              onSelectUser={u => openUserDetail(u, 'established-users')}
            />
          )}
          {view === 'recent-interactions' && (
            <RecentInteractions
              onSelectUser={u => openUserDetail(u, 'recent-interactions')}
            />
          )}
          {view === 'meetings' && (
            <MeetingsList
              onNavigate={navigate}
              onOpenLead={openLeadDetail}
              onOpenUser={u => openUserDetail(u, u.is_established ? 'established-users' : 'new-users')}
            />
          )}
          {view === 'meeting-links' && <MeetingLinks />}
          {view === 'recycle-bin' && <RecycleBin />}
          {view === 'settings' && <Settings />}
        </div>
      </main>
    </div>
  );
}

export default App;
