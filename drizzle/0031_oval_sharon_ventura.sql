ALTER TABLE "projects" ADD COLUMN "layout" text DEFAULT 'single' NOT NULL;
UPDATE "projects"
SET "layout" = 'team'
WHERE EXISTS (
  SELECT 1 FROM "agents"
  WHERE "agents"."project_id" = "projects"."id"
    AND "agents"."kind" = 'member'
    AND "agents"."root" LIKE 'agents/%'
);
