-- Sprint 013 — Scrum completion: board-scoped sprints, membership history, story points.

-- 1. New columns (boardId nullable until backfilled).
ALTER TABLE "Issue" ADD COLUMN "storyPoints" DOUBLE PRECISION;
ALTER TABLE "Sprint"
  ADD COLUMN "boardId" TEXT,
  ADD COLUMN "completeDate" TIMESTAMP(3),
  ADD COLUMN "sequence" INTEGER NOT NULL DEFAULT 0;

-- 2. Any sprint-owning project without a board gets a minimal kanban board
-- (columns are created empty; settings can map statuses afterwards).
INSERT INTO "Board" ("id", "name", "type", "projectId", "createdAt")
SELECT gen_random_uuid()::text, p."name" || ' board', 'kanban', p."id", CURRENT_TIMESTAMP
FROM "Project" p
WHERE EXISTS (SELECT 1 FROM "Sprint" s WHERE s."projectId" = p."id")
  AND NOT EXISTS (SELECT 1 FROM "Board" b WHERE b."projectId" = p."id");

-- 3. Re-parent sprints: boardId = the owning project's board.
UPDATE "Sprint" s
SET "boardId" = b."id"
FROM "Board" b
WHERE b."projectId" = s."projectId";

-- 4. Per-board sprint sequence (creation order) for default naming.
WITH numbered AS (
  SELECT "id", ROW_NUMBER() OVER (PARTITION BY "boardId" ORDER BY "createdAt", "name") AS n
  FROM "Sprint"
)
UPDATE "Sprint" s SET "sequence" = numbered.n FROM numbered WHERE s."id" = numbered."id";

-- 5. US3.1 — boards of projects that have ever had a sprint become scrum.
UPDATE "Board" b SET "type" = 'scrum'
WHERE EXISTS (SELECT 1 FROM "Sprint" s WHERE s."boardId" = b."id");

-- 6. Sprint membership history — backfill current memberships.
CREATE TABLE "IssueSprint" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "sprintId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "IssueSprint_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "IssueSprint_sprintId_removedAt_idx" ON "IssueSprint"("sprintId", "removedAt");
CREATE INDEX "IssueSprint_issueId_idx" ON "IssueSprint"("issueId");

INSERT INTO "IssueSprint" ("id", "issueId", "sprintId", "addedAt", "removedAt")
SELECT gen_random_uuid()::text, i."id", i."sprintId",
       i."updatedAt", NULL
FROM "Issue" i
WHERE i."sprintId" IS NOT NULL;

-- 7. Enforce boardId once backfilled.
ALTER TABLE "Sprint" ALTER COLUMN "boardId" SET NOT NULL;

-- 8. Indexes + FKs.
CREATE INDEX "Sprint_boardId_state_idx" ON "Sprint"("boardId", "state");
ALTER TABLE "Sprint" ADD CONSTRAINT "Sprint_boardId_fkey"
  FOREIGN KEY ("boardId") REFERENCES "Board"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "IssueSprint" ADD CONSTRAINT "IssueSprint_issueId_fkey"
  FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IssueSprint" ADD CONSTRAINT "IssueSprint_sprintId_fkey"
  FOREIGN KEY ("sprintId") REFERENCES "Sprint"("id") ON DELETE CASCADE ON UPDATE CASCADE;
