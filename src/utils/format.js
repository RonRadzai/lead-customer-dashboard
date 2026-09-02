// Shared date and label formatting helpers.

// Parse SQLite-style and ISO date strings. SQLite CURRENT_TIMESTAMP strings carry
// no timezone but are UTC — append Z so JS doesn't read them as local time.
export function toDate(s) {
  if (!s) return null;
  s = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)) return new Date(s.replace(' ', 'T') + 'Z');
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T00:00:00Z');
  return new Date(s);
}

// "Jun 11, 2026" — UTC-aware via toDate (list views).
export function formatShortDate(dateStr) {
  if (!dateStr) return '—';
  const d = toDate(dateStr);
  if (!d || isNaN(d)) return '—';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// "Jun 11, 2026, 2:30 PM" (detail views).
export function formatDateTime(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// "just now" / "5m ago" / "3h ago" / "2d ago" / locale date.
export function formatRelative(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr.includes('T') ? dateStr : dateStr.replace(' ', 'T') + 'Z');
  const now = new Date();
  const diffMins = Math.floor((now - date) / 60000);
  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHrs = Math.floor(diffMins / 60);
  if (diffHrs < 24) return `${diffHrs}h ago`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

// Activity-log action → display label (covers lead and new-user actions).
export const ACTION_LABELS = {
  created:          'Created',
  updated:          'Updated',
  stage_changed:    'Stage Changed',
  converted:        'Converted',
  lost:             'Marked Lost',
  note_added:       'Note Added',
  category_changed: 'Category Changed',
  status_changed:   'Status Changed',
  attempt_logged:   'Attempt Logged',
  attempt_reverted: 'Attempt Reverted',
  demo_scheduled:   'Meeting Scheduled',
  meeting_canceled: 'Meeting Canceled',
  meeting_completed:'Meeting Completed',
};

export const formatAction = (action) => ACTION_LABELS[action] || action;
