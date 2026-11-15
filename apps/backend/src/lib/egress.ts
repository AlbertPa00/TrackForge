// Sprint 064 US5 — ONE egress guard for every outbound fetch the server makes.
// Centralizing this fixes the bug class where each call site hand-rolled its
// own checks and missed a case (bracketed IPv6, first-answer-only DNS,
// auto-followed redirects, alternate IP encodings).
//
// Rules enforced here:
//  - http/https only; the URL parser canonicalizes hostname encodings
//    (0x7f., decimal, octal, mixed forms all collapse to dotted-quad)
//  - bracket-stripped IPv6 literals + IPv4-mapped IPv6 normalized to v4
//  - full private/reserved blocklists for v4 and v6, deny-by-default
//  - hostname DNS validated against ALL answers, failure = deny
//  - redirects are followed manually; every hop is re-validated and
//    auth/signature headers are stripped on the first redirect
//  - callers run this at *delivery* time to shrink the DNS-rebinding window

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { JiraApiError, jiraError } from './errors.js';

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^100\.(6[4-9]|[7-9]\d|1[0-2]\d)\./,
  /^198\.(18|19)\./,
  /^(22[4-9]|2[3-9]\d)\./, // 224.0.0.0/4 multicast + 240/4 reserved
];
const PRIVATE_V6 = [/^::$/, /^::1$/, /^fe[89ab]/, /^fc/, /^fd/, /^fec0/, /^64:ff9b::/, /^64:ff9b:1::/, /^2001:db8/i];
const BLOCKED_HOSTNAMES = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.lan$/i,
  /^metadata\.google\.internal$/i,
];

/** Strip URL-literal brackets and collapse IPv4-mapped IPv6 (`::ffff:x`) to v4. */
export function normalizeIp(host: string): string {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(bare) !== 6) return bare;
  const f = bare.indexOf('ffff:');
  if (f === -1 || !/^0{0,4}(:0{0,4}){0,5}$/.test(bare.slice(0, f))) return bare;
  const tail = bare.slice(f + 5);
  if (isIP(tail) === 4) return tail;
  const parts = tail.split(':');
  if (parts.length > 2) return bare;
  const n = parts.map((p) => parseInt(p || '0', 16));
  if (n.some((x) => Number.isNaN(x) || x > 0xffff)) return bare;
  const bits = n.length === 1 ? n[0]! : ((n[0]! << 16) | n[1]!) >>> 0;
  return `${bits >>> 24}.${(bits >>> 16) & 255}.${(bits >>> 8) & 255}.${bits & 255}`;
}

export function isPrivateAddress(ip: string): boolean {
  const norm = normalizeIp(ip);
  const v = isIP(norm);
  if (v === 4) return PRIVATE_V4.some((r) => r.test(norm));
  if (v === 6) return PRIVATE_V6.some((r) => r.test(norm));
  return true; // not a parseable IP — deny
}

export interface EgressOpts {
  /** Escape hatch for self-hosted/inbound use (e.g. WEBHOOK_ALLOW_PRIVATE). */
  allowPrivate?: boolean;
  /** Also allow non-http(s) schemes — default is http/https only. */
  schemes?: string[];
}

/**
 * Validate a URL for outbound use. Throws JiraApiError(400) on anything that
 * could reach a private/reserved address or a non-HTTP scheme.
 */
export async function assertPublicUrl(raw: string, opts: EgressOpts = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new JiraApiError(400, jiraError(['Invalid URL.']));
  }
  const schemes = opts.schemes ?? ['http:', 'https:'];
  if (!schemes.includes(url.protocol)) {
    throw new JiraApiError(400, jiraError(['URL must be http(s).']));
  }
  if (url.username || url.password) {
    throw new JiraApiError(400, jiraError(['URL must not contain credentials.']));
  }
  if (opts.allowPrivate) return url;
  const host = normalizeIp(url.hostname);
  if (BLOCKED_HOSTNAMES.some((r) => r.test(host))) {
    throw new JiraApiError(400, jiraError(['URL points to a private host.']));
  }
  if (isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new JiraApiError(400, jiraError(['URL points to a private address.']));
    }
    return url;
  }
  // Every answer must be public — checking only the first lets an attacker
  // order a private answer second. Resolution failure denies (TOCTOU shrink).
  let answers: { address: string }[];
  try {
    answers = await lookup(host, { all: true });
  } catch {
    throw new JiraApiError(400, jiraError(['URL host could not be resolved.']));
  }
  if (!answers.length || answers.some((a) => isPrivateAddress(a.address))) {
    throw new JiraApiError(400, jiraError(['URL resolves to a private address.']));
  }
  return url;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HOP_HEADERS = ['authorization', 'x-hub-signature-256', 'x-trackforge-internal', 'cookie'];

/**
 * SSRF-hardened fetch: validates the URL, follows redirects manually with
 * re-validation per hop, and strips credential headers once a redirect occurs.
 */
export async function egressFetch(
  raw: string,
  init: RequestInit = {},
  opts: EgressOpts & { maxRedirects?: number } = {}
): Promise<Response> {
  const maxRedirects = opts.maxRedirects ?? 3;
  let url = (await assertPublicUrl(raw, opts)).toString();
  let current = init;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetch(url, { ...current, redirect: 'manual' });
    if (!REDIRECT_STATUSES.has(res.status) || !res.headers.get('location') || hop === maxRedirects) {
      return res;
    }
    const next = new URL(res.headers.get('location')!, url).toString();
    url = (await assertPublicUrl(next, opts)).toString();
    // 3xx → drop the body (303 semantics) and any credential headers.
    const headers = { ...(current.headers as Record<string, string> | undefined) };
    for (const k of Object.keys(headers)) {
      if (HOP_HEADERS.includes(k.toLowerCase())) delete headers[k];
    }
    current = { ...current, method: 'GET', body: undefined, headers };
  }
  throw new JiraApiError(400, jiraError(['Too many redirects.']));
}
