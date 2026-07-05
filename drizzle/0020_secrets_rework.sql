CREATE TABLE "pending_secrets" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"project_id" varchar(12) NOT NULL,
	"member_name" text NOT NULL,
	"key" text NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"fingerprint" text,
	"sandbox_exposed" boolean DEFAULT false NOT NULL,
	"attach_shared" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_attachments" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"project_id" varchar(12) NOT NULL,
	"agent_id" varchar(12) NOT NULL,
	"key" text NOT NULL,
	"sandbox_exposed" boolean DEFAULT false NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "secret_requirement_dismissals" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"project_id" varchar(12) NOT NULL,
	"agent_id" varchar(12) NOT NULL,
	"key" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "secret_values" DROP CONSTRAINT "secret_values_agent_scope_key_uq";--> statement-breakpoint
ALTER TABLE "secrets_metadata" DROP CONSTRAINT "secrets_agent_scope_key_uq";--> statement-breakpoint
ALTER TABLE "secret_values" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "secrets_metadata" ALTER COLUMN "agent_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "secrets_metadata" ADD COLUMN "fingerprint" text;--> statement-breakpoint
ALTER TABLE "pending_secrets" ADD CONSTRAINT "pending_secrets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pending_secrets" ADD CONSTRAINT "pending_secrets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_attachments" ADD CONSTRAINT "secret_attachments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_attachments" ADD CONSTRAINT "secret_attachments_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_attachments" ADD CONSTRAINT "secret_attachments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_requirement_dismissals" ADD CONSTRAINT "secret_requirement_dismissals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_requirement_dismissals" ADD CONSTRAINT "secret_requirement_dismissals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secret_requirement_dismissals" ADD CONSTRAINT "secret_requirement_dismissals_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "pending_secrets_scope_key_uq" ON "pending_secrets" USING btree ("project_id","member_name","key");--> statement-breakpoint
CREATE UNIQUE INDEX "secret_attachments_agent_key_uq" ON "secret_attachments" USING btree ("agent_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "secret_req_dismissals_agent_key_uq" ON "secret_requirement_dismissals" USING btree ("agent_id","key");--> statement-breakpoint
ALTER TABLE "secret_values" ADD CONSTRAINT "secret_values_agent_scope_key_uq" UNIQUE NULLS NOT DISTINCT("project_id","agent_id","environment_id","key");--> statement-breakpoint
ALTER TABLE "secrets_metadata" ADD CONSTRAINT "secrets_agent_scope_key_uq" UNIQUE NULLS NOT DISTINCT("project_id","agent_id","environment_id","key");