import React from 'react';

export function SkeletonRow() {
  return (
    <div className="skeleton-row" aria-hidden="true">
      <div>
        <span className="skeleton skeleton-line-lg" style={{ marginBottom: 8 }} />
        <span className="skeleton skeleton-line-md" />
      </div>
      <div className="skeleton-row-trailing">
        <span className="skeleton skeleton-pill" />
        <span className="skeleton skeleton-date" />
      </div>
    </div>
  );
}

export function SkeletonList({ count = 6 }) {
  return (
    <div className="record-list" aria-busy="true" aria-label="Loading">
      {Array.from({ length: count }, (_, i) => <SkeletonRow key={i} />)}
    </div>
  );
}

const EMPTY_ICONS = {
  inbox: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 12h-6l-2 3h-4l-2-3H2" />
      <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z" />
    </svg>
  ),
  users: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  ),
  search: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8" />
      <path d="m21 21-4.35-4.35" />
    </svg>
  ),
  sparkle: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="m19 6-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
    </svg>
  ),
};

export function EmptyState({ icon = 'inbox', title, description, action }) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">{EMPTY_ICONS[icon] || EMPTY_ICONS.inbox}</div>
      {title && <h3>{title}</h3>}
      {description && <p>{description}</p>}
      {action}
    </div>
  );
}

export default SkeletonList;
