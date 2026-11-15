import { test, expect } from '@playwright/test';

const CREDS = { email: 'admin@trackforge.local', password: 'trackforge' };

test('unauthenticated users are redirected to login', async ({ page }) => {
  await page.goto('http://localhost:5173/');
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.getByText('Log in to continue')).toBeVisible();
});

test('login then app shell loads with Jira-style nav', async ({ page }) => {
  await page.goto('http://localhost:5173/login');
  await page.getByPlaceholder('Email').fill(CREDS.email);
  await page.getByPlaceholder('Password').fill(CREDS.password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).toHaveURL('http://localhost:5173/');
  await expect(page.getByText('TrackForge')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create' }).first()).toBeVisible();
});
