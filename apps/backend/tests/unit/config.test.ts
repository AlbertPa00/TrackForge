import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 043 — env contract: schema validation, *_FILE secrets, production gate.

const kept = { ...process.env };
const KEYS = [
  'NODE_ENV', 'PORT', 'DATABASE_URL', 'SESSION_SECRET', 'SESSION_SECRET_FILE',
  'TF_ADMIN_EMAIL', 'TF_ADMIN_PASSWORD', 'TF_ADMIN_PASSWORD_FILE',
  'ADMIN_EMAIL', 'ADMIN_PASSWORD', 'ATTACHMENT_STORAGE', 'S3_ENDPOINT', 'S3_BUCKET',
];

function clean() {
  for (const k of KEYS) delete process.env[k];
}
async function fresh() {
  vi.resetModules();
  return import('../../src/config.js');
}

const tmp = mkdtempSync(join(tmpdir(), 'tf-env-'));
afterAll(() => {
  Object.assign(process.env, kept);
  rmSync(tmp, { recursive: true, force: true });
});

describe('043 env contract', () => {
  beforeEach(clean);

  it('dev defaults pass without secrets', async () => {
    const { loadEnv } = await fresh();
    const env = loadEnv();
    expect(env.PORT).toBe(3000);
    expect(env.ATTACHMENT_STORAGE).toBe('fs');
  });

  it('production without DATABASE_URL/SESSION_SECRET fails with a readable table', async () => {
    process.env.NODE_ENV = 'production';
    const { loadEnv } = await fresh();
    expect(() => loadEnv()).toThrowError(/configuration error/);
    try {
      loadEnv();
      expect.unreachable();
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain('DATABASE_URL');
      expect(msg).toContain('SESSION_SECRET');
      expect(msg).toContain('env-reference.md');
    }
  });

  it('production accepts a full config', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgres://u:p@db:5432/tf';
    process.env.SESSION_SECRET = 'x'.repeat(40);
    const { loadEnv } = await fresh();
    expect(() => loadEnv()).not.toThrow();
  });

  it('rejects the dev default secret in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.DATABASE_URL = 'postgres://u:p@db:5432/tf';
    process.env.SESSION_SECRET = 'trackforge-dev-secret';
    const { loadEnv } = await fresh();
    expect(() => loadEnv()).toThrowError(/SESSION_SECRET/);
  });

  it('*_FILE convention reads mounted secrets', async () => {
    const f = join(tmp, 'secret.txt');
    writeFileSync(f, 'file-sourced-secret-value-padded-to-32\n');
    process.env.SESSION_SECRET_FILE = f;
    const { loadEnv } = await fresh();
    expect(loadEnv().SESSION_SECRET).toBe('file-sourced-secret-value-padded-to-32');
  });

  it('invalid enum values report the field name', async () => {
    process.env.ATTACHMENT_STORAGE = 'bogus';
    const { loadEnv } = await fresh();
    try {
      loadEnv();
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toContain('ATTACHMENT_STORAGE');
    }
  });
});
