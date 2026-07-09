/**
 * Persisted Discord connections (issue #32). A row binds a Discord server + slash command to
 * the agent/environment it routes to, written by the connect callback and read by the
 * interactions relay and the send proxy. Mirrors `~/github/installations.server.ts` (direct
 * Drizzle, upsert-on-conflict) — the bot token is never stored, only the routing binding.
 */
import { and, desc, eq } from "drizzle-orm";

import { db } from "~/db/client.server";
import { discordConnections } from "~/db/schema";

export interface DiscordConnection {
  id: string;
  projectId: string;
  agentId: string;
  environmentId: string;
  guildId: string;
  guildName: string | null;
  commandName: string;
  commandId: string | null;
}

export interface UpsertConnectionInput {
  projectId: string;
  agentId: string;
  environmentId: string;
  guildId: string;
  guildName: string | null;
  commandName: string;
  commandId: string | null;
}

/**
 * Bind (guild, command) to an agent/environment. Idempotent on the unique (guildId,
 * commandName): a reconnect (same agent picking the server again, or moving envs) updates the
 * routing in place rather than duplicating.
 */
export async function upsertConnection(
  input: UpsertConnectionInput,
): Promise<DiscordConnection> {
  const [row] = await db
    .insert(discordConnections)
    .values(input)
    .onConflictDoUpdate({
      target: [discordConnections.guildId, discordConnections.commandName],
      set: {
        projectId: input.projectId,
        agentId: input.agentId,
        environmentId: input.environmentId,
        guildName: input.guildName,
        commandId: input.commandId,
        updatedAt: new Date(),
      },
    })
    .returning();
  return toConnection(row);
}

/** The connection for one (guild, command) pair — the relay's primary lookup. */
export async function findConnectionByGuildCommand(
  guildId: string,
  commandName: string,
): Promise<DiscordConnection | null> {
  const [row] = await db
    .select()
    .from(discordConnections)
    .where(
      and(
        eq(discordConnections.guildId, guildId),
        eq(discordConnections.commandName, commandName),
      ),
    )
    .limit(1);
  return row ? toConnection(row) : null;
}

/** Every connection in a guild (fallback routing for non-command interactions). */
export async function listConnectionsForGuild(
  guildId: string,
): Promise<DiscordConnection[]> {
  const rows = await db
    .select()
    .from(discordConnections)
    .where(eq(discordConnections.guildId, guildId));
  return rows.map(toConnection);
}

/** Every server this agent is connected to — the send proxy's guild-scoping allowlist. */
export async function listConnectionsForAgent(
  agentId: string,
): Promise<DiscordConnection[]> {
  const rows = await db
    .select()
    .from(discordConnections)
    .where(eq(discordConnections.agentId, agentId))
    .orderBy(desc(discordConnections.createdAt));
  return rows.map(toConnection);
}

/** Drop a connection (disconnect). */
export async function deleteConnection(id: string): Promise<void> {
  await db.delete(discordConnections).where(eq(discordConnections.id, id));
}

function toConnection(
  row: typeof discordConnections.$inferSelect,
): DiscordConnection {
  return {
    id: row.id,
    projectId: row.projectId,
    agentId: row.agentId,
    environmentId: row.environmentId,
    guildId: row.guildId,
    guildName: row.guildName,
    commandName: row.commandName,
    commandId: row.commandId,
  };
}
