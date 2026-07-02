/**
 * Per-worker setup: point every server module at the test database BEFORE any of them is
 * imported (the db client reads DATABASE_URL at module init), and pin seam selection so
 * tests are deterministic regardless of the developer's .env.local.
 */
import { testDatabaseUrl } from "./env";

process.env.DATABASE_URL = testDatabaseUrl();
process.env.EDEN_MODE = "oss";
process.env.EDEN_DEPLOY_TARGET = "container"; // throws DeployToolingUnavailable — no docker in tests
process.env.EDEN_DISABLE_WORKER = "1";
process.env.EDEN_SECRETS_KEY =
  "6465616462656566646561646265656664656164626565666465616462656566"; // fixed 32-byte test key
