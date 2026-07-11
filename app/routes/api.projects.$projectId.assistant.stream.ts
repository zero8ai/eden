/**
 * Assistant streaming turn (resource route, action only). Project-level sibling of the playground
 * stream route: the Assistant page POSTs a message here and reads back the same NDJSON turn
 * stream. Differences from the playground route: the target is the project's built-in assistant
 * instance (`ensureAssistantInstance`, not a user deployment), the tenancy guard is project-level
 * (no agent param), and runs are recorded on the "assistant" channel. The disconnect-safe drain
 * itself is the shared `streamTurnResponse` helper.
 */
import { getSessionAuth } from "~/auth/session.server";
import { data, redirect, type ActionFunctionArgs } from "react-router";

import type { Target } from "~/chat/playground.server";
import { asString, streamTurnResponse } from "~/chat/turn-stream.server";
import { ensureAssistantInstance } from "~/assistant/instance.server";
import {
  ensureConversationCheckout,
  getCheckoutRow,
} from "~/assistant/checkout-sync.server";
import {
  conversationBranch,
  conversationCheckoutPath,
} from "~/assistant/checkout-sync";
import {
  createPlaygroundSession,
  getPlaygroundSession,
  markPlaygroundSessionRunning,
  titleFromMessage,
  type PlaygroundSession,
} from "~/playground/sessions.server";
import { canContinueSessionOnTarget } from "~/playground/ownership";
import { requireProject, requireRepo } from "~/project/guard.server";

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const project = requireRepo(
    await requireProject(auth, args.params.projectId),
  );
  const form = await args.request.formData();
  const playgroundSessionId = asString(form.get("playgroundSessionId")) || null;
  const message = asString(form.get("message")).trim();
  if (!message) throw data({ error: "Type a message first." }, { status: 400 });

  // Resolve (and if needed provision/wake) the project's assistant instance. A turn requires it
  // live; while it provisions the page shows a setup state and retries — so a non-live status is
  // a JSON error the client surfaces, not a stream.
  const instance = await ensureAssistantInstance(project.id);
  if (instance.status !== "live" || !instance.url) {
    throw data(
      {
        error:
          instance.status === "failed"
            ? (instance.error ??
              "The assistant failed to start. Check the deployment logs.")
            : "Your assistant is still starting — try again in a moment.",
        provisioning: instance.status === "provisioning",
      },
      { status: instance.status === "failed" ? 500 : 409 },
    );
  }

  const target: Target = {
    deploymentId: instance.deploymentId!,
    environmentId: instance.environmentId,
    releaseId: instance.releaseId ?? "",
    url: instance.url,
    version: instance.version ?? "assistant",
    environmentName: "assistant",
    gitSha: instance.gitSha ?? "",
  };

  let session: PlaygroundSession | null = playgroundSessionId
    ? await getPlaygroundSession({
        id: playgroundSessionId,
        projectId: project.id,
        agentId: instance.agentId,
        userId: auth.user.id,
      })
    : null;
  if (playgroundSessionId && !session) {
    throw data({ error: "That conversation was not found." }, { status: 404 });
  }
  if (session && !canContinueSessionOnTarget(session, target.deploymentId)) {
    throw data(
      {
        error:
          "This conversation belongs to an assistant instance that was replaced. Start a new conversation to continue.",
      },
      { status: 409 },
    );
  }
  const title = session?.title ? null : titleFromMessage(message);
  if (!session) {
    session = await createPlaygroundSession({
      projectId: project.id,
      agentId: instance.agentId,
      userId: auth.user.id,
      environmentId: target.environmentId,
      deploymentId: target.deploymentId,
      releaseId: target.releaseId,
      version: target.version,
      title,
    });
  }
  await markPlaygroundSessionRunning({ id: session.id, target, title });

  // Coding-agent model: make sure the conversation's git checkout exists on the
  // instance before the turn runs (clone/fetch, recovering from volume loss), and hand the model its
  // checkout path on the first turn plus a note if the base branch advanced. The checkout is on the
  // shared home volume, so the model's sandbox sees the same tree the sync engine later mirrors.
  const firstTurn = !playgroundSessionId;
  const [ensured, checkoutRow] = await Promise.all([
    ensureConversationCheckout({
      conversationId: session.id,
      deploymentId: target.deploymentId,
    }),
    getCheckoutRow(session.id).catch(() => null),
  ]);
  const prefixParts: string[] = [];
  if (firstTurn) {
    prefixParts.push(
      `[Eden] Your working checkout for this conversation is at ${conversationCheckoutPath(session.id)} on branch ${conversationBranch(session.id)}. Do all repo edits there with bash — Eden auto-syncs your changes to a pull request after each turn.`,
    );
  }
  if (ensured.note) prefixParts.push(`[Eden] ${ensured.note}`);
  // Last sync's policy notes: edits Eden stripped or skipped (assistant.json, .ts under
  // .eden/assistant, binary/oversize files, symlinks). Without this the model would believe a
  // stripped edit landed.
  for (const warning of checkoutRow?.warnings ?? []) {
    prefixParts.push(`[Eden] From your last sync: ${warning}`);
  }
  const messagePrefix = prefixParts.length > 0 ? prefixParts.join("\n") : null;

  return streamTurnResponse({
    projectId: project.id,
    target,
    session,
    message,
    channel: "assistant",
    title,
    messagePrefix,
  });
}
