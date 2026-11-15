// 050 docs portal — ⌘K search palette (Mintlify-style). Merges server-side
// excerpt search with the offline client index, deduped by slug.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchDocsIndex, fetchDocsSearch } from '../../api/client.js';
import { SearchIcon } from '../../components/icons.js';
import { useManifest } from './Sidebar.js';
import { imeComposing } from '../../lib/ime.js';
import { useModalDialog } from '../../lib/useModalDialog.js';

interface Hit { slug: string; title: string; section: string; sub: string }

export function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const navigate = useNavigate();
  const listRef = useRef<HTMLDivElement>(null);
  const dlgRef = useRef<HTMLDialogElement>(null);
  const manifest = useManifest();
  useModalDialog({ ref: dlgRef, open, onClose });

  const server = useQuery({
    queryKey: ['docs-search', q],
    queryFn: () => fetchDocsSearch(q),
    enabled: open && q.trim().length >= 2,
  });
  const index = useQuery({
    queryKey: ['docs-index'],
    queryFn: fetchDocsIndex,
    staleTime: 300_000,
    enabled: open,
  });

  const hits = useMemo<Hit[]>(() => {
    if (q.trim().length < 2) return [];
    const seen = new Set<string>();
    const out: Hit[] = [];
    for (const r of server.data?.results ?? []) {
      seen.add(r.slug);
      out.push({ slug: r.slug, title: r.title, section: r.section, sub: r.excerpt });
    }
    const needle = q.toLowerCase();
    for (const i of index.data?.index ?? []) {
      if (seen.has(i.slug)) continue;
      if (i.title.toLowerCase().includes(needle) || i.headings.some((h) => h.toLowerCase().includes(needle))) {
        seen.add(i.slug);
        out.push({ slug: i.slug, title: i.title, section: i.section, sub: i.headings[0] ?? '' });
      }
      if (out.length >= 10) break;
    }
    return out;
  }, [server.data, index.data, q]);

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
    }
  }, [open]);
  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  const sectionLabel = (s: string) => manifest.data?.sections[s] ?? s;
  const go = (slug: string) => {
    onClose();
    navigate(`/docs/page/${slug}`);
  };

  return (
    <dialog
      ref={dlgRef}
      aria-label="Search documentation"
      className="tf-palette mx-auto mt-[12vh] w-full max-w-xl overflow-hidden rounded-xl border border-[var(--d-border)] bg-[var(--d-raised)] p-0 shadow-[var(--d-shadow)]"
    >
        <div className="flex items-center gap-2.5 border-b border-[var(--d-border-soft)] px-4 py-3">
          <SearchIcon size={16} className="shrink-0 text-[var(--d-faint)]" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, hits.length - 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
              else if (e.key === 'Enter' && !imeComposing(e) && hits[active]) go(hits[active].slug);
              else if (e.key === 'Escape') onClose();
            }}
            placeholder="Search documentation…"
            className="w-full bg-transparent text-[15px] text-[var(--d-text)] outline-none placeholder:text-[var(--d-faint)]"
          />
          <kbd className="d-kbd">esc</kbd>
        </div>
        <div ref={listRef} className="d-scrollbar max-h-[55vh] overflow-y-auto p-2">
          {q.trim().length >= 2 && hits.length === 0 && !server.isFetching && (
            <div className="px-3 py-8 text-center text-sm text-[var(--d-faint)]">
              No results for “{q}”.
            </div>
          )}
          {q.trim().length < 2 && (
            <div className="px-3 py-8 text-center text-sm text-[var(--d-faint)]">
              Type at least 2 characters to search across all docs.
            </div>
          )}
          {hits.map((h, i) => (
            <button
              key={h.slug}
              type="button"
              data-active={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(h.slug)}
              className={`flex w-full items-start gap-3 rounded-lg px-3 py-2.5 text-left ${
                i === active ? 'bg-[var(--d-hover)]' : ''
              }`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-[var(--d-text)]" title={h.title}>{h.title}</span>
                {h.sub && (
                  <span className="mt-0.5 block truncate text-xs text-[var(--d-muted)]" title={h.sub}>{h.sub}</span>
                )}
              </span>
              <span className="d-chip mt-0.5 shrink-0">{sectionLabel(h.section)}</span>
            </button>
          ))}
        </div>
        <div className="flex items-center gap-4 border-t border-[var(--d-border-soft)] px-4 py-2 text-[11px] text-[var(--d-faint)]">
          <span className="flex items-center gap-1"><kbd className="d-kbd">↑</kbd><kbd className="d-kbd">↓</kbd> navigate</span>
          <span className="flex items-center gap-1"><kbd className="d-kbd">↵</kbd> open</span>
          <span className="ml-auto">Docs ship with this build</span>
        </div>
    </dialog>
  );
}
