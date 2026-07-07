/**
 * Confirmation for destructive actions — the one pattern for "are you sure?" across the app
 * (never window.confirm: it blocks the main thread, can't be styled, and breaks automation).
 * Wraps shadcn's AlertDialog; the caller supplies the trigger and what confirming does.
 */
import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "~/components/ui/alert-dialog";

export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  onConfirm,
  open,
  onOpenChange,
  variant = "destructive",
}: {
  /** The button that opens the dialog (rendered as-is via asChild). Omit when controlled. */
  trigger?: ReactNode;
  title: string;
  description: string;
  /** Label for the confirming action, e.g. "Delete" or "Deploy". */
  confirmLabel: string;
  onConfirm: () => void;
  /** Controlled mode — for callers that open the dialog from a menu item, not a trigger. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Confirm-button weight: destructive (default) for deletions, default for safe actions. */
  variant?: "destructive" | "default";
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {trigger && <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            {variant === "destructive" && (
              <span
                className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-rose-500/10 text-rose-600 ring-1 ring-rose-500/20 dark:text-rose-400"
                aria-hidden
              >
                <TriangleAlert className="size-4" />
              </span>
            )}
            {title}
          </AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            className={
              variant === "destructive"
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/90"
                : undefined
            }
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
