// 049 SC-004 — MCP HTTP transport completes OAuth discovery + registration
// against a stock-client flow: 401 → resource_metadata → AS metadata →
// register → token → authenticated MCP request.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import type { Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { authed } from '../request.js';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';

let appServer: Server | null = null;
let mcp: ChildProcess | null = null;
let appUrl = '';
const MCP_PORT = 3999;

beforeAll(async () => {
  appServer = app.listen(0);
  appUrl = `http://127.0.0.1:${(appServer.address() as { port: number }).port}`;
  process.env.PUBLIC_BASE_URL = appUrl; // issuer/audience for this ephemeral deployment
  const mcpDir = path.resolve(__dirname, '../../../mcp');
  const tsxCli = path.join(mcpDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  mcp = spawn(process.execPath, [tsxCli, 'src/index.ts', '--http', '--port', String(MCP_PORT)], {
    cwd: mcpDir,
    env: {
      ...process.env,
      TRACKFORGE_URL: appUrl,
      MCP_PUBLIC_URL: `http://127.0.0.1:${MCP_PORT}`,
      // no TRACKFORGE_TOKEN — Bearer must come per-request (OAuth or PAT)
    },
    stdio: 'ignore',
  });
  // Wait for the listener.
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${MCP_PORT}/.well-known/oauth-protected-resource`);
      break;
    } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
});

afterAll(() => {
  try { mcp?.kill('SIGTERM'); } catch { /* already dead */ }
  appServer?.close();
});

describe('049 SC-004 — MCP HTTP transport OAuth discovery', () => {
  it('401 carries RFC 9728 resource_metadata hint; metadata points at the AS', async () => {
    const denied = await fetch(`http://127.0.0.1:${MCP_PORT}/`, { method: 'POST', body: '{}' });
    expect(denied.status).toBe(401);
    const hint = denied.headers.get('www-authenticate') ?? '';
    expect(hint).toContain('resource_metadata=');
    const metaUrl = /resource_metadata="([^"]+)"/.exec(hint)![1];
    const meta = await (await fetch(metaUrl)).json();
    expect(meta.authorization_servers).toEqual([appUrl]);
    expect(meta.resource).toBe(`http://127.0.0.1:${MCP_PORT}`);
  });

  it('full flow: AS discovery → admin client → client_credentials token → MCP accepts it', async () => {
    // 1. AS metadata (what a stock client does with authorization_servers[0]).
    const asMeta = await (await fetch(`${appUrl}/.well-known/oauth-authorization-server`)).json();
    expect(asMeta.token_endpoint).toBeTruthy();

    // 2. Pre-registered client (priority #1) — confidential, service user.
    const svc = await prisma.user.create({
      data: { email: 'mcp-svc@test.local', displayName: 'MCP Svc', passwordHash: '!external', type: 'service' },
    });
    const client = await authed(app).post('/api/internal/admin/oauth/clients').send({
      name: 'mcp-client', grantTypes: ['client_credentials'], allowedScopes: ['read'],
      confidential: true, serviceUserId: svc.id,
    }).expect(201);

    // 3. Token (Basic client auth, as a stock client does).
    const tok = await (await fetch(asMeta.token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${client.body.clientId}:${client.body.clientSecret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
    })).json();
    expect(tok.access_token).toBeTruthy();

    // 4. MCP transport accepts the OAuth JWT — initialize handshake passes auth.
    const init = await fetch(`http://127.0.0.1:${MCP_PORT}/`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${tok.access_token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'stock', version: '1.0' } },
      }),
    });
    // Not a 401 — the transport accepted the delegated token (streamable
    // transport may still answer 200/4xx for protocol specifics).
    expect(init.status).not.toBe(401);
  });
});
