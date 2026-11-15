import { test, expect } from '@playwright/test';

const OUT = process.env.SHOT_DIR;
const go = (page, path) =>
  page.evaluate((p) => { history.pushState({}, '', p); dispatchEvent(new PopStateEvent('popstate')); }, path);

test.setTimeout(120000);
test('verify fixes', async ({ page }) => {
  let notif = 0;
  page.on('request', (r) => { if (r.url().includes('/me/notifications')) notif++; });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/login');
  await page.getByPlaceholder('Email').fill('admin@trackforge.local');
  await page.getByPlaceholder('Password').fill('trackforge');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).toHaveURL(/localhost:5173\/(?!login)/);
  await page.waitForTimeout(3000);
  const notifAfterLogin = notif;
  await go(page, '/issues');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/v-issues.png` });
  await go(page, '/projects/SCRUM/board');
  await page.waitForTimeout(2500);
  await page.keyboard.press('c');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/v-create.png` });
  await page.keyboard.press('Escape');
  await go(page, '/projects/SCRUM');
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/v-list.png` });
  console.log('NOTIFS', JSON.stringify({ afterLogin: notifAfterLogin, total: notif }));
});
