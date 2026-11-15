import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { pickIssues, type PickedIssue } from '../api/client.js';
import IssueKey from './IssueKey.js';
import { imeComposing } from '../lib/ime.js';

/**
 * 033 — Jira-style issue picker combobox backed by /rest/api/2/issue/picker.
 * Types ahead against key or summary; selecting fills the chosen key.
 * Shared by link/move/parent dialogs.
 */
export default function IssuePicker({
  value,
  onChange,
  onSelect,
  placeholder = 'Issue key or summary…',
  excludeKey,
  autoFocus,
  className = 'w-40 rounded border border-atl-n-40 px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-atl-b-200',
}: {
  /** Current text (usually the chosen key once selected). */
  value: string;
  onChange: (v: string) => void;
  /** Fired when a result row is picked (defaults to setting value to the key). */
  onSelect?: (issue: PickedIssue) => void;
  placeholder?: string;
  /** Don't suggest this issue (linking to self is meaningless). */
  excludeKey?: string;
  autoFocus?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [hi, setHi] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  // Debounce the picker query off the input text (300ms, Jira-like).
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(value), 300);
    return () => window.clearTimeout(t);
  }, [value]);

  const { data } = useQuery({
    queryKey: ['issue-picker', query],
    queryFn: () => pickIssues(query, 8),
    enabled: open && query.trim().length > 0,
  });
  const results = (data?.sections?.[0]?.issues ?? []).filter((i) => i.key !== excludeKey);

  // Keep the keyboard highlight inside the result list.
  useEffect(() => setHi(0), [query]);

  const pick = (i: (typeof results)[number]) => {
    if (onSelect) onSelect(i); else onChange(i.key);
    setOpen(false);
  };

  // Close on outside click.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div ref={boxRef} className="relative">
      <input
        autoFocus={autoFocus}
        value={value}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation(); // don't let a parent Modal/Drawer close too
            setOpen(false);
          }
          if (!open || results.length === 0) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHi((h) => (h + 1) % results.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHi((h) => (h - 1 + results.length) % results.length);
          } else if (e.key === 'Enter' && !imeComposing(e)) {
            e.preventDefault();
            pick(results[Math.min(hi, results.length - 1)]);
          }
        }}
        placeholder={placeholder}
        className={className}
      />
      {open && results.length > 0 && (
        <ul className="absolute z-20 mt-1 w-72 max-h-64 overflow-auto rounded-[3px] border border-atl-n-30 bg-atl-paper shadow-lg">
          {results.map((i, idx) => (
            <li key={i.id}>
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(i);
                }}
                onMouseEnter={() => setHi(idx)}
                title={`${i.key}: ${i.summary}`}
                className={`w-full text-left px-3 py-1.5 flex items-baseline gap-2 ${idx === hi ? 'bg-atl-b-50' : 'hover:bg-atl-n-10'}`}
              >
                <IssueKey
                  issueKey={i.key}
                  categoryKey={i.statusCategory}
                  className="text-xs font-medium text-atl-n-100 shrink-0"
                />
                <span className="text-sm text-atl-n-700 truncate">{i.summary}</span>
                <span className="ml-auto text-[10px] text-atl-n-100 shrink-0">{i.issueType}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
