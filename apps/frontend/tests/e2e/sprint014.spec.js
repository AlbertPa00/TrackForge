import { test, expect, request as pwRequest } from '@playwright/test';

const CREDS = { email: 'admin@trackforge.local', password: 'trackforge' };
const API = 'http://localhost:3000';
const TOKEN = process.env.TRACKFORGE_TOKEN ?? '';

async function login(page) {
  await page.goto('http://localhost:5173/login');
  await page.getByPlaceholder('Email').fill(CREDS.email);
  await page.getByPlaceholder('Password').fill(CREDS.password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).toHaveURL('http://localhost:5173/');
}

async function api() {
  return pwRequest.newContext({ baseURL: API, extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` } });
}

test('admin custom-fields page creates a field', async ({ page }) => {
  await login(page);
  await page.goto('http://localhost:5173/settings/customfields');
  // Seeded system fields are listed.
  await expect(page.getByText('Story Points').first()).toBeVisible();
  await page.getByRole('button', { name: 'Create custom field' }).click();
  const name = `Risk ${Date.now().toString(36)}`;
  await page.getByLabel(/name/i).first().fill(name);
  await page.locator('select').first().selectOption('select');
  await page.getByPlaceholder(/one option per line/i).fill('Low\nHigh');
  await page.locator('form').getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByText(name)).toBeVisible();
  await page.screenshot({ path: 'shot-customfields.png', fullPage: true });
});

test('issue detail renders + edits a custom field row', async ({ page }) => {
  const ctx = await api();
  const name = `Severity ${Date.now().toString(36)}`;
  const res = await ctx.post('/api/internal/customfields', {
    data: { name, type: 'select', context: { options: ['S1', 'S2'] } },
  });
  const field = await res.json();
  const issueRes = await ctx.post('/rest/api/2/issue', {
    data: { fields: { project: { key: 'SCRUM' }, summary: `cf e2e ${name}`, [field.id]: { value: 'S1' } } },
  });
  const issue = await issueRes.json();

  await login(page);
  await page.goto(`http://localhost:5173/browse/${issue.key}`);
  await expect(page.getByText(name).first()).toBeVisible();
  await expect(page.getByText('S1').first()).toBeVisible();
  // Edit to S2 via the inline select — the CF row is a DetailRow (dt label + dd editor).
  const dd = page.locator('dt', { hasText: name }).locator('..').locator('dd');
  await dd.getByRole('button').first().click();
  await dd.getByRole('option', { name: 'S2' }).click();
  await expect(page.getByText('S2').first()).toBeVisible();
  await page.screenshot({ path: 'shot-issue-cf.png', fullPage: true });
});

test('create dialog surfaces custom fields from createmeta', async ({ page }) => {
  const ctx = await api();
  const name = `Env ${Date.now().toString(36)}`;
  await ctx.post('/api/internal/customfields', {
    data: { name, type: 'select', context: { options: ['Prod', 'Stage'] } },
  });
  await login(page);
  await page.goto('http://localhost:5173/projects/SCRUM');
  await page.getByRole('button', { name: /create/i }).first().click();
  await expect(page.getByText(name).first()).toBeVisible();
  await page.screenshot({ path: 'shot-create-cf.png', fullPage: true });
});
