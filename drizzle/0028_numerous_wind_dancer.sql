CREATE TABLE "playground_events" (
	"session_id" varchar(12) NOT NULL,
	"stream_index" integer NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "playground_events_session_id_stream_index_pk" PRIMARY KEY("session_id","stream_index")
);
--> statement-breakpoint
ALTER TABLE "playground_events" ADD CONSTRAINT "playground_events_session_id_playground_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."playground_sessions"("id") ON DELETE cascade ON UPDATE no action;