import { useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { useQuery } from '@tanstack/react-query';
import {
  attachmentPath,
  searchAssignableUsers,
  uploadAttachments,
  type Attachment,
} from '../api/client.js';

marked.setOptions({ gfm: true, breaks: true });

/** Renders sanitised markdown (no raw HTML, no javascript: links). */
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(raw, {
      FORBID_TAGS: ['style', 'form', 'input', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['style', 'onerror', 'onclick'],
    });
  }, [text]);
  return (
    <div
      className={`tf-markdown text-sm text-atl-n-700 ${className}`}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

interface MarkdownEditorProps {
  value: string;
  onSave: (value: string) => Promise<void>;
  onCancel: () => void;
  placeholder?: string;
  /** Fires on every draft edit — lets a parent persist/track the draft. */
  onChange?: (value: string) => void;
  /** Button label (default "Save"). */
  saveLabel?: string;
  /** Ctrl/Cmd+Enter submits — Jira comment-composer parity. */
  submitOnModEnter?: boolean;
  /** Extra props spread onto the textarea (e.g. data-* hooks). */
  inputProps?: React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
    [key: `data-${string}`]: unknown;
  };
  /** 058 US6 — enables paste-image-to-attach + mention picker when present. */
  issueKey?: string;
  projectKey?: string;
}

const TOOL_BTN =
  'h-6 w-6 rounded text-xs text-atl-n-300 hover:bg-atl-n-30 hover:text-atl-n-700 font-medium';

/** Textarea + toolbar + preview toggle with explicit Save/Cancel (Jira description editor). */
export function MarkdownEditor({ value, onSave, onCancel, placeholder, onChange, saveLabel = 'Save', submitOnModEnter, inputProps, issueKey, projectKey }: MarkdownEditorProps) {
  const [draft, setDraft] = useState(value);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(0);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 058 US6 — mention picker reuses the same assignable-user search as the
  // comment composer; inserts `[~accountId:id]` markers.
  const { data: mentionUsers } = useQuery({
    queryKey: ['assignable', projectKey, mentionQuery],
    queryFn: () => searchAssignableUsers(projectKey!, mentionQuery),
    enabled: mentionOpen && Boolean(projectKey),
  });

  /** Insert `text`, or wrap the current selection with before/after markers. */
  const wrap = (before: string, after = '', fallback = '') => {
    const ta = taRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e } = ta;
    const sel = draft.slice(s, e) || fallback;
    const next = draft.slice(0, s) + before + sel + after + draft.slice(e);
    setDraft(next);
    onChange?.(next);
    requestAnimationFrame(() => {
      ta.focus();
      // Select the wrapped text so it's easy to replace (e.g. fallback text).
      const inner = s + before.length;
      ta.setSelectionRange(inner, inner + sel.length);
    });
  };

  const prefixLines = (prefix: string) => {
    const ta = taRef.current;
    if (!ta) return;
    const { selectionStart: s, selectionEnd: e } = ta;
    const start = draft.lastIndexOf('\n', s - 1) + 1;
    const block = draft.slice(start, e);
    const next = draft.slice(0, start) + block.replace(/^/gm, prefix) + draft.slice(e);
    setDraft(next);
    onChange?.(next);
    requestAnimationFrame(() => ta.focus());
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    if (!issueKey) return;
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    const ta = taRef.current;
    const at = ta?.selectionStart ?? draft.length;
    setUploading((n) => n + 1);
    try {
      const uploaded = await uploadAttachments(issueKey, files);
      const embeds = uploaded
        .map((a: Attachment) => `![${a.filename}](${attachmentPath(a.content)})`)
        .join('\n');
      setDraft((d) => {
        const next = d.slice(0, at) + embeds + d.slice(at);
        onChange?.(next);
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading((n) => n - 1);
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await onSave(draft);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
      setSaving(false);
    }
  };

  return (
    <div>
      <div className="mb-1 flex items-center gap-1 text-xs">
        <button
          type="button"
          onClick={() => setPreview(false)}
          className={`px-2 py-0.5 rounded ${!preview ? 'bg-atl-n-20 font-medium' : 'text-atl-n-200 hover:bg-atl-n-10'}`}
        >
          Write
        </button>
        <button
          type="button"
          onClick={() => setPreview(true)}
          className={`px-2 py-0.5 rounded ${preview ? 'bg-atl-n-20 font-medium' : 'text-atl-n-200 hover:bg-atl-n-10'}`}
        >
          Preview
        </button>
        {/* 058 US6 — markdown toolbar (disabled in preview) */}
        {!preview && (
          <span className="ml-2 inline-flex items-center gap-0.5 border-l border-atl-n-30 pl-2">
            <button type="button" title="Bold" aria-label="Bold" className={`${TOOL_BTN} font-bold`} onClick={() => wrap('**', '**', 'bold')}>B</button>
            <button type="button" title="Italic" aria-label="Italic" className={`${TOOL_BTN} italic`} onClick={() => wrap('*', '*', 'italic')}>I</button>
            <button type="button" title="Code" aria-label="Code" className={`${TOOL_BTN} font-mono`} onClick={() => wrap('`', '`', 'code')}>{'<>'}</button>
            <button type="button" title="Bulleted list" aria-label="Bulleted list" className={TOOL_BTN} onClick={() => prefixLines('- ')}>•</button>
            <button type="button" title="Link" aria-label="Link" className={`${TOOL_BTN} inline-flex items-center justify-center`} onClick={() => wrap('[', '](https://)', 'link text')}>
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
                <path d="M6.5 9.5a3 3 0 0 0 4.2.2l2-2a3 3 0 0 0-4.2-4.2l-1.1 1.1M9.5 6.5a3 3 0 0 0-4.2-.2l-2 2a3 3 0 0 0 4.2 4.2l1.1-1.1" />
              </svg>
            </button>
            {projectKey && (
              <span className="relative">
                <button
                  type="button"
                  title="Mention"
                  aria-label="Mention"
                  className={TOOL_BTN}
                  onClick={() => setMentionOpen((o) => !o)}
                >
                  @
                </button>
                {mentionOpen && (
                  <div className="absolute left-0 top-7 z-30 w-56 rounded-md border border-atl-n-30 bg-atl-paper shadow-lg">
                    <input
                      autoFocus
                      value={mentionQuery}
                      onChange={(e) => setMentionQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.stopPropagation(); // don't let a parent Modal/Drawer close too
                          setMentionOpen(false);
                        }
                      }}
                      placeholder="Search people…"
                      className="w-full border-b border-atl-n-30 px-2.5 py-1.5 text-xs outline-none"
                    />
                    <ul className="max-h-40 overflow-y-auto py-1">
                      {(mentionUsers ?? []).slice(0, 8).map((u) => (
                        <li key={u.accountId}>
                          <button
                            type="button"
                            className="w-full px-2.5 py-1 text-left text-xs text-atl-n-700 hover:bg-atl-n-10"
                            onClick={() => {
                              wrap(`[~accountId:${u.accountId}]`, '');
                              setMentionOpen(false);
                              setMentionQuery('');
                            }}
                          >
                            {u.displayName}
                          </button>
                        </li>
                      ))}
                      {mentionUsers && mentionUsers.length === 0 && (
                        <li className="px-2.5 py-1 text-xs text-atl-n-200">No matches</li>
                      )}
                    </ul>
                  </div>
                )}
              </span>
            )}
          </span>
        )}
        {uploading > 0 && <span className="ml-2 text-atl-n-200">Uploading image…</span>}
      </div>
      {preview ? (
        <div className="min-h-[72px] rounded border border-atl-n-30 bg-atl-n-10 px-3 py-2">
          {draft.trim() ? <Markdown text={draft} /> : <p className="text-sm text-atl-n-100 italic">Nothing to preview</p>}
        </div>
      ) : (
        <textarea
          ref={taRef}
          autoFocus
          {...inputProps}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            onChange?.(e.target.value);
          }}
          onKeyDown={(e) => {
            if (submitOnModEnter && (e.ctrlKey || e.metaKey) && e.key === 'Enter' && draft.trim()) {
              e.preventDefault();
              void save();
            }
            inputProps?.onKeyDown?.(e);
          }}
          onPaste={(e) => void onPaste(e)}
          rows={Math.max(4, draft.split('\n').length + 1)}
          placeholder={placeholder ?? 'Describe the work…'}
          className="w-full rounded border border-atl-n-40 px-3 py-2 text-sm text-atl-n-700 focus:outline-none focus:ring-2 focus:ring-atl-b-200 focus:border-atl-b-300"
        />
      )}
      {error && <p className="mt-1 text-xs text-atl-r-400">{error}</p>}
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          disabled={saving || !draft.trim()}
          onClick={() => void save()}
          className="rounded bg-atl-b-300 px-3 py-1 text-sm font-medium text-white hover:bg-atl-b-400 disabled:opacity-50"
        >
          {saving ? 'Saving…' : saveLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-3 py-1 text-sm text-atl-n-300 hover:bg-atl-n-20"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
