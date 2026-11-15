# Sprint 018 — Attachments

| | |
|---|---|
| **Status** | Shipped — storage port, issue-visibility enforcement, Jira-shape `fields.attachment[]`, changelog + audit on upload/delete, mime sniff + safe-inline headers, panel + lightbox UI, MCP tool |
| **Milestone** | M1 Parity MVP |
| **Theme** | Jira parity — P0 collaboration feature |
| **Depends on** | 008 (issue page, activity), 015 (`CREATE_ATTACHMENTS`/`DELETE_ALL_ATTACHMENTS` via `permissionService`), 016 (job runner for thumbnail generation + orphan sweeps; threat-model gate), 017 (importer contract) |
| **Unblocks** | Attachment import (this sprint's `EntityImporter`), card attachment counts (033), inline images in markdown |
| **New dependencies (justify in plan)** | file-type sniffing lib (e.g. `file-type`) — server-side mime validation; image thumbnail lib (`sharp`) — thumbnails per DESIGN §8.7/Jira |
| **Spec-kit folder** | `specs/018-attachments/` |

> **Replan additions (2026-11-07):** (1) ship an `EntityImporter` for Jira Cloud attachments
> (download via the attachment `content` URL with the job's credentials, size/type limits
> applied, failures per-item in the 017 report); (2) thumbnails and orphan-file sweeps run as
> 016 jobs, not inline in the request; (3) threat-model entry for uploads (stored XSS, mime
> spoofing, zip bombs, path traversal) is a DoD item.

## Goal

Files on issues — DESIGN P0 and Appendix B `attachment` field. This sprint adds:

- a **storage port** (local filesystem now; S3/MinIO adapter shape for later per §19),
- the Jira attachment API (`POST/GET/DELETE /attachment`, `issue.fields.attachment[]`),
- the UI panel: drag-drop upload, thumbnails, preview/lightbox, delete,
- metadata (author, size, mime, created) in payloads, changelog and audit.

## Why now

Attachments are everyday-Jira and a migration hard requirement (XML backups embed file
references). Doing it before bulk ops and reports keeps those surfaces complete.

## Scope

**In**: `POST /issue/{key}/attachments` (multipart, `X-Atlassian-Token: no-check`, Jira
contract); `GET /attachment/{id}`, `/attachment/content/{id}`, `/attachment/thumbnail/{id}`,
`DELETE /attachment/{id}`; issue payload `attachment[]`; UI panel w/ drag-drop, image
thumbnails + lightbox, file-icon list for non-images; per-file size/type limits (admin
config); storage path convention `attachments/{projectId}/{issueId}/{attachmentId}`;
changelog `Attachment` items + audit; comment/issue markdown can reference attachment URLs.

**Out**: virus scanning (port exists, default no-op adapter — documented), versioned
attachments (Jira doesn't have them either), remote/object storage (adapter shape only),
inline paste into markdown editor (stretch if trivial), ZIP download of all attachments.

---

## User stories

### US1 — Upload & store (P1)

As a user, I want to attach files to an issue so evidence lives with the work.

**Independent test**: attach a PNG and a PDF to TF-1 via API and UI; reopen issue; files
download byte-identical; payload lists both.

**Acceptance scenarios**

1. **Given** `POST /issue/{key}/attachments` multipart, **When** files upload, **Then** each returns Jira's `{id, filename, size, mimeType, content, thumbnail, author, created}`; `fields.attachment[]` updates; changelog + audit record `attachment` add.
2. **Given** a file over the configured limit (default 25MB) or a disallowed type, **When** uploaded, **Then** Jira-style 413/400 with the limit in the message.
3. **Given** an image (png/jpg/gif/webp), **When** stored, **Then** a thumbnail is generated and `/thumbnail/{id}` serves it; non-images get a type icon.
4. **Given** sniffed mime differs from claimed mime (spoofed upload), **When** validated, **Then** server-side sniffing wins or rejects per policy — never serve attacker-chosen content-type.

### US2 — View, download, delete (P1)

As a user, I want to preview and manage attachments on the issue page.

**Acceptance scenarios**

1. **Given** the Attachments panel, **When** rendered, **Then** thumbnails grid (images) + list (other) with name/size/author/date; image click opens a lightbox; file click downloads via `/attachment/content/{id}` with correct `Content-Disposition`.
2. **Given** author or `DELETE_ALL_ATTACHMENTS` permission, **When** delete, **Then** file + record + thumbnails removed after confirm; changelog records removal.
3. **Given** a user without `CREATE_ATTACHMENTS` (015), **When** uploading, **Then** 403 Jira error; without `BROWSE_PROJECTS` the file URLs 404 (existence protection — files are never served without permission).
4. **Given** issue delete (008 flow), **When** confirmed, **Then** its files are removed from storage — no orphans (cascade job in same tx flow).

### US3 — Storage port (P1, architecture)

As an operator, I want storage swappable so this can move to MinIO/S3 later without code churn.

**Acceptance scenarios**

1. **Given** `ports/AttachmentStore` (`put/get/delete/thumbnailPath`), **When** `LocalFsStore` runs, **Then** all tests pass against a temp dir; a `MemoryStore` serves tests/CI.
2. **Given** configuration `ATTACHMENT_STORAGE=fs|memory`, **When** switched, **Then** no service code changes (adapter boundary, V-pattern from DESIGN §21).

---

## Edge cases

- Same filename twice: stored independently, served by id (Jira allows duplicates).
- Deleted issue's attachment URL → 404.
- Corrupt/non-decodable image: upload succeeds, thumbnail falls back to type icon.
- Attachment on a security-levelled issue (015): file routes inherit the issue's visibility.
- Storage-full/disk-error → 507-style error with retry guidance; partial uploads cleaned up.
- SVG: served with `Content-Disposition: attachment` + strict `Content-Security-Policy`
  (stored-XSS vector — never inline).

## Functional requirements

- **FR-001**: Attachment bytes MUST live behind the storage port; service code never touches `fs` directly.
- **FR-002**: Every file route MUST enforce issue visibility (`BROWSE_PROJECTS` + security level) — no open URLs, no signed-URL leaks.
- **FR-003**: `fields.attachment[]` MUST match Appendix B/Jira shape (self, id, filename, mimeType, size, created, author, content/thumbnail links).
- **FR-004**: Upload/delete MUST write changelog items + audit events (A2).
- **FR-005**: Sniffed mime MUST drive serving headers; `inline` only for safe image/pdf types.

## API surface

| Method | Path | Notes |
|---|---|---|
| POST | `/rest/api/2/issue/{key}/attachments` | Multipart, `X-Atlassian-Token: no-check` |
| GET | `/rest/api/2/attachment/{id}` | Metadata |
| GET | `/rest/api/2/attachment/content/{id}` | Bytes |
| GET | `/rest/api/2/attachment/thumbnail/{id}` | Thumb |
| DELETE | `/rest/api/2/attachment/{id}` | Author or DELETE_ALL |
| — | `issue.fields.attachment[]` | Jira array |

## Data model changes

- **Attachment**: `id`, `issueId` (FK cascade), `filename`, `mime`, `sniffedMime`, `size`,
  `storagePath`, `thumbPath?`, `authorId`, `channel`, `tokenId?`, `createdAt`.

## MCP tools added

`attach_file` (path→upload, dry-run shows size/type/limits first — A4), `list_attachments`,
`download_attachment`, `delete_attachment` (guarded).

## AI-native checklist

- [ ] Upload is idempotent-safe via `Idempotency-Key` (A4) — retries don't double-attach.
- [ ] Limits discoverable via `system/info` or createmeta (A3).
- [ ] Errors actionable: "file exceeds 25MB" not "upload failed" (A8).

## Success criteria

- **SC-001**: Round-trip: upload via UI + API + MCP, byte-identical download, thumbnail for images.
- **SC-002**: E2E: attach screenshot → visible in panel → lightbox → delete → changelog shows both events.
- **SC-003**: Spoofed `.exe`-as-`.png` rejected/never served as image; SVG forced to download.
- **SC-004**: Agent eval: "attach ./report.pdf to TF-3" succeeds with size/preview confirmation.

## Risks

| Risk | Mitigation |
|---|---|
| Stored XSS via HTML/SVG attachments | Disposition `attachment` + CSP; mime sniffing; never `inline` untrusted types |
| Disk growth unbounded | Per-file cap now; per-project quota field reserved for later |
| sharp adds native dep | Optional-dep pattern: degrade to icon fallback if native build fails (CI note) |

## Sprint-specific Definition of Done

- [ ] Common DoD in [roadmap §4](../roadmap.md#4-definition-of-done-common-to-all-sprints).
- [ ] `compat.ts` marks the attachment family full.
- [ ] Docker volume for `attachments/` documented in deployment docs.
