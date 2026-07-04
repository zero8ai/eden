-- User-defined environments (M5.7): no name is special anymore — the member's PRIMARY
-- environment (default Ship target, Versions hero) is simply its FIRST by (created_at, id).
-- The old seeded trio was bulk-inserted with one createdAt, so that ordering is currently
-- nondeterministic; nudge the seeded "production" a second earlier wherever a member has
-- several environments, so every existing agent's primary stays what the UI treated as
-- primary until now. No rows are created, renamed, or deleted (owner decision).
UPDATE environments e
SET created_at = created_at - interval '1 second'
WHERE e.name = 'production'
  AND EXISTS (
    SELECT 1 FROM environments e2
    WHERE e2.agent_id = e.agent_id AND e2.id <> e.id
  );
