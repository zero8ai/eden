/**
 * Tenant isolation (D2): a query scoped to org A must never return org B's rows. These are
 * the invariants a bug in would be a security incident, so they get regression coverage.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { db } from "~/db/client.server";
import { orgs } from "~/db/schema";
import { createProject, getProject, listProjects } from "~/db/queries.server";

const orgA = `org_test_a_${process.pid}`;
const orgB = `org_test_b_${process.pid}`;

let projectA: { id: string };
let projectB: { id: string };

beforeAll(async () => {
  await db
    .insert(orgs)
    .values([
      { id: orgA, name: "Org A" },
      { id: orgB, name: "Org B" },
    ])
    .onConflictDoNothing();
  projectA = await createProject({ orgId: orgA, name: "Alpha Agent" });
  projectB = await createProject({ orgId: orgB, name: "Beta Agent" });
});

describe("tenant isolation", () => {
  it("returns a project to its own org", async () => {
    const row = await getProject(orgA, projectA.id);
    expect(row?.id).toBe(projectA.id);
  });

  it("hides a project from another org", async () => {
    expect(await getProject(orgA, projectB.id)).toBeUndefined();
    expect(await getProject(orgB, projectA.id)).toBeUndefined();
  });

  it("lists only the tenant's projects", async () => {
    const listA = await listProjects(orgA);
    expect(listA.some((p) => p.id === projectA.id)).toBe(true);
    expect(listA.some((p) => p.id === projectB.id)).toBe(false);
  });

  it("suffixes colliding slugs within an org instead of failing", async () => {
    const again = await createProject({ orgId: orgA, name: "Alpha Agent" });
    expect(again.slug).not.toBe((await getProject(orgA, projectA.id))!.slug);
    expect(again.slug).toMatch(/^alpha-agent-\d+$/);
  });
});
