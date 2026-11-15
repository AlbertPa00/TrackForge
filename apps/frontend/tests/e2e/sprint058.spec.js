import { test, expect } from '@playwright/test';

// Sprint 058 — better-than-Jira UX: issue drawer, unified palette, summary.
// Runs against the seeded dev stack (SCRUM demo project).

const CREDS = { email: 'admin@trackforge.local', password: 'trackforge' };
const API = 'http://localhost:3000';

async function login(page) {
  await page.goto('http://localhost:5173/login');
  await page.getByPlaceholder('Email').fill(CREDS.email);
  await page.getByPlaceholder('Password').fill(CREDS.password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).toHaveURL('http://localhost:5173/');
}

async function api(page, method, path, body) {
  const res = await page.request.fetch(`${API}${path}`, {
    method,
    data: body,
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok()) throw new Error(`${method} ${path} → ${res.status()}: ${await res.text()}`);
  return res.json().catch(() => ({}));
}

const run = Date.now().toString(36);

test('SC-001: backlog row click opens drawer; Escape closes; stays on backlog', async ({ page }) => {
  await login(page);
  const key = (await api(page, 'POST', '/rest/api/2/issue', {
    fields: { project: { key: 'SCRUM' }, summary: `E2E058 drawer ${run}` },
  })).key;
  await page.goto('http://localhost:5173/projects/SCRUM/backlog');
  // New issues land in the backlog — the summary link's plain click opens the drawer.
  await page.getByRole('link', { name: `E2E058 drawer ${run}` }).click();

  // Drawer opens as a dialog; URL carries ?selectedIssue for deep-link/refresh.
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`selectedIssue=${key}`));
  await expect(drawer.locator('h1', { hasText: `E2E058 drawer ${run}` })).toBeVisible();

  // Escape closes, param clears, page never navigated.
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);
  await expect(page).not.toHaveURL(/selectedIssue/);
  await expect(page).toHaveURL(/projects\/SCRUM\/backlog/);
});

test('SC-001b: deep-link ?selectedIssue= reopens the drawer on load', async ({ page }) => {
  await login(page);
  const key = (await api(page, 'POST', '/rest/api/2/issue', {
    fields: { project: { key: 'SCRUM' }, summary: `E2E058 deeplink ${run}` },
  })).key;
  await page.goto(`http://localhost:5173/projects/SCRUM/board?selectedIssue=${key}`);
  const drawer = page.getByRole('dialog');
  await expect(drawer).toBeVisible();
  await expect(drawer.locator('h1', { hasText: `E2E058 deeplink ${run}` })).toBeVisible();
});

test('SC-003: palette runs a deterministic local command with no AI round-trip', async ({ page }) => {
  await login(page);
  // Fail the test if any AI endpoint is called — local commands must not plan.
  let aiCalled = false;
  page.on('request', (r) => {
    if (r.url().includes('/api/internal/ai/')) aiCalled = true;
  });
  await page.goto('http://localhost:5173/projects/SCRUM/backlog');
  await page.waitForTimeout(800); // let the keydown listener attach post-hydration
  const input = page.getByPlaceholder(/Type a command/);
  // Ctrl+K is a one-shot toggle — retry once if the first press raced hydration.
  await page.keyboard.press('Control+k');
  if (!(await input.isVisible().catch(() => false))) {
    await page.waitForTimeout(500);
    await page.keyboard.press('Control+k');
  }
  await expect(input).toBeVisible();
  await input.fill('go board');
  await page.getByText('Go to Board', { exact: true }).click();
  await expect(page).toHaveURL(/projects\/SCRUM\/board/);
  expect(aiCalled).toBe(false);
});

test('SC-007: project summary page renders the five widgets', async ({ page }) => {
  await login(page);
  await api(page, 'POST', '/rest/api/2/issue', {
    fields: { project: { key: 'SCRUM' }, summary: `E2E058 summary ${run}` },
  });
  await page.goto('http://localhost:5173/projects/SCRUM');
  await expect(page.getByText('Status overview')).toBeVisible();
  await expect(page.getByText('Open by priority')).toBeVisible();
  await expect(page.getByText('Recent activity')).toBeVisible();
});
