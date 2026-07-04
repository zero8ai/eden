-- Single-live cutover (M6, PRD §7.7 revision): the product model is now ONE live version per
-- environment. Forward deploys used to leave prior releases' deployments live side by side
-- (the weighted-splitter primitive), so environments accumulated multiple live rows. Keep the
-- most recently created live deployment per environment (ties: highest traffic weight) at
-- weight 100 and demote the rest to stopped/0 — the same outcome deploying wins by today.
-- Demoted rows' containers (if any) receive no traffic once the row leaves `live`; they are
-- reaped by the deploy target on its next stop/redeploy, not by this data-only migration.
WITH ranked AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "environment_id"
      ORDER BY "created_at" DESC, "traffic_weight" DESC
    ) AS rn
  FROM "deployments"
  WHERE "status" = 'live'
)
UPDATE "deployments" d
SET
  "status" = CASE WHEN r.rn = 1 THEN 'live' ELSE 'stopped' END,
  "traffic_weight" = CASE WHEN r.rn = 1 THEN 100 ELSE 0 END,
  "updated_at" = now()
FROM ranked r
WHERE d."id" = r."id";
