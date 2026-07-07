-- Team environments (the TEAM is the deployment unit). Environments stay PHYSICALLY per-agent
-- (one row per member per name; environments_agent_name_uq on (agent_id, name) — those ids are
-- load-bearing FKs for deployments, secrets, playground worlds, delegations, and /e/<envId>
-- ingress), but LOGICALLY they are team-level: a project owns one set of env NAMES and every
-- roster member (kind = 'member') has a row of every name. A member in one env but not another is
-- drift, not a feature.
--
-- Backfill the invariant. For each project let S be the distinct env names across its member
-- agents (or {'default'} when the project has no member envs at all — preserving the ≥1 rule),
-- then insert every missing (member agent, name in S) row. The built-in assistant (kind <>
-- 'member') is excluded from S and never gets rows here. IDs mirror the app's newId(): a fresh
-- random 12-char [a-z] string per inserted row. The id LATERAL is CORRELATED on the outer row
-- (the WHERE references a/s) — an uncorrelated volatile subquery may be materialized once by the
-- planner and hand every row the same id, which would violate the primary key.
INSERT INTO "environments" ("id", "project_id", "agent_id", "name")
SELECT gen."id", a."project_id", a."id", s."name"
FROM "agents" a
JOIN LATERAL (
  -- S: the project's team env set, or {'default'} when it has no member envs yet.
  SELECT DISTINCT e."name"
  FROM "environments" e
  JOIN "agents" ma ON ma."id" = e."agent_id" AND ma."kind" = 'member'
  WHERE ma."project_id" = a."project_id"
  UNION
  SELECT 'default'
  WHERE NOT EXISTS (
    SELECT 1
    FROM "environments" e2
    JOIN "agents" ma2 ON ma2."id" = e2."agent_id" AND ma2."kind" = 'member'
    WHERE ma2."project_id" = a."project_id"
  )
) s ON true
CROSS JOIN LATERAL (
  SELECT string_agg(
    substr('abcdefghijklmnopqrstuvwxyz', (floor(random() * 26) + 1)::int, 1),
    ''
  ) AS "id"
  FROM generate_series(1, 12)
  -- Correlation with the outer row: forces per-row re-evaluation (see header comment).
  WHERE a."id" IS NOT NULL AND s."name" IS NOT NULL
) gen
WHERE a."kind" = 'member'
  AND NOT EXISTS (
    SELECT 1
    FROM "environments" ex
    WHERE ex."agent_id" = a."id" AND ex."name" = s."name"
  );
