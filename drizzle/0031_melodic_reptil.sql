CREATE TABLE "connection_grants" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"project_id" varchar(12) NOT NULL,
	"agent_id" varchar(12) NOT NULL,
	"environment_id" varchar(12),
	"provider" varchar(32) NOT NULL,
	"account_email" text,
	"scopes" text NOT NULL,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"refresh_token_ciphertext" text NOT NULL,
	"refresh_token_iv" text NOT NULL,
	"refresh_token_auth_tag" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connection_grants_scope_uq" UNIQUE NULLS NOT DISTINCT("project_id","agent_id","environment_id","provider")
);
--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connection_grants" ADD CONSTRAINT "connection_grants_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;