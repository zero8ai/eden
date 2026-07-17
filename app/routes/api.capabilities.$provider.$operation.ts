/**
 * Generic capability route (issue #166): `POST /api/capabilities/:provider/:operation`. An agent
 * instance's thin per-operation tool POSTs its typed input here with
 * `Authorization: Bearer <EDEN_TEAM_TOKEN>` — the SAME delegation-token auth as the Discord send
 * proxy and #167's token broker (one instance-facing auth story, three consumers). The token
 * authenticates the CALLER DEPLOYMENT; the control plane resolves deployment → environment →
 * agent, then hands off to the framework (capabilities/execute.server.ts): enablement → shape →
 * invariants → execute with the control-plane-held credential → audit. The vendor credential
 * never reaches the instance in any form.
 *
 * Bad token → 401; business outcomes → 200 `{ ok:false, error }` so the tool surfaces the text;
 * vendor/transport failures → 502. Resource route (action only).
 */
import { data, type ActionFunctionArgs } from "react-router";

import { executeCapabilityCall } from "~/capabilities/execute.server";
import { getRuntime } from "~/seams/index.server";
import { verifyDelegationToken } from "~/team/token.server";

export async function action({ request, params }: ActionFunctionArgs) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const deploymentId = token ? verifyDelegationToken(token) : null;
  if (!deploymentId)
    throw data({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return data(
      { ok: false, error: "Send the operation's input as a JSON body." },
      { status: 400 },
    );
  }

  // Resolve the caller from the token's deployment: deployment → env → agent (the exact pattern
  // of the Discord send proxy). Nothing but the deployment id is trusted from the client.
  const store = getRuntime().data;
  const deployment = await store.deployments.findById(deploymentId);
  const env = deployment
    ? await store.environments.findById(deployment.environmentId)
    : null;
  const agent = env ? await store.agents.findById(env.agentId) : null;
  if (!agent) {
    return data(
      { ok: false, error: "Your deployment is no longer known to Eden." },
      { status: 403 },
    );
  }

  const outcome = await executeCapabilityCall({
    provider: params.provider ?? "",
    operation: params.operation ?? "",
    caller: {
      deploymentId,
      agent: {
        id: agent.id,
        projectId: agent.projectId,
        name: agent.name,
        root: agent.root,
      },
    },
    body,
  });
  return data(outcome.body, { status: outcome.status });
}
