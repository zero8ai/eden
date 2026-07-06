/**
 * Teammate delegation relay (Team delegation — D1/§2). A team member's `ask-teammate` tool POSTs
 * `{ teammate, message }` here with its `EDEN_TEAM_TOKEN`; the route verifies the token to a
 * deployment id and hands that plus the body to `runAsk`. Everything else — caller resolution,
 * authorization, concurrency caps, target env/deployment resolution, the eve turn, run recording,
 * and the correlation row — lives here so the flow is unit-testable against an injected store +
 * `sendTurn` + recorders, with zero I/O.
 *
 * Business failures the model should read (no permission, no live peer, caps hit, the peer parked
 * on a question) come back as `{ ok: false, error }` — the ROUTE returns those with HTTP 200 so
 * the tool surfaces the text. Only a bad token is a 401, and that check is the route's.
 */
import type { TurnResult } from "~/agent/talk.server";
import { sendTurn } from "~/agent/talk.server";
import type { DataStore } from "~/data/ports";
import {
  externalRunId,
  recordTurnFinish,
  recordTurnStart,
} from "~/observability/record.server";
import { getRunIdByExternal } from "~/observability/store.server";
import { getRuntime } from "~/seams/index.server";

/** Default relay/peer-turn budget; the tool's fetch adds 60s of slack on top. */
export const DEFAULT_DELEGATION_TIMEOUT_MS = 600_000;
/** Slack added to the timeout when deciding whether a `running` row is stale (crash guard). */
const STALE_SLACK_MS = 60_000;
/** Max active delegations on one directed edge, and across a whole project. */
const EDGE_CAP = 3;
const PROJECT_CAP = 10;
/** Reject messages larger than this (bytes) before opening a peer session. */
const MAX_MESSAGE_BYTES = 100_000;

export function delegationTimeoutMs(): number {
  const raw = Number(process.env.EDEN_DELEGATION_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DELEGATION_TIMEOUT_MS;
}

export interface AskDeps {
  store: DataStore;
  /** eve client (blocking) — injected so tests need no running instance. */
  sendTurn: typeof sendTurn;
  recordStart: typeof recordTurnStart;
  recordFinish: typeof recordTurnFinish;
  resolveRunId: (projectId: string, externalRunId: string) => Promise<string | null>;
  now: () => Date;
  timeoutMs: number;
}

export function defaultAskDeps(): AskDeps {
  return {
    store: getRuntime().data,
    sendTurn,
    recordStart: recordTurnStart,
    recordFinish: recordTurnFinish,
    resolveRunId: getRunIdByExternal,
    now: () => new Date(),
    timeoutMs: delegationTimeoutMs(),
  };
}

export interface AskInput {
  /** The caller deployment id the token authenticated (route-verified). */
  deploymentId: string;
  teammate: string;
  message: string;
}

export type AskResult =
  | {
      ok: true;
      reply: string | null;
      teammate: string;
      sessionId: string | null;
      runId: string | null;
      runPath: string | null;
    }
  | { ok: false; error: string };

function deny(error: string): AskResult {
  return { ok: false, error };
}

/** The peer member's run path (teams only reach the relay, so this is always member-scoped). */
function runPathFor(projectId: string, agentName: string, runId: string): string {
  return `/repos/${projectId}/agents/${encodeURIComponent(agentName)}/runs/${runId}`;
}

export async function runAsk(input: AskInput, deps: AskDeps): Promise<AskResult> {
  const { store } = deps;

  const teammate = input.teammate?.trim();
  const message = input.message ?? "";
  if (!teammate) return deny("Name the teammate to ask.");
  if (!message.trim()) return deny("The message to your teammate is empty.");
  if (Buffer.byteLength(message, "utf8") > MAX_MESSAGE_BYTES) {
    return deny("Your message is too long — keep a delegated request under 100KB.");
  }

  // 1. Resolve the caller from the token's deployment: deployment → env → agent → project.
  const deployment = await store.deployments.findById(input.deploymentId);
  if (!deployment) return deny("Your deployment is no longer known to Eden.");
  const callerEnv = await store.environments.findById(deployment.environmentId);
  if (!callerEnv) return deny("Your environment is no longer known to Eden.");
  const caller = await store.agents.findById(callerEnv.agentId);
  if (!caller) return deny("Your agent is no longer part of this repository.");
  const project = await store.projects.findById(caller.projectId);
  if (!project) return deny("This repository is no longer connected.");

  // 2. Resolve the target member by (project, name). Only real roster members are delegation
  //    targets — the built-in assistant (kind !== 'member') is never a teammate.
  const roster = (await store.agents.listByProject(project.id)).filter(
    (a) => a.kind === "member",
  );
  const target = roster.find((a) => a.name === teammate);
  if (!target) return deny(`No teammate named "${teammate}" is on this team.`);
  if (target.id === caller.id) return deny("You can't delegate a task to yourself.");

  // 3. Authorization — default-allow: only a disabled override row blocks the ask.
  const link = await store.agentLinks.get(caller.id, target.id);
  if (link && !link.enabled) {
    return deny(`You're not permitted to ask "${teammate}". Ask a human to enable it in Settings.`);
  }

  // 4. Concurrency caps — count only `running` rows younger than the timeout (+ slack), so a
  //    crashed relay can never wedge the caps.
  const since = new Date(deps.now().getTime() - (deps.timeoutMs + STALE_SLACK_MS));
  const [edgeActive, projectActive] = await Promise.all([
    store.delegations.countActiveEdge(caller.id, target.id, since),
    store.delegations.countActiveProject(project.id, since),
  ]);
  if (edgeActive >= EDGE_CAP) {
    return deny(`Too many in-flight asks to "${teammate}" already — wait for one to finish.`);
  }
  if (projectActive >= PROJECT_CAP) {
    return deny("This team already has too many delegations in flight — try again shortly.");
  }

  // 5. Target env = the peer's environment with the SAME NAME as the caller's (ship-fan-out
  //    convention). 6. It must have a live deployment with a reachable url.
  const targetEnvs = await store.environments.listByAgent(target.id);
  const targetEnv = targetEnvs.find((e) => e.name === callerEnv.name);
  if (!targetEnv) {
    return deny(
      `"${teammate}" has no "${callerEnv.name}" environment to reach — its environments differ from yours.`,
    );
  }
  const targetDeployments = await store.deployments.listByEnvironment(targetEnv.id);
  const live = targetDeployments.find((d) => d.status === "live" && d.url);
  if (!live || !live.url) {
    const everDeployed = targetDeployments.length > 0;
    return deny(
      everDeployed
        ? `"${teammate}" has no live deployment in "${callerEnv.name}" right now — it needs to be deployed and running.`
        : `"${teammate}" has never been deployed to "${callerEnv.name}" — deploy it before delegating.`,
    );
  }

  // 7. Open the correlation record (running), then run the peer turn.
  const delegation = await store.delegations.insert({
    projectId: project.id,
    fromAgentId: caller.id,
    fromEnvironmentId: callerEnv.id,
    toAgentId: target.id,
    toEnvironmentId: targetEnv.id,
  });

  const prefixed = `From your teammate "${caller.name}": ${message}`;
  const startedAt = deps.now();
  let result: TurnResult;
  try {
    result = await deps.sendTurn({
      baseUrl: live.url,
      message: prefixed,
      timeoutMs: deps.timeoutMs,
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await store.delegations.finalize(delegation.id, {
      status: "failed",
      error: detail,
    });
    return deny(`Couldn't reach "${teammate}": ${detail}`);
  }

  // 8. Record the peer's run (channel "teammate", linked-trace metadata). Best-effort — a
  //    recording hiccup must not lose the reply.
  let runId: string | null = null;
  if (result.sessionId && result.turnId) {
    const runExternalId = externalRunId(result.sessionId, result.turnId);
    const runMeta = {
      delegationId: delegation.id,
      fromAgentId: caller.id,
      fromAgentName: caller.name,
    };
    try {
      await deps.recordStart(
        {
          projectId: project.id,
          deploymentId: live.id,
          releaseId: live.releaseId,
          externalRunId: runExternalId,
          externalSessionId: result.sessionId,
          userMessage: prefixed,
          channel: "teammate",
          metadata: runMeta,
        },
        startedAt,
      );
      await deps.recordFinish({
        projectId: project.id,
        deploymentId: live.id,
        releaseId: live.releaseId,
        externalRunId: runExternalId,
        externalSessionId: result.sessionId,
        result,
        userMessage: prefixed,
        channel: "teammate",
        metadata: runMeta,
        startedAt,
        wallClockMs: deps.now().getTime() - startedAt.getTime(),
      });
      runId = await deps.resolveRunId(project.id, runExternalId);
    } catch (error) {
      console.error("[team] recording delegated run failed:", error);
    }
  }

  const runPath = runId ? runPathFor(project.id, target.name, runId) : null;

  // 9. Parked-on-input turns don't compose across a delegation (D5) — surface the request text.
  //    A turn that settled "ok" with NO reply is a failure too: a "successful" delegation with
  //    nothing in it would only confuse the calling model.
  const parked =
    result.inputRequests.length > 0 && (!result.reply || !result.reply.trim());
  const emptyReply = result.ok && !parked && (!result.reply || !result.reply.trim());
  if (parked || emptyReply || !result.ok) {
    const error = parked
      ? `"${teammate}" needs input to continue: ${result.inputRequests[0].prompt}`
      : emptyReply
        ? `"${teammate}" finished without a reply.`
        : (result.error ?? `"${teammate}" couldn't complete the request.`);
    await store.delegations.finalize(delegation.id, {
      status: "failed",
      error,
      externalSessionId: result.sessionId,
      runId,
    });
    return deny(error);
  }

  await store.delegations.finalize(delegation.id, {
    status: "completed",
    externalSessionId: result.sessionId,
    runId,
  });

  return {
    ok: true,
    reply: result.reply,
    teammate: target.name,
    sessionId: result.sessionId,
    runId,
    runPath,
  };
}
