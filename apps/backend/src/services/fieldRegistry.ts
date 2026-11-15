/**
 * Unified field registry (D19): every field — system or custom — resolves
 * through here. Consumers: issue serializer, /field, createmeta/editmeta,
 * JQL, changelog, importer.
 *
 * Registry entries are cheap descriptors; CF storage details live in
 * `cf` (the prisma row with contexts loaded).
 */
import { prisma } from '../prisma.js';
import { FIELD_DEFS, type FieldDef } from '../lib/systemFields.js';
import { listFields, getField, fieldsForProject, type FieldWithContexts } from './customFieldService.js';
import { cfSchema, cfTypeDef } from '../lib/cfTypes.js';
import { JiraApiError, jiraError } from '../lib/errors.js';

/** 065 US5 — moved from routes/issues.ts: field keys handled by first-class
 *  inputs. Anything else in `fields`/`update` is routed to the custom-field
 *  engine (customfield_NNNNN or alias). */
export const KNOWN_FIELD_KEYS = new Set([
  'project',
  'summary',
  'description',
  'issuetype',
  'priority',
  'assignee',
  'delegate', // 047
  'reporter',
  'labels',
  'duedate',
  'resolution',
  'resolutiondate',
  'parent',
  'story_points',
  'storyPoints',
  'status',
  'sprint',
  'comment',
  'issuelinks',
  'subtasks',
  'created',
  'updated',
  'attachment',
  'watches',
  'votes',
  'worklog',
  'timetracking',
  'versions',
  'components',
  'fixVersions',
  'environment',
  'security',
  'epic',
  'rank',
]);

export interface RegistryEntry {
  /** API id — 'summary', 'customfield_10042', or system-alias 'story_points'. */
  id: string;
  /** Storage id — for CFs always `customfield_NNNNN` (alias resolves to it). */
  canonicalId: string;
  name: string;
  custom: boolean;
  /** JQL clause names — cf[10042] + display name for CFs. */
  clauseNames: string[];
  schema: Record<string, unknown>;
  navigable: boolean;
  searchable: boolean;
  orderable: boolean;
  /** update-op verbs allowed ('set' is always implicit for CFs). */
  operations: string[];
  searcherType?: string;
  /** Present for custom fields. */
  cf?: FieldWithContexts;
  system?: FieldDef;
}

/** CF row → registry entry. `story_points` stays reachable via alias + cf id. */
export function cfToEntry(cf: FieldWithContexts): RegistryEntry {
  const def = cfTypeDef(cf.type);
  return {
    id: cf.id,
    canonicalId: cf.id,
    name: cf.name,
    custom: true,
    clauseNames: [`cf[${cf.seq}]`, cf.name],
    schema: cfSchema(cf),
    navigable: cf.type !== 'checklist',
    searchable: cf.searcherType !== 'none',
    orderable: ['number', 'date', 'datetime', 'text'].includes(cf.type),
    operations: def.updateOps,
    searcherType: cf.searcherType,
    cf,
  };
}

export function systemToEntry(f: FieldDef): RegistryEntry {
  return {
    id: f.id,
    canonicalId: f.id,
    name: f.name,
    custom: false,
    clauseNames: [f.id],
    schema: f.schema,
    navigable: f.navigable,
    searchable: f.searchable,
    orderable: true,
    operations: f.operations,
    searcherType: String(f.schema.type ?? 'none'),
    system: f,
  };
}

/** All fields: system defs + active CFs. Order: system first then CF seq. */
export async function allFields(): Promise<RegistryEntry[]> {
  const cfs = await listFields();
  return [...FIELD_DEFS.map(systemToEntry), ...cfs.map(cfToEntry)];
}

/** Fields applicable to a project (for createmeta/editmeta/serializers). */
export async function fieldsForProjectScoped(projectId: string): Promise<RegistryEntry[]> {
  const cfs = await listFields();
  return [...FIELD_DEFS.map(systemToEntry), ...fieldsForProject(cfs, projectId).map(cfToEntry)];
}

const cfIdRe = /^customfield_(\d+)$/i;
const cfClauseRe = /^cf\[(\d+)\]$/i;

/**
 * Resolve a field reference — accepts:
 *   'customfield_10042', 'cf[10042]', an alias ('story_points'),
 *   a system id ('summary'), or a display name ('Risk Level', 'Story Points').
 */
export async function resolveField(ref: string): Promise<RegistryEntry | null> {
  const raw = ref.trim();
  const cfClause = cfClauseRe.exec(raw);
  if (cfClause) {
    const cf = await prisma.customField.findFirst({
      where: { seq: Number(cfClause[1]), active: true },
      include: { contexts: { include: { projects: true, options: { orderBy: { position: 'asc' } } } } },
    });
    return cf ? cfToEntry(cf) : null;
  }
  const sys = FIELD_DEFS.find((f) => f.id === raw.toLowerCase() || f.name.toLowerCase() === raw.toLowerCase());
  if (sys) return systemToEntry(sys);
  const cfId = cfIdRe.exec(raw);
  if (cfId) {
    try {
      return cfToEntry(await getField(raw));
    } catch {
      return null;
    }
  }
  // alias or CF name (case-insensitive).
  const cfs = await listFields();
  const hit = cfs.find((f) => f.alias === raw || f.name.toLowerCase() === raw.toLowerCase());
  return hit ? cfToEntry(hit) : null;
}

export async function requireField(ref: string): Promise<RegistryEntry> {
  const f = await resolveField(ref);
  if (!f) {
    throw new JiraApiError(400, jiraError([`Field '${ref}' does not exist or is not searchable.`]));
  }
  return f;
}
