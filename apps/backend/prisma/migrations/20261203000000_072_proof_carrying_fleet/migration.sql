-- 072 — proof-carrying work, resource locks, waitlists, issue ledger, advisories

-- DomainEvent dead-letter bookkeeping
ALTER TABLE "DomainEvent"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "lastError" TEXT,
  ADD COLUMN "deadLetteredAt" TIMESTAMP(3);
CREATE INDEX "DomainEvent_nextAttemptAt_idx" ON "DomainEvent"("nextAttemptAt");

-- AgentSession git grounding + drift reconciliation
ALTER TABLE "AgentSession"
  ADD COLUMN "baseSha" TEXT,
  ADD COLUMN "headSha" TEXT,
  ADD COLUMN "branchName" TEXT,
  ADD COLUMN "driftStatus" TEXT NOT NULL DEFAULT 'untracked',
  ADD COLUMN "driftReport" JSONB;

-- Traces outlive handed-off sessions while the branch is unmerged
ALTER TABLE "StigmergicTrace" ADD COLUMN "pendingMerge" BOOLEAN NOT NULL DEFAULT false;

-- Town-hall evidence gate
ALTER TABLE "TownHallTopic" ADD COLUMN "requireEvidenceReceipt" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "WorkReceipt" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "issueId" TEXT,
  "sessionId" TEXT,
  "topicPostId" BIGINT,
  "authorId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "sha256" TEXT NOT NULL,
  "gitCommitSha" TEXT,
  "gitBranch" TEXT,
  "summary" TEXT NOT NULL,
  "metricsJson" JSONB,
  "artifactUri" TEXT,
  "verification" TEXT NOT NULL DEFAULT 'unverified',
  "verifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkReceipt_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WorkReceipt_issueId_verification_idx" ON "WorkReceipt"("issueId", "verification");
CREATE INDEX "WorkReceipt_sessionId_idx" ON "WorkReceipt"("sessionId");
CREATE INDEX "WorkReceipt_topicPostId_idx" ON "WorkReceipt"("topicPostId");
CREATE INDEX "WorkReceipt_gitCommitSha_idx" ON "WorkReceipt"("gitCommitSha");
ALTER TABLE "WorkReceipt" ADD CONSTRAINT "WorkReceipt_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkReceipt" ADD CONSTRAINT "WorkReceipt_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "WorkReceipt" ADD CONSTRAINT "WorkReceipt_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkReceipt" ADD CONSTRAINT "WorkReceipt_topicPostId_fkey" FOREIGN KEY ("topicPostId") REFERENCES "TownHallPost"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WorkReceipt" ADD CONSTRAINT "WorkReceipt_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ResourceLock" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "agentUserId" TEXT NOT NULL,
  "pathPattern" TEXT NOT NULL,
  "mode" TEXT NOT NULL DEFAULT 'exclusive',
  "fenceToken" INTEGER NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ResourceLock_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ResourceLock_projectId_expiresAt_idx" ON "ResourceLock"("projectId", "expiresAt");
CREATE INDEX "ResourceLock_projectId_pathPattern_idx" ON "ResourceLock"("projectId", "pathPattern");
ALTER TABLE "ResourceLock" ADD CONSTRAINT "ResourceLock_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceLock" ADD CONSTRAINT "ResourceLock_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ResourceLock" ADD CONSTRAINT "ResourceLock_agentUserId_fkey" FOREIGN KEY ("agentUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ContentionWaiter" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "targetKind" TEXT NOT NULL,
  "targetKey" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ContentionWaiter_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ContentionWaiter_targetKind_targetKey_userId_key" ON "ContentionWaiter"("targetKind", "targetKey", "userId");
CREATE INDEX "ContentionWaiter_targetKind_targetKey_createdAt_idx" ON "ContentionWaiter"("targetKind", "targetKey", "createdAt");
CREATE INDEX "ContentionWaiter_expiresAt_idx" ON "ContentionWaiter"("expiresAt");
ALTER TABLE "ContentionWaiter" ADD CONSTRAINT "ContentionWaiter_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ContentionWaiter" ADD CONSTRAINT "ContentionWaiter_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "IssueLedgerEntry" (
  "id" BIGSERIAL NOT NULL,
  "issueId" TEXT NOT NULL,
  "actorId" TEXT,
  "kind" TEXT NOT NULL,
  "summary" TEXT NOT NULL,
  "payload" JSONB,
  "receiptId" TEXT,
  "sessionId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IssueLedgerEntry_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "IssueLedgerEntry_issueId_id_idx" ON "IssueLedgerEntry"("issueId", "id" DESC);
ALTER TABLE "IssueLedgerEntry" ADD CONSTRAINT "IssueLedgerEntry_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueLedgerEntry" ADD CONSTRAINT "IssueLedgerEntry_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IssueLedgerEntry" ADD CONSTRAINT "IssueLedgerEntry_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "WorkReceipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "RepoAdvisory" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "pathGlob" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'info',
  "summary" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  "sourceIssueId" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RepoAdvisory_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RepoAdvisory_projectId_active_idx" ON "RepoAdvisory"("projectId", "active");
ALTER TABLE "RepoAdvisory" ADD CONSTRAINT "RepoAdvisory_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RepoAdvisory" ADD CONSTRAINT "RepoAdvisory_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RepoAdvisory" ADD CONSTRAINT "RepoAdvisory_sourceIssueId_fkey" FOREIGN KEY ("sourceIssueId") REFERENCES "Issue"("id") ON DELETE SET NULL ON UPDATE CASCADE;
