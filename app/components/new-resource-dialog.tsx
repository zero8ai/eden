/**
 * "New tool / skill / …" — the create flow from the Overview cards. Asks for just a name,
 * derives the file path (agent/<category>/<slug>.<ext>), and opens the editor, which starts
 * from that category's starter template. Nothing is staged until the user saves.
 */
import {
  CalendarClock,
  Hash,
  Plug,
  Sparkles,
  Workflow,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

import { accentChip, type Accent } from "~/components/shell";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "~/components/ui/dialog";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import {
  resourcePath,
  slugifyResourceName,
  type ResourceKind,
} from "~/eve/templates";
import { cn } from "~/lib/utils";

/**
 * Per-resource-kind signature glyph + accent, mirroring the marketplace type colours so a
 * "New tool/skill/…" dialog is recognisable at a glance (tool=blue, skill=amber, subagent=
 * fuchsia, channel=emerald, connection=cyan, schedule=amber — the schedule identity).
 */
const KIND_META: Record<ResourceKind["key"], { icon: LucideIcon; accent: Accent }> = {
  tools: { icon: Wrench, accent: "blue" },
  skills: { icon: Sparkles, accent: "amber" },
  subagents: { icon: Workflow, accent: "fuchsia" },
  channels: { icon: Hash, accent: "emerald" },
  schedules: { icon: CalendarClock, accent: "amber" },
  connections: { icon: Plug, accent: "cyan" },
};

export function NewResourceDialog({
  kind,
  base,
  root = "agent",
}: {
  kind: ResourceKind;
  /** Repository base path, e.g. /repos/:id */
  base: string;
  /** Active agent root ("agent" or "agents/<member>/agent") the file is created under. */
  root?: string;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const slug = slugifyResourceName(name);
  const meta = KIND_META[kind.key];
  const Icon = meta.icon;

  const create = () => {
    if (!slug) return;
    setOpen(false);
    setName("");
    navigate(`${base}/edit?path=${encodeURIComponent(resourcePath(kind, slug, root))}`);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm">
          New
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span
              className={cn(
                "flex size-7 items-center justify-center rounded-lg",
                accentChip[meta.accent],
              )}
            >
              <Icon className="size-4" aria-hidden />
            </span>
            New {kind.label}
          </DialogTitle>
          <DialogDescription>{kind.hint}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor={`new-${kind.key}-name`}>Name</Label>
          <Input
            id={`new-${kind.key}-name`}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                create();
              }
            }}
            placeholder={`My ${kind.label}`}
            autoFocus
          />
          <p className="text-xs text-muted-foreground">
            {slug ? (
              <>
                Creates <span className="font-mono">{resourcePath(kind, slug, root)}</span>
              </>
            ) : (
              "Names become kebab-case file names."
            )}
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={create} disabled={!slug}>
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
