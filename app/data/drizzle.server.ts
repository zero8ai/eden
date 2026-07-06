/**
 * Drizzle-backed DataStore — the single place control-plane SQL lives (ports.ts is the seam).
 * Behavior that a fake can't reproduce (FOR UPDATE SKIP LOCKED claims, the (project, version)
 * unique constraint, transactional weight updates) is realized here and trusted at the schema
 * level; the logic that orchestrates these calls is what gets unit-tested against the fake.
 */
import { and, asc, desc, eq, gt, inArray, lte, notInArray, sql } from "drizzle-orm";

import { db } from "~/db/client.server";
import {
  agentLinks,
  agents,
  auditLog,
  conversations,
  delegations,
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
  agents: {
    async findById(id) {
      const [row] = await db.select().from(agents).where(eq(agents.id, id)).limit(1);
      return row ?? null;
    },
    async listByProject(projectId) {
      return db
        .select()
        .from(agents)
        .where(eq(agents.projectId, projectId))
        .orderBy(asc(agents.name));
    },
    async syncRoster(projectId, roster) {
      return db.transaction(async (tx) => {
        if (roster.length > 0) {
          await tx
            .insert(agents)
            .values(roster.map((m) => ({ projectId, name: m.name, root: m.root })))
            .onConflictDoUpdate({
              target: [agents.projectId, agents.name],
              set: { root: sql`excluded.root`, updatedAt: new Date() },
            });
          await tx.delete(agents).where(
            and(
              eq(agents.projectId, projectId),
              // Only prune tree-detected members. Internal rows (kind !== 'member', e.g. the
              // built-in assistant) are never in the detected roster and must survive sync.
              eq(agents.kind, "member"),
              notInArray(
                agents.name,
                roster.map((m) => m.name),
              ),
            ),
          );
        }
        // Never delete the whole roster: an empty detection (e.g. a truncated tree read)
        // must not cascade away releases/runs. An empty roster is a no-op.
        return tx
          .select()
          .from(agents)
          .where(eq(agents.projectId, projectId))
          .orderBy(asc(agents.name));
      });
    },
    async findAssistant(projectId) {
      const [row] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.projectId, projectId), eq(agents.kind, "assistant")))
        .limit(1);
      return row ?? null;
    },
    async createAssistant(input) {
      const [row] = await db
        .insert(agents)
        .values({
          projectId: input.projectId,
          name: input.name,
          root: input.root,
          kind: "assistant",
        })
        .returning();
      return row;
    },
  },

  releases: {
    async countByAgent(agentId) {
      const [{ c }] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(releases)
        .where(eq(releases.agentId, agentId));
      return c ?? 0;
    },
    async insert(input) {
      const [row] = await db
        .insert(releases)
        .values({
          projectId: input.projectId,
          agentId: input.agentId,
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
    async findByCommit(agentId, gitSha) {
      const [row] = await db
        .select()
        .from(releases)
        .where(and(eq(releases.agentId, agentId), eq(releases.gitSha, gitSha)))
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
    async findById(id) {
      const [row] = await db
        .select()
        .from(deployments)
        .where(eq(deployments.id, id))
        .limit(1);
      return row ?? null;
    },
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
    async deleteFailed(environmentId) {
      await db
        .delete(deployments)
        .where(
          and(
            eq(deployments.environmentId, environmentId),
            eq(deployments.status, "failed"),
          ),
        );
    },
    async setWeights(environmentId, weights) {
      // One transaction so a crash mid-way can't leave a partial split; the per-row
      // updates hit distinct rows and are order-independent, so they run concurrently
      // (pipelined on the transaction's connection).
      await db.transaction(async (tx) => {
        await Promise.all(
          weights.map((w) =>
            tx
              .update(deployments)
              .set({ trafficWeight: Math.max(0, Math.round(w.weight)), updatedAt: new Date() })
              .where(
                and(
                  eq(deployments.id, w.deploymentId),
                  eq(deployments.environmentId, environmentId),
                ),
              ),
          ),
        );
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
    // Creation order with id as tiebreak: seeded rows can share a createdAt (bulk insert),
    // and "first environment" is the PRIMARY (ship target, hero card) — it must be stable.
    async listByProject(projectId) {
      return db
        .select()
        .from(environments)
        .where(eq(environments.projectId, projectId))
        .orderBy(asc(environments.createdAt), asc(environments.id));
    },
    async listByAgent(agentId) {
      return db
        .select()
        .from(environments)
        .where(eq(environments.agentId, agentId))
        .orderBy(asc(environments.createdAt), asc(environments.id));
    },
    async ensureDefault(projectId, agentId) {
      const [existing] = await db
        .select({ id: environments.id })
        .from(environments)
        .where(eq(environments.agentId, agentId))
        .limit(1);
      if (existing) return;
      // Concurrent ensureDefault calls are settled by the (agent, name) unique index; a
      // race with a concurrent user-created env can at worst leave both rows — acceptable.
      await db
        .insert(environments)
        .values({ projectId, agentId, name: "default" })
        .onConflictDoNothing();
    },
    async create(input) {
      const [row] = await db.insert(environments).values(input).returning();
      return row;
    },
    async rename(id, name) {
      await db.update(environments).set({ name }).where(eq(environments.id, id));
    },
    async deleteById(id) {
      // Lock the member's env rows before counting, so two concurrent deletes of a
      // two-env agent serialize and the loser sees count=1 — never zero envs left.
      return db.transaction(async (tx) => {
        const [env] = await tx
          .select({ agentId: environments.agentId })
          .from(environments)
          .where(eq(environments.id, id))
          .limit(1);
        if (!env) return false;
        const siblings = await tx
          .select({ id: environments.id })
          .from(environments)
          .where(eq(environments.agentId, env.agentId))
          .for("update");
        if (siblings.length <= 1) return false;
        await tx.delete(environments).where(eq(environments.id, id));
        return true;
      });
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
    async deleteById(id) {
      await db.delete(projects).where(eq(projects.id, id));
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
    async requeueRunning() {
      const rows = await db
        .update(jobs)
        .set({ status: "queued", runAt: new Date(), updatedAt: new Date() })
        .where(eq(jobs.status, "running"))
        .returning({ id: jobs.id });
      return rows.length;
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
          agentId: input.agentId,
          path: input.path,
          content: input.content,
          baseSha: input.baseSha ?? null,
          createdBy: input.createdBy ?? null,
        })
        .onConflictDoUpdate({
          target: [draftChanges.projectId, draftChanges.path],
          set: {
            agentId: input.agentId,
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

  conversations: {
    async get(projectId, kind, userId) {
      const [row] = await db
        .select()
        .from(conversations)
        .where(
          and(
            eq(conversations.projectId, projectId),
            eq(conversations.kind, kind),
            eq(conversations.createdBy, userId),
          ),
        )
        .limit(1);
      return row ?? null;
    },
    async save(input) {
      const [row] = await db
        .insert(conversations)
        .values(input)
        .onConflictDoUpdate({
          target: [conversations.projectId, conversations.kind, conversations.createdBy],
          set: { messages: input.messages, state: input.state, updatedAt: new Date() },
        })
        .returning();
      return row;
    },
    async delete(projectId, kind, userId) {
      await db
        .delete(conversations)
        .where(
          and(
            eq(conversations.projectId, projectId),
            eq(conversations.kind, kind),
            eq(conversations.createdBy, userId),
          ),
        );
    },
  },

  audit: {
    async record(input) {
      await recordAudit(input);
    },
  },

  agentLinks: {
    async listByProject(projectId) {
      return db.select().from(agentLinks).where(eq(agentLinks.projectId, projectId));
    },
    async get(fromAgentId, toAgentId) {
      const [row] = await db
        .select()
        .from(agentLinks)
        .where(
          and(eq(agentLinks.fromAgentId, fromAgentId), eq(agentLinks.toAgentId, toAgentId)),
        )
        .limit(1);
      return row ?? null;
    },
    async set(input) {
      await db
        .insert(agentLinks)
        .values({
          projectId: input.projectId,
          fromAgentId: input.fromAgentId,
          toAgentId: input.toAgentId,
          enabled: input.enabled,
        })
        .onConflictDoUpdate({
          target: [agentLinks.fromAgentId, agentLinks.toAgentId],
          set: { enabled: input.enabled, updatedAt: new Date() },
        });
    },
  },

  delegations: {
    async insert(input) {
      const [row] = await db
        .insert(delegations)
        .values({
          projectId: input.projectId,
          fromAgentId: input.fromAgentId,
          fromEnvironmentId: input.fromEnvironmentId,
          toAgentId: input.toAgentId,
          toEnvironmentId: input.toEnvironmentId,
          status: "running",
        })
        .returning();
      return row;
    },
    async finalize(id, patch) {
      await db
        .update(delegations)
        .set({
          status: patch.status,
          error: patch.error ?? null,
          ...(patch.externalSessionId !== undefined
            ? { externalSessionId: patch.externalSessionId }
            : {}),
          ...(patch.runId !== undefined ? { runId: patch.runId } : {}),
          finishedAt: patch.finishedAt ?? new Date(),
        })
        .where(eq(delegations.id, id));
    },
    async countActiveEdge(fromAgentId, toAgentId, since) {
      const [{ c }] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(delegations)
        .where(
          and(
            eq(delegations.fromAgentId, fromAgentId),
            eq(delegations.toAgentId, toAgentId),
            eq(delegations.status, "running"),
            gt(delegations.startedAt, since),
          ),
        );
      return c ?? 0;
    },
    async countActiveProject(projectId, since) {
      const [{ c }] = await db
        .select({ c: sql<number>`count(*)::int` })
        .from(delegations)
        .where(
          and(
            eq(delegations.projectId, projectId),
            eq(delegations.status, "running"),
            gt(delegations.startedAt, since),
          ),
        );
      return c ?? 0;
    },
  },
};
