/**
 * OSS ModelGateway: no proxy — instances use direct provider keys (BYO), so there is no
 * central metering or spend cap. Managed swaps in a real gateway (LiteLLM-class) that owns
 * keys, meters tokens, and enforces caps (ARCH §3.2) behind the same seam.
 */
import type { ModelGateway } from "../types";

export const directModelGateway: ModelGateway = {
  name: "direct-keys",
  async endpointFor() {
    // No gateway in OSS: the instance talks to providers directly using its own keys.
    return { baseUrl: "", headers: {} };
  },
  async checkBudget() {
    // No central spend control in BYO mode.
    return { allowed: true };
  },
};
