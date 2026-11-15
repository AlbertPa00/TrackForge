import { Link } from 'react-router-dom';
import type { ReactNode } from 'react';

/** Shared page header: breadcrumb line, title row with right-aligned actions.
 *  Unifies the hand-rolled headers across pages (P2 — layout alignment). */
export default function PageHeader({
  crumbs,
  title,
  actions,
  afterTitle,
}: {
  /** Breadcrumb segments; a `to` renders a Link, plain text renders a span. */
  crumbs?: { label: string; to?: string }[];
  title: ReactNode;
  actions?: ReactNode;
  /** Extra content rendered inline after the title (chips, toggles). */
  afterTitle?: ReactNode;
}) {
  return (
    <div className="mb-5 flex items-start justify-between gap-4">
      <div className="min-w-0">
        {crumbs && crumbs.length > 0 && (
          <nav className="text-xs text-atl-n-200 mb-0.5" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
              <span key={i}>
                {i > 0 && <span className="mx-1">/</span>}
                {c.to ? (
                  <Link to={c.to} className="text-atl-n-400 hover:underline">
                    {c.label}
                  </Link>
                ) : (
                  <span className="text-atl-n-400">{c.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        <h1 className="text-xl font-semibold text-atl-n-800 flex items-center gap-2">
          {title}
          {afterTitle}
        </h1>
      </div>
      {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
