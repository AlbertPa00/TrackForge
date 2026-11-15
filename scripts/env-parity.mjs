#!/usr/bin/env node
// Release gate L7 — .env.example ↔ docker-compose.prod.yml parity.
//
//   a) every ${VAR} reference in the prod compose must be documented in
//      .env.example (active or commented-optional) — otherwise a fresh
//      install hits "required variable not set" or a silent empty default.
//   b) every ACTIVE key in .env.example must be consumed — by a compose
//      ${} ref, or read via process.env.* in backend src (env_file passes
//      the whole file into the container, so an unread key is a lie).
//   c) backend src process.env reads that aren't in .env.example are
//      listed as warnings (dev/test/ops vars are expected; review only).
//
// Exit 1 on any (a)/(b) failure. No deps — plain node.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const read = (p) => readFileSync(join(root, p), 'utf8');

// ── 1. .env.example keys ─────────────────────────────────────────────
const envLines = read('.env.example').split('\n');
const active = new Set();
const documented = new Set();
for (const line of envLines) {
  const m = line.match(/^\s*#\s*([A-Z_][A-Z0-9_]*)\s*=/) ?? line.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
  if (!m) continue;
  (line.trimStart().startsWith('#') ? documented : active).add(m[1]);
}

// ── 2. compose ${VAR} refs ───────────────────────────────────────────
const compose = read('docker-compose.prod.yml');
const composeRefs = new Set(
  [...compose.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]),
);

// ── 3. backend env reads — process.env.X + envSchema keys + helper calls ─
const envReads = new Map(); // var → first file
const note = (v, file) => { if (!envReads.has(v)) envReads.set(v, relative(root, file)); };
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f !== 'node_modules' && f !== 'dist' && f !== 'tests') walk(p);
    } else if (/\.tsx?$/.test(f)) {
      const src = readFileSync(p, 'utf8');
      for (const m of src.matchAll(/process\.env\.([A-Z_][A-Z0-9_]*)|process\.env\[['"]([A-Z_][A-Z0-9_]*)['"]\]/g)) {
        note(m[1] ?? m[2], p);
      }
      for (const m of src.matchAll(/\b(?:readEnv|secret)\s*\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g)) {
        note(m[1], p);
      }
    }
  }
};
walk(join(root, 'apps/backend/src'));

// zod env schema keys in config.ts declare env names without process.env.*
const configSrc = read('apps/backend/src/config.ts');
const schemaBlock = configSrc.match(/z\.object\(\{([\s\S]*?)\}\)/)?.[1] ?? '';
for (const m of schemaBlock.matchAll(/^\s*([A-Z_][A-Z0-9_]*)\s*:/gm)) {
  note(m[1], 'apps/backend/src/config.ts');
}

// ── checks ───────────────────────────────────────────────────────────
let fail = 0;
const bad = (msg) => { console.error(`  FAIL ${msg}`); fail++; };
const warn = (msg) => console.log(`  warn ${msg}`);

for (const v of composeRefs) {
  if (!active.has(v) && !documented.has(v)) {
    bad(`compose references \${${v}} but .env.example never documents it`);
  }
}
for (const v of active) {
  if (!composeRefs.has(v) && !envReads.has(v)) {
    bad(`.env.example sets ${v} but neither compose nor backend src reads it`);
  }
}
for (const [v, file] of envReads) {
  if (!active.has(v) && !documented.has(v) && !v.endsWith('_FILE')) {
    warn(`${v} read in ${file} — not in .env.example (ok if dev/ops-only, else document)`);
  }
}

// ── 4. env-reference.md parity (065 US8) ─────────────────────────────
// Every env var the backend reads must be documented in env-reference.md —
// the doc used to drift vars behind the code. Runtime/test internals are
// allowlisted; everything else is a FAIL, not a warning.
const envRef = read('docs/env-reference.md');
const ENVREF_SKIP = new Set(['NODE_ENV', 'VITEST', 'CI']);
for (const [v, file] of envReads) {
  if (ENVREF_SKIP.has(v) || v.endsWith('_FILE')) continue;
  if (!envRef.includes(v)) {
    bad(`${v} read in ${file} but not documented in docs/env-reference.md`);
  }
}
if (fail) { console.error(`env-parity FAIL — ${fail} problem(s)`); process.exit(1); }
console.log('env-parity OK');
