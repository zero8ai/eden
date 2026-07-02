/**
 * OSS TelemetrySink: upsert normalized run events straight into the runs store. Same code
 * path serves managed (co-located) and BYO (events arrive via the authenticated OTLP ingest
 * route, then land here). One run row per (project, externalRunId) — see PRD §7.6 / ARCH §3.7.
 */
import { db } from "~/db/client.server";
import { runs } from "~/db/schema";
import type { NormalizedRunEvent, TelemetrySink } from "../types";

export const localTelemetrySink: TelemetrySink = {
  name: "local-runs-store",

  async ingest(event: NormalizedRunEvent) {
    const values = {
      projectId: event.projectId,
      deploymentId: event.deploymentId ?? null,
      releaseId: event.releaseId ?? null,
      externalRunId: event.externalRunId,
      channel: event.channel ?? null,
      status: event.status ?? "running",
      tokensInput: event.tokensInput ?? null,
      tokensOutput: event.tokensOutput ?? null,
      wallClockMs: event.wallClockMs ?? null,
      error: event.error ?? null,
      metadata: event.metadata ?? {},
      ...(event.startedAt ? { startedAt: new Date(event.startedAt) } : {}),
      finishedAt: event.finishedAt ? new Date(event.finishedAt) : null,
    };

    await db
      .insert(runs)
      .values(values)
      .onConflictDoUpdate({
        target: [runs.projectId, runs.externalRunId],
        // Only overwrite fields the event actually carried, so partial updates
        // (e.g. a "completed" event after a "running" one) don't null earlier data.
        set: stripUndefined({
          deploymentId: event.deploymentId,
          releaseId: event.releaseId,
          channel: event.channel,
          status: event.status,
          tokensInput: event.tokensInput,
          tokensOutput: event.tokensOutput,
          wallClockMs: event.wallClockMs,
          error: event.error,
          finishedAt: event.finishedAt ? new Date(event.finishedAt) : undefined,
        }),
      });
  },
};

function stripUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined),
  ) as Partial<T>;
}

