/**
 * Sprint 039 US-XML: Jira Server/DC backup entities.xml → fixture map.
 *
 * entities.xml is a flat table dump (<Issue>, <Action type="comment">,
 * <User>, <NodeAssociation>, <ChangeGroup>/<ChangeItem>…). We normalize it
 * into Jira Cloud REST shapes so the 017 pipeline runs unchanged, including
 * changelog rows (surfaced as fields.changelog for the history importer).
 */
import { XMLParser } from 'fast-xml-parser';
import yauzl from 'yauzl';
import { Readable } from 'node:stream';

interface Row {
  [k: string]: string | undefined;
}

function table(xml: Record<string, unknown>, name: string): Row[] {
  const v = xml[name];
  if (v === undefined) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr as Row[];
}

/** Extract entities.xml (and optional attachments manifest) from a backup zip. */
export async function unzipXmlBackup(buf: Buffer): Promise<{ entitiesXml: string; attachmentPaths: Set<string> }> {
  return new Promise((resolve, reject) => {
    const out = { entitiesXml: '', attachmentPaths: new Set<string>() };
    yauzl.fromBuffer(buf, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error('not a zip'));
      zip.readEntry();
      zip.on('entry', (entry: yauzl.Entry) => {
        const name = entry.fileName;
        if (/attachments?\//i.test(name) && !entry.fileName.endsWith('/')) out.attachmentPaths.add(name);
        if (/entities\.xml$/i.test(name)) {
          // 064 US6 — zip-bomb guard: cap decompressed entities.xml (admin-only
          // surface, but a crafted 100KB zip can inflate to GBs in memory).
          const MAX_XML = 1024 * 1024 * 1024;
          if (entry.uncompressedSize > MAX_XML) return reject(new Error('entities.xml exceeds 1GB decompressed cap'));
          zip.openReadStream(entry, (e2, stream?: Readable) => {
            if (e2 || !stream) return reject(e2 ?? new Error('no stream'));
            const chunks: Buffer[] = [];
            let size = 0;
            stream.on('data', (c: Buffer) => {
              size += c.length;
              if (size > MAX_XML) {
                stream.destroy();
                return reject(new Error('entities.xml exceeds 1GB decompressed cap'));
              }
              chunks.push(c);
            });
            stream.on('end', () => {
              out.entitiesXml = Buffer.concat(chunks).toString('utf-8');
              zip.readEntry();
            });
          });
        } else zip.readEntry();
      });
      zip.on('end', () => {
        if (!out.entitiesXml) reject(new Error('zip contains no entities.xml'));
        else resolve(out);
      });
    });
  });
}

const num = (v: string | undefined) => (v ? Number(v) : undefined);
const acct = (userName?: string) => (userName ? { accountId: `xml:${userName.toLowerCase()}` } : null);
/** Jira Server dates look like '2024-01-03 09:00:00.0' — normalize to ISO. */
const dt = (v?: string) => (v ? v.replace(' ', 'T').replace(/(\.\d)\d*$/, '$1') : undefined);

/** entities.xml text → fixture map (Jira Cloud REST shapes). */
export function entitiesXmlToFixture(xmlText: string): Record<string, unknown> {
  // 064 US6 — processEntities:false (already the default since fxp 4.1) pinned
  // explicitly so a dep bump can't silently re-enable entity expansion.
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: false });
  const doc = parser.parse(xmlText) as Record<string, unknown>;
  const root = (doc.entities ?? doc) as Record<string, unknown>;

  const users = table(root, 'User').map((u) => ({
    accountId: `xml:${String(u['@_userName'] ?? u['@_name'] ?? u['@_id']).toLowerCase()}`,
    emailAddress: u['@_emailAddress'] ?? u['@_lowerEmailAddress'] ?? `${u['@_userName']}@import.local`,
    displayName: u['@_displayName'] ?? u['@_fullName'] ?? u['@_userName'] ?? 'Unknown',
    active: String(u['@_active'] ?? '1') !== '0',
  }));
  const userById = new Map(
    table(root, 'User').map((u) => [u['@_id'] ?? '', `xml:${String(u['@_userName'] ?? u['@_id']).toLowerCase()}`])
  );
  const acctById = (id?: string) => (id && userById.get(id) ? { accountId: userById.get(id) } : null);
  const acctByName = (name?: string) => acct(name ?? undefined);

  const types = table(root, 'IssueType').map((t) => ({
    id: t['@_id'],
    name: t['@_name'],
    subtask: String(t['@_type'] ?? '') === 'jira_subtask' || /sub/i.test(t['@_name'] ?? ''),
  }));
  const statuses = table(root, 'Status').map((s) => ({
    id: s['@_id'],
    name: s['@_name'],
    statusCategory: { key: /done|closed|resolved/i.test(s['@_name'] ?? '') ? 'done' : 'new' },
  }));
  const priorities = table(root, 'Priority').map((p) => ({ id: p['@_id'], name: p['@_name'] }));
  const resolutions = table(root, 'Resolution').map((r) => ({ id: r['@_id'], name: r['@_name'] }));
  const typeById = new Map(types.map((t) => [t.id, t.name]));
  const statusById = new Map(statuses.map((s) => [s.id, s.name]));
  const prioById = new Map(priorities.map((p) => [p.id, p.name]));
  const resById = new Map(resolutions.map((r) => [r.id, r.name]));

  const projects = table(root, 'Project').map((p) => ({
    id: p['@_id'],
    key: p['@_key'],
    name: p['@_name'] ?? p['@_key'],
    lead: acctById(p['@_lead']) ?? acctByName(p['@_leadname']),
    projectTypeKey: 'software',
  }));

  const components = table(root, 'Component');
  const versions = table(root, 'Version');
  const labels = new Map<string, string[]>();
  for (const l of table(root, 'Label')) {
    const k = l['@_issue'] ?? '';
    labels.set(k, [...(labels.get(k) ?? []), l['@_label'] ?? ''].filter(Boolean));
  }
  const comments = new Map<string, unknown[]>();
  const worklogs = new Map<string, unknown[]>();
  for (const a of table(root, 'Action')) {
    const issueId = a['@_issue'] ?? '';
    if (a['@_type'] === 'comment' || (a['@_body'] && !a['@_timeworked'])) {
      comments.set(issueId, [
        ...(comments.get(issueId) ?? []),
        {
          id: a['@_id'],
          body: a['@_body'] ?? '',
          author: acctByName(a['@_author']),
          created: dt(a['@_created']),
        },
      ]);
    }
    if (a['@_type'] === 'worklog' || a['@_timeworked']) {
      worklogs.set(issueId, [
        ...(worklogs.get(issueId) ?? []),
        {
          id: a['@_id'],
          timeSpentSeconds: num(a['@_timeworked']),
          author: acctByName(a['@_author']),
          started: dt(a['@_startdate'] ?? a['@_created']),
          comment: a['@_body'],
        },
      ]);
    }
  }
  // associations: Issue→Component / Issue→Version (fix + affects)
  const assoc = new Map<
    string,
    {
      components: { id: string; name: string }[];
      fix: { id: string; name: string }[];
      affects: { id: string; name: string }[];
    }
  >();
  const compById = new Map(components.map((c) => [c['@_id'], c['@_name']]));
  const verById = new Map(versions.map((v) => [v['@_id'], v['@_name']]));
  for (const na of table(root, 'NodeAssociation')) {
    if (na['@_sourceNodeEntity'] !== 'Issue') continue;
    const k = na['@_sourceNodeId'] ?? '';
    const entry = assoc.get(k) ?? { components: [], fix: [], affects: [] };
    const sink = na['@_sinkNodeId'] ?? '';
    const kind = String(na['@_associationType'] ?? na['@_sinkNodeEntity'] ?? '');
    if (na['@_sinkNodeEntity'] === 'Component')
      entry.components.push({ id: sink!, name: compById.get(sink ?? '') ?? '?' });
    else if (/fix/i.test(kind)) entry.fix.push({ id: sink!, name: verById.get(sink ?? '') ?? '?' });
    else if (na['@_sinkNodeEntity'] === 'Version')
      entry.affects.push({ id: sink!, name: verById.get(sink ?? '') ?? '?' });
    assoc.set(k, entry);
  }
  // issue links
  const linkTypes = table(root, 'LinkType');
  const ltById = new Map(linkTypes.map((t) => [t['@_id'], t]));
  const issueById = new Map<string, string>();
  const issueRows = table(root, 'Issue');
  const projIdToKey = new Map(projects.map((p) => [p.id, p.key]));
  for (const i of issueRows) {
    const pk = projIdToKey.get(i['@_project'] ?? '') ?? i['@_key']?.split('-')[0] ?? '?';
    issueById.set(i['@_id'] ?? '', `${pk}-${i['@_number'] ?? i['@_id']}`);
  }
  const links = new Map<string, unknown[]>();
  for (const l of table(root, 'IssueLink')) {
    const type = ltById.get(l['@_linktype'] ?? '');
    const srcKey = issueById.get(l['@_source'] ?? '') ?? '';
    const dstKey = issueById.get(l['@_destination'] ?? '') ?? '';
    links.set(l['@_source'] ?? '', [
      ...(links.get(l['@_source'] ?? '') ?? []),
      {
        id: l['@_id'],
        type: {
          id: l['@_linktype'],
          name: type?.['@_linkname'] ?? 'Link',
          inward: type?.['@_inward'],
          outward: type?.['@_outward'],
        },
        outwardIssue: { id: l['@_destination'], key: dstKey },
      },
    ]);
    links.set(l['@_destination'] ?? '', [
      ...(links.get(l['@_destination'] ?? '') ?? []),
      {
        id: l['@_id'],
        type: {
          id: l['@_linktype'],
          name: type?.['@_linkname'] ?? 'Link',
          inward: type?.['@_inward'],
          outward: type?.['@_outward'],
        },
        inwardIssue: { id: l['@_source'], key: srcKey },
      },
    ]);
  }
  // changelog: ChangeGroup (header) + ChangeItem (field rows)
  const itemsByGroup = new Map<string, Row[]>();
  for (const ci of table(root, 'ChangeItem')) {
    const g = ci['@_group'] ?? '';
    itemsByGroup.set(g, [...(itemsByGroup.get(g) ?? []), ci]);
  }
  const changelogByIssue = new Map<string, unknown[]>();
  for (const cg of table(root, 'ChangeGroup')) {
    const k = cg['@_issue'] ?? '';
    changelogByIssue.set(k, [
      ...(changelogByIssue.get(k) ?? []),
      {
        id: cg['@_id'],
        created: dt(cg['@_created']),
        author: acctByName(cg['@_author']),
        items: (itemsByGroup.get(cg['@_id'] ?? '') ?? []).map((ci) => ({
          field: ci['@_field'],
          fieldtype: ci['@_fieldtype'],
          fromString: ci['@_oldstring'] ?? ci['@_oldvalue'],
          toString: ci['@_newstring'] ?? ci['@_newvalue'],
        })),
      },
    ]);
  }

  const issues = issueRows.map((i) => {
    const pk = projIdToKey.get(i['@_project'] ?? '') ?? '?';
    const num_ = i['@_number'] ?? i['@_id'];
    const key = `${pk}-${num_}`;
    const a = assoc.get(i['@_id'] ?? '') ?? { components: [], fix: [], affects: [] };
    const parentId = i['@_parent'];
    return {
      id: i['@_id'],
      key,
      fields: {
        summary: i['@_summary'] ?? '(no summary)',
        description: i['@_description'],
        issuetype: { name: typeById.get(i['@_type']) ?? 'Task' },
        status: { name: statusById.get(i['@_status']) ?? 'To Do' },
        priority: i['@_priority'] ? { name: prioById.get(i['@_priority']) } : null,
        resolution: i['@_resolution'] ? { name: resById.get(i['@_resolution']) } : null,
        assignee: acctByName(i['@_assignee'] ?? undefined),
        reporter: acctByName(i['@_reporter'] ?? undefined),
        labels: labels.get(i['@_id'] ?? '') ?? [],
        duedate: dt(i['@_duedate']),
        parent: parentId ? { key: issueById.get(parentId) } : undefined,
        created: dt(i['@_created']),
        updated: dt(i['@_updated']),
        timeoriginalestimate: num(i['@_timeoriginalestimate']),
        timeestimate: num(i['@_timeestimate']),
        comment: { comments: comments.get(i['@_id'] ?? '') ?? [], total: (comments.get(i['@_id'] ?? '') ?? []).length },
        components: a.components,
        fixVersions: a.fix,
        versions: a.affects,
        issuelinks: links.get(i['@_id'] ?? '') ?? [],
        changelog: { histories: changelogByIssue.get(i['@_id'] ?? '') ?? [] },
        attachment: [],
        votes: { votes: 0 },
        watches: { watchCount: 0 },
      },
    };
  });

  const fixture: Record<string, unknown> = {
    '/rest/api/3/users/search': users,
    '/rest/api/3/issuetype': types.length ? types : [{ id: '1', name: 'Task' }],
    '/rest/api/3/status': statuses.length ? statuses : [{ id: '1', name: 'To Do', statusCategory: { key: 'new' } }],
    '/rest/api/3/priority': priorities.length ? priorities : [{ id: '3', name: 'Medium' }],
    '/rest/api/3/resolution': resolutions,
    '/rest/api/3/search': { issues, total: issues.length, maxResults: issues.length, startAt: 0 },
    '/rest/api/3/role': [],
    '/rest/api/3/field': [],
    '/rest/api/3/issuesecurityschemes': { issueSecuritySchemes: [] },
    '/rest/api/3/issuetypescheme': { issueTypeSchemes: [] },
    '/rest/api/3/fieldconfigurations': { values: [] },
    '/rest/api/3/workflow/search': { values: [] },
    '/rest/api/3/filter/search': { values: [] },
    '/rest/api/3/issueLinkType': {
      issueLinkTypes: linkTypes.map((t) => ({
        id: t['@_id'],
        name: t['@_linkname'],
        inward: t['@_inward'],
        outward: t['@_outward'],
      })),
    },
  };
  for (const p of projects) {
    fixture[`/rest/api/3/project/${p.key}`] = p;
    fixture[`/rest/api/3/project/${p.key}/components`] = components
      .filter((c) => c['@_project'] === p.id)
      .map((c) => ({ id: c['@_id'], name: c['@_name'], project: p.key }));
    fixture[`/rest/api/3/project/${p.key}/versions`] = versions
      .filter((v) => v['@_project'] === p.id)
      .map((v, i) => ({ id: v['@_id'], name: v['@_name'], project: p.key, sequence: i }));
  }
  for (const i of issueRows) {
    const key = issueById.get(i['@_id'] ?? '')!;
    fixture[`/rest/api/3/issue/${key}/worklog`] = { worklogs: worklogs.get(i['@_id'] ?? '') ?? [] };
  }
  return fixture;
}

/** Full entry: zip buffer → fixture map. */
export async function xmlBackupToFixture(
  buf: Buffer
): Promise<{ fixture: Record<string, unknown>; attachmentPaths: Set<string> }> {
  const { entitiesXml, attachmentPaths } = await unzipXmlBackup(buf);
  return { fixture: entitiesXmlToFixture(entitiesXml), attachmentPaths };
}
