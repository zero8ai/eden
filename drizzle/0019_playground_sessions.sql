CREATE TABLE "playground_sessions" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"project_id" varchar(12) NOT NULL,
	"agent_id" varchar(12) NOT NULL,
	"environment_id" varchar(12),
	"world_key" text,
	"created_by" text NOT NULL,
	"external_session_id" text,
	"continuation_token" text,
	"stream_index" integer DEFAULT 0 NOT NULL,
	"title" text,
	"status" text DEFAULT 'new' NOT NULL,
	"last_deployment_id" varchar(12),
	"last_release_id" varchar(12),
	"last_version" text,
	"last_event_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playground_sessions" ADD CONSTRAINT "playground_sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "playground_sessions" ADD CONSTRAINT "playground_sessions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "playground_sessions" ADD CONSTRAINT "playground_sessions_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "playground_sessions" ADD CONSTRAINT "playground_sessions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "playground_sessions" ADD CONSTRAINT "playground_sessions_last_deployment_id_deployments_id_fk" FOREIGN KEY ("last_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "playground_sessions" ADD CONSTRAINT "playground_sessions_last_release_id_releases_id_fk" FOREIGN KEY ("last_release_id") REFERENCES "public"."releases"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "playground_sessions_scope_updated_idx" ON "playground_sessions" USING btree ("project_id","agent_id","created_by","updated_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "playground_sessions_external_uq" ON "playground_sessions" USING btree ("project_id","external_session_id");
