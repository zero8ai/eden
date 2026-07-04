CREATE TABLE "workspace_settings" (
	"org_id" text PRIMARY KEY NOT NULL,
	"model_key_ciphertext" text,
	"model_key_iv" text,
	"model_key_auth_tag" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_settings" ADD CONSTRAINT "workspace_settings_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;