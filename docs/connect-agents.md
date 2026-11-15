# Connect an agent or IDE

TrackForge's issues, boards, and workflows are available to AI agents over MCP
(Model Context Protocol). The endpoint is on the **same origin** as the app —
one URL is the whole setup:

```
https://<your-trackforge-host>/mcp
```

A read-only toolset lives at `/mcp/readonly` (or `?toolset=readonly`) — write
tools are hidden from `tools/list` and refused at call time.

In the UI, **Profile menu → Connect agents** (`/connect`) shows the endpoint,
per-client recipes, and PAT minting.

## OAuth clients — recommended, nothing to paste

Claude, VS Code, Cursor, and Windsurf support MCP authorization: they discover
the authorization server (`/.well-known/oauth-protected-resource/mcp`),
register themselves via dynamic registration, open your browser for sign-in +
consent, and refresh tokens automatically. Grants show up under
**Profile → Connected apps** and can be revoked there.

| Client | Setup |
|---|---|
| Claude Code | `claude mcp add --transport http trackforge https://<host>/mcp` |
| Claude (web/desktop) | Settings → Connectors → Add custom connector → paste the URL |
| VS Code | `vscode:mcp/install` deeplink from `/connect`, or `.vscode/mcp.json`: `{"servers":{"trackforge":{"type":"http","url":"https://<host>/mcp"}}}` |
| Cursor | `cursor://` install deeplink from `/connect`, or `~/.cursor/mcp.json`: `{"mcpServers":{"trackforge":{"url":"https://<host>/mcp"}}}` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json`: `{"mcpServers":{"trackforge":{"serverUrl":"https://<host>/mcp"}}}` |

## Token clients — PAT fallback

For stdio-only clients, scripts, and CI: mint a `tfp_*` personal access token
from **/connect** (name, scopes, project allow-list, optional expiry +
approval policy) and send it on every request:

```bash
Authorization: Bearer tfp_...
```

Stdio-only clients (Claude Desktop, older IDE plugins) bridge to the remote
endpoint via `mcp-remote`:

```json
{ "mcpServers": { "trackforge": {
    "command": "npx",
    "args": ["-y", "mcp-remote", "https://<host>/mcp",
             "--header", "Authorization: Bearer <tfp_...>"] } } }
```

## Operators

- The endpoint is served by the backend itself — no second process or port.
  The standalone `trackforge-mcp --http --port 3001` listener remains for
  split deployments (see `docs/mcp.md`).
- `MCP_RATE_LIMIT` (default 600/min per IP) gates the unauthenticated surface;
  per-principal limits apply after the token resolves.
- Auth is bearer-token only — session cookies are deliberately ignored on
  `/mcp`, so no ambient browser credential can drive it.
- `PUBLIC_BASE_URL` should be the external URL in production: OAuth issuers,
  resource metadata, and the consent redirect all derive from it.
