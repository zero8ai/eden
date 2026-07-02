/**
 * Drizzle-backed DataStore — the single place control-plane SQL lives (ports.ts is the seam).
 * Behavior that a fake can't reproduce (FOR UPDATE SKIP LOCKED claims, the (project, version)
 * unique constraint, transactional weight updates) is realized here and trusted at the schema
 * level; the logic that orchestrates these calls is what gets unit-tested against the fake.
 */
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";

import { db } from "~/db/client.server";
import {
  auditLog,
  deployments,
  draftChanges,
  environments,
  jobs,
  projects,
  releases,
} from "~/db/schema";
import { recordAudit } from "~/managed/audit.server";
import type { DataStore } from "./ports";

export const drizzleDataStore: DataStore = {
  releases: {
    async countByProject(projectId) {
      const [{ c }] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(releases)
        .where(eq(releases.projectId, projectId));
      return c ?? 0;
    },
    async insert(input) {
      const [row] = await db
        .insert(releases)
        .values({
          projectId: input.projectId,
          version: input.version,
          gitSha: input.gitSha,
          changelog: input.changelog ?? null,
          createdBy: input.createdBy ?? null,
        })
        .returning();
      return row;
    },
    async findById(id) {
      const [row] = await db.select().from(releases).where(eq(releases.id, id)).limit(1);
      return row ?? null;
    },
    async findByCommit(projectId, gitSha) {
      const [row] = await db
        .select()
        .from(releases)
        .where(and(eq(releases.projectId, projectId), eq(releases.gitSha, gitSha)))
        .limit(1);
      return row ?? null;
    },
    async setImageRef(id, imageRef) {
      await db.update(releases).set({ imageRef }).where(eq(releases.id, id));
    },
    async listByProject(projectId) {
      return db
        .select()
        .from(releases)
        .where(eq(releases.projectId, projectId))
        .orderBy(desc(releases.createdAt));
    },
  },

  deployments: {
    async insert(input) {
      const [row] = await db
        .insert(deployments)
        .values({
          environmentId: input.environmentId,
          releaseId: input.releaseId,
          status: input.status,
          trafficWeight: input.trafficWeight,
          createdBy: input.createdBy ?? null,
        })
        .returning();
      return row;
    },
    async update(id, patch) {
      const [row] = await db
        .update(deployments)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(deployments.id, id))
        .returning();
      return row;
    },
    async listByEnvironment(environmentId) {
      return db
        .select({
          id: deployments.id,
          status: deployments.status,
          trafficWeight: deployments.trafficWeight,
          url: deployments.url,
          errorDetail: deployments.errorDetail,
          createdAt: deployments.createdAt,
          releaseId: deployments.releaseId,
          version: releases.version,
          gitSha: releases.gitSha,
        })
        .from(deployments)
        .innerJoin(releases, eq(deployments.releaseId, releases.id))
        .where(eq(deployments.environmentId, environmentId))
        .orderBy(sql`${deployments.createdAt} desc`);
    },
    async drainLive(environmentId) {
      await db
        .update(deployments)
        .set({ status: "draining", trafficWeight: 0, updatedAt: new Date() })
        .where(
          and(
            eq(deployments.environmentId, environmentId),
            eq(deployments.status, "live"),
          ),
        );
    },
    async setWeights(environmentId, weights) {
      await db.transaction(async (tx) => {
        for (const w of weights) {
          await tx
            .update(deployments)
            .set({ trafficWeight: Math.max(0, Math.round(w.weight)), updatedAt: new Date() })
            .where(
              and(
                eq(deployments.id, w.deploymentId),
                eq(deployments.environmentId, environmentId),
              ),
            );
        }
      });
    },
  },

  environments: {
    async findById(id) {
      const [row] = await db
        .select()
        .from(environments)
        .where(eq(environments.id, id))
        .limit(1);
      return row ?? null;
    },
    async listByProject(projectId) {
      return db
        .select()
        .from(environments)
        .where(eq(environments.projectId, projectId))
        .orderBy(asc(environments.createdAt));
    },
    async seedDefaults(projectId, names) {
      await db
        .insert(environments)
        .values(names.map((name) => ({ projectId, name })))
        .onConflictDoNothing();
    },
  },

  projects: {
    async findById(id) {
      const [row] = await db.select().from(projects).where(eq(projects.id, id)).limit(1);
      return row ?? null;
    },
    async findByRepo(owner, repo) {
      const [row] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.repoOwner, owner), eq(projects.repoName, repo)))
        .limit(1);
      return row ?? null;
    },
    async getByOrg(orgId, id) {
      const [row] = await db
        .select()
        .from(projects)
        .where(and(eq(projects.orgId, orgId), eq(projects.id, id)))
        .limit(1);
      return row ?? null;
    },
    async listByOrg(orgId) {
      return db
        .select()
        .from(projects)
        .where(eq(projects.orgId, orgId))
        .orderBy(desc(projects.createdAt));
    },
    async slugExists(orgId, slug) {
      const rows = await db
        .select({ id: projects.id })
        .from(projects)
        .where(and(eq(projects.orgId, orgId), eq(projects.slug, slug)))
        .limit(1);
      return rows.length > 0;
    },
    async create(input) {
      const [row] = await db.insert(projects).values(input).returning();
      return row;
    },
  },

  jobs: {
    async insert(input) {
      const [row] = await db
        .insert(jobs)
        .values({
          kind: input.kind,
          payload: input.payload,
          ...(input.runAt ? { runAt: input.runAt } : {}),
          ...(input.maxAttempts ? { maxAttempts: input.maxAttempts } : {}),
        })
        .returning({ id: jobs.id });
      return row.id;
    },
    async claimNext(now) {
      return db.transaction(async (tx) => {
        const [job] = await tx
          .select()
          .from(jobs)
          .where(and(eq(jobs.status, "queued"), lte(jobs.runAt, now)))
          .orderBy(asc(jobs.runAt))
          .limit(1)
          .for("update", { skipLocked: true });
        if (!job) return null;
        await tx
          .update(jobs)
          .set({ status: "running", attempts: job.attempts + 1, updatedAt: new Date() })
          .where(eq(jobs.id, job.id));
        return { ...job, status: "running", attempts: job.attempts + 1 };
      });
    },
    async update(id, patch) {
      await db
        .update(jobs)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(jobs.id, id));
    },
    async statsByStatus() {
      const rows = await db
        .select({ status: jobs.status, count: sql<number>`count(*)::int` })
        .from(jobs)
        .groupBy(jobs.status);
      return Object.fromEntries(rows.map((r) => [r.status, r.count]));
    },
  },

  drafts: {
    async upsert(input) {
      const [row] = await db
        .insert(draftChanges)
        .values({
          projectId: input.projectId,
          path: input.path,
          content: input.content,
          baseSha: input.baseSha ?? null,
          createdBy: input.createdBy ?? null,
        })
        .onConflictDoUpdate({
          target: [draftChanges.projectId, draftChanges.path],
          set: {
            content: input.content,
            baseSha: input.baseSha ?? null,
            createdBy: input.createdBy ?? null,
            updatedAt: new Date(),
          },
        })
        .returning();
      return row;
    },
    async get(projectId, path) {
      const [row] = await db
        .select()
        .from(draftChanges)
        .where(and(eq(draftChanges.projectId, projectId), eq(draftChanges.path, path)))
        .limit(1);
      return row ?? null;
    },
    async listByProject(projectId) {
      return db
        .select()
        .from(draftChanges)
        .where(eq(draftChanges.projectId, projectId))
        .orderBy(asc(draftChanges.createdAt));
    },
    async deleteByPaths(projectId, paths) {
      if (paths.length === 0) return;
      await db
        .delete(draftChanges)
        .where(and(eq(draftChanges.projectId, projectId), inArray(draftChanges.path, paths)));
    },
  },

  audit: {
    async record(input) {
      await recordAudit(input);
    },
  },
};
