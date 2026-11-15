#!/usr/bin/env node
// Release gate G2.1 — zero skipped/focused tests may be committed.
//
// Forbidden in *.test.* / *.spec.* files:
//   describe.skip · it.skip · test.skip · context.skip · .todo( · .fixme(
//   xdescribe( · xit( · xtest( · fdescribe( · fit(
//   describe.only · it.only · test.only (focus — silently runs one test)
//
// Allowed: ctx.skip() — vitest's runtime conditional skip (ldap.test.ts
// uses it for "no LDAP server provisioned"); it runs the test, then
// reports a conditional result. Baseline is zero forbidden matches —
// anything found fails CI.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

const FORBIDDEN = [
  /\b(?:describe|it|test|context)\s*\.\s*(?:skip|todo|fixme)\s*\(/g,
  /\b(?:describe|it|test|context)\s*\.\s*only\s*\(/g,
  /\b[xf](?:describe|it|test|context)\s*\(/g,
];

const hits = [];
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f !== 'node_modules' && f !== 'dist' && f !== '.turbo') walk(p);
    } else if (/\.(?:test|spec)\.[jt]sx?$|\.spec\.mjs$/.test(f)) {
      const src = readFileSync(p, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (FORBIDDEN.some((re) => { re.lastIndex = 0; return re.test(line); })) {
          hits.push(`${relative(root, p)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
  }
};
walk(root);

if (hits.length) {
  console.error(`test-skip-guard FAIL — ${hits.length} skipped/focused test(s) committed:`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log('test-skip-guard OK — zero skipped/focused tests');
