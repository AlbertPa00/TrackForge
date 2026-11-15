import { useEffect, useRef, useState, type ReactNode } from 'react';

export interface IconSelectOption {
  value: string;
  label: string;
  icon?: ReactNode;
}

/** Closed button that opens an option list below (icons supported — unlike a
    native <select>). Esc / click-outside closes; a pick calls onChange and
    closes. Matches the restyled .border-atl-n-40 selects. */
export default function IconSelect({
  value,
  options,
  onChange,
  className = '',
  ariaLabel,
}: {
  value: string;
  options: IconSelectOption[];
  onChange: (value: string) => void;
  className?: string;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        className="flex w-full items-center gap-1.5 rounded border border-atl-n-40 bg-atl-paper px-2 py-1.5 text-sm text-atl-n-800 shadow-sm focus:border-atl-b-300 focus:outline-none"
      >
        {current?.icon}
        <span className="flex-1 text-left">{current?.label ?? value}</span>
        <svg width="10" height="10" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true" className="text-atl-n-200">
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute left-0 right-0 z-50 mt-1 max-h-56 overflow-auto rounded border border-atl-n-40 bg-atl-paper py-1 shadow-lg"
        >
          {options.map((o) => (
            <li
              key={o.value}
              role="option"
              aria-selected={o.value === value}
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(o.value);
                setOpen(false);
              }}
              className={`flex cursor-pointer items-center gap-1.5 px-2 py-1.5 text-sm hover:bg-atl-n-20 ${
                o.value === value ? 'bg-atl-b-50 text-atl-b-500' : 'text-atl-n-800'
              }`}
            >
              {o.icon}
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
