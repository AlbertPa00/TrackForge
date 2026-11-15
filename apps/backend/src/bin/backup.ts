// 044 — `pnpm backup` (dev) / `docker compose exec app node dist/bin/backup.js`.
import { runBackup, listBackups, verifyBackup } from '../services/backupService.js';
import { prisma } from '../prisma.js';

const cmd = process.argv[2] ?? 'now';
try {
  if (cmd === 'now') {
    const m = await runBackup();
    console.log(
      `backup ${m.id}: ${m.files.join(', ')} (${m.counts.issues} issues, ${m.counts.attachments} attachments)`
    );
  } else if (cmd === 'list') {
    for (const b of await listBackups()) console.log(`${b.id}  ${b.createdAt}  issues=${b.counts.issues}`);
  } else if (cmd === 'verify') {
    const id = process.argv[3];
    if (!id) throw new Error('usage: backup verify <id>');
    const r = await verifyBackup(id);
    console.log(r.ok ? `${r.id}: checksums OK` : `${r.id}: MISMATCH ${r.mismatched.join(', ')}`);
    process.exitCode = r.ok ? 0 : 1;
  } else {
    throw new Error('usage: backup [now|list|verify <id>]');
  }
} catch (e) {
  console.error(`backup: ${(e as Error).message}`);
  process.exitCode = 1;
}
await prisma.$disconnect();
