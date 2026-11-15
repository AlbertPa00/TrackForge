// Saved filters — Jira /filter CRUD + favourites + share permissions.

import { prisma } from '../prisma.js';
import { JiraApiError, jiraError } from '../lib/errors.js';
import type { Actor } from '../lib/auth.js';
// JqlParseError from assertFilterRefsValid propagates to the route's 400 handler.
import {
  annotateSharePerms,
  canSeeFilter,
  normalizeSharePerm,
  scopeToPermInputs,
  type FilterLike,
  type SharePermInput,
  type SharePermRow,
} from './filterScope.js';
import { resourceSelf, userSelf } from '../lib/http.js';

type ShareInput = {
  sharedScope?: string;
  sharedTarget?: string | null;
  sharePermissions?: SharePermInput[];
};

const FILTER_INCLUDE = { owner: true, favourites: true, sharePerms: true } as const;

type FilterRow = {
  id: string;
  name: string;
  description: string | null;
  jql: string;
  ownerId: string;
  visibility: string;
  sharePerms: SharePermRow[];
  favourites?: { userId: string }[];
  owner?: { id: string; displayName: string; email: string };
};

async function toFilterResponse(f: FilterRow, actorId: string) {
  const owner = f.owner!;
  return {
    id: f.id,
    self: resourceSelf(`/rest/api/2/filter/${f.id}`),
    name: f.name,
    description: f.description ?? undefined,
    owner: {
      self: userSelf(owner.id),
      accountId: owner.id,
      displayName: owner.displayName,
      emailAddress: owner.email,
      active: true,
    },
    jql: f.jql,
    viewUrl: resourceSelf(`/issues?filterId=${f.id}`),
    searchUrl: resourceSelf(`/rest/api/2/search?jql=${encodeURIComponent(f.jql)}`),
    favourite: (f.favourites ?? []).some((x) => x.userId === actorId),
    sharePermissions: await annotateSharePerms(f.sharePerms),
    // TrackForge extension — simpler visibility flag for clients
    visibility: f.visibility,
  };
}

async function loadFilter(id: string) {
  return prisma.filter.findUnique({ where: { id }, include: FILTER_INCLUDE });
}

function canSee(filter: FilterLike, actor: Actor) {
  return canSeeFilter(filter, actor);
}

/** 032 US3 — parse the JQL + validate `filter =` refs exist and don't cycle.
 *  (Values are not resolved at save — Jira lets you save unresolvable JQL.) */
async function validateJql(actor: Actor, jql: string, selfId?: string) {
  const { parseJql } = await import('../jql/parser.js');
  const { assertJqlFieldRefs } = await import('../jql/compiler.js');
  const { assertFilterRefsValid } = await import('./filterScope.js');
  const parsed = parseJql(jql);
  try {
    await assertJqlFieldRefs(actor, parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new JiraApiError(400, jiraError([msg]));
  }
  await assertFilterRefsValid(actor, jql, selfId);
}

/** Normalize share input → perm rows. undefined = leave unchanged; [] = private. */
async function resolveShareRows(
  actor: Actor,
  input: ShareInput
): Promise<{ type: string; target: string | null; target2: string | null }[] | undefined> {
  let inputs: SharePermInput[] | undefined;
  if (input.sharePermissions !== undefined) {
    inputs = input.sharePermissions;
  } else if (input.sharedScope !== undefined) {
    inputs = scopeToPermInputs(input.sharedScope, input.sharedTarget);
  } else {
    return undefined;
  }
  const rows: { type: string; target: string | null; target2: string | null }[] = [];
  for (const p of inputs) rows.push(await normalizeSharePerm(p));
  return rows;
}

function visibilityFor(rows: { type: string }[] | undefined, fallback: string) {
  if (!rows) return fallback;
  return rows.some((r) => r.type === 'global' || r.type === 'authenticated') ? 'all' : 'private';
}

function canEdit(filter: { ownerId: string }, actor: Actor) {
  return filter.ownerId === actor.user.id || actor.user.isAdmin;
}

async function requireEditable(actor: Actor, id: string) {
  const filter = await loadFilter(id);
  if (!filter || !(await canSee(filter, actor))) {
    throw new JiraApiError(404, jiraError(['Filter does not exist or you do not have permission to see it.']));
  }
  if (!canEdit(filter, actor)) {
    throw new JiraApiError(403, jiraError(['You do not have permission to edit this filter.']));
  }
  return filter;
}

/** Jira GET/PUT /filter/defaultShareScope — per-user default for new filters. */
const DEFAULT_SCOPE_KEY = 'filter.defaultShareScope';

export async function getDefaultShareScope(actor: Actor) {
  const row = await prisma.userPreference.findUnique({
    where: { userId_key: { userId: actor.user.id, key: DEFAULT_SCOPE_KEY } },
  });
  return { scope: (row?.value as { scope?: string } | null)?.scope ?? 'PRIVATE' };
}

export async function setDefaultShareScope(actor: Actor, scope: string) {
  const s = String(scope ?? '').toUpperCase();
  if (s !== 'GLOBAL' && s !== 'PRIVATE') {
    throw new JiraApiError(400, jiraError(['Scope must be GLOBAL or PRIVATE.']));
  }
  await prisma.userPreference.upsert({
    where: { userId_key: { userId: actor.user.id, key: DEFAULT_SCOPE_KEY } },
    create: { userId: actor.user.id, key: DEFAULT_SCOPE_KEY, value: { scope: s } },
    update: { value: { scope: s } },
  });
  return { scope: s };
}

export async function createFilter(
  actor: Actor,
  input: { name: string; jql: string; description?: string | null; visibility?: string } & ShareInput
) {
  if (!input.name?.trim()) {
    throw new JiraApiError(400, jiraError([], { name: 'A filter name is required.' }));
  }
  if (!input.jql?.trim()) {
    throw new JiraApiError(400, jiraError([], { jql: 'A JQL query is required.' }));
  }
  await validateJql(actor, input.jql);
  let rows = await resolveShareRows(actor, input);
  if (rows === undefined) {
    const def = await getDefaultShareScope(actor);
    rows = def.scope === 'GLOBAL' ? [{ type: 'global', target: null, target2: null }] : [];
  }
  const filter = await prisma.filter.create({
    data: {
      ownerId: actor.user.id,
      name: input.name.trim(),
      description: input.description ?? null,
      jql: input.jql,
      visibility: input.visibility === 'all' || visibilityFor(rows, 'private') === 'all' ? 'all' : 'private',
      sharePerms: { create: rows },
    },
    include: FILTER_INCLUDE,
  });
  return await toFilterResponse(filter, actor.user.id);
}

export async function updateFilter(
  actor: Actor,
  id: string,
  input: {
    name?: string;
    jql?: string;
    description?: string | null;
    visibility?: string;
    ownerAccountId?: string;
  } & ShareInput
) {
  const filter = await requireEditable(actor, id);
  // seed the cycle guard with this filter's id so `filter = <self>` (direct or
  // transitive through another filter's stored JQL) is rejected at save time.
  if (input.jql !== undefined) await validateJql(actor, input.jql, filter.id);
  let newOwnerId: string | undefined;
  if (input.ownerAccountId !== undefined) {
    const u = await prisma.user.findUnique({
      where: { id: input.ownerAccountId },
      select: { id: true, active: true },
    });
    if (!u || !u.active) throw new JiraApiError(400, jiraError(['User does not exist']));
    newOwnerId = u.id;
  }
  const rows = await resolveShareRows(actor, input);
  const updated = await prisma.filter.update({
    where: { id: filter.id },
    data: {
      ...(newOwnerId !== undefined ? { ownerId: newOwnerId } : {}),
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.jql !== undefined ? { jql: input.jql } : {}),
      ...(rows !== undefined
        ? {
            visibility: input.visibility === 'all' ? 'all' : visibilityFor(rows, 'private'),
            sharePerms: { deleteMany: {}, create: rows },
          }
        : input.visibility !== undefined
          ? { visibility: input.visibility === 'all' ? 'all' : 'private' }
          : {}),
    },
    include: FILTER_INCLUDE,
  });
  return await toFilterResponse(updated, actor.user.id);
}

// ---------- Jira /filter/{id}/permission endpoints ----------

export async function listSharePermissions(actor: Actor, filterId: string) {
  const filter = await requireEditable(actor, filterId);
  return annotateSharePerms(filter.sharePerms);
}

export async function addSharePermission(actor: Actor, filterId: string, input: SharePermInput) {
  const filter = await requireEditable(actor, filterId);
  const row = await normalizeSharePerm(input);
  const created = await prisma.filterSharePermission.create({
    data: { filterId: filter.id, ...row },
  });
  await prisma.filter.update({
    where: { id: filter.id },
    data: { visibility: visibilityFor([row, ...filter.sharePerms], filter.visibility) },
  });
  return (await annotateSharePerms([created]))[0];
}

export async function getSharePermission(actor: Actor, filterId: string, permId: string) {
  const filter = await requireEditable(actor, filterId);
  const perm = filter.sharePerms.find((p) => p.id === permId);
  if (!perm) {
    throw new JiraApiError(404, jiraError([`Share permission '${permId}' does not exist.`]));
  }
  return (await annotateSharePerms([perm]))[0];
}

export async function deleteSharePermission(actor: Actor, filterId: string, permId: string) {
  const filter = await requireEditable(actor, filterId);
  const perm = filter.sharePerms.find((p) => p.id === permId);
  if (!perm) {
    throw new JiraApiError(404, jiraError([`Share permission '${permId}' does not exist.`]));
  }
  await prisma.filterSharePermission.delete({ where: { id: perm.id } });
  const rest = filter.sharePerms.filter((p) => p.id !== permId);
  await prisma.filter.update({
    where: { id: filter.id },
    data: { visibility: visibilityFor(rest, 'private') },
  });
}

export async function deleteFilter(actor: Actor, id: string) {
  const filter = await requireEditable(actor, id);
  await prisma.filter.delete({ where: { id: filter.id } });
}

export async function getFilter(actor: Actor, id: string) {
  const filter = await loadFilter(id);
  if (!filter || !(await canSee(filter, actor))) {
    throw new JiraApiError(404, jiraError(['Filter does not exist or you do not have permission to see it.']));
  }
  return await toFilterResponse(filter, actor.user.id);
}

export async function listMyFilters(actor: Actor) {
  const filters = await prisma.filter.findMany({
    where: { ownerId: actor.user.id },
    include: FILTER_INCLUDE,
    orderBy: { name: 'asc' },
  });
  return Promise.all(filters.map((f) => toFilterResponse(f, actor.user.id)));
}

export async function listVisibleFilters(actor: Actor, nameFilter = '') {
  const filters = await prisma.filter.findMany({
    where: nameFilter ? { name: { contains: nameFilter, mode: 'insensitive' as const } } : {},
    include: FILTER_INCLUDE,
    orderBy: { name: 'asc' },
  });
  const visible: typeof filters = [];
  for (const f of filters) if (await canSee(f, actor)) visible.push(f);
  return Promise.all(visible.map((f) => toFilterResponse(f, actor.user.id)));
}

export async function listFavouriteFilters(actor: Actor) {
  const favourites = await prisma.filterFavourite.findMany({
    where: { userId: actor.user.id },
    include: { filter: { include: FILTER_INCLUDE } },
  });
  const visible: (typeof favourites)[number]['filter'][] = [];
  for (const f of favourites.map((x) => x.filter)) {
    if (await canSee(f, actor)) visible.push(f);
  }
  return Promise.all(visible.map((f) => toFilterResponse(f, actor.user.id)));
}

export async function setFavourite(actor: Actor, id: string, favourite: boolean) {
  const filter = await loadFilter(id);
  if (!filter || !(await canSee(filter, actor))) {
    throw new JiraApiError(404, jiraError(['Filter does not exist or you do not have permission to see it.']));
  }
  if (favourite) {
    await prisma.filterFavourite.upsert({
      where: { filterId_userId: { filterId: filter.id, userId: actor.user.id } },
      create: { filterId: filter.id, userId: actor.user.id },
      update: {},
    });
  } else {
    await prisma.filterFavourite.deleteMany({
      where: { filterId: filter.id, userId: actor.user.id },
    });
  }
  return getFilter(actor, filter.id);
}
