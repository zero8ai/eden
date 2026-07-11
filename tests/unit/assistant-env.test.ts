/**
 * The built-in assistant's deploy env (issue #28): a Codex-backed assistant model runs through
 * Eden's gateway (EDEN_MODEL_GATEWAY_URL/TOKEN) and needs no OpenRouter key; an OpenRouter model
 * still requires one. `getWorkspaceModelKey` / `getWorkspaceAssistantModel` / the Codex-connection
 * check are mocked so the assistant env is exercised with no DB.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getWorkspaceModelKey = vi.fn<() => Promise<string | null>>();
const getWorkspaceAssistantModel = vi.fn<() => Promise<string | null>>();
const hasActiveCodexConnection = vi.fn<() => Promise<boolean>>();

vi.mock("~/org/workspace.server", () => ({
  getWorkspaceModelKey: () => getWorkspaceModelKey(),
  getWorkspaceAssistantModel: () => getWorkspaceAssistantModel(),
}));
vi.mock("~/models/provider-connections.server", () => ({
  hasActiveCodexConnection: () => hasActiveCodexConnection(),
}));

import { assistantEnv } from "~/assistant/instance.server";
import { verifyGatewayToken } from "~/gateway/token.server";

const OLD_KEY = process.env.EDEN_SECRETS_KEY;
const OLD_OR = process.env.OPENROUTER_API_KEY;

beforeEach(() => {
  process.env.EDEN_SECRETS_KEY = "a".repeat(64);
  delete process.env.OPENROUTER_API_KEY;
  getWorkspaceModelKey.mockReset();
  getWorkspaceAssistantModel.mockReset();
  hasActiveCodexConnection.mockReset();
});
afterEach(() => {
  if (OLD_KEY === undefined) delete process.env.EDEN_SECRETS_KEY;
  else process.env.EDEN_SECRETS_KEY = OLD_KEY;
  if (OLD_OR === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = OLD_OR;
});

describe("assistantEnv", () => {
  it("sets the OpenRouter key and no gateway env for an OpenRouter default model", async () => {
    getWorkspaceModelKey.mockResolvedValue("sk-or-workspace");
    getWorkspaceAssistantModel.mockResolvedValue(null);
    hasActiveCodexConnection.mockResolvedValue(false);
    const env = await assistantEnv({ orgId: "org_1", deploymentId: "dep_1" });
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-workspace");
    expect(env).not.toHaveProperty("EDEN_MODEL_GATEWAY_URL");
    expect(env).not.toHaveProperty("EDEN_MODEL_GATEWAY_TOKEN");
  });

  it("runs a codex/* assistant model through the gateway with no OpenRouter key required", async () => {
    getWorkspaceModelKey.mockResolvedValue(null);
    getWorkspaceAssistantModel.mockResolvedValue("codex/conn_1/gpt-5.5");
    hasActiveCodexConnection.mockResolvedValue(true);
    const env = await assistantEnv({ orgId: "org_1", deploymentId: "dep_1" });
    expect(env).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(env.EDEN_ASSISTANT_MODEL).toBe("codex/conn_1/gpt-5.5");
    expect(env.EDEN_MODEL_GATEWAY_URL).toContain("/api/gateway/v1");
    expect(verifyGatewayToken(env.EDEN_MODEL_GATEWAY_TOKEN)).toBe("org_1");
  });

  it("also injects the gateway env alongside an OpenRouter key when a Codex connection exists", async () => {
    getWorkspaceModelKey.mockResolvedValue("sk-or-workspace");
    getWorkspaceAssistantModel.mockResolvedValue(null);
    hasActiveCodexConnection.mockResolvedValue(true);
    const env = await assistantEnv({ orgId: "org_1", deploymentId: "dep_1" });
    expect(env.OPENROUTER_API_KEY).toBe("sk-or-workspace");
    expect(env.EDEN_MODEL_GATEWAY_TOKEN).toBeTruthy();
  });

  it("throws when there is neither an OpenRouter key nor a codex model on a Codex connection", async () => {
    getWorkspaceModelKey.mockResolvedValue(null);
    getWorkspaceAssistantModel.mockResolvedValue(null); // default is an OpenRouter id
    hasActiveCodexConnection.mockResolvedValue(false);
    await expect(
      assistantEnv({ orgId: "org_1", deploymentId: "dep_1" }),
    ).rejects.toThrow(/OpenRouter key/);
  });
});
