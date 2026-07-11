CREATE TABLE "model_provider_connections" (
	"id" varchar(12) PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"provider" varchar(32) NOT NULL,
	"label" text NOT NULL,
	"account_email" text,
	"account_id" text,
	"access_token_ciphertext" text,
	"access_token_iv" text,
	"access_token_auth_tag" text,
	"refresh_token_ciphertext" text,
	"refresh_token_iv" text,
	"refresh_token_auth_tag" text,
	"access_token_expires_at" timestamp with time zone,
	"status" varchar(16) DEFAULT 'active' NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "model_provider_connections" ADD CONSTRAINT "model_provider_connections_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_provider_connections" ADD CONSTRAINT "model_provider_connections_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "model_provider_connections_org_idx" ON "model_provider_connections" USING btree ("org_id");