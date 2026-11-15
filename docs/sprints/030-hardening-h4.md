# Sprint 030 — Hardening H4 (absorbed)

**Status: never ran as a numbered sprint.** This stub exists because the
hardening cadence (`hardening-cadence.md`) and `roadmap.md` reserved 030 for
"Hardening H4 — M3 Insight & communication", and a dozen docs still reference
the number.

The planned H4 gate items landed in the hardening sprints that did run:

| H4 item (cadence table) | Where it actually shipped |
|---|---|
| Report numbers match hand-computed fixtures | `tests/integration/reports*.test.ts` — H5 (035) + reports-perf fixtures |
| Email delivery / outbox chaos test | `tests/integration/mail*.test.ts` — 029 build + 059/064 hardening |
| Dashboard per-viewer permission test | `tests/integration/dashboards*.test.ts` — 026 build + 064 gate |

The cadence doc's **intent** (a hardening gate every four feature sprints) is
preserved — the shipped sequence is 025 H3 → 035 H5 → 059 H7, with the number
030 skipped rather than renumbered. Treat "sprint 030" references in older
docs as this stub.
