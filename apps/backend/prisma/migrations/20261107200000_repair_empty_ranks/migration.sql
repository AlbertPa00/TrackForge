-- Repair issues whose rank is '' (produced before the rank-append fix):
-- give each a rank that sorts after the project's current max, ordered by
-- issueNumber. `max || 'i'…` keeps every project distinct and monotonic.
WITH m AS (
  SELECT "projectId", MAX(rank) AS mx
  FROM "Issue"
  WHERE rank <> ''
  GROUP BY "projectId"
),
r AS (
  SELECT id, "projectId",
         ROW_NUMBER() OVER (PARTITION BY "projectId" ORDER BY "issueNumber") AS rn
  FROM "Issue"
  WHERE rank = ''
)
UPDATE "Issue" i
SET rank = CONCAT(COALESCE(m.mx, ''), REPEAT('i', r.rn::int))
FROM r
LEFT JOIN m ON m."projectId" = r."projectId"
WHERE i.id = r.id;
