/**
 * Discord send proxy logic (issue #32): payload validation and the guild-scoping decision that
 * confines the shared bot token to servers the calling agent is actually connected to.
 */
import { describe, expect, it } from "vitest";

import {
  DISCORD_MESSAGE_MAX,
  isGuildAllowed,
  validateSendPayload,
} from "~/discord/send.server";

describe("validateSendPayload", () => {
  it("accepts a well-formed body", () => {
    expect(validateSendPayload({ channelId: "c1", message: "hi" })).toEqual({
      ok: true,
      value: { channelId: "c1", message: "hi" },
    });
  });

  it("trims the channel id", () => {
    const r = validateSendPayload({ channelId: "  c1  ", message: "hi" });
    expect(r.ok && r.value.channelId).toBe("c1");
  });

  it("rejects a missing channel id or empty message", () => {
    expect(validateSendPayload({ message: "hi" })).toEqual({
      ok: false,
      error: "channelId is required.",
    });
    expect(validateSendPayload({ channelId: "c1", message: "   " })).toEqual({
      ok: false,
      error: "message is empty.",
    });
  });

  it("rejects an over-length message", () => {
    const r = validateSendPayload({
      channelId: "c1",
      message: "x".repeat(DISCORD_MESSAGE_MAX + 1),
    });
    expect(r.ok).toBe(false);
  });
});

describe("isGuildAllowed", () => {
  it("allows a channel in a connected server", () => {
    expect(isGuildAllowed("g1", ["g0", "g1"])).toBe(true);
  });

  it("refuses an unconnected server and an unknown guild", () => {
    expect(isGuildAllowed("g2", ["g0", "g1"])).toBe(false);
    expect(isGuildAllowed(null, ["g0", "g1"])).toBe(false);
  });
});
