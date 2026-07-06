/**
 * The install planner + lock format (PRD §7.8, Milestone 6 phase 2).
 *
 * All against literals, no I/O: the planner takes plain data by design (app/marketplace/
 * install.server.ts), so path mapping, the dependency conflict policy, update-vs-conflict, and
 * the lock round-trip are each pinned here. If the planner's rules drift, these fail — which is
 * the point: install materializes files into customer repos, so its decisions need teeth.
 */
import { describe, expect, it } from "vitest";

import {
  planInstall,
  planUninstall,
  type PlanContext,
} from "~/marketplace/install.server";
import {
  emptyLock,
  findInstall,
  parseLock,
  removeInstall,
  serializeLock,
  upsertInstall,
  type EdenLock,
  type InstallEntry,
} from "~/marketplace/lock";
import type { CatalogTemplate } from "~/seams/types";

const REGISTRY = "fixture";

/** A tool template: one file, one dependency, one secret. */
const toolTpl: CatalogTemplate = {
  manifest: {
    id: "cloudflare-deploy",
    type: "tool",
    name: "Cloudflare Deploy",
    description: "Deploy a Worker.",
    version: "0.1.0",
    eve: ">=0.1.0",
    files: ["tools/cloudflare-deploy.ts"],
    dependencies: { wrangler: "^3.0.0" },
    secrets: [
      { name: "CLOUDFLARE_API_TOKEN", description: "token", sandbox: true },
    ],
  },
  files: { "tools/cloudflare-deploy.ts": "export default {};\n" },
};

/** An agent template: instructions + module + a tool, two deps. */
const agentTpl: CatalogTemplate = {
  manifest: {
    id: "cloudflare-deployment-engineer",
    type: "agent",
    name: "Cloudflare Deployment Engineer",
    description: "Deploys workers.",
    version: "0.1.0",
    eve: ">=0.1.0",
    model: "anthropic/claude-sonnet-5",
    files: ["instructions.md", "agent.ts", "tools/cloudflare-deploy.ts"],
    dependencies: { wrangler: "^3.0.0" },
  },
  files: {
    "instructions.md": "# Engineer\n",
    "agent.ts": "export default {};\n",
    "tools/cloudflare-deploy.ts": "export default {};\n",
  },
};

const browserSkillTpl: CatalogTemplate = {
  manifest: {
    id: "agent-browser",
    type: "skill",
    name: "Agent Browser",
    description: "Browser automation.",
    version: "0.1.0",
    eve: ">=0.1.0",
    files: ["skills/agent-browser.md"],
    sandbox: {
      bootstrap: [
        "if ! command -v chromium >/dev/null; then echo \"deb [arch=$(dpkg --print-architecture) trusted=yes] http://deb.debian.org/debian trixie main\" > /etc/apt/sources.list.d/debian-trixie.list && printf \"Package: *\\nPin: release n=trixie\\nPin-Priority: 100\\n\" > /etc/apt/preferences.d/debian-trixie && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends chromium && rm -rf /var/lib/apt/lists/*; fi",
        "npm install -g agent-browser@0.31.1",
        "AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium agent-browser --version",
      ],
      env: {
        AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
        AGENT_BROWSER_PROFILE: "/workspace/home/agent-browser/profile",
      },
      revalidationKey: "agent-browser@0.31.1-chromium-debian-trixie",
    },
  },
  files: { "skills/agent-browser.md": "# Agent Browser\n" },
};

function pkg(deps: Record<string, string>): string {
  return (
    JSON.stringify(
      {
        name: "pm",
        private: true,
        type: "module",
        scripts: { dev: "eve dev", build: "eve build" },
        dependencies: deps,
      },
      null,
      2,
    ) + "\n"
  );
}

/** A member-target context for the tool template, with overridable bits. */
function memberCtx(over: Partial<PlanContext> = {}): PlanContext {
  return {
    template: toolTpl,
    registry: REGISTRY,
    repoPaths: [],
    drafts: [],
    packageJson: pkg({ zod: "^3.23.0" }),
    lock: emptyLock(),
    target: { kind: "member", memberName: "pm", root: "agents/pm/agent" },
    ...over,
  };
}

describe("planInstall — path mapping", () => {
  it("maps a tool into an existing member's agent root", () => {
    const plan = planInstall(memberCtx());
    const paths = plan.writes.map((w) => w.path);
    expect(paths).toContain("agents/pm/agent/tools/cloudflare-deploy.ts");
    expect(paths).toContain("eden-lock.json");
    expect(plan.conflicts).toEqual([]);
    expect(plan.isUpdate).toBe(false);
    expect(plan.secrets).toEqual([
      // sandbox rides through so the wizard can flip the exposure flag on install.
      { name: "CLOUDFLARE_API_TOKEN", description: "token", sandbox: true },
    ]);
  });

  it("maps a single-agent (null member) tool into the root agent", () => {
    const plan = planInstall(
      memberCtx({
        packageJson: null,
        target: { kind: "member", memberName: null, root: "agent" },
      }),
    );
    const paths = plan.writes.map((w) => w.path);
    expect(paths).toContain("agent/tools/cloudflare-deploy.ts");
    // No package.json existed → a fresh one is written at the repo root, carrying the dep.
    expect(paths).toContain("package.json");
    const lockWrite = plan.writes.find((w) => w.path === "eden-lock.json")!;
    expect(
      findInstall(
        parseLock(JSON.parse(lockWrite.content)),
        "cloudflare-deploy",
        null,
      ),
    ).toBeDefined();
  });

  it("maps an agent into a NEW team member with a generated package.json", () => {
    const plan = planInstall({
      template: agentTpl,
      registry: REGISTRY,
      repoPaths: [],
      drafts: [],
      packageJson: null,
      lock: emptyLock(),
      rosterNames: ["pm"],
      target: { kind: "new-member", name: "deployer" },
    });
    const paths = plan.writes.map((w) => w.path);
    expect(paths).toContain("agents/deployer/agent/instructions.md");
    expect(paths).toContain("agents/deployer/agent/agent.ts");
    expect(paths).toContain("agents/deployer/agent/tools/cloudflare-deploy.ts");
    expect(paths).toContain("agents/deployer/package.json");
    expect(plan.conflicts).toEqual([]);

    const gen = JSON.parse(
      plan.writes.find((w) => w.path === "agents/deployer/package.json")!
        .content,
    );
    expect(gen.name).toBe("deployer");
    expect(gen.type).toBe("module");
    // Scaffold deps merged with the template's.
    expect(gen.dependencies).toEqual({
      eve: "latest",
      wrangler: "^3.0.0",
      zod: "^4.4.3",
    });

    // The lock records final paths, EXCLUDING the generated package.json.
    const entry = findInstall(
      parseLock(
        JSON.parse(
          plan.writes.find((w) => w.path === "eden-lock.json")!.content,
        ),
      ),
      "cloudflare-deployment-engineer",
      "deployer",
    )!;
    expect(entry.files).toEqual([
      "agents/deployer/agent/agent.ts",
      "agents/deployer/agent/instructions.md",
      "agents/deployer/agent/tools/cloudflare-deploy.ts",
    ]);
  });
});

describe("planInstall — lock secrets snapshot (§4.5)", () => {
  it("records manifest secrets in the lock entry so requirements survive forever", () => {
    const plan = planInstall(memberCtx());
    const lockWrite = plan.writes.find((w) => w.path === "eden-lock.json")!;
    const entry = findInstall(
      parseLock(JSON.parse(lockWrite.content)),
      "cloudflare-deploy",
      "pm",
    )!;
    expect(entry.secrets).toEqual([
      { name: "CLOUDFLARE_API_TOKEN", description: "token", sandbox: true },
    ]);
    // Values NEVER touch the plan or the lock.
    expect(lockWrite.content).not.toMatch(/value|ciphertext/i);
  });

  it("omits the secrets field entirely for templates that declare none", () => {
    const plan = planInstall({
      template: agentTpl,
      registry: REGISTRY,
      repoPaths: [],
      drafts: [],
      packageJson: null,
      lock: emptyLock(),
      rosterNames: ["pm"],
      target: { kind: "new-member", name: "deployer" },
    });
    const lockWrite = plan.writes.find((w) => w.path === "eden-lock.json")!;
    const entry = findInstall(
      parseLock(JSON.parse(lockWrite.content)),
      "cloudflare-deployment-engineer",
      "deployer",
    )!;
    expect(entry.secrets).toBeUndefined();
  });

  it("old locks without the field parse fine and produce no required rows", () => {
    const legacy = {
      version: 1,
      installs: [
        {
          id: "x",
          type: "tool",
          name: "X",
          version: "0.1.0",
          hash: "abc",
          registry: "fixture",
          member: null,
          files: ["agent/tools/x.ts"],
        },
      ],
    };
    const lock = parseLock(legacy);
    expect(lock.installs[0].secrets).toBeUndefined();
  });
});

describe("planInstall — sandbox setup", () => {
  it("materializes a marketplace sandbox add-on and managed sandbox module", () => {
    const plan = planInstall(
      memberCtx({
        template: browserSkillTpl,
        packageJson: null,
      }),
    );
    const paths = plan.writes.map((w) => w.path);
    expect(paths).toContain("agents/pm/agent/skills/agent-browser.md");
    expect(paths).toContain("agents/pm/agent/sandbox/addons/agent-browser.ts");
    expect(paths).toContain("agents/pm/agent/sandbox/sandbox.ts");

    const addon = plan.writes.find(
      (w) => w.path === "agents/pm/agent/sandbox/addons/agent-browser.ts",
    )!.content;
    expect(addon).toContain("npm install -g agent-browser@0.31.1");
    expect(addon).toContain("apt-get install -y --no-install-recommends chromium");
    expect(addon).toContain("AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium");

    const sandbox = plan.writes.find(
      (w) => w.path === "agents/pm/agent/sandbox/sandbox.ts",
    )!.content;
    expect(sandbox).toContain(
      'import * as addon0 from "./addons/agent-browser";',
    );
    expect(sandbox).toContain("EDEN_SANDBOX_ENV");
    expect(sandbox).toContain(
      "defaultBackend({ docker: { env }, vercel: { env } })",
    );

    const entry = findInstall(
      parseLock(
        JSON.parse(
          plan.writes.find((w) => w.path === "eden-lock.json")!.content,
        ),
      ),
      "agent-browser",
      "pm",
    )!;
    expect(entry.files).toEqual([
      "agents/pm/agent/sandbox/addons/agent-browser.ts",
      "agents/pm/agent/skills/agent-browser.md",
    ]);
    expect(entry.sandbox?.revalidationKey).toBe(
      "agent-browser@0.31.1-chromium-debian-trixie",
    );
  });

  it("updates the managed sandbox module with all installed add-ons for the member", () => {
    const priorPlan = planInstall(
      memberCtx({
        template: browserSkillTpl,
        packageJson: null,
      }),
    );
    const priorLock = parseLock(
      JSON.parse(
        priorPlan.writes.find((w) => w.path === "eden-lock.json")!.content,
      ),
    );
    const cloudflareSkill: CatalogTemplate = {
      manifest: {
        id: "cloudflare-cli",
        type: "skill",
        name: "Cloudflare CLI",
        description: "Cloudflare CLI.",
        version: "0.1.0",
        eve: ">=0.1.0",
        files: ["skills/cloudflare-cli.md"],
        sandbox: {
          bootstrap: ["npm install -g wrangler@latest"],
          revalidationKey: "wrangler@latest",
        },
      },
      files: { "skills/cloudflare-cli.md": "# Cloudflare CLI\n" },
    };
    const plan = planInstall(
      memberCtx({
        template: cloudflareSkill,
        packageJson: null,
        lock: priorLock,
      }),
    );
    const sandbox = plan.writes.find(
      (w) => w.path === "agents/pm/agent/sandbox/sandbox.ts",
    )!.content;
    expect(sandbox).toContain(
      'import * as addon0 from "./addons/agent-browser";',
    );
    expect(sandbox).toContain(
      'import * as addon1 from "./addons/cloudflare-cli";',
    );
    expect(sandbox).toContain("const addons = [addon0, addon1];");
  });
});

describe("planInstall — dependency merge policy", () => {
  it("adds a dependency the package doesn't have", () => {
    const plan = planInstall(
      memberCtx({ packageJson: pkg({ zod: "^3.23.0" }) }),
    );
    const pkgWrite = plan.writes.find(
      (w) => w.path === "agents/pm/package.json",
    )!;
    expect(pkgWrite).toBeDefined();
    expect(JSON.parse(pkgWrite.content).dependencies).toEqual({
      wrangler: "^3.0.0",
      zod: "^3.23.0",
    });
    expect(plan.warnings).toEqual([]);
  });

  it("keeps an intersecting existing range silently (no churn, no warning)", () => {
    const plan = planInstall(
      memberCtx({ packageJson: pkg({ wrangler: "^3.1.0" }) }),
    );
    expect(plan.writes.some((w) => w.path === "agents/pm/package.json")).toBe(
      false,
    );
    expect(plan.warnings).toEqual([]);
  });

  it("warns and keeps the agent's range when ranges are disjoint", () => {
    const plan = planInstall(
      memberCtx({ packageJson: pkg({ wrangler: "^2.0.0" }) }),
    );
    expect(plan.writes.some((w) => w.path === "agents/pm/package.json")).toBe(
      false,
    );
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("wrangler");
    expect(plan.warnings[0]).toContain("^2.0.0");
    expect(plan.warnings[0]).toContain("^3.0.0");
  });
});

describe("planInstall — conflicts", () => {
  it("flags a target path that already exists on the branch", () => {
    const plan = planInstall(
      memberCtx({ repoPaths: ["agents/pm/agent/tools/cloudflare-deploy.ts"] }),
    );
    expect(plan.conflicts).toEqual([
      "agents/pm/agent/tools/cloudflare-deploy.ts",
    ]);
  });

  it("flags a target path occupied by a staged (non-deletion) draft", () => {
    const plan = planInstall(
      memberCtx({
        drafts: [
          {
            path: "agents/pm/agent/tools/cloudflare-deploy.ts",
            content: "mine\n",
          },
        ],
      }),
    );
    expect(plan.conflicts).toEqual([
      "agents/pm/agent/tools/cloudflare-deploy.ts",
    ]);
  });

  it("does NOT flag a path with only a staged deletion draft", () => {
    const plan = planInstall(
      memberCtx({
        drafts: [
          { path: "agents/pm/agent/tools/cloudflare-deploy.ts", content: null },
        ],
      }),
    );
    expect(plan.conflicts).toEqual([]);
  });

  it("never treats package.json or eden-lock.json as a conflict (they merge)", () => {
    const plan = planInstall(
      memberCtx({
        repoPaths: ["agents/pm/package.json", "eden-lock.json"],
        packageJson: pkg({ zod: "^3.23.0" }),
      }),
    );
    expect(plan.conflicts).toEqual([]);
    expect(plan.writes.some((w) => w.path === "eden-lock.json")).toBe(true);
  });
});

describe("planInstall — update mode", () => {
  it("reinstalling the same id+member overwrites and deletes dropped files", () => {
    const prior: InstallEntry = {
      id: "cloudflare-deploy",
      type: "tool",
      name: "Cloudflare Deploy",
      version: "0.0.9",
      hash: "old",
      registry: REGISTRY,
      member: "pm",
      files: [
        "agents/pm/agent/tools/cloudflare-deploy.ts",
        "agents/pm/agent/tools/legacy.ts",
      ],
      dependencies: { wrangler: "^3.0.0" },
    };
    const lock = upsertInstall(emptyLock(), prior);
    const plan = planInstall(
      memberCtx({
        lock,
        repoPaths: [
          "agents/pm/agent/tools/cloudflare-deploy.ts",
          "agents/pm/agent/tools/legacy.ts",
        ],
      }),
    );
    expect(plan.isUpdate).toBe(true);
    // Owning our own files is not a conflict.
    expect(plan.conflicts).toEqual([]);
    // The old version's dropped file is scheduled for deletion.
    expect(plan.deletions).toEqual(["agents/pm/agent/tools/legacy.ts"]);
  });
});

describe("planInstall — new-member validation", () => {
  const base = {
    template: agentTpl,
    registry: REGISTRY,
    repoPaths: [] as string[],
    drafts: [],
    packageJson: null,
    lock: emptyLock(),
  };

  it("rejects a name already in the roster", () => {
    const plan = planInstall({
      ...base,
      rosterNames: ["pm", "deployer"],
      target: { kind: "new-member", name: "deployer" },
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toContain("deployer");
  });

  it("rejects an invalid (non-slug) name", () => {
    const plan = planInstall({
      ...base,
      rosterNames: [],
      target: { kind: "new-member", name: "Not Valid" },
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toContain("valid member name");
  });

  it("flags an orphan package.json already at the new member's path", () => {
    // A half-deleted member leaves agents/<name>/package.json with no agent/ dir — the roster
    // misses it, but the generated package.json is a CREATE and must not clobber it silently.
    const plan = planInstall({
      ...base,
      rosterNames: [],
      repoPaths: ["agents/deployer/package.json"],
      target: { kind: "new-member", name: "deployer" },
    });
    expect(plan.conflicts).toEqual(["agents/deployer/package.json"]);
  });
});

describe("planInstall — malformed package.json", () => {
  it("is a blocking conflict, not a crash", () => {
    const plan = planInstall(memberCtx({ packageJson: "{ not json" }));
    expect(plan.conflicts).toEqual([
      "agents/pm/package.json is not valid JSON — fix it before installing.",
    ]);
    // No package.json write is staged; the template file + lock writes still plan fine.
    expect(plan.writes.map((w) => w.path)).toEqual([
      "agents/pm/agent/tools/cloudflare-deploy.ts",
      "eden-lock.json",
    ]);
  });
});

describe("planInstall — resolved (composed) templates", () => {
  /** A flattened agent template as compose.server.ts hands it to the planner: extra hash + includes. */
  const resolvedEngineer: CatalogTemplate & {
    hash?: string;
    includes?: Array<{
      id: string;
      type: "channel";
      name: string;
      version: string;
      hash: string;
    }>;
  } = {
    manifest: {
      id: "engineer",
      type: "agent",
      name: "Engineer",
      description: "Ships code.",
      version: "0.2.0",
      eve: ">=0.1.0",
      // The channel's file is flattened in alongside the agent's own files.
      files: ["channels/discord.ts", "agent.ts", "instructions.md"],
      secrets: [{ name: "DISCORD_BOT_TOKEN", description: "bot token" }],
    },
    files: {
      "channels/discord.ts": "export default {};\n",
      "agent.ts": "export default {};\n",
      "instructions.md": "# Engineer\n",
    },
    hash: "parent-own-hash",
    includes: [
      {
        id: "discord",
        type: "channel",
        name: "Discord",
        version: "0.1.0",
        hash: "discord-own-hash",
      },
    ],
  };

  it("records the PROVIDED hash + includes and lands every flattened file under the member dir", () => {
    const plan = planInstall({
      template: resolvedEngineer,
      registry: REGISTRY,
      repoPaths: [],
      drafts: [],
      packageJson: null,
      lock: emptyLock(),
      rosterNames: ["pm"],
      target: { kind: "new-member", name: "eng" },
    });
    const paths = plan.writes.map((w) => w.path);
    expect(paths).toContain("agents/eng/agent/channels/discord.ts");
    expect(paths).toContain("agents/eng/agent/agent.ts");
    expect(paths).toContain("agents/eng/agent/instructions.md");

    const entry = findInstall(
      parseLock(
        JSON.parse(
          plan.writes.find((w) => w.path === "eden-lock.json")!.content,
        ),
      ),
      "engineer",
      "eng",
    )!;
    // The resolver-supplied hash is used verbatim (not recomputed over the flattened template).
    expect(entry.hash).toBe("parent-own-hash");
    expect(entry.includes).toEqual([
      {
        id: "discord",
        type: "channel",
        name: "Discord",
        version: "0.1.0",
        hash: "discord-own-hash",
      },
    ]);
  });

  it("update dropping an include stages the dropped included file for deletion", () => {
    const prior: InstallEntry = {
      id: "engineer",
      type: "agent",
      name: "Engineer",
      version: "0.1.0",
      hash: "old",
      registry: REGISTRY,
      member: "eng",
      files: [
        "agents/eng/agent/agent.ts",
        "agents/eng/agent/channels/discord.ts",
        "agents/eng/agent/instructions.md",
      ],
      includes: [
        {
          id: "discord",
          type: "channel",
          name: "Discord",
          version: "0.1.0",
          hash: "discord-own-hash",
        },
      ],
    };
    // The new resolved version no longer includes Discord — its file is gone from the flatten.
    const noDiscord: CatalogTemplate & { hash?: string } = {
      manifest: {
        id: "engineer",
        type: "agent",
        name: "Engineer",
        description: "Ships code.",
        version: "0.2.0",
        eve: ">=0.1.0",
        files: ["agent.ts", "instructions.md"],
      },
      files: {
        "agent.ts": "export default {};\n",
        "instructions.md": "# Engineer\n",
      },
      hash: "new-own-hash",
    };
    const plan = planInstall({
      template: noDiscord,
      registry: REGISTRY,
      repoPaths: prior.files,
      drafts: [],
      packageJson: null,
      lock: upsertInstall(emptyLock(), prior),
      target: { kind: "member", memberName: "eng", root: "agents/eng/agent" },
    });
    expect(plan.isUpdate).toBe(true);
    expect(plan.conflicts).toEqual([]);
    expect(plan.deletions).toEqual(["agents/eng/agent/channels/discord.ts"]);
  });

  it("a standalone channel install collides with a path an agent-install already owns", () => {
    // The engineer agent materialized channels/discord.ts under member x (a different lock entry).
    const agentEntry: InstallEntry = {
      id: "engineer",
      type: "agent",
      name: "Engineer",
      version: "0.2.0",
      hash: "h",
      registry: REGISTRY,
      member: "x",
      files: [
        "agents/x/agent/agent.ts",
        "agents/x/agent/channels/discord.ts",
      ],
    };
    const discordChannel: CatalogTemplate = {
      manifest: {
        id: "discord",
        type: "channel",
        name: "Discord",
        description: "Talk from Discord.",
        version: "0.1.0",
        eve: ">=0.20.0",
        files: ["channels/discord.ts"],
      },
      files: { "channels/discord.ts": "export default {};\n" },
    };
    const plan = planInstall({
      template: discordChannel,
      registry: REGISTRY,
      repoPaths: agentEntry.files,
      drafts: [],
      packageJson: null,
      lock: upsertInstall(emptyLock(), agentEntry),
      target: { kind: "member", memberName: "x", root: "agents/x/agent" },
    });
    // A DIFFERENT lock entry owns the path, so this is a blocking conflict, not an update.
    expect(plan.isUpdate).toBe(false);
    expect(plan.conflicts).toEqual(["agents/x/agent/channels/discord.ts"]);
  });
});

describe("lock helpers round-trip", () => {
  const entry: InstallEntry = {
    id: "cloudflare-deploy",
    type: "tool",
    name: "Cloudflare Deploy",
    version: "0.1.0",
    hash: "abc",
    registry: REGISTRY,
    member: "pm",
    files: ["agents/pm/agent/tools/cloudflare-deploy.ts"],
    dependencies: { wrangler: "^3.0.0" },
  };

  it("upsert then serialize/parse is stable", () => {
    const lock = upsertInstall(emptyLock(), entry);
    const parsed = parseLock(JSON.parse(serializeLock(lock)));
    expect(parsed).toEqual(lock);
    expect(findInstall(parsed, "cloudflare-deploy", "pm")).toEqual(entry);
  });

  it("upsert replaces the same (id, member), not appends", () => {
    let lock = upsertInstall(emptyLock(), entry);
    lock = upsertInstall(lock, { ...entry, version: "0.2.0" });
    expect(lock.installs).toHaveLength(1);
    expect(findInstall(lock, "cloudflare-deploy", "pm")!.version).toBe("0.2.0");
  });

  it("the same id under a different member is a distinct install", () => {
    let lock = upsertInstall(emptyLock(), entry);
    lock = upsertInstall(lock, { ...entry, member: "qa" });
    expect(lock.installs).toHaveLength(2);
  });

  it("remove drops exactly the (id, member) entry", () => {
    const lock = upsertInstall(emptyLock(), entry);
    const after = removeInstall(lock, "cloudflare-deploy", "pm");
    expect(after.installs).toEqual([]);
  });
});

describe("planUninstall", () => {
  const entry: InstallEntry = {
    id: "cloudflare-deploy",
    type: "tool",
    name: "Cloudflare Deploy",
    version: "0.1.0",
    hash: "abc",
    registry: REGISTRY,
    member: "pm",
    files: [
      "agents/pm/agent/tools/cloudflare-deploy.ts",
      "agents/pm/agent/tools/helper.ts",
    ],
    dependencies: { wrangler: "^3.0.0" },
  };
  const lock: EdenLock = upsertInstall(emptyLock(), entry);

  it("deletes the entry's files, drops it from the lock, lists deps left", () => {
    const plan = planUninstall({
      lock,
      id: "cloudflare-deploy",
      memberName: "pm",
      repoPaths: entry.files,
    });
    expect(plan.notFound).toBe(false);
    expect(plan.deletions).toEqual(entry.files);
    expect(plan.depsLeft).toEqual(["wrangler"]);
    const parsed = parseLock(JSON.parse(plan.lockWrite.content));
    expect(findInstall(parsed, "cloudflare-deploy", "pm")).toBeUndefined();
  });

  it("only deletes files still present on the branch", () => {
    const plan = planUninstall({
      lock,
      id: "cloudflare-deploy",
      memberName: "pm",
      repoPaths: ["agents/pm/agent/tools/cloudflare-deploy.ts"],
    });
    expect(plan.deletions).toEqual([
      "agents/pm/agent/tools/cloudflare-deploy.ts",
    ]);
  });

  it("reports notFound for an install that isn't in the lock", () => {
    const plan = planUninstall({
      lock,
      id: "nope",
      memberName: "pm",
      repoPaths: [],
    });
    expect(plan.notFound).toBe(true);
    expect(plan.deletions).toEqual([]);
  });

  it("removes sandbox add-ons and regenerates the managed sandbox module", () => {
    const installPlan = planInstall(
      memberCtx({
        template: browserSkillTpl,
        packageJson: null,
      }),
    );
    const installedLock = parseLock(
      JSON.parse(
        installPlan.writes.find((w) => w.path === "eden-lock.json")!.content,
      ),
    );
    const entry = findInstall(installedLock, "agent-browser", "pm")!;
    const plan = planUninstall({
      lock: installedLock,
      id: "agent-browser",
      memberName: "pm",
      repoPaths: entry.files,
    });
    expect(plan.deletions).toEqual([
      "agents/pm/agent/sandbox/addons/agent-browser.ts",
      "agents/pm/agent/skills/agent-browser.md",
    ]);
    expect(plan.writes.map((w) => w.path)).toEqual([
      "eden-lock.json",
      "agents/pm/agent/sandbox/sandbox.ts",
    ]);
    expect(
      plan.writes.find((w) => w.path === "agents/pm/agent/sandbox/sandbox.ts")!
        .content,
    ).toContain("const addons = [];");
  });
});
