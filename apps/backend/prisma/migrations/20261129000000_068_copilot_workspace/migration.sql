-- 068 — copilot workbench threads: per-user multi-turn context for the dock.
-- Turns are a record of what happened (instructions, answers, entity refs,
-- applied writes) — never execution authority, which stays with the in-memory
-- planStore's 10-minute planId TTL.

-- CreateTable
CREATE TABLE "CopilotThread" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CopilotThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CopilotTurn" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "index" INTEGER NOT NULL,
    "instruction" TEXT NOT NULL,
    "answer" TEXT,
    "entities" JSONB,
    "writesApplied" JSONB,
    "outcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CopilotTurn_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CopilotThread_userId_updatedAt_idx" ON "CopilotThread"("userId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CopilotTurn_threadId_index_key" ON "CopilotTurn"("threadId", "index");

-- CreateIndex
CREATE INDEX "CopilotTurn_threadId_createdAt_idx" ON "CopilotTurn"("threadId", "createdAt");

-- AddForeignKey
ALTER TABLE "CopilotThread" ADD CONSTRAINT "CopilotThread_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CopilotTurn" ADD CONSTRAINT "CopilotTurn_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "CopilotThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;
