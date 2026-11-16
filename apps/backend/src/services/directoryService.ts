// Sprint 049 Track A2 — LDAP/AD bind authentication + scheduled sync.
// Pattern (RFC 4511): service-bind → search user DN → rebind-as-user.
// FR-005: plaintext refused (ldaps|starttls only), bind secret via secretRef,
// all filter interpolation RFC 4515-escaped.
// Rename-safe: users keyed by immutable id (attrMap.entryUuid — objectGUID
// on AD, entryUUID on OpenLDAP), never by name/email (FR-004).
import { Client, type Entry } from 'ldapts';
import { prisma } from '../prisma.js';
import { revokeAllCredentials } from './scimService.js';
import type { DirectoryConnection, User } from '../lib/pc.js';

export interface LdapConfig {
  hosts: string[]; // failover list — tried in order
  port: number;
  tls: 'ldaps' | 'starttls';
  bindDn: string;
  baseDn: string;
  userFilter: string; // e.g. '(&(objectClass=person)(uid={login}))'
  attrMap: {
    login?: string; // uid | sAMAccountName — default 'uid'
    email?: string; // default 'mail'
    displayName?: string; // default 'displayName' | 'cn'
    entryUuid?: string; // immutable id — default 'entryUUID'
    disabled?: string; // 'userAccountControl' (AD) — bit 2 = disabled
    memberOf?: string; // default 'memberOf'
  };
  groupMap?: Record<string, string>; // ldap group DN/name → TrackForge group name
  syncIntervalSec?: number; // default 900
  insecureSkipVerify?: boolean; // self-signed lab fixtures — opt-in, recorded
}

export function ldapConfig(conn: DirectoryConnection): LdapConfig {
  const c = conn.config as Partial<LdapConfig>;
  if (!Array.isArray(c.hosts) || !c.hosts.length) throw new Error('config.hosts: non-empty host list required');
  if (c.tls !== 'ldaps' && c.tls !== 'starttls')
    throw new Error('config.tls must be ldaps or starttls — plaintext refused');
  if (!c.bindDn || !c.baseDn) throw new Error('config.bindDn and config.baseDn are required');
  if (!c.userFilter) throw new Error('config.userFilter is required');
  return {
    hosts: c.hosts,
    port: c.port ?? (c.tls === 'ldaps' ? 636 : 389),
    tls: c.tls,
    bindDn: c.bindDn,
    baseDn: c.baseDn,
    userFilter: c.userFilter,
    attrMap: c.attrMap ?? {},
    groupMap: c.groupMap,
    syncIntervalSec: c.syncIntervalSec ?? 900,
    insecureSkipVerify: c.insecureSkipVerify === true,
  };
}

// 064 US5 — a UI admin must not be able to exfiltrate TrackForge's own secrets
// by naming them as a connection's credential (env:SESSION_SECRET → sent as a
// Bearer token to an attacker-controlled baseUrl). TrackForge runtime secrets
// are never valid external credentials, so they're denied unconditionally;
// TRACKFORGE_SECRET_REF_ALLOW further narrows to an explicit allow-list.
const SECRET_REF_DENIED = new Set([
  'SESSION_SECRET',
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'REDIS_URL',
  'METRICS_BEARER',
  'TRACKFORGE_SECRET_REF_ALLOW',
]);

/** secretRef → the actual secret: 'env:NAME' reads process.env; anything else is invalid. */
export function resolveSecret(secretRef: string | null): string {
  if (!secretRef?.startsWith('env:')) throw new Error('secretRef must be env:VAR_NAME — secrets never stored inline');
  const name = secretRef.slice(4).toUpperCase();
  if (SECRET_REF_DENIED.has(name)) throw new Error(`secretRef ${secretRef} names a protected TrackForge secret`);
  const allow = process.env.TRACKFORGE_SECRET_REF_ALLOW?.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow?.length && !allow.includes(name)) {
    throw new Error(`secretRef ${secretRef} is not in TRACKFORGE_SECRET_REF_ALLOW`);
  }
  const v = process.env[name];
  if (!v) throw new Error(`secretRef ${secretRef} resolves to an empty environment variable`);
  return v;
}

/** RFC 4515 — escape filter-assertion input (parens, *, NUL, backslash). FR-005. */
export function escapeLdapFilter(input: string): string {
  // eslint-disable-next-line no-control-regex -- NUL/control chars must be escaped per RFC 4515
  const re = /[\\()*=<>;\x00-\x1f\x7f-\uffff]/g;
  return input.replace(re, (ch) => `\\${ch.charCodeAt(0).toString(16).padStart(2, '0').toUpperCase()}`);
}

function ldapUrl(cfg: LdapConfig, host: string): string {
  return `${cfg.tls === 'ldaps' ? 'ldaps' : 'ldap'}://${host}:${cfg.port}`;
}

async function connect(cfg: LdapConfig, dn: string, password: string): Promise<Client> {
  let lastErr: unknown = null;
  for (const host of cfg.hosts) {
    const tlsOpts = cfg.insecureSkipVerify ? { rejectUnauthorized: false } : {};
    // ldaps: TLS at connect time via constructor options. starttls: plain
    // connect, then upgrade — constructor tlsOptions would handshake too early.
    const client = new Client({
      url: ldapUrl(cfg, host),
      timeout: 8000,
      connectTimeout: 8000,
      ...(cfg.tls === 'ldaps' ? { tlsOptions: tlsOpts } : {}),
    });
    try {
      if (cfg.tls === 'starttls') await client.startTLS(tlsOpts);
      await client.bind(dn, password);
      return client;
    } catch (e) {
      lastErr = e;
      await client.unbind().catch(() => undefined);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function interpolateFilter(template: string, login: string): string {
  return template.replace(/\{login\}/g, escapeLdapFilter(login));
}

interface DirectoryUser {
  dn: string;
  login: string;
  email: string;
  displayName: string;
  entryUuid: string;
  disabled: boolean;
  groups: string[];
}

function entryToUser(cfg: LdapConfig, e: Entry): DirectoryUser | null {
  const a = cfg.attrMap;
  const str = (v: unknown): string => (Array.isArray(v) ? String(v[0] ?? '') : String(v ?? ''));
  const login = str(e[a.login ?? 'uid']);
  if (!login) return null;
  const email = str(e[a.email ?? 'mail']) || login;
  const displayName = str(e[a.displayName ?? 'displayName']) || str(e.cn) || login;
  const entryUuid = str(e[a.entryUuid ?? 'entryUUID']) || str(e.dn);
  const uac = a.disabled ? parseInt(str(e[a.disabled]) || '0', 10) : 0;
  const memberOf = e[a.memberOf ?? 'memberOf'];
  return {
    dn: str(e.dn),
    login,
    email,
    displayName,
    entryUuid,
    disabled: (uac & 2) !== 0,
    groups: (Array.isArray(memberOf) ? memberOf : memberOf ? [memberOf] : []).map(String),
  };
}

async function searchUser(cfg: LdapConfig, client: Client, login: string): Promise<DirectoryUser | null> {
  const { searchEntries } = await client.search(cfg.baseDn, {
    filter: interpolateFilter(cfg.userFilter, login),
    scope: 'sub',
  });
  if (searchEntries.length !== 1) return null; // zero or multiple → fail closed (edge case)
  return entryToUser(cfg, searchEntries[0]);
}

/** Admin 'test' — bind + sample resolution. Machine-readable for agents. */
export async function testDirectoryConnection(conn: DirectoryConnection, sampleLogin?: string): Promise<object> {
  const cfg = ldapConfig(conn);
  const secret = resolveSecret(conn.secretRef);
  const client = await connect(cfg, cfg.bindDn, secret);
  try {
    const { searchEntries } = await client.search(cfg.baseDn, {
      filter: cfg.userFilter.replace('{login}', '*'),
      scope: 'sub',
      sizeLimit: 1,
    });
    const sample = sampleLogin
      ? await searchUser(cfg, client, sampleLogin)
      : searchEntries[0]
        ? entryToUser(cfg, searchEntries[0])
        : null;
    return {
      ok: true,
      bind: 'ok',
      sampleUser: sample ? { login: sample.login, email: sample.email, dn: sample.dn } : null,
    };
  } finally {
    await client.unbind().catch(() => undefined);
  }
}

/** Bind-auth path: find enabled ldap conns, try service-bind → search → user-rebind. */
export async function authenticateViaDirectory(
  login: string,
  password: string
): Promise<{ user: User } | { error: 'unavailable' } | null> {
  const conns = await prisma.directoryConnection.findMany({ where: { type: 'ldap', enabled: true } });
  if (!conns.length) return null;
  let sawUnavailable = false;
  for (const conn of conns) {
    try {
      const cfg = ldapConfig(conn);
      const secret = resolveSecret(conn.secretRef);
      const svc = await connect(cfg, cfg.bindDn, secret);
      const found = await searchUser(cfg, svc, login).finally(() => svc.unbind().catch(() => undefined));
      if (!found) continue; // user not in this directory
      if (found.disabled) return { error: 'unavailable' };
      // Rebind as the user — wrong password throws here.
      const u = await connect(cfg, found.dn, password)
        .then(async (c) => {
          await c.unbind().catch(() => undefined);
          return true;
        })
        .catch(() => false);
      if (!u) return null; // found in directory, bad password → ordinary 401 (not "unavailable")
      const user = await provisionFromDirectory(conn, found);
      return { user };
    } catch {
      sawUnavailable = true;
    }
  }
  return sawUnavailable ? { error: 'unavailable' } : null;
}

/** Upsert a TrackForge user from directory attrs — keyed by entryUuid (rename-safe). */
export async function provisionFromDirectory(conn: DirectoryConnection, du: DirectoryUser): Promise<User> {
  const ident = await prisma.externalIdentity.findUnique({
    where: {
      provider_directoryConnectionId_externalId: {
        provider: 'ldap',
        directoryConnectionId: conn.id,
        externalId: du.entryUuid,
      },
    },
  });
  let user: User | null = ident
    ? await prisma.user.findUnique({ where: { id: ident.userId } })
    : await prisma.user.findUnique({ where: { email: du.email.toLowerCase() } }); // first-sync link by login
  if (user) {
    const data: Record<string, unknown> = {};
    if (user.email !== du.email.toLowerCase()) data.email = du.email.toLowerCase();
    if (user.displayName !== du.displayName) data.displayName = du.displayName;
    if (du.disabled !== !user.active) data.active = !du.disabled;
    if (Object.keys(data).length) user = await prisma.user.update({ where: { id: user.id }, data });
  } else {
    user = await prisma.user.create({
      data: {
        email: du.email.toLowerCase(),
        displayName: du.displayName,
        passwordHash: '!external',
        active: !du.disabled,
      },
    });
  }
  if (du.disabled) await revokeAllCredentials(user.id);
  await prisma.externalIdentity.upsert({
    where: {
      provider_directoryConnectionId_externalId: {
        provider: 'ldap',
        directoryConnectionId: conn.id,
        externalId: du.entryUuid,
      },
    },
    update: { userId: user.id },
    create: { provider: 'ldap', directoryConnectionId: conn.id, externalId: du.entryUuid, userId: user.id },
  });
  await applyGroupMap(conn, user.id, du.groups);
  return user;
}

async function applyGroupMap(conn: DirectoryConnection, userId: string, ldapGroups: string[]): Promise<void> {
  const cfg = ldapConfig(conn);
  if (!cfg.groupMap || !Object.keys(cfg.groupMap).length) return;
  const wanted = new Set(
    Object.entries(cfg.groupMap)
      .filter(([ldapGroup]) =>
        ldapGroups.some(
          (g) =>
            g.toLowerCase() === ldapGroup.toLowerCase() || g.toLowerCase().includes(`cn=${ldapGroup.toLowerCase()},`)
        )
      )
      .map(([, tfGroup]) => tfGroup)
  );
  const groups = await prisma.group.findMany({ where: { name: { in: [...wanted] } } });
  for (const g of groups) {
    await prisma.groupMember.upsert({
      where: { groupId_userId: { groupId: g.id, userId } },
      update: {},
      create: { groupId: g.id, userId },
    });
  }
}

/** Full sync — enumerate users matching userFilter (wildcard), converge, deactivate disabled. */
export async function syncDirectoryConnection(conn: DirectoryConnection): Promise<object> {
  const cfg = ldapConfig(conn);
  const secret = resolveSecret(conn.secretRef);
  const client = await connect(cfg, cfg.bindDn, secret);
  const stats = { seen: 0, provisioned: 0, updated: 0, deactivated: 0, errors: 0 };
  try {
    const { searchEntries } = await client.search(cfg.baseDn, {
      filter: cfg.userFilter.replace(/\{login\}/g, '*'),
      scope: 'sub',
      paged: { pageSize: 500 },
    });
    for (const e of searchEntries) {
      const du = entryToUser(cfg, e);
      if (!du) continue;
      stats.seen++;
      try {
        const before = await prisma.externalIdentity.findUnique({
          where: {
            provider_directoryConnectionId_externalId: {
              provider: 'ldap',
              directoryConnectionId: conn.id,
              externalId: du.entryUuid,
            },
          },
        });
        await provisionFromDirectory(conn, du);
        if (du.disabled) stats.deactivated++;
        else if (before) stats.updated++;
        else stats.provisioned++;
      } catch {
        stats.errors++;
      }
    }
  } finally {
    await client.unbind().catch(() => undefined);
  }
  await prisma.directoryConnection.update({
    where: { id: conn.id },
    data: {
      lastSyncAt: new Date(),
      syncStatus: { state: stats.errors ? 'degraded' : 'ok', stats, ranAt: new Date().toISOString() },
    },
  });
  return stats;
}

/** Scheduled sweep — sync enabled ldap conns whose interval has elapsed. */
export async function runDueDirectorySyncs(): Promise<number> {
  const conns = await prisma.directoryConnection.findMany({ where: { type: 'ldap', enabled: true } });
  let synced = 0;
  for (const conn of conns) {
    let intervalMs = 900_000;
    try {
      intervalMs = ldapConfig(conn).syncIntervalSec! * 1000;
    } catch {
      continue;
    }
    if (conn.lastSyncAt && Date.now() - conn.lastSyncAt.getTime() < intervalMs) continue;
    try {
      await syncDirectoryConnection(conn);
      synced++;
    } catch {
      await prisma.directoryConnection
        .update({
          where: { id: conn.id },
          data: { syncStatus: { state: 'error', ranAt: new Date().toISOString() } },
        })
        .catch(() => undefined);
    }
  }
  return synced;
}
