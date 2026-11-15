import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  fetchMyself,
  searchAssignableUsers,
  type UserRef,
} from '../api/client.js';
import UserAvatar from './UserAvatar.js';
import { imeComposing } from '../lib/ime.js';

/**
 * Form-bound people picker — same UX as AssigneePicker but stores an
 * accountId instead of writing to an issue. Use wherever a user is chosen
 * before the issue exists (create dialog, filter sharing, ownership).
 */
export default function UserPicker({
  projectKey,
  search,
  value,
  onChange,
  placeholder = 'Unassigned',
  disabled = false,
  className = '',
}: {
  /** Scope for assignable-user search. Ignored when `search` is provided. */
  projectKey?: string;
  /** Custom people search (e.g. global /user/search) — overrides projectKey. */
  search?: (query: string) => Promise<UserRef[]>;
  /** Selected accountId, or '' for none. */
  value: string;
  onChange: (accountId: string, user: UserRef | null) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  // Remember the picked user — they may not be in the current search page.
  const [picked, setPicked] = useState<UserRef | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const { data: me } = useQuery({ queryKey: ['myself'], queryFn: fetchMyself, staleTime: Infinity });
  const { data: users, isFetching } = useQuery({
    queryKey: search ? ['user-search', query] : ['assignable', projectKey, query],
    queryFn: () => (search ? search(query) : searchAssignableUsers(projectKey!, query)),
    enabled: Boolean(search ?? projectKey),
  });

  const selected =
    (picked?.accountId === value ? picked : null) ??
    (users ?? []).find((u) => u.accountId === value) ??
    null;

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  useEffect(() => setHighlight(0), [query]);

  const options = users ?? [];
  const showSelf = Boolean(me && me.accountId !== value && (search ?? projectKey));

  const pick = (u: UserRef | null) => {
    setPicked(u);
    onChange(u?.accountId ?? '', u);
    setOpen(false);
    setQuery('');
  };

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        disabled={disabled || !(search ?? projectKey)}
        onClick={() => {
          setOpen((o) => !o);
          requestAnimationFrame(() => inputRef.current?.focus());
        }}
        className="w-full h-9 px-2 rounded-[3px] border-2 border-atl-n-40 text-sm text-atl-n-800 focus:border-atl-b-300 outline-none bg-atl-paper flex items-center gap-2 text-left disabled:bg-atl-n-10"
        aria-haspopup="listbox"
        aria-expanded={open}
        title={selected?.displayName ?? placeholder}
      >
        <UserAvatar displayName={selected?.displayName} size={20} />
        <span className="truncate">{selected?.displayName ?? placeholder}</span>
      </button>

      {open && (
        <div className="absolute top-10 left-0 right-0 z-40 rounded bg-atl-paper shadow-lg border border-atl-n-30">
          <div className="p-2 border-b border-atl-n-30">
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                const count = options.length + (showSelf ? 1 : 0) + (value ? 1 : 0);
                if (e.key === 'ArrowDown' && count) {
                  e.preventDefault();
                  setHighlight((h) => (h + 1) % count);
                } else if (e.key === 'ArrowUp' && count) {
                  e.preventDefault();
                  setHighlight((h) => (h - 1 + count) % count);
                } else if (e.key === 'Enter' && !imeComposing(e) && count) {
                  e.preventDefault();
                  if (highlight === 0 && showSelf) pick(me!);
                  else {
                    const off = showSelf ? 1 : 0;
                    if (value && highlight === off) pick(null);
                    else {
                      const idx = highlight - off - (value ? 1 : 0);
                      if (options[idx]) pick(options[idx]);
                    }
                  }
                } else if (e.key === 'Escape') {
                  e.stopPropagation(); // don't let a parent Modal/Drawer close too
                  setOpen(false);
                }
              }}
              placeholder="Search people"
              aria-label="Search people"
              className="w-full h-8 px-2 rounded border border-atl-n-40 text-sm outline-none focus:border-atl-b-300"
            />
          </div>
          <div className="max-h-56 overflow-y-auto py-1" role="listbox">
            {showSelf && (
              <Row active={highlight === 0} user={me!} label={`Assign to me (${me!.displayName})`} sub={me!.emailAddress} onClick={() => pick(me!)} onHover={() => setHighlight(0)} />
            )}
            {value && (
              <Row active={highlight === (showSelf ? 1 : 0)} unassigned label="Unassigned" onClick={() => pick(null)} onHover={() => setHighlight(showSelf ? 1 : 0)} />
            )}
            {options.map((u, i) => {
              const idx = i + (showSelf ? 1 : 0) + (value ? 1 : 0);
              return (
                <Row key={u.accountId} active={highlight === idx} user={u} label={u.displayName} sub={u.emailAddress} onClick={() => pick(u)} onHover={() => setHighlight(idx)} />
              );
            })}
            {options.length === 0 && (
              <div className="px-3 py-2 text-xs text-atl-n-200">
                {isFetching ? 'Searching…' : 'No people found'}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  user,
  label,
  sub,
  unassigned,
  active,
  onClick,
  onHover,
}: {
  user?: UserRef;
  label: string;
  sub?: string;
  unassigned?: boolean;
  active?: boolean;
  onClick: () => void;
  onHover: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={active}
      onClick={onClick}
      onMouseEnter={onHover}
      title={sub ? `${label} (${sub})` : label}
      className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-left ${active ? 'bg-atl-b-50' : 'hover:bg-atl-n-10'}`}
    >
      <UserAvatar displayName={unassigned ? null : user?.displayName} size={24} />
      <span className="min-w-0">
        <span className="block text-sm text-atl-n-800 truncate">{label}</span>
        {sub && <span className="block text-xs text-atl-n-200 truncate">{sub}</span>}
      </span>
    </button>
  );
}
