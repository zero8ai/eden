/**
 * In-memory SecretKVStore for unit-testing the local SecretsProvider without Postgres.
 * Models scope-exact keying (agent-wide == null environment) and the resolve ordering
 * (agent-wide first, then env-scoped) the provider relies on for overrides.
 */
import type { SecretRef } from "~/seams/types";
import type { ScopedSealed, SecretKVStore } from "~/seams/oss/secret-store";
import type { SealedSecret } from "~/seams/oss/secretbox";

const k = (ref: SecretRef) => `${ref.agentId}|${ref.environmentId ?? ""}|${ref.key}`;

export function makeFakeSecretKV(): SecretKVStore {
  const rows = new Map<string, { ref: SecretRef; sealed: SealedSecret }>();
  return {
    async upsert(ref, sealed) {
      rows.set(k(ref), { ref, sealed });
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
            r.ref.agentId === scope.agentId &&
            r.ref.environmentId === scope.environmentId,
        )
        .map((r) => r.ref.key)
        .sort();
    },
    async listForResolve(scope): Promise<ScopedSealed[]> {
      const all = [...rows.values()].filter((r) => r.ref.agentId === scope.agentId);
      const wide = all.filter((r) => r.ref.environmentId === null);
      const scoped = scope.environmentId
        ? all.filter((r) => r.ref.environmentId === scope.environmentId)
        : [];
      return [...wide, ...scoped].map((r) => ({
        key: r.ref.key,
        environmentId: r.ref.environmentId,
        ...r.sealed,
      }));
    },
  };
}
