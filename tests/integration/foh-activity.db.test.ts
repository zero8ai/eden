/**
 * FOH activity feed against a REAL Postgres (WP8): seed the synthetic sam → ivy scenario —
 * deployment, human-opened session, delegation with its linked teammate run (+ steps),
 * agent-opened session, and a plain run — then assert the projection reconstructs it in
 * wall-clock order with the exchange expandable from the linked run (§6 legibility in DB
 * form), tolerating a delegation whose run recording never landed.
 *
 * Opt-in: runs only when EDEN_DB_SMOKE=1 and DATABASE_URL point at a live dev database
 * (`EDEN_DB_SMOKE=1 npx vitest run tests/integration/foh-activity.db.test.ts` with
 * .env.local sourced). Creates its own rows and deletes them, so it's safe to re-run.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const LIVE = process.env.EDEN_DB_SMOKE === "1";

describe.runIf(LIVE)("FOH activity projection against real Postgres", () => {
  it("reconstructs the sam → ivy scenario in order, with the exchange expansion", async () => {
    const { db } = await import("~/db/client.server");
    const { organization, user } = await import("~/db/auth-schema");
    const {
      projects,
      agents,
      environments,
      releases,
      deployments,
      playgroundSessions,
      delegations,
      runs,
      runSteps,
    } = await import("~/db/schema");
    const { listTeamActivity, getDelegationExchange } = await import(
      "~/foh/activity.server"
    );

    const ORG = "org_foh_activity";
    const USER = "user_foh_activity";
    const now = new Date();
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.delete(user).where(eq(user.id, USER));
    await db.insert(organization).values({
      id: ORG,
      name: "foh activity",
      slug: "foh-activity-smoke",
      createdAt: now,
    });
    await db.insert(user).values({
      id: USER,
      name: "Aaron",
      email: "foh-activity@smoke.test",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    const [project] = await db
      .insert(projects)
      .values({ orgId: ORG, name: "agency", slug: "foh-activity-smoke" })
      .returning();
    const [sam] = await db
      .insert(agents)
      .values({ projectId: project.id, name: "sam", root: "agents/sam/agent" })
      .returning();
    const [ivy] = await db
      .insert(agents)
      .values({ projectId: project.id, name: "ivy", root: "agents/ivy/agent" })
      .returning();

    const t = (min: number) => new Date(Date.UTC(2026, 6, 24, 10, min, 0));

    // 10:00 — ivy's deployment goes live.
    const [env] = await db
      .insert(environments)
      .values({ projectId: project.id, agentId: ivy.id, name: "default" })
      .returning();
    const [release] = await db
      .insert(releases)
      .values({ projectId: project.id, agentId: ivy.id, version: "v3", gitSha: "abc123" })
      .returning();
    const [deployment] = await db
      .insert(deployments)
      .values({
        environmentId: env.id,
        releaseId: release.id,
        status: "live",
        url: "http://127.0.0.1:1",
        createdAt: t(0),
      })
      .returning();

    // 10:10 — Aaron opens a session with sam.
    const [humanSession] = await db
      .insert(playgroundSessions)
      .values({
        projectId: project.id,
        agentId: sam.id,
        createdBy: USER,
        surface: "foh",
        title: "the pricing page is broken",
        createdAt: t(10),
      })
      .returning();

    // Builder-surface noise must never appear in the feed.
    await db.insert(playgroundSessions).values({
      projectId: project.id,
      agentId: sam.id,
      createdBy: USER,
      surface: "playground",
      title: "builder noise",
      createdAt: t(11),
    });

    // 10:20 — a plain (non-delegation) run for sam.
    const [plainRun] = await db
      .insert(runs)
      .values({
        projectId: project.id,
        agentId: sam.id,
        channel: "foh",
        status: "completed",
        metadata: { input: "look at the pricing page" },
        startedAt: t(20),
      })
      .returning();

    // 10:44 — sam → ivy delegation: linked teammate run with the full exchange steps.
    const [delegationRun] = await db
      .insert(runs)
      .values({
        projectId: project.id,
        agentId: ivy.id,
        channel: "teammate",
        status: "completed",
        metadata: {
          input: "can you check DNS for eden.dev?",
          delegationId: "pending", // patched below once the delegation row exists
          fromAgentId: sam.id,
          fromAgentName: "sam",
        },
        startedAt: t(44),
      })
      .returning();
    const [delegationRow] = await db
      .insert(delegations)
      .values({
        projectId: project.id,
        fromAgentId: sam.id,
        fromEnvironmentId: env.id,
        toAgentId: ivy.id,
        toEnvironmentId: env.id,
        runId: delegationRun.id,
        status: "completed",
        startedAt: t(44),
        finishedAt: t(46),
      })
      .returning();
    await db
      .update(runs)
      .set({
        metadata: {
          input: "can you check DNS for eden.dev?",
          delegationId: delegationRow.id,
          fromAgentId: sam.id,
          fromAgentName: "sam",
        },
      })
      .where(eq(runs.id, delegationRun.id));
    await db.insert(runSteps).values([
      {
        runId: delegationRun.id,
        seq: 1,
        type: "message",
        data: { role: "user", text: "can you check DNS for eden.dev?" },
      },
      { runId: delegationRun.id, seq: 2, type: "model_call", data: {} },
      {
        runId: delegationRun.id,
        seq: 3,
        type: "tool_call",
        toolName: "bash",
        data: { summary: "dig eden.dev" },
      },
      {
        runId: delegationRun.id,
        seq: 4,
        type: "message",
        data: { role: "assistant", text: "DNS is healthy — A record points at the LB." },
      },
    ]);

    // 10:45 — a second delegation parks on a human and opens ivy's agent-side session;
    // its run recording never landed (runId null — best-effort).
    const [waitingDelegation] = await db
      .insert(delegations)
      .values({
        projectId: project.id,
        fromAgentId: sam.id,
        fromEnvironmentId: env.id,
        toAgentId: ivy.id,
        toEnvironmentId: env.id,
        status: "waiting",
        startedAt: t(45),
        finishedAt: t(45),
      })
      .returning();
    const [agentSession] = await db
      .insert(playgroundSessions)
      .values({
        projectId: project.id,
        agentId: ivy.id,
        createdBy: null,
        openedByAgentId: sam.id,
        delegationId: waitingDelegation.id,
        surface: "foh",
        title: "Which registrar account should I use?",
        createdAt: t(46),
      })
      .returning();

    // The projection reconstructs the scenario newest-first, builder noise and the
    // delegation-linked run excluded.
    const page = await listTeamActivity(project.id);
    const ids = page.events.map((e) => e.id);
    expect(ids).toEqual([
      `session:${agentSession.id}`,
      `delegation:${waitingDelegation.id}`,
      `delegation:${delegationRow.id}`,
      `run:${plainRun.id}`,
      `session:${humanSession.id}`,
      `deployment:${deployment.id}`,
    ]);
    expect(page.events[0]).toMatchObject({
      type: "session",
      openedByAgentName: "sam",
      openedByUserName: null,
      agentName: "ivy",
    });
    expect(page.events[1]).toMatchObject({
      type: "delegation",
      status: "waiting",
      ask: null, // runId never landed
      finishedAt: null, // park-time finishedAt is not an outcome
    });
    expect(page.events[2]).toMatchObject({
      type: "delegation",
      fromAgentName: "sam",
      toAgentName: "ivy",
      ask: "can you check DNS for eden.dev?",
      status: "completed",
      finishedAt: t(46).toISOString(),
    });
    expect(page.events[4]).toMatchObject({
      type: "session",
      openedByUserName: "Aaron",
      title: "the pricing page is broken",
    });
    expect(page.events[5]).toMatchObject({
      type: "deployment",
      agentName: "ivy",
      version: "v3",
      status: "live",
    });
    expect(page.nextBefore).toBeNull();

    // Cursor pagination: `before` excludes everything at/after the cutoff.
    const older = await listTeamActivity(project.id, { before: t(44) });
    expect(older.events.map((e) => e.id)).toEqual([
      `run:${plainRun.id}`,
      `session:${humanSession.id}`,
      `deployment:${deployment.id}`,
    ]);

    // The exchange expansion reconstructs who said what and what was done.
    const exchange = await getDelegationExchange(project.id, delegationRow.id);
    expect(exchange).toMatchObject({
      fromAgentName: "sam",
      toAgentName: "ivy",
      status: "completed",
      ask: "can you check DNS for eden.dev?",
    });
    expect(exchange?.steps).toEqual([
      { kind: "message", role: "user", text: "can you check DNS for eden.dev?" },
      { kind: "tool", toolName: "bash", summary: "dig eden.dev", isError: false },
      {
        kind: "message",
        role: "assistant",
        text: "DNS is healthy — A record points at the LB.",
      },
    ]);

    // Null-runId expansion degrades cleanly; other projects' delegations are invisible.
    const bare = await getDelegationExchange(project.id, waitingDelegation.id);
    expect(bare).toMatchObject({ ask: null, steps: [], status: "waiting" });
    expect(await getDelegationExchange("proj_nope_12", delegationRow.id)).toBeNull();

    // Cleanup (org cascade takes the project subtree; user row is independent).
    await db.delete(organization).where(eq(organization.id, ORG));
    await db.delete(user).where(eq(user.id, USER));
  });
});
