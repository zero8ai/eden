/**
 * Discord connections CRUD against a REAL Postgres (issue #32): upsert-on-conflict keyed by
 * (guildId, commandName), and the lookups the relay + send proxy depend on — the Drizzle
 * behaviour the unit fakes can't prove.
 *
 * Opt-in: runs only when EDEN_DB_SMOKE=1 and DATABASE_URL point at a live dev database
 * (`EDEN_DB_SMOKE=1 npx vitest run tests/integration/discord-connections.db.test.ts` with
 * .env.local sourced). Creates its own org/project/agent/env rows and deletes them, so it's
 * safe to re-run.
 */
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const LIVE = process.env.EDEN_DB_SMOKE === "1";

describe.runIf(LIVE)("discord connections against real Postgres", () => {
  it("upserts by (guild, command) and reads back by guild/agent", async () => {
    const { db } = await import("~/db/client.server");
    const { orgs, users, projects, agents, environments } =
      await import("~/db/schema");
    const {
      upsertConnection,
      findConnectionByGuildCommand,
      listConnectionsForGuild,
      listConnectionsForAgent,
      deleteConnection,
    } = await import("~/discord/connections.server");

    const ORG = "org_discord_smoke";
    const USER = "user_discord_smoke";
    await db.delete(orgs).where(eq(orgs.id, ORG));
    await db.delete(users).where(eq(users.id, USER));
    await db.insert(orgs).values({ id: ORG, name: "discord smoke" });
    await db.insert(users).values({ id: USER, email: "discord@smoke.test" });
    const [project] = await db
      .insert(projects)
      .values({ orgId: ORG, name: "discord", slug: "discord-smoke" })
      .returning();
    const [agentA] = await db
      .insert(agents)
      .values({
        projectId: project.id,
        name: "triage",
        root: "agents/triage/agent",
      })
      .returning();
    const [agentB] = await db
      .insert(agents)
      .values({
        projectId: project.id,
        name: "reviewer",
        root: "agents/reviewer/agent",
      })
      .returning();
    const [envA] = await db
      .insert(environments)
      .values({ projectId: project.id, agentId: agentA.id, name: "production" })
      .returning();
    const [envA2] = await db
      .insert(environments)
      .values({ projectId: project.id, agentId: agentA.id, name: "staging" })
      .returning();
    const [envB] = await db
      .insert(environments)
      .values({ projectId: project.id, agentId: agentB.id, name: "production" })
      .returning();

    // Insert, then re-upsert the SAME (guild, command) moving to a new env — one row, updated.
    const first = await upsertConnection({
      projectId: project.id,
      agentId: agentA.id,
      environmentId: envA.id,
      guildId: "guild_1",
      guildName: "Acme",
      commandName: "triage",
      commandId: "cmd_1",
    });
    const second = await upsertConnection({
      projectId: project.id,
      agentId: agentA.id,
      environmentId: envA2.id,
      guildId: "guild_1",
      guildName: "Acme Inc",
      commandName: "triage",
      commandId: "cmd_1b",
    });
    expect(second.id).toBe(first.id); // conflict updated in place
    expect(second.environmentId).toBe(envA2.id);
    expect(second.guildName).toBe("Acme Inc");

    // A different command in the same guild is a separate row.
    await upsertConnection({
      projectId: project.id,
      agentId: agentB.id,
      environmentId: envB.id,
      guildId: "guild_1",
      guildName: "Acme",
      commandName: "reviewer",
      commandId: "cmd_2",
    });

    const byGuildCommand = await findConnectionByGuildCommand(
      "guild_1",
      "triage",
    );
    expect(byGuildCommand?.agentId).toBe(agentA.id);

    const guildRows = await listConnectionsForGuild("guild_1");
    expect(guildRows.map((r) => r.commandName).sort()).toEqual([
      "reviewer",
      "triage",
    ]);

    const agentRows = await listConnectionsForAgent(agentA.id);
    expect(agentRows).toHaveLength(1);
    expect(agentRows[0].commandName).toBe("triage");

    await deleteConnection(first.id);
    expect(await findConnectionByGuildCommand("guild_1", "triage")).toBeNull();

    await db.delete(orgs).where(eq(orgs.id, ORG));
    await db.delete(users).where(eq(users.id, USER));
  });
});
