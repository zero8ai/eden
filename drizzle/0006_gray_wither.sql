CREATE TABLE "workspace_tasks" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"kind" text NOT NULL,
	"subject_key" text NOT NULL,
	"label" text NOT NULL,
	"stage" text,
	"status" text DEFAULT 'running' NOT NULL,
	"origin_url" text NOT NULL,
	"result_url" text,
	"error" text,
	"job_id" varchar(12),
	"dismissed_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_tasks" ADD CONSTRAINT "workspace_tasks_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workspace_tasks_project_status_idx" ON "workspace_tasks" USING btree ("project_id","status");