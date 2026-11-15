import { describe, it, expect, beforeAll } from 'vitest';
import app from '../../src/main.js';
import { authed } from '../request.js';
import { prisma } from '../../src/prisma.js';
import { getDurableRunner } from '../../src/lib/jobs.js';
import { registerImportHandlers } from '../../src/import/service.js';
import { csvToFixture, parseCsv } from '../../src/import/csvSource.js';

beforeAll(() => registerImportHandlers());

const CSV = `Summary,Issue key,Issue Type,Status,Priority,Assignee,Reporter,Created,Labels,Labels,Comment,Component/s,Fix Version/s,Story Points,Parent,Sprint
"oauth login flow",CS-1,Task,In Progress,High,ada@x.com,Bob Smith,2026-01-05,auth,backend,"05/Jan/26 10:00 AM;Bob Smith;looks good",identity,1.0,3,,Sprint 7
"sso callback",CS-2,Bug,To Do,Medium,ada@x.com,Bob Smith,2026-01-06,sso,,,identity,,2,CS-1,Sprint 7
`;

const CSV_ATTACH = `Summary,Issue key,Issue Type,Status,Priority,Assignee,Reporter,Attachment
"att issue",CS-9,Task,To Do,Medium,ada@x.com,Bob,https://files.example.com/a%20b.pdf
`;

describe('039 CSV importer', () => {
  it('parseCsv handles quotes, commas, repeated headers', () => {
    const rows = parseCsv('a,"b,c","d""q"\n1,2,3\n');
    expect(rows).toEqual([['a', 'b,c', 'd"q'], ['1', '2', '3']]);
  });

  it('csvToFixture builds a Jira-shaped fixture', () => {
    const fx = csvToFixture(CSV);
    const issues = (fx['/rest/api/3/search'] as { issues: { key: string; fields: Record<string, unknown> }[] }).issues;
    expect(issues).toHaveLength(2);
    expect((issues[0].fields.labels as string[])).toEqual(['auth', 'backend']);
    expect((issues[0].fields.comment as { comments: unknown[] }).comments).toHaveLength(1);
    expect((issues[1].fields.parent as { key: string }).key).toBe('CS-1');
    const users = fx['/rest/api/3/users/search'] as { accountId: string }[];
    expect(users.map((u) => u.accountId)).toContain('csv:ada-x-com');
  });

  it('runs the full import pipeline: users → project → issues → comments → links', async () => {
    const res = await authed(app).post('/api/internal/migration/csv').send({ csv: CSV, dryRun: false });
    expect(res.status).toBe(202);
    expect(res.body.source).toBe('csv');
    await getDurableRunner().flush();
    const job = (await authed(app).get(`/api/internal/migration/${res.body.id}`)).body;
    expect(job.stage).toBe('done');
    expect(job.report.plan.issue.creates).toBe(2);
    expect(job.report.errors ?? []).toEqual([]);

    const p = await prisma.project.findUniqueOrThrow({ where: { key: 'CS' } });
    const issues = await prisma.issue.findMany({ where: { projectId: p.id }, orderBy: { issueNumber: 'asc' } });
    expect(issues.map((i) => `${p.key}-${i.issueNumber}`)).toEqual(['CS-1', 'CS-2']);
    const cs2 = issues[1];
    expect(cs2.summary).toBe('sso callback');
    const parent = await prisma.issue.findUniqueOrThrow({ where: { id: cs2.parentId! } });
    expect(parent.summary).toBe('oauth login flow');
    expect([...issues[0].labels].sort()).toEqual(['auth', 'backend']);
    const comments = await prisma.comment.findMany({ where: { issueId: issues[0].id } });
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain('looks good');
    const comp = await prisma.component.findFirst({ where: { projectId: p.id } });
    expect(comp?.name).toBe('identity');
    // Sprint column → Sprint row + IssueSprint membership
    const sprint = await prisma.sprint.findFirst({ where: { projectId: p.id, name: 'Sprint 7' } });
    expect(sprint).toBeTruthy();
    const membership = await prisma.issueSprint.findFirst({ where: { sprintId: sprint!.id, removedAt: null } });
    expect(membership).toBeTruthy();
  });

  it('preview endpoint maps headers and samples rows', async () => {
    const res = await authed(app).post('/api/internal/migration/csv/preview').send({ csv: CSV, maxRows: 1 });
    expect(res.status).toBe(200);
    expect(res.body.issueCount).toBe(2);
    expect(res.body.projectKeys).toEqual(['CS']);
    expect(res.body.mapping['issue key']).toBe('issueKey');
    expect(res.body.mapping['sprint']).toBe('sprint');
    expect(res.body.preview).toHaveLength(1);
    expect(res.body.preview[0]['Summary']).toBe('oauth login flow');
  });

  it('attachment URLs surface as planned attachment ops', async () => {
    const fx = csvToFixture(CSV_ATTACH);
    const issue = (fx['/rest/api/3/search'] as { issues: { fields: { attachment: { content: string | null; filename: string }[] } }[] }).issues[0];
    expect(issue.fields.attachment[0].filename).toBe('a b.pdf');
    expect(issue.fields.attachment[0].content).toBe('https://files.example.com/a%20b.pdf');
  });

  it('dry-run plans without writing issues', async () => {
    const res = await authed(app).post('/api/internal/migration/csv').send({ csv: CSV, dryRun: true });
    expect(res.status).toBe(202);
    await getDurableRunner().flush();
    const job = (await authed(app).get(`/api/internal/migration/${res.body.id}`)).body;
    expect(job.stage).toBe('done');
    expect(job.report.plan.issue.creates).toBe(2);
    expect(await prisma.issue.count({ where: { project: { key: 'CS' } } })).toBe(0);
  });
});
