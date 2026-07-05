/**
 * Store-level semantics of the secrets rework (§5): the §5 precedence matrix (agent+env >
 * agent-wide > shared+env > shared-wide, most-specific wins), the attachment sandbox-name union
 * (§5 pure rule), and fingerprint/exposure metadata written in the provider's set path (§4.1).
 * Precedence is exercised through the provider + the attachment-aware fake KV; the union rule is
 * exercised as the pure function the Drizzle helper delegates to.
 */
import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";

import { computeSandboxNames } from "~/seams/oss/secret-store";
import { makeLocalSecretsProvider } from "~/seams/oss/secrets.local.server";
import { fingerprint } from "~/seams/oss/secretbox";
import { makeFakeSecretKV, type FakeSecretKV } from "../fakes/secret-kv";

const key = crypto.randomBytes(32);
const PROJECT = "proj_1";
const AGENT = "agent_1";
const ENV = "env_1";

let kv: FakeSecretKV;
let secrets: ReturnType<typeof makeLocalSecretsProvider>;

const ref = (k: string, environmentId: string | null = null, agentId: string | null = AGENT) => ({
  projectId: PROJECT,
  agentId,
  environmentId,
  key: k,
});
const scope = (environmentId: string | null = null, agentId: string | null = AGENT) => ({
  projectId: PROJECT,
  agentId,
  environmentId,
});
const shared = (k: string, environmentId: string | null = null) => ref(k, environmentId, null);

beforeEach(() => {
  kv = makeFakeSecretKV();
  secrets = makeLocalSecretsProvider(kv, () => key);
});

describe("§5 precedence — most-specific wins", () => {
  it("agent+env overrides agent-wide overrides shared+env overrides shared-wide", async () => {
    await secrets.set(shared("TOKEN"), "shared-wide");
    await secrets.set(shared("TOKEN", ENV), "shared-env");
    await secrets.set(ref("TOKEN"), "agent-wide");
    await secrets.set(ref("TOKEN", ENV), "agent-env");
    kv.attach(AGENT, "TOKEN");

    expect((await secrets.resolve(scope(ENV))).TOKEN).toBe("agent-env");
  });

  it("falls to agent-wide when there is no agent+env row", async () => {
    await secrets.set(shared("TOKEN"), "shared-wide");
    await secrets.set(ref("TOKEN"), "agent-wide");
    kv.attach(AGENT, "TOKEN");
    expect((await secrets.resolve(scope(ENV))).TOKEN).toBe("agent-wide");
  });

  it("falls to shared+env over shared-wide when the member has no own row", async () => {
    await secrets.set(shared("TOKEN"), "shared-wide");
    await secrets.set(shared("TOKEN", ENV), "shared-env");
    kv.attach(AGENT, "TOKEN");
    expect((await secrets.resolve(scope(ENV))).TOKEN).toBe("shared-env");
    // Without an env, only shared-wide is in scope.
    expect((await secrets.resolve(scope(null))).TOKEN).toBe("shared-wide");
  });

  it("does NOT resolve a shared secret the member has not attached", async () => {
    await secrets.set(shared("TOKEN"), "shared-wide");
    // no attach
    expect((await secrets.resolve(scope(ENV))).TOKEN).toBeUndefined();
    kv.attach(AGENT, "TOKEN");
    expect((await secrets.resolve(scope(ENV))).TOKEN).toBe("shared-wide");
  });

  it("an agent secret shadows an attached shared one of the same name (§11.1)", async () => {
    await secrets.set(shared("GITHUB_TOKEN"), "shared-value");
    await secrets.set(ref("GITHUB_TOKEN"), "agent-value");
    kv.attach(AGENT, "GITHUB_TOKEN");
    expect((await secrets.resolve(scope(null))).GITHUB_TOKEN).toBe("agent-value");
    // Deleting the override restores shared behaviour (precedence, no data change).
    await secrets.delete(ref("GITHUB_TOKEN"));
    expect((await secrets.resolve(scope(null))).GITHUB_TOKEN).toBe("shared-value");
  });
});

describe("§5 sandbox-name union (computeSandboxNames)", () => {
  it("unions the member's own exposed names with attachment-exposed names that exist", () => {
    expect(
      computeSandboxNames({
        agentExposed: ["A"],
        attachmentExposed: ["SHARED_OK", "SHARED_MISSING"],
        sharedExisting: ["SHARED_OK"],
      }),
    ).toEqual(["A", "SHARED_OK"]);
  });

  it("drops an attachment-exposed name whose shared secret does not exist in scope", () => {
    expect(
      computeSandboxNames({
        agentExposed: [],
        attachmentExposed: ["GHOST"],
        sharedExisting: [],
      }),
    ).toEqual([]);
  });

  it("dedupes when a name is exposed both ways and sorts", () => {
    expect(
      computeSandboxNames({
        agentExposed: ["Z", "DUP"],
        attachmentExposed: ["DUP"],
        sharedExisting: ["DUP"],
      }),
    ).toEqual(["DUP", "Z"]);
  });
});

describe("§4.1 fingerprint + exposure metadata", () => {
  it("writes the full SHA-256 fingerprint of the value in the set path", async () => {
    await secrets.set(ref("API_KEY"), "s3cr3t");
    expect(kv.meta(ref("API_KEY"))?.fingerprint).toBe(fingerprint("s3cr3t"));
  });

  it("sets sandbox exposure atomically at creation (§6 — no second round-trip)", async () => {
    await secrets.set(ref("API_KEY"), "v", { sandboxExposed: true });
    expect(kv.meta(ref("API_KEY"))?.sandboxExposed).toBe(true);
  });

  it("a value replace without meta leaves the existing exposure flag untouched", async () => {
    await secrets.set(ref("API_KEY"), "v", { sandboxExposed: true });
    await secrets.set(ref("API_KEY"), "rotated");
    expect(kv.meta(ref("API_KEY"))?.sandboxExposed).toBe(true);
    expect(kv.meta(ref("API_KEY"))?.fingerprint).toBe(fingerprint("rotated"));
  });
});
