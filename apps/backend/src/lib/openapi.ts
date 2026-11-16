import { zodToJsonSchema } from 'zod-to-json-schema';
import { z, type ZodTypeAny } from 'zod/v3';
import {
  createIssueSchema,
  updateIssueSchema,
  createProjectSchema,
  transitionIssueSchema,
  bulkCreateSchema,
  assigneeBodySchema,
  searchRequestSchema,
  createSprintSchema,
  updateSprintSchema,
  issueKeysSchema,
  loginSchema,
  createTokenSchema,
  createUserSchema,
  commentSchema,
  issueLinkSchema,
  updateProjectSchema,
  jqlParseSchema,
  createFilterSchema,
  filterSchema,
  boardTypeSchema,
  worklogSchema,
  updateWorklogSchema,
  worklogListSchema,
  timeTrackingConfigSchema,
  moduleTogglesSchema,
  projectCategorySchema,
} from './validation.js';
import { publicBaseUrl } from '../config.js';

type JsonSchema = Record<string, unknown>;

function body(schema: ZodTypeAny, example?: unknown): JsonSchema {
  return {
    required: true,
    content: {
      'application/json': {
        schema: zodToJsonSchema(schema, { $refStrategy: 'none' }) as JsonSchema,
        ...(example !== undefined ? { example } : {}),
      },
    },
  };
}

function params(spec: Record<string, string | { description: string; schema?: JsonSchema }>): JsonSchema[] {
  return Object.entries(spec).map(([name, v]) => {
    const s = typeof v === 'string' ? { description: v } : v;
    return {
      name,
      in: 'path' as const,
      required: true,
      schema: { type: 'string' },
      description: s.description,
    };
  });
}

function queries(spec: Record<string, { description: string; type?: string; required?: boolean }>): JsonSchema[] {
  return Object.entries(spec).map(([name, v]) => ({
    name,
    in: 'query' as const,
    required: v.required ?? false,
    schema: { type: v.type ?? 'string' },
    description: v.description,
  }));
}

function ok(description: string, example?: unknown): JsonSchema {
  return {
    '200': {
      description,
      ...(example !== undefined ? { content: { 'application/json': { example } } } : {}),
    },
  };
}

interface Op {
  summary: string;
  description?: string;
  requestBody?: JsonSchema;
  parameters?: JsonSchema[];
  responses: JsonSchema;
  tags?: string[];
  extension?: boolean;
}

function op(o: Op): JsonSchema {
  const { summary, description, requestBody, parameters, responses, tags, extension } = o;
  const out: JsonSchema = {
    summary,
    ...(description ? { description } : {}),
    ...(tags ? { tags } : {}),
    ...(parameters?.length ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses,
  };
  if (extension) out['x-trackforge-extension'] = true;
  return out;
}

const JIRA_ERR = {
  '400': { description: 'Invalid request — Jira error shape `{errorMessages, errors}`' },
  '401': { description: 'Not authenticated' },
  '403': { description: 'Forbidden — missing scope or permission' },
  '404': { description: 'Not found (or hidden by token project allow-list)' },
};

const ISSUE_REF = { description: 'Jira issue object: `{id, key, self, fields{…}}`' };
const IDEM = {
  description:
    'Optional `Idempotency-Key` header replays the first response within 24h; ' +
    '`?dryRun=true` validates and returns `{issue, changes[]}` without persisting.',
};

/** Terse extension op for the catch-up table below. */
function x(summary: string, tag: string, pathParams?: Record<string, string>): JsonSchema {
  return op({
    summary: `${summary} (TF ext)`,
    tags: [tag],
    extension: true,
    ...(pathParams ? { parameters: params(pathParams) } : {}),
    responses: ok(summary),
  });
}

/**
 * Catch-up documentation: internal/extension routes added after the curated
 * `paths` literal was seeded. `/rest/api/2/*` entries here are mirrored to
 * `/rest/api/3` by injectV3 like everything else. Curated entries win on
 * collision — merge order in openApiDocument.
 */
const catchUp: Record<string, Record<string, JsonSchema>> = {
  // auth & identity (035/036)
  '/api/internal/auth/login/totp': { post: x('TOTP second-factor login {preAuthToken, code|backupCode}', 'auth') },
  '/api/internal/auth/reset-request': { post: x('Request a password-reset email {email}', 'auth') },
  '/api/internal/auth/reset-confirm': { post: x('Confirm password reset {token, newPassword}', 'auth') },
  '/api/internal/auth/idps': { get: x('Enabled identity providers for the login page', 'auth') },
  '/api/internal/auth/oidc/{idp}': { get: x('Start OIDC flow — redirects to the IdP', 'auth', { idp: 'IdP id' }) },
  '/api/internal/auth/oidc/{idp}/callback': {
    get: x('OIDC callback — sets tf_session cookie', 'auth', { idp: 'IdP id' }),
  },
  '/api/internal/admin/idps': {
    get: x('List identity providers (admin)', 'admin'),
    post: x('Create identity provider {name,issuer,clientId,clientSecret,…} (admin)', 'admin'),
  },
  '/api/internal/admin/idps/{id}': {
    put: x('Update identity provider (admin)', 'admin', { id: 'IdP id' }),
    delete: x('Delete identity provider (admin)', 'admin', { id: 'IdP id' }),
  },
  // development integrations (038)
  '/api/internal/dev/{repoSlug}/{secret}': {
    post: x('Inbound dev-tool webhook (push/PR/branch payload)', 'development', {
      repoSlug: 'Repo slug',
      secret: 'Webhook secret',
    }),
  },
  '/api/internal/dev/repositories': {
    get: x('List linked repositories (admin)', 'development'),
    post: x('Link a repository {name,slug} — returns webhook secret once (admin)', 'development'),
  },
  '/api/internal/dev/repositories/{id}': {
    put: x('Update repository (admin)', 'development', { id: 'Repository id' }),
    delete: x('Unlink repository (admin)', 'development', { id: 'Repository id' }),
  },
  '/api/internal/dev/repositories/{id}/deliveries': {
    get: x('Recent webhook deliveries (admin)', 'development', { id: 'Repository id' }),
  },
  '/api/internal/dev/repositories/{id}/deliveries/{deliveryId}/reprocess': {
    post: x('Re-run a stored delivery payload through ingest — re-links items (admin)', 'development', {
      id: 'Repository id',
      deliveryId: 'Delivery row id',
    }),
  },
  '/api/internal/dev/repositories/{id}/unlinked': {
    get: x('Issue keys seen but not linked (admin)', 'development', { id: 'Repository id' }),
  },
  '/api/internal/issues/{key}/development': {
    get: x('Development summary: commits, branches, PRs per issue', 'development', { key: 'Issue key' }),
  },
  // GitLab integration add-on (051)
  '/api/internal/dev/gitlab/connections': {
    get: x('List GitLab connections (admin)', 'development'),
    post: x(
      'Create GitLab connection {name,baseUrl,apiTokenRef(env:VAR),groupPath?,mode?,signingToken?,webhookSecret?,verifySsl?} (admin)',
      'development'
    ),
  },
  '/api/internal/dev/gitlab/connections/{id}': {
    put: x('Update GitLab connection (admin)', 'development', { id: 'Connection id' }),
    delete: x('Delete GitLab connection (admin)', 'development', { id: 'Connection id' }),
  },
  '/api/internal/dev/gitlab/connections/{id}/test': {
    post: x('Connection preflight: token scope + group reachability (admin)', 'development', { id: 'Connection id' }),
  },
  '/api/internal/dev/gitlab/connections/{id}/backfill': {
    post: x('Enqueue one-shot backfill of MRs/branches/pipelines/deployments (admin)', 'development', {
      id: 'Connection id',
    }),
  },
  '/api/internal/dev/gitlab/connections/{id}/sync': {
    post: x('Run incremental poll sync now (admin)', 'development', { id: 'Connection id' }),
  },
  '/api/internal/dev/gitlab/connections/{id}/status': {
    get: x('Connection status: mode, cursors, last backfill (admin)', 'development', { id: 'Connection id' }),
  },
  '/api/internal/issues/{key}/gitlab/branch': {
    post: x('Create a GitLab branch from this issue {connectionId,ref?,name?}', 'development', { key: 'Issue key' }),
  },
  '/api/internal/issues/{key}/gitlab/merge-request': {
    post: x(
      'Open a GitLab merge request from this issue {connectionId,sourceBranch,targetBranch,title?}',
      'development',
      { key: 'Issue key' }
    ),
  },
  '/rest/devinfo/0.10/bulk': {
    post: x(
      'Jira devinfo bulk ingestion (provider-signed: branches/commits/PRs/builds/deployments/flags)',
      'development'
    ),
  },
  '/rest/devinfo/0.10/repository/{repoId}/{provider}/{updateSequenceId}': {
    delete: x('Jira devinfo deletion: drop stale entities for a repository (provider-signed)', 'development', {
      repoId: 'Repository id',
      provider: 'Provider slug',
      updateSequenceId: 'Sequence id',
    }),
  },
  '/unsubscribe': {
    get: x('One-click notification unsubscribe {u,e,sig} — renders confirm page (064)', 'notifications'),
    post: x('Confirm notification unsubscribe {token} (064)', 'notifications'),
  },
  // jira-compat additions (015/034)
  '/rest/api/2/issue/picker': { get: x('Issue picker search ?query=&currentJQL=&showSubTasks=', 'search') },
  '/rest/api/2/issuesecurityschemes': { get: x('List issue security schemes', 'security') },
  '/rest/api/2/issuesecurityschemes/{id}': { get: x('Issue security scheme detail', 'security', { id: 'Scheme id' }) },
  '/rest/api/2/screens': { get: x('List screens', 'admin') },
  '/rest/api/2/screens/{id}': { get: x('Screen detail', 'admin', { id: 'Screen id' }) },
  '/rest/api/2/screens/{id}/tabs': { get: x('Screen tabs', 'admin', { id: 'Screen id' }) },
  '/rest/api/2/fieldconfigurations': { get: x('List field configurations', 'admin') },
  '/rest/api/2/fieldconfigurations/{id}': {
    get: x('Field configuration detail', 'admin', { id: 'Field configuration id' }),
  },
  '/rest/api/2/filter/defaultShareScope': {
    get: x('Default share scope for new filters', 'filters'),
    put: x('Set default share scope {scope}', 'filters'),
  },
  '/rest/api/2/filter/{id}/permission': {
    get: x('Filter share permissions', 'filters', { id: 'Filter id' }),
    post: x('Add share permission {type,projectId?,groupname?}', 'filters', { id: 'Filter id' }),
  },
  '/rest/api/2/filter/{id}/permission/{permissionId}': {
    get: x('Filter share permission detail', 'filters', { id: 'Filter id', permissionId: 'Permission id' }),
    delete: x('Remove share permission', 'filters', { id: 'Filter id', permissionId: 'Permission id' }),
  },
  // boards admin + agile additions (025/026)
  '/api/internal/boards/{id}': { put: x('Update board {name,filterId,…}', 'boards', { id: 'Board id' }) },
  '/api/internal/boards/{id}/default': { post: x('Make board the project default', 'boards', { id: 'Board id' }) },
  '/api/internal/boards/{id}/cardconfig': { put: x('Update card layout fields', 'boards', { id: 'Board id' }) },
  '/api/internal/boards/{id}/quickfilters': {
    post: x('Create quick filter {name,jql}', 'boards', { id: 'Board id' }),
    put: x('Rename/reorder quick filter', 'boards', { id: 'Board id' }),
  },
  '/api/internal/boards/{id}/quickfilters/{qfId}': {
    put: x('Update quick filter', 'boards', { id: 'Board id', qfId: 'Quick filter id' }),
    delete: x('Delete quick filter', 'boards', { id: 'Board id', qfId: 'Quick filter id' }),
  },
  '/rest/agile/1.0/board': { post: x('Create board {name,type,filterId}', 'boards') },
  '/rest/agile/1.0/board/{boardId}': { delete: x('Delete board', 'boards', { boardId: 'Board id' }) },
  '/rest/agile/1.0/board/{boardId}/quickfilter': { get: x('Board quick filters', 'boards', { boardId: 'Board id' }) },
  '/rest/agile/1.0/board/{boardId}/quickfilter/{qfId}': {
    get: x('Quick filter detail', 'boards', { boardId: 'Board id', qfId: 'Quick filter id' }),
  },
  '/rest/agile/1.0/board/{boardId}/cardconfig': {
    get: x('Board card layout config', 'boards', { boardId: 'Board id' }),
  },
  '/rest/agile/1.0/board/{boardId}/reports': {
    get: x('Board report summaries (burndown/velocity links)', 'boards', { boardId: 'Board id' }),
  },
  // /me self-service (036)
  '/api/internal/me': {
    get: x('My profile', 'me'),
    put: x('Update my profile {displayName,avatar}', 'me'),
  },
  '/api/internal/me/password': { put: x('Change my password {current,new}', 'me') },
  '/api/internal/me/sessions': { get: x('My active sessions', 'me') },
  '/api/internal/me/sessions/{id}': { delete: x('Revoke a session', 'me', { id: 'Session id' }) },
  '/api/internal/me/totp': {
    post: x('Begin TOTP enrollment — returns secret + otpauth URI', 'me'),
    delete: x('Disable TOTP', 'me'),
  },
  '/api/internal/me/totp/verify': { post: x('Verify TOTP code to finish enrollment', 'me') },
  '/api/internal/me/totp/backup-codes': { post: x('Regenerate TOTP backup codes', 'me') },
  '/api/internal/me/preferences': {
    get: x('My preferences {theme,locale,timezone,…}', 'me'),
    put: x('Update my preferences', 'me'),
  },
  // roadmap / reports / jql / automation (027/028/041)
  '/api/internal/roadmap/{projectKey}': {
    get: x('Roadmap: epics with child-issue progress + scheduled items', 'roadmap', { projectKey: 'Project key' }),
  },
  '/api/internal/reports': { get: x('Report catalog', 'reports') },
  '/api/internal/reports/epic/{projectKey}': {
    get: x('Epic report ?epicKey=', 'reports', { projectKey: 'Project key' }),
  },
  '/api/internal/reports/cfd/{projectKey}': {
    get: x('Cumulative flow diagram data ?from=&to=', 'reports', { projectKey: 'Project key' }),
  },
  '/api/internal/reports/control/{projectKey}': {
    get: x('Control chart data ?from=&to=', 'reports', { projectKey: 'Project key' }),
  },
  '/api/internal/reports/pie': { get: x('Pie chart ?jql=&statType=status|assignee|…', 'reports') },
  '/api/internal/reports/two-dimensional': { get: x('Two-dimensional stats ?jql=&xAxis=&yAxis=', 'reports') },
  '/api/internal/reports/created-vs-resolved': { get: x('Created vs resolved ?jql=&period=', 'reports') },
  '/api/internal/reports/workload': { get: x('Workload per assignee ?jql=', 'reports') },
  '/api/internal/reports/average-age': { get: x('Average age of unresolved ?jql=&period=', 'reports') },
  '/api/internal/reports/resolution-time': { get: x('Resolution time trend ?jql=&period=', 'reports') },
  '/api/internal/reports/time-tracking': { get: x('Time tracking rollup ?jql=', 'reports') },
  '/api/internal/reports/timesheet': { get: x('Timesheet rows ?jql=&from=&to=&user=', 'reports') },
  '/api/internal/reports/version/{id}': { get: x('Version report', 'reports', { id: 'Version id' }) },
  '/api/internal/reports/project/{key}': { get: x('Project report', 'reports', { key: 'Project key' }) },
  '/api/internal/reports/org': { get: x('Org-wide report (admin)', 'reports') },
  '/api/internal/jql/functions': { get: x('JQL function catalog with signatures + examples', 'search') },
  '/api/internal/automation/schema': {
    get: x('Automation component catalog: triggers/conditions/actions', 'automation'),
  },
  '/api/internal/automation/rules': {
    get: x('List automation rules ?projectKey=', 'automation'),
    post: x('Create automation rule (admin)', 'automation'),
  },
  '/api/internal/automation/rules/{id}': {
    get: x('Automation rule detail', 'automation', { id: 'Rule id' }),
    put: x('Update automation rule (admin)', 'automation', { id: 'Rule id' }),
    delete: x('Delete automation rule (admin)', 'automation', { id: 'Rule id' }),
  },
  '/api/internal/automation/rules/{id}/toggle': { post: x('Enable/disable rule', 'automation', { id: 'Rule id' }) },
  '/api/internal/automation/rules/{id}/runs': { get: x('Rule run history', 'automation', { id: 'Rule id' }) },
  '/api/internal/automation/runs/{id}': {
    get: x('Automation run detail + audit items', 'automation', { id: 'Run id' }),
  },
  '/api/internal/automation/rules/{id}/run': {
    post: x('Manual rule run (dryRun supported)', 'automation', { id: 'Rule id' }),
  },
  '/api/internal/automation/rules/{id}/dry-run': {
    post: x('Dry-run rule against ?issueKey=', 'automation', { id: 'Rule id' }),
  },
  '/api/internal/automation/validate': { post: x('Validate a rule definition without saving', 'automation') },
  '/api/internal/automation/scheduled-tick': {
    post: x('Run the scheduled-trigger sweep (internal scheduler)', 'automation'),
  },
  // project landing page (058)
  '/api/internal/projects/{key}/summary': {
    get: x('Project summary — status rollup, activity, priorities, versions, workload, agents', 'projects', {
      key: 'Project key',
    }),
  },
  // agent sessions + questions (047)
  '/api/internal/projects/{key}/agent-activity': {
    get: x('Live agent activity per issue — running/blocked/needs-answer counts for board badges', 'agents', {
      key: 'Project key',
    }),
  },
  '/api/internal/issues/{key}/sessions': { get: x('Agent sessions for an issue', 'agents', { key: 'Issue key' }) },
  '/api/internal/agent-sessions/{id}': {
    get: x('Agent session detail incl. activities + guidance context', 'agents', { id: 'Session id' }),
  },
  '/api/internal/agent-sessions/{id}/activities': {
    post: x(
      'Emit a session activity {kind:thought|action|error,message,data?} — done/failed kinds close the session',
      'agents',
      { id: 'Session id' }
    ),
  },
  '/api/internal/agent-questions': {
    post: x('Ask a blocking question against a session {sessionId,question,options?,expiresAt?}', 'agents'),
  },
  '/api/internal/issues/{key}/agent-questions': {
    get: x('Open agent questions for an issue', 'agents', { key: 'Issue key' }),
  },
  '/api/internal/agent-questions/{id}': { get: x('Agent question detail', 'agents', { id: 'Question id' }) },
  '/api/internal/agent-questions/{id}/answer': {
    post: x('Answer a question {answer|optionId} — resumes the session', 'agents', { id: 'Question id' }),
  },
  '/api/internal/agent/claim': {
    post: x(
      'Atomic ready-work claim {projectKey?|jql?, agent?, rank?} → delegates top-ranked ready issue + opens session in one tx (SKIP LOCKED)',
      'agents'
    ),
  },
  // bulk ops (023)
  '/api/internal/bulk/edit': { post: x('Bulk edit fields across ?issueKeys=/search results', 'bulk') },
  '/api/internal/bulk/transition': { post: x('Bulk workflow transition', 'bulk') },
  '/api/internal/bulk/move': { post: x('Bulk move to another project {projectKey,issuetype?}', 'bulk') },
  '/api/internal/bulk/delete': { post: x('Bulk delete — destructive, admin', 'bulk') },
  '/api/internal/bulk/comment': { post: x('Bulk add comment', 'bulk') },
  '/api/internal/bulk/watch': { post: x('Bulk watch/unwatch', 'bulk') },
  '/api/internal/bulk/link': { post: x('Bulk create issue links {type,inwardIssue}', 'bulk') },
  // schemes (030/034)
  '/api/internal/notificationschemes': {
    get: x('List notification schemes', 'admin'),
    post: x('Create notification scheme (admin)', 'admin'),
  },
  '/api/internal/notificationschemes/{id}': {
    get: x('Notification scheme detail', 'admin', { id: 'Scheme id' }),
    put: x('Update notification scheme (admin)', 'admin', { id: 'Scheme id' }),
    delete: x('Delete notification scheme (admin)', 'admin', { id: 'Scheme id' }),
  },
  '/api/internal/projects/{key}/notificationscheme': {
    post: x('Assign notification scheme {schemeId|null}', 'admin', { key: 'Project key' }),
  },
  '/api/internal/issuesecurityschemes': {
    get: x('List issue security schemes', 'admin'),
    post: x('Create issue security scheme (admin)', 'admin'),
  },
  '/api/internal/issuesecurityschemes/{id}': {
    put: x('Update issue security scheme (admin)', 'admin', { id: 'Scheme id' }),
    delete: x('Delete issue security scheme (admin)', 'admin', { id: 'Scheme id' }),
  },
  '/api/internal/issuesecurityschemes/{id}/levels': {
    post: x('Add security level {name,grants[]}', 'admin', { id: 'Scheme id' }),
  },
  '/api/internal/issuesecurityschemes/levels/{id}': {
    put: x('Update security level', 'admin', { id: 'Level id' }),
    delete: x('Delete security level', 'admin', { id: 'Level id' }),
  },
  '/api/internal/projects/{key}/issuesecurityscheme': {
    post: x('Assign issue security scheme {schemeId|null}', 'admin', { key: 'Project key' }),
  },
  '/api/internal/screens': {
    get: x('List screens', 'admin'),
    post: x('Create screen {name,tabs[],fields[]} (admin)', 'admin'),
  },
  '/api/internal/screens/{id}': {
    put: x('Update screen (admin)', 'admin', { id: 'Screen id' }),
    delete: x('Delete screen (admin)', 'admin', { id: 'Screen id' }),
  },
  '/api/internal/screens/{id}/tabs': { put: x('Replace screen tabs + field layout', 'admin', { id: 'Screen id' }) },
  '/api/internal/screenschemes': {
    get: x('List screen schemes', 'admin'),
    post: x('Create screen scheme (admin)', 'admin'),
  },
  '/api/internal/screenschemes/{id}': {
    put: x('Update screen scheme (admin)', 'admin', { id: 'Scheme id' }),
    delete: x('Delete screen scheme (admin)', 'admin', { id: 'Scheme id' }),
  },
  '/api/internal/issuetypescreenschemes': {
    get: x('List issue-type screen schemes', 'admin'),
    post: x('Create issue-type screen scheme (admin)', 'admin'),
  },
  '/api/internal/issuetypescreenschemes/{id}': {
    put: x('Update issue-type screen scheme (admin)', 'admin', { id: 'Scheme id' }),
    delete: x('Delete issue-type screen scheme (admin)', 'admin', { id: 'Scheme id' }),
  },
  '/api/internal/fieldconfigurations': {
    get: x('List field configurations', 'admin'),
    post: x('Create field configuration (admin)', 'admin'),
  },
  '/api/internal/fieldconfigurations/{id}': {
    put: x('Update field configuration (admin)', 'admin', { id: 'Configuration id' }),
    delete: x('Delete field configuration (admin)', 'admin', { id: 'Configuration id' }),
  },
  '/api/internal/fieldconfigurationschemes': {
    get: x('List field configuration schemes', 'admin'),
    post: x('Create field configuration scheme (admin)', 'admin'),
  },
  '/api/internal/fieldconfigurationschemes/{id}': {
    put: x('Update field configuration scheme (admin)', 'admin', { id: 'Scheme id' }),
    delete: x('Delete field configuration scheme (admin)', 'admin', { id: 'Scheme id' }),
  },
  '/api/internal/issuetypeschemes': {
    get: x('List issue type schemes', 'admin'),
    post: x('Create issue type scheme (admin)', 'admin'),
  },
  '/api/internal/issuetypeschemes/{id}': {
    put: x('Update issue type scheme (admin)', 'admin', { id: 'Scheme id' }),
    delete: x('Delete issue type scheme (admin)', 'admin', { id: 'Scheme id' }),
  },
  '/api/internal/projects/{key}/issuetypescreenscheme': {
    post: x('Assign issue-type screen scheme {schemeId|null}', 'admin', { key: 'Project key' }),
  },
  '/api/internal/projects/{key}/issuetypescreenscheme/resolved': {
    get: x('Effective screen scheme resolution for the project', 'admin', { key: 'Project key' }),
  },
  '/api/internal/projects/{key}/fieldconfigurationscheme': {
    post: x('Assign field configuration scheme {schemeId|null}', 'admin', { key: 'Project key' }),
  },
  '/api/internal/projects/{key}/issuetypescheme': {
    post: x('Assign issue type scheme {schemeId|null}', 'admin', { key: 'Project key' }),
  },
  '/api/internal/projects/{key}/workflowscheme': {
    post: x('Assign workflow scheme {schemeId|null}', 'admin', { key: 'Project key' }),
  },
  // filters, mail/outbox, migration, system, workflowschemes (029/032/039/044)
  '/api/internal/filters/unsubscribe': { get: x('Unsubscribe from a filter subscription {token}', 'filters') },
  '/api/internal/filters/{id}/subscriptions': {
    get: x('Filter subscriptions', 'filters', { id: 'Filter id' }),
    post: x('Subscribe to a filter {cron}', 'filters', { id: 'Filter id' }),
  },
  '/api/internal/filters/{id}/subscriptions/{subId}': {
    delete: x('Remove a filter subscription', 'filters', { id: 'Filter id', subId: 'Subscription id' }),
  },
  '/api/internal/admin/mail': {
    get: x('SMTP config — password never returned (admin)', 'admin'),
    put: x('Update SMTP config (admin)', 'admin'),
  },
  '/api/internal/admin/mail/test': { post: x('Send a test email {to} (admin)', 'admin') },
  '/api/internal/admin/outbox': { get: x('Mail outbox — queued/failed notifications (admin)', 'admin') },
  '/api/internal/migration/csv': { post: x('CSV import {projectKey,csv,mapping} — 202 job', 'migration') },
  '/api/internal/migration/csv/preview': {
    post: x('CSV import dry-run: parsed rows + mapping suggestions', 'migration'),
  },
  '/api/internal/migration/jira-server-xml': { post: x('Jira Server XML backup import — 202 job', 'migration') },
  '/api/internal/migration/export/{id}': { get: x('Download an export bundle', 'migration', { id: 'Export id' }) },
  '/api/internal/ai/outcome': {
    post: x(
      'Record an AI output outcome {feature,outcome:accepted|edited|discarded|clarified|failed} — verification-cost metric',
      'ai'
    ),
  },
  '/api/internal/admin/projects': {
    get: x('Admin project overview — all projects incl. archived, with issue counts + last issue update', 'admin'),
  },
  '/api/internal/projects/{key}/issues/archived': {
    get: x('Archived issues for a project (RESTORE_ISSUES or admin)', 'admin', { key: 'Project key' }),
  },
  '/api/internal/users/invite': {
    post: x('Invite a user by email — inactive account + single-use invite token, emailed via outbox (admin)', 'admin'),
  },
  '/api/internal/users/{accountId}/invite': {
    post: x('Re-send invite to an inactive account (admin)', 'admin', { accountId: 'User account id' }),
  },
  '/api/internal/users/{accountId}/anonymize': {
    post: x('Anonymize a user — GDPR erasure, two-step (?dryRun=true → confirmToken)', 'admin', {
      accountId: 'User account id',
    }),
  },
  '/api/internal/users/{accountId}/password-reset': {
    post: x(
      'Admin-initiated password reset — flags mustChangePassword, clears 2FA, revokes sessions, mails a reset link (admin)',
      'admin',
      { accountId: 'User account id' }
    ),
  },
  '/api/internal/auth/invite-accept': {
    post: x('Accept an invite — sets password and activates the account (public)', 'auth'),
  },
  '/api/internal/system/banner': {
    get: x('Announcement banner text (any user)', 'system'),
    put: x('Set announcement banner — shown site-wide (admin)', 'ops'),
  },
  '/api/internal/system/auth-policy': {
    get: x('Read the SSO-only auth policy flag (admin)', 'admin'),
    put: x(
      'Set the SSO-only auth policy {ssoOnly} — password login blocked except site-admin break-glass (admin)',
      'admin'
    ),
  },
  '/api/internal/admin/system/status': {
    get: x('Instance status: version, uptime, db/queue/storage checks, backup + update-check state (admin)', 'ops'),
  },
  '/api/internal/admin/system/updatecheck': { post: x('Run the update check now (admin)', 'ops') },
  '/api/internal/admin/system/backups': { get: x('List backup sets under BACKUP_DIR (admin)', 'ops') },
  '/api/internal/admin/system/backup': { post: x('Run a backup now — 202 (admin)', 'ops') },
  '/api/internal/admin/system/backups/{id}/verify': {
    post: x('Verify backup checksums (admin)', 'ops', { id: 'Backup set id' }),
  },
  '/api/internal/admin/system/backups/{id}/restore': {
    post: x(
      'Restore a backup — dryRun returns manifest + confirmToken; confirm launches detached pgRestore (admin)',
      'ops',
      { id: 'Backup set id' }
    ),
  },
  '/api/internal/admin/system/restore-status': {
    get: x('Restore progress — file-backed marker, survives DB replacement (admin)', 'ops'),
  },
  '/api/internal/admin/system/support.zip': { get: x('Support bundle — secrets redacted (admin)', 'ops') },
  '/api/internal/workflowschemes': {
    get: x('List workflow schemes', 'admin'),
    post: x('Create workflow scheme (admin)', 'admin'),
  },
  '/api/internal/workflowschemes/{id}': {
    get: x('Get workflow scheme (admin)', 'admin', { id: 'Scheme id' }),
    put: x('Update workflow scheme (admin)', 'admin', { id: 'Scheme id' }),
    delete: x('Delete workflow scheme (admin)', 'admin', { id: 'Scheme id' }),
  },
  // OAuth 2.1 authorization server (049)
  '/.well-known/oauth-authorization-server': { get: x('AS metadata — RFC 8414 discovery (unauthenticated)', 'oauth') },
  '/.well-known/oauth-protected-resource': {
    get: x('Protected resource metadata — RFC 9728 (unauthenticated)', 'oauth'),
  },
  '/oauth/jwks': { get: x('JWKS — RS256 public keys for access-token verification (unauthenticated)', 'oauth') },
  '/oauth/authorize': {
    get: x('Consent screen — session-only; validates client+S256 PKCE then renders approval form', 'oauth', {
      client_id: 'Client id',
      redirect_uri: 'Registered redirect (exact match)',
      scope: 'Space-separated scopes',
      state: 'Client state',
      code_challenge: 'S256 challenge',
      code_challenge_method: 'S256',
    }),
    post: x('Consent decision — session-only; {decision:approve|deny} + authorize params → 302 code', 'oauth'),
  },
  '/oauth/device': {
    post: x('Device authorization — RFC 8628; {client_id,scope} → {device_code,user_code,verification_uri}', 'oauth'),
    get: x('Device approval page — session-only user_code entry', 'oauth'),
  },
  '/oauth/device/approve': { post: x('Device approval decision — session-only {user_code,decision}', 'oauth') },
  '/oauth/token': {
    post: x(
      'Token endpoint — authorization_code|refresh_token|client_credentials|device_code; Basic or body client auth',
      'oauth'
    ),
  },
  '/oauth/revoke': { post: x('Token revocation — RFC 7009; revokes the grant chain (always 200)', 'oauth') },
  '/oauth/introspect': { post: x('Token introspection — RFC 7662; admin-scoped {token} → {active,…}', 'oauth') },
  '/oauth/register': {
    post: x(
      'Dynamic client registration — RFC 7591; public clients only, rate-limited, OAUTH_DCR_ENABLED toggle',
      'oauth'
    ),
  },
  '/api/internal/admin/oauth/clients': {
    get: x('List OAuth clients — secrets never returned (admin)', 'oauth'),
    post: x(
      'Register OAuth client {name,grantTypes,allowedScopes,…} — returns clientSecret once when confidential (admin)',
      'oauth'
    ),
  },
  '/api/internal/admin/oauth/clients/{id}': {
    put: x('Update OAuth client (admin)', 'oauth', { id: 'Client row id' }),
    delete: x('Delete OAuth client (admin)', 'oauth', { id: 'Client row id' }),
  },
  '/api/internal/me/grants': { get: x('My consented OAuth grants {grants[]}', 'oauth') },
  '/api/internal/me/grants/{id}': {
    delete: x('Revoke one of my grants — kills the refresh chain', 'oauth', { id: 'Grant id' }),
  },
  // Docs portal (050) — optional auth, audience-filtered server-side
  '/api/internal/docs/manifest': { get: x('Docs manifest — sections + pages visible to this audience', 'docs') },
  '/api/internal/docs/index': { get: x('Docs search index — titles + headings for client-side search', 'docs') },
  '/api/internal/docs/search': { get: x('Full-text doc search {results[]: slug,title,excerpt} — ?q=', 'docs') },
  '/api/internal/docs/page/{slug}': {
    get: x('Rendered + sanitized doc page {markdown,html}', 'docs', { slug: 'Doc slug from the manifest' }),
  },
  '/api/internal/docs/openapi.json': {
    get: x('Served OpenAPI document — authed audience (DOCS_PUBLIC opens it)', 'docs'),
  },
  // SCIM 2.0 service provider (049 Track A1) — per-connection bearer auth
  '/scim/v2/ServiceProviderConfig': { get: x('SCIM feature advertisement (patch+filter, no bulk)', 'scim') },
  '/scim/v2/ResourceTypes': { get: x('SCIM resource types: User, Group', 'scim') },
  '/scim/v2/Schemas': { get: x('SCIM schemas', 'scim') },
  '/scim/v2/Users': {
    get: x('List users — filter=userName|externalId eq, startIndex/count', 'scim'),
    post: x('Provision/upsert user — externalId keyed, idempotent', 'scim'),
  },
  '/scim/v2/Users/{id}': {
    get: x('SCIM user resource', 'scim', { id: 'User id' }),
    put: x('Replace user attrs — externalId-keyed rename safe', 'scim', { id: 'User id' }),
    patch: x('Tolerant PATCH — replace ops only', 'scim', { id: 'User id' }),
    delete: x('Deprovision — deactivate + revoke credentials, never delete', 'scim', { id: 'User id' }),
  },
  '/scim/v2/Groups': {
    get: x('List groups', 'scim'),
    post: x('Create/converge group — bounded member list, unknown ids warn', 'scim'),
  },
  '/scim/v2/Groups/{id}': {
    get: x('SCIM group resource', 'scim', { id: 'Group id' }),
    put: x('Replace group — membership converges exactly', 'scim', { id: 'Group id' }),
  },
  '/api/internal/admin/directory': {
    get: x('List directory connections — secrets never emitted (admin)', 'scim'),
    post: x(
      'Create connection {type:scim|ldap,name,config,secretRef,enabled} — returns scimToken once (admin)',
      'scim'
    ),
  },
  '/api/internal/admin/directory/{id}': {
    put: x('Update directory connection (admin)', 'scim', { id: 'Connection id' }),
    delete: x('Delete directory connection (admin)', 'scim', { id: 'Connection id' }),
  },
  '/api/internal/admin/directory/{id}/scim-tokens': {
    post: x('Mint an additional SCIM bearer — rotation (admin)', 'scim', { id: 'Connection id' }),
  },
  '/api/internal/admin/directory/{id}/scim-tokens/{tokenId}': {
    delete: x('Revoke a SCIM bearer (admin)', 'scim', { id: 'Connection id', tokenId: 'Token id' }),
  },
  '/api/internal/admin/directory/{id}/test': {
    post: x('LDAP connection test — bind + sample user resolution, machine-readable (admin)', 'scim', {
      id: 'Connection id',
    }),
  },
  '/api/internal/admin/directory/{id}/sync': {
    post: x('On-demand LDAP sync — converge users by immutable id, deactivate disabled (admin)', 'scim', {
      id: 'Connection id',
    }),
  },
};

export function openApiDocument() {
  // 040 — v3 mirror appended after the literal: every /rest/api/2 path also
  // exists under /rest/api/3, same semantics with ADF bodies (docs/adf.md).
  const injectV3 = (doc: { paths: Record<string, unknown> }) => {
    for (const [p, ops] of Object.entries(doc.paths)) {
      if (p.startsWith('/rest/api/2/')) doc.paths[p.replace('/rest/api/2/', '/rest/api/3/')] = ops;
    }
    return doc;
  };
  const doc = {
    openapi: '3.1.0',
    info: {
      title: 'TrackForge API',
      version: '1.0.0',
      description:
        'Jira-compatible REST API. Auth: `tf_session` cookie (UI login), ' +
        '`Bearer tfp_*` personal access token, or HTTP Basic with token as password. ' +
        'TrackForge extensions are marked `x-trackforge-extension`.',
    },
    servers: [{ url: publicBaseUrl() }],
    security: [{ bearerAuth: [] }, { basicAuth: [] }, { cookieAuth: [] }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'PAT: `Bearer tfp_…`' },
        basicAuth: { type: 'http', scheme: 'basic', description: 'email:tfp_… base64' },
        cookieAuth: { type: 'apiKey', in: 'cookie', name: 'tf_session' },
      },
    },
    paths: {
      '/rest/api/2/serverInfo': {
        get: op({
          summary: 'Server info (unauthenticated)',
          tags: ['meta'],
          responses: ok('Server metadata', {
            baseUrl: '…',
            version: '1.0.0',
            deploymentType: 'Server',
            serverTitle: 'TrackForge',
          }),
        }),
      },
      '/rest/api/2/openapi.json': {
        get: op({
          summary: 'This OpenAPI document',
          tags: ['meta'],
          extension: true,
          responses: ok('OpenAPI 3.1 JSON'),
        }),
      },
      '/rest/api/2/myself': {
        get: op({ summary: 'Current user', tags: ['users'], responses: { '200': ISSUE_REF, ...JIRA_ERR } }),
      },
      '/rest/api/2/status': {
        get: op({ summary: 'List statuses', tags: ['meta'], responses: ok('Jira status array') }),
      },
      '/rest/api/2/priority': {
        get: op({ summary: 'List priorities', tags: ['meta'], responses: ok('Jira priority array') }),
      },
      '/rest/api/2/issuetype': {
        get: op({ summary: 'List issue types', tags: ['meta'], responses: ok('Jira issue type array') }),
      },
      '/rest/api/2/field': {
        get: op({ summary: 'List system fields', tags: ['meta'], responses: ok('Jira field array') }),
      },
      '/rest/api/2/project': {
        get: op({
          summary: 'List projects (archived hidden unless includeArchived)',
          tags: ['projects'],
          parameters: queries({
            includeArchived: { type: 'boolean', description: 'include archived projects' },
            categoryId: { type: 'string', description: 'filter by project category' },
          }),
          responses: ok('Jira project array'),
        }),
        post: op({
          summary: 'Create project (projectTypeKey|projectTemplateKey|categoryId)',
          tags: ['projects'],
          requestBody: body(createProjectSchema),
          responses: { '201': { description: 'Created project' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/project/{key}': {
        get: op({
          summary: 'Get project',
          tags: ['projects'],
          parameters: params({ key: 'Project key' }),
          responses: { '200': { description: 'Jira project' }, ...JIRA_ERR },
        }),
        put: op({
          summary: 'Update project (name, description, lead, avatarColor, categoryId)',
          tags: ['projects'],
          parameters: params({ key: 'Project key' }),
          requestBody: body(updateProjectSchema),
          responses: { '200': { description: 'Updated project' }, ...JIRA_ERR },
        }),
        delete: op({
          summary: 'Delete project + its issues (admin)',
          tags: ['projects'],
          parameters: params({ key: 'Project key' }),
          responses: { '204': { description: 'Deleted' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/project/{key}/archive': {
        post: op({
          summary: 'Archive project — read-only, hidden from pickers (admin)',
          tags: ['projects'],
          parameters: params({ key: 'Project key' }),
          responses: { '200': { description: 'Archived project' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/project/{key}/restore': {
        post: op({
          summary: 'Restore archived project (admin)',
          tags: ['projects'],
          parameters: params({ key: 'Project key' }),
          responses: { '200': { description: 'Restored project' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/issue': {
        post: op({
          summary: 'Create issue',
          tags: ['issues'],
          requestBody: body(createIssueSchema),
          description: IDEM.description,
          responses: { '201': { description: 'Created issue' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/issue/bulk': {
        post: op({
          summary:
            'Bulk create issues (≤50) — dryRun=true previews per item; batchId makes retries per-item idempotent',
          tags: ['issues'],
          requestBody: body(bulkCreateSchema),
          responses: { '201': { description: '{issues[], errors[], batchId?}' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/issue/createmeta/{projectKey}/issuetypes': {
        get: op({
          summary: 'Create metadata: issue types for a project',
          tags: ['meta'],
          parameters: params({ projectKey: 'Project key' }),
          responses: ok('createmeta issuetypes'),
        }),
      },
      '/rest/api/2/issue/createmeta/{projectKey}/issuetypes/{issueTypeId}': {
        get: op({
          summary: 'Create metadata: fields for an issue type',
          tags: ['meta'],
          parameters: params({ projectKey: 'Project key', issueTypeId: 'Issue type id' }),
          responses: ok('createmeta field values'),
        }),
      },
      '/rest/api/2/project/{key}/statuses': {
        get: op({
          summary: 'Statuses valid for this project (per issue type)',
          tags: ['projects'],
          parameters: params({ key: 'Project key' }),
          responses: ok('[{id,name,statuses[],subtask}]'),
        }),
      },
      '/rest/api/2/workflow': {
        get: op({ summary: 'List workflows', tags: ['workflows'], responses: ok('{values[{name,default}]}') }),
      },
      '/rest/api/2/issue/{key}': {
        get: op({
          summary: 'Get issue',
          tags: ['issues'],
          parameters: [
            ...params({ key: 'Issue key' }),
            ...queries({
              fields: { description: 'Comma-separated field ids; *all, *navigable' },
              expand: { description: 'changelog,names,schema' },
            }),
          ],
          responses: { '200': ISSUE_REF, ...JIRA_ERR },
        }),
        put: op({
          summary: 'Edit issue',
          tags: ['issues'],
          parameters: params({ key: 'Issue key' }),
          requestBody: body(updateIssueSchema),
          description: 'Jira `fields` + `update` ops. ' + IDEM.description,
          responses: { '204': { description: 'Updated' }, ...JIRA_ERR },
        }),
        delete: op({
          summary: 'Delete issue',
          tags: ['issues'],
          parameters: [
            ...params({ key: 'Issue key' }),
            ...queries({
              deleteSubtasks: { description: 'true to delete subtasks too', type: 'string' },
              confirmToken: { description: 'token from a dryRun delete preview', type: 'string' },
              dryRun: { description: 'true → returns {deletesSubtasks,clearsParentOn,confirmToken}', type: 'string' },
            }),
          ],
          description: 'Jira `deleteSubtasks` semantics + TrackForge `confirmToken` (get one via `?dryRun=true`).',
          responses: { '204': { description: 'Deleted' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/issue/{key}/children': {
        get: op({
          summary: 'Child issues (subtasks + epic children)',
          tags: ['issues'],
          extension: true,
          parameters: params({ key: 'Issue key' }),
          responses: ok('{issues[]}'),
        }),
      },
      '/rest/api/2/issue/{key}/archive': {
        put: op({
          summary:
            'Archive issue — leaves every read surface, read-only (Jira DC; ARCHIVE_ISSUES). ?dryRun=true previews',
          tags: ['issues'],
          parameters: [
            ...params({ key: 'Issue key' }),
            ...queries({ dryRun: { description: 'true → validate + preview without persisting', type: 'string' } }),
          ],
          responses: { '204': { description: 'Archived' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/issue/{key}/restore': {
        put: op({
          summary: 'Restore archived issue (Jira DC; RESTORE_ISSUES). ?dryRun=true previews',
          tags: ['issues'],
          parameters: [
            ...params({ key: 'Issue key' }),
            ...queries({ dryRun: { description: 'true → validate + preview without persisting', type: 'string' } }),
          ],
          responses: { '204': { description: 'Restored' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/issue/{key}/comment': {
        get: op({
          summary: 'List comments (paged; orderBy=created|+created|-created, default newest-first)',
          tags: ['issues'],
          parameters: [
            ...params({ key: 'Issue key' }),
            ...queries({
              startAt: { type: 'integer', description: 'offset' },
              maxResults: { type: 'integer', description: 'page size ≤100' },
            }),
          ],
          responses: ok('{startAt,maxResults,total,comments[]}'),
        }),
        post: op({
          summary: 'Add comment (markdown body; mentions `[~accountId:id]`) — dryRun=true previews',
          tags: ['issues'],
          parameters: params({ key: 'Issue key' }),
          requestBody: body(commentSchema, { body: 'see [~accountId:uuid]' }),
          responses: { '201': { description: 'Created comment' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/issue/{key}/comment/{id}': {
        get: op({
          summary: 'Get comment',
          tags: ['issues'],
          parameters: params({ key: 'Issue key', id: 'Comment id' }),
          responses: ok('comment'),
        }),
        put: op({
          summary: 'Edit comment (author or admin)',
          tags: ['issues'],
          parameters: params({ key: 'Issue key', id: 'Comment id' }),
          requestBody: body(commentSchema),
          responses: { '200': { description: 'Updated comment' }, ...JIRA_ERR },
        }),
        delete: op({
          summary: 'Delete comment (author or admin)',
          tags: ['issues'],
          parameters: params({ key: 'Issue key', id: 'Comment id' }),
          responses: { '204': { description: 'Deleted' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/issue/{key}/worklog': {
        get: op({
          summary: 'List worklogs (oldest-first)',
          tags: ['worklogs'],
          parameters: [
            ...params({ key: 'Issue key' }),
            ...queries({
              startAt: { type: 'integer', description: 'offset' },
              maxResults: { type: 'integer', description: 'page size ≤5000' },
              startedAfter: { type: 'integer', description: 'ms epoch' },
              startedBefore: { type: 'integer', description: 'ms epoch' },
            }),
          ],
          responses: ok('{startAt,maxResults,total,worklogs[]}'),
        }),
        post: op({
          summary: 'Log work (duration "2h 30m" or seconds)',
          tags: ['worklogs'],
          parameters: [
            ...params({ key: 'Issue key' }),
            ...queries({
              adjustEstimate: { type: 'string', description: 'auto|leave|new|manual' },
              newEstimate: { type: 'string', description: 'required when adjustEstimate=new' },
              reduceBy: { type: 'string', description: 'required when adjustEstimate=manual' },
              dryRun: { type: 'string', description: 'true → preview' },
            }),
          ],
          requestBody: body(worklogSchema, {
            timeSpent: '2h',
            comment: 'see [~accountId:uuid]',
            started: '2026-01-01T09:00:00.000Z',
            billable: false,
          }),
          description: 'Jira v2 worklog. ' + IDEM.description,
          responses: { '201': { description: 'Created worklog' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/issue/{key}/worklog/{id}': {
        get: op({
          summary: 'Get worklog',
          tags: ['worklogs'],
          parameters: params({ key: 'Issue key', id: 'Worklog id' }),
          responses: ok('worklog'),
        }),
        put: op({
          summary: 'Edit worklog (author or EDIT_ALL_WORKLOGS)',
          tags: ['worklogs'],
          parameters: [
            ...params({ key: 'Issue key', id: 'Worklog id' }),
            ...queries({
              adjustEstimate: { type: 'string', description: 'auto|leave|new|manual' },
              newEstimate: { type: 'string', description: 'required when adjustEstimate=new' },
              reduceBy: { type: 'string', description: 'required when adjustEstimate=manual' },
            }),
          ],
          requestBody: body(updateWorklogSchema),
          responses: { '200': { description: 'Updated worklog' }, ...JIRA_ERR },
        }),
        delete: op({
          summary: 'Delete worklog (author or DELETE_ALL_WORKLOGS)',
          tags: ['worklogs'],
          parameters: [
            ...params({ key: 'Issue key', id: 'Worklog id' }),
            ...queries({
              adjustEstimate: { type: 'string', description: 'auto|leave|new|manual' },
              newEstimate: { type: 'string', description: 'required when adjustEstimate=new' },
              increaseBy: { type: 'string', description: 'required when adjustEstimate=manual on delete' },
            }),
          ],
          responses: { '204': { description: 'Deleted' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/worklog/updated': {
        get: op({
          summary: 'Ids of worklogs updated since (incremental sync)',
          tags: ['worklogs'],
          parameters: queries({
            since: { type: 'integer', description: 'ms epoch' },
            expand: { type: 'string', description: '"values" embeds worklog objects' },
          }),
          responses: ok('{values[],since,until,lastPage,self,nextPage}'),
        }),
      },
      '/rest/api/2/worklog/deleted': {
        get: op({
          summary: 'Ids of worklogs deleted since (incremental sync)',
          tags: ['worklogs'],
          parameters: queries({ since: { type: 'integer', description: 'ms epoch' } }),
          responses: ok('{values[],since,until,lastPage}'),
        }),
      },
      '/rest/api/2/worklog/list': {
        post: op({
          summary: 'Fetch worklogs by ids (≤1000)',
          tags: ['worklogs'],
          requestBody: body(worklogListSchema, { ids: ['worklog-uuid'], expand: ['properties'] }),
          responses: ok('worklog[]'),
        }),
      },
      '/api/internal/system/info': {
        get: op({
          summary: 'Instance facts (uptime, counts, modules, timeTracking)',
          tags: ['admin'],
          extension: true,
          responses: ok('{baseUrl,version,uptimeSec,counts,modules,timeTracking}'),
        }),
      },
      '/api/internal/system/timetracking': {
        get: op({
          summary: 'Workday assumptions for duration parsing/format',
          tags: ['admin'],
          extension: true,
          responses: ok('TimeTrackingConfig'),
        }),
        put: op({
          summary: 'Update time-tracking config (admin)',
          tags: ['admin'],
          extension: true,
          requestBody: body(timeTrackingConfigSchema, {
            hoursPerDay: 8,
            daysPerWeek: 5,
            format: 'pretty',
            defaultUnit: 'h',
          }),
          responses: { '200': { description: 'Updated config' }, ...JIRA_ERR },
        }),
      },
      '/api/internal/system/settings/{key}': {
        get: op({
          summary: 'Read a raw setting by key (admin)',
          tags: ['admin'],
          extension: true,
          parameters: params({ key: 'Setting key' }),
          responses: ok('{key,value}'),
        }),
      },
      '/api/internal/system/modules': {
        get: op({
          summary: 'Instance module toggles (ai, automation, devPanel, importers)',
          tags: ['admin'],
          extension: true,
          responses: ok('{ai,automation,devPanel,importers}'),
        }),
        put: op({
          summary: 'Update module toggles (admin)',
          tags: ['admin'],
          extension: true,
          requestBody: body(moduleTogglesSchema, { ai: false }),
          responses: { '200': { description: 'Updated toggles' }, ...JIRA_ERR },
        }),
      },
      '/api/internal/projectcategories': {
        get: op({
          summary: 'List project categories',
          tags: ['admin'],
          extension: true,
          responses: ok('category array'),
        }),
        post: op({
          summary: 'Create project category (admin)',
          tags: ['admin'],
          extension: true,
          requestBody: body(projectCategorySchema, { name: 'Internal' }),
          responses: { '201': { description: 'Created category' }, ...JIRA_ERR },
        }),
      },
      '/api/internal/projectcategories/{id}': {
        put: op({
          summary: 'Rename project category (admin)',
          tags: ['admin'],
          extension: true,
          parameters: params({ id: 'Category id' }),
          requestBody: body(projectCategorySchema, { name: 'Internal' }),
          responses: { '200': { description: 'Updated' }, ...JIRA_ERR },
        }),
        delete: op({
          summary: 'Delete unused project category (admin)',
          tags: ['admin'],
          extension: true,
          parameters: params({ id: 'Category id' }),
          responses: { '204': { description: 'Deleted' }, ...JIRA_ERR },
        }),
      },
      '/api/internal/metadata/{entity}': {
        get: op({
          summary: 'List metadata rows: statuses|priorities|resolutions|issuetypes|issuelinktypes (admin)',
          tags: ['admin'],
          extension: true,
          parameters: params({ entity: 'statuses|priorities|resolutions|issuetypes|issuelinktypes' }),
          responses: ok('row array'),
        }),
        post: op({
          summary: 'Create metadata row (admin)',
          tags: ['admin'],
          extension: true,
          parameters: params({ entity: 'statuses|priorities|resolutions|issuetypes|issuelinktypes' }),
          responses: { '201': { description: 'Created' }, ...JIRA_ERR },
        }),
      },
      '/api/internal/metadata/{entity}/{id}': {
        put: op({
          summary: 'Update metadata row (admin)',
          tags: ['admin'],
          extension: true,
          parameters: params({ entity: 'entity', id: 'Row id' }),
          responses: { '200': { description: 'Updated' }, ...JIRA_ERR },
        }),
        delete: op({
          summary: 'Delete metadata row — blocked while referenced (admin)',
          tags: ['admin'],
          extension: true,
          parameters: params({ entity: 'entity', id: 'Row id' }),
          responses: { '204': { description: 'Deleted' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/resolution': {
        get: op({ summary: 'List resolutions', tags: ['meta'], responses: ok('Jira resolution array') }),
      },
      '/rest/api/2/label': {
        get: op({
          summary: 'List labels (paged)',
          tags: ['meta'],
          parameters: queries({
            startAt: { type: 'integer', description: 'offset' },
            maxResults: { type: 'integer', description: 'page size' },
          }),
          responses: ok('{startAt,maxResults,total,values[]}'),
        }),
      },
      // ---- Sprint 018: attachments ----
      '/rest/api/2/issue/{key}/attachments': {
        post: op({
          summary: 'Upload attachment(s) (multipart field "file", X-Atlassian-Token: no-check)',
          tags: ['issues'],
          parameters: params({ key: 'Issue key' }),
          requestBody: {
            content: {
              'multipart/form-data': {
                schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' } } },
              },
            },
          },
          responses: {
            '200': { description: 'Attachment metadata[]' },
            '413': { description: 'File exceeds the configured attachment limit' },
            ...JIRA_ERR,
          },
        }),
      },
      '/rest/api/2/attachment/meta': {
        get: op({ summary: 'Attachment limits', tags: ['meta'], responses: ok('{enabled,uploadLimit}') }),
      },
      '/rest/api/2/attachment/{id}': {
        get: op({
          summary: 'Attachment metadata',
          tags: ['issues'],
          parameters: params({ id: 'Attachment id' }),
          responses: ok('Attachment metadata'),
        }),
        delete: op({
          summary: 'Delete attachment (author or DELETE_ALL_ATTACHMENTS)',
          tags: ['issues'],
          parameters: params({ id: 'Attachment id' }),
          responses: { '204': { description: 'Deleted' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/attachment/content/{id}': {
        get: op({
          summary: 'Attachment bytes (safe inline types only; SVG/others force download)',
          tags: ['issues'],
          parameters: params({ id: 'Attachment id' }),
          responses: ok('Binary content'),
        }),
      },
      '/rest/api/2/attachment/thumbnail/{id}': {
        get: op({
          summary: 'Attachment thumbnail (images; async-generated)',
          tags: ['issues'],
          parameters: params({ id: 'Attachment id' }),
          responses: ok('PNG thumbnail'),
        }),
      },
      // ---- Sprint 019: components, versions & release hub ----
      '/rest/api/2/component': {
        post: op({
          summary: 'Create component',
          tags: ['projects'],
          requestBody: body(
            z.object({
              name: z.string(),
              project: z.string(),
              description: z.string().optional(),
              leadAccountId: z.string().optional(),
              assigneeType: z.enum(['PROJECT_DEFAULT', 'COMPONENT_LEAD', 'PROJECT_LEAD', 'UNASSIGNED']).optional(),
            }),
            { name: 'Auth', project: 'TF', assigneeType: 'COMPONENT_LEAD' }
          ),
          description: IDEM.description,
          responses: { '201': { description: 'Component' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/component/{id}': {
        get: op({
          summary: 'Get component',
          tags: ['projects'],
          parameters: params({ id: 'Component id' }),
          responses: ok('Component'),
        }),
        put: op({
          summary: 'Update component',
          tags: ['projects'],
          parameters: params({ id: 'Component id' }),
          responses: ok('Component'),
        }),
        delete: op({
          summary: 'Delete component (?moveIssuesTo=<id> reassigns refs)',
          tags: ['projects'],
          parameters: [
            ...params({ id: 'Component id' }),
            ...queries({ moveIssuesTo: { description: 'component id to move issue refs to' } }),
          ],
          responses: { '204': { description: 'Deleted' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/component/{id}/relatedIssueCounts': {
        get: op({
          summary: 'Component issue count',
          tags: ['projects'],
          parameters: params({ id: 'Component id' }),
          responses: ok('{issueCount}'),
        }),
      },
      '/rest/api/2/version': {
        post: op({
          summary: 'Create version',
          tags: ['projects'],
          requestBody: body(
            z.object({
              name: z.string(),
              project: z.string(),
              description: z.string().optional(),
              startDate: z.string().optional(),
              releaseDate: z.string().optional(),
              released: z.boolean().optional(),
            }),
            { name: '1.0', project: 'TF' }
          ),
          description: IDEM.description,
          responses: { '201': { description: 'Version' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/version/{id}': {
        get: op({
          summary: 'Get version',
          tags: ['projects'],
          parameters: params({ id: 'Version id' }),
          responses: ok('Version'),
        }),
        put: op({
          summary: 'Update version',
          tags: ['projects'],
          parameters: params({ id: 'Version id' }),
          responses: ok('Version'),
        }),
        delete: op({
          summary: 'Delete version (?moveFixIssuesTo=/moveAffectedIssuesTo= reassigns refs)',
          tags: ['projects'],
          parameters: [
            ...params({ id: 'Version id' }),
            ...queries({
              moveFixIssuesTo: { description: 'version id for fix refs' },
              moveAffectedIssuesTo: { description: 'version id for affects refs' },
            }),
          ],
          responses: { '204': { description: 'Deleted' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/version/{id}/move': {
        post: op({
          summary: 'Reorder version (position or after)',
          tags: ['projects'],
          parameters: params({ id: 'Version id' }),
          requestBody: body(
            z.object({
              position: z.enum(['First', 'Last', 'Earlier', 'Later']).optional(),
              after: z.string().optional(),
            }),
            { position: 'First' }
          ),
          responses: ok('Version'),
        }),
      },
      '/rest/api/2/version/{id}/release': {
        post: op({
          summary: 'Mark version released (stamps releaseDate)',
          tags: ['projects'],
          parameters: params({ id: 'Version id' }),
          requestBody: body(z.object({ releaseDate: z.string().optional() }), { releaseDate: '2026-12-01' }),
          responses: ok('Version'),
        }),
      },
      '/rest/api/2/version/{id}/releasenotes': {
        get: op({
          summary: 'Release notes — done issues grouped by issue type',
          tags: ['projects'],
          parameters: params({ id: 'Version id' }),
          responses: ok('{version,project,groups[{type,issues[]}]}'),
        }),
      },
      '/rest/api/2/version/{id}/relatedIssueCounts': {
        get: op({
          summary: 'Version issue counts',
          tags: ['projects'],
          parameters: params({ id: 'Version id' }),
          responses: ok('{issueCount}'),
        }),
      },
      '/rest/api/2/version/{id}/unresolvedIssueCount': {
        get: op({
          summary: 'Version unresolved issue count',
          tags: ['projects'],
          parameters: params({ id: 'Version id' }),
          responses: ok('{issuesUnresolvedCount}'),
        }),
      },
      '/rest/api/2/project/{key}/components': {
        get: op({
          summary: 'List project components',
          tags: ['projects'],
          parameters: params({ key: 'Project key' }),
          responses: ok('Component[]'),
        }),
      },
      '/rest/api/2/project/{key}/versions': {
        get: op({
          summary: 'List project versions (ordered)',
          tags: ['projects'],
          parameters: params({ key: 'Project key' }),
          responses: ok('Version[]'),
        }),
      },
      '/rest/api/2/issueLinkType': {
        get: op({ summary: 'List issue link types', tags: ['issues'], responses: ok('{issueLinkTypes[]}') }),
      },
      '/rest/api/2/issueLink': {
        post: op({
          summary: 'Link two issues — dryRun=true validates + previews',
          tags: ['issues'],
          requestBody: body(issueLinkSchema, {
            type: { name: 'Blocks' },
            outwardIssue: { key: 'TF-1' },
            inwardIssue: { key: 'TF-2' },
          }),
          responses: { '201': { description: 'Linked' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/issueLink/{id}': {
        delete: op({
          summary: 'Remove issue link',
          tags: ['issues'],
          parameters: params({ id: 'Link id' }),
          responses: { '204': { description: 'Removed' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/issue/{key}/watchers': {
        get: op({
          summary: 'List watchers',
          tags: ['issues'],
          parameters: params({ key: 'Issue key' }),
          responses: ok('{self,isWatching,watchCount,watchers[]}'),
        }),
        post: op({
          summary: 'Add watcher (self or admin) — dryRun=true previews target',
          tags: ['issues'],
          parameters: params({ key: 'Issue key' }),
          responses: { '204': { description: 'Watching' }, ...JIRA_ERR },
        }),
        delete: op({
          summary: 'Remove watcher (?username=|?accountId=, self default)',
          tags: ['issues'],
          parameters: params({ key: 'Issue key' }),
          responses: { '204': { description: 'Unwatched' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/issue/{key}/votes': {
        get: op({
          summary: 'List voters + hasVoted',
          tags: ['issues'],
          parameters: params({ key: 'Issue key' }),
          responses: ok('{self,votes,hasVoted,voters[]}'),
        }),
        post: op({
          summary: 'Vote (idempotent)',
          tags: ['issues'],
          parameters: params({ key: 'Issue key' }),
          responses: { '204': { description: 'Voted' }, ...JIRA_ERR },
        }),
        delete: op({
          summary: 'Remove own vote',
          tags: ['issues'],
          parameters: params({ key: 'Issue key' }),
          responses: { '204': { description: 'Vote removed' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/issue/{key}/remotelink': {
        get: op({
          summary: 'List remote issue links',
          tags: ['issues'],
          parameters: params({ key: 'Issue key' }),
          responses: ok('RemoteLink[]'),
        }),
        post: op({
          summary: 'Create remote link {object:{url,title}}',
          tags: ['issues'],
          parameters: params({ key: 'Issue key' }),
          responses: { '201': { description: 'RemoteLink' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/issue/{key}/remotelink/{linkId}': {
        delete: op({
          summary: 'Delete remote link',
          tags: ['issues'],
          parameters: params({ key: 'Issue key', linkId: 'Link id' }),
          responses: { '204': { description: 'Deleted' }, ...JIRA_ERR },
        }),
      },
      '/api/internal/issues/{key}/clone': {
        post: op({
          summary: 'Clone issue (TF ext) — dryRun supported; options carry links/subtasks/attachments/watchers/votes',
          tags: ['issues'],
          parameters: params({ key: 'Issue key' }),
          responses: { '201': { description: '{key,issue}' }, ...JIRA_ERR },
        }),
      },
      '/api/internal/issues/{key}/move': {
        post: op({
          summary: 'Move issue to another project (TF ext) — dryRun previews key/drops; commit re-keys + IssueKeyAlias',
          tags: ['issues'],
          parameters: params({ key: 'Issue key' }),
          responses: ok('{oldKey,key,dropped}'),
        }),
      },
      '/api/internal/bulk/{op}': {
        post: op({
          summary:
            'Bulk op (TF ext) — edit|transition|move|delete|comment|watch|link; {issueKeys|jql, payload, dryRun} → jobId + per-item plan',
          tags: ['bulk'],
          responses: { '202': { description: '{jobId,total,plan}' }, ...JIRA_ERR },
        }),
      },
      '/api/internal/bulk/job/{jobId}': {
        get: op({
          summary: 'Bulk job status + per-item results (TF ext)',
          tags: ['bulk'],
          parameters: params({ jobId: 'Job id' }),
          responses: ok('BulkJob'),
        }),
      },
      '/api/internal/bulk/job/{jobId}/retry': {
        post: op({
          summary: 'Retry failed items of a bulk job (TF ext)',
          tags: ['bulk'],
          parameters: params({ jobId: 'Job id' }),
          responses: { '202': { description: '{jobId,total,plan}' }, ...JIRA_ERR },
        }),
      },
      '/api/internal/export/issues': {
        get: op({
          summary: 'Export issue list (TF ext) — ?jql=&format=csv|print&columns=; permission/JQL identical to /search',
          tags: ['bulk'],
          responses: ok('text/csv | text/html'),
        }),
      },
      '/api/internal/export/issue/{key}': {
        get: op({
          summary: 'Print-friendly single issue (TF ext) — ?format=print',
          tags: ['bulk'],
          parameters: params({ key: 'Issue key' }),
          responses: ok('text/html'),
        }),
      },
      '/rest/api/2/issue/{key}/editmeta': {
        get: op({
          summary: 'Editable fields + allowed values',
          tags: ['meta'],
          parameters: params({ key: 'Issue key' }),
          responses: ok('editmeta'),
        }),
      },
      '/rest/api/2/issue/{key}/changelog': {
        get: op({
          summary: 'Issue change history',
          tags: ['issues'],
          parameters: [
            ...params({ key: 'Issue key' }),
            ...queries({
              startAt: { type: 'integer', description: 'offset' },
              maxResults: { type: 'integer', description: 'page size ≤100' },
            }),
          ],
          responses: ok('{startAt,maxResults,total,histories[]}'),
        }),
      },
      '/rest/api/2/issue/{key}/assignee': {
        put: op({
          summary: 'Assign issue',
          tags: ['issues'],
          parameters: params({ key: 'Issue key' }),
          requestBody: body(assigneeBodySchema, { accountId: 'user-uuid' }),
          description:
            'Body: `{accountId}` or `{name}` (resolved by displayName/email); `null` or `{name:"-1"}` unassigns. ' +
            IDEM.description,
          responses: { '204': { description: 'Assigned' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/issue/{key}/transitions': {
        get: op({
          summary: 'List available transitions',
          tags: ['issues'],
          parameters: params({ key: 'Issue key' }),
          responses: ok('{transitions[]}'),
        }),
        post: op({
          summary: 'Execute transition',
          tags: ['issues'],
          parameters: params({ key: 'Issue key' }),
          requestBody: body(transitionIssueSchema, {
            transition: { id: 'transition-uuid' },
            fields: { resolution: { name: 'Done' } },
            update: { comment: [{ add: { body: 'closing' } }] },
          }),
          description:
            'Transition ids come from GET (stable, workflow-defined — no longer status ids). Screen fields via `fields`; comment via `update.comment[].add`. ' +
            IDEM.description,
          responses: { '204': { description: 'Transitioned' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/search': {
        get: op({
          summary: 'JQL search',
          tags: ['search'],
          parameters: queries({
            jql: { description: 'Full JQL — see contracts/jql.md (project clause optional)', required: true },
            startAt: { type: 'integer', description: 'offset' },
            maxResults: { type: 'integer', description: 'page size ≤100' },
            fields: { description: 'Comma-separated field ids' },
            expand: { description: 'changelog,names,schema' },
          }),
          responses: ok('{startAt,maxResults,total,issues[]}'),
        }),
        post: op({
          summary: 'JQL search (body form)',
          tags: ['search'],
          requestBody: body(searchRequestSchema),
          responses: ok('{startAt,maxResults,total,issues[]}'),
        }),
      },
      '/rest/api/2/user': {
        get: op({
          summary: 'Get user by accountId',
          tags: ['users'],
          parameters: queries({ accountId: { required: true, description: 'User id' } }),
          responses: ok('Jira user'),
        }),
      },
      '/rest/api/2/user/search': {
        get: op({
          summary: 'Search users',
          tags: ['users'],
          parameters: queries({ query: { description: 'name/email substring' } }),
          responses: ok('Jira user array'),
        }),
      },
      '/rest/api/2/user/assignable/search': {
        get: op({
          summary: 'Assignable users for a project',
          tags: ['users'],
          parameters: queries({
            project: { required: true, description: 'Project key' },
            query: { description: 'name/email substring' },
          }),
          responses: ok('Jira user array'),
        }),
      },
      '/rest/agile/1.0/board': {
        get: op({
          summary: 'List boards (persisted, one per project)',
          tags: ['agile'],
          parameters: queries({ projectKeyOrId: { description: 'Project key' } }),
          responses: ok('{values[boards]}'),
        }),
      },
      '/rest/agile/1.0/board/{boardId}': {
        get: op({
          summary: 'Get a board (id, or legacy project key)',
          tags: ['agile'],
          parameters: params({ boardId: 'Board id or project key' }),
          responses: ok('board'),
        }),
      },
      '/rest/agile/1.0/board/{boardId}/configuration': {
        get: op({
          summary: 'Board column config incl. unmapped statuses + WIP limits',
          tags: ['agile'],
          parameters: params({ boardId: 'Board id' }),
          responses: ok('configuration'),
        }),
        put: op({
          summary: 'Replace column↔status mapping (TF ext)',
          tags: ['agile'],
          parameters: params({ boardId: 'Board id' }),
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } } } },
          responses: ok('configuration'),
        }),
      },
      '/rest/agile/1.0/board/{boardId}/issue': {
        get: op({
          summary: 'Issues on board (active sprint)',
          tags: ['agile'],
          parameters: params({ boardId: 'Board id' }),
          responses: ok('{issues[]}'),
        }),
      },
      '/rest/agile/1.0/board/{boardId}/sprint': {
        get: op({
          summary: 'Sprints for a board',
          tags: ['agile'],
          parameters: params({ boardId: 'Board id' }),
          responses: ok('{values[sprints]}'),
        }),
      },
      '/rest/agile/1.0/sprint': {
        post: op({
          summary: 'Create sprint',
          tags: ['agile'],
          requestBody: body(createSprintSchema),
          responses: { '201': { description: 'Created sprint' } },
        }),
      },
      '/rest/agile/1.0/sprint/{sprintId}': {
        get: op({
          summary: 'Get a sprint',
          tags: ['agile'],
          parameters: params({ sprintId: 'Sprint id' }),
          responses: ok('sprint'),
        }),
        put: op({
          summary: 'Update sprint (start/close/rename/goal)',
          tags: ['agile'],
          parameters: params({ sprintId: 'Sprint id' }),
          requestBody: body(updateSprintSchema),
          responses: { '200': { description: 'Updated sprint' } },
        }),
        post: op({
          summary: 'Update sprint (start/close/rename)',
          tags: ['agile'],
          parameters: params({ sprintId: 'Sprint id' }),
          requestBody: body(updateSprintSchema),
          responses: { '200': { description: 'Updated sprint' } },
        }),
        delete: op({
          summary: 'Delete a future sprint (issues → backlog)',
          tags: ['agile'],
          parameters: params({ sprintId: 'Sprint id' }),
          responses: { '204': { description: 'Deleted' } },
        }),
      },
      '/rest/agile/1.0/board/{boardId}/backlog': {
        get: op({
          summary: 'Backlog issues (scrum boards, rank order)',
          tags: ['agile'],
          parameters: params({ boardId: 'Board id' }),
          responses: ok('{issues[]}'),
        }),
      },
      '/rest/agile/1.0/board/{boardId}/type': {
        put: op({
          summary: 'Switch board type scrum↔kanban (TF ext)',
          tags: ['agile'],
          extension: true,
          parameters: params({ boardId: 'Board id' }),
          requestBody: body(boardTypeSchema),
          responses: ok('board'),
        }),
      },
      '/rest/agile/1.0/epic/{key}': {
        get: op({
          summary: 'Get an epic',
          tags: ['agile'],
          parameters: params({ key: 'Epic issue key' }),
          responses: ok('epic'),
        }),
      },
      '/rest/agile/1.0/epic/none/issue': {
        post: op({
          summary: 'Remove issues from their epic',
          tags: ['agile'],
          requestBody: body(issueKeysSchema),
          responses: { '204': { description: 'Moved' } },
        }),
      },
      '/rest/agile/1.0/epic/{key}/issue': {
        get: op({
          summary: 'Issues in an epic',
          tags: ['agile'],
          parameters: params({ key: 'Epic issue key or "none"' }),
          responses: ok('{issues[]}'),
        }),
        post: op({
          summary: 'Move issues to an epic (key=none removes)',
          tags: ['agile'],
          parameters: params({ key: 'Epic issue key or "none"' }),
          requestBody: body(issueKeysSchema),
          responses: { '204': { description: 'Moved' } },
        }),
      },
      '/rest/agile/1.0/sprint/{sprintId}/issue': {
        get: op({
          summary: 'Issues in a sprint',
          tags: ['agile'],
          parameters: params({ sprintId: 'Sprint id' }),
          responses: ok('{issues[]}'),
        }),
        post: op({
          summary: 'Move issues to sprint',
          tags: ['agile'],
          parameters: params({ sprintId: 'Sprint id' }),
          requestBody: body(issueKeysSchema),
          responses: { '204': { description: 'Moved' } },
        }),
      },
      '/rest/agile/1.0/issue/rank': {
        put: op({
          summary: 'Rank issues (LexoRank) — dryRun=true previews the op',
          tags: ['agile'],
          requestBody: {
            required: true,
            content: {
              'application/json': { schema: { type: 'object', example: { issues: ['TF-1'], rankAfterIssue: 'TF-3' } } },
            },
          },
          responses: ok('{movedIssues[]}'),
        }),
      },
      '/rest/agile/1.0/backlog/issue': {
        post: op({
          summary: 'Move issues to backlog',
          tags: ['agile'],
          requestBody: body(issueKeysSchema),
          responses: { '204': { description: 'Moved' } },
        }),
      },
      '/rest/agile/1.0/issue/{issueKey}': {
        get: op({
          summary: 'Issue (agile view — same shape as /rest/api/2/issue)',
          tags: ['agile'],
          parameters: params({ issueKey: 'Issue key' }),
          responses: ok('issue'),
        }),
      },
      // --- Sprint 015: permissions core ---
      '/rest/api/2/group': {
        get: op({
          summary: 'Get group by name (admin)',
          tags: ['permissions'],
          parameters: queries({ groupname: { required: true, description: 'Group name' } }),
          responses: ok('{name,self,users:{size}}'),
        }),
        post: op({
          summary: 'Create group (admin)',
          tags: ['permissions'],
          responses: { '201': { description: 'Created group' }, ...JIRA_ERR },
        }),
        put: op({
          summary: 'Update group policy flags {requireTotp} (admin) — TrackForge divergence',
          tags: ['permissions'],
          parameters: queries({ groupname: { required: true, description: 'Group name' } }),
          responses: ok('{name,requireTotp}'),
        }),
        delete: op({
          summary: 'Delete group (admin) — dryRun lists dependents',
          tags: ['permissions'],
          parameters: queries({ groupname: { required: true, description: 'Group name' } }),
          responses: { '204': { description: 'Deleted' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/groups/picker': {
        get: op({
          summary: 'List/search groups (admin) — 021 admin console',
          tags: ['permissions'],
          parameters: queries({
            query: { description: 'name substring' },
            startAt: { type: 'integer', description: 'offset' },
            maxResults: { type: 'integer', description: 'page size (cap 1000)' },
          }),
          responses: ok('{groups:[{name,memberCount}],total} — total = matching groups, not page size'),
        }),
      },
      '/rest/api/2/group/member': {
        get: op({
          summary: 'Page group members (admin); ?query= filters by name/email (extension)',
          tags: ['permissions'],
          parameters: queries({
            groupname: { required: true, description: 'Group name' },
            startAt: { type: 'integer', description: 'offset' },
            maxResults: { type: 'integer', description: 'page size' },
            query: { type: 'string', description: 'Member filter — displayName/email contains (extension)' },
          }),
          responses: ok('{startAt,maxResults,total,values[]}'),
        }),
      },
      '/rest/api/2/group/user': {
        post: op({
          summary: 'Add user to group (admin)',
          tags: ['permissions'],
          parameters: queries({ groupname: { required: true, description: 'Group name' } }),
          responses: { '201': { description: 'Added' }, ...JIRA_ERR },
        }),
        delete: op({
          summary: 'Remove user from group (admin)',
          tags: ['permissions'],
          parameters: queries({
            groupname: { required: true, description: 'Group name' },
            accountId: { description: 'User id (or username)' },
          }),
          responses: { '204': { description: 'Removed' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/role': {
        get: op({
          summary: 'List project roles (names only — Jira restricts to admin; kept readable for share pickers)',
          tags: ['permissions'],
          responses: ok('role array'),
        }),
        post: op({
          summary: 'Create project role (admin)',
          tags: ['permissions'],
          responses: { '201': { description: 'Created role' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/role/{id}': {
        get: op({
          summary: 'Get project role',
          tags: ['permissions'],
          parameters: params({ id: 'Role id' }),
          responses: ok('role'),
        }),
        put: op({
          summary: 'Update project role (admin)',
          tags: ['permissions'],
          parameters: params({ id: 'Role id' }),
          responses: ok('role'),
        }),
        delete: op({
          summary: 'Delete project role (admin)',
          tags: ['permissions'],
          parameters: params({ id: 'Role id' }),
          responses: { '204': { description: 'Deleted' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/project/{key}/role': {
        get: op({
          summary: 'Role→actors-URL map for the project (project admin)',
          tags: ['permissions'],
          parameters: params({ key: 'Project key' }),
          responses: ok('{RoleName: url}'),
        }),
      },
      '/rest/api/2/project/{key}/role/{id}': {
        get: op({
          summary: 'List actors of a role in the project (project admin)',
          tags: ['permissions'],
          parameters: params({ key: 'Project key', id: 'Role id' }),
          responses: ok('{id,name,actors[]}'),
        }),
        post: op({
          summary: 'Add actors {user:[accountId], group:[name]} (project admin)',
          tags: ['permissions'],
          parameters: params({ key: 'Project key', id: 'Role id' }),
          responses: ok('updated actors'),
        }),
        put: op({
          summary: 'Replace all actors of the role (project admin)',
          tags: ['permissions'],
          parameters: params({ key: 'Project key', id: 'Role id' }),
          responses: ok('updated actors'),
        }),
        delete: op({
          summary: 'Remove one actor ?user=|?group= (project admin)',
          tags: ['permissions'],
          parameters: params({ key: 'Project key', id: 'Role id' }),
          responses: { '204': { description: 'Removed' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/permissionscheme': {
        get: op({
          summary: 'List permission schemes (admin) (?expand=permissions)',
          tags: ['permissions'],
          responses: ok('{permissionSchemes[]}'),
        }),
        post: op({
          summary: 'Create permission scheme (admin)',
          tags: ['permissions'],
          responses: { '201': { description: 'Created scheme' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/permissionscheme/{id}': {
        get: op({
          summary: 'Get scheme (admin) (?expand=permissions)',
          tags: ['permissions'],
          parameters: params({ id: 'Scheme id' }),
          responses: ok('scheme'),
        }),
        put: op({
          summary: 'Update scheme (admin)',
          tags: ['permissions'],
          parameters: params({ id: 'Scheme id' }),
          responses: ok('scheme'),
        }),
        delete: op({
          summary: 'Delete scheme (admin) — in-use projects reassign to default; dryRun previews',
          tags: ['permissions'],
          parameters: params({ id: 'Scheme id' }),
          responses: { '204': { description: 'Deleted' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/permissionscheme/{id}/permission': {
        get: op({
          summary: 'List grants (admin)',
          tags: ['permissions'],
          parameters: params({ id: 'Scheme id' }),
          responses: ok('{permissions[]}'),
        }),
        post: op({
          summary: 'Add grant {permission, holder:{type,parameter}} (admin)',
          tags: ['permissions'],
          parameters: params({ id: 'Scheme id' }),
          responses: { '201': { description: 'Created grant' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/permissionscheme/{id}/permission/preview': {
        post: op({
          summary: 'Grant-impact preview: direct reachable-user count per holder (021)',
          tags: ['permissions'],
          responses: ok('{holder,projects[],directUserCount,dynamic,detail}'),
        }),
      },
      '/rest/api/2/permissionscheme/{id}/permission/{permissionId}': {
        delete: op({
          summary: 'Delete grant (admin)',
          tags: ['permissions'],
          parameters: params({ id: 'Scheme id', permissionId: 'Grant id' }),
          responses: { '204': { description: 'Deleted' }, ...JIRA_ERR },
        }),
      },
      '/rest/api/2/project/{key}/permissionscheme': {
        get: op({
          summary: 'Scheme assigned to the project (project admin)',
          tags: ['permissions'],
          parameters: params({ key: 'Project key' }),
          responses: ok('scheme'),
        }),
        put: op({
          summary: 'Assign scheme to project (project admin) — dryRun previews impact',
          tags: ['permissions'],
          parameters: params({ key: 'Project key' }),
          responses: ok('scheme'),
        }),
      },
      '/rest/api/2/mypermissions': {
        get: op({
          summary: 'My permissions for a project or issue',
          tags: ['permissions'],
          parameters: queries({
            permissions: { required: true, description: 'Comma-separated permission keys' },
            projectKey: { description: 'Project key' },
            issueKey: { description: 'Issue key' },
          }),
          responses: ok('{permissions:{PERM:{havePermission}}}'),
        }),
      },
      '/api/internal/ai/sprints/{boardId}/scope': {
        post: op({
          summary: 'AI sprint scope suggestion (advisory only)',
          tags: ['ai'],
          extension: true,
          parameters: params({ boardId: 'Board id or project key' }),
          responses: ok('{suggested, unestimated, blocked}'),
        }),
      },
      '/api/internal/auth/login': {
        post: op({
          summary: 'Log in (session cookie)',
          tags: ['auth'],
          extension: true,
          requestBody: body(loginSchema, { email: 'admin@x', password: '…' }),
          responses: { '200': { description: 'User object + tf_session cookie' } },
        }),
      },
      '/api/internal/auth/logout': {
        post: op({
          summary: 'Log out',
          tags: ['auth'],
          extension: true,
          responses: { '204': { description: 'Logged out' } },
        }),
      },
      '/api/internal/auth/whoami': {
        get: op({
          summary: 'Principal info: scopes, allow-list, channel',
          tags: ['auth'],
          extension: true,
          responses: ok('{user,scopes,allowedProjects,channel,token}'),
        }),
      },
      '/api/internal/admin/users': {
        get: op({
          summary:
            'Paginated admin user directory ?status=&type=&group=&query=&startAt=&maxResults= — PageBean with groups + directory columns',
          tags: ['admin'],
          extension: true,
          responses: ok('{startAt,maxResults,total,isLast,values[user+isAdmin+lastLoginAt+groups+directory]}'),
        }),
      },
      '/api/internal/users': {
        get: op({ summary: 'List users (admin)', tags: ['admin'], extension: true, responses: ok('user array') }),
        post: op({
          summary: 'Create user/agent (admin)',
          tags: ['admin'],
          extension: true,
          requestBody: body(createUserSchema),
          responses: { '201': { description: 'Created user' } },
        }),
      },
      '/api/internal/users/{accountId}': {
        put: op({
          summary: 'Update user (admin)',
          tags: ['admin'],
          extension: true,
          parameters: params({ accountId: 'User id' }),
          responses: ok('user'),
        }),
        patch: op({
          summary: 'Patch user — active flag, password reset (admin)',
          tags: ['admin'],
          extension: true,
          parameters: params({ accountId: 'User id' }),
          responses: ok('user'),
        }),
      },
      '/api/internal/users/{accountId}/tokens': {
        get: op({
          summary: "List a user's tokens (admin)",
          tags: ['admin'],
          extension: true,
          parameters: params({ accountId: 'User id' }),
          responses: ok('token array'),
        }),
        post: op({
          summary:
            "Mint a PAT for another account (admin) — agents can't session-login, so their first token is issued this way; secret returned once",
          tags: ['admin'],
          extension: true,
          parameters: params({ accountId: 'User id' }),
          requestBody: body(createTokenSchema, {
            name: 'agent-ci',
            scopes: ['read', 'write'],
            projectKeys: ['TF'],
            approvalPolicy: 'never',
          }),
          responses: ok('token + one-time secret', 201),
        }),
      },
      '/api/internal/users/{accountId}/profile': {
        get: op({
          summary: 'Public user profile — identity, preferences, open assigned issues per project, recent comments',
          tags: ['users'],
          extension: true,
          parameters: params({ accountId: 'User id' }),
          responses: ok('{user, openIssuesByProject[], recentComments[]}'),
        }),
      },
      '/api/internal/people': {
        get: op({
          summary:
            'People directory — paginated user roster with server-computed open-issue counts ?query=&startAt=&maxResults=',
          tags: ['users'],
          extension: true,
          responses: ok('{startAt,maxResults,total,isLast,values[user+openIssueCount]}'),
        }),
      },
      '/api/internal/tokens': {
        get: op({
          summary: 'List my tokens',
          tags: ['tokens'],
          extension: true,
          responses: ok('token array (no secrets)'),
        }),
        post: op({
          summary: 'Create PAT — secret returned once',
          tags: ['tokens'],
          extension: true,
          requestBody: body(createTokenSchema, { name: 'ci', scopes: ['read', 'write'], projectKeys: ['TF'] }),
          responses: { '201': { description: 'Token + secret (once)' } },
        }),
      },
      '/api/internal/tokens/{id}': {
        delete: op({
          summary: 'Revoke token',
          tags: ['tokens'],
          extension: true,
          parameters: params({ id: 'Token id' }),
          responses: { '204': { description: 'Revoked' } },
        }),
      },
      '/api/internal/admin/tokens': {
        get: op({
          summary: 'All tokens joined with owner — admin aggregate, replaces per-user fan-out (admin)',
          tags: ['admin'],
          extension: true,
          responses: ok('token array with owner fields'),
        }),
      },
      '/api/internal/workflows': {
        get: op({
          summary: 'List workflows (full definitions)',
          tags: ['admin'],
          extension: true,
          responses: ok('workflow array'),
        }),
        post: op({
          summary: 'Create workflow (admin)',
          tags: ['admin'],
          extension: true,
          responses: { '201': { description: 'Created workflow' } },
        }),
      },
      '/api/internal/workflows/{id}': {
        get: op({
          summary: 'Get workflow',
          tags: ['admin'],
          extension: true,
          parameters: params({ id: 'Workflow id or name' }),
          responses: ok('workflow'),
        }),
        put: op({
          summary: 'Replace workflow (admin)',
          tags: ['admin'],
          extension: true,
          parameters: params({ id: 'Workflow id' }),
          responses: ok('workflow'),
        }),
        delete: op({
          summary: 'Delete workflow (admin) — refused while bound',
          tags: ['admin'],
          extension: true,
          parameters: params({ id: 'Workflow id' }),
          responses: { '204': { description: 'Deleted' } },
        }),
      },
      '/api/internal/projects/{key}/workflow': {
        post: op({
          summary: 'Assign workflow to project with status mapping',
          tags: ['admin'],
          extension: true,
          parameters: params({ key: 'Project key' }),
          responses: ok('{workflow,remappedIssues}'),
        }),
      },
      '/api/internal/audit': {
        get: op({
          summary: 'Security audit log — filterable, format=csv export (admin)',
          tags: ['admin'],
          extension: true,
          parameters: queries({
            startAt: { type: 'integer', description: 'offset' },
            maxResults: { type: 'integer', description: 'page size ≤1000' },
            actorId: { type: 'string', description: 'filter by actor account id' },
            action: { type: 'string', description: 'filter by action substring (case-insensitive)' },
            entityType: { type: 'string', description: 'filter by entity type' },
            entityId: { type: 'string', description: 'filter by entity id' },
            from: { type: 'string', description: 'ISO date lower bound' },
            to: { type: 'string', description: 'ISO date upper bound' },
            format: { type: 'string', description: 'csv → text/csv export of filtered page' },
          }),
          responses: ok('{total,events[]} | text/csv'),
        }),
      },
      '/api/internal/audit/actions': {
        get: op({
          summary: 'Distinct audit action names — feeds the Action filter datalist (admin)',
          tags: ['admin'],
          extension: true,
          responses: ok('{actions: string[]}'),
        }),
      },
      '/rest/api/2/jql/parse': {
        post: op({
          summary: 'Validate JQL without executing (Jira Cloud)',
          tags: ['search'],
          requestBody: body(jqlParseSchema, { queries: ['project = TF AND status != Done'] }),
          responses: ok('{queries: [{query,structure|errors}]}'),
        }),
      },
      '/rest/api/2/jql/autocompletedata': {
        get: op({
          summary: 'JQL autocomplete field/function metadata',
          tags: ['search'],
          responses: ok('{visibleFieldNames,visibleFunctionNames,jqlReservedWords}'),
        }),
      },
      '/rest/api/2/jql/autocompletedata/suggestions': {
        get: op({
          summary: 'JQL value suggestions for a field',
          tags: ['search'],
          parameters: queries({
            fieldName: { required: true, description: 'e.g. status' },
            fieldValue: { description: 'prefix to match' },
          }),
          responses: ok('{results: [{value,displayName}]}'),
        }),
      },
      '/rest/api/2/filter': {
        post: op({
          summary: 'Create saved filter',
          tags: ['filters'],
          requestBody: body(createFilterSchema, {
            name: 'My open issues',
            jql: 'assignee = currentUser() AND statusCategory != Done',
          }),
          responses: { '201': { description: 'Jira filter' } },
        }),
      },
      '/rest/api/2/filter/my': {
        get: op({ summary: "Caller's own filters", tags: ['filters'], responses: ok('Jira filter[]') }),
      },
      '/rest/api/2/filter/favourite': {
        get: op({ summary: "Caller's starred filters", tags: ['filters'], responses: ok('Jira filter[]') }),
      },
      '/rest/api/2/filter/favorite': {
        get: op({
          summary: "Caller's starred filters (US spelling)",
          tags: ['filters'],
          responses: ok('Jira filter[]'),
        }),
      },
      '/rest/api/2/filter/search': {
        get: op({
          summary: 'Visible filters (own + shared + starred)',
          tags: ['filters'],
          parameters: queries({ filterName: { description: 'name substring' } }),
          responses: ok('Jira filter[]'),
        }),
      },
      '/rest/api/2/filter/{id}': {
        get: op({
          summary: 'Get a filter',
          tags: ['filters'],
          parameters: params({ id: 'Filter id' }),
          responses: ok('Jira filter'),
        }),
        put: op({
          summary: 'Update a filter (owner only)',
          tags: ['filters'],
          parameters: params({ id: 'Filter id' }),
          requestBody: body(filterSchema, {}),
          responses: ok('Jira filter'),
        }),
        delete: op({
          summary: 'Delete a filter (owner only)',
          tags: ['filters'],
          parameters: params({ id: 'Filter id' }),
          responses: { '204': { description: 'Deleted' } },
        }),
      },
      '/rest/api/2/filter/{id}/run': {
        get: op({
          summary: 'Execute a saved filter (TF ext)',
          tags: ['filters'],
          extension: true,
          parameters: params({ id: 'Filter id' }),
          responses: ok('{startAt,maxResults,total,issues[]}'),
        }),
      },
      '/rest/api/2/filter/{id}/favourite': {
        put: op({
          summary: 'Star a filter (TF ext)',
          tags: ['filters'],
          extension: true,
          parameters: params({ id: 'Filter id' }),
          responses: ok('Jira filter'),
        }),
        delete: op({
          summary: 'Unstar a filter (TF ext)',
          tags: ['filters'],
          extension: true,
          parameters: params({ id: 'Filter id' }),
          responses: ok('Jira filter'),
        }),
      },
      '/rest/api/2/dashboard': {
        get: op({ summary: 'Dashboards visible to the caller', tags: ['dashboards'], responses: ok('{dashboards[]}') }),
        post: op({
          summary: 'Create a dashboard',
          tags: ['dashboards'],
          requestBody: body(z.record(z.any()), { name: 'Team Wall', sharePermissions: [{ type: 'loggedin' }] }),
          responses: { '201': { description: 'Dashboard' } },
        }),
      },
      '/rest/api/2/dashboard/search': {
        get: op({
          summary: 'Search dashboards',
          tags: ['dashboards'],
          parameters: queries({
            dashboardName: { description: 'name substring' },
            owner: { description: 'owner name substring' },
          }),
          responses: ok('{values[],total,isLast}'),
        }),
      },
      '/rest/api/2/dashboard/gadgets': {
        get: op({
          summary: 'Available gadget types',
          tags: ['dashboards'],
          responses: ok('{gadgets[{type,title,configFields[]}]}'),
        }),
      },
      '/rest/api/2/dashboard/{id}': {
        get: op({
          summary: 'Get a dashboard (incl. gadgets + permissions)',
          tags: ['dashboards'],
          parameters: params({ id: 'Dashboard id' }),
          responses: ok('Dashboard'),
        }),
        put: op({
          summary: 'Update a dashboard',
          tags: ['dashboards'],
          parameters: params({ id: 'Dashboard id' }),
          requestBody: body(z.record(z.any()), { name: 'Renamed' }),
          responses: ok('Dashboard'),
        }),
        delete: op({
          summary: 'Delete a dashboard (owner/admin)',
          tags: ['dashboards'],
          parameters: params({ id: 'Dashboard id' }),
          responses: { '204': { description: 'Deleted' } },
        }),
      },
      '/rest/api/2/dashboard/{id}/copy': {
        post: op({
          summary: 'Copy a dashboard (private to copier)',
          tags: ['dashboards'],
          parameters: params({ id: 'Dashboard id' }),
          requestBody: body(z.record(z.any()), { name: 'Optional name' }),
          responses: { '201': { description: 'Dashboard' } },
        }),
      },
      '/rest/api/2/dashboard/{id}/gadget': {
        post: op({
          summary: 'Add a gadget',
          tags: ['dashboards'],
          parameters: params({ id: 'Dashboard id' }),
          requestBody: body(z.record(z.any()), { type: 'assigned-to-me', config: { maxResults: 10 }, column: 0 }),
          responses: { '201': { description: 'Gadget' } },
        }),
      },
      '/rest/api/2/dashboard/{id}/gadget/{gid}': {
        put: op({
          summary: 'Update/reposition a gadget',
          tags: ['dashboards'],
          parameters: params({ id: 'Dashboard id', gid: 'Gadget id' }),
          requestBody: body(z.record(z.any()), { position: 1 }),
          responses: ok('Gadget'),
        }),
        delete: op({
          summary: 'Remove a gadget',
          tags: ['dashboards'],
          parameters: params({ id: 'Dashboard id', gid: 'Gadget id' }),
          responses: { '204': { description: 'Deleted' } },
        }),
      },
      '/api/internal/dashboards/{id}/data': {
        get: op({
          summary: 'Aggregate gadget data (TF ext, viewer-context)',
          tags: ['dashboards'],
          extension: true,
          parameters: params({ id: 'Dashboard id' }),
          responses: ok('{dashboard,gadgets[{gadget,data}]}'),
        }),
      },
      '/api/internal/dashboards/{id}/gadgets/{gid}/data': {
        get: op({
          summary: 'Single gadget data (TF ext, viewer-context)',
          tags: ['dashboards'],
          extension: true,
          parameters: params({ id: 'Dashboard id', gid: 'Gadget id' }),
          responses: ok('{type,title,data}'),
        }),
      },
      '/api/internal/preferences': {
        get: op({ summary: 'User preference map', tags: ['admin'], extension: true, responses: ok('{key: value}') }),
      },
      '/api/internal/preferences/{key}': {
        put: op({
          summary: 'Set a user preference',
          tags: ['admin'],
          extension: true,
          parameters: params({ key: 'e.g. issueTable.columns' }),
          responses: ok('{key: value}'),
        }),
      },
      '/rest/webhooks/1.0/webhook': {
        get: op({ summary: 'List webhooks (admin)', tags: ['webhooks'], responses: ok('{webhookCallbackResponse[]}') }),
        post: op({
          summary: 'Register webhook (admin)',
          tags: ['webhooks'],
          responses: { '201': { description: 'Webhook created' }, ...JIRA_ERR },
        }),
      },
      '/rest/webhooks/1.0/webhook/{id}': {
        get: op({
          summary: 'Get webhook (admin)',
          tags: ['webhooks'],
          parameters: params({ id: 'Webhook id' }),
          responses: ok('webhook'),
        }),
        put: op({
          summary: 'Update webhook (admin)',
          tags: ['webhooks'],
          parameters: params({ id: 'Webhook id' }),
          responses: { '200': { description: 'Updated' }, ...JIRA_ERR },
        }),
        delete: op({
          summary: 'Delete webhook (admin)',
          tags: ['webhooks'],
          parameters: params({ id: 'Webhook id' }),
          responses: { '204': { description: 'Deleted' }, ...JIRA_ERR },
        }),
      },
      '/api/internal/webhooks/{id}/deliveries': {
        get: op({
          summary: 'Webhook delivery log (admin)',
          tags: ['webhooks'],
          extension: true,
          parameters: params({ id: 'Webhook id' }),
          responses: ok('{deliveries[]}'),
        }),
      },
      '/api/internal/webhooks/{id}/deliveries/{deliveryId}/redeliver': {
        post: op({
          summary: 'Requeue a delivery (admin)',
          tags: ['webhooks'],
          extension: true,
          parameters: params({ id: 'Webhook id', deliveryId: 'Delivery id' }),
          responses: { '202': { description: 'Requeued' }, ...JIRA_ERR },
        }),
      },
      '/api/internal/events': {
        get: op({
          summary: 'Cursor event feed (TF ext)',
          tags: ['events'],
          extension: true,
          parameters: queries({
            after: { type: 'integer', description: 'Last seen event id (410 when expired)' },
            types: { description: 'CSV event types' },
            projects: { description: 'CSV project keys' },
            limit: { type: 'integer', description: 'page size ≤500' },
          }),
          responses: ok('{events[],nextCursor,hasMore}'),
        }),
      },
      '/api/internal/events/stream': {
        get: op({
          summary: 'SSE event stream — Last-Event-ID resume, 25s heartbeat (TF ext)',
          tags: ['events'],
          extension: true,
          responses: ok('text/event-stream'),
        }),
      },
      '/api/internal/events/{id}': {
        get: op({
          summary: 'Single event (TF ext)',
          tags: ['events'],
          extension: true,
          parameters: params({ id: 'Event id' }),
          responses: ok('event'),
        }),
      },
      '/api/internal/me/notifications': {
        get: op({
          summary: 'List notifications (TF ext)',
          tags: ['me'],
          extension: true,
          parameters: queries({
            unreadOnly: { type: 'boolean', description: 'unread only' },
            startAt: { type: 'integer', description: 'offset' },
            maxResults: { type: 'integer', description: 'page size ≤100' },
          }),
          responses: ok('{total,unreadCount,notifications[]}'),
        }),
      },
      '/api/internal/me/notifications/read': {
        post: op({
          summary: 'Mark notifications read — {ids[]} or {all:true} (TF ext)',
          tags: ['me'],
          extension: true,
          responses: ok('{marked}'),
        }),
      },
      '/api/internal/me/recent-views': {
        get: op({
          summary: 'Recently viewed issues (TF ext)',
          tags: ['me'],
          extension: true,
          responses: ok('{issues[]}'),
        }),
        post: op({
          summary: 'Record an issue view — {issueKey} (TF ext)',
          tags: ['me'],
          extension: true,
          responses: { '204': { description: 'Recorded' }, ...JIRA_ERR },
        }),
      },
      '/api/internal/me/work': {
        get: op({
          summary: 'Your work — assigned/watching/reported/recent (TF ext)',
          tags: ['me'],
          extension: true,
          responses: ok('{assigned[],watching[],reported[],recent[]}'),
        }),
      },
      '/api/internal/me/timesheet': {
        get: op({
          summary: 'My timesheet — per-day + per-issue logged seconds ?from&to=YYYY-MM-DD (TF ext)',
          tags: ['me'],
          extension: true,
          responses: ok('{totalSec,days,issues[],expectedSec,expectedToDateSec,workdaySec}'),
        }),
      },
      '/api/internal/ai/settings': {
        get: op({
          summary: 'AI provider settings — key never returned (admin)',
          tags: ['ai'],
          extension: true,
          responses: ok(
            '{configured,provider,baseUrl,chatModel,embedModel,speechModel,hasApiKey,dailyLimit,monthlyBudget,promptLogging}'
          ),
        }),
        put: op({
          summary: 'Update AI settings — apiKey is write-only (admin)',
          tags: ['ai'],
          extension: true,
          responses: ok('{configured,hasApiKey}'),
        }),
      },
      '/api/internal/ai/settings/test': {
        post: op({
          summary: 'Test the AI connection (admin)',
          tags: ['ai'],
          extension: true,
          responses: ok('{ok,detail}'),
        }),
      },
      '/api/internal/ai/usage': {
        get: op({
          summary: 'AI usage — month totals + outcomes + per-user today (admin)',
          tags: ['ai'],
          extension: true,
          responses: ok('{month,outcomes,today[]}'),
        }),
      },
      '/api/internal/ai/prompts': {
        get: op({
          summary: 'Prompt log when enabled — secrets redacted (admin)',
          tags: ['ai'],
          extension: true,
          responses: ok('{logs[]}'),
        }),
      },
      '/api/internal/ai/capabilities': {
        get: op({
          summary: 'AI feature flags for UI affordances — configured/embeddings/speech (any user)',
          tags: ['ai'],
          extension: true,
          responses: ok('{configured,embeddings,speech}'),
        }),
      },
      '/api/internal/ai/transcribe': {
        post: op({
          summary:
            'Speech → text via the configured provider /audio/transcriptions (multipart field "file") — requires speechModel (TF ext)',
          tags: ['ai'],
          extension: true,
          requestBody: {
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: { file: { type: 'string', format: 'binary' } },
                  required: ['file'],
                },
              },
            },
          },
          responses: ok('{text,audioSeconds,costUsd}'),
        }),
      },
      '/api/internal/ai/plan': {
        post: op({
          summary:
            'Copilot: instruction → turn (bounded read loop, markdown answer, dry-run write previews, threadId) (TF ext)',
          tags: ['ai'],
          extension: true,
          responses: ok(
            '{planId?,steps[{display}],answer?,threadId,turnId,warnings[]} | {clarify:{question,options[]},threadId,turnId}'
          ),
        }),
      },
      '/api/internal/ai/execute': {
        post: op({
          summary:
            'Copilot: execute confirmed steps — planId required + bound to stored plan; turnId records outcome (TF ext)',
          tags: ['ai'],
          extension: true,
          responses: ok('{results[{ok,skipped,display}]}'),
        }),
      },
      '/api/internal/ai/threads': {
        get: op({
          summary: 'Copilot: list my threads (last 50, owner-only) (TF ext)',
          tags: ['ai'],
          extension: true,
          responses: ok('{threads[{id,title,turns,updatedAt}]}'),
        }),
      },
      '/api/internal/ai/threads/{id}': {
        get: op({
          summary: 'Copilot: load a thread with turns (owner-only) (TF ext)',
          tags: ['ai'],
          extension: true,
          parameters: params({ id: 'Copilot thread id' }),
          responses: ok('{thread:{id,title,turns[{instruction,answer,entities,writesApplied,outcome}]}}'),
        }),
        delete: op({
          summary: 'Copilot: delete a thread (owner-only) (TF ext)',
          tags: ['ai'],
          extension: true,
          parameters: params({ id: 'Copilot thread id' }),
          responses: { '204': { description: 'Deleted' } },
        }),
      },
      '/api/internal/search/aggregate': {
        post: op({
          summary: 'JQL aggregate: total + optional group-by buckets (visibility-scoped) (TF ext)',
          tags: ['search'],
          extension: true,
          responses: ok('{total,groupBy,truncated,buckets[{value,count}]}'),
        }),
      },
      '/api/internal/ai/jql': {
        post: op({
          summary: 'Natural language → validated JQL (TF ext)',
          tags: ['ai'],
          extension: true,
          responses: ok('{jql}'),
        }),
      },
      '/api/internal/ai/issues/draft': {
        post: op({
          summary: 'Draft an issue description (TF ext)',
          tags: ['ai'],
          extension: true,
          responses: ok('{draft}'),
        }),
      },
      '/api/internal/ai/issues/{key}/summary': {
        post: op({
          summary: 'Summarise an issue (TF ext)',
          tags: ['ai'],
          extension: true,
          parameters: params({ key: 'Issue key' }),
          responses: ok('{summary}'),
        }),
      },
      '/api/internal/ai/issues/{key}/draft': {
        post: op({
          summary: 'Draft description for an issue (TF ext)',
          tags: ['ai'],
          extension: true,
          parameters: params({ key: 'Issue key' }),
          responses: ok('{draft}'),
        }),
      },
      '/api/internal/ai/issues/{key}/breakdown': {
        post: op({
          summary: 'Propose epic child stories (TF ext)',
          tags: ['ai'],
          extension: true,
          parameters: params({ key: 'Issue key' }),
          responses: ok('{children[]}'),
        }),
      },
      '/api/internal/ai/issues/{key}/similar': {
        get: op({
          summary: 'Similar issues via embeddings (TF ext)',
          tags: ['ai'],
          extension: true,
          parameters: params({ key: 'Issue key' }),
          responses: ok('{issues[{key,summary,status,score}]}'),
        }),
      },
      '/api/internal/ai/issues/{key}/suggest-resolution': {
        post: op({
          summary:
            'Resolution suggestion from similar resolved issues — closed-set pick, server-computed confidence (TF ext)',
          tags: ['ai'],
          extension: true,
          parameters: params({ key: 'Issue key' }),
          responses: ok('{resolution,confidence,diagnosis,basedOn[],reason}'),
        }),
      },
      '/api/internal/ai/similar': {
        get: op({
          summary: 'Similar issues for free text — create-dialog typeahead (TF ext)',
          tags: ['ai'],
          extension: true,
          parameters: queries({
            text: { description: 'free text' },
            project: { description: 'restrict to project key' },
          }),
          responses: ok('{issues[]}'),
        }),
      },
      '/api/internal/proposals': {
        get: op({
          summary: 'Approvals inbox — pending proposals for review (TF ext)',
          tags: ['proposals'],
          extension: true,
          parameters: queries({
            status: { description: 'pending|approved|rejected|expired|failed' },
            project: { description: 'project key' },
            issue: { description: 'issue key (TF-12) — proposals targeting that issue' },
          }),
          responses: ok('{proposals[],total}'),
        }),
      },
      '/api/internal/proposals/{id}': {
        get: op({
          summary: 'Proposal detail with request + diff (TF ext)',
          tags: ['proposals'],
          extension: true,
          parameters: params({ id: 'Proposal id' }),
          responses: ok('proposal'),
        }),
      },
      '/api/internal/proposals/{id}/approve': {
        post: op({
          summary: 'Approve — re-validates + applies as the agent (TF ext)',
          tags: ['proposals'],
          extension: true,
          parameters: params({ id: 'Proposal id' }),
          responses: ok('{status,result}'),
        }),
      },
      '/api/internal/proposals/{id}/reject': {
        post: op({
          summary: 'Reject with optional reason (TF ext)',
          tags: ['proposals'],
          extension: true,
          parameters: params({ id: 'Proposal id' }),
          responses: ok('{status}'),
        }),
      },
      '/api/internal/proposals/bulk': {
        post: op({
          summary: 'Bulk approve/reject — {ids[], action, reason?} (TF ext)',
          tags: ['proposals'],
          extension: true,
          responses: ok('{results[]}'),
        }),
      },
      '/api/internal/reports/board/{boardId}/velocity': {
        get: op({
          summary: 'Velocity — committed vs completed points per closed sprint (TF ext)',
          tags: ['reports'],
          extension: true,
          parameters: params({ boardId: 'Board id' }),
          responses: ok('{sprints[]}'),
        }),
      },
      '/api/internal/reports/board/{boardId}/burndown': {
        get: op({
          summary: 'Burndown — daily remaining/scope/done points (TF ext)',
          tags: ['reports'],
          extension: true,
          parameters: params({ boardId: 'Board id' }),
          responses: ok('{series[]}'),
        }),
      },
      '/api/internal/reports/board/{boardId}/sprint/{sprintId}/report': {
        get: op({
          summary: 'Sprint report — member issues with points/done/scope-change flags (TF ext)',
          tags: ['reports'],
          extension: true,
          parameters: params({ boardId: 'Board id', sprintId: 'Sprint id' }),
          responses: ok('{issues[]}'),
        }),
      },
      '/api/internal/customfields': {
        get: op({
          summary: 'List custom fields (+contexts/options, includeInactive?) (TF ext)',
          tags: ['customfields'],
          extension: true,
          responses: ok('{fields[], types[]}'),
        }),
        post: op({
          summary: 'Create custom field {name,type,description?,context?} — admin (TF ext)',
          tags: ['customfields'],
          extension: true,
          responses: ok('{field}', 201),
        }),
      },
      '/api/internal/customfields/{id}': {
        get: op({
          summary: 'Get one custom field with contexts/options (TF ext)',
          tags: ['customfields'],
          extension: true,
          parameters: params({ id: 'customfield_NNNNN or alias' }),
          responses: ok('{field}'),
        }),
        put: op({
          summary: 'Update name/description — admin (TF ext)',
          tags: ['customfields'],
          extension: true,
          parameters: params({ id: 'Field id' }),
          responses: ok('{field}'),
        }),
        delete: op({
          summary: 'Soft-delete (?dryRun=true previews affectedIssues) — admin (TF ext)',
          tags: ['customfields'],
          extension: true,
          parameters: params({ id: 'Field id' }),
          responses: ok('', 204),
        }),
      },
      '/api/internal/customfields/{id}/options': {
        get: op({
          summary: 'List options for a field (?project=KEY scopes to context) (TF ext)',
          tags: ['customfields'],
          extension: true,
          parameters: params({ id: 'Field id' }),
          responses: ok('{options[]}'),
        }),
      },
      '/api/internal/customfields/{id}/contexts': {
        post: op({
          summary: 'Add context {isGlobal?,projectKeys?,options?} — admin (TF ext)',
          tags: ['customfields'],
          extension: true,
          parameters: params({ id: 'Field id' }),
          responses: ok('{field}', 201),
        }),
      },
      '/api/internal/customfields/{id}/contexts/{ctxId}': {
        put: op({
          summary: 'Update context options {options[{id?,value,disabled?,children?}]} — admin (TF ext)',
          tags: ['customfields'],
          extension: true,
          parameters: params({ id: 'Field id', ctxId: 'Context id' }),
          responses: ok('{field}'),
        }),
        delete: op({
          summary: 'Remove a context — admin (TF ext)',
          tags: ['customfields'],
          extension: true,
          parameters: params({ id: 'Field id', ctxId: 'Context id' }),
          responses: ok('{field}'),
        }),
      },
      '/api/internal/migration': {
        get: op({
          summary: 'List recent import jobs — admin (TF ext)',
          tags: ['migration'],
          extension: true,
          responses: ok('{jobs[]}'),
        }),
      },
      '/api/internal/migration/jira-cloud': {
        post: op({
          summary:
            'Start staged Jira Cloud import {baseUrl,email,apiToken|secretRef,projectKeys[],dryRun?,deltaFrom?} — 202 job; dryRun writes nothing — admin (TF ext)',
          tags: ['migration'],
          extension: true,
          responses: ok('{job}', 202),
        }),
      },
      '/api/internal/migration/jira-server': {
        post: op({
          summary:
            'Start live Jira Server/DC import {baseUrl,authMode:basic|pat,username?,apiToken|secretRef,projectKeys[],dryRun?,deltaFrom?,fieldAliases?,groups[]?,allowPrivate?,insecureSkipVerify?} — 202 job — admin (TF ext)',
          tags: ['migration'],
          extension: true,
          responses: ok('{job}', 202),
        }),
      },
      '/api/internal/migration/{id}': {
        get: op({
          summary:
            'Import job status: stage, per-entity plan counts, unsupported list, warnings, verify diffs — admin (TF ext)',
          tags: ['migration'],
          extension: true,
          parameters: params({ id: 'Import job id' }),
          responses: ok('{job}'),
        }),
      },
      '/api/internal/migration/{id}/resume': {
        post: op({
          summary: 'Resume a failed/interrupted import — ops are idempotent — admin (TF ext)',
          tags: ['migration'],
          extension: true,
          parameters: params({ id: 'Import job id' }),
          responses: ok('{job}', 202),
        }),
      },
      '/.well-known/oauth-protected-resource/mcp': {
        get: op({
          summary:
            'RFC 9728 protected-resource metadata for the /mcp endpoint — unauthenticated {resource,authorization_servers,bearer_methods_supported,scopes_supported} (TF ext)',
          tags: ['ops'],
          extension: true,
          responses: ok('{resource,authorization_servers,bearer_methods_supported,scopes_supported}'),
        }),
      },
      '/healthz': {
        get: op({
          summary: 'Liveness probe — unauthenticated {status,uptimeSec} (TF ext)',
          tags: ['ops'],
          extension: true,
          responses: ok('{status,uptimeSec}'),
        }),
      },
      '/readyz': {
        get: op({
          summary:
            'Readiness probe — unauthenticated; 200 {status:"ready",checks} or 503 when db/jobs checks fail (TF ext)',
          tags: ['ops'],
          extension: true,
          responses: ok('{status,checks}'),
        }),
      },
      '/metrics': {
        get: op({
          summary:
            'Prometheus text exposition: request counter, latency histogram, job queue depth, outbox gauge — unauthenticated (TF ext)',
          tags: ['ops'],
          extension: true,
          responses: ok('text/plain'),
        }),
      },
      '/llms.txt': {
        get: op({
          summary:
            'Agent onboarding index (text/plain): MCP endpoints, REST base, docs for agents — unauthenticated (TF ext)',
          tags: ['ops'],
          extension: true,
          responses: ok('text/plain'),
        }),
      },
      '/api/internal/admin/jobs': {
        get: op({
          summary: 'List durable jobs, ?state=waiting|active|completed|failed — admin (TF ext)',
          tags: ['ops'],
          extension: true,
          responses: ok('{jobs[]}'),
        }),
      },
      '/api/internal/admin/jobs/{id}': {
        get: op({
          summary: 'Durable job detail: queue, key, state, attempts, payload, error — admin (TF ext)',
          tags: ['ops'],
          extension: true,
          parameters: params({ id: 'Job id' }),
          responses: ok('{job}'),
        }),
      },
      '/api/internal/admin/jobs/{id}/retry': {
        post: op({
          summary: 'Requeue a failed/dead-lettered durable job — 202 — admin (TF ext)',
          tags: ['ops'],
          extension: true,
          parameters: params({ id: 'Job id' }),
          responses: ok('{retried}', 202),
        }),
      },
    },
  } as { paths: Record<string, unknown> };
  // merge the catch-up table — curated literal entries win on collision.
  for (const [p, ops] of Object.entries(catchUp)) {
    doc.paths[p] = { ...((doc.paths[p] as Record<string, unknown>) ?? {}), ...ops };
  }
  return injectV3(doc);
}
