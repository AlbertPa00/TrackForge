-- Sprint 049: OAuth 2.1 authorization server (Track B)

CREATE TABLE "OAuthClient" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecretHash" TEXT,
    "name" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "grantTypes" TEXT[],
    "allowedScopes" TEXT[],
    "allowedProjectKeys" TEXT[],
    "serviceUserId" TEXT,
    "metadataDocumentUrl" TEXT,
    "registrationType" TEXT NOT NULL DEFAULT 'pre-registered',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthClient_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OAuthAuthorizationCode" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "clientDbId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "scopes" TEXT[],
    "projectKeys" TEXT[],
    "codeChallenge" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthAuthorizationCode_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OAuthGrant" (
    "id" TEXT NOT NULL,
    "clientDbId" TEXT NOT NULL,
    "userId" TEXT,
    "scopes" TEXT[],
    "projectKeys" TEXT[],
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthGrant_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OAuthRefreshToken" (
    "id" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "rotatedToId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "reuseDetected" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OAuthRefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OAuthClient_clientId_key" ON "OAuthClient"("clientId");
CREATE UNIQUE INDEX "OAuthAuthorizationCode_hash_key" ON "OAuthAuthorizationCode"("hash");
CREATE INDEX "OAuthGrant_clientDbId_userId_idx" ON "OAuthGrant"("clientDbId", "userId");
CREATE UNIQUE INDEX "OAuthRefreshToken_hash_key" ON "OAuthRefreshToken"("hash");

ALTER TABLE "OAuthAuthorizationCode" ADD CONSTRAINT "OAuthAuthorizationCode_clientDbId_fkey" FOREIGN KEY ("clientDbId") REFERENCES "OAuthClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OAuthGrant" ADD CONSTRAINT "OAuthGrant_clientDbId_fkey" FOREIGN KEY ("clientDbId") REFERENCES "OAuthClient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "OAuthRefreshToken" ADD CONSTRAINT "OAuthRefreshToken_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "OAuthGrant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
