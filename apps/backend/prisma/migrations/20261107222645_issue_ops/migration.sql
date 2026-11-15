ALTER TABLE "Issue" ADD COLUMN "environment" TEXT;
CREATE TABLE "IssueVote" (
  "id" TEXT NOT NULL,
  "issueId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "IssueVote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "IssueVote_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "IssueVote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "IssueVote_issueId_userId_key" ON "IssueVote"("issueId", "userId");
CREATE INDEX "IssueVote_issueId_idx" ON "IssueVote"("issueId");
CREATE TABLE "RemoteIssueLink" (
  "id" TEXT NOT NULL,
  "issueId" TEXT NOT NULL,
  "globalId" TEXT,
  "url" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "summary" TEXT,
  "iconUrl" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RemoteIssueLink_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "RemoteIssueLink_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "RemoteIssueLink_issueId_idx" ON "RemoteIssueLink"("issueId");
