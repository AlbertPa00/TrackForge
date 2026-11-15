import { prisma } from '../prisma.js';
import { Prisma } from '../lib/pc.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import { getIssueByKey, parseIssueKey, toIssueKey, toIssueResponse, issueInclude } from './issueService.js';
import { toUserResponse } from './userService.js';
import { emitEvent } from './eventService.js';
import { addWatcher, autowatchAllowed } from './notificationService.js';
import { requirePermission, canModifyAuthored } from './permissionService.js';
import { assertIssueWritable } from './projectService.js';
import type { Actor } from '../lib/auth.js';
import { resourceSelf } from '../lib/http.js';

const commentInclude = { author: true, issue: { include: { project: true } } } as const;

type CommentRow = {
  id: string;
  body: string;
  channel: string;
  createdAt: Date;
  updatedAt: Date;
  visibility?: unknown;
  author: Parameters<typeof toUserResponse>[0];
  issue: { issueNumber: number; project: { key: string } };
};

export function toCommentResponse(c: CommentRow) {
  const key = toIssueKey(c.issue.project.key, c.issue.issueNumber);
  return {
    id: c.id,
    self: resourceSelf(`/rest/api/2/issue/${key}/comment/${c.id}`),
    author: toUserResponse(c.author),
    body: c.body,
    created: c.createdAt.toISOString(),
    updated: c.updatedAt.toISOString(),
    channel: c.channel,
    // 031: Jira visibility — emitted only when restricted
    ...(c.visibility ? { visibility: c.visibility } : {}),
  };
}

/**
 * 065 audit C2 — event payloads fan out to the feed, SSE stream and e-mail
 * without per-recipient visibility evaluation, so a restricted comment's body
 * must not ride them. Metadata (id/author/visibility marker) stays; entitled
 * readers fetch the body via REST where visibility is enforced.
 */
function toCommentEventPayload(c: CommentRow) {
  const r = toCommentResponse(c);
  return c.visibility ? { ...r, body: null } : r;
}

export async function listComments(
  issueKey: string,
  startAt = 0,
  maxResults = 50,
  actor?: Actor,
  order: 'asc' | 'desc' = 'desc'
) {
  const issue = await getIssueByKey(issueKey);
  // 031: visibility-restricted comments are filtered post-fetch so `total`
  // is computed over the visible set (comment lists are small per issue).
  const all = await prisma.comment.findMany({
    where: { issueId: issue.id },
    orderBy: { createdAt: order },
    include: commentInclude,
  });
  const { filterByVisibility } = await import('./issueSecurityService.js');
  const visible = actor ? await filterByVisibility(all, actor, issue.projectId) : all;
  const comments = visible.slice(startAt, startAt + Math.min(100, maxResults));
  return { startAt, maxResults: comments.length, total: visible.length, comments };
}

export async function addComment(issueKey: string, body: string, actor: Actor, visibilityInput?: unknown) {
  if (!body?.trim()) {
    throw new JiraApiError(400, jiraError([], { body: 'Comment body is required.' }));
  }
  const issue = await getIssueByKey(issueKey);
  await assertIssueWritable(issue);
  await requirePermission(actor, 'ADD_COMMENTS', { projectId: issue.projectId, issue });
  const { parseVisibility, assertVisibilityTarget } = await import('./issueSecurityService.js');
  const visibility = parseVisibility(visibilityInput);
  if (visibility) await assertVisibilityTarget(visibility);
  const comment = await prisma.$transaction(async (tx) => {
    const c = await tx.comment.create({
      data: {
        issueId: issue.id,
        authorId: actor.user.id,
        body,
        channel: actor.channel,
        ...(visibility ? { visibility } : {}),
      },
      include: commentInclude,
    });
    const snapshot = await tx.issue.findUnique({ where: { id: issue.id }, include: issueInclude });
    await emitEvent(tx, actor, {
      type: 'comment_created',
      projectId: issue.projectId,
      issueId: issue.id,
      payload: {
        issueKey,
        projectKey: issue.project.key,
        issue: snapshot ? toIssueResponse(snapshot) : null,
        comment: toCommentEventPayload(c),
      },
    });
    return c;
  });
  if (await autowatchAllowed(actor.user.id, 'comment')) {
    await addWatcher(issue.id, actor.user.id); // auto-watch: commenters follow (066 — pref-gated)
  }
  return comment;
}

async function canModify(c: { authorId: string }, issue: { projectId: string }, actor: Actor, kind: 'EDIT' | 'DELETE') {
  return canModifyAuthored(actor, c, 'COMMENTS', kind, { projectId: issue.projectId });
}

export async function getComment(issueKey: string, commentId: string, actor?: Actor) {
  const c = await prisma.comment.findUnique({ where: { id: commentId }, include: commentInclude });
  if (!c) throw new JiraApiError(404, jiraError(['Comment does not exist.']));
  const { projectKey, issueNumber } = await parseIssueKey(issueKey);
  // 065 audit C4 — compare the ISSUE, not just its project: a comment id from
  // a security-levelled issue must not be readable through a sibling issue's
  // URL in the same project.
  if (c.issue.project.key !== projectKey || c.issue.issueNumber !== issueNumber) {
    throw new JiraApiError(404, jiraError(['Comment does not exist on this issue.']));
  }
  if (actor) {
    const { canSeeVisibility } = await import('./issueSecurityService.js');
    if (!(await canSeeVisibility(c, actor, c.issue.projectId))) {
      throw new JiraApiError(404, jiraError(['Comment does not exist.']));
    }
  }
  return c;
}

export async function editComment(
  issueKey: string,
  commentId: string,
  body: string,
  actor: Actor,
  visibilityInput?: unknown
) {
  if (!body?.trim()) {
    throw new JiraApiError(400, jiraError([], { body: 'Comment body is required.' }));
  }
  const c = await getComment(issueKey, commentId, actor);
  const issue = await getIssueByKey(issueKey);
  await assertIssueWritable(issue);
  if (!(await canModify(c, issue, actor, 'EDIT'))) {
    throw new JiraApiError(
      403,
      jiraError([], {
        permission: `Missing required permission 'EDIT_${c.authorId === actor.user.id ? 'OWN' : 'ALL'}_COMMENTS'.`,
      })
    );
  }
  const { parseVisibility, assertVisibilityTarget } = await import('./issueSecurityService.js');
  const visibility = parseVisibility(visibilityInput);
  if (visibility) await assertVisibilityTarget(visibility);
  return prisma.$transaction(async (tx) => {
    const updated = await tx.comment.update({
      where: { id: c.id },
      data: { body, ...(visibility !== undefined ? { visibility: visibility ?? Prisma.DbNull } : {}) },
      include: commentInclude,
    });
    await emitEvent(tx, actor, {
      type: 'comment_updated',
      projectId: updated.issue.projectId,
      issueId: updated.issueId,
      payload: {
        issueKey,
        projectKey: updated.issue.project.key,
        comment: toCommentEventPayload(updated),
      },
    });
    return updated;
  });
}

export async function deleteComment(issueKey: string, commentId: string, actor: Actor) {
  const c = await getComment(issueKey, commentId, actor);
  const issue = await getIssueByKey(issueKey);
  await assertIssueWritable(issue);
  if (!(await canModify(c, issue, actor, 'DELETE'))) {
    throw new JiraApiError(
      403,
      jiraError([], {
        permission: `Missing required permission 'DELETE_${c.authorId === actor.user.id ? 'OWN' : 'ALL'}_COMMENTS'.`,
      })
    );
  }
  await prisma.$transaction(async (tx) => {
    await emitEvent(tx, actor, {
      type: 'comment_deleted',
      projectId: c.issue.projectId,
      issueId: c.issueId,
      payload: {
        issueKey,
        projectKey: c.issue.project.key,
        comment: toCommentEventPayload(c),
      },
    });
    await tx.comment.delete({ where: { id: c.id } });
  });
}

/** Extracts mentioned user ids from Jira-style `[~accountId:<id>]` markers. */
export function extractMentionIds(body: string): string[] {
  return [...body.matchAll(/\[~accountId:([^\]]+)\]/g)].map((m) => m[1]!);
}
