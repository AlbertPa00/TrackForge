#!/usr/bin/env node
// Release gates G3.6 + L5 — repository hygiene over git-tracked files.
//
//   a) no secret-shaped literals in tracked content (PATs, PEM blocks,
//      GitHub/Slack/AWS/OpenAI/Google keys)
//   b) no tracked env/secret FILES (.env*, *.pem, *.key, id_rsa*)
//   c) no "jira-dupe" in public-facing copy — the repo dir name is fine,
//      shipped text is not
//
// Exit 1 on any finding. gitleaks covers git history at release time;
// this covers the working tree on every PR.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'scripts/hygiene-scan.mjs';

const SECRET_RES = [
  /tfp_[0-9a-f]{40,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /github_pat_[A-Za-z0-9_]{22,}/,
  /gh[pousr]_[A-Za-z0-9]{36,}/,
  /xox[baprs]-[0-9A-Za-z-]{10,}/,
  /AKIA[0-9A-Z]{16}/,
  /sk-[A-Za-z0-9]{32,}/,
  /AIza[0-9A-Za-z_-]{35}/,
];

const PUBLIC_COPY = /^(README\.md|CHANGELOG|CONTRIBUTING\.md|SECURITY\.md|VERIFY\.md|docs\/[^ ]*\.md|\.github\/[^ ]*\.md|apps\/mcp\/README\.md|package\.json|apps\/[^/]*\/package\.json)$/i;
const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|ttf|otf|db|sqlite|zip|gz|tar|pdf|mp4|avif)$/i;

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0').filter(Boolean);

let fail = 0;
const bad = (msg) => { console.error(`  FAIL ${msg}`); fail++; };

for (const rel of tracked) {
  // (b) tracked secret/env files
  if (/(^|\/)\.env($|\.)/.test(rel) && !/\.env\.example$/.test(rel)) {
    bad(`tracked env file: ${rel}`);
    continue;
  }
  if (/\.(pem|key|p12|pfx|jks|keystore)$/i.test(rel) || /id_rsa|id_ed25519/i.test(rel)) {
    bad(`tracked secret material: ${rel}`);
    continue;
  }
  if (BINARY.test(rel) || rel === SELF) continue;

  let src;
  try { src = readFileSync(join(root, rel), 'utf8'); } catch { continue; }

  // (a) secret-shaped literals
  for (const re of SECRET_RES) {
    const m = src.match(re);
    if (m) bad(`${rel}: possible secret "${m[0].slice(0, 14)}…"`);
  }

  // (c) clone/dupe product framing in public copy — nominative "Jira
  // compatible" is fine; presenting the product as a Jira clone is not
  if (PUBLIC_COPY.test(rel) && /jira[-_ ]?(clone|dupe|copy|rip ?off|knock ?off)/i.test(src)) {
    bad(`${rel}: clone/dupe product framing in public-facing copy`);
  }
}

console.log(`hygiene-scan: ${tracked.length} tracked files`);
if (fail) { console.error(`hygiene-scan FAIL — ${fail} problem(s)`); process.exit(1); }
console.log('hygiene-scan OK');
