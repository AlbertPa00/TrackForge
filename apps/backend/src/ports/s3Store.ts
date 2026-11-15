/**
 * 043 — S3-compatible attachment store (MinIO in prod compose; AWS S3 works too).
 * Plain fetch + AWS Signature Version 4 — zero new deps. Path-style URLs
 * ({endpoint}/{bucket}/{key}) since that's what MinIO serves by default.
 */
import { createHash, createHmac } from 'node:crypto';

export interface S3Options {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region?: string;
}

const sha256 = (d: Buffer | string): string => createHash('sha256').update(d).digest('hex');
const hmac = (key: Buffer | string, d: string): Buffer => createHmac('sha256', key).update(d).digest();
const encodeKey = (key: string): string => key.split('/').map(encodeURIComponent).join('/');

export class S3Store {
  private readonly endpoint: string;
  private readonly region: string;

  constructor(private readonly o: S3Options) {
    this.endpoint = o.endpoint.replace(/\/$/, '');
    this.region = o.region ?? 'us-east-1';
  }

  private sign(method: string, path: string, canonicalQuery: string, payload: Buffer | string): Record<string, string> {
    const host = new URL(this.endpoint).host;
    const now = new Date();
    const amzDate = now
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256(payload);
    const headers: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };
    const signed = Object.keys(headers).sort().join(';');
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((k) => `${k}:${headers[k]}`)
      .join('\n');
    const canonical = `${method}\n${path}\n${canonicalQuery}\n${canonicalHeaders}\n\n${signed}\n${payloadHash}`;
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const toSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(canonical)}`;
    let k: Buffer | string = `AWS4${this.o.secretKey}`;
    for (const part of [dateStamp, this.region, 's3', 'aws4_request']) k = hmac(k, part);
    const signature = createHmac('sha256', k).update(toSign).digest('hex');
    return {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${this.o.accessKey}/${scope}, SignedHeaders=${signed}, Signature=${signature}`,
    };
  }

  private pathFor(key: string): string {
    return `/${this.o.bucket}/${encodeKey(key)}`;
  }

  private url(key: string): string {
    return `${this.endpoint}${this.pathFor(key)}`;
  }

  /** Create the bucket once — idempotent; AlreadyOwnedByYou/409 means "exists". */
  private bucketReady: Promise<void> | null = null;
  private ensureBucket(): Promise<void> {
    if (!this.bucketReady) {
      const path = `/${this.o.bucket}`;
      this.bucketReady = fetch(`${this.endpoint}${path}`, {
        method: 'PUT',
        headers: this.sign('PUT', path, '', ''),
      }).then(async (res) => {
        if (!res.ok && res.status !== 409) {
          const body = await res.text().catch(() => '');
          // BucketAlreadyExists without ownership is still fatal for writes.
          if (res.status === 403 && !body.includes('BucketAlreadyExists')) {
            throw new Error(`S3 create bucket ${this.o.bucket}: ${res.status} ${body}`);
          }
        }
      });
    }
    return this.bucketReady;
  }

  async put(key: string, data: Buffer): Promise<void> {
    await this.ensureBucket();
    const res = await fetch(this.url(key), {
      method: 'PUT',
      headers: this.sign('PUT', this.pathFor(key), '', data),
      body: data,
    });
    if (!res.ok) throw new Error(`S3 put ${key}: ${res.status} ${await res.text().catch(() => '')}`);
  }

  async get(key: string): Promise<Buffer> {
    const res = await fetch(this.url(key), {
      method: 'GET',
      headers: this.sign('GET', this.pathFor(key), '', ''),
    });
    if (!res.ok) throw new Error(`S3 get ${key}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    const res = await fetch(this.url(key), {
      method: 'DELETE',
      headers: this.sign('DELETE', this.pathFor(key), '', ''),
    });
    if (!res.ok && res.status !== 404) throw new Error(`S3 delete ${key}: ${res.status}`);
  }

  async listKeys(): Promise<string[]> {
    const path = `/${this.o.bucket}`;
    const res = await fetch(`${this.endpoint}${path}?list-type=2`, {
      headers: this.sign('GET', path, 'list-type=2', ''),
    });
    if (!res.ok) throw new Error(`S3 list: ${res.status}`);
    const xml = await res.text();
    return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => m[1]);
  }
}
