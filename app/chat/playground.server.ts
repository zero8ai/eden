/**
 * Shared Playground plumbing used by both the page route and the streaming resource route:
 * the conversation kind key, the tenancy-guarded list of live deployments to talk to, and the
 * per-conversation persisted state (which deployment the eve session belongs to). Keeping these
 * in one place means the stream route enforces the exact same "live + belongs to this agent"
 * guard the page always has.
 */
import type { ConversationKind } from "~/chat/conversation.server";
import { listDeployments } from "~/deploy/controller.server";
import { listAgentEnvironments } from "~/db/queries.server";

/** A live deployment this agent can be talked to, tagged with the release it serves. */
export interface Target {
  deploymentId: string;
  releaseId: string;
  url: string;
  version: string;
  environmentName: string;
}

/**
 * Per-conversation persisted state: the deployment the current eve session belongs to (a
 * different deployment doesn't share memory), plus the session id + continuation token.
 */
export interface PlaygroundState extends Record<string, unknown> {
  deploymentId: string | null;
  sessionId: string | null;
  continuationToken: string | null;
}

export const EMPTY_STATE: PlaygroundState = {
  deploymentId: null,
  sessionId: null,
  continuationToken: null,
};

export function playgroundKind(agentId: string): ConversationKind {
  return `playground:${agentId}`;
}

/** Every live deployment belonging to this agent (across its environments). */
export async function liveTargets(agentId: string): Promise<Target[]> {
  const envs = await listAgentEnvironments(agentId);
  const perEnv = await Promise.all(
    envs.map(async (env) => {
      const deployments = await listDeployments(env.id);
      return deployments.flatMap((d) =>
        d.status === "live" && d.url
          ? [
              {
                deploymentId: d.id,
                releaseId: d.releaseId,
                url: d.url,
                version: d.version,
                environmentName: env.name,
              },
            ]
          : [],
      );
    }),
  );
  return perEnv.flat();
}
