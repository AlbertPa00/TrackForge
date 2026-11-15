-- Sprint 049 Track A: directory integration (SCIM + LDAP connections)

CREATE TABLE "DirectoryConnection" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secretRef" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncAt" TIMESTAMP(3),
    "syncStatus" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DirectoryConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExternalIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "directoryConnectionId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ScimToken" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScimToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExternalIdentity_provider_directoryConnectionId_externalId_key" ON "ExternalIdentity"("provider", "directoryConnectionId", "externalId");
CREATE INDEX "ExternalIdentity_userId_idx" ON "ExternalIdentity"("userId");
CREATE UNIQUE INDEX "ScimToken_hash_key" ON "ScimToken"("hash");

ALTER TABLE "ExternalIdentity" ADD CONSTRAINT "ExternalIdentity_directoryConnectionId_fkey" FOREIGN KEY ("directoryConnectionId") REFERENCES "DirectoryConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ScimToken" ADD CONSTRAINT "ScimToken_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "DirectoryConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
