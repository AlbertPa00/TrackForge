// 044 — `pnpm restore <backup-id>` / `docker compose exec app node dist/bin/restore.js <id>`.
// Verifies checksums, then pg_restore --clean --if-exists, then re-copies the
// attachments tree for the fs store. Forward-only: restores INTO the current
// schema — run migrations first when restoring across versions.
import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pgRestore, verifyBackup } from '../services/backupService.js';
import { prisma } from '../prisma.js';

const id = process.argv[2];
if (!id) {
  console.error('usage: restore <backup-id>  (see `pnpm backup list`)');
  process.exit(1);
}
const root = process.env.BACKUP_DIR ?? './backups';
try {
  const v = await verifyBackup(id);
  if (!v.ok) throw new Error(`checksum mismatch: ${v.mismatched.join(', ')}`);
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  console.log(`restoring ${id} — pg_restore --clean --if-exists …`);
  await pgRestore(url, join(root, id, 'db.dump'));
  if ((process.env.ATTACHMENT_STORAGE ?? 'fs') === 'fs') {
    const src = join(root, id, 'attachments');
    const dest = process.env.ATTACHMENT_DIR ?? './attachments';
    await mkdir(dest, { recursive: true });
    await cp(src, dest, { recursive: true }).catch(() => {});
  }
  console.log(`restore ${id} complete`);
} catch (e) {
  console.error(`restore: ${(e as Error).message}`);
  process.exitCode = 1;
}
await prisma.$disconnect();
