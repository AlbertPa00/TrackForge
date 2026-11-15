-- 032 US4: Filter.sharedScope/sharedTarget → FilterSharePermission rows
CREATE TABLE "FilterSharePermission" (
  "id"       TEXT NOT NULL,
  "filterId" TEXT NOT NULL,
  "type"     TEXT NOT NULL,
  "target"   TEXT,
  "target2"  TEXT,
  CONSTRAINT "FilterSharePermission_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "FilterSharePermission_filterId_idx" ON "FilterSharePermission"("filterId");
ALTER TABLE "FilterSharePermission"
  ADD CONSTRAINT "FilterSharePermission_filterId_fkey"
  FOREIGN KEY ("filterId") REFERENCES "Filter"("id") ON DELETE CASCADE;

-- backfill: scope → perm rows (project/projectrole resolve keys/names to ids)
INSERT INTO "FilterSharePermission" ("id","filterId","type","target","target2")
SELECT gen_random_uuid()::text, f."id", 'global', NULL, NULL FROM "Filter" f WHERE f."sharedScope" = 'all';
INSERT INTO "FilterSharePermission" ("id","filterId","type","target","target2")
SELECT gen_random_uuid()::text, f."id", 'group', f."sharedTarget", NULL FROM "Filter" f WHERE f."sharedScope" = 'group';
INSERT INTO "FilterSharePermission" ("id","filterId","type","target","target2")
SELECT gen_random_uuid()::text, f."id", 'project', p."id", NULL
FROM "Filter" f JOIN "Project" p ON upper(p."key") = upper(f."sharedTarget") WHERE f."sharedScope" = 'project';
INSERT INTO "FilterSharePermission" ("id","filterId","type","target","target2")
SELECT gen_random_uuid()::text, f."id", 'projectrole', r."id", p."id"
FROM "Filter" f
JOIN "Project" p ON upper(p."key") = upper(split_part(f."sharedTarget", ':', 1))
JOIN "ProjectRole" r ON lower(r."name") = lower(split_part(f."sharedTarget", ':', 2))
WHERE f."sharedScope" = 'projectrole';

ALTER TABLE "Filter" DROP COLUMN "sharedScope", DROP COLUMN "sharedTarget";
