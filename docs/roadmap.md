# TrackForge Roadmap — Sprint Plan

**Last updated**: 2026-11-07
**Owner**: TrackForge core team
**Governed by**: [`.specify/memory/constitution.md`](../.specify/memory/constitution.md) (v1.1.0 — amended in Sprint 005)
**North star**: [`DESIGN.md`](../DESIGN.md)
**References**: [`docs/data-model.md`](data-model.md) (entity → sprint map) · [`docs/design-system.md`](design-system.md) (tokens + components)

This document is the **sprint backlog** for TrackForge. Each sprint below has a definition file in
[`docs/sprints/`](sprints/). When a sprint starts, its definition file is the input to the spec-kit
cycle (`/speckit.specify` → `/speckit.plan` → `/speckit.tasks` → `/speckit.implement`), which produces
the working artifacts in `specs/NNN-<name>/`. The sprint doc defines **what and why**; the spec-kit
folder owns **how** and the task checklist.

---

## 1. Where we are (baseline, 2026-11-07)

| # | Sprint | Status | Artifacts |
|---|---|---|---|
| 001 | Core Foundation | Done | [`specs/001-core-foundation`](../specs/001-core-foundation/) |
| 002 | Jira-Style UI & Core Issue Workflow | Done (commit `1cbf1bb`) | [`specs/002-jira-style-ui`](../specs/002-jira-style-ui/) |
| 003 | Kanban Board View (virtual board, HTML5 DnD) | Done (commit `df9b755`) | [`specs/003-kanban-board`](../specs/003-kanban-board/) |
| 004 | Backlog & Sprint Management (basic Scrum loop) | Done (commit `87d97a2`) | [`specs/004-backlog-sprints`](../specs/004-backlog-sprints/) |
| 005 | Hardening & AI-Native Charter | Done (commit `6744d73`) | [`specs/005-hardening-and-ai-charter`](../specs/005-hardening-and-ai-charter/) |
| 006 | Identity, Tokens & Audit | Done | [`specs/006-identity-tokens-audit`](../specs/006-identity-tokens-audit/) |
| 007 | Agent-Ready API & MCP Server | Done | [`specs/007-agent-api-and-mcp`](../specs/007-agent-api-and-mcp/) |
| 008 | Editable Issues & Collaboration | Done | [`specs/008-editable-issues-collaboration`](../specs/008-editable-issues-collaboration/) |
| 009 | Workflow Engine & Board Configuration | Done | [`specs/009-workflow-engine-board-config`](../specs/009-workflow-engine-board-config/) |
| 010 | JQL Engine & Advanced Search | Done | [`specs/010-jql-engine-search`](../specs/010-jql-engine-search/) |
| 011 | Events, Webhooks & Real-time | Done | [`specs/011-events-webhooks-realtime`](../specs/011-events-webhooks-realtime/) |
| 012 | AI Copilot & Human-in-the-Loop | Done | [`specs/012-ai-copilot-hitl`](../specs/012-ai-copilot-hitl/) |
| 013 | Scrum Completion | Done | [`specs/013-scrum-completion`](../specs/013-scrum-completion/) |
| 014 | Custom Fields Core | Done | [`specs/014-custom-fields-core`](../specs/014-custom-fields-core/) |
| 015 | Permissions Core | Done | [`specs/015-permissions-core`](../specs/015-permissions-core/) |
| 016–020 | Platform reliability, importer v1, attachments, components/versions, MVP gate | Done | sprint docs 016–020 |
| 021 | Admin Console | Backend landed (frontend/tests pending per sprint doc) | `3a65586` |
| 022 | Issue Operations (votes, remote links, clone/move) | Done | `06a8609` |
| 023 | Bulk Operations & Export (+ navigator wizard) | Done | `e660cb5`, `26cea98` |
| 024 | Time Tracking & Worklogs | Done | `8558bd4` |
| 025 | Hardening H3 (closes M2) | Done — H2-a/H2-b closed, 500-issue load test, gate table in sprint doc | `docs/sprints/025` |
| 026–029 | Dashboards & gadgets · agile + general/time reports · email notification schemes | Done | sprint docs 026–029 |
| ~~030~~ | Hardening H4 — absorbed into 035/059/064 | — | [stub](sprints/030-hardening-h4.md) |
| 031–034 | Scheme layer (permissions/notification/issue-security) · JQL completion · boards & navigator polish · automation + agent triage | Done | sprint docs 031–034 |
| 035 | Hardening H5 | Done | sprint doc 035 |
| 036–042 | SSO/OIDC/2FA · i18n/a11y/shortcuts · git dev panel · XML/CSV importers · REST v3/ADF · roadmap timeline · UX-parity audit | Done | sprint docs 036–042 |
| 043–045 | Release engineering & distribution · production operations (backups/metrics) · deploy envs & HA | Done | sprint docs 043–045 |
| ~~046~~ | Hardening H6 / GA gate — absorbed into 063/064 + release-gates | — | [stub](sprints/046-hardening-h6-ga.md) |
| 047–052 | Agent experience polish · Jira Server/DC importer · directory integration + OAuth2 provider · docs portal · GitLab add-on · copilot trust | Done | sprint docs 047–052 |
| 053–058 | Security scope enforcement · board/backlog correctness · navigator interactions · MCP contract hardening · copilot/automation integrity · UX | Done | sprint docs 053–058 |
| 059–062 | Hardening H7 · admin console parity + QA · backlog/settings QA | Done | sprint docs 059–062 |
| 063 | Launch wedge | Done | sprint doc 063 |
| 064 | Pre-release security audit | Done — remediation appendix in `docs/pre-release-audit.md` | sprint doc 064 |
| 065 | Repo cleanup — dead code, dedup, layer repairs, docs hygiene | In progress | this sprint |

Sprints 001–004 were specified directly in spec-kit, without a sprint doc in `docs/sprints/`. Sprint
doc numbering starts at 005. **030 and 046 were reserved for hardening gates
that were absorbed into later sprints** — the stub docs map each gate item to
where it actually shipped.

**What works today**:
- **Projects and issues**: project create/list/get; issue create/get/edit (summary, description,
  priority, status).
- **Workflow and search**: any-to-any status transitions; JQL-lite search scoped to one project;
  metadata endpoints.
- **UI**: a Jira-styled shell (top nav, project sidebar, issue table, issue detail, create dialogs)
  and a Kanban board with drag-to-transition.
- **Scrum basics (004)**: backlog, sprint create/start/complete, drag issues between
  backlog and sprints, board scoped to the active sprint.
- **Identity (006)**: users (human + agent), cookie-session login, PATs with scopes and project
  allow-lists, assignee picker, per-issue changelog, admin audit log, per-principal rate limiting.
- **Agent surface (007)**: OpenAPI 3.1 + drift test, `fields`/`expand`, POST search, `/field`,
  createmeta/editmeta, `Idempotency-Key`, `dryRun`, bulk create, allowed-values errors, and a
  first-party MCP server (`apps/mcp`) — tools + resources over stdio/HTTP, scoped by the token.
- **Collaboration (008)**: inline editing of every field (one `InlineEdit` primitive, `e` shortcut),
  sanitised markdown descriptions/comments, Jira `update` ops, labels, due date, resolution,
  parent/subtask/epic hierarchy with child panels, comments with `@` mentions, activity tabs
  (All/Comments/History interleaved), issue links, issue + project deletion (two-step confirm
  token for agents), and a project settings page.
- **Workflows & boards (009)**: per-project workflows with named transitions, conditions,
  validators, post-functions and transition screens; `PUT fields.status` rejected (transitions
  only); persisted boards with column→status mapping, advisory WIP limits, LexoRank ranking;
  workflow editor + board column settings UIs; board drop resolves a valid transition.
- **Search (010)**: a real JQL engine (lexer→parser→AST→Prisma compiler) replacing JQL-lite —
  all core fields, `IN`/`IS EMPTY`/comparison/`~` operators, `AND/OR/NOT` precedence,
  relative dates + `startOfWeek()`-family functions, `currentUser()`, multi-field `ORDER BY`;
  cross-project search with token scoping; PostgreSQL FTS for `text ~`; `/jql/parse` +
  autocomplete endpoints; saved filters with favourites + `/filter/{id}/run`; advanced search
  UI (Basic⇄JQL, JQL editor with autocomplete, column chooser persisted per user), Filters
  top-nav + global-search dropdown; MCP `validate_jql`/`jql_help`/`list_filters`/`run_filter`/`save_filter`.
- **Eventing & realtime (011)**: transactional `DomainEvent` outbox beside every mutation's
  changelog; advisory-locked dispatcher fans out to webhooks (HMAC-signed, retry/backoff,
  SSRF-guarded, JQL-filtered), notifications (assignee/mention/watcher fan-out) and SSE;
  cursor-paged `/events` feed (410 on expired cursor) + `/events/stream` with Last-Event-ID
  resume; Jira watchers API + auto-watch; notification bell, "Your work" page, server-side
  recents; MCP event/webhook/notification tools + `resources/subscribe` live updates.

**What 004 explicitly leaves out**: story points, sprint dates in the UI, explicit Scrum
board types, reports. These are picked up in [Sprint 013](sprints/013-scrum-completion.md).

*The bullet list above is a sprint-011 snapshot kept as delivery history. The
items it called gaps — attachments (018), components/versions (019), worklogs
(024), custom fields (014/031), permission schemes (015/031), dashboards,
reports, mail, automation, SSO/2FA, importers, v3/ADF, dev panel, docs portal —
all shipped in the sprints tabled above. For the **current** gap list see
[`capability-matrix.md`](capability-matrix.md) §2 and the pre-flight notes
below; for current authz/scoping rules see [`SECURITY.md`](../SECURITY.md).*

---

## 2. Sprint sequence

| # | Sprint | Theme | Depends on | Size |
|---|---|---|---|---|
| 005 | [Hardening & AI-Native Charter](sprints/005-hardening-and-ai-charter.md) | Quality, honesty, principles | 004 | M |
| 006 | [Identity, Tokens & Audit](sprints/006-identity-tokens-audit.md) | Jira parity + AI foundation | 005 | L |
| 007 | [Agent-Ready API & MCP Server](sprints/007-agent-api-and-mcp.md) | AI-native | 006 | L |
| 008 | [Editable Issues & Collaboration](sprints/008-editable-issues-collaboration.md) | Jira parity | 006, 007 | L |
| 009 | [Workflow Engine & Board Configuration](sprints/009-workflow-engine-board-config.md) | Jira parity | 003, 008 | L |
| 010 | [JQL Engine & Advanced Search](sprints/010-jql-engine-search.md) | Jira parity + AI | 006, 008 | L |
| 011 | [Events, Webhooks & Real-time](sprints/011-events-webhooks-realtime.md) | AI-native + collaboration | 006, 008 | M |
| 012 | [AI Copilot & Human-in-the-Loop](sprints/012-ai-copilot-human-in-the-loop.md) | AI-native | 007, 010, 011 | L |
| 013 | [Scrum Completion](sprints/013-scrum-completion.md) | Jira parity | 004, 009, 010 | M |

Sizes are relative (S/M/L) to help with sequencing; they are not time estimates. Any sprint marked
L may be split during `/speckit.specify` if it cannot be delivered as one shippable slice.

### Post-013: milestones and waves (replanned 2026-11-07)

**Target (D18)**: Jira parity at the **data and API level** for P0 entities — so migration is
lossless (constitution IV) — with **simplified UX** where Jira's admin model is a known burden
(project-centric editors over scheme objects). **Planning rule (rolling wave)**: only the next
wave is detailed; later sprints are *epics* whose scenarios are candidates, re-validated at wave
planning using the previous milestone gate's evidence. **Cadence**: a hardening sprint after every
4 feature sprints ([hardening-cadence.md](sprints/hardening-cadence.md)); each closes a milestone
with an explicit gate.

> **Pre-flight (before 014 starts) — DoD debt from 008/009, not later-sprint work.**
> *Security first*: token project-scope on agile/link/label routes and `DELETE /project`;
> comment issue-number scoping (cross-issue comment access); `resolveAssigneeRef({})` assigning an
> arbitrary user. *Correctness*: `description: null` clearing; REST `update`-op parsing
> (`parent {key}`, `edit`, unknown fields rejected); stale-type parent revalidation; label
> `join(',')` change detection; cross-project sprint moves; `seedMetadata`/`seedWorkflows` at
> startup; reusable delete `confirmToken` (add expiry); idempotency check-then-act race;
> `updateUser` email→500; link/comment audit gaps. *Schema (cheap now, breaking later)*: 009
> FR-007 — drop `Board.projectId @unique`, add `isDefault`, replace `findUnique({projectId})` with
> the default-board lookup; 013 field-accessor rule for story points (D19). *Nav honesty*: fix
> stale "Coming in Sprint N" tooltips (Timeline → 041, Dashboards → 026, Your work → 011,
> Teams → 015).

| Milestone | # | Sprint | Level | Depends on | Size |
|---|---|---|---|---|---|
| **M1 Parity MVP** — a team can move from Jira Cloud | 014 | [Custom Fields Core](sprints/014-custom-fields-core.md) | Detailed | 008, 010, 013 | L |
| | 015 | [Permissions Core](sprints/015-permissions-core.md) | Detailed | 006, 009, 014, pre-flight | L |
| | 016 | [Platform Reliability (H1)](sprints/016-platform-reliability.md) | Detailed | 011, 014, 015 | M |
| | 017 | [Jira Cloud Importer v1](sprints/017-jira-cloud-importer.md) | Detailed | 009–016 | L |
| | 018 | [Attachments](sprints/018-attachments.md) | Detailed | 008, 015, 016, 017 | M |
| | 019 | [Components, Versions & Release Hub](sprints/019-components-versions-release-hub.md) | Detailed | 010, 011, 014, 015, 017 | M |
| | 020 | [MVP Gate (H2)](sprints/020-mvp-gate.md) | Detailed | 009–019 | M |

> **020 gate status (partial, 2026-11)**: G3–G7 met autonomously — leak test found + fixed real
> scope gaps on agile/release routes (`tests/integration/leak.test.ts`); `/rest/api/2/workflow`
> downgraded to partial in the compat audit. **Waived pending human pilot** (FR-002): G1 pilot
> sprint, G2 zero-diff import report, G8 gap-log triage — owner: pilot coordinator, target:
> wave-2 kickoff. Wave-2 work may proceed on the met gates; G1/G2/G8 close when a real Jira
> project runs a sprint in TrackForge.

| **M2 Daily-driver parity** | 021 | [Admin Console](sprints/021-admin-console.md) | Epic | 014–017 | M |
| | 022 | [Issue Operations](sprints/022-issue-operations.md) | Epic | 011, 014, 015, 017 | M |
| | 023 | [Bulk Operations & Export](sprints/023-bulk-operations-export.md) | Epic | 010, 013, 015, 016, 022 | M |
| | 024 | [Time Tracking & Worklogs](sprints/024-time-tracking-worklogs.md) | Epic | 013, 015, 017 | M |
| | 048 | [Jira Server/DC Importer](sprints/048-jira-server-dc-importer.md) | Detailed (pull-forward) | 017 + 018/019/024 importers | M |
| | 050 | [Documentation Portal & Docs-as-Product](sprints/050-docs-portal.md) | Detailed (pull-forward) | 007, 016 | M |
| | 025 | [Hardening H3](sprints/025-hardening-h3.md) | Cadence | 021–024 | M |
| **M3 Insight & communication** | 026 | [Dashboards & Gadgets](sprints/026-dashboards-gadgets.md) | Epic | 010, 011, 013, 015, 024 | M |
| | 027 | [Reports I — Agile](sprints/027-reports-agile.md) | Epic | 006, 013, 026 | M |
| | 028 | [Reports II — General, Time & Project/Org](sprints/028-reports-general-time.md) | Epic | 019, 024, 027 | M |
| | 029 | [Email & Notification Schemes](sprints/029-email-notification-schemes.md) | Epic | 011, 015, 016, 021 | M |
| | 030 | Hardening H4 ([cadence](sprints/hardening-cadence.md)) | Cadence | 026–029 | M |
| **M4 Configurability & power** | 031 | [Scheme Layer & Issue Security](sprints/031-scheme-layer.md) | Epic | 014, 015, 017, 021 | L |
| | 032 | [JQL & Search Completion](sprints/032-jql-search-completion.md) | Epic | 010, 014, 015, 019, 022, 024, 031 | M |
| | 033 | [Boards & Navigator Polish](sprints/033-boards-navigator-polish.md) | Epic | 009, 010, 014, 022, 023, 032 | M |
| | 034 | [Automation Rules & Agent Triage](sprints/034-automation-agent-triage.md) | Epic | 011, 012, 015, 016, 021, 023 | L |
| | 035 | Hardening H5 ([cadence](sprints/hardening-cadence.md)) | Cadence | 031–034 | M |
| **M5 Enterprise & reach** | 036 | [Identity: SSO, 2FA, Profiles](sprints/036-identity-sso-2fa.md) | Epic | 006, 015, 021, 029 | M |
| | 049 | [Directory Integration (SCIM/LDAP) & OAuth2 Provider](sprints/049-directory-integration-oauth2.md) | Detailed | 006, 015, 036, 029 | M |
| | 037 | [i18n, Accessibility & Shortcuts](sprints/037-i18n-accessibility-shortcuts.md) | Epic | 016, 029, 036 | M |
| | 038 | [Git Integration & Dev Panel](sprints/038-git-integration-dev-panel.md) | Epic | 011, 016, 021, 024, 034 | M |
| | 039 | [Importers II — XML, CSV, History, Export](sprints/039-importers-xml-csv-export.md) | Epic | 017, 023, 031, 036 | L |
| | 040 | [REST API v3 & ADF](sprints/040-rest-v3-adf.md) | Epic | 017, 026, 039 | M |
| | 041 | [Roadmap, Timeline & Gantt View](sprints/041-roadmap-timeline-view.md) | Epic | 014, 019, 033 | M |
| | 042 | [UX Parity Audit & Jira-Feel](sprints/042-ux-parity-jira-feel-audit.md) | Epic+ (protocol fixed) | all UI sprints | M |
| | 051 | [GitLab Integration Add-on](sprints/051-gitlab-integration-addon.md) | Detailed | 038, 021, 016 (+049 opt.) | M |
| **LW Launch wedge** | 063 | [Launch Wedge — Installable Proof](sprints/063-launch-wedge.md) | Detailed | 016, 020, 022–025, 048, 050; intersects 053 | M–L |
| **M6 Ship & Operate (GA)** | 043 | [Release Engineering & Distribution](sprints/043-release-engineering-distribution.md) | Epic | 016, 018, 021, 036 | M |
| | 044 | [Production Operations](sprints/044-production-operations.md) | Epic | 016, 043 | M |
| | 045 | [Deployment Environments & HA](sprints/045-deployment-environments-ha.md) | Epic | 043, 044 | M |
| | 046 | Hardening H6 — GA ([cadence](sprints/hardening-cadence.md)) | Cadence | 036–045 | M |
| **Post-GA** | 047 | [Agent Experience Polish](sprints/047-agent-experience-polish.md) | Epic | 012, 022, 023, 029, 034 | M |
| | 052 | [Copilot Trust & Simplicity](sprints/052-copilot-trust-simplicity.md) | Epic | 012, 047 | M |
| **Post-GA audit wave** | 053 | [Security & Scope Enforcement](sprints/053-security-scope-enforcement.md) | Detailed | 015, 031, 022, 023, 012 | M |
| | 054 | [Board & Backlog Drag Correctness](sprints/054-board-backlog-correctness.md) | Detailed | 009, 033, 019, 053 | S |
| | 055 | [Issue Detail & Navigator Interactions](sprints/055-issue-navigator-interactions.md) | Detailed | 010, 022, 033, 037, 053 | M |
| | 056 | [MCP & Contract Surface Hardening](sprints/056-mcp-contract-hardening.md) | Detailed | 007, 012, 016, 034, 048, 053 | M |
| | 057 | [Copilot, Automation & Data Integrity](sprints/057-copilot-automation-integrity.md) | Detailed | 012, 022, 034, 047, 032, 053 | M |
| | 058 | [Better-Than-Jira UX Wave](sprints/058-better-than-jira-ux.md) | Detailed | 054, 055, 057, 012, 047, 037, 042 | L |
| | 059 | Hardening H7 ([cadence](sprints/hardening-cadence.md)) | Cadence | 053–058 | M |
| | 060 | [Jira Admin-Console Parity](sprints/060-admin-console-parity.md) | Detailed | 021, 031, 029, 036, 053, 015 | L |
| | 061 | [Admin Console QA Sweep](sprints/061-admin-console-qa.md) | Detailed | 021, 060, 029, 036, 044, 049, 051 | M |
| | 062 | [Backlog & Settings QA Sweep](sprints/062-backlog-settings-qa.md) | Detailed | 033, 054, 058, 052, 060, 031 | S |
| **LW Launch gate** | 064 | [Pre-Release Security Audit](sprints/064-pre-release-security-audit.md) | Detailed | 063, 053, 036, 049, 018, 034 | L |
| | 065 | [Repo Cleanup: dedup, dead code, docs](sprints/065-repo-cleanup.md) | Detailed | 064 | L |

**Recurring obligations (every sprint from 017 on, see §4)**: ship an `EntityImporter` for each
new importable entity; complete a threat-model entry for each new attack surface; assign new MCP
tools to a toolset within the D21 budget.

### Dependency graph

```text
001 ─► 002 ─► 003 ─► 004 ─► 005 ─► 006 ─► 007 ─► 008 ─┬─► 009 ─────────► 013
                                           │          ├─► 010 ─┬────────► 013
                                           │          │        └────────► 012
                                           │          └─► 011 ──────────► 012
                                           └────────────────────────────► 012

Post-013 (milestones; ═ = milestone gate):
M1  013 ─► 014 CF core ─► 015 permissions ─► 016 H1 reliability ─► 017 Cloud importer ─┬─► 018 attachments ─┐
                                                                                       └─► 019 versions ────┴─► ═020 MVP gate═
M2  ═020═ ─► 021 admin ─► 022 issue ops ─► 023 bulk ─► 024 worklogs ─► ═025 H3═
                  └─► 048 jira-server importer (pull-forward — deps are the shipped 017+018/019/024 importers)
                  └─► 050 docs portal (pull-forward — platform-level, no domain deps)
M3  ═025═ ─► 026 dashboards ─► 027 reports I ─► 028 reports II ─► 029 email ─► ═030 H4═
M4  ═030═ ─► 031 schemes + issue security ─► 032 JQL ─► 033 boards ─► 034 automation + agent ─► ═035 H5═
M5  ═035═ ─► 036 identity ─► 037 i18n/a11y ─► 038 git ─► 039 importers II ─► 040 v3 ─► 041 roadmap ─► 042 UX audit
                    └─► 049 directory (SCIM/LDAP) + OAuth2 provider
                    └─► 051 gitlab add-on (extends 038 — devinfo-compat, backfill, outbound, native-Jira path)
LW  ═025..M5═ ─► 063 launch wedge (install+compat+agent proof; pulls 043/053 slices forward) ─► ═064 pre-release security audit (GA gate)═ ─► 065 repo cleanup (dedup/dead-code/docs)
M6  ═M5═ ─► 043 release-eng ─► 044 prod-ops ─► 045 envs/HA ─► ═046 GA═ ─► 047 agent polish (post-GA wave)
Audit wave (deep-audit findings): 053 security/scope ─► ┬─► 054 board/backlog ─┐
                                                  ├─► 055 issue/navigator ──┤
                                                  ├─► 056 MCP/contracts  ───┼─► 058 better-than-Jira UX ─► ═059 H7═
                                                  └─► 057 copilot/automation ┘
060 admin-console parity ─► 061 admin-console QA sweep (deep page-by-page QA findings)
                       └► 062 backlog & settings QA sweep (same audit method on scrum surfaces)

Every feature sprint from 017 on ──(EntityImporter)──► 017 importer grows continuously
```

Reading: an arrow means "must be done before". 013 needs 009 and 010 (and builds on 004); 012 needs
007, 010 and 011. Post-013, order *within* a milestone is a recommendation (exact edges are in the
table); order *between* milestones is a gate. The importer is no longer a final sprint: 017 lands
it in M1 and every later sprint extends it, so real Jira data tests the model continuously.

### Why this order

1. **005 first** — stop the bleeding: CI, honest navigation, integrity bugs, one design system, and a
   constitution principle that makes "AI-native" a requirement instead of an afterthought.
2. **006 before everything else** — identity, tokens and the changelog are prerequisites for
   assignment, comments, permissions, notifications, webhooks, *and* for agents acting safely and
   attributably. Building features before identity guarantees rework.
3. **007 immediately after identity** — once the MCP server and self-describing API exist, every
   later sprint ships its MCP tools as part of its Definition of Done. Doing this last would mean
   retrofitting tools onto eight sprints of features.
4. **008 → 009 → 010** — the Jira core loop: edit and discuss issues, enforce real workflows, find
   anything with real JQL.
5. **011 → 012** — events let agents react; the copilot reuses the MCP tool registry, JQL validator
   and event stream, so it comes after them.
6. **013** — 004 delivers the basic Scrum loop early. Completing it (ranking, estimates, sprint
   dates and carry-over, explicit Scrum boards, reports) needs LexoRank and persisted boards (009)
   and JQL-backed board filters (010).
7. **M1 = the smallest set that lets a real team leave Jira Cloud.** Custom fields (014) and
   permissions (015) are the P0 data the importer needs to be lossless; reliability (016) lands
   *before* the first feature needing durable jobs; the **importer moves to 017** — not last —
   so adoption starts after ~7 sprints instead of ~20 and real data tests every later sprint;
   attachments and versions are what most Jira projects can't migrate without. 020 proves it
   with a real pilot.
8. **Why 014/015 were split.** The previous drafts packed field engine + screens + field configs
   + issue-type schemes (014) and roles + schemes + issue security + route refactor (015) into
   one sprint each — two to three sprints of work, violating constitution I. The scheme layer
   and issue security move to 031, after the daily-driver work, inside a mature hardening cadence.
9. **M2 before M3** — admin self-service, issue operations, bulk ops and worklogs are what pilot
   teams hit daily; dashboards/reports (M3) need worklogs and versions as data anyway.
10. **M4 holds the high-complexity, lower-frequency work** — scheme layer + issue security (the
    largest regression surface), JQL completion, board polish, and automation with the
    **AI-native agent-triage action** (the differentiator, constitution VI).
11. **M5 is enterprise reach** — identity, i18n/a11y, git, the remaining import sources and
    export, v3/ADF, the roadmap view (least load-bearing P1) and the **UX-parity audit**
    (042 — pages must sit where a Jira user expects, not just exist).
12. **M6 ships it** — a feature-complete repo nobody can install isn't GA. Release engineering
    (043), day-2 operations (044) and delivery environments (045) turn the audited product into
    a verifiable distribution, and **GA (046) is the last gate** so "publish to production
    users" literally means a published, restorable, monitorable artifact. DevOps culture says
    deploy early — the 020 pilot covers that with the dev compose; productizing waits for the
    data model/env surface to settle (043's deps note).
13. **Hardening every 4 sprints** — 008 shipped ~13 defects behind a green suite; nineteen
    straight feature sprints would compound that. H-sprints carry the milestone gates.

### Scenario traceability (nothing from the 2026-11-07 gap review is dropped)

| Gap from review | Now owned by |
|---|---|
| Custom fields (engine, contexts, JQL) | 014 · screens/field configs/issue-type schemes → 031 |
| Permission schemes, roles, groups | 015 · issue security + comment/worklog visibility → 031 |
| Admin console (users, tokens, audit, metadata) | 021 |
| Attachments | 018 |
| Votes, flag, clone, move, remote links, reporter/environment | 022 (flag = 014 system CF) |
| Bulk operations + export | 023 · project/XML export → 039 |
| Components, versions, release hub | 019 |
| Time tracking & worklogs | 024 |
| Dashboards & gadgets | 026 |
| Reports suite (CFD, control, sprint, epic, general, time, version, timesheet, project summary, org metrics) | 027 + 028 |
| Email, notification schemes, filter subscriptions | 029 |
| JQL leftovers (`membersOf`, `updatedBy`, `linkedIssues`, `WAS`/`CHANGED`, sharing) | 032 |
| Multi-board, quick filters, card options, swimlanes, column/group-by, issue picker | schema 009 (FR-007) · UI 033 |
| Automation rules (+ agent triage) | 034 |
| Git integration / dev panel | 038 |
| SSO, 2FA, profiles, password reset | 036 |
| i18n, accessibility, **keyboard shortcuts** | 037 |
| Jira migration — Cloud | 017 · XML/CSV/history/export → 039 |
| REST v3 / ADF | 040 (converter seeded in 017) |
| Roadmap/timeline view | 041 (Start date field already in 014) |
| **UX parity / Jira-feel** (placement, naming, friction — "same platform, zero friction") | 042 audit + the Jira-feel checklist in common DoD §4 |
| **Project templates & types, project archive** (previously unowned) | 021 |
| **Job queue, observability, perf budgets, frontend tests, threat model** (previously unowned) | 016 + every H-sprint |
| **Deployment, releases, backups, monitoring, HA** (previously unowned — DESIGN §19 had no sprint) | 043 + 044 + 045, gate 046 |
| Starred issues | **Dropped** — not a Jira feature; "Watching" (011) covers it |
| **Agent experience** — delegate (not assign), agent sessions, question interrupts, autonomy slider, agent guidance, verification telemetry (agentic-UX research: Linear delegate model, LangChain ambient agents) | 047 (post-GA) |

### Later (not yet scheduled)

Items intentionally left out even after 046 — recorded so "not planned" is a decision, not an
oversight:

1. **Plugin/extension system** for custom post-functions, conditions, validators, gadget types
   (DESIGN Phase 8). Decision direction recorded: **declarative extension manifest** over the
   registries (014 field types, 032 JQL functions, 009/034 workflow + automation functions,
   026 gadgets); external compute via signed webhook callbacks — post-hoc event subscribers
   only, **never blocking validators/conditions** (sync requirement; blocking external calls
   reproduce ScriptRunner-Cloud ordering bugs); no embedded code sandbox. Dogfooding rule:
   future feature packs must be expressible as manifests. Revisit at/after 046.
2. **Cross-project boards** and **parallel sprints** — excluded by 013; revisit if multi-team
   usage demands it after 033's multi-board UI lands.
3. **Portfolio/initiative hierarchy** above epics (Jira Align territory — DESIGN excludes).
4. **Custom report builder** (user-defined report types; Phase 8) — 027/028 cover the fixed suite.
5. **Native Slack/Teams apps** and **mobile apps** — webhooks + responsive web cover the need.
6. **OpenSearch relevance-ranked `~` search** — regex/contains documented as the divergence
   until measured need (010); 016 perf budgets decide when.
7. **SAML** — OIDC (036) + LDAP/SCIM (049) cover the identity space; SAML bridges exist in every
   major IdP. *(LDAP/SCIM provisioning itself is now scheduled — sprint 049.)*
8. **Jira Service Management objects** (queues, SLAs, request types) — different product.
9. **Incoming-mail → issue creation** — Jira mail handlers; niche for internal use.
10. **GraphQL gateway** — Jira's internal UI API; our compat contract is REST+MCP.
11. **Wallboard/TV dashboard mode**, issue-navigator split view — P3 backlog, pull in if pilots ask.
12. **Test management** (Zephyr/Xray territory) — post-GA **feature-pack candidate**: test
    entities as issue types + `tests`/`testedBy` link types + `TestRun` entity + JUnit-ingest
    endpoint; traceability falls out of JQL for free (the Xray model, not Zephyr's separate
    objects). Not scheduled — reassess at the 046 gate against pilot demand.

---

## 3. AI-native principles (apply to every sprint from 005 onward)

TrackForge must be as operable by an AI agent as by a human. Concretely:

| # | Principle | Meaning | Enforced from |
|---|---|---|---|
| A1 | **One surface** | Every capability is reachable through the public API; the UI, the MCP server and the in-app copilot all call the same services. No UI-only features. | 005 |
| A2 | **Attributable** | Every write records the actor (human or agent account), the channel (`ui`, `api`, `mcp`, `copilot`) and the token used. | 006 |
| A3 | **Discoverable** | An agent can learn valid projects, fields, values and transitions from metadata endpoints before writing; no guessing. | 007 |
| A4 | **Safe to retry** | Writes accept an `Idempotency-Key`; writes support `dryRun` previews. | 007 |
| A5 | **Scoped** | Agent credentials are least-privilege: read/write/admin scopes, optional project allow-list, expiry, revocation. | 006 |
| A6 | **Reactive** | Agents can subscribe to changes (webhooks, event stream, cursor polling) instead of polling search. | 011 |
| A7 | **Reviewable** | Agent writes can require human approval (proposal → approve/reject), and every change is undoable via history. | 012 |
| A8 | **Token-efficient** | Responses support `fields`/`expand` selection; MCP tool outputs are compact and errors are actionable (list valid values). | 007 |

---

## 4. Definition of Done (common to all sprints)

A sprint is done only when **all** of the following hold. Sprint docs add sprint-specific items.

**Process**
- [ ] `specs/NNN-<name>/` contains `spec.md`, `plan.md`, `tasks.md` and `contracts/` derived from the sprint doc.
- [ ] `tasks.md` is fully ticked and matches what was actually built.
- [ ] Work is committed with messages referencing the spec directory.
- [ ] The sprint doc's **Status** is updated, and this roadmap's tables are updated.

**Quality (constitution gates)**
- [ ] Unit tests for new domain logic; integration tests for every new endpoint (happy path + primary errors).
- [ ] Playwright covers each P1 user journey of the sprint.
- [ ] `typecheck`, `lint` and all tests pass in CI (from Sprint 005 onward).
- [ ] Migrations are reversible and seed data is updated.
- [ ] UI changes are manually smoke-tested in the browser.

**Jira compatibility**
- [ ] New endpoints use Jira paths and shapes; every intentional divergence is listed in the sprint's `contracts/api.md`.

**AI-native (from the sprint where each principle is enforced)**
- [ ] Every new capability is exposed as an MCP tool with an LLM-oriented description and JSON schema (from 007).
- [ ] New MCP tools are assigned to a toolset within the D21 budget (from 016).
- [ ] Every new write path records actor + channel in the changelog (from 006).
- [ ] Every new write endpoint honours `Idempotency-Key` and `dryRun` (from 007).
- [ ] New fields/values appear in `createmeta`/`editmeta`/`/field` (from 007).
- [ ] Where a common task takes ≥3 API calls, expose a composite job tool (`close_issue`,
      `start_sprint`, `triage_issue`) within the D21 budget — job-shaped tools beat endpoint
      wrappers (Atlassian's own MCP lesson).

**Recurring obligations (added 2026-11-07 replan)**
- [ ] **Importer**: every sprint that adds an importable entity ships its `EntityImporter`
      (`discover/map/plan/apply/verify`) and the entity appears in the 017 validation report (from 017).
- [ ] **Threat model**: every sprint that adds attack surface (uploads, inbound webhooks, OIDC,
      email, rule execution, outbound calls) adds a `docs/threat-model.md` entry and closes its
      mitigations (from 016).
- [ ] **Compat verification**: every new Jira endpoint row in `compat.ts` is checked against the
      official Jira REST docs before being marked `full` (from 016).
- [ ] **Frontend**: new components get Vitest coverage (from 016); new P1 journeys get Playwright.
- [ ] **Jira-feel**: every new page/view passes the 8-dimension parity checklist from
      [sprint 042's audit protocol](sprints/042-ux-parity-jira-feel-audit.md#audit-protocol-fixed)
      (reach, structure, actions, fields, tables, interactions, feedback, density) before its
      sprint is done — 042 itself is the full-product pass.

---

## 5. Open decisions

Each must be resolved before the listed sprint's `/speckit.plan` step.

| ID | Decision | Options | Recommendation | Needed by |
|---|---|---|---|---|
| D1 | Default database | Stay on SQLite until 010 · Move to PostgreSQL now | **Move to PostgreSQL in 005.** Every later sprint adds migrations; switching providers later resets migration history. Postgres also unlocks full-text search (010) and pgvector (012). | 005 |
| D2 | CI host & git remote | GitHub Actions · GitLab CI · other | GitHub Actions, if the repo will live on GitHub. Currently there is no remote. | 005 |
| D3 | Design token set | Current Atlassian Design System tokens · legacy ADG palette | **Current ADS tokens** (already used by the top nav: `#1D2125`, `#0C66E4`). | 005 |
| D4 | UI session mechanism | JWT in httpOnly cookie · server-side sessions | JWT in httpOnly cookie (matches DESIGN.md §18.6); PATs for API/agents. | 006 |
| D5 | Native API prefix | `/api/internal/*` · `/rest/internal/*` | DESIGN.md uses both (§18.1 vs §18.5). Pick **`/api/internal/*`** and fix DESIGN.md. | 006 |
| D6 | Rich-text storage | Markdown now, ADF later · ADF now | **Markdown now**, convert to ADF when v3 lands. | 008 |
| D7 | Board identifiers | Keep project key (003) · numeric ids like Jira | **Numeric ids** when boards become persisted (009); keep the key as an alias for one release. | 009 |
| D8 | JQL parser | nearley grammar (DESIGN.md) · hand-written recursive-descent | Hand-written recursive-descent: no dependency, better error positions. | 010 |
| D9 | LLM provider & data policy | OpenAI-compatible endpoint (incl. local Ollama/vLLM) · Anthropic · both | Provider-agnostic adapter; **off by default**; local models supported for data residency. | 012 |
| D10 | CF value storage | JSONB join table (CustomFieldValue) · per-type columns · EAV | **JSONB join table** — no schema churn per field, JQL compiles to JSONB predicates + GIN/expression indexes. | 014 |
| D11 | Permission evaluation | Single permission service · per-route checks | **Single service** (`permissionService`) + architecture test banning ad-hoc checks — the 008 scope-bypass pattern must not recur. | 015 |
| D12 | Attachment storage | Local FS now · S3/MinIO now | **Storage port** (`AttachmentStore`) with `fs` adapter now, S3 adapter when needed — DESIGN §19 names MinIO for production. | 018 |
| D13 | ~~Job/queue runner~~ | superseded by D20 | was "in-process now, BullMQ later" — abandoned (compounded deferral) | — |
| D14 | Charting | Custom SVG primitives · chart library | **Custom SVG kit** (`components/charts/*`) shared by dashboards and reports — consistent with 013's no-chart-lib decision; revisit only if interactivity demands it. | 026 |
| D15 | Migration identity mapping | Jira-id→TF-id map retained · ephemeral import | **Retained `ExternalIdMap`** — provenance for agents, enables resume/idempotent re-import. | 017 |
| D16 | ADF ↔ markdown fidelity | Bidirectional converter, lossy unsupported nodes · store ADF | **Convert, never store ADF** (D6 stands); one converter module seeded in 017, completed in 040. | 040 |
| D17 | Roadmap timeline lib | Custom SVG grid · Gantt library | **Custom grid** — no dep until a measured need (same discipline as D14). | 041 |
| D18 | Parity target | Full Jira-API + admin-UX parity · data/API parity + simpler UX | **Data & API parity, simplified UX** (recommendation; user can override). Jira objects (schemes, roles, filters, gadgets) exist and are importable losslessly (constitution IV); the UI manages them project-centrically, with full scheme editors available but never required. | 014 |
| D19 | System field vs custom field | All system fields as columns · all as CFs | **Rule**: entities Jira models as system fields → columns/joins; entities Jira models as CFs (Story Points, Sprint/flags, Epic Link, Flagged, Start date, Sprint) → **system-managed CFs** via the 014 registry, storage adapter free to use an existing column (story points stays a column — no migration). | 014 |
| D20 | Queue & scheduler | In-process runner · Redis+BullMQ | **Redis+BullMQ behind ports in 016** (one infrastructure landing before 4 sprints that need it); in-memory adapter for tests/dev. | 016 |
| D21 | MCP tool surface | One flat list (grows ~120 tools) | **Toolsets**: `core` (≤30), `admin`, `reporting`, `integration`; token scopes select sets; tools extend existing tools over new ones where possible; per-sprint assignment is a DoD item. | 016 |
| D22 | Planning horizon | Detail all sprints upfront | **Rolling waves**: only the next wave detailed; epics carry candidate scenarios and are re-validated at each milestone gate. | — |
