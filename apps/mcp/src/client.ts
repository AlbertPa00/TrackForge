/** Thin REST client: forwards the agent token + declares the mcp channel. */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface CallOptions {
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  dryRun?: boolean;
  idempotencyKey?: string;
  /** Free-text reason attached to a gated write — shown to the human approver. */
  rationale?: string;
}

// Sprint 056: write-tool extras (dry_run / idempotency_key / rationale) are
// injected once per tool invocation instead of hand-forwarded at every
// call site — a write tool can no longer ship a schema flag that silently
// never reaches the wire. Call-site opts still win over the inherited ones.
const callExtras = new AsyncLocalStorage<CallOptions>();

export function withCallExtras<T>(extras: CallOptions, fn: () => T): T {
  return callExtras.run(extras, fn);
}

// 070 — pooled servers serve any token: tools resolve their client at call
// time through this binding (stateless HTTP wraps each dispatch in
// withClient; stdio sets one static client) instead of capturing it at
// register time, so a pre-built server+transport can be reused pool-side.
const clientStore = new AsyncLocalStorage<TrackForgeClient>();
let staticClient: TrackForgeClient | undefined;

export function withClient<T>(client: TrackForgeClient, fn: () => T): T {
  return clientStore.run(client, fn);
}

/** Stdio mode — one principal for the process lifetime. */
export function setStaticClient(client: TrackForgeClient): void {
  staticClient = client;
}

export function currentClient(): TrackForgeClient {
  const c = clientStore.getStore() ?? staticClient;
  if (!c) throw new Error('TrackForgeClient not bound — tool handlers must run inside withClient()');
  return c;
}

/** Drop-in for a captured `tf`: forwards every member access to the
 *  request-bound client at call time. */
export function boundClient(): TrackForgeClient {
  return new Proxy({} as TrackForgeClient, {
    get(_target, prop) {
      const c = currentClient() as unknown as Record<string | symbol, unknown>;
      const v = c[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(c) : v;
    },
  });
}

export class ToolError extends Error {
  constructor(
    public status: number,
    public errorMessages: string[],
    public errors: Record<string, string>
  ) {
    super(
      [...errorMessages, ...Object.entries(errors).map(([k, v]) => `${k}: ${v}`)].join(' | ') ||
        `Request failed (${status})`
    );
  }
}

export class TrackForgeClient {
  constructor(
    private baseUrl: string,
    private token: string
  ) {}

  /** Base URL for one-off stream connections (SSE). */
  base() {
    return this.baseUrl;
  }

  /** Auth headers for out-of-band requests (SSE stream). */
  authHeaders(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, 'X-TrackForge-Channel': 'mcp' };
  }

  /** Multipart POST for the attachment API (Sprint 018). `file` is the Jira field name. */
  async upload(path: string, file: { data: Blob; filename: string }, opts: { rationale?: string } = {}): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    const fd = new FormData();
    fd.append('file', file.data, file.filename);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'X-TrackForge-Channel': 'mcp',
        'X-Atlassian-Token': 'no-check',
        ...(opts.rationale ? { 'X-TrackForge-Rationale': opts.rationale } : {}),
      },
      body: fd,
    });
    const body = (await res.json().catch(() => ({}))) as {
      errorMessages?: string[];
      errors?: Record<string, string>;
    };
    if (!res.ok) throw new ToolError(res.status, body.errorMessages ?? [], body.errors ?? {});
    return body;
  }

  /** Raw binary GET — attachment content/thumbnail downloads (Sprint 018). */
  async getBinary(path: string): Promise<{ data: Buffer; contentType: string; filename: string | null }> {
    const url = new URL(`${this.baseUrl}${path}`);
    const res = await fetch(url, { headers: this.authHeaders() });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { errorMessages?: string[]; errors?: Record<string, string> };
      throw new ToolError(res.status, body.errorMessages ?? [], body.errors ?? {});
    }
    const cd = res.headers.get('content-disposition') ?? '';
    const m = cd.match(/filename="?([^";]+)"?/);
    return {
      data: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? 'application/octet-stream',
      filename: m?.[1] ?? null,
    };
  }

  async call<T = unknown>(method: string, path: string, opts: CallOptions = {}): Promise<T> {
    const inherited = callExtras.getStore();
    if (inherited) {
      opts = {
        dryRun: inherited.dryRun,
        idempotencyKey: inherited.idempotencyKey,
        rationale: inherited.rationale,
        ...opts,
      };
    }
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    }
    if (opts.dryRun) url.searchParams.set('dryRun', 'true');

    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.token}`,
        'X-TrackForge-Channel': 'mcp',
        ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
        ...(opts.rationale ? { 'X-TrackForge-Rationale': opts.rationale } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });

    if (res.status === 204) return undefined as T;
    // 202 = gated write parked as a Proposal for human review — tell the
    // agent how to track it instead of pretending the write happened.
    if (res.status === 202) {
      const p = (await res.json().catch(() => ({}))) as { proposalId?: string; status?: string };
      return {
        ...p,
        pendingApproval: true,
        note: `Write is pending human approval (proposal ${p.proposalId ?? '?'}). ` +
          'Check status with get_proposal; do not retry the same write.',
      } as T;
    }
    const body = (await res.json().catch(() => ({}))) as {
      errorMessages?: string[];
      errors?: Record<string, string>;
    };
    if (!res.ok) {
      throw new ToolError(res.status, body.errorMessages ?? [], body.errors ?? {});
    }
    return body as T;
  }
}

/** Renders a tool result as compact MCP text content. */
export function asText(data: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** Renders a ToolError (or generic error) as an actionable MCP error result. */
export function asError(err: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  if (err instanceof ToolError) {
    const lines = [`Error (${err.status})`];
    for (const m of err.errorMessages) lines.push(`- ${m}`);
    for (const [k, v] of Object.entries(err.errors)) lines.push(`- ${k}: ${v}`);
    if (err.status === 401) lines.push('Hint: check TRACKFORGE_TOKEN is valid and not revoked.');
    if (err.status === 403) lines.push("Hint: the token lacks the required scope — ask for a token with 'write'.");
    if (err.status === 404) lines.push('Hint: verify the key exists and is inside the token project allow-list.');
    if (err.status === 422) lines.push('Hint: reuse an Idempotency-Key only with an identical body; pick a fresh key for a new request.');
    return { content: [{ type: 'text', text: lines.join('\n') }], isError: true };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: `Error: ${msg}` }], isError: true };
}

export function tool(handler: (args: never) => Promise<ReturnType<typeof asText>>) {
  return async (args: never) => {
    try {
      return await handler(args);
    } catch (err) {
      return asError(err) as never;
    }
  };
}
