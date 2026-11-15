// Same-origin MCP mount — the Streamable HTTP transport served at /mcp on the
// primary port, so "connect a client" is one URL: OAuth discovery (RFC 9728),
// DCR, and consent all resolve on this origin. Bearer-token only by design:
// session cookies must NOT authenticate here (cookie + CORS '*' would let any
// website drive MCP as the visitor). The standalone trackforge-mcp --http
// listener remains for split deployments.
import { Router, type Router as RouterType, type Request, type Response } from 'express';
import { handleMcpHttpRequest, redactSecrets } from 'trackforge-mcp';
import { resolveRequestActor } from '../middleware/auth.js';
import { publicBaseUrl } from '../config.js';
import { ah } from '../lib/http.js';

export interface McpMountOptions {
  /** Base URL the MCP tools call — typically loopback (http://127.0.0.1:PORT). */
  trackforgeUrl: () => string;
}

const escHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Browser-facing landing page for GET /mcp — humans get docs, clients get JSON-RPC. */
function landingPage(base: string): string {
  const mcpUrl = `${base}/mcp`;
  const esc = escHtml(mcpUrl);
  return `<!doctype html><html><head><title>TrackForge MCP endpoint</title><style>
body{font-family:system-ui;margin:40px auto;max-width:560px}h1{font-size:18px}
code,pre{background:#f4f5f7;border-radius:4px}code{padding:1px 4px}pre{padding:12px;overflow:auto}
.card{border:1px solid #ddd;border-radius:8px;padding:20px}p{color:#444}</style></head><body>
<div class="card"><h1>TrackForge MCP endpoint</h1>
<p>This URL is a Model Context Protocol server (Streamable HTTP). Point your
agent client at <code>${esc}</code> — it is not meant to be browsed.</p>
<p><b>Claude Code / OAuth-capable clients:</b></p>
<pre>claude mcp add --transport http trackforge ${esc}</pre>
<p>Clients that support MCP authorization complete an OAuth sign-in
automatically — no token to paste. For token-based setups, send
<code>Authorization: Bearer &lt;tfp_* PAT&gt;</code> on every request; append
<code>?toolset=readonly</code> for a read-only toolset.</p>
<p>Metadata: <code>${escHtml(`${base}/.well-known/oauth-protected-resource/mcp`)}</code></p>
</div></body></html>`;
}

const MCP_CORS_HEADERS =
  'Authorization, Content-Type, MCP-Session-Id, MCP-Protocol-Version, Last-Event-ID';

export function mcpRouter(opts: McpMountOptions): RouterType {
  const router = Router();

  // Machine surface: permissive CORS is safe because nothing here accepts
  // ambient credentials — every request must carry an explicit Bearer token.
  router.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', MCP_CORS_HEADERS);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'MCP-Session-Id');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  router.all(
    ['/', '/readonly'],
    ah(async (req: Request, res: Response) => {
      const base = publicBaseUrl();
      const forceReadonly =
        req.path === '/readonly' ||
        req.query.readonly !== undefined ||
        req.query.toolset === 'readonly';

      const auth = req.headers.authorization ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
      if (!token) {
        if (req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')) {
          res.type('html').send(landingPage(base));
          return;
        }
        // RFC 9728 §5 — the hint drives stock OAuth clients to the metadata doc.
        res
          .status(401)
          .setHeader(
            'www-authenticate',
            `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`
          )
          .json({ error: 'Bearer token required' });
        return;
      }

      const actor = await resolveRequestActor(req);
      if (!actor?.token) {
        res.status(401).json({ error: 'Invalid or expired bearer token' });
        return;
      }
      const scopes = actor.token.scopes;
      const canWrite = scopes.includes('write') || scopes.includes('admin');
      try {
        // express.json() already parsed the body — forward it or the
        // transport waits forever on a consumed stream.
        await handleMcpHttpRequest(
          req,
          res,
          token,
          {
            trackforgeUrl: opts.trackforgeUrl(),
            forceReadonly,
            canWrite,
          },
          req.body
        );
      } catch (err) {
        console.error(redactSecrets(String(err)));
        if (!res.headersSent) res.status(500).json({ error: 'MCP transport error' });
      }
    })
  );

  return router;
}
