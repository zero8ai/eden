import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  discordRunStart: vi.fn(),
  fetch: vi.fn(),
  recordTurnFailure: vi.fn(),
  recordTurnStart: vi.fn(),
  resolveRelayTarget: vi.fn(),
  verifyDiscordSignature: vi.fn(),
}));

vi.mock("~/discord/config.server", () => ({
  getDiscordAppConfig: () => ({ publicKey: "public-key" }),
}));

vi.mock("~/discord/connect.server", () => ({
  DISCORD_CHANNEL_ROUTE: "/eve/v1/discord",
}));

vi.mock("~/discord/relay.server", () => ({
  defaultRelayDeps: () => ({}),
  discordRunStart: mocks.discordRunStart,
  resolveRelayTarget: mocks.resolveRelayTarget,
  verifyDiscordSignature: mocks.verifyDiscordSignature,
}));

vi.mock("~/observability/record.server", () => ({
  recordTurnFailure: mocks.recordTurnFailure,
  recordTurnStart: mocks.recordTurnStart,
}));

const RUN_START = {
  projectId: "proj_1",
  deploymentId: "dep_1",
  releaseId: "rel_1",
  externalRunId: "discord:interaction_1",
  externalSessionId: "discord:interaction_1",
  userMessage: "Investigate the deploy",
  channel: "discord",
  metadata: { discordInteractionId: "interaction_1" },
};

function request(): Request {
  return new Request("http://localhost/api/discord/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": "signature",
      "x-signature-timestamp": "timestamp",
    },
    body: JSON.stringify({
      id: "interaction_1",
      type: 2,
      guild_id: "guild_1",
      data: { name: "triage" },
    }),
  });
}

function args() {
  const req = request();
  return {
    request: req,
    url: new URL(req.url),
    pattern: "/api/discord/interactions",
    params: {},
    context: {} as never,
  };
}

function responseStatus(value: unknown): number {
  expect(value).toBeInstanceOf(Response);
  if (!(value instanceof Response)) throw new Error("expected a Response");
  return value.status;
}

describe("Discord interactions resource action", () => {
  beforeEach(() => {
    mocks.discordRunStart.mockReset().mockReturnValue(RUN_START);
    mocks.recordTurnFailure.mockReset().mockResolvedValue(undefined);
    mocks.recordTurnStart.mockReset().mockResolvedValue(undefined);
    mocks.resolveRelayTarget.mockReset().mockResolvedValue({
      ok: true,
      url: "http://127.0.0.1:3700",
      deploymentId: "dep_1",
      releaseId: "rel_1",
      connection: { id: "connection_1" },
    });
    mocks.verifyDiscordSignature.mockReset().mockReturnValue(true);
    mocks.fetch.mockReset().mockResolvedValue(
      new Response(JSON.stringify({ type: 5 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", mocks.fetch);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("persists the running row before forwarding and leaves a deferred ACK running", async () => {
    const order: string[] = [];
    mocks.recordTurnStart.mockImplementation(async () => {
      order.push("record");
    });
    mocks.fetch.mockImplementation(async () => {
      order.push("forward");
      return new Response(JSON.stringify({ type: 5 }), { status: 200 });
    });
    const { action } = await import("~/routes/api.discord.interactions");

    const response = await action(args());

    expect(order).toEqual(["record", "forward"]);
    expect(mocks.recordTurnStart).toHaveBeenCalledWith(RUN_START);
    expect(mocks.recordTurnFailure).not.toHaveBeenCalled();
    expect(responseStatus(response)).toBe(200);
  });

  it("bounds a stalled start write so forwarding retains the Discord deadline", async () => {
    vi.useFakeTimers();
    mocks.recordTurnStart.mockReturnValue(new Promise(() => undefined));
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { action, DISCORD_ACTION_BUDGET_MS, RUN_START_RECORD_BUDGET_MS } =
      await import("~/routes/api.discord.interactions");

    const operation = action(args());
    await vi.advanceTimersByTimeAsync(RUN_START_RECORD_BUDGET_MS);
    const response = await operation;

    expect(mocks.fetch).toHaveBeenCalledOnce();
    const fetchBudget = timeout.mock.calls[0][0];
    expect(fetchBudget).toBeGreaterThan(0);
    expect(fetchBudget).toBeLessThanOrEqual(
      DISCORD_ACTION_BUDGET_MS - RUN_START_RECORD_BUDGET_MS,
    );
    expect(responseStatus(response)).toBe(200);
  });

  it("settles a command as failed when the deployment rejects the forward", async () => {
    mocks.fetch.mockResolvedValue(
      new Response("rejected", {
        status: 503,
        headers: { "content-type": "text/plain" },
      }),
    );
    const { action } = await import("~/routes/api.discord.interactions");

    const response = await action(args());

    expect(responseStatus(response)).toBe(503);
    expect(mocks.recordTurnFailure).toHaveBeenCalledWith({
      ...RUN_START,
      error: expect.stringContaining("HTTP 503"),
      startedAt: expect.any(Date),
    });
  });

  it("settles a command as failed when the deployment cannot be reached", async () => {
    mocks.fetch.mockRejectedValue(new Error("connection refused"));
    const { action } = await import("~/routes/api.discord.interactions");

    const response = await action(args());

    expect(response).toMatchObject({ init: { status: 504 } });
    expect(mocks.recordTurnFailure).toHaveBeenCalledWith({
      ...RUN_START,
      error: expect.stringMatching(/could not reach/i),
      startedAt: expect.any(Date),
    });
  });

  it("does not fail a possibly accepted turn when only the 2xx ACK body is interrupted", async () => {
    const accepted = new Response(JSON.stringify({ type: 5 }), { status: 200 });
    vi.spyOn(accepted, "text").mockRejectedValue(new Error("body interrupted"));
    mocks.fetch.mockResolvedValue(accepted);
    const { action } = await import("~/routes/api.discord.interactions");

    const response = await action(args());

    expect(response).toMatchObject({ init: { status: 504 } });
    expect(mocks.recordTurnFailure).not.toHaveBeenCalled();
  });
});
