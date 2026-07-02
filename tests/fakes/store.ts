/**
 * In-memory DataStore for unit tests — the fake behind the repository seam (app/data/ports.ts).
 * Lets the deploy controller and queue be tested with zero I/O: no Postgres, no docker, no
 * clock. It models the shapes and the observable contract (uniqueness, ordering, claim-once);
 * guarantees that only the engine can provide (real row locking) are trusted at the schema
 * level, per the test strategy.
 */
import type {
  DataStore,
  Deployment,
  Environment,
  Job,
  Project,
  Release,
} from "~/data/ports";

/** A collision error shaped like the Postgres one isVersionLabelCollision looks for. */
function versionCollision(): Error {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    code: "23505",
    constraint_name: "releases_project_version_uq",
  });
}

export interface FakeStore extends DataStore {
  /** Test seams: pre-populate rows the logic reads but doesn't create. */
  seedProject(p: Partial<Project> & { id: string; orgId: string }): Project;
  seedEnvironment(e: { id: string; projectId: string; name?: string }): Environment;
  /** Force the next N release inserts to raise a version-collision (exercises retry). */
  forceReleaseCollisions(n: number): void;
  /** Inspect recorded audit entries. */
  readonly auditEntries: { action: string; target?: string | null; orgId: string }[];
}

export function makeFakeStore(): FakeStore {
  let seq = 0;
  const id = (p: string) => `${p}_${++seq}`;

  const projects = new Map<string, Project>();
  const environments = new Map<string, Environment>();
  const releases = new Map<string, Release>();
  const deployments = new Map<string, Deployment>();
  const jobs = new Map<string, Job>();
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
    seedEnvironment(e) {
      const row: Environment = {
        id: e.id,
        projectId: e.projectId,
        name: e.name ?? "production",
        createdAt: new Date(0),
      };
      environments.set(row.id, row);
      return row;
    },
    forceReleaseCollisions(n) {
      forcedCollisions = n;
    },

    releases: {
      async countByProject(projectId) {
        return [...releases.values()].filter((r) => r.projectId === projectId).length;
      },
      async insert(input) {
        if (forcedCollisions > 0) {
          forcedCollisions--;
          throw versionCollision();
        }
        const dup = [...releases.values()].some(
          (r) => r.projectId === input.projectId && r.version === input.version,
        );
        if (dup) throw versionCollision();
        const row: Release = {
          id: id("rel"),
          projectId: input.projectId,
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
      async findByCommit(projectId, gitSha) {
        return (
          [...releases.values()].find(
            (r) => r.projectId === projectId && r.gitSha === gitSha,
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
      async insert(input) {
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
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      },
      async seedDefaults(projectId, names) {
        for (const name of names) {
          const eid = id("env");
          environments.set(eid, { id: eid, projectId, name, createdAt: new Date(++seq) });
        }
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
      async statsByStatus() {
        const out: Record<string, number> = {};
        for (const j of jobs.values()) out[j.status] = (out[j.status] ?? 0) + 1;
        return out;
      },
    },

    audit: {
      async record(input) {
        auditEntries.push({ action: input.action, target: input.target, orgId: input.orgId });
      },
    },
  };
}
