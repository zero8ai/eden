CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"root" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "secret_values" DROP CONSTRAINT "secret_values_scope_key_uq";--> statement-breakpoint
ALTER TABLE "secrets_metadata" DROP CONSTRAINT "secrets_scope_key_uq";--> statement-breakpoint
DROP INDEX "environments_project_name_uq";--> statement-breakpoint
DROP INDEX "releases_project_version_uq";--> statement-breakpoint
ALTER TABLE "draft_changes" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "environments" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "secret_values" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "secrets_metadata" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "agent_id" uuid;--> statement-breakpoint
-- Backfill (Milestone 5.5): every existing project becomes a team of one — a single "agent"
-- member rooted at the conventional `agent/` directory — and every downstream row keys to it.
INSERT INTO "agents" ("project_id", "name", "root")
SELECT "id", 'agent', 'agent' FROM "projects";--> statement-breakpoint
UPDATE "draft_changes" t SET "agent_id" = a."id" FROM "agents" a WHERE a."project_id" = t."project_id";--> statement-breakpoint
UPDATE "environments" t SET "agent_id" = a."id" FROM "agents" a WHERE a."project_id" = t."project_id";--> statement-breakpoint
UPDATE "releases" t SET "agent_id" = a."id" FROM "agents" a WHERE a."project_id" = t."project_id";--> statement-breakpoint
UPDATE "runs" t SET "agent_id" = a."id" FROM "agents" a WHERE a."project_id" = t."project_id";--> statement-breakpoint
UPDATE "secret_values" t SET "agent_id" = a."id" FROM "agents" a WHERE a."project_id" = t."project_id";--> statement-breakpoint
UPDATE "secrets_metadata" t SET "agent_id" = a."id" FROM "agents" a WHERE a."project_id" = t."project_id";--> statement-breakpoint
UPDATE "sessions" t SET "agent_id" = a."id" FROM "agents" a WHERE a."project_id" = t."project_id";--> statement-breakpoint
ALTER TABLE "draft_changes" ALTER COLUMN "agent_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "environments" ALTER COLUMN "agent_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "releases" ALTER COLUMN "agent_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "secret_values" ALTER COLUMN "agent_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "secrets_metadata" ALTER COLUMN "agent_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_project_name_uq" ON "agents" USING btree ("project_id","name");--> statement-breakpoint
ALTER TABLE "draft_changes" ADD CONSTRAINT "draft_changes_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "environments" ADD CONSTRAINT "environments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_values" ADD CONSTRAINT "secret_values_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets_metadata" ADD CONSTRAINT "secrets_metadata_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "environments_agent_name_uq" ON "environments" USING btree ("agent_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "releases_agent_version_uq" ON "releases" USING btree ("agent_id","version");--> statement-breakpoint
CREATE INDEX "releases_agent_idx" ON "releases" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "runs_agent_started_idx" ON "runs" USING btree ("agent_id","started_at");--> statement-breakpoint
ALTER TABLE "secret_values" ADD CONSTRAINT "secret_values_agent_scope_key_uq" UNIQUE NULLS NOT DISTINCT("agent_id","environment_id","key");--> statement-breakpoint
ALTER TABLE "secrets_metadata" ADD CONSTRAINT "secrets_agent_scope_key_uq" UNIQUE NULLS NOT DISTINCT("agent_id","environment_id","key");
