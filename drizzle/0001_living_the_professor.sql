CREATE TABLE "schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"deployment_id" uuid NOT NULL,
	"cron" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid,
	"key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secret_values_scope_key_uq" UNIQUE NULLS NOT DISTINCT("project_id","environment_id","key")
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" text NOT NULL,
	"deployment_id" uuid,
	"kind" text NOT NULL,
	"quantity" integer NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb
);
--> statement-breakpoint
DROP INDEX "secrets_scope_key_uq";--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_values" ADD CONSTRAINT "secret_values_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_values" ADD CONSTRAINT "secret_values_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedules_deployment_idx" ON "schedules" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "usage_events_org_at_idx" ON "usage_events" USING btree ("org_id","at");--> statement-breakpoint
ALTER TABLE "secrets_metadata" ADD CONSTRAINT "secrets_scope_key_uq" UNIQUE NULLS NOT DISTINCT("project_id","environment_id","key");