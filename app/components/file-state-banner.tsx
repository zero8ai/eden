/**
 * Editor banner for a file's change-lifecycle state (shared by all editors).
 *
 * Editors always show the user's LATEST intended value — a staged draft, or the pending value
 * from an open change request, or the merged repo content. This banner says WHICH of those the
 * form is showing, so "why does this show X?" is always answerable on the page itself.
 */
import { Link } from "react-router";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import type { FileView } from "~/drafts/drafts.server";

export function FileStateBanner({
  saved,
  source,
  change,
  base,
  stagedDeletion = false,
}: {
  /** The just-submitted save succeeded (actionData.ok) — show the staged state. */
  saved: boolean;
  source: FileView["source"];
  change: FileView["change"];
  /** Repository base path, e.g. /repos/:id */
  base: string;
  /** A deletion is staged for this file (the form shows the repo content). */
  stagedDeletion?: boolean;
}) {
  if (stagedDeletion && !saved) {
    return (
      <Alert className="mb-6">
        <AlertTitle>Staged for deletion</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            This file is marked for deletion in your staged changes; the form shows the
            repository content. Saving here replaces the deletion with an edit.
          </span>
          <Link
            to={`${base}/deployment`}
            className="font-medium underline underline-offset-4"
          >
            Review staged changes on the Deployment tab →
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  if (saved || source === "draft") {
    return (
      <Alert className="mb-6">
        <AlertTitle>Staged — not published yet</AlertTitle>
        <AlertDescription className="flex items-center gap-3">
          <span>This file has an unpublished draft; the form shows it.</span>
          <Link
            to={`${base}/deployment`}
            className="font-medium underline underline-offset-4"
          >
            Review &amp; publish on the Deployment tab →
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  if (source === "change-request" && change) {
    return (
      <Alert className="mb-6">
        <AlertTitle>Pending — in change request #{change.number}</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span>
            Showing the unmerged value from &ldquo;{change.title}&rdquo;. Saving here stages
            a new draft on top of it.
          </span>
          <Link
            to={`${base}/deployment`}
            className="font-medium underline underline-offset-4"
          >
            Merge or delete it on the Deployment tab →
          </Link>
        </AlertDescription>
      </Alert>
    );
  }

  return null;
}
