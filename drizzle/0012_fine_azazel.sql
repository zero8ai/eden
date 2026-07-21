CREATE TABLE "agent_model_overrides" (
	"org_id" text NOT NULL,
	"agent_name" text NOT NULL,
	"model" text NOT NULL,
	"effort" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_model_overrides_org_id_agent_name_pk" PRIMARY KEY("org_id","agent_name")
);
--> statement-breakpoint
ALTER TABLE "agent_model_overrides" ADD CONSTRAINT "agent_model_overrides_org_id_organization_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;