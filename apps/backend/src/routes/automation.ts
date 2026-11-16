import { ps } from '../lib/validation.js';
// 034 — automation rule management. Authoring (create): site admins any scope;
// ADMINISTER_PROJECTS for project-scoped rules; others 403 (canAuthor).
// Managing an existing rule (read/update/toggle/run): site admin, the rule's
// author, or a project admin of the rule's project (canManageRule — 404 hides
// existence on reads, 403 names the requirement on writes). Setting another
// user as the rule actor requires site admin (resolveRuleActor).

import { Router, type Router as RouterType } from 'express';
import { z } from 'zod/v3';
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { ah, pageParams, parseBody } from '../lib/http.js';
import {
  automationSchema,
  executeRule,
  loadRuleForWrite,
  loadRuleManaged,
  validateRuleShape,
  validateRuleJql,
  runScheduledRules,
  canAuthor,
  resolveProjectId,
  resolveRuleActor,
  toRunResponse,
  toRuleResponse,
  unmaskSecrets,
  RULE_INCLUDE,
} from '../services/automationService.js';
import { hasPermission } from '../services/permissionService.js';
import { getIssueByKey } from '../services/issueService.js';
import { canSeeIssueFull } from '../services/visibilityService.js';
import { issueKeysForJql } from '../services/searchService.js';
import type { Actor } from '../lib/auth.js';

export const automationRouter: RouterType = Router();

const ruleInput = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).optional(),
  scope: z.enum(['global', 'project']).default('global'),
  projectKey: z.string().optional(),
  actorId: z.string().optional(), // defaults to author; site admin required otherwise
  enabled: z.boolean().default(true),
  trigger: z.record(z.unknown()),
  conditions: z.array(z.record(z.unknown())).default([]),
  actions: z.array(z.record(z.unknown())).min(1),
});

const INCLUDE = RULE_INCLUDE;

// registry self-description (FR-006)
automationRouter.get('/schema', (_req, res) => res.json(automationSchema()));

automationRouter.get(
  '/rules',
  ah(async (req, res) => {
    const where = req.actor!.user.isAdmin
      ? {}
      : {
          OR: [
            { createdById: req.actor!.user.id },
            { project: { key: { in: req.actor!.token?.projectKeys ?? ['\u0000'] } } },
          ],
        };
    const rules = await prisma.automationRule.findMany({
      where,
      include: INCLUDE,
      orderBy: { name: 'asc' },
    });
    // project admins see rules for projects they administer
    const visible = [];
    for (const r of rules) {
      if (
        req.actor!.user.isAdmin ||
        r.createdById === req.actor!.user.id ||
        (r.projectId && (await hasPermission(req.actor!, 'ADMINISTER_PROJECTS', { projectId: r.projectId })))
      )
        visible.push(toRuleResponse(r));
    }
    res.json({ rules: visible });
  })
);

automationRouter.post(
  '/rules',
  ah(async (req, res) => {
    const body = parseBody(ruleInput, req);
    const projectId = await resolveProjectId(body.projectKey, body.scope);
    const auth = await canAuthor(req.actor!, body.scope, projectId);
    if (auth) throw new JiraApiError(403, jiraError([auth]));
    const ra = await resolveRuleActor(req.actor!, body.actorId);
    if (ra.error) throw new JiraApiError(400, jiraError([ra.error]));
    const errs = [...validateRuleShape(body), ...(await validateRuleJql(body))];
    if (errs.length) throw new JiraApiError(400, jiraError(errs));
    const rule = await prisma.automationRule.create({
      data: {
        name: body.name,
        description: body.description,
        scope: body.scope,
        projectId,
        actorId: ra.userId ?? req.actor!.user.id,
        createdById: req.actor!.user.id,
        enabled: body.enabled,
        trigger: body.trigger as never,
        conditions: body.conditions as never,
        actions: body.actions as never,
      },
      include: INCLUDE,
    });
    res.status(201).json(toRuleResponse(rule));
  })
);

automationRouter.get(
  '/rules/:id',
  ah(async (req, res) => {
    // 065 audit C5 — same visibility as the list: author, project admin of the
    // rule's project, or site admin. 404 hides existence (and its config).
    const r = await loadRuleManaged(req.actor!, ps(req.params.id), { include: INCLUDE });
    res.json(toRuleResponse(r));
  })
);

automationRouter.put(
  '/rules/:id',
  ah(async (req, res) => {
    const existing = await loadRuleForWrite(req.actor!, ps(req.params.id));
    const body = parseBody(ruleInput.partial(), req);
    const merged = { ...existing, ...body };
    if (body.actions) merged.actions = unmaskSecrets(body.actions, existing.actions) as typeof merged.actions;
    const projectId =
      body.scope || body.projectKey
        ? await resolveProjectId(body.projectKey, merged.scope as string)
        : existing.projectId;
    // 064 US4 — re-validate authoring rights on the *merged* scope: widening a
    // project rule to global (or moving it to an unadministered project) must be
    // rejected, not silently adopted.
    const authorErr = await canAuthor(req.actor!, merged.scope as string, projectId);
    if (authorErr) throw new JiraApiError(403, jiraError([authorErr]));
    if (body.actorId !== undefined) {
      const ra = await resolveRuleActor(req.actor!, body.actorId);
      if (ra.error) throw new JiraApiError(400, jiraError([ra.error]));
      // 065 US4 — store the canonical accountId even when the caller
      // referenced the user by name/email (one resolver, everywhere).
      if (ra.userId) body.actorId = ra.userId;
    }
    const errs = [...validateRuleShape(merged), ...(await validateRuleJql(merged))];
    if (errs.length) throw new JiraApiError(400, jiraError(errs));
    // 065 audit D3 — a non-admin editing someone else's rule must not inherit
    // the original (possibly site-admin) actor: the rule resets to run as, and
    // be owned by, the editor — it can only ever do what they could do.
    const takeOwnership = !req.actor!.user.isAdmin && existing.createdById !== req.actor!.user.id;
    const rule = await prisma.automationRule.update({
      where: { id: existing.id },
      data: {
        name: merged.name as string,
        description: (merged.description ?? null) as string | null,
        scope: merged.scope as string,
        projectId,
        actorId: takeOwnership ? req.actor!.user.id : ((merged.actorId as string | undefined) ?? existing.actorId),
        ...(takeOwnership ? { createdById: req.actor!.user.id } : {}),
        enabled: merged.enabled as boolean,
        trigger: merged.trigger as never,
        conditions: merged.conditions as never,
        actions: merged.actions as never,
        version: { increment: 1 }, // versioned — runs record ruleVersion
        failureCount: 0,
      },
      include: INCLUDE,
    });
    res.json(toRuleResponse(rule));
  })
);

automationRouter.delete(
  '/rules/:id',
  ah(async (req, res) => {
    const existing = await loadRuleForWrite(req.actor!, ps(req.params.id));
    await prisma.automationRule.delete({ where: { id: existing.id } });
    res.status(204).end();
  })
);

automationRouter.post(
  '/rules/:id/toggle',
  ah(async (req, res) => {
    await loadRuleForWrite(req.actor!, ps(req.params.id));
    const { enabled } = parseBody(z.object({ enabled: z.boolean().default(true) }), req);
    const r = await prisma.automationRule.update({ where: { id: ps(req.params.id) }, data: { enabled }, include: INCLUDE });
    res.json(toRuleResponse(r));
  })
);

automationRouter.get(
  '/rules/:id/runs',
  ah(async (req, res) => {
    await loadRuleManaged(req.actor!, ps(req.params.id));
    const runs = await prisma.automationRun.findMany({
      where: { ruleId: ps(req.params.id) },
      orderBy: { startedAt: 'desc' },
      take: pageParams(req, { cap: 200 }).maxResults,
    });
    res.json({ runs: runs.map(toRunResponse) });
  })
);

automationRouter.get(
  '/runs/:runId',
  ah(async (req, res) => {
    const run = await prisma.automationRun.findUnique({ where: { id: ps(req.params.runId) } });
    if (!run) throw new JiraApiError(404, jiraError(['Run not found']));
    await loadRuleManaged(req.actor!, run.ruleId, { message: 'Run not found' });
    res.json(toRunResponse(run));
  })
);

// 065 audit D1 — a caller-supplied issueKey must be (a) inside the rule's
// project scope and (b) visible to the caller; otherwise a project admin could
// run (and webhook-export) any issue in the instance.
async function assertRunnableIssue(actor: Actor, rule: { projectId: string | null }, issueKey: string) {
  const issue = await getIssueByKey(issueKey).catch(() => null);
  if (!issue || (rule.projectId && issue.projectId !== rule.projectId) || !(await canSeeIssueFull(actor, issue))) {
    throw new JiraApiError(
      404,
      jiraError([`Issue '${issueKey}' does not exist or you do not have permission to see it.`])
    );
  }
}

automationRouter.post(
  '/rules/:id/run',
  ah(async (req, res) => {
    const r = await loadRuleManaged(req.actor!, ps(req.params.id));
    const issueKey = req.body?.issueKey ? String(req.body.issueKey) : null;
    if (issueKey) await assertRunnableIssue(req.actor!, r, issueKey);
    res.status(202).json(toRunResponse(await executeRule(r, { issueKey })));
  })
);

automationRouter.post(
  '/rules/:id/dry-run',
  ah(async (req, res) => {
    const r = await loadRuleManaged(req.actor!, ps(req.params.id));
    // dry-run against a key or a JQL selection (first N matches)
    const issueKey = req.body?.issueKey ? String(req.body.issueKey) : null;
    const jql = req.body?.jql ? String(req.body.jql) : null;
    if (issueKey) {
      await assertRunnableIssue(req.actor!, r, issueKey);
      res.json(toRunResponse(await executeRule(r, { issueKey, dryRun: true })));
      return;
    }
    if (jql) {
      // 065 US1 — route through searchService so every visibility gate
      // (browse scope, token allow-list, security level) applies uniformly.
      const runs = [];
      for (const issueKey of await issueKeysForJql(req.actor!, jql, 10)) {
        runs.push(toRunResponse(await executeRule(r, { issueKey, dryRun: true })));
      }
      res.json({ runs });
      return;
    }
    throw new JiraApiError(400, jiraError(['dry-run requires issueKey or jql']));
  })
);

automationRouter.post(
  '/validate',
  ah(async (req, res) => {
    const body = parseBody(ruleInput.partial({ name: true }), req);
    const errs = [...validateRuleShape(body), ...(await validateRuleJql(body))];
    if (body.scope === 'project' && body.projectKey) await resolveProjectId(body.projectKey, 'project');
    if (body.actorId) {
      const ra = await resolveRuleActor(req.actor!, body.actorId);
      if (ra.error) errs.push(`actor: ${ra.error}`);
    }
    res.json({ valid: errs.length === 0, errors: errs });
  })
);

// scheduler hook — invoked by the durable job, also directly testable.
// 064 US4 — site-admin only: triggering due rules executes actions as their
// configured actors, so this must not be callable by arbitrary users.
automationRouter.post(
  '/scheduled-tick',
  ah(async (req, res) => {
    if (!req.actor!.user.isAdmin) throw new JiraApiError(403, jiraError(['Site admin required']));
    res.json({ processed: await runScheduledRules() });
  })
);
