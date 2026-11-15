import { useEffect, useRef, useState } from 'react';

/** Jira-style ⋯ row-action menu (releases, components, …). */
export default function RowMenu({
  items,
  ariaLabel = 'Row actions',
}: {
  items: { label: string; onClick: () => void; disabled?: boolean; danger?: boolean }[];
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={ariaLabel}
        title={ariaLabel}
        aria-expanded={open}
        className="h-7 w-7 rounded-[3px] bg-atl-n-20 text-sm text-atl-n-700 hover:bg-atl-n-30"
      >
        ⋯
      </button>
      {open && (
        <ul className="absolute right-0 top-full z-20 mt-1 w-36 rounded border border-atl-n-30 bg-atl-paper py-1 shadow-lg">
          {items.map((it) => (
            <li key={it.label}>
              <button
                type="button"
                disabled={it.disabled}
                onClick={() => { setOpen(false); it.onClick(); }}
                className={`w-full px-3 py-1.5 text-left text-sm hover:bg-atl-n-10 disabled:opacity-40 disabled:hover:bg-transparent ${
                  it.danger ? 'text-atl-r-400' : 'text-atl-n-600'
                }`}
              >
                {it.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
