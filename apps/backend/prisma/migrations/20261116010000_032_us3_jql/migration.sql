-- 032 US3 — denormalized vote/watch counts for JQL `votes`/`watches`,
-- filter share scope/target for `filter = "name"` share-aware subqueries.
ALTER TABLE "Issue" ADD COLUMN "voteCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Issue" ADD COLUMN "watcherCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Filter" ADD COLUMN "sharedScope" TEXT NOT NULL DEFAULT 'private';
ALTER TABLE "Filter" ADD COLUMN "sharedTarget" TEXT;

UPDATE "Issue" i SET "voteCount" = c.cnt
FROM (SELECT "issueId", COUNT(*)::int AS cnt FROM "IssueVote" GROUP BY "issueId") c
WHERE c."issueId" = i.id;

UPDATE "Issue" i SET "watcherCount" = c.cnt
FROM (SELECT "issueId", COUNT(*)::int AS cnt FROM "Watcher" GROUP BY "issueId") c
WHERE c."issueId" = i.id;

-- visibility='all' filters are public shares.
UPDATE "Filter" SET "sharedScope" = 'all' WHERE "visibility" = 'all';
