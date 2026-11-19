import { ps } from '../lib/validation.js';
import { Router, type Router as RouterType } from 'express';
import crypto from 'crypto';
import {
  createIssue,
  previewCreateIssue,
  getIssueByKey,
  listChildren,
  updateIssue,
  previewUpdateIssue,
  assignIssue,
  previewAssignIssue,
  getIssueTransitions,
  executeTransition,
  previewTransition,
  deleteIssue,
  previewDeleteIssue,
  archiveIssue,
  restoreIssue,
  toIssueResponse,
  toIssueResponseWithCf,
  expandIssueResponse,
  parseSelection,
  relatedIssueIds,
  type CreateIssueInput,
  type UpdateIssueInput,
  type CfOp,
} from '../services/issueService.js';
import { getChangelog, toHistoryResponse } from '../services/changelogService.js';
import { getCreateMetaForProject, getEditMeta } from '../services/createmetaService.js';
import { KNOWN_FIELD_KEYS } from '../services/fieldRegistry.js';
import {
  listComments,
  addComment,
  getComment,
  editComment,
  deleteComment,
  toCommentResponse,
} from '../services/commentService.js';
import { watchState, addWatcher, removeWatcher } from '../services/notificationService.js';
import {
  voteState,
  addVote,
  removeVote,
  listRemoteLinks,
  createRemoteLink,
  deleteRemoteLink,
} from '../services/issueOpsService.js';
import {
  listWorklogs,
  addWorklog,
  planAddWorklog,
  updateWorklog,
  deleteWorklog,
  toWorklogResponse,
} from '../services/worklogService.js';
import { prisma } from '../prisma.js';
import type { Actor } from '../lib/auth.js';
import { audit } from '../services/auditService.js';
import { qs,
  createIssueSchema,
  compositeUpdateIssueSchema,
  transitionIssueSchema,
  bulkCreateSchema,
  assigneeBodySchema,
  commentSchema,
  worklogSchema,
  updateWorklogSchema,
  formatZodErrors,
} from '../lib/validation.js';
import { jiraError, JiraApiError } from '../lib/errors.js';
import { isAllowedExternalUrl, ALLOWED_URL_SCHEMES_LABEL } from '../lib/urls.js';
import { enforceIssueScope, projectAllowed } from '../middleware/auth.js';
import { requirePermission, hasPermission } from '../services/permissionService.js';
import { visibleIssueIds } from '../services/visibilityService.js';
import { ah, isDryRun, markDryRun, pageParams, resourceSelf, userSelf } from '../lib/http.js';

const router: RouterType = Router();

function extractCfInputs(fields: Record<string, unknown>): Record<string, unknown> | undefined {
  const cf: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!KNOWN_FIELD_KEYS.has(k)) cf[k] = v;
  }
  return Object.keys(cf).length ? cf : undefined;
}

/** Jira `fields.timetracking` → seconds-parseable input; read-only time keys rejected. */
function extractTimeTracking(fields: Record<string, unknown>) {
  for (const ro of ['timespent', 'worklog', 'workratio', 'progress']) {
    if (ro in fields) {
      throw new JiraApiError(
        400,
        jiraError([], {
          [`fields.${ro}`]: `Field '${ro}' cannot be set. It is not on the appropriate screen, or unknown.`,
        })
      );
    }
  }
  const tt = fields.timetracking as { originalEstimate?: string | null; remainingEstimate?: string | null } | undefined;
  if (!tt) return undefined;
  return {
    originalEstimate: tt.originalEstimate === null ? null : tt.originalEstimate,
    remainingEstimate: tt.remainingEstimate === null ? null : tt.remainingEstimate,
  };
}

function toCreateInput(fields: {
  project: { key: string };
  summary: string;
  description?: string;
  issuetype?: { name: string };
  priority?: { name: string };
  assignee?: { accountId?: string; name?: string } | null;
  delegate?: { accountId?: string; name?: string } | null; // 047
  labels?: string[];
  duedate?: string | null;
  parent?: { key: string } | null;
  story_points?: number | null;
  reporter?: { accountId?: string; name?: string };
  environment?: string | null;
  components?: { id?: string; name?: string }[];
  fixVersions?: { id?: string; name?: string }[];
  versions?: { id?: string; name?: string }[];
  security?: unknown;
}): CreateIssueInput {
  return {
    projectKey: fields.project.key,
    summary: fields.summary,
    description: fields.description,
    issueTypeName: fields.issuetype?.name,
    priorityName: fields.priority?.name,
    assignee: fields.assignee,
    delegate: fields.delegate, // 047
    labels: fields.labels,
    dueDate: fields.duedate ?? undefined,
    parentKey: fields.parent?.key ?? undefined,
    storyPoints: fields.story_points === null ? null : fields.story_points,
    reporter: fields.reporter ?? undefined,
    environment: fields.environment ?? undefined,
    components: fields.components,
    fixVersions: fields.fixVersions,
    affectsVersions: fields.versions,
    security: fields.security,
    timeTracking: extractTimeTracking(fields as Record<string, unknown>),
    customFields: extractCfInputs(fields as Record<string, unknown>),
  };
}

/** Merges Jira `fields` and `update` operations into one UpdateIssueInput. */
function toUpdateInput(body: {
  fields?: {
    summary?: string;
    description?: string | null;
    status?: { name: string };
    priority?: { name: string };
    issuetype?: { name: string };
    assignee?: { accountId?: string; name?: string } | null;
    delegate?: { accountId?: string; name?: string } | null; // 047
    labels?: string[];
    duedate?: string | null;
    resolution?: { name: string } | null;
    parent?: { key: string } | null;
    story_points?: number | null;
    reporter?: { accountId?: string; name?: string } | null;
    environment?: string | null;
    components?: { id?: string; name?: string }[];
    fixVersions?: { id?: string; name?: string }[];
    versions?: { id?: string; name?: string }[];
    security?: unknown;
  };
  update?: Record<string, { set?: unknown; add?: unknown; remove?: unknown; edit?: unknown }[]>;
  expectedVersion?: number;
  fenceToken?: number | null;
}): UpdateIssueInput {
  const f = body.fields ?? {};
  const input: UpdateIssueInput = {
    summary: f.summary,
    description: f.description ?? undefined,
    statusName: f.status?.name,
    priorityName: f.priority?.name,
    issueTypeName: f.issuetype?.name,
    assignee: f.assignee,
    delegate: f.delegate,
    labels: f.labels,
    dueDate: f.duedate,
    resolutionName: f.resolution === null ? null : f.resolution?.name,
    parentKey: f.parent === null ? null : f.parent?.key,
    storyPoints: f.story_points === null ? null : f.story_points,
    reporter: f.reporter,
    environment: f.environment,
    // 019: fields-form = set semantics for the release collections
    componentOps: f.components !== undefined ? { set: f.components } : undefined,
    fixVersionOps: f.fixVersions !== undefined ? { set: f.fixVersions } : undefined,
    affectsVersionOps: f.versions !== undefined ? { set: f.versions } : undefined,
    security: f.security,
    timeTracking: extractTimeTracking(f as Record<string, unknown>),
    customFields: extractCfInputs(f as Record<string, unknown>),
    expectedVersion: body.expectedVersion,
    fenceToken: body.fenceToken,
  };

  for (const [field, ops] of Object.entries(body.update ?? {})) {
    if (!KNOWN_FIELD_KEYS.has(field)) {
      // Custom-field update ops → CfOp[]
      const cfOps: CfOp[] = [];
      for (const op of ops) {
        if (op.set !== undefined) cfOps.push({ op: 'set', value: op.set });
        if (op.add !== undefined) cfOps.push({ op: 'add', value: op.add });
        if (op.remove !== undefined) cfOps.push({ op: 'remove', value: op.remove });
      }
      if (cfOps.length) (input.customFieldOps ??= {})[field] = cfOps;
      continue;
    }
    for (const op of ops) {
      if (field === 'timetracking') {
        // Jira `update` form: [{edit: {originalEstimate, remainingEstimate}}]
        const v = (op.edit ?? op.set) as
          | { originalEstimate?: string | null; remainingEstimate?: string | null }
          | undefined;
        if (v) {
          input.timeTracking = {
            originalEstimate: v.originalEstimate === null ? null : v.originalEstimate,
            remainingEstimate: v.remainingEstimate === null ? null : v.remainingEstimate,
          };
        }
        continue;
      }
      if (field === 'labels') {
        if (op.add !== undefined) (input.labelsAdd ??= []).push(String(op.add));
        if (op.remove !== undefined) (input.labelsRemove ??= []).push(String(op.remove));
        if (op.set !== undefined) input.labels = Array.isArray(op.set) ? op.set.map(String) : [String(op.set)];
      } else if (field === 'components' || field === 'fixVersions' || field === 'versions') {
        // 019: Jira update ops on release collections — refs are {name}|{id}
        const key =
          field === 'components' ? 'componentOps' : field === 'fixVersions' ? 'fixVersionOps' : 'affectsVersionOps';
        const bag = (input[key] ??= {});
        type Ref = { id?: string; name?: string };
        const asRefs = (v: unknown): Ref[] => (Array.isArray(v) ? v : [v]) as Ref[];
        if (op.set !== undefined) bag.set = asRefs(op.set);
        if (op.add !== undefined) (bag.add ??= []).push(...asRefs(op.add));
        if (op.remove !== undefined) (bag.remove ??= []).push(...asRefs(op.remove));
      } else if (op.set !== undefined) {
        const v = op.set as Record<string, unknown> | string | null;
        const name = typeof v === 'object' && v !== null ? String(v.name ?? '') : v == null ? null : String(v);
        if (field === 'summary') input.summary = name ?? undefined;
        else if (field === 'description') input.description = name;
        else if (field === 'status') input.statusName = name ?? undefined;
        else if (field === 'priority') input.priorityName = name ?? undefined;
        else if (field === 'issuetype') input.issueTypeName = name ?? undefined;
        else if (field === 'resolution') input.resolutionName = name;
        else if (field === 'duedate') input.dueDate = name;
        else if (field === 'security') input.security = v;
        else if (field === 'parent') input.parentKey = name;
        else if (field === 'story_points' || field === 'storyPoints') input.storyPoints = v == null ? null : Number(v);
        else if (field === 'assignee') {
          input.assignee = v == null ? null : { accountId: String((v as Record<string, unknown>)?.accountId ?? v) };
        }
      }
    }
  }
  return input;
}

router.post(
  '/',
  ah(async (req, res) => {
    const parsed = createIssueSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    if (!projectAllowed(req.actor!, parsed.data.fields.project.key)) {
      res.status(404).json(jiraError(['Project does not exist or you do not have permission to see it.']));
      return;
    }

    if (isDryRun(req)) {
      const preview = await previewCreateIssue(toCreateInput(parsed.data.fields), req.actor!);
      markDryRun(res);
      res.status(200).json(preview);
      return;
    }

    const issue = await createIssue(toCreateInput(parsed.data.fields), req.actor!);
    const visibleRelIds = await visibleIssueIds(req.actor!, relatedIssueIds([issue]));
    res.status(201).json(await toIssueResponseWithCf(issue, { actorId: req.actor!.user.id, visibleRelIds }));
  })
);

// Jira bulk create — per-item success/failure.
router.post(
  '/bulk',
  ah(async (req, res) => {
    const parsed = bulkCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const issues: unknown[] = [];
    const errors: { index: number; status: number; errorMessages: string[]; errors: Record<string, string> }[] = [];

    if (isDryRun(req)) {
      // 052 — per-item planCreate preview, zero writes.
      for (const [i, update] of parsed.data.issueUpdates.entries()) {
        try {
          if (!projectAllowed(req.actor!, update.fields.project.key)) {
            throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.']));
          }
          issues.push({ index: i, preview: await previewCreateIssue(toCreateInput(update.fields), req.actor!) });
        } catch (err) {
          if (err instanceof JiraApiError) {
            errors.push({ index: i, status: err.status, ...err.response });
          } else {
            throw err;
          }
        }
      }
      markDryRun(res);
      res.status(200).json({ dryRun: true, issues, errors });
      return;
    }

    // US3.4 — batchId gives per-item idempotency: a retried batch replays the
    // recorded result for items already created under `bulk:{batchId}:{index}`
    // instead of double-creating them after a mid-loop crash.
    const batchId = parsed.data.batchId;
    const principalId = req.actor!.token?.id ?? req.actor!.user.id;

    for (const [i, update] of parsed.data.issueUpdates.entries()) {
      try {
        if (!projectAllowed(req.actor!, update.fields.project.key)) {
          throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.']));
        }
        const itemHash = crypto
          .createHash('sha256')
          .update(`POST /issue/bulk ${JSON.stringify(update)}`)
          .digest('hex');
        if (batchId) {
          const key = `bulk:${batchId}:${i}`;
          const rec = await prisma.idempotencyRecord.findUnique({
            where: { principalId_key: { principalId, key } },
          });
          if (rec) {
            if (rec.requestHash !== itemHash) {
              errors.push({
                index: i,
                status: 422,
                errorMessages: [`batchId '${batchId}' item ${i} was already used with different fields.`],
                errors: {},
              });
            } else {
              issues.push({ index: i, ...(JSON.parse(rec.responseBody ?? '{}') as object), replayed: true });
            }
            continue;
          }
        }
        const issue = await createIssue(toCreateInput(update.fields), req.actor!);
        const r = toIssueResponse(issue);
        issues.push({ id: r.id, key: r.key, self: r.self });
        if (batchId) {
          await prisma.idempotencyRecord
            .create({
              data: {
                principalId,
                key: `bulk:${batchId}:${i}`,
                method: 'POST',
                path: '/rest/api/2/issue/bulk',
                requestHash: itemHash,
                status: 201,
                responseBody: JSON.stringify({ id: r.id, key: r.key, self: r.self }),
              },
            })
            .catch(() => undefined);
        }
      } catch (err) {
        if (err instanceof JiraApiError) {
          errors.push({ index: i, status: err.status, ...err.response });
        } else {
          throw err;
        }
      }
    }
    res.status(201).json({ issues, errors, ...(batchId ? { batchId } : {}) });
  })
);

// Jira createmeta — must precede /:key so 'createmeta' isn't read as an issue key.
// 065 audit C5 — the token allow-list alone let callers enumerate issue types
// and field metadata for projects they cannot browse.
async function createMetaVisible(actor: Actor, projectKey: string): Promise<boolean> {
  if (!projectAllowed(actor, projectKey)) return false;
  const project = await prisma.project.findUnique({ where: { key: projectKey }, select: { id: true } });
  if (!project) return false;
  const { canSeeProjectId } = await import('../services/visibilityService.js');
  return canSeeProjectId(actor, project.id);
}

router.get(
  '/createmeta/:projectKey/issuetypes',
  ah(async (req, res) => {
    const projectKey = ps(req.params.projectKey).toUpperCase();
    if (!(await createMetaVisible(req.actor!, projectKey))) {
      res.status(404).json(jiraError(['Project does not exist or you do not have permission to see it.']));
      return;
    }
    res.json(await getCreateMetaForProject(projectKey));
  })
);

router.get(
  '/createmeta/:projectKey/issuetypes/:issueTypeId',
  ah(async (req, res) => {
    const projectKey = ps(req.params.projectKey).toUpperCase();
    if (!(await createMetaVisible(req.actor!, projectKey))) {
      res.status(404).json(jiraError(['Project does not exist or you do not have permission to see it.']));
      return;
    }
    res.json(await getCreateMetaForProject(projectKey, ps(req.params.issueTypeId)));
  })
);

// Jira GET /rest/api/2/issue/picker?query= — registered before /:key (033).
router.get(
  '/picker',
  ah(async (req, res) => {
    const { pickIssues } = await import('../services/boardService.js');
    const query = String(qs(req.query.query) ?? '');
    const { maxResults } = pageParams(req, { cap: 50, default: 10 });
    res.json(await pickIssues(req.actor!, query, maxResults));
  })
);

router.get(
  '/:key/editmeta',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const issue = await getIssueByKey(key);
    res.json(await getEditMeta(issue.project.key, issue.issueTypeId));
  })
);

router.get(
  '/:key',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const issue = await getIssueByKey(key);
    const fields = parseSelection(qs(req.query.fields));
    const expand = parseSelection(qs(req.query.expand));
    const visibleRelIds = await visibleIssueIds(req.actor!, relatedIssueIds([issue]));
    const response = (await toIssueResponseWithCf(issue, { fields, actorId: req.actor!.user.id, visibleRelIds })) as Record<
      string,
      unknown
    >;
    await expandIssueResponse(response, issue, expand);
    res.json(response);
  })
);

// TrackForge extension: subtasks + epic children in one call (drives the Child issues panel).
router.get(
  '/:key/children',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const issue = await getIssueByKey(key);
    const children = await listChildren(issue.id, issue.projectId, req.actor);
    const visibleRelIds = await visibleIssueIds(req.actor!, relatedIssueIds(children));
    res.json({ issues: children.map((c) => toIssueResponse(c as never, { visibleRelIds })) });
  })
);

router.get(
  '/:key/changelog',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const issue = await getIssueByKey(key);
    const { startAt, maxResults } = pageParams(req, { cap: 100, default: 50 });
    const { total, histories } = await getChangelog(issue.id, startAt, maxResults);
    res.json({ startAt, maxResults, total, histories: histories.map(toHistoryResponse) });
  })
);

router.put(
  '/:key/assignee',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const parsed = assigneeBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    // Jira semantics: accountId null or name "-1" → unassign; else resolve a user.
    let assignee: { accountId?: string; name?: string } | null;
    if (parsed.data.accountId === null || parsed.data.name === '-1') {
      assignee = null;
    } else if (parsed.data.accountId || parsed.data.name) {
      assignee = { accountId: parsed.data.accountId ?? undefined, name: parsed.data.name };
    } else {
      res.status(400).json(jiraError([], { assignee: 'Provide an accountId or name, or null to unassign.' }));
      return;
    }

    if (isDryRun(req)) {
      const preview = await previewAssignIssue(key, assignee, req.actor!);
      markDryRun(res);
      res.status(200).json(preview);
      return;
    }

    await assignIssue(key, assignee, req.actor!);
    res.status(204).send();
  })
);

router.get(
  '/:key/transitions',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const transitions = await getIssueTransitions(key, req.actor!);
    res.json({ expand: 'transitions', transitions });
  })
);

router.post(
  '/:key/transitions',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const parsed = transitionIssueSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }

    const body = {
      fields: parsed.data.fields,
      update: parsed.data.update,
      expectedVersion: parsed.data.expectedVersion,
      fenceToken: parsed.data.fenceToken,
    };

    if (isDryRun(req)) {
      const preview = await previewTransition(key, parsed.data.transition.id, req.actor!, body);
      markDryRun(res);
      res.status(200).json(preview);
      return;
    }

    await executeTransition(key, parsed.data.transition.id, req.actor!, body);
    res.status(204).send();
  })
);

router.put(
  '/:key',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const parsed = compositeUpdateIssueSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const input = toUpdateInput(parsed.data);
    const composite = parsed.data.transition || parsed.data.comment || parsed.data.worklog;

    if (!composite) {
      if (isDryRun(req)) {
        const preview = await previewUpdateIssue(key, input, req.actor!);
        markDryRun(res);
        res.status(200).json(preview);
        return;
      }
      await updateIssue(key, input, req.actor!);
      res.status(204).send();
      return;
    }

    // 063 US5 — composite write: fields/update + transition + comment +
    // worklog in one call (TF extension). Steps apply in fixed order; every
    // declared step is validated up front so input errors never produce
    // partial writes. `transition` carries the same fields/update screen
    // shape as POST /transitions (resolution, assignee, update.comment).
    const hasFieldOps = Object.keys(parsed.data.fields ?? {}).length > 0 || parsed.data.update !== undefined;
    const transitionBody = parsed.data.transition
      ? {
          fields: parsed.data.transition.fields,
          update: parsed.data.transition.update,
          expectedVersion: parsed.data.expectedVersion,
          fenceToken: parsed.data.fenceToken,
        }
      : undefined;
    const issue = await getIssueByKey(key);
    const opts = adjustOpts(req);

    // ---- validation phase (throws the same 4xx the real calls would) ----
    const previews: Record<string, unknown> = {};
    if (hasFieldOps) previews.fields = await previewUpdateIssue(key, input, req.actor!);
    if (parsed.data.transition) {
      previews.transition = await previewTransition(key, parsed.data.transition.id, req.actor!, transitionBody);
    }
    if (parsed.data.comment) {
      await requirePermission(req.actor!, 'ADD_COMMENTS', { projectId: issue.projectId, issue });
      previews.comment = {
        body: parsed.data.comment.body,
        visibility: parsed.data.comment.visibility ?? null,
        author: { accountId: req.actor!.user.id, displayName: req.actor!.user.displayName },
      };
    }
    if (parsed.data.worklog) {
      const plan = await planAddWorklog(issue, parsed.data.worklog, opts, req.actor!);
      previews.worklog = {
        timeSpentSeconds: plan.sec,
        started: plan.started.toISOString(),
        comment: parsed.data.worklog.comment ?? undefined,
        billable: parsed.data.worklog.billable === true,
        resultingEstimates: {
          originalEstimateSec: issue.originalEstimateSec,
          remainingEstimateSec: plan.afterRemaining,
        },
      };
    }

    if (isDryRun(req)) {
      markDryRun(res);
      res.status(200).json({ dryRun: true, steps: previews });
      return;
    }

    // ---- apply phase (input already validated above) ----
    const steps: Record<string, unknown> = {};
    if (hasFieldOps) {
      await updateIssue(key, input, req.actor!);
      steps.fields = 'updated';
    }
    if (parsed.data.transition) {
      await executeTransition(key, parsed.data.transition.id, req.actor!, transitionBody);
      steps.transition = { id: parsed.data.transition.id };
    }
    if (parsed.data.comment) {
      const comment = await addComment(key, parsed.data.comment.body, req.actor!, parsed.data.comment.visibility);
      await audit(req, 'comment.create', 'issue', key, { commentId: comment.id });
      steps.comment = { id: comment.id };
    }
    if (parsed.data.worklog) {
      const { worklog } = await addWorklog(issue, key, parsed.data.worklog, opts, req.actor!);
      await audit(req, 'worklog.create', 'issue', key, { worklogId: worklog.id, seconds: worklog.timeSpentSec });
      steps.worklog = { id: worklog.id, timeSpentSeconds: worklog.timeSpentSec };
    }
    res.status(200).json({ updated: true, steps });
  })
);

// --- comments (Jira v2) ---

router.get(
  '/:key/comment',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const { startAt, maxResults } = pageParams(req, { cap: 100, default: 50 });
    // Jira orderBy: `created` | `+created` (asc) | `-created` (desc, default).
    const rawOrder = String(qs(req.query.orderBy) ?? '');
    const order = rawOrder === 'created' || rawOrder === '+created' ? 'asc' : 'desc';
    const page = await listComments(key, startAt, maxResults, req.actor!, order);
    res.json({ ...page, comments: page.comments.map(toCommentResponse) });
  })
);

router.post(
  '/:key/comment',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const parsed = commentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    if (isDryRun(req)) {
      // 052 — validate existence + permission, render the would-be comment.
      const issue = await getIssueByKey(key);
      await requirePermission(req.actor!, 'ADD_COMMENTS', { projectId: issue.projectId, issue });
      markDryRun(res);
      res.status(200).json({
        dryRun: true,
        comment: {
          body: parsed.data.body,
          visibility: parsed.data.visibility ?? null,
          author: { accountId: req.actor!.user.id, displayName: req.actor!.user.displayName },
        },
      });
      return;
    }
    const comment = await addComment(key, parsed.data.body, req.actor!, parsed.data.visibility);
    await audit(req, 'comment.create', 'issue', key, { commentId: comment.id });
    res.status(201).json(toCommentResponse(comment));
  })
);

router.get(
  '/:key/comment/:id',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    res.json(toCommentResponse(await getComment(key, ps(req.params.id), req.actor!)));
  })
);

router.put(
  '/:key/comment/:id',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const parsed = commentSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    res.json(
      toCommentResponse(await editComment(key, ps(req.params.id), parsed.data.body, req.actor!, parsed.data.visibility))
    );
  })
);

router.delete(
  '/:key/comment/:id',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    await deleteComment(key, ps(req.params.id), req.actor!);
    res.status(204).send();
  })
);

// --- watchers (Jira v2) ---

// Jira POST body is a JSON-encoded username string; we also accept { name } /
// { accountId } for API ergonomics. Empty body watches yourself.
async function resolveWatchTarget(reqBody: unknown, key: string, actor: Actor) {
  const issue = await getIssueByKey(key);
  let ref = actor.user.id;
  if (typeof reqBody === 'string' && reqBody) ref = reqBody;
  else if (reqBody && typeof reqBody === 'object') {
    const b = reqBody as { name?: string; accountId?: string };
    ref = b.accountId ?? b.name ?? actor.user.id;
  }
  const target = await prisma.user.findFirst({
    where: { OR: [{ id: ref }, { email: ref }, { displayName: ref }] },
  });
  if (!target || !target.active) {
    throw new JiraApiError(400, jiraError(['User not found or inactive.']));
  }
  // Watching on behalf of another user requires MANAGE_WATCHERS (Jira).
  if (target.id !== actor.user.id) {
    await requirePermission(actor, 'MANAGE_WATCHERS', { projectId: issue.projectId, issue });
  }
  return { issue, target };
}

router.get(
  '/:key/watchers',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const issue = await getIssueByKey(key);
    const state = await watchState(issue.id, req.actor!.user.id);
    // Jira: the watchers list requires VIEW_VOTERS_AND_WATCHERS; the count and
    // own watch state are always returned.
    const canView = await hasPermission(req.actor!, 'VIEW_VOTERS_AND_WATCHERS', { projectId: issue.projectId, issue });
    res.json({
      self: resourceSelf(`/rest/api/2/issue/${key}/watchers`),
      isWatching: state.isWatching,
      watchCount: state.watchCount,
      ...(canView
        ? {
            watchers: state.watchers.map((w) => ({
              ...w,
              self: userSelf(w.accountId),
            })),
          }
        : {}),
    });
  })
);

router.post(
  '/:key/watchers',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const { issue, target } = await resolveWatchTarget(req.body, key, req.actor!);
    if (isDryRun(req)) {
      // 052 — target/permission validated by resolveWatchTarget; no write.
      markDryRun(res);
      res.status(200).json({
        dryRun: true,
        watch: { issue: key, user: { accountId: target.id, displayName: target.displayName } },
      });
      return;
    }
    await addWatcher(issue.id, target.id);
    res.status(204).send();
  })
);

router.delete(
  '/:key/watchers',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const ref = String(qs(req.query.username) ?? qs(req.query.accountId) ?? req.actor!.user.id);
    const { issue, target } = await resolveWatchTarget(ref === req.actor!.user.id ? undefined : ref, key, req.actor!);
    await removeWatcher(issue.id, target.id);
    res.status(204).send();
  })
);

// --- votes (Jira v2, sprint 022) ---

router.get(
  '/:key/votes',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const issue = await getIssueByKey(key);
    const state = await voteState(issue.id, req.actor!.user.id);
    const canView = await hasPermission(req.actor!, 'VIEW_VOTERS_AND_WATCHERS', { projectId: issue.projectId, issue });
    res.json({
      self: resourceSelf(`/rest/api/2/issue/${key}/votes`),
      votes: state.votes,
      hasVoted: state.hasVoted,
      ...(canView
        ? {
            voters: state.voters.map((v) => ({
              ...v,
              self: userSelf(v.accountId),
            })),
          }
        : {}),
    });
  })
);

router.post(
  '/:key/votes',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const issue = await getIssueByKey(key);
    await addVote(issue.id, req.actor!.user.id, req.actor!, key);
    res.status(204).send();
  })
);

router.delete(
  '/:key/votes',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const issue = await getIssueByKey(key);
    await removeVote(issue.id, req.actor!.user.id, req.actor!, key);
    res.status(204).send();
  })
);

// --- remote issue links (Jira v2, sprint 022) ---

router.get(
  '/:key/remotelink',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const issue = await getIssueByKey(key);
    res.json(await listRemoteLinks(issue.id, key));
  })
);

router.post(
  '/:key/remotelink',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const issue = await getIssueByKey(key);
    const body = (req.body ?? {}) as {
      object?: { url?: string; title?: string; summary?: string; icon?: { url16x16?: string }; status?: unknown };
      globalId?: string;
    };
    if (!body.object?.url || !body.object?.title) {
      throw new JiraApiError(400, jiraError([], { object: 'object.url and object.title are required.' }));
    }
    // Stored XSS guard: object.url renders as href — javascript:/data: must never store.
    if (!isAllowedExternalUrl(body.object.url)) {
      throw new JiraApiError(
        400,
        jiraError([], { 'object.url': `URL must use an allowed scheme (${ALLOWED_URL_SCHEMES_LABEL}).` })
      );
    }
    const link = await createRemoteLink(
      issue.id,
      key,
      {
        url: body.object.url,
        title: body.object.title,
        summary: body.object.summary,
        globalId: body.globalId,
        iconUrl: body.object.icon?.url16x16,
      },
      req.actor!
    );
    res.status(201).json(link);
  })
);

router.delete(
  '/:key/remotelink/:linkId',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const issue = await getIssueByKey(key);
    await deleteRemoteLink(issue.id, ps(req.params.linkId), req.actor!, key);
    res.status(204).send();
  })
);

// --- worklogs (Jira v2, sprint 024) ---

function adjustOpts(req: { query: unknown }) {
  const q = req.query as Record<string, unknown>;
  return {
    adjustEstimate: q.adjustEstimate as string | undefined,
    newEstimate: q.newEstimate as string | undefined,
    reduceBy: q.reduceBy as string | undefined,
  };
}

router.get(
  '/:key/worklog',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const issue = await getIssueByKey(key);
    const q = req.query as Record<string, unknown>;
    res.json(
      await listWorklogs(
        issue,
        key,
        {
          startAt: Math.max(0, Number(q.startAt) || 0),
          maxResults: Number(q.maxResults) || undefined,
          startedAfter: Number(q.startedAfter) || undefined,
          startedBefore: Number(q.startedBefore) || undefined,
        },
        undefined,
        req.actor!
      )
    );
  })
);

router.post(
  '/:key/worklog',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const parsed = worklogSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const issue = await getIssueByKey(key);
    const opts = adjustOpts(req);

    if (isDryRun(req)) {
      const plan = await planAddWorklog(issue, parsed.data, opts, req.actor!);
      markDryRun(res);
      res.status(200).json({
        worklog: {
          timeSpent: plan.items.find((i) => i.field === 'Worklog')?.toString,
          timeSpentSeconds: plan.sec,
          started: plan.started.toISOString(),
          comment: parsed.data.comment ?? undefined,
          billable: parsed.data.billable === true,
        },
        resultingEstimates: {
          originalEstimateSec: issue.originalEstimateSec,
          remainingEstimateSec: plan.afterRemaining,
        },
        changes: plan.items,
      });
      return;
    }

    const { worklog, cfg } = await addWorklog(issue, key, parsed.data, opts, req.actor!);
    await audit(req, 'worklog.create', 'issue', key, { worklogId: worklog.id, seconds: worklog.timeSpentSec });
    res.status(201).json(toWorklogResponse(worklog, key, cfg));
  })
);

router.get(
  '/:key/worklog/:id',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const issue = await getIssueByKey(key);
    const page = await listWorklogs(issue, key, {}, undefined, req.actor!);
    const w = page.worklogs.find((x) => x.id === ps(req.params.id));
    if (!w) {
      res.status(404).json(jiraError(['The worklog does not exist or you do not have permission to see it.']));
      return;
    }
    res.json(w);
  })
);

router.put(
  '/:key/worklog/:id',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const parsed = updateWorklogSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json(jiraError([], formatZodErrors(parsed.error)));
      return;
    }
    const issue = await getIssueByKey(key);
    const { worklog, cfg } = await updateWorklog(issue, key, ps(req.params.id), parsed.data, adjustOpts(req), req.actor!);
    await audit(req, 'worklog.update', 'issue', key, { worklogId: worklog.id });
    res.json(toWorklogResponse(worklog, key, cfg));
  })
);

router.delete(
  '/:key/worklog/:id',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const issue = await getIssueByKey(key);
    await deleteWorklog(issue, key, ps(req.params.id), adjustOpts(req), req.actor!);
    await audit(req, 'worklog.delete', 'issue', key, { worklogId: ps(req.params.id) });
    res.status(204).send();
  })
);

// --- issue delete (Jira deleteSubtasks semantics + TrackForge confirmToken) ---

router.delete(
  '/:key',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    await enforceIssueScope(key, req.actor!);
    const deleteSubtasks = String(qs(req.query.deleteSubtasks) ?? '') === 'true';

    if (isDryRun(req)) {
      markDryRun(res);
      res.status(200).json(await previewDeleteIssue(key, deleteSubtasks));
      return;
    }

    const result = await deleteIssue(
      key,
      deleteSubtasks,
      String(qs(req.query.confirmToken) ?? req.headers['x-confirm-token'] ?? '') || undefined,
      req.actor!
    );
    await audit(req, 'issue.delete', 'issue', key, result);
    res.status(204).send();
  })
);

// --- issue archive / restore (060 US7 — Jira DC) ---

router.put(
  '/:key/archive',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    // Not yet archived → enforceIssueScope resolves it and applies BROWSE +
    // token allow-list. ARCHIVE_ISSUES is checked inside archiveIssue.
    await enforceIssueScope(key, req.actor!);
    if (isDryRun(req)) {
      markDryRun(res);
      res.json(await archiveIssue(key, req.actor!, true));
      return;
    }
    await archiveIssue(key, req.actor!);
    await audit(req, 'issue.archive', 'issue', key);
    res.status(204).send();
  })
);

router.put(
  '/:key/restore',
  ah(async (req, res) => {
    const key = ps(req.params.key).toUpperCase();
    // Archived issues are existence-hidden by canSeeIssue, so restore bypasses
    // enforceIssueScope deliberately — the token allow-list still applies, and
    // RESTORE_ISSUES is checked inside restoreIssue.
    const projectKey = key.split('-')[0] ?? '';
    if (!projectAllowed(req.actor!, projectKey)) {
      res.status(404).json(jiraError(['Issue does not exist or you do not have permission to see it.']));
      return;
    }
    if (isDryRun(req)) {
      markDryRun(res);
      res.json(await restoreIssue(key, req.actor!, true));
      return;
    }
    await restoreIssue(key, req.actor!);
    await audit(req, 'issue.restore', 'issue', key);
    res.status(204).send();
  })
);

export default router;
