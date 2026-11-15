/**
 * Sprint 018 — attachment service (US1/US2).
 * Bytes live behind `ports/attachmentStore` (FR-001); sniffed mime drives serving
 * headers (FR-005); issue visibility enforced by callers (FR-002).
 */
import { fileTypeFromBuffer } from 'file-type';
import type { Attachment, Issue, User } from '@prisma/client';
import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import type { Actor } from '../lib/auth.js';
import { getAttachmentStore } from '../ports/attachmentStore.js';
import { recordChange } from './changelogService.js';
import { emitEvent } from './eventService.js';
import { getDurableRunner, jobRunner, withAdvisoryLock } from '../lib/jobs.js';
import { resourceSelf } from '../lib/http.js';

export const MAX_ATTACHMENT_BYTES = Number(process.env.ATTACHMENT_MAX_BYTES ?? 25 * 1024 * 1024);

/** Types safe to render inline; everything else downloads (FR-005). */
const INLINE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);
const THUMBABLE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

type AttachmentWithAuthor = Attachment & { author: Pick<User, 'id' | 'displayName' | 'email' | 'active' | 'type'> };

export function toAttachmentResponse(a: AttachmentWithAuthor) {
  return {
    self: resourceSelf(`/rest/api/2/attachment/${a.id}`),
    id: a.id,
    filename: a.filename,
    author: {
      accountId: a.author.id,
      displayName: a.author.displayName,
      emailAddress: a.author.email,
      active: a.author.active,
      ...(a.author.type === 'agent' ? { agent: true } : {}),
    },
    created: a.createdAt.toISOString(),
    size: a.size,
    mimeType: a.sniffedMime ?? a.mime,
    content: resourceSelf(`/rest/api/2/attachment/content/${a.id}`),
    ...(a.thumbPath ? { thumbnail: resourceSelf(`/rest/api/2/attachment/thumbnail/${a.id}`) } : {}),
  };
}

const storageKey = (issue: Issue, attachmentId: string) => `${issue.projectId}/${issue.id}/${attachmentId}`;

/** sharp is an optional native dep — fall back to no-thumbnail when absent or undecodable. */
async function makeThumbnail(data: Buffer): Promise<Buffer | null> {
  try {
    const sharp = (await import('sharp')).default;
    return await sharp(data).resize(128, 128, { fit: 'inside', withoutEnlargement: true }).png().toBuffer();
  } catch {
    return null;
  }
}

export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  mimetype: string;
  size: number;
}

export async function uploadAttachments(issue: Issue, files: UploadedFile[], actor: Actor) {
  const store = getAttachmentStore();
  const created: AttachmentWithAuthor[] = [];
  for (const f of files) {
    if (f.size > MAX_ATTACHMENT_BYTES) {
      throw new JiraApiError(
        413,
        jiraError([
          `File '${f.originalname}' exceeds the ${Math.round(MAX_ATTACHMENT_BYTES / 1048576)}MB attachment limit.`,
        ])
      );
    }
    const sniffed = await fileTypeFromBuffer(f.buffer).catch(() => undefined);
    const row = await prisma.attachment.create({
      data: {
        issueId: issue.id,
        filename: f.originalname.slice(0, 255) || 'file',
        mime: f.mimetype || 'application/octet-stream',
        sniffedMime: sniffed?.mime ?? null,
        size: f.size,
        storagePath: '',
        authorId: actor.user.id,
        channel: actor.channel,
        tokenId: actor.token?.id ?? null,
      },
      include: { author: true },
    });
    const key = storageKey(issue, row.id);
    try {
      await store.put(key, f.buffer);
    } catch {
      await prisma.attachment.delete({ where: { id: row.id } }).catch(() => undefined);
      throw new JiraApiError(
        507,
        jiraError([`Could not store '${f.originalname}' — storage error. Retry the upload.`])
      );
    }
    // Thumbnail as an 016 job — never inline in the request (replan #2).
    if (THUMBABLE_MIMES.has(sniffed?.mime ?? f.mimetype)) {
      await getDurableRunner()
        ?.enqueue('attachment:thumbnail', { attachmentId: row.id, storageKey: key })
        .catch(() => undefined);
    }
    const updated = await prisma.attachment.update({
      where: { id: row.id },
      data: { storagePath: key },
      include: { author: true },
    });
    created.push(updated);
  }
  if (created.length) {
    await recordChange(
      prisma,
      issue.id,
      actor,
      created.map((a) => ({ field: 'Attachment', fromString: null, to: a.id, toString: a.filename }))
    );
    for (const a of created) {
      await emitEvent(prisma, actor, {
        type: 'jira:attachment_created',
        projectId: issue.projectId,
        payload: { attachment: toAttachmentResponse(a), issueId: issue.id },
      });
    }
  }
  return created;
}

/** Register the thumbnail + orphan-sweep job handlers once (boot + test setup). */
export function registerAttachmentJobs() {
  const runner = getDurableRunner();
  runner?.register('attachment:thumbnail', async (payload) => {
    const { attachmentId, storageKey: key } = payload as { attachmentId: string; storageKey: string };
    const store = getAttachmentStore();
    const data = await store.get(key);
    const thumb = await makeThumbnail(data);
    if (thumb) {
      const tkey = `${key}.thumb.png`;
      await store.put(tkey, thumb);
      await prisma.attachment.update({ where: { id: attachmentId }, data: { thumbPath: tkey } });
    }
  });
  // Orphan sweep: delete stored bytes whose attachment row is gone (issue deleted,
  // or a store.put succeeded but the metadata update crashed). Periodic tick →
  // durable job + advisory lock so multi-instance deployments sweep exactly once.
  runner?.register('attachment:sweep', () =>
    withAdvisoryLock('attachment:sweep', async () => {
      const store = getAttachmentStore();
      const keys = (await store.listKeys?.()) ?? [];
      for (const key of keys) {
        const base = key.endsWith('.thumb.png') ? key.slice(0, -10) : key;
        const attachmentId = base.split('/').at(-1);
        if (!attachmentId) continue;
        const row = await prisma.attachment.findUnique({ where: { id: attachmentId }, select: { id: true } });
        if (!row) await store.delete(key).catch(() => undefined);
      }
    }).then(() => {})
  );
  jobRunner.register(
    'attachment-sweep',
    () => runner!.enqueue('attachment:sweep', {}, { key: 'periodic:attachment:sweep' }).then(() => {}),
    3_600_000
  ); // hourly
  // Targeted purge after issue delete — keys captured pre-delete, enqueued post-commit.
  runner?.register('attachment:purge', async (payload) => {
    const { keys } = payload as { keys: string[] };
    const store = getAttachmentStore();
    for (const key of keys) await store.delete(key).catch(() => undefined);
  });
}

/**
 * Import path (017/018): persists bytes + metadata for a migrated attachment.
 * No changelog/events — bulk import stays quiet like the other importers.
 */
export async function importAttachment(
  issue: Pick<Issue, 'id' | 'projectId'>,
  file: { filename: string; mime: string; size: number; buffer: Buffer },
  opts: { authorId: string; createdAt?: Date | null }
) {
  const store = getAttachmentStore();
  const sniffed = await fileTypeFromBuffer(file.buffer).catch(() => undefined);
  const row = await prisma.attachment.create({
    data: {
      issueId: issue.id,
      filename: file.filename.slice(0, 255) || 'file',
      mime: file.mime || 'application/octet-stream',
      sniffedMime: sniffed?.mime ?? null,
      size: file.size,
      storagePath: '',
      authorId: opts.authorId,
      channel: 'import',
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
    include: { author: true },
  });
  const key = `${issue.projectId}/${issue.id}/${row.id}`;
  await store.put(key, file.buffer);
  const updated = await prisma.attachment.update({
    where: { id: row.id },
    data: { storagePath: key },
    include: { author: true },
  });
  if (THUMBABLE_MIMES.has(sniffed?.mime ?? file.mime)) {
    await getDurableRunner()
      ?.enqueue('attachment:thumbnail', { attachmentId: row.id, storageKey: key })
      .catch(() => undefined);
  }
  return updated;
}

export interface ServeResult {
  buffer: Buffer;
  headers: Record<string, string>;
}

/** RFC 5987 — non-Latin-1 names travel in filename* (065 audit G9). */
function contentDisposition(kind: 'inline' | 'attachment', filename: string): string {
  const fallback = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Sniffed mime wins; `inline` only for safe types; SVG always downloads (FR-005). */
export async function serveContent(a: Attachment): Promise<ServeResult> {
  const buffer = await getAttachmentStore().get(a.storagePath);
  const mime = a.sniffedMime ?? a.mime;
  const safeInline = INLINE_MIMES.has(mime) && mime !== 'image/svg+xml';
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Content-Length': String(buffer.length),
    'Content-Disposition': contentDisposition(safeInline ? 'inline' : 'attachment', a.filename),
    'X-Content-Type-Options': 'nosniff',
  };
  if (mime === 'image/svg+xml' || !safeInline) {
    headers['Content-Security-Policy'] = "default-src 'none'; style-src 'unsafe-inline'";
  }
  return { buffer, headers };
}

export async function serveThumbnail(a: Attachment): Promise<ServeResult | null> {
  if (!a.thumbPath) return null;
  const buffer = await getAttachmentStore()
    .get(a.thumbPath)
    .catch(() => null);
  if (!buffer) return null;
  return {
    buffer,
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(buffer.length),
      'Content-Disposition': contentDisposition('inline', `${a.filename}.thumb.png`),
      'X-Content-Type-Options': 'nosniff',
    },
  };
}

export async function deleteAttachment(a: Attachment, issue: Issue, actor: Actor) {
  const store = getAttachmentStore();
  await store.delete(a.storagePath).catch(() => undefined);
  if (a.thumbPath) await store.delete(a.thumbPath).catch(() => undefined);
  await prisma.attachment.delete({ where: { id: a.id } });
  await recordChange(prisma, issue.id, actor, [
    { field: 'Attachment', from: a.id, fromString: a.filename, toString: null },
  ]);
  await emitEvent(prisma, actor, {
    type: 'jira:attachment_deleted',
    projectId: issue.projectId,
    payload: { attachmentId: a.id, filename: a.filename, issueId: issue.id },
  });
}
