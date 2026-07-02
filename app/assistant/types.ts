/**
 * The embedded authoring assistant seam (Author pillar, PRD §7.2 / D4).
 *
 * A PM describes a tool in natural language ("look up an order by ID in our Postgres and
 * return its status"); the assistant produces a valid eve `defineTool(...)` TypeScript file
 * plus a plain-language explanation and the secret names it references. The generated file
 * ships through the same git-native PR flow (D3) — the assistant never writes the repo
 * directly.
 *
 * D4 selects the Pi SDK as the intended runtime for rich, multi-file interactive editing
 * against a working-branch checkout. This seam lets that Pi adapter and a one-shot Claude
 * generator (the OSS reference impl) sit behind one interface. Pure types (no server imports).
 */

export interface GenerateToolInput {
  /** The PM's natural-language description of the tool. */
  instruction: string;
  /** When editing an existing tool, its current path + contents for context. */
  existingTool?: { path: string; content: string } | null;
}

export interface GeneratedTool {
  /** Repo-relative path, e.g. `agent/tools/order_lookup.ts`. */
  path: string;
  /** The full `defineTool(...)` TypeScript module. */
  content: string;
  /** Plain-language explanation of what the tool does, for the PM. */
  explanation: string;
  /** Secret names the tool references (set these in the secrets manager). */
  secretsNeeded: string[];
}

export interface AuthoringAssistant {
  readonly name: string;
  generateTool(input: GenerateToolInput): Promise<GeneratedTool>;
}
