# Plan — Sprint 007: Agent-Ready API & MCP

## Architecture

- `IdempotencyRecord` (Prisma) + `middleware/idempotency.ts` — wraps res.json, stores status+body, replays on same key+principal+hash.
- Field registry in `metaService` drives `/field`, `fields=` selection, `names`/`schema` expand.
- `planCreate`/`planUpdate` in `issueService` — shared validation/diff for writes and dryRun previews; `resolveAssigneeRef` accepts accountId or name/email.
- `createmetaService` — Jira-shaped createmeta/editmeta from live metadata + field registry.
- `lib/openapi.ts` — OpenAPI 3.1 doc, request schemas via `zod-to-json-schema`; route-drift test walks the Express stack.
- `apps/mcp` — `@modelcontextprotocol/sdk`; `client.ts` (token + channel header + Jira-error surfacing), `tools.ts` (13 tools + 2 resources), `index.ts` (stdio/HTTP transports, scope-aware tool registration).

## New dependencies

- `zod-to-json-schema` (backend) — OpenAPI generation from existing zod schemas.
- `@modelcontextprotocol/sdk@1.32.2` (apps/mcp) — official MCP SDK, >7 days published.
