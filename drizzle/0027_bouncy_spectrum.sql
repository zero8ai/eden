-- Existing duplicate in-flight rows are exactly the residue of the race this index closes (#31):
-- keep the newest pending/building row per environment and fail the stragglers, so the unique
-- index can be created on databases that already carry stranded duplicates.
UPDATE "deployments" d
SET "status" = 'failed',
    "error_detail" = 'superseded by a concurrent provision (duplicate in-flight row, see #31)',
    "updated_at" = now()
WHERE d."status" in ('pending', 'building')
  AND d."id" <> (
    SELECT k."id" FROM "deployments" k
    WHERE k."environment_id" = d."environment_id"
      AND k."status" in ('pending', 'building')
    ORDER BY k."created_at" DESC, k."id" DESC
    LIMIT 1
  );--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_env_inflight_uq" ON "deployments" USING btree ("environment_id") WHERE "deployments"."status" in ('pending', 'building');
