# Capability matrix — TrackForge vs Jira (latest)

Comparison against Atlassian's public documentation for **Jira Cloud (latest)** and
**Jira Data Center 10.x** (final self-hosted baseline — DC itself is EOL March 2029).
Sources: support.atlassian.com, confluence.atlassian.com (release notes/upgrade matrix),
atlassian.com/migration comparison pages. Reviewed 2026-11-07.

Status legend: **shipped** = in the codebase today · **planned** = owned by a sprint ·
**gap** = not planned, decision needed · **excluded** = deliberately out of scope.

## 1. Core Jira Software surface — effectively complete coverage

| Capability | Jira latest | TrackForge | Sprint |
|---|---|---|---|
| Issues, comments, history, mentions | ✓ | shipped | 008, 011 |
| Workflow engine, transitions, conditions/validators/post-functions | ✓ | shipped (engine); scheme layer planned | 009, 031 |
| Boards, backlog, sprints, epics, ranking, WIP limits | ✓ | shipped (core); polish planned | 004, 013, 033 |
| JQL — grammar, functions, `WAS`/`CHANGED`/`membersOf`, sharing | ✓ | shipped (engine); completion planned | 010, 032 |
| Custom fields (12 types) + field configs | ✓ | shipped | 014, 031 |
| Permissions, roles, groups, global perms | ✓ | shipped; schemes planned | 015, 031 |
| Attachments (upload, thumbnails, limits) | ✓ | shipped | 018 |
| Components, versions, release hub, release notes | ✓ | shipped | 019 |
| Votes, watchers, remote links, clone, move, reporter/environment | ✓ | shipped | 011, 022 |
| Bulk operations, CSV/JSON export | ✓ | shipped | 023 |
| Time tracking & worklogs | ✓ | shipped (API + importer) | 024 |
| Dashboards & gadgets | ✓ | shipped | 026 |
| Reports suite (agile + general/time) | ✓ | shipped | 027, 028 |
| Email notifications, schemes, filter subscriptions | ✓ | shipped | 029 |
| Automation rules (+ agent triage — beyond Jira) | ✓ | shipped | 034 |
| REST v2 API, webhooks (HMAC, JQL filter) | ✓ | shipped | 007, 011 |
| REST v3 / ADF content | ✓ | shipped | 040 |
| Git integration / Development panel | ✓ | shipped | 038 |
| Roadmap/timeline view | ✓ | shipped | 041 |
| Admin console, audit log, project archive, templates | ✓ | console/audit/archive shipped; **templates = gap** | 006, 021 |
| Dark theme, keyboard shortcuts, i18n | ✓ | shipped | 037 |
| SSO (OIDC), 2FA, profiles | ✓ | shipped | 036 |
| LDAP/SCIM directory, OAuth2 provider | ✓ (DC has SAML/LDAP) | shipped (OIDC/SCIM/LDAP; **SAML excluded**) | 049 |
| Jira Cloud importer | JCMA | shipped (dry-run, delta, resume) | 017 |
| Jira Server/DC importer | n/a | shipped | 048, 039 |
| Docs portal / API explorer | confluence.atlassian.com | shipped | 050 |

## 2. Cloud-only capabilities — the gap list

| Capability | TrackForge status | Notes |
|---|---|---|
| Rovo / natural-language "intent-aware" search, Teamwork Graph | **gap** | JQL + copilot exist; semantic search unowned — candidate for 047 or new sprint |
| Team-managed (next-gen) self-serve projects | **excluded** | One project model — deliberate simplification |
| Plans / Advanced Roadmaps (cross-project, capacity, dependencies) | **excluded** | 041 covers project-level roadmap; portfolio = Later #3 |
| Goals (Atlas), Teams/people directory | **gap** | Groups exist; Goal/Team as first-class entities unplanned |
| Space views: list, calendar, summary | **partial** | Board/backlog/issues/timeline + project summary exist; calendar view unplanned |
| Forms (structured intake) | **gap** | Not planned |
| Approvals | **gap** | Mostly a JSM feature; unplanned |
| JSM suite — queues, SLAs, portals, Assets/Insight CMDB | **excluded** | Different product (Later #8) |
| Marketplace / app platform (Forge, Connect) | **excluded** | Declarative extension-manifest decision recorded (Later #1) |
| Smart links / rich link previews | **gap** | Unplanned |
| Incoming mail → issue creation | **excluded** | Later #9 — revisit on demand |
| Mobile apps | **excluded** | Responsive web only |
| Application Links (OAuth 1.0a app-to-app) | **superseded** | 049's OAuth2.1 provider is the modern equivalent |

## 3. Where TrackForge exceeds Jira (either edition)

- **Agent-first API** — MCP server + full REST parity; agents are first-class users by constitution, not an integration afterthought.
- **dryRun previews** on mutating endpoints — Jira has no equivalent.
- **`Idempotency-Key` write safety** and two-step destructive deletes with `confirmToken`.
- **Channel attribution** (`X-TrackForge-Channel`) — every change records whether a human, API client, MCP agent, or copilot did it.
- **Import provenance** (`ExternalIdMap`) — every migrated row keeps its source identity; delta re-runs and resume are built-in.
- **HITL proposals** (012) + **agent triage automation** (034) + deterministic no-LLM eval suite — a deeper agent story than Rovo's UI copilot model.
- **Self-hosted, no per-user licensing** — vs Cloud subscription or DC's (now-EOL) license model.

## 4. Reading this for migration planning

- **From Jira Server/DC 10.x**: planned parity is effectively complete for Jira Software scope —
  nothing on a standard DC install is unreachable, except JSM (excluded) and SAML (OIDC/SCIM/LDAP
  cover the identity space).
- **From Jira Cloud**: core-parity strong; section-2 gaps are either deliberate product
  exclusions or flagged decisions — semantic search, calendar/summary views, dark theme,
  Goals/Teams, forms, approvals.
