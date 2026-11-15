import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { fetchMyself, fetchUserProfile, type UserProfile } from '../api/client.js';
import UserAvatar from '../components/UserAvatar.js';
import IssueTypeIcon from '../components/IssueTypeIcon.js';
import PriorityIcon from '../components/PriorityIcon.js';
import StatusLozenge from '../components/StatusLozenge.js';
import EmptyState from '../components/EmptyState.js';
import { formatDateTime } from '../lib/format.js';

/** Jira ViewProfile parity: read-only profile for any user. Two-pane layout —
 * left nav (Summary + self/admin shortcuts), header with a Tools ⌄ menu, then
 * the Summary page: Details / Preferences / Assigned open issues / Activity.
 * Your own profile links back to /profile (the editable self-service page). */

function ToolsMenu({ isSelf, isAdmin }: { isSelf: boolean; isAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  if (!isSelf && !isAdmin) return null;
  const item = 'block px-4 py-1.5 text-sm text-atl-n-700 hover:bg-atl-n-10 whitespace-nowrap';
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1.5 rounded bg-atl-n-10 px-3 py-1.5 text-sm text-atl-n-700 hover:bg-atl-n-20"
      >
        Tools
        <svg width="10" height="10" viewBox="0 0 10 10" className="opacity-60" aria-hidden="true">
          <path d="M1.5 3.5 5 7l3.5-3.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 top-9 w-48 rounded bg-atl-paper shadow-lg border border-atl-n-30 py-1.5 z-50">
          {isSelf && (
            <Link to="/profile" className={item} onClick={() => setOpen(false)}>
              Edit profile
            </Link>
          )}
          {isAdmin && (
            <Link to="/admin/users" className={item} onClick={() => setOpen(false)}>
              Administer user
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function SideNav({ isSelf, isAdmin }: { isSelf: boolean; isAdmin: boolean }) {
  const item = (active: boolean) =>
    `block px-3 py-1.5 text-sm border-l-2 ${
      active
        ? 'border-atl-b-300 bg-atl-n-10 font-medium text-atl-n-800'
        : 'border-transparent text-atl-n-700 hover:bg-atl-n-10'
    }`;
  return (
    <nav aria-label="Profile" className="w-44 shrink-0">
      <ul className="space-y-0.5">
        <li>
          <span aria-current="page" className={item(true)}>
            Summary
          </span>
        </li>
        {isSelf && (
          <li>
            <Link to="/profile" className={item(false)}>
              Account settings
            </Link>
          </li>
        )}
        {isAdmin && !isSelf && (
          <li>
            <Link to="/admin/users" className={item(false)}>
              User administration
            </Link>
          </li>
        )}
      </ul>
    </nav>
  );
}

function PrefRow({ label, value }: { label: string; value?: string | null }) {
  return (
    <>
      <dt className="py-1 text-atl-n-200">{label}</dt>
      <dd className="py-1 text-atl-n-700">{value || '—'}</dd>
    </>
  );
}

function SummaryBody({ profile, isSelf }: { profile: UserProfile; isSelf: boolean }) {
  const { user: u, openIssuesByProject, recentComments } = profile;
  return (
    <>
      <h2 className="text-base font-semibold text-atl-n-800 mb-4">Summary</h2>

      {/* Jira "Details" module — groups visible to self/admin only. */}
      <section className="bg-atl-paper rounded shadow-sm p-4 mb-6">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-atl-n-300 mb-1.5">Details</h3>
        <dl className="grid grid-cols-[10rem_1fr] text-sm">
          <PrefRow label="Full name" value={u.displayName} />
          <PrefRow label="Email" value={u.emailAddress} />
          <PrefRow label="Status" value={u.active === false ? 'Inactive' : 'Active'} />
          {u.agent !== undefined && <PrefRow label="Account type" value={u.agent ? 'Agent' : 'Human'} />}
          {u.groups && <PrefRow label="Groups" value={u.groups.length ? u.groups.join(', ') : '—'} />}
        </dl>
      </section>

      <section className="bg-atl-paper rounded shadow-sm p-4 mb-6">
        <div className="flex items-start justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-atl-n-300 mb-1.5">Preferences</h3>
          {isSelf && (
            <Link to="/profile" aria-label="Edit preferences" className="text-atl-n-200 hover:text-atl-n-500">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M11.2 1.6a1.7 1.7 0 0 1 2.4 0l.8.8a1.7 1.7 0 0 1 0 2.4l-8.1 8.1-3.9 1.1 1.1-3.9 7.7-8.5zM2.6 13.4l.7-.2 8.1-8.1-.5-.5-8.1 8.1-.2.7z" />
              </svg>
            </Link>
          )}
        </div>
        <dl className="grid grid-cols-[10rem_1fr] text-sm">
          <PrefRow label="Language" value={u.locale} />
          <PrefRow label="Time zone" value={u.timezone} />
          <PrefRow label="Date format" value={u.dateFormat} />
        </dl>
      </section>

      <section className="bg-atl-paper rounded shadow-sm p-4 mb-6">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-atl-n-300 mb-2">
          Assigned open issues per project
        </h3>
        {openIssuesByProject.length === 0 && (
          <p className="text-sm text-atl-n-200">
            {isSelf ? 'You have no open issues assigned to you.' : `${u.displayName} has no open issues assigned.`}
          </p>
        )}
        {openIssuesByProject.map((g) => (
          <div key={g.project.key} className="mb-4 last:mb-0">
            <Link to={`/projects/${g.project.key}`} className="text-sm font-medium text-atl-b-300 hover:underline">
              {g.project.name} ({g.project.key})
            </Link>
            <ul className="mt-1 divide-y divide-atl-n-20 border-t border-atl-n-20">
              {g.issues.map((i) => (
                <li key={i.key} className="flex items-center gap-2 py-1.5 text-sm">
                  <span className="inline-flex" title={i.type}><IssueTypeIcon name={i.type} size={14} /></span>
                  <Link to={`/browse/${i.key}`} className="shrink-0 font-medium text-atl-b-300 hover:underline">
                    {i.key}
                  </Link>
                  <span className="min-w-0 flex-1 truncate text-atl-n-700" title={i.summary}>{i.summary}</span>
                  {i.priority && <span className="inline-flex" title={`Priority: ${i.priority}`}><PriorityIcon name={i.priority} size={14} /></span>}
                  <StatusLozenge name={i.status} categoryKey={i.statusCategory} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      {recentComments.length > 0 && (
        <section className="bg-atl-paper rounded shadow-sm p-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-atl-n-300 mb-2">Activity</h3>
          <ul className="space-y-3">
            {recentComments.map((c) => (
              <li key={c.id} className="flex gap-3">
                <UserAvatar displayName={u.displayName} emoji={u.avatarEmoji} size={24} />
                <div className="min-w-0 text-sm">
                  <div className="text-xs text-atl-n-300">
                    <span className="font-medium text-atl-n-700">{u.displayName}</span> commented on{' '}
                    <Link to={`/browse/${c.issueKey}`} className="font-medium text-atl-b-300 hover:underline">
                      {c.issueKey}
                    </Link>
                    <span className="ml-2">{formatDateTime(c.createdAt)}</span>
                  </div>
                  <p className="mt-0.5 text-atl-n-700 line-clamp-2" title={c.body}>{c.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

export default function UserProfilePage() {
  const { accountId = '' } = useParams();
  const me = useQuery({ queryKey: ['myself'], queryFn: fetchMyself, staleTime: Infinity });
  const profile = useQuery({
    queryKey: ['user-profile', accountId],
    queryFn: () => fetchUserProfile(accountId),
    enabled: !!accountId,
    retry: false,
  });

  if (profile.isLoading) return <div className="p-8 text-atl-n-200">Loading…</div>;
  if (profile.isError || !profile.data) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <EmptyState title="User not found" description="This account does not exist or was deactivated." />
      </div>
    );
  }

  const { user: u } = profile.data;
  const isSelf = me.data?.accountId === u.accountId;
  const isAdmin = me.data?.isAdmin === true;

  return (
    <div className="max-w-5xl mx-auto px-6 py-6 flex gap-8">
      <SideNav isSelf={isSelf} isAdmin={isAdmin} />
      <div className="min-w-0 flex-1">
        <header className="flex items-center gap-4 mb-6">
          <UserAvatar displayName={u.displayName} emoji={u.avatarEmoji} size={56} />
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold text-atl-n-800 truncate" title={u.displayName}>
              {u.displayName}
              {u.agent && (
                <span className="ml-2 align-middle rounded bg-atl-n-20 px-1.5 py-0.5 text-[10px] font-medium text-atl-n-300">
                  AGENT
                </span>
              )}
            </h1>
            <div className="text-sm text-atl-n-200 truncate" title={u.emailAddress}>{u.emailAddress}</div>
          </div>
          <ToolsMenu isSelf={isSelf} isAdmin={isAdmin} />
        </header>
        <SummaryBody profile={profile.data} isSelf={isSelf} />
      </div>
    </div>
  );
}
