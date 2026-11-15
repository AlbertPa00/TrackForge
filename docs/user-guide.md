# TrackForge user guide

Daily-driver basics for a team working in TrackForge.

## Getting around

- **Your work** (`/`) — assigned issues, recent views, notifications.
- **Projects** (`/projects`) — the project list; click one to enter its sidebar: **Board**, **Backlog**, **Reports**, **Releases**, **Components**, **Settings**.
- **Issues** (`/issues`) — full-text + JQL search.
- **Filters** (`/filters`) — saved JQL; run, share, favourite.

## Issues

- **Create** — `c` from most pages or the Create button: project, type, summary, optional labels/components/fixVersions.
- **Browse** — `/browse/ABC-12` shows the issue. Edit any field inline (summary, description markdown, assignee, labels, estimates). Sub-tasks and linked issues live in their own sections.
- **Comments** — markdown with `@mentions`; your own comments are editable.
- **Attachments** — drag files onto the issue's Attachments section or click to browse (25MB default limit). Images get thumbnails + a lightbox; other types get an icon row. Delete your own uploads with ×.
- **Watch** — the eye icon adds you as a watcher (you'll get notifications on change).
- **Transitions** — the status lozenge offers the next workflow states; required fields (e.g. Resolution on Done) are prompted.

## Board & backlog

- **Board** — columns are workflow statuses (project admin configures them under Board → settings). Drag cards to transition; WIP limits tint over-capacity columns.
- **Backlog** — ranked list + sprint panel. Drag issues into/out of a sprint, or use Rank to top/bottom. Right-click a card for sprint/epic assignment.
- **Epics** — issues of type Epic group children; the epic panel on the board filters by epic.

## Searching (JQL)

TrackForge runs real JQL:

```
project = ABC AND status = "In Progress" AND assignee = currentUser()
fixVersion = earliestUnreleasedVersion() AND priority = High
```

Field pickers on the issue sidebar (components, fixVersions/affects, labels, assignee) all have JQL equivalents — `component`, `fixVersion`, `affectedVersion`, `labels`, `assignee`, `reporter`, `status`, `issuetype`, `priority`, `sprint`, `created`, `updated`, `resolved`, `due`, plus custom fields by name.

## Releases & components

- **Releases** (`/projects/KEY/releases`) — version cards with progress (done vs unresolved). Expand a card to see its issues grouped by status. **Release** marks it released with a date; **notes** exports markdown or CSV.
- **Components** (`/projects/KEY/components`) — the component list with lead, default assignee, issue counts; edit or delete (with a swap option to re-home issues).
- Setting **fixVersions** on issues is what feeds the release hub.

## Notifications & activity

- The bell in the top nav streams events for watched/assigned/mentioned issues; SSE keeps it live.
- The issue's **Activity** section merges comments and field-change history (changelog) — filter by tab.

## Your API token

**Settings → your profile → tokens** (or `POST /api/internal/tokens`): name it, pick scopes (`read`/`write`/`admin`), optionally allow-list it to project keys. Use it for scripts, the MCP server (`TRACKFORGE_URL` + `TRACKFORGE_TOKEN`), or any Jira-shaped REST client.
