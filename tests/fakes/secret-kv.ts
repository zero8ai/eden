/**
 * In-memory SecretKVStore for unit-testing the local SecretsProvider without Postgres.
 * Models scope-exact keying (agentId null == shared, env null == agent-wide) and the resolve
 * ordering (shared-wide → shared-env → agent-wide → agent-env) the provider relies on for the
 * §5 precedence. `attach(agentId, key)` seeds an attachment so precedence-with-sharing is testable.
 */
import type { SecretRef } from "~/seams/types";
import type { ScopedSealed, SecretKVStore, SecretMeta } from "~/seams/oss/secret-store";
import type { SealedSecret } from "~/seams/oss/secretbox";

const k = (ref: { projectId: string; agentId: string | null; environmentId: string | null; key: string }) =>
  `${ref.projectId}|${ref.agentId ?? ""}|${ref.environmentId ?? ""}|${ref.key}`;

export interface FakeSecretKV extends SecretKVStore {
  /** Opt a member into a shared (agentId null) secret name — models `secret_attachments`. */
  attach(agentId: string, key: string): void;
  detach(agentId: string, key: string): void;
  meta(ref: SecretRef): SecretMeta | undefined;
}

export function makeFakeSecretKV(): FakeSecretKV {
  const rows = new Map<string, { ref: SecretRef; sealed: SealedSecret; meta?: SecretMeta }>();
  const attachments = new Set<string>(); // `${agentId}|${key}`

  return {
    async upsert(ref, sealed, meta) {
      const prev = rows.get(k(ref));
      const mergedMeta: SecretMeta = {
        fingerprint: meta?.fingerprint ?? prev?.meta?.fingerprint,
        sandboxExposed:
          meta?.sandboxExposed !== undefined ? meta.sandboxExposed : prev?.meta?.sandboxExposed,
        updatedBy: meta?.updatedBy ?? prev?.meta?.updatedBy ?? null,
      };
      rows.set(k(ref), { ref, sealed, meta: mergedMeta });
    },
    async getSealed(ref) {
      return rows.get(k(ref))?.sealed ?? null;
    },
    async delete(ref) {
      rows.delete(k(ref));
    },
    async listKeys(scope) {
      return [...rows.values()]
        .filter(
          (r) =>
            r.ref.projectId === scope.projectId &&
            r.ref.agentId === scope.agentId &&
            r.ref.environmentId === scope.environmentId,
        )
        .map((r) => r.ref.key)
        .sort();
    },
    async listForResolve(scope): Promise<ScopedSealed[]> {
      const all = [...rows.values()].filter((r) => r.ref.projectId === scope.projectId);
      const agentRows = all.filter((r) => r.ref.agentId === scope.agentId);
      const agentWide = agentRows.filter((r) => r.ref.environmentId === null);
      const agentEnv = scope.environmentId
        ? agentRows.filter((r) => r.ref.environmentId === scope.environmentId)
        : [];

      const attachedKeys = new Set(
        [...attachments]
          .filter((a) => a.startsWith(`${scope.agentId}|`))
          .map((a) => a.slice(String(scope.agentId).length + 1)),
      );
      const sharedRows = all.filter(
        (r) => r.ref.agentId === null && attachedKeys.has(r.ref.key),
      );
      const sharedWide = sharedRows.filter((r) => r.ref.environmentId === null);
      const sharedEnv = scope.environmentId
        ? sharedRows.filter((r) => r.ref.environmentId === scope.environmentId)
        : [];

      return [...sharedWide, ...sharedEnv, ...agentWide, ...agentEnv].map((r) => ({
        key: r.ref.key,
        environmentId: r.ref.environmentId,
        ...r.sealed,
      }));
    },
    attach(agentId, key) {
      attachments.add(`${agentId}|${key}`);
    },
    detach(agentId, key) {
      attachments.delete(`${agentId}|${key}`);
    },
    meta(ref) {
      return rows.get(k(ref))?.meta;
    },
  };
}
