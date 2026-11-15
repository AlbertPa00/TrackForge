-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "notificationSchemeId" TEXT;

-- CreateTable
CREATE TABLE "NotificationScheme" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NotificationScheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationSchemeEntry" (
    "id" TEXT NOT NULL,
    "schemeId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "recipientKind" TEXT NOT NULL,
    "recipientRef" TEXT,

    CONSTRAINT "NotificationSchemeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EmailOutbox" (
    "id" TEXT NOT NULL,
    "toUserId" TEXT,
    "toEmail" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "eventId" BIGINT,
    "eventType" TEXT,
    "issueKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "EmailOutbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FilterSubscription" (
    "id" TEXT NOT NULL,
    "filterId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "frequency" TEXT NOT NULL,
    "dayOfWeek" INTEGER,
    "hour" INTEGER NOT NULL DEFAULT 9,
    "unsubscribeToken" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FilterSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "NotificationSchemeEntry_schemeId_event_idx" ON "NotificationSchemeEntry"("schemeId", "event");

-- CreateIndex
CREATE INDEX "EmailOutbox_status_createdAt_idx" ON "EmailOutbox"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FilterSubscription_unsubscribeToken_key" ON "FilterSubscription"("unsubscribeToken");

-- CreateIndex
CREATE INDEX "FilterSubscription_userId_idx" ON "FilterSubscription"("userId");

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_notificationSchemeId_fkey" FOREIGN KEY ("notificationSchemeId") REFERENCES "NotificationScheme"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NotificationSchemeEntry" ADD CONSTRAINT "NotificationSchemeEntry_schemeId_fkey" FOREIGN KEY ("schemeId") REFERENCES "NotificationScheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EmailOutbox" ADD CONSTRAINT "EmailOutbox_toUserId_fkey" FOREIGN KEY ("toUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilterSubscription" ADD CONSTRAINT "FilterSubscription_filterId_fkey" FOREIGN KEY ("filterId") REFERENCES "Filter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FilterSubscription" ADD CONSTRAINT "FilterSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
