/**
 * In-memory DataStore for unit tests — the fake behind the repository seam (app/data/ports.ts).
 * Lets the deploy controller and queue be tested with zero I/O: no Postgres, no docker, no
 * clock. It models the shapes and the observable contract (uniqueness, ordering, claim-once);
 * guarantees that only the engine can provide (real row locking) are trusted at the schema
 * level, per the test strategy.
 */
import type {
  Agent,
  AgentLink,
  DataStore,
  Delegation,
  Deployment,
  DraftChange,
  Environment,
  Job,
  Project,
  Release,
} from "~/data/ports";

/** A collision error shaped like the Postgres one isVersionLabelCollision looks for. */
function versionCollision(): Error {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint_name: "releases_agent_version_uq",
  });
}

/** An in-flight deployment (pending/building) per environment. */
const IN_FLIGHT_STATUSES = new Set(["pending", "building"]);

/** The Postgres unique-violation raised by the deployments_env_inflight_uq partial index. */
function inflightDeploymentCollision(): Error {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint_name: "deployments_env_inflight_uq",
  });
}

export interface FakeStore extends DataStore {
  /** Test seams: pre-populate rows the logic reads but doesn't create. */
  seedProject(p: Partial<Project> & { id: string; orgId: string }): Project;
  seedAgent(a: {
    id: string;
    projectId: string;
    name?: string;
    root?: string;
    kind?: string;
    pendingName?: string | null;
  }): Agent;
  seedEnvironment(e: {
    id: string;
    projectId: string;
    agentId?: string;
    name?: string;
  }): Environment;
  /** Force the next N release inserts to raise a version-collision (exercises retry). */
  forceReleaseCollisions(n: number): void;
  /** Inspect recorded audit entries. */
  readonly auditEntries: { action: string; target?: string | null; orgId: string }[];
}

export function makeFakeStore(): FakeStore {
  let seq = 0;
  const id = (p: string) => `${p}_${++seq}`;

  const projects = new Map<string, Project>();
  const agents = new Map<string, Agent>();
  const environments = new Map<string, Environment>();
  const releases = new Map<string, Release>();
  const deployments = new Map<string, Deployment>();
  const jobs = new Map<string, Job>();
  const drafts = new Map<string, DraftChange>(); // key: projectId|path
  const agentLinks = new Map<string, AgentLink>(); // key: fromAgentId|toAgentId
  const delegations = new Map<string, Delegation>();
  const auditEntries: { action: string; target?: string | null; orgId: string }[] = [];
  let forcedCollisions = 0;

  return {
    auditEntries,

    seedProject(p) {
      const row: Project = {
        id: p.id,
        orgId: p.orgId,
        name: p.name ?? "Agent",
        slug: p.slug ?? "agent",
        repoOwner: p.repoOwner ?? null,
        repoName: p.repoName ?? null,
        repoInstallationId: p.repoInstallationId ?? null,
        defaultBranch: p.defaultBranch ?? "main",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
      projects.set(row.id, row);
      return row;
    },
    seedAgent(a) {
      const row: Agent = {
        id: a.id,
        projectId: a.projectId,
        name: a.name ?? "agent",
        root: a.root ?? "agent",
        kind: a.kind ?? "member",
        pendingName: a.pendingName ?? null,
        createdAt: new Date(0),
        updatedAt: new Date(0),
      };
      agents.set(row.id, row);
      return row;
    },
    seedEnvironment(e) {
      const row: Environment = {
        id: e.id,
        projectId: e.projectId,
        agentId: e.agentId ?? `agent-for-${e.projectId}`,
        name: e.name ?? "production",
        createdAt: new Date(0),
      };
      environments.set(row.id, row);
      return row;
    },
    forceReleaseCollisions(n) {
      forcedCollisions = n;
    },

    agents: {
      async findById(aid) {
        return agents.get(aid) ?? null;
      },
      async listByProject(projectId) {
        return [...agents.values()]
          .filter((a) => a.projectId === projectId)
          .sort((a, b) => a.name.localeCompare(b.name));
      },
      async syncRoster(projectId, roster) {
        if (roster.length > 0) {
          const keep = new Set(roster.map((m) => m.name));
          for (const [aid, a] of agents) {
            // Only prune tree-detected members; internal rows (assistant) survive sync.
            if (a.projectId === projectId && a.kind === "member" && !keep.has(a.name))
              agents.delete(aid);
          }
          for (const m of roster) {
            const existing = [...agents.values()].find(
              (a) => a.projectId === projectId && a.name === m.name,
            );
            if (existing) {
              agents.set(existing.id, { ...existing, root: m.root, updatedAt: new Date(++seq) });
            } else {
              const aid = id("agent");
              agents.set(aid, {
                id: aid,
                projectId,
                name: m.name,
                root: m.root,
                kind: "member",
                pendingName: null,
                createdAt: new Date(++seq),
                updatedAt: new Date(seq),
              });
            }
          }
        }
        return [...agents.values()]
          .filter((a) => a.projectId === projectId)
          .sort((a, b) => a.name.localeCompare(b.name));
      },
      async rename(aid, patch) {
        const existing = agents.get(aid);
        if (!existing) throw new Error("agent not found");
        const row = {
          ...existing,
          name: patch.name,
          root: patch.root,
          pendingName: null,
          updatedAt: new Date(++seq),
        };
        agents.set(aid, row);
        return row;
      },
      async setPendingName(aid, pendingName) {
        const existing = agents.get(aid);
        if (!existing) return;
        agents.set(aid, { ...existing, pendingName, updatedAt: new Date(++seq) });
      },
      async findAssistant(projectId) {
        return (
          [...agents.values()].find(
            (a) => a.projectId === projectId && a.kind === "assistant",
          ) ?? null
        );
      },
      async createAssistant(input) {
        const aid = id("agent");
        const row: Agent = {
          id: aid,
          projectId: input.projectId,
          name: input.name,
          root: input.root,
          kind: "assistant",
          pendingName: null,
          createdAt: new Date(++seq),
          updatedAt: new Date(seq),
        };
        agents.set(aid, row);
        return row;
      },
    },

    releases: {
      async countByAgent(agentId) {
        return [...releases.values()].filter((r) => r.agentId === agentId).length;
      },
      async insert(input) {
        if (forcedCollisions > 0) {
          forcedCollisions--;
          throw versionCollision();
        }
        const dup = [...releases.values()].some(
          (r) => r.agentId === input.agentId && r.version === input.version,
        );
        if (dup) throw versionCollision();
        const row: Release = {
          id: id("rel"),
          projectId: input.projectId,
          agentId: input.agentId,
          version: input.version,
          gitSha: input.gitSha,
          imageRef: null,
          changelog: input.changelog ?? null,
          createdBy: input.createdBy ?? null,
          createdAt: new Date(seq),
        };
        releases.set(row.id, row);
        return row;
      },
      async findById(rid) {
        return releases.get(rid) ?? null;
      },
      async findByCommit(agentId, gitSha) {
        return (
          [...releases.values()].find(
            (r) => r.agentId === agentId && r.gitSha === gitSha,
          ) ?? null
        );
      },
      async setImageRef(rid, imageRef) {
        const r = releases.get(rid);
        if (r) releases.set(rid, { ...r, imageRef });
      },
      async listByProject(projectId) {
        return [...releases.values()]
          .filter((r) => r.projectId === projectId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      },
    },

    deployments: {
      async findById(did) {
        return deployments.get(did) ?? null;
      },
      async insert(input) {
        // Model deployments_env_inflight_uq: at most one pending/building row per environment,
        // so the concurrent-provision race (#31) is exercisable without Postgres.
        if (
          IN_FLIGHT_STATUSES.has(input.status) &&
          [...deployments.values()].some(
            (d) => d.environmentId === input.environmentId && IN_FLIGHT_STATUSES.has(d.status),
          )
        ) {
          throw inflightDeploymentCollision();
        }
        const row: Deployment = {
          id: id("dep"),
          environmentId: input.environmentId,
          releaseId: input.releaseId,
          status: input.status,
          trafficWeight: input.trafficWeight,
          url: null,
          errorDetail: null,
          createdBy: input.createdBy ?? null,
          createdAt: new Date(++seq),
          updatedAt: new Date(seq),
        };
        deployments.set(row.id, row);
        return row;
      },
      async update(did, patch) {
        const cur = deployments.get(did);
        if (!cur) throw new Error("deployment not found");
        const next = { ...cur, ...patch, updatedAt: new Date(++seq) };
        // The partial unique index also rejects an UPDATE that moves a second row in-flight.
        if (
          patch.status !== undefined &&
          IN_FLIGHT_STATUSES.has(next.status) &&
          [...deployments.values()].some(
            (d) =>
              d.id !== did &&
              d.environmentId === cur.environmentId &&
              IN_FLIGHT_STATUSES.has(d.status),
          )
        ) {
          throw inflightDeploymentCollision();
        }
        deployments.set(did, next);
        return next;
      },
      async listByEnvironment(environmentId) {
        return [...deployments.values()]
          .filter((d) => d.environmentId === environmentId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .map((d) => {
            const rel = releases.get(d.releaseId);
            return {
              id: d.id,
              status: d.status,
              trafficWeight: d.trafficWeight,
              url: d.url,
              errorDetail: d.errorDetail,
              createdAt: d.createdAt,
              releaseId: d.releaseId,
              version: rel?.version ?? "?",
              gitSha: rel?.gitSha ?? "?",
            };
          });
      },
      async drainLive(environmentId) {
        for (const [did, d] of deployments) {
          if (d.environmentId === environmentId && d.status === "live") {
            deployments.set(did, { ...d, status: "draining", trafficWeight: 0 });
          }
        }
      },
      async deleteFailed(environmentId) {
        for (const [did, d] of deployments) {
          if (d.environmentId === environmentId && d.status === "failed") {
            deployments.delete(did);
          }
        }
      },
      async setWeights(environmentId, weights) {
        for (const w of weights) {
          const d = deployments.get(w.deploymentId);
          if (d && d.environmentId === environmentId) {
            deployments.set(d.id, { ...d, trafficWeight: Math.max(0, Math.round(w.weight)) });
          }
        }
      },
    },

    environments: {
      async findById(eid) {
        return environments.get(eid) ?? null;
      },
      async listByProject(projectId) {
        return [...environments.values()]
          .filter((e) => e.projectId === projectId)
          .sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
          );
      },
      async listByAgent(agentId) {
        return [...environments.values()]
          .filter((e) => e.agentId === agentId)
          .sort(
            (a, b) =>
              a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
          );
      },
      async ensureDefault(projectId, agentId) {
        const has = [...environments.values()].some((e) => e.agentId === agentId);
        if (has) return;
        const eid = id("env");
        environments.set(eid, {
          id: eid,
          projectId,
          agentId,
          name: "default",
          createdAt: new Date(++seq),
        });
      },
      async create(input) {
        const dup = [...environments.values()].some(
          (e) => e.agentId === input.agentId && e.name === input.name,
        );
        if (dup) {
          throw Object.assign(new Error("duplicate key value violates unique constraint"), {
            code: "23505",
            constraint_name: "environments_agent_name_uq",
          });
        }
        const eid = id("env");
        const row = { id: eid, ...input, createdAt: new Date(++seq) };
        environments.set(eid, row);
        return row;
      },
      async rename(eid, name) {
        const env = environments.get(eid);
        if (!env) return;
        const dup = [...environments.values()].some(
          (e) => e.agentId === env.agentId && e.name === name && e.id !== eid,
        );
        if (dup) {
          throw Object.assign(new Error("duplicate key value violates unique constraint"), {
            code: "23505",
            constraint_name: "environments_agent_name_uq",
          });
        }
        environments.set(eid, { ...env, name });
      },
      async deleteById(eid) {
        const env = environments.get(eid);
        if (!env) return false;
        const siblings = [...environments.values()].filter(
          (e) => e.agentId === env.agentId,
        );
        if (siblings.length <= 1) return false;
        environments.delete(eid);
        // Mirror the FK cascade: the env's deployments go with it.
        for (const [did, d] of deployments) {
          if (d.environmentId === eid) deployments.delete(did);
        }
        return true;
      },
    },

    projects: {
      async findById(pid) {
        return projects.get(pid) ?? null;
      },
      async findByRepo(owner, repo) {
        return (
          [...projects.values()].find(
            (p) => p.repoOwner === owner && p.repoName === repo,
          ) ?? null
        );
      },
      async getByOrg(orgId, pid) {
        const p = projects.get(pid);
        return p && p.orgId === orgId ? p : null;
      },
      async listByOrg(orgId) {
        return [...projects.values()]
          .filter((p) => p.orgId === orgId)
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      },
      async slugExists(orgId, slug) {
        return [...projects.values()].some((p) => p.orgId === orgId && p.slug === slug);
      },
      async create(input) {
        const row: Project = {
          id: id("proj"),
          orgId: input.orgId,
          name: input.name,
          slug: input.slug,
          repoOwner: input.repoOwner ?? null,
          repoName: input.repoName ?? null,
          repoInstallationId: input.repoInstallationId ?? null,
          defaultBranch: input.defaultBranch ?? "main",
          createdAt: new Date(++seq),
          updatedAt: new Date(seq),
        };
        projects.set(row.id, row);
        return row;
      },
      async deleteById(pid) {
        projects.delete(pid);
        // Mirror the FK cascade the schema enforces.
        for (const [aid, a] of agents) if (a.projectId === pid) agents.delete(aid);
        for (const [eid, e] of environments) {
          if (e.projectId === pid) {
            environments.delete(eid);
            for (const [did, d] of deployments) {
              if (d.environmentId === eid) deployments.delete(did);
            }
          }
        }
        for (const [rid, r] of releases) if (r.projectId === pid) releases.delete(rid);
        for (const [k, d] of drafts) if (d.projectId === pid) drafts.delete(k);
      },
    },

    jobs: {
      async insert(input) {
        const jid = id("job");
        jobs.set(jid, {
          id: jid,
          kind: input.kind,
          payload: input.payload,
          status: "queued",
          attempts: 0,
          maxAttempts: input.maxAttempts ?? 3,
          runAt: input.runAt ?? new Date(0),
          error: null,
          createdAt: new Date(++seq),
          updatedAt: new Date(seq),
        });
        return jid;
      },
      async claimNext(now) {
        const due = [...jobs.values()]
          .filter((j) => j.status === "queued" && j.runAt.getTime() <= now.getTime())
          .sort((a, b) => a.runAt.getTime() - b.runAt.getTime());
        const job = due[0];
        if (!job) return null;
        const claimed = { ...job, status: "running", attempts: job.attempts + 1 };
        jobs.set(job.id, claimed);
        return claimed;
      },
      async update(jid, patch) {
        const cur = jobs.get(jid);
        if (cur) jobs.set(jid, { ...cur, ...patch, updatedAt: new Date(++seq) });
      },
      async requeueRunning() {
        let n = 0;
        for (const [jid, j] of jobs) {
          if (j.status === "running") {
            jobs.set(jid, { ...j, status: "queued", runAt: new Date(0) });
            n++;
          }
        }
        return n;
      },
      async statsByStatus() {
        const out: Record<string, number> = {};
        for (const j of jobs.values()) out[j.status] = (out[j.status] ?? 0) + 1;
        return out;
      },
    },

    drafts: {
      async upsert(input) {
        const key = `${input.projectId}|${input.path}`;
        const existing = drafts.get(key);
        const row: DraftChange = {
          id: existing?.id ?? id("draft"),
          projectId: input.projectId,
          agentId: input.agentId,
          path: input.path,
          content: input.content,
          baseSha: input.baseSha ?? null,
          createdBy: input.createdBy ?? null,
          createdAt: existing?.createdAt ?? new Date(++seq),
          updatedAt: new Date(++seq),
        };
        drafts.set(key, row);
        return row;
      },
      async get(projectId, path) {
        return drafts.get(`${projectId}|${path}`) ?? null;
      },
      async listByProject(projectId) {
        return [...drafts.values()]
          .filter((d) => d.projectId === projectId)
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      },
      async deleteByPaths(projectId, paths) {
        for (const p of paths) drafts.delete(`${projectId}|${p}`);
      },
    },

    audit: {
      async record(input) {
        auditEntries.push({ action: input.action, target: input.target, orgId: input.orgId });
      },
    },

    agentLinks: {
      async listByProject(projectId) {
        return [...agentLinks.values()].filter((l) => l.projectId === projectId);
      },
      async get(fromAgentId, toAgentId) {
        return agentLinks.get(`${fromAgentId}|${toAgentId}`) ?? null;
      },
      async set(input) {
        const key = `${input.fromAgentId}|${input.toAgentId}`;
        const existing = agentLinks.get(key);
        agentLinks.set(key, {
          id: existing?.id ?? id("link"),
          projectId: input.projectId,
          fromAgentId: input.fromAgentId,
          toAgentId: input.toAgentId,
          enabled: input.enabled,
          createdAt: existing?.createdAt ?? new Date(++seq),
          updatedAt: new Date(++seq),
        });
      },
    },

    delegations: {
      async insert(input) {
        const row: Delegation = {
          id: id("deleg"),
          projectId: input.projectId,
          fromAgentId: input.fromAgentId,
          fromEnvironmentId: input.fromEnvironmentId,
          toAgentId: input.toAgentId,
          toEnvironmentId: input.toEnvironmentId,
          externalSessionId: null,
          runId: null,
          status: "running",
          error: null,
          startedAt: new Date(),
          finishedAt: null,
        };
        delegations.set(row.id, row);
        return row;
      },
      async finalize(did, patch) {
        const cur = delegations.get(did);
        if (!cur) return;
        delegations.set(did, {
          ...cur,
          status: patch.status,
          error: patch.error ?? null,
          externalSessionId:
            patch.externalSessionId !== undefined
              ? patch.externalSessionId
              : cur.externalSessionId,
          runId: patch.runId !== undefined ? patch.runId : cur.runId,
          finishedAt: patch.finishedAt ?? new Date(),
        });
      },
      async countActiveEdge(fromAgentId, toAgentId, since) {
        return [...delegations.values()].filter(
          (d) =>
            d.fromAgentId === fromAgentId &&
            d.toAgentId === toAgentId &&
            d.status === "running" &&
            d.startedAt.getTime() > since.getTime(),
        ).length;
      },
      async countActiveProject(projectId, since) {
        return [...delegations.values()].filter(
          (d) =>
            d.projectId === projectId &&
            d.status === "running" &&
            d.startedAt.getTime() > since.getTime(),
        ).length;
      },
    },
  };
}
