import { test, expect } from '@playwright/test';

// 052 — copilot trust & simplicity: the palette's deterministic journeys.
// 068 — the palette is now a deterministic launcher; copilot work lives in
// the Ctrl+J dock. AI-dependent paths (plan rendering, clarify chips, apply,
// answers) are covered by tests/unit/{commandpalette,copilotdock}.test.tsx
// against a mocked client; a live plan would hit the configured provider, so
// e2e stays deterministic.

const CREDS = { email: 'admin@trackforge.local', password: 'trackforge' };

async function login(page) {
  await page.goto('http://localhost:5173/login');
  await page.getByPlaceholder('Email').fill(CREDS.email);
  await page.getByPlaceholder('Password').fill(CREDS.password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).toHaveURL('http://localhost:5173/');
}

test('palette shows human-first helper + suggestion chips', async ({ page }) => {
  await login(page);
  await page.keyboard.press('Control+k');
  const input = page.getByPlaceholder(/type a command/i);
  await expect(input).toBeVisible();
  // Empty input surfaces the human-first local commands (navigations, help).
  await expect(page.getByRole('option', { name: /issue navigator/i })).toBeVisible();
  // No tool names or raw JSON in the default surface.
  await expect(page.locator('details')).toHaveCount(0);
  await expect(page.getByText(/\{\s*"/)).toHaveCount(0);
});

test('issue-context chips appear on an issue page', async ({ page }) => {
  await login(page);
  await page.goto('http://localhost:5173/projects/SCRUM/issues');
  await page.locator('table tbody tr a').first().click();
  await expect(page).toHaveURL(/\/browse\/([A-Z]+-\d+)/);
  const key = page.url().match(/browse\/([A-Z]+-\d+)/)[1];
  await page.keyboard.press('Control+k');
  // Issue-context commands filter in once typed — the default surface is
  // capped at 8 navigation options.
  await page.getByPlaceholder(/type a command/i).fill('watch');
  await expect(page.getByRole('option', { name: `Watch ${key}` })).toBeVisible();
});

test('bare issue key offers Open issue and navigates without planning', async ({ page }) => {
  await login(page);
  await page.keyboard.press('Control+k');
  const input = page.getByPlaceholder(/type a command/i);
  await input.fill('TF-1');
  await expect(page.getByRole('button', { name: /TF-1.*Open issue/i })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/browse\/TF-1/);
});

test('Esc closes the palette', async ({ page }) => {
  await login(page);
  await page.keyboard.press('Control+k');
  await expect(page.getByPlaceholder(/type a command/i)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByPlaceholder(/type a command/i)).toHaveCount(0);
});

// ---------- 068: dock + handoff ----------

test('Ctrl+J opens the copilot dock with composer + empty state', async ({ page }) => {
  await login(page);
  await page.keyboard.press('Control+j');
  const dock = page.getByTestId('copilot-dock');
  await expect(dock).toBeVisible();
  await expect(page.getByLabel(/message copilot/i)).toBeVisible();
  await expect(page.getByText(/keep the context/i)).toBeVisible();
  // Ctrl+J again toggles it away.
  await page.keyboard.press('Control+j');
  await expect(dock).toHaveCount(0);
});

test('question input in Ctrl+K offers Ask Copilot and hands off to the dock', async ({ page }) => {
  await login(page);
  await page.keyboard.press('Control+k');
  const input = page.getByPlaceholder(/type a command/i);
  // A question-form prompt must NOT navigate to a local command.
  await input.fill('list sprints');
  const ask = page.getByRole('option', { name: /Ask Copilot/i });
  await expect(ask).toBeVisible();
  await page.keyboard.press('Enter');
  // Palette closed, dock opened — page URL unchanged.
  await expect(input).toHaveCount(0);
  await expect(page.getByTestId('copilot-dock')).toBeVisible();
  await expect(page).toHaveURL('http://localhost:5173/');
});

test('dock minimizes to the rail and restores without losing the thread', async ({ page }) => {
  await login(page);
  await page.keyboard.press('Control+j');
  await page.getByRole('button', { name: 'Minimize Copilot' }).click();
  await expect(page.getByTestId('copilot-dock')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open Copilot' }).click();
  await expect(page.getByTestId('copilot-dock')).toBeVisible();
});
