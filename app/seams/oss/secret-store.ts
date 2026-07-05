/**
 * Storage port for the local SecretsProvider: sealed values + the name index, scoped by
 * (agent, environment, key) — per-agent by decision (PRD §7.9). Splitting this out lets the
 * provider's scoping/override logic (secrets.local.server.ts) be unit-tested against an
 * in-memory KV with real crypto, while the Drizzle impl here owns the two-table persistence
 * (values + metadata).
 */
import { and, eq, isNull, or } from "drizzle-orm";

import { db } from "~/db/client.server";
import { secretsMetadata, secretValues } from "~/db/schema";
import type { SecretRef, SecretScope } from "../types";
import type { SealedSecret } from "./secretbox";

/** A sealed value with the scope needed to merge agent-wide + env-scoped at resolve time. */
export interface ScopedSealed extends SealedSecret {
  key: string;
  environmentId: string | null;
}

export interface SecretKVStore {
  upsert(ref: SecretRef, sealed: SealedSecret): Promise<void>;
  getSealed(ref: SecretRef): Promise<SealedSecret | null>;
  delete(ref: SecretRef): Promise<void>;
  /** Keys in an exact scope, sorted (names only, values never listed). */
  listKeys(scope: SecretScope): Promise<string[]>;
  /** Sealed rows for resolve, agent-wide first then env-scoped (so env overrides). */
  listForResolve(scope: SecretScope): Promise<ScopedSealed[]>;
}

function valueScope(ref: SecretRef) {
  return and(
    eq(secretValues.agentId, ref.agentId),
    ref.environmentId === null
      ? isNull(secretValues.environmentId)
      : eq(secretValues.environmentId, ref.environmentId),
    eq(secretValues.key, ref.key),
  );
}

export const drizzleSecretKV: SecretKVStore = {
  async upsert(ref, sealed) {
    await db
      .insert(secretValues)
      .values({
        projectId: ref.projectId,
        agentId: ref.agentId,
        environmentId: ref.environmentId,
        key: ref.key,
        ...sealed,
      })
      .onConflictDoUpdate({
        target: [secretValues.agentId, secretValues.environmentId, secretValues.key],
        set: { ...sealed, updatedAt: new Date() },
      });
    // Keep the name/audit index in sync (never stores the value).
    await db
      .insert(secretsMetadata)
      .values({
        projectId: ref.projectId,
        agentId: ref.agentId,
        environmentId: ref.environmentId,
        key: ref.key,
      })
      .onConflictDoUpdate({
        target: [secretsMetadata.agentId, secretsMetadata.environmentId, secretsMetadata.key],
        set: { updatedAt: new Date() },
      });
  },

  async getSealed(ref) {
    const [row] = await db.select().from(secretValues).where(valueScope(ref)).limit(1);
    return row ? { ciphertext: row.ciphertext, iv: row.iv, authTag: row.authTag } : null;
  },

  async delete(ref) {
    await db.delete(secretValues).where(valueScope(ref));
    await db
      .delete(secretsMetadata)
      .where(
        and(
          eq(secretsMetadata.agentId, ref.agentId),
          ref.environmentId === null
            ? isNull(secretsMetadata.environmentId)
            : eq(secretsMetadata.environmentId, ref.environmentId),
          eq(secretsMetadata.key, ref.key),
        ),
      );
  },

  async listKeys(scope) {
    const rows = await db
      .select({ key: secretValues.key })
      .from(secretValues)
      .where(
        and(
          eq(secretValues.agentId, scope.agentId),
          scope.environmentId === null
            ? isNull(secretValues.environmentId)
            : eq(secretValues.environmentId, scope.environmentId),
        ),
      );
    return rows.map((r) => r.key).sort();
  },

  async listForResolve(scope) {
    const agentWide = await db
      .select()
      .from(secretValues)
      .where(and(eq(secretValues.agentId, scope.agentId), isNull(secretValues.environmentId)));
    const envScoped = scope.environmentId
      ? await db
          .select()
          .from(secretValues)
          .where(
            and(
              eq(secretValues.agentId, scope.agentId),
              eq(secretValues.environmentId, scope.environmentId),
            ),
          )
      : [];
    return [...agentWide, ...envScoped].map((r) => ({
      key: r.key,
      environmentId: r.environmentId,
      ciphertext: r.ciphertext,
      iv: r.iv,
      authTag: r.authTag,
    }));
  },
};

// ── Sandbox exposure (metadata, never values) ────────────────────────────────
// The per-secret "available in the agent's sandbox shell" flag lives on the METADATA index,
// not behind the SecretsProvider: it's control-plane policy about a name, so it survives
// provider swaps (KMS/Vault store values, not Eden decisions) and value rotations. Deploys
// join the exposed names into EDEN_SANDBOX_ENV (see ~/deploy/controller.server.ts).

function metadataScope(ref: { agentId: string; environmentId: string | null; key: string }) {
  return and(
    eq(secretsMetadata.agentId, ref.agentId),
    ref.environmentId === null
      ? isNull(secretsMetadata.environmentId)
      : eq(secretsMetadata.environmentId, ref.environmentId),
    eq(secretsMetadata.key, ref.key),
  );
}

/** Flip one secret's sandbox exposure (exact scope — the row the Settings list shows). */
export async function setSecretSandboxExposed(
  ref: SecretRef,
  exposed: boolean,
  updatedBy?: string | null,
): Promise<void> {
  await db
    .update(secretsMetadata)
    .set({ sandboxExposed: exposed, updatedBy: updatedBy ?? null, updatedAt: new Date() })
    .where(metadataScope(ref));
}

/** Exposure flags for a Settings list's exact scope: key → exposed. */
export async function listSandboxExposure(scope: SecretScope): Promise<Record<string, boolean>> {
  const rows = await db
    .select({ key: secretsMetadata.key, exposed: secretsMetadata.sandboxExposed })
    .from(secretsMetadata)
    .where(
      and(
        eq(secretsMetadata.agentId, scope.agentId),
        scope.environmentId === null
          ? isNull(secretsMetadata.environmentId)
          : eq(secretsMetadata.environmentId, scope.environmentId),
      ),
    );
  return Object.fromEntries(rows.map((r) => [r.key, r.exposed]));
}

/**
 * Names exposed to the sandbox for a DEPLOY scope: agent-wide rows plus the environment's,
 * matching how `resolve` merges values. A name is exposed when ANY in-scope row marks it —
 * deliberately the simple rule; exposure is per-name policy, not per-override.
 */
export async function listSandboxExposedNames(scope: SecretScope): Promise<string[]> {
  const rows = await db
    .select({ key: secretsMetadata.key })
    .from(secretsMetadata)
    .where(
      and(
        eq(secretsMetadata.agentId, scope.agentId),
        eq(secretsMetadata.sandboxExposed, true),
        scope.environmentId === null
          ? isNull(secretsMetadata.environmentId)
          : or(
              isNull(secretsMetadata.environmentId),
              eq(secretsMetadata.environmentId, scope.environmentId),
            ),
      ),
    );
  return [...new Set(rows.map((r) => r.key))].sort();
}
