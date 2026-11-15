import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchUserProfile, type UserRef } from '../api/client.js';
import UserAvatar from './UserAvatar.js';
import HoverCard from './HoverCard.js';

/**
 * Jira-style person card on hover/focus of a user name/avatar. Supplemental
 * only — the full profile lives at /profile/{accountId}. Renders immediately
 * from the UserRef the caller already has; when `accountId` is present the
 * read-only profile is lazy-fetched on first open for email/timezone/groups
 * and open-issue counts, and cached by react-query.
 */
export default function UserHoverCard({
  user,
  displayName,
  children,
}: {
  /** Pass whatever ref the caller has — `{accountId}` at minimum for fetch. */
  user?: Partial<UserRef> | null;
  /** Fallback when `user` is absent or partial. */
  displayName?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const accountId = user?.accountId;

  const { data: profile } = useQuery({
    queryKey: ['user-profile', accountId],
    queryFn: () => fetchUserProfile(accountId!),
    enabled: open && !!accountId,
    staleTime: 60_000,
  });

  const u = profile?.user ?? user;
  const openCount = profile?.openIssuesByProject.reduce((n, g) => n + g.issues.length, 0);

  return (
    <HoverCard
      onOpenChange={setOpen}
      renderCard={() => (
        <div className="flex items-start gap-3">
          <UserAvatar displayName={u?.displayName ?? displayName} emoji={u?.avatarEmoji} size={40} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-semibold text-atl-n-800" title={u?.displayName ?? displayName}>
                {u?.displayName ?? displayName ?? 'Unknown user'}
              </span>
              {u?.agent && (
                <span className="shrink-0 rounded bg-atl-n-20 px-1.5 py-0.5 text-[10px] font-medium text-atl-n-300">
                  AGENT
                </span>
              )}
            </div>
            {u?.emailAddress && (
              <div className="truncate text-xs text-atl-n-300" title={u.emailAddress}>{u.emailAddress}</div>
            )}
            <div className="mt-1.5 text-xs text-atl-n-300">
              {profile ? (
                <>
                  {profile.user.timezone && <span title={profile.user.timezone}>{profile.user.timezone}</span>}
                  {openCount !== undefined && (
                    <span>
                      {profile.user.timezone ? ' · ' : ''}
                      {openCount} open issue{openCount === 1 ? '' : 's'}
                    </span>
                  )}
                  {profile.user.groups?.length ? <span> · {profile.user.groups.join(', ')}</span> : null}
                </>
              ) : accountId ? (
                'Loading profile…'
              ) : null}
            </div>
            {accountId && (
              <Link to={`/profile/${accountId}`} className="mt-1.5 inline-block text-xs text-atl-b-300 hover:underline">
                View profile →
              </Link>
            )}
          </div>
        </div>
      )}
    >
      {children}
    </HoverCard>
  );
}
