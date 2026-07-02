/**
 * Pi-backed AuthoringAssistant (D4, PRD §7.2) — the richer, interactive path.
 *
 * The Pi SDK (`@earendil-works/pi-coding-agent`) runs a coding agent with read/write/edit/bash
 * tools scoped to a checkout of the working branch, so its edits become clean PR commits and it
 * can iterate across multiple files and sandbox-test tools. That requires materializing a
 * working-branch checkout on disk (the open "Pi session ↔ working branch" spike) and a sandbox,
 * which the deploy environment provides.
 *
 * This adapter is the seam placeholder for that integration: it satisfies the interface and
 * documents the intended wiring. Until the checkout/sandbox host is available it defers to a
 * clear error; the Claude one-shot generator (claude.server.ts) is the working OSS default.
 */
import type {
  AuthoringAssistant,
  GeneratedTool,
  GenerateToolInput,
} from "./types";

export const piAuthoringAssistant: AuthoringAssistant = {
  name: "pi-coding-agent",

  async generateTool(_input: GenerateToolInput): Promise<GeneratedTool> {
    // Wiring (M1 follow-up): createAgentSession() from @earendil-works/pi-coding-agent over
    // createCodingTools scoped to a working-branch checkout dir → prompt to author the tool →
    // read the changed files back → return as GeneratedTool for the PR flow.
    throw new Error(
      "The Pi authoring assistant needs a working-branch checkout host, which isn't " +
        "configured here. Use EDEN_ASSISTANT=claude for the one-shot generator, or configure " +
        "the Pi workspace (see PRD §7.2 / the Pi-session spike).",
    );
  },
};
