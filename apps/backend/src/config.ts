import { readFileSync } from 'node:fs';
import { z } from 'zod/v3';

/**
 * 043 — 12-factor config contract. Every setting arrives via env or a mounted
 * secret file (`*_FILE` convention — the file's contents become the value).
 * `validateEnv()` runs before listen; on failure it prints a readable table of
 * what's wrong and exits 1 — the app never starts half-configured.
 * `docs/env-reference.md` and `.env.example` are generated from this schema.
 */

/** Docker secrets / k8s mounted secrets: NAME_FILE contents override NAME. */
function readEnv(name: string): string | undefined {
  const file = process.env[`${name}_FILE`];
  if (file) {
    try {
      return readFileSync(file, 'utf8').trim();
    } catch {
      return undefined;
    }
  }
  return process.env[name];
}

const bool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).optional(),
  PORT: z.coerce.number().int().min(1).max(65535).optional().default(3000),

  // Required in production (validated in loadEnv's prod gate — optional here so
  // dev/test defaults still boot)
  DATABASE_URL: z
    .string()
    .min(1)
    .optional()
    .describe('PostgreSQL connection string (postgres://user:pass@host:5432/db)'),
  SESSION_SECRET: z
    .string()
    .optional()
    .describe('HMAC secret for session JWTs (>=32 chars; SESSION_SECRET_FILE for secrets)'),

  // HTTP surface
  PUBLIC_BASE_URL: z.string().url().optional().describe('External URL for links in emails/webhooks'),
  FRONTEND_URL: z
    .string()
    .url()
    .optional()
    .describe('SPA origin for browser redirects (OAuth login bounce). Defaults to PUBLIC_BASE_URL in prod, :5173 in dev'),
  CORS_ORIGINS: z.string().optional().describe('Comma-separated origins (dev only — prod is single-origin)'),
  FRONTEND_DIST: z.string().optional().describe('Path to the built frontend (single-origin serving)'),
  RATE_LIMIT: z.coerce.number().int().optional().describe('Requests/min per actor (default 1000)'),
  METRICS_BEARER: z
    .string()
    .optional()
    .describe('Shared bearer required on /metrics (prod: set so the public port stops serving it open)'),
  UPDATE_CHECK_ENABLED: z.enum(['true', 'false']).optional().default('false'),
  UPDATE_CHECK_URL: z.string().optional(),
  UPDATE_CHECK_INTERVAL_MS: z.coerce.number().int().positive().optional().default(86_400_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional().default('info'),

  // First-run bootstrap (also TF_ADMIN_* aliases)
  ADMIN_EMAIL: z.string().email().optional().describe('Bootstrap admin email (first user) — or TF_ADMIN_EMAIL'),
  ADMIN_PASSWORD: z
    .string()
    .optional()
    .describe('Bootstrap admin password (ADMIN_PASSWORD_FILE / TF_ADMIN_PASSWORD_FILE for secrets)'),
  TF_ADMIN_EMAIL: z.string().email().optional(),
  TF_ADMIN_PASSWORD: z.string().optional(),

  // Storage
  ATTACHMENT_STORAGE: z.enum(['fs', 's3', 'memory']).optional().default('fs'),
  ATTACHMENT_DIR: z.string().optional().describe('Filesystem attachment dir (fs backend)'),
  ATTACHMENT_MAX_BYTES: z.coerce.number().int().optional(),
  S3_ENDPOINT: z.string().optional().describe('S3-compatible endpoint (MinIO) — required when ATTACHMENT_STORAGE=s3'),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY: z.string().optional(),
  S3_SECRET_KEY: z.string().optional(),
  S3_REGION: z.string().optional(),

  // Infra
  REDIS_URL: z.string().optional().describe('Redis URL for queue/pub-sub scale-out'),
  EVENT_RETENTION_DAYS: z.coerce.number().int().optional(),

  // Backups (044)
  BACKUP_ENABLED: bool.describe('Scheduled backups — default on in production, off in dev'),
  BACKUP_DIR: z.string().optional().describe('Backup root (default ./backups; /backups in the image)'),
  BACKUP_KEEP: z.coerce.number().int().min(1).optional().describe('Backup sets retained (default 14)'),
  BACKUP_INTERVAL_MS: z.coerce.number().int().optional(),

  // Mail
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().optional(),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional().describe('SMTP_PASSWORD_FILE also honored via generic *_FILE convention'),
  SMTP_FROM: z.string().optional(),
  SMTP_TLS: bool,

  // Misc
  WEBHOOK_ALLOW_PRIVATE: bool.describe('Allow webhooks to RFC1918/loopback (dev only — SSRF guard)'),

  // Build metadata (injected by the image build via OCI labels → env)
  TF_VERSION: z.string().optional(),
  TF_BUILD_DATE: z.string().optional(),
  TF_BUILD_NUMBER: z.coerce.number().int().optional(),
  TF_SCM_REVISION: z.string().optional(),
});

type Env = z.infer<typeof envSchema>;
let cached: Env | null = null;

/** Validated env — throws with a readable table on failure. */
export function loadEnv(): Env {
  if (cached) return cached;
  const raw: Record<string, string | undefined> = {};
  for (const key of Object.keys(envSchema.shape)) raw[key] = readEnv(key);
  // *_FILE fallback chains for the documented secret names
  raw.TF_ADMIN_PASSWORD ??= readEnv('ADMIN_PASSWORD');
  raw.TF_ADMIN_EMAIL ??= readEnv('ADMIN_EMAIL');

  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const rows = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(
      `TrackForge configuration error — fix and restart:\n${rows.join('\n')}\nSee docs/env-reference.md.`
    );
  }
  const env = parsed.data;
  const failures: string[] = [];
  // 045 US3-3 — never boot with a known/example secret. Denylist covers the
  // dev default and every placeholder published in .env.example/docs.
  const badSecrets = new Set([
    'trackforge-dev-secret',
    'change-me',
    'changeme',
    'your-session-secret-here',
    'secret',
    'SESSION_SECRET',
  ]);
  if (env.SESSION_SECRET && (badSecrets.has(env.SESSION_SECRET) || env.SESSION_SECRET.startsWith('change-me'))) {
    failures.push('SESSION_SECRET: is a known/example value — generate one: openssl rand -base64 32');
  }
  if (env.NODE_ENV === 'production') {
    if (!env.DATABASE_URL) failures.push('DATABASE_URL: required in production (postgres://…)');
    if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32 || env.SESSION_SECRET === 'trackforge-dev-secret') {
      failures.push('SESSION_SECRET: required in production (>=32 chars, not the dev default, or SESSION_SECRET_FILE)');
    }
    if (env.ATTACHMENT_STORAGE === 's3' && (!env.S3_ENDPOINT || !env.S3_BUCKET)) {
      failures.push('S3_ENDPOINT + S3_BUCKET: required when ATTACHMENT_STORAGE=s3');
    }
    // 065 audit A5 — the session cookie's Secure flag follows this URL; over
    // http it is sent in the clear. Warn loudly rather than fail: http behind
    // a home-lab proxy is a legitimate deployment, but the operator must know.
    const base = process.env.PUBLIC_BASE_URL ?? '';
    if (base && !base.startsWith('https://')) {
      console.warn(
        `[config] PUBLIC_BASE_URL=${base} is not https — session cookies will not carry the Secure flag. ` +
          'Terminate TLS (or put TrackForge behind an https reverse proxy) and set PUBLIC_BASE_URL accordingly.'
      );
    }
  }
  if (failures.length) {
    throw new Error(
      `TrackForge configuration error — fix and restart:\n  ${failures.join('\n  ')}\nSee docs/env-reference.md.`
    );
  }
  cached = env;
  return env;
}

/** Boot-time fail-fast — exits 1 with the readable table (skipped under tests). */
export function validateEnv(): void {
  try {
    loadEnv();
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}

export const publicBaseUrl = (): string => (process.env.PUBLIC_BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');

/** Where the SPA lives, for browser redirects (OAuth authorize → /login?next=). */
export const frontendBaseUrl = (): string =>
  (
    process.env.FRONTEND_URL ??
    (process.env.NODE_ENV === 'production' ? publicBaseUrl() : 'http://localhost:5173')
  ).replace(/\/$/, '');

// 065 audit A2 — ONE resolved session secret. Every signer/verifier must call
// this (JWTs, internal-actor HMAC, confirm tokens, AI-key encryption) so the
// documented SESSION_SECRET_FILE path actually takes effect. Falls back to the
// dev secret only outside production; loadEnv() still fails fast on a missing
// or known-bad value at boot.
let cachedSessionSecret: string | undefined;
export function sessionSecret(): string {
  if (cachedSessionSecret) return cachedSessionSecret;
  const s = readEnv('SESSION_SECRET');
  if (s) return (cachedSessionSecret = s);
  if (process.env.NODE_ENV === 'production') {
    throw new Error('SESSION_SECRET or SESSION_SECRET_FILE is required in production');
  }
  return (cachedSessionSecret = 'trackforge-dev-secret');
}
