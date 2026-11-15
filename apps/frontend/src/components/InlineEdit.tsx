import { useState, useRef, useEffect, useCallback, type ReactNode, type KeyboardEvent } from 'react';
import { imeComposing } from '../lib/ime.js';

interface InlineEditProps {
  /** Current committed value shown in display mode. */
  value: string;
  /** Render the value in read mode. */
  display: (value: string) => ReactNode;
  /** Called with the new text; throw/reject to keep editing and show the error. */
  onSave: (value: string) => Promise<void>;
  /** 'input' | 'textarea' | 'select' | 'date'; select needs `options`.
      'date' shows the formatted value at rest and a native picker while editing. */
  mode?: 'input' | 'textarea' | 'select' | 'date';
  /** `icon` renders before the label in the dropdown row + the focused-value
      bar (issue-type/priority glyphs). */
  options?: { value: string; label: string; icon?: ReactNode }[];
  placeholder?: string;
  /** Allow empty value (e.g. description can be cleared). */
  allowEmpty?: boolean;
  className?: string;
  /** Accessible label for the display button. */
  ariaLabel?: string;
  /** Hover text on the display button — defaults to ariaLabel. */
  title?: string;
  /** External control: force edit mode on mount when `startEditing`. */
  startEditing?: boolean;
  onEditingChange?: (editing: boolean) => void;
  /** Read-only render — no click affordance (permission-gated fields). */
  disabled?: boolean;
}

/**
 * Jira-style click-to-edit: click the value → editor; Enter/blur saves,
 * Esc cancels. Used for summary, description, labels, due date, selects.
 */
export default function InlineEdit({
  value,
  display,
  onSave,
  mode = 'input',
  options,
  placeholder,
  allowEmpty = true,
  className = '',
  ariaLabel,
  title,
  startEditing = false,
  onEditingChange,
  disabled = false,
}: InlineEditProps) {
  const [editing, setEditing] = useState(startEditing);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      if (inputRef.current instanceof HTMLInputElement || inputRef.current instanceof HTMLTextAreaElement) {
        inputRef.current.select();
      }
    }
  }, [editing]);

  const setMode = useCallback((next: boolean) => {
    setEditing(next);
    onEditingChange?.(next);
    if (next) {
      setDraft(value);
      setError(null);
    }
  }, [onEditingChange, value]);

  // `startEditing` is a one-shot trigger: enter edit mode when it goes true.
  useEffect(() => {
    if (startEditing) setMode(true);
  }, [startEditing, setMode]);

  const save = async (nextValue: string) => {
    if (saving) return;
    const trimmed = nextValue.trim();
    if (!allowEmpty && !trimmed) {
      setError('This field is required');
      return;
    }
    if (trimmed === value) {
      setMode(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(trimmed);
      setEditing(false);
      onEditingChange?.(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      setMode(false);
    } else if (e.key === 'Enter' && !imeComposing(e) && mode !== 'textarea') {
      e.preventDefault();
      void save(draft);
    }
  };

  if (!editing) {
    if (disabled) {
      return <div className={`w-full text-left rounded px-1 -mx-1 ${className}`}>{display(value)}</div>;
    }
    return (
      <button
        type="button"
        onClick={() => setMode(true)}
        aria-label={ariaLabel ?? 'Edit'}
        title={title ?? ariaLabel ?? 'Click to edit'}
        className={`w-full text-left rounded hover:bg-atl-n-20 transition-colors ${className}`}
      >
        {display(value)}
      </button>
    );
  }

  return (
    <div className={className}>
      {mode === 'select' ? (
        // Custom listbox — native <select> can't render per-option icons, and
        // the panel sits near the viewport bottom so we open downward into a
        // bounded scroll region instead of relying on OS popup placement.
        <SelectDropdown
          options={options ?? []}
          draft={draft}
          saving={saving}
          onPick={(v) => void save(v)}
          onCancel={() => setMode(false)}
          onKeyDown={onKeyDown}
        />
      ) : mode === 'date' ? (
        <input
          ref={(el) => { inputRef.current = el; }}
          type="date"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save(draft)}
          onKeyDown={onKeyDown}
          disabled={saving}
          className="w-full rounded border border-atl-b-300 bg-atl-paper px-2 py-1 text-sm text-atl-n-700 focus:outline-none focus:ring-2 focus:ring-atl-b-200"
        />
      ) : mode === 'textarea' ? (
        <textarea
          ref={(el) => { inputRef.current = el; }}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save(draft)}
          onKeyDown={onKeyDown}
          disabled={saving}
          rows={Math.max(3, draft.split('\n').length)}
          placeholder={placeholder}
          className="w-full rounded border border-atl-b-300 bg-atl-paper px-2 py-1 text-sm text-atl-n-700 focus:outline-none focus:ring-2 focus:ring-atl-b-200"
        />
      ) : (
        <input
          ref={(el) => { inputRef.current = el; }}
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => void save(draft)}
          onKeyDown={onKeyDown}
          disabled={saving}
          placeholder={placeholder}
          className="w-full rounded border border-atl-b-300 bg-atl-paper px-2 py-1 text-sm text-atl-n-700 focus:outline-none focus:ring-2 focus:ring-atl-b-200"
        />
      )}
      {error && <p className="mt-1 text-xs text-atl-r-400">{error}</p>}
    </div>
  );
}

/** Focused-value bar + always-open option list. onMouseDown on rows fires
    before the container's blur, so a click saves instead of cancelling; Esc
    and click-outside cancel like the other modes. */
function SelectDropdown({
  options,
  draft,
  saving,
  onPick,
  onCancel,
  onKeyDown,
}: {
  options: { value: string; label: string; icon?: ReactNode }[];
  draft: string;
  saving: boolean;
  onPick: (value: string) => void;
  onCancel: () => void;
  onKeyDown: (e: KeyboardEvent) => void;
}) {
  const [active, setActive] = useState(() =>
    Math.max(0, options.findIndex((o) => o.value === draft))
  );
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rootRef.current?.focus();
  }, []);
  const activeOption = options[Math.min(active, options.length - 1)];
  return (
    // relative anchor: the option list overlays below instead of reflowing
    // the details grid around it (field structure stays put while editing).
    <div
      className="relative rounded border border-atl-b-300 bg-atl-paper focus:outline-none focus:ring-2 focus:ring-atl-b-200"
      tabIndex={-1}
      ref={rootRef}
      onBlur={(e) => {
        if (!saving && !e.currentTarget.contains(e.relatedTarget)) onCancel();
      }}
      onKeyDown={(e) => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          setActive((a) =>
            (a + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % Math.max(options.length, 1)
          );
          return;
        }
        if (e.key === 'Enter' && !imeComposing(e)) {
          e.preventDefault();
          if (activeOption) onPick(activeOption.value);
          return;
        }
        onKeyDown(e); // Escape cancels via the parent handler
      }}
      role="listbox"
      aria-activedescendant={activeOption ? `tf-ie-opt-${active}` : undefined}
    >
      <div className="flex items-center gap-1.5 px-2 py-1 text-sm text-atl-n-700">
        {activeOption?.icon}
        {activeOption?.label ?? draft}
      </div>
      <ul className="absolute left-0 right-0 top-full z-50 mt-0.5 max-h-56 overflow-auto rounded border border-atl-n-40 bg-atl-paper py-1 shadow-lg">
        {options.map((o, i) => (
          <li
            key={o.value}
            id={`tf-ie-opt-${i}`}
            role="option"
            aria-selected={i === active}
            ref={i === active ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
            onMouseEnter={() => setActive(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(o.value);
            }}
            className={`flex cursor-pointer items-center gap-1.5 px-2 py-1.5 text-sm hover:bg-atl-n-20 ${
              i === active ? 'bg-atl-b-50 text-atl-b-500' : 'text-atl-n-800'
            }`}
          >
            {o.icon}
            {o.label}
          </li>
        ))}
      </ul>
    </div>
  );
}
