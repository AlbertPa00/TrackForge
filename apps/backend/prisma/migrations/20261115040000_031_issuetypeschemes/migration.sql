-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "issueTypeSchemeId" TEXT;

-- CreateTable
CREATE TABLE "IssueTypeScheme" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "IssueTypeScheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssueTypeSchemeItem" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "issueTypeId" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "IssueTypeSchemeItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "IssueTypeScheme_name_key" ON "IssueTypeScheme"("name");

-- CreateIndex
CREATE UNIQUE INDEX "IssueTypeSchemeItem_schemeId_issueTypeId_key" ON "IssueTypeSchemeItem"("schemeId", "issueTypeId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_issueTypeSchemeId_fkey" FOREIGN KEY ("issueTypeSchemeId") REFERENCES "IssueTypeScheme"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueTypeSchemeItem" ADD CONSTRAINT "IssueTypeSchemeItem_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "IssueTypeScheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueTypeSchemeItem" ADD CONSTRAINT "IssueTypeSchemeItem_issueTypeId_fkey" FOREIGN KEY ("issueTypeId") REFERENCES "IssueType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
