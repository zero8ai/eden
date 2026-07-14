CREATE TABLE "github_mobile_installation_handoffs" (
	"code_hash" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"org_id" text NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_mobile_installation_handoffs" ADD CONSTRAINT "github_mobile_installation_handoffs_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_mobile_installation_handoffs" ADD CONSTRAINT "github_mobile_installation_handoffs_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_mobile_installation_handoffs" ADD CONSTRAINT "github_mobile_installation_handoffs_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_mobile_handoffs_expires_idx" ON "github_mobile_installation_handoffs" USING btree ("expires_at");