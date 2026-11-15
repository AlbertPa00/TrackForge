import { test, expect } from '@playwright/test';

const CREDS = { email: 'admin@trackforge.local', password: 'trackforge' };

async function login(page) {
  await page.goto('http://localhost:5173/login');
  await page.getByPlaceholder('Email').fill(CREDS.email);
  await page.getByPlaceholder('Password').fill(CREDS.password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).toHaveURL('http://localhost:5173/');
}

test('advanced search — basic mode', async ({ page }) => {
  await login(page);
  await page.goto('http://localhost:5173/issues');
  await expect(page.getByRole('heading', { name: 'Issues' })).toBeVisible();
  await expect(page.getByPlaceholder('Contains text')).toBeVisible();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'test-results/issues-basic.png', fullPage: true });
});

test('advanced search — JQL mode + autocomplete', async ({ page }) => {
  await login(page);
  await page.goto('http://localhost:5173/issues?mode=jql&jql=' + encodeURIComponent('statusCategory != Done ORDER BY priority DESC, created DESC'));
  await expect(page.getByLabel('JQL query')).toBeVisible();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'test-results/issues-jql.png', fullPage: true });
  // autocomplete: type a field prefix
  await page.getByLabel('JQL query').fill('');
  await page.getByLabel('JQL query').type('stat');
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'test-results/issues-jql-autocomplete.png' });
});

test('basic ⇄ jql round-trip', async ({ page }) => {
  await login(page);
  await page.goto('http://localhost:5173/issues');
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'JQL' }).click();
  await expect(page.getByLabel('JQL query')).toBeVisible();
  const jql = await page.getByLabel('JQL query').inputValue();
  expect(jql.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Basic' }).click();
  await expect(page.getByPlaceholder('Contains text')).toBeVisible();
});

test('filters page + save-as flow', async ({ page }) => {
  const filterName = `E2E open issues ${Date.now().toString(36)}`;
  await login(page);
  // save a filter from advanced search
  await page.goto('http://localhost:5173/issues?mode=jql&jql=' + encodeURIComponent('statusCategory != Done'));
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: /Save as/ }).click();
  await page.getByPlaceholder('e.g. My open bugs').fill(filterName);
  await page.getByRole('button', { name: 'Save filter' }).click();
  await page.waitForTimeout(600);
  // filters list shows it
  await page.goto('http://localhost:5173/filters');
  await expect(page.getByText(filterName)).toBeVisible();
  await page.screenshot({ path: 'test-results/filters.png', fullPage: true });
  // clean up — row Delete opens a confirm dialog, confirm there
  await page.getByRole('row', { name: filterName }).getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('button', { name: filterName })).toHaveCount(0);
});

test('top-nav filters menu + global search', async ({ page }) => {
  await login(page);
  await page.goto('http://localhost:5173/');
  await page.getByRole('button', { name: 'Filters' }).click();
  await expect(page.getByText('Advanced issue search')).toBeVisible();
  await page.screenshot({ path: 'test-results/topnav-filters.png' });
  await page.getByLabel('Global search').fill('eval');
  await page.waitForTimeout(700);
  await page.screenshot({ path: 'test-results/topnav-search.png' });
});
