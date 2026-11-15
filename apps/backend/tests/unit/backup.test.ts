import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  runBackup, listBackups, verifyBackup, lastBackupStatus, pruneBackups,
} from '../../src/services/backupService.js';


// 044 US1 — backup service: manifest, checksums, retention, status record.
// pg_dump is injected; everything else exercises the real fs/DB path.

let root = '';
const attDir = mkdtempSync(join(tmpdir(), 'tf-att-'));
const kept = { BACKUP_DIR: process.env.BACKUP_DIR, DATABASE_URL: process.env.DATABASE_URL, BACKUP_KEEP: process.env.BACKUP_KEEP, ATTACHMENT_STORAGE: process.env.ATTACHMENT_STORAGE, ATTACHMENT_DIR: process.env.ATTACHMENT_DIR };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tf-backup-')); // fresh dir per test — retention counts stay isolated
  process.env.BACKUP_DIR = root;
  process.env.DATABASE_URL = 'postgres://u:p@db:5432/tf';
  process.env.ATTACHMENT_STORAGE = 'fs';
  process.env.ATTACHMENT_DIR = attDir;
  process.env.BACKUP_KEEP = '2';
});
afterAll(() => {
  for (const [k, v] of Object.entries(kept)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(attDir, { recursive: true, force: true });
});

const fakeDump = async (_url: string, out: string) => {
  writeFileSync(out, `dump-bytes-${Date.now()}`);
};

describe('044 backup service', () => {
  it('writes db.dump + manifest + checksums, records last status', async () => {
    const m = await runBackup(fakeDump);
    const dir = join(root, m.id);
    expect(existsSync(join(dir, 'db.dump'))).toBe(true);
    expect(existsSync(join(dir, 'manifest.json'))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.counts).toHaveProperty('issues');
    expect(manifest.sha256['db.dump']).toMatch(/^[0-9a-f]{64}$/);
    const status = await lastBackupStatus();
    expect(status?.ok).toBe(true);
    expect(status?.id).toBe(m.id);
  });

  it('verify passes on intact backup, lists manifests', async () => {
    const m = await runBackup(fakeDump);
    const v = await verifyBackup(m.id);
    expect(v.ok).toBe(true);
    expect(v.mismatched).toHaveLength(0);
    const all = await listBackups();
    expect(all.some((b) => b.id === m.id)).toBe(true);
  });

  it('verify detects tampering', async () => {
    const m = await runBackup(fakeDump);
    writeFileSync(join(root, m.id, 'db.dump'), 'corrupted');
    const v = await verifyBackup(m.id);
    expect(v.ok).toBe(false);
    expect(v.mismatched).toContain('db.dump');
  });

  it('mirrors the fs attachment tree', async () => {
    mkdirSync(join(attDir, 'p', 'i'), { recursive: true });
    writeFileSync(join(attDir, 'p', 'i', 'a.bin'), 'attachment-bytes');
    const m = await runBackup(fakeDump);
    expect(readFileSync(join(root, m.id, 'attachments', 'p', 'i', 'a.bin'), 'utf8')).toBe('attachment-bytes');
  });

  it('prunes retention to BACKUP_KEEP', async () => {
    // Manufacture 4 backup dirs; keep=2 leaves the two newest.
    for (const name of ['20200101-000000', '20200102-000000', '20200103-000000', '20200104-000000']) {
      mkdirSync(join(root, name), { recursive: true });
    }
    const pruned = await pruneBackups();
    expect(pruned).toBe(2);
    expect(existsSync(join(root, '20200104-000000'))).toBe(true);
    expect(existsSync(join(root, '20200103-000000'))).toBe(true);
    expect(existsSync(join(root, '20200101-000000'))).toBe(false);
  });
});
