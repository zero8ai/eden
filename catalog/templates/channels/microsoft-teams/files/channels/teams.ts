import { teamsChannel } from "eve/channels/teams";

// Credentials come from the MICROSOFT_APP_ID / MICROSOFT_APP_PASSWORD environment
// variables, plus MICROSOFT_TENANT_ID for single-tenant bots (set them as agent
// secrets in Eden).
export default teamsChannel();
