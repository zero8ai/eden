/**
 * Playground streaming turn (resource route, action only). The page POSTs a message here and
 * reads back an NDJSON stream of the turn as it runs. The disconnect-safe drain + persistence +
 * recording live in the shared `~/chat/turn-stream.server` helper (used by the assistant surface
 * too); this route only resolves the tenancy-guarded live target + the session row.
 */
import { withAuth } from "@workos-inc/authkit-react-router";
import { data, redirect, type ActionFunctionArgs } from "react-router";

import { liveTargets } from "~/chat/playground.server";
import { asString, streamTurnResponse } from "~/chat/turn-stream.server";
import { findModel } from "~/models/catalog.server";
import { buildModelDirective } from "~/models/model-directive";
import {
  createPlaygroundSession,
  getPlaygroundSession,
  markPlaygroundSessionRunning,
  setPlaygroundSessionModel,
  titleFromMessage,
  type PlaygroundSession,
} from "~/playground/sessions.server";
import {
  resolveAgentContext,
  agentFromParams,
} from "~/project/agent-context.server";
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
  const agentName =
    agentFromParams(args.params) ?? asString(form.get("agentName"));
  const { active } = await resolveAgentContext(project.id, agentName);

  const deploymentId = asString(form.get("deploymentId"));
  const playgroundSessionId = asString(form.get("playgroundSessionId")) || null;
  const message = asString(form.get("message")).trim();
  if (!message) throw data({ error: "Type a message first." }, { status: 400 });
  // The composer's current model selection; absent = keep the session's stored override.
  const requestedModelId = asString(form.get("modelId")).trim() || null;

  // Only talk to live deployments that belong to THIS agent (tenancy guard) — reject with
  // JSON, not a stream, so the client can surface it.
  const targets = await liveTargets(active.id);
  const target = targets.find((t) => t.deploymentId === deploymentId);
  if (!target) {
    throw data(
      {
        error:
          "That deployment isn't live (or isn't part of this agent). Deploy first.",
      },
      { status: 400 },
    );
  }

  let playgroundSession: PlaygroundSession | null = playgroundSessionId
    ? await getPlaygroundSession({
        id: playgroundSessionId,
        projectId: project.id,
        agentId: active.id,
        userId: auth.user.id,
      })
    : null;
  if (playgroundSessionId && !playgroundSession) {
    throw data(
      { error: "That playground session was not found." },
      { status: 404 },
    );
  }
  if (
    playgroundSession?.externalSessionId &&
    playgroundSession.environmentId &&
    playgroundSession.environmentId !== target.environmentId
  ) {
    throw data(
      {
        error:
          "That Eve session belongs to a different environment. Start a new conversation for this deployment.",
      },
      { status: 400 },
    );
  }
  const title = playgroundSession?.title ? null : titleFromMessage(message);
  if (!playgroundSession) {
    playgroundSession = await createPlaygroundSession({
      projectId: project.id,
      agentId: active.id,
      userId: auth.user.id,
      environmentId: target.environmentId,
      deploymentId: target.deploymentId,
      releaseId: target.releaseId,
      version: target.version,
      title,
      modelId: requestedModelId,
    });
  } else if (requestedModelId && requestedModelId !== playgroundSession.modelId) {
    // The selector changed since the last turn — remember it on the conversation.
    await setPlaygroundSessionModel({
      id: playgroundSession.id,
      projectId: project.id,
      agentId: active.id,
      userId: auth.user.id,
      modelId: requestedModelId,
    });
    playgroundSession = { ...playgroundSession, modelId: requestedModelId };
  }
  await markPlaygroundSessionRunning({ id: playgroundSession.id, target, title });

  // A model override travels as one machine-readable line prepended to the SENT message (eve's
  // session API has no per-turn model field); the deployed agent's dynamic-model resolver reads
  // it, and every display surface strips it. The catalog lookup supplies the model's context
  // window; when the catalog is unreachable the directive simply omits it.
  const effectiveModel = requestedModelId ?? playgroundSession.modelId;
  const messagePrefix = effectiveModel
    ? buildModelDirective({
        id: effectiveModel,
        contextWindowTokens: (await findModel(effectiveModel))?.contextWindow ?? undefined,
      })
    : null;

  return streamTurnResponse({
    projectId: project.id,
    target,
    session: playgroundSession,
    message,
    channel: "playground",
    title,
    messagePrefix,
  });
}
