// 050 docs portal — grouped, collapsible sidebar nav (Mintlify-style).
import { useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchDocsManifest } from '../../api/client.js';
import { ChevronDownIcon, CodeIcon } from '../../components/icons.js';
import { orderedSections, pagesInSection, sectionIcon } from './nav.js';

export function useManifest() {
  return useQuery({ queryKey: ['docs-manifest'], queryFn: fetchDocsManifest, staleTime: 60_000 });
}

/** Nav body shared by the sticky desktop rail and the mobile drawer. */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const manifest = useManifest();
  const { pathname } = useLocation();
  // Sidebar lives outside the nested <Routes>, so parse the slug from the URL.
  const slug = pathname.startsWith('/docs/page/') ? pathname.split('/')[3] : undefined;
  const [closed, setClosed] = useState<Set<string>>(new Set());
  if (!manifest.data) return <nav className="px-3 py-4 text-sm text-[var(--d-faint)]">Loading…</nav>;
  const m = manifest.data;

  const toggle = (sec: string) =>
    setClosed((s) => {
      const next = new Set(s);
      if (next.has(sec)) next.delete(sec);
      else next.add(sec);
      return next;
    });

  return (
    <nav className="px-3 pb-8 pt-4" aria-label="Documentation">
      {orderedSections(m).map((sec) => {
        const list = pagesInSection(m, sec);
        if (!list.length && sec !== 'api') return null;
        const Icon = sectionIcon(m.sectionMeta?.[sec]?.icon);
        const isClosed = closed.has(sec);
        // Never collapse the group that contains the page you're reading.
        const expanded = !isClosed || list.some((p) => p.slug === slug);
        return (
          <div key={sec} className="mb-4">
            <button
              type="button"
              onClick={() => toggle(sec)}
              aria-expanded={expanded}
              className="group flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left"
            >
              <span className="flex h-5 w-5 items-center justify-center text-[var(--d-faint)] transition-colors group-hover:text-[var(--d-accent)]">
                <Icon size={14} />
              </span>
              <span className="text-[13px] font-semibold tracking-tight text-[var(--d-text)]">
                {m.sections[sec] ?? sec}
              </span>
              <span
                className={`ml-auto text-[var(--d-faint)] transition-transform ${expanded ? 'rotate-180' : ''}`}
              >
                <ChevronDownIcon size={12} />
              </span>
            </button>
            {expanded && (
              <div className="mt-0.5 ml-[18px] border-l border-[var(--d-border-soft)] pl-2">
                {list.map((p) => (
                  <NavLink
                    key={p.slug}
                    to={`/docs/page/${p.slug}`}
                    onClick={onNavigate}
                    className={({ isActive }) => `d-navitem ${isActive ? 'active' : ''}`}
                  >
                    <span className="truncate" title={p.title}>{p.title}</span>
                    {p.audience === 'admin' && (
                      <span className="d-chip ml-auto shrink-0" title="Admin audience only">Admin</span>
                    )}
                  </NavLink>
                ))}
                {sec === 'api' && (
                  <NavLink
                    to="/docs/api"
                    onClick={onNavigate}
                    className={({ isActive }) => `d-navitem ${isActive ? 'active' : ''}`}
                  >
                    <CodeIcon size={13} className="shrink-0" />
                    <span className="truncate">Endpoint explorer</span>
                  </NavLink>
                )}
              </div>
            )}
          </div>
        );
      })}
    </nav>
  );
}

export function Sidebar() {
  return (
    <aside className="d-scrollbar hidden w-64 shrink-0 overflow-y-auto border-r border-[var(--d-border)] bg-[var(--d-surface)] lg:block">
      <SidebarNav />
    </aside>
  );
}
