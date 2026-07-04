/**
 * Local SecretsProvider scoping + crypto — against an in-memory KV (no DB). Verifies the logic
 * the provider owns: seal/open round-trip, upsert on the same scope+key, resolve's env-over-
 * agent-wide override, per-agent isolation (PRD §7.9), and scope-exact delete.
 */
import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { makeLocalSecretsProvider } from "~/seams/oss/secrets.local.server";
import { makeFakeSecretKV } from "../fakes/secret-kv";

const key = crypto.randomBytes(32);
const PROJECT = "proj_1";
const AGENT = "agent_1";
const OTHER_AGENT = "agent_2";
const ENV = "env_1";
let secrets: ReturnType<typeof makeLocalSecretsProvider>;

const ref = (k: string, environmentId: string | null = null, agentId = AGENT) => ({
  projectId: PROJECT,
  agentId,
  environmentId,
  key: k,
});
const scope = (environmentId: string | null = null, agentId = AGENT) => ({
  projectId: PROJECT,
  agentId,
  environmentId,
});

beforeEach(() => {
  secrets = makeLocalSecretsProvider(makeFakeSecretKV(), () => key);
});

describe("secrets", () => {
  it("round-trips a value through encryption", async () => {
    await secrets.set(ref("API_KEY"), "s3cr3t");
    expect(await secrets.get(ref("API_KEY"))).toBe("s3cr3t");
  });

  it("upserts on the same scope+key", async () => {
    await secrets.set(ref("API_KEY"), "first");
    await secrets.set(ref("API_KEY"), "rotated");
    expect(await secrets.get(ref("API_KEY"))).toBe("rotated");
  });

  it("resolve() overrides agent-wide with env-scoped values", async () => {
    await secrets.set(ref("SHARED"), "agent-wide");
    await secrets.set(ref("API_KEY"), "rotated");
    await secrets.set(ref("SHARED", ENV), "env-scoped");

    const resolved = await secrets.resolve(scope(ENV));
    expect(resolved.SHARED).toBe("env-scoped");
    expect(resolved.API_KEY).toBe("rotated");

    // Without an environment, only agent-wide values apply.
    const bare = await secrets.resolve(scope(null));
    expect(bare.SHARED).toBe("agent-wide");
  });

  it("isolates secrets between roster members (§7.9: least privilege)", async () => {
    await secrets.set(ref("CLOUDFLARE_API_TOKEN"), "deployer-only");
    // The other teammate sees nothing — not in resolve, not by name, not by direct get.
    expect(await secrets.resolve(scope(null, OTHER_AGENT))).toEqual({});
    expect(await secrets.listNames(scope(null, OTHER_AGENT))).toEqual([]);
    expect(await secrets.get(ref("CLOUDFLARE_API_TOKEN", null, OTHER_AGENT))).toBeNull();
  });

  it("deletes scope-exactly", async () => {
    await secrets.set(ref("SHARED"), "agent-wide");
    await secrets.set(ref("SHARED", ENV), "env-scoped");

    await secrets.delete(ref("SHARED", ENV));
    expect(await secrets.get(ref("SHARED", ENV))).toBeNull();
    expect(await secrets.get(ref("SHARED"))).toBe("agent-wide");
  });

  it("lists names scope-exactly, never values", async () => {
    await secrets.set(ref("B"), "1");
    await secrets.set(ref("A"), "2");
    await secrets.set(ref("C", ENV), "3");
    expect(await secrets.listNames(scope(null))).toEqual(["A", "B"]);
    expect(await secrets.listNames(scope(ENV))).toEqual(["C"]);
  });
});
