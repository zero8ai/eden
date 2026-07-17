/**
 * Shared error page for the connection connect/callback routes (issue #163). These loaders
 * redirect on success, so the component only ever renders a readable failure. Client-safe (no
 * .server suffix) — it is the routes' render path.
 */
import { Plug } from "lucide-react";
import { Link } from "react-router";

import { AppShell, PageHeader } from "~/components/shell";
import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";

export function ConnectionFlowErrorPage(props: {
  title: string;
  description: string;
  alertTitle: string;
  error: string;
  backUrl: string;
  userEmail: string;
}) {
  return (
    <AppShell userEmail={props.userEmail}>
      <PageHeader
        icon={Plug}
        accent="brand"
        title={props.title}
        description={props.description}
        actions={
          <Button variant="ghost" asChild>
            <Link to={props.backUrl}>← Back</Link>
          </Button>
        }
      />
      <Alert variant="destructive">
        <AlertTitle>{props.alertTitle}</AlertTitle>
        <AlertDescription>{props.error}</AlertDescription>
      </Alert>
    </AppShell>
  );
}
