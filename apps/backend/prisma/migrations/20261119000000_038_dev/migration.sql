CREATE TABLE "DevRepository" (
    "id" TEXT NOT NULL, "name" TEXT NOT NULL, "provider" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL, "webhookSecret" TEXT NOT NULL,
    "projectKeyMap" JSONB NOT NULL DEFAULT '{}', "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DevRepository_pkey" PRIMARY KEY ("id"));
CREATE TABLE "DevelopmentItem" (
    "id" TEXT NOT NULL, "repoId" TEXT NOT NULL, "type" TEXT NOT NULL,
    "externalId" TEXT NOT NULL, "title" TEXT NOT NULL, "url" TEXT,
    "authorName" TEXT, "authorEmail" TEXT, "state" TEXT NOT NULL DEFAULT '',
    "payload" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "DevelopmentItem_pkey" PRIMARY KEY ("id"));
CREATE TABLE "DevelopmentItemIssue" (
    "itemId" TEXT NOT NULL, "issueId" TEXT NOT NULL,
    CONSTRAINT "DevelopmentItemIssue_pkey" PRIMARY KEY ("itemId", "issueId"));
CREATE TABLE "DevDelivery" (
    "id" TEXT NOT NULL, "repoId" TEXT NOT NULL, "deliveryId" TEXT NOT NULL,
    "status" TEXT NOT NULL, "error" TEXT, "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DevDelivery_pkey" PRIMARY KEY ("id"));
CREATE UNIQUE INDEX "DevelopmentItem_repoId_type_externalId_key" ON "DevelopmentItem"("repoId","type","externalId");
CREATE INDEX "DevelopmentItem_repoId_idx" ON "DevelopmentItem"("repoId");
CREATE INDEX "DevelopmentItemIssue_issueId_idx" ON "DevelopmentItemIssue"("issueId");
CREATE UNIQUE INDEX "DevDelivery_repoId_deliveryId_key" ON "DevDelivery"("repoId","deliveryId");
ALTER TABLE "DevelopmentItem" ADD CONSTRAINT "DevelopmentItem_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "DevRepository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DevelopmentItemIssue" ADD CONSTRAINT "DevelopmentItemIssue_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "DevelopmentItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DevelopmentItemIssue" ADD CONSTRAINT "DevelopmentItemIssue_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DevDelivery" ADD CONSTRAINT "DevDelivery_repoId_fkey" FOREIGN KEY ("repoId") REFERENCES "DevRepository"("id") ON DELETE CASCADE ON UPDATE CASCADE;
