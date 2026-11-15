import { Router, type Router as RouterType } from 'express';
import { prisma } from '../prisma.js';
import { parseJql, JqlParseError } from '../jql/parser.js';
import { FIELDS, JQL_RESERVED_WORDS, DATE_FUNCTIONS, lookupField } from '../jql/fields.js';
import { JQL_FUNCTIONS } from '../jql/functions.js';
import { listJqlFunctions } from '../jql/functions.js';
import type { JqlClause } from '../jql/ast.js';
import { ah } from '../lib/http.js';

const router: RouterType = Router();

/** 032: TF-native function registry — mounted at /api/internal/jql (A3). */
export const jqlInternalRouter: RouterType = Router();
jqlInternalRouter.get('/functions', (_req, res) => {
  res.json({ functions: listJqlFunctions() });
});

function astToStructure(clause: JqlClause): Record<string, unknown> {
  switch (clause.type) {
    case 'and':
    case 'or':
      return { type: clause.type, clauses: clause.clauses.map(astToStructure) };
    case 'not':
      return { type: 'not', clause: astToStructure(clause.clause) };
    case 'condition':
      return {
        type: 'condition',
        field: clause.field.name,
        operator: clause.operator,
        operand:
          clause.operand.kind === 'list'
            ? {
                kind: 'list',
                items: clause.operand.items.map((i) => ({
                  kind: i.kind,
                  value: 'value' in i ? i.value : 'raw' in i ? i.raw : null,
                })),
              }
            : {
                kind: clause.operand.kind,
                value:
                  'value' in clause.operand
                    ? clause.operand.value
                    : 'raw' in clause.operand
                      ? clause.operand.raw
                      : null,
              },
      };
  }
}

// Jira Cloud: POST /rest/api/2/jql/parse  { queries: string[] }
router.post(
  '/parse',
  ah(async (req, res) => {
    const queries: string[] = Array.isArray(req.body?.queries) ? req.body.queries : [];
    const results = [];
    for (const q of queries) {
      try {
        const ast = parseJql(String(q ?? ''));
        // 032: Jira validates field names in /parse — resolve cf references too
        const { assertJqlFieldRefs } = await import('../jql/compiler.js');
        await assertJqlFieldRefs(req.actor!, ast);
        results.push({
          query: q,
          structure: {
            where: ast.where ? astToStructure(ast.where) : null,
            orderBy: ast.orderBy.map((o) => ({ field: o.field.name, direction: o.direction })),
          },
          errors: [],
        });
      } catch (err) {
        const msg = err instanceof JqlParseError ? err.message : err instanceof Error ? err.message : String(err);
        results.push({ query: q, errors: [msg] });
      }
    }
    res.json({ queries: results });
  })
);

// Jira: GET /rest/api/2/jql/autocompletedata
router.get(
  '/autocompletedata',
  ah(async (_req, res) => {
    const { listFields } = await import('../services/customFieldService.js');
    const { cfTypeDef } = await import('../lib/cfTypes.js');
    const cfs = (await listFields())
      .filter((f) => f.searcherType !== 'none')
      .map((f) => {
        const orderable = f.searcherType !== 'none' && !['multiselect', 'checkbox', 'cascading'].includes(f.type);
        return {
          // Jira suggests cf[NNNNN] for custom fields.
          value: `cf[${f.seq}]`,
          displayName: f.name,
          orderable,
          searchable: true,
          operators: cfTypeDef(f.type).jqlOps,
          types: [f.searcherType],
        };
      });
    res.json({
      visibleFieldNames: [
        ...FIELDS.map((f) => ({
          value: f.name,
          displayName: f.displayName,
          orderable: f.orderable,
          searchable: true,
          operators: f.operators,
          types: [f.valueKind],
        })),
        ...cfs,
      ],
      visibleFunctionNames: [
        { value: 'currentUser()', displayName: 'currentUser()', types: ['user'], isList: 'false' },
        ...[...DATE_FUNCTIONS].map((fn) => ({
          value: `${fn}()`,
          displayName: `${fn}()`,
          types: ['date'],
          isList: 'false',
        })),
        // 032 — central function registry (user/issue/date-returning functions)
        ...JQL_FUNCTIONS.filter((f) => f.name !== 'currentuser').map((f) => ({
          value: `${f.name}(${f.argHint ? '…' : ''})`,
          displayName: `${f.name}(${f.argHint})`,
          types: [f.returns],
          isList: 'true',
        })),
      ],
      jqlReservedWords: JQL_RESERVED_WORDS,
    });
  })
);

// Jira: GET /rest/api/2/jql/autocompletedata/suggestions?fieldName=&fieldValue=
router.get(
  '/autocompletedata/suggestions',
  ah(async (req, res) => {
    const fieldName = String(req.query.fieldName ?? '').toLowerCase();
    const prefix = String(req.query.fieldValue ?? '').replace(/^"|"$/g, '');
    const like = { contains: prefix, mode: 'insensitive' as const };
    let results: { value: string; displayName: string }[] = [];

    const def = lookupField(fieldName);
    if (!def || !def.suggestAs) {
      // Custom field? cf[N] / customfield_N / name → option & user suggestions.
      const m = /^cf\[(\d+)\]$/i.exec(fieldName) ?? /^customfield_(\d+)$/i.exec(fieldName);
      const { listFields, allOptions } = await import('../services/customFieldService.js');
      const cf = (await listFields()).find(
        (f) =>
          f.id.toLowerCase() === (m ? `customfield_${m[1]}` : fieldName) ||
          f.name.toLowerCase() === fieldName ||
          f.alias === fieldName
      );
      if (cf) {
        if (cf.searcherType === 'exact') {
          results = allOptions(cf)
            .filter((o) => !o.parentId && !o.disabled && o.value.toLowerCase().includes(prefix.toLowerCase()))
            .map((o) => ({ value: o.value, displayName: o.value }));
        } else if (cf.searcherType === 'user') {
          const users = await prisma.user.findMany({
            where: { active: true, OR: [{ displayName: like }, { email: like }] },
            take: 10,
            orderBy: { displayName: 'asc' },
          });
          results = users.map((u) => ({ value: u.displayName, displayName: `${u.displayName} <${u.email}>` }));
        }
      }
      res.json({
        results: results.map((r) => ({
          value: /\s/.test(r.value) && !r.value.endsWith('()') ? `"${r.value}"` : r.value,
          displayName: r.displayName,
        })),
      });
      return;
    }

    switch (def.suggestAs) {
      case 'project': {
        const allowed = req.actor!.token?.projectKeys;
        const projects = await prisma.project.findMany({
          where: {
            key: { contains: prefix, mode: 'insensitive' },
            ...(allowed?.length ? { key: { in: allowed } } : {}),
          },
          take: 10,
          orderBy: { key: 'asc' },
        });
        results = projects.map((p) => ({ value: p.key, displayName: `${p.key} — ${p.name}` }));
        break;
      }
      case 'status': {
        const rows = await prisma.status.findMany({ where: { name: like }, orderBy: { sequence: 'asc' } });
        results = rows.map((s) => ({ value: s.name, displayName: s.name }));
        break;
      }
      case 'statusCategory':
        results = [
          { value: 'To Do', displayName: 'To Do' },
          { value: 'In Progress', displayName: 'In Progress' },
          { value: 'Done', displayName: 'Done' },
        ].filter((r) => r.value.toLowerCase().includes(prefix.toLowerCase()));
        break;
      case 'issueType': {
        const rows = await prisma.issueType.findMany({ where: { name: like } });
        results = rows.map((t) => ({ value: t.name, displayName: t.name }));
        break;
      }
      case 'priority': {
        const rows = await prisma.priority.findMany({ where: { name: like }, orderBy: { sequence: 'asc' } });
        results = rows.map((p) => ({ value: p.name, displayName: p.name }));
        break;
      }
      case 'resolution': {
        const rows = await prisma.resolution.findMany({ where: { name: like }, orderBy: { sequence: 'asc' } });
        results = [
          { value: 'Unresolved', displayName: 'Unresolved' },
          ...rows.map((r) => ({ value: r.name, displayName: r.name })),
        ].filter((r) => r.value.toLowerCase().includes(prefix.toLowerCase()));
        break;
      }
      case 'user': {
        if ('currentuser()'.startsWith(prefix.toLowerCase())) {
          results.push({ value: 'currentUser()', displayName: 'currentUser() (me)' });
        }
        const users = await prisma.user.findMany({
          where: { active: true, OR: [{ displayName: like }, { email: like }] },
          take: 10,
          orderBy: { displayName: 'asc' },
        });
        results.push(...users.map((u) => ({ value: u.displayName, displayName: `${u.displayName} <${u.email}>` })));
        break;
      }
      case 'label': {
        const rows = await prisma.$queryRaw<{ label: string }[]>`
          SELECT DISTINCT unnest(labels) AS label FROM "Issue"
          WHERE EXISTS (SELECT 1 FROM unnest(labels) l WHERE l ILIKE ${'%' + prefix + '%'})
          ORDER BY label LIMIT 10`;
        results = rows.map((r) => ({ value: r.label, displayName: r.label }));
        break;
      }
      case 'issueKey': {
        const m = /^([A-Za-z][A-Za-z0-9]*)-?(\d*)$/.exec(prefix.trim());
        const rows = await prisma.issue.findMany({
          where: m
            ? {
                project: { key: { startsWith: m[1].toUpperCase() } },
                ...(m[2] ? { issueNumber: Number(m[2]) } : {}),
              }
            : {},
          include: { project: { select: { key: true } } },
          take: 10,
          orderBy: [{ project: { key: 'asc' } }, { issueNumber: 'asc' }],
        });
        results = rows.map((i) => ({
          value: `${i.project.key}-${i.issueNumber}`,
          displayName: `${i.project.key}-${i.issueNumber} — ${i.summary}`,
        }));
        break;
      }
      default:
        results = [];
    }
    // quote values containing spaces (Jira convention)
    res.json({
      results: results.map((r) => ({
        value: /\s/.test(r.value) && !r.value.endsWith('()') ? `"${r.value}"` : r.value,
        displayName: r.displayName,
      })),
    });
  })
);

export default router;
