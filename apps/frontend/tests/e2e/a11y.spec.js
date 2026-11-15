// 037 US2-1 — axe checks on the top-10 flows: zero serious/critical violations.
import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const CREDS = { email: 'admin@trackforge.local', password: 'trackforge' };

const FLOWS = [
  ['your-work', '/your-work'],
  ['projects', '/projects'],
  ['issues', '/issues'],
  ['board', '/projects/SCRUM/board'],
  ['backlog', '/projects/SCRUM/backlog'],
  ['issue-detail', '/browse/SCRUM-1'],
  ['reports', '/projects/SCRUM/reports'],
  ['dashboards', '/dashboards'],
  ['admin-users', '/admin/users'],
  ['profile', '/profile'],
];

test.beforeEach(async ({ page }) => {
  await page.goto('http://localhost:5173/login');
  await page.getByPlaceholder('Email').fill(CREDS.email);
  await page.getByPlaceholder('Password').fill(CREDS.password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).toHaveURL(/localhost:5173\/(?!login)/);
});

for (const [name, path] of FLOWS) {
  test(`axe: ${name} has no serious/critical violations`, async ({ page }) => {
    await page.goto(`http://localhost:5173${path}`);
    // networkidle never settles (SSE/polling) — wait for rendered content instead.
    await page.locator('nav, main, table, form').first().waitFor({ timeout: 15000 }).catch(() => {});
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa'])
      .analyze();
    const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(
      bad.map((v) => `${v.id}(${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
      `${name} — ${bad.length} serious/critical violations`
    ).toEqual([]);
  });
}
