-- Sprint 021 — project categories + archive.
CREATE TABLE "ProjectCategory" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  CONSTRAINT "ProjectCategory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProjectCategory_name_key" ON "ProjectCategory"("name");

ALTER TABLE "Project" ADD COLUMN "categoryId" TEXT;
ALTER TABLE "Project" ADD COLUMN "archived" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Project" ADD CONSTRAINT "Project_categoryId_fkey"
  FOREIGN KEY ("categoryId") REFERENCES "ProjectCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Project_archived_idx" ON "Project"("archived");
