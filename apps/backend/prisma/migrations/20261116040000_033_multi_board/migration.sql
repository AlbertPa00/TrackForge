-- 033: boards become N:1 per project (doc said 009 did this — it didn't;
-- projectId was still @unique). Adds isDefault/saved-filter/card-config/
-- creator + BoardQuickFilter.

DROP INDEX IF EXISTS "Board_projectId_key";
ALTER TABLE "Board"
  ADD COLUMN "isDefault" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "filterId" TEXT,
  ADD COLUMN "cardConfig" JSONB,
  ADD COLUMN "createdBy" TEXT;
ALTER TABLE "Board"
  ADD CONSTRAINT "Board_filterId_fkey" FOREIGN KEY ("filterId") REFERENCES "Filter"("id") ON DELETE SET NULL,
  ADD CONSTRAINT "Board_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User"("id") ON DELETE SET NULL;
CREATE INDEX "Board_projectId_isDefault_idx" ON "Board"("projectId", "isDefault");

-- exactly one default per project: the earliest board
UPDATE "Board" b SET "isDefault" = true
WHERE b."id" = (
  SELECT b2."id" FROM "Board" b2 WHERE b2."projectId" = b."projectId"
  ORDER BY b2."createdAt" ASC, b2."id" ASC LIMIT 1
);

CREATE TABLE "BoardQuickFilter" (
  "id"       TEXT NOT NULL,
  "boardId"  TEXT NOT NULL,
  "name"     TEXT NOT NULL,
  "jql"      TEXT NOT NULL,
  "position" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "BoardQuickFilter_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BoardQuickFilter_boardId_idx" ON "BoardQuickFilter"("boardId");
ALTER TABLE "BoardQuickFilter"
  ADD CONSTRAINT "BoardQuickFilter_boardId_fkey"
  FOREIGN KEY ("boardId") REFERENCES "Board"("id") ON DELETE CASCADE;
