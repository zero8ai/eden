import { useState } from "react";
import { Button } from "~/components/ui/button";

export function TurnError({
  message,
  detail,
  retryable,
  onRetry,
  busy,
}: {
  message: string;
  detail?: string | null;
  retryable?: boolean;
  onRetry?: () => void;
  busy?: boolean;
}) {
  const [showDetail, setShowDetail] = useState(false);
  return (
    <div className="space-y-2">
      <p className="whitespace-pre-wrap text-destructive">{message}</p>
      {(detail || (retryable && onRetry)) && (
        <div className="flex flex-wrap items-center gap-3">
          {retryable && onRetry && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRetry}
              disabled={busy}
            >
              Retry
            </Button>
          )}
          {detail && (
            <button
              type="button"
              className="text-xs text-muted-foreground underline underline-offset-2"
              onClick={() => setShowDetail((v) => !v)}
            >
              {showDetail ? "Hide details" : "Show details"}
            </button>
          )}
        </div>
      )}
      {showDetail && detail && (
        <pre className="overflow-x-auto rounded-lg bg-muted/50 p-3 font-mono text-xs text-muted-foreground">
          {detail}
        </pre>
      )}
    </div>
  );
}
