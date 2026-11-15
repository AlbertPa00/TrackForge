-- 060 US7 — Jira DC issue archiving.
ALTER TABLE "Issue"
  ADD COLUMN "archived"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "archivedAt"   TIMESTAMP(3),
  ADD COLUMN "archivedById" TEXT;

CREATE INDEX "Issue_archived_idx" ON "Issue"("archived");
