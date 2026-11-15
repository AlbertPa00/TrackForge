# Sprint 040 — REST API v3 & ADF

| | |
|---|---|
| **Status** | Epic (draft) — Wave 5; scenarios are candidates, re-validate at wave planning |
| **Milestone** | M5 Enterprise & reach |
| **Theme** | Compatibility — the second API surface (Phase 6) |
| **Depends on** | 008+ (markdown bodies as the canonical store), 017 (basic ADF→markdown converter — extended here, not rewritten), 039 (import/export proves the data model), 026 (dashboard gadget API — Jira exposes it on v2 and v3) |

> **Replan note (2026-11-07):** 017 already ships an ADF→markdown converter for imports; this
> sprint makes it bidirectional and complete for the supported node set — one converter module,
> not two. Pagination note: several v3 endpoints use cursor/`nextPageToken` styles (e.g. the
> enhanced JQL search) — mirror those shapes where the v3 route differs from v2.
| **Unblocks** | Jira Cloud-native integrations that only speak v3/ADF |
| **Spec-kit folder** | `specs/040-rest-v3-adf/` |

## Goal

Jira exposes REST v3 where rich-text fields (description, comment, environment) are
**Atlassian Document Format** JSON, not strings. Integrations written for Cloud v3 can't
talk to v2-only TrackForge today. This sprint adds:

- the `/rest/api/3/` surface for the documented v2-equivalent endpoints,
- a **bidirectional ADF ↔ Markdown** converter (canonical store stays markdown — D6
  stands; ADF is a wire format),
- `renderedFields` expansion (server-rendered HTML/markdown per Jira),
- content-negotiation notes + divergence documentation.

## Why now (and not earlier)

v3 is mechanical once the v2 surface and the body format are stable. Doing it before
migration settled the data model would double the compat work — now it wraps proven shapes.

## Scope

**In**: `/rest/api/3/` mirrors of: `issue` (GET/POST/PUT incl. createmeta/editmeta),
`comment` CRUD, `search`, `myself`, `project`, `user` search/assignable, `field`,
`priority`, `issuetype`, `status`, `resolution`, `issueLink*`, `filter`, `dashboard` (026
subset), `attachment`, `worklog`, `watchers`, `votes`; ADF conversion for description,
comment bodies, environment; `expand=renderedFields`; ADF↔markdown coverage for the
common node set (paragraph, text+marks, headings, lists, code blocks, blockquote, rule,
hardBreak, link, mention, table, media→link fallback); `bulk/fetch` and `bulk/create` if
trivial; OpenAPI doc for v3 paths (drift-tested).

**Out**: ADF extensions/embedded objects Jira adds (panels, layouts, expand, status lozenges,
media groups — lossy conversion documented), v3's new `bulk` app-work endpoints,
ADF *authoring* widgets in the UI (UI keeps markdown — documented divergence, D6 stands).

---

## User stories

### US1 — ADF conversion (P1)

As an integrator, I want Jira-shaped document bodies.

**Independent test**: `GET /rest/api/3/issue/TF-1` returns `fields.description` as ADF;
`POST` with ADF stores markdown losslessly where representable and renders correctly in UI;
round-trip markdown→ADF→markdown ≈ identical for the supported node set.

**Acceptance scenarios**

1. **Given** markdown stored, **When** v3 GET runs, **Then** description/comments/environment emit valid ADF (validator-tested against the ADF schema).
2. **Given** ADF posted, **When** converted, **Then** supported nodes map to markdown; unsupported nodes degrade per documented rules (panel→blockquote, status→`[text]`, media→link) with a `x-trackforge-adf-losses` response note in dev mode.
3. **Given** `expand=renderedFields`, **When** requested, **Then** bodies also return rendered HTML (DOMPurify-sanitized output, same as UI — 008).

### US2 — v3 routes (P1)

**Acceptance scenarios**

1. **Given** every endpoint in the scope list, **When** called under `/rest/api/3/`, **Then** behavior matches v2 semantically with v3 response shapes (ADF bodies, `accountId` ids, v3 pagination objects).
2. **Given** the drift test, **When** run, **Then** documented v3 routes match OpenAPI 3.1 doc additions.
3. **Given** v3 + v2 called on the same resource, **When** compared, **Then** same data — bodies differ only by format (ADF vs markdown string).

### US3 — Compat proof (P2)

**Acceptance scenarios**

1. **Given** a small script written against Jira Cloud v3 docs (create→comment→search→transition), **When** pointed at TrackForge, **Then** it works unmodified (the compat promise, exercised).

---

## Edge cases

- ADF with marks/nodes we can't represent → documented lossy mapping, never a 500.
- Media nodes reference attachments — v1 emits `url` links to `/attachment/content/{id}`.
- Mentions in ADF (`attrs.id` = accountId) round-trip to `[~accountId:]` markers (008 format).
- Empty/whitespace bodies → minimal valid ADF (`{type:'doc',content:[{type:'paragraph'}]}`).
- v3-only fields (`created.date`, `properties`) — documented subset.

## Functional requirements

- **FR-001**: Canonical storage MUST stay markdown (D6) — ADF is wire conversion, never stored.
- **FR-002**: Every v3 route MUST have a v2 twin with identical semantics — one service layer, two serializers (decorator pattern §21.11).
- **FR-003**: ADF output MUST validate against the ADF schema (fixture-tested).
- **FR-004**: Lossy conversions MUST be documented per node type in `docs/adf.md`.

## API surface

| Method | Path | Notes |
|---|---|---|
| mirrors | `/rest/api/3/issue` · `/comment` · `/search` · `/project` · `/myself` · `/user/*` · `/field` · `/priority` · `/issuetype` · `/status` · `/resolution` · `/issueLink*` · `/filter` · `/dashboard` · `/attachment` · `/worklog` · `/watchers` · `/votes` | v2-equivalent semantics |
| `expand` | `renderedFields` | Server-rendered bodies |

## Data model changes

- None — serializer-only sprint (the cleanest possible compat layer).

## MCP tools added

None needed — tools speak internally; document that MCP returns markdown while v3 speaks
ADF. (`jql_help` gains a note on ADF mention markers.)

## AI-native checklist

- [ ] Agents can choose markdown (v2/MCP) or ADF (v3) — same truth, no format lock (A1).
- [ ] Lossy-node warnings surface in API responses, never silently (A8).
- [ ] `renderedFields` gives agents rendered output without a markdown lib (A3).

## Success criteria

- **SC-001**: v3 CRUD round-trip works end-to-end via ADF bodies.
- **SC-002**: Conversion matrix test: every supported node maps losslessly; unsupported map per documented rules.
- **SC-003**: A stock Jira Cloud v3 client script runs unmodified.
- **SC-004**: `compat.ts` marks the v3 family with per-endpoint status.

## Risks

| Risk | Mitigation |
|---|---|
| ADF is a big spec — scope creep | Supported-node list is the contract; everything else = documented degradation |
| Dual-surface drift (v2 vs v3) | One service layer + a parity test comparing v2/v3 on identical fixtures |
| ADF validation edge cases | Schema-validation test suite + real-world ADF fixtures from Jira docs |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] `docs/adf.md` — supported nodes, lossy mappings, mention markers.
- [ ] OpenAPI includes the v3 paths; drift test covers both versions.


---

## Implementation status — Done (commit 96f9c82)

- **US1**: `markdownToAdf.ts` — full supported-node coverage incl. tables,
  mentions (`[~accountId:]` ⇄ mention nodes), marks; round-trip md→ADF→md ≈
  identical for the supported set. `adfWire.ts` — inbound every `{type:'doc'}`
  → markdown; outbound `description`/`environment`/comment `body` → ADF;
  `expand=renderedFields` → marked + sanitize-html HTML; lossy nodes →
  `x-trackforge-adf-losses` (non-production).
- **US2**: `jiraApi` Router mounted at BOTH `/rest/api/2` and `/rest/api/3` —
  literal "one service layer, two serializers". OpenAPI auto-mirrors all v2
  paths (drift-covered); serverInfo twins; compat.ts v3 row.
- **Verified**: restV3 9/9 (converter matrix, CRUD round-trip, renderedFields
  sanitization, lossy header, v2/v3 parity); 34/34 core regressions.
- **Deferred per spec**: v3 bulk/* endpoints, panels/layouts/extension nodes
  (documented lossy in docs/adf.md), UI ADF authoring widgets (D6 stands).
