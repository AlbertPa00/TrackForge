# Sprint 046 — Hardening H6 / GA gate (absorbed)

**Status: never ran as a numbered sprint.** The hardening cadence reserved 046
for "Hardening H6 — M6 Ship & Operate — GA": the final release gate. The work
shipped split across the launch-prep sprints that did run:

| H6 gate item (cadence table) | Where it actually shipped |
|---|---|
| Full XML/CSV round-trip | 039 importer suite + `tests/integration/jiraServer*.test.ts` (048) |
| v2/v3 parity test | 040 REST v3/ADF + OpenAPI `injectV3` drift test |
| SSO/2FA pen-test checklist | 036 build + 064 pre-release security audit (`docs/pre-release-audit.md`) |
| WCAG automated pass | 037 + `apps/frontend/tests/e2e/a11y.spec.js` (axe gate) |
| 042 UX-parity ledger clean | 042 ledger + 055/058/062 follow-ups |
| Clean-VM install < 10 min | `install-smoke.yml` CI workflow |
| Restore drill | `restore-drill.yml` monthly workflow + `scripts/restore-drill.sh` |
| Deploy-pipeline dry run | 043/045 + `deploy.yml` staging→prod gate |
| GA release notes | 063 launch wedge |

Numbering skipped 046 (045 → 047) rather than renumbering — treat "sprint 046"
references in older docs as this stub. The GA gate itself is owned by
`docs/release-gates.md`, not a sprint number.
