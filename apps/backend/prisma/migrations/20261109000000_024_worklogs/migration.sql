-- Sprint 024: time tracking & worklogs

-- AlterTable
ALTER TABLE "Issue" ADD COLUMN "originalEstimateSec" INTEGER,
ADD COLUMN "remainingEstimateSec" INTEGER;

-- CreateTable
CREATE TABLE "Worklog" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "timeSpentSec" INTEGER NOT NULL,
    "started" TIMESTAMP(3) NOT NULL,
    "comment" TEXT,
    "billable" BOOLEAN NOT NULL DEFAULT false,
    "channel" TEXT NOT NULL DEFAULT 'api',
    "tokenId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Worklog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeletedWorklog" (
    "worklogId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeletedWorklog_pkey" PRIMARY KEY ("worklogId")
);

-- CreateTable
CREATE TABLE "SystemSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SystemSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE INDEX "Worklog_issueId_started_idx" ON "Worklog"("issueId", "started");

-- CreateIndex
CREATE INDEX "Worklog_authorId_started_idx" ON "Worklog"("authorId", "started");

-- CreateIndex
CREATE INDEX "Worklog_updatedAt_idx" ON "Worklog"("updatedAt");

-- CreateIndex
CREATE INDEX "DeletedWorklog_deletedAt_idx" ON "DeletedWorklog"("deletedAt");

-- AddForeignKey
ALTER TABLE "Worklog" ADD CONSTRAINT "Worklog_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Worklog" ADD CONSTRAINT "Worklog_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Worklog" ADD CONSTRAINT "Worklog_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "ApiToken"("id") ON DELETE SET NULL ON UPDATE CASCADE;
