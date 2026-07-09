/**
 * Discord send proxy logic (issue #32). The `discord-send-message` tool can't hold the shared
 * bot token (it acts across every connected server), so it POSTs to the control plane, which
 * sends on its behalf — but ONLY to channels in servers the calling agent is actually connected
 * to. The payload validation and the guild-scoping decision live here, pure and injectable, so
 * the route stays thin (mirrors how team-ask splits the route from `ask.server.ts`).
 */

/** Discord message content cap the tool advertises (keep in lockstep with its zod schema). */
export const DISCORD_MESSAGE_MAX = 1900;

export type SendPayload = { channelId: string; message: string };

export type ValidatedSend =
  { ok: true; value: SendPayload } | { ok: false; error: string };

/** Validate the proxy body: non-empty channelId + message, message within the length cap. */
export function validateSendPayload(body: unknown): ValidatedSend {
  const b = body as { channelId?: unknown; message?: unknown } | null;
  const channelId = typeof b?.channelId === "string" ? b.channelId.trim() : "";
  const message = typeof b?.message === "string" ? b.message : "";
  if (!channelId) return { ok: false, error: "channelId is required." };
  if (!message.trim()) return { ok: false, error: "message is empty." };
  if (message.length > DISCORD_MESSAGE_MAX) {
    return {
      ok: false,
      error: `message exceeds ${DISCORD_MESSAGE_MAX} characters.`,
    };
  }
  return { ok: true, value: { channelId, message } };
}

/**
 * Guild-scoping decision: the channel's guild must be one the agent is connected to. Confines
 * the shared bot token to servers the calling agent actually reaches — a channel in any other
 * server (another tenant's) is refused.
 */
export function isGuildAllowed(
  channelGuildId: string | null,
  connectedGuildIds: readonly string[],
): boolean {
  if (!channelGuildId) return false;
  return connectedGuildIds.includes(channelGuildId);
}
