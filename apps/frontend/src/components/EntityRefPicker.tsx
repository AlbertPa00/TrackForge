import { useMemo, useState } from 'react';
import { CheckIcon } from './icons.js';

export interface EntityRef {
  id: string;
  name: string;
}

interface EntityRefPickerProps {
  /** Current refs on the issue. */
  values: EntityRef[];
  /** All selectable refs for the project (archived options should be filtered out by the caller). */
  options: EntityRef[];
  onSave: (refs: EntityRef[]) => Promise<void>;
  placeholder?: string;
  label?: string;
  /** Read-only chips (user lacks EDIT_ISSUES). */
  disabled?: boolean;
}

/** Jira-style multi-value ref chips; click to open a dropdown, toggle to add/remove, saves the full set. */
export default function EntityRefPicker({ values, options, onSave, placeholder = 'None', label, disabled = false }: EntityRefPickerProps) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const current = useMemo(() => new Set(values.map((v) => v.id)), [values]);
  const suggestions = useMemo(() => {
    const q = draft.trim().toLowerCase();
    return options
      .filter((o) => !q || o.name.toLowerCase().includes(q))
      .slice(0, 8);
  }, [draft, options]);

  const toggle = async (ref: EntityRef) => {
    setSaving(true);
    setError(null);
    try {
      const next = current.has(ref.id)
        ? values.filter((v) => v.id !== ref.id)
        : [...values, ref];
      await onSave(next);
      setDraft('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    if (disabled) {
      return (
        <div className="flex flex-wrap items-center gap-1 rounded px-1 py-0.5 min-h-[24px]">
          {values.length === 0 ? (
            <span className="text-sm text-atl-n-100">{placeholder}</span>
          ) : (
            values.map((v) => (
              <span key={v.id} className="rounded-full bg-atl-n-20 px-2 py-0.5 text-xs text-atl-n-500">
                {v.name}
              </span>
            ))
          )}
        </div>
      );
    }
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex flex-wrap items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-atl-n-20 min-h-[24px] w-full"
        aria-label={label ?? 'Edit'}
      >
        {values.length === 0 ? (
          <span className="text-sm text-atl-n-100">{placeholder}</span>
        ) : (
          values.map((v) => (
            <span key={v.id} className="rounded-full bg-atl-n-20 px-2 py-0.5 text-xs text-atl-n-500">
              {v.name}
            </span>
          ))
        )}
      </button>
    );
  }

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-1 rounded border border-atl-b-300 px-1.5 py-1 focus-within:ring-2 focus-within:ring-atl-b-200">
        {values.map((v) => (
          <span key={v.id} className="inline-flex items-center gap-1 rounded-full bg-atl-n-20 px-2 py-0.5 text-xs text-atl-n-500">
            {v.name}
            <button
              type="button"
              onClick={() => void toggle(v)}
              className="text-atl-n-200 hover:text-atl-n-500"
              aria-label={`Remove ${v.name}`}
            >
              ×
            </button>
          </span>
        ))}
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation(); // don't let a parent Modal/Drawer close too
              setOpen(false); setDraft(''); setError(null);
            }
          }}
          onBlur={() => { setOpen(false); setDraft(''); }}
          disabled={saving}
          placeholder={values.length ? '' : 'Search…'}
          className="min-w-[80px] flex-1 border-0 p-0.5 text-sm text-atl-n-700 focus:outline-none"
        />
      </div>
      {suggestions.length > 0 && (
        <ul className="absolute left-0 top-full z-10 mt-1 w-full max-h-56 overflow-y-auto rounded border border-atl-n-30 bg-atl-paper shadow-lg">
          {suggestions.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); void toggle(s); }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-atl-n-10"
              >
                <span className={`inline-block h-3.5 w-3.5 rounded-[3px] border ${current.has(s.id) ? 'bg-atl-b-300 border-atl-b-300' : 'border-atl-n-40'}`}>
                  {current.has(s.id) && <span className="flex items-center justify-center text-white"><CheckIcon size={9} /></span>}
                </span>
                {s.name}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-1 text-xs text-atl-r-400">{error}</p>}
    </div>
  );
}
