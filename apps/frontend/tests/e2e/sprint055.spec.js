import { test, expect } from '@playwright/test';

// Sprint 055 — issue detail & navigator interaction regressions.
// Runs against the seeded dev stack (SCRUM demo project).

const CREDS = { email: 'admin@trackforge.local', password: 'trackforge' };
const API = 'http://localhost:3000';
const BANNER = 'This issue was updated elsewhere.';

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

async function makeIssue(page, summary) {
  const r = await api(page, 'POST', '/rest/api/2/issue', {
    fields: { project: { key: 'SCRUM' }, summary },
  });
  return r.key;
}

const run = Date.now().toString(36);

test('SC-001: vote, due-date edit and picker open/escape produce no false conflict banner', async ({ page }) => {
  await login(page);
  const key = await makeIssue(page, `E2E055 banner ${run}`);
  await page.goto(`http://localhost:5173/browse/${key}`);
  const banner = page.getByText(BANNER);

  // Vote — a local mutation whose refetch must not look like a remote write.
  await page.getByRole('button', { name: 'Vote', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Remove vote', exact: true })).toBeVisible();
  await page.waitForTimeout(1200);
  await expect(banner).toHaveCount(0);

  // Due date — InlineEdit save bumps `updated`; still no banner.
  await page.getByLabel('Edit due date').click();
  await page.locator('input[type="date"]').fill('2027-12-24');
  await page.locator('input[type="date"]').press('Enter');
  await expect(page.getByLabel('Edit due date')).toBeVisible(); // saved → read mode
  await page.waitForTimeout(1200);
  await expect(banner).toHaveCount(0);

  // Assignee picker: opens, scrolling inside the list keeps it open,
  // Escape closes and returns focus to the trigger.
  await page.locator('[data-tf-assign]').click();
  await expect(page.getByPlaceholder('Search people')).toBeVisible();
  await page.getByPlaceholder('Search people').hover();
  await page.mouse.wheel(0, 300); // wheel over the list — menu must stay open
  await expect(page.getByPlaceholder('Search people')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByPlaceholder('Search people')).toHaveCount(0);
  await expect(page.locator('[data-tf-assign]')).toBeFocused();
  await expect(banner).toHaveCount(0);
});

test('SC-002: switching issues in the detail pane shows no banner and clean edit state', async ({ page }) => {
  await login(page);
  const a = await makeIssue(page, `E2E055 switch A ${run}`);
  const b = await makeIssue(page, `E2E055 switch B ${run}`);
  const jql = encodeURIComponent(`key in (${a}, ${b})`);
  await page.goto(`http://localhost:5173/issues?view=detail&jql=${jql}`);

  const rowA = page.locator('li', { hasText: a });
  const rowB = page.locator('li', { hasText: b });

  // Select A and open its summary editor — then switch to B mid-edit.
  await rowA.getByText(`E2E055 switch A ${run}`).click();
  await expect(page).toHaveURL(new RegExp(`issue=${a}`));
  await page.getByLabel('Edit summary').click();
  const draftInput = page.locator(`input[value="E2E055 switch A ${run}"]`);
  await expect(draftInput).toBeVisible();

  await rowB.getByText(`E2E055 switch B ${run}`).click();
  await expect(page).toHaveURL(new RegExp(`issue=${b}`));

  // B renders read-mode: no stale editor holding A's draft, no conflict banner.
  await expect(draftInput).toHaveCount(0);
  await expect(page.getByLabel('Edit summary')).toBeVisible();
  await expect(page.getByText(BANNER)).toHaveCount(0);
  await page.waitForTimeout(1500);
  await expect(page.getByText(BANNER)).toHaveCount(0);
});

test('SC-003: resolution+labels survive Basic⇄JQL; translate output runs and persists', async ({ page }) => {
  await login(page);
  const resolutions = await api(page, 'GET', '/rest/api/2/resolution');
  const resName = (Array.isArray(resolutions) ? resolutions : resolutions.values ?? [])[0]?.name ?? 'Done';
  const label = `e2e55${run}`;

  await page.goto('http://localhost:5173/issues?mode=jql');
  const editor = page.getByLabel('JQL query');
  await editor.fill(`resolution = "${resName}" AND labels = ${label}`);
  await editor.press('Enter');
  await page.waitForTimeout(400);

  // → Basic: both fields land in the URL as first-class params.
  await page.getByRole('button', { name: 'Basic', exact: true }).click();
  await expect(page).toHaveURL(/resolution=/);
  await expect(page).toHaveURL(/labels=/);
  const url = new URL(page.url());
  expect(url.searchParams.get('resolution')).toBe(resName);
  expect(url.searchParams.get('labels')).toBe(label);

  // → JQL again: the round trip rebuilds both clauses.
  await page.getByRole('button', { name: 'JQL', exact: true }).click();
  await expect.poll(async () => page.getByLabel('JQL query').inputValue()).toContain('resolution');
  await expect.poll(async () => page.getByLabel('JQL query').inputValue()).toContain(`labels = ${label}`);

  // AI translate (mocked — deterministic): output commits to URL + runs search.
  await page.route('**/api/internal/ai/jql', (route) =>
    route.fulfill({ json: { jql: 'project = SCRUM ORDER BY created DESC' } })
  );
  const searches = [];
  page.on('request', (r) => {
    if (r.url().includes('/rest/api/2/search')) searches.push(r.url());
  });
  await editor.fill('labels = nothing-real');
  await page.locator('button[title*="plain language"]').click();
  await page.getByLabel('Natural language search').fill('scrum issues');
  await page.getByRole('button', { name: 'Translate' }).click();
  await expect.poll(async () => page.getByLabel('JQL query').inputValue()).toContain('project = SCRUM');
  await expect(page).toHaveURL(/jql=/);
  const committed = new URL(page.url()).searchParams.get('jql') ?? '';
  expect(committed).toContain('project = SCRUM');
  const jqlOf = (u) => new URL(u).searchParams.get('jql') ?? '';
  await expect.poll(() => searches.some((u) => jqlOf(u).includes('project = SCRUM'))).toBeTruthy();
});

test('SC-004: Basic "Contains text" issues text ~ (FTS), not summary ~', async ({ page }) => {
  await login(page);
  const searches = [];
  page.on('request', (r) => {
    if (r.url().includes('/rest/api/2/search')) searches.push(r.url());
  });
  await page.goto('http://localhost:5173/issues');
  await page.getByPlaceholder('Contains text').fill(`zzt-${run}`);
  // The page-load search fires first — poll until the text search lands.
  const jqlOf = (u) => new URL(u).searchParams.get('jql') ?? '';
  let found;
  await expect
    .poll(() => (found = searches.map(jqlOf).find((j) => j.includes('zzt'))), { timeout: 5000 })
    .toBeTruthy();
  expect(found).toContain(`text ~ "zzt-${run}"`);
  expect(found).not.toContain('summary ~');
});
