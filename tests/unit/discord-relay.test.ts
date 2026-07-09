/**
 * Discord interactions relay (issue #32). Two properties the route depends on: the Ed25519
 * signature check must accept Discord's real signing scheme and fail closed on anything off,
 * and target resolution must route commands by (guild, command name) with sensible fallbacks
 * for non-command interactions — all against injected deps, zero network/DB.
 */
import { generateKeyPairSync, sign as edSign } from "node:crypto";
import { describe, expect, it } from "vitest";

import type { DiscordConnection } from "~/discord/connections.server";
import {
  resolveRelayTarget,
  verifyDiscordSignature,
  type InteractionPayload,
  type RelayDeps,
} from "~/discord/relay.server";

/** A real Ed25519 keypair; export the raw 32-byte public key as hex (last 32 bytes of SPKI DER). */
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const publicKeyHex = Buffer.from(spki.subarray(spki.length - 32)).toString(
    "hex",
  );
  return { privateKey, publicKeyHex };
}

describe("verifyDiscordSignature", () => {
  const { privateKey, publicKeyHex } = keypair();
  const timestamp = "1700000000";
  const body = JSON.stringify({ type: 1 });
  const signature = Buffer.from(
    edSign(null, Buffer.from(timestamp + body, "utf8"), privateKey),
  ).toString("hex");

  it("accepts a correctly signed request", () => {
    expect(
      verifyDiscordSignature(body, signature, timestamp, publicKeyHex),
    ).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(
      verifyDiscordSignature(body + " ", signature, timestamp, publicKeyHex),
    ).toBe(false);
  });

  it("rejects a wrong timestamp", () => {
    expect(
      verifyDiscordSignature(body, signature, "1700000001", publicKeyHex),
    ).toBe(false);
  });

  it("rejects missing headers and garbage hex", () => {
    expect(verifyDiscordSignature(body, null, timestamp, publicKeyHex)).toBe(
      false,
    );
    expect(verifyDiscordSignature(body, signature, null, publicKeyHex)).toBe(
      false,
    );
    expect(verifyDiscordSignature(body, "zzzz", timestamp, publicKeyHex)).toBe(
      false,
    );
    expect(verifyDiscordSignature(body, signature, timestamp, "not-hex")).toBe(
      false,
    );
  });
});

describe("resolveRelayTarget", () => {
  const conn = (over: Partial<DiscordConnection>): DiscordConnection => ({
    id: "conn_1",
    projectId: "proj_1",
    agentId: "agent_1",
    environmentId: "env_1",
    guildId: "guild_1",
    guildName: "Acme",
    commandName: "triage",
    commandId: "cmd_1",
    ...over,
  });

  const deps = (over: Partial<RelayDeps>): RelayDeps => ({
    findConnection: async () => null,
    listConnections: async () => [],
    findLiveUrl: async () => "http://127.0.0.1:3700",
    ...over,
  });

  it("routes a command interaction by (guild, command name)", async () => {
    const c = conn({});
    const result = await resolveRelayTarget(
      { type: 2, guild_id: "guild_1", data: { name: "triage" } },
      deps({
        findConnection: async (g, n) =>
          g === "guild_1" && n === "triage" ? c : null,
      }),
    );
    expect(result).toEqual({
      ok: true,
      url: "http://127.0.0.1:3700",
      connection: c,
    });
  });

  it("returns no-connection for an unknown guild/command", async () => {
    const result = await resolveRelayTarget(
      { type: 2, guild_id: "guild_x", data: { name: "nope" } },
      deps({}),
    );
    expect(result).toEqual({ ok: false, reason: "no-connection" });
  });

  it("returns no-live-deployment when the connection has no live url", async () => {
    const result = await resolveRelayTarget(
      { type: 2, guild_id: "guild_1", data: { name: "triage" } },
      deps({
        findConnection: async () => conn({}),
        findLiveUrl: async () => null,
      }),
    );
    expect(result).toEqual({ ok: false, reason: "no-live-deployment" });
  });

  it("routes a non-command interaction via the guild's sole connection", async () => {
    const c = conn({});
    const result = await resolveRelayTarget(
      { type: 3, guild_id: "guild_1" } as InteractionPayload,
      deps({ listConnections: async () => [c] }),
    );
    expect(result).toEqual({
      ok: true,
      url: "http://127.0.0.1:3700",
      connection: c,
    });
  });

  it("routes a non-command interaction by originating command metadata when ambiguous", async () => {
    const a = conn({ id: "a", commandName: "triage" });
    const b = conn({ id: "b", commandName: "reviewer", agentId: "agent_2" });
    const result = await resolveRelayTarget(
      {
        type: 3,
        guild_id: "guild_1",
        message: { interaction_metadata: { name: "reviewer" } },
      },
      deps({ listConnections: async () => [a, b] }),
    );
    expect(result.ok && result.connection.id).toBe("b");
  });

  it("returns no-connection for an ambiguous guild with no metadata match", async () => {
    const a = conn({ id: "a", commandName: "triage" });
    const b = conn({ id: "b", commandName: "reviewer" });
    const result = await resolveRelayTarget(
      { type: 3, guild_id: "guild_1" } as InteractionPayload,
      deps({ listConnections: async () => [a, b] }),
    );
    expect(result).toEqual({ ok: false, reason: "no-connection" });
  });
});
