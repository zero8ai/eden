/** Workspace-level default-model settings. Provider credentials live on provider connections. */
import { eq } from "drizzle-orm";

import { db } from "~/db/client.server";
import { workspaceSettings } from "~/db/schema";

/** Set (or clear, with null) the connection-qualified workspace default model id. */
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

/** The org's configured connection-qualified default model id, or null when none is configured. */
export async function getWorkspaceAssistantModel(
  orgId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ model: workspaceSettings.assistantModel })
    .from(workspaceSettings)
    .where(eq(workspaceSettings.orgId, orgId))
    .limit(1);
  return row?.model ?? null;
}
