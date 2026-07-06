CREATE TABLE "agent_links" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"project_id" varchar(12) NOT NULL,
	"from_agent_id" varchar(12) NOT NULL,
	"to_agent_id" varchar(12) NOT NULL,
	"enabled" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "delegations" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"project_id" varchar(12) NOT NULL,
	"from_agent_id" varchar(12),
	"from_environment_id" varchar(12),
	"to_agent_id" varchar(12),
	"to_environment_id" varchar(12),
	"external_session_id" text,
	"run_id" varchar(12),
	"status" text DEFAULT 'running' NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "agent_links" ADD CONSTRAINT "agent_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_links" ADD CONSTRAINT "agent_links_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_links" ADD CONSTRAINT "agent_links_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_from_agent_id_agents_id_fk" FOREIGN KEY ("from_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "delegations" ADD CONSTRAINT "delegations_to_agent_id_agents_id_fk" FOREIGN KEY ("to_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_links_pair_uq" ON "agent_links" USING btree ("from_agent_id","to_agent_id");--> statement-breakpoint
CREATE INDEX "delegations_project_started_idx" ON "delegations" USING btree ("project_id","created_at");