import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { executeTransition, fetchTransitions, type Transition } from '../api/client.js';
import { useIssueWrite } from '../lib/useIssueWrite.js';
import StatusLozenge from './StatusLozenge.js';
import TransitionScreenModal from './TransitionScreenModal.js';

export default function StatusTransitionMenu({
  issueKey,
  projectKey,
  statusName,
  statusCategoryKey,
  disabled = false,
  prominent = false,
}: {
  issueKey: string;
  projectKey?: string;
  statusName: string;
  statusCategoryKey: string;
  /** Static status lozenge, no dropdown (user lacks TRANSITION_ISSUES). */
  disabled?: boolean;
  /** Issue-view size: bordered button lozenge (Jira parity) vs inline chip. */
  prominent?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [screenTransition, setScreenTransition] = useState<Transition | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const markWrite = useIssueWrite(issueKey);

  const { data: transitions } = useQuery({
    queryKey: ['transitions', issueKey],
    queryFn: () => fetchTransitions(issueKey),
    enabled: open,
  });

  const mutation = useMutation({
    mutationFn: ({
      transitionId,
      body,
    }: {
      transitionId: string;
      body?: { fields?: Record<string, unknown>; comment?: string };
    }) => executeTransition(issueKey, transitionId, body),
    onSuccess: () => {
      setOpen(false);
      setScreenTransition(null);
      markWrite([['issues'], ['transitions', issueKey]]);
    },
  });

  useEffect(() => {
    if (!open) return;
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, left: r.left });
    function onClick(e: MouseEvent) {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    }
    const onScroll = (e: Event) => {
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
        ref.current?.querySelector('button')?.focus();
      }
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [open]);

  // Transition failures surface as a flag under the button — Jira flags
  // dismiss on click and on their own after a few seconds.
  const { isError: transitionFailed, reset: resetTransition } = mutation;
  useEffect(() => {
    if (!transitionFailed) return;
    const t = window.setTimeout(() => resetTransition(), 6_000);
    return () => window.clearTimeout(t);
  }, [transitionFailed, resetTransition]);

  function pick(t: Transition) {
    if (t.hasScreen) {
      setOpen(false);
      setScreenTransition(t);
    } else {
      mutation.mutate({ transitionId: t.id });
    }
  }

  if (disabled) {
    return (
      <StatusLozenge
        name={statusName}
        categoryKey={statusCategoryKey}
        title={`Status: ${statusName} — read-only (no transition permission)`}
      />
    );
  }

  return (
    <div ref={ref} className="relative inline-block max-w-full">
      <button
        onClick={() => setOpen((o) => !o)}
        title={`Status: ${statusName} — click to change`}
        className={
          prominent
            ? 'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[3px] border border-atl-n-30 hover:bg-atl-n-20 transition-colors max-w-full'
            : 'inline-flex items-center gap-1 rounded hover:bg-black/10 transition-colors max-w-full'
        }
      >
        <StatusLozenge name={statusName} categoryKey={statusCategoryKey} title={null} />
        <svg width="10" height="10" viewBox="0 0 10 10" className="text-atl-n-100 shrink-0">
          <path d="M1.5 3.5 5 7l3.5-3.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </svg>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed z-50 w-52 rounded-md bg-atl-paper shadow-lg border border-atl-n-30 py-1"
            style={{ top: pos.top, left: pos.left }}
          >
            {(transitions ?? []).map((t) => (
              <button
                key={t.id}
                onClick={() => pick(t)}
                disabled={mutation.isPending}
                className="w-full text-left px-3 py-1.5 hover:bg-atl-n-20 disabled:opacity-60 flex items-center justify-between gap-2"
              >
                <span>
                  <span className="block text-sm text-atl-n-800">{t.name}</span>
                  <StatusLozenge name={t.to.name} categoryKey={t.to.statusCategory.key} />
                </span>
                {t.hasScreen && <span className="text-[10px] text-atl-n-100">form</span>}
              </button>
            ))}
            {transitions && transitions.length === 0 && (
              <div className="px-3 py-2 text-xs text-atl-n-100">No transitions available</div>
            )}
            {!transitions && <div className="px-3 py-2 text-xs text-atl-n-100">Loading…</div>}
          </div>,
          document.body
        )}

      {mutation.isError &&
        !screenTransition &&
        pos &&
        createPortal(
          <button
            type="button"
            role="alert"
            onClick={() => mutation.reset()}
            title="Dismiss"
            className="fixed z-50 w-56 rounded-md bg-atl-r-50 border border-atl-r-300 px-3 py-2 text-left text-xs text-atl-r-500"
            style={{ top: pos.top, left: pos.left }}
          >
            {(mutation.error as Error).message}
          </button>,
          document.body
        )}

      <TransitionScreenModal
        transition={screenTransition}
        issueKey={issueKey}
        projectKey={projectKey}
        onClose={() => setScreenTransition(null)}
        submitting={mutation.isPending}
        error={mutation.isError ? (mutation.error as Error).message : null}
        onSubmit={(body) => screenTransition && mutation.mutate({ transitionId: screenTransition.id, body })}
      />
    </div>
  );
}
