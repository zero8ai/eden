/**
 * Storage port for the local SecretsProvider: sealed values + the name index, scoped by
 * (project, environment, key). Splitting this out lets the provider's scoping/override logic
 * (secrets.local.server.ts) be unit-tested against an in-memory KV with real crypto, while the
 * Drizzle impl here owns the two-table persistence (values + metadata).
 */
import { and, eq, isNull } from "drizzle-orm";

import { db } from "~/db/client.server";
import { secretsMetadata, secretValues } from "~/db/schema";
import type { SecretRef } from "../types";
import type { SealedSecret } from "./secretbox";

/** A sealed value with the scope needed to merge project-wide + env-scoped at resolve time. */
export interface ScopedSealed extends SealedSecret {
  key: string;
  environmentId: string | null;
}

export interface SecretKVStore {
  upsert(ref: SecretRef, sealed: SealedSecret): Promise<void>;
  getSealed(ref: SecretRef): Promise<SealedSecret | null>;
  delete(ref: SecretRef): Promise<void>;
  /** Keys in an exact scope, sorted (names only, values never listed). */
  listKeys(projectId: string, environmentId: string | null): Promise<string[]>;
  /** Sealed rows for resolve, project-wide first then env-scoped (so env overrides). */
  listForResolve(projectId: string, environmentId: string | null): Promise<ScopedSealed[]>;
}

function valueScope(ref: SecretRef) {
  return and(
    eq(secretValues.projectId, ref.projectId),
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
      .values({ projectId: ref.projectId, environmentId: ref.environmentId, key: ref.key, ...sealed })
      .onConflictDoUpdate({
        target: [secretValues.projectId, secretValues.environmentId, secretValues.key],
        set: { ...sealed, updatedAt: new Date() },
      });
    // Keep the name/audit index in sync (never stores the value).
    await db
      .insert(secretsMetadata)
      .values({ projectId: ref.projectId, environmentId: ref.environmentId, key: ref.key })
      .onConflictDoUpdate({
        target: [secretsMetadata.projectId, secretsMetadata.environmentId, secretsMetadata.key],
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
          eq(secretsMetadata.projectId, ref.projectId),
          ref.environmentId === null
            ? isNull(secretsMetadata.environmentId)
            : eq(secretsMetadata.environmentId, ref.environmentId),
          eq(secretsMetadata.key, ref.key),
        ),
      );
  },

  async listKeys(projectId, environmentId) {
    const rows = await db
      .select({ key: secretValues.key })
      .from(secretValues)
      .where(
        and(
          eq(secretValues.projectId, projectId),
          environmentId === null
            ? isNull(secretValues.environmentId)
            : eq(secretValues.environmentId, environmentId),
        ),
      );
    return rows.map((r) => r.key).sort();
  },

  async listForResolve(projectId, environmentId) {
    const projectWide = await db
      .select()
      .from(secretValues)
      .where(and(eq(secretValues.projectId, projectId), isNull(secretValues.environmentId)));
    const envScoped = environmentId
      ? await db
          .select()
          .from(secretValues)
          .where(
            and(
              eq(secretValues.projectId, projectId),
              eq(secretValues.environmentId, environmentId),
            ),
          )
      : [];
    return [...projectWide, ...envScoped].map((r) => ({
      key: r.key,
      environmentId: r.environmentId,
      ciphertext: r.ciphertext,
      iv: r.iv,
      authTag: r.authTag,
    }));
  },
};
