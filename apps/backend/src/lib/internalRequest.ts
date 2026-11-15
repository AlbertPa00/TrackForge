// Server-internal dispatch: signed X-TrackForge-Internal loopback requests that
// traverse the full middleware + route stack — identical validation, project
// scoping (principal, not token), changelog, events and idempotency. Two users:
//   • copilot — runs as the signed-in user with channel=copilot (the copilot is
//     just another MCP client; no private shortcuts).
//   • proposal approval — re-executes the stored request as the original
//     principal with bypassApproval so the write isn't re-proposed, and
//     approvedById so the changelog records the human reviewer.
// Works even when the original PAT is revoked: the signature, minted with
// SESSION_SECRET, identifies the user directly.

import { INTERNAL_HEADER, signInternalActor } from './auth.js';

let overrideBase: string | null = null;

/** Tests point dispatch at an ephemeral app.listen(0) address. */
export function setInternalBaseUrl(url: string | null) {
  overrideBase = url;
}

export function internalBaseUrl(): string {
  return overrideBase ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
}

export interface InternalCallOptions {
  userId: string;
  channel: 'api' | 'mcp' | 'copilot' | 'automation';
  /** 065 B3 — caller's ApiToken/OAuthGrant id; keeps project scope + policy. */
  tokenId?: string;
  bypassApproval?: boolean;
  approvedById?: string;
  rationale?: string;
  headers?: Record<string, string>;
}

export async function internalRequest<T = unknown>(
  opts: InternalCallOptions,
  method: string,
  path: string,
  body?: unknown
): Promise<{ status: number; body: T }> {
  const res = await fetch(`${internalBaseUrl()}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      [INTERNAL_HEADER]: signInternalActor({
        uid: opts.userId,
        ch: opts.channel,
        tok: opts.tokenId,
        bypassApproval: opts.bypassApproval,
        approvedById: opts.approvedById,
      }),
      ...(opts.rationale ? { 'X-TrackForge-Rationale': opts.rationale } : {}),
      ...(opts.headers ?? {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = undefined;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body: parsed as T };
}
