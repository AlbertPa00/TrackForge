
-- AlterTable

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "projectKeys" TEXT[],
    "stage" TEXT NOT NULL DEFAULT 'discovering',
    "stageData" JSONB,
    "report" JSONB,
    "error" TEXT,
    "actorId" TEXT NOT NULL,
    "dryRun" BOOLEAN NOT NULL DEFAULT false,
    "lastRunAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalIdMap" (
    "id" TEXT NOT NULL,
    "importJobId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "internalId" TEXT NOT NULL,

    CONSTRAINT "ExternalIdMap_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportJob_stage_idx" ON "ImportJob"("stage");

-- CreateIndex
CREATE INDEX "ExternalIdMap_importJobId_entityType_idx" ON "ExternalIdMap"("importJobId", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalIdMap_importJobId_entityType_externalId_key" ON "ExternalIdMap"("importJobId", "entityType", "externalId");

-- AddForeignKey
ALTER TABLE "ImportJob" ADD CONSTRAINT "ImportJob_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalIdMap" ADD CONSTRAINT "ExternalIdMap_importJobId_fkey" FOREIGN KEY ("importJobId") REFERENCES "ImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

