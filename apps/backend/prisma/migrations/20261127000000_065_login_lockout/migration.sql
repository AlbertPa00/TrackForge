-- 065 audit A5 — per-account lockout: failed-password counters + lock window.
ALTER TABLE "User"
  ADD COLUMN "loginFailures" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "loginLockedUntil" TIMESTAMP(3);
