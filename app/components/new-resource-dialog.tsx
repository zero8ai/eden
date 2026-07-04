/**
 * "New tool / skill / …" — the create flow from the Overview cards. Asks for just a name,
 * derives the file path (agent/<category>/<slug>.<ext>), and opens the editor, which starts
 * from that category's starter template. Nothing is staged until the user saves.
 */
import { useState } from "react";
import { useNavigate } from "react-router";

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

export function NewResourceDialog({
  kind,
  base,
  root = "agent",
}: {
  kind: ResourceKind;
  /** Project base path, e.g. /projects/:id */
  base: string;
  /** Active agent root ("agent" or "agents/<member>/agent") the file is created under. */
  root?: string;
}) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const slug = slugifyResourceName(name);

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
          <DialogTitle>New {kind.label}</DialogTitle>
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
