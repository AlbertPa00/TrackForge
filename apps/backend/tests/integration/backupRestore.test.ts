// Sprint 061 US4 — guarded UI restore. The route previews with
// ?dryRun=true + confirmToken, verifies manifest checksums before
// launching, and honours TF_DISABLE_UI_RESTORE. Restore itself runs
// detached with progress in a file marker (never the DB).
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import app from '../../src/main.js';
import { authed, ensureTestAuth } from '../request.js';

const dir = await mkdtemp(join(tmpdir(), 'tf-restore-test-'));
const BID = '20990101-000000';

const sha256 = async (p: string) => createHash('sha256').update(await readFile(p)).digest('hex');

async function seedBackup(contents: string) {
  await mkdir(join(dir, BID), { recursive: true });
  await writeFile(join(dir, BID, 'db.dump'), contents);
  const hash = await sha256(join(dir, BID, 'db.dump'));
  const manifest = {
    id: BID, createdAt: new Date().toISOString(), version: 'test', scm: 'test',
    sha256: { 'db.dump': hash },
    counts: { issues: 1 }, files: ['db.dump'],
  };
  await writeFile(join(dir, BID, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(dir, BID, 'checksums.sha256'), `${hash}  db.dump\n`);
}

describe('backup restore guard (061 US4)', () => {
  beforeEach(async () => {
    await ensureTestAuth();
    await seedBackup('not-a-real-pg-dump-archive');
    process.env.BACKUP_DIR = dir;
    delete process.env.TF_DISABLE_UI_RESTORE;
  });
  afterAll(async () => {
    delete process.env.BACKUP_DIR;
    await rm(dir, { recursive: true, force: true });
  });

  it('dryRun previews the manifest and mints a confirmToken without restoring', async () => {
    const r = await authed(app)
      .post(`/api/internal/admin/system/backups/${BID}/restore?dryRun=true`)
      .expect(200);
    expect(r.body.preview.id).toBe(BID);
    expect(r.body.preview.counts.issues).toBe(1);
    expect(r.body.confirmToken).toBeTruthy();
    expect(r.body.warning).toContain('permanently lost');
    expect(r.body.warning).toContain('Attachment');
  });

  it('refuses a real restore without a confirmToken', async () => {
    await authed(app).post(`/api/internal/admin/system/backups/${BID}/restore`).expect(400);
    await expect(readFile(join(dir, '.restore-status.json'), 'utf8')).rejects.toThrow();
  });

  it('409s when manifest checksums no longer match the files', async () => {
    const dry = await authed(app)
      .post(`/api/internal/admin/system/backups/${BID}/restore?dryRun=true`).expect(200);
    await writeFile(join(dir, BID, 'db.dump'), 'tampered-after-preview');
    await authed(app)
      .post(`/api/internal/admin/system/backups/${BID}/restore?confirmToken=${dry.body.confirmToken}`)
      .expect(409);
  });

  it('404s when TF_DISABLE_UI_RESTORE is set', async () => {
    process.env.TF_DISABLE_UI_RESTORE = '1';
    await authed(app)
      .post(`/api/internal/admin/system/backups/${BID}/restore?dryRun=true`).expect(404);
  });

  it('launches detached and leaves a file marker for status polling', async () => {
    const dry = await authed(app)
      .post(`/api/internal/admin/system/backups/${BID}/restore?dryRun=true`).expect(200);
    await authed(app)
      .post(`/api/internal/admin/system/backups/${BID}/restore?confirmToken=${dry.body.confirmToken}`)
      .expect(202);

    // The marker is written before pg_restore runs; the fake archive makes it
    // fail fast (or ENOENT when the binary is absent) — either way it must
    // land in the file, not the DB.
    const deadline = Date.now() + 5000;
    let status: { state: string; backupId?: string } | null = null;
    while (Date.now() < deadline) {
      try {
        status = JSON.parse(await readFile(join(dir, '.restore-status.json'), 'utf8'));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    expect(status?.backupId).toBe(BID);
    expect(['running', 'done', 'failed']).toContain(status?.state);
  });
});
