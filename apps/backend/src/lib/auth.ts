import crypto from 'crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import type { ApiToken, User } from '../lib/pc.js';
import { sessionSecret } from '../config.js';

// 065 audit A2 — the secret resolves through config (env or SESSION_SECRET_FILE);
// never read process.env.SESSION_SECRET directly here.
const SESSION_TTL = `${process.env.SESSION_TTL_HOURS ?? '12'}h` as jwt.SignOptions['expiresIn'];
export const SESSION_COOKIE = 'tf_session';

export interface Actor {
  user: User;
  token?: ApiToken;
  channel: 'ui' | 'api' | 'mcp' | 'copilot' | 'automation' | 'smartcommit';
  /** Set for server-internal requests (signed X-TrackForge-Internal). */
  internal?: {
    bypassApproval?: boolean;
    approvedById?: string;
  };
}

// --- passwords (scrypt, memory-hard) ---

// 065 audit A5 — async scrypt: scryptSync ran ~80ms on the request thread per
// call, so every login attempt stalled the whole API (a DoS amplifier).
const scryptAsync = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number
) => Promise<Buffer>;

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scryptAsync(password, salt, 64)).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const candidate = await scryptAsync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// --- API tokens ---

export function generateToken(): { plain: string; prefix: string; hash: string } {
  const plain = `tfp_${crypto.randomBytes(24).toString('hex')}`;
  return { plain, prefix: plain.slice(0, 12), hash: hashToken(plain) };
}

export function hashToken(plain: string): string {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

// --- internal actor (HMAC-signed, server-only; survives revoked PATs) ---

export const INTERNAL_HEADER = 'x-trackforge-internal';
const INTERNAL_TTL_MS = 60_000;

export interface InternalActorClaims {
  uid: string;
  ch: 'api' | 'mcp' | 'copilot' | 'automation';
  exp: number;
  bypassApproval?: boolean;
  approvedById?: string;
  // 065 audit B3 — the caller's token id (ApiToken or OAuthGrant) carried
  // through dispatch so project-scoped principals can't be laundered into
  // unrestricted sessions. Re-validated (revocation/expiry) on resolution.
  tok?: string;
}

export function signInternalActor(claims: Omit<InternalActorClaims, 'exp'>): string {
  const payload = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + INTERNAL_TTL_MS })).toString('base64url');
  const sig = crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyInternalActor(header: string): InternalActorClaims | null {
  try {
    const [payload, sig] = header.split('.');
    const expected = crypto.createHmac('sha256', sessionSecret()).update(payload!).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(sig!, 'base64url'), Buffer.from(expected, 'base64url'))) return null;
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) as InternalActorClaims;
    if (!claims.uid || claims.exp < Date.now()) return null;
    return claims;
  } catch {
    return null;
  }
}

// --- session JWT ---

export function signSession(
  userId: string,
  sid?: string,
  expiresIn: jwt.SignOptions['expiresIn'] = SESSION_TTL
): string {
  return jwt.sign({ sub: userId, ...(sid ? { sid } : {}) }, sessionSecret(), { expiresIn });
}

export function verifySession(token: string): { userId: string; sid?: string } | null {
  try {
    const payload = jwt.verify(token, sessionSecret()) as { sub?: string; sid?: string; kind?: string };
    // 065 audit A1 — a `kind` claim marks a non-session token (e.g. the 2FA
    // 'pending' login token). Reject it here so it can never act as a session.
    if (payload.kind) return null;
    return payload.sub ? { userId: payload.sub, sid: payload.sid } : null;
  } catch {
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (!k) continue;
    // Malformed % escapes must not throw — a single bad cookie used to take
    // the process down via unhandled rejection in requireAuth.
    try {
      out[k] = decodeURIComponent(v.join('='));
    } catch {
      out[k] = v.join('=');
    }
  }
  return out;
}
