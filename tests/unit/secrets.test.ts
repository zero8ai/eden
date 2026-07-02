/**
 * Local SecretsProvider scoping + crypto — against an in-memory KV (no DB). Verifies the logic
 * the provider owns: seal/open round-trip, upsert on the same scope+key, resolve's env-over-
 * project-wide override, and scope-exact delete.
 */
import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { makeLocalSecretsProvider } from "~/seams/oss/secrets.local.server";
import { makeFakeSecretKV } from "../fakes/secret-kv";

const key = crypto.randomBytes(32);
const PROJECT = "proj_1";
const ENV = "env_1";
let secrets: ReturnType<typeof makeLocalSecretsProvider>;

beforeEach(() => {
  secrets = makeLocalSecretsProvider(makeFakeSecretKV(), () => key);
});

describe("secrets", () => {
  it("round-trips a value through encryption", async () => {
    await secrets.set({ projectId: PROJECT, environmentId: null, key: "API_KEY" }, "s3cr3t");
    expect(await secrets.get({ projectId: PROJECT, environmentId: null, key: "API_KEY" })).toBe("s3cr3t");
  });

  it("upserts on the same scope+key", async () => {
    await secrets.set({ projectId: PROJECT, environmentId: null, key: "API_KEY" }, "first");
    await secrets.set({ projectId: PROJECT, environmentId: null, key: "API_KEY" }, "rotated");
    expect(await secrets.get({ projectId: PROJECT, environmentId: null, key: "API_KEY" })).toBe("rotated");
  });

  it("resolve() overrides project-wide with env-scoped values", async () => {
    await secrets.set({ projectId: PROJECT, environmentId: null, key: "SHARED" }, "project-wide");
    await secrets.set({ projectId: PROJECT, environmentId: null, key: "API_KEY" }, "rotated");
    await secrets.set({ projectId: PROJECT, environmentId: ENV, key: "SHARED" }, "env-scoped");

    const resolved = await secrets.resolve(PROJECT, ENV);
    expect(resolved.SHARED).toBe("env-scoped");
    expect(resolved.API_KEY).toBe("rotated");

    // Without an environment, only project-wide values apply.
    const bare = await secrets.resolve(PROJECT, null);
    expect(bare.SHARED).toBe("project-wide");
  });

  it("deletes scope-exactly", async () => {
    await secrets.set({ projectId: PROJECT, environmentId: null, key: "SHARED" }, "project-wide");
    await secrets.set({ projectId: PROJECT, environmentId: ENV, key: "SHARED" }, "env-scoped");

    await secrets.delete({ projectId: PROJECT, environmentId: ENV, key: "SHARED" });
    expect(await secrets.get({ projectId: PROJECT, environmentId: ENV, key: "SHARED" })).toBeNull();
    expect(await secrets.get({ projectId: PROJECT, environmentId: null, key: "SHARED" })).toBe("project-wide");
  });

  it("lists names scope-exactly, never values", async () => {
    await secrets.set({ projectId: PROJECT, environmentId: null, key: "B" }, "1");
    await secrets.set({ projectId: PROJECT, environmentId: null, key: "A" }, "2");
    await secrets.set({ projectId: PROJECT, environmentId: ENV, key: "C" }, "3");
    expect(await secrets.listNames(PROJECT, null)).toEqual(["A", "B"]);
    expect(await secrets.listNames(PROJECT, ENV)).toEqual(["C"]);
  });
});
