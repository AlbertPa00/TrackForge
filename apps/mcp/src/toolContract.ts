/**
 * Sprint 056 US6 — contract registry (phase 1: mutation surface).
 *
 * One declarative mapping of every mutating MCP tool → the REST routes it
 * writes to, plus the route's `dryRun` capability. `eval/run.ts` diffs this
 * against `tools.ts`: a tool that lands without an entry, a route call that
 * diverges, or a `dry_run` flag the route can't honor fails the eval.
 *
 * dryRun capability values:
 *  - 'query'  → route honors `?dryRun=true` (server-side preview)
 *  - 'body'   → route takes `dryRun` in the JSON body
 *  - 'client' → no server support; the tool itself previews (validate/GET only)
 *  - false    → no dryRun support — schema must NOT advertise dry_run
 *
 * `{key}`/`{id}`/… mark path params (template-literal segments in tools.ts).
 */

export interface RouteDecl {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Path with `{param}` placeholders, e.g. '/rest/api/2/issue/{key}/transitions'. */
  path: string;
}

export interface MutationToolDecl {
  routes: RouteDecl[];
  dryRun: 'query' | 'body' | 'client' | false;
}

const ISSUE = '/rest/api/2/issue/{key}';

/** Mutation surface — every wtool-registered tool must appear here. */
export const MUTATION_REGISTRY: Record<string, MutationToolDecl> = {
  // --- core issue writes ---
  create_issue: { routes: [{ method: 'POST', path: '/rest/api/2/issue' }], dryRun: 'query' },
  update_issue: { routes: [{ method: 'PUT', path: ISSUE }], dryRun: 'query' },
  assign_issue: { routes: [{ method: 'PUT', path: `${ISSUE}/assignee` }], dryRun: 'query' },
  transition_issue: { routes: [{ method: 'POST', path: `${ISSUE}/transitions` }], dryRun: 'query' },
  bulk_create_issues: { routes: [{ method: 'POST', path: '/rest/api/2/issue/bulk' }], dryRun: 'query' },
  add_comment: { routes: [{ method: 'POST', path: `${ISSUE}/comment` }], dryRun: 'query' },
  edit_comment: { routes: [{ method: 'PUT', path: `${ISSUE}/comment/{id}` }], dryRun: false },
  create_subtask: { routes: [{ method: 'POST', path: '/rest/api/2/issue' }], dryRun: 'query' },
  link_issues: { routes: [{ method: 'POST', path: '/rest/api/2/issueLink' }], dryRun: 'query' },
  delete_issue: { routes: [{ method: 'DELETE', path: ISSUE }], dryRun: 'query' },
  archive_issue: { routes: [{ method: 'PUT', path: `${ISSUE}/archive` }], dryRun: 'query' },
  restore_issue: { routes: [{ method: 'PUT', path: `${ISSUE}/restore` }], dryRun: 'query' },
  clone_issue: { routes: [{ method: 'POST', path: '/api/internal/issues/{key}/clone' }], dryRun: 'body' },
  move_issue: { routes: [{ method: 'POST', path: '/api/internal/issues/{key}/move' }], dryRun: 'body' },
  estimate_issue: { routes: [{ method: 'PUT', path: ISSUE }], dryRun: 'query' },
  set_estimate: { routes: [{ method: 'PUT', path: ISSUE }], dryRun: 'query' },
  delegate_issue: { routes: [{ method: 'PUT', path: ISSUE }], dryRun: 'query' },
  watch_issue: { routes: [{ method: 'POST', path: `${ISSUE}/watchers` }], dryRun: 'query' },
  unwatch_issue: { routes: [{ method: 'DELETE', path: `${ISSUE}/watchers` }], dryRun: false },
  vote_issue: { routes: [{ method: 'POST', path: `${ISSUE}/votes` }], dryRun: false },
  unvote_issue: { routes: [{ method: 'DELETE', path: `${ISSUE}/votes` }], dryRun: false },
  log_work: { routes: [{ method: 'POST', path: `${ISSUE}/worklog` }], dryRun: 'query' },
  attach_file: { routes: [{ method: 'POST', path: `${ISSUE}/attachments` }], dryRun: 'client' },
  delete_attachment: { routes: [{ method: 'DELETE', path: '/rest/api/2/attachment/{id}' }], dryRun: false },
  link_remote: { routes: [{ method: 'POST', path: `${ISSUE}/remotelink` }], dryRun: false },
  unlink_remote: { routes: [{ method: 'DELETE', path: `${ISSUE}/remotelink/{id}` }], dryRun: false },
  bulk_change: { routes: [{ method: 'POST', path: '/api/internal/bulk/{op}' }], dryRun: 'body' },

  // --- agile ---
  move_card: { routes: [{ method: 'POST', path: `${ISSUE}/transitions` }], dryRun: 'query' },
  rank_issue: { routes: [{ method: 'PUT', path: '/rest/agile/1.0/issue/rank' }], dryRun: 'query' },
  create_sprint: { routes: [{ method: 'POST', path: '/rest/agile/1.0/sprint' }], dryRun: false },
  start_sprint: { routes: [{ method: 'PUT', path: '/rest/agile/1.0/sprint/{id}' }], dryRun: false },
  complete_sprint: { routes: [{ method: 'PUT', path: '/rest/agile/1.0/sprint/{id}' }], dryRun: false },
  move_to_sprint: { routes: [{ method: 'POST', path: '/rest/agile/1.0/sprint/{id}/issue' }], dryRun: false },
  move_to_backlog: { routes: [{ method: 'POST', path: '/rest/agile/1.0/backlog/issue' }], dryRun: false },
  move_to_epic: { routes: [{ method: 'POST', path: '/rest/agile/1.0/epic/{key}/issue' }], dryRun: false },
  manage_board: {
    routes: [
      { method: 'POST', path: '/rest/agile/1.0/board' },
      { method: 'PUT', path: '/api/internal/boards/{id}' },
      { method: 'POST', path: '/api/internal/boards/{id}/default' },
      { method: 'DELETE', path: '/rest/agile/1.0/board/{id}' },
      { method: 'PUT', path: '/api/internal/boards/{id}/cardconfig' },
    ],
    dryRun: false,
  },
  manage_quick_filters: {
    routes: [
      { method: 'POST', path: '/api/internal/boards/{id}/quickfilters' },
      { method: 'PUT', path: '/api/internal/boards/{id}/quickfilters/{fid}' },
      { method: 'DELETE', path: '/api/internal/boards/{id}/quickfilters/{fid}' },
    ],
    dryRun: false,
  },
  suggest_sprint_scope: { routes: [{ method: 'POST', path: '/api/internal/ai/sprints/{key}/scope' }], dryRun: false },

  // --- project/version metadata ---
  update_project: {
    routes: [
      { method: 'PUT', path: '/rest/api/2/project/{key}' },
      { method: 'POST', path: '/rest/api/2/project/{key}/archive' },
      { method: 'POST', path: '/rest/api/2/project/{key}/restore' },
    ],
    dryRun: false,
  },
  release_version: { routes: [{ method: 'POST', path: '/rest/api/2/version/{id}/release' }], dryRun: 'client' },
  manage_components: {
    routes: [
      { method: 'POST', path: '/rest/api/2/component' },
      { method: 'PUT', path: '/rest/api/2/component/{id}' },
      { method: 'DELETE', path: '/rest/api/2/component/{id}' },
    ],
    dryRun: false,
  },
  manage_versions: {
    routes: [
      { method: 'POST', path: '/rest/api/2/version' },
      { method: 'PUT', path: '/rest/api/2/version/{id}' },
      { method: 'DELETE', path: '/rest/api/2/version/{id}' },
      { method: 'POST', path: '/rest/api/2/version/{id}/move' },
    ],
    dryRun: false,
  },
  manage_project_roles: {
    routes: [
      { method: 'POST', path: '/rest/api/2/project/{key}/role/{id}' },
      { method: 'PUT', path: '/rest/api/2/project/{key}/role/{id}' },
      { method: 'DELETE', path: '/rest/api/2/project/{key}/role/{id}' },
      { method: 'POST', path: '/rest/api/2/role' },
      { method: 'PUT', path: '/rest/api/2/role/{id}' },
      { method: 'DELETE', path: '/rest/api/2/role/{id}' },
    ],
    dryRun: false,
  },
  manage_groups: {
    routes: [
      { method: 'POST', path: '/rest/api/2/group' },
      { method: 'DELETE', path: '/rest/api/2/group' },
      { method: 'POST', path: '/rest/api/2/group/user' },
      { method: 'DELETE', path: '/rest/api/2/group/user' },
    ],
    dryRun: 'query',
  },
  manage_user: {
    routes: [
      { method: 'POST', path: '/api/internal/users' },
      { method: 'PATCH', path: '/api/internal/users/{id}' },
      { method: 'DELETE', path: '/api/internal/users/{id}' },
    ],
    dryRun: false,
  },
  manage_permission_scheme: {
    routes: [
      { method: 'POST', path: '/rest/api/2/permissionscheme' },
      { method: 'PUT', path: '/rest/api/2/permissionscheme/{id}' },
      { method: 'DELETE', path: '/rest/api/2/permissionscheme/{id}' },
      { method: 'POST', path: '/rest/api/2/permissionscheme/{id}/permission' },
      { method: 'DELETE', path: '/rest/api/2/permissionscheme/{id}/permission/{pid}' },
      { method: 'PUT', path: '/rest/api/2/project/{key}/permissionscheme' },
    ],
    dryRun: 'query',
  },
  manage_custom_field: {
    routes: [
      { method: 'POST', path: '/api/internal/customfields' },
      { method: 'PUT', path: '/api/internal/customfields/{id}' },
      { method: 'DELETE', path: '/api/internal/customfields/{id}' },
      { method: 'PUT', path: '/api/internal/customfields/{id}/contexts/{ctx}' },
    ],
    dryRun: 'query',
  },
  manage_notification_scheme: {
    routes: [
      { method: 'POST', path: '/api/internal/notificationschemes' },
      { method: 'PUT', path: '/api/internal/notificationschemes/{id}' },
      { method: 'DELETE', path: '/api/internal/notificationschemes/{id}' },
      { method: 'POST', path: '/api/internal/projects/{key}/notificationscheme' },
    ],
    dryRun: false,
  },
  manage_screens: {
    routes: [
      { method: 'POST', path: '/api/internal/screens' },
      { method: 'PUT', path: '/api/internal/screens/{id}' },
      { method: 'DELETE', path: '/api/internal/screens/{id}' },
      { method: 'POST', path: '/api/internal/screens/{id}/tabs' },
      { method: 'PUT', path: '/api/internal/screens/{id}/tabs' },
      { method: 'POST', path: '/api/internal/screens/{id}/tabs/{tab}/fields' },
      { method: 'DELETE', path: '/api/internal/screens/{id}/tabs/{tab}/fields/{fid}' },
      { method: 'POST', path: '/api/internal/screenschemes' },
      { method: 'PUT', path: '/api/internal/screenschemes/{id}' },
      { method: 'DELETE', path: '/api/internal/screenschemes/{id}' },
      { method: 'POST', path: '/api/internal/issuetypescreenschemes' },
      { method: 'PUT', path: '/api/internal/issuetypescreenschemes/{id}' },
      { method: 'DELETE', path: '/api/internal/issuetypescreenschemes/{id}' },
      { method: 'POST', path: '/api/internal/projects/{key}/issuetypescreenscheme' },
    ],
    dryRun: false,
  },
  manage_field_configuration: {
    routes: [
      { method: 'POST', path: '/api/internal/fieldconfigurations' },
      { method: 'PUT', path: '/api/internal/fieldconfigurations/{id}' },
      { method: 'DELETE', path: '/api/internal/fieldconfigurations/{id}' },
      { method: 'POST', path: '/api/internal/fieldconfigurationschemes' },
      { method: 'PUT', path: '/api/internal/fieldconfigurationschemes/{id}' },
      { method: 'DELETE', path: '/api/internal/fieldconfigurationschemes/{id}' },
      { method: 'POST', path: '/api/internal/projects/{key}/fieldconfigurationscheme' },
    ],
    dryRun: false,
  },

  // --- filters & dashboards ---
  save_filter: {
    routes: [
      { method: 'POST', path: '/rest/api/2/filter' },
      { method: 'PUT', path: '/rest/api/2/filter/{id}' },
      { method: 'DELETE', path: '/rest/api/2/filter/{id}' },
    ],
    dryRun: false,
  },
  share_filter: {
    routes: [
      { method: 'POST', path: '/rest/api/2/filter/{id}/permission' },
      { method: 'DELETE', path: '/rest/api/2/filter/{id}/permission/{pid}' },
    ],
    dryRun: false,
  },
  subscribe_filter: {
    routes: [
      { method: 'POST', path: '/api/internal/filters/{id}/subscriptions' },
      { method: 'DELETE', path: '/api/internal/filters/{id}/subscriptions/{sub}' },
    ],
    dryRun: false,
  },
  update_dashboard: {
    routes: [
      { method: 'PUT', path: '/rest/api/2/dashboard/{id}' },
      { method: 'DELETE', path: '/rest/api/2/dashboard/{id}' },
    ],
    dryRun: false,
  },
  share_dashboard: { routes: [{ method: 'PUT', path: '/rest/api/2/dashboard/{id}' }], dryRun: false },
  create_gadget: {
    routes: [
      { method: 'POST', path: '/rest/api/2/dashboard/{id}/gadget' },
      { method: 'DELETE', path: '/rest/api/2/dashboard/{id}/gadget/{gid}' },
    ],
    dryRun: false,
  },
  update_preferences: {
    routes: [
      { method: 'PUT', path: '/api/internal/me' },
      { method: 'PUT', path: '/api/internal/me/preferences' },
    ],
    dryRun: false,
  },
  set_issue_security: {
    routes: [
      { method: 'PUT', path: '/rest/api/2/issue/{key}' },
      { method: 'POST', path: '/api/internal/projects/{key}/issuesecurityscheme' },
    ],
    dryRun: 'query',
  },

  // --- automation & agent ---
  create_rule: {
    routes: [
      { method: 'POST', path: '/api/internal/automation/rules' },
      { method: 'POST', path: '/api/internal/automation/validate' },
    ],
    dryRun: 'client',
  },
  run_rule: {
    routes: [
      { method: 'POST', path: '/api/internal/automation/rules/{id}/run' },
      { method: 'POST', path: '/api/internal/automation/rules/{id}/dry-run' },
    ],
    dryRun: 'client',
  },
  toggle_rule: { routes: [{ method: 'POST', path: '/api/internal/automation/rules/{id}/toggle' }], dryRun: false },
  emit_activity: { routes: [{ method: 'POST', path: '/api/internal/agent-sessions/{id}/activities' }], dryRun: false },
  ask_user: { routes: [{ method: 'POST', path: '/api/internal/agent-questions' }], dryRun: false },
  claim_issue: { routes: [{ method: 'POST', path: '/api/internal/agent/claim' }], dryRun: false },
  summarize_issue: { routes: [{ method: 'POST', path: '/api/internal/ai/issues/{key}/summary' }], dryRun: false },
  suggest_resolution: { routes: [{ method: 'POST', path: '/api/internal/ai/issues/{key}/suggest-resolution' }], dryRun: false },
  jql_from_text: { routes: [{ method: 'POST', path: '/api/internal/ai/jql' }], dryRun: false },

  // --- integrations & ops ---
  gitlab_create_branch: { routes: [{ method: 'POST', path: '/api/internal/issues/{key}/gitlab/branch' }], dryRun: 'body' },
  gitlab_create_mr: { routes: [{ method: 'POST', path: '/api/internal/issues/{key}/gitlab/merge-request' }], dryRun: 'body' },
  register_webhook: {
    routes: [
      { method: 'POST', path: '/rest/webhooks/1.0/webhook' },
      { method: 'DELETE', path: '/rest/webhooks/1.0/webhook/{id}' },
    ],
    dryRun: false,
  },
  send_test_mail: { routes: [{ method: 'POST', path: '/api/internal/admin/mail/test' }], dryRun: false },
  reprocess_delivery: {
    routes: [{ method: 'POST', path: '/api/internal/dev/repositories/{id}/deliveries/{did}/reprocess' }],
    dryRun: false,
  },
  set_schedule: { routes: [{ method: 'PUT', path: '/rest/api/2/issue/{key}' }], dryRun: 'query' },
  retry_job: { routes: [{ method: 'POST', path: '/api/internal/admin/jobs/{id}/retry' }], dryRun: false },
  revoke_token: { routes: [{ method: 'DELETE', path: '/api/internal/tokens/{id}' }], dryRun: false },
  revoke_grant: { routes: [{ method: 'DELETE', path: '/api/internal/me/grants/{id}' }], dryRun: false },

  // --- migration ---
  start_jira_import: { routes: [{ method: 'POST', path: '/api/internal/migration/jira-cloud' }], dryRun: 'body' },
  start_jira_server_import: { routes: [{ method: 'POST', path: '/api/internal/migration/jira-server' }], dryRun: 'body' },
  resume_import: { routes: [{ method: 'POST', path: '/api/internal/migration/{id}/resume' }], dryRun: false },
};
