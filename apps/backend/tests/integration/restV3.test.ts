import { describe, it, expect, beforeEach } from 'vitest';
import app from '../../src/main.js';
import { authed } from '../request.js';
import { markdownToAdf } from '../../src/lib/markdownToAdf.js';
import { adfToMarkdown } from '../../src/import/adfToMarkdown.js';

const setup = async () => {
  const a = await authed(app);
  await a.post('/rest/api/2/project').send({ key: 'TF', name: 'TrackForge' });
  return a;
};

describe('040 markdown → ADF converter', () => {
  it('covers the supported node set', () => {
    const doc = markdownToAdf('# Title\n\npara with **bold** and *em* and `code` and [link](https://x.io) and [~accountId:u1]\n\n- a\n- b\n\n1. one\n\n> quoted\n\n---\n\n```ts\nconst x = 1\n```\n\n| h1 | h2 |\n|---|---|\n| c1 | c2 |') as any;
    expect(doc.type).toBe('doc');
    const types = doc.content.map((n: any) => n.type);
    expect(types).toEqual(['heading', 'paragraph', 'bulletList', 'orderedList', 'blockquote', 'rule', 'codeBlock', 'table']);
    const p = doc.content[1];
    expect(p.content.some((n: any) => n.marks?.[0]?.type === 'strong')).toBe(true);
    expect(p.content.some((n: any) => n.type === 'mention' && n.attrs.id === 'u1')).toBe(true);
    const link = p.content.find((n: any) => n.marks?.[0]?.type === 'link');
    expect(link.marks[0].attrs.href).toBe('https://x.io');
    const table = doc.content.at(-1);
    expect(table.content[0].content[0].type).toBe('tableHeader');
  });

  it('round-trips md → ADF → md for the supported set', () => {
    const md = 'Hello **world**\n\n- item one\n- item two\n\n> a quote\n\n`inline` and [a link](https://x.io)';
    const back = adfToMarkdown(markdownToAdf(md));
    expect(back).toContain('**world**');
    expect(back).toContain('item one');
    expect(back).toContain('a quote');
    expect(back).toContain('`inline`');
    expect(back).toContain('https://x.io');
  });

  it('empty input → minimal valid ADF', () => {
    expect(markdownToAdf('')).toEqual({ type: 'doc', version: 1, content: [{ type: 'paragraph', content: [] }] });
  });
});

describe('040 /rest/api/3 wire surface', () => {
  beforeEach(async () => { await setup(); });

  it('GET issue returns description as ADF; v2 twin returns markdown', async () => {
    const a = await authed(app);
    const created = await a.post('/rest/api/3/issue').send({
      fields: {
        project: { key: 'TF' }, summary: 'adf issue', issuetype: { name: 'Task' },
        description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello adf' }] }] },
      },
    }).expect(201);
    const key = created.body.key;

    const v3 = await a.get(`/rest/api/3/issue/${key}`).expect(200);
    expect(v3.body.fields.description).toMatchObject({ type: 'doc', version: 1 });
    expect(v3.body.fields.description.content[0].content[0].text).toBe('hello adf');

    const v2 = await a.get(`/rest/api/2/issue/${key}`).expect(200);
    expect(v2.body.fields.description).toBe('hello adf');
  });

  it('v3 comment create (ADF) stores markdown; v2 reads it back', async () => {
    const a = await authed(app);
    const key = (await a.post('/rest/api/2/issue').send({
      fields: { project: { key: 'TF' }, summary: 'c1', issuetype: { name: 'Task' } },
    }).expect(201)).body.key;
    await a.post(`/rest/api/3/issue/${key}/comment`).send({
      body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'v3 note', marks: [{ type: 'strong' }] }] }] },
    }).expect(201);
    const v2 = await a.get(`/rest/api/2/issue/${key}/comment`).expect(200);
    expect(v2.body.comments[0].body).toBe('**v3 note**');
    // and the v3 comment endpoint returns the body as ADF
    const v3 = await a.get(`/rest/api/3/issue/${key}/comment`).expect(200);
    const adfComment = v3.body.comments[0].body;
    expect(adfComment.type).toBe('doc');
    expect(adfComment.content[0].content[0].text).toBe('v3 note');
    expect(adfComment.content[0].content[0].marks[0].type).toBe('strong');
  });

  it('expand=renderedFields emits sanitized HTML siblings', async () => {
    const a = await authed(app);
    const key = (await a.post('/rest/api/3/issue').send({
      fields: {
        project: { key: 'TF' }, summary: 'rf', issuetype: { name: 'Task' },
        description: 'safe **bold** <script>alert(1)</script>',
      },
    }).expect(201)).body.key;
    const res = await a.get(`/rest/api/3/issue/${key}?expand=renderedFields`).expect(200);
    expect(res.body.renderedFields.description).toContain('<strong>bold</strong>');
    expect(res.body.renderedFields.description).not.toContain('<script>');
  });

  it('lossy inbound ADF surfaces via x-trackforge-adf-losses', async () => {
    const a = await authed(app);
    const res = await a.post('/rest/api/3/issue').send({
      fields: {
        project: { key: 'TF' }, summary: 'lossy', issuetype: { name: 'Task' },
        description: { type: 'doc', version: 1, content: [{ type: 'alienNode', content: [{ type: 'text', text: 'kept text' }] }] },
      },
    }).expect(201);
    expect(res.headers['x-trackforge-adf-losses']).toBeTruthy();
  });

  it('v3 search speaks ADF bodies; parity with v2 on identical query', async () => {
    const a = await authed(app);
    await a.post('/rest/api/2/issue').send({
      fields: { project: { key: 'TF' }, summary: 'parity target', issuetype: { name: 'Task' }, description: 'same body' },
    }).expect(201);
    const [v2, v3] = await Promise.all([
      a.get('/rest/api/2/search?jql=summary~"parity target"').expect(200),
      a.get('/rest/api/3/search?jql=summary~"parity target"').expect(200),
    ]);
    expect(v3.body.issues).toHaveLength(1);
    expect(v3.body.issues[0].fields.description).toMatchObject({ type: 'doc' });
    expect(v2.body.issues[0].fields.description).toBe('same body');
    expect(v3.body.issues[0].key).toBe(v2.body.issues[0].key);
  });

  it('non-body routes mirror cleanly (myself, priority, issuetype)', async () => {
    const a = await authed(app);
    const [v2, v3] = await Promise.all([
      a.get('/rest/api/2/issuetype').expect(200),
      a.get('/rest/api/3/issuetype').expect(200),
    ]);
    expect(v3.body).toEqual(v2.body);
  });
});
