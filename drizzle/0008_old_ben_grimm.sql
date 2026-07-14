CREATE TABLE "github_installation_states" (
	"nonce_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"session_id" text NOT NULL,
	"org_id" text NOT NULL,
	"code_verifier" text NOT NULL,
	"candidate_installation_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_installations" ADD COLUMN "verified_by_user_id" text;--> statement-breakpoint
-- Legacy projects stored GitHub's raw installation id. Convert only an exact same-tenant match;
-- unmatched values fail closed. Existing installation rows intentionally remain unverified.
UPDATE "projects" AS "p"
SET "repo_installation_id" = "g"."id"
FROM "github_installations" AS "g"
WHERE "p"."org_id" = "g"."org_id"
  AND "p"."repo_installation_id" = "g"."installation_id";--> statement-breakpoint
UPDATE "projects" AS "p"
SET "repo_installation_id" = NULL
WHERE "p"."repo_installation_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "github_installations" AS "g"
    WHERE "g"."org_id" = "p"."org_id"
      AND "g"."id" = "p"."repo_installation_id"
  );--> statement-breakpoint
ALTER TABLE "github_installation_states" ADD CONSTRAINT "github_installation_states_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installation_states" ADD CONSTRAINT "github_installation_states_session_id_session_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."session"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installation_states" ADD CONSTRAINT "github_installation_states_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_installation_states_expires_idx" ON "github_installation_states" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_verified_by_user_id_user_id_fk" FOREIGN KEY ("verified_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "github_installations" ADD CONSTRAINT "github_installations_org_id_id_uq" UNIQUE("org_id","id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_repo_installation_fk" FOREIGN KEY ("org_id","repo_installation_id") REFERENCES "public"."github_installations"("org_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
