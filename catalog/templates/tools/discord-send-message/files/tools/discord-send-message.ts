import { sendDiscordChannelMessage } from "eve/channels/discord";
import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description:
    "Send a message to a Discord channel by channel id. Use this when the user asks you to notify or update Discord.",
  inputSchema: z.object({
    channelId: z
      .string()
      .min(1)
      .describe("Discord channel id to send the message to."),
    message: z
      .string()
      .min(1)
      .max(1900)
      .describe("Plain text message to send. Keep it concise."),
  }),
  async execute({ channelId, message }) {
    const botToken = process.env.DISCORD_BOT_TOKEN;
    if (!botToken) {
      return {
        ok: false,
        error: "DISCORD_BOT_TOKEN is not configured.",
      };
    }

    const posted = await sendDiscordChannelMessage({
      channelId,
      credentials: { botToken },
      body: {
        content: message,
        allowed_mentions: { parse: [] },
      },
    });

    return {
      ok: true,
      channelId,
      messageId: posted.id,
    };
  },
});
