/**
 * Stop a running portal turn (issue #180) — the guest-guarded sibling of the playground stop
 * route. Cancels the eve turn on the owning deployment (when still live), aborts the local
 * drain, and settles the session row to `stopped`.
 */
import { data, type ActionFunctionArgs } from "react-router";

import { getSessionAuth } from "~/auth/session.server";
import { liveTargets } from "~/chat/playground.server";
import { asString, cancelActiveTurn } from "~/chat/turn-stream.server";
import {
  getPlaygroundSession,
  markPlaygroundSessionStopped,
} from "~/playground/sessions.server";
import { findSessionOwnerTarget } from "~/playground/ownership";
import { requirePortalBySlug, requirePortalGuest } from "~/portal/guard.server";

export async function action(args: ActionFunctionArgs) {
  const portal = await requirePortalBySlug(args.params.slug);
  const session = await getSessionAuth(args);
  const guest = await requirePortalGuest(session, portal);

  const form = await args.request.formData();
  const portalSessionId = asString(form.get("portalSessionId"));
  if (!portalSessionId) {
    throw data({ error: "No conversation to stop." }, { status: 400 });
  }

  const portalSession = await getPlaygroundSession({
    id: portalSessionId,
    projectId: portal.projectId,
    agentId: portal.agentId,
    userId: guest.userId,
    portalId: portal.id,
  });
  if (!portalSession) {
    throw data({ error: "That conversation was not found." }, { status: 404 });
  }

  const targets = await liveTargets(portal.agentId);
  const target = findSessionOwnerTarget(portalSession, targets);

  // Only ask Eve to cancel while the deployment that RAN the turn is still live (see the
  // playground stop route for why: Eve hangs, not 404s, on unknown sessions).
  if (portalSession.externalSessionId && target) {
    try {
      await fetch(
        `${target.url.replace(/\/+$/, "")}/eve/v1/session/${portalSession.externalSessionId}/cancel`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scope: "turn" }),
          signal: AbortSignal.timeout(5_000),
        },
      );
    } catch {
      // Best-effort: the local abort below still detaches the drain; the loader's
      // abandoned-session settling covers the rest.
    }
  }

  cancelActiveTurn(portalSession.id);
  await markPlaygroundSessionStopped({ id: portalSession.id, target });
  return { ok: true as const };
}
