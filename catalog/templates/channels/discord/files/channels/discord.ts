import {
  discordChannel,
  discordContinuationToken,
  renderInputRequestComponents,
  splitDiscordMessageContent,
} from "eve/channels/discord";

// DISCORD_APPLICATION_ID and DISCORD_PUBLIC_KEY are provisioned automatically by Eden at
// deploy from the installation's shared Discord app — no need to set them yourself. No bot
// token is provided to the instance: the shared token stays on the control plane, and
// interaction replies use the interaction token, so the channel works without it.
export default discordChannel({
  events: {
    // Work around eve anchoring the continuation token to the session's first posted message
    // while Discord component and modal answers route by the clicked message id. Remove this
    // override once eve re-keys input requests upstream. Each post replaces the token, so only
    // the latest question routes; older superseded buttons remain stale. If one event contains
    // multiple requests, only the last posted request routes.
    async "input.requested"(event, channel) {
      for (const request of event.requests) {
        const content =
          splitDiscordMessageContent(request.prompt)[0] ?? request.prompt;
        const posted = await channel.discord.post({
          components: renderInputRequestComponents(request),
          content,
        });

        if (posted.id && channel.discord.channelId) {
          channel.setContinuationToken(
            discordContinuationToken(channel.discord.channelId, posted.id),
          );
        }
      }
    },
  },
});
