import { twilioChannel } from "eve/channels/twilio";

// Account credentials come from the TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN
// environment variables. The numbers are read from env too, so you don't edit
// this file: TWILIO_ALLOW_FROM is who may reach the agent (comma-separated for
// several, "*" for anyone), TWILIO_FROM_NUMBER is what it sends from. Set all
// four as agent secrets in Eden.
const allowFrom = (process.env.TWILIO_ALLOW_FROM ?? "")
  .split(",")
  .map((n) => n.trim())
  .filter(Boolean);

export default twilioChannel({
  allowFrom: allowFrom.includes("*") ? "*" : allowFrom,
  messaging: { from: process.env.TWILIO_FROM_NUMBER },
});
