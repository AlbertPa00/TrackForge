# Migration compatibility (expand-contract)

Rolling deploys and the rollback rule ("DB only rolls forward") mean the
**previous app version must keep working against the new schema**. Every
migration within a release is therefore **additive-only**.

## The rule

| Allowed (expand) | Forbidden until next release (contract) |
|---|---|
| `CREATE TABLE`, `CREATE INDEX` | `DROP TABLE` |
| `ADD COLUMN` nullable / with default | `DROP COLUMN` |
| `ALTER COLUMN` widening (varchar→text) | `ALTER COLUMN TYPE` on existing data |
| new nullable FK / constraint | `RENAME`, `SET NOT NULL` (use a default first) |

## Two-release split for destructive changes

- **Release N**: code stops reading/writing the column; migration drops nothing.
- **Release N+1**: the `DROP` ships — the previous version already ignores it.

Renames = add new column + dual-write in N, drop old in N+1.

## Enforcement

`scripts/migration-compat.mjs` scans new migrations in CI (`git diff
origin/main…HEAD`) and fails on destructive SQL with the guidance above. It
verified-flagged the pre-GA history (the baseline is the first GA tag —
pre-release migrations predate the rule by design, which is why CI diffs
instead of scanning all).
