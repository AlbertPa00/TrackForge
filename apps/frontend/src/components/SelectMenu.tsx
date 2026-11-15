import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Minimal styled dropdown — replaces native <select> in chrome-level spots
 *  (board switcher). Button + listbox; click-outside and Escape close. */
export default function SelectMenu({
  value,
  options,
  onChange,
  label,
  title,
  ariaLabel,
  buttonClassName,
}: {
  value: string;
  options: { value: string; label: string; hint?: string }[];
  onChange: (value: string) => void;
  /** Content rendered inside the trigger button. */
  label: ReactNode;
  title?: string;
  /** Accessible name for the trigger — falls back to `title`. */
  ariaLabel?: string;
  buttonClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
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
        onClick={() => setOpen((o) => !o)}
        title={title}
        aria-label={ariaLabel ?? title}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={
          buttonClassName ??
          'inline-flex items-center gap-1.5 rounded-[3px] px-2 py-1 text-sm text-atl-n-600 hover:bg-atl-n-20'
        }
      >
        {label}
        <svg width="10" height="10" viewBox="0 0 10 10" className="text-atl-n-100 shrink-0" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <ul
          role="listbox"
          className="absolute left-0 top-full mt-1 z-30 min-w-56 max-h-72 overflow-y-auto rounded-[3px] border border-atl-n-30 bg-atl-paper py-1 shadow-lg"
        >
          {options.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                role="option"
                aria-selected={o.value === value}
                onClick={() => {
                  setOpen(false);
                  if (o.value !== value) onChange(o.value);
                }}
                className={`w-full text-left px-3 py-1.5 text-sm hover:bg-atl-n-10 ${
                  o.value === value ? 'bg-atl-b-50 text-atl-b-400 font-medium' : 'text-atl-n-600'
                }`}
              >
                {o.label}
                {o.hint && <span className="block text-xs font-normal text-atl-n-200">{o.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
