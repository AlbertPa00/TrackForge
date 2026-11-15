#!/usr/bin/env node
// 045 — post-deploy smoke suite. Shared by deploy.yml, restore-drill docs,
// and operators: `BASE_URL=… ADMIN_EMAIL=… ADMIN_PASSWORD=… node tests/smoke/smoke.mjs`
// Exercises the P1 journeys that prove a deploy is good: health, auth,
// project list, issue create/edit, JQL, board fetch. Exit 1 on any failure.
const BASE = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com';
const PASS = process.env.ADMIN_PASSWORD ?? 'admin123';

let cookie = '';
let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failures += 1;
};

const j = async (path, opts = {}) => {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', cookie, ...(opts.headers ?? {}) },
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  let body = null;
  try { body = await res.json(); } catch { /* html/empty */ }
  return { status: res.status, body };
};

console.log(`smoke → ${BASE}`);
{
  const r = await fetch(`${BASE}/healthz`);
  const b = await r.json().catch(() => ({}));
  ok('healthz 200 + ok', r.status === 200 && b.status === 'ok');
}
{
  const r = await j('/rest/api/2/serverInfo');
  ok('serverInfo', r.status === 200 && !!r.body?.version, r.body?.version);
}
{
  const r = await j('/api/internal/auth/login', {
    method: 'POST', body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  ok('admin login', r.status === 200 && !!cookie);
  if (!cookie) { console.log('\nSMOKE FAIL — cannot continue unauthenticated'); process.exit(1); }
}
{
  const r = await j('/rest/api/2/project');
  ok('project list', r.status === 200 && Array.isArray(r.body));
  globalThis.__key = r.body?.[0]?.key;
}
// create → edit → JQL the new issue (proves write path + search index)
{
  const key = globalThis.__key;
  if (!key) { ok('issue create (needs ≥1 project)', false); }
  else {
    const c = await j('/rest/api/2/issue', {
      method: 'POST',
      body: JSON.stringify({ fields: { project: { key }, summary: 'smoke-deploy-check', issuetype: { name: 'Task' } } }),
    });
    const ikey = c.body?.key;
    ok('issue create', c.status === 201 && !!ikey, ikey);
    if (ikey) {
      const e = await j(`/rest/api/2/issue/${ikey}`, {
        method: 'PUT', body: JSON.stringify({ fields: { summary: 'smoke-deploy-check edited' } }),
      });
      ok('issue edit', e.status === 200);
      const s = await j(`/rest/api/2/search?jql=${encodeURIComponent(`key = ${ikey}`)}`);
      ok('JQL find created issue', s.status === 200 && s.body?.issues?.some((i) => i.key === ikey));
    }
  }
}
{
  const r = await j('/api/internal/boards');
  ok('board list', r.status === 200);
}

console.log(failures ? `\nSMOKE FAIL — ${failures} check(s) failed` : '\nSMOKE PASS');
process.exit(failures ? 1 : 0);
