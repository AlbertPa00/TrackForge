import { test, expect } from '@playwright/test';

const CREDS = { email: 'admin@trackforge.local', password: 'trackforge' };

async function login(page) {
  await page.goto('http://localhost:5173/login');
  await page.getByPlaceholder('Email').fill(CREDS.email);
  await page.getByPlaceholder('Password').fill(CREDS.password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).toHaveURL('http://localhost:5173/');
}

test('Approvals inbox loads', async ({ page }) => {
  await login(page);
  await page.goto('http://localhost:5173/approvals');
  await expect(page.getByText(/approvals/i).first()).toBeVisible();
  await page.screenshot({ path: 'shot-approvals.png', fullPage: true });
});

test('AI settings page (admin)', async ({ page }) => {
  await login(page);
  await page.goto('http://localhost:5173/settings/ai');
  await expect(page.getByText(/ai|provider/i).first()).toBeVisible();
  await page.screenshot({ path: 'shot-ai-settings.png', fullPage: true });
});

test('command palette opens on Ctrl+K', async ({ page }) => {
  await login(page);
  await page.keyboard.press('Control+k');
  await expect(page.getByPlaceholder(/instruction|copilot|what would you like|type a command/i)).toBeVisible();
  await page.screenshot({ path: 'shot-palette.png' });
});

test('issue detail shows AI actions panel', async ({ page }) => {
  await login(page);
  // Open the project navigator and click through to an issue.
  await page.goto('http://localhost:5173/projects/SCRUM/issues');
  await page.locator('table tbody tr a').first().click();
  await expect(page).toHaveURL(/\/browse\/[A-Z]+-\d+/);
  await expect(page.getByRole('button', { name: 'Summarize' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Draft description' })).toBeVisible();
});
