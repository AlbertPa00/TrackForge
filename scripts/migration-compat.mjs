#!/usr/bin/env node
// 045 US2 SC-003 — expand-contract lint for migrations. Rolling deploys run
// the previous app version against the new schema, so every migration in a
// release must be backward-compatible: additive only. Destructive changes
// split across two releases (docs/migrations.md).
//
// Scans NEW migration files (git diff vs a base ref, or all when --all).
// Exit 1 on destructive SQL with the guidance.
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MIG_DIR = 'apps/backend/prisma/migrations';

// Destructive patterns (expand-contract violations). Comments/strings are
// stripped first — a `-- note` mentioning DROP is fine.
const RULES = [
  [/\bDROP\s+TABLE\b/i, 'DROP TABLE — ship in release N+1 after code stops using it'],
  [/\bDROP\s+COLUMN\b/i, 'DROP COLUMN — release N: stop writing; release N+1: drop'],
  [/\bALTER\s+COLUMN\b[^;]*\bTYPE\b/i, 'ALTER COLUMN TYPE — breaks old-version reads; use a new column + backfill'],
  [/\bRENAME\b/i, 'RENAME — old version loses the name; use add-new + dual-write'],
  [/\bSET\s+NOT\s+NULL\b/i, 'SET NOT NULL — old-version inserts can violate it; add a default first'],
  [/\bDROP\s+NOT\s+NULL\b/i, null], // widening is safe — allowed
  [/\bDROP\s+INDEX\b/i, 'DROP INDEX — verify no old-version query needs it (usually safe, flagged)'],
  [/\bDROP\s+CONSTRAINT\b/i, 'DROP CONSTRAINT — flagged: confirm old version never relies on it'],
  [/\bALTER\s+TABLE\b[^;]*\bUSING\b/i, 'ALTER ... USING — rewrite can break old-version rows'],
];

const stripComments = (sql) =>
  sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

function newMigrationFiles(base) {
  if (base === '--all') {
    return readdirSync(MIG_DIR)
      .filter((d) => /^\d{14}_/.test(d))
      .map((d) => join(MIG_DIR, d, 'migration.sql'));
  }
  let out;
  try {
    out = execSync(`git diff --name-only --diff-filter=A ${base}...HEAD -- ${MIG_DIR}`, { encoding: 'utf8' });
  } catch {
    console.error(`migration-compat: cannot diff against '${base}' — pass --all or a ref`);
    process.exit(2);
  }
  return out.trim().split('\n').filter((f) => f.endsWith('migration.sql'));
}

const base = process.argv[2] ?? 'origin/main';
const files = newMigrationFiles(base).filter(existsSync);
if (!files.length) {
  console.log('migration-compat: no new migrations — pass');
  process.exit(0);
}

let bad = 0;
for (const f of files) {
  const sql = stripComments(readFileSync(f, 'utf8'));
  for (const [re, msg] of RULES) {
    if (!msg) continue;
    if (re.test(sql)) {
      console.error(`✗ ${f}: ${msg}`);
      bad += 1;
    }
  }
}
if (bad) {
  console.error(`\nmigration-compat: ${bad} destructive statement(s) across ${files.length} migration(s).`);
  console.error('Expand-contract: additive-only within a release — see docs/migrations.md.');
  process.exit(1);
}
console.log(`migration-compat: ${files.length} new migration(s) additive-only — pass`);
