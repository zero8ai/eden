/**
 * Test setup. The suite is entirely unit tests over in-memory fakes — nothing connects to a
 * database — so we only need a DATABASE_URL present for `db/client.server` to construct its
 * (lazy, never-connected) postgres.js client at import time. No Postgres process is required.
 */
process.env.DATABASE_URL ??= "postgres://unit:unit@localhost:5432/unit_never_connects";
