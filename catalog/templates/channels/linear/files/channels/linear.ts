import { linearChannel } from "eve/channels/linear";

// Credentials come from the LINEAR_AGENT_ACCESS_TOKEN / LINEAR_WEBHOOK_SECRET
// environment variables (set them as agent secrets in Eden). Assign an issue to
// the agent, or @mention it, to open an Agent Session.
export default linearChannel({});
