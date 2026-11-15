#!/usr/bin/env node
// Release gate L3 — every command/path a doc tells a customer to run must
// exist. Scans the public docs for:
//
//   `pnpm --filter <pkg> <script>`   → workspace pkg + script must exist
//   `pnpm <script>`                  → root package.json script (builtins skipped)
//   `docker compose -f <file>`       → compose file must exist
//   [text](relative/path)            → markdown links must resolve
//
// Docs covered: README.md, CONTRIBUTING.md, VERIFY.md, docs/install.md,
// docs/mcp.md, docs/agents.md, apps/mcp/README.md. Exit 1 on any broken claim.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = [
  'README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'VERIFY.md',
  'docs/install.md', 'docs/architecture.md', 'docs/mcp.md', 'docs/agents.md',
  'apps/mcp/README.md',
];
const PKG_DIRS = ['apps/backend', 'apps/frontend', 'apps/mcp'];
const BUILTINS = new Set(['install', 'dev', 'build', 'test', 'lint', 'typecheck', 'format', 'add', 'remove', 'run', 'exec', 'dlx', 'init']);

const rootScripts = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts ?? {};
const pkgs = {}; // package-name or dir-basename → {dir, scripts} (pnpm resolves both)
for (const dir of PKG_DIRS) {
  const j = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  const entry = { dir, scripts: j.scripts ?? {} };
  pkgs[j.name] = entry;
  pkgs[dir.split('/').pop()] = entry;
}

let fail = 0;
const bad = (doc, msg) => { console.error(`  FAIL ${doc}: ${msg}`); fail++; };

for (const doc of DOCS) {
  const path = join(root, doc);
  if (!existsSync(path)) { bad(doc, 'doc listed but missing'); continue; }
  const src = readFileSync(path, 'utf8');

  for (const m of src.matchAll(/pnpm --filter\s+(?:--\S+\s+)*([@\w/-]+)\s+([a-z][a-z0-9:_-]*)/gi)) {
    const [, name, script] = m;
    if (!pkgs[name]) { bad(doc, `pnpm --filter ${name} — unknown workspace package`); continue; }
    if (!pkgs[name].scripts[script] && !BUILTINS.has(script)) {
      bad(doc, `pnpm --filter ${name} ${script} — no such script (${name} has: ${Object.keys(pkgs[name].scripts).join(', ')})`);
    }
  }

  for (const m of src.matchAll(/pnpm\s+(?!--filter\b)([a-z][a-z0-9:_-]*)/gi)) {
    const script = m[1];
    if (!rootScripts[script] && !BUILTINS.has(script)) {
      bad(doc, `pnpm ${script} — no such root script (root has: ${Object.keys(rootScripts).join(', ')})`);
    }
  }

  for (const m of src.matchAll(/docker compose(?:\.exe)?\s+(?:-f|(?:--file(?:name)?))\s*(\S+)/g)) {
    if (!existsSync(join(root, m[1]))) bad(doc, `docker compose -f ${m[1]} — file missing`);
  }

  for (const m of src.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
    const target = m[1];
    if (/^[a-z]+:/i.test(target) || target.startsWith('#') || target.includes('://') || /\$\{?\w/.test(target)) continue;
    const resolved = join(dirname(path), target);
    if (!existsSync(resolved)) bad(doc, `broken link → ${target}`);
  }
}

if (fail) { console.error(`docs-claims FAIL — ${fail} broken claim(s)`); process.exit(1); }
console.log(`docs-claims OK — ${DOCS.length} docs, commands+paths verified`);
