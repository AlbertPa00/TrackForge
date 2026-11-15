#!/usr/bin/env node
// Screenshot capture for docs/README — logs into the dev app and shoots the
// showcase pages. Needs :5173 (dev server) + seeded data (scripts/seed-showcase.mjs).
//   node scripts/capture-shots.mjs [outdir]
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = process.env.FRONTEND_URL ?? 'http://localhost:5173';
const OUT = process.argv[2] ?? new URL('../shots', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
// Defaults are the documented dev-seed creds (AGENTS.md) — override via env
// if your local DB was rebuilt with different users.
const CREDS = {
  email: process.env.SHOT_EMAIL ?? 'admin@trackforge.local',
  password: process.env.SHOT_PASSWORD ?? 'trackforge',
};

const SHOTS = [
  ['board', '/projects/WEB/board', 'issue card'],
  ['backlog', '/projects/WEB/backlog', 'Backlog'],
  ['issue-agent', '/browse/WEB-1', 'Agent activity'],
  ['approvals', '/approvals', 'proposal'],
  ['jql-search', `/issues?mode=jql&jql=${encodeURIComponent('project = WEB ORDER BY created ASC')}`, 'WEB-1'],
  ['yourwork', '/your-work', 'Assigned'],
];

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1600, height: 900 } })).newPage();

await page.goto(`${BASE}/login`);
await page.getByPlaceholder('Email').fill(CREDS.email);
await page.getByPlaceholder('Password').fill(CREDS.password);
await page.getByRole('button', { name: 'Log in', exact: true }).click();
await page.waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 15000 });
await page.waitForTimeout(1500);

for (const [name, path, waitText] of SHOTS) {
  try {
    await page.goto(`${BASE}${path}`);
    await page.waitForTimeout(1800); // let queries settle
    if (waitText) await page.waitForSelector(`text=${waitText}`, { timeout: 8000 }).catch(() => {});
    await page.screenshot({ path: join(OUT, `${name}.png`) });
    console.log(`✓ ${name}.png`);
  } catch (e) {
    console.log(`✗ ${name}: ${e.message.split('\n')[0]}`);
  }
}
await browser.close();
