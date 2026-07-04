/**
 * Inline model picker for the agent overview: the suggested shortlist + "Custom…" (free-text
 * id). Committing a value calls onCommit — the caller stages the agent.ts draft like every
 * other edit. Extracted from the retired edit-agent page so the one config option lives
 * directly on the overview instead of behind an edit screen.
 */
import { useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { SUGGESTED_MODELS } from "~/eve/agentModule";

const CUSTOM = "__custom";

export function ModelSelect({
  value,
  busy,
  onCommit,
}: {
  /** Current model id (repo or staged draft), or null when agent.ts has none yet. */
  value: string | null;
  /** Disable while the stage request is in flight. */
  busy: boolean;
  onCommit: (model: string) => void;
}) {
  const known = SUGGESTED_MODELS.includes(
    (value ?? "") as (typeof SUGGESTED_MODELS)[number],
  );
  const [customOpen, setCustomOpen] = useState(false);
  const [custom, setCustom] = useState(known || !value ? "" : value);

  const commitCustom = () => {
    const id = custom.trim();
    if (!id) return;
    setCustomOpen(false);
    onCommit(id);
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        // Unknown ids render as the custom sentinel so the trigger still shows something.
        value={known ? (value ?? undefined) : value ? CUSTOM : undefined}
        disabled={busy}
        onValueChange={(v) => {
          if (v === CUSTOM) {
            setCustomOpen(true);
            return;
          }
          setCustomOpen(false);
          onCommit(v);
        }}
      >
        <SelectTrigger className="w-72 font-mono text-sm" aria-label="Model">
          <SelectValue placeholder={busy ? "Saving…" : "Pick a model"}>
            {busy ? "Saving…" : (value ?? undefined)}
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {SUGGESTED_MODELS.map((m) => (
            <SelectItem key={m} value={m} className="font-mono text-sm">
              {m}
            </SelectItem>
          ))}
          <SelectItem value={CUSTOM}>Custom…</SelectItem>
        </SelectContent>
      </Select>
      {customOpen && (
        <div className="flex items-center gap-2">
          <Input
            autoFocus
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitCustom();
              }
            }}
            placeholder="provider/model-id"
            className="w-64 font-mono text-sm"
            aria-label="Custom model id"
          />
          <Button size="sm" variant="secondary" onClick={commitCustom} disabled={busy}>
            Set
          </Button>
        </div>
      )}
    </div>
  );
}
