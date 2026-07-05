/**
 * Workspace-level OpenRouter key:
 *  - the authoring assistant uses it to talk to models,
 *  - deploys expose it as OPENROUTER_API_KEY (scoped secrets can override it), and
 *  - the workspace model id is the inherited default for agents with no local model.
 * Write-only from the UI (like secrets): sealed with the same AES-GCM box, plaintext never
 * listed back. In managed mode this collapses into the ModelGateway (Eden owns keys).
 */
import { eq } from "drizzle-orm";

import { db } from "~/db/client.server";
import { workspaceSettings } from "~/db/schema";
import { decodeKey, open, seal } from "~/seams/oss/secretbox";

const key = () => decodeKey(process.env.EDEN_SECRETS_KEY);

/** Set (or clear, with null) the org's OpenRouter key. */
export async function setWorkspaceModelKey(
  orgId: string,
  value: string | null,
): Promise<void> {
  const sealed = value ? seal(key(), value) : null;
  await db
    .insert(workspaceSettings)
    .values({
      orgId,
      modelKeyCiphertext: sealed?.ciphertext ?? null,
      modelKeyIv: sealed?.iv ?? null,
      modelKeyAuthTag: sealed?.authTag ?? null,
    })
    .onConflictDoUpdate({
      target: workspaceSettings.orgId,
      set: {
        modelKeyCiphertext: sealed?.ciphertext ?? null,
        modelKeyIv: sealed?.iv ?? null,
        modelKeyAuthTag: sealed?.authTag ?? null,
        updatedAt: new Date(),
      },
    });
}

/** The org's OpenRouter key plaintext (deploy injection / assistant), or null. */
export async function getWorkspaceModelKey(orgId: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(workspaceSettings)
    .where(eq(workspaceSettings.orgId, orgId))
    .limit(1);
  if (!row?.modelKeyCiphertext || !row.modelKeyIv || !row.modelKeyAuthTag) return null;
  return open(key(), {
    ciphertext: row.modelKeyCiphertext,
    iv: row.modelKeyIv,
    authTag: row.modelKeyAuthTag,
  });
}

/** Set (or clear, with null) the workspace default OpenRouter model id. */
export async function setWorkspaceAssistantModel(
  orgId: string,
  model: string | null,
): Promise<void> {
  await db
    .insert(workspaceSettings)
    .values({ orgId, assistantModel: model })
    .onConflictDoUpdate({
      target: workspaceSettings.orgId,
      set: { assistantModel: model, updatedAt: new Date() },
    });
}

/** The org's configured default model id, or null for Eden's default. */
export async function getWorkspaceAssistantModel(orgId: string): Promise<string | null> {
  const [row] = await db
    .select({ model: workspaceSettings.assistantModel })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.orgId, orgId))
    .limit(1);
  return row?.model ?? null;
}

/** Whether a key is configured (for UI state; never returns the value). */
export async function hasWorkspaceModelKey(orgId: string): Promise<boolean> {
  const [row] = await db
    .select({ ct: workspaceSettings.modelKeyCiphertext })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.orgId, orgId))
    .limit(1);
  return !!row?.ct;
}
