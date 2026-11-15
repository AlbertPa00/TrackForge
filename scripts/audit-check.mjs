#!/usr/bin/env node
/**
 * 016 FR security gate — `pnpm audit --prod` fails on high/critical CVEs.
 * Accepted risks live in scripts/audit-allowlist.json with a mandatory
 * `expires` date; expired entries stop applying so risks must be re-triaged.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const allow = JSON.parse(readFileSync(join(root, 'scripts/audit-allowlist.json'), 'utf8'));
const today = new Date().toISOString().slice(0, 10);
const active = allow.filter((a) => a.expires && a.expires >= today);
const expired = allow.filter((a) => !a.expires || a.expires < today);
for (const a of expired) console.warn(`allow-list entry EXPIRED (${a.expires}): ${a.id} — re-triage required`);

let out = '';
try {
  out = execSync('pnpm audit --prod --json', { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  out = e.stdout?.toString() ?? '';
  if (!out.trim()) {
    console.error(e.stderr?.toString() || String(e));
    process.exit(1);
  }
}

const data = out.trim() ? JSON.parse(out) : { advisories: [] };
const advisories = Array.isArray(data.advisories) ? data.advisories : Object.values(data.advisories ?? {});
const HIGH = new Set(['high', 'critical']);
const isAllowed = (a) =>
  active.some((x) => x.id === a.id || x.id === a.github_advisory_id || (x.url && x.url === a.url));
const bad = advisories.filter((a) => HIGH.has(a.severity) && !isAllowed(a));

if (bad.length) {
  console.error(`\n${bad.length} high/critical advisories not allow-listed:`);
  for (const a of bad) console.error(`  - [${a.severity}] ${a.title ?? a.id} ${a.url ?? ''}`);
  process.exit(1);
}
console.log(`audit clean — ${advisories.length} advisories, ${active.length} allow-listed, ${expired.length} expired`);
