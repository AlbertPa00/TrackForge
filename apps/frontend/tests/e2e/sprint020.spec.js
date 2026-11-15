import { test, expect, request as pwRequest } from '@playwright/test';

const CREDS = { email: 'admin@trackforge.local', password: 'trackforge' };
const API = 'http://localhost:3000';
const TOKEN = process.env.TRACKFORGE_TOKEN ?? '';

async function login(page) {
  await page.goto('http://localhost:5173/login');
  await page.getByPlaceholder('Email').fill(CREDS.email);
  await page.getByPlaceholder('Password').fill(CREDS.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL('http://localhost:5173/');
}

async function api() {
  return pwRequest.newContext({ baseURL: API, extraHTTPHeaders: { Authorization: `Bearer ${TOKEN}` } });
}

/** Sprint 020 — M1 daily-driver journey: create → attach → fixVersion → release. */

test('journey: upload an attachment on the issue page and see it listed', async ({ page }) => {
  const ctx = await api();
  const key = `P20${Date.now().toString(36).toUpperCase().slice(-4)}`;
  await (await ctx.post('/rest/api/2/project', { data: { key, name: key } })).json();
  const issue = await (await ctx.post('/rest/api/2/issue', {
    data: { fields: { project: { key }, summary: 'journey attach' } },
  })).json();

  await login(page);
  await page.goto(`http://localhost:5173/browse/${issue.key}`);
  await expect(page.getByText('Attachments')).toBeVisible();
  await page.locator('input[type=file]').setInputFiles({
    name: 'hello.txt', mimeType: 'text/plain', buffer: Buffer.from('journey bytes'),
  });
  await expect(page.getByText('hello.txt')).toBeVisible({ timeout: 10000 });
});

test('journey: fixVersion on issue flows into the release hub and releases', async ({ page }) => {
  const ctx = await api();
  const key = `P21${Date.now().toString(36).toUpperCase().slice(-4)}`;
  await (await ctx.post('/rest/api/2/project', { data: { key, name: key } })).json();
  const version = await (await ctx.post('/rest/api/2/version', {
    data: { project: key, name: 'v1.0-journey' },
  })).json();
  const issue = await (await ctx.post('/rest/api/2/issue', {
    data: { fields: { project: { key }, summary: 'journey release', fixVersions: [{ id: version.id }] } },
  })).json();

  await login(page);
  await page.goto(`http://localhost:5173/projects/${key}/releases`);
  await expect(page.getByText('v1.0-journey')).toBeVisible();
  // Fix-versioned issue shows under the version card's Unresolved bucket.
  await page.getByText('v1.0-journey').click();
  await expect(page.getByText(issue.key)).toBeVisible();
});
