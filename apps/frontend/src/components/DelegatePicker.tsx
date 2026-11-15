import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { delegateIssue, searchDelegateAgents, type UserRef } from '../api/client.js';
import UserAvatar from './UserAvatar.js';
import { useIssueWrite } from '../lib/useIssueWrite.js';

// 047 — delegate, not assign: the agent works the issue while the human
// assignee stays accountable. Lists only isAssignableAgent accounts.
export default function DelegatePicker({
  issueKey,
  delegate,
  disabled = false,
}: {
  issueKey: string;
  delegate: UserRef | null | undefined;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const markWrite = useIssueWrite(issueKey);

  const { data: agents } = useQuery({
    queryKey: ['delegate-agents', query],
    queryFn: () => searchDelegateAgents(query),
    enabled: open,
  });

  const mutation = useMutation({
    mutationFn: (agent: { name?: string; accountId?: string } | null) => delegateIssue(issueKey, agent),
    onSuccess: () => {
      markWrite([['issues'], ['agent-sessions', issueKey]]);
      setOpen(false);
      setQuery('');
    },
  });

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  if (disabled) {
    return (
      <div
        className="flex items-center gap-2 rounded px-1 -mx-1 py-0.5"
        title={`${delegate?.displayName ?? 'No agent'} — read-only`}
      >
        <UserAvatar displayName={delegate?.displayName} size={20} />
        <span className="truncate text-sm text-atl-n-700">{delegate?.displayName ?? 'No agent'}</span>
      </div>
    );
  }

  return (
    <div className="relative group w-full" ref={ref}>
      <button
        data-tf-delegate
        onClick={() => setOpen((o) => !o)}
        title={`Delegate: ${delegate?.displayName ?? 'No agent'} — click to change`}
        className="w-full flex items-center gap-2 rounded px-1 -mx-1 py-0.5 hover:bg-atl-n-10 text-left"
      >
        <UserAvatar displayName={delegate?.displayName} size={20} />
        <span className="truncate text-sm text-atl-n-700">{delegate?.displayName ?? 'No agent'}</span>
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

      {open && (
        <div className="absolute left-0 top-7 w-72 rounded bg-atl-paper shadow-lg border border-atl-n-30 z-50">
          <div className="p-2 border-b border-atl-n-30">
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search agents"
              className="w-full h-8 px-2 rounded border border-atl-n-40 text-sm outline-none focus:border-atl-b-300"
            />
          </div>
          <div className="max-h-64 overflow-y-auto py-1">
            {delegate && (
              <button
                onClick={() => mutation.mutate(null)}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-atl-n-10 text-left"
              >
                <UserAvatar displayName={null} size={24} />
                <span className="block text-sm text-atl-n-800">Clear delegate</span>
              </button>
            )}
            {(agents ?? []).map((u) => (
              <button
                key={u.accountId}
                onClick={() => mutation.mutate({ accountId: u.accountId })}
                title={`${u.displayName} (agent)`}
                className="w-full flex items-center gap-2.5 px-3 py-1.5 hover:bg-atl-n-10 text-left"
              >
                <UserAvatar displayName={u.displayName} size={24} />
                <span className="min-w-0">
                  <span className="block text-sm text-atl-n-800 truncate">{u.displayName}</span>
                  <span className="block text-xs text-atl-n-200 truncate">Agent</span>
                </span>
              </button>
            ))}
            {(agents ?? []).length === 0 && (
              <div className="px-3 py-2 text-xs text-atl-n-200">
                No assignable agents — flag an agent account in admin → users.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
