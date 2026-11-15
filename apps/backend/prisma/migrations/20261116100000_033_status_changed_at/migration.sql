-- 033 US3: Issue.statusChangedAt — board days-in-column indicator.
ALTER TABLE "Issue" ADD COLUMN "statusChangedAt" TIMESTAMP(3);
-- Backfill: latest 'status' change-item wins; issues never transitioned get createdAt.
UPDATE "Issue" i SET "statusChangedAt" = COALESCE(
  (SELECT MAX(h."createdAt") FROM "ChangeHistory" h
    JOIN "ChangeItem" ci ON ci."historyId" = h."id"
    WHERE h."issueId" = i."id" AND ci."field" = 'status'),
  i."createdAt"
);
