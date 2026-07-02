/**
 * Authenticated runs ingest endpoint (Observe pillar, ARCH §3.7).
 *
 * BYO/self-host instances POST normalized run events here with a per-project ingest token
 * (`Authorization: Bearer edn_...`). Managed instances are co-located but use the same path.
 * Body is Eden's normalized JSON (session + run + steps) — the instance's OTel/event-log
 * exporter maps spans into this shape. Resource route (action only).
 */
import { data, type ActionFunctionArgs } from "react-router";

import { ingestRun, resolveIngestToken, type IngestPayload } from "~/observability/store.server";

export async function action({ request }: ActionFunctionArgs) {
  const auth = request.headers.get("authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const projectId = token ? await resolveIngestToken(token) : null;
  if (!projectId) throw data("unauthorized", { status: 401 });

  let payload: IngestPayload;
  try {
    payload = (await request.json()) as IngestPayload;
  } catch {
    throw data("invalid json", { status: 400 });
  }
  if (!payload.externalRunId) {
    throw data("externalRunId required", { status: 400 });
  }

  await ingestRun(projectId, payload);
  return data({ ok: true });
}
