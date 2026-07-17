CREATE TABLE "capability_calls" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"agent_id" varchar(12),
	"deployment_id" varchar(12),
	"provider" varchar(32) NOT NULL,
	"operation" text NOT NULL,
	"group_id" text,
	"outcome" varchar(16) NOT NULL,
	"error" text,
	"input_summary" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "connection_grants" ADD COLUMN "resource_id" text;--> statement-breakpoint
ALTER TABLE "connection_grants" ADD COLUMN "resource_name" text;--> statement-breakpoint
ALTER TABLE "capability_calls" ADD CONSTRAINT "capability_calls_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_calls" ADD CONSTRAINT "capability_calls_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "capability_calls_agent_created_idx" ON "capability_calls" USING btree ("agent_id","created_at");