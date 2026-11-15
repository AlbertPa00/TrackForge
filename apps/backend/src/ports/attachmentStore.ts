/**
 * Sprint 018 — attachment storage port (DESIGN §21 adapter, FR-001).
 * Service code never touches `fs` directly — `put/get/delete` by storage key.
 * `ATTACHMENT_STORAGE=fs|memory` selects the adapter; `ATTACHMENT_DIR` sets the
 * fs root (default `./attachments`). Object storage (S3/MinIO) plugs in later
 * by implementing this interface.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { S3Store } from './s3Store.js';

export interface AttachmentStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  /** Optional — powers the orphan sweep. Stores without listing simply skip it. */
  listKeys?(): Promise<string[]>;
}

/** Path traversal guard — keys are `{projectId}/{issueId}/{attachmentId}` shaped. */
function safeKey(root: string, key: string): string {
  const abs = resolve(root) + sep;
  const p = resolve(root, key);
  if (!p.startsWith(abs)) throw new Error(`Unsafe storage key '${key}'`);
  return p;
}

export class LocalFsStore implements AttachmentStore {
  constructor(private readonly root: string) {}

  async put(key: string, data: Buffer): Promise<void> {
    const p = safeKey(this.root, key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(safeKey(this.root, key));
  }

  async delete(key: string): Promise<void> {
    await rm(safeKey(this.root, key), { force: true });
  }

  async listKeys(): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string, prefix: string): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        const rel = prefix ? `${prefix}/${e.name}` : e.name;
        const full = join(dir, e.name);
        if (e.isDirectory()) await walk(full, rel);
        else if (e.isFile()) out.push(rel.split(sep).join('/'));
      }
    };
    await walk(resolve(this.root), '');
    return out;
  }
}

export class MemoryStore implements AttachmentStore {
  private readonly files = new Map<string, Buffer>();
  async put(key: string, data: Buffer): Promise<void> {
    this.files.set(key, Buffer.from(data));
  }
  async get(key: string): Promise<Buffer> {
    const d = this.files.get(key);
    if (!d) throw new Error(`No such object '${key}'`);
    return d;
  }
  async delete(key: string): Promise<void> {
    this.files.delete(key);
  }
  async listKeys(): Promise<string[]> {
    return [...this.files.keys()];
  }
  /** Test hook. */
  clear(): void {
    this.files.clear();
  }
}

let store: AttachmentStore | null = null;

export function getAttachmentStore(): AttachmentStore {
  if (!store) {
    const kind = process.env.ATTACHMENT_STORAGE ?? 'fs';
    if (kind === 'memory') {
      store = new MemoryStore();
    } else if (kind === 's3') {
      // 043 — MinIO/S3 backend; required fields are gated by validateEnv().
      store = new S3Store({
        endpoint: process.env.S3_ENDPOINT ?? '',
        bucket: process.env.S3_BUCKET ?? '',
        accessKey: process.env.S3_ACCESS_KEY ?? '',
        secretKey: process.env.S3_SECRET_KEY ?? '',
        region: process.env.S3_REGION,
      });
    } else {
      store = new LocalFsStore(process.env.ATTACHMENT_DIR ?? './attachments');
    }
  }
  return store;
}

/** Test hook — swap or reset the singleton. */
export function setAttachmentStore(s: AttachmentStore | null): void {
  store = s;
}
