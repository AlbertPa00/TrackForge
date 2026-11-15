#!/usr/bin/env node
import { createServer } from 'node:http';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcpServer, handleMcpHttpRequest, redactSecrets } from './server.js';

const TRACKFORGE_URL = process.env.TRACKFORGE_URL ?? 'http://localhost:3000';
const TRACKFORGE_TOKEN = process.env.TRACKFORGE_TOKEN;
const args = process.argv.slice(2);
const HTTP_MODE = args.includes('--http');
const PORT = Number(args[args.indexOf('--port') + 1] ?? process.env.MCP_PORT ?? 3001);
// 063 US3 — read-only toolset: --readonly flag, TRACKFORGE_MCP_READONLY env,
// or ?readonly / ?toolset=readonly query in HTTP mode. Write tools are then
// absent from tools/list AND unreachable by name (the SDK refuses calls to
// unregistered tools), mirroring Linear's /mcp/readonly endpoint.
const READONLY =
  args.includes('--readonly') || /^(1|true|yes)$/i.test(process.env.TRACKFORGE_MCP_READONLY ?? '');

if (HTTP_MODE) {
  const selfUrl = process.env.MCP_PUBLIC_URL ?? `http://localhost:${PORT}`;
  // Stateless Streamable HTTP: each request may carry its own Bearer token.
  const http = createServer(async (req, res) => {
    try {
      // RFC 9728 — MCP authorization: the resource metadata document lets a
      // stock OAuth client discover TrackForge's authorization server.
      if (req.url === '/.well-known/oauth-protected-resource') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
          resource: selfUrl,
          authorization_servers: [TRACKFORGE_URL.replace(/\/+$/, '')],
          bearer_methods_supported: ['header'],
          scopes_supported: ['read', 'write'],
        }));
        return;
      }
      const auth = req.headers.authorization ?? '';
      // 064 US4 — no env-token fallback in HTTP mode: a listener without
      // per-request auth must not silently act as the daemon's PAT.
      const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (!token) {
        // RFC 9728 §5 — the WWW-Authenticate hint points clients at the metadata doc.
        res.writeHead(401, {
          'www-authenticate': `Bearer resource_metadata="${selfUrl}/.well-known/oauth-protected-resource"`,
        }).end(JSON.stringify({ error: 'Bearer token required' }));
        return;
      }
      const url = new URL(req.url ?? '/', selfUrl);
      const readonly = READONLY || url.searchParams.has('readonly') ||
        url.searchParams.get('toolset') === 'readonly';
      await handleMcpHttpRequest(req, res, token, { trackforgeUrl: TRACKFORGE_URL, forceReadonly: readonly });
    } catch (err) {
      console.error(redactSecrets(String(err)));
      if (!res.headersSent) res.writeHead(500).end();
    }
  });
  http.listen(PORT, () => {
    console.error(`trackforge-mcp HTTP listening on :${PORT} (stateless; Bearer token per request)`);
  });
} else {
  if (!TRACKFORGE_TOKEN) {
    console.error('TRACKFORGE_TOKEN is required (a tfp_* personal access token).');
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  const { server } = await createMcpServer(TRACKFORGE_TOKEN, {
    trackforgeUrl: TRACKFORGE_URL,
    forceReadonly: READONLY,
  });
  server.connect(transport).catch((e) => {
    console.error(redactSecrets(String(e)));
    process.exit(1);
  });
}
