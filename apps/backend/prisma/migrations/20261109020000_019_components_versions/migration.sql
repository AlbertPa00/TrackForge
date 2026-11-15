-- Sprint 019: components, versions, and issue join tables.

CREATE TABLE "Component" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "leadId" TEXT,
    "assigneeType" TEXT NOT NULL DEFAULT 'PROJECT_DEFAULT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Component_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Version" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "released" BOOLEAN NOT NULL DEFAULT false,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "startDate" TIMESTAMP(3),
    "releaseDate" TIMESTAMP(3),
    "sequence" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Version_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IssueComponent" (
    "issueId" TEXT NOT NULL,
    "componentId" TEXT NOT NULL,

    CONSTRAINT "IssueComponent_pkey" PRIMARY KEY ("issueId", "componentId")
);

CREATE TABLE "IssueVersion" (
    "issueId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,

    CONSTRAINT "IssueVersion_pkey" PRIMARY KEY ("issueId", "versionId", "kind")
);

CREATE INDEX "Component_projectId_idx" ON "Component"("projectId");
CREATE UNIQUE INDEX "Component_projectId_name_key" ON "Component"("projectId", "name");
CREATE INDEX "Version_projectId_sequence_idx" ON "Version"("projectId", "sequence");
CREATE UNIQUE INDEX "Version_projectId_name_key" ON "Version"("projectId", "name");
CREATE INDEX "IssueComponent_componentId_idx" ON "IssueComponent"("componentId");
CREATE INDEX "IssueVersion_versionId_kind_idx" ON "IssueVersion"("versionId", "kind");

ALTER TABLE "Component" ADD CONSTRAINT "Component_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Component" ADD CONSTRAINT "Component_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Version" ADD CONSTRAINT "Version_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueComponent" ADD CONSTRAINT "IssueComponent_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueComponent" ADD CONSTRAINT "IssueComponent_componentId_fkey" FOREIGN KEY ("componentId") REFERENCES "Component"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueVersion" ADD CONSTRAINT "IssueVersion_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueVersion" ADD CONSTRAINT "IssueVersion_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "Version"("id") ON DELETE CASCADE ON UPDATE CASCADE;
