import { useQuery } from '@tanstack/react-query';
import { fetchMyPermissions, fetchMyself } from '../api/client.js';

/**
 * Permission-gate helper backed by GET /rest/api/2/mypermissions.
 * `can(name)` is optimistic — true until the response lands (the server still
 * enforces; hiding-then-showing would flicker for the common case where the
 * user can edit). `canAdmin` is strict — admin affordances appear only once
 * confirmed (isAdmin || ADMINISTER_PROJECTS on the scope).
 */
export function usePermissions(
  scope: { issueKey?: string; projectKey?: string },
  permissions: string[],
) {
  const { data: me } = useQuery({ queryKey: ['myself'], queryFn: fetchMyself, staleTime: Infinity });
  const scoped = Boolean(scope.issueKey ?? scope.projectKey);
  const { data } = useQuery({
    queryKey: ['mypermissions', scope.issueKey ?? scope.projectKey, ...permissions],
    queryFn: () =>
      fetchMyPermissions({ issueKey: scope.issueKey, projectKey: scope.projectKey, permissions }),
    enabled: scoped,
    staleTime: 60_000,
  });
  const can = (perm: string) => !scoped || data == null || Boolean(data.permissions[perm]?.havePermission);
  const canAdmin =
    Boolean(me?.isAdmin) || data?.permissions.ADMINISTER_PROJECTS?.havePermission === true;
  return { can, canAdmin, me };
}

/** Shared issue permission set — every caller on an issue page uses the same
 *  query key, so all gating costs a single /mypermissions request. */
const ISSUE_PERMS = [
  'EDIT_ISSUES', 'TRANSITION_ISSUES', 'RESOLVE_ISSUES', 'CLOSE_ISSUES',
  'ASSIGN_ISSUES', 'DELETE_ISSUES', 'LINK_ISSUES', 'ADD_COMMENTS',
  'WORK_ON_ISSUES', 'MOVE_ISSUES', 'CREATE_ISSUES', 'CREATE_ATTACHMENTS',
  'DELETE_ALL_ATTACHMENTS', 'DELETE_OWN_ATTACHMENTS', 'SCHEDULE_ISSUES',
  'MANAGE_SPRINTS', 'MODIFY_REPORTER', 'SET_ISSUE_SECURITY',
  'VIEW_VOTERS_AND_WATCHERS', 'VIEW_DEV_TOOLS', 'MANAGE_WATCHERS',
  'ADMINISTER_PROJECTS',
];

export function useIssuePermissions(issueKey: string | undefined) {
  return usePermissions({ issueKey }, ISSUE_PERMS);
}
