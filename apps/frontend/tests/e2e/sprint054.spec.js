import { test, expect } from '@playwright/test';

// Sprint 054 — board & backlog drag correctness regressions.
// Runs against the seeded dev stack (SCRUM demo project: scrum board,
// 3 closed sprints + 1 active sprint + backlog issues).

const CREDS = { email: 'admin@trackforge.local', password: 'trackforge' };
const API = 'http://localhost:3000';

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

async function scrumBoard(page) {
  const r = await api(page, 'GET', '/rest/agile/1.0/board?projectKeyOrId=SCRUM');
  return r.values[0];
}

async function activeSprint(page, boardId) {
  const r = await api(page, 'GET', `/rest/agile/1.0/board/${boardId}/sprint?state=active`);
  return r.values[0];
}

async function makeIssue(page, summary) {
  const r = await api(page, 'POST', '/rest/api/2/issue', {
    fields: { project: { key: 'SCRUM' }, summary },
  });
  return r.key;
}

/** Native HTML5 drag: real DataTransfer through React's on* handlers.
 *  The pause after dragstart lets React flush draggingKey state — a same-tick
 *  drop would see it still null and no-op. */
async function html5Drag(page, source, target) {
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await source.dispatchEvent('dragstart', { dataTransfer });
  await page.waitForTimeout(250);
  await target.dispatchEvent('dragover', { dataTransfer });
  await target.dispatchEvent('drop', { dataTransfer });
  await source.dispatchEvent('dragend', { dataTransfer });
}

const run = Date.now().toString(36);

test('SC-001: bottom card of a column can be reordered upward (keyboard DnD)', async ({ page }) => {
  await login(page);
  const board = await scrumBoard(page);
  const sprint = await activeSprint(page, board.id);
  const a = await makeIssue(page, `E2E054 bottom A ${run}`);
  const b = await makeIssue(page, `E2E054 bottom B ${run}`);
  await api(page, 'POST', `/rest/agile/1.0/sprint/${sprint.id}/issue`, { issues: [a, b] });

  await page.goto('http://localhost:5173/projects/SCRUM/board');
  const column = page.locator('section', { has: page.locator('h2', { hasText: 'To Do' }) }).first();
  const cards = column.locator('div[aria-label*=" — "]');
  await expect(cards.filter({ hasText: b })).toHaveCount(1);

  const order = async () => {
    const labels = await Promise.all(
      (await cards.all()).map((el) => el.getAttribute('aria-label'))
    );
    return {
      a: labels.findIndex((l) => l?.startsWith(`${a} —`) ?? false),
      b: labels.findIndex((l) => l?.startsWith(`${b} —`) ?? false),
    };
  };

  expect((await order()).a).toBeLessThan((await order()).b); // B starts below A

  // Keyboard DnD: focus B (last card), Space lifts, ArrowUp one slot, Enter drops.
  // The pauses let React flush kbDrag — same-tick arrows would hit a null lift.
  await cards.filter({ hasText: b }).first().focus();
  await page.keyboard.press(' ');
  await page.waitForTimeout(250);
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(100);
  await page.keyboard.press('Enter');

  await expect.poll(async () => { const o = await order(); return o.b - o.a; }, { timeout: 15000 }).toBeLessThan(0);
});

test('SC-002: dropping a sprint issue on a backlog row moves it out of the sprint', async ({ page }) => {
  await login(page);
  const board = await scrumBoard(page);
  const sprint = await activeSprint(page, board.id);
  const key = await makeIssue(page, `E2E054 leave sprint ${run}`);
  const anchor = await makeIssue(page, `E2E054 backlog anchor ${run}`);
  await api(page, 'POST', `/rest/agile/1.0/sprint/${sprint.id}/issue`, { issues: [key] });

  await page.goto('http://localhost:5173/projects/SCRUM/backlog');
  const sprintSection = page.locator('section', { has: page.locator('h2', { hasText: sprint.name }) });
  const backlogSection = page.locator('section', { has: page.locator('h2', { hasText: 'Backlog' }) });
  const dragged = sprintSection.locator('div[draggable="true"]', { hasText: key });
  const target = backlogSection.locator('div[draggable="true"]', { hasText: anchor });
  await expect(dragged).toHaveCount(1);
  await expect(target).toHaveCount(1);

  await html5Drag(page, dragged, target);

  await expect(sprintSection.locator('div[draggable="true"]', { hasText: key })).toHaveCount(0);
  await expect(backlogSection.locator('div[draggable="true"]', { hasText: key })).toHaveCount(1);
});

test('SC-003: issue reorders within a sprint via drag', async ({ page }) => {
  await login(page);
  const board = await scrumBoard(page);
  const sprint = await activeSprint(page, board.id);
  const a = await makeIssue(page, `E2E054 insprint A ${run}`);
  const b = await makeIssue(page, `E2E054 insprint B ${run}`);
  await api(page, 'POST', `/rest/agile/1.0/sprint/${sprint.id}/issue`, { issues: [a, b] });

  await page.goto('http://localhost:5173/projects/SCRUM/backlog');
  const sprintSection = page.locator('section', { has: page.locator('h2', { hasText: sprint.name }) });
  const rows = sprintSection.locator('div[draggable="true"]');
  // Wait for the sprint-issues query to land before reading row order.
  await expect(rows.filter({ hasText: a })).toHaveCount(1);
  await expect(rows.filter({ hasText: b })).toHaveCount(1);
  const order = async () => {
    const texts = await rows.allTextContents();
    return { a: texts.findIndex((t) => t.includes(a)), b: texts.findIndex((t) => t.includes(b)) };
  };
  expect((await order()).a).toBeLessThan((await order()).b); // B added after A

  // Drag B's row onto A's row → B ranks before A inside the same sprint.
  await html5Drag(
    page,
    rows.filter({ hasText: b }),
    rows.filter({ hasText: a })
  );

  // Read both indexes from one DOM snapshot — refetches can briefly flap
  // between the pre/post-rank order while stale responses land.
  await expect.poll(async () => { const o = await order(); return o.b - o.a; }, { timeout: 15000 }).toBeLessThan(0);
  // And it is still in the sprint, not the backlog.
  await expect(sprintSection.locator('div[draggable="true"]', { hasText: b })).toHaveCount(1);
});

test('SC-004: backlog never fetches issues for closed sprints', async ({ page }) => {
  await login(page);
  const board = await scrumBoard(page);
  const sprintIssueCalls = [];
  page.on('request', (r) => {
    if (/\/rest\/agile\/1\.0\/sprint\/[^/]+\/issue/.test(r.url())) sprintIssueCalls.push(r.url());
  });

  await page.goto('http://localhost:5173/projects/SCRUM/backlog');
  // SSE holds a stream open — networkidle never fires. Wait for the backlog
  // section to finish rendering instead (a row appearing is the last query).
  await page.locator('section', { has: page.locator('h2', { hasText: 'Backlog' }) })
    .locator('div[draggable="true"]').first().waitFor();
  await page.waitForTimeout(1500);

  const open = await api(page, 'GET', `/rest/agile/1.0/board/${board.id}/sprint?state=active,future`);
  expect(sprintIssueCalls.length).toBe(open.values.length);
});
