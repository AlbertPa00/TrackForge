-- 047 — agent experience polish. Expand-contract compliant: additive only;
-- requireApproval columns stay until the next release (docs/migrations.md).

-- AlterTable
ALTER TABLE "AiSettings" ADD COLUMN     "globalGuidance" TEXT;

-- AlterTable
ALTER TABLE "AiUsage" ADD COLUMN     "outcome" JSONB;

-- AlterTable
ALTER TABLE "ApiToken" ADD COLUMN     "approvalPolicy" TEXT NOT NULL DEFAULT 'never';

-- AlterTable
ALTER TABLE "Issue" ADD COLUMN     "delegateId" TEXT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "agentGuidance" TEXT;

-- AlterTable
ALTER TABLE "Proposal" ADD COLUMN     "appliedWithEdits" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "editedBody" JSONB,
ADD COLUMN     "timeToApproveSec" INTEGER;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "approvalPolicy" TEXT NOT NULL DEFAULT 'never',
ADD COLUMN     "isAssignableAgent" BOOLEAN NOT NULL DEFAULT false;

-- Data backfill: requireApproval true→always (false→never = the column default).
UPDATE "User" SET "approvalPolicy" = 'always' WHERE "requireApproval" = true;
UPDATE "ApiToken" SET "approvalPolicy" = 'always' WHERE "requireApproval" = true;

-- CreateTable
CREATE TABLE "AgentSession" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "agentUserId" TEXT NOT NULL,
    "delegatorId" TEXT,
    "trigger" TEXT NOT NULL DEFAULT 'delegate',
    "status" TEXT NOT NULL DEFAULT 'running',
    "activities" JSONB NOT NULL DEFAULT '[]',
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AgentSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentQuestion" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" JSONB,
    "status" TEXT NOT NULL DEFAULT 'open',
    "answer" TEXT,
    "answeredById" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),

    CONSTRAINT "AgentQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentSession_issueId_status_idx" ON "AgentSession"("issueId", "status");

-- CreateIndex
CREATE INDEX "AgentSession_agentUserId_status_idx" ON "AgentSession"("agentUserId", "status");

-- CreateIndex
CREATE INDEX "AgentQuestion_sessionId_status_idx" ON "AgentQuestion"("sessionId", "status");

-- CreateIndex
CREATE INDEX "AgentQuestion_issueId_status_idx" ON "AgentQuestion"("issueId", "status");

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_delegateId_fkey" FOREIGN KEY ("delegateId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_agentUserId_fkey" FOREIGN KEY ("agentUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSession" ADD CONSTRAINT "AgentSession_delegatorId_fkey" FOREIGN KEY ("delegatorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentQuestion" ADD CONSTRAINT "AgentQuestion_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentQuestion" ADD CONSTRAINT "AgentQuestion_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentQuestion" ADD CONSTRAINT "AgentQuestion_answeredById_fkey" FOREIGN KEY ("answeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
