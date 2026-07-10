CREATE TABLE "discord_connections" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"project_id" varchar(12) NOT NULL,
	"agent_id" varchar(12) NOT NULL,
	"environment_id" varchar(12) NOT NULL,
	"guild_id" text NOT NULL,
	"guild_name" text,
	"command_name" text NOT NULL,
	"command_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "discord_connections" ADD CONSTRAINT "discord_connections_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_connections" ADD CONSTRAINT "discord_connections_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discord_connections" ADD CONSTRAINT "discord_connections_environment_id_environments_id_fk" FOREIGN KEY ("environment_id") REFERENCES "public"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "discord_connections_guild_command_uq" ON "discord_connections" USING btree ("guild_id","command_name");