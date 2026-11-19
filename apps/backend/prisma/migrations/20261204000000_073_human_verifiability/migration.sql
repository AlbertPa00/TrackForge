-- 073 — human verifiability, inspectable receipt payloads, dossier comments, deliverable sign-off

-- Structured comment metadata for rich UI dossier & review cards
ALTER TABLE "Comment" ADD COLUMN "metadataJson" JSONB;

-- Track the consolidated Work Product Dossier comment emitted on session release
ALTER TABLE "AgentSession" ADD COLUMN "dossierCommentId" TEXT;

-- WorkReceipt file manifest + Attachment link + honest digest_only default
ALTER TABLE "WorkReceipt"
  ADD COLUMN "changedFiles" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  ADD COLUMN "attachmentId" TEXT,
  ADD COLUMN "contentType" TEXT,
  ALTER COLUMN "verification" SET DEFAULT 'digest_only';

UPDATE "WorkReceipt" SET "verification" = 'digest_only' WHERE "verification" = 'unverified';

CREATE INDEX "WorkReceipt_attachmentId_idx" ON "WorkReceipt"("attachmentId");
ALTER TABLE "WorkReceipt"
  ADD CONSTRAINT "WorkReceipt_attachmentId_fkey"
  FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Lazy-loaded inline receipt text (<= 64 KiB)
CREATE TABLE "WorkReceiptPayload" (
  "receiptId" TEXT NOT NULL,
  "contentText" TEXT NOT NULL,
  "byteLength" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WorkReceiptPayload_pkey" PRIMARY KEY ("receiptId")
);
ALTER TABLE "WorkReceiptPayload"
  ADD CONSTRAINT "WorkReceiptPayload_receiptId_fkey"
  FOREIGN KEY ("receiptId") REFERENCES "WorkReceipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- SHA-pinned deliverable acceptance sign-off
CREATE TABLE "DeliverableReview" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "issueId" TEXT NOT NULL,
  "sessionId" TEXT,
  "reviewerId" TEXT NOT NULL,
  "verdict" TEXT NOT NULL,
  "body" TEXT,
  "pinnedHeadSha" TEXT,
  "pinnedReceiptIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "commentId" TEXT,
  "supersededAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "DeliverableReview_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DeliverableReview_issueId_createdAt_idx" ON "DeliverableReview"("issueId", "createdAt" DESC);
CREATE INDEX "DeliverableReview_projectId_verdict_idx" ON "DeliverableReview"("projectId", "verdict");
ALTER TABLE "DeliverableReview"
  ADD CONSTRAINT "DeliverableReview_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeliverableReview"
  ADD CONSTRAINT "DeliverableReview_issueId_fkey"
  FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeliverableReview"
  ADD CONSTRAINT "DeliverableReview_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "DeliverableReview"
  ADD CONSTRAINT "DeliverableReview_reviewerId_fkey"
  FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
