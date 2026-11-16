import { ps } from '../lib/validation.js';
import { Router, type Router as RouterType, type Request } from 'express';
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { ah, resourceSelf, sendCsv } from '../lib/http.js';
import { hasPermission } from '../services/permissionService.js';
import { projectAllowed } from '../middleware/auth.js';
import {
  createComponent,
  updateComponent,
  deleteComponent,
  listComponents,
  createVersion,
  updateVersion,
  deleteVersion,
  moveVersion,
  listVersions,
  versionIssueCounts,
  releaseVersion,
  releaseNotes,
  toComponentResponse,
  toVersionResponse,
} from '../services/componentVersionService.js';
import { qs } from '../lib/validation.js';

/** Sprint 019 — Jira component & version endpoints. */
export const componentRouter: RouterType = Router(); // /rest/api/2/component
export const versionRouter: RouterType = Router(); // /rest/api/2/version
export const projectReleaseRouter: RouterType = Router(); // /rest/api/2/project/{k}/components|versions|releases

/** Token allow-list + BROWSE_PROJECTS (064 US3) — enforced before any permission check. */
async function assertProjectVisible(actor: Request['actor'], projectKey: string) {
  if (!projectAllowed(actor!, projectKey)) {
    throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.'], {}));
  }
  const p = await prisma.project.findUnique({ where: { key: projectKey }, select: { id: true } });
  if (!p || !(await hasPermission(actor!, 'BROWSE_PROJECTS', { projectId: p.id }))) {
    throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.'], {}));
  }
}

async function projectByKey(key: string, actor?: Request['actor']) {
  const p = await prisma.project.findUnique({ where: { key: key.toUpperCase() } });
  if (!p)
    throw new JiraApiError(404, jiraError(['Project does not exist or you do not have permission to see it.'], {}));
  if (actor) await assertProjectVisible(actor, p.key);
  return p;
}

async function requireProjectAdmin(actor: Request['actor'], projectId: string) {
  if (actor!.user.isAdmin) return;
  if (!(await hasPermission(actor!, 'ADMINISTER_PROJECTS', { projectId }))) {
    throw new JiraApiError(
      403,
      jiraError(["Missing required permission 'ADMINISTER_PROJECTS'."], {
        permission: "Missing required permission 'ADMINISTER_PROJECTS'.",
      })
    );
  }
}

/* ------------------------------ components ------------------------------ */

componentRouter.post(
  '/',
  ah(async (req, res) => {
    const b = req.body ?? {};
    const project = await projectByKey(String(b.project ?? ''), req.actor);
    await requireProjectAdmin(req.actor, project.id);
    const c = await createComponent(project.id, b, req.actor!);
    res.status(201).json(toComponentResponse(c));
  })
);

componentRouter.get(
  '/:id',
  ah(async (req, res) => {
    const c = await prisma.component.findUnique({
      where: { id: ps(req.params.id) },
      include: { lead: { select: { id: true, displayName: true } }, project: { select: { key: true } } },
    });
    if (!c) throw new JiraApiError(404, jiraError([`Component '${ps(req.params.id)}' does not exist.`], {}));
    await assertProjectVisible(req.actor, c.project.key);
    res.json(toComponentResponse(c));
  })
);

componentRouter.put(
  '/:id',
  ah(async (req, res) => {
    const existing = await prisma.component.findUnique({
      where: { id: ps(req.params.id) },
      include: { project: { select: { key: true } } },
    });
    if (!existing) throw new JiraApiError(404, jiraError([`Component '${ps(req.params.id)}' does not exist.`], {}));
    await assertProjectVisible(req.actor, existing.project.key);
    await requireProjectAdmin(req.actor, existing.projectId);
    const c = await updateComponent(ps(req.params.id), req.body ?? {}, req.actor!);
    res.json(toComponentResponse(c));
  })
);

componentRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const existing = await prisma.component.findUnique({
      where: { id: ps(req.params.id) },
      include: { project: { select: { key: true } } },
    });
    if (!existing) throw new JiraApiError(404, jiraError([`Component '${ps(req.params.id)}' does not exist.`], {}));
    await assertProjectVisible(req.actor, existing.project.key);
    await requireProjectAdmin(req.actor, existing.projectId);
    await deleteComponent(
      ps(req.params.id),
      typeof qs(req.query.moveIssuesTo) === 'string' ? qs(req.query.moveIssuesTo) : undefined,
      req.actor!
    );
    res.status(204).end();
  })
);

componentRouter.get(
  '/:id/relatedIssueCounts',
  ah(async (req, res) => {
    const c = await prisma.component.findUnique({
      where: { id: ps(req.params.id) },
      include: { project: { select: { key: true } } },
    });
    if (!c) throw new JiraApiError(404, jiraError([`Component '${ps(req.params.id)}' does not exist.`], {}));
    await assertProjectVisible(req.actor, c.project.key);
    const count = await prisma.issueComponent.count({ where: { componentId: ps(req.params.id) } });
    res.json({ self: resourceSelf(`/rest/api/2/component/${ps(req.params.id)}`), issueCount: count });
  })
);

/* ------------------------------- versions ------------------------------- */

versionRouter.post(
  '/',
  ah(async (req, res) => {
    const b = req.body ?? {};
    const project = await projectByKey(String(b.project ?? ''), req.actor);
    await requireProjectAdmin(req.actor, project.id);
    const v = await createVersion(project.id, b, req.actor!);
    res.status(201).json(toVersionResponse(v));
  })
);

versionRouter.get(
  '/:id',
  ah(async (req, res) => {
    const v = await prisma.version.findUnique({
      where: { id: ps(req.params.id) },
      include: { project: { select: { key: true } } },
    });
    if (!v) throw new JiraApiError(404, jiraError([`Version '${ps(req.params.id)}' does not exist.`], {}));
    await assertProjectVisible(req.actor, v.project.key);
    res.json(toVersionResponse(v));
  })
);

versionRouter.put(
  '/:id',
  ah(async (req, res) => {
    const existing = await prisma.version.findUnique({
      where: { id: ps(req.params.id) },
      include: { project: { select: { key: true } } },
    });
    if (!existing) throw new JiraApiError(404, jiraError([`Version '${ps(req.params.id)}' does not exist.`], {}));
    await assertProjectVisible(req.actor, existing.project.key);
    await requireProjectAdmin(req.actor, existing.projectId);
    const v = await updateVersion(ps(req.params.id), req.body ?? {}, req.actor!);
    res.json(toVersionResponse(v));
  })
);

versionRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const existing = await prisma.version.findUnique({
      where: { id: ps(req.params.id) },
      include: { project: { select: { key: true } } },
    });
    if (!existing) throw new JiraApiError(404, jiraError([`Version '${ps(req.params.id)}' does not exist.`], {}));
    await assertProjectVisible(req.actor, existing.project.key);
    await requireProjectAdmin(req.actor, existing.projectId);
    await deleteVersion(
      ps(req.params.id),
      typeof qs(req.query.moveFixIssuesTo) === 'string' ? qs(req.query.moveFixIssuesTo) : undefined,
      typeof qs(req.query.moveAffectedIssuesTo) === 'string' ? qs(req.query.moveAffectedIssuesTo) : undefined,
      req.actor!
    );
    res.status(204).end();
  })
);

versionRouter.post(
  '/:id/move',
  ah(async (req, res) => {
    const existing = await prisma.version.findUnique({
      where: { id: ps(req.params.id) },
      include: { project: { select: { key: true } } },
    });
    if (!existing) throw new JiraApiError(404, jiraError([`Version '${ps(req.params.id)}' does not exist.`], {}));
    await assertProjectVisible(req.actor, existing.project.key);
    await requireProjectAdmin(req.actor, existing.projectId);
    const b = req.body ?? {};
    const v = await moveVersion(ps(req.params.id), b.position, b.after, req.actor!);
    res.json(toVersionResponse(v));
  })
);

versionRouter.post(
  '/:id/release',
  ah(async (req, res) => {
    const existing = await prisma.version.findUnique({
      where: { id: ps(req.params.id) },
      include: { project: { select: { key: true } } },
    });
    if (!existing) throw new JiraApiError(404, jiraError([`Version '${ps(req.params.id)}' does not exist.`], {}));
    await assertProjectVisible(req.actor, existing.project.key);
    await requireProjectAdmin(req.actor, existing.projectId);
    const v = await releaseVersion(ps(req.params.id), req.body?.releaseDate, req.actor!);
    res.json(toVersionResponse(v));
  })
);

versionRouter.get(
  '/:id/releasenotes',
  ah(async (req, res) => {
    const v = await prisma.version.findUnique({
      where: { id: ps(req.params.id) },
      include: { project: { select: { key: true } } },
    });
    if (!v) throw new JiraApiError(404, jiraError([`Version '${ps(req.params.id)}' does not exist.`], {}));
    await assertProjectVisible(req.actor, v.project.key);
    const notes = await releaseNotes(ps(req.params.id));
    if (qs(req.query.format) === 'csv') {
      sendCsv(res, 'releasenotes', [
        ['type', 'key', 'summary'],
        ...notes.groups.flatMap((g) => g.issues.map((i) => [g.type, i.key, i.summary])),
      ]);
      return;
    }
    res.json(notes);
  })
);

versionRouter.get(
  '/:id/relatedIssueCounts',
  ah(async (req, res) => {
    const v = await prisma.version.findUnique({
      where: { id: ps(req.params.id) },
      include: { project: { select: { key: true } } },
    });
    if (!v) throw new JiraApiError(404, jiraError([`Version '${ps(req.params.id)}' does not exist.`], {}));
    await assertProjectVisible(req.actor, v.project.key);
    const c = await versionIssueCounts(ps(req.params.id));
    res.json({ self: resourceSelf(`/rest/api/2/version/${ps(req.params.id)}`), ...c });
  })
);

versionRouter.get(
  '/:id/unresolvedIssueCount',
  ah(async (req, res) => {
    const v = await prisma.version.findUnique({
      where: { id: ps(req.params.id) },
      include: { project: { select: { key: true } } },
    });
    if (!v) throw new JiraApiError(404, jiraError([`Version '${ps(req.params.id)}' does not exist.`], {}));
    await assertProjectVisible(req.actor, v.project.key);
    const unresolved = await prisma.issueVersion.count({
      where: { versionId: ps(req.params.id), kind: 'fix', issue: { status: { category: { not: 'done' } } } },
    });
    res.json({ self: resourceSelf(`/rest/api/2/version/${ps(req.params.id)}`), issuesUnresolvedCount: unresolved });
  })
);

/* --------------------------- project-scoped lists ------------------------ */

projectReleaseRouter.get(
  '/:key/components',
  ah(async (req, res) => {
    const p = await projectByKey(ps(req.params.key), req.actor);
    res.json((await listComponents(p.id)).map(toComponentResponse));
  })
);

projectReleaseRouter.get(
  '/:key/versions',
  ah(async (req, res) => {
    const p = await projectByKey(ps(req.params.key), req.actor);
    res.json((await listVersions(p.id)).map(toVersionResponse));
  })
);
