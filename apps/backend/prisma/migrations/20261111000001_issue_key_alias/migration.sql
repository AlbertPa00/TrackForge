CREATE TABLE "IssueKeyAlias" (
  "id" TEXT NOT NULL,
  "oldKey" TEXT NOT NULL,
  "issueId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IssueKeyAlias_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IssueKeyAlias_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "IssueKeyAlias_oldKey_key" ON "IssueKeyAlias"("oldKey");
CREATE UNIQUE INDEX "IssueKeyAlias_issueId_key" ON "IssueKeyAlias"("issueId");
