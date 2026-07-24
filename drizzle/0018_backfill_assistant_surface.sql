-- Backfill legacy assistant conversations (issue #221 PRD gap 2).
--
-- Migration 0015 added `playground_sessions.surface` with DEFAULT 'playground', so every row
-- that existed before it — including genuine assistant conversations — was stamped 'playground'.
-- Assistant conversations are exactly the rows targeting the built-in assistant agent
-- (agents.kind = 'assistant'); playground sessions always target kind 'member' agents. Restamp
-- them so surface queries can use exact equality for all three surfaces.
UPDATE "playground_sessions"
SET "surface" = 'assistant'
WHERE "surface" = 'playground'
  AND "agent_id" IN (SELECT "id" FROM "agents" WHERE "kind" = 'assistant');
