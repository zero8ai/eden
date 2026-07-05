/**
 * Display transcript entry for Eden's conversational surfaces (assistant, playground).
 * Persisted as jsonb in conversations.messages — keep it JSON-serializable and additive
 * (new optional fields are fine; renames break stored transcripts). Client+server safe.
 */

export interface ChatStep {
  type: string;
  name?: string | null;
  durationMs?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  isError?: boolean;
  code?: string | null;
  message?: string | null;
  details?: string | null;
  /** Primary tool of the step's actions (e.g. "bash", "load_skill"). Additive. */
  toolName?: string | null;
  /** Compacted summary of the primary action — command, skill, or file path. Additive. */
  summary?: string | null;
}

export interface ChatEntry {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** Playground: reply is structured JSON (render as code). */
  structured?: boolean;
  /** Playground: version + model that produced the reply, and the agent's steps. */
  version?: string;
  modelId?: string | null;
  steps?: ChatStep[];
  /** Assistant: files staged, secrets to set, check outcome for this turn. */
  files?: string[];
  secrets?: string[];
  checks?: { ran: boolean; ok: boolean };
  error?: string | null;
}
