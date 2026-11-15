-- Sprint 031: denormalized effective security level (own ?? parent's) so the
-- visibility predicate stays join-free at the query layer.
ALTER TABLE "Issue" ADD COLUMN "effSecurityLevelId" TEXT;

UPDATE "Issue" c SET "effSecurityLevelId" = COALESCE(
  c."securityLevelId",
  (SELECT p."securityLevelId" FROM "Issue" p WHERE p."id" = c."parentId")
);

ALTER TABLE "Issue" ADD CONSTRAINT "Issue_effSecurityLevelId_fkey"
  FOREIGN KEY ("effSecurityLevelId") REFERENCES "SecurityLevel"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Issue_effSecurityLevelId_idx" ON "Issue"("effSecurityLevelId");
