import { describe, expect, it } from "vitest";

import {
  addDependency,
  assembleBundle,
  deleteFile_,
  projectContext,
  resolveAssistantContext,
  runChecks,
  scaffoldMember,
  writeFile_,
  type AuthoringDeps,
  type AuthoringProject,
} from "~/assistant/authoring.server";
import { listDrafts, stageDraft } from "~/drafts/drafts.server";
import type { BuildCheckResult } from "~/seams/types";
import { makeFakeStore, type FakeStore } from "../fakes/store";

const project: AuthoringProject = {
  id: "p",
  orgId: "o",
  name: "repo",
  slug: "repo",
  repoOwner: "acme",
  repoName: "repo",
  repoInstallationId: "inst",
  defaultBranch: "main",
  createdAt: new Date(),
  updatedAt: new Date(),
};

function harness(opts?: {
  repoFiles?: Record<string, string>;
  checkBuild?: BuildCheckResult | null;
}) {
  const store = makeFakeStore();
  store.seedProject({ id: "p", orgId: "o", repoOwner: "acme", repoName: "repo" });
  store.seedAgent({ id: "m1", projectId: "p", name: "agent", root: "agent" });
  const repoFiles = opts?.repoFiles ?? {};

  const resolveFileView: AuthoringDeps["resolveFileView"] = async (_p, path) => {
    const draft = await store.drafts.get("p", path);
    if (draft) {
      return draft.content === null
        ? { content: null, source: "draft", existsInRepo: path in repoFiles, change: null, stagedDeletion: true }
        : { content: draft.content, source: "draft", existsInRepo: path in repoFiles, change: null, stagedDeletion: false };
    }
    const content = repoFiles[path] ?? null;
    return { content, source: "repo", existsInRepo: content !== null, change: null, stagedDeletion: false };
  };

  const deps: AuthoringDeps = {
    store,
    getSource: async () => ({
      paths: Object.keys(repoFiles),
      files: {},
      ref: "main",
      truncated: false,
    }),
    resolveFileView,
    stageDraft: (input) => stageDraft(input, store),
    listDrafts: (pid) => listDrafts(pid, store),
    readPublished: async (_p, path) => repoFiles[path] ?? null,
    resolveManifests: async ({ packages }) => ({
      packageJson: JSON.stringify({ dependencies: Object.fromEntries(packages.map((p) => [p, "1.0.0"])) }),
      packageLock: JSON.stringify({ lockfileVersion: 3, packages: {} }),
    }),
    checkBuild:
      opts?.checkBuild === null
        ? null
        : async () => opts?.checkBuild ?? { ok: true },
    secretKeys: async () => [],
    catalog: {
      name: "fake",
      index: async () => ({ templates: [] }) as never,
      template: async () => ({ manifest: {}, files: {} }) as never,
    },
  };
  return { store, deps, repoFiles };
}

describe("assistant authoring: write policy", () => {
  it("stages a member file as a draft attributed to that member", async () => {
    const { store, deps } = harness();
    const res = await writeFile_(project, "agent/tools/foo.ts", "export default 1;", deps);
    expect(res).toMatchObject({ ok: true, path: "agent/tools/foo.ts" });
    const drafts = await store.drafts.listByProject("p");
    expect(drafts).toHaveLength(1);
    expect(drafts[0].agentId).toBe("m1"); // attributed via agentForPath
  });

  it("refuses package manifests, assistant.json, and off-surface paths", async () => {
    const { deps } = harness();
    expect(await writeFile_(project, "package.json", "{}", deps)).toMatchObject({ ok: false });
    expect(await writeFile_(project, "agent/package-lock.json", "{}", deps)).toMatchObject({ ok: false });
    expect(await writeFile_(project, ".eden/assistant/assistant.json", "{}", deps)).toMatchObject({ ok: false });
    expect(await writeFile_(project, ".eden/assistant/agent.ts", "x", deps)).toMatchObject({ ok: false });
    expect(await writeFile_(project, "Dockerfile", "x", deps)).toMatchObject({ ok: false });
  });

  it("allows the assistant markdown config surface", async () => {
    const { deps } = harness();
    expect(await writeFile_(project, ".eden/assistant/instructions.md", "# hi", deps)).toMatchObject({ ok: true });
    expect(await writeFile_(project, ".eden/assistant/skills/x.md", "# s", deps)).toMatchObject({ ok: true });
  });

  it("stages a deletion", async () => {
    const { store, deps } = harness({ repoFiles: { "agent/tools/old.ts": "x" } });
    const res = await deleteFile_(project, "agent/tools/old.ts", deps);
    expect(res).toMatchObject({ ok: true });
    const [draft] = await store.drafts.listByProject("p");
    expect(draft.content).toBeNull();
  });
});

describe("assistant authoring: add-dependency", () => {
  it("stages regenerated package.json + lock", async () => {
    const { store, deps } = harness({ repoFiles: { "package.json": JSON.stringify({ dependencies: {} }) } });
    const res = await addDependency(project, { packages: ["zod@4"], agentRoot: "agent" }, deps);
    expect(res).toMatchObject({ ok: true, staged: ["package.json", "package-lock.json"] });
    const paths = (await store.drafts.listByProject("p")).map((d) => d.path).sort();
    expect(paths).toEqual(["package-lock.json", "package.json"]);
  });

  it("targets a team member's manifest by root", async () => {
    const { deps } = harness({ repoFiles: { "agents/pm/package.json": JSON.stringify({ dependencies: {} }) } });
    const res = await addDependency(project, { packages: ["pg"], agentRoot: "agents/pm/agent" }, deps);
    expect(res).toMatchObject({ ok: true, staged: ["agents/pm/package.json", "agents/pm/package-lock.json"] });
  });

  it("rejects invalid specs and missing manifests", async () => {
    const { deps } = harness();
    expect(await addDependency(project, { packages: ["../evil"] }, deps)).toMatchObject({ ok: false });
    expect(await addDependency(project, { packages: [] }, deps)).toMatchObject({ ok: false });
    expect(await addDependency(project, { packages: ["pg"] }, deps)).toMatchObject({ ok: false }); // no package.json
  });
});

describe("assistant authoring: run-checks", () => {
  it("skips the build for an assistant-only (.eden) changeset", async () => {
    const { deps } = harness();
    await writeFile_(project, ".eden/assistant/instructions.md", "# hi", deps);
    const res = await runChecks(project, deps);
    expect(res).toMatchObject({ ok: true, ran: false, skipped: true });
  });

  it("runs the build for member changesets and surfaces failures", async () => {
    const { deps } = harness({ checkBuild: { ok: false, output: "TS error" } });
    await writeFile_(project, "agent/tools/foo.ts", "x", deps);
    const res = await runChecks(project, deps);
    expect(res).toMatchObject({ ok: true, ran: true, passed: false, output: "TS error" });
  });
});

describe("assistant authoring: scaffold-member", () => {
  it("stages a new member scaffold as drafts", async () => {
    const { store, deps } = harness();
    const res = await scaffoldMember(project, "Growth Bot", deps);
    expect(res).toMatchObject({ ok: true, member: "growth-bot" });
    const paths = (await store.drafts.listByProject("p")).map((d) => d.path);
    expect(paths.some((p) => p.startsWith("agents/growth-bot/"))).toBe(true);
  });

  it("rejects reserved and duplicate names", async () => {
    const { store, deps } = harness();
    store.seedAgent({ id: "m2", projectId: "p", name: "pm", root: "agents/pm/agent" });
    expect(await scaffoldMember(project, "assistant", deps)).toMatchObject({ ok: false });
    expect(await scaffoldMember(project, "pm", deps)).toMatchObject({ ok: false });
  });
});

describe("assistant authoring: bundle + context", () => {
  it("assembles published config into the entrypoint bundle shape", async () => {
    const { deps } = harness({
      repoFiles: {
        ".eden/assistant/instructions.md": "Be helpful.",
        ".eden/assistant/skills/deploys.md": "# deploys",
        ".eden/assistant/schedules/daily.md": "# daily",
        ".eden/assistant/assistant.json": JSON.stringify({ model: "anthropic/claude-sonnet-5" }),
      },
    });
    const bundle = await assembleBundle(project, deps);
    expect(bundle.instructions).toBe("Be helpful.");
    expect(bundle.model).toBe("anthropic/claude-sonnet-5");
    expect(bundle.files).toEqual({
      "skills/user/deploys.md": "# deploys",
      "schedules/user/daily.md": "# daily",
    });
  });

  it("project-context lists members and staged drafts", async () => {
    const { deps } = harness({ repoFiles: { ".eden/assistant/instructions.md": "hi" } });
    await writeFile_(project, "agent/tools/foo.ts", "x", deps);
    const ctx = await projectContext(project, deps);
    expect(ctx).toMatchObject({ ok: true, isTeam: false });
    if (ctx.ok) {
      expect(ctx.members.map((m) => m.name)).toEqual(["agent"]);
      expect(ctx.assistantConfig.instructions).toBe(true);
      expect(ctx.stagedDrafts).toEqual([{ path: "agent/tools/foo.ts", deletion: false }]);
    }
  });
});

describe("assistant authoring: caller resolution", () => {
  it("rejects a deployment whose agent is not the assistant", async () => {
    const store = makeFakeStore();
    store.seedProject({ id: "p", orgId: "o", repoOwner: "a", repoName: "r", repoInstallationId: "i" });
    store.seedAgent({ id: "m1", projectId: "p", name: "agent", root: "agent" }); // kind member
    const env = store.seedEnvironment({ id: "e1", projectId: "p", agentId: "m1", name: "default" });
    const dep = await store.deployments.insert({
      environmentId: env.id,
      releaseId: "rel",
      status: "live",
      trafficWeight: 100,
    });
    expect(await resolveAssistantContext(dep.id, store)).toBeNull();
  });

  it("resolves an assistant deployment to its project", async () => {
    const store = makeFakeStore();
    store.seedProject({ id: "p", orgId: "o", repoOwner: "a", repoName: "r", repoInstallationId: "i" });
    const assistant = await store.agents.createAssistant({ projectId: "p", name: "assistant", root: ".eden/assistant" });
    const env = store.seedEnvironment({ id: "e1", projectId: "p", agentId: assistant.id, name: "assistant" });
    const dep = await store.deployments.insert({
      environmentId: env.id,
      releaseId: "rel",
      status: "live",
      trafficWeight: 100,
    });
    const ctx = await resolveAssistantContext(dep.id, store);
    expect(ctx).toMatchObject({ agentId: assistant.id, deploymentId: dep.id });
    expect(ctx?.project.id).toBe("p");
  });
});
