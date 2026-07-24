DELETE FROM playground_sessions WHERE portal_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE "chat_portals" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal_grants" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portal_turns" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "chat_portals" CASCADE;--> statement-breakpoint
DROP TABLE "portal_grants" CASCADE;--> statement-breakpoint
DROP TABLE "portal_turns" CASCADE;--> statement-breakpoint
-- IF EXISTS: the DROP TABLE "chat_portals" CASCADE above already removed this FK.
ALTER TABLE "playground_sessions" DROP CONSTRAINT IF EXISTS "playground_sessions_portal_id_chat_portals_id_fk";
--> statement-breakpoint
DROP INDEX "playground_sessions_portal_idx";--> statement-breakpoint
ALTER TABLE "playground_sessions" DROP COLUMN "portal_id";