import express, { Request, Response, NextFunction, Application } from 'express';
import compression from 'compression';
import { existsSync } from 'node:fs';
import { buildMeta } from './lib/buildInfo.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adfWire } from './lib/adfWire.js';
import { roadmapRouter } from './routes/roadmap.js';
import cors from 'cors';
import projectRoutes from './routes/projects.js';
import issueRoutes from './routes/issues.js';
import { issueOpsRouter } from './routes/issueOps.js';
import { bulkRouter, exportRouter } from './routes/bulk.js';
import { registerBulkHandlers } from './services/bulkService.js';
import searchRoutes from './routes/search.js';
import metaRoutes from './routes/meta.js';
import jqlRoutes, { jqlInternalRouter } from './routes/jql.js';
import { automationRouter } from './routes/automation.js';
import filterRoutes from './routes/filters.js';
import boardRoutes, { boardInternalRouter } from './routes/boards.js';
import workflowRoutes from './routes/workflows.js';
import { sprintRouter, backlogRouter } from './routes/sprints.js';
import authRoutes from './routes/auth.js';
import { docsRouter } from './routes/docs.js';
import { oauthRouter, oauthAdminRouter, oauthMeRouter } from './routes/oauth.js';
import { mcpRouter } from './routes/mcp.js';
import { scimRouter, directoryAdminRouter } from './routes/scim.js';
import { userRouter, internalRouter } from './routes/users.js';
import { eventsRouter } from './routes/events.js';
import { webhookRouter, webhookInternalRouter } from './routes/webhooks.js';
import { meRouter } from './routes/me.js';
import { adminIdpRouter, identityAuthRouter } from './routes/identity.js';
import { devReceiverRouter, devAdminRouter, devIssueRouter, devGitlabRouter, devinfoRouter } from './routes/dev.js';
import { agentRouter } from './routes/agentSessions.js';
import { projectExtrasRouter } from './routes/projectExtras.js';
import { aiRouter } from './routes/ai.js';
import { searchInternalRouter } from './routes/search.js'; // 068 — /search/aggregate
import { proposalsRouter } from './routes/proposals.js';
import { reportsRouter } from './routes/reports.js';
import {
  notificationSchemeRouter,
  mailAdminRouter,
  projectSchemeRouter,
  meNotifyRouter,
  filterSubRouter,
  unsubRouter,
} from './routes/mail.js';
import { customFieldsRouter } from './routes/customfields.js';
import { permissionRouter, projectPermissionRouter } from './routes/permissions.js';
import { healthz, readyz, metrics, adminJobsRouter, metricsMiddleware } from './routes/ops.js';
import { ah } from './lib/http.js';
import { requestLogger } from './lib/logger.js';
import { ZodError } from 'zod/v3';
import { Prisma } from '@prisma/client';
import { formatZodErrors } from './lib/validation.js';
import { JiraApiError, jiraError } from './lib/errors.js';
import { requireAuth, rateLimit, authRateLimit, ipRateLimit } from './middleware/auth.js';
import { proposalGate } from './middleware/proposals.js';
import { idempotency } from './middleware/idempotency.js';
import { publicBaseUrl, validateEnv } from './config.js';
import { ensureBootstrap } from './services/userService.js';
import { jobRunner } from './lib/jobs.js';
import { registerJobs } from './services/dispatchService.js';
import { initSseFanout } from './services/sseHub.js';
import { registerImportHandlers } from './import/service.js';
import { migrationRouter } from './routes/migration.js';
import { issueSecurityJiraRouter, issueSecurityAdminRouter, projectSecurityRouter } from './routes/issueSecurity.js';
import {
  screensJiraRouter,
  screensAdminRouter,
  projectScreensRouter,
  fieldConfigJiraRouter,
} from './routes/screens.js';
import { componentRouter, versionRouter, projectReleaseRouter } from './routes/releaseMgmt.js';
import { worklogRouter } from './routes/worklogs.js';
import { systemRouter } from './routes/system.js';
import { metadataRouter } from './routes/metadata.js';
import { dashboardRouter, dashboardDataRouter } from './routes/dashboards.js';
import { attachmentsRouter, attachmentRouter } from './routes/attachments.js';
import { registerAttachmentJobs } from './services/attachmentService.js';

// 064 US6 — fail closed when NODE_ENV is unset: a bare `node dist/main.js`
// deploy must not silently boot on dev-secret semantics. Dev runs through tsx
// (src/main.ts) and defaults to development; everything else is production.
if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = /src[\\/]main\.(ts|mts|js)$/.test(process.argv[1] ?? '') ? 'development' : 'production';
}

const app: Application = express();
// 064 US6 — opt-in TRUST_PROXY: without it req.ip is the LB's address (rate
// buckets collapse, audit logs record proxy IPs). Accepts 'true', a hop
// count, or a comma-separated subnet list.
const trustProxy = process.env.TRUST_PROXY;
if (trustProxy) {
  app.set(
    'trust proxy',
    trustProxy === 'true'
      ? true
      : /^\d+$/.test(trustProxy)
        ? Number(trustProxy)
        : trustProxy.split(',').map((s) => s.trim())
  );
}
const PORT = Number(process.env.PORT ?? 3000);

const corsOrigins = (process.env.CORS_ORIGINS ?? 'http://localhost:5173').split(',').map((o) => o.trim());
app.use(cors({ origin: corsOrigins, credentials: true }));
// 064 US6 — baseline security headers on every response (the OAuth HTML pages
// were clickjackable without these; JSON APIs get them for free).
// 065 audit E4 — + CSP and HSTS. CSP is one policy for the SPA and the OAuth
// HTML pages (both self-contained; inline styles allowed for <style> blocks
// and React style attributes). HSTS only on TLS-terminated requests so plain
// HTTP deployments don't pin themselves into an unreachable scheme.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; " +
      "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
  );
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});
app.use(metricsMiddleware);
app.use(requestLogger()); // 016 structured request logs (secret-free by construction)
app.use(express.json());
// gzip/br the JSON API — Jira-shaped payloads are verbose. The SSE stream is
// excluded: compression buffers writes, which would stall live event delivery.
app.use(
  compression({
    filter: (req, res) => req.path !== '/api/internal/events/stream' && compression.filter(req, res),
  })
);

// 065 audit E1 — last line of defense: a missed async throw becomes an
// unhandled rejection which stops Node by default. Log it loud and keep the
// process alive; ah() coverage makes this a fallback, not the primary path.
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});

// Unauthenticated surface — /healthz|/readyz stay unlimited (K8s probes must
// never 429); /metrics gets a coarse per-IP cap (065 E2: scrapers poll, but
// anyone could previously hammer it).
app.get('/healthz', healthz); // 016 probes — direct routes so they enumerate cleanly
app.get('/readyz', ah(readyz));
app.get('/metrics', ipRateLimit(Number(process.env.METRICS_RATE_LIMIT ?? 120)), ah(metrics));
// Strict per-IP limit on the unauthenticated auth surface — brute force,
// TOTP guessing and reset spam all funnel through here.
app.use('/api/internal/auth', authRateLimit);
app.use('/api/internal/auth', authRoutes);
app.use('/api/internal/auth', identityAuthRouter); // 036 — reset + OIDC
app.use('/api/internal/admin/idps', adminIdpRouter); // 036
// 038 — {repoId}/{provider} webhook receiver: unauthenticated by design (the
// HMAC is the credential) but IP-limited; the provider param is constrained so
// admin paths under /api/internal/dev reach the authenticated routers below.
app.use('/api/internal/dev', ipRateLimit(Number(process.env.DEV_WEBHOOK_RATE_LIMIT ?? 600)), devReceiverRouter);
app.use('/unsubscribe', unsubRouter); // 029 — token is the credential; no login
app.use('/api/internal/docs', docsRouter); // 050 — optional auth, audience-filtered
// 063 US3 — agent self-onboarding index (Linear-style llms.txt): tells AI
// clients how to reach the MCP server and where the agent docs live.
app.get('/llms.txt', (_req, res) => {
  const base = publicBaseUrl();
  res.type('text/plain; charset=utf-8').send(`# TrackForge

Self-hosted issue tracker where AI agents are first-class users:
they authenticate with PATs and drive the same REST API humans use,
plus a first-party MCP server. The API implements the Jira v2 REST
contract. All writes support dryRun and Idempotency-Key; JQL-compatible
queries support functions like ready().

## Connect (MCP)
- Remote endpoint: ${base}/mcp — Streamable HTTP on the primary port.
  OAuth-capable clients (Claude, VS Code, Cursor) sign in via OAuth 2.1 +
  PKCE — no token to paste; discovery document:
  ${base}/.well-known/oauth-protected-resource/mcp
- Token clients: Authorization: Bearer <tfp_* PAT> per request; append
  ?toolset=readonly for a read-only toolset (write tools hidden AND refused
  at call time). /mcp/readonly is the pinned read-only alias.
- stdio (repo checkout): TRACKFORGE_URL=${base} TRACKFORGE_TOKEN=<tfp_* PAT>
  pnpm --filter trackforge-mcp dev

## Connect (REST)
- Base: ${base}/rest/api/2  (Jira v2 shapes) and ${base}/rest/agile/1.0
- Auth: Authorization: Bearer <tfp_* PAT> — create via POST /api/internal/tokens

## Docs for agents
- GET ${base}/rest/api/2/openapi.json — machine-readable API contract
- GET ${base}/rest/api/2/serverInfo — version + deployment info
- GET ${base}/api/internal/jql/functions — JQL function registry
- repo: docs/mcp.md (MCP setup), docs/agents.md (sessions, questions, approval
  policies), docs/compatibility.md (Jira parity matrix)

## Errors
{errorMessages: string[], errors: {field: msg}} — field errors list allowed
values so agents can self-correct.
`);
});
app.use('/', oauthRouter); // 049 — /.well-known/* + /oauth/* (rate-limited internally)
// Same-origin MCP — one URL ({base}/mcp) for OAuth-capable clients (Claude,
// VS Code, Cursor) and Bearer-PAT setups alike. Bearer-only: session cookies
// are deliberately not honored here. MCP_INTERNAL_URL overrides the loopback
// base the tools call (tests pin it to the ephemeral port).
app.use(
  '/mcp',
  // 070 — a whole agent fleet typically shares one egress IP; 600/min meant
  // ~10 tool calls/sec for the entire org before 429s. Per-principal limits
  // still apply on the loopback REST calls the tools make.
  ipRateLimit(Number(process.env.MCP_RATE_LIMIT ?? 6000)),
  mcpRouter({
    trackforgeUrl: () => process.env.MCP_INTERNAL_URL ?? `http://127.0.0.1:${PORT}`,
  })
);
app.use('/scim/v2', scimRouter); // 049 — per-connection bearer auth, not session
for (const v of ['2', '3'])
  app.get(`/rest/api/${v}/serverInfo`, (_req, res) => {
    const meta = buildMeta();
    res.json({
      baseUrl: publicBaseUrl(),
      version: meta.version,
      deploymentType: 'Server',
      buildNumber: meta.buildNumber,
      buildDate: meta.buildDate,
      serverTitle: 'TrackForge',
      serverTime: new Date().toISOString(),
      scmInfo: meta.scm,
    });
  });

// Everything under /rest and /api/internal requires auth + is rate limited;
// writes carrying an Idempotency-Key are replay-safe. The proposal gate parks
// writes from requireApproval principals as reviewable Proposals (202).
// 065 audit E2 — coarse per-IP ceiling BEFORE auth: invalid/expired tokens
// got unlimited 401s previously, each costing a DB lookup. High enough that
// NAT'd users stay under it; per-principal limiting still applies post-auth.
// 070 — raised for shared-egress agent fleets (1,000 agents behind one NAT
// gateway need headroom; PAT lookups are cached so bad tokens stay cheap).
app.use(['/rest', '/api/internal'], ipRateLimit(Number(process.env.PRE_AUTH_RATE_LIMIT ?? 5000)));
app.use(['/rest', '/api/internal'], requireAuth, rateLimit, idempotency);
app.use(['/rest', '/api/internal'], proposalGate);

// 065 audit D5 — dev admin + issue routers mount under the global chain: rate
// limit, idempotency and the proposal gate now apply (branch/MR creation from
// an approval-gated token parks instead of executing). Their own
// requireAuth/requireAdmin stays as defence in depth.
app.use('/api/internal/dev/gitlab/connections', devGitlabRouter); // 051
app.use('/api/internal/dev/repositories', devAdminRouter); // 038
app.use('/api/internal/issues', devIssueRouter); // 038 — /{key}/development + gitlab branch/MR

// 040: one router stack serves both REST versions — v3 adds the ADF wire
// transform (ADF<->markdown at the boundary, FR-002 "one service layer").
const jiraApi = express.Router();
jiraApi.use('/', permissionRouter); // /group, /role, /permissionscheme, /mypermissions
jiraApi.use('/project', projectPermissionRouter); // /project/{k}/role*, /project/{k}/permissionscheme
jiraApi.use('/project', projectRoutes);
jiraApi.use('/project', projectReleaseRouter); // /{k}/components|versions (019)
jiraApi.use('/issue', issueRoutes);
jiraApi.use('/issue', attachmentsRouter); // /{k}/attachments (018)
jiraApi.use('/attachment', attachmentRouter); // 018
jiraApi.use('/component', componentRouter); // 019
jiraApi.use('/version', versionRouter); // 019
jiraApi.use('/worklog', worklogRouter); // 024 incremental sync
jiraApi.use('/issuesecurityschemes', issueSecurityJiraRouter); // 031 US4
jiraApi.use('/screens', screensJiraRouter); // 031 US1
jiraApi.use('/fieldconfigurations', fieldConfigJiraRouter); // 031 US2
jiraApi.use('/search', searchRoutes);
jiraApi.use('/jql', jqlRoutes);
jiraApi.use('/filter', filterRoutes);
jiraApi.use('/dashboard', dashboardRouter); // 026
jiraApi.use('/user', userRouter);
jiraApi.use('/', metaRoutes);
app.use('/rest/api/2', jiraApi);
app.use('/rest/api/3', adfWire, jiraApi); // 040 — same semantics, ADF bodies
app.use('/api/internal/boards', boardInternalRouter); // 033 — before agile mount order irrelevant
app.use('/rest/agile/1.0/board', boardRoutes);
app.use('/rest/agile/1.0', sprintRouter);
app.use('/rest/agile/1.0/backlog', backlogRouter);
app.use('/rest/webhooks/1.0', webhookRouter);
app.use('/rest/devinfo/0.10', devinfoRouter); // 051 — devinfo-compat, PAT+write via /rest
app.use('/api/internal', eventsRouter);
app.use('/api/internal/me', meRouter);
app.use('/api/internal/me', meNotifyRouter); // 029 — /preferences
app.use('/api/internal', webhookInternalRouter);
app.use('/api/internal/roadmap', roadmapRouter); // 041 — before internalRouter
app.use('/api/internal', internalRouter);
app.use('/api/internal/ai', aiRouter);
app.use('/api/internal/search', searchInternalRouter); // 068 — aggregate
app.use('/api/internal/proposals', proposalsRouter);
app.use('/api/internal/reports', reportsRouter);
app.use('/api/internal/customfields', customFieldsRouter);
app.use('/api/internal/jql', jqlInternalRouter); // 032 function registry
app.use('/api/internal/automation', automationRouter); // 034
app.use('/api/internal/issues', issueOpsRouter); // /{key}/clone|move (022) — before migrationRouter's blanket requireAdmin
app.use('/api/internal', agentRouter); // 047 — /issues/{k}/sessions + /agent-sessions + /agent-questions
app.use('/api/internal', projectExtrasRouter); // 058 — /projects/{k}/summary
app.use('/api/internal/admin/oauth', oauthAdminRouter); // 049 — client CRUD
app.use('/api/internal/admin', directoryAdminRouter); // 049 — /directory* (SCIM+LDAP)
app.use('/api/internal/me', oauthMeRouter); // 049 — /grants
app.use('/api/internal/bulk', bulkRouter); // 023 — before migrationRouter's blanket requireAdmin
app.use('/api/internal/export', exportRouter); // 023
app.use('/api/internal', dashboardDataRouter); // 026 — before migrationRouter's blanket requireAdmin
app.use('/api/internal/notificationschemes', notificationSchemeRouter); // 029 admin
app.use('/api/internal/projects', projectSchemeRouter); // 029 — before /project catch-alls
app.use('/api/internal/issuesecurityschemes', issueSecurityAdminRouter); // 031 admin
app.use('/api/internal/projects', projectSecurityRouter); // 031 — /{key}/issuesecurityscheme
app.use('/api/internal', screensAdminRouter); // 031 — /screens|/screenschemes|/issuetypescreenschemes
app.use('/api/internal/projects', projectScreensRouter); // 031 — /{key}/issuetypescreenscheme
app.use('/api/internal/filters', filterSubRouter); // 029 subscriptions — before internalRouter
app.use('/api/internal/admin', mailAdminRouter); // 029 mail config/test/outbox
app.use('/api/internal', migrationRouter); // /migration* (017)
app.use('/api/internal', systemRouter); // /system* + /projectcategories (024/021)
app.use('/api/internal/metadata', metadataRouter); // 021 admin metadata CRUD
app.use('/api/internal/admin', adminJobsRouter); // /jobs* (016)
app.use('/api/internal', workflowRoutes);

// 043 US3: single-origin runtime — serve the built SPA at / when a frontend
// dist exists (prod image; FRONTEND_DIST overrides). API mounts above win.
const frontendDist = process.env.FRONTEND_DIST ?? fileURLToPath(new URL('../../frontend/dist', import.meta.url));
if (existsSync(frontendDist)) {
  app.use(
    express.static(frontendDist, {
      index: 'index.html',
      setHeaders: (res, filePath) => {
        // Vite emits content-hashed files under assets/ — cache them
        // immutably. index.html and friends revalidate every load so a new
        // deploy is picked up immediately.
        res.setHeader(
          'Cache-Control',
          /[/\\]assets[/\\]/.test(filePath) ? 'public, max-age=31536000, immutable' : 'no-cache'
        );
      },
    })
  );
  // Express 5 / path-to-regexp v8: '*' is no longer valid — app.use + the
  // method guard below keeps the SPA fallback semantics identical.
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/rest') || req.path.startsWith('/api')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(join(frontendDist, 'index.html'));
  });
}

app.use(['/rest', '/api/internal'], (_req: Request, res: Response) => {
  res.status(404).json(jiraError(['Route not found']));
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof JiraApiError) {
    res.status(err.status).json(err.response);
    return;
  }
  // 065 audit E3 — client mistakes map to Jira-shaped 4xx, never a bare 500.
  if (err instanceof ZodError) {
    res.status(400).json(jiraError([], formatZodErrors(err)));
    return;
  }
  // body-parser (express.json) stamps status + type on malformed bodies and
  // oversized payloads; honor any 4xx it reports.
  const httpErr = err as { status?: number; statusCode?: number; type?: string };
  const httpStatus = httpErr.status ?? httpErr.statusCode;
  if (typeof httpStatus === 'number' && httpStatus >= 400 && httpStatus < 500) {
    const msg =
      httpErr.type === 'entity.too.large'
        ? 'Request entity too large.'
        : httpErr.type?.includes('parse')
          ? 'Malformed request body.'
          : 'Bad request.';
    res.status(httpStatus).json(jiraError([msg]));
    return;
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2025':
        res.status(404).json(jiraError(['Record not found.']));
        return;
      case 'P2002':
        res.status(409).json(jiraError(['A record with this value already exists.']));
        return;
      case 'P2003':
        res.status(400).json(jiraError(['Invalid reference.']));
        return;
      case 'P2023':
        res.status(400).json(jiraError(['Malformed identifier.']));
        return;
      default:
        break;
    }
  }
  console.error(err);
  res.status(500).json(jiraError(['Internal server error']));
});

export function startServer() {
  validateEnv(); // 043 — fail fast with a readable table, never half-configured
  // 070 — cross-replica SSE fan-out (no-ops without REDIS_URL)
  void initSseFanout().catch(() => undefined);
  registerJobs();
  registerImportHandlers();
  registerBulkHandlers();
  registerAttachmentJobs(); // 018 thumbnails
  jobRunner.start();
  const server = app.listen(PORT, async () => {
    await ensureBootstrap().catch((e) => console.error('Bootstrap failed:', e));
    console.log(`TrackForge API running on http://localhost:${PORT}`);
  });
  // 043 — graceful SIGTERM/SIGINT: stop accepting, stop jobs, drain, exit.
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      console.log(`${sig} received — draining HTTP and jobs…`);
      jobRunner.stop();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 10_000).unref();
    });
  }
  return server;
}

export default app;

if (process.env.VITEST !== 'true') {
  startServer();
}
