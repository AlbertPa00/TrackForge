-- 065 audit F4 — two-step confirm tokens become single-use + expiring.
-- Raw tokens are shown once in the dryRun preview; only sha256 is stored and
-- consumption is an atomic usedAt claim (replay-safe, race-safe).
CREATE TABLE "ConfirmToken" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfirmToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConfirmToken_tokenHash_key" ON "ConfirmToken"("tokenHash");
CREATE INDEX "ConfirmToken_expiresAt_idx" ON "ConfirmToken"("expiresAt");
