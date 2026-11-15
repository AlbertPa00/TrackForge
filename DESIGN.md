# TrackForge — A Jira-Compatible Issue & Project Tracking Platform for Internal Use

## Design Document
**Version:** 1.1  
**Date:** 2026-06-20  
**Objective:** Design a self-hosted, internally-deployed issue tracking and agile project management platform with full Jira Software functional parity. Supports seamless migration of all Jira projects (Server, Data Center, and Cloud) with a Jira REST API-compatible layer. Covers Scrum/Kanban boards, customizable workflows, JQL search, dashboards, time tracking, reporting, and explicit software design patterns for maintainability and extensibility.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Jira Platform Analysis](#2-jira-platform-analysis)
3. [Requirements & Scope](#3-requirements--scope)
4. [System Architecture](#4-system-architecture)
5. [The Issue Ontology (Jira's Core Concept, Adapted)](#5-the-issue-ontology-jiras-core-concept-adapted)
6. [Issue Types & Custom Fields](#6-issue-types--custom-fields)
7. [Workflows & State Machines](#7-workflows--state-machines)
8. [Boards — Scrum & Kanban](#8-boards--scrum--kanban)
9. [Backlog & Sprint Management](#9-backlog--sprint-management)
10. [JQL — Query Language](#10-jql--query-language)
11. [Dashboards & Gadgets](#11-dashboards--gadgets)
12. [Reports & Analytics](#12-reports--analytics)
13. [Time Tracking & Estimation](#13-time-tracking--estimation)
14. [Notifications & Collaboration](#14-notifications--collaboration)
15. [Security, Permissions & Access Control](#15-security-permissions--access-control)
16. [Technology Stack](#16-technology-stack)
17. [Data Model (Detailed)](#17-data-model-detailed)
18. [API Design & Jira REST API Compatibility](#18-api-design--jira-rest-api-compatibility)
19. [Deployment Architecture](#19-deployment-architecture)
20. [Jira Compatibility & Migration](#20-jira-compatibility--migration)
21. [Software Design Patterns](#21-software-design-patterns)
22. [Roadmap & Phasing](#22-roadmap--phasing)

---

## 1. Executive Summary

TrackForge is a self-hostable issue tracking and agile project management platform that achieves full functional parity with Atlassian Jira Software for internal team use. It provides customizable workflows, Scrum and Kanban boards, JQL-based search, dashboards with gadgets, sprint management, time tracking, and rich reporting. Critically, it includes a **Jira REST API compatibility layer** and a **full migration pipeline** so that all existing Jira projects — including configurations, issues, history, comments, attachments, worklogs, sprints, boards, and custom fields — can be migrated with minimal effort.

### What we replicate from Jira

| Jira Concept | TrackForge Equivalent |
|---|---|
| **Projects** — containers with shared configurations | **Projects** — Software (Scrum/Kanban), with categories, components, versions |
| **Issues** — atomic work unit with type, status, priority, assignee | **Issues** — full type system (Epic, Story, Task, Bug, Subtask) with custom fields, links, attachments |
| **Workflows** — configurable state machines | **Workflow Engine** — visual designer with conditions, validators, post-functions |
| **Boards** — Scrum/Kanban with columns, swimlanes, WIP limits | **Boards** — drag-and-drop with configurable columns, swimlanes, card layouts |
| **Sprints** — time-boxed iterations | **Sprints** — planning, active sprint, sprint goal, velocity tracking |
| **JQL** — structured query language | **TQL** — full JQL-compatible syntax with autocomplete |
| **Dashboards** — customizable pages with gadgets | **Dashboards** — 15+ gadget types, shared dashboards |
| **Custom Fields** — extensible field system | **Custom Fields** — 20+ types with field configurations and contexts |
| **Notifications** — email + in-app alerts | **Notification Engine** — configurable per-event, email + in-app + webhook |
| **Permissions** — granular permission scheme | **Permission System** — project roles, permission schemes, issue security |
| **Reports** — burndown, velocity, CFD, etc. | **Reports** — full report suite, exportable |
| **Issue Links** — relationships between issues | **Issue Links** — blocks, relates to, duplicates, clones, parent/child |
| **Versions/Releases** — fix version tracking | **Versions** — release management with progress tracking |
| **Components** — sub-grouping within projects | **Components** — with component leads and default assignees |
| **Time Tracking** — estimate, remaining, logged | **Time Tracking** — work logs, timesheets, reports |
| **REST API** — Jira REST API v2/v3 | **Jira-Compatible REST API** — endpoint-compatible for zero-change migration of integrations |
| **Import/Export** — XML backup, CSV, JSON | **Migration Pipeline** — full import from Jira XML, REST API, CSV |

### What we deliberately simplify

- **No Atlassian Marketplace** — custom add-ons built in-house
- **No cross-product integration** — no Confluence/Bitbucket/Bamboo (standalone)
- **No cloud multi-tenancy** — single-instance internal deployment
- **No Jira Align** — portfolio/enterprise roadmapping out of scope initially
- **No Jira Service Management** — ITSM/CSM features out of scope

---

## 2. Jira Platform Analysis

### 2.1 Jira's Core Architecture

Jira is built around a flexible issue tracking engine with configurable workflows:

- **Issue-Centric Model**: Issues have type, status, priority, assignee, reporter, description, comments, attachments, custom fields, links, and complete change history. Issues are the atoms of project management.
- **Configurable Workflows**: Each issue type can have its own workflow — a state machine with statuses and transitions. Transitions have conditions (who can execute), validators (what must be true), and post-functions (what happens after).
- **Screen Schemes**: Different screens for create, edit, and view per issue type per project.
- **Field Configurations**: Define field behavior — required/optional, hidden/visible, default values, custom contexts per project.
- **Permission Schemes**: Granular permissions assignable to project roles, groups, or users.
- **Notification Schemes**: Map issue events to notification recipients and channels.

### 2.2 Jira Agile (Jira Software)

- **Scrum Boards**: Sprint-based with backlog, sprint planning, active sprint view, sprint report, burndown chart
- **Kanban Boards**: Continuous flow with WIP limits, cumulative flow diagram, control chart
- **Backlog View**: Prioritized list with drag-to-rank, sprint assignment, epic grouping
- **Epic/Story Hierarchy**: Epics contain stories, stories contain subtasks

### 2.3 JQL (Jira Query Language)

- Field operators: `=`, `!=`, `>`, `<`, `>=`, `<=`, `IN`, `NOT IN`, `IS`, `IS NOT`, `~`, `!~`, `WAS`, `CHANGED`
- Logical operators: `AND`, `OR`, `NOT`
- Functions: `currentUser()`, `membersOf()`, `startOfDay()`, `endOfWeek()`, `updatedBy()`, `linkedIssuesOf()`, `openSprints()`
- Order by: `ORDER BY field ASC/DESC`
- Saved filters with sharing and subscriptions

### 2.4 Jira REST API (v2 and v3)

Jira exposes two REST API versions:
- **v2** (`/rest/api/2/`): Legacy, widely used by integrations, returns plain text for description fields
- **v3** (`/rest/api/3/`): Current, uses Atlassian Document Format (ADF) for rich text fields
- **Agile API** (`/rest/agile/1.0/`): Board and sprint operations

TrackForge must be **endpoint-compatible** with both v2 and v3 so existing scripts, CI/CD integrations, and tools work without modification.

### 2.5 Jira Data Formats for Migration

- **XML Backup** (Jira Server/DC): Full system export as XML zip — projects, issues, users, configurations, attachments
- **JSON via REST API** (Jira Cloud): Export issues, projects, configurations via REST API calls
- **CSV Import/Export**: Bulk issue import via CSV with field mapping
- **Project Import**: Jira's native project import feature for cross-instance migration

### 2.6 Key Takeaways for TrackForge

1. **Workflow engine is the backbone**: Issues flow through configurable state machines
2. **Flexibility through configuration, not code**: Admins configure via UI
3. **JQL is essential**: Full query language with autocomplete and saved filters
4. **Board is the primary interface**: Drag-and-drop, fast, configurable
5. **Everything is auditable**: Full change history on every issue
6. **API compatibility enables migration**: Jira REST API compatibility is non-negotiable for zero-friction migration
7. **Design patterns ensure maintainability**: Explicit pattern selection for workflow engine, field system, notifications, and extensibility

---

## 3. Requirements & Scope

### 3.1 Core Features (Jira Parity)

| Feature | Priority | Description |
|---|---|---|
| Issue Management | P0 | Create, view, edit, delete, transition issues with full metadata |
| Custom Workflows | P0 | Visual workflow designer with statuses, transitions, conditions, validators, post-functions |
| Scrum Boards | P0 | Sprint planning, active sprint board, sprint report, burndown |
| Kanban Boards | P0 | Continuous flow board with WIP limits, cumulative flow |
| Backlog Management | P0 | Prioritized backlog with drag-to-rank, sprint assignment, epic grouping |
| JQL Search | P0 | Full query language with autocomplete, saved filters, sharing, subscriptions |
| Custom Fields | P0 | 20+ field types with field configurations and contexts |
| Dashboards | P0 | Customizable dashboards with 15+ gadget types |
| Reports | P0 | Burndown, velocity, control chart, CFD, pie chart, created vs resolved |
| Time Tracking | P1 | Original estimate, remaining, logged work, timesheets |
| Issue Links | P0 | Blocks, relates to, duplicates, parent/child, clones |
| Attachments | P0 | File upload with preview |
| Comments & Mentions | P0 | Inline comments, @mentions, restricted visibility |
| Notifications | P1 | Email + in-app notifications, configurable per event |
| Permissions & Roles | P0 | Permission schemes, project roles, issue security |
| Versions/Releases | P1 | Fix version tracking, release hub, release notes |
| Components | P1 | Sub-grouping with component leads |
| Bulk Operations | P1 | Bulk edit, bulk transition, bulk move, bulk delete |
| Roadmap | P1 | Epic-level roadmap with timeline view |
| Issue History | P0 | Complete changelog with field-level diffs |
| Export | P1 | CSV, Excel, printable, JSON export |
| REST API | P0 | Full CRUD API — Jira REST API v2/v3 compatible |
| Webhooks | P1 | Configurable webhooks for issue events |
| **Jira Migration** | **P0** | **Full import from Jira XML backup, REST API export, CSV** |
| **Jira API Compatibility** | **P0** | **Endpoint-compatible with Jira REST API v2/v3** |

### 3.2 Non-Functional Requirements

- **Self-hostable**: Runs on a single server via Docker Compose
- **Responsive**: Board interactions < 100ms; issue search < 500ms for 10k issues
- **Scalable to ~500k issues**: Handles large internal deployments
- **Multi-project**: Supports 100+ projects with independent configurations
- **Browser-based**: Modern browsers (Chrome, Firefox, Edge, Safari)
- **Accessible**: WCAG 2.1 AA compliance
- **Internationalizable**: i18n framework with English as default
- **API-first**: All features accessible via REST API
- **Jira-compatible**: REST API endpoints match Jira v2/v3 for integration portability

---

## 4. System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CLIENT (Browser)                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ │
│  │ Board    │ │ Backlog  │ │ Issue    │ │ Dashboard│ │ JQL      │ │
│  │ (Scrum/  │ │ (Rank,   │ │ Detail   │ │ (Gadgets)│ │ Search   │ │
│  │  Kanban) │ │  Sprint) │ │ (View/   │ │          │ │          │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ │
│  ┌────┴─────┐ ┌────┴─────┐ ┌────┴─────┐ ┌────┴─────┐ ┌────┴─────┐ │
│  │ Reports  │ │ Admin    │ │ Roadmap  │ │ Migration│ │ Settings │ │
│  │ (Charts) │ │ Console  │ │ (Epics)  │ │ Tool     │ │ Profile  │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘ │
│                    REST API + WebSocket                              │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────┼──────────────────────────────────────┐
│                   API GATEWAY (Auth, Rate Limit, Routing)            │
│                   /rest/api/2/  →  Jira v2 compat                    │
│                   /rest/api/3/  →  Jira v3 compat                    │
│                   /rest/agile/1.0/  →  Agile API compat              │
│                   /api/internal/  →  TrackForge native API           │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────┼──────────────────────────────────────┐
│                     APPLICATION LAYER                                │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌────────────┐          │
│  │ Issue     │ │ Workflow  │ │ Board &   │ │ Search     │          │
│  │ Service   │ │ Engine    │ │ Sprint    │ │ Service    │          │
│  │ (CRUD,    │ │ (State    │ │ Service   │ │ (JQL       │          │
│  │  History, │ │  Machine, │ │ (Scrum,   │ │  Parser,   │          │
│  │  Links,   │ │  Transi-  │ │  Kanban,  │ │  Indexer,  │          │
│  │  Attach)  │ │  tions)   │ │  Backlog) │ │  Filters)  │          │
│  └─────┬─────┘ └─────┬─────┘ └─────┬─────┘ └──────┬─────┘          │
│  ┌─────┴─────┐ ┌─────┴─────┐ ┌─────┴─────┐ ┌─────┴─────┐          │
│  │ Notifi-   │ │ Report    │ │ Admin     │ │ Migration │          │
│  │ cation    │ │ Service   │ │ Service   │ │ Service   │          │
│  │ Service   │ │ (Charts)  │ │ (Config)  │ │ (Import/  │          │
│  │           │ │           │ │           │ │  Export)  │          │
│  └─────┬─────┘ └─────┬─────┘ └─────┬─────┘ └─────┬─────┘          │
│  ┌─────┴─────┐ ┌─────┴─────┐ ┌─────┴─────┐ ┌─────┴─────┐          │
│  │ Time      │ │ Jira API  │ │ Webhook   │ │ Audit     │          │
│  │ Tracking  │ │ Compat    │ │ Service   │ │ Service   │          │
│  │ Service   │ │ Layer     │ │           │ │           │          │
│  └─────┬─────┘ └─────┬─────┘ └─────┬─────┘ └─────┬─────┘          │
│        └──────────────┴──────────────┴──────────────┘              │
│                      Event Bus (Redis Pub/Sub)                       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
┌──────────────────────────────┼──────────────────────────────────────┐
│                      DATA LAYER                                      │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌────────────┐          │
│  │ PostgreSQL│ │ OpenSearch│ │ Redis     │ │ MinIO/S3   │          │
│  │ (Issues,  │ │ (Search   │ │ (Cache,   │ │ (Attach-   │          │
│  │  Config,  │ │  index,   │ │  Sessions,│ │  ments,    │          │
│  │  Audit)   │ │  JQL)     │ │  Pub/Sub) │ │  Avatars)  │          │
│  └───────────┘ └───────────┘ └───────────┘ └────────────┘          │
└─────────────────────────────────────────────────────────────────────┘
```

### Architecture Principles

1. **Configuration over code**: Projects, workflows, fields, screens are all configurable data
2. **Event-driven**: Issue changes emit events → notifications, indexing, webhooks, audit logs
3. **Service-oriented monolith**: Logical service boundaries within a single deployable unit
4. **Search separated from storage**: PostgreSQL for transactional, OpenSearch for JQL/full-text
5. **Everything is auditable**: Every issue change, config change, user action is logged
6. **Jira API compatibility as a layer**: A dedicated compatibility layer maps Jira REST API endpoints to internal services — native API and Jira-compat API coexist
7. **Design patterns as architecture**: Explicit pattern selection (see Section 21) ensures maintainability and extensibility

---

## 5. The Issue Ontology (Jira's Core Concept, Adapted)

The issue model is the heart of TrackForge. It defines the entities of project management and their relationships.

### 5.1 Object Types

```
INSTANCE (System)
├── properties: name, base_url, version, locale, timezone
├── links: 1:N → PROJECT, 1:N → USER, 1:N → GROUP
│
PROJECT
├── properties: key, name, type (scrum|kanban), category, lead,
│               description, avatar_url, url, default_assignee, email_from
├── links: 1:N → ISSUE, 1:N → COMPONENT, 1:N → VERSION,
│         1:1 → PERMISSION_SCHEME, 1:1 → NOTIFICATION_SCHEME,
│         1:1 → WORKFLOW_SCHEME, 1:1 → FIELD_CONFIG_SCHEME,
│         1:1 → SCREEN_SCHEME, 1:1 → ISSUE_TYPE_SCHEME,
│         1:N → BOARD
│
ISSUE
├── properties: key, summary, description (rich text), environment,
│               issue_type, status, priority, resolution,
│               assignee, reporter, created_at, updated_at, due_date,
│               resolution_date, original_estimate, remaining_estimate,
│               time_spent, story_points, labels, security_level, rank
├── links: N:1 → PROJECT, N:1 → ISSUE (parent/subtask),
│         N:N → ISSUE (links), N:N → VERSION (fix/affected),
│         N:N → COMPONENT, 1:N → COMMENT, 1:N → ATTACHMENT,
│         1:N → WORKLOG, 1:N → ISSUE_CHANGE, 1:N → CUSTOM_FIELD_VALUE
│
ISSUE_TYPE
├── properties: name, description, icon_url, hierarchy_level, is_subtask
├── links: N:N → PROJECT (via issue type scheme)
│
COMMENT
├── properties: body (rich text), author, created_at, updated_at,
│               updated_by, visibility (role|group|all)
├── links: N:1 → ISSUE
│
ATTACHMENT
├── properties: filename, content_type, size_bytes, author,
│               created_at, storage_path, thumbnail_url
├── links: N:1 → ISSUE
│
WORKLOG
├── properties: time_spent_seconds, author, started_at, comment, created_at
├── links: N:1 → ISSUE
│
ISSUE_LINK
├── properties: link_type (blocks|relates_to|duplicates|clones),
│               created_at, created_by
├── links: N:1 → ISSUE (source), N:1 → ISSUE (destination)
│
ISSUE_CHANGE (History Entry)
├── properties: field_name, old_value, new_value, author, timestamp,
│               change_type (field|status|assignee|comment|attachment|link)
├── links: N:1 → ISSUE
│
COMPONENT
├── properties: name, description, lead, default_assignee, project_id
├── links: N:N → ISSUE, N:1 → PROJECT
│
VERSION
├── properties: name, description, release_date, start_date,
│               released, archived, sequence, project_id
├── links: N:N → ISSUE (fix/affected), N:1 → PROJECT
│
BOARD
├── properties: name, type (scrum|kanban), filter_id, column_config,
│               swimlane_config, card_layout_config, estimation_field,
│               ranking_field, sub_query
├── links: N:1 → PROJECT, 1:N → SPRINT
│
SPRINT
├── properties: name, state (future|active|closed), start_date, end_date,
│               goal, board_id, sequence, closed_at
├── links: N:N → ISSUE, N:1 → BOARD
│
CUSTOM_FIELD
├── properties: name, type, description, default_value, is_required,
│               is_searchable
├── links: N:N → PROJECT, 1:N → CUSTOM_FIELD_OPTION,
│         1:N → CUSTOM_FIELD_CONTEXT
│
WORKFLOW
├── properties: name, mode (live|draft), is_default
├── links: 1:N → WORKFLOW_STATUS, 1:N → WORKFLOW_TRANSITION
│
WORKFLOW_TRANSITION
├── properties: name, source_status_id, target_status_id, screen_id,
│               is_global, is_initial
├── links: N:1 → WORKFLOW, 1:N → CONDITION, 1:N → VALIDATOR,
│         1:N → POST_FUNCTION
│
USER
├── properties: username, email, display_name, avatar_url, is_active,
│               locale, timezone
├── links: N:N → GROUP, N:N → PROJECT_ROLE
│
PERMISSION_SCHEME
├── properties: name, description
├── links: 1:N → PERMISSION_GRANT, N:1 → PROJECT
│
NOTIFICATION_SCHEME
├── properties: name, description
├── links: 1:N → NOTIFICATION_EVENT, N:1 → PROJECT
```

### 5.2 Link Types (Relationships)

```
PROJECT     ──contains──→        ISSUE
PROJECT     ──has_component──→   COMPONENT
PROJECT     ──has_version──→     VERSION
PROJECT     ──has_board──→       BOARD
ISSUE       ──has_subtask──→     ISSUE (parent → child)
ISSUE       ──blocks──→          ISSUE
ISSUE       ──relates_to──→      ISSUE
ISSUE       ──duplicates──→      ISSUE
ISSUE       ──clones──→          ISSUE
ISSUE       ──fix_in──→          VERSION
ISSUE       ──affects──→         VERSION
ISSUE       ──part_of──→         COMPONENT
ISSUE       ──in_sprint──→       SPRINT
BOARD       ──has_sprint──→      SPRINT
USER        ──member_of──→       GROUP
USER        ──has_role──→        PROJECT_ROLE
```

### 5.3 Why This Matters

In Jira, the issue graph enables queries like: *"Show me all bugs blocking stories in the current sprint assigned to my team with priority > Medium"*. TrackForge supports the same graph traversal via TQL.

---

## 6. Issue Types & Custom Fields

### 6.1 Standard Issue Types

| Issue Type | Hierarchy | Description |
|---|---|---|
| **Epic** | 1 | Large body of work containing multiple stories |
| **Story** | 0 | User story — deliverable from user perspective |
| **Task** | 0 | Generic work item |
| **Bug** | 0 | Defect or error |
| **Subtask** | -1 | Breakdown of a story or task |
| **Initiative** | 2 | (Optional) Portfolio-level item above epics |

### 6.2 Custom Field Types

| Field Type | Storage | JQL Support | UI Widget |
|---|---|---|---|
| **Text (single line)** | VARCHAR | `=`, `!=`, `~`, `!~`, `IN` | Input |
| **Text (multi-line)** | TEXT | `~`, `!~` | Textarea |
| **Number** | DECIMAL | `=`, `!=`, `>`, `<`, `>=`, `<=`, `IN` | Number input |
| **Date** | DATE | `=`, `>=`, `<=`, date functions | Date picker |
| **Date Time** | TIMESTAMPTZ | `=`, `>=`, `<=` | DateTime picker |
| **Select (single)** | VARCHAR | `=`, `!=`, `IN`, `NOT IN` | Dropdown |
| **Select (multiple)** | JSONB | `IN`, `NOT IN` | Multi-select |
| **Cascading Select** | JSONB | `=`, `IN` | Two-level dropdown |
| **User Picker** | UUID | `=`, `IN`, `membersOf()` | User autocomplete |
| **Group Picker** | VARCHAR | `=`, `IN` | Group dropdown |
| **URL** | VARCHAR | `=`, `!=` | URL input |
| **Checkbox** | JSONB | `IN` | Checkbox group |
| **Radio Button** | VARCHAR | `=`, `!=`, `IN` | Radio group |
| **Label** | JSONB | `IN`, `NOT IN` | Tag input |
| **Project Picker** | UUID | `=`, `IN` | Project dropdown |
| **Version Picker** | UUID | `=`, `IN`, `releasedVersions()` | Version dropdown |
| **Component Picker** | UUID | `=`, `IN` | Component dropdown |
| **Duration** | INT (seconds) | `=`, `>`, `<` | Duration input |
| **Story Points** | DECIMAL | `=`, `>`, `<`, `>=`, `<=`, `IS` | Number input |
| **Epic Link** | UUID | `=`, `IN` | Epic dropdown |
| **Sprint** | UUID | `=`, `IN`, `openSprints()` | Sprint dropdown |

### 6.3 Field Configurations

Define field behavior per issue type:
- **Required / Optional**: Whether the field must have a value
- **Hidden / Visible**: Whether the field appears on screens
- **Default Value**: Auto-populated for new issues
- **Custom description**: Override help text
- **Renderer**: Wiki markup or plain text

### 6.4 Custom Field Contexts

Custom fields can have different options per project:
```
Custom Field "Risk Level":
  Context 1 (Project TF): Options = Low, Medium, High, Critical
  Context 2 (Project QA): Options = S1, S2, S3, S4
  Context 3 (All other):  Options = Low, Medium, High
```

### 6.5 Screen Schemes

Controls which fields appear on Create / Edit / View screens per issue type per project.

### 6.6 Issue Type Schemes

Maps which issue types are available in a project. Multiple projects can share a scheme.

---

## 7. Workflows & State Machines

### 7.1 Default Scrum Workflow

```
┌──────────┐     "Start Progress"     ┌──────────┐    "Review"    ┌──────────┐
│  TO DO   │─────────────────────────►│IN PROGRESS│──────────────►│IN REVIEW │
│          │◄─────────────────────────│           │◄───────────────│          │
└──────────┘     "Stop Progress"      └──────────┘   "Needs Work"  └─────┬────┘
                                                                     │"Approve"
                                                                     ▼
                                                               ┌──────────┐
                                                               │   DONE   │
                                                               │          │
                                                               └──────────┘
```

### 7.2 Default Kanban Workflow

```
BACKLOG → TO DO → IN PROGRESS → IN REVIEW → DONE
  ▲          │          │           │
  └──────────┴──────────┴───────────┘ (any → backlog)
```

### 7.3 Workflow Components

#### Statuses
| Property | Description |
|---|---|
| Name | Display name (e.g., "In Progress") |
| Category | `todo`, `in_progress`, `done` — drives board columns and reporting |
| Sequence | Display order |

#### Transitions
| Property | Description |
|---|---|
| Name | Display name (e.g., "Start Progress") |
| Source Status | Starting status (or "Any" for global) |
| Target Status | Ending status |
| Screen | Optional transition screen |
| Global | Available from any status |
| Initial | First transition (creates issue in target status) |

#### Conditions (who can execute)
| Type | Description |
|---|---|
| `Only Assignee` | Only the issue's assignee |
| `Only Reporter` | Only the issue's reporter |
| `Permission` | User must have specific permission |
| `Project Role` | User must be in specific role |
| `Group` | User must be in specific group |
| `Sub-Task Blocking` | All subtasks must be in specific status |
| `Field Value` | Field must have specific value |

#### Validators (what must be true)
| Type | Description |
|---|---|
| `Field Required` | Field must have a value |
| `Comment Required` | Comment must be added |
| `Attachment Required` | Attachment must exist |
| `Regex` | Field value must match regex |

#### Post-Functions (what happens after)
| Type | Description |
|---|---|
| `Set Field Value` | Auto-set a field |
| `Assign to Current User` | Auto-assign to transitioner |
| `Assign to Lead` | Auto-assign to project/component lead |
| `Trigger Webhook` | Fire webhook |
| `Send Notification` | Trigger notification |
| `Create Sub-Task` | Auto-create subtasks from template |

### 7.4 Workflow Designer UI

```
┌─────────────────────────────────────────────────────────────────┐
│  WORKFLOW DESIGNER — "TF: Scrum Workflow"              [Save]   │
│                                                                  │
│  ┌──────┐     ┌──────────┐     ┌──────────┐     ┌──────┐      │
│  │ TO DO│────►│IN PROGRESS│────►│ IN REVIEW│────►│ DONE │      │
│  │      │◄────│           │◄────│          │     │      │      │
│  └──────┘     └──────────┘     └──────────┘     └──────┘      │
│                                                                  │
│  [+ Add Status]  [+ Add Transition]  [Draft] [Publish]          │
│                                                                  │
│  Selected: "Start Progress" (TO DO → IN PROGRESS)               │
│  Conditions:  Only Assignee or Role: Developers                 │
│  Validators:  (none)                                            │
│  Post-Functions:                                                │
│   1. Assign to Current User                                     │
│   2. Set Field "Start Date" = today                             │
│   3. Send Notification (event: issue_started)                   │
└─────────────────────────────────────────────────────────────────┘
```

### 7.5 Workflow Schemes

Maps issue types to workflows per project:
```
Workflow Scheme "TF: Scrum":
  Story    → "TF: Scrum Workflow"
  Bug      → "TF: Bug Workflow" (has "Triage" status)
  Epic     → "TF: Epic Workflow" (simplified: To Do → Done)
  Subtask  → "TF: Scrum Workflow"
  (default) → "TF: Scrum Workflow"
```

---

## 8. Boards — Scrum & Kanban

### 8.1 Board Configuration

```
┌─────────────────────────────────────────────────────────────┐
│  BOARD CONFIG — "TF Sprint Board"                    [Save]  │
│                                                              │
│  Name: [TF Sprint Board          ]                          │
│  Type: ● Scrum  ○ Kanban                                    │
│  Filter: [project = TF AND type != Epic ORDER BY rank]     │
│                                                              │
│  Columns:                                                    │
│    ┌──────┐  ┌──────────┐  ┌──────────┐  ┌──────┐         │
│    │ TO DO│  │IN PROGRESS│  │ IN REVIEW│  │ DONE │         │
│    │      │  │  (WIP: 5) │  │  (WIP: 3)│  │      │         │
│    └──────┘  └──────────┘  └──────────┘  └──────┘         │
│                                                              │
│  Column → Status Mapping:                                   │
│    TO DO:       Open, Reopened                              │
│    IN PROGRESS: In Progress                                 │
│    IN REVIEW:   In Review, In QA                            │
│    DONE:        Done, Closed, Resolved                      │
│                                                              │
│  Swimlanes: ● Epic  ○ Assignee  ○ JQL                      │
│  Estimation: ● Story Points  ○ Original Estimate  ○ None   │
│  Ranking:    ● Rank (lexo-rank)                             │
└─────────────────────────────────────────────────────────────┘
```

### 8.2 Scrum Board — Active Sprint

```
┌──────────────────────────────────────────────────────────────────────┐
│  TF Sprint Board  |  Sprint 14: "Dashboard MVP"  |  5 days remaining │
│                                                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐            │
│  │  TO DO   │  │IN PROGRESS│  │ IN REVIEW│  │   DONE   │            │
│  │  (8)     │  │  (3/5)   │  │  (2/3)   │  │  (12)    │            │
│  ├──────────┤  ├──────────┤  ├──────────┤  ├──────────┤            │
│  │ TF-101   │  │ TF-095   │  │ TF-091   │  │ TF-080   │            │
│  │ Add logi │  │ Fix auth │  │ Review U │  │ Setup DB │            │
│  │ ● 3pts   │  │ ● 5pts   │  │ ● 2pts   │  │ ✓ 8pts   │            │
│  │ @maria   │  │ @juan    │  │ @maria   │  │ @carlos  │            │
│  ├──────────┤  ├──────────┤  ├──────────┤  ├──────────┤            │
│  │ TF-102   │  │ TF-096   │  │ TF-092   │  │ TF-081   │            │
│  │ Add pass │  │ API endp │  │ Code rev │  │ Init proj│            │
│  │ ● 2pts   │  │ ● 8pts   │  │ ● 1pt    │  │ ✓ 3pts   │            │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘            │
│                                                                       │
│  [◄ Backlog]  [Complete Sprint]  [Report]  [Board Config]           │
└──────────────────────────────────────────────────────────────────────┘
```

### 8.3 Kanban Board

```
┌──────────────────────────────────────────────────────────────────────┐
│  TF Kanban Board  |  WIP: 8/10  |  Avg cycle time: 2.3 days         │
│                                                                       │
│  ┌────────┐  ┌──────────┐  ┌──────────┐  ┌────────┐  ┌────────┐   │
│  │BACKLOG │  │  TO DO   │  │IN PROGRESS│  │ REVIEW │  │  DONE  │   │
│  │        │  │  (0/∞)  │  │  (4/5)   │  │ (2/3) │  │        │   │
│  ├────────┤  ├──────────┤  ├──────────┤  ├────────┤  ├────────┤   │
│  │ TF-201 │  │ TF-195   │  │ TF-190   │  │ TF-185 │  │ TF-180 │   │
│  │ TF-202 │  │ TF-196   │  │ TF-191   │  │ TF-186 │  │ TF-181 │   │
│  └────────┘  └──────────┘  └──────────┘  └────────┘  └────────┘   │
│                                                                       │
│  ⚠ WIP limit exceeded on IN PROGRESS (4/5)                          │
└──────────────────────────────────────────────────────────────────────┘
```

### 8.4 Card Detail (Click to Expand)

```
┌─────────────────────────────────────────────────────────────┐
│  TF-095: Fix authentication token refresh bug      [×]      │
│                                                               │
│  Type: Bug    Priority: High    Status: In Progress          │
│  Assignee: @juan    Reporter: @maria    Story Points: 5     │
│  Sprint: Sprint 14    Epic: TF-1    Labels: backend, security│
│  Fix Version: 2.1.0    Components: Auth                      │
│                                                               │
│  Description:                                                 │
│  Token refresh fails when the user has multiple active       │
│  sessions. Need to implement per-session token rotation.     │
│                                                               │
│  ── Comments (3) ──────────────────────────────────────       │
│  @maria: Can we add a test for this? (2h ago)                │
│  @juan: Already added unit test. (1h ago)                    │
│  [Add comment...]                                            │
│                                                               │
│  ── Linked Issues ────────────────────────────────────        │
│  • TF-096 is blocked by TF-095                               │
│                                                               │
│  ── Work Log ────────────────────────────────────────         │
│  @juan: 2h — "Investigated root cause" (yesterday)           │
│  Total: 5h / Estimate: 5h    [Log Work]                      │
│                                                               │
│  ── History ────────────────────────────────────────          │
│  Juan moved from TO DO to IN PROGRESS (yesterday)            │
│  Maria changed priority from Medium to High (2 days ago)     │
└─────────────────────────────────────────────────────────────┘
```

### 8.5 Swimlanes

| Type | Description |
|---|---|
| **Epic** | One swimlane per epic + "Issues without epic" + "Expedite" |
| **Assignee** | One swimlane per assignee |
| **Project** | One per project (cross-project boards) |
| **JQL Queries** | Custom JQL-based swimlanes |
| **Story** | One per parent story (subtask boards) |

### 8.6 WIP Limits

- Per-column limits (e.g., max 5 in "In Progress")
- Visual warning when exceeded (red header)
- Optional: block drag-and-drop when exceeded
- WIP count in header: `(4/5)`

### 8.7 Card Indicators

| Indicator | Visual |
|---|---|
| Priority | Colored left border (Highest=red → Lowest=gray) |
| Story Points | Badge with number |
| Linked issues | Chain icon with count |
| Attachments | Paperclip icon with count |
| Comments | Speech bubble with count |
| Overdue | Red clock if due date passed and not done |
| Flagged | Red flag (impediment) |

---

## 9. Backlog & Sprint Management

### 9.1 Backlog View

```
┌──────────────────────────────────────────────────────────────────────┐
│  BACKLOG — TF Sprint Board                                  [Sprint 14]│
│                                                                       │
│  ┌─ EPICS ──────────────────────────────────────────────────────┐    │
│  │  ▾ TF-1: Authentication           [3/7 done]  [12pts / 35pts]│    │
│  │  ▾ TF-2: Dashboard                [1/5 done]  [5pts / 25pts] │    │
│  │  ▸ TF-3: API Layer                [0/4 done]  [0pts / 20pts] │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  ┌─ SPRINT 14 (Active) — 5 days remaining ─────────────────────┐    │
│  │  TF-095  Fix auth token refresh     ●5  @juan    [IN PROG]  │    │
│  │  TF-096  API endpoint for refresh   ●8  @carlos  [TO DO]    │    │
│  │  ... (23 issues, 52pts committed)                           │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  ┌─ BACKLOG ────────────────────────────────────────────────────┐    │
│  │  TF-101  Add login rate limiting   ●3  @—       [TO DO]     │    │
│  │  TF-102  Password reset flow       ●2  @—       [TO DO]     │    │
│  │  ... (47 issues in backlog)                                 │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
│  [Create Sprint]  [Plan Sprint]  [← drag issues to sprint]          │
└──────────────────────────────────────────────────────────────────────┘
```

### 9.2 Sprint Lifecycle

```
FUTURE SPRINT → (admin clicks "Start Sprint") → ACTIVE SPRINT → (admin clicks "Complete Sprint") → CLOSED SPRINT
  (issues can be         (start_date, end_date,         (incomplete issues moved to
   added/removed)         goal set, issues locked)       backlog or next sprint, read-only)
```

### 9.3 Sprint Planning

```
┌─────────────────────────────────────────────────────────────┐
│  SPRINT PLANNING — Sprint 15                                │
│                                                              │
│  Sprint Name: [Sprint 15: API & Auth Polish      ]          │
│  Duration:    [2 weeks]  Start: [2026-06-23]  End: [07-07] │
│  Goal:        [Complete auth fixes and ship API v2        ]│
│                                                              │
│  ┌─ Available in Backlog ──────────────────────────────┐    │
│  │  TF-101  Add login rate limiting   ●3              │    │
│  │  TF-102  Password reset flow       ●2              │    │
│  │  TF-103  OAuth2 provider support   ●13             │    │
│  └─────────────────────────────────────────────────────┘    │
│  ┌─ Selected for Sprint ───────────────────────────────┐    │
│  │  TF-101  Add login rate limiting   ●3              │    │
│  │  TF-102  Password reset flow       ●2              │    │
│  └─────────────────────────────────────────────────────┘    │
│                                                              │
│  Committed: 5pts   Team Velocity (avg 6 sprints): 22pts    │
│  [Cancel]  [Start Sprint]                                   │
└─────────────────────────────────────────────────────────────┘
```

### 9.4 Ranking (LexoRank)

Issues are ranked using lexographic ranking (like Jira's LexoRank):
- Each issue has a `rank` string like `"0|hzzzzz:"`
- Dragging between two issues computes a midpoint rank
- O(1) updates — no full-table reordering
- Periodic rebalancing when ranks get too close

---

## 10. JQL — Query Language

### 10.1 TQL Syntax (JQL-Compatible)

```
query        := clause (ORDER BY field (ASC|DESC))?
clause       := term (OR term)*
term         := factor (AND factor)*
factor       := NOT? (field op value | "(" clause ")")
op           := "=" | "!=" | "~" | "!~" | ">" | ">=" | "<" | "<=" |
                "IN" | "NOT IN" | "IS" | "IS NOT" | "WAS" | "WAS NOT" |
                "WAS IN" | "WAS NOT IN" | "CHANGED"
```

### 10.2 Supported Fields

| Field | Operators | Example |
|---|---|---|
| `project` | `=`, `IN` | `project = TF` |
| `issuetype` | `=`, `IN` | `issuetype in (Bug, Task)` |
| `status` | `=`, `IN`, `WAS`, `CHANGED` | `status = "In Progress"` |
| `priority` | `=`, `IN`, `>`, `<` | `priority >= High` |
| `assignee` | `=`, `IN`, `IS`, `IS NOT` | `assignee = currentUser()` |
| `reporter` | `=`, `IN`, `IS`, `IS NOT` | `reporter = "juan"` |
| `created` | `=`, `>=`, `<=`, `>` | `created >= startOfDay()` |
| `updated` | `=`, `>=`, `<=` | `updated >= "-7d"` |
| `duedate` | `=`, `>=`, `<=`, `IS` | `duedate <= endOfWeek()` |
| `resolution` | `=`, `IN`, `IS` | `resolution = Unresolved` |
| `component` | `=`, `IN`, `IS` | `component in (Auth, API)` |
| `fixVersion` | `=`, `IN` | `fixVersion = "2.1.0"` |
| `labels` | `IN` | `labels in (backend, urgent)` |
| `sprint` | `=`, `IN`, `IS NOT` | `sprint in openSprints()` |
| `"Epic Link"` | `=`, `IN` | `"Epic Link" = TF-1` |
| `storyPoints` | `=`, `>`, `<`, `>=`, `<=`, `IS` | `storyPoints >= 3` |
| `text` | `~` | `text ~ "memory leak"` |
| `summary` | `~`, `!~`, `=` | `summary ~ "auth"` |
| `description` | `~`, `!~` | `description ~ "race condition"` |
| `comment` | `~`, `!~` | `comment ~ "fixed"` |
| `key` | `=`, `IN` | `key in (TF-095, TF-096)` |
| `statusCategory` | `=`, `IN` | `statusCategory != Done` |
| `parent` | `=`, `IN` | `parent = TF-100` |
| `cf[xxxx]` | varies | `cf[10001] = "High Risk"` |

Also implemented (Sprints 019–032; full matrix in `specs/010-jql-engine-search/contracts/jql.md`):
`affectedVersion`, `worklogDate`, `timespent`, `timeestimate`,
`timeoriginalestimate`, `workratio`, `billable`, `votes`, `watches`,
`security` (Jira `level`), `projectcategory`, `environment`, `epicLink`
(quoted `"Epic Link"` or `epicLink`), `filter`/`savedfilter` (share-aware
saved-filter subquery), and custom fields by bare name/alias
(`Flagged = Impediment`). `rank` is ORDER BY-only.

### 10.3 Supported Functions

As-implemented status (Sprint 032; registry at `GET /api/internal/jql/functions`):

| Function | Example | Status |
|---|---|---|
| `currentUser()` | `assignee = currentUser()` | implemented |
| `membersOf("group")` | `assignee in membersOf("developers")` | implemented |
| `startOfDay()` / `endOfDay()` | `created >= startOfDay()` | implemented |
| `startOfWeek()` / `endOfWeek()` | `duedate <= endOfWeek()` | implemented |
| `startOfMonth()` / `endOfMonth()` | `created >= startOfMonth()` | implemented |
| `now()` | `updated <= now()` | implemented |
| `"-Nd"` / `"Nh"` / `"Nw"` | `updated >= "-7d"` | implemented (relative dates) |
| `openSprints()` | `sprint in openSprints()` | implemented (+ `closedSprints`, `futureSprints`) |
| `closedSprints()` | `sprint in closedSprints()` | implemented |
| `releasedVersions()` | `fixVersion in releasedVersions()` | implemented (+ `unreleasedVersions`, `earliestUnreleasedVersion`, `latestReleasedVersion`) |
| `unreleasedVersions()` | `fixVersion in unreleasedVersions()` | implemented |
| `linkedIssuesOf("type")` | `key in linkedIssuesOf("Blocks")` | implemented — arg is a **link type**, not a key; `linkedIssues(key[,type])` for per-issue sets |
| `subtasksOf("jql")` | `key in subtasksOf("project = X")` | implemented — takes a JQL subquery, not a key |
| `updatedBy("user")` | `reporter in updatedBy("juan")` | implemented |
| `commentedBy("user")` | `key in commentedBy("maria")` | implemented |
| `componentsLeadBy("user")` | `component in componentsLeadBy("carlos")` | implemented |
| `projectsLeadBy("user")` | `project in projectsLeadBy("carlos")` | implemented |
| `watchers([key])` / `voters([key])` | `assignee in watchers()` | implemented (032) |
| `parentsOf("jql")` / `epicsOf("jql")` / `issuesInEpics("jql")` | `key in issuesInEpics("project = X")` | implemented (032 tree pack) |
| `hasComments()` | `key in hasComments()` | implemented (032) |
| `currentLogin()` / `previousLogin()` / `lastLogin()` | `updated >= currentLogin()` | implemented (032) |
| `cascadeOption("p","c")` | — | **deferred** — no cascading CF type yet |
| `issueHistory()` / `issuesFromReport()` | — | **deferred** — explicitly out of scope |
| `issueFunction` pseudo-field | — | **not implemented** — ScriptRunner field; issue-set functions hang off `key`/`parent` instead |

History operators (§10.1) are implemented for `status`, `priority`, `resolution`,
`assignee`, `reporter`, `fixversion`, `sprint`: `WAS`, `WAS NOT`, `WAS IN`,
`WAS NOT IN`, `CHANGED` with `FROM`/`TO`/`BY`/`BEFORE`/`AFTER`/`ON`/`DURING`
predicates over `ChangeItem` history. Other fields error explicitly.

### 10.4 Saved Filters

- Save any JQL query as a named filter
- Share with: everyone, groups, roles, or private
- Used by: boards, dashboard gadgets, subscriptions, exports
- Subscriptions: email results on schedule (daily, weekly, monthly)

---

## 11. Dashboards & Gadgets

### 11.1 Gadget Types

| Gadget | Description |
|---|---|
| **Assigned to Me** | Issues assigned to current user |
| **Filter Results** | Table of issues from a saved filter |
| **Two-Dimensional Filter** | Grid by two fields (e.g., assignee × status) |
| **Pie Chart** | Issues grouped by a field |
| **Created vs. Resolved** | Line chart over time |
| **Burndown Chart** | Sprint burndown |
| **Sprint Health** | Sprint progress widget |
| **Velocity Chart** | Team velocity across sprints |
| **Cumulative Flow Diagram** | CFD for Kanban |
| **Average Age** | Average issue age by status |
| **Recently Updated** | Recently updated issues |
| **Activity Stream** | Recent activity across projects |
| **Watched Issues** | Issues the user is watching |
| **Statistics** | Count by field (bar chart) |
| **Heat Map** | Issues colored by priority × status |
| **Favourite Filters** | Quick links to favorite filters |

### 11.2 Dashboard Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│  My Dashboard                                          [+ Add Gadget] │
│                                                                       │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐     │
│  │ Assigned to Me  │  │ Sprint Health   │  │ Activity Stream │     │
│  │  8 issues       │  │  Sprint 14      │  │  10:32 — Juan   │     │
│  │  • TF-095 Bug   │  │  ████████░░ 87% │  │    moved TF-095 │     │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘     │
│                                                                       │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐     │
│  │ Created vs      │  │ Velocity Chart  │  │ Pie Chart:      │     │
│  │ Resolved        │  │  ▂▃▅▄▆▅▇       │  │ Issues by Type  │     │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘     │
└──────────────────────────────────────────────────────────────────────┘
```

### 11.3 Dashboard Sharing

- **Private**, **Shared with groups**, **Shared with roles**, **Public**
- Admin can set system-wide default dashboard for new users

---

## 12. Reports & Analytics

### 12.1 Scrum Reports

#### Sprint Report (Burndown)

```
  60 ┤●                                               Ideal
     │ ╲                                              ═══════
  50 ┤  ╲                                              ╲
  40 ┤    ╲╲                                            ╲
  30 ┤       ╲╲                                          ╲
  20 ┤          ╲╲                                        ╲
  10 ┤             ╲╲                                      ╲
   0 ┼────────────────────────────────────────────●─────────●
     Jun 10  12  14  16  18  20  22  24

  Committed: 60pts  |  Completed: 52pts  |  Remaining: 8pts
```

#### Velocity Chart

```
  40 ┤                                                  ╭──╮
  30 ┤                                      ╭──╮╯  ╰╮    │
  20 ┤                          ╭──╮╯  ╰╮    │    │    │
  10 ┤              ╭──╮╯  ╰╮    │    │    │    │    │
   0 ┼──╮╯──╯──╯──╯──╯──╯──╯──╯──╯──╯──╯──╯──╯──╯──╯
       S9   S10  S11  S12  S13  S14
  ■ Committed  ■ Completed  |  Average: 22pts
```

### 12.2 Kanban Reports

#### Cumulative Flow Diagram (CFD)

```
  100 ┤███████████████████████████████████████████████████████ Done
   80 ┤███████████████████████████████████████████████░░░░░░ Review
   60 ┤██████████████████████████████████████████░░░░░░░░░░ In Prog
   40 ┤██████████████████████████████████████░░░░░░░░░░░░░ To Do
   20 ┤██████████████████████████████████░░░░░░░░░░░░░░░░ Backlog
    0 ┼──────────────────────────────────────────────────
      May 21                  Jun 5                  Jun 20
```

#### Control Chart (Cycle Time)

```
  10d ┤                    ●
   8d ┤              ●         ●
   6d ┤                    ●              ●
   4d ┤    ●        ●  ●        ●  ●     ●  ●  ●  ●  ●
   2d ┤ ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ● ●
   0d ┼──────────────────────────────────────────────────
      May 21                  Jun 5                  Jun 20
  Avg: 2.3d  |  Rolling avg: 2.1d  |  Over SLA: 3
```

### 12.3 General Reports

| Report | Type | Description |
|---|---|---|
| **Pie Chart** | Distribution | Issues grouped by any field |
| **Created vs. Resolved** | Trend | Line chart over time |
| **Average Age** | Bar | Average age of unresolved issues by status |
| **Time Tracking** | Table | Estimated vs. spent vs. remaining |
| **Workload Pie** | Distribution | Issues or time by assignee |
| **Resolution Time** | Bar | Average resolution time by type/priority |
| **Two Dimensional** | Grid | Issues grouped by two fields |
| **User Workload** | Table | Pending work per user |
| **Version Report** | Progress | Release progress vs. predicted completion |
| **Epic Report** | Progress | Epic progress with burndown |

### 12.4 Export

All reports exportable to: PNG, CSV, PDF, Printable HTML

---

## 13. Time Tracking & Estimation

### 13.1 Time Tracking Model

```
┌─────────────────────────────────────────────────────┐
│  Original Estimate:   5h   (set during planning)    │
│  Remaining Estimate:  2h   (updated as work happens)│
│  Time Spent:          3h   (sum of work logs)       │
│                                                       │
│  Progress: 60%  ████████░░░░░░░░                    │
└─────────────────────────────────────────────────────┘
```

### 13.2 Work Log

```
┌─────────────────────────────────────────────────────────────┐
│  LOG WORK — TF-095                                          │
│                                                              │
│  Time Spent:        [3h        ]                            │
│  Date Started:      [2026-06-20 10:00    ]                 │
│  Remaining Estimate:[2h        ]  (auto-adjusted)          │
│  Comment:           [Implemented the token refresh logic]  │
│                                                              │
│  [Log]  [Cancel]                                            │
└─────────────────────────────────────────────────────────────┘
```

### 13.3 Time Tracking Configuration

```
Default unit:           ● Hours  ○ Days  ○ Weeks
Time format:            ● Pretty (e.g., "2h 30m")  ○ Hours (e.g., "2.5h")
Default time estimate:  [8h]  (1 day)
Work days per week:     [5]
Work hours per day:     [8]
Auto-adjust remaining:  [✓] Reduce remaining by logged time
```

### 13.4 Timesheet Report

```
┌──────────────────────────────────────────────────────────────────────┐
│  TIMESHEET — Week of Jun 16-22, 2026 — User: Juan                    │
│                                                                       │
│  ┌────────┬──────────────────────┬──────┬──────┬──────┬──────┐      │
│  │ Issue  │ Summary              │ Mon  │ Tue  │ Wed  │ Thu  │      │
│  ├────────┼──────────────────────┼──────┼──────┼──────┼──────┤      │
│  │ TF-095 │ Fix auth token...    │ 3h   │ 2h   │ 1h   │ —    │      │
│  │ TF-096 │ API endpoint...      │ —    │ 1h   │ 3h   │ 2h   │      │
│  ├────────┼──────────────────────┼──────┼──────┼──────┼──────┤      │
│  │        │ TOTAL                │ 3h   │ 3h   │ 4h   │ 4h   │      │
│  └────────┴──────────────────────┴──────┴──────┴──────┴──────┘      │
│                                                                       │
│  Week total: 14h  |  Target: 40h  |  Variance: -26h                 │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 14. Notifications & Collaboration

### 14.1 Notification Events

| Event | Trigger | Default Recipients |
|---|---|---|
| `issue_created` | Issue is created | Reporter, watchers, project lead |
| `issue_updated` | Any field is changed | Assignee, watchers |
| `issue_assigned` | Assignee is changed | New assignee |
| `issue_commented` | Comment is added | Assignee, reporter, watchers, @mentioned |
| `issue_transitioned` | Status is changed | Assignee, reporter, watchers |
| `issue_deleted` | Issue is deleted | Reporter, watchers |
| `issue_linked` | Issue link is created | Assignee of linked issue |
| `issue_worklogged` | Work is logged | Assignee, reporter |
| `issue_mentioned` | User is @mentioned | Mentioned user |
| `sprint_started` | Sprint is started | Board team (role: Developers) |
| `sprint_closed` | Sprint is completed | Board team |
| `version_released` | Version is released | Project watchers |

### 14.2 Notification Channels

| Channel | Description |
|---|---|
| **Email** | HTML email with issue summary, change diff, and deep link |
| **In-App** | Bell icon notification with unread count |
| **Webhook** | POST JSON payload to configured URL (Slack/Discord/Teams) |
| **WebSocket** | Real-time push to browser |

### 14.3 Notification Scheme Configuration

```
Notification Scheme "TF Default":
  Event: issue_created
    → Email to: Reporter, Watchers
    → In-app to: Reporter, Watchers
    → Webhook: https://hooks.slack.com/... (if configured)

  Event: issue_commented
    → Email to: Assignee, Reporter, Watchers, @mentioned users
    → In-app to: Assignee, Reporter, Watchers, @mentioned users

  Event: issue_transitioned
    → Email to: Assignee, Reporter (only if status changed to Done)
    → In-app to: Assignee, Reporter, Watchers
```

### 14.4 Email Template

```
Subject: [TF-095] Fix authentication token refresh bug — Status changed to "In Progress"

Juan changed the status of TF-095 from "To Do" to "In Progress"

Issue:    TF-095 — Fix authentication token refresh bug
Project:  TrackForge (TF)
Type:     Bug    Priority: High    Assignee: Juan    Reporter: Maria

Changes:
  Status: To Do → In Progress
  Assignee: (Unassigned) → Juan

View issue: https://trackforge.internal/browse/TF-095
```

### 14.5 Watchers & @Mentions

- Users can watch/unwatch any issue they can browse
- Auto-watch: configurable to auto-watch issues you create, comment on, or are assigned
- `@username` in comments/descriptions with autocomplete
- Mentioned user receives notification regardless of watcher status

### 14.6 Voting

- Users can vote on issues (one vote per user per issue)
- Vote count shown on issue view

---

## 15. Security, Permissions & Access Control

### 15.1 Permission Scheme

| Permission | Description | Default Grantee |
|---|---|---|
| `BROWSE_PROJECTS` | View project and its issues | Project Role: Users |
| `CREATE_ISSUES` | Create new issues | Project Role: Users |
| `EDIT_ISSUES` | Edit issue fields | Project Role: Developers |
| `ASSIGN_ISSUES` | Assign issues to users | Project Role: Developers |
| `ASSIGNABLE_USER` | Can be assigned issues | Project Role: Developers |
| `RESOLVE_ISSUES` | Transition to resolved | Project Role: Developers |
| `CLOSE_ISSUES` | Transition to closed | Project Role: Administrators |
| `DELETE_ISSUES` | Delete issues | Project Role: Administrators |
| `MOVE_ISSUES` | Move issues between projects | Project Role: Administrators |
| `LINK_ISSUES` | Create issue links | Project Role: Developers |
| `ADD_COMMENTS` | Add comments | Project Role: Users |
| `EDIT_ALL_COMMENTS` | Edit any user's comments | Project Role: Administrators |
| `DELETE_ALL_COMMENTS` | Delete any user's comments | Project Role: Administrators |
| `CREATE_ATTACHMENTS` | Upload attachments | Project Role: Users |
| `DELETE_ALL_ATTACHMENTS` | Delete any attachment | Project Role: Administrators |
| `WORK_ON_ISSUES` | Log work | Project Role: Developers |
| `EDIT_ALL_WORKLOGS` | Edit any worklog | Project Role: Administrators |
| `MANAGE_WATCHERS` | Add/remove watchers | Project Role: Developers |
| `MANAGE_SPRINTS` | Create/start/close sprints | Project Role: Administrators |
| `ADMINISTER_PROJECT` | Configure project settings | Project Role: Administrators |

### 15.2 Permission Grantee Types

Each permission can be granted to: Project Role, Group, Specific User, Everyone (logged in), Reporter, Current Assignee, Project Lead

### 15.3 Issue Security

Issue-level security controls who can see individual issues:

```
Issue Security Scheme "TF Default":
  "Internal Only"     → Visible to: Project Role: Users
  "Developer Only"    → Visible to: Project Role: Developers
  "Admin Only"        → Visible to: Project Role: Administrators
```

### 15.4 Project Roles

| Role | Description |
|---|---|
| **Administrators** | Full project configuration access |
| **Developers** | Create, edit, transition, comment, log work |
| **Users** | Browse, create, comment |
| **Custom Roles** | Admin-defined with custom membership |

### 15.5 Authentication

- **Primary**: Username/password with bcrypt hashing
- **Session**: JWT access tokens (15min) + refresh tokens (7 days)
- **Optional SSO**: OIDC integration (Google, Microsoft, custom IdP)
- **API Tokens**: Personal API tokens for REST API access (Jira-compatible)
- **2FA**: Optional TOTP-based two-factor authentication

### 15.6 Audit Log

Every significant action is logged with user, action, entity type, entity ID, details (JSONB), IP address, user agent, and timestamp. Covers: issue CRUD, transitions, configuration changes, security events, admin actions.

---

## 16. Technology Stack

### 16.1 Frontend

| Component | Technology | Rationale |
|---|---|---|
| Framework | **Next.js 14+ (React 18)** | SSR, App Router, server components |
| State management | **Zustand** | Lightweight, good for board state |
| Drag-and-drop | **@dnd-kit/core** | Modern, accessible, performant |
| Charts | **Recharts** | Composable chart components |
| Rich text editor | **TipTap** | Collaborative editing, @mentions |
| UI components | **shadcn/ui + Tailwind CSS** | Modern, customizable, accessible |
| Data tables | **TanStack Table** | Sorting, filtering, pagination |
| Forms | **React Hook Form + Zod** | Schema validation |
| Date handling | **date-fns** | JQL date functions |
| Icons | **Lucide React** | Consistent icon set |

### 16.2 Backend

| Component | Technology | Rationale |
|---|---|---|
| API server | **Node.js + NestJS** | TypeScript end-to-end, modular DI architecture |
| ORM | **Prisma** | Type-safe, migrations, PostgreSQL support |
| Search | **OpenSearch 2.x** | Full-text search, JQL execution, aggregations |
| Background jobs | **BullMQ** (Redis-based) | Email, webhooks, reports, reindexing |
| WebSocket | **Socket.io** | Real-time board updates, notifications |
| JQL parser | **nearley.js** | Grammar-based parser for TQL |
| Markdown | **markdown-it** | Server + client rendering |

### 16.3 Data Layer

| Component | Technology | Rationale |
|---|---|---|
| Database | **PostgreSQL 16** | Primary store, JSONB for custom fields |
| Search index | **OpenSearch 2.x** | Full-text + structured search, JQL |
| Cache | **Redis 7** | Sessions, board cache, BullMQ broker, pub/sub |
| Object storage | **MinIO** | S3-compatible, attachments, avatars |
| File processing | **sharp** | Thumbnail generation |

### 16.4 Infrastructure

| Component | Technology |
|---|---|
| Containerization | Docker + Docker Compose |
| Reverse proxy | Nginx or Traefik |
| SSL | Let's Encrypt or self-signed (internal) |
| Monitoring | Prometheus + Grafana (optional) |
| Backups | pg_dump + OpenSearch snapshots + MinIO replication |
| Email | SMTP relay (internal) |

### 16.5 Development

| Component | Technology |
|---|---|
| Language | TypeScript 5.x (full-stack) |
| Package manager | pnpm (monorepo) |
| Monorepo | Turborepo |
| Testing | Vitest (unit) + Playwright (e2e) |
| Linting | ESLint + Prettier |

---

## 17. Data Model (Detailed)

### 17.1 PostgreSQL Schema — Core Tables

```sql
-- ============ USERS & GROUPS ============

CREATE TABLE app_user (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username        VARCHAR(255) UNIQUE NOT NULL,
    email           VARCHAR(255) UNIQUE NOT NULL,
    display_name    VARCHAR(255) NOT NULL,
    password_hash   VARCHAR(255),
    avatar_url      VARCHAR(500),
    is_active       BOOLEAN DEFAULT true,
    is_admin        BOOLEAN DEFAULT false,
    locale          VARCHAR(10) DEFAULT 'en',
    timezone        VARCHAR(50) DEFAULT 'UTC',
    last_login_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE user_group (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) UNIQUE NOT NULL,
    description     TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE user_group_member (
    group_id        UUID REFERENCES user_group(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES app_user(id) ON DELETE CASCADE,
    PRIMARY KEY (group_id, user_id)
);

CREATE TABLE api_token (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES app_user(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    token_hash      VARCHAR(255) NOT NULL,
    expires_at      TIMESTAMPTZ,
    last_used_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============ PROJECTS ============

CREATE TABLE project (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key             VARCHAR(10) UNIQUE NOT NULL,
    name            VARCHAR(255) NOT NULL,
    project_type    VARCHAR(20) NOT NULL DEFAULT 'software',
    board_type      VARCHAR(10) NOT NULL DEFAULT 'scrum',
    category        VARCHAR(255),
    lead_id         UUID REFERENCES app_user(id),
    description     TEXT,
    avatar_url      VARCHAR(500),
    url             VARCHAR(500),
    default_assignee_id UUID REFERENCES app_user(id),
    email_from      VARCHAR(255),
    is_deleted      BOOLEAN DEFAULT false,
    deleted_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_project_key ON project(key);

CREATE TABLE project_role (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID REFERENCES project(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    UNIQUE (project_id, name)
);

CREATE TABLE project_role_member (
    role_id         UUID REFERENCES project_role(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES app_user(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, user_id)
);

CREATE TABLE project_role_group (
    role_id         UUID REFERENCES project_role(id) ON DELETE CASCADE,
    group_id        UUID REFERENCES user_group(id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, group_id)
);

CREATE TABLE component (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID REFERENCES project(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    lead_id         UUID REFERENCES app_user(id),
    default_assignee_id UUID REFERENCES app_user(id),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (project_id, name)
);

CREATE TABLE version (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID REFERENCES project(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    release_date    DATE,
    start_date      DATE,
    is_released     BOOLEAN DEFAULT false,
    is_archived     BOOLEAN DEFAULT false,
    sequence        INT DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (project_id, name)
);

-- ============ ISSUE TYPES, STATUSES, PRIORITIES ============

CREATE TABLE issue_type (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(100) NOT NULL,
    description     TEXT,
    icon_url        VARCHAR(500),
    hierarchy_level INT DEFAULT 0,
    is_subtask      BOOLEAN DEFAULT false,
    is_system       BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE status (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(100) NOT NULL,
    category        VARCHAR(20) NOT NULL,
    description     TEXT,
    icon_url        VARCHAR(500),
    sequence        INT DEFAULT 0,
    is_initial      BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE priority (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(50) NOT NULL,
    description     TEXT,
    icon_url        VARCHAR(500),
    color           VARCHAR(7),
    sequence        INT DEFAULT 0,
    is_default      BOOLEAN DEFAULT false
);

CREATE TABLE resolution (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(50) NOT NULL,
    description     TEXT,
    sequence        INT DEFAULT 0
);

-- ============ ISSUES ============

CREATE TABLE issue (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID REFERENCES project(id) ON DELETE CASCADE,
    issue_number    INT NOT NULL,
    key             VARCHAR(20) UNIQUE NOT NULL,
    summary         VARCHAR(1000) NOT NULL,
    description     TEXT,
    environment     TEXT,
    issue_type_id   UUID NOT NULL,
    status_id       UUID NOT NULL,
    priority_id     UUID NOT NULL,
    resolution_id   UUID,
    assignee_id     UUID REFERENCES app_user(id),
    reporter_id     UUID REFERENCES app_user(id) NOT NULL,
    parent_id       UUID REFERENCES issue(id) ON DELETE SET NULL,
    epic_link_id    UUID REFERENCES issue(id) ON DELETE SET NULL,
    security_level_id UUID,
    original_estimate_seconds INT,
    remaining_estimate_seconds INT,
    time_spent_seconds INT DEFAULT 0,
    story_points    DECIMAL(5,1),
    rank            VARCHAR(255) NOT NULL DEFAULT '',
    due_date        DATE,
    resolution_date TIMESTAMPTZ,
    is_deleted      BOOLEAN DEFAULT false,
    deleted_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (project_id, issue_number)
);
CREATE INDEX idx_issue_project ON issue(project_id);
CREATE INDEX idx_issue_assignee ON issue(assignee_id);
CREATE INDEX idx_issue_status ON issue(status_id);
CREATE INDEX idx_issue_type ON issue(issue_type_id);
CREATE INDEX idx_issue_parent ON issue(parent_id);
CREATE INDEX idx_issue_rank ON issue(project_id, rank);
CREATE INDEX idx_issue_updated ON issue(updated_at DESC);

-- ============ ISSUE RELATIONSHIPS ============

CREATE TABLE issue_link_type (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(100) NOT NULL,
    inward          VARCHAR(100) NOT NULL,
    outward         VARCHAR(100) NOT NULL,
    is_system       BOOLEAN DEFAULT false
);

CREATE TABLE issue_link (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    link_type_id    UUID REFERENCES issue_link_type(id) ON DELETE CASCADE,
    source_issue_id UUID REFERENCES issue(id) ON DELETE CASCADE,
    target_issue_id UUID REFERENCES issue(id) ON DELETE CASCADE,
    created_by      UUID REFERENCES app_user(id),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE (link_type_id, source_issue_id, target_issue_id)
);

-- ============ COMMENTS, ATTACHMENTS, WORKLOGS ============

CREATE TABLE comment (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id        UUID REFERENCES issue(id) ON DELETE CASCADE,
    author_id       UUID REFERENCES app_user(id) NOT NULL,
    body            TEXT NOT NULL,
    visibility_type VARCHAR(20) DEFAULT 'all',
    visibility_value VARCHAR(255),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_by_id   UUID REFERENCES app_user(id)
);
CREATE INDEX idx_comment_issue ON comment(issue_id, created_at);

CREATE TABLE attachment (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id        UUID REFERENCES issue(id) ON DELETE CASCADE,
    filename        VARCHAR(500) NOT NULL,
    content_type    VARCHAR(255),
    size_bytes      BIGINT NOT NULL,
    storage_path    VARCHAR(1000) NOT NULL,
    thumbnail_path  VARCHAR(1000),
    author_id       UUID REFERENCES app_user(id) NOT NULL,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_attachment_issue ON attachment(issue_id);

CREATE TABLE worklog (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id        UUID REFERENCES issue(id) ON DELETE CASCADE,
    author_id       UUID REFERENCES app_user(id) NOT NULL,
    time_spent_seconds INT NOT NULL,
    started_at      TIMESTAMPTZ NOT NULL,
    comment         TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_worklog_issue ON worklog(issue_id);

-- ============ ISSUE CHANGE HISTORY ============

CREATE TABLE issue_change (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id        UUID REFERENCES issue(id) ON DELETE CASCADE,
    field_name      VARCHAR(255) NOT NULL,
    old_value       TEXT,
    new_value       TEXT,
    old_display     TEXT,
    new_display     TEXT,
    author_id       UUID REFERENCES app_user(id) NOT NULL,
    timestamp       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_change_issue ON issue_change(issue_id, timestamp DESC);

-- ============ LABELS ============

CREATE TABLE label (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) UNIQUE NOT NULL
);

CREATE TABLE issue_label (
    issue_id        UUID REFERENCES issue(id) ON DELETE CASCADE,
    label_id        UUID REFERENCES label(id) ON DELETE CASCADE,
    PRIMARY KEY (issue_id, label_id)
);

-- ============ VERSION & COMPONENT ASSOCIATIONS ============

CREATE TABLE issue_version (
    issue_id        UUID REFERENCES issue(id) ON DELETE CASCADE,
    version_id      UUID REFERENCES version(id) ON DELETE CASCADE,
    association     VARCHAR(20) NOT NULL,  -- fix|affected
    PRIMARY KEY (issue_id, version_id, association)
);

CREATE TABLE issue_component (
    issue_id        UUID REFERENCES issue(id) ON DELETE CASCADE,
    component_id    UUID REFERENCES component(id) ON DELETE CASCADE,
    PRIMARY KEY (issue_id, component_id)
);

-- ============ WATCHERS & VOTES ============

CREATE TABLE issue_watcher (
    issue_id        UUID REFERENCES issue(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES app_user(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (issue_id, user_id)
);

CREATE TABLE issue_vote (
    issue_id        UUID REFERENCES issue(id) ON DELETE CASCADE,
    user_id         UUID REFERENCES app_user(id) ON DELETE CASCADE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (issue_id, user_id)
);
```

### 17.2 PostgreSQL Schema — Configuration Tables

```sql
-- ============ WORKFLOWS ============

CREATE TABLE workflow (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    mode            VARCHAR(10) DEFAULT 'live',
    is_default      BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE workflow_status (
    workflow_id     UUID REFERENCES workflow(id) ON DELETE CASCADE,
    status_id       UUID REFERENCES status(id),
    is_initial      BOOLEAN DEFAULT false,
    sequence        INT DEFAULT 0,
    PRIMARY KEY (workflow_id, status_id)
);

CREATE TABLE workflow_transition (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id     UUID REFERENCES workflow(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    source_status_id UUID REFERENCES status(id),
    target_status_id UUID REFERENCES status(id) NOT NULL,
    screen_id       UUID,
    is_global       BOOLEAN DEFAULT false,
    is_initial      BOOLEAN DEFAULT false,
    sequence        INT DEFAULT 0
);

CREATE TABLE workflow_condition (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transition_id   UUID REFERENCES workflow_transition(id) ON DELETE CASCADE,
    type            VARCHAR(50) NOT NULL,
    configuration   JSONB NOT NULL DEFAULT '{}',
    sequence        INT DEFAULT 0
);

CREATE TABLE workflow_validator (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transition_id   UUID REFERENCES workflow_transition(id) ON DELETE CASCADE,
    type            VARCHAR(50) NOT NULL,
    configuration   JSONB NOT NULL DEFAULT '{}',
    sequence        INT DEFAULT 0
);

CREATE TABLE workflow_post_function (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    transition_id   UUID REFERENCES workflow_transition(id) ON DELETE CASCADE,
    type            VARCHAR(50) NOT NULL,
    configuration   JSONB NOT NULL DEFAULT '{}',
    sequence        INT DEFAULT 0
);

-- ============ SCHEMES ============

CREATE TABLE workflow_scheme (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    is_default      BOOLEAN DEFAULT false
);

CREATE TABLE workflow_scheme_mapping (
    scheme_id       UUID REFERENCES workflow_scheme(id) ON DELETE CASCADE,
    issue_type_id   UUID REFERENCES issue_type(id),
    workflow_id     UUID REFERENCES workflow(id) NOT NULL,
    PRIMARY KEY (scheme_id, issue_type_id)
);

CREATE TABLE issue_type_scheme (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    is_default      BOOLEAN DEFAULT false
);

CREATE TABLE issue_type_scheme_item (
    scheme_id       UUID REFERENCES issue_type_scheme(id) ON DELETE CASCADE,
    issue_type_id   UUID REFERENCES issue_type(id) ON DELETE CASCADE,
    sequence        INT DEFAULT 0,
    PRIMARY KEY (scheme_id, issue_type_id)
);

-- ============ CUSTOM FIELDS ============

CREATE TABLE custom_field (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    type            VARCHAR(50) NOT NULL,
    description     TEXT,
    is_system       BOOLEAN DEFAULT false,
    is_searchable   BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE custom_field_option (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    custom_field_id UUID REFERENCES custom_field(id) ON DELETE CASCADE,
    value           VARCHAR(500) NOT NULL,
    sequence        INT DEFAULT 0,
    is_disabled     BOOLEAN DEFAULT false
);

CREATE TABLE custom_field_context (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    custom_field_id UUID REFERENCES custom_field(id) ON DELETE CASCADE,
    project_id      UUID REFERENCES project(id),
    issue_type_id   UUID REFERENCES issue_type(id),
    is_default      BOOLEAN DEFAULT false
);

CREATE TABLE custom_field_value (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issue_id        UUID REFERENCES issue(id) ON DELETE CASCADE,
    custom_field_id UUID REFERENCES custom_field(id) ON DELETE CASCADE,
    value_string    TEXT,
    value_number    DECIMAL(20,4),
    value_date      DATE,
    value_datetime  TIMESTAMPTZ,
    value_uuid      UUID,
    value_json      JSONB,
    UNIQUE (issue_id, custom_field_id)
);
CREATE INDEX idx_cfv_issue ON custom_field_value(issue_id);
CREATE INDEX idx_cfv_field ON custom_field_value(custom_field_id);

-- ============ SCREENS & FIELD CONFIGURATIONS ============

CREATE TABLE screen (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    description     TEXT
);

CREATE TABLE screen_field (
    screen_id       UUID REFERENCES screen(id) ON DELETE CASCADE,
    field_id        VARCHAR(100) NOT NULL,
    sequence        INT DEFAULT 0,
    PRIMARY KEY (screen_id, field_id)
);

CREATE TABLE screen_scheme (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    description     TEXT
);

CREATE TABLE screen_scheme_mapping (
    scheme_id       UUID REFERENCES screen_scheme(id) ON DELETE CASCADE,
    issue_type_id   UUID REFERENCES issue_type(id),
    create_screen_id  UUID REFERENCES screen(id),
    edit_screen_id    UUID REFERENCES screen(id),
    view_screen_id    UUID REFERENCES screen(id),
    PRIMARY KEY (scheme_id, issue_type_id)
);

CREATE TABLE field_configuration (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    is_default      BOOLEAN DEFAULT false
);

CREATE TABLE field_configuration_item (
    config_id       UUID REFERENCES field_configuration(id) ON DELETE CASCADE,
    field_id        VARCHAR(100) NOT NULL,
    is_required     BOOLEAN DEFAULT false,
    is_hidden       BOOLEAN DEFAULT false,
    default_value   TEXT,
    custom_description TEXT,
    renderer        VARCHAR(50) DEFAULT 'text',
    PRIMARY KEY (config_id, field_id)
);

-- ============ PERMISSIONS ============

CREATE TABLE permission_scheme (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    is_default      BOOLEAN DEFAULT false
);

CREATE TABLE permission_grant (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scheme_id       UUID REFERENCES permission_scheme(id) ON DELETE CASCADE,
    permission      VARCHAR(50) NOT NULL,
    grantee_type    VARCHAR(20) NOT NULL,
    grantee_id      VARCHAR(255)
);

-- ============ NOTIFICATIONS ============

CREATE TABLE notification_scheme (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    description     TEXT,
    is_default      BOOLEAN DEFAULT false
);

CREATE TABLE notification_event (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    scheme_id       UUID REFERENCES notification_scheme(id) ON DELETE CASCADE,
    event_type      VARCHAR(50) NOT NULL,
    recipient_type  VARCHAR(20) NOT NULL,
    recipient_id    VARCHAR(255),
    channel         VARCHAR(20) NOT NULL DEFAULT 'email'
);

-- ============ BOARDS & SPRINTS ============

CREATE TABLE board (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID REFERENCES project(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    type            VARCHAR(10) NOT NULL,
    filter_id       UUID,
    column_config   JSONB NOT NULL DEFAULT '[]',
    swimlane_config JSONB NOT NULL DEFAULT '{}',
    card_layout_config JSONB NOT NULL DEFAULT '{}',
    estimation_field VARCHAR(50) DEFAULT 'story_points',
    sub_query       TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE sprint (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id        UUID REFERENCES board(id) ON DELETE CASCADE,
    name            VARCHAR(255) NOT NULL,
    state           VARCHAR(10) NOT NULL DEFAULT 'future',
    start_date      TIMESTAMPTZ,
    end_date        TIMESTAMPTZ,
    goal            TEXT,
    sequence        INT DEFAULT 0,
    closed_at       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE sprint_issue (
    sprint_id       UUID REFERENCES sprint(id) ON DELETE CASCADE,
    issue_id        UUID REFERENCES issue(id) ON DELETE CASCADE,
    added_at        TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (sprint_id, issue_id)
);

-- ============ SAVED FILTERS ============

CREATE TABLE saved_filter (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    jql             TEXT NOT NULL,
    owner_id        UUID REFERENCES app_user(id) NOT NULL,
    is_favorite     BOOLEAN DEFAULT false,
    share_type      VARCHAR(20) DEFAULT 'private',
    share_target    VARCHAR(255),
    subscription_config JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============ DASHBOARDS ============

CREATE TABLE dashboard (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    owner_id        UUID REFERENCES app_user(id) NOT NULL,
    share_type      VARCHAR(20) DEFAULT 'private',
    share_target    VARCHAR(255),
    is_system_default BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE dashboard_gadget (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    dashboard_id    UUID REFERENCES dashboard(id) ON DELETE CASCADE,
    gadget_type     VARCHAR(50) NOT NULL,
    title           VARCHAR(255),
    config          JSONB NOT NULL DEFAULT '{}',
    position_x      INT DEFAULT 0,
    position_y      INT DEFAULT 0,
    width           INT DEFAULT 1,
    height          INT DEFAULT 1
);

-- ============ WEBHOOKS ============

CREATE TABLE webhook (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(255) NOT NULL,
    url             VARCHAR(1000) NOT NULL,
    events          JSONB NOT NULL DEFAULT '[]',
    project_id      UUID REFERENCES project(id),
    is_active       BOOLEAN DEFAULT true,
    secret          VARCHAR(255),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============ AUDIT LOG ============

CREATE TABLE audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES app_user(id),
    action          VARCHAR(50) NOT NULL,
    entity_type     VARCHAR(50) NOT NULL,
    entity_id       UUID,
    details         JSONB,
    ip_address      VARCHAR(45),
    user_agent      TEXT,
    timestamp       TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_time ON audit_log(timestamp DESC);

-- ============ MIGRATION TRACKING ============

CREATE TABLE migration_job (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_type     VARCHAR(20) NOT NULL,  -- jira_xml|jira_api|csv
    source_details  JSONB,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending',  -- pending|running|completed|failed
    total_items     INT,
    processed_items INT DEFAULT 0,
    error_log       TEXT,
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE migration_user_mapping (
    migration_job_id UUID REFERENCES migration_job(id) ON DELETE CASCADE,
    source_username  VARCHAR(255) NOT NULL,
    source_email     VARCHAR(255),
    target_user_id   UUID REFERENCES app_user(id),
    PRIMARY KEY (migration_job_id, source_username)
);
```

### 17.3 Entity Relationship Diagram

```
INSTANCE
  └── PROJECT ──1:N── ISSUE ──1:N── COMMENT
       │                  │       ──1:N── ATTACHMENT
       ├──1:N── COMPONENT │       ──1:N── WORKLOG
       ├──1:N── VERSION   │       ──1:N── ISSUE_CHANGE
       ├──1:1── PERM_SCHEME│      ──N:N── ISSUE (links)
       ├──1:1── NOTIF_SCHEME│     ──N:N── VERSION
       ├──1:1── WORKFLOW_SCHEME│  ──N:N── COMPONENT
       ├──1:N── BOARD     │       ──N:N── LABEL
       │      1:N──SPRINT─│──N:N──ISSUE
       └──1:N── PROJECT_ROLE ──N:N── USER ──N:N── GROUP

WORKFLOW ──1:N── TRANSITION ──1:N── CONDITION/VALIDATOR/POST_FUNCTION
CUSTOM_FIELD ──1:N── OPTION / CONTEXT / VALUE
SCREEN ──1:N── FIELD
SAVED_FILTER ──used by── BOARD, DASHBOARD_GADGET
DASHBOARD ──1:N── GADGET
MIGRATION_JOB ──1:N── USER_MAPPING
```

---

## 18. API Design & Jira REST API Compatibility

### 18.1 API Routing Strategy

TrackForge exposes three API surfaces simultaneously:

| Route Prefix | Purpose | Compatibility |
|---|---|---|
| `/rest/api/2/` | Jira REST API v2 compatible | Existing Jira integrations work unchanged |
| `/rest/api/3/` | Jira REST API v3 compatible (ADF format) | Modern Jira integrations work unchanged |
| `/rest/agile/1.0/` | Jira Agile API compatible | Board/sprint integrations work unchanged |
| `/api/internal/` | TrackForge native API | Extended features beyond Jira parity |

The Jira-compatible routes are handled by a **Jira Compatibility Layer** — a controller set that maps Jira request/response formats to internal service calls and back. This is implemented as a **Adapter Pattern** (see Section 21).

### 18.2 Jira REST API v2 — Endpoint Compatibility Matrix

| Jira Endpoint | TrackForge Status | Notes |
|---|---|---|
| `GET /rest/api/2/issue/{key}` | ✅ Full | Issue with fields, renderedFields, changelog |
| `POST /rest/api/2/issue` | ✅ Full | Create issue with fields |
| `PUT /rest/api/2/issue/{key}` | ✅ Full | Edit issue fields |
| `DELETE /rest/api/2/issue/{key}` | ✅ Full | Delete issue |
| `GET /rest/api/2/issue/createmeta` | ✅ Full | Create metadata (projects, issue types, fields) |
| `GET /rest/api/2/issue/{key}/editmeta` | ✅ Full | Edit metadata (available fields) |
| `GET /rest/api/2/issue/{key}/transitions` | ✅ Full | Available transitions |
| `POST /rest/api/2/issue/{key}/transitions` | ✅ Full | Execute transition |
| `GET /rest/api/2/issue/{key}/comment` | ✅ Full | List comments |
| `POST /rest/api/2/issue/{key}/comment` | ✅ Full | Add comment |
| `PUT /rest/api/2/issue/{key}/comment/{id}` | ✅ Full | Edit comment |
| `DELETE /rest/api/2/issue/{key}/comment/{id}` | ✅ Full | Delete comment |
| `GET /rest/api/2/issue/{key}/watchers` | ✅ Full | List watchers |
| `POST /rest/api/2/issue/{key}/watchers` | ✅ Full | Add watcher |
| `DELETE /rest/api/2/issue/{key}/watchers` | ✅ Full | Remove watcher |
| `GET /rest/api/2/issue/{key}/votes` | ✅ Full | List votes |
| `POST /rest/api/2/issue/{key}/votes` | ✅ Full | Add vote |
| `DELETE /rest/api/2/issue/{key}/votes` | ✅ Full | Remove vote |
| `GET /rest/api/2/issue/{key}/worklog` | ✅ Full | List worklogs |
| `POST /rest/api/2/issue/{key}/worklog` | ✅ Full | Add worklog |
| `PUT /rest/api/2/issue/{key}/worklog/{id}` | ✅ Full | Edit worklog |
| `DELETE /rest/api/2/issue/{key}/worklog/{id}` | ✅ Full | Delete worklog |
| `GET /rest/api/2/issue/{key}/attachments` | ✅ Full | List attachments |
| `POST /rest/api/2/issue/{key}/attachments` | ✅ Full | Add attachment (multipart) |
| `DELETE /rest/api/2/attachment/{id}` | ✅ Full | Delete attachment |
| `GET /rest/api/2/search` | ✅ Full | JQL search with fields param |
| `POST /rest/api/2/search` | ✅ Full | JQL search (POST body) |
| `GET /rest/api/2/project` | ✅ Full | List projects |
| `GET /rest/api/2/project/{key}` | ✅ Full | Project details |
| `POST /rest/api/2/project` | ✅ Full | Create project |
| `PUT /rest/api/2/project/{key}` | ✅ Full | Update project |
| `DELETE /rest/api/2/project/{key}` | ✅ Full | Delete project |
| `GET /rest/api/2/project/{key}/components` | ✅ Full | List components |
| `POST /rest/api/2/component` | ✅ Full | Create component |
| `PUT /rest/api/2/component/{id}` | ✅ Full | Update component |
| `DELETE /rest/api/2/component/{id}` | ✅ Full | Delete component |
| `GET /rest/api/2/project/{key}/versions` | ✅ Full | List versions |
| `POST /rest/api/2/version` | ✅ Full | Create version |
| `PUT /rest/api/2/version/{id}` | ✅ Full | Update version |
| `DELETE /rest/api/2/version/{id}` | ✅ Full | Delete version |
| `GET /rest/api/2/project/{key}/statuses` | ✅ Full | Statuses available in project |
| `GET /rest/api/2/issuetype` | ✅ Full | List issue types |
| `GET /rest/api/2/priority` | ✅ Full | List priorities |
| `GET /rest/api/2/status` | ✅ Full | List statuses |
| `GET /rest/api/2/resolution` | ✅ Full | List resolutions |
| `GET /rest/api/2/field` | ✅ Full | List all fields (system + custom) |
| `GET /rest/api/2/filter` | ✅ Full | List saved filters |
| `POST /rest/api/2/filter` | ✅ Full | Create saved filter |
| `GET /rest/api/2/filter/{id}` | ✅ Full | Get filter |
| `PUT /rest/api/2/filter/{id}` | ✅ Full | Update filter |
| `DELETE /rest/api/2/filter/{id}` | ✅ Full | Delete filter |
| `GET /rest/api/2/user` | ✅ Full | Search users |
| `GET /rest/api/2/user` | ✅ Full | Get user by username/accountId |
| `GET /rest/api/2/group` | ✅ Full | List groups / group members |
| `GET /rest/api/2/myself` | ✅ Full | Current user info |
| `GET /rest/api/2/serverInfo` | ✅ Full | Server info (version, build, etc.) |
| `GET /rest/api/2/configuration` | ✅ Full | Configuration info |
| `POST /rest/api/2/issueLink` | ✅ Full | Create issue link |
| `DELETE /rest/api/2/issueLink/{id}` | ✅ Full | Delete issue link |
| `GET /rest/api/2/issueLinkType` | ✅ Full | List link types |
| `POST /rest/api/2/issue/bulk` | ✅ Full | Bulk create |
| `POST /rest/api/2/issue/createmeta` | ✅ Full | Bulk create metadata |
| `GET /rest/api/2/jql/autocompletedata` | ✅ Full | JQL autocomplete suggestions |
| `GET /rest/api/2/jql/autocompletedata/suggestions` | ✅ Full | JQL field value suggestions |
| `GET /rest/api/2/notificationscheme` | ✅ Full | Notification schemes |
| `GET /rest/api/2/permissionscheme` | ✅ Full | Permission schemes |
| `GET /rest/api/2/workflowscheme` | ✅ Full | Workflow schemes |
| `POST /rest/api/2/webhook` | ✅ Full | Register webhook |
| `DELETE /rest/api/2/webhook/{id}` | ✅ Full | Delete webhook |

### 18.3 Jira Agile API — Endpoint Compatibility

| Jira Endpoint | TrackForge Status |
|---|---|
| `GET /rest/agile/1.0/board` | ✅ List boards |
| `GET /rest/agile/1.0/board/{id}` | ✅ Board details |
| `GET /rest/agile/1.0/board/{id}/sprint` | ✅ Sprints on board |
| `GET /rest/agile/1.0/board/{id}/backlog` | ✅ Backlog issues |
| `GET /rest/agile/1.0/board/{id}/configuration` | ✅ Board config |
| `PUT /rest/agile/1.0/board/{id}/configuration` | ✅ Update board config |
| `GET /rest/agile/1.0/sprint/{id}` | ✅ Sprint details |
| `POST /rest/agile/1.0/sprint` | ✅ Create sprint |
| `PUT /rest/agile/1.0/sprint/{id}` | ✅ Update sprint |
| `POST /rest/agile/1.0/sprint/{id}/start` | ✅ Start sprint |
| `POST /rest/agile/1.0/sprint/{id}/close` | ✅ Close sprint |
| `DELETE /rest/agile/1.0/sprint/{id}` | ✅ Delete sprint |
| `GET /rest/agile/1.0/sprint/{id}/issue` | ✅ Issues in sprint |
| `POST /rest/agile/1.0/sprint/{id}/issue` | ✅ Add issues to sprint |
| `DELETE /rest/agile/1.0/sprint/{id}/issue` | ✅ Remove issues from sprint |
| `GET /rest/agile/1.0/issue/{key}` | ✅ Issue with sprint/epic info |
| `GET /rest/agile/1.0/epic/{key}` | ✅ Epic details |
| `GET /rest/agile/1.0/epic/{key}/issue` | ✅ Issues in epic |
| `POST /rest/agile/1.0/issue/rank` | ✅ Rank issues (lexo-rank) |

### 18.4 Jira REST API v3 — ADF (Atlassian Document Format) Support

For v3, rich text fields (description, comment body, environment) use **Atlassian Document Format (ADF)** — a JSON-based document format. TrackForge implements:

- **ADF Parser**: Converts ADF JSON to internal markdown/HTML and back
- **ADF Renderer**: Server-side rendering to HTML for email notifications and exports
- **ADF Editor**: TipTap-based editor that produces ADF-compatible JSON
- **v2 Fallback**: When v2 endpoints are called, rich text is returned as plain text or wiki markup

### 18.5 TrackForge Native API (Extended)

Beyond Jira compatibility, TrackForge exposes native endpoints for features Jira doesn't have or handles differently:

```
# Migration
POST   /api/internal/migration/jira-xml          → Import Jira XML backup
POST   /api/internal/migration/jira-api          → Import from Jira REST API
POST   /api/internal/migration/csv               → Import CSV
GET    /api/internal/migration/{id}/status       → Migration job status
GET    /api/internal/migration/{id}/report       → Migration report (errors, warnings)

# Export
GET    /api/internal/export/project/{key}        → Full project export (JSON)
GET    /api/internal/export/project/{key}/issues → Issue export (CSV/JSON)
POST   /api/internal/export/project/{key}/xml    → Jira-compatible XML export

# Bulk Operations
POST   /api/internal/bulk/edit                   → Bulk edit issues
POST   /api/internal/bulk/transition             → Bulk transition
POST   /api/internal/bulk/move                   → Bulk move to project
POST   /api/internal/bulk/delete                 → Bulk delete

# Reports (native)
GET    /api/internal/reports/burndown/{sprintId}  → Burndown data (JSON)
GET    /api/internal/reports/velocity/{boardId}   → Velocity data (JSON)
GET    /api/internal/reports/cfd/{boardId}        → CFD data (JSON)
GET    /api/internal/reports/control/{boardId}    → Control chart data (JSON)

# Roadmap
GET    /api/internal/roadmap/{boardId}            → Epic roadmap data
```

### 18.6 Authentication for API

| Method | Header | Notes |
|---|---|---|
| **Basic Auth** | `Authorization: Basic base64(user:pass)` | Jira-compatible — username/password or username:api_token |
| **API Token** | `Authorization: Basic base64(email:api_token)` | Jira Cloud-compatible token auth |
| **Bearer JWT** | `Authorization: Bearer <jwt>` | TrackForge native session tokens |
| **PAT** | `Authorization: Bearer <personal_access_token>` | Personal access tokens (Jira DC-compatible) |

### 18.7 Rate Limiting

- Default: 1000 requests/min per user (configurable)
- Jira-compatible `X-RateLimit-*` headers returned
- 429 Too Many Requests with `Retry-After` header

### 18.8 Pagination

Jira-compatible pagination:
- `startAt` (offset) and `maxResults` (limit) query params
- Response includes `startAt`, `maxResults`, `total`
- Default page size: 50 (max: 1000)

---

## 19. Deployment Architecture

### 19.1 Docker Compose (Single-Server)

```yaml
version: '3.8'

services:
  # Frontend (Next.js)
  frontend:
    build: ./frontend
    ports: ["3000:3000"]
    environment:
      - NEXT_PUBLIC_API_URL=http://backend:4000
      - NEXT_PUBLIC_WS_URL=http://backend:4000

  # Backend API (NestJS)
  backend:
    build: ./backend
    ports: ["4000:4000"]
    depends_on: [postgres, redis, minio, opensearch]
    environment:
      - DATABASE_URL=postgresql://trackforge:trackforge@postgres:5432/trackforge
      - REDIS_URL=redis://redis:6379/0
      - OPENSEARCH_URL=http://opensearch:9200
      - MINIO_ENDPOINT=minio:9000
      - MINIO_ACCESS_KEY=trackforge
      - MINIO_SECRET_KEY=trackforge12345
      - JWT_SECRET=${JWT_SECRET}
      - SMTP_HOST=${SMTP_HOST}
      - SMTP_PORT=${SMTP_PORT}

  # Background worker (BullMQ)
  worker:
    build: ./backend
    command: node dist/worker.js
    depends_on: [redis, postgres, opensearch]
    environment:
      - DATABASE_URL=postgresql://trackforge:trackforge@postgres:5432/trackforge
      - REDIS_URL=redis://redis:6379/0

  # Database
  postgres:
    image: postgres:16-alpine
    ports: ["5432:5432"]
    environment:
      POSTGRES_DB: trackforge
      POSTGRES_USER: trackforge
      POSTGRES_PASSWORD: trackforge
    volumes: ["pgdata:/var/lib/postgresql/data"]

  # Search index
  opensearch:
    image: opensearchproject/opensearch:2.12.0
    ports: ["9200:9200"]
    environment:
      - discovery.type=single-node
      - DISABLE_SECURITY_PLUGIN=true
      - "OPENSEARCH_JAVA_OPTS=-Xms512m -Xmx512m"
    volumes: ["osdata:/usr/share/opensearch/data"]

  # Cache + message broker
  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  # Object storage
  minio:
    image: minio/minio
    ports: ["9000:9000", "9001:9001"]
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: trackforge
      MINIO_ROOT_PASSWORD: trackforge12345
    volumes: ["miniodata:/data"]

  # Reverse proxy
  nginx:
    image: nginx:alpine
    ports: ["80:80", "443:443"]
    volumes:
      - ./nginx.conf:/etc/nginx/nginx.conf
      - ./ssl:/etc/nginx/ssl
    depends_on: [frontend, backend]

volumes:
  pgdata:
  osdata:
  miniodata:
```

### 19.2 Hardware Requirements

| Component | Minimum | Recommended |
|---|---|---|
| CPU | 4 cores | 8 cores |
| RAM | 8 GB | 16 GB (OpenSearch is memory-heavy) |
| Storage | 50 GB | 200 GB+ (attachments) |
| Network | Any | Broadband (for webhooks/email) |

### 19.3 Backup Strategy

| Data | Method | Frequency |
|---|---|---|
| PostgreSQL | `pg_dump` + compressed backup | Daily (automated cron) |
| OpenSearch | Snapshot to MinIO bucket | Daily |
| MinIO (attachments) | `mc mirror` to backup bucket or external S3 | Daily |
| Redis | RDB snapshot | Hourly (cache only — non-critical) |
| Config | Version-controlled in Git | On change |

---

## 20. Jira Compatibility & Migration

This section details the complete migration pipeline — the critical feature that enables moving all Jira projects to TrackForge with minimal effort.

### 20.1 Migration Sources

| Source | Method | Scope |
|---|---|---|
| **Jira Server / Data Center** | XML backup import (zip upload) | Full: projects, issues, users, configs, attachments, history, comments, worklogs |
| **Jira Cloud** | REST API export (authenticated pull) | Full: projects, issues, users, configs, attachments (via API) |
| **Jira CSV export** | CSV import with field mapping | Partial: issues only (no history, comments, attachments) |
| **Jira JSON export** | JSON import (from REST API or custom export) | Configurable: whatever is in the JSON |

### 20.2 Migration Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                     MIGRATION PIPELINE                               │
│                                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ Jira XML │  │ Jira API │  │ CSV File │  │ JSON File│           │
│  │ Backup   │  │ Export   │  │ Upload   │  │ Upload   │           │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘           │
│       │              │              │              │                 │
│       ▼              ▼              ▼              ▼                 │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │              Source Adapter (Strategy Pattern)           │       │
│  │  Parses source format into normalized intermediate       │       │
│  │  representation (IR) — common data structure             │       │
│  └────────────────────────┬────────────────────────────────┘       │
│                           │                                          │
│                           ▼                                          │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │              Mapping & Transformation Layer              │       │
│  │  • User mapping (Jira user → TrackForge user)           │       │
│  │  • Field mapping (Jira custom field IDs → TF field IDs) │       │
│  │  • Status mapping (Jira statuses → TF statuses)         │       │
│  │  • Workflow mapping (Jira workflows → TF workflows)     │       │
│  │  • Project key mapping (optional rename)                │       │
│  │  • Attachment download & re-upload to MinIO             │       │
│  └────────────────────────┬────────────────────────────────┘       │
│                           │                                          │
│                           ▼                                          │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │              Import Engine (batch processor)             │       │
│  │  1. Create/update project configuration (schemes)       │       │
│  │  2. Create/update users and groups                       │       │
│  │  3. Create components and versions                       │       │
│  │  4. Create issues (preserving keys, dates, history)      │       │
│  │  5. Import comments, worklogs, attachments               │       │
│  │  6. Create issue links                                   │       │
│  │  7. Import sprints and board configurations              │       │
│  │  8. Import saved filters and dashboards                  │       │
│  │  9. Rebuild OpenSearch index                              │       │
│  └────────────────────────┬────────────────────────────────┘       │
│                           │                                          │
│                           ▼                                          │
│  ┌─────────────────────────────────────────────────────────┐       │
│  │              Validation & Report                         │       │
│  │  • Issue count comparison (source vs target)             │       │
│  │  • Error log (failed imports with reasons)               │       │
│  │  • Warning log (data that was transformed/lost)          │       │
│  │  • User mapping report (unmapped users)                  │       │
│  │  • Field mapping report (unmapped fields)                │       │
│  └─────────────────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────────────────┘
```

### 20.3 Jira XML Backup Import (Server / Data Center)

Jira Server/DC can export a full XML backup (zip containing `entities.xml` + attachments). TrackForge parses this:

**XML Structure (Jira entities.xml):**
```xml
<Entities>
  <User username="juan" .../>
  <Group name="developers" .../>
  <Project id="10000" key="TF" name="TrackForge" .../>
  <Issue id="10001" key="TF-1" project="10000" .../>
  <ChangeItem .../>
  <ChangeGroup .../>
  <Comment .../>
  <Worklog .../>
  <FileAttachment .../>
  <IssueLink .../>
  <CustomField .../>
  <CustomFieldValue .../>
  <Status .../>
  <Priority .../>
  <Resolution .../>
  <Version .../>
  <Component .../>
  <Sprint .../>
  <Board .../>
  ...
</Entities>
```

**Import Steps:**
1. Admin uploads XML zip via migration UI
2. System unzips and parses `entities.xml` (streaming XML parser for large files)
3. Attachments extracted from zip and stored in MinIO
4. User mapping UI presented (match Jira users to TrackForge users, or create new)
5. Field mapping UI presented (match Jira custom fields to TrackForge fields, or create new)
6. Background job processes import in batches (1000 issues/batch)
7. Progress shown via WebSocket (processed/total, current batch, errors)
8. On completion, validation report displayed

### 20.4 Jira Cloud REST API Import

For Jira Cloud, there's no XML backup. Instead, TrackForge connects to the Jira Cloud REST API:

**Configuration:**
```
Jira Cloud URL:    [https://yourteam.atlassian.net    ]
Admin email:       [admin@yourteam.com                ]
API token:         [********************************  ]  (Jira Cloud API token)

Projects to import:
  [✓] TF — TrackForge
  [✓] QA — Quality Assurance
  [ ] OPS — Operations

Import options:
  [✓] Include attachments (downloaded from Jira)
  [✓] Include change history
  [✓] Include comments
  [✓] Include worklogs
  [✓] Include sprints and boards
  [✓] Include saved filters
  [✓] Preserve issue keys (TF-1 stays TF-1)
  [✓] Preserve original timestamps
```

**Import Process:**
1. Admin enters Jira Cloud URL + credentials
2. TrackForge calls `GET /rest/api/2/serverInfo` to verify connectivity
3. TrackForge calls `GET /rest/api/2/project` to list available projects
4. Admin selects projects and configures options
5. Background job:
   - Fetches project config (issue types, workflows, fields, screens, schemes)
   - Fetches all users via `GET /rest/api/2/user/search`
   - Fetches all issues via `GET /rest/api/2/search` (paginated, 100/page)
   - For each issue: fetches comments, worklogs, attachments, changelog, watchers, votes
   - Downloads attachments to MinIO
   - Creates everything in TrackForge preserving keys and timestamps
6. Rebuilds OpenSearch index
7. Generates validation report

### 20.5 CSV Import

For simpler migrations or bulk issue creation:

```
┌─────────────────────────────────────────────────────────────────────┐
│  CSV IMPORT                                                         │
│                                                                      │
│  Project: [TrackForge (TF)          ]                              │
│  CSV File: [Choose file...] (UTF-8, comma-separated)               │
│                                                                      │
│  Field Mapping (auto-detected from CSV headers):                   │
│  ┌──────────────────┬──────────────────┬──────────────────────┐   │
│  │ CSV Column       │ TrackForge Field │ Preview (row 1)      │   │
│  ├──────────────────┼──────────────────┼──────────────────────┤   │
│  │ Summary          │ summary          │ Fix login bug         │   │
│  │ Issue Type       │ issuetype        │ Bug                   │   │
│  │ Priority         │ priority         │ High                  │   │
│  │ Assignee         │ assignee         │ juan                  │   │
│  │ Description      │ description      │ Token refresh fails   │   │
│  │ Story Points     │ storyPoints      │ 5                     │   │
│  │ Labels           │ labels           │ backend,urgent        │   │
│  └──────────────────┴──────────────────┴──────────────────────┘   │
│                                                                      │
│  Options:                                                           │
│    [✓] Create missing users (from Assignee/Reporter columns)       │
│    [✓] Create missing components                                    │
│    [✓] Create missing versions                                      │
│    [ ] Map CSV values to existing options (for select fields)       │
│                                                                      │
│  [Import]  [Cancel]                                                 │
└─────────────────────────────────────────────────────────────────────┘
```

### 20.6 User Mapping

Critical step — Jira users must be mapped to TrackForge users:

```
┌─────────────────────────────────────────────────────────────────────┐
│  USER MAPPING — 23 Jira users found                                 │
│                                                                      │
│  ┌──────────────────┬──────────────────┬──────────────────────┐   │
│  │ Jira User        │ TrackForge User  │ Action               │   │
│  ├──────────────────┼──────────────────┼──────────────────────┤   │
│  │ juan (juan@co.)  │ juan (matched)   │ ✓ Auto-matched       │   │
│  │ maria (maria@..) │ maria (matched)  │ ✓ Auto-matched       │   │
│  │ carlos (car@co)  │ —                │ [Create new user ▾]  │   │
│  │ olduser (x@x)    │ —                │ [Map to... ▾]        │   │
│  │ admin (admin@)   │ admin (matched)  │ ✓ Auto-matched       │   │
│  └──────────────────┴──────────────────┴──────────────────────┘   │
│                                                                      │
│  [Auto-match by email]  [Auto-match by username]                    │
│  [Continue]                                                          │
└─────────────────────────────────────────────────────────────────────┘
```

### 20.7 Field Mapping

Jira custom fields have numeric IDs (e.g., `customfield_10001`). These must be mapped to TrackForge custom fields:

```
┌─────────────────────────────────────────────────────────────────────┐
│  FIELD MAPPING — 12 custom fields found                             │
│                                                                      │
│  ┌──────────────────────┬──────────────────────┬──────────────┐   │
│  │ Jira Custom Field    │ TrackForge Field     │ Action       │   │
│  ├──────────────────────┼──────────────────────┼──────────────┤   │
│  │ customfield_10001    │ Story Points         │ ✓ Auto-mapped│   │
│  │ (Story Points, num)  │ (storyPoints, num)   │              │   │
│  │ customfield_10002    │ Epic Link            │ ✓ Auto-mapped│   │
│  │ (Epic Link, link)    │ (epicLink, link)     │              │   │
│  │ customfield_10003    │ Sprint               │ ✓ Auto-mapped│   │
│  │ (Sprint, sprint)     │ (sprint, sprint)     │              │   │
│  │ customfield_10004    │ —                    │ [Create new ▾]│  │
│  │ (Risk Level, select) │                      │              │   │
│  └──────────────────────┴──────────────────────┴──────────────┘   │
│                                                                      │
│  [Continue]                                                          │
└─────────────────────────────────────────────────────────────────────┘
```

### 20.8 Migration Validation Report

```
┌─────────────────────────────────────────────────────────────────────┐
│  MIGRATION REPORT — Import from Jira XML                            │
│  Status: ✅ Completed with warnings                                 │
│  Duration: 12m 34s                                                  │
│                                                                      │
│  ── Summary ──────────────────────────────────────────────          │
│  Projects imported:     3                                           │
│  Issues imported:       4,872 / 4,875 (3 failed)                   │
│  Comments imported:     12,341                                      │
│  Attachments imported:  892                                         │
│  Worklogs imported:     1,205                                       │
│  Users mapped:          23 / 25 (2 unmapped — assigned to admin)   │
│  Custom fields mapped:  12 / 12                                     │
│  Sprints imported:      18                                          │
│  Boards imported:       3                                           │
│  Saved filters imported: 7                                          │
│                                                                      │
│  ── Errors (3) ───────────────────────────────────────────          │
│  1. TF-0451: Failed to import — invalid status "Deprecated"        │
│     → Issue skipped. Manual review needed.                         │
│  2. TF-0999: Failed to import — parent issue TF-0998 not found     │
│     → Subtask skipped. Import parent first.                        │
│  3. QA-0123: Failed to import — custom field value out of range    │
│     → Value "Critical+" not in TrackForge options. Skipped field.  │
│                                                                      │
│  ── Warnings (15) ────────────────────────────────────────          │
│  1. User "olduser" not mapped — 45 issues reassigned to "admin"    │
│  2. Workflow "Custom Bug Flow" simplified — 2 post-functions       │
│     not supported (type: "script_runner") — manual setup needed    │
│  3. 3 attachments larger than 100MB — skipped                      │
│  ... (12 more)                                                     │
│                                                                      │
│  [Download full report (JSON)]  [Download errors (CSV)]            │
│  [View failed issues]  [Done]                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### 20.9 Migration UI Flow

```
Step 1: Choose source type
  ○ Jira XML backup (Server/DC)
  ● Jira Cloud REST API
  ○ CSV file
  ○ JSON file
  [Next →]

Step 2: Configure connection (for API) / Upload file (for XML/CSV)
  [Enter Jira URL + credentials  OR  Upload file]
  [Next →]

Step 3: Select projects
  [Checkboxes for available projects]
  [Next →]

Step 4: User mapping
  [Auto-match + manual override table]
  [Next →]

Step 5: Field mapping
  [Auto-match + manual override table]
  [Next →]

Step 6: Import options
  [Checkboxes: attachments, history, comments, etc.]
  [Start Import →]

Step 7: Progress (real-time via WebSocket)
  [Progress bar + live log + error feed]
  [Wait for completion]

Step 8: Validation report
  [Summary + errors + warnings + downloads]
  [Done]
```

### 20.10 Export for Round-Trip Migration

TrackForge can also export data back in Jira-compatible formats:

| Export Format | Scope | Use Case |
|---|---|---|
| **Jira XML** | Full system | Migrate back to Jira Server/DC |
| **Jira REST JSON** | Per-project | Import into Jira Cloud via API |
| **CSV** | Issue list | Bulk export for spreadsheets |
| **TrackForge JSON** | Full system | Backup/restore or migrate to another TrackForge instance |

---

## 21. Software Design Patterns

This section documents the explicit design pattern selection for TrackForge's architecture. Each pattern is chosen for its suitability to the specific problem domain and is mapped to the component where it applies.

### 21.1 Pattern Overview

| Pattern | Category | Applied To |
|---|---|---|
| **State Machine** | Behavioral | Workflow Engine — issue status transitions |
| **Strategy** | Behavioral | Custom field types, notification channels, report generators, migration sources |
| **Factory Method** | Creational | Issue creation, gadget creation, screen rendering |
| **Abstract Factory** | Creational | Jira API v2/v3 response format factories |
| **Adapter** | Structural | Jira REST API compatibility layer (Jira format ↔ internal format) |
| **Observer / Event Sourcing** | Behavioral | Issue change events → notifications, audit, indexing, webhooks |
| **Chain of Responsibility** | Behavioral | Workflow transition pipeline (conditions → validators → post-functions) |
| **Specification** | Behavioral | JQL query engine (field predicates composed with AND/OR/NOT) |
| **Repository** | Structural | Data access layer (abstracts Prisma/PostgreSQL) |
| **Unit of Work** | Structural | Transactional issue operations (create issue + comments + links atomically) |
| **Command** | Behavioral | Issue operations (create, edit, transition, comment) as reversible commands |
| **Decorator** | Structural | Field renderers (wiki markup, plain text, ADF) wrapping base field display |
| **Plugin / Module** | Structural | Extensibility system for custom post-functions, conditions, validators |
| **Builder** | Creational | Complex query construction (JQL → OpenSearch DSL) |
| **Facade** | Structural | Migration service (simplifies complex multi-step import pipeline) |
| **Mediator** | Behavioral | Board state synchronization (WebSocket updates between clients) |
| **Template Method** | Behavioral | Report generation (common structure, subclass-specific data fetching) |
| **Memento** | Behavioral | Issue change history (store state snapshots for undo/audit) |

### 21.2 State Machine Pattern — Workflow Engine

**Problem**: Issues flow through configurable state machines with complex transition rules.

**Solution**: Each issue's lifecycle is governed by a State Machine instance:

```typescript
interface WorkflowState {
  statusId: string;
  name: string;
  category: 'todo' | 'in_progress' | 'done';
}

interface WorkflowTransition {
  id: string;
  name: string;
  sourceState: WorkflowState;
  targetState: WorkflowState;
  conditions: Condition[];
  validators: Validator[];
  postFunctions: PostFunction[];
}

class IssueStateMachine {
  private current: WorkflowState;
  private transitions: Map<string, WorkflowTransition>;

  canExecute(transitionId: string, context: TransitionContext): boolean {
    const t = this.transitions.get(transitionId);
    if (!t || t.sourceState !== this.current) return false;
    return t.conditions.every(c => c.evaluate(context));
  }

  execute(transitionId: string, context: TransitionContext): TransitionResult {
    if (!this.canExecute(transitionId, context))
      throw new InvalidTransitionError();

    const t = this.transitions.get(transitionId);

    // Run validators
    for (const v of t.validators) {
      const result = v.validate(context);
      if (!result.valid) throw new ValidationError(result.message);
    }

    // Change state
    const oldState = this.current;
    this.current = t.targetState;

    // Run post-functions
    for (const pf of t.postFunctions) {
      pf.execute(context);
    }

    return { from: oldState, to: t.targetState, transition: t };
  }
}
```

**Why State Machine**: Workflows are literally state machines. This pattern directly models the domain, makes transitions explicit, and enforces valid paths. Jira itself uses this pattern internally.

### 21.3 Strategy Pattern — Pluggable Behaviors

**Problem**: Multiple algorithms for the same operation (field rendering, notification delivery, report generation, migration source parsing).

**Solution**: Strategy interfaces with swappable implementations:

```typescript
// --- Custom Field Strategies ---
interface FieldTypeStrategy {
  type: string;
  validate(value: unknown): boolean;
  serialize(value: unknown): FieldValue;
  deserialize(raw: FieldValue): unknown;
  render(value: unknown): string;
  toJQLPredicate(field: string, op: string, value: string): object;
}

class TextFieldStrategy implements FieldTypeStrategy { ... }
class NumberFieldStrategy implements FieldTypeStrategy { ... }
class UserPickerFieldStrategy implements FieldTypeStrategy { ... }
class SelectFieldStrategy implements FieldTypeStrategy { ... }

// Registry
const fieldStrategies = new Map<string, FieldTypeStrategy>();
fieldStrategies.set('text', new TextFieldStrategy());
fieldStrategies.set('number', new NumberFieldStrategy());
// ...

// --- Notification Channel Strategies ---
interface NotificationChannelStrategy {
  channel: string;
  send(notification: Notification, recipients: User[]): Promise<void>;
}

class EmailChannelStrategy implements NotificationChannelStrategy { ... }
class InAppChannelStrategy implements NotificationChannelStrategy { ... }
class WebhookChannelStrategy implements NotificationChannelStrategy { ... }

// --- Report Generator Strategies ---
interface ReportStrategy {
  type: string;
  generate(params: ReportParams): ReportData;
}

class BurndownReportStrategy implements ReportStrategy { ... }
class VelocityReportStrategy implements ReportStrategy { ... }
class CFDReportStrategy implements ReportStrategy { ... }
class ControlChartReportStrategy implements ReportStrategy { ... }

// --- Migration Source Strategies ---
interface MigrationSourceStrategy {
  sourceType: string;
  parse(input: Buffer | ConnectionConfig): IntermediateRepresentation;
}

class JiraXmlSourceStrategy implements MigrationSourceStrategy { ... }
class JiraApiSourceStrategy implements MigrationSourceStrategy { ... }
class CsvSourceStrategy implements MigrationSourceStrategy { ... }
```

**Why Strategy**: Each field type, notification channel, report type, and migration source has the same interface but different behavior. New types can be added without modifying existing code — **Open/Closed Principle**.

### 21.4 Adapter Pattern — Jira API Compatibility Layer

**Problem**: TrackForge's internal data model differs from Jira's API format. Existing Jira integrations must work unchanged.

**Solution**: Adapter wraps internal services to expose Jira-compatible request/response:

```typescript
// Jira v2 adapter
class JiraV2IssueAdapter {
  constructor(private issueService: IssueService) {}

  async getIssue(key: string): Promise<JiraV2Issue> {
    const internal = await this.issueService.getByKey(key);
    return this.toJiraV2Format(internal);
  }

  async createIssue(input: JiraV2CreateInput): Promise<JiraV2CreateResponse> {
    const internal = this.fromJiraV2Format(input);
    const created = await this.issueService.create(internal);
    return { key: created.key, id: created.id, self: `/rest/api/2/issue/${created.key}` };
  }

  private toJiraV2Format(issue: InternalIssue): JiraV2Issue {
    return {
      id: issue.id,
      key: issue.key,
      fields: {
        summary: issue.summary,
        description: issue.description,  // plain text for v2
        issuetype: { id: issue.issueTypeId, name: issue.issueTypeName },
        status: { id: issue.statusId, name: issue.statusName, statusCategory: { key: issue.statusCategory } },
        priority: { id: issue.priorityId, name: issue.priorityName },
        assignee: issue.assigneeId ? { name: issue.assigneeUsername } : null,
        reporter: { name: issue.reporterUsername },
        created: issue.createdAt.toISOString(),
        updated: issue.updatedAt.toISOString(),
        // ... map all Jira fields
      },
      changelog: { histories: issue.changes.map(c => ({ ... })) },
      renderedFields: { description: renderMarkdown(issue.description) },
    };
  }
}

// Jira v3 adapter (ADF format)
class JiraV3IssueAdapter {
  async getIssue(key: string): Promise<JiraV3Issue> {
    const internal = await this.issueService.getByKey(key);
    return {
      ...this.toJiraV2Format(internal),  // base fields same
      fields: {
        ...this.toJiraV2Format(internal).fields,
        description: markdownToADF(internal.description),  // ADF for v3
      },
    };
  }
}
```

**Why Adapter**: Decouples internal model from external API format. Both v2 and v3 can coexist by wrapping the same internal service differently. If Jira changes their API, only the adapter changes.

### 21.5 Observer / Event Sourcing — Issue Change Events

**Problem**: When an issue changes, multiple subsystems must react (notifications, audit log, search index, webhooks) without coupling.

**Solution**: Event-driven architecture with pub/sub:

```typescript
// Event types
interface IssueEvent {
  type: string;
  issueKey: string;
  userId: string;
  timestamp: Date;
  changes?: FieldChange[];
}

// Event bus (Redis pub/sub)
class EventBus {
  async publish(event: IssueEvent): Promise<void> {
    await redis.publish(`events:${event.type}`, JSON.stringify(event));
  }

  subscribe(eventType: string, handler: (event: IssueEvent) => void): void {
    redis.subscribe(`events:${eventType}`, (msg) => handler(JSON.parse(msg)));
  }
}

// Subscribers (Observers)
class NotificationSubscriber {
  onIssueUpdated(event: IssueEvent) {
    // Resolve notification scheme → send emails/in-app/webhooks
  }
}

class AuditSubscriber {
  onIssueUpdated(event: IssueEvent) {
    // Write to audit_log table
  }
}

class SearchIndexSubscriber {
  onIssueUpdated(event: IssueEvent) {
    // Reindex issue in OpenSearch
  }
}

class WebhookSubscriber {
  onIssueUpdated(event: IssueEvent) {
    // Fire configured webhooks for this project
  }
}
```

**Why Observer**: Decouples the issue service from notification, audit, indexing, and webhook subsystems. New subscribers can be added without modifying the issue service. Each subscriber handles failures independently — a webhook failure doesn't block notifications.

### 21.6 Chain of Responsibility — Transition Pipeline

**Problem**: Workflow transitions have ordered steps: conditions → validators → state change → post-functions. Each step can abort the chain.

**Solution**: Chain of Responsibility processes the transition:

```typescript
interface TransitionHandler {
  handle(context: TransitionContext): Promise<TransitionResult | null>;
}

class ConditionHandler implements TransitionHandler {
  async handle(ctx: TransitionContext) {
    for (const condition of ctx.transition.conditions) {
      if (!condition.evaluate(ctx)) {
        return { success: false, error: 'Condition not met' };
      }
    }
    return null; // continue chain
  }
}

class ValidatorHandler implements TransitionHandler {
  async handle(ctx: TransitionContext) {
    for (const validator of ctx.transition.validators) {
      const result = validator.validate(ctx);
      if (!result.valid) return { success: false, error: result.message };
    }
    return null;
  }
}

class StateChangeHandler implements TransitionHandler {
  async handle(ctx: TransitionContext) {
    ctx.issue.statusId = ctx.transition.targetStatusId;
    await ctx.issueRepository.save(ctx.issue);
    return null;
  }
}

class PostFunctionHandler implements TransitionHandler {
  async handle(ctx: TransitionContext) {
    for (const pf of ctx.transition.postFunctions) {
      await pf.execute(ctx);
    }
    return { success: true };
  }
}

// Chain assembly
const chain = [
  new ConditionHandler(),
  new ValidatorHandler(),
  new StateChangeHandler(),
  new PostFunctionHandler(),
];

async function executeTransition(ctx: TransitionContext) {
  for (const handler of chain) {
    const result = await handler.handle(ctx);
    if (result !== null) return result;
  }
}
```

### 21.7 Specification Pattern — JQL Engine

**Problem**: JQL queries compose field predicates with AND/OR/NOT. Need a way to evaluate these against issues and translate to OpenSearch queries.

**Solution**: Specification pattern with composable predicates:

```typescript
interface Specification<T> {
  isSatisfiedBy(entity: T): boolean;
  toOpenSearchQuery(): object;
}

class FieldEqualsSpec implements Specification<Issue> {
  constructor(private field: string, private value: unknown) {}

  isSatisfiedBy(issue: Issue): boolean {
    return issue[this.field] === this.value;
  }

  toOpenSearchQuery(): object {
    return { term: { [this.field]: this.value } };
  }
}

class AndSpec implements Specification<Issue> {
  constructor(private specs: Specification<Issue>[]) {}

  isSatisfiedBy(issue: Issue): boolean {
    return this.specs.every(s => s.isSatisfiedBy(issue));
  }

  toOpenSearchQuery(): object {
    return { bool: { must: this.specs.map(s => s.toOpenSearchQuery()) } };
  }
}

class OrSpec implements Specification<Issue> {
  constructor(private specs: Specification<Issue>[]) {}

  isSatisfiedBy(issue: Issue): boolean {
    return this.specs.some(s => s.isSatisfiedBy(issue));
  }

  toOpenSearchQuery(): object {
    return { bool: { should: this.specs.map(s => s.toOpenSearchQuery()) } };
  }
}

class NotSpec implements Specification<Issue> {
  constructor(private spec: Specification<Issue>) {}

  isSatisfiedBy(issue: Issue): boolean {
    return !this.spec.isSatisfiedBy(issue);
  }

  toOpenSearchQuery(): object {
    return { bool: { must_not: this.spec.toOpenSearchQuery() } };
  }
}

// JQL parser produces specification tree
// "project = TF AND priority >= High"
// → new AndSpec([
//     new FieldEqualsSpec('project', 'TF'),
//     new FieldGteSpec('priority', 'High')
//   ])
```

### 21.8 Repository + Unit of Work — Data Access

**Problem**: Need clean data access abstraction and atomic transactions for complex issue operations.

**Solution**:

```typescript
// Repository — abstracts data access
interface IssueRepository {
  findById(id: string): Promise<Issue | null>;
  findByKey(key: string): Promise<Issue | null>;
  search(spec: Specification<Issue>, pagination: Pagination): Promise<Issue[]>;
  save(issue: Issue): Promise<Issue>;
  delete(id: string): Promise<void>;
}

class PrismaIssueRepository implements IssueRepository {
  constructor(private prisma: PrismaClient) {}

  async findByKey(key: string): Promise<Issue | null> {
    const row = await this.prisma.issue.findUnique({ where: { key } });
    return row ? this.toDomain(row) : null;
  }
  // ...
}

// Unit of Work — atomic transactions
interface UnitOfWork {
  begin(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

class IssueCreationUoW {
  constructor(
    private uow: UnitOfWork,
    private issueRepo: IssueRepository,
    private commentRepo: CommentRepository,
    private linkRepo: IssueLinkRepository,
  ) {}

  async execute(input: CreateIssueInput): Promise<Issue> {
    await this.uow.begin();
    try {
      const issue = await this.issueRepo.save(input.issue);
      if (input.comments) {
        for (const c of input.comments)
          await this.commentRepo.save({ ...c, issueId: issue.id });
      }
      if (input.links) {
        for (const l of input.links)
          await this.linkRepo.save({ ...l, sourceIssueId: issue.id });
      }
      await this.uow.commit();
      return issue;
    } catch (e) {
      await this.uow.rollback();
      throw e;
    }
  }
}
```

### 21.9 Factory Method — Issue & Gadget Creation

```typescript
// Issue factory — creates issues with correct defaults per type
interface IssueFactory {
  create(type: IssueType, project: Project, input: CreateInput): Issue;
}

class ScrumIssueFactory implements IssueFactory {
  create(type: IssueType, project: Project, input: CreateInput): Issue {
    const issue = new Issue();
    issue.projectId = project.id;
    issue.issueTypeId = type.id;
    issue.statusId = this.getInitialStatus(type);
    issue.priorityId = this.getDefaultPriority();
    issue.rank = this.generateInitialRank();
    issue.key = `${project.key}-${this.nextIssueNumber(project)}`;
    // Apply field configuration defaults
    this.applyFieldDefaults(issue, project, type);
    return issue;
  }
}

// Gadget factory — creates dashboard gadgets by type
interface GadgetFactory {
  create(type: string, config: GadgetConfig): Gadget;
}

class DashboardGadgetFactory implements GadgetFactory {
  private creators = new Map<string, (config) => Gadget>();

  constructor() {
    this.creators.set('assigned-to-me', (c) => new AssignedToMeGadget(c));
    this.creators.set('pie-chart', (c) => new PieChartGadget(c));
    this.creators.set('burndown', (c) => new BurndownGadget(c));
    // ...
  }

  create(type: string, config: GadgetConfig): Gadget {
    const creator = this.creators.get(type);
    if (!creator) throw new UnknownGadgetError(type);
    return creator(config);
  }
}
```

### 21.10 Builder Pattern — JQL to OpenSearch

```typescript
class OpenSearchQueryBuilder {
  private query: any = {};

  must(clause: object): this {
    if (!this.query.bool) this.query.bool = {};
    if (!this.query.bool.must) this.query.bool.must = [];
    this.query.bool.must.push(clause);
    return this;
  }

  should(clauses: object[]): this {
    if (!this.query.bool) this.query.bool = {};
    this.query.bool.should = clauses;
    return this;
  }

  mustNot(clause: object): this {
    if (!this.query.bool) this.query.bool = {};
    if (!this.query.bool.must_not) this.query.bool.must_not = [];
    this.query.bool.must_not.push(clause);
    return this;
  }

  sort(field: string, order: 'asc' | 'desc'): this {
    if (!this.query.sort) this.query.sort = [];
    this.query.sort.push({ [field]: { order } });
    return this;
  }

  from(offset: number): this { this.query.from = offset; return this; }
  size(limit: number): this { this.query.size = limit; return this; }

  build(): object { return this.query; }
}

// Usage: JQL "project = TF AND priority >= High ORDER BY updated DESC"
const osQuery = new OpenSearchQueryBuilder()
  .must({ term: { project_key: 'TF' } })
  .must({ range: { priority_sequence: { gte: 3 } } })  // High = seq 3
  .sort('updated_at', 'desc')
  .from(0)
  .size(50)
  .build();
```

### 21.11 Decorator Pattern — Field Renderers

```typescript
interface FieldRenderer {
  render(value: unknown): string;
}

class PlainTextRenderer implements FieldRenderer {
  render(value: string): string { return value; }
}

class WikiMarkupDecorator implements FieldRenderer {
  constructor(private wrapped: FieldRenderer) {}
  render(value: string): string {
    const plain = this.wrapped.render(value);
    return wikiToHtml(plain);
  }
}

class ADFDecorator implements FieldRenderer {
  constructor(private wrapped: FieldRenderer) {}
  render(value: string): string {
    const plain = this.wrapped.render(value);
    return adfToHtml(markdownToADF(plain));
  }
}

// Usage: choose renderer based on API version
const v2Renderer = new WikiMarkupDecorator(new PlainTextRenderer());
const v3Renderer = new ADFDecorator(new PlainTextRenderer());
```

### 21.12 Facade Pattern — Migration Service

```typescript
class MigrationFacade {
  constructor(
    private sourceStrategies: Map<string, MigrationSourceStrategy>,
    private userMapper: UserMapper,
    private fieldMapper: FieldMapper,
    private importEngine: ImportEngine,
    private validator: MigrationValidator,
  ) {}

  async migrate(request: MigrationRequest): Promise<MigrationResult> {
    // 1. Parse source
    const strategy = this.sourceStrategies.get(request.sourceType);
    const ir = strategy.parse(request.input);

    // 2. Map users and fields
    const userMap = await this.userMapper.map(ir.users, request.userMapping);
    const fieldMap = await this.fieldMapper.map(ir.customFields, request.fieldMapping);

    // 3. Import
    const importResult = await this.importEngine.import(ir, {
      projects: request.projects,
      userMap,
      fieldMap,
      options: request.options,
    });

    // 4. Validate
    const report = await this.validator.validate(ir, importResult);

    return { importResult, report };
  }
}
```

### 21.13 Plugin / Module Pattern — Extensibility

```typescript
// Plugin interface for custom workflow post-functions
interface PostFunctionPlugin {
  type: string;
  execute(context: TransitionContext): Promise<void>;
  getConfigSchema(): JSONSchema;
  renderConfigUI(config: unknown): ReactComponent;
}

// Plugin registry
class PluginRegistry {
  private plugins = new Map<string, PostFunctionPlugin>();

  register(plugin: PostFunctionPlugin): void {
    this.plugins.set(plugin.type, plugin);
  }

  get(type: string): PostFunctionPlugin | undefined {
    return this.plugins.get(type);
  }
}

// Built-in plugins
registry.register(new SetFieldPostFunction());
registry.register(new AssignToCurrentUserPostFunction());
registry.register(new TriggerWebhookPostFunction());

// Custom plugins (loaded from /plugins directory)
registry.register(new CustomSlackNotificationPostFunction());
```

### 21.14 Command Pattern — Reversible Issue Operations

```typescript
interface IssueCommand {
  execute(): Promise<void>;
  undo(): Promise<void>;
  description: string;
}

class EditFieldCommand implements IssueCommand {
  constructor(
    private issue: Issue,
    private field: string,
    private newValue: unknown,
    private oldValue: unknown,
    private repo: IssueRepository,
  ) {}

  async execute() {
    this.issue[this.field] = this.newValue;
    await this.repo.save(this.issue);
  }

  async undo() {
    this.issue[this.field] = this.oldValue;
    await this.repo.save(this.issue);
  }

  get description() {
    return `Changed ${this.field} from ${this.oldValue} to ${this.newValue}`;
  }
}
```

### 21.15 Pattern Summary — SOLID Compliance

| Principle | How TrackForge Complies |
|---|---|
| **S**ingle Responsibility | Each service handles one domain (Issue, Workflow, Board, Search, Notification) |
| **O**pen/Closed | New field types, report types, notification channels, post-functions added via Strategy/Plugin without modifying existing code |
| **L**iskov Substitution | All field type strategies are interchangeable through FieldTypeStrategy interface |
| **I**nterface Segregation | Repository interfaces expose only needed methods; subscribers implement only events they care about |
| **D**ependency Inversion | Services depend on interfaces (IssueRepository, NotificationChannel), not concrete implementations; NestJS DI container wires implementations |

---

## 22. Roadmap & Phasing

### Phase 1: Foundation (Weeks 1-5)
- PostgreSQL schema + Prisma migrations
- User/group management + JWT auth
- Project CRUD + components + versions
- Issue CRUD with standard fields (summary, description, type, status, priority, assignee, reporter)
- Basic issue list view + detail view
- Standard issue types, statuses, priorities, resolutions
- REST API v2 compatible endpoints for issues and projects
- OpenSearch integration for basic search

### Phase 2: Workflows & Boards (Weeks 6-10)
- Workflow engine (State Machine pattern) with statuses, transitions
- Conditions, validators, post-functions
- Workflow designer UI
- Workflow schemes + issue type schemes
- Scrum board with drag-and-drop (@dnd-kit)
- Kanban board with WIP limits
- Board configuration (columns, swimlanes, card layout)
- Backlog view with ranking (LexoRank)
- Sprint management (create, start, close)
- Jira Agile API compatible endpoints

### Phase 3: JQL & Customization (Weeks 11-15)
- JQL parser (nearley.js grammar) + autocomplete
- JQL → OpenSearch query builder
- Saved filters with sharing + subscriptions
- Custom fields (all 20+ types) with field configurations and contexts
- Screen schemes + field configuration schemes
- Issue type schemes
- Full JQL search UI with results table
- Advanced search with field autocomplete

### Phase 4: Collaboration & Notifications (Weeks 16-19)
- Comments with @mentions and visibility restrictions
- Attachments (upload to MinIO, thumbnails)
- Worklogs + time tracking
- Issue links (blocks, relates to, duplicates, clones)
- Watchers + voting
- Notification engine (email, in-app, webhook)
- Notification schemes
- WebSocket real-time updates (board sync, notification badge)
- Activity stream

### Phase 5: Dashboards & Reports (Weeks 20-23)
- Dashboard system with 15+ gadget types
- Dashboard sharing (private, group, role, public)
- Report engine (Strategy pattern): burndown, velocity, CFD, control chart, pie, created vs resolved, average age, time tracking, workload
- Report export (PNG, CSV, PDF)
- Bulk operations (bulk edit, transition, move, delete)
- Roadmap view (epic timeline)

### Phase 6: Jira Migration & API Compatibility (Weeks 24-28)
- Jira REST API v2 full compatibility (all endpoints from Section 18.2)
- Jira REST API v3 compatibility with ADF support
- Jira Agile API full compatibility
- Migration pipeline: Jira XML backup import
- Migration pipeline: Jira Cloud REST API import
- Migration pipeline: CSV import with field mapping
- User mapping UI
- Field mapping UI
- Migration validation report
- Export: Jira XML, JSON, CSV
- Webhook registration + delivery

### Phase 7: Polish & Hardening (Weeks 29-32)
- Permission schemes + issue security
- Audit log for all operations
- 2FA (TOTP)
- OIDC SSO integration
- API token management
- Rate limiting
- i18n framework
- Accessibility audit (WCAG 2.1 AA)
- Performance optimization (query tuning, caching strategy)
- Playwright e2e test suite
- Documentation (admin guide, API reference, migration guide)

### Phase 8: Advanced (Future)
- Plugin system for custom post-functions/conditions/validators
- Cross-project boards
- Portfolio/Initiative level hierarchy
- Advanced reports (custom report builder)
- Mobile-responsive board view
- Slack/Microsoft Teams app integration
- Git integration (branch linking, PR status on issues)
- Automation rules (if-then issue automation)

---

## 23. AI-Native Control Plane

TrackForge is designed to be operable by AI agents with the same fidelity as by humans. Agent access rides on the same public API surface (`/rest/api/2/`, `/rest/agile/1.0/`) plus the TrackForge native API under `/api/internal/` and an MCP tool layer; there is no separate "agent backend". The governing principles are ratified as Constitution Principle VI and detailed in [docs/roadmap.md](../docs/roadmap.md) §3 (A1–A8):

| # | Principle | Enforced from |
|---|---|---|
| A1 | One surface — every capability reachable via public API; no UI-only features | Sprint 005 |
| A2 | Attributable — every write records actor, channel and token | Sprint 006 |
| A3 | Discoverable — metadata endpoints describe valid inputs | Sprint 007 |
| A4 | Safe to retry — `Idempotency-Key` + `dryRun` previews | Sprint 007 |
| A5 | Scoped — least-privilege agent credentials | Sprint 006 |
| A6 | Reactive — webhooks/event stream for change subscription | Sprint 011 |
| A7 | Reviewable — proposal/approval flows + undoable history | Sprint 012 |
| A8 | Token-efficient — `fields`/`expand` selection, actionable errors | Sprint 007 |

A feature that only works through the UI is not considered done.

---

## Appendix A: Jira Feature Parity Checklist

| Jira Feature | TrackForge Status | Phase |
|---|---|---|
| Projects (Scrum/Kanban) | ✅ Full | P1 |
| Issues (all types) | ✅ Full | P1 |
| Custom Fields (20+ types) | ✅ Full | P3 |
| Workflows (visual designer) | ✅ Full | P2 |
| Workflow conditions/validators/post-functions | ✅ Full | P2 |
| Scrum Boards | ✅ Full | P2 |
| Kanban Boards | ✅ Full | P2 |
| Backlog + Sprint Management | ✅ Full | P2 |
| JQL Search | ✅ Full | P3 |
| Saved Filters + Subscriptions | ✅ Full | P3 |
| Dashboards + Gadgets | ✅ Full | P5 |
| Reports (all types) | ✅ Full | P5 |
| Time Tracking + Worklogs | ✅ Full | P4 |
| Comments + @Mentions | ✅ Full | P4 |
| Attachments | ✅ Full | P4 |
| Issue Links | ✅ Full | P4 |
| Watchers + Voting | ✅ Full | P4 |
| Notifications (email/in-app/webhook) | ✅ Full | P4 |
| Permission Schemes | ✅ Full | P7 |
| Issue Security | ✅ Full | P7 |
| Project Roles | ✅ Full | P7 |
| Components + Versions | ✅ Full | P1 |
| Bulk Operations | ✅ Full | P5 |
| Roadmap | ✅ Full | P5 |
| REST API v2 | ✅ Full | P6 |
| REST API v3 (ADF) | ✅ Full | P6 |
| Agile API | ✅ Full | P6 |
| Webhooks | ✅ Full | P6 |
| Jira XML Import | ✅ Full | P6 |
| Jira Cloud API Import | ✅ Full | P6 |
| CSV Import | ✅ Full | P6 |
| Audit Log | ✅ Full | P7 |
| 2FA | ✅ Full | P7 |
| SSO (OIDC) | ✅ Full | P7 |
| Plugin System | 📋 Future | P8 |
| Automation Rules | 📋 Future | P8 |
| Git Integration | 📋 Future | P8 |

## Appendix B: Jira REST API Field Mapping

| Jira Field | TrackForge Internal Field | Notes |
|---|---|---|
| `summary` | `issue.summary` | Direct |
| `description` | `issue.description` | v2: plain text, v3: ADF JSON |
| `issuetype` | `issue.issue_type_id` → join `issue_type` | Object with id/name |
| `status` | `issue.status_id` → join `status` | Object with id/name/statusCategory |
| `priority` | `issue.priority_id` → join `priority` | Object with id/name |
| `assignee` | `issue.assignee_id` → join `app_user` | Object with name/displayName |
| `reporter` | `issue.reporter_id` → join `app_user` | Object with name/displayName |
| `created` | `issue.created_at` | ISO timestamp |
| `updated` | `issue.updated_at` | ISO timestamp |
| `duedate` | `issue.due_date` | Date |
| `resolution` | `issue.resolution_id` → join `resolution` | Object with id/name |
| `resolutiondate` | `issue.resolution_date` | ISO timestamp |
| `environment` | `issue.environment` | v2: plain text, v3: ADF |
| `labels` | `issue_label` join | Array of strings |
| `components` | `issue_component` join `component` | Array of objects |
| `fixVersions` | `issue_version` (fix) join `version` | Array of objects |
| `affectsVersions` | `issue_version` (affected) join `version` | Array of objects |
| `issuelinks` | `issue_link` join | Array with type + linkedIssue |
| `subtasks` | `issue` where `parent_id` = this | Array of objects |
| `customfield_*` | `custom_field_value` join | Type-specific serialization |
| `timetracking` | Computed from estimate/remaining/spent | Object with originalEstimate/remainingEstimate/timeSpent |
| `aggregatetimespent` | Sum of subtask time_spent | Computed |
| `watches` | `issue_watcher` count | Object with watchCount |
| `votes` | `issue_vote` count | Object with votes |
| `comment` | `comment` join | Object with comments array + total |
| `attachment` | `attachment` join | Array of objects |
| `worklog` | `worklog` join | Object with worklogs array + total |
| `changelog` | `issue_change` join | Object with histories array |

## Appendix C: Open-Source References

- **Plane** (github.com/makeplane/plane): Open-source Jira alternative (Python/Django + Next.js)
- **Taiga** (github.com/taigaio): Agile project management (Python/Django + Angular)
- **OpenProject** (github.com/opf/openproject): Project management (Ruby on Rails)
- **Focalboard** (github.com/mattermost/focalboard): Kanban board (Go + React)
- **Leantime** (github.com/Leantime/leantime): Project management for non-project managers (PHP)
- **OpenSearch**: Search and analytics engine (fork of Elasticsearch)
- **NestJS**: Progressive Node.js framework with DI, modules, decorators
- **@dnd-kit**: Modern, accessible drag-and-drop toolkit for React
