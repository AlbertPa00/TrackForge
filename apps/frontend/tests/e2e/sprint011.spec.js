import { test, expect } from '@playwright/test';

const CREDS = { email: 'admin@trackforge.local', password: 'trackforge' };

async function login(page) {
  await page.goto('http://localhost:5173/login');
  await page.getByPlaceholder('Email').fill(CREDS.email);
  await page.getByPlaceholder('Password').fill(CREDS.password);
  await page.getByRole('button', { name: 'Log in' }).click();
  await expect(page).toHaveURL('http://localhost:5173/');
}

test('Your work page loads sections', async ({ page }) => {
  await login(page);
  await page.goto('http://localhost:5173/your-work');
  await expect(page.getByText('Your work')).toBeVisible();
  await expect(page.getByText('Assigned to you')).toBeVisible();
  await page.screenshot({ path: 'shot-yourwork.png', fullPage: true });
});

test('notification bell is present in top nav', async ({ page }) => {
  await login(page);
  await expect(page.locator('button[aria-label^="Notifications"], [title*="notification" i]').first()).toBeVisible();
});

test('Webhooks settings page (admin)', async ({ page }) => {
  await login(page);
  await page.goto('http://localhost:5173/settings/webhooks');
  await expect(page.getByText(/webhook/i).first()).toBeVisible();
  await page.screenshot({ path: 'shot-webhooks.png', fullPage: true });
});
