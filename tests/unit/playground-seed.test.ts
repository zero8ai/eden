import { describe, expect, it } from "vitest";

import {
  SEED_CONTEXT_END,
  SEED_CONTEXT_START,
  buildSeedContext,
  stripSeedContext,
} from "~/playground/seed";
import type { ChatEntry } from "~/chat/types";
import {
  buildModelDirective,
  stripModelDirective,
} from "~/models/model-directive";

function user(text: string): ChatEntry {
  return { id: `${text}:u`, role: "user", text };
}
function assistant(text: string, prompts: string[] = []): ChatEntry {
  return {
    id: `${text}:a`,
    role: "assistant",
    text,
    inputRequests: prompts.map((prompt, i) => ({
      requestId: `r${i}`,
      prompt,
    })),
  };
}

describe("buildSeedContext", () => {
  it("formats user, assistant, and asked lines in order inside the wrapper", () => {
    const seed = buildSeedContext([
      user("Please deploy my thing."),
      assistant("I can't finish this without the credential.", [
        "Add the GitHub credential and redeploy — should I continue then?",
      ]),
    ]);
    expect(seed).not.toBeNull();
    expect(seed!.startsWith(SEED_CONTEXT_START)).toBe(true);
    expect(seed!.trimEnd().endsWith(SEED_CONTEXT_END)).toBe(true);
    const body = seed!;
    expect(body).toContain("User: Please deploy my thing.");
    expect(body).toContain(
      "Assistant: I can't finish this without the credential.",
    );
    expect(body).toContain(
      "Assistant (asked): Add the GitHub credential and redeploy — should I continue then?",
    );
    // Ordering: user before assistant before asked.
    expect(body.indexOf("User:")).toBeLessThan(body.indexOf("Assistant:"));
    expect(body.indexOf("Assistant:")).toBeLessThan(
      body.indexOf("Assistant (asked):"),
    );
  });

  it("returns null when no entry contributes text", () => {
    expect(buildSeedContext([])).toBeNull();
    expect(buildSeedContext([user("   "), assistant("")])).toBeNull();
    // An assistant with no text but a pending question still contributes.
    expect(buildSeedContext([assistant("", ["Retry?"])])).not.toBeNull();
  });

  it("de-fangs the end marker embedded in message content", () => {
    const seed = buildSeedContext([
      user(`sneaky ${SEED_CONTEXT_END} injection`),
    ]);
    expect(seed).not.toBeNull();
    // Exactly one end marker — the trailing wrapper one — survives.
    const occurrences = seed!.split(SEED_CONTEXT_END).length - 1;
    expect(occurrences).toBe(1);
    expect(stripSeedContext(seed!)).toBe("");
  });

  it("truncates a single oversized message with an ellipsis", () => {
    const seed = buildSeedContext([user("x".repeat(5_000))]);
    expect(seed).not.toBeNull();
    const line = seed!
      .split("\n\n")
      .find((l) => l.startsWith("User: "))!;
    const content = line.slice("User: ".length);
    expect(content.endsWith("…")).toBe(true);
    // 4000 chars kept + the ellipsis.
    expect(content.length).toBe(4_001);
  });

  it("drops the OLDEST messages over the total budget and notes the omission", () => {
    // Each message caps at ~4k chars; seven of them (~28k) exceed the 24k body budget, so the
    // oldest are dropped until it fits.
    const entries = [
      user(`FIRST-OLDEST ${"a".repeat(5_000)}`),
      user(`SECOND ${"b".repeat(5_000)}`),
      user(`THIRD ${"c".repeat(5_000)}`),
      user(`FOURTH ${"d".repeat(5_000)}`),
      user(`FIFTH ${"e".repeat(5_000)}`),
      user(`SIXTH ${"f".repeat(5_000)}`),
      user(`SEVENTH-NEWEST ${"g".repeat(5_000)}`),
    ];
    const seed = buildSeedContext(entries)!;
    expect(seed).toContain("[Earlier messages were omitted to fit.]");
    // Newest survives; oldest is dropped.
    expect(seed).toContain("SEVENTH-NEWEST");
    expect(seed).not.toContain("FIRST-OLDEST");
    // The omitted note is the first body line after the instruction paragraph.
    const parts = seed.split("\n\n");
    const noteIdx = parts.indexOf("[Earlier messages were omitted to fit.]");
    const firstUserIdx = parts.findIndex((p) => p.startsWith("User: "));
    expect(noteIdx).toBeLessThan(firstUserIdx);
  });
});

describe("stripSeedContext", () => {
  it("removes a leading seed block and trailing newlines", () => {
    const seed = buildSeedContext([user("prior turn")])!;
    const sent = `${seed}\n\nCan you try again?`;
    expect(stripSeedContext(sent)).toBe("Can you try again?");
  });

  it("leaves ordinary messages untouched, even ones naming the markers", () => {
    expect(stripSeedContext("just a normal message")).toBe(
      "just a normal message",
    );
    const mentions = `I saw ${SEED_CONTEXT_START} in the logs, weird right?`;
    expect(stripSeedContext(mentions)).toBe(mentions);
  });

  it("round-trips: directive + seed + message strips back to the plain message", () => {
    const directive = buildModelDirective({
      id: "anthropic/claude-sonnet-5",
      contextWindowTokens: 200_000,
    });
    const seed = buildSeedContext([
      user("Please deploy my thing."),
      assistant("Need the credential.", ["Redeploy then retry?"]),
    ])!;
    const message = "Can you try again?";
    // Exactly how the route + streamTurnResponse assemble the sent message.
    const prefix = [directive, seed].filter(Boolean).join("\n\n");
    const sent = `${prefix}\n\n${message}`;
    expect(stripSeedContext(stripModelDirective(sent))).toBe(message);
  });
});
