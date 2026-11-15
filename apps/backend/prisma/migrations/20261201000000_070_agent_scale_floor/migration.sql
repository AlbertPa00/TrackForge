-- 070 — fleet scale floor:
--  1. AgentSession.activities (Json) -> append-only AgentActivity rows.
--     The JSONB column was a read-modify-write on every emit: O(n^2) bytes
--     over a session's life and a lost-update race between concurrent emits.
--  2. IssueLink.inwardId index — ready()/claim anti-joins filter on it.

CREATE TABLE "AgentActivity" (
    "id" BIGSERIAL NOT NULL,
    "sessionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "byName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentActivity_pkey" PRIMARY KEY ("id")
);

-- Backfill preserves array order: WITH ORDINALITY drives insertion order,
-- which is the BigInt id order readers sort by.
INSERT INTO "AgentActivity" ("sessionId", "type", "text", "byName", "createdAt")
SELECT s.id,
       COALESCE(a.item->>'type', 'action'),
       COALESCE(a.item->>'text', ''),
       COALESCE(a.item->>'by', ''),
       COALESCE((a.item->>'at')::timestamptz, CURRENT_TIMESTAMP)
FROM "AgentSession" s
CROSS JOIN LATERAL jsonb_array_elements(s."activities") WITH ORDINALITY AS a(item, n)
ORDER BY s.id, a.n;

CREATE INDEX "AgentActivity_sessionId_id_idx" ON "AgentActivity"("sessionId", "id");

ALTER TABLE "AgentActivity"
    ADD CONSTRAINT "AgentActivity_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "AgentSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AgentSession" DROP COLUMN "activities";

CREATE INDEX "IssueLink_inwardId_idx" ON "IssueLink"("inwardId");
