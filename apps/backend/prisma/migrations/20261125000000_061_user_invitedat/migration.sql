-- 061 US2 — pending-invite marker. Set when an invite is (re-)issued,
-- cleared by confirmInvite. Guards re-invite to never-activated accounts
-- and stops invite-accept from re-activating deactivated users.
ALTER TABLE "User"
  ADD COLUMN "invitedAt" TIMESTAMP(3);
