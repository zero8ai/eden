/**
 * Assistant streaming turn (resource route, action only). Project-level sibling of the playground
 * stream route: the Assistant page POSTs a message here and reads back the same NDJSON turn
 * stream. Differences from the playground route: the target is the project's built-in assistant
 * instance (`ensureAssistantInstance`, not a user deployment), the tenancy guard is project-level
 * (no agent param), and runs are recorded on the "assistant" channel. The disconnect-safe drain
 * itself is the shared `streamTurnResponse` helper.
 */
import { withAuth } from "@workos-inc/authkit-react-router";
import { data, redirect, type ActionFunctionArgs } from "react-router";

import type { Target } from "~/chat/playground.server";
import { asString, streamTurnResponse } from "~/chat/turn-stream.server";
import { ensureAssistantInstance } from "~/assistant/instance.server";
import {
  createPlaygroundSession,
  getPlaygroundSession,
  markPlaygroundSessionRunning,
  titleFromMessage,
  type PlaygroundSession,
} from "~/playground/sessions.server";
import { requireProject, requireRepo } from "~/project/guard.server";

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
            ? (instance.error ?? "The assistant failed to start. Check the deployment logs.")
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

  return streamTurnResponse({
    projectId: project.id,
    target,
    session,
    message,
    channel: "assistant",
    title,
  });
}
