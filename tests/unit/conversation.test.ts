/**
 * Conversation persistence semantics — one conversation per (project, kind, user), resumes
 * across visits, expires after idle, resets explicitly. Against the in-memory store.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  IDLE_EXPIRY_MS,
  isExpired,
  loadConversation,
  resetConversation,
  saveConversation,
} from "~/chat/conversation.server";
import type { ChatEntry } from "~/chat/types";
import { makeFakeStore, type FakeStore } from "../fakes/store";

let store: FakeStore;
const PROJECT = "proj_1";
const USER = "user_1";

const entry = (role: "user" | "assistant", text: string): ChatEntry => ({
  id: text,
  role,
  text,
});

beforeEach(() => {
  store = makeFakeStore();
  store.seedProject({ id: PROJECT, orgId: "org_1" });
});

describe("conversations", () => {
  it("resumes across loads (navigate away and back)", async () => {
    await saveConversation(
      PROJECT,
      "assistant",
      USER,
      [entry("user", "hi"), entry("assistant", "hello")],
      { history: [{ role: "user", content: "hi" }] },
      store,
    );
    const loaded = await loadConversation(PROJECT, "assistant", USER, { history: [] }, store);
    expect(loaded.entries).toHaveLength(2);
    expect(loaded.state.history).toHaveLength(1);
    expect(loaded.expired).toBe(false);
  });

  it("is scoped per kind and per user", async () => {
    await saveConversation(PROJECT, "assistant", USER, [entry("user", "a")], {}, store);
    const playground = await loadConversation(PROJECT, "playground", USER, {}, store);
    const otherUser = await loadConversation(PROJECT, "assistant", "user_2", {}, store);
    expect(playground.entries).toHaveLength(0);
    expect(otherUser.entries).toHaveLength(0);
  });

  it("expires after idle: fresh start, flagged so the UI can say so", async () => {
    await saveConversation(PROJECT, "assistant", USER, [entry("user", "old")], {}, store);
    // Age the row past the idle window.
    const row = await store.conversations.get(PROJECT, "assistant", USER);
    await store.conversations.save({
      projectId: PROJECT,
      kind: "assistant",
      createdBy: USER,
      messages: row!.messages,
      state: row!.state,
    });
    const aged = await store.conversations.get(PROJECT, "assistant", USER);
    aged!.updatedAt = new Date(Date.now() - IDLE_EXPIRY_MS - 1000);

    const loaded = await loadConversation(PROJECT, "assistant", USER, {}, store);
    expect(loaded.entries).toHaveLength(0);
    expect(loaded.expired).toBe(true);
  });

  it("reset deletes the conversation outright", async () => {
    await saveConversation(PROJECT, "assistant", USER, [entry("user", "x")], {}, store);
    await resetConversation(PROJECT, "assistant", USER, store);
    const loaded = await loadConversation(PROJECT, "assistant", USER, {}, store);
    expect(loaded.entries).toHaveLength(0);
    expect(loaded.expired).toBe(false);
  });

  it("isExpired is a strict idle-window check", () => {
    const now = new Date();
    expect(isExpired(new Date(now.getTime() - IDLE_EXPIRY_MS + 60_000), now)).toBe(false);
    expect(isExpired(new Date(now.getTime() - IDLE_EXPIRY_MS - 60_000), now)).toBe(true);
  });
});
