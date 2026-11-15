#!/usr/bin/env node
// Showcase seed for screenshots — a small realistic project with an agent
// mid-session and a parked proposal. Idempotent-ish: skips existing project.
const B = process.env.TRACKFORGE_URL ?? 'http://localhost:3000';
const T = process.env.TRACKFORGE_TOKEN;
if (!T) { console.error('TRACKFORGE_TOKEN required'); process.exit(1); }

const j = async (m, p, body) => {
  const r = await fetch(`${B}${p}`, {
    method: m,
    headers: { Authorization: `Bearer ${T}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await r.text();
  let data; try { data = JSON.parse(t); } catch { data = t; }
  return { status: r.status, data };
};

// 1. project
let proj = await j('GET', '/rest/api/2/project/WEB');
if (proj.status === 404) {
  proj = await j('POST', '/rest/api/2/project', {
    key: 'WEB', name: 'Website Redesign', description: 'Marketing site refresh — demo project',
  });
}
console.log('project:', proj.status, proj.data?.key ?? proj.data?.errorMessages);

// 2. issues
const issues = [
  ['Hero section copy refresh', 'Task'],
  ['Responsive nav breakpoints', 'Task'],
  ['Lighthouse performance pass', 'Task'],
  ['Migrate blog images to CDN', 'Task'],
  ['Pricing page A/B variant', 'Story'],
  ['Newsletter signup form', 'Story'],
  ['Accessibility audit fixes', 'Bug'],
];
const keys = [];
for (const [summary, type] of issues) {
  const r = await j('POST', '/rest/api/2/issue', {
    fields: { project: { key: 'WEB' }, summary, issuetype: { name: type },
      description: `Part of the website refresh.`, labels: ['website', 'q1'] },
  });
  keys.push(r.data?.key);
  console.log('issue:', r.status, r.data?.key ?? r.data?.errorMessages);
}

// 3. move a couple through transitions so the board has all columns
const transit = async (key, name) => {
  const tr = await j('GET', `/rest/api/2/issue/${key}/transitions`);
  const t = tr.data?.transitions?.find((x) => new RegExp(name, 'i').test(x.name));
  if (!t) { console.log(`  no transition "${name}" for ${key}`); return; }
  const r = await j('POST', `/rest/api/2/issue/${key}/transitions`, { transition: { id: t.id } });
  console.log(`  ${key} → ${name}:`, r.status);
};
await transit(keys[1], 'progress|start');
await transit(keys[2], 'progress|start');
await transit(keys[3], 'done|complete|resolve');

// 4. delegate agent on WEB-1 → session + activities
const agentIssue = keys[0];
const d = await j('PUT', `/rest/api/2/issue/${agentIssue}`, { fields: { delegate: { email: 'eval-agent@trackforge.local' } } });
console.log('delegate:', d.status, d.data?.errorMessages ?? 'ok');
const sess = await j('GET', `/api/internal/issues/${agentIssue}/sessions`);
const sid = sess.data?.sessions?.[0]?.id ?? sess.data?.[0]?.id;
console.log('session:', sid);
if (sid) {
  for (const a of [
    { type: 'thought', message: 'Scanning the brief — the hero copy needs to match the new brand voice guide before I touch markup.' },
    { type: 'action', message: 'Drafted 3 headline variants in the issue description; flagged the CTA button copy for review.' },
    { type: 'action', message: 'Cross-checked SEO title length — all variants under 60 chars.' },
  ]) {
    const r = await j('POST', `/api/internal/agent-sessions/${sid}/activities`, a);
    console.log('activity:', r.status, a.type);
  }
}

// 5. gated token → parked proposal (populates the Approvals inbox)
const tok = await j('POST', '/api/internal/tokens', {
  name: 'showcase-gated', scopes: ['read', 'write'], approvalPolicy: 'always',
});
if (tok.data?.secret) {
  const r = await fetch(`${B}/rest/api/2/issue/${keys[4]}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${tok.data.secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ fields: { summary: 'Pricing page A/B variant — annual toggle' } }),
  });
  const p = await r.json();
  console.log('proposal parked:', r.status, p.proposalId ?? p.errorMessages);
} else {
  console.log('gated token mint failed:', tok.status, tok.data?.errorMessages);
}
console.log('showcase seed done');
