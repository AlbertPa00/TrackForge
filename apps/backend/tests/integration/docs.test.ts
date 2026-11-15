// 050 — docs portal: SC-001 audience gating, SC-002 manifest registry drift.
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import app from '../../src/main.js';
import { authed } from '../request.js';
import { prisma } from '../../src/prisma.js';
import { generateToken } from '../../src/lib/auth.js';
import { docsRoot, loadManifest, renderMarkdown, searchDocs } from '../../src/services/docsService.js';
import type { Actor } from '../../src/lib/auth.js';

let server: Server | null = null;
afterAll(() => { server?.close(); server = null; });
const anon = () => { server ??= app.listen(0); return request.agent(server); };

describe('docs manifest registry (US1)', () => {
  const manifest = loadManifest();

  it('every docs/*.md is registered and every manifest source exists', () => {
    const onDisk = readdirSync(docsRoot()).filter((f) => f.endsWith('.md'));
    const registered = new Set(manifest.pages.map((p) => p.source));
    for (const f of onDisk) {
      expect(registered.has(f), `unregistered doc: ${f}`).toBe(true);
    }
    for (const p of manifest.pages) {
      expect(existsSync(join(docsRoot(), p.source)), `missing source: ${p.source}`).toBe(true);
      expect(manifest.sections[p.section], `unknown section ${p.section} (${p.slug})`).toBeTruthy();
      expect(['public', 'authed', 'admin']).toContain(p.audience);
    }
  });

  it('slugs are unique and sources are not shared', () => {
    const slugs = manifest.pages.map((p) => p.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    const sources = manifest.pages.map((p) => p.source);
    expect(new Set(sources).size).toBe(sources.length);
  });

  it('relative markdown links resolve to files or anchors', () => {
    const slugify = (h: string) => h.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-');
    const headingsOf = (file: string) => new Set(
      readFileSync(join(docsRoot(), file), 'utf8').split('\n')
        .filter((l) => /^#{1,6}\s/.test(l))
        .map((l) => slugify(l.replace(/^#{1,6}\s+/, '').trim())),
    );
    const linkRe = /\[[^\]]*\]\(([^)\s]+)\)/g;
    for (const p of manifest.pages) {
      const md = readFileSync(join(docsRoot(), p.source), 'utf8');
      const anchors = headingsOf(p.source);
      for (const m of md.matchAll(linkRe)) {
        const href = m[1];
        if (/^[a-z]+:/.test(href)) continue; // external scheme
        if (href.startsWith('#')) {
          expect(anchors.has(href.slice(1)), `${p.source}: dead anchor ${href}`).toBe(true);
          continue;
        }
        const [file, anchor] = href.split('#');
        const target = join(docsRoot(), file);
        expect(existsSync(target), `${p.source}: dead link ${href}`).toBe(true);
        if (anchor && file.endsWith('.md')) {
          expect(headingsOf(file).has(anchor), `${p.source}: dead anchor ${href}`).toBe(true);
        }
      }
    }
  });
});

describe('docs API (SC-001, FR-002)', () => {
  let userBearer: string;
  beforeEach(async () => {
    const u = await prisma.user.create({
      data: { email: 'docsuser@test.local', displayName: 'Docs User', passwordHash: 'x', isAdmin: false },
    });
    const { plain, prefix, hash } = generateToken();
    await prisma.apiToken.create({ data: { userId: u.id, name: 't', prefix, hash, scopes: ['read', 'write'] } });
    userBearer = plain;
  });
  const asUser = () => { server ??= app.listen(0); return request.agent(server).set('Authorization', `Bearer ${userBearer}`); };

  it('manifest is audience-filtered: anonymous sees only public pages', async () => {
    const res = await anon().get('/api/internal/docs/manifest');
    expect(res.status).toBe(200);
    const audiences = new Set(res.body.pages.map((p: { audience: string }) => p.audience));
    expect([...audiences]).toEqual(['public']);
    expect(res.body.sections).toBeTruthy();
  });

  it('authed actor sees public+authed; admin sees admin too', async () => {
    const res = await asUser().get('/api/internal/docs/manifest');
    const auds = new Set(res.body.pages.map((p: { audience: string }) => p.audience));
    expect(auds.has('authed')).toBe(true);
    expect(auds.has('admin')).toBe(false);
    const adm = await authed(app).get('/api/internal/docs/manifest');
    const adminAuds = new Set(adm.body.pages.map((p: { audience: string }) => p.audience));
    expect(adminAuds.has('admin')).toBe(true);
  });

  it('admin pages 404 anonymously and for non-admin actors (no existence leak)', async () => {
    expect((await anon().get('/api/internal/docs/page/threat-model')).status).toBe(404);
    expect((await asUser().get('/api/internal/docs/page/threat-model')).status).toBe(404);
    expect((await authed(app).get('/api/internal/docs/page/threat-model')).status).toBe(200);
  });

  it('public page renders sanitized HTML; script payloads stripped', async () => {
    expect((await anon().get('/api/internal/docs/page/user-guide')).status).toBe(404);
    const pub = await anon().get('/api/internal/docs/page/capability-matrix');
    expect(pub.status).toBe(200);
    expect(pub.body.html).toContain('<');
    expect(pub.body.markdown.length).toBeGreaterThan(100);
    const xss = renderMarkdown('<script>alert(1)</script>\n\n[x](javascript:alert(1))');
    expect(xss).not.toContain('script');
    expect(xss).not.toContain('javascript:');
  });

  it('search index is audience-filtered and carries headings', async () => {
    const res = await anon().get('/api/internal/docs/index');
    expect(res.status).toBe(200);
    const slugs = res.body.index.map((i: { slug: string }) => i.slug);
    expect(slugs).toContain('capability-matrix');
    expect(slugs).not.toContain('threat-model');
  });

  // 056 — searchDocs matches the whole phrase OR every term (prose rarely
  // repeats a query verbatim).
  it('renders callouts, highlighted code, and anchor links (portal refresh)', () => {
    const html = renderMarkdown('> [!WARNING]\n> mind the gap\n\n```ts\nconst x: number = 1\n```\n\n## Deep link');
    expect(html).toContain('tf-callout-warning');
    expect(html).toContain('>WARNING<');
    expect(html).not.toContain('[!WARNING]');
    expect(html).toContain('data-lang="ts"');
    expect(html).toContain('language-ts');
    expect(html).toContain('hljs-'); // real token highlighting, not escaped plain text
    expect(html).toContain('id="deep-link"');
    expect(html).toContain('class="tf-anchor" href="#deep-link"');
    // unknown admonition markers degrade to a plain blockquote
    expect(renderMarkdown('> [!BOGUS]\n> x')).toContain('<blockquote>');
    // unhighlighted languages still get the code shell, escaped
    const plain = renderMarkdown('```weirdlang\na<b\n```');
    expect(plain).toContain('tf-code');
    expect(plain).toContain('a&lt;b');
    expect(plain).not.toContain('a<b');
  });

  it('searchDocs: whole-phrase hit OR all-term coverage', () => {
    const admin = { user: { isAdmin: true } } as Actor;
    const phrase = searchDocs('api token scopes', admin).map((h) => h.slug);
    expect(phrase).toContain('user-guide');
    expect(phrase).toContain('security-model');
    const terms = searchDocs('scopes api', admin).map((h) => h.slug);
    expect(terms).toContain('security-model');
    expect(searchDocs('qqzzxx-nothing-matches', admin)).toEqual([]);
    expect(searchDocs('a', admin)).toEqual([]);
  });

  it('DOCS_PUBLIC=on opens authed pages to anonymous; admin stays closed', async () => {
    process.env.DOCS_PUBLIC = 'on';
    try {
      const res = await anon().get('/api/internal/docs/manifest');
      const auds = new Set(res.body.pages.map((p: { audience: string }) => p.audience));
      expect(auds.has('authed')).toBe(true);
      expect(auds.has('admin')).toBe(false);
      expect((await anon().get('/api/internal/docs/page/user-guide')).status).toBe(200);
      expect((await anon().get('/api/internal/docs/page/threat-model')).status).toBe(404);
    } finally {
      delete process.env.DOCS_PUBLIC;
    }
  });
});
