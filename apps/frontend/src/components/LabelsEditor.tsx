import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchLabels } from '../api/client.js';
import { imeComposing } from '../lib/ime.js';

interface LabelsEditorProps {
  labels: string[];
  onSave: (labels: string[]) => Promise<void>;
  /** Read-only chips (user lacks EDIT_ISSUES). */
  disabled?: boolean;
}

/** Jira-style label chips; click to edit, suggestions from /label, no spaces. */
export default function LabelsEditor({ labels, onSave, disabled = false }: LabelsEditorProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const { data: allLabels } = useQuery({ queryKey: ['labels'], queryFn: fetchLabels });

  const suggestions = useMemo(() => {
    const q = draft.trim().toLowerCase();
    if (!q) return [];
    return (allLabels ?? [])
      .filter((l) => l.toLowerCase().includes(q) && !labels.includes(l))
      .slice(0, 6);
  }, [draft, allLabels, labels]);

  const save = async (next: string[]) => {
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      setEditing(false);
      setDraft('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const commit = () => {
    const parts = draft
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (parts.some((p) => /\s/.test(p))) {
      setError('Labels cannot contain spaces');
      return;
    }
    void save([...new Set([...labels, ...parts])]);
  };

  const remove = (l: string) => void save(labels.filter((x) => x !== l));

  if (!editing) {
    if (disabled) {
      return (
        <div className="flex flex-wrap items-center gap-1 rounded px-1 py-0.5 min-h-[24px]">
          {labels.length === 0 ? (
            <span className="text-sm text-atl-n-100">None</span>
          ) : (
            labels.map((l) => (
              <span key={l} className="rounded-full bg-atl-n-20 px-2 py-0.5 text-xs text-atl-n-500">
                {l}
              </span>
            ))
          )}
        </div>
      );
    }
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="flex flex-wrap items-center gap-1 rounded px-1 py-0.5 text-left hover:bg-atl-n-20 min-h-[24px] w-full"
        aria-label="Edit labels"
      >
        {labels.length === 0 ? (
          <span className="text-sm text-atl-n-100">None</span>
        ) : (
          labels.map((l) => (
            <span key={l} className="rounded-full bg-atl-n-20 px-2 py-0.5 text-xs text-atl-n-500">
              {l}
            </span>
          ))
        )}
      </button>
    );
  }

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-1 rounded border border-atl-b-300 px-1.5 py-1 focus-within:ring-2 focus-within:ring-atl-b-200">
        {labels.map((l) => (
          <span key={l} className="inline-flex items-center gap-1 rounded-full bg-atl-n-20 px-2 py-0.5 text-xs text-atl-n-500">
            {l}
            <button
              type="button"
              onClick={() => remove(l)}
              className="text-atl-n-200 hover:text-atl-n-500"
              aria-label={`Remove ${l}`}
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
            if (e.key === 'Enter' && !imeComposing(e)) { e.preventDefault(); commit(); }
            if (e.key === 'Escape') { setEditing(false); setDraft(''); setError(null); }
          }}
          onBlur={commit}
          disabled={saving}
          placeholder={labels.length ? '' : 'Add labels…'}
          className="min-w-[80px] flex-1 border-0 p-0.5 text-sm text-atl-n-700 focus:outline-none"
        />
      </div>
      {suggestions.length > 0 && (
        <ul className="absolute left-0 top-full z-10 mt-1 w-full rounded border border-atl-n-30 bg-atl-paper shadow-lg">
          {suggestions.map((s) => (
            <li key={s}>
              <button
                type="button"
                onMouseDown={(e) => { e.preventDefault(); void save([...labels, s]); }}
                className="w-full px-3 py-1.5 text-left text-sm hover:bg-atl-n-10"
              >
                {s}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <p className="mt-1 text-xs text-atl-r-400">{error}</p>}
    </div>
  );
}
