import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchGroups } from '../api/client.js';
import { PeopleIcon } from './icons.js';
import { imeComposing } from '../lib/ime.js';

/**
 * Searchable group picker backed by /rest/api/2/groups/picker (admin-only in
 * Jira and here). When `canBrowse` is false — e.g. a project admin who can
 * assign group actors but may not enumerate groups — it degrades to a plain
 * free-text input so the caller can still submit a known group name.
 */
export default function GroupPicker({
  value,
  onChange,
  canBrowse = true,
  placeholder = 'Group name…',
  disabled = false,
  className = '',
}: {
  /** Selected group name, or '' for none. */
  value: string;
  onChange: (name: string) => void;
  /** False → free-text input (no /groups/picker permission). */
  canBrowse?: boolean;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data } = useQuery({
    queryKey: ['groups-picker', query],
    queryFn: () => fetchGroups(query),
    enabled: canBrowse && open,
  });
  const options = (data?.groups ?? []).map((g) => g.name).filter((n) => n !== value);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  useEffect(() => setHighlight(0), [query]);

  if (!canBrowse) {
    return (
      <input
        className={`h-9 px-2 rounded-[3px] border-2 border-atl-n-40 text-sm text-atl-n-800 focus:border-atl-b-300 outline-none bg-atl-paper disabled:bg-atl-n-10 ${className}`}
        placeholder={placeholder}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  const pick = (name: string) => {
    onChange(name);
    setOpen(false);
    setQuery('');
  };

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setOpen((o) => !o);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        className="w-full h-9 px-2 rounded-[3px] border-2 border-atl-n-40 text-sm text-atl-n-800 focus:border-atl-b-300 outline-none bg-atl-paper flex items-center gap-2 text-left disabled:bg-atl-n-10"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={value || placeholder}
      >
        <PeopleIcon size={16} className="text-atl-n-200 shrink-0" />
        <span className={`truncate ${value ? '' : 'text-atl-n-200'}`}>{value || placeholder}</span>
      </button>

      {open && (
        <div className="absolute top-10 left-0 right-0 z-40 rounded bg-atl-paper shadow-lg border border-atl-n-30">
          <div className="p-2 border-b border-atl-n-30">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown' && options.length) {
                  e.preventDefault();
                  setHighlight((h) => (h + 1) % options.length);
                } else if (e.key === 'ArrowUp' && options.length) {
                  e.preventDefault();
                  setHighlight((h) => (h - 1 + options.length) % options.length);
                } else if (e.key === 'Enter' && !imeComposing(e)) {
                  e.preventDefault();
                  if (options[highlight]) pick(options[highlight]);
                } else if (e.key === 'Escape') {
                  setOpen(false);
                }
              }}
              placeholder="Search groups"
              aria-label="Search groups"
              className="w-full h-8 px-2 rounded border border-atl-n-40 text-sm outline-none focus:border-atl-b-300"
            />
          </div>
          <div className="max-h-56 overflow-y-auto py-1" role="listbox">
            {options.map((name, i) => (
              <button
                key={name}
                type="button"
                role="option"
                aria-selected={i === highlight}
                onClick={() => pick(name)}
                onMouseEnter={() => setHighlight(i)}
                title={name}
                className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left ${i === highlight ? 'bg-atl-b-50' : 'hover:bg-atl-n-10'}`}
              >
                <PeopleIcon size={16} className="text-atl-n-200 shrink-0" />
                <span className="min-w-0 truncate text-sm text-atl-n-800">{name}</span>
              </button>
            ))}
            {options.length === 0 && (
              <div className="px-3 py-2 text-xs text-atl-n-200">No groups found</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
