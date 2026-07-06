CREATE TABLE "assistant_checkouts" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"conversation_id" varchar(12) NOT NULL,
	"project_id" varchar(12) NOT NULL,
	"branch" text NOT NULL,
	"base_branch" text NOT NULL,
	"pr_number" integer,
	"pr_draft" boolean DEFAULT true NOT NULL,
	"last_synced_hash" text,
	"warnings" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_checkouts" ADD CONSTRAINT "assistant_checkouts_conversation_id_playground_sessions_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."playground_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_checkouts" ADD CONSTRAINT "assistant_checkouts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_checkouts_conversation_uq" ON "assistant_checkouts" USING btree ("conversation_id");