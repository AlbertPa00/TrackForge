-- 071 — Agent Town Hall & fleet coordination:
--  1. Issue optimistic concurrency (version) + monotonic lease fencing
--     (lastFenceToken); zombie/stale writers get 409 instead of clobbering.
--  2. AgentSession upgraded in place into the fenced lease (role driver|
--     reviewer|observer, fenceToken, ttlSec, heartbeatAt, leaseExpiresAt,
--     worktreeRef, handoff) — one open driver per issue enforced by the
--     partial unique index below; reviewer/observer coexist freely.
--  3. AgentProfile (roster/presence) + AgentInboxItem (durable agent mailbox).
--  4. TownHallChannel/Topic/Post/Stance/TopicIssue — parliamentary
--     deliberation that compiles to issue DAGs.
--  5. StigmergicTrace — ephemeral cross-issue file/symbol intent signals.
--  6. Project.agentPaused + AgentQuestion peer targets (targetUserId/Role).

ALTER TABLE "Project"
    ADD COLUMN "agentPaused" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "agentPauseReason" TEXT;

ALTER TABLE "Issue"
    ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN "lastFenceToken" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "AgentSession"
    ADD COLUMN "role" TEXT NOT NULL DEFAULT 'driver',
    ADD COLUMN "fenceToken" INTEGER,
    ADD COLUMN "ttlSec" INTEGER NOT NULL DEFAULT 900,
    ADD COLUMN "heartbeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
    ADD COLUMN "worktreeRef" TEXT,
    ADD COLUMN "handoff" JSONB;

-- At most one open driver session per issue. Open = running|blocked|
-- needs-answer; done/failed/expired/released/broken free the slot.
CREATE UNIQUE INDEX "AgentSession_one_open_driver_idx"
    ON "AgentSession" ("issueId")
    WHERE "role" = 'driver' AND "status" IN ('running', 'needs-answer', 'blocked');

CREATE INDEX "AgentSession_leaseExpiresAt_idx" ON "AgentSession"("leaseExpiresAt");

ALTER TABLE "AgentQuestion"
    ADD COLUMN "targetUserId" TEXT,
    ADD COLUMN "targetRole" TEXT;

ALTER TABLE "AgentQuestion"
    ADD CONSTRAINT "AgentQuestion_targetUserId_fkey"
    FOREIGN KEY ("targetUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "AgentProfile" (
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'generalist',
    "skills" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "model" TEXT,
    "bio" TEXT,
    "maxConcurrentLeases" INTEGER NOT NULL DEFAULT 1,
    "lastHeartbeatAt" TIMESTAMP(3),
    "lastSummonedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentProfile_pkey" PRIMARY KEY ("userId")
);

CREATE INDEX "AgentProfile_role_idx" ON "AgentProfile"("role");
CREATE INDEX "AgentProfile_lastHeartbeatAt_idx" ON "AgentProfile"("lastHeartbeatAt");
CREATE INDEX "AgentProfile_skills_idx" ON "AgentProfile" USING GIN ("skills");

ALTER TABLE "AgentProfile"
    ADD CONSTRAINT "AgentProfile_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TownHallChannel" (
    "id" TEXT NOT NULL,
    "projectId" TEXT,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "agentCooldownSec" INTEGER NOT NULL DEFAULT 15,
    "archived" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TownHallChannel_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TownHallChannel_projectId_slug_key" ON "TownHallChannel"("projectId", "slug");
CREATE INDEX "TownHallChannel_projectId_archived_idx" ON "TownHallChannel"("projectId", "archived");

ALTER TABLE "TownHallChannel"
    ADD CONSTRAINT "TownHallChannel_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TownHallTopic" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "projectId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'rfc',
    "status" TEXT NOT NULL DEFAULT 'open',
    "title" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "quorumRequired" INTEGER NOT NULL DEFAULT 1,
    "requiredRoles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "decisionSummary" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "postCount" INTEGER NOT NULL DEFAULT 0,
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TownHallTopic_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TownHallTopic_channelId_status_lastActivityAt_idx" ON "TownHallTopic"("channelId", "status", "lastActivityAt" DESC);
CREATE INDEX "TownHallTopic_projectId_status_idx" ON "TownHallTopic"("projectId", "status");

ALTER TABLE "TownHallTopic"
    ADD CONSTRAINT "TownHallTopic_channelId_fkey"
    FOREIGN KEY ("channelId") REFERENCES "TownHallChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "TownHallTopic_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "User"("id") ON UPDATE CASCADE,
    ADD CONSTRAINT "TownHallTopic_resolvedById_fkey"
    FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON UPDATE CASCADE;

CREATE TABLE "TownHallPost" (
    "id" BIGSERIAL NOT NULL,
    "topicId" TEXT NOT NULL,
    "parentId" BIGINT,
    "authorId" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'api',
    "speechAct" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "refs" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TownHallPost_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TownHallPost_topicId_id_idx" ON "TownHallPost"("topicId", "id");
CREATE INDEX "TownHallPost_topicId_authorId_createdAt_idx" ON "TownHallPost"("topicId", "authorId", "createdAt");

ALTER TABLE "TownHallPost"
    ADD CONSTRAINT "TownHallPost_topicId_fkey"
    FOREIGN KEY ("topicId") REFERENCES "TownHallTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "TownHallPost_parentId_fkey"
    FOREIGN KEY ("parentId") REFERENCES "TownHallPost"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "TownHallPost_authorId_fkey"
    FOREIGN KEY ("authorId") REFERENCES "User"("id") ON UPDATE CASCADE;

CREATE TABLE "TownHallStance" (
    "id" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "stance" TEXT NOT NULL,
    "reason" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TownHallStance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TownHallStance_topicId_actorId_key" ON "TownHallStance"("topicId", "actorId");
CREATE INDEX "TownHallStance_topicId_stance_idx" ON "TownHallStance"("topicId", "stance");

ALTER TABLE "TownHallStance"
    ADD CONSTRAINT "TownHallStance_topicId_fkey"
    FOREIGN KEY ("topicId") REFERENCES "TownHallTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "TownHallStance_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "TownHallTopicIssue" (
    "topicId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "relation" TEXT NOT NULL DEFAULT 'compiled',

    CONSTRAINT "TownHallTopicIssue_pkey" PRIMARY KEY ("topicId", "issueId")
);

CREATE INDEX "TownHallTopicIssue_issueId_idx" ON "TownHallTopicIssue"("issueId");

ALTER TABLE "TownHallTopicIssue"
    ADD CONSTRAINT "TownHallTopicIssue_topicId_fkey"
    FOREIGN KEY ("topicId") REFERENCES "TownHallTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "TownHallTopicIssue_issueId_fkey"
    FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AgentInboxItem" (
    "id" BIGSERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "eventId" BIGINT,
    "projectId" TEXT,
    "issueId" TEXT,
    "topicId" TEXT,
    "reason" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "ackedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentInboxItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentInboxItem_userId_ackedAt_id_idx" ON "AgentInboxItem"("userId", "ackedAt", "id");
CREATE INDEX "AgentInboxItem_createdAt_idx" ON "AgentInboxItem"("createdAt");

ALTER TABLE "AgentInboxItem"
    ADD CONSTRAINT "AgentInboxItem_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "AgentInboxItem_topicId_fkey"
    FOREIGN KEY ("topicId") REFERENCES "TownHallTopic"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StigmergicTrace" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StigmergicTrace_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StigmergicTrace_sessionId_kind_target_key" ON "StigmergicTrace"("sessionId", "kind", "target");
CREATE INDEX "StigmergicTrace_projectId_target_expiresAt_idx" ON "StigmergicTrace"("projectId", "target", "expiresAt");
CREATE INDEX "StigmergicTrace_expiresAt_idx" ON "StigmergicTrace"("expiresAt");

ALTER TABLE "StigmergicTrace"
    ADD CONSTRAINT "StigmergicTrace_issueId_fkey"
    FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "StigmergicTrace_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    ADD CONSTRAINT "StigmergicTrace_actorId_fkey"
    FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
