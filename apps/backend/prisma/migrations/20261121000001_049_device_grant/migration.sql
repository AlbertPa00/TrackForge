-- Sprint 049: RFC 8628 device authorization grant

CREATE TABLE "OAuthDeviceCode" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "userCode" TEXT NOT NULL,
    "clientDbId" TEXT NOT NULL,
    "scopes" TEXT[],
    "projectKeys" TEXT[],
    "userId" TEXT,
    "deniedAt" TIMESTAMP(3),
    "lastPollAt" TIMESTAMP(3),
    "intervalSec" INTEGER NOT NULL DEFAULT 5,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthDeviceCode_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OAuthDeviceCode_hash_key" ON "OAuthDeviceCode"("hash");
CREATE UNIQUE INDEX "OAuthDeviceCode_userCode_key" ON "OAuthDeviceCode"("userCode");
