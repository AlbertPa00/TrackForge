import { describe, it, expect } from 'vitest';
import { issueImporter } from '../../src/import/importers.js';
import type { ImportCtx } from '../../src/import/types.js';

const ctx = (aliases: Record<string, string>): ImportCtx =>
  ({ job: { projectKeys: ['X'], stageData: { fieldAliases: aliases } } }) as ImportCtx;

const gh = (bean: string) =>
  `com.atlassian.greenhopper.service.sprint.Sprint@deadbeef[${bean}]`;

describe('issueImporter.map — Greenhopper sprint strings', () => {
  it('captures sprint names that contain a closing bracket', async () => {
    const mapped = await issueImporter.map(
      {
        id: '1', key: 'X-1',
        fields: {
          summary: 's', issuetype: { name: 'Task' }, status: { name: 'x' },
          customfield_10001: [gh(
            'id=42,rapidViewId=7,state=CLOSED,name=[26 FEB - 26 MAR] DeV Team 7,startDate=2026-02-26,endDate=2026-03-26,sequence=42,goal=',
          )],
        },
      },
      ctx({ sprint: 'customfield_10001' }),
    );
    expect(mapped.sprintName).toBe('[26 FEB - 26 MAR] DeV Team 7');
  });

  it('handles a trailing name=…] and plain names/objects', async () => {
    const trailing = await issueImporter.map(
      {
        id: '2', key: 'X-2',
        fields: {
          summary: 's', issuetype: { name: 'Task' }, status: { name: 'x' },
          customfield_10001: [gh('id=9,state=ACTIVE,name=Final Sprint')],
        },
      },
      ctx({ sprint: 'customfield_10001' }),
    );
    expect(trailing.sprintName).toBe('Final Sprint');

    const mixed = await issueImporter.map(
      {
        id: '3', key: 'X-3',
        fields: {
          summary: 's', issuetype: { name: 'Task' }, status: { name: 'x' },
          customfield_10001: ['Sprint 9', { name: 'Sprint 10' }],
        },
      },
      ctx({ sprint: 'customfield_10001' }),
    );
    // last entry wins — it is the current sprint
    expect(mixed.sprintName).toBe('Sprint 10');
  });
});
