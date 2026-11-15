-- AlterTable
ALTER TABLE "AgentSession" DROP COLUMN "activities";

-- CreateTable
CREATE TABLE "AgentActivity" (
    "id" BIGSERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "byName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentActivity_sessionId_id_idx" ON "AgentActivity"("sessionId", "id");

-- CreateIndex
CREATE INDEX "IssueLink_inwardId_idx" ON "IssueLink"("inwardId");

-- AddForeignKey
ALTER TABLE "AgentActivity" ADD CONSTRAINT "AgentActivity_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
