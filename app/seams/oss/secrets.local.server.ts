/**
 * OSS SecretsProvider: AES-256-GCM encrypted values in Postgres. Managed swaps this for
 * KMS/Vault behind the same seam. Plaintext never touches the repo or logs (PRD §7.2).
 */
import { and, eq, isNull } from "drizzle-orm";

import { db } from "~/db/client.server";
import { secretsMetadata, secretValues } from "~/db/schema";
import type { SecretRef, SecretsProvider } from "../types";
import { decodeKey, open, seal } from "./secretbox";

const getKey = () => decodeKey(process.env.EDEN_SECRETS_KEY);
const encrypt = (plaintext: string) => seal(getKey(), plaintext);
const decrypt = (row: { ciphertext: string; iv: string; authTag: string }) =>
  open(getKey(), row);

/** Scope predicate that treats a null environment as project-wide. */
function scope(ref: SecretRef) {
  return and(
    eq(secretValues.projectId, ref.projectId),
    ref.environmentId === null
      ? isNull(secretValues.environmentId)
      : eq(secretValues.environmentId, ref.environmentId),
    eq(secretValues.key, ref.key),
  );
}

export const localSecretsProvider: SecretsProvider = {
  name: "local-encrypted",

  async set(ref, value) {
    const enc = encrypt(value);
    await db
      .insert(secretValues)
      .values({
        projectId: ref.projectId,
        environmentId: ref.environmentId,
        key: ref.key,
        ...enc,
      })
      .onConflictDoUpdate({
        target: [
          secretValues.projectId,
          secretValues.environmentId,
          secretValues.key,
        ],
        set: { ...enc, updatedAt: new Date() },
      });

    // Keep the name/audit index in sync (never stores the value).
    await db
      .insert(secretsMetadata)
      .values({
        projectId: ref.projectId,
        environmentId: ref.environmentId,
        key: ref.key,
      })
      .onConflictDoUpdate({
        target: [
          secretsMetadata.projectId,
          secretsMetadata.environmentId,
          secretsMetadata.key,
        ],
        set: { updatedAt: new Date() },
      });
  },

  async get(ref) {
    const [row] = await db.select().from(secretValues).where(scope(ref)).limit(1);
    return row ? decrypt(row) : null;
  },

  async delete(ref) {
    await db.delete(secretValues).where(scope(ref));
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

  async listNames(projectId, environmentId) {
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

  async resolve(projectId, environmentId) {
    // Environment-scoped secrets override project-wide ones of the same name.
    const projectWide = await db
      .select()
      .from(secretValues)
      .where(
        and(
          eq(secretValues.projectId, projectId),
          isNull(secretValues.environmentId),
        ),
      );
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

    const out: Record<string, string> = {};
    for (const row of [...projectWide, ...envScoped]) {
      out[row.key] = decrypt(row);
    }
    return out;
  },
};
