// Sprint 044 US1 — backup & restore. Scheduled pg_dump + attachment mirror
// into BACKUP_DIR with a manifest (sha256, counts, version); retention prunes
// per policy. Restore is `pg_restore --clean --if-exists` — see
// docs/backup-restore.md. The dump command is injectable for tests.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { prisma } from '../prisma.js';
import { issueConfirmToken, consumeConfirmToken } from '../lib/confirmToken.js';
import { getSetting, putSetting } from './settingsService.js';
import { getAttachmentStore } from '../ports/attachmentStore.js';

const execFileP = promisify(execFile);
const LAST_KEY = 'backup:last';

export interface BackupManifest {
  id: string; // dir name — UTC timestamp YYYYMMDD-HHMMSS
  createdAt: string;
  version: string;
  scm: string;
  sha256: Record<string, string>;
  counts: Record<string, number>;
  files: string[];
}

export interface LastBackup {
  at: string;
  ok: boolean;
  id?: string;
  error?: string;
}

const sha256File = async (p: string): Promise<string> =>
  createHash('sha256')
    .update(await readFile(p))
    .digest('hex');

const backupDir = (): string => process.env.BACKUP_DIR ?? './backups';
const keep = (): number => Number(process.env.BACKUP_KEEP ?? 14);

/** Parse postgres:// URLs into pg_dump argv (no password on argv — PGPASSWORD). */
function pgArgs(databaseUrl: string): { args: string[]; env: NodeJS.ProcessEnv } {
  const u = new URL(databaseUrl);
  const env = { ...process.env, PGPASSWORD: decodeURIComponent(u.password) };
  const args = [
    '--format=custom',
    '--compress=6',
    '--no-owner',
    '-h',
    u.hostname,
    '-p',
    u.port || '5432',
    '-U',
    decodeURIComponent(u.username),
    '-d',
    decodeURIComponent(u.pathname.slice(1)),
  ];
  return { args, env };
}

/** Real dump: pg_dump custom format → db.dump. pg_restore for restore(). */
async function pgDump(databaseUrl: string, outFile: string): Promise<void> {
  const { args, env } = pgArgs(databaseUrl);
  await execFileP('pg_dump', [...args, '-f', outFile], { env });
}

export async function pgRestore(databaseUrl: string, dumpFile: string): Promise<void> {
  const { args, env } = pgArgs(databaseUrl);
  await execFileP('pg_restore', [...args, '--clean', '--if-exists', dumpFile], { env });
}

// ---------- 061 US4 — UI restore ----------
// pg_restore --clean drops the tables the durable job runner and sessions live
// in, so restore runs detached with progress in a FILE marker — never a DB row.

export const uiRestoreEnabled = (): boolean => !process.env.TF_DISABLE_UI_RESTORE;

/** Single-use, expiring token authorising a restore after a ?dryRun=true
    preview (065 audit F4). */
export function restorePreviewToken(backupId: string) {
  return issueConfirmToken('restore', backupId);
}

/** Atomically claim the restore token — true exactly once per preview. */
export function consumeRestoreToken(backupId: string, raw: string | undefined) {
  return consumeConfirmToken('restore', backupId, raw);
}

export interface RestoreStatus {
  state: 'idle' | 'running' | 'done' | 'failed';
  backupId?: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
}

const restoreMarkerPath = () => join(backupDir(), '.restore-status.json');

export async function readRestoreStatus(): Promise<RestoreStatus> {
  try {
    return JSON.parse(await readFile(restoreMarkerPath(), 'utf8')) as RestoreStatus;
  } catch {
    return { state: 'idle' };
  }
}

/**
 * Launch a detached restore: verifies nothing here (the route runs
 * verifyBackup first), writes the running marker, then pg_restore in the
 * background — the request returns before the DB is dropped. The marker file
 * survives the restore precisely because it is not in the database.
 */
export async function runRestoreDetached(id: string): Promise<void> {
  const dumpFile = join(backupDir(), id, 'db.dump');
  const status: RestoreStatus = { state: 'running', backupId: id, startedAt: new Date().toISOString() };
  const mark = (s: RestoreStatus) => writeFile(restoreMarkerPath(), JSON.stringify(s)).catch(() => undefined);
  await mark(status);
  const url = process.env.DATABASE_URL ?? '';
  void pgRestore(url, dumpFile)
    .then(() => mark({ ...status, state: 'done', finishedAt: new Date().toISOString() }))
    .catch((e) =>
      mark({
        ...status,
        state: 'failed',
        finishedAt: new Date().toISOString(),
        error: String(e instanceof Error ? e.message : e),
      })
    );
}

/**
 * One backup: timestamped dir under BACKUP_DIR containing
 * `db.dump`, `attachments/` (fs store only; s3 mirrors via mc/rclone — see
 * docs/backup-restore.md), `manifest.json`, `checksums.sha256`.
 */
export async function runBackup(dump: (url: string, out: string) => Promise<void> = pgDump): Promise<BackupManifest> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('BACKUP requires DATABASE_URL');
  const root = backupDir();
  const id = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });

  const files: string[] = [];
  const sha256: Record<string, string> = {};

  const dbFile = join(dir, 'db.dump');
  await dump(databaseUrl, dbFile);
  files.push('db.dump');
  sha256['db.dump'] = await sha256File(dbFile);

  // Attachments — fs store mirrors the tree; s3 mirrors via listKeys+get.
  // 065 audit G7 — every copied attachment is checksummed so verifyBackup
  // covers them too (previously only db.dump was integrity-checked).
  const storage = process.env.ATTACHMENT_STORAGE ?? 'fs';
  if (storage === 'fs') {
    const src = process.env.ATTACHMENT_DIR ?? './attachments';
    const dest = join(dir, 'attachments');
    await cp(src, dest, { recursive: true }).catch(() => {});
    // Walk the mirrored tree and checksum each file as attachments/<rel>.
    const walk = async (d: string, prefix: string): Promise<void> => {
      for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = join(d, e.name);
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        if (e.isDirectory()) await walk(p, rel);
        else if (e.isFile()) {
          files.push(`attachments/${rel}`);
          sha256[`attachments/${rel}`] = await sha256File(p);
        }
      }
    };
    await walk(dest, '');
  } else if (storage === 's3') {
    const store = getAttachmentStore();
    const keys = (await store.listKeys?.()) ?? [];
    for (const k of keys) {
      const dest = join(dir, 'attachments', k);
      await mkdir(join(dest, '..'), { recursive: true });
      const buf = await store.get(k);
      await writeFile(dest, buf);
      files.push(`attachments/${k}`);
      sha256[`attachments/${k}`] = createHash('sha256').update(buf).digest('hex');
    }
  }

  const counts = {
    issues: await prisma.issue.count(),
    users: await prisma.user.count(),
    projects: await prisma.project.count(),
    attachments: await prisma.attachment.count(),
  };
  const { buildMeta } = await import('../lib/buildInfo.js');
  const meta = buildMeta();
  const manifest: BackupManifest = {
    id,
    createdAt: new Date().toISOString(),
    version: meta.version,
    scm: meta.scm,
    sha256,
    counts,
    files,
  };
  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const lines = Object.entries(sha256)
    .map(([f, h]) => `${h}  ${f}`)
    .join('\n');
  await writeFile(join(dir, 'checksums.sha256'), `${lines}\n`);

  await pruneBackups();
  await putSetting(LAST_KEY, { at: manifest.createdAt, ok: true, id } satisfies LastBackup);
  return manifest;
}

/** Keep the newest `keep` timestamped backup dirs; delete the rest. */
export async function pruneBackups(): Promise<number> {
  const root = backupDir();
  const entries = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && /^\d{8}-\d{6}$/.test(e.name))
    .map((e) => e.name)
    .sort(); // timestamp names sort chronologically
  const excess = entries.slice(0, Math.max(0, entries.length - keep()));
  for (const name of excess) await rm(join(root, name), { recursive: true, force: true });
  return excess.length;
}

export async function listBackups(): Promise<BackupManifest[]> {
  const root = backupDir();
  const names = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((e) => e.isDirectory() && /^\d{8}-\d{6}$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
  const out: BackupManifest[] = [];
  for (const name of names) {
    try {
      out.push(JSON.parse(await readFile(join(root, name, 'manifest.json'), 'utf8')));
    } catch {
      /* incomplete dir — skip */
    }
  }
  return out;
}

export async function lastBackupStatus(): Promise<LastBackup | null> {
  return getSetting<LastBackup>(LAST_KEY);
}

export async function recordBackupFailure(error: unknown): Promise<void> {
  await putSetting(LAST_KEY, {
    at: new Date().toISOString(),
    ok: false,
    error: String(error).slice(0, 500),
  } satisfies LastBackup).catch(() => {});
}

/** sha256 verification of every checksummed file — the restore-drill check. */
export async function verifyBackup(id: string): Promise<{ id: string; ok: boolean; mismatched: string[] }> {
  // 065 audit F5 — the id goes straight into a path join; constrain it to the
  // timestamped dir-name format so '..' cannot escape BACKUP_DIR.
  if (!/^\d{8}-\d{6}$/.test(id)) throw new Error(`Invalid backup id: ${id}`);
  const dir = join(backupDir(), id);
  const text = await readFile(join(dir, 'checksums.sha256'), 'utf8');
  const mismatched: string[] = [];
  for (const line of text.trim().split('\n')) {
    const [hash, file] = line.split(/\s+/);
    // File names come from the manifest writer, but a tampered checksums file
    // must not turn this into an arbitrary-path hash oracle: only flat names
    // (db.dump) or forward-slash relative paths under attachments/ with no
    // traversal segments are hashed.
    const safe =
      !!file &&
      (/^[\w.-]+$/.test(file) || (file.startsWith('attachments/') && !file.includes('..') && !file.includes('\\')));
    if (!safe) {
      mismatched.push(file ?? '<invalid>');
      continue;
    }
    const actual = await sha256File(join(dir, file)).catch(() => null);
    if (actual !== hash) mismatched.push(file);
  }
  return { id, ok: mismatched.length === 0, mismatched };
}
