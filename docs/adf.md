# ADF wire format (Sprint 040)

TrackForge stores bodies as **markdown** (D6). `/rest/api/3/` is a wire transform over the
same route stack as `/rest/api/2/` — one service layer, two serializers.

## Direction

| Boundary | Conversion | Where |
|---|---|---|
| Inbound request | every `{type:'doc'}` node → markdown (`adfToMarkdown`) | `src/lib/adfWire.ts` |
| Outbound response | `fields.description`, `fields.environment`, comment `body` → ADF (`markdownToAdf`) | `src/lib/adfWire.ts` |
| `?expand=renderedFields` | adds `renderedFields` (issue) / `renderedBody` (comment) as sanitized HTML (`marked` + `sanitize-html`) | `src/lib/adfWire.ts` |

## Supported ADF node set (lossless)

paragraph · text (bold/italic/strike/code/link marks) · heading 1-6 · bulletList ·
orderedList · codeBlock (language attr) · blockquote · rule · hardBreak ·
table/tableRow/tableCell/tableHeader · mention (`attrs.id` ⇄ `[~accountId:]` markers).

## Lossy mappings (documented degradation)

| Inbound node | Result |
|---|---|
| panel, expand, layout, decisionList, taskList | content unwrapped into surrounding block text |
| status lozenge | plain `[text]` |
| media/mediaSingle/mediaGroup | `url`/`file` link text when attrs present, else dropped |
| embedCard, inlineCard, extension nodes | dropped |
| unknown nodes | children kept when textual; `x-trackforge-adf-losses` header lists each loss (non-production only) |

Empty/whitespace bodies emit the minimal valid doc `{type:'doc',version:1,content:[{type:'paragraph'}]}`.

## Divergences from Jira Cloud v3

- `accountId` — TrackForge has no Atlassian account directory; user objects carry our ids.
- `created.date`, `properties` bags — subset only.
- `bulk/*` endpoints — not mirrored (v2 parity only where listed in the sprint scope).
- MCP tools keep returning markdown — agents pick v2/MCP or v3/ADF, same truth.
