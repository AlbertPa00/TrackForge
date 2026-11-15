import { describe, it, expect, beforeAll } from 'vitest';
import app from '../../src/main.js';
import { authed } from '../request.js';
import { prisma } from '../../src/prisma.js';
import { getDurableRunner } from '../../src/lib/jobs.js';
import { registerImportHandlers } from '../../src/import/service.js';
import { entitiesXmlToFixture } from '../../src/import/xmlSource.js';

beforeAll(() => registerImportHandlers());

/* Minimal stored-zip writer (no compression, CRC-32) for test fixtures. */
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer) => buf.reduce((crc, b) => (CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0, 0xffffffff) ^ 0xffffffff;

function makeZip(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf-8');
    const data = Buffer.from(content, 'utf-8');
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    chunks.push(local, nameBuf, data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(data.length, 20); cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28); cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += 30 + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const count = Object.keys(files).length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(count, 8); eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cdBuf.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, cdBuf, eocd]);
}

const ENTITIES_XML = `<?xml version="1.0"?>
<entities>
  <User id="1" userName="admin" displayName="Admin User" lowerEmailAddress="admin@x.io" active="1"/>
  <User id="2" userName="bob" displayName="Bob B" lowerEmailAddress="bob@x.io" active="1"/>
  <Project id="100" key="XT" name="Xml Test" lead="1"/>
  <IssueType id="1" name="Task"/><IssueType id="2" name="Bug"/>
  <Status id="1" name="To Do"/><Status id="3" name="Done"/>
  <Priority id="3" name="Medium"/>
  <Resolution id="1" name="Done"/>
  <Component id="500" project="100" name="Backend"/>
  <Version id="600" project="100" name="v1.0"/>
  <Issue id="1001" project="100" number="1" type="1" status="1" priority="3" summary="First issue" reporter="admin" assignee="bob" created="2024-01-01 10:00:00.0" updated="2024-01-02 10:00:00.0"/>
  <Issue id="1002" project="100" number="2" type="2" status="3" summary="Bug two" reporter="bob" resolution="1" created="2024-01-01 11:00:00.0"/>
  <NodeAssociation sourceNodeEntity="Issue" sourceNodeId="1001" sinkNodeEntity="Component" sinkNodeId="500" associationType="IssueComponent"/>
  <NodeAssociation sourceNodeEntity="Issue" sourceNodeId="1001" sinkNodeEntity="Version" sinkNodeId="600" associationType="IssueFixVersion"/>
  <Label issue="1001" label="imported"/>
  <Action id="700" issue="1001" type="comment" author="bob" body="hello world" created="2024-01-03 09:00:00.0"/>
  <LinkType id="1000" linkname="Blocks" inward="is blocked by" outward="blocks"/>
  <IssueLink id="800" linktype="1000" source="1001" destination="1002"/>
  <ChangeGroup id="900" issue="1001" author="admin" created="2024-01-04 12:00:00.0"/>
  <ChangeItem id="901" group="900" field="status" fieldtype="jira" oldstring="To Do" newstring="In Progress"/>
  <ChangeItem id="902" group="900" field="assignee" fieldtype="jira" oldstring="" newstring="bob"/>
</entities>`;

describe('Jira Server XML backup import', () => {
  it('parses entities.xml into a Jira-shaped fixture map', () => {
    const fx = entitiesXmlToFixture(ENTITIES_XML) as any;
    const users = fx['/rest/api/3/users/search'];
    expect(users).toHaveLength(2);
    const search = fx['/rest/api/3/search'];
    expect(search.issues).toHaveLength(2);
    const i1 = search.issues.find((i: any) => i.key === 'XT-1');
    expect(i1.fields.summary).toBe('First issue');
    expect(i1.fields.labels).toEqual(['imported']);
    expect(i1.fields.components[0].name).toBe('Backend');
    expect(i1.fields.fixVersions[0].name).toBe('v1.0');
    expect(i1.fields.comment.comments[0].body).toBe('hello world');
    expect(i1.fields.issuelinks).toHaveLength(1);
    expect(i1.fields.changelog.histories).toHaveLength(1);
    expect(i1.fields.changelog.histories[0].items).toHaveLength(2);
  });

  it('runs the full pipeline from a zipped backup incl. changelog', async () => {
    const zip = makeZip({ 'entities.xml': ENTITIES_XML });
    const agent = await authed(app);
    const res = await agent
      .post('/api/internal/migration/jira-server-xml')
      .send({ zipBase64: zip.toString('base64') })
      .expect(202);
    const jobId = res.body.id;
    await getDurableRunner().flush();
    const job = (await agent.get(`/api/internal/migration/${jobId}`).expect(200)).body;
    expect(job.stage).toBe('done');
    expect(job.report.errors ?? []).toEqual([]);

    const project = await prisma.project.findUniqueOrThrow({ where: { key: 'XT' } });
    expect(project.name).toBe('Xml Test');
    const i1 = await prisma.issue.findFirstOrThrow({
      where: { projectId: project.id, issueNumber: 1 },
      include: { comments: true, components: { include: { component: true } }, versionRefs: { include: { version: true } } },
    });
    expect(i1.summary).toBe('First issue');
    expect(i1.labels).toEqual(['imported']);
    expect(i1.comments).toHaveLength(1);
    expect(i1.comments[0].body).toBe('hello world');
    expect(i1.components.map((c) => c.component.name)).toEqual(['Backend']);
    expect(i1.versionRefs.filter((v) => v.kind === 'fix').map((v) => v.version.name)).toEqual(['v1.0']);
    // issue link
    const i2 = await prisma.issue.findFirstOrThrow({ where: { projectId: project.id, issueNumber: 2 } });
    const links = await prisma.issueLink.findMany({
      where: { OR: [{ outwardId: i1.id }, { inwardId: i1.id }] },
    });
    expect(links).toHaveLength(1);
    expect([links[0].outwardId, links[0].inwardId].sort()).toEqual([i1.id, i2.id].sort());
    // changelog imported as native history
    const histories = await prisma.changeHistory.findMany({
      where: { issueId: i1.id, channel: 'import' },
      include: { items: true },
    });
    expect(histories).toHaveLength(1);
    expect(histories[0].items).toHaveLength(2);
    expect(histories[0].items.map((i) => i.field).sort()).toEqual(['assignee', 'status']);
    expect(histories[0].items.find((i) => i.field === 'status')?.toString).toBe('In Progress');
    expect(histories[0].createdAt.toISOString()).toContain('2024-01-04');
  });

  it('rejects a non-zip body', async () => {
    const agent = await authed(app);
    await agent
      .post('/api/internal/migration/jira-server-xml')
      .send({ zipBase64: Buffer.from('not a zip').toString('base64') })
      .expect(400);
  });
});
