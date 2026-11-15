ALTER TABLE "User" ADD COLUMN "locale" TEXT NOT NULL DEFAULT 'en_US',
    ADD COLUMN "dateFormat" TEXT NOT NULL DEFAULT 'd/MMM/yy',
    ADD COLUMN "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "totpSecret" TEXT,
    ADD COLUMN "totpEnabled" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "backupCodes" JSONB;

CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userAgent" TEXT,
    "ip" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "IdentityProvider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "issuer" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT,
    "scopes" TEXT NOT NULL DEFAULT 'openid email profile',
    "claimMap" JSONB NOT NULL DEFAULT '{}',
    "autoProvision" BOOLEAN NOT NULL DEFAULT true,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IdentityProvider_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OidcIdentity" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "idpId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OidcIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE UNIQUE INDEX "IdentityProvider_name_key" ON "IdentityProvider"("name");
CREATE UNIQUE INDEX "OidcIdentity_idpId_subject_key" ON "OidcIdentity"("idpId", "subject");
CREATE INDEX "OidcIdentity_userId_idx" ON "OidcIdentity"("userId");
CREATE UNIQUE INDEX "PasswordResetToken_hash_key" ON "PasswordResetToken"("hash");
CREATE INDEX "PasswordResetToken_userId_idx" ON "PasswordResetToken"("userId");

ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OidcIdentity" ADD CONSTRAINT "OidcIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OidcIdentity" ADD CONSTRAINT "OidcIdentity_idpId_fkey" FOREIGN KEY ("idpId") REFERENCES "IdentityProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "User" ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT false;
