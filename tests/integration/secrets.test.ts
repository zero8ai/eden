/**
 * SecretsProvider scoping: env-scoped overrides project-wide at resolve time, values
 * round-trip through AES-256-GCM, and deletion is scope-exact.
 */
import { eq } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "~/db/client.server";
import { environments, orgs } from "~/db/schema";
import { createProject } from "~/db/queries.server";
import { localSecretsProvider as secrets } from "~/seams/oss/secrets.local.server";

const orgId = `org_test_secrets_${process.pid}`;
let projectId: string;
let envId: string;

beforeAll(async () => {
  await db.insert(orgs).values({ id: orgId, name: "Secrets Org" }).onConflictDoNothing();
  const project = await createProject({ orgId, name: "Secrets Agent" });
  projectId = project.id;
  const [env] = await db
    .select()
    .from(environments)
    .where(eq(environments.projectId, projectId));
  envId = env.id;
});

describe("secrets", () => {
  it("round-trips a value through encryption", async () => {
    await secrets.set({ projectId, environmentId: null, key: "API_KEY" }, "s3cr3t");
    expect(await secrets.get({ projectId, environmentId: null, key: "API_KEY" })).toBe(
      "s3cr3t",
    );
  });

  it("upserts on the same scope+key", async () => {
    await secrets.set({ projectId, environmentId: null, key: "API_KEY" }, "rotated");
    expect(await secrets.get({ projectId, environmentId: null, key: "API_KEY" })).toBe(
      "rotated",
    );
  });

  it("resolve() overrides project-wide with env-scoped values", async () => {
    await secrets.set({ projectId, environmentId: null, key: "SHARED" }, "project-wide");
    await secrets.set({ projectId, environmentId: envId, key: "SHARED" }, "env-scoped");
    const resolved = await secrets.resolve(projectId, envId);
    expect(resolved.SHARED).toBe("env-scoped");
    expect(resolved.API_KEY).toBe("rotated");
    // Without an environment, only project-wide values apply.
    const bare = await secrets.resolve(projectId, null);
    expect(bare.SHARED).toBe("project-wide");
  });

  it("deletes scope-exactly", async () => {
    await secrets.delete({ projectId, environmentId: envId, key: "SHARED" });
    expect(await secrets.get({ projectId, environmentId: envId, key: "SHARED" })).toBeNull();
    expect(await secrets.get({ projectId, environmentId: null, key: "SHARED" })).toBe(
      "project-wide",
    );
  });
});
