CREATE TABLE "user_workspace_memory" (
	"user_id" text PRIMARY KEY NOT NULL,
	"last_org_id" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_workspace_memory" ADD CONSTRAINT "user_workspace_memory_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_workspace_memory" ADD CONSTRAINT "user_workspace_memory_last_org_id_organization_id_fk" FOREIGN KEY ("last_org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;