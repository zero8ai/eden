/**
 * Portal streaming turn (issue #180; resource route, action only). The public portal page POSTs
 * a message here and reads back the same NDJSON stream as the playground — the turn pipeline
 * (`streamTurnResponse` → drain-and-persist) is reused verbatim. What differs is the door:
 * the guard wants a guest session + live grant (never org membership), the model is pinned by
 * the portal config, the deployment is chosen server-side (guests have no deployment
 * awareness), and the turn passes rate/spend gates first — non-members can invoke the model.
 */
import { data, type ActionFunctionArgs } from "react-router";

import { getSessionAuth } from "~/auth/session.server";
import { liveTargets, type Target } from "~/chat/playground.server";
import { asString, streamTurnResponse } from "~/chat/turn-stream.server";
import { signModelDirective } from "~/models/model-directive.server";
import { findWorkspaceModel } from "~/models/union.server";
import type { ReasoningEffort } from "~/models/reasoning";
import {
  createPlaygroundSession,
  getPlaygroundSession,
  loadPlaygroundEntriesFromCache,
  markPlaygroundSessionRunning,
  titleFromMessage,
  unbindPlaygroundSessionForReseed,
  type PlaygroundSession,
} from "~/playground/sessions.server";
import { canContinueSessionOnTarget } from "~/playground/ownership";
import { buildSeedContext } from "~/playground/seed";
import { requirePortalBySlug, requirePortalGuest } from "~/portal/guard.server";
import { evaluatePortalTurn } from "~/portal/policy";
import {
  portalTurnCounts,
  recordPortalTurn,
  type ChatPortal,
} from "~/portal/portals.server";
import { getRuntime } from "~/seams/index.server";

/** Pick the deployment for a guest turn: session continuity first, else any live target. */
export function pickPortalTarget(
  targets: Target[],
  session: PlaygroundSession | null,
): Target | null {
  if (session?.lastDeploymentId) {
    const owner = targets.find(
      (t) => t.deploymentId === session.lastDeploymentId,
    );
    if (owner) return owner;
  }
  return targets[0] ?? null;
}

export async function action(args: ActionFunctionArgs) {
  const portal = await requirePortalBySlug(args.params.slug);
  const session = await getSessionAuth(args);
  const guest = await requirePortalGuest(session, portal);

  const form = await args.request.formData();
  const portalSessionId = asString(form.get("portalSessionId")) || null;
  const message = asString(form.get("message")).trim();
  if (!message) throw data({ error: "Type a message first." }, { status: 400 });

  // Abuse controls before anything expensive: per-guest hourly rate limit + per-portal cap.
  const counts = await portalTurnCounts({
    portalId: portal.id,
    userId: guest.userId,
  });
  const decision = evaluatePortalTurn({
    guestTurnsLastHour: counts.guestTurnsLastHour,
    turnsPerHour: portal.turnsPerHour,
    portalTurnsLast30d: counts.portalTurnsLast30d,
    monthlyTurnCap: portal.monthlyTurnCap,
  });
  if (!decision.allowed) {
    throw data({ error: decision.error }, { status: decision.status });
  }

  // Tenant-level budget/kill-switch (managed mode) — guests must not bypass the org's caps.
  const project = await getRuntime().data.projects.findById(portal.projectId);
  if (!project) throw data({ error: "Not found" }, { status: 404 });
  const budget = await getRuntime().modelGateway.checkBudget(project.orgId);
  if (!budget.allowed) {
    throw data(
      { error: "This portal is temporarily unavailable." },
      { status: 429 },
    );
  }

  let portalSession: PlaygroundSession | null = portalSessionId
    ? await getPlaygroundSession({
        id: portalSessionId,
        projectId: portal.projectId,
        agentId: portal.agentId,
        userId: guest.userId,
        portalId: portal.id,
      })
    : null;
  if (portalSessionId && !portalSession) {
    throw data({ error: "That conversation was not found." }, { status: 404 });
  }

  const targets = await liveTargets(portal.agentId);
  const target = pickPortalTarget(targets, portalSession);
  if (!target) {
    throw data(
      { error: "This agent is offline right now. Please try again later." },
      { status: 409 },
    );
  }

  // Same cross-redeploy reseed as the playground (#71): a portal conversation routinely
  // outlives the deployment that started it, so continue it on the current target by seeding a
  // fresh eve session from Eden's durable transcript cache.
  let seedContext: string | null = null;
  if (
    portalSession &&
    !canContinueSessionOnTarget(portalSession, target.deploymentId)
  ) {
    seedContext = buildSeedContext(
      await loadPlaygroundEntriesFromCache(portalSession),
    );
    portalSession = await unbindPlaygroundSessionForReseed(portalSession);
  }

  const title = portalSession?.title ? null : titleFromMessage(message);
  if (!portalSession) {
    portalSession = await createPlaygroundSession({
      projectId: portal.projectId,
      agentId: portal.agentId,
      userId: guest.userId,
      portalId: portal.id,
      environmentId: target.environmentId,
      deploymentId: target.deploymentId,
      releaseId: target.releaseId,
      version: target.version,
      title,
      modelId: portal.modelId,
      effort: (portal.effort as ReasoningEffort | null) ?? null,
    });
  }
  await markPlaygroundSessionRunning({ id: portalSession.id, target, title });

  const messagePrefix = await portalMessagePrefix({
    portal,
    orgId: project.orgId,
    deploymentId: target.deploymentId,
    seedContext,
    message,
  });

  // Count the turn once it is actually dispatched (all gates passed).
  await recordPortalTurn({ portalId: portal.id, userId: guest.userId });

  return streamTurnResponse({
    projectId: portal.projectId,
    target,
    session: portalSession,
    message,
    channel: "portal",
    title,
    messagePrefix,
  });
}

/**
 * The signed model directive for the portal's pinned model (+ the reseed context when present).
 * Best-effort: if the pinned model is no longer available from an active provider connection,
 * fall back to the deployed default silently — a guest can't fix a model-availability problem,
 * so failing their turn over it helps nobody.
 */
async function portalMessagePrefix(input: {
  portal: ChatPortal;
  orgId: string;
  deploymentId: string;
  seedContext: string | null;
  message: string;
}): Promise<string | null> {
  const { portal, seedContext } = input;
  let directive: string | null = null;
  if (portal.modelId) {
    const model = await findWorkspaceModel(input.orgId, portal.modelId).catch(
      () => null,
    );
    if (model) {
      const directiveBody = [seedContext, input.message]
        .filter(Boolean)
        .join("\n\n");
      directive = signModelDirective(
        {
          id: portal.modelId,
          contextWindowTokens: model.contextWindow ?? undefined,
          effort: (portal.effort as ReasoningEffort | null) ?? undefined,
        },
        input.deploymentId,
        directiveBody,
      );
    } else {
      console.warn(
        `[portal] pinned model ${portal.modelId} unavailable for portal ${portal.id} — using the deployed default`,
      );
    }
  }
  // Order matters: the model directive must stay the first line of the sent message.
  return [directive, seedContext].filter(Boolean).join("\n\n") || null;
}
