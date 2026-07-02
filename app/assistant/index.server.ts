/**
 * Selects the AuthoringAssistant implementation by `EDEN_ASSISTANT` (default `claude`).
 * `claude` = one-shot Claude generator (OSS reference); `pi` = interactive Pi coding agent (D4).
 */
import { claudeAuthoringAssistant } from "./claude.server";
import { piAuthoringAssistant } from "./pi.server";
import type { AuthoringAssistant } from "./types";

export function getAuthoringAssistant(): AuthoringAssistant {
  return process.env.EDEN_ASSISTANT === "pi"
    ? piAuthoringAssistant
    : claudeAuthoringAssistant;
}
