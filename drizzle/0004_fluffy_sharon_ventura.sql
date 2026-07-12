CREATE TABLE "run_reconcile_cursors" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"project_id" varchar(12) NOT NULL,
	"external_session_id" text NOT NULL,
	"stream_index" integer DEFAULT 0 NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb,
	"last_activity_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_reconcile_cursors_session_uq" UNIQUE("project_id","external_session_id")
);
--> statement-breakpoint
ALTER TABLE "run_reconcile_cursors" ADD CONSTRAINT "run_reconcile_cursors_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;