/**
 * Discord interactions relay (issue #32). Eden's shared app has ONE Interactions Endpoint URL
 * pointing at the control plane; this module verifies Discord's Ed25519 signature and resolves
 * which agent instance a given interaction routes to. The route (`api.discord.interactions.ts`)
 * then forwards the raw request to that instance's eve Discord channel untouched — a dumb pipe,
 * so the instance re-verifies and replies with the interaction token exactly as it does today.
 *
 * The signature verify and target resolution are pure/injectable so they unit-test with a real
 * Ed25519 keypair and a fake store — zero network, zero database.
 */
import { createPublicKey, verify as cryptoVerify } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { db } from "~/db/client.server";
import { deployments } from "~/db/schema";
import {
  findConnectionByGuildCommand,
  listConnectionsForGuild,
  type DiscordConnection,
} from "./connections.server";

/** The Ed25519 SPKI DER prefix — prepended to a 32-byte raw public key to build a KeyObject. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Verify Discord's request signature: Ed25519 over `timestamp + rawBody`, the signature and
 * public key both hex. Any malformed input (bad hex, wrong length) fails closed as false.
 */
export function verifyDiscordSignature(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  publicKeyHex: string,
): boolean {
  if (!signature || !timestamp) return false;
  try {
    const keyDer = Buffer.concat([
      ED25519_SPKI_PREFIX,
      Buffer.from(publicKeyHex, "hex"),
    ]);
    const key = createPublicKey({ key: keyDer, format: "der", type: "spki" });
    const message = Buffer.from(timestamp + rawBody, "utf8");
    const sig = Buffer.from(signature, "hex");
    if (sig.length !== 64) return false;
    return cryptoVerify(null, message, key, sig);
  } catch {
    return false;
  }
}

/* ─────────────────────────────── target resolution ─────────────────────────────── */

/** A Discord interaction payload — only the fields the relay routes on. */
export interface InteractionPayload {
  type?: number;
  guild_id?: string;
  data?: { name?: string };
  message?: {
    interaction_metadata?: { name?: string };
    interaction?: { name?: string };
  };
}

export type RelayTarget =
  | { ok: true; url: string; connection: DiscordConnection }
  | { ok: false; reason: "no-connection" | "no-live-deployment" };

export interface RelayDeps {
  findConnection: (
    guildId: string,
    commandName: string,
  ) => Promise<DiscordConnection | null>;
  listConnections: (guildId: string) => Promise<DiscordConnection[]>;
  /** The live (status='live', non-null url) deployment url for an environment, or null. */
  findLiveUrl: (environmentId: string) => Promise<string | null>;
}

/** APPLICATION_COMMAND interaction type. */
const TYPE_APPLICATION_COMMAND = 2;

/**
 * Resolve the instance a Discord interaction routes to. Command interactions look up the
 * connection by (guild, command name). Non-command interactions (components/modals/autocomplete)
 * carry no command name of their own, so they fall back to: the guild's sole connection, else
 * the originating command name in the message's interaction metadata, else nothing.
 */
export async function resolveRelayTarget(
  payload: InteractionPayload,
  deps: RelayDeps,
): Promise<RelayTarget> {
  const guildId = payload.guild_id;
  if (!guildId) return { ok: false, reason: "no-connection" };

  let connection: DiscordConnection | null = null;
  if (payload.type === TYPE_APPLICATION_COMMAND && payload.data?.name) {
    connection = await deps.findConnection(guildId, payload.data.name);
  } else {
    const all = await deps.listConnections(guildId);
    if (all.length === 1) {
      connection = all[0];
    } else {
      const originName =
        payload.message?.interaction_metadata?.name ??
        payload.message?.interaction?.name ??
        null;
      if (originName) {
        connection = all.find((c) => c.commandName === originName) ?? null;
      }
    }
  }
  if (!connection) return { ok: false, reason: "no-connection" };

  const url = await deps.findLiveUrl(connection.environmentId);
  if (!url) return { ok: false, reason: "no-live-deployment" };
  return { ok: true, url, connection };
}

/** Default deps: the real connection store + a live-deployment lookup over Drizzle. */
export function defaultRelayDeps(): RelayDeps {
  return {
    findConnection: findConnectionByGuildCommand,
    listConnections: listConnectionsForGuild,
    findLiveUrl: findLiveDeploymentUrl,
  };
}

/** The loopback url (`http://127.0.0.1:<port>`) of an environment's live deployment, or null. */
export async function findLiveDeploymentUrl(
  environmentId: string,
): Promise<string | null> {
  const rows = await db
    .select({ url: deployments.url })
    .from(deployments)
    .where(
      and(
        eq(deployments.environmentId, environmentId),
        eq(deployments.status, "live"),
      ),
    );
  return rows.find((r) => !!r.url)?.url ?? null;
}
