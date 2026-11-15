# Sprint 050 — Documentation Portal & Docs-as-Product

| | |
|---|---|
| **Status** | Shipped (all local SCs). `docs/manifest.json` registers all 34 docs (slug/section/audience/helpAnchors) — SC-002 registry+dead-link CI test. `/api/internal/docs/{manifest,index,search,page/:slug,openapi.json}` before the auth gate, `optionalAuth` + server-side audience filter (admin 404s, not 403s). `/docs` portal: sidebar sections, server-rendered sanitized HTML + heading anchors + TOC, offline-capable index+excerpt search, tag-grouped API explorer rendering the *served* spec with `ext` badges → compatibility page. Route-aware `?` HelpLink in TopNav. MCP `search_docs`/`get_doc` + SC-004 eval section. `DOCS_PUBLIC=on` opens authed pages, never admin. migration.md/identity.md already backfilled (048/049 DoD). Open: per-page in-context anchors beyond the TopNav map, multi-version docs (out of scope by design). |
| **Milestone** | M2 Daily-driver parity — scheduled by need; only hard dep is CI plumbing (016) + MCP app (007) |
| **Theme** | Adoption unlock (constitution IV) + AI-native operability (VI) — docs are a product surface, humans *and* agents read them |
| **Depends on** | 007 (MCP for `search_docs`/`get_doc`), 016 (CI test infrastructure); nothing domain-level |
| **Unblocks** | Self-serve onboarding; admin self-service for 036/048/049 features; a docs story GA (046) can point at; ends "promised-but-missing docs" drift |
| **New dependencies (justify in plan)** | markdown renderer + sanitizer (`markdown-it`/`marked` + `sanitize-html`), API explorer (`@scalar/api-reference` or `swagger-ui-dist` — self-hosted, no CDN), client-side search index (`pagefind` build-time or `fuse.js`) |
| **Spec-kit folder** | `specs/050-docs-portal/` |

## Goal

TrackForge ships a **public documentation portal inside the product** — the way Atlassian serves
confluence.atlassian.com + developer.atlassian.com, but self-hosted and version-locked to the
deployment:

- A `/docs` site in the frontend: capabilities overview (public landing — "what can it do"),
  user guide, admin/ops guide, **rendered API reference** (from the served OpenAPI doc),
  migration guide, identity/security, release notes.
- **Docs-as-code**: every page is a markdown file in `docs/` registered in a **docs manifest**;
  CI fails on unregistered files, dead links, or sprint-promised docs that don't exist —
  eliminating today's drift (`docs/migration.md` and `docs/identity.md` are committed DoD
  deliverables that were never written).
- **In-app help**: "?" affordances map pages → doc anchors.
- **Agent parity** (nobody else has this): the same manifest + content exposed via MCP —
  `search_docs`, `get_doc` — so agents answer questions from the shipped docs, not from memory.

## Why now (gap analysis)

- Docs today = 14 markdown files + a served `openapi.json` with **no rendered UI and zero
  help links anywhere in the app**.
- Docs are only ever sprint-DoD checkboxes — no owner — which is exactly how
  `docs/migration.md` (017+048 DoD) and `docs/identity.md` (036+049 DoD) are already missing.
- A self-hosted product must carry its docs with it — an intranet deployment can't send users
  to a public SaaS docs site. Version-locked docs ship in the release artifact (043).

## Scope

**In**: docs manifest + registry test; `/docs` portal (public capabilities/landing, sectioned
guides, rendered API explorer, search, TOC/anchors, markdown→HTML with sanitization); in-app
help-link mapping; MCP `search_docs`/`get_doc`; backfill of `docs/migration.md` and
`docs/identity.md` skeletons with real content for shipped features; `DOCS_PUBLIC` deployment
flag gating the unauthenticated surface.

**Out**: multi-version docs (v1 = shipped-with-release only); i18n of docs → 037; a public
marketing website (the `/docs` capabilities section *is* the in-product equivalent — static
export for external hosting is v2); comments/feedback widgets; changelog automation beyond a
release-notes page fed by 043's artifacts.

## User stories

### US1 — Docs manifest & registry (P1)

As a maintainer, docs promises are enforced, not hoped for.

**Acceptance scenarios**

1. **Given** `docs/manifest.json` (entries: `slug, title, section, audience: public|authed|admin, source, ownerSprint, helpAnchors[]`), **When** CI runs, **Then** every `docs/*.md` is registered, every manifest source exists, and every sprint-DoD doc reference resolves — unregistered/missing files fail the build.
2. **Given** any markdown in `docs/`, **When** linted, **Then** relative links and `#anchors` resolve (link checker); dead links fail CI.
3. **Given** a sprint DoD naming `docs/x.md`, **When** the file or manifest entry is absent, **Then** CI fails — the "promised-but-missing" failure mode becomes impossible.

### US2 — The portal (P1)

As a user or admin, I can browse real documentation at `/docs`.

**Acceptance scenarios**

1. **Given** `/docs`, **When** rendered, **Then** a sidebar shows sections — *Overview · User guide · Admin & operations · API reference · Migration · Identity & security · Releases* — populated from the manifest; each page renders sanitized markdown with code highlighting, in-page TOC, and deep-linkable anchors.
2. **Given** the search box, **When** a query is entered, **Then** a client-side index (built from the manifest at build time) returns title+excerpt hits — works offline on an intranet.
3. **Given** `audience` levels, **When** `DOCS_PUBLIC=off`, **Then** only `public` pages serve unauthenticated (capabilities/overview + API reference per flag); `authed` needs login, `admin` needs admin. `DOCS_PUBLIC=on` also opens `authed` pages — deployment's choice, documented.

### US3 — Public capabilities landing (P1)

As a prospective/evaluating user, I can see what TrackForge does before logging in.

**Acceptance scenarios**

1. **Given** `/docs` (or `/` pre-login redirect per flag), **When** viewed unauthenticated, **Then** a capabilities overview renders: what it is, feature tour (issues, boards, JQL, sprints, releases, automation, agent API/MCP, migration paths), Jira-compat summary — sourced from [`docs/capability-matrix.md`](../capability-matrix.md), which stays the single comparison table — and links into the guides: the professional-web-app docs landing.
2. **Given** `GET /rest/api/2/serverInfo`-adjacent metadata, **When** the about/capabilities page renders, **Then** it reflects the *running* version/edition — the page can never describe features the build doesn't have (version-locked by construction).

### US4 — API reference explorer (P1)

As a developer or agent operator, I want the Atlassian-developer-site experience.

**Acceptance scenarios**

1. **Given** `/docs/api`, **When** rendered, **Then** the served `openapi.json` is browsable (endpoints grouped by tag, request/response schemas, auth schemes, try-it console optional but off by default against production).
2. **Given** `x-trackforge-extension` ops and `compatibility.md`, **When** an endpoint is viewed, **Then** extension/divergence badges render and link to the compatibility entry — the divergence contract is visible where developers look.
3. **Given** 049's OAuth endpoints when they land, **When** registered in `lib/openapi.ts`, **Then** they appear automatically — the drift test + manifest keep this true without portal code changes.

### US5 — In-app help & agent docs (P2)

1. **Given** `helpAnchors` in the manifest, **When** a "?" control on a page is clicked, **Then** it deep-links to the mapped doc anchor (e.g. board settings → board-config section); unmapped pages fall back to the section index.
2. **Given** MCP `search_docs(query)` / `get_doc(slug)`, **When** an agent calls them, **Then** they return manifest-scoped excerpts/full docs — the eval suite gains deterministic checks that key answers come from shipped docs.

## Edge cases

- Rendered markdown is XSS surface → sanitize all HTML output; no raw-HTML passthrough in docs markdown.
- `admin` docs (security model, threat model, ops internals) must never be reachable unauthenticated regardless of `DOCS_PUBLIC` — enforced by audience, tested.
- Docs paths must not collide with `/rest/*`, `/api/*`, or SPA routes — portal mounted under `/docs`, 404s inside stay in-portal.
- Images/assets in docs → served from the bundled build, not external URLs (intranet-safe).
- Very large `openapi.json` → explorer lazy-renders; load measured against the 016 perf budget.

## Functional requirements

- **FR-001**: the docs manifest is the single registry — every public page, every guide, every
  promised doc; CI enforces completeness (US1).
- **FR-002**: `audience: admin` content MUST NOT be reachable without admin auth under any
  `DOCS_PUBLIC` setting.
- **FR-003**: all rendered markdown MUST be sanitized; docs MUST ship in the release artifact
  (043 hook) so the portal matches the running version.
- **FR-004**: the API explorer MUST render the *served* `openapi.json`, not a copy — drift-
  tested docs, same guarantee as the contract itself.
- **FR-005**: no CDN dependencies — portal + explorer + search index fully self-hosted.
- **FR-006**: sprint DoDs that name a `docs/*.md` file MUST also add/refresh its manifest entry —
  added to the common DoD checklist.

## API surface

| Method | Path | Notes |
|---|---|---|
| GET | `/api/internal/docs/manifest` · `/api/internal/docs/page/:slug` | Manifest + rendered (sanitized) page bodies; audience-filtered server-side |
| GET | `/docs/*` (SPA) | The portal — public per `DOCS_PUBLIC` |
| — | `DOCS_PUBLIC` env | `off` (default) · `on` |

## Data model changes

None — docs are files + a manifest, versioned with the code.

## MCP tools

`search_docs`, `get_doc` (read-only; no admin-audience content exposed); deterministic checks
added in `apps/mcp/eval/run.ts` (e.g. "how do PAT scopes work" resolves the security-model doc).

## AI-native checklist

- [ ] Every doc an agent might need is reachable via MCP without UI (A1).
- [ ] Manifest is machine-readable — agents can enumerate documentation coverage (A3).
- [ ] Portal auth respects token scoping — scoped PATs see only their audience level (A2).

## Success criteria

- **SC-001**: `/docs` serves the full manifest; `DOCS_PUBLIC=off` unauthenticated requests see only `public` pages — `admin` pages return 401/404 even logged out.
- **SC-002**: CI fails on a seeded missing-doc/dead-link/unregistered-file — the drift test works.
- **SC-003**: `/docs/api` renders every registered endpoint incl. extension badges; no drift between served spec and explorer.
- **SC-004**: MCP eval — an agent answers 3 doc-answerable questions via `search_docs` with correct sources.
- **SC-005**: `migration.md` + `identity.md` backfilled for shipped surface; referenced from their sprint DoDs.

## Risks

| Risk | Mitigation |
|---|---|
| Docs rot after the sprint | Manifest + CI ownership (FR-001/006) — rot fails the build, not silently |
| Portal bloats the frontend bundle | Route-level lazy load; explorer chunked separately |
| XSS via rendered markdown | Sanitizer + CSP; no raw HTML; security test in suite |
| Scope creep toward a CMS | Markdown-in-repo only — editing UX is the repo, not a portal editor |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints) — plus the new FR-006 manifest entry added to that checklist.
- [ ] Threat-model entry: public surface (`DOCS_PUBLIC`), markdown XSS, admin-content leakage.
- [ ] `docs/` itself dogfoods: portal ships with populated sections — capabilities overview, user + admin guides filled to current feature surface, migration + identity backfills.
