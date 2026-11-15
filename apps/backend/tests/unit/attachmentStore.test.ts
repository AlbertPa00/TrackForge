import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { LocalFsStore, MemoryStore } from '../../src/ports/attachmentStore.js';

// LocalFsStore — safeKey resolves keys against the root. Regression: a relative
// root (the default './attachments') used to fail the prefix check outright,
// turning every upload into a 507.

const roots: string[] = [];
const tmpRoot = () => {
  const d = mkdtempSync(join(tmpdir(), 'tf-store-'));
  roots.push(d);
  return d;
};
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

describe('LocalFsStore', () => {
  it('roundtrips put/get/delete/listKeys with an absolute root', async () => {
    const store = new LocalFsStore(tmpRoot());
    await store.put('p/i/a', Buffer.from('x'));
    expect(await store.get('p/i/a')).toEqual(Buffer.from('x'));
    expect(await store.listKeys()).toEqual(['p/i/a']);
    await store.delete('p/i/a');
    await expect(store.get('p/i/a')).rejects.toThrow();
  });

  it('accepts a relative root (default ./attachments shape)', async () => {
    const abs = tmpRoot();
    const rel = relative(process.cwd(), abs);
    expect(rel.startsWith('.')).toBe(true);
    const store = new LocalFsStore(rel);
    await store.put('p/i/a', Buffer.from('x'));
    expect(await store.get('p/i/a')).toEqual(Buffer.from('x'));
  });

  it('rejects keys that escape the root', async () => {
    const store = new LocalFsStore(tmpRoot());
    await expect(store.put('../../evil', Buffer.from('x'))).rejects.toThrow('Unsafe storage key');
    await expect(store.get('../evil')).rejects.toThrow('Unsafe storage key');
  });
});

describe('MemoryStore', () => {
  it('roundtrips and clears', async () => {
    const store = new MemoryStore();
    await store.put('k', Buffer.from('x'));
    expect(await store.listKeys()).toEqual(['k']);
    store.clear();
    await expect(store.get('k')).rejects.toThrow();
  });
});
