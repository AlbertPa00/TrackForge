import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery } from '@tanstack/react-query';
import { assignIssue, fetchMyself, searchAssignableUsers, type UserRef } from '../api/client.js';
import UserAvatar from './UserAvatar.js';
import { useIssueWrite } from '../lib/useIssueWrite.js';

export default function AssigneePicker({
  issueKey,
  projectKey,
  assignee,
  disabled = false,
}: {
  issueKey: string;
  projectKey: string;
  assignee: UserRef | null;
  /** Read-only display (user lacks ASSIGN_ISSUES). */
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const markWrite = useIssueWrite(issueKey);

  const { data: me } = useQuery({ queryKey: ['myself'], queryFn: fetchMyself, staleTime: Infinity });
  const { data: users } = useQuery({
    queryKey: ['assignable', projectKey, query],
    queryFn: () => searchAssignableUsers(projectKey, query),
    enabled: open,
  });

  const mutation = useMutation({
    mutationFn: (accountId: string | null) => assignIssue(issueKey, accountId),
    onSuccess: () => {
      markWrite([['issues']]);
      setOpen(false);
      setQuery('');
    },
  });

  useEffect(() => {
    if (!open) return;
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 4, left: r.left });
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    // Scroll closes the menu only when it moves the page/layout — scrolling
    // the picker's own result list must keep it open (Jira parity).
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

  const options = (users ?? []).filter((u) => u.accountId !== me?.accountId);

  if (disabled) {
    return (
      <div
        className="flex items-center gap-2 rounded px-1 -mx-1 py-0.5"
        title={`${assignee?.displayName ?? 'Unassigned'} — read-only`}
      >
        <UserAvatar displayName={assignee?.displayName} size={20} />
        <span className="truncate text-sm text-atl-n-700">{assignee?.displayName ?? 'Unassigned'}</span>
      </div>
    );
  }

  return (
    <div className="relative group w-full" ref={ref}>
      <button
        data-tf-assign
        onClick={() => setOpen((o) => !o)}
        title={`Assignee: ${assignee?.displayName ?? 'Unassigned'} — click to change (a)`}
        className="w-full flex items-center gap-2 rounded px-1 -mx-1 py-0.5 hover:bg-atl-n-10 text-left"
      >
        <UserAvatar displayName={assignee?.displayName} size={20} />
        <span className="truncate text-sm text-atl-n-700">{assignee?.displayName ?? 'Unassigned'}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 16 16"
          className="ml-auto shrink-0 text-atl-n-200 opacity-0 group-hover:opacity-100"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M11.3 1.3a1 1 0 0 1 1.4 0l2 2a1 1 0 0 1 0 1.4l-9.5 9.5a1 1 0 0 1-.4.25l-3.5 1a1 1 0 0 1-1.22-1.22l1-3.5a1 1 0 0 1 .25-.4zm1.4 1.4-1.06-1.07-8.19 8.2-.53 1.86 1.85-.53z" />
        </svg>
      </button>

      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="fixed w-72 rounded bg-atl-paper shadow-lg border border-atl-n-30 z-50"
            style={{ top: pos.top, left: pos.left }}
          >
            <div className="p-2 border-b border-atl-n-30">
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search people"
                className="w-full h-8 px-2 rounded border border-atl-n-40 text-sm outline-none focus:border-atl-b-300"
              />
            </div>
            <div className="max-h-64 overflow-y-auto py-1">
              {me && me.accountId !== assignee?.accountId && (
                <PickRow
                  label="Assign to me"
                  sub={me.emailAddress}
                  user={{ accountId: me.accountId, displayName: me.displayName }}
                  onClick={() => mutation.mutate(me.accountId)}
                />
              )}
              {assignee && <PickRow label="Unassigned" unassigned onClick={() => mutation.mutate(null)} />}
              {options.map((u) => (
                <PickRow
                  key={u.accountId}
                  user={u}
                  label={u.displayName}
                  sub={u.emailAddress}
                  onClick={() => mutation.mutate(u.accountId)}
                />
              ))}
              {options.length === 0 && !me && <div className="px-3 py-2 text-xs text-atl-n-200">No people found</div>}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

function PickRow({
  user,
  label,
  sub,
  unassigned,
  onClick,
}: {
  user?: UserRef;
  label: string;
  sub?: string;
  unassigned?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={sub ? `${label} (${sub})` : label}
      className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-atl-n-10 text-left"
    >
      <UserAvatar displayName={unassigned ? null : user?.displayName} size={24} />
      <span className="min-w-0">
        <span className="block text-sm text-atl-n-800 truncate">{label}</span>
        {sub && <span className="block text-xs text-atl-n-200 truncate">{sub}</span>}
      </span>
    </button>
  );
}
