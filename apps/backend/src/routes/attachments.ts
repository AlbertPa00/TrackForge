import { ps } from '../lib/validation.js';
/**
 * Sprint 018 — Jira attachment API (US1/US2).
 *   POST   /rest/api/2/issue/:key/attachments   (multipart, X-Atlassian-Token: no-check)
 *   GET    /rest/api/2/attachment/:id           metadata
 *   GET    /rest/api/2/attachment/content/:id   bytes (safe-inline; SVG always downloads)
 *   GET    /rest/api/2/attachment/thumbnail/:id thumbnail or 404
 *   DELETE /rest/api/2/attachment/:id           author or DELETE_ALL_ATTACHMENTS
 * Visibility inherits the issue's — scope enforced via enforceIssueScope (FR-002).
 */
import { Router, type Router as RouterType, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import { prisma } from '../prisma.js';
import { jiraError, JiraApiError } from '../lib/errors.js';
import { enforceIssueScope } from '../middleware/auth.js';
import { requireIssuePermission, hasPermission } from '../services/permissionService.js';
import { getIssueByKey } from '../services/issueService.js';
import { ah } from '../lib/http.js';
import {
  MAX_ATTACHMENT_BYTES,
  deleteAttachment,
  serveContent,
  serveThumbnail,
  toAttachmentResponse,
  uploadAttachments,
} from '../services/attachmentService.js';

const upload = multer({
  storage: multer.memoryStorage(),
  // 064 US6 — file-size alone isn't a multipart-DoS bound; cap file count and
  // total parts so a flood of tiny parts can't exhaust memory.
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 10, parts: 20, fields: 20 },
});

/** Multer reports LIMIT_FILE_SIZE via next(err) — convert to a Jira-shaped 413. */
function multipart(req: Request, res: Response, next: NextFunction) {
  upload.array('file')(req, res, (err: unknown) => {
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      next(
        new JiraApiError(
          413,
          jiraError([`File exceeds the ${Math.round(MAX_ATTACHMENT_BYTES / 1048576)}MB attachment limit.`])
        )
      );
      return;
    }
    if (err) {
      next(new JiraApiError(400, jiraError([`Malformed multipart upload: ${(err as Error).message}`])));
      return;
    }
    next();
  });
}

async function loadIssueScoped(key: string, actor: Parameters<typeof enforceIssueScope>[1]) {
  await enforceIssueScope(key.toUpperCase(), actor);
  return getIssueByKey(key.toUpperCase());
}

async function loadAttachmentScoped(id: string, actor: Parameters<typeof enforceIssueScope>[1]) {
  const att = await prisma.attachment.findUnique({
    where: { id },
    include: { issue: { select: { issueNumber: true, project: { select: { key: true } } } } },
  });
  if (!att?.issue) {
    throw new JiraApiError(404, jiraError(['Attachment does not exist or you do not have permission to see it.']));
  }
  const issueKey = `${att.issue.project.key}-${att.issue.issueNumber}`;
  await enforceIssueScope(issueKey, actor);
  return { att, issueKey };
}

export const attachmentsRouter: RouterType = Router();

/** Jira clients send `X-Atlassian-Token: no-check` + multipart field `file` (repeatable). */
attachmentsRouter.post(
  '/:key/attachments',
  multipart,
  ah(async (req, res) => {
    const issue = await loadIssueScoped(ps(req.params.key), req.actor!);
    if (!issue) return;
    await requireIssuePermission(req.actor!, 'CREATE_ATTACHMENTS', issue);
    const files = (req.files as Express.Multer.File[]) ?? [];
    if (files.length === 0) {
      throw new JiraApiError(400, jiraError(['No file was uploaded. Send a multipart field named "file".']));
    }
    const created = await uploadAttachments(issue, files, req.actor!);
    res.json(created.map(toAttachmentResponse));
  })
);

export const attachmentRouter: RouterType = Router();

/** Jira's limits-discovery endpoint — must precede /:id (A3). */
attachmentRouter.get('/meta', (_req, res) => {
  res.json({ enabled: true, uploadLimit: MAX_ATTACHMENT_BYTES });
});

attachmentRouter.get(
  '/:id',
  ah(async (req, res) => {
    const scoped = await loadAttachmentScoped(ps(req.params.id), req.actor!);
    if (!scoped) return;
    const full = await prisma.attachment.findUniqueOrThrow({ where: { id: scoped.att.id }, include: { author: true } });
    res.json(toAttachmentResponse(full));
  })
);

attachmentRouter.get(
  '/content/:id',
  ah(async (req, res) => {
    const scoped = await loadAttachmentScoped(ps(req.params.id), req.actor!);
    if (!scoped) return;
    const { buffer, headers } = await serveContent(scoped.att);
    res.set(headers).send(buffer);
  })
);

attachmentRouter.get(
  '/thumbnail/:id',
  ah(async (req, res) => {
    const scoped = await loadAttachmentScoped(ps(req.params.id), req.actor!);
    if (!scoped) return;
    const thumb = await serveThumbnail(scoped.att);
    if (!thumb) {
      throw new JiraApiError(404, jiraError(['Attachment does not exist or you do not have permission to see it.']));
    }
    res.set(thumb.headers).send(thumb.buffer);
  })
);

attachmentRouter.delete(
  '/:id',
  ah(async (req, res) => {
    const scoped = await loadAttachmentScoped(ps(req.params.id), req.actor!);
    if (!scoped) return;
    const issue = await getIssueByKey(scoped.issueKey);
    // Jira: own uploads → DELETE_OWN_ATTACHMENTS; others → DELETE_ALL_ATTACHMENTS.
    if (scoped.att.authorId !== req.actor!.user.id) {
      await requireIssuePermission(req.actor!, 'DELETE_ALL_ATTACHMENTS', issue);
    } else if (!(await hasPermission(req.actor!, 'DELETE_OWN_ATTACHMENTS', { projectId: issue.projectId, issue }))) {
      throw new JiraApiError(403, jiraError(['You do not have permission to delete attachments on this issue.']));
    }
    await deleteAttachment(scoped.att, issue, req.actor!);
    res.status(204).end();
  })
);
