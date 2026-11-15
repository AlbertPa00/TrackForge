import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { TrackForgeClient } from './client.js';
import { asText, boundClient, ToolError, withCallExtras } from './client.js';
import { subscribeStream } from './events.js';

const JQL_HINT =
  'JQL: fields project, key/issue, summary, description, text, comment, status, statusCategory, ' +
  'issuetype, priority, resolution, assignee, reporter, labels, parent, created, updated, resolved, duedate, ' +
  'storypoints, sprint, component, fixversion, affectedversion, timespent, timeestimate, timeoriginalestimate, ' +
  'workratio, worklogdate, billable, votes, watches, security(level), projectcategory(category), filter, ' +
  'plus custom fields by cf[NNNNN]/customfield_NNNNN/bare name (e.g. Flagged). ' +
  'Operators: = != > >= < <= IN NOT IN ~ !~ IS [NOT] EMPTY and history ops WAS/WAS NOT/CHANGED ' +
  '(CHANGED/FROM/TO/BEFORE/AFTER/ON/DURING/BY predicates; WAS/CHANGED on status, priority, resolution, ' +
  'assignee, reporter, fixversion, sprint only). ' +
  'Values: quoted/unquoted strings, numbers, EMPTY, relative dates (-7d, 2w, -1h), functions — ' +
  'user: currentUser(), membersOf("g"), updatedBy(), watchers(), voters(); ' +
  'issue-set: linkedIssues(key[,type]), linkedIssuesOf("type"), subtasksOf(jql), parentsOf(jql), ' +
  'epicsOf(jql), issuesInEpics(jql), hasComments(), ready(), blocked(); ' +
  'date: now(), startOfDay(), endOfDay(), startOfWeek(), endOfWeek(), startOfMonth(), endOfMonth(), ' +
  'currentLogin(), lastLogin()/previousLogin(); ' +
  'sprint/version: openSprints(), closedSprints(), futureSprints(), releasedVersions(), unreleasedVersions(). ' +
  '`filter = "name"` inlines a saved filter honoring its share scope (cycles rejected). ' +
  'Combine with AND OR NOT and parentheses; order with ORDER BY f [ASC|DESC], … ' +
  'Omit the project clause to search all projects your token can see.';

export interface ToolOpts {
  /** When false, write tools are omitted (token without 'write' scope). */
  write?: boolean;
}

// Sprint 056 write parity: idempotency_key + rationale apply to EVERY mutating
// tool (the idempotency middleware and proposal rationale are route-agnostic),
// so they live in a shared fragment instead of per-tool. dry_run stays declared
// per-tool — only where the target route actually honors it.
export const WRITE_EXTRAS = {
  idempotency_key: z
    .string()
    .optional()
    .describe('Replay-safe key; reuse only with an identical request (a different body → 422)'),
  rationale: z
    .string()
    .optional()
    .describe('Why this change — shown to human approvers and recorded in the audit log'),
};

export function registerTools(server: McpServer, opts: ToolOpts = {}) {
  const tf = boundClient(); // 070 — resolves per-request, never capture-bound
  const write = opts.write !== false;
  // Every mutating tool registers through wtool: the schema gets WRITE_EXTRAS
  // merged in and the wrapped tf.call picks the arg values up via
  // withCallExtras — a declared flag can never silently never reach the wire.
  const wtool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: S,
    handler: (a: z.infer<z.ZodObject<S & typeof WRITE_EXTRAS>>) => any
  ) =>
    server.tool(
      name,
      description,
      { ...schema, ...WRITE_EXTRAS } as z.ZodRawShape,
      (async (a: any) =>
        withCallExtras(
          {
            dryRun: a?.dry_run === true || undefined,
            idempotencyKey: a?.idempotency_key,
            rationale: a?.rationale,
          },
          () => handler(a)
        )) as never
    );
  server.tool(
    'whoami',
    'Returns the authenticated TrackForge principal: user identity, auth channel, token scopes and the project allow-list. Call this first to learn what you may access.',
    {},
    async () => asText(await tf.call('GET', '/api/internal/auth/whoami'))
  );

  server.tool(
    'list_projects',
    'Lists all projects visible to your token. Returns Jira project objects {id,key,name,projectTypeKey}.',
    {},
    async () => asText(await tf.call('GET', '/rest/api/2/project'))
  );

  server.tool(
    'get_project',
    'Gets one project by its key (e.g. "TF").',
    { project_key: z.string().describe('Project key, e.g. TF') },
    async ({ project_key }) => asText(await tf.call('GET', `/rest/api/2/project/${project_key.toUpperCase()}`))
  );

  server.tool(
    'get_create_meta',
    'Discovers what you can create: issue types for a project, or (with issue_type_id) the required fields and allowed values (priorities, types, assignee autocomplete URL). Call before create_issue if unsure which values are valid.',
    {
      project_key: z.string().describe('Project key'),
      issue_type_id: z.string().optional().describe('Issue type id — omit to list types first'),
    },
    async ({ project_key, issue_type_id }) =>
      asText(
        await tf.call(
          'GET',
          `/rest/api/2/issue/createmeta/${project_key.toUpperCase()}/issuetypes${issue_type_id ? `/${issue_type_id}` : ''}`
        )
      )
  );

  server.tool(
    'search_issues',
    `Searches issues with JQL and returns a page. ${JQL_HINT} Results are capped (default 20, max 100) — page with start_at. Use fields to keep responses small. Validate first with validate_jql if unsure.`,
    {
      jql: z.string().describe(JQL_HINT),
      fields: z.array(z.string()).optional().describe('Field ids to include, e.g. ["summary","status","assignee"]. Strongly recommended.'),
      start_at: z.number().int().min(0).optional().describe('Offset for pagination (cursor)'),
      max_results: z.number().int().min(1).max(100).optional().describe('Page size, default 20, max 100'),
      expand: z.array(z.enum(['changelog', 'names', 'schema'])).optional(),
    },
    async ({ jql, fields, start_at, max_results, expand }) => {
      const res = await tf.call<{ startAt: number; maxResults: number; total: number; issues: unknown[] }>(
        'GET',
        '/rest/api/2/search',
        {
          query: {
            jql,
            startAt: start_at ?? 0,
            maxResults: Math.min(100, max_results ?? 20),
            fields: fields?.join(','),
            expand: expand?.join(','),
          },
        }
      );
      const nextAt = res.startAt + res.issues.length;
      return asText({ ...res, nextStartAt: nextAt < res.total ? nextAt : null });
    }
  );

  server.tool(
    'search_aggregate',
    `Counts JQL results, optionally grouped into buckets — much cheaper than search_issues for "how many" questions. ${JQL_HINT}`,
    {
      jql: z.string().describe(JQL_HINT),
      group_by: z
        .enum(['status', 'assignee', 'priority', 'issuetype', 'project', 'reporter', 'sprint'])
        .optional()
        .describe('Bucket field, e.g. "status" → counts per status'),
    },
    async ({ jql, group_by }) =>
      asText(
        await tf.call('POST', '/api/internal/search/aggregate', {
          body: { jql, groupBy: group_by },
        })
      )
  );

  server.tool(
    'get_issue',
    'Gets one issue by key (e.g. "TF-3"). Use fields to trim the payload; expand ["changelog"] includes who changed what.',
    {
      issue_key: z.string().describe('Issue key, e.g. TF-3'),
      fields: z.array(z.string()).optional(),
      expand: z.array(z.enum(['changelog', 'names', 'schema'])).optional(),
    },
    async ({ issue_key, fields, expand }) =>
      asText(
        await tf.call('GET', `/rest/api/2/issue/${issue_key.toUpperCase()}`, {
          query: { fields: fields?.join(','), expand: expand?.join(',') },
        })
      )
  );

  if (write) wtool(
    'create_issue',
    'Creates an issue. Reporter is set automatically to you. Set dry_run=true to preview without writing; pass idempotency_key to make retries safe.',
    {
      project_key: z.string().describe('Project key'),
      summary: z.string().describe('One-line summary'),
      description: z.string().optional(),
      issue_type: z.string().optional().describe('Issue type name; default "Task". Discover via get_create_meta.'),
      priority: z.string().optional().describe('Priority name; default "Medium". Allowed: Highest, High, Medium, Low, Lowest.'),
      assignee: z.string().optional().describe('Assignee: accountId or email. Resolve people with find_users.'),
      labels: z.array(z.string()).optional().describe('Label names (no spaces)'),
      due_date: z.string().optional().describe('YYYY-MM-DD'),
      parent_key: z.string().optional().describe('Parent issue key — required for Subtask; Epic for epic children'),
      custom_fields: z.record(z.string(), z.unknown()).optional()
        .describe('Custom field values keyed by customfield_NNNNN or alias (e.g. {"customfield_10004":{"value":"High"},"startdate":"2026-01-01"}). Discover ids + allowed values via list_custom_fields/get_create_meta.'),
      dry_run: z.boolean().optional().describe('Validate + preview only; nothing is persisted'),
      idempotency_key: z.string().optional().describe('Replay-safe key; reuse only with an identical request'),
      rationale: z.string().optional().describe('Why this change — shown to the human approver when your token requires approval'),
    },
    async (a) =>
      asText(
        await tf.call('POST', '/rest/api/2/issue', {
          dryRun: a.dry_run,
          idempotencyKey: a.idempotency_key,
          rationale: a.rationale,
          body: {
            fields: {
              project: { key: a.project_key.toUpperCase() },
              summary: a.summary,
              description: a.description,
              issuetype: a.issue_type ? { name: a.issue_type } : undefined,
              priority: a.priority ? { name: a.priority } : undefined,
              assignee: a.assignee ? { accountId: a.assignee } : undefined,
              labels: a.labels,
              duedate: a.due_date,
              parent: a.parent_key ? { key: a.parent_key.toUpperCase() } : undefined,
              ...a.custom_fields,
            },
          },
        })
      )
  );

  if (write) wtool(
    'update_issue',
    'Edits issue fields (summary, description, priority by name, assignee). Omitted fields are untouched. Status is NOT editable via fields — but you may pass transition_id (and optionally comment/worklog) to do a composite one-call update+transition+comment+worklog (TrackForge extension; mcp-atlassian parity). Set dry_run=true to preview the whole composite.',
    {
      issue_key: z.string(),
      summary: z.string().optional(),
      description: z.string().nullable().optional().describe('Markdown body; null clears it'),
      priority: z.string().optional(),
      issue_type: z.string().optional().describe('Change issue type by name (hierarchy re-validated)'),
      assignee: z.string().nullable().optional().describe('accountId/email to assign, null to unassign, omit to keep'),
      labels: z.array(z.string()).optional().describe('Replace all labels (set semantics)'),
      add_labels: z.array(z.string()).optional().describe('Labels to add (Jira update ops)'),
      remove_labels: z.array(z.string()).optional().describe('Labels to remove'),
      due_date: z.string().nullable().optional().describe('YYYY-MM-DD or null to clear'),
      resolution: z.string().nullable().optional().describe('Resolution name (Done, Won\'t Do, …) or null to clear'),
      parent: z.string().nullable().optional().describe('Parent issue key (epic for stories, any non-subtask for subtasks) or null to clear'),
      reporter: z.string().optional().describe('accountId/email of the new reporter'),
      environment: z.string().nullable().optional().describe('Free-text environment or null to clear'),
      custom_fields: z.record(z.string(), z.unknown()).optional()
        .describe('Custom field values keyed by customfield_NNNNN or alias; null clears a value. Discover ids via list_custom_fields.'),
      custom_field_ops: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))).optional()
        .describe('Jira update ops for multi-valued custom fields, e.g. {"customfield_10005":[{"add":{"value":"Backend"}},{"remove":{"value":"Web"}}]}'),
      transition_id: z.string().optional()
        .describe('Workflow transition id to execute in the same call (composite). Get ids via get_transitions.'),
      comment: z.string().optional()
        .describe('Comment body to add in the same call (composite)'),
      worklog: z.object({
        timeSpent: z.string().optional().describe('e.g. "2h", "1d"'),
        timeSpentSeconds: z.number().int().positive().optional(),
        comment: z.string().optional(),
        billable: z.boolean().optional(),
      }).optional().describe('Worklog to record in the same call (composite)'),
      dry_run: z.boolean().optional(),
      idempotency_key: z.string().optional(),
      rationale: z.string().optional().describe('Why this change — shown to the human approver when your token requires approval'),
    },
    async (a) => {
      const stray = (a as { status?: string }).status;
      if (stray) {
        return asText({
          error: `fields.status is not editable via update_issue — status moves go through transitions like Jira.`,
          hint: `Call get_transitions(issue_key) for executable transitions, then transition_issue({issue_key, status: "${stray}"}).`,
        });
      }
      return asText(
        await tf.call('PUT', `/rest/api/2/issue/${a.issue_key.toUpperCase()}`, {
          dryRun: a.dry_run,
          idempotencyKey: a.idempotency_key,
          rationale: a.rationale,
          body: {
            fields: {
              summary: a.summary,
              description: a.description,
              priority: a.priority ? { name: a.priority } : undefined,
              issuetype: a.issue_type ? { name: a.issue_type } : undefined,
              assignee: a.assignee === null ? null : a.assignee ? { accountId: a.assignee } : undefined,
              labels: a.labels,
              duedate: a.due_date,
              resolution: a.resolution === null ? null : a.resolution ? { name: a.resolution } : undefined,
              parent: a.parent === null ? null : a.parent ? { key: a.parent.toUpperCase() } : undefined,
              reporter: a.reporter ? { accountId: a.reporter } : undefined,
              environment: a.environment,
              ...a.custom_fields,
            },
            update: (a.add_labels?.length || a.remove_labels?.length || a.custom_field_ops)
              ? {
                  ...(a.custom_field_ops ?? {}),
                  labels: [
                    ...(a.add_labels ?? []).map((l) => ({ add: l })),
                    ...(a.remove_labels ?? []).map((l) => ({ remove: l })),
                  ],
                }
              : undefined,
            // 063 US5 — composite extras: same PUT body extensions the route accepts
            ...(a.transition_id ? { transition: { id: a.transition_id } } : {}),
            ...(a.comment ? { comment: { body: a.comment } } : {}),
            ...(a.worklog ? { worklog: a.worklog } : {}),
          },
        }) ?? { ok: true, note: 'Updated (204). Fetch with get_issue to confirm.' }
      );
    }
  );

  server.tool(
    'find_ready_issues',
    'Lists issues that are ready to pick up: unresolved, undelegated, and not blocked by an unresolved "blocks" link (JQL: key in ready()). Use this before claim_issue to see what work is available.',
    {
      project_key: z.string().describe('Project key, e.g. TF'),
      jql: z.string().optional().describe('Additional JQL to narrow the ready set, e.g. "priority = High"'),
      fields: z.array(z.string()).optional().describe('Field ids to include; strongly recommended, e.g. ["summary","status","priority"]'),
      max_results: z.number().int().min(1).max(100).optional().describe('Page size, default 20'),
    },
    async ({ project_key, jql, fields, max_results }) => {
      const query = `project = ${project_key.toUpperCase()} AND key in ready()${jql ? ` AND (${jql})` : ''}`;
      const res = await tf.call('GET', '/rest/api/2/search', {
        query: {
          jql: query,
          maxResults: Math.min(100, max_results ?? 20),
          fields: (fields ?? ['summary', 'status', 'priority', 'assignee']).join(','),
        },
      });
      return asText(res);
    }
  );

  if (write) wtool(
    'claim_issue',
    'Atomically claims the top-ranked ready issue in a project for an agent: sets delegate + opens an agent session in one transaction, so two agents can never pick up the same issue. Returns the claimed issue key and sessionId — call find_ready_issues first to see the pool. Body: {projectKey, jql?, agent?{accountId|name}}.',
    {
      project_key: z.string().describe('Project key to claim work from, e.g. TF'),
      jql: z.string().optional().describe('Optional JQL to narrow the claimable pool, e.g. "priority = Highest"'),
      agent: z.string().optional().describe('accountId/name of the agent to claim for — omit when your token belongs to the assignable agent'),
    },
    async (a) =>
      asText(
        await tf.call('POST', '/api/internal/agent/claim', {
          body: {
            projectKey: a.project_key.toUpperCase(),
            ...(a.jql ? { jql: a.jql } : {}),
            // Resolve either way: accountId→id|email, name→displayName|email.
            ...(a.agent ? { agent: { accountId: a.agent, name: a.agent } } : {}),
          },
        })
      )
  );

  if (write) wtool(
    'assign_issue',
    'Assigns an issue to a user by accountId or email — or unassigns. Use find_users to resolve a person; use whoami then accountId to assign to yourself.',
    {
      issue_key: z.string(),
      assignee: z.string().nullable().describe('accountId or email; null unassigns'),
      dry_run: z.boolean().optional(),
    },
    async (a) =>
      asText(
        await tf.call('PUT', `/rest/api/2/issue/${a.issue_key.toUpperCase()}/assignee`, {
          dryRun: a.dry_run,
          body: { accountId: a.assignee },
        }) ?? { ok: true }
      )
  );

  server.tool(
    'get_transitions',
    'Lists the workflow transitions available for an issue. Each transition has {id, name, hasScreen, fields (required screen fields e.g. "resolution"), to{status}}. Transitions that fail their conditions are NOT listed — only executable ones appear.',
    { issue_key: z.string() },
    async ({ issue_key }) =>
      asText(await tf.call('GET', `/rest/api/2/issue/${issue_key.toUpperCase()}/transitions`))
  );

  if (write) wtool(
    'transition_issue',
    'Executes a workflow transition. Provide transition_id from get_transitions, or a transition/status name (resolved automatically). If the transition hasScreen, required fields must be passed via `fields` (e.g. {resolution:{name:"Done"}}); an optional comment can be added.',
    {
      issue_key: z.string(),
      transition_id: z.string().optional(),
      status: z.string().optional().describe('Transition or target status name — resolved to a transition id'),
      fields: z.record(z.unknown()).optional().describe('Screen fields, e.g. {resolution:{name:"Done"}}'),
      comment: z.string().optional().describe('Comment added with the transition'),
      dry_run: z.boolean().optional(),
      rationale: z.string().optional().describe('Why this change — shown to the human approver when your token requires approval'),
    },
    async (a) => {
      let transitionId = a.transition_id;
      if (!transitionId) {
        if (!a.status) {
          return asText({ hint: 'Provide transition_id or status. Call get_transitions for valid options.' });
        }
        const { transitions } = await tf.call<{
          transitions: { id: string; name: string; to: { name: string } }[];
        }>(
          'GET',
          `/rest/api/2/issue/${a.issue_key.toUpperCase()}/transitions`
        );
        const q = a.status!.toLowerCase();
        const match = transitions.find(
          (t) => t.name.toLowerCase() === q || t.to.name.toLowerCase() === q
        );
        if (!match) {
          return asText({
            error: `No transition to '${a.status}'.`,
            available: transitions.map((t) => `${t.name} → ${t.to.name}`),
          });
        }
        transitionId = match.id;
      }
      return asText(
        await tf.call('POST', `/rest/api/2/issue/${a.issue_key.toUpperCase()}/transitions`, {
          dryRun: a.dry_run,
          rationale: a.rationale,
          body: {
            transition: { id: transitionId },
            ...(a.fields ? { fields: a.fields } : {}),
            ...(a.comment ? { update: { comment: [{ add: { body: a.comment } }] } } : {}),
          },
        }) ?? { ok: true, transitionedTo: transitionId }
      );
    }
  );

  server.tool(
    'find_users',
    'Resolves people by name or email substring. Returns users with accountId (use it for assignee). Pass project_key to restrict to users assignable in that project.',
    {
      query: z.string().describe('Name or email substring, e.g. "ada" or "ada@x.com"'),
      project_key: z.string().optional().describe('Restrict to users assignable in this project'),
    },
    async ({ query, project_key }) =>
      asText(
        await tf.call(
          'GET',
          project_key ? '/rest/api/2/user/assignable/search' : '/rest/api/2/user/search',
          { query: { query, project: project_key?.toUpperCase() } }
        )
      )
  );

  if (write) wtool(
    'bulk_create_issues',
    'Creates up to 50 issues in one call. Returns {issues[], errors[]} with per-item failures — check errors before assuming success.',
    {
      issues: z
        .array(
          z.object({
            project_key: z.string(),
            summary: z.string(),
            description: z.string().optional(),
            issue_type: z.string().optional(),
            priority: z.string().optional(),
            assignee: z.string().optional(),
            labels: z.array(z.string()).optional(),
            components: z.array(z.string()).optional().describe('Component names'),
            fix_versions: z.array(z.string()).optional().describe('fixVersion names'),
            affected_versions: z.array(z.string()).optional().describe('Affects version names'),
            due_date: z.string().optional().describe('YYYY-MM-DD'),
            parent_key: z.string().optional().describe('Required for Subtask; Epic for epic children'),
            custom_fields: z.record(z.string(), z.unknown()).optional()
              .describe('Custom field values keyed by customfield_NNNNN or alias'),
          })
        )
        .min(1)
        .max(50),
      dry_run: z.boolean().optional().describe('Validate + preview only; nothing is persisted'),
      idempotency_key: z.string().optional(),
      batch_id: z.string().optional()
        .describe('Per-item retry token: a retried batch replays already-created items instead of duplicating them'),
    },
    async ({ issues, dry_run, idempotency_key, batch_id }) =>
      asText(
        await tf.call('POST', '/rest/api/2/issue/bulk', {
          dryRun: dry_run,
          idempotencyKey: idempotency_key,
          body: {
            ...(batch_id ? { batchId: batch_id } : {}),
            issueUpdates: issues.map((i) => ({
              fields: {
                project: { key: i.project_key.toUpperCase() },
                summary: i.summary,
                description: i.description,
                issuetype: i.issue_type ? { name: i.issue_type } : undefined,
                priority: i.priority ? { name: i.priority } : undefined,
                assignee: i.assignee ? { accountId: i.assignee } : undefined,
                labels: i.labels,
                components: i.components?.map((name) => ({ name })),
                fixVersions: i.fix_versions?.map((name) => ({ name })),
                versions: i.affected_versions?.map((name) => ({ name })),
                duedate: i.due_date,
                parent: i.parent_key ? { key: i.parent_key.toUpperCase() } : undefined,
                ...i.custom_fields,
              },
            })),
          },
        })
      )
  );

  // --- Sprint 008: collaboration ---

  if (write) wtool(
    'add_comment',
    'Adds a comment to an issue. Body is markdown; mention people as `@Name` or `[~accountId:<id>]` (resolve ids with find_users).',
    {
      issue_key: z.string(),
      body: z.string().describe('Markdown comment body'),
      dry_run: z.boolean().optional().describe('Validate + preview only; nothing is persisted'),
      rationale: z.string().optional().describe('Why this change — shown to the human approver when your token requires approval'),
    },
    async ({ issue_key, body, dry_run, rationale }) =>
      asText(await tf.call('POST', `/rest/api/2/issue/${issue_key.toUpperCase()}/comment`, { dryRun: dry_run, body: { body }, rationale }))
  );

  server.tool(
    'list_comments',
    'Lists comments on an issue (newest first, paged).',
    {
      issue_key: z.string(),
      start_at: z.number().int().min(0).optional(),
      max_results: z.number().int().min(1).max(100).optional(),
    },
    async ({ issue_key, start_at, max_results }) =>
      asText(
        await tf.call('GET', `/rest/api/2/issue/${issue_key.toUpperCase()}/comment`, {
          query: { startAt: start_at ?? 0, maxResults: Math.min(100, max_results ?? 50) },
        })
      )
  );

  if (write) wtool(
    'edit_comment',
    'Edits a comment you authored (admins can edit any).',
    { issue_key: z.string(), comment_id: z.string(), body: z.string() },
    async ({ issue_key, comment_id, body }) =>
      asText(
        await tf.call('PUT', `/rest/api/2/issue/${issue_key.toUpperCase()}/comment/${comment_id}`, {
          body: { body },
        })
      )
  );

  if (write) wtool(
    'create_subtask',
    'Creates a Subtask under a parent issue (same project).',
    {
      parent_key: z.string().describe('Parent issue key (non-subtask type)'),
      summary: z.string(),
      description: z.string().optional(),
      assignee: z.string().optional(),
      dry_run: z.boolean().optional(),
    },
    async (a) => {
      const parent = await tf.call<{ key: string; fields: { project: { key: string } } }>(
        'GET',
        `/rest/api/2/issue/${a.parent_key.toUpperCase()}`,
        { query: { fields: 'project' } }
      );
      return asText(
        await tf.call('POST', '/rest/api/2/issue', {
          dryRun: a.dry_run,
          body: {
            fields: {
              project: { key: parent.fields.project.key },
              summary: a.summary,
              description: a.description,
              issuetype: { name: 'Subtask' },
              parent: { key: a.parent_key.toUpperCase() },
              assignee: a.assignee ? { accountId: a.assignee } : undefined,
            },
          },
        })
      );
    }
  );

  server.tool(
    'get_children',
    'Lists an issue\'s children — subtasks for standard issues, epic children for epics — with status.',
    { issue_key: z.string() },
    async ({ issue_key }) =>
      asText(await tf.call('GET', `/rest/api/2/issue/${issue_key.toUpperCase()}/children`))
  );

  server.tool(
    'list_link_types',
    'Lists issue link types (Blocks, Relates, Duplicate, Cloners) with inward/outward names.',
    {},
    async () => asText(await tf.call('GET', '/rest/api/2/issueLinkType'))
  );

  if (write) wtool(
    'link_issues',
    'Links two issues. direction "outward" means source_key does the outward action to target_key (e.g. TF-1 blocks TF-2 → type Blocks, source TF-1, target TF-2).',
    {
      type: z.string().describe('Link type name (Blocks, Relates, Duplicate, Cloners) or id'),
      source_key: z.string().describe('Issue that performs the outward relationship'),
      target_key: z.string().describe('Issue that receives it'),
      dry_run: z.boolean().optional().describe('Validate + preview only; nothing is persisted'),
    },
    async ({ type, source_key, target_key, dry_run }) =>
      asText(
        await tf.call('POST', '/rest/api/2/issueLink', {
          dryRun: dry_run,
          body: { type: { name: type }, outwardIssue: { key: source_key.toUpperCase() }, inwardIssue: { key: target_key.toUpperCase() } },
        }) ?? { ok: true }
      )
  );

  // Destructive: two-step — dry_run first returns a confirmToken, then the real
  // delete requires it. Agents cannot delete in one blind step (A7 groundwork).
  if (write) wtool(
    'delete_issue',
    'Deletes an issue. TWO STEPS: call with dry_run=true first to get a confirm_token and see what will be deleted (subtasks listed); then call again with that confirm_token to actually delete.',
    {
      issue_key: z.string(),
      delete_subtasks: z.boolean().optional().describe('true = also delete subtasks (required if it has any)'),
      dry_run: z.boolean().optional().describe('true = preview only, returns confirm_token'),
      confirm_token: z.string().optional().describe('Token from the dry_run preview — required for a real delete'),
      rationale: z.string().optional().describe('Why this deletion — shown to the human approver when your token requires approval'),
    },
    async (a) => {
      const key = a.issue_key.toUpperCase();
      if (a.dry_run || !a.confirm_token) {
        const preview = await tf.call('DELETE', `/rest/api/2/issue/${key}`, {
          query: {
            deleteSubtasks: String(!!a.delete_subtasks),
            dryRun: 'true',
          },
        });
        return asText({
          ...((preview ?? {}) as Record<string, unknown>),
          hint: 'This was a PREVIEW — nothing was deleted. To delete, call delete_issue again with this confirm_token.',
        });
      }
      return asText(
        await tf.call('DELETE', `/rest/api/2/issue/${key}`, {
          query: { deleteSubtasks: String(!!a.delete_subtasks), confirmToken: a.confirm_token },
          rationale: a.rationale,
        }) ?? { ok: true, deleted: key }
      );
    }
  );

  // 060 US7 — Jira DC issue archiving: reversible, hides the issue from every
  // read surface and makes it read-only until restored.
  if (write) wtool(
    'archive_issue',
    'Archives an issue: it disappears from search, boards, backlog and direct reads, and becomes read-only. Reversible via restore_issue. dry_run=true validates without archiving.',
    {
      issue_key: z.string(),
      dry_run: z.boolean().optional().describe('true = preview only'),
      rationale: z.string().optional().describe('Why — shown to the human approver when your token requires approval'),
    },
    async (a) => {
      const key = a.issue_key.toUpperCase();
      if (a.dry_run) {
        const preview = await tf.call('PUT', `/rest/api/2/issue/${key}/archive`, { query: { dryRun: 'true' } });
        return asText({ ...(preview as Record<string, unknown> ?? {}), hint: 'PREVIEW — nothing was archived. Call again without dry_run to archive.' });
      }
      return asText(
        (await tf.call('PUT', `/rest/api/2/issue/${key}/archive`, { rationale: a.rationale })) ?? { ok: true, archived: key }
      );
    }
  );

  if (write) wtool(
    'restore_issue',
    'Restores an archived issue so it is visible and writable again. dry_run=true validates without restoring.',
    {
      issue_key: z.string(),
      dry_run: z.boolean().optional().describe('true = preview only'),
    },
    async (a) => {
      const key = a.issue_key.toUpperCase();
      if (a.dry_run) {
        const preview = await tf.call('PUT', `/rest/api/2/issue/${key}/restore`, { query: { dryRun: 'true' } });
        return asText({ ...(preview as Record<string, unknown> ?? {}), hint: 'PREVIEW — nothing was restored. Call again without dry_run to restore.' });
      }
      return asText((await tf.call('PUT', `/rest/api/2/issue/${key}/restore`)) ?? { ok: true, restored: key });
    }
  );

  // --- Sprint 009: workflows & boards ---

  server.tool(
    'get_workflow',
    'Returns a workflow definition: statuses and named transitions with conditions, validators, post-functions and screen fields. Pass a workflow name/id, or a project_key to get its assigned workflow.',
    {
      workflow: z.string().optional().describe('Workflow id or name (e.g. "Simple")'),
      project_key: z.string().optional().describe('Resolve the workflow assigned to this project'),
    },
    async (a) => {
      let id = a.workflow;
      if (!id && a.project_key) {
        const project = await tf.call<{ workflow?: { id: string; name: string } }>(
          'GET',
          `/rest/api/2/project/${a.project_key.toUpperCase()}`
        );
        id = project.workflow?.id;
        if (!id) return asText({ error: `Project ${a.project_key} has no workflow.` });
      }
      if (!id) return asText({ hint: 'Provide workflow (name/id) or project_key.' });
      return asText(await tf.call('GET', `/api/internal/workflows/${encodeURIComponent(id)}`));
    }
  );

  server.tool(
    'get_board',
    'Get one board by id, or the project\'s DEFAULT board by project key (legacy alias). Returns the column→status configuration by default; set include_quick_filters for quick filters too.',
    {
      board: z.string().optional().describe('board id or project key (default board)'),
      board_id: z.string().optional().describe('legacy alias of board'),
      project_key: z.string().optional().describe('project key → its default board'),
      include_config: z.boolean().optional().describe('include column configuration (default true)'),
      include_quick_filters: z.boolean().optional(),
    },
    async (a) => {
      const id = a.board ?? a.board_id ?? a.project_key?.toUpperCase();
      if (!id) return asText({ hint: 'Provide board, board_id or project_key.' });
      const out: Record<string, unknown> = {
        board: await tf.call('GET', `/rest/agile/1.0/board/${encodeURIComponent(id)}`),
      };
      if (a.include_config !== false) {
        out.configuration = await tf.call('GET', `/rest/agile/1.0/board/${encodeURIComponent(id)}/configuration`);
      }
      if (a.include_quick_filters) {
        out.quickFilters = await tf.call('GET', `/rest/agile/1.0/board/${encodeURIComponent(id)}/quickfilter`);
      }
      return asText(out);
    }
  );

  server.tool(
    'get_board_issues',
    'Lists issues on a board (active sprint when one exists) grouped by board column. Pass board_id or a project_key. Pages through all issues up to max_issues (default 1000); when total exceeds the cap, truncated=true tells you to narrow the board filter.',
    {
      board_id: z.string().optional(),
      project_key: z.string().optional(),
      max_issues: z.number().int().min(1).max(5000).optional().describe('Cap on issues fetched (default 1000)'),
    },
    async (a) => {
      const id = a.board_id ?? a.project_key?.toUpperCase();
      if (!id) return asText({ hint: 'Provide board_id or project_key.' });
      const cap = a.max_issues ?? 1000;
      const PAGE = 200; // backend /board/{id}/issue maxResults cap
      const [config, first] = await Promise.all([
        tf.call<{
          columnConfig: { columns: { name: string; statuses: { id: string }[] }[] };
        }>('GET', `/rest/agile/1.0/board/${id}/configuration`),
        tf.call<{ total: number; issues: { key: string; fields: { summary: string; status: { id: string; name: string } } }[] }>(
          'GET',
          `/rest/agile/1.0/board/${id}/issue`,
          { query: { startAt: 0, maxResults: Math.min(PAGE, cap) } }
        ),
      ]);
      const issues = [...first.issues];
      while (issues.length < Math.min(cap, first.total)) {
        const next = await tf.call<typeof first>('GET', `/rest/agile/1.0/board/${id}/issue`, {
          query: { startAt: issues.length, maxResults: Math.min(PAGE, cap - issues.length) },
        });
        if (next.issues.length === 0) break;
        issues.push(...next.issues);
      }
      const columns = config.columnConfig.columns.map((col) => {
        const ids = new Set(col.statuses.map((s) => s.id));
        return {
          column: col.name,
          issues: issues
            .filter((i) => ids.has(i.fields.status.id))
            .map((i) => ({ key: i.key, summary: i.fields.summary, status: i.fields.status.name })),
        };
      });
      return asText({ total: first.total, fetched: issues.length, truncated: issues.length < first.total, columns });
    }
  );

  if (write) wtool(
    'rank_issue',
    'Reorders an issue on the board: place it before or after another issue (LexoRank persists). Exactly one of rank_before / rank_after is required.',
    {
      issue_key: z.string(),
      rank_before: z.string().optional().describe('Issue key to rank before'),
      rank_after: z.string().optional().describe('Issue key to rank after'),
      dry_run: z.boolean().optional().describe('Validate + preview only; nothing is persisted'),
    },
    async (a) => {
      if (Boolean(a.rank_before) === Boolean(a.rank_after)) {
        return asText({ error: 'Provide exactly one of rank_before or rank_after.' });
      }
      return asText(
        await tf.call('PUT', '/rest/agile/1.0/issue/rank', {
          dryRun: a.dry_run,
          body: {
            issues: [a.issue_key.toUpperCase()],
            ...(a.rank_before ? { rankBeforeIssue: a.rank_before.toUpperCase() } : {}),
            ...(a.rank_after ? { rankAfterIssue: a.rank_after.toUpperCase() } : {}),
          },
        }) ?? { ok: true }
      );
    }
  );

  if (write) wtool(
    'move_card',
    'Moves a card to a named board column: resolves a valid workflow transition into one of the column\'s mapped statuses (or reports which transitions exist). Use get_board for column names.',
    {
      issue_key: z.string(),
      column: z.string().describe('Target column name, e.g. "In Progress"'),
      project_key: z.string().optional().describe('Project key — defaults to the issue\'s project'),
      transition_id: z.string().optional().describe('Pick a specific transition when more than one leads into the column'),
      fields: z.record(z.unknown()).optional().describe('Screen fields if the transition requires them'),
      comment: z.string().optional(),
      dry_run: z.boolean().optional().describe('Validate + preview only; nothing is persisted'),
    },
    async (a) => {
      const key = a.issue_key.toUpperCase();
      const projectKey = (a.project_key ?? key.split('-')[0]).toUpperCase();
      const config = await tf.call<{
        columnConfig: { columns: { name: string; statuses: { id: string; name: string }[] }[] };
      }>('GET', `/rest/agile/1.0/board/${projectKey}/configuration`);
      const col = config.columnConfig.columns.find(
        (c) => c.name.toLowerCase() === a.column.toLowerCase()
      );
      if (!col) {
        return asText({
          error: `No column '${a.column}'.`,
          columns: config.columnConfig.columns.map((c) => c.name),
        });
      }
      const targetIds = new Set(col.statuses.map((s) => s.id));
      const { transitions } = await tf.call<{
        transitions: { id: string; name: string; hasScreen?: boolean; to: { id: string; name: string } }[];
      }>('GET', `/rest/api/2/issue/${key}/transitions`);
      const candidates = transitions.filter((t) => targetIds.has(t.to.id));
      let t: { id: string; name: string; hasScreen?: boolean; to: { id: string; name: string } } | undefined = candidates[0];
      if (a.transition_id) {
        t = candidates.find((c) => c.id === a.transition_id) ?? transitions.find((x) => x.id === a.transition_id);
        if (!t) {
          return asText({
            error: `Transition id '${a.transition_id}' is not currently available on ${key}.`,
            available: transitions.map((x) => ({ id: x.id, name: x.name, to: x.to.name })),
          });
        }
      } else if (candidates.length > 1) {
        return asText({
          error: `Multiple transitions reach column '${col.name}' — pick one via transition_id.`,
          candidates: candidates.map((c) => ({ transition_id: c.id, name: c.name, to: c.to.name })),
        });
      }
      if (!t) {
        return asText({
          error: `No workflow transition into column '${col.name}' from the issue's current status.`,
          available: transitions.map((x) => `${x.name} → ${x.to.name}`),
        });
      }
      return asText(
        await tf.call('POST', `/rest/api/2/issue/${key}/transitions`, {
          dryRun: a.dry_run,
          body: {
            transition: { id: t.id },
            ...(a.fields ? { fields: a.fields } : {}),
            ...(a.comment ? { update: { comment: [{ add: { body: a.comment } }] } } : {}),
          },
        }) ?? { ok: true, movedTo: t.to.name, via: t.name }
      );
    }
  );

  // --- Sprint 013: scrum tooling ---

  server.tool(
    'get_backlog',
    'Lists backlog issues for a scrum board in rank order (issues not in any sprint). Pass board_id or a project_key.',
    {
      board_id: z.string().optional(),
      project_key: z.string().optional(),
      max_results: z.number().int().min(1).max(500).optional().describe('Cap on issues fetched (default 50, up to 500 across pages)'),
    },
    async (a) => {
      const id = a.board_id ?? a.project_key?.toUpperCase();
      if (!id) return asText({ hint: 'Provide board_id or project_key.' });
      const cap = a.max_results ?? 50;
      type Page = {
        total: number;
        issues: { key: string; fields: { summary: string; story_points?: number | null; status: { name: string } } }[];
      };
      const first = await tf.call<Page>('GET', `/rest/agile/1.0/board/${id}/backlog`, {
        query: { startAt: 0, maxResults: Math.min(100, cap) },
      });
      const issues = [...first.issues];
      while (issues.length < Math.min(cap, first.total)) {
        const next = await tf.call<Page>('GET', `/rest/agile/1.0/board/${id}/backlog`, {
          query: { startAt: issues.length, maxResults: Math.min(100, cap - issues.length) },
        });
        if (next.issues.length === 0) break;
        issues.push(...next.issues);
      }
      return asText({
        total: first.total,
        fetched: issues.length,
        truncated: issues.length < first.total,
        issues: issues.map((i) => ({
          key: i.key,
          summary: i.fields.summary,
          status: i.fields.status.name,
          points: i.fields.story_points ?? null,
        })),
      });
    }
  );

  server.tool(
    'list_sprints',
    'Lists sprints for a board (active first). Pass board_id or a project_key.',
    {
      board_id: z.string().optional(),
      project_key: z.string().optional(),
      state: z.enum(['future', 'active', 'closed']).optional(),
    },
    async (a) => {
      const id = a.board_id ?? a.project_key?.toUpperCase();
      if (!id) return asText({ hint: 'Provide board_id or project_key.' });
      const r = await tf.call<{ values: unknown[] }>(
        'GET',
        `/rest/agile/1.0/board/${id}/sprint`,
        { query: { state: a.state } }
      );
      return asText(r.values);
    }
  );

  if (write) wtool(
    'create_sprint',
    'Creates a sprint on a scrum board. origin_board_id accepts a board id or project key.',
    {
      origin_board_id: z.string().describe('Board id or project key'),
      name: z.string().optional(),
      goal: z.string().optional(),
      rationale: z.string().optional().describe('Reason for this change — shown to human approvers when writes are gated'),
    },
    async (a) =>
      asText(
        await tf.call('POST', '/rest/agile/1.0/sprint', {
          body: { originBoardId: a.origin_board_id, name: a.name, goal: a.goal },
          rationale: a.rationale,
        })
      )
  );

  if (write) wtool(
    'start_sprint',
    'Starts a future sprint (only one active sprint per board).',
    {
      sprint_id: z.string(),
      name: z.string().optional(),
      goal: z.string().optional(),
      duration_days: z.number().int().min(1).max(30).optional().describe('Sprint length in days (sets endDate)'),
      rationale: z.string().optional(),
    },
    async (a) =>
      asText(
        await tf.call('PUT', `/rest/agile/1.0/sprint/${a.sprint_id}`, {
          body: {
            state: 'active',
            name: a.name,
            goal: a.goal,
            ...(a.duration_days
              ? { endDate: new Date(Date.now() + a.duration_days * 86400_000).toISOString() }
              : {}),
          },
          rationale: a.rationale,
        })
      )
  );

  if (write) wtool(
    'complete_sprint',
    'Completes an active sprint. Open issues move to the backlog, a new sprint, or an existing future sprint.',
    {
      sprint_id: z.string(),
      move_open_issues_to: z
        .enum(['backlog', 'new'])
        .or(z.string())
        .optional()
        .describe("'backlog' (default), 'new', or a future sprint id"),
      new_sprint_name: z.string().optional(),
      rationale: z.string().optional(),
    },
    async (a) =>
      asText(
        await tf.call('PUT', `/rest/agile/1.0/sprint/${a.sprint_id}`, {
          body: {
            state: 'closed',
            moveOpenIssuesTo: a.move_open_issues_to,
            newSprintName: a.new_sprint_name,
          },
          rationale: a.rationale,
        })
      )
  );

  if (write) wtool(
    'move_to_sprint',
    'Moves issues into a sprint (future or active).',
    {
      sprint_id: z.string(),
      issue_keys: z.array(z.string()).min(1),
      rationale: z.string().optional(),
    },
    async (a) =>
      asText(
        (await tf.call('POST', `/rest/agile/1.0/sprint/${a.sprint_id}/issue`, {
          body: { issues: a.issue_keys.map((k) => k.toUpperCase()) },
          rationale: a.rationale,
        })) ?? { ok: true }
      )
  );

  if (write) wtool(
    'move_to_backlog',
    'Moves issues out of their sprint back to the backlog.',
    {
      issue_keys: z.array(z.string()).min(1),
      rationale: z.string().optional(),
    },
    async (a) =>
      asText(
        (await tf.call('POST', '/rest/agile/1.0/backlog/issue', {
          body: { issues: a.issue_keys.map((k) => k.toUpperCase()) },
          rationale: a.rationale,
        })) ?? { ok: true }
      )
  );

  if (write) wtool(
    'estimate_issue',
    'Sets (or clears) story points on an issue.',
    {
      issue_key: z.string(),
      points: z.number().min(0).nullable().describe('Story points — null clears the estimate'),
      dry_run: z.boolean().optional().describe('Validate + preview only; nothing is persisted'),
      rationale: z.string().optional(),
    },
    async (a) =>
      asText(
        (await tf.call('PUT', `/rest/api/2/issue/${a.issue_key.toUpperCase()}`, {
          body: { fields: { story_points: a.points } },
          rationale: a.rationale,
        })) ?? { ok: true, points: a.points }
      )
  );

  // --- Sprint 024: worklogs & time tracking ---

  if (write) wtool(
    'log_work',
    'Logs time worked on an issue. `time_spent` is a Jira duration ("2h", "1w 3d 4h 30m" — workday length comes from instance config, default 8h/day 5d/week) or seconds as a number. adjust_estimate controls the remaining estimate: "auto" (default — subtract logged time), "leave" (keep), "new" (requires new_estimate), "manual"/"reduceBy" (reduce by reduce_by). Supports dry_run preview.',
    {
      issue_key: z.string(),
      time_spent: z.union([z.string(), z.number()]).describe('Duration like "2h 30m" or raw seconds'),
      comment: z.string().optional().describe('Work description (markdown)'),
      started: z.string().optional().describe('ISO datetime when work started (default: now)'),
      billable: z.boolean().optional().describe('Mark the entry billable (queryable via JQL `billable`)'),
      adjust_estimate: z.enum(['auto', 'leave', 'new', 'manual']).optional(),
      new_estimate: z.string().optional().describe('Required when adjust_estimate="new" — e.g. "1d"'),
      reduce_by: z.string().optional().describe('Required when adjust_estimate="manual" — e.g. "30m"'),
      dry_run: z.boolean().optional(),
      rationale: z.string().optional(),
    },
    async (a) =>
      asText(
        await tf.call('POST', `/rest/api/2/issue/${a.issue_key.toUpperCase()}/worklog`, {
          dryRun: a.dry_run,
          rationale: a.rationale,
          query: {
            adjustEstimate: a.adjust_estimate,
            newEstimate: a.new_estimate,
            reduceBy: a.reduce_by,
          },
          body: {
            timeSpent: typeof a.time_spent === 'number' ? String(a.time_spent) : a.time_spent,
            comment: a.comment,
            started: a.started,
            billable: a.billable,
          },
        })
      )
  );

  server.tool(
    'list_worklogs',
    'Lists worklogs on an issue (oldest first). Each entry has author, timeSpent ("2h"), timeSpentSeconds, started and billable.',
    {
      issue_key: z.string(),
      start_at: z.number().int().min(0).optional(),
      max_results: z.number().int().min(1).max(5000).optional(),
    },
    async ({ issue_key, start_at, max_results }) =>
      asText(
        await tf.call('GET', `/rest/api/2/issue/${issue_key.toUpperCase()}/worklog`, {
          query: { startAt: start_at ?? 0, maxResults: max_results },
        })
      )
  );

  if (write) wtool(
    'set_estimate',
    'Sets the original and/or remaining time estimate on an issue ("1w", "2d 4h", "30m" or null to clear). Prefer log_work for tracking actual work — this edits the plan numbers.',
    {
      issue_key: z.string(),
      original_estimate: z.string().nullable().optional().describe('e.g. "1w 2d" or null to clear'),
      remaining_estimate: z.string().nullable().optional().describe('e.g. "4h" or null to clear'),
      dry_run: z.boolean().optional(),
      rationale: z.string().optional(),
    },
    async (a) =>
      asText(
        (await tf.call('PUT', `/rest/api/2/issue/${a.issue_key.toUpperCase()}`, {
          dryRun: a.dry_run,
          rationale: a.rationale,
          body: {
            fields: {
              timetracking: {
                ...(a.original_estimate !== undefined ? { originalEstimate: a.original_estimate } : {}),
                ...(a.remaining_estimate !== undefined ? { remainingEstimate: a.remaining_estimate } : {}),
              },
            },
          },
        })) ?? { ok: true }
      )
  );

  server.tool(
    'get_sprint_report',
    'Sprint report: member issues with points, done status, and scope-change flags. Also returns committed/completed totals.',
    {
      board_id: z.string().describe('Board id or project key'),
      sprint_id: z.string(),
    },
    async (a) => {
      const r = await tf.call<{
        sprint: { name: string; state: string };
        issues: { key: string; summary: string; status: string; points: number; done: boolean; addedAfterStart: boolean }[];
      }>('GET', `/api/internal/reports/board/${a.board_id}/sprint/${a.sprint_id}/report`);
      const committed = r.issues.reduce((s, i) => s + i.points, 0);
      const completed = r.issues.filter((i) => i.done).reduce((s, i) => s + i.points, 0);
      return asText({ sprint: r.sprint, committedPoints: committed, completedPoints: completed, issues: r.issues });
    }
  );

  server.tool(
    'get_velocity',
    'Velocity: committed vs completed story points per closed sprint on a board.',
    { board_id: z.string().describe('Board id or project key') },
    async (a) => asText(await tf.call('GET', `/api/internal/reports/board/${a.board_id}/velocity`))
  );

  if (write) wtool(
    'suggest_sprint_scope',
    'AI suggestion for what to pull into the next sprint, based on backlog rank and recent velocity. Advisory only — nothing is moved.',
    {
      board_id: z.string().describe('Board id or project key'),
      sprint_id: z.string().optional().describe('Future sprint to size the suggestion against'),
    },
    async (a) =>
      asText(
        await tf.call('POST', `/api/internal/ai/sprints/${a.board_id}/scope`, {
          body: { sprintId: a.sprint_id },
        })
      )
  );

  server.tool(
    'list_custom_fields',
    'Lists custom field definitions (id customfield_NNNNN, name, type, contexts, allowed options). System-managed fields (Story Points, Flagged, Start date) appear too — write them via their alias or cf id.',
    { include_inactive: z.boolean().optional() },
    async (a) =>
      asText(
        await tf.call('GET', '/api/internal/customfields', {
          query: { includeInactive: a.include_inactive ? 'true' : undefined },
        })
      )
  );

  if (write) wtool(
    'manage_custom_field',
    'Admin: create a custom field, rename it, deactivate it (dry-run preview first), or edit context options. Requires an admin token. For cascading options pass {value, children:[...]}.',
    {
      action: z.enum(['create', 'rename', 'deactivate', 'set_options']),
      field_id: z.string().optional().describe('customfield_NNNNN — required except for create'),
      name: z.string().optional().describe('Field name (create/rename)'),
      type: z.string().optional().describe('create: text, textarea, number, date, datetime, url, select, radio, multiselect, checkbox, cascading, user, checklist'),
      description: z.string().optional(),
      project_keys: z.array(z.string()).optional().describe('Scope the context to these projects; omit for global'),
      options: z.array(z.unknown()).optional().describe('Option values (strings or {value, children}) for create/set_options'),
      context_id: z.string().optional().describe('set_options only — which context to update; defaults to the first'),
      dry_run: z.boolean().optional().describe('deactivate: preview affected issues without applying'),
      rationale: z.string().optional(),
    },
    async (a) => {
      const base = '/api/internal/customfields';
      switch (a.action) {
        case 'create':
          return asText(
            await tf.call('POST', base, {
              rationale: a.rationale,
              body: {
                name: a.name, type: a.type, description: a.description,
                context: a.project_keys?.length || a.options?.length
                  ? { projectKeys: a.project_keys, options: a.options }
                  : undefined,
              },
            })
          );
        case 'rename':
          return asText(
            await tf.call('PUT', `${base}/${a.field_id}`, {
              rationale: a.rationale,
              body: { name: a.name, description: a.description },
            })
          );
        case 'deactivate':
          return asText(
            (await tf.call('DELETE', `${base}/${a.field_id}`, {
              dryRun: a.dry_run, rationale: a.rationale,
            })) ?? { ok: true, deactivated: a.field_id }
          );
        case 'set_options': {
          const field = await tf.call<{ contexts: { id: string }[] }>('GET', `${base}/${a.field_id}`);
          const ctxId = a.context_id ?? field.contexts[0]?.id;
          if (!ctxId) throw new Error('Field has no context — add one first via the admin UI.');
          return asText(
            await tf.call('PUT', `${base}/${a.field_id}/contexts/${ctxId}`, {
              rationale: a.rationale,
              body: { options: a.options ?? [] },
            })
          );
        }
      }
    }
  );

  // --- Sprint 015: permissions core ---

  server.tool(
    'get_my_permissions',
    'Check which project permissions the calling account holds before writing (A3). Pass a project key (or issue key) and the permission keys you plan to exercise, e.g. CREATE_ISSUES, EDIT_ISSUES, TRANSITION_ISSUES, ADD_COMMENTS, DELETE_ISSUES, LINK_ISSUES, ADMINISTER_PROJECTS.',
    {
      project_key: z.string().optional().describe('Project key — omit for global check'),
      issue_key: z.string().optional().describe('Issue key for reporter/assignee-scoped grants'),
      permissions: z.array(z.string()).min(1).describe('Permission keys to evaluate'),
    },
    async (a) => {
      const q = new URLSearchParams({ permissions: a.permissions.join(',') });
      if (a.project_key) q.set('projectKey', a.project_key.toUpperCase());
      if (a.issue_key) q.set('issueKey', a.issue_key.toUpperCase());
      return asText(await tf.call('GET', `/rest/api/2/mypermissions?${q}`));
    }
  );

  if (write) wtool(
    'manage_groups',
    'Admin (D21): create/delete groups, add/remove members, list members. Actions: create(name), delete(name, dry_run previews dependents), members(name), add_user(name, account_id), remove_user(name, account_id), list().',
    {
      action: z.enum(['list', 'create', 'delete', 'members', 'add_user', 'remove_user']),
      name: z.string().optional().describe('Group name'),
      account_id: z.string().optional().describe('User accountId (or email/display name) for membership changes'),
      dry_run: z.boolean().optional().describe('delete: preview grants/roles depending on the group'),
      rationale: z.string().optional(),
    },
    async (a) => {
      const g = a.name ? `groupname=${encodeURIComponent(a.name)}` : '';
      switch (a.action) {
        case 'list':
          return asText(await tf.call('GET', '/rest/api/2/groups/picker'));
        case 'create':
          return asText(await tf.call('POST', '/rest/api/2/group', { body: { name: a.name }, rationale: a.rationale }));
        case 'delete':
          return asText(
            (await tf.call('DELETE', `/rest/api/2/group?${g}`, { dryRun: a.dry_run, rationale: a.rationale })) ?? { ok: true }
          );
        case 'members':
          return asText(await tf.call('GET', `/rest/api/2/group/member?${g}`));
        case 'add_user':
          return asText(await tf.call('POST', `/rest/api/2/group/user?${g}`, { body: { accountId: a.account_id }, rationale: a.rationale }));
        case 'remove_user':
          return asText(
            (await tf.call('DELETE', `/rest/api/2/group/user?${g}&accountId=${encodeURIComponent(a.account_id ?? '')}`, { rationale: a.rationale })) ?? { ok: true }
          );
      }
    }
  );

  if (write) wtool(
    'manage_project_roles',
    'Manage project role membership (People). Actions: list(project_key), actors(project_key, role), add_actor(project_key, role, users?, groups?), remove_actor(project_key, role, user?|group?), create_role(name, description).',
    {
      action: z.enum(['list', 'actors', 'add_actor', 'remove_actor', 'create_role']),
      project_key: z.string().optional(),
      role: z.string().optional().describe('Role name (Administrators/Developers/Users/custom)'),
      users: z.array(z.string()).optional().describe('accountIds to add'),
      groups: z.array(z.string()).optional().describe('Group names to add'),
      user: z.string().optional().describe('remove_actor: accountId'),
      group: z.string().optional().describe('remove_actor: group name'),
      name: z.string().optional().describe('create_role: role name'),
      description: z.string().optional(),
      rationale: z.string().optional(),
    },
    async (a) => {
      const pk = a.project_key?.toUpperCase() ?? '';
      const roleId = async () => {
        const roles = await tf.call<{ id: string; name: string }[]>('GET', '/rest/api/2/role');
        const r = roles.find((x) => x.name === a.role || x.id === a.role);
        if (!r) throw new Error(`Role '${a.role}' not found. Known: ${roles.map((x) => x.name).join(', ')}`);
        return r.id;
      };
      switch (a.action) {
        case 'create_role':
          return asText(await tf.call('POST', '/rest/api/2/role', { body: { name: a.name, description: a.description }, rationale: a.rationale }));
        case 'list':
          return asText(await tf.call('GET', `/rest/api/2/project/${pk}/role`));
        case 'actors':
          return asText(await tf.call('GET', `/rest/api/2/project/${pk}/role/${await roleId()}`));
        case 'add_actor':
          return asText(await tf.call('POST', `/rest/api/2/project/${pk}/role/${await roleId()}`, { body: { user: a.users, group: a.groups }, rationale: a.rationale }));
        case 'remove_actor': {
          const q = a.user ? `user=${encodeURIComponent(a.user)}` : `group=${encodeURIComponent(a.group ?? '')}`;
          return asText((await tf.call('DELETE', `/rest/api/2/project/${pk}/role/${await roleId()}?${q}`, { rationale: a.rationale })) ?? { ok: true });
        }
      }
    }
  );

  if (write) wtool(
    'manage_permission_scheme',
    'Admin (D21): permission schemes and grants. Actions: list(), get(scheme), create(name), grant(scheme, permission, holder_type, holder_param), revoke(grant_id, scheme), assign(project_key, scheme, dry_run previews impact), delete(scheme, dry_run). Holder types: applicationRole (any logged-in user), user (param=accountId), group (param=group name), projectRole (param=roleId), projectLead, reporter, assignee, userCustomField / groupCustomField (param=customfield id).',
    {
      action: z.enum(['list', 'get', 'create', 'grant', 'revoke', 'assign', 'delete']),
      scheme: z.string().optional().describe('Scheme id (or exact name)'),
      name: z.string().optional().describe('create: scheme name'),
      permission: z.string().optional().describe('grant: e.g. EDIT_ISSUES'),
      holder_type: z.string().optional(),
      holder_param: z.string().optional(),
      grant_id: z.string().optional().describe('revoke: grant id'),
      project_key: z.string().optional().describe('assign: project key'),
      dry_run: z.boolean().optional(),
      rationale: z.string().optional(),
    },
    async (a) => {
      const schemeId = async () => {
        if (a.scheme && !a.scheme.includes(' ')) {
          const s = await tf.call<{ permissionSchemes: { id: string; name: string }[] }>('GET', '/rest/api/2/permissionscheme');
          const found = s.permissionSchemes.find((x) => x.id === a.scheme || x.name === a.scheme);
          if (found) return found.id;
        }
        const s = await tf.call<{ permissionSchemes: { id: string; name: string }[] }>('GET', '/rest/api/2/permissionscheme');
        const found = s.permissionSchemes.find((x) => x.name === a.scheme);
        if (!found) throw new Error(`Scheme '${a.scheme}' not found.`);
        return found.id;
      };
      switch (a.action) {
        case 'list':
          return asText(await tf.call('GET', '/rest/api/2/permissionscheme'));
        case 'get':
          return asText(await tf.call('GET', `/rest/api/2/permissionscheme/${await schemeId()}?expand=permissions`));
        case 'create':
          return asText(await tf.call('POST', '/rest/api/2/permissionscheme', { body: { name: a.name }, rationale: a.rationale }));
        case 'grant':
          return asText(
            await tf.call('POST', `/rest/api/2/permissionscheme/${await schemeId()}/permission`, {
              body: { permission: a.permission, holder: { type: a.holder_type, parameter: a.holder_param } },
              rationale: a.rationale,
            })
          );
        case 'revoke':
          return asText(
            (await tf.call('DELETE', `/rest/api/2/permissionscheme/${await schemeId()}/permission/${a.grant_id}`, { rationale: a.rationale })) ?? { ok: true }
          );
        case 'assign':
          return asText(
            await tf.call('PUT', `/rest/api/2/project/${a.project_key?.toUpperCase()}/permissionscheme`, {
              body: { id: await schemeId() },
              dryRun: a.dry_run,
              rationale: a.rationale,
            })
          );
        case 'delete':
          return asText(
            (await tf.call('DELETE', `/rest/api/2/permissionscheme/${await schemeId()}`, { dryRun: a.dry_run, rationale: a.rationale })) ?? { ok: true }
          );
      }
    }
  );

  // --- Sprint 021: admin console (admin-scoped) ---

  if (write) wtool(
    'manage_user',
    'Admin: list/create/update users, deactivate/reactivate, reset password, list a user\'s tokens. Actions: list, create(email, display_name, password?, is_admin?, type?, owner_id?, is_assignable?, approval_policy?), update(account_id + fields), deactivate(account_id), reactivate(account_id), reset_password(account_id, password), tokens(account_id). Deactivating the last active admin is refused; deactivated users cannot log in or be assigned.',
    {
      action: z.enum(['list', 'create', 'update', 'deactivate', 'reactivate', 'reset_password', 'tokens']),
      account_id: z.string().optional().describe('User accountId (uuid)'),
      email: z.string().optional(),
      display_name: z.string().optional(),
      password: z.string().optional(),
      is_admin: z.boolean().optional(),
      type: z.enum(['human', 'agent']).optional(),
      owner_id: z.string().optional().describe('Owning user for agent accounts'),
      is_assignable: z.boolean().optional().describe('047 — appears in the delegate picker'),
      approval_policy: z.enum(['always', 'destructiveOnly', 'never']).optional()
        .describe('047 — autonomy gate: always parks all writes, destructiveOnly parks DELETEs'),
      require_approval: z.boolean().optional().describe('Legacy: maps to approval_policy=always'),
      rationale: z.string().optional(),
    },
    async (a) => {
      const uid = a.account_id ? encodeURIComponent(a.account_id) : '';
      switch (a.action) {
        case 'list':
          return asText(await tf.call('GET', '/api/internal/users'));
        case 'create':
          return asText(await tf.call('POST', '/api/internal/users', {
            body: {
              email: a.email, displayName: a.display_name, password: a.password,
              isAdmin: a.is_admin, type: a.type, ownerId: a.owner_id,
              isAssignableAgent: a.is_assignable, approvalPolicy: a.approval_policy,
            }, rationale: a.rationale }));
        case 'deactivate':
          return asText(await tf.call('PATCH', `/api/internal/users/${uid}`, { body: { active: false }, rationale: a.rationale }));
        case 'reactivate':
          return asText(await tf.call('PATCH', `/api/internal/users/${uid}`, { body: { active: true }, rationale: a.rationale }));
        case 'reset_password':
          return asText(await tf.call('PATCH', `/api/internal/users/${uid}`, { body: { password: a.password }, rationale: a.rationale }));
        case 'tokens':
          return asText(await tf.call('GET', `/api/internal/users/${uid}/tokens`));
        case 'update':
          return asText(await tf.call('PATCH', `/api/internal/users/${uid}`, {
            body: {
              ...(a.email !== undefined ? { email: a.email } : {}),
              ...(a.display_name !== undefined ? { displayName: a.display_name } : {}),
              ...(a.is_admin !== undefined ? { isAdmin: a.is_admin } : {}),
              ...(a.require_approval !== undefined ? { requireApproval: a.require_approval } : {}),
              ...(a.is_assignable !== undefined ? { isAssignableAgent: a.is_assignable } : {}),
              ...(a.approval_policy !== undefined ? { approvalPolicy: a.approval_policy } : {}),
              ...(a.password !== undefined ? { password: a.password } : {}),
            }, rationale: a.rationale }));
      }
    }
  );

  if (write) wtool(
    'revoke_token',
    'Admin: revoke a PAT by id. Use manage_user action=tokens to find ids. Irreversible — the token stops authenticating immediately.',
    { token_id: z.string(), rationale: z.string().optional() },
    async (a) =>
      asText((await tf.call('DELETE', `/api/internal/tokens/${encodeURIComponent(a.token_id)}`, { rationale: a.rationale })) ?? { ok: true })
  );

  server.tool(
    'query_audit',
    'Admin: query the security audit log — who did what, when. Filters: actor_id, action substring (e.g. "issue.delete"), entity_type (issue|project|user|token|…), entity_id (e.g. TF-9), from/to ISO dates. Paginate with start_at/max_results (≤1000).',
    {
      actor_id: z.string().optional(),
      action: z.string().optional().describe('Substring, case-insensitive'),
      entity_type: z.string().optional(),
      entity_id: z.string().optional().describe('Entity id or issue key'),
      from: z.string().optional().describe('ISO date lower bound'),
      to: z.string().optional().describe('ISO date upper bound'),
      start_at: z.number().optional(),
      max_results: z.number().optional(),
    },
    async (a) => {
      const q = new URLSearchParams();
      if (a.actor_id) q.set('actorId', a.actor_id);
      if (a.action) q.set('action', a.action);
      if (a.entity_type) q.set('entityType', a.entity_type);
      if (a.entity_id) q.set('entityId', a.entity_id);
      if (a.from) q.set('from', a.from);
      if (a.to) q.set('to', a.to);
      if (a.start_at !== undefined) q.set('startAt', String(a.start_at));
      if (a.max_results !== undefined) q.set('maxResults', String(a.max_results));
      const qs = q.toString();
      return asText(await tf.call('GET', `/api/internal/audit${qs ? `?${qs}` : ''}`));
    }
  );

  if (write) wtool(
    'update_project',
    'Admin: update a project — name, description, lead (account_id or email), category (category_id or null to clear), or archive/restore via action. Archived projects are read-only and hidden from pickers.',
    {
      project_key: z.string(),
      action: z.enum(['update', 'archive', 'restore']).optional().describe('default: update'),
      name: z.string().optional(),
      description: z.string().optional(),
      lead: z.string().optional().describe('Lead accountId or email; empty string clears'),
      category_id: z.string().nullable().optional().describe('ProjectCategory id — see projectcategories API; null clears'),
      rationale: z.string().optional(),
    },
    async (a) => {
      const pk = a.project_key.toUpperCase();
      if (a.action === 'archive') return asText(await tf.call('POST', `/rest/api/2/project/${pk}/archive`, { rationale: a.rationale }));
      if (a.action === 'restore') return asText(await tf.call('POST', `/rest/api/2/project/${pk}/restore`, { rationale: a.rationale }));
      const body: Record<string, unknown> = {};
      if (a.name !== undefined) body.name = a.name;
      if (a.description !== undefined) body.description = a.description;
      if (a.lead !== undefined) body.lead = a.lead === '' ? null : { accountId: a.lead };
      if (a.category_id !== undefined) body.categoryId = a.category_id;
      return asText(await tf.call('PUT', `/rest/api/2/project/${pk}`, { body, rationale: a.rationale }));
    }
  );

  // --- Sprint 016: ops / job inspection (admin) ---

  server.tool(
    'get_job_status',
    'Lists durable background jobs or fetches one by id (admin). Filter by `state` = waiting|active|completed|failed. Returns id, name, attemptsMade, failedReason, state.',
    {
      id: z.string().optional().describe('Job id — omit to list all'),
      state: z.enum(['waiting', 'active', 'completed', 'failed']).optional(),
    },
    async (a) =>
      asText(
        a.id
          ? await tf.call('GET', `/api/internal/admin/jobs/${a.id}`)
          : await tf.call('GET', `/api/internal/admin/jobs${a.state ? `?state=${a.state}` : ''}`)
      )
  );

  if (write) wtool(
    'retry_job',
    'Requeues a dead-lettered durable job by id (admin).',
    {
      id: z.string().describe('Job id'),
      rationale: z.string().optional(),
    },
    async (a) =>
      asText(await tf.call('POST', `/api/internal/admin/jobs/${a.id}/retry`, { rationale: a.rationale }))
  );

  // --- Sprint 017: Jira Cloud migration (admin) ---

  server.tool(
    'get_import_status',
    'Lists Jira Cloud import jobs or fetches one by id (admin). Returns stage (discovering→done|failed), per-entity plan counts, unsupported entities, warnings and verify diffs.',
    { id: z.string().optional().describe('Import job id — omit to list recent') },
    async (a) =>
      asText(await tf.call('GET', a.id ? `/api/internal/migration/${a.id}` : '/api/internal/migration'))
  );

  if (write) wtool(
    'start_jira_import',
    'Starts a staged Jira Cloud import (admin). dryRun=true plans only and writes nothing — always dry-run first and review the report. projectKeys is required.',
    {
      baseUrl: z.string().optional().describe('Jira site base URL, e.g. https://org.atlassian.net'),
      email: z.string().optional(),
      apiToken: z.string().optional().describe('Jira API token — or pass secretRef instead'),
      secretRef: z.string().optional().describe('Env var name holding the token'),
      projectKeys: z.array(z.string()).min(1),
      dryRun: z.boolean().optional().describe('Plan only — writes nothing (default false)'),
      deltaFrom: z.string().optional().describe('ISO date — only import entities updated since'),
    },
    async (a) =>
      asText(await tf.call('POST', '/api/internal/migration/jira-cloud', { body: a }))
  );

  if (write) wtool(
    'start_jira_server_import',
    'Starts a live Jira Server/DC import over /rest/api/2 (admin). authMode basic=username+password|token, pat=Bearer (Jira>=8.14). Preflight confirms Server/DC and resolves instance-specific custom-field ids by name. Always dry-run first.',
    {
      baseUrl: z.string().describe('Server/DC base URL, e.g. https://jira.corp.local — context paths preserved'),
      authMode: z.enum(['basic', 'pat']).describe('basic=username+password/token; pat=Bearer token'),
      username: z.string().optional().describe('Required for basic'),
      apiToken: z.string().optional().describe('Password or PAT — or pass secretRef instead'),
      secretRef: z.string().optional().describe('Env var name holding the token'),
      projectKeys: z.array(z.string()).min(1),
      dryRun: z.boolean().optional().describe('Plan only — writes nothing (default false)'),
      deltaFrom: z.string().optional().describe('ISO date — only import entities updated since'),
      fieldAliases: z.record(z.string()).optional().describe('Override alias→customfield id, e.g. {storyPoints:"customfield_10030"}'),
      groups: z.array(z.string()).optional().describe('Group names whose members join user discovery (large instances)'),
      allowPrivate: z.boolean().optional().describe('Opt-in: allow loopback/private/link-local baseUrl'),
      insecureSkipVerify: z.boolean().optional().describe('Opt-in: skip TLS verify for self-signed instances (recorded on job)'),
    },
    async (a) =>
      asText(await tf.call('POST', '/api/internal/migration/jira-server', { body: a }))
  );

  if (write) wtool(
    'resume_import',
    'Resumes a failed/interrupted Jira import by job id (admin). Ops are idempotent — resume converges.',
    { id: z.string().describe('Import job id') },
    async (a) =>
      asText(await tf.call('POST', `/api/internal/migration/${a.id}/resume`, {}))
  );

  // --- Sprint 049: OAuth grants (user-facing — admin stays API-only) ---

  server.tool(
    'list_my_grants',
    'Lists OAuth clients the current user has consented to (client name, scopes, granted-at). Revoke with revoke_grant.',
    {},
    async () => asText(await tf.call('GET', '/api/internal/me/grants'))
  );

  if (write) wtool(
    'revoke_grant',
    'Revokes one of the current user\'s OAuth grants by id — kills the refresh chain instantly (access tokens die within minutes).',
    { id: z.string().describe('Grant id from list_my_grants') },
    async (a) => asText(await tf.call('DELETE', `/api/internal/me/grants/${a.id}`))
  );

  // --- Sprint 050: docs-as-product — agents answer from shipped docs ---

  server.tool(
    'search_docs',
    'Searches TrackForge\'s shipped documentation (user guide, admin/ops, identity, migration, API compat) and returns matching pages with excerpts. Use get_doc for the full page.',
    { query: z.string().describe('Search terms, e.g. "PAT scopes" or "LDAP bind"') },
    async (a) => asText(await tf.call('GET', `/api/internal/docs/search?q=${encodeURIComponent(a.query)}`))
  );

  server.tool(
    'get_doc',
    'Fetches a full documentation page by slug (see search_docs results or the manifest for slugs). Returns markdown.',
    { slug: z.string().describe('Doc slug, e.g. identity, migration, security-model') },
    async (a) => {
      const page = await tf.call('GET', `/api/internal/docs/page/${encodeURIComponent(a.slug)}`) as { markdown?: string; title?: string };
      return asText({ slug: a.slug, title: page.title, markdown: page.markdown });
    }
  );

  // --- Sprint 019: components, versions & release hub ---

  if (write) wtool(
    'manage_components',
    'Lists components for a project, or creates/updates/deletes one (write op required for mutations). Components are project-scoped; deleting removes issue refs (or set move_issues_to to swap them to another component).',
    {
      project_key: z.string().describe('Project key (list/create)'),
      op: z.enum(['list', 'create', 'update', 'delete']).optional().describe('list (default)'),
      component_id: z.string().optional().describe('update/delete: component id'),
      name: z.string().optional().describe('create/update'),
      description: z.string().optional(),
      lead_account_id: z.string().optional().describe('create/update: component lead account id'),
      assignee_type: z.enum(['PROJECT_DEFAULT', 'COMPONENT_LEAD', 'PROJECT_LEAD', 'UNASSIGNED']).optional()
        .describe('create/update: default assignee for new issues in this component'),
      move_issues_to: z.string().optional().describe('delete: component id to move issue refs to'),
      rationale: z.string().optional(),
    },
    async (a) => {
      const key = a.project_key.toUpperCase();
      if (a.op === 'create')
        return asText(await tf.call('POST', '/rest/api/2/component', {
          body: { project: key, name: a.name, description: a.description, leadAccountId: a.lead_account_id, assigneeType: a.assignee_type },
          rationale: a.rationale,
        }));
      if (a.op === 'update' && a.component_id)
        return asText(await tf.call('PUT', `/rest/api/2/component/${a.component_id}`, {
          body: { name: a.name, description: a.description, leadAccountId: a.lead_account_id, assigneeType: a.assignee_type },
          rationale: a.rationale,
        }));
      if (a.op === 'delete' && a.component_id)
        return asText((await tf.call('DELETE', `/rest/api/2/component/${a.component_id}`, {
          query: a.move_issues_to ? { moveIssuesTo: a.move_issues_to } : undefined,
          rationale: a.rationale,
        })) ?? { ok: true });
      return asText(await tf.call('GET', `/rest/api/2/project/${key}/components`));
    }
  );

  if (write) wtool(
    'manage_versions',
    'Lists versions for a project (ordered), or creates/updates/deletes one. move: position "Earlier"|"Later"|"First"|"Last" or after=another version. Delete swaps refs via move_fix_issues_to / move_affected_issues_to.',
    {
      project_key: z.string().describe('Project key (list/create)'),
      op: z.enum(['list', 'create', 'update', 'delete', 'move']).optional().describe('list (default)'),
      version_id: z.string().optional().describe('update/delete/move: version id'),
      name: z.string().optional().describe('create/update'),
      description: z.string().optional(),
      released: z.boolean().optional(),
      archived: z.boolean().optional(),
      start_date: z.string().optional().describe('ISO date'),
      release_date: z.string().optional().describe('ISO date'),
      position: z.enum(['Earlier', 'Later', 'First', 'Last']).optional().describe('move'),
      after: z.string().optional().describe('move: version id to place after'),
      move_fix_issues_to: z.string().optional().describe('delete: version id to move fixVersion refs to'),
      move_affected_issues_to: z.string().optional().describe('delete: version id to move affects refs to'),
      rationale: z.string().optional(),
    },
    async (a) => {
      const key = a.project_key.toUpperCase();
      const body = {
        project: key, name: a.name, description: a.description,
        released: a.released, archived: a.archived, startDate: a.start_date, releaseDate: a.release_date,
      };
      if (a.op === 'create')
        return asText(await tf.call('POST', '/rest/api/2/version', { body, rationale: a.rationale }));
      if (a.op === 'update' && a.version_id)
        return asText(await tf.call('PUT', `/rest/api/2/version/${a.version_id}`, { body, rationale: a.rationale }));
      if (a.op === 'move' && a.version_id)
        return asText(await tf.call('POST', `/rest/api/2/version/${a.version_id}/move`, {
          body: { position: a.position, after: a.after }, rationale: a.rationale,
        }));
      if (a.op === 'delete' && a.version_id)
        return asText((await tf.call('DELETE', `/rest/api/2/version/${a.version_id}`, {
          query: {
            ...(a.move_fix_issues_to ? { moveFixIssuesTo: a.move_fix_issues_to } : {}),
            ...(a.move_affected_issues_to ? { moveAffectedIssuesTo: a.move_affected_issues_to } : {}),
          },
          rationale: a.rationale,
        })) ?? { ok: true });
      return asText(await tf.call('GET', `/rest/api/2/project/${key}/versions`));
    }
  );

  if (write) wtool(
    'release_version',
    'Marks a version released and stamps its release date (idempotent). dry_run=true returns the issue rollup it would produce (status counts + grouped issues) without releasing.',
    {
      version_id: z.string().describe('Version id'),
      release_date: z.string().optional().describe('ISO date — defaults to today'),
      dry_run: z.boolean().optional().describe('Preview the rollup without releasing'),
      rationale: z.string().optional(),
    },
    async (a) => {
      if (a.dry_run) {
        const [counts, unresolved] = await Promise.all([
          tf.call('GET', `/rest/api/2/version/${a.version_id}/relatedIssueCounts`),
          tf.call('GET', `/rest/api/2/version/${a.version_id}/unresolvedIssueCount`),
        ]);
        return asText({ dryRun: true, relatedIssueCounts: counts, unresolvedIssueCount: unresolved });
      }
      return asText(await tf.call('POST', `/rest/api/2/version/${a.version_id}/release`, {
        body: a.release_date ? { releaseDate: a.release_date } : {},
        rationale: a.rationale,
      }));
    }
  );

  server.tool(
    'get_release_notes',
    'Returns release notes for a version: done issues grouped by issue type (markdown-friendly shape). Get version ids from manage_versions.',
    { version_id: z.string().describe('Version id') },
    async (a) => asText(await tf.call('GET', `/rest/api/2/version/${a.version_id}/releasenotes`))
  );

  // --- Sprint 018: attachments ---

  if (write) wtool(
    'attach_file',
    'Uploads a local file to an issue (Jira attachment API). dry_run=true reports the file size/type and the server upload limit WITHOUT uploading — use it first on large files. Returns Jira attachment metadata (id, filename, content/thumbnail URLs).',
    {
      issue_key: z.string().describe('Issue key, e.g. TF-12'),
      path: z.string().describe('Local file path to upload'),
      dry_run: z.boolean().optional().describe('Report size/type/limits without uploading'),
      rationale: z.string().optional(),
    },
    async (a) => {
      const { stat, readFile } = await import('node:fs/promises');
      const { basename } = await import('node:path');
      const st = await stat(a.path);
      const meta = (await tf.call('GET', '/rest/api/2/attachment/meta')) as { enabled?: boolean; uploadLimit?: number };
      if (a.dry_run) {
        return asText({
          file: a.path,
          filename: basename(a.path),
          sizeBytes: st.size,
          uploadLimitBytes: meta.uploadLimit ?? null,
          fits: meta.uploadLimit ? st.size <= meta.uploadLimit : null,
        });
      }
      if (meta.uploadLimit && st.size > meta.uploadLimit) {
        throw new ToolError(413, [`File is ${st.size}B — exceeds the ${meta.uploadLimit}B attachment limit.`], {});
      }
      const buf = await readFile(a.path);
      return asText(await tf.upload(`/rest/api/2/issue/${a.issue_key.toUpperCase()}/attachments`, {
        data: new Blob([buf]), filename: basename(a.path),
      }, { rationale: a.rationale }));
    }
  );

  server.tool(
    'list_attachments',
    'Lists attachment metadata on an issue (id, filename, size, mime, author, created, content/thumbnail URLs).',
    { issue_key: z.string().describe('Issue key, e.g. TF-12') },
    async (a) => {
      const issue = (await tf.call('GET', `/rest/api/2/issue/${a.issue_key.toUpperCase()}`, {
        query: { fields: 'attachment' },
      })) as { fields?: { attachment?: unknown[] } };
      return asText(issue.fields?.attachment ?? []);
    }
  );

  server.tool(
    'download_attachment',
    'Downloads an attachment to a local path. Use list_attachments to get ids; dest_path defaults to ./<filename>.',
    {
      attachment_id: z.string(),
      dest_path: z.string().optional().describe('Local destination path (defaults to ./<filename>)'),
    },
    async (a) => {
      const { writeFile } = await import('node:fs/promises');
      const { join, basename } = await import('node:path');
      const { data, filename, contentType } = await tf.getBinary(`/rest/api/2/attachment/content/${a.attachment_id}`);
      const dest = a.dest_path ?? join('.', basename(filename ?? `attachment-${a.attachment_id}`));
      await writeFile(dest, data);
      return asText({ saved: dest, bytes: data.length, contentType });
    }
  );

  if (write) wtool(
    'delete_attachment',
    'Deletes an attachment by id (own uploads always allowed; others need DELETE_ALL_ATTACHMENTS). Use list_attachments to get ids.',
    {
      attachment_id: z.string(),
      rationale: z.string().optional(),
    },
    async (a) =>
      asText(
        (await tf.call('DELETE', `/rest/api/2/attachment/${a.attachment_id}`, {
          rationale: a.rationale,
        })) ?? { deleted: true, id: a.attachment_id }
      )
  );

  if (write) wtool(
    'move_to_epic',
    'Moves issues under an epic (epic_key) or removes them from their epic (omit epic_key).',
    {
      issue_keys: z.array(z.string()).min(1),
      epic_key: z.string().optional().describe('Epic issue key — omit to remove from epic'),
      rationale: z.string().optional(),
    },
    async (a) =>
      asText(
        (await tf.call('POST', `/rest/agile/1.0/epic/${a.epic_key?.toUpperCase() ?? 'none'}/issue`, {
          body: { issues: a.issue_keys.map((k) => k.toUpperCase()) },
          rationale: a.rationale,
        })) ?? { ok: true }
      )
  );

  // --- Sprint 010: JQL engine & saved filters ---

  server.tool(
    'validate_jql',
    'Validates a JQL query without running it. Returns the parsed structure (where/orderBy) or Jira-style syntax errors with positions. Call this before search_issues when composing a query.',
    { jql: z.string().describe('JQL query to validate') },
    async ({ jql }) => {
      const res = await tf.call<{ queries: { query: string; structure?: unknown; errors: string[] }[] }>(
        'POST',
        '/rest/api/2/jql/parse',
        { body: { queries: [jql] } }
      );
      const r = res.queries[0];
      return asText(
        r.errors?.length
          ? { valid: false, errors: r.errors, hint: 'Fix the query — field names/operators are documented by jql_help.' }
          : { valid: true, structure: r.structure }
      );
    }
  );

  server.tool(
    'jql_help',
    'Returns the supported JQL surface: searchable fields with allowed operators and value types, date/user functions, orderable fields, and reserved words. Read this before composing JQL.',
    {},
    async () =>
      asText({
        grammar: JQL_HINT,
        precedence: 'NOT > AND > OR (use parentheses to override)',
        fields: (await tf.call<{ visibleFieldNames: unknown[] }>('GET', '/rest/api/2/jql/autocompletedata'))
          .visibleFieldNames,
        note: 'GET /jql/autocompletedata also lists functions and reserved words — this returns the field matrix which is the most useful part for agents.',
      })
  );

  server.tool(
    'list_filters',
    'Lists saved filters: yours, ones you starred, and shared filters. scope "favourite" returns only starred filters; "all" returns every visible filter.',
    {
      scope: z.enum(['my', 'favourite', 'all']).optional().describe('my=own (default), favourite=starred, all=visible'),
      name_contains: z.string().optional().describe('Filter names by substring (scope=all)'),
    },
    async ({ scope, name_contains }) => {
      const q = name_contains ? `?filterName=${encodeURIComponent(name_contains)}` : '';
      if (scope === 'favourite') return asText(await tf.call('GET', '/rest/api/2/filter/favourite'));
      if (scope === 'all') return asText(await tf.call('GET', `/rest/api/2/filter${q}`));
      return asText(await tf.call('GET', '/rest/api/2/filter/my'));
    }
  );

  server.tool(
    'run_filter',
    'Runs a saved filter by id and returns its first page of issues. Accepts start_at/max_results for pagination.',
    {
      filter_id: z.string().describe('Filter id (from list_filters)'),
      start_at: z.number().int().min(0).optional(),
      max_results: z.number().int().min(1).max(100).optional(),
    },
    async ({ filter_id, start_at, max_results }) => {
      const res = await tf.call<{ startAt: number; maxResults: number; total: number; issues: unknown[] }>(
        'GET',
        `/rest/api/2/filter/${encodeURIComponent(filter_id)}/run`,
        { query: { startAt: start_at ?? 0, maxResults: Math.min(100, max_results ?? 20) } }
      );
      const nextAt = res.startAt + res.issues.length;
      return asText({ ...res, nextStartAt: nextAt < res.total ? nextAt : null });
    }
  );

  if (write) wtool(
    'save_filter',
    'Creates a saved filter from a JQL query (name required; JQL validated server-side). Optionally pass share_permissions (Jira rows) — e.g. [{type:"group",groupname:"dev"}] — or visibility "all" as shorthand for a global share. Returns the filter id — run it with run_filter.',
    {
      name: z.string().describe('Filter name'),
      jql: z.string().describe('JQL query — validate with validate_jql first'),
      description: z.string().optional(),
      visibility: z.enum(['private', 'all']).optional().describe('private (default) or all'),
      share_permissions: z
        .array(z.record(z.unknown()))
        .optional()
        .describe('Jira sharePermissions rows: {type:"group",groupname}, {type:"project",projectKey|projectId}, {type:"projectRole",projectKey|projectId,roleName|roleId}, {type:"user",userKey|accountId}, {type:"global"|"authenticated"}'),
    },
    async ({ name, jql, description, visibility, share_permissions }) =>
      asText(
        await tf.call('POST', '/rest/api/2/filter', {
          body: {
            name,
            jql,
            description,
            sharePermissions: share_permissions ?? (visibility === 'all' ? [{ type: 'global' }] : []),
          },
        })
      )
  );

  if (write) wtool(
    'share_filter',
    'Manages share permissions on a saved filter you own (Jira /filter/{id}/permission). action add posts one permission row; remove deletes it by permission id; list shows current rows. Permissions: global | authenticated | group(groupname) | project(projectKey|projectId) | projectRole(projectKey|projectId + roleName|roleId) | user(userKey|accountId).',
    {
      filter_id: z.string().describe('Filter id'),
      action: z.enum(['list', 'add', 'remove']).describe('list rows, add one row, or remove by permission id'),
      permission: z
        .record(z.unknown())
        .optional()
        .describe('For add — the permission object, e.g. {type:"group",groupname:"dev"}'),
      permission_id: z.string().optional().describe('For remove — the sharePermission id from list'),
    },
    async ({ filter_id, action, permission, permission_id }) => {
      const base = `/rest/api/2/filter/${encodeURIComponent(filter_id)}/permission`;
      if (action === 'list') return asText(await tf.call('GET', base));
      if (action === 'add') {
        if (!permission) throw new ToolError(400, ['permission object required for action=add'], {});
        return asText(await tf.call('POST', base, { body: permission }));
      }
      if (!permission_id) throw new ToolError(400, ['permission_id required for action=remove'], {});
      return asText(await tf.call('DELETE', `${base}/${encodeURIComponent(permission_id)}`));
    }
  );

  // ---------- events, webhooks, watching, your work (011) ----------

  server.tool(
    'get_events',
    'Reads the durable event feed (transactional outbox) after a cursor. Event ids are monotonic — pass the last id you saw as `after` to get only new events; the response nextCursor continues the feed. Filter by types (e.g. jira:issue_updated, comment_created) and/or projects. A 410 means your cursor expired — resync with after=0. Each event carries actor+channel so you can ignore your own actions (loop guard).',
    {
      after: z.number().int().min(0).optional().describe('Last seen event id (default 0 = from the start)'),
      types: z.array(z.string()).optional().describe('Event types, e.g. ["jira:issue_updated","comment_created"]'),
      projects: z.array(z.string()).optional().describe('Project keys, e.g. ["TF"]'),
      limit: z.number().int().min(1).max(500).optional().describe('Page size, default 100, max 500'),
    },
    async ({ after, types, projects, limit }) => {
      const query = new URLSearchParams();
      if (after) query.set('after', String(after));
      if (types?.length) query.set('types', types.join(','));
      if (projects?.length) query.set('projects', projects.join(','));
      if (limit) query.set('limit', String(limit));
      return asText(await tf.call('GET', `/api/internal/events${query.size ? `?${query}` : ''}`));
    }
  );

  if (write) wtool(
    'watch_issue',
    'Watches an issue — you (or, as admin, another user) get in-app notifications on its changes. Creators, assignees and commenters auto-watch.',
    {
      issue_key: z.string().describe('Issue key, e.g. TF-1'),
      account_id: z.string().optional().describe('User to add as watcher (admin only; default: yourself)'),
      dry_run: z.boolean().optional().describe('Validate + preview only; nothing is persisted'),
    },
    async ({ issue_key, account_id, dry_run }) =>
      asText(
        await tf.call('POST', `/rest/api/2/issue/${issue_key.toUpperCase()}/watchers`, {
          dryRun: dry_run,
          body: account_id ? { accountId: account_id } : undefined,
        }) ?? { watching: true }
      )
  );

  if (write) wtool(
    'unwatch_issue',
    'Stops watching an issue.',
    {
      issue_key: z.string().describe('Issue key'),
      account_id: z.string().optional().describe('User to remove (admin only; default: yourself)'),
    },
    async ({ issue_key, account_id }) =>
      asText(
        await tf.call(
          'DELETE',
          `/rest/api/2/issue/${issue_key.toUpperCase()}/watchers${account_id ? `?accountId=${encodeURIComponent(account_id)}` : ''}`
        ) ?? { watching: false }
      )
  );

  if (write) wtool(
    'vote_issue',
    'Votes for an issue — the same user re-voting is a no-op (Jira idempotent).',
    {
      issue_key: z.string().describe('Issue key'),
    },
    async ({ issue_key }) =>
      asText(
        await tf.call('POST', `/rest/api/2/issue/${issue_key.toUpperCase()}/votes`) ?? { voted: true }
      )
  );

  if (write) wtool(
    'unvote_issue',
    'Removes your vote from an issue.',
    {
      issue_key: z.string().describe('Issue key'),
    },
    async ({ issue_key }) =>
      asText(
        await tf.call('DELETE', `/rest/api/2/issue/${issue_key.toUpperCase()}/votes`) ?? { voted: false }
      )
  );

  server.tool(
    'list_remote_links',
    'Lists an issue’s remote (web) links — Jira remotelink objects.',
    {
      issue_key: z.string().describe('Issue key'),
    },
    async ({ issue_key }) =>
      asText(await tf.call('GET', `/rest/api/2/issue/${issue_key.toUpperCase()}/remotelink`))
  );

  if (write) wtool(
    'link_remote',
    'Adds a remote (web) link to an issue — Jira remotelink.',
    {
      issue_key: z.string().describe('Issue key'),
      url: z.string().describe('Link target URL'),
      title: z.string().describe('Link title'),
      summary: z.string().optional(),
      global_id: z.string().optional().describe('Caller-scoped dedupe id'),
    },
    async ({ issue_key, url, title, summary, global_id }) =>
      asText(
        await tf.call('POST', `/rest/api/2/issue/${issue_key.toUpperCase()}/remotelink`, {
          body: { object: { url, title, summary }, globalId: global_id },
        })
      )
  );

  if (write) wtool(
    'unlink_remote',
    'Removes a remote link by id.',
    {
      issue_key: z.string().describe('Issue key'),
      link_id: z.string().describe('Remote link id (from list_remote_links)'),
    },
    async ({ issue_key, link_id }) =>
      asText(
        await tf.call('DELETE', `/rest/api/2/issue/${issue_key.toUpperCase()}/remotelink/${link_id}`) ?? { removed: true }
      )
  );

  if (write) wtool(
    'clone_issue',
    'Clones an issue — "CLONE - " summary prefix, Cloners link, you auto-watch. dry_run=true previews the would-be issue without creating it.',
    {
      issue_key: z.string().describe('Issue key'),
      summary: z.string().optional().describe('Clone summary (default "CLONE - <original>")'),
      include_links: z.boolean().optional(),
      include_subtasks: z.boolean().optional(),
      include_attachments: z.boolean().optional(),
      include_watchers: z.boolean().optional(),
      include_votes: z.boolean().optional(),
      dry_run: z.boolean().optional(),
    },
    async (a) =>
      asText(
        await tf.call('POST', `/api/internal/issues/${a.issue_key.toUpperCase()}/clone`, {
          body: {
            summary: a.summary,
            dryRun: a.dry_run,
            options: {
              includeLinks: a.include_links,
              includeSubtasks: a.include_subtasks,
              includeAttachments: a.include_attachments,
              includeWatchers: a.include_watchers,
              includeVotes: a.include_votes,
            },
          },
        })
      )
  );

  if (write) wtool(
    'move_issue',
    'Moves an issue to another project (optionally changing issue type/status) — dry_run=true previews the new key + dropped fields. Needs MOVE_ISSUES on the source and CREATE_ISSUES on the target.',
    {
      issue_key: z.string().describe('Issue key'),
      project_key: z.string().describe('Target project key'),
      issue_type: z.string().optional().describe('Target issue type name (defaults to same name)'),
      status: z.string().optional().describe('Target status name'),
      dry_run: z.boolean().optional(),
    },
    async (a) =>
      asText(
        await tf.call('POST', `/api/internal/issues/${a.issue_key.toUpperCase()}/move`, {
          body: {
            target: { projectKey: a.project_key.toUpperCase(), issueTypeName: a.issue_type, statusName: a.status },
            dryRun: a.dry_run,
          },
        })
      )
  );

  if (write) wtool(
    'bulk_change',
    'Bulk operation on many issues (TF ext): op ∈ edit|transition|move|delete|comment|watch|link. Select via issue_keys (≤500) or jql. ALWAYS run dry_run=true first to preview the per-item plan (A4/A7), then re-run without it to execute — returns job_id; poll with get_bulk_job.',
    {
      op: z.enum(['edit', 'transition', 'move', 'delete', 'comment', 'watch', 'link']),
      issue_keys: z.array(z.string()).max(500).optional().describe('Explicit keys — omit to use jql'),
      jql: z.string().optional().describe('JQL selecting the issues (≤500 match cap)'),
      payload: z.record(z.string(), z.unknown()).optional().describe('Op payload, e.g. {fields:{labels:[..]}}, {transitionId}, {body}, {type,inwardKey}, {target:{projectKey}}'),
      dry_run: z.boolean().optional().describe('Plan-only preview — required before execute'),
    },
    async (a) =>
      asText(
        await tf.call('POST', `/api/internal/bulk/${a.op}`, {
          body: { issueKeys: a.issue_keys, jql: a.jql, payload: a.payload, dryRun: a.dry_run },
        })
      )
  );

  server.tool(
    'get_bulk_job',
    'Bulk job status: total/done/succeeded/failed counters plus the per-item results table.',
    { job_id: z.string() },
    async ({ job_id }) => asText(await tf.call('GET', `/api/internal/bulk/job/${job_id}`))
  );

  server.tool(
    'export_issues',
    'Export the issue list as CSV (Excel-friendly, UTF-8 BOM) or print HTML. Columns default to key,summary,issuetype,status,priority,assignee,reporter,created; custom-field ids are valid columns.',
    {
      jql: z.string().optional().describe('JQL filter (same permissions as search)'),
      format: z.enum(['csv', 'print']).optional(),
      columns: z.string().optional().describe('Comma-separated column ids'),
    },
    async (a) => {
      const q = new URLSearchParams();
      if (a.jql) q.set('jql', a.jql);
      q.set('format', a.format ?? 'csv');
      if (a.columns) q.set('columns', a.columns);
      return asText(await tf.call('GET', `/api/internal/export/issues?${q}`));
    }
  );

  server.tool(
    'print_issue',
    'Print-friendly HTML page for one issue (fields + description + comments) — for PDF-print workflows.',
    { issue_key: z.string() },
    async ({ issue_key }) => asText(await tf.call('GET', `/api/internal/export/issue/${issue_key.toUpperCase()}?format=print`))
  );

  server.tool(
    'get_my_work',
    'Your work dashboard: issues assigned to you (open), issues you watch (open), issues you reported, and your 10 most recent views. Use it to orient at session start.',
    {},
    async () => asText(await tf.call('GET', '/api/internal/me/work'))
  );

  server.tool(
    'list_webhooks',
    'Lists registered webhooks (admin). Each webhook posts Jira-shaped payloads for its subscribed events, optionally filtered by JQL and signed with HMAC-SHA256.',
    {},
    async () => asText(await tf.call('GET', '/rest/webhooks/1.0/webhook'))
  );

  if (write) wtool(
    'register_webhook',
    'Registers a webhook (admin). Subscribes `events` (e.g. jira:issue_updated, comment_created) at `url`; `jql` scopes delivery to matching issues (e.g. project = TF); `secret` signs bodies with HMAC-SHA256 (X-Hub-Signature-256 header); `exclude_actor_ids` prevents loops by skipping events from those users (e.g. your own agent user). Private/loopback URLs are refused unless the server sets WEBHOOK_ALLOW_PRIVATE.',
    {
      name: z.string().describe('Webhook name'),
      url: z.string().url().describe('POST target URL'),
      events: z.array(z.string()).min(1).describe('Event names, e.g. ["jira:issue_updated","comment_created"]'),
      jql: z.string().optional().describe('JQL filter (issue-related-events-section), e.g. "project = TF AND labels = deploy"'),
      secret: z.string().optional().describe('HMAC-SHA256 signing secret (auto-generated if omitted)'),
      exclude_actor_ids: z.array(z.string()).optional().describe('Actor account ids to skip (loop guard — include your own)'),
      enabled: z.boolean().optional(),
    },
    async ({ name, url, events, jql, secret, exclude_actor_ids, enabled }) =>
      asText(
        await tf.call('POST', '/rest/webhooks/1.0/webhook', {
          body: {
            name, url, events,
            ...(jql ? { filters: { 'issue-related-events-section': jql } } : {}),
            ...(secret ? { secret } : {}),
            ...(exclude_actor_ids?.length ? { excludeActorIds: exclude_actor_ids } : {}),
            ...(enabled !== undefined ? { enabled } : {}),
          },
        })
      )
  );

  // ---------- AI copilot & approvals (012) ----------

  if (write) wtool(
    'summarize_issue',
    'AI-summarises an issue: current state, decisions from comments, open questions, suggested next step. Requires AI configured on the server (Settings → AI) — returns a 404 error otherwise.',
    { issue_key: z.string().describe('Issue key, e.g. TF-1') },
    async ({ issue_key }) =>
      asText(await tf.call('POST', `/api/internal/ai/issues/${issue_key.toUpperCase()}/summary`))
  );

  server.tool(
    'find_similar_issues',
    'Finds issues semantically similar to an issue or free text — duplicate detection before creating. Requires an embedding model in Settings → AI. Returns up to 5 {key,summary,status,score}.',
    {
      issue_key: z.string().optional().describe('Anchor issue key'),
      text: z.string().optional().describe('Free text to match (e.g. a summary you are about to create)'),
      project_key: z.string().optional().describe('Restrict matches to this project (text mode)'),
    },
    async ({ issue_key, text, project_key }) => {
      if (issue_key) {
        return asText(await tf.call('GET', `/api/internal/ai/issues/${issue_key.toUpperCase()}/similar`));
      }
      if (!text) return asText({ hint: 'Provide issue_key or text.' });
      const q = new URLSearchParams({ text });
      if (project_key) q.set('project', project_key.toUpperCase());
      return asText(await tf.call('GET', `/api/internal/ai/similar?${q}`));
    }
  );

  if (write) wtool(
    'suggest_resolution',
    'Suggests how to resolve an issue from similar already-resolved issues — verified server-side: the pick is restricted to resolutions the evidence actually carries and confidence is computed from evidence weight, not self-reported. Returns {resolution:{id,name}|null, confidence, diagnosis, basedOn[{key,summary,resolution,score}], reason}. Read-only; apply with get_transitions + transition_issue. Requires AI + embeddings configured.',
    { issue_key: z.string().describe('Issue key, e.g. TF-1') },
    async ({ issue_key }) =>
      asText(await tf.call('POST', `/api/internal/ai/issues/${issue_key.toUpperCase()}/suggest-resolution`))
  );

  if (write) wtool(
    'jql_from_text',
    'Translates a natural-language request into validated JQL using the server AI. Verify the returned jql (it is parsed server-side) then run it with search_issues.',
    { text: z.string().describe('e.g. "my open bugs updated this week"') },
    async ({ text }) =>
      asText(await tf.call('POST', '/api/internal/ai/jql', { body: { text } }))
  );

  server.tool(
    'list_my_proposals',
    'Lists your pending/resolved proposals — writes your gated token parked for human approval. Poll this after a write returns pendingApproval.',
    {
      status: z.enum(['pending', 'approved', 'rejected', 'expired', 'failed']).optional(),
      project_key: z.string().optional(),
    },
    async ({ status, project_key }) => {
      const q = new URLSearchParams();
      if (status) q.set('status', status);
      if (project_key) q.set('project', project_key.toUpperCase());
      return asText(await tf.call('GET', `/api/internal/proposals${q.size ? `?${q}` : ''}`));
    }
  );

  server.tool(
    'get_proposal',
    'Gets one proposal by id: the parked request (method/path/body), its dry-run diff, status, and the result/error once resolved.',
    { proposal_id: z.string().describe('Proposal id from a 202 response or list_my_proposals') },
    async ({ proposal_id }) =>
      asText(await tf.call('GET', `/api/internal/proposals/${encodeURIComponent(proposal_id)}`))
  );

  // --- Sprint 026: dashboards & gadgets ---

  server.tool(
    'list_dashboards',
    'Lists dashboards visible to you (own + shared + system), optionally filtered by name or owner.',
    {
      name_contains: z.string().optional().describe('Filter by dashboard-name substring'),
      owner: z.string().optional().describe('Filter by owner display-name substring'),
    },
    async ({ name_contains, owner }) => {
      const q = new URLSearchParams();
      if (name_contains) q.set('dashboardName', name_contains);
      if (owner) q.set('owner', owner);
      const path = q.size ? `/rest/api/2/dashboard/search?${q}` : '/rest/api/2/dashboard';
      return asText(await tf.call('GET', path));
    }
  );

  server.tool(
    'get_dashboard',
    'Gets one dashboard: metadata, share/edit permissions, and its gadgets (type, position, config).',
    { dashboard_id: z.string().describe('Dashboard id (from list_dashboards)') },
    async ({ dashboard_id }) =>
      asText(await tf.call('GET', `/rest/api/2/dashboard/${encodeURIComponent(dashboard_id)}`))
  );

  server.tool(
    'get_dashboard_data',
    'Resolves every gadget on a dashboard with live data, evaluated under YOUR permissions (not the owner). Returns one entry per gadget with either data or an error card.',
    { dashboard_id: z.string().describe('Dashboard id'), gadget_id: z.string().optional().describe('Resolve only this gadget') },
    async ({ dashboard_id, gadget_id }) =>
      asText(await tf.call('GET', gadget_id
        ? `/api/internal/dashboards/${encodeURIComponent(dashboard_id)}/gadgets/${encodeURIComponent(gadget_id)}/data`
        : `/api/internal/dashboards/${encodeURIComponent(dashboard_id)}/data`))
  );

  if (write) wtool(
    'update_dashboard',
    'Creates or updates a dashboard: name, description, column layout, share/edit permissions. Omit dashboard_id to create.',
    {
      dashboard_id: z.string().optional().describe('Existing dashboard id; omit to create'),
      name: z.string().optional(),
      description: z.string().optional(),
      columns: z.number().int().min(1).max(3).optional(),
      delete: z.boolean().optional().describe('Delete instead (owner/admin only)'),
    },
    async ({ dashboard_id, name, description, columns, delete: del }) => {
      if (del && dashboard_id) {
        await tf.call('DELETE', `/rest/api/2/dashboard/${encodeURIComponent(dashboard_id)}`);
        return asText({ deleted: dashboard_id });
      }
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (description !== undefined) body.description = description;
      if (columns !== undefined) body.layout = { columns };
      return asText(await tf.call(dashboard_id ? 'PUT' : 'POST',
        dashboard_id ? `/rest/api/2/dashboard/${encodeURIComponent(dashboard_id)}` : '/rest/api/2/dashboard',
        { body }));
    }
  );

  if (write) wtool(
    'share_dashboard',
    'Sets a dashboard share/edit permissions. type: global|loggedin|group|project|project-role|user. target: group name, project key, user id, or role id (project-role also needs target2=project key).',
    {
      dashboard_id: z.string(),
      share_permissions: z.array(z.object({ type: z.string(), target: z.string().optional(), target2: z.string().optional() })).optional(),
      edit_permissions: z.array(z.object({ type: z.string(), target: z.string().optional(), target2: z.string().optional() })).optional(),
    },
    async ({ dashboard_id, share_permissions, edit_permissions }) =>
      asText(await tf.call('PUT', `/rest/api/2/dashboard/${encodeURIComponent(dashboard_id)}`, {
        body: { sharePermissions: share_permissions, editPermissions: edit_permissions },
      }))
  );

  if (write) wtool(
    'create_gadget',
    'Adds a gadget to a dashboard. Types (see /rest/api/2/dashboard/gadgets): assigned-to-me, filter-results, recently-updated, watched-issues, pie-chart, two-dimensional, created-vs-resolved, sprint-health, burndown-chart, velocity-chart, activity-stream.',
    {
      dashboard_id: z.string(),
      type: z.string().describe('Gadget type key'),
      config: z.record(z.any()).optional().describe('Per-type config, e.g. {jql, statType} or {boardId}'),
      column: z.number().int().min(0).max(2).optional(),
      position: z.number().int().min(0).optional(),
      gadget_id: z.string().optional().describe('Existing gadget id → update instead of add'),
      delete: z.boolean().optional().describe('Remove the gadget (needs gadget_id)'),
    },
    async ({ dashboard_id, type, config, column, position, gadget_id, delete: del }) => {
      if (del && gadget_id) {
        await tf.call('DELETE', `/rest/api/2/dashboard/${encodeURIComponent(dashboard_id)}/gadget/${encodeURIComponent(gadget_id)}`);
        return asText({ deleted: gadget_id });
      }
      const path = gadget_id
        ? `/rest/api/2/dashboard/${encodeURIComponent(dashboard_id)}/gadget/${encodeURIComponent(gadget_id)}`
        : `/rest/api/2/dashboard/${encodeURIComponent(dashboard_id)}/gadget`;
      const body: Record<string, unknown> = {};
      if (type) body.type = type;
      if (config !== undefined) body.config = config;
      if (column !== undefined) body.column = column;
      if (position !== undefined) body.position = position;
      return asText(await tf.call(gadget_id ? 'PUT' : 'POST', path, { body }));
    }
  );

  // --- Sprint 027: reports (one tool for all types — D21) ---
  server.tool(
    'get_report',
    'Runs an analytics report and returns the JSON series plus key aggregates. Types: sprint, epic, burndown, velocity, cfd, control. Provide the params your report needs (board_id for cfd/control/velocity/burndown, sprint_id for sprint, epic_key for epic).',
    {
      type: z.enum(['sprint', 'epic', 'burndown', 'velocity', 'cfd', 'control',
        'pie', 'twoDimensional', 'createdVsResolved', 'workload', 'averageAge',
        'resolutionTime', 'timeTracking', 'timesheet', 'version', 'project', 'org']),
      board_id: z.string().optional(),
      sprint_id: z.string().optional(),
      epic_key: z.string().optional(),
      days: z.number().int().min(1).max(365).optional(),
      window: z.number().int().min(1).optional(),
      // 028 params
      jql: z.string().optional(),
      statType: z.string().optional().describe('pie grouping field'),
      xstatType: z.string().optional(),
      ystatType: z.string().optional(),
      groupBy: z.string().optional().describe('resolutionTime grouping field'),
      projectKey: z.string().optional(),
      versionId: z.string().optional(),
      userId: z.string().optional(),
      cumulative: z.boolean().optional(),
      list_types: z.boolean().optional().describe('Return the report registry instead of running a report'),
    },
    async ({ type, board_id, sprint_id, epic_key, days, window, list_types, jql, statType, xstatType, ystatType, groupBy, projectKey, versionId, userId, cumulative }) => {
      if (list_types) return asText(await tf.call('GET', '/api/internal/reports'));
      const q = jql ? `jql=${encodeURIComponent(jql)}` : '';
      let path: string;
      switch (type) {
        case 'sprint': path = `/api/internal/reports/board/${board_id}/sprint/${sprint_id}/report`; break;
        case 'epic': path = `/api/internal/reports/epic/${encodeURIComponent(epic_key!)}`; break;
        case 'burndown': path = `/api/internal/reports/board/${board_id}/burndown${sprint_id ? `?sprintId=${sprint_id}` : ''}`; break;
        case 'velocity': path = `/api/internal/reports/board/${board_id}/velocity`; break;
        case 'cfd': path = `/api/internal/reports/cfd/${board_id}?days=${days ?? 30}`; break;
        case 'control': path = `/api/internal/reports/control/${board_id}?days=${days ?? 30}&window=${window ?? 7}`; break;
        case 'pie': path = `/api/internal/reports/pie?${q}&statType=${statType ?? 'status'}`; break;
        case 'twoDimensional': path = `/api/internal/reports/two-dimensional?${q}&xstatType=${xstatType ?? 'status'}&ystatType=${ystatType ?? 'assignee'}`; break;
        case 'createdVsResolved': path = `/api/internal/reports/created-vs-resolved?${q}&days=${days ?? 30}&cumulative=${cumulative ?? false}`; break;
        case 'workload': path = `/api/internal/reports/workload${projectKey ? `?projectKey=${projectKey}` : ''}`; break;
        case 'averageAge': path = `/api/internal/reports/average-age${q ? `?${q}` : ''}`; break;
        case 'resolutionTime': path = `/api/internal/reports/resolution-time?groupBy=${groupBy ?? 'priority'}${q ? `&${q}` : ''}`; break;
        case 'timeTracking': path = `/api/internal/reports/time-tracking?${versionId ? `versionId=${versionId}` : sprint_id ? `sprintId=${sprint_id}` : projectKey ? `projectKey=${projectKey}` : ''}`; break;
        case 'timesheet': path = `/api/internal/reports/timesheet?${[userId ? `userId=${userId}` : '', projectKey ? `projectKey=${projectKey}` : ''].filter(Boolean).join('&')}`; break;
        case 'version': path = `/api/internal/reports/version/${versionId}`; break;
        case 'project': path = `/api/internal/reports/project/${projectKey}`; break;
        case 'org': path = '/api/internal/reports/org'; break;
      }
      return asText(await tf.call('GET', path));
    }
  );

  // --- Sprint 029: email & notification schemes ---
  if (write) wtool(
    'manage_notification_scheme',
    'Admin — list, create, update or delete notification schemes (event → recipient → channel matrices), or assign one to a project.',
    {
      action: z.enum(['list', 'create', 'update', 'delete', 'assign']),
      scheme_id: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      entries: z.array(z.object({
        event: z.string().describe('issue_created|issue_updated|issue_assigned|issue_deleted|comment_created|work_logged|sprint_event|version_event|mentioned|generic'),
        channel: z.enum(['email', 'inapp']).optional(),
        recipientKind: z.enum(['reporter', 'assignee', 'watchers', 'mentioned', 'projectlead', 'projectrole', 'group', 'user']),
        recipientRef: z.string().optional().describe('roleId | group name | userId'),
      })).optional(),
      project_key: z.string().optional().describe('for assign'),
    },
    async ({ action, scheme_id, name, description, entries, project_key }) => {
      switch (action) {
        case 'list': return asText(await tf.call('GET', '/api/internal/notificationschemes'));
        case 'create': return asText(await tf.call('POST', '/api/internal/notificationschemes', { body: { name, description, entries } }));
        case 'update': return asText(await tf.call('PUT', `/api/internal/notificationschemes/${scheme_id}`, { body: { name, description, entries } }));
        case 'delete': return asText(await tf.call('DELETE', `/api/internal/notificationschemes/${scheme_id}`));
        case 'assign': return asText(await tf.call('POST', `/api/internal/projects/${project_key}/notificationscheme`, { body: { schemeId: scheme_id ?? null } }));
      }
    }
  );

  if (write) wtool(
    'send_test_mail',
    'Admin — send a test email through the configured SMTP adapter to verify the mail path.',
    { to: z.string().optional().describe('recipient address (default: calling admin)') },
    async ({ to }) => asText(await tf.call('POST', '/api/internal/admin/mail/test', { body: { to } }))
  );

  server.tool(
    'get_outbox',
    'Admin — inspect the EmailOutbox send log (who was emailed what, status, errors). Filter by status pending|sent|failed|digest.',
    { status: z.string().optional(), max_results: z.number().int().min(1).max(200).optional() },
    async ({ status, max_results }) => asText(await tf.call('GET', `/api/internal/admin/outbox${status ? `?status=${status}` : ''}${max_results ? `${status ? '&' : '?'}maxResults=${max_results}` : ''}`))
  );

  if (write) wtool(
    'subscribe_filter',
    'Subscribe to a saved filter — scheduled email of its results (daily|weekly). Pass subscription_id with action=unsubscribe to remove.',
    {
      action: z.enum(['list', 'subscribe', 'unsubscribe']),
      filter_id: z.string().optional(),
      frequency: z.enum(['daily', 'weekly']).optional(),
      day_of_week: z.number().int().min(0).max(6).optional(),
      hour: z.number().int().min(0).max(23).optional(),
      subscription_id: z.string().optional(),
    },
    async ({ action, filter_id, frequency, day_of_week, hour, subscription_id }) => {
      switch (action) {
        case 'list': return asText(await tf.call('GET', `/api/internal/filters/${filter_id}/subscriptions`));
        case 'subscribe': return asText(await tf.call('POST', `/api/internal/filters/${filter_id}/subscriptions`, { body: { frequency: frequency ?? 'daily', dayOfWeek: day_of_week, hour } }));
        case 'unsubscribe': return asText(await tf.call('DELETE', `/api/internal/filters/${filter_id}/subscriptions/${subscription_id}`));
      }
    }
  );

  if (write) wtool(
    'update_preferences',
    'Get or set notification preferences — per-event/channel toggles, autowatch flags, digest mode (immediate|daily).',
    {
      events: z.record(z.record(z.boolean())).optional().describe('event → channel → enabled'),
      autowatch: z.object({ create: z.boolean().optional(), comment: z.boolean().optional(), assign: z.boolean().optional() }).optional(),
      digest: z.enum(['immediate', 'daily']).optional(),
      locale: z.string().optional().describe('036 — e.g. en_US, de_DE'),
      timezone: z.string().optional().describe('036 — IANA tz, e.g. Europe/Berlin'),
      date_format: z.string().optional().describe('036 — e.g. d/MMM/yy'),
    },
    async ({ events, autowatch, digest, locale, timezone, date_format }) => {
      if (locale !== undefined || timezone !== undefined || date_format !== undefined) {
        return asText(await tf.call('PUT', '/api/internal/me', { body: { locale, timezone, dateFormat: date_format } }));
      }
      if (events === undefined && autowatch === undefined && digest === undefined) {
        return asText(await tf.call('GET', '/api/internal/me/preferences'));
      }
      return asText(await tf.call('PUT', '/api/internal/me/preferences', { body: { events, autowatch, digest } }));
    }
  );

  server.tool(
    'get_dev_status',
    'Issue development panel — branches, pull requests, commits, builds and deployments linked to the issue (038).',
    { issue_key: z.string().describe('e.g. TF-1') },
    async ({ issue_key }) => asText(await tf.call('GET', `/api/internal/issues/${issue_key}/development`)),
  );

  if (write) wtool(
    'reprocess_delivery',
    'Admin: re-run a stored webhook delivery through ingest — re-links items when issues were created after the delivery arrived (038). Admin-only.',
    {
      repo_id: z.string().describe('DevRepository id (from manage_dev_repositories / admin connections)'),
      delivery_id: z.string().describe('DevDelivery row id — list via GET /api/internal/dev/repositories/{repo_id}/deliveries'),
    },
    async ({ repo_id, delivery_id }) => asText(await tf.call('POST',
      `/api/internal/dev/repositories/${encodeURIComponent(repo_id)}/deliveries/${encodeURIComponent(delivery_id)}/reprocess`)),
  );

  server.tool(
    'get_profile',
    'Read the caller\'s profile — identity, locale/timezone/date-format prefs, 2FA status, open assigned issues and recent comments (036).',
    {},
    async () => asText(await tf.call('GET', '/api/internal/me')),
  );

  // --- Sprint 041: roadmap / scheduling ---
  server.tool(
    'get_roadmap',
    'Roadmap feed for a board — epic bars (start/due/child-rollup progress/links) plus version pins; level=issues returns the full Gantt row set (per-issue type, parent, links). Same permission-filtered data the Timeline view renders (A1).',
    {
      board: z.string().describe('board id or project key (default board)'),
      level: z.enum(['epics', 'issues']).optional().describe('epics = roadmap bars; issues = every row for Gantt'),
      status: z.string().optional(), assignee: z.string().optional(), label: z.string().optional(),
    },
    async ({ board, level, status, assignee, label }) => {
      const qs = new URLSearchParams();
      if (level) qs.set('level', level);
      if (status) qs.set('status', status);
      if (assignee) qs.set('assignee', assignee);
      if (label) qs.set('label', label);
      const suffix = qs.size ? `?${qs}` : '';
      return asText(await tf.call('GET', `/api/internal/roadmap/${encodeURIComponent(board)}${suffix}`));
    },
  );

  if (write) wtool(
    'set_schedule',
    "Set an issue's Start date / Due date (the 014 startdate CF + duedate system field) — the same write the Timeline drag performs. Validates start <= due; dry_run previews the change.",
    {
      issue_key: z.string().describe('e.g. TF-1'),
      start: z.string().optional().describe('YYYY-MM-DD'),
      due: z.string().optional().describe('YYYY-MM-DD'),
      dry_run: z.boolean().optional(),
    },
    async ({ issue_key, start, due, dry_run }) => {
      if (!start && !due) throw new Error('nothing to set — pass start and/or due');
      if (start && due && start > due) throw new Error('start must be <= due');
      const fields: Record<string, string> = {};
      if (start) fields.startdate = start;
      if (due) fields.duedate = due;
      if (dry_run) return asText({ dryRun: true, issue_key, fields });
      await tf.call('PUT', `/rest/api/2/issue/${issue_key}`, { body: { fields } });
      return asText({ updated: issue_key, fields });
    },
  );

  // --- Sprint 031: scheme layer tools ---
  if (write) wtool(
    'manage_screens',
    'Admin — manage screens (tabs + ordered fields), screen schemes (create/edit/view ops) and issue-type screen schemes. Actions: list_screens, get_screen, create_screen, update_screen, delete_screen, set_tabs, list_schemes, create_scheme, update_scheme, delete_scheme, assign (bind issueTypeScreenScheme to project).',
    {
      action: z.enum(['list_screens', 'get_screen', 'create_screen', 'update_screen', 'delete_screen',
        'set_tabs', 'list_schemes', 'create_scheme', 'update_scheme', 'delete_scheme',
        'list_itss', 'create_itss', 'update_itss', 'delete_itss', 'assign']),
      screen_id: z.string().optional(),
      scheme_id: z.string().optional().describe('screen scheme id'),
      itss_id: z.string().optional().describe('issue-type screen scheme id'),
      project_key: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      tabs: z.array(z.object({ name: z.string(), fields: z.array(z.string()) })).optional()
        .describe('tab name + ordered registry field ids'),
      items: z.array(z.object({ operation: z.enum(['default', 'create', 'edit', 'view']), screenId: z.string() })).optional()
        .describe('screen scheme items — operation → screen'),
      default_scheme_id: z.string().optional().describe('ITSS default screen scheme'),
      mappings: z.array(z.object({ issueTypeId: z.string(), screenSchemeId: z.string() })).optional(),
    },
    async ({ action, screen_id, scheme_id, itss_id, project_key, name, description, tabs, items, default_scheme_id, mappings }) => {
      switch (action) {
        case 'list_screens': return asText(await tf.call('GET', '/rest/api/2/screens'));
        case 'get_screen': return asText(await tf.call('GET', `/rest/api/2/screens/${screen_id}`));
        case 'create_screen': return asText(await tf.call('POST', '/api/internal/screens', { body: { name, description, tabs } }));
        case 'update_screen': return asText(await tf.call('PUT', `/api/internal/screens/${screen_id}`, { body: { name, description } }));
        case 'delete_screen': return asText(await tf.call('DELETE', `/api/internal/screens/${screen_id}`));
        case 'set_tabs': return asText(await tf.call('PUT', `/api/internal/screens/${screen_id}/tabs`, { body: { tabs } }));
        case 'list_schemes': return asText(await tf.call('GET', '/api/internal/screenschemes'));
        case 'create_scheme': return asText(await tf.call('POST', '/api/internal/screenschemes', { body: { name, description, items } }));
        case 'update_scheme': return asText(await tf.call('PUT', `/api/internal/screenschemes/${scheme_id}`, { body: { name, description, items } }));
        case 'delete_scheme': return asText(await tf.call('DELETE', `/api/internal/screenschemes/${scheme_id}`));
        case 'list_itss': return asText(await tf.call('GET', '/api/internal/issuetypescreenschemes'));
        case 'create_itss': return asText(await tf.call('POST', '/api/internal/issuetypescreenschemes', { body: { name, description, defaultSchemeId: default_scheme_id, mappings } }));
        case 'update_itss': return asText(await tf.call('PUT', `/api/internal/issuetypescreenschemes/${itss_id}`, { body: { name, description, defaultSchemeId: default_scheme_id, mappings } }));
        case 'delete_itss': return asText(await tf.call('DELETE', `/api/internal/issuetypescreenschemes/${itss_id}`));
        case 'assign': return asText(await tf.call('POST', `/api/internal/projects/${project_key}/issuetypescreenscheme`, { body: { schemeId: itss_id ?? null } }));
      }
    }
  );

  if (write) wtool(
    'manage_field_configuration',
    'Admin — manage field configurations (required/hidden/description/defaultValue + conditional rules) and their schemes. Actions: list, get, create, update, delete, list_schemes, create_scheme, update_scheme, delete_scheme, assign (bind scheme to project).',
    {
      action: z.enum(['list', 'get', 'create', 'update', 'delete', 'list_schemes', 'create_scheme', 'update_scheme', 'delete_scheme', 'assign']),
      config_id: z.string().optional(),
      scheme_id: z.string().optional(),
      project_key: z.string().optional(),
      name: z.string().optional(),
      description: z.string().optional(),
      items: z.array(z.object({
        fieldId: z.string(),
        required: z.boolean().optional(),
        hidden: z.boolean().optional(),
        description: z.string().optional(),
        defaultValue: z.unknown().optional(),
        rules: z.array(z.object({
          when: z.record(z.unknown()).describe('context match, e.g. {field:"priority",is:"Highest"}'),
          required: z.boolean().optional(),
          hidden: z.boolean().optional(),
          defaultValue: z.unknown().optional(),
        })).optional(),
      })).optional(),
      default_config_id: z.string().optional(),
      mappings: z.array(z.object({ issueTypeId: z.string(), configId: z.string() })).optional(),
    },
    async ({ action, config_id, scheme_id, project_key, name, description, items, default_config_id, mappings }) => {
      switch (action) {
        case 'list': return asText(await tf.call('GET', '/rest/api/2/fieldconfigurations'));
        case 'get': return asText(await tf.call('GET', `/rest/api/2/fieldconfigurations/${config_id}`));
        case 'create': return asText(await tf.call('POST', '/api/internal/fieldconfigurations', { body: { name, description, items } }));
        case 'update': return asText(await tf.call('PUT', `/api/internal/fieldconfigurations/${config_id}`, { body: { name, description, items } }));
        case 'delete': return asText(await tf.call('DELETE', `/api/internal/fieldconfigurations/${config_id}`));
        case 'list_schemes': return asText(await tf.call('GET', '/api/internal/fieldconfigurationschemes'));
        case 'create_scheme': return asText(await tf.call('POST', '/api/internal/fieldconfigurationschemes', { body: { name, description, defaultConfigId: default_config_id, mappings } }));
        case 'update_scheme': return asText(await tf.call('PUT', `/api/internal/fieldconfigurationschemes/${scheme_id}`, { body: { name, description, defaultConfigId: default_config_id, mappings } }));
        case 'delete_scheme': return asText(await tf.call('DELETE', `/api/internal/fieldconfigurationschemes/${scheme_id}`));
        case 'assign': return asText(await tf.call('POST', `/api/internal/projects/${project_key}/fieldconfigurationscheme`, { body: { schemeId: scheme_id ?? null } }));
      }
    }
  );

  if (write) wtool(
    'set_issue_security',
    'Set or clear the security level on an issue (fields.security). Actions: set | clear | list_schemes (Jira read) | assign_scheme (admin project bind). dry_run previews set/clear.',
    {
      action: z.enum(['set', 'clear', 'list_schemes', 'assign_scheme']),
      issue_key: z.string().optional(),
      level: z.string().optional().describe('security level id or name'),
      scheme_id: z.string().optional(),
      project_key: z.string().optional(),
      dry_run: z.boolean().optional().describe('set/clear: validate + preview only'),
    },
    async ({ action, issue_key, level, scheme_id, project_key }) => {
      switch (action) {
        case 'list_schemes': return asText(await tf.call('GET', '/rest/api/2/issuesecurityschemes'));
        case 'assign_scheme': return asText(await tf.call('POST', `/api/internal/projects/${project_key}/issuesecurityscheme`, { body: { schemeId: scheme_id ?? null } }));
        case 'clear':
          await tf.call('PUT', `/rest/api/2/issue/${issue_key}`, { body: { fields: { security: null } } });
          return asText({ ok: true, security: null });
        case 'set':
          await tf.call('PUT', `/rest/api/2/issue/${issue_key}`, { body: { fields: { security: /^[0-9a-f-]{36}$/i.test(level ?? '') ? { id: level } : { name: level } } } });
          return asText({ ok: true, security: level });
      }
    }
  );

  // ---------- Sprint 047: agent experience (delegate, sessions, questions) ----------

  if (write) wtool(
    'delegate_issue',
    'Delegate an issue to an agent (Jira `fields.delegate`) — the assignee stays accountable; the delegate works it and a session opens. Agent must be an assignable agent account.',
    {
      issue_key: z.string().describe('e.g. TF-1'),
      agent: z.string().describe('agent account name or accountId'),
      clear: z.boolean().optional().describe('true clears the delegate'),
      dry_run: z.boolean().optional().describe('Validate + preview only; nothing is persisted'),
    },
    async ({ issue_key, agent, clear }) => {
      await tf.call('PUT', `/rest/api/2/issue/${issue_key}`, {
        body: { fields: { delegate: clear ? null : { name: agent } } },
      });
      return asText({ delegated: clear ? null : agent, issue: issue_key });
    },
  );

  server.tool(
    'list_agent_sessions',
    'List agent sessions on an issue — delegation/mention/rule-spawned runs with status, agent, delegator and activity counts. Inspectable history of agent work (047 US2).',
    { issue_key: z.string().describe('e.g. TF-1') },
    async ({ issue_key }) => asText(await tf.call('GET', `/api/internal/issues/${issue_key}/sessions`)),
  );

  server.tool(
    'get_agent_session',
    'Get one agent session with its full activity timeline (thoughts, actions, errors) and open questions.',
    { session_id: z.string() },
    async ({ session_id }) => asText(await tf.call('GET', `/api/internal/agent-sessions/${session_id}`)),
  );

  if (write) wtool(
    'emit_activity',
    'Report progress on your agent session — a thought, an action taken, or an error. Pass status to close the run (done/failed) or mark it blocked. Activities appear on the issue for humans.',
    {
      session_id: z.string(),
      type: z.enum(['thought', 'action', 'error']).describe('what this entry represents'),
      text: z.string().describe('human-readable description, max 4000 chars'),
      status: z.enum(['running', 'blocked', 'done', 'failed']).optional()
        .describe('session transition to apply — omit to stay running'),
    },
    async ({ session_id, type, text, status }) =>
      asText(await tf.call('POST', `/api/internal/agent-sessions/${session_id}/activities`, {
        body: { type, text, ...(status ? { status } : {}) },
      })),
  );

  if (write) wtool(
    'ask_user',
    'Ask the human a question — pauses your session (needs-answer) and notifies the delegator. Poll get_agent_question for the answer, or subscribe to the issue events stream.',
    {
      issue_key: z.string().describe('e.g. TF-1'),
      session_id: z.string(),
      question: z.string().describe('the question, max 4000 chars'),
      options: z.array(z.string()).optional().describe('up to 10 suggested answers'),
      expires_in_sec: z.number().int().min(60).optional().describe('default: session sweep decides'),
    },
    async ({ issue_key, session_id, question, options, expires_in_sec }) =>
      asText(await tf.call('POST', '/api/internal/agent-questions', {
        body: {
          issueKey: issue_key, sessionId: session_id, question,
          ...(options ? { options } : {}),
          ...(expires_in_sec ? { expiresInSec: expires_in_sec } : {}),
        },
      })),
  );

  server.tool(
    'get_agent_question',
    'Poll a question you asked — status, answer text, who answered and when. Status pending = still waiting; answered = resume your work.',
    { question_id: z.string() },
    async ({ question_id }) => asText(await tf.call('GET', `/api/internal/agent-questions/${question_id}`)),
  );

  // ---------- Sprint 051: GitLab integration ----------
  // Same endpoints the dev panel calls — branch/MR creation mutates the remote
  // GitLab, so both are write-gated; status is read-only.
  server.tool(
    'gitlab_connection_status',
    'List GitLab connections and their sync state (mode, cursors, last backfill, last error). Admin only.',
    { connection_id: z.string().optional().describe('omit to list all connections') },
    async ({ connection_id }) => {
      if (connection_id) return asText(await tf.call('GET', `/api/internal/dev/gitlab/connections/${connection_id}/status`));
      return asText(await tf.call('GET', '/api/internal/dev/gitlab/connections'));
    }
  );

  if (write) wtool(
    'gitlab_create_branch',
    'Create a GitLab branch for an issue (same path as the dev panel). Omit name to auto-generate <key>-<slug>; connection_id defaults to the first enabled connection.',
    {
      issue_key: z.string().describe('e.g. TF-9'),
      ref: z.string().describe('source ref to branch from, e.g. main'),
      name: z.string().optional().describe('branch name; auto-generated from the issue if omitted'),
      connection_id: z.string().optional(),
      dry_run: z.boolean().optional().describe('preview the would-be request without calling GitLab'),
    },
    async ({ issue_key, ref, name, connection_id, dry_run }) =>
      asText(await tf.call('POST', `/api/internal/issues/${issue_key.toUpperCase()}/gitlab/branch`, {
        body: { ref, name, connectionId: connection_id, dryRun: dry_run } }))
  );

  if (write) wtool(
    'gitlab_create_mr',
    'Open a GitLab merge request for an issue (same path as the dev panel). connection_id defaults to the first enabled connection.',
    {
      issue_key: z.string().describe('e.g. TF-9'),
      source_branch: z.string(),
      target_branch: z.string(),
      title: z.string().optional().describe('defaults to "<key> <summary>"'),
      connection_id: z.string().optional(),
      dry_run: z.boolean().optional(),
    },
    async ({ issue_key, source_branch, target_branch, title, connection_id, dry_run }) =>
      asText(await tf.call('POST', `/api/internal/issues/${issue_key.toUpperCase()}/gitlab/merge-request`, {
        body: { sourceBranch: source_branch, targetBranch: target_branch, title, connectionId: connection_id, dryRun: dry_run } }))
  );

  // --- Sprint 033: boards & navigator polish (moved out of registerResources in 056) ---

  server.tool(
    'list_boards',
    'List agile boards — all, or every board of a project via project_key (N:1 since Sprint 033; the project\'s isDefault board is what legacy project-key board links resolve to).',
    {
      project_key: z.string().optional().describe('project key — lists all its boards when set'),
    },
    async ({ project_key }) => {
      const qs = project_key ? `?projectKeyOrId=${encodeURIComponent(project_key)}` : '';
      return asText(await tf.call('GET', `/rest/agile/1.0/board${qs}`));
    }
  );

  if (write) wtool(
    'manage_board',
    'Manage agile boards — actions: create (name + project_key; optional type, filter_id, filter_jql, make_default), update (rename/bind filter or direct JQL), set_default, delete (default board needs promote_to unless it is the last one), set_card_config (colors/daysInColumn/hideDone/swimlaneBy/indicators).',
    {
      action: z.enum(['create', 'update', 'set_default', 'delete', 'set_card_config']),
      board: z.string().optional().describe('board id, or project key for its default board'),
      name: z.string().optional(),
      type: z.enum(['scrum', 'kanban']).optional(),
      project_key: z.string().optional().describe('required for create'),
      filter_id: z.string().nullable().optional().describe('saved filter id (Jira board location model); null unbinds'),
      filter_jql: z.string().nullable().optional().describe('direct JQL text (TF-native; overrides filterId when filter_id unset)'),
      make_default: z.boolean().optional(),
      promote_to: z.string().optional().describe('board id to promote when deleting the default'),
      card_config: z.record(z.unknown()).optional(),
      rationale: z.string().optional(),
    },
    async ({ action, board, name, type, project_key, filter_id, filter_jql, make_default, promote_to, card_config, rationale }) => {
      switch (action) {
        case 'create': {
          const created = (await tf.call('POST', '/rest/agile/1.0/board', {
            body: { name, type, filterId: filter_id ?? undefined, location: { projectKeyOrId: project_key } },
            rationale,
          })) as { id?: string };
          if (filter_jql || make_default) {
            await tf.call('PUT', `/api/internal/boards/${created.id}`, {
              body: { ...(filter_jql ? { filter: filter_jql } : {}) },
            });
            if (make_default) await tf.call('POST', `/api/internal/boards/${created.id}/default`);
          }
          return asText(created);
        }
        case 'update':
          return asText(await tf.call('PUT', `/api/internal/boards/${encodeURIComponent(board!)}`, {
            body: { name, filterId: filter_id, filter: filter_jql },
            rationale,
          }));
        case 'set_default':
          return asText(await tf.call('POST', `/api/internal/boards/${encodeURIComponent(board!)}/default`, { rationale }));
        case 'delete':
          return asText(await tf.call('DELETE', `/rest/agile/1.0/board/${encodeURIComponent(board!)}${promote_to ? `?promoteTo=${encodeURIComponent(promote_to)}` : ''}`, { rationale }));
        case 'set_card_config':
          return asText(await tf.call('PUT', `/api/internal/boards/${encodeURIComponent(board!)}/cardconfig`, { body: card_config, rationale }));
      }
    }
  );

  if (write) wtool(
    'manage_quick_filters',
    'Manage a board\'s quick filters (named JQL chips AND-composed onto board issues) — actions: list, get, create (name + jql; JQL validated server-side), update, delete. Read actions run on read-scoped tokens; writes surface the REST 403.',
    {
      action: z.enum(['list', 'get', 'create', 'update', 'delete']),
      board: z.string().describe('board id, or project key for its default board'),
      quick_filter_id: z.string().optional(),
      name: z.string().optional(),
      jql: z.string().optional(),
      position: z.number().int().optional(),
      rationale: z.string().optional(),
    },
    async ({ action, board, quick_filter_id, name, jql, position, rationale }) => {
      const b = encodeURIComponent(board);
      switch (action) {
        case 'list': return asText(await tf.call('GET', `/rest/agile/1.0/board/${b}/quickfilter`));
        case 'get': return asText(await tf.call('GET', `/rest/agile/1.0/board/${b}/quickfilter/${quick_filter_id}`));
        case 'create': return asText(await tf.call('POST', `/api/internal/boards/${b}/quickfilters`, { body: { name, jql, position }, rationale }));
        case 'update': return asText(await tf.call('PUT', `/api/internal/boards/${b}/quickfilters/${quick_filter_id}`, { body: { name, jql, position }, rationale }));
        case 'delete': return asText(await tf.call('DELETE', `/api/internal/boards/${b}/quickfilters/${quick_filter_id}`, { rationale }));
      }
    }
  );

  server.tool(
    'pick_issue',
    'Jira issue picker — search issues by exact key (PROJ-123), project prefix (PROJ), or summary text. Returns up to max_results issues with key/summary/type/status; visibility-scoped.',
    {
      query: z.string().describe('key, project-key prefix, or summary text'),
      max_results: z.number().int().min(1).max(50).optional(),
    },
    async ({ query, max_results }) => {
      const qs = `?query=${encodeURIComponent(query)}${max_results ? `&maxResults=${max_results}` : ''}`;
      return asText(await tf.call('GET', `/rest/api/2/issue/picker${qs}`));
    }
  );

  // ---------- Sprint 034: automation rules ----------
  server.tool(
    'list_rules',
    'List automation rules the caller can see (site admin: all; project admin/author: scoped).',
    {},
    async () => asText(await tf.call('GET', '/api/internal/automation/rules'))
  );

  server.tool(
    'get_rule',
    'Get one automation rule (name/scope/actor/trigger/conditions/actions/version/runs stats).',
    { rule: z.string().describe('rule id') },
    async ({ rule }) => asText(await tf.call('GET', `/api/internal/automation/rules/${rule}`))
  );

  if (write) wtool(
    'create_rule',
    'Create an automation rule — WHEN trigger IF conditions THEN actions. scope global|project (project needs project_key). trigger.type ∈ issue_created|issue_updated|issue_assigned|issue_transitioned|comment_created|issue_deleted|issue_linked|work_logged|scheduled(cron+jql)|manual. conditions: jql|field_equals|user_in_group|user_in_role|linked_issues_exist. actions: edit_fields|transition|assign|comment|add_labels|remove_labels|link_issues|move_to_sprint|webhook|ask_agent. Validated + dry-runnable before enabling.',
    {
      name: z.string(),
      scope: z.enum(['global', 'project']).optional(),
      project_key: z.string().optional(),
      trigger: z.record(z.unknown()),
      conditions: z.array(z.record(z.unknown())).optional(),
      actions: z.array(z.record(z.unknown())),
      enabled: z.boolean().optional(),
      dry_run: z.boolean().optional().describe('validate only — returns errors without creating'),
      rationale: z.string().optional(),
    },
    async ({ name, scope, project_key, trigger, conditions, actions, enabled, dry_run, rationale }) => {
      const body = { name, scope: scope ?? 'global', projectKey: project_key, trigger, conditions: conditions ?? [], actions, enabled };
      if (dry_run) return asText(await tf.call('POST', '/api/internal/automation/validate', { body }));
      return asText(await tf.call('POST', '/api/internal/automation/rules', { body, rationale }));
    }
  );

  if (write) wtool(
    'run_rule',
    'Manually execute a rule against an issue (or dry-run to preview steps without writing).',
    {
      rule: z.string(),
      issue_key: z.string().optional(),
      jql: z.string().optional().describe('dry-run selection alternative to issue_key'),
      dry_run: z.boolean().optional(),
      rationale: z.string().optional(),
    },
    async ({ rule, issue_key, jql, dry_run, rationale }) => {
      if (dry_run) return asText(await tf.call('POST', `/api/internal/automation/rules/${rule}/dry-run`, { body: { issueKey: issue_key, jql } }));
      return asText(await tf.call('POST', `/api/internal/automation/rules/${rule}/run`, { body: { issueKey: issue_key }, rationale }));
    }
  );

  server.tool(
    'get_rule_runs',
    'Step-level audit log of a rule\'s runs (or one run by run_id) — trigger/condition/action results, errors, emitted events.',
    { rule: z.string().optional(), run_id: z.string().optional(), max_results: z.number().int().optional() },
    async ({ rule, run_id, max_results }) => {
      if (run_id) return asText(await tf.call('GET', `/api/internal/automation/runs/${run_id}`));
      const qs = max_results ? `?maxResults=${max_results}` : '';
      return asText(await tf.call('GET', `/api/internal/automation/rules/${rule}/runs${qs}`));
    }
  );

  if (write) wtool(
    'toggle_rule',
    'Enable or disable an automation rule.',
    { rule: z.string(), enabled: z.boolean(), rationale: z.string().optional() },
    async ({ rule, enabled, rationale }) => asText(await tf.call('POST', `/api/internal/automation/rules/${rule}/toggle`, { body: { enabled }, rationale }))
  );
}

export function registerResources(server: McpServer) {
  const tf = boundClient();
  server.resource(
    'project',
    'trackforge://project/{key}',
    { description: 'A TrackForge project (Jira project object)' },
    async (uri) => {
      const key = uri.pathname.replace(/^\/+|\/+$/g, '').split('/').pop()!;
      const data = await tf.call('GET', `/rest/api/2/project/${key.toUpperCase()}`);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.resource(
    'issue',
    'trackforge://issue/{key}',
    { description: 'A TrackForge issue (Jira issue object with fields)' },
    async (uri) => {
      const key = uri.pathname.replace(/^\/+|\/+$/g, '').split('/').pop()!;
      const data = await tf.call('GET', `/rest/api/2/issue/${key.toUpperCase()}`);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.resource(
    'filter',
    'trackforge://filter/{id}',
    { description: 'A saved JQL filter (name, owner, JQL, sharing)' },
    async (uri) => {
      const id = uri.pathname.replace(/^\/+|\/+$/g, '').split('/').pop()!;
      const data = await tf.call('GET', `/rest/api/2/filter/${encodeURIComponent(id)}`);
      return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(data, null, 2) }] };
    }
  );
}

/**
 * resources/subscribe — emits notifications/resources/updated for subscribed
 * trackforge://issue/{key} URIs when the event stream reports a change.
 * The SSE pump starts lazily on first subscribe and follows the token.
 */
export function registerSubscriptions(server: McpServer, tf: TrackForgeClient) {
  const subscribed = new Set<string>();
  let stopStream: (() => void) | null = null;

  const ensureStream = () => {
    if (stopStream) return;
    stopStream = subscribeStream(
      `${tf.base()}/api/internal/events/stream`,
      tf.authHeaders(),
      (ev) => {
        if (ev.event !== 'tf-event' || !ev.data) return;
        try {
          const e = JSON.parse(ev.data) as { issueKey?: string };
          const uri = e.issueKey ? `trackforge://issue/${e.issueKey}` : null;
          if (uri && subscribed.has(uri)) {
            void server.server.sendResourceUpdated({ uri });
          }
        } catch {
          /* malformed event — skip */
        }
      },
      (err) => {
        console.error(`[trackforge-mcp] event stream closed: ${err}`);
        stopStream = null; // next subscribe reopens
      }
    );
  };

  server.server.setRequestHandler(SubscribeRequestSchema, async (req) => {
    subscribed.add(req.params.uri);
    ensureStream();
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (req) => {
    subscribed.delete(req.params.uri);
    if (subscribed.size === 0) {
      stopStream?.();
      stopStream = null;
    }
    return {};
  });
}
