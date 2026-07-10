/**
 * Durable transcript cache against a REAL Postgres (issue #48): the reconnect fix persists raw Eve
 * events to `playground_events` as the turn-stream drain reads them, then reconstructs the
 * transcript from Eden's DB on reconnect — no replay of Eve's whole log from index 0.
 *
 * This proves the two properties the unit fakes can't: (1) the same raw events that the Eve-replay
 * path projects (see tests/unit/playground-replay.test.ts) project IDENTICALLY when sourced from
 * the cache, and (2) the (session, streamIndex) PK makes re-drained writes idempotent.
 *
 * Opt-in: runs only when EDEN_DB_SMOKE=1 and DATABASE_URL point at a live dev database
 * (`EDEN_DB_SMOKE=1 npx vitest run tests/integration/playground-cache.db.test.ts` with .env.local
 * sourced). Creates its own org/project/agent/session rows and deletes them, so it's safe to re-run.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const LIVE = process.env.EDEN_DB_SMOKE === "1";

describe.runIf(LIVE)(
  "playground transcript cache against real Postgres",
  () => {
    it("persists raw events and reprojects the transcript from the cache, idempotently", async () => {
      const { db } = await import("~/db/client.server");
      const { orgs, users, projects, agents, playgroundSessions } =
        await import("~/db/schema");
      const {
        createPlaygroundSession,
        savePlaygroundEvents,
        loadPlaygroundEntriesFromCache,
        cachedStreamIndex,
        markPlaygroundSessionStopped,
        savePlaygroundSessionCursor,
        savePlaygroundSessionProgress,
      } = await import("~/playground/sessions.server");

      const ORG = "org_pgcache_smoke";
      const USER = "user_pgcache_smoke";
      // Fresh scope each run (cascades clean up the session + its cached events).
      await db.delete(orgs).where(eq(orgs.id, ORG));
      await db.delete(users).where(eq(users.id, USER));
      await db.insert(orgs).values({ id: ORG, name: "pgcache smoke" });
      await db.insert(users).values({ id: USER, email: "pgcache@smoke.test" });
      const [project] = await db
        .insert(projects)
        .values({ orgId: ORG, name: "pgcache", slug: "pgcache-smoke" })
        .returning();
      const [agent] = await db
        .insert(agents)
        .values({
          projectId: project.id,
          name: "engineer",
          root: "agents/engineer/agent",
        })
        .returning();
      const session = await createPlaygroundSession({
        projectId: project.id,
        agentId: agent.id,
        userId: USER,
      });

      const at = new Date().toISOString();
      // The exact raw-event shape the drain buffers (streamIndex + type + data + meta) — the same
      // events tests/unit/playground-replay.test.ts feeds the Eve-replay path.
      const events = [
        {
          type: "session.started",
          data: { runtime: { modelId: "m/x" } },
          meta: { at },
        },
        { type: "turn.started", data: { turnId: "turn_0" }, meta: { at } },
        {
          type: "message.received",
          data: { turnId: "turn_0", message: "finish the deploy" },
          meta: { at },
        },
        {
          type: "step.started",
          data: { turnId: "turn_0", sequence: 1 },
          meta: { at },
        },
        {
          type: "message.appended",
          data: { turnId: "turn_0", messageSoFar: "Working on it" },
          meta: { at },
        },
      ].map((e, i) => ({ streamIndex: i + 1, ...e }));

      await savePlaygroundEvents(session.id, events);

      const entries = await loadPlaygroundEntriesFromCache(session);
      expect(entries).toMatchObject([
        { role: "user", text: "finish the deploy" },
        { role: "assistant", text: "Working on it", modelId: "m/x" },
      ]);
      expect(await cachedStreamIndex(session.id)).toBe(5);

      // Idempotent re-drain: replaying the same indices is a no-op, not a duplicate-key crash, and the
      // transcript is unchanged.
      await savePlaygroundEvents(session.id, events);
      expect(await loadPlaygroundEntriesFromCache(session)).toEqual(entries);
      expect(await cachedStreamIndex(session.id)).toBe(5);

      // Stop is terminal for an already-running drain: both its queued progress write and its final
      // cursor write arrive after /stop in this ordering, and both must become no-ops. The fake target
      // deliberately has no FK rows, so either update escaping its status guard also fails loudly.
      await markPlaygroundSessionStopped({ id: session.id });
      const staleDrainTarget = {
        deploymentId: "dep_pgsmoke",
        environmentId: "env_pgsmoke",
        releaseId: "rel_pgsmoke",
        url: "http://127.0.0.1:1",
        version: "v1",
        environmentName: "smoke",
        gitSha: "deadbeef",
      };
      await savePlaygroundSessionProgress({
        id: session.id,
        target: staleDrainTarget,
        externalSessionId: "wrun_pgcache_smoke",
        continuationToken: null,
        streamIndex: 5,
      });
      await savePlaygroundSessionCursor({
        id: session.id,
        target: staleDrainTarget,
        externalSessionId: "wrun_pgcache_smoke",
        continuationToken: null,
        streamIndex: 5,
        status: "waiting",
      });
      const [afterStaleDrain] = await db
        .select()
        .from(playgroundSessions)
        .where(eq(playgroundSessions.id, session.id));
      expect(afterStaleDrain).toMatchObject({
        status: "stopped",
        externalSessionId: null,
        streamIndex: 0,
        lastDeploymentId: null,
      });

      // Cleanup.
      await db.delete(orgs).where(eq(orgs.id, ORG));
      await db.delete(users).where(eq(users.id, USER));
    });
  },
);
