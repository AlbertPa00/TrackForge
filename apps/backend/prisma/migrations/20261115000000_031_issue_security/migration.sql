-- AlterTable
ALTER TABLE "Issue" ADD COLUMN     "securityLevelId" TEXT;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "issueSecuritySchemeId" TEXT;

-- CreateTable
CREATE TABLE "IssueSecurityScheme" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IssueSecurityScheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityLevel" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "SecurityLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SecurityLevelMember" (
    "id" TEXT NOT NULL,
    "levelId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ref" TEXT,

    CONSTRAINT "SecurityLevelMember_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecurityLevel_schemeId_idx" ON "SecurityLevel"("schemeId");

-- CreateIndex
CREATE INDEX "SecurityLevelMember_levelId_idx" ON "SecurityLevelMember"("levelId");

-- CreateIndex
CREATE INDEX "Issue_securityLevelId_idx" ON "Issue"("securityLevelId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_issueSecuritySchemeId_fkey" FOREIGN KEY ("issueSecuritySchemeId") REFERENCES "IssueSecurityScheme"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_securityLevelId_fkey" FOREIGN KEY ("securityLevelId") REFERENCES "SecurityLevel"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityLevel" ADD CONSTRAINT "SecurityLevel_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "IssueSecurityScheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SecurityLevelMember" ADD CONSTRAINT "SecurityLevelMember_levelId_fkey" FOREIGN KEY ("levelId") REFERENCES "SecurityLevel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
