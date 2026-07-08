import { connectSlackCredentials } from "@vercel/connect/eve";
import { slackChannel } from "eve/channels/slack";

// Slack credentials are brokered by a Vercel Connect connector, not raw env
// secrets: connectSlackCredentials resolves a fresh bot token (rotation, refresh,
// and inbound webhook verification handled server-side) from the connector UID in
// SLACK_CONNECTOR (e.g. "slack/my-agent"). Provision the connector with the Vercel
// Connect CLI — see this template's setup notes.
const connector = process.env.SLACK_CONNECTOR;
if (!connector) {
  throw new Error(
    "SLACK_CONNECTOR is not set — provision a Vercel Connect Slack connector and set its UID as a secret. See this channel's setup notes.",
  );
}

export default slackChannel({
  credentials: connectSlackCredentials(connector),
});
