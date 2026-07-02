CREATE TABLE "ingest_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "ingest_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "run_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"type" text NOT NULL,
	"model" text,
	"tool_name" text,
	"tokens_input" integer,
	"tokens_output" integer,
	"duration_ms" integer,
	"is_error" boolean DEFAULT false NOT NULL,
	"approval_gated" boolean DEFAULT false NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb,
	"started_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"external_session_id" text,
	"trigger" text,
	"channel" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_external_uq" UNIQUE NULLS NOT DISTINCT("project_id","external_session_id")
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "session_id" uuid;--> statement-breakpoint
ALTER TABLE "ingest_tokens" ADD CONSTRAINT "ingest_tokens_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_steps" ADD CONSTRAINT "run_steps_run_id_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ingest_tokens_project_idx" ON "ingest_tokens" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "run_steps_run_seq_idx" ON "run_steps" USING btree ("run_id","seq");--> statement-breakpoint
CREATE INDEX "sessions_project_started_idx" ON "sessions" USING btree ("project_id","started_at");