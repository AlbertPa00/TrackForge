import type { ReactNode } from 'react';

/**
 * 042 F-013 — Jira-style empty state: illustration chip + heading + helper copy +
 * optional action. Replaces plain-text "no results" lines; keep copy action-oriented
 * ("No issues match your search — try a different filter or create one").
 */
export default function EmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
      <div className="mb-3 flex h-16 w-16 items-center justify-center rounded-full bg-atl-n-20 text-atl-n-200">
        {icon ?? (
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.8-3.8" strokeLinecap="round" />
          </svg>
        )}
      </div>
      <h3 className="text-sm font-semibold text-atl-n-700">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-xs leading-relaxed text-atl-n-200">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
