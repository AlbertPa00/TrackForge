import { test, expect } from '@playwright/test';

const CREDS = { email: 'admin@trackforge.local', password: 'trackforge' };

async function login(page) {
  await page.goto('http://localhost:5173/login');
  await page.getByPlaceholder('Email').fill(CREDS.email);
  await page.getByPlaceholder('Password').fill(CREDS.password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).toHaveURL('http://localhost:5173/');
}

test('scrum backlog shows sprint groups and backlog', async ({ page }) => {
  await login(page);
  await page.goto('http://localhost:5173/projects/SCRUM/backlog');
  // Seeded project: 3 closed + 1 active sprint → active sprint header + backlog group.
  await expect(page.getByText(/SCRUM Sprint 4/i).first()).toBeVisible();
  await expect(page.getByText(/^backlog$/i).first()).toBeVisible();
  await page.screenshot({ path: 'shot-backlog.png', fullPage: true });
});

test('scrum board header shows active sprint + Complete sprint', async ({ page }) => {
  await login(page);
  await page.goto('http://localhost:5173/projects/SCRUM/board');
  await expect(page.getByText(/SCRUM Sprint 4/i).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Complete sprint' })).toBeVisible();
  await page.screenshot({ path: 'shot-scrum-board.png', fullPage: true });
});

test('reports page renders velocity + burndown for scrum board', async ({ page }) => {
  await login(page);
  await page.goto('http://localhost:5173/projects/SCRUM/reports');
  await expect(page.getByText(/velocity|burndown|report/i).first()).toBeVisible();
  await page.screenshot({ path: 'shot-reports.png', fullPage: true });
});

test('kanban board hides backlog/reports sidebar entries', async ({ page }) => {
  await login(page);
  // BENCH00 is a kanban project — sidebar should not show Backlog/Reports.
  await page.goto('http://localhost:5173/projects/BENCH00/board');
  const backlogLink = page.getByRole('link', { name: /^backlog$/i });
  await expect(backlogLink).toHaveCount(0);
});
