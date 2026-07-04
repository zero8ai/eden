/**
 * Embedded authoring assistant (Author pillar, PRD §7.2 / D4) — a persistent CONVERSATION,
 * not a request form. Each user message runs the authoring agent (assistant/agent.server.ts)
 * with the conversation's model-level history, so follow-ups build on earlier turns. The
 * transcript + history persist server-side (chat/conversation.server.ts): navigate away and
 * back and it's still here; idle for 24h and it starts fresh. One conversation per user per
 * project — no session management.
 */
import { authkitLoader, withAuth } from "@workos-inc/authkit-react-router";
import { Link, redirect, useFetcher, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";

import { runAuthoringAgent, type ChatMessage } from "~/assistant/agent.server";
import {
  loadConversation,
  resetConversation,
  saveConversation,
} from "~/chat/conversation.server";
import type { ChatEntry } from "~/chat/types";
import {
  AssistantBubble,
  ChatComposer,
  ChatTranscript,
  PendingBubble,
  UserBubble,
} from "~/components/chat";
import { AgentNav, AppShell, PageHeader } from "~/components/shell";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { newId } from "~/lib/id";
import { requireProject, requireRepo } from "~/project/guard.server";
import type { Route } from "./+types/projects.$projectId.assistant";

interface AssistantState extends Record<string, unknown> {
  history: ChatMessage[];
}

export const loader = (args: LoaderFunctionArgs) =>
  authkitLoader(
    args,
    async ({ auth }) => {
      const project = requireRepo(
        await requireProject(
          {
            user: auth.user,
            organizationId: auth.organizationId,
            role: auth.role,
          },
          args.params.projectId,
        ),
      );
      const conversation = await loadConversation<AssistantState>(
        project.id,
        "assistant",
        auth.user!.id,
        { history: [] },
      );
      return { project, entries: conversation.entries, expired: conversation.expired };
    },
    { ensureSignedIn: true },
  );

export async function action(args: ActionFunctionArgs) {
  const auth = await withAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = requireRepo(
    await requireProject(
      {
        user: auth.user,
        organizationId: auth.organizationId ?? null,
        role: auth.role ?? null,
      },
      args.params.projectId,
    ),
  );

  const form = await args.request.formData();
  if (String(form.get("intent")) === "reset") {
    await resetConversation(project.id, "assistant", auth.user.id);
    return { ok: true as const };
  }

  const message = String(form.get("message") ?? "").trim();
  if (!message) return { error: "Say what you want built." };

  const conversation = await loadConversation<AssistantState>(
    project.id,
    "assistant",
    auth.user.id,
    { history: [] },
  );
  const entries = [...conversation.entries];
  entries.push({ id: newId(), role: "user", text: message });

  try {
    const result = await runAuthoringAgent({
      project,
      instruction: message,
      createdBy: auth.user.id,
      history: conversation.state.history,
    });
    entries.push({
      id: newId(),
      role: "assistant",
      text: result.summary,
      files: result.files,
      secrets: result.secretsNeeded,
      checks: result.checks.ran ? { ran: true, ok: result.checks.ok } : undefined,
    });
    await saveConversation(project.id, "assistant", auth.user.id, entries, {
      history: result.history,
    });
    return { ok: true as const };
  } catch (error) {
    // Persist the user's message + the failure so the conversation stays coherent.
    entries.push({
      id: newId(),
      role: "assistant",
      text: "",
      error: (error as Error).message,
    });
    await saveConversation(project.id, "assistant", auth.user.id, entries, {
      history: conversation.state.history,
    });
    return { ok: true as const };
  }
}

export function meta() {
  return [{ title: "Assistant · Eden" }];
}

export default function Assistant({ loaderData }: Route.ComponentProps) {
  const { project, entries, expired } = loaderData;
  const base = `/projects/${project.id}`;
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const pendingMessage =
    busy && fetcher.formData?.get("intent") !== "reset"
      ? String(fetcher.formData?.get("message") ?? "")
      : null;

  return (
    <AppShell workspaceName={project.name}>
      <PageHeader
        title="Assistant"
        description="Tell it what the agent should be able to do. It writes the code, verifies the build, and stages everything for your review in Changes."
        actions={
          entries.length > 0 ? (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="reset" />
              <Button type="submit" variant="outline" size="sm" disabled={busy}>
                New conversation
              </Button>
            </fetcher.Form>
          ) : undefined
        }
      />
      <AgentNav base={base} />

      {expired && entries.length === 0 && (
        <Alert className="mb-4">
          <AlertDescription>
            Your previous conversation expired after a day of inactivity — starting fresh.
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-4 pb-4">
        <ChatTranscript dep={`${entries.length}:${pendingMessage ?? ""}`}>
          {entries.length === 0 && !pendingMessage && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              e.g. &ldquo;Add a tool that sends a message to our Discord channel.&rdquo;
            </p>
          )}
          {(entries as ChatEntry[]).map((e) =>
            e.role === "user" ? (
              <UserBubble key={e.id} text={e.text} />
            ) : (
              <AssistantEntry key={e.id} entry={e} base={base} />
            ),
          )}
          {pendingMessage && (
            <>
              <UserBubble text={pendingMessage} />
              <PendingBubble label="Working — reading the repo, writing code, verifying the build…" />
            </>
          )}
        </ChatTranscript>

        <ChatComposer
          placeholder="What should the agent be able to do?"
          busy={busy}
          busyLabel="Working…"
          onSend={(message) => fetcher.submit({ message }, { method: "post" })}
        />
      </div>
    </AppShell>
  );
}

function AssistantEntry({ entry, base }: { entry: ChatEntry; base: string }) {
  return (
    <AssistantBubble>
      {entry.error ? (
        <p className="whitespace-pre-wrap text-destructive">{entry.error}</p>
      ) : (
        <p className="whitespace-pre-wrap">{entry.text}</p>
      )}

      {entry.checks && (
        <p className="mt-2">
          <Badge variant={entry.checks.ok ? "secondary" : "destructive"} className="text-xs">
            {entry.checks.ok ? "checks passed" : "checks failed"}
          </Badge>
        </p>
      )}

      {entry.files && entry.files.length > 0 && (
        <div className="mt-2 space-y-1 border-t pt-2 text-xs">
          <p className="font-medium text-muted-foreground">Staged files</p>
          <ul className="space-y-0.5">
            {entry.files.map((f) => (
              <li key={f}>
                <Link
                  to={`${base}/edit?path=${encodeURIComponent(f)}`}
                  className="font-mono underline-offset-4 hover:underline"
                >
                  {f}
                </Link>
              </li>
            ))}
          </ul>
          <p>
            <Link to={`${base}/changes`} className="font-medium underline underline-offset-4">
              Review &amp; publish in Changes →
            </Link>
          </p>
        </div>
      )}

      {entry.secrets && entry.secrets.length > 0 && (
        <p className="mt-2 text-xs">
          Secrets to set:{" "}
          {entry.secrets.map((s) => (
            <Badge key={s} variant="secondary" className="mr-1 font-mono">
              {s}
            </Badge>
          ))}
          <Link to={`${base}/secrets`} className="underline underline-offset-4">
            open Secrets →
          </Link>
        </p>
      )}
    </AssistantBubble>
  );
}
