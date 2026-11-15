import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yauzl from 'yauzl';
import { buildSupportZip } from '../../src/services/supportZipService.js';

// 044 US3 / SC-004 — support zip contains zero secrets.

const kept = { SESSION_SECRET: process.env.SESSION_SECRET, DATABASE_URL: process.env.DATABASE_URL, SMTP_PASS: process.env.SMTP_PASS };
const dir = mkdtempSync(join(tmpdir(), 'tf-zip-'));

beforeAll(() => {
  process.env.SESSION_SECRET = 'super-secret-session-value-0123456789';
  process.env.DATABASE_URL = 'postgres://tf:hunter2pw@db:5432/trackforge';
  process.env.SMTP_PASS = 'smtp-s3cr3t';
});
afterAll(() => {
  for (const [k, v] of Object.entries(kept)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

async function unzip(zipPath: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const zip = await new Promise<yauzl.ZipFile>((res, rej) =>
    yauzl.open(zipPath, { lazyEntries: true }, (e, z) => (e ? rej(e) : res(z!))),
  );
  await new Promise<void>((res, rej) => {
    zip.readEntry();
    zip.on('entry', (entry) => {
      if (/\/$/.test(entry.fileName)) return zip.readEntry();
      zip.openReadStream(entry, (e, stream) => {
        if (e) return rej(e);
        const chunks: Buffer[] = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => {
          out.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
          zip.readEntry();
        });
        stream.on('error', rej);
      });
    });
    zip.on('end', res);
    zip.on('error', rej);
  });
  return out;
}

describe('044 support zip', () => {
  it('produces a valid zip with expected entries', async () => {
    const zip = await buildSupportZip();
    expect(zip.subarray(0, 2).toString()).toBe('PK');
    const p = join(dir, 's.zip');
    writeFileSync(p, zip);
    const files = await unzip(p);
    for (const name of ['manifest.json', 'config.json', 'checks.json', 'recent-errors.json']) {
      expect(files.has(name), name).toBe(true);
    }
  });

  it('SC-004: zero secret values in any entry', async () => {
    const zip = await buildSupportZip();
    const p = join(dir, 's2.zip');
    writeFileSync(p, zip);
    const files = await unzip(p);
    const blob = [...files.values()].join('\n');
    for (const secret of ['super-secret-session-value-0123456789', 'hunter2pw', 'smtp-s3cr3t']) {
      expect(blob).not.toContain(secret);
    }
    expect(blob).not.toMatch(/tfp_[A-Za-z0-9_-]{8,}/);
    // Secret keys are present as placeholders only.
    const cfg = JSON.parse(files.get('config.json')!);
    expect(cfg.SESSION_SECRET).toBe('<set>');
    expect(cfg.DATABASE_URL).toBe('<set>');
    expect(cfg.SMTP_PASS).toBe('<set>');
    expect(cfg.PORT).toMatch(/^\d+$/);
  });
});
