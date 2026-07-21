CREATE TABLE "chat_portals" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"project_id" varchar(12) NOT NULL,
	"agent_id" varchar(12) NOT NULL,
	"slug" varchar(32) NOT NULL,
	"name" text NOT NULL,
	"access_mode" text DEFAULT 'invite' NOT NULL,
	"model_id" text,
	"effort" text,
	"turns_per_hour" integer DEFAULT 20 NOT NULL,
	"monthly_turn_cap" integer,
	"disabled_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_grants" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"portal_id" varchar(12) NOT NULL,
	"email" text NOT NULL,
	"invited_by" text,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portal_turns" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"portal_id" varchar(12) NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "playground_sessions" ADD COLUMN "portal_id" varchar(12);--> statement-breakpoint
ALTER TABLE "chat_portals" ADD CONSTRAINT "chat_portals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_portals" ADD CONSTRAINT "chat_portals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_portals" ADD CONSTRAINT "chat_portals_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_grants" ADD CONSTRAINT "portal_grants_portal_id_chat_portals_id_fk" FOREIGN KEY ("portal_id") REFERENCES "public"."chat_portals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_grants" ADD CONSTRAINT "portal_grants_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_turns" ADD CONSTRAINT "portal_turns_portal_id_chat_portals_id_fk" FOREIGN KEY ("portal_id") REFERENCES "public"."chat_portals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "portal_turns" ADD CONSTRAINT "portal_turns_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "chat_portals_slug_uq" ON "chat_portals" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "chat_portals_project_idx" ON "chat_portals" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portal_grants_portal_email_uq" ON "portal_grants" USING btree ("portal_id","email");--> statement-breakpoint
CREATE INDEX "portal_grants_email_idx" ON "portal_grants" USING btree ("email");--> statement-breakpoint
CREATE INDEX "portal_turns_portal_user_at_idx" ON "portal_turns" USING btree ("portal_id","user_id","created_at");--> statement-breakpoint
ALTER TABLE "playground_sessions" ADD CONSTRAINT "playground_sessions_portal_id_chat_portals_id_fk" FOREIGN KEY ("portal_id") REFERENCES "public"."chat_portals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "playground_sessions_portal_idx" ON "playground_sessions" USING btree ("portal_id","updated_at");