-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "permissionSchemeId" TEXT;

-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Group_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GroupMember" (
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "GroupMember_pkey" PRIMARY KEY ("groupId","userId")
);

-- CreateTable
CREATE TABLE "ProjectRole" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "ProjectRole_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectRoleActor" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "userId" TEXT,
    "groupId" TEXT,

    CONSTRAINT "ProjectRoleActor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PermissionScheme" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "PermissionScheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PermissionGrant" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "holderType" TEXT NOT NULL,
    "holderParam" TEXT,

    CONSTRAINT "PermissionGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Group_name_key" ON "Group"("name");

-- CreateIndex
CREATE INDEX "GroupMember_userId_idx" ON "GroupMember"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectRole_name_key" ON "ProjectRole"("name");

-- CreateIndex
CREATE INDEX "ProjectRoleActor_projectId_roleId_idx" ON "ProjectRoleActor"("projectId", "roleId");

-- CreateIndex
CREATE INDEX "ProjectRoleActor_userId_idx" ON "ProjectRoleActor"("userId");

-- CreateIndex
CREATE INDEX "ProjectRoleActor_groupId_idx" ON "ProjectRoleActor"("groupId");

-- CreateIndex
CREATE UNIQUE INDEX "PermissionScheme_name_key" ON "PermissionScheme"("name");

-- CreateIndex
CREATE INDEX "PermissionGrant_schemeId_permission_idx" ON "PermissionGrant"("schemeId", "permission");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_permissionSchemeId_fkey" FOREIGN KEY ("permissionSchemeId") REFERENCES "PermissionScheme"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GroupMember" ADD CONSTRAINT "GroupMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRoleActor" ADD CONSTRAINT "ProjectRoleActor_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "ProjectRole"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRoleActor" ADD CONSTRAINT "ProjectRoleActor_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRoleActor" ADD CONSTRAINT "ProjectRoleActor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectRoleActor" ADD CONSTRAINT "ProjectRoleActor_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PermissionGrant" ADD CONSTRAINT "PermissionGrant_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "PermissionScheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

