// Importable MCP server factory — shared by the stdio/HTTP CLI (index.ts)
// and the backend's same-origin /mcp mount (apps/backend/src/routes/mcp.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TrackForgeClient, setStaticClient, withClient } from './client.js';
import { registerTools, registerResources, registerSubscriptions } from './tools.js';

export interface CreateMcpOptions {
  /** Base URL of the TrackForge REST API the tools call. */
  trackforgeUrl: string;
  /** Force the read-only toolset (hides AND refuses write tools). */
  forceReadonly?: boolean;
  /**
   * Pre-resolved write permission. When provided, the whoami probe is skipped
   * (the same-origin mount already resolved the actor from the request).
   * When omitted, write tools register unless the token's principal lacks the
   * `write` scope, detected via GET /api/internal/auth/whoami.
   */
  canWrite?: boolean;
}

export interface McpHandle {
  server: McpServer;
  tf: TrackForgeClient;
}

interface Principal {
  scopes?: string[];
}

const INSTRUCTIONS =
  'TrackForge is a Jira-compatible issue tracker. All project/issue operations go ' +
  'through these tools — never guess field names or values: call get_create_meta first. ' +
  'Use fields= and search paging to keep responses small. Writes support dry_run preview.';

function buildServer(write: boolean, subscriptions: boolean): McpServer {
  const server = new McpServer(
    { name: 'trackforge', version: '0.1.0' },
    {
      instructions: INSTRUCTIONS,
      capabilities: { resources: { subscribe: subscriptions } },
    }
  );
  registerTools(server, { write });
  registerResources(server);
  return server;
}

export async function createMcpServer(token: string, opts: CreateMcpOptions): Promise<McpHandle> {
  const tf = new TrackForgeClient(opts.trackforgeUrl, token);
  // Single-principal process (stdio CLI): tools bind statically — the ALS
  // request binding used by the pooled HTTP path is unnecessary here.
  setStaticClient(tf);
  let write = !opts.forceReadonly;
  if (opts.canWrite !== undefined) {
    write = write && opts.canWrite;
  } else {
    try {
      const me = await tf.call<Principal>('GET', '/api/internal/auth/whoami');
      write = write && (me.scopes?.includes('write') ?? true);
    } catch {
      // whoami unreachable — register all tools; calls surface the real error.
    }
  }
  const server = buildServer(write, true);
  registerSubscriptions(server, tf);
  return { server, tf };
}

// ---------- 070 — pooled stateless HTTP servers ----------
// Every POST used to pay a full createMcpServer(): ~140 tool registrations
// and their zod schemas rebuilt per request, plus a fresh transport. Servers
// are principal-agnostic (the client binds per request via withClient), so
// connected {server, transport} pairs pool cleanly per toolset variant.
//
// No resources/subscribe on pooled servers: stateless mode has no session to
// deliver notifications on anyway, and a lingering per-server subscription
// set would leak one principal's event stream to the next request's
// principal.
interface PooledEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

const POOL_MAX = Math.max(1, Number(process.env.MCP_SERVER_POOL ?? 32));
const pools: Record<'full' | 'ro', PooledEntry[]> = { full: [], ro: [] };

async function buildPooledEntry(write: boolean): Promise<PooledEntry> {
  const server = buildServer(write, false);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);
  return { server, transport };
}

/** Test/metrics hook. */
export function mcpPoolSize(): { full: number; ro: number } {
  return { full: pools.full.length, ro: pools.ro.length };
}

export async function handleMcpHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  token: string,
  opts: CreateMcpOptions,
  /** Pass when upstream middleware already consumed the body (e.g. express.json()). */
  parsedBody?: unknown
): Promise<void> {
  const tf = new TrackForgeClient(opts.trackforgeUrl, token);
  let write = !opts.forceReadonly;
  if (opts.canWrite !== undefined) {
    write = write && opts.canWrite;
  } else if (write) {
    try {
      const me = await tf.call<Principal>('GET', '/api/internal/auth/whoami');
      write = me.scopes?.includes('write') ?? true;
    } catch {
      // whoami unreachable — serve the full toolset; calls surface the real error.
    }
  }
  const variant = write ? 'full' : 'ro';
  const entry = pools[variant].pop() ?? (await buildPooledEntry(write));
  let reuse = true;
  try {
    await withClient(tf, () => entry.transport.handleRequest(req, res, parsedBody));
  } catch (e) {
    // A mid-flight failure can leave per-request state on the transport —
    // retire the pair rather than risk cross-request bleed.
    reuse = false;
    throw e;
  } finally {
    if (reuse && pools[variant].length < POOL_MAX) pools[variant].push(entry);
    else await entry.server.close().catch(() => undefined);
  }
}

export function redactSecrets(msg: string): string {
  return msg.replace(/Bearer\s+\S+/gi, 'Bearer ***').replace(/tfp_[a-f0-9]+/gi, 'tfp_***');
}
