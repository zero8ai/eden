/**
 * FOH streaming turn (resource route, action only) — the front-of-house sibling of the
 * playground stream route (D20 copy, not a shared refactor). Differences from the playground:
 * the guard is FOH scope (`requireFohProject`, never the BOH-gated `requireProject`), the
 * agent travels as `agentId` (D14 URLs are id-based), a scaled-to-zero agent is WOKEN instead
 * of rejected (§6: opening a session with a stopped agent wakes it), and the supersede rule
 * runs before the turn (`beginFohTurn`: a new message resolves any parked question — eve
 * answers from the next message, so stale inbox items must not linger, D13).
 */
import { getSessionAuth } from "~/auth/session.server";
import { data, redirect, type ActionFunctionArgs } from "react-router";

import { liveTargets } from "~/chat/playground.server";
import { asString, streamTurnResponse } from "~/chat/turn-stream.server";
import { listAgentEnvironments } from "~/db/queries.server";
import { ensureLiveDeploymentForEnvironment } from "~/deploy/wake.server";
import { beginFohTurn } from "~/foh/inbox.server";
import { requireFohProject } from "~/foh/guard.server";
import { signModelDirective } from "~/models/model-directive.server";
import { parseRequestedModelSelection } from "~/models/playground-selection";
import { type ReasoningEffort } from "~/models/reasoning";
import {
  findWorkspaceModel,
  ownsWorkspaceModelReference,
} from "~/models/union.server";
import {
  createPlaygroundSession,
  getFohSessionForViewer,
  loadPlaygroundEntriesFromCache,
  markPlaygroundSessionRunning,
  setPlaygroundSessionModel,
  titleFromMessage,
  unbindPlaygroundSessionForReseed,
  type PlaygroundSession,
} from "~/playground/sessions.server";
import {
  canContinueSessionOnTarget,
  findSessionOwnerTarget,
} from "~/playground/ownership";
import { buildSeedContext } from "~/playground/seed";
import { getRuntime } from "~/seams/index.server";

export async function action(args: ActionFunctionArgs) {
  const auth = await getSessionAuth(args);
  if (!auth.user) throw redirect("/login");
  const access = await requireFohProject(auth, args.params.projectId);
  const project = access.project;

  const form = await args.request.formData();
  const agentId = asString(form.get("agentId"));
  const message = asString(form.get("message")).trim();
  if (!message) throw data({ error: "Type a message first." }, { status: 400 });
  const playgroundSessionId = asString(form.get("playgroundSessionId")) || null;

  const agent = agentId
    ? await getRuntime().data.agents.findById(agentId)
    : null;
  if (!agent || agent.projectId !== project.id || agent.kind !== "member") {
    throw data({ error: "That team member was not found." }, { status: 404 });
  }

  const selection = parseRequestedModelSelection({
    modelId: asString(form.get("modelId")),
    effort: asString(form.get("effort")),
  });
  if (!selection.ok) {
    throw data({ error: selection.error }, { status: 400 });
  }
  const requestedModelId = selection.modelId;
  const requestedEffort = selection.effort;
  const requestedModel = requestedModelId
    ? await findWorkspaceModel(project.orgId, requestedModelId)
    : null;
  if (requestedModelId && !requestedModel) {
    throw data(
      {
        error:
          "That model is not available from an active provider connection in this workspace.",
      },
      { status: 400 },
    );
  }
  if (
    requestedEffort &&
    !requestedModel?.supportedEfforts?.includes(requestedEffort)
  ) {
    throw data(
      { error: "That reasoning effort is not supported by the selected model." },
      { status: 400 },
    );
  }

  let session: PlaygroundSession | null = playgroundSessionId
    ? await getFohSessionForViewer({
        id: playgroundSessionId,
        projectId: project.id,
        agentId: agent.id,
        viewerId: auth.user.id,
        includeAll: access.backOfHouse,
      })
    : null;
  if (playgroundSessionId && !session) {
    throw data({ error: "That conversation was not found." }, { status: 404 });
  }

  // Target resolution with wake-on-open: prefer whatever is live; if nothing is, start a
  // stopped instance (session's environment first) and re-read the live targets — the
  // deployments row now carries the fresh url. Presence ○ agents are messageable by design.
  let targets = await liveTargets(agent.id);
  if (targets.length === 0) {
    const environments = await listAgentEnvironments(agent.id);
    const ordered = session?.environmentId
      ? [
          session.environmentId,
          ...environments
            .map((env) => env.id)
            .filter((id) => id !== session?.environmentId),
        ]
      : environments.map((env) => env.id);
    for (const environmentId of ordered) {
      if (await ensureLiveDeploymentForEnvironment(environmentId)) break;
    }
    targets = await liveTargets(agent.id);
  }
  if (targets.length === 0) {
    throw data(
      {
        error: `"${agent.name}" has no deployment to talk to right now — deploy from back of house first.`,
      },
      { status: 400 },
    );
  }
  const target =
    (session && findSessionOwnerTarget(session, targets)) ??
    targets.find((t) => t.environmentId === session?.environmentId) ??
    targets[0];

  const effectiveModel = requestedModelId ?? session?.modelId ?? null;
  const effectiveEffort = requestedModelId
    ? requestedEffort
    : ((session?.effort as ReasoningEffort | null) ?? null);
  const effectiveModelOwned = effectiveModel
    ? requestedModelId === effectiveModel
      ? Boolean(requestedModel)
      : await ownsWorkspaceModelReference(project.orgId, effectiveModel)
    : false;
  if (effectiveModel && !effectiveModelOwned) {
    throw data(
      {
        error:
          "This conversation's model is no longer available. Choose a model from an active provider connection.",
      },
      { status: 400 },
    );
  }

  // #71 reseed inherits unchanged: a session whose owning eve session died with a replaced
  // deployment is transparently reseeded from the durable cache on this target.
  let seedContext: string | null = null;
  if (session && !canContinueSessionOnTarget(session, target.deploymentId)) {
    seedContext = buildSeedContext(await loadPlaygroundEntriesFromCache(session));
    session = await unbindPlaygroundSessionForReseed(session);
  }

  const title = session?.title ? null : titleFromMessage(message);
  if (!session) {
    session = await createPlaygroundSession({
      projectId: project.id,
      agentId: agent.id,
      userId: auth.user.id,
      surface: "foh",
      environmentId: target.environmentId,
      deploymentId: target.deploymentId,
      releaseId: target.releaseId,
      version: target.version,
      title,
      modelId: requestedModelId,
      effort: requestedEffort,
    });
  } else {
    if (
      requestedModelId &&
      (requestedModelId !== session.modelId ||
        requestedEffort !== session.effort)
    ) {
      await setPlaygroundSessionModel({
        id: session.id,
        projectId: project.id,
        agentId: agent.id,
        userId: session.createdBy ?? auth.user.id,
        modelId: requestedModelId,
        effort: requestedEffort,
        surface: "foh",
      });
      session = {
        ...session,
        modelId: requestedModelId,
        effort: requestedEffort,
      };
    }
    // Supersede (D13): whatever this turn says, eve resolves any parked ask from it — clear
    // the needs-you park and its inbox items before streaming.
    await beginFohTurn(session.id);
  }
  await markPlaygroundSessionRunning({ id: session.id, target, title });

  const directiveBody = [seedContext, message].filter(Boolean).join("\n\n");
  const directive = effectiveModel
    ? signModelDirective(
        {
          id: effectiveModel,
          contextWindowTokens: requestedModel?.contextWindow ?? undefined,
          effort: effectiveEffort ?? undefined,
        },
        target.deploymentId,
        directiveBody,
      )
    : null;
  // Order matters: the model directive MUST stay the first line of the sent message; the
  // reseed context block (#71), when present, follows it.
  const messagePrefix =
    [directive, seedContext].filter(Boolean).join("\n\n") || null;

  return streamTurnResponse({
    projectId: project.id,
    target,
    session,
    message,
    channel: "foh",
    title,
    messagePrefix,
  });
}
