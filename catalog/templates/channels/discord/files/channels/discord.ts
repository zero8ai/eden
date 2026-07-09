import { discordChannel } from "eve/channels/discord";

// DISCORD_APPLICATION_ID and DISCORD_PUBLIC_KEY are provisioned automatically by Eden at
// deploy from the installation's shared Discord app — no need to set them yourself. No bot
// token is provided to the instance: the shared token stays on the control plane, and
// interaction replies use the interaction token, so the channel works without it.
export default discordChannel({});
