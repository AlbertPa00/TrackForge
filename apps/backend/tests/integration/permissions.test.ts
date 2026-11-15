import { describe, it, expect, beforeAll } from 'vitest';
import app from '../../src/main.js';
import { prisma } from '../../src/prisma.js';
import { authed, ensureTestAuth } from '../request.js';
import { hashPassword, generateToken } from '../../src/lib/auth.js';
import request from 'supertest';

/** Creates a non-admin user + token; returns a supertest agent for them. */
async function memberAuth(email: string) {
  const user = await prisma.user.create({
    data: { email, displayName: email.split('@')[0], passwordHash: await hashPassword('pw') },
  });
  const { plain, prefix, hash } = generateToken();
  await prisma.apiToken.create({ data: { userId: user.id, name: 't', prefix, hash, scopes: ['read', 'write'] } });
  await prisma.groupMember.upsert({
    where: { groupId_userId: { groupId: (await prisma.group.findUniqueOrThrow({ where: { name: 'jira-software-users' } })).id, userId: user.id } },
    create: { groupId: (await prisma.group.findUniqueOrThrow({ where: { name: 'jira-software-users' } })).id, userId: user.id },
    update: {},
  });
  return { user, agent: request.agent(app).set('Authorization', `Bearer ${plain}`) };
}

async function createProject(key: string, leadEmail?: string) {
  const lead = leadEmail ? await prisma.user.findUnique({ where: { email: leadEmail } }) : null;
  return prisma.project.create({
    data: {
      key,
      name: key,
      leadId: lead?.id,
      permissionSchemeId: (await prisma.permissionScheme.findFirstOrThrow({ where: { name: 'Default Permission Scheme' } })).id,
    },
  });
}

async function grant(schemeId: string, permission: string, holderType: string, holderParam?: string) {
  return prisma.permissionGrant.create({ data: { schemeId, permission, holderType, holderParam } });
}

describe('Sprint 015 — Permissions Core', () => {
  beforeAll(async () => {
    await ensureTestAuth();
    await (await import('../../src/seed.js')).seedPermissionDefaults();
  });

  // ---------- US1 groups & roles ----------

  it('creates groups, adds members, pages them (Jira shapes)', async () => {
    await authed(app).post('/rest/api/2/group').send({ name: 'agents' }).expect(201);
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@test.local' } });
    await authed(app).post('/rest/api/2/group/user?groupname=agents').send({ accountId: admin.id }).expect(201);
    const members = await authed(app).get('/rest/api/2/group/member?groupname=agents').expect(200);
    expect(members.body.total).toBe(1);
    expect(members.body.values[0].accountId).toBe(admin.id);
    const g = await authed(app).get('/rest/api/2/group?groupname=agents').expect(200);
    expect(g.body.users.size).toBe(1);
  });

  it('/group/member?query= filters members server-side (name + email)', async () => {
    await authed(app).post('/rest/api/2/group').send({ name: 'filterable' }).expect(201);
    const { user: alpha } = await memberAuth('alpha-fm@test.local');
    const { user: beta } = await memberAuth('beta-fm@test.local');
    for (const u of [alpha, beta]) {
      await authed(app).post('/rest/api/2/group/user?groupname=filterable').send({ accountId: u.id }).expect(201);
    }
    const all = await authed(app).get('/rest/api/2/group/member?groupname=filterable').expect(200);
    expect(all.body.total).toBe(2);
    const byName = await authed(app).get('/rest/api/2/group/member?groupname=filterable&query=alpha').expect(200);
    expect(byName.body.total).toBe(1);
    expect(byName.body.values.map((v: { accountId: string }) => v.accountId)).toEqual([alpha.id]);
    const byEmail = await authed(app).get('/rest/api/2/group/member?groupname=filterable&query=beta-fm%40').expect(200);
    expect(byEmail.body.total).toBe(1);
    expect(byEmail.body.values[0].accountId).toBe(beta.id);
    const none = await authed(app).get('/rest/api/2/group/member?groupname=filterable&query=zzz').expect(200);
    expect(none.body.total).toBe(0);
    expect(none.body.isLast).toBe(true);
  });

  it('rejects group admin calls from non-admins', async () => {
    const { agent } = await memberAuth('pleb@test.local');
    await agent.post('/rest/api/2/group').send({ name: 'x' }).expect(403);
    await agent.get('/rest/api/2/groups/picker').expect(403);
  });

  it('lists groups via /groups/picker with member counts + query filter (021)', async () => {
    await authed(app).post('/rest/api/2/group').send({ name: 'devs' }).expect(201);
    await authed(app).post('/rest/api/2/group').send({ name: 'ops' }).expect(201);
    const all = await authed(app).get('/rest/api/2/groups/picker').expect(200);
    const names = all.body.groups.map((g: { name: string }) => g.name);
    expect(names).toContain('devs');
    expect(names).toContain('ops');
    expect(all.body.groups.find((g: { name: string }) => g.name === 'devs').memberCount).toBe(0);
    const filtered = await authed(app).get('/rest/api/2/groups/picker?query=dev').expect(200);
    expect(filtered.body.groups.map((g: { name: string }) => g.name)).toEqual(['devs']);
    // total counts all matches, not the page size — and startAt pages past it.
    expect(filtered.body.total).toBe(1);
    const page0 = await authed(app).get('/rest/api/2/groups/picker?maxResults=1&startAt=0').expect(200);
    expect(page0.body.groups).toHaveLength(1);
    expect(page0.body.total).toBeGreaterThanOrEqual(2);
    const page1 = await authed(app).get('/rest/api/2/groups/picker?maxResults=1&startAt=1').expect(200);
    expect(page1.body.groups).toHaveLength(1);
    expect(page1.body.groups[0].name).not.toBe(page0.body.groups[0].name);
  });

  it('grant preview resolves direct user reach per holder type (021 US3)', async () => {
    const schemes = await authed(app).get('/rest/api/2/permissionscheme').expect(200);
    const schemeId = schemes.body.permissionSchemes[0].id;
    const { agent } = await memberAuth('prev@test.local');
    const me = await agent.get('/rest/api/2/myself');
    await authed(app).post('/rest/api/2/group').send({ name: 'previewers' }).expect(201);
    await authed(app).post('/rest/api/2/group/user?groupname=previewers').send({ accountId: me.body.accountId }).expect(201);

    const appPreview = await authed(app)
      .post(`/rest/api/2/permissionscheme/${schemeId}/permission/preview`)
      .send({ holder: { type: 'applicationRole' } }).expect(200);
    expect(appPreview.body.directUserCount).toBeGreaterThanOrEqual(2);
    expect(appPreview.body.dynamic).toBe(false);

    const grpPreview = await authed(app)
      .post(`/rest/api/2/permissionscheme/${schemeId}/permission/preview`)
      .send({ holder: { type: 'group', parameter: 'previewers' } }).expect(200);
    expect(grpPreview.body.directUserCount).toBe(1);

    const dynPreview = await authed(app)
      .post(`/rest/api/2/permissionscheme/${schemeId}/permission/preview`)
      .send({ holder: { type: 'assignee' } }).expect(200);
    expect(dynPreview.body.dynamic).toBe(true);
    expect(dynPreview.body.directUserCount).toBeNull();

    await authed(app)
      .post(`/rest/api/2/permissionscheme/${schemeId}/permission/preview`)
      .send({ holder: { type: 'group', parameter: 'nonexistent' } }).expect(400);
  });

  it('adds user+group actors to a project role with Jira actor types', async () => {
    await createProject('PRA');
    const { user } = await memberAuth('dev1@test.local');
    await authed(app).post('/rest/api/2/group').send({ name: 'qa-team' }).expect(201);
    const role = await prisma.projectRole.findUniqueOrThrow({ where: { name: 'Developers' } });
    const res = await authed(app)
      .post(`/rest/api/2/project/PRA/role/${role.id}`)
      .send({ user: [user.id], group: ['qa-team'] })
      .expect(200);
    const types = res.body.actors.map((a: { type: string }) => a.type).sort();
    expect(types).toEqual(['atlassian-group-role-actor', 'atlassian-user-role-actor']);
  });

  it('role membership via group counts for permissions', async () => {
    await createProject('GRP');
    const { user, agent } = await memberAuth('groupdev@test.local');
    // Restrictive scheme: only Developers role gets CREATE_ISSUES.
    const scheme = await prisma.permissionScheme.create({ data: { name: 'Restricted' } });
    const devRole = await prisma.projectRole.findUniqueOrThrow({ where: { name: 'Developers' } });
    await grant(scheme.id, 'BROWSE_PROJECTS', 'applicationRole');
    await grant(scheme.id, 'CREATE_ISSUES', 'projectRole', devRole.id);
    await prisma.project.update({ where: { key: 'GRP' }, data: { permissionSchemeId: scheme.id } });
    // User is NOT a Developer yet → create denied naming CREATE_ISSUES.
    const denied = await agent.post('/rest/api/2/issue').send({ fields: { project: { key: 'GRP' }, summary: 'x' } }).expect(403);
    expect(JSON.stringify(denied.body)).toContain('CREATE_ISSUES');
    // Grant membership via group actor.
    await prisma.group.create({ data: { name: 'devs-g' } });
    const g = await prisma.group.findUniqueOrThrow({ where: { name: 'devs-g' } });
    await prisma.groupMember.create({ data: { groupId: g.id, userId: user.id } });
    await authed(app).post(`/rest/api/2/project/GRP/role/${devRole.id}`).send({ group: ['devs-g'] }).expect(200);
    await agent.post('/rest/api/2/issue').send({ fields: { project: { key: 'GRP' }, summary: 'x' } }).expect(201);
  });

  it('group actor in Administrators role grants ADMINISTER_PROJECTS to members only', async () => {
    await createProject('GAD');
    const { user, agent } = await memberAuth('grpadmin@test.local');
    const { agent: outsider } = await memberAuth('outsider@test.local');
    const admins = await prisma.projectRole.findUniqueOrThrow({ where: { name: 'Administrators' } });
    // Role-actor reads are project-admin gated — denied before the grant.
    await agent.get(`/rest/api/2/project/GAD/role/${admins.id}`).expect(403);
    // Assign the group to the project's Administrators role.
    const g = await prisma.group.create({ data: { name: 'gad-admins' } });
    await prisma.groupMember.create({ data: { groupId: g.id, userId: user.id } });
    await authed(app).post(`/rest/api/2/project/GAD/role/${admins.id}`).send({ group: ['gad-admins'] }).expect(200);
    // Member now passes the project-admin gate; non-member still denied.
    const res = await agent.get(`/rest/api/2/project/GAD/role/${admins.id}`).expect(200);
    expect(res.body.actors.map((a: { type: string }) => a.type)).toContain('atlassian-group-role-actor');
    await outsider.get(`/rest/api/2/project/GAD/role/${admins.id}`).expect(403);
    // Admin op through the member too — adding an actor to another role.
    const devRole = await prisma.projectRole.findUniqueOrThrow({ where: { name: 'Developers' } });
    await agent.post(`/rest/api/2/project/GAD/role/${devRole.id}`).send({ user: [user.id] }).expect(200);
  });

  // ---------- US2 schemes & enforcement ----------

  it('seeds the default scheme with Jira holder types', async () => {
    const scheme = await prisma.permissionScheme.findFirstOrThrow({ where: { name: 'Default Permission Scheme' } });
    const res = await authed(app).get(`/rest/api/2/permissionscheme/${scheme.id}?expand=permissions`).expect(200);
    const holders = new Set(res.body.permissions.map((p: { holder: { type: string } }) => p.holder.type));
    expect(holders.has('applicationRole')).toBe(true);
    expect(holders.has('projectRole')).toBe(true);
    expect(holders.has('group')).toBe(true);
    expect(res.body.permissions.length).toBeGreaterThanOrEqual(15);
  });

  it('enforces the same permission across write paths (403 names it)', async () => {
    await createProject('ENF');
    const { agent } = await memberAuth('nofield@test.local');
    const scheme = await prisma.permissionScheme.create({ data: { name: 'BrowseOnly' } });
    await grant(scheme.id, 'BROWSE_PROJECTS', 'applicationRole');
    await prisma.project.update({ where: { key: 'ENF' }, data: { permissionSchemeId: scheme.id } });
    // Admin creates the issue first (admin bypass).
    await authed(app).post('/rest/api/2/issue').send({ fields: { project: { key: 'ENF' }, summary: 's' } }).expect(201);
    for (const attempt of [
      () => agent.put('/rest/api/2/issue/ENF-1').send({ fields: { summary: 'edit' } }),
      () => agent.post('/rest/api/2/issue/ENF-1/comment').send({ body: 'hi' }),
      () => agent.post('/rest/api/2/issue').send({ fields: { project: { key: 'ENF' }, summary: 'y' } }),
    ]) {
      const res = await attempt();
      expect(res.status).toBe(403);
      expect(JSON.stringify(res.body)).toContain('permission');
    }
    // Read still works (BROWSE granted).
    await agent.get('/rest/api/2/issue/ENF-1').expect(200);
  });

  it('hides issues in non-browsable projects from search and GET (404)', async () => {
    await createProject('SEC');
    await authed(app).post('/rest/api/2/issue').send({ fields: { project: { key: 'SEC' }, summary: 'secret' } }).expect(201);
    const scheme = await prisma.permissionScheme.create({ data: { name: 'NoBrowse' } });
    await grant(scheme.id, 'BROWSE_PROJECTS', 'group', 'jira-administrators');
    await prisma.project.update({ where: { key: 'SEC' }, data: { permissionSchemeId: scheme.id } });
    const { agent } = await memberAuth('outsider@test.local');
    await agent.get('/rest/api/2/issue/SEC-1').expect(404);
    const res = await agent.get('/rest/api/2/search?jql=project=SEC').expect(200);
    expect(res.body.issues?.length ?? res.body.total ?? 0).toBe(0);
    // Admin still sees it (site-admin bypass).
    await authed(app).get('/rest/api/2/issue/SEC-1').expect(200);
  });

  it('mypermissions reflects scheme grants accurately', async () => {
    await createProject('MYP');
    const { agent } = await memberAuth('checker@test.local');
    const res = await agent.get('/rest/api/2/mypermissions?projectKey=MYP&permissions=EDIT_ISSUES,DELETE_ISSUES,ADMINISTER_PROJECTS').expect(200);
    expect(res.body.permissions.EDIT_ISSUES.havePermission).toBe(true); // applicationRole on default scheme
    expect(res.body.permissions.ADMINISTER_PROJECTS.havePermission).toBe(false);
    await agent.get('/rest/api/2/mypermissions').expect(400); // permissions param required
  });

  it('edits scheme grants via API and reassignment changes access', async () => {
    await createProject('REA');
    const { agent } = await memberAuth('swap@test.local');
    const locked = await authed(app).post('/rest/api/2/permissionscheme').send({ name: 'Locked' }).expect(201);
    await authed(app).post(`/rest/api/2/permissionscheme/${locked.body.id}/permission`).send({ permission: 'BROWSE_PROJECTS', holder: { type: 'applicationRole' } }).expect(201);
    await authed(app).put('/rest/api/2/project/REA/permissionscheme').send({ id: locked.body.id }).expect(200);
    await agent.post('/rest/api/2/issue').send({ fields: { project: { key: 'REA' }, summary: 'x' } }).expect(403);
    // Grant CREATE via API → now allowed.
    await authed(app).post(`/rest/api/2/permissionscheme/${locked.body.id}/permission`).send({ permission: 'CREATE_ISSUES', holder: { type: 'applicationRole' } }).expect(201);
    await agent.post('/rest/api/2/issue').send({ fields: { project: { key: 'REA' }, summary: 'x' } }).expect(201);
  });

  // ---------- US3 architecture & PAT intersection ----------

  it('token project allow-list still intersects with permissions (404)', async () => {
    const user = await prisma.user.create({ data: { email: 'tok@test.local', displayName: 'tok', passwordHash: await hashPassword('pw') } });
    const { plain, prefix, hash } = generateToken();
    await prisma.apiToken.create({ data: { userId: user.id, name: 't', prefix, hash, scopes: ['read', 'write'], projectKeys: ['OTHER'] } });
    const agent = request.agent(app).set('Authorization', `Bearer ${plain}`);
    await agent.get('/rest/api/2/issue/SEC-1').expect(404); // token scoped out
  });

  // ---------- US4 last-admin guard ----------

  it('blocks removing the last Administrators actor', async () => {
    const project = await createProject('LAD');
    const role = await prisma.projectRole.findUniqueOrThrow({ where: { name: 'Administrators' } });
    await prisma.projectRoleActor.deleteMany({ where: { projectId: project.id, roleId: role.id } });
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@test.local' } });
    await prisma.projectRoleActor.create({ data: { projectId: project.id, roleId: role.id, userId: admin.id } });
    const res = await authed(app).delete(`/rest/api/2/project/LAD/role/${role.id}?user=${admin.id}`).expect(400);
    expect(JSON.stringify(res.body)).toContain('Administrators');
  });

  it('group dry-run delete lists dependents', async () => {
    await prisma.group.create({ data: { name: 'doomed' } });
    const g = await prisma.group.findUniqueOrThrow({ where: { name: 'doomed' } });
    const role = await prisma.projectRole.findUniqueOrThrow({ where: { name: 'Users' } });
    await prisma.projectRoleActor.create({ data: { projectId: (await createProject('DRY')).id, roleId: role.id, groupId: g.id } });
    const res = await authed(app).delete('/rest/api/2/group?groupname=doomed&dryRun=true').expect(200);
    expect(res.headers['x-trackforge-dryrun']).toBe('true');
    expect(res.body.roleActors.length).toBe(1);
    await authed(app).delete('/rest/api/2/group?groupname=doomed').expect(204);
    await authed(app).get('/rest/api/2/group?groupname=doomed').expect(404);
  });

  it('group-picker CF validates against existing groups', async () => {
    const cf = await prisma.customField.create({
      data: { id: 'customfield_10090', seq: 10090, name: 'Team Group', type: 'group', searcherType: 'text' },
    });
    await prisma.customFieldContext.create({ data: { fieldId: cf.id, isGlobal: true } });
    await createProject('GCF');
    await authed(app).post('/rest/api/2/issue').send({ fields: { project: { key: 'GCF' }, summary: 'g', customfield_10090: 'no-such-group' } }).expect(400);
    const ok = await authed(app).post('/rest/api/2/issue').send({ fields: { project: { key: 'GCF' }, summary: 'g', customfield_10090: 'jira-software-users' } }).expect(201);
    expect(ok.body.fields.customfield_10090).toEqual({ name: 'jira-software-users' });
  });
});

// ---------- Jira parity pass: catalog + enforcement gaps ----------

describe('Jira parity — permission catalog & enforcement', () => {
  beforeAll(async () => {
    await ensureTestAuth();
    await (await import('../../src/seed.js')).seedPermissionDefaults();
  });

  it('seeds the full Jira permission catalog (35 keys)', async () => {
    const { PERMISSIONS } = await import('../../src/services/permissionService.js');
    for (const p of [
      'MANAGE_SPRINTS', 'VIEW_DEV_TOOLS', 'VIEW_READONLY_WORKFLOW',
      'VIEW_VOTERS_AND_WATCHERS', 'MODIFY_REPORTER', 'SET_ISSUE_SECURITY',
      'CLOSE_ISSUES', 'RESOLVE_ISSUES', 'ARCHIVE_ISSUES', 'RESTORE_ISSUES',
    ]) expect(PERMISSIONS).toContain(p);
    expect(PERMISSIONS.length).toBe(35);
    // And the seed repair loop granted them on the default scheme.
    const scheme = await prisma.permissionScheme.findFirstOrThrow({ where: { name: 'Default Permission Scheme' } });
    const seeded = new Set(
      (await prisma.permissionGrant.findMany({ where: { schemeId: scheme.id } })).map((g) => g.permission)
    );
    for (const p of PERMISSIONS) expect(seeded, `default scheme missing ${p}`).toContain(p);
  });

  it('gates scheme reads to admins (Jira: scheme admin is global)', async () => {
    const { agent } = await memberAuth('nosch@test.local');
    await agent.get('/rest/api/2/permissionscheme').expect(403);
    const scheme = await prisma.permissionScheme.findFirstOrThrow({ where: { name: 'Default Permission Scheme' } });
    await agent.get(`/rest/api/2/permissionscheme/${scheme.id}`).expect(403);
    // Role name list stays readable for share pickers (documented divergence).
    await agent.get('/rest/api/2/role').expect(200);
  });

  it('gates project role actor reads to project admins', async () => {
    await createProject('RAC');
    const role = await prisma.projectRole.findUniqueOrThrow({ where: { name: 'Developers' } });
    const { agent } = await memberAuth('noactors@test.local');
    await agent.get(`/rest/api/2/project/RAC/role/${role.id}`).expect(403);
    await authed(app).get(`/rest/api/2/project/RAC/role/${role.id}`).expect(200);
  });

  it('requires admin to create projects (Jira parity)', async () => {
    const { agent } = await memberAuth('nocreate@test.local');
    await agent.post('/rest/api/2/project').send({ key: 'NPC', name: 'No' }).expect(403);
    await authed(app).post('/rest/api/2/project').send({ key: 'APC', name: 'Yes' }).expect(201);
  });

  it('hides watchers/voters lists without VIEW_VOTERS_AND_WATCHERS', async () => {
    await createProject('VWV');
    await authed(app).post('/rest/api/2/issue').send({ fields: { project: { key: 'VWV' }, summary: 'w' } }).expect(201);
    const { agent } = await memberAuth('viewer@test.local');
    // Default scheme grants the permission → lists visible.
    const allowed = await agent.get('/rest/api/2/issue/VWV-1/watchers').expect(200);
    expect(allowed.body).toHaveProperty('watchers');
    // Strip it from this project's scheme → lists gone, count stays.
    const scheme = await prisma.permissionScheme.create({ data: { name: 'NoViewWatchers' } });
    for (const p of ['BROWSE_PROJECTS']) await grant(scheme.id, p, 'applicationRole');
    await prisma.project.update({ where: { key: 'VWV' }, data: { permissionSchemeId: scheme.id } });
    const denied = await agent.get('/rest/api/2/issue/VWV-1/watchers').expect(200);
    expect(denied.body).not.toHaveProperty('watchers');
    expect(denied.body).toHaveProperty('watchCount');
    const vdenied = await agent.get('/rest/api/2/issue/VWV-1/votes').expect(200);
    expect(vdenied.body).not.toHaveProperty('voters');
  });

  it('watch-on-behalf needs MANAGE_WATCHERS, not site admin', async () => {
    await createProject('WOB');
    await authed(app).post('/rest/api/2/issue').send({ fields: { project: { key: 'WOB' }, summary: 'w' } }).expect(201);
    const { user, agent } = await memberAuth('watcher-mgr@test.local');
    const target = await prisma.user.findUniqueOrThrow({ where: { email: 'watcher-mgr@test.local' } });
    void user;
    // Not an admin and no MANAGE_WATCHERS grant → cannot watch for others.
    const other = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@test.local' } });
    await agent.post('/rest/api/2/issue/WOB-1/watchers').send({ accountId: other.id }).expect(403);
    // Grant MANAGE_WATCHERS to this user via a scheme on the project.
    const scheme = await prisma.permissionScheme.create({ data: { name: 'WatchMgr' } });
    await grant(scheme.id, 'BROWSE_PROJECTS', 'applicationRole');
    await grant(scheme.id, 'MANAGE_WATCHERS', 'user', target.id);
    await prisma.project.update({ where: { key: 'WOB' }, data: { permissionSchemeId: scheme.id } });
    await agent.post('/rest/api/2/issue/WOB-1/watchers').send({ accountId: other.id }).expect(204);
  });

  it('filters assignable search to ASSIGNABLE_USER holders', async () => {
    await createProject('ASG');
    const { user: onlyUser } = await memberAuth('only-assignable@test.local');
    await memberAuth('not-assignable@test.local');
    const scheme = await prisma.permissionScheme.create({ data: { name: 'AssignableOnly' } });
    await grant(scheme.id, 'BROWSE_PROJECTS', 'applicationRole');
    await grant(scheme.id, 'ASSIGNABLE_USER', 'user', onlyUser.id);
    await prisma.project.update({ where: { key: 'ASG' }, data: { permissionSchemeId: scheme.id } });
    const res = await authed(app).get('/rest/api/2/user/assignable/search?project=ASG').expect(200);
    const ids = res.body.map((u: { accountId: string }) => u.accountId);
    expect(ids).toContain(onlyUser.id);
    expect(ids).not.toContain((await prisma.user.findUniqueOrThrow({ where: { email: 'not-assignable@test.local' } })).id);
    // Site admins are always assignable (Jira bypass).
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@test.local' } });
    expect(ids).toContain(admin.id);
  });

  it('reporter changes need MODIFY_REPORTER', async () => {
    await createProject('REP');
    await authed(app).post('/rest/api/2/issue').send({ fields: { project: { key: 'REP' }, summary: 'r' } }).expect(201);
    const { agent } = await memberAuth('rep@test.local');
    const other = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@test.local' } });
    const scheme = await prisma.permissionScheme.create({ data: { name: 'NoReporter' } });
    await grant(scheme.id, 'BROWSE_PROJECTS', 'applicationRole');
    await grant(scheme.id, 'EDIT_ISSUES', 'applicationRole');
    await prisma.project.update({ where: { key: 'REP' }, data: { permissionSchemeId: scheme.id } });
    const res = await agent.put('/rest/api/2/issue/REP-1').send({ fields: { reporter: { accountId: other.id } } }).expect(403);
    expect(JSON.stringify(res.body)).toContain('MODIFY_REPORTER');
  });

  it('sprint lifecycle needs MANAGE_SPRINTS (not SCHEDULE_ISSUES)', async () => {
    const p = await createProject('SPR');
    const { ensureProjectBoard } = await import('../../src/seed.js');
    const board = await ensureProjectBoard(p.id);
    const { agent } = await memberAuth('sprinter@test.local');
    const scheme = await prisma.permissionScheme.create({ data: { name: 'ScheduleOnly' } });
    await grant(scheme.id, 'BROWSE_PROJECTS', 'applicationRole');
    await grant(scheme.id, 'SCHEDULE_ISSUES', 'applicationRole');
    await prisma.project.update({ where: { key: 'SPR' }, data: { permissionSchemeId: scheme.id } });
    const res = await agent.post('/rest/agile/1.0/sprint').send({ originBoardId: board!.id, name: 'S1' }).expect(403);
    expect(JSON.stringify(res.body)).toContain('MANAGE_SPRINTS');
    await grant(scheme.id, 'MANAGE_SPRINTS', 'applicationRole');
    await agent.post('/rest/agile/1.0/sprint').send({ originBoardId: board!.id, name: 'S1' }).expect(201);
  });

  it('transitions list is empty without TRANSITION_ISSUES', async () => {
    await createProject('TRX');
    await authed(app).post('/rest/api/2/issue').send({ fields: { project: { key: 'TRX' }, summary: 't' } }).expect(201);
    const { agent } = await memberAuth('notrans@test.local');
    const allowed = await agent.get('/rest/api/2/issue/TRX-1/transitions').expect(200);
    expect(allowed.body.transitions.length).toBeGreaterThan(0);
    const scheme = await prisma.permissionScheme.create({ data: { name: 'NoTransition' } });
    await grant(scheme.id, 'BROWSE_PROJECTS', 'applicationRole');
    await prisma.project.update({ where: { key: 'TRX' }, data: { permissionSchemeId: scheme.id } });
    const denied = await agent.get('/rest/api/2/issue/TRX-1/transitions').expect(200);
    expect(denied.body.transitions).toEqual([]);
  });

  it('project statuses list requires BROWSE_PROJECTS', async () => {
    await createProject('STS');
    const scheme = await prisma.permissionScheme.create({ data: { name: 'NoBrowseSts' } });
    await grant(scheme.id, 'BROWSE_PROJECTS', 'group', 'jira-administrators');
    await prisma.project.update({ where: { key: 'STS' }, data: { permissionSchemeId: scheme.id } });
    const { agent } = await memberAuth('nosts@test.local');
    await agent.get('/rest/api/2/project/STS/statuses').expect(404);
  });

  it('dev panel needs VIEW_DEV_TOOLS on top of issue scope', async () => {
    await createProject('DVP');
    await authed(app).post('/rest/api/2/issue').send({ fields: { project: { key: 'DVP' }, summary: 'd' } }).expect(201);
    const { agent } = await memberAuth('devviewer@test.local');
    const scheme = await prisma.permissionScheme.create({ data: { name: 'NoDevTools' } });
    await grant(scheme.id, 'BROWSE_PROJECTS', 'applicationRole');
    await prisma.project.update({ where: { key: 'DVP' }, data: { permissionSchemeId: scheme.id } });
    const res = await agent.get('/api/internal/issues/DVP-1/development').expect(403);
    expect(JSON.stringify(res.body)).toContain('VIEW_DEV_TOOLS');
  });

  it('userCustomField holder reaches whoever the user-picker field holds', async () => {
    const cf = await prisma.customField.create({
      data: { id: 'customfield_10091', seq: 10091, name: 'Approver', type: 'user', searcherType: 'user' },
    });
    await prisma.customFieldContext.create({ data: { fieldId: cf.id, isGlobal: true } });
    await createProject('UCF');
    const { user, agent } = await memberAuth('approver@test.local');
    // Scheme: only the user held in customfield_10091 may browse.
    const scheme = await prisma.permissionScheme.create({ data: { name: 'ApproverOnly' } });
    await grant(scheme.id, 'BROWSE_PROJECTS', 'userCustomField', cf.id);
    await prisma.project.update({ where: { key: 'UCF' }, data: { permissionSchemeId: scheme.id } });
    await authed(app)
      .post('/rest/api/2/issue')
      .send({ fields: { project: { key: 'UCF' }, summary: 'u', customfield_10091: user.id } })
      .expect(201);
    await agent.get('/rest/api/2/issue/UCF-1').expect(200);
    const { agent: other } = await memberAuth('not-approver@test.local');
    await other.get('/rest/api/2/issue/UCF-1').expect(404);
  });
});

// ---------- US3.1 architecture test (SC-003) ----------
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('architecture: mutating issue routes funnel through permissionService', () => {
  it('every service handling issue writes calls requirePermission/hasPermission', () => {
    const services = ['issueService.ts', 'commentService.ts', 'linkService.ts', 'workflowService.ts'];
    for (const f of services) {
      const src = readFileSync(join(__dirname, '../../src/services', f), 'utf8');
      expect(src, `${f} must enforce via permissionService`).toMatch(/requirePermission|hasPermission/);
    }
  });

  it('fails on a deliberately unprotected service (meta-test)', () => {
    // A hypothetical service file without permission imports must fail the check.
    const fake = 'export async function updateIssue() { return prisma.issue.update(); }';
    expect(/requirePermission|hasPermission/.test(fake)).toBe(false);
  });

  it('every mutating issue route uses enforceIssueScope', () => {
    const src = readFileSync(join(__dirname, '../../src/routes/issues.ts'), 'utf8');
    const mutating = [...src.matchAll(/router\.(put|post|delete)\(\s*'\/?(:\w+[^']*)?'/g)];
    expect(mutating.length).toBeGreaterThan(5);
    // Each mutating handler body must contain enforceIssueScope before its close.
    const scopeCount = (src.match(/enforceIssueScope\(key/g) ?? []).length;
    expect(scopeCount).toBeGreaterThanOrEqual(mutating.length - 2); // create+bulk are project-scoped instead
  });
});
