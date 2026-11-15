import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { S3Store } from '../../src/ports/s3Store.js';

// 043 — S3 adapter: SigV4-signed requests against a stub endpoint.

const objects = new Map<string, Buffer>();
let server: Server;
let endpoint = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const auth = req.headers.authorization ?? '';
    // Every request must carry a SigV4 Authorization header.
    if (!auth.startsWith('AWS4-HMAC-SHA256 ')) {
      res.writeHead(403).end('missing sig');
      return;
    }
    const key = decodeURIComponent(url.pathname.split('/').slice(2).join('/'));
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        objects.set(key, Buffer.concat(chunks));
        res.writeHead(200).end();
      });
    } else if (req.method === 'GET' && url.searchParams.get('list-type') === '2') {
      res.writeHead(200).end(
        `<ListBucketResult>${[...objects.keys()].map((k) => `<Contents><Key>${k}</Key></Contents>`).join('')}</ListBucketResult>`,
      );
    } else if (req.method === 'GET') {
      const d = objects.get(key);
      if (d) res.writeHead(200).end(d);
      else res.writeHead(404).end();
    } else if (req.method === 'DELETE') {
      objects.delete(key);
      res.writeHead(204).end();
    } else {
      res.writeHead(405).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, r));
  endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());

const make = () =>
  new S3Store({ endpoint, bucket: 'tf', accessKey: 'ak', secretKey: 'sk', region: 'us-east-1' });

describe('043 S3Store', () => {
  it('put/get/delete/list round-trip with signed requests', async () => {
    const s = make();
    await s.put('p/i/a.bin', Buffer.from('hello s3'));
    expect((await s.get('p/i/a.bin')).toString()).toBe('hello s3');
    expect(await s.listKeys()).toContain('p/i/a.bin');
    await s.delete('p/i/a.bin');
    await expect(s.get('p/i/a.bin')).rejects.toThrow('404');
  });

  it('encodes keys with spaces/specials', async () => {
    const s = make();
    await s.put('p/i/my file (1).png', Buffer.from('x'));
    expect((await s.get('p/i/my file (1).png'))[0]).toBe(0x78);
  });
});
