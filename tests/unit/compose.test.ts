/**
 * Catalog composition — the include resolver (PRD §7.8, marketplace composition).
 *
 * All against an in-memory CatalogSource fake, no I/O: resolveTemplate (compose.server.ts) sits on
 * top of the unchanged seam and flattens `includes` into one materialized template. These pin the
 * merge rules — files union (dup = error), deps parent-wins, secrets union (desc first-wins,
 * sandbox OR), connections union, sandbox merge, provenance, and the own-hash invariant — plus the
 * guard rails: cycles, depth cap, agent-include rejection, missing references.
 */
import { describe, expect, it } from "vitest";

import { resolveTemplate } from "~/marketplace/compose.server";
import { templateContentHash } from "~/marketplace/hash.server";
import type { TemplateManifest } from "~/marketplace/manifest";
import type { CatalogTemplate } from "~/seams/types";
import { fakeCatalog } from "../fakes/catalog";

/** A channel bundled by reference: files, a secret, a connection, deps, and sandbox setup. */
const channelTpl: CatalogTemplate = {
  manifest: {
    id: "discord",
    type: "channel",
    name: "Discord",
    description: "Talk from Discord.",
    version: "0.1.0",
    eve: ">=0.20.0",
    files: ["channels/discord.ts"],
    dependencies: { "discord-lib": "^1.0.0" },
    secrets: [
      { name: "DISCORD_BOT_TOKEN", description: "bot token" },
      { name: "SHARED_SECRET", description: "from channel", provisioned: true },
    ],
    connections: ["discord-gateway"],
    sandbox: {
      bootstrap: ["install discord"],
      env: { DISCORD_ENV: "chan", SHARED_ENV: "chan" },
      revalidationKey: "discord@1",
    },
  },
  files: { "channels/discord.ts": "export default {};\n" },
};

/** A tool bundled by reference: one file, one dependency that collides with the parent's. */
const toolTpl: CatalogTemplate = {
  manifest: {
    id: "search",
    type: "tool",
    name: "Search",
    description: "Search the web.",
    version: "0.3.0",
    eve: ">=0.1.0",
    files: ["tools/search.ts"],
    dependencies: { "search-lib": "^2.0.0" },
  },
  files: { "tools/search.ts": "export default {};\n" },
};

/** The parent agent that includes the channel + the tool. */
const agentTpl: CatalogTemplate = {
  manifest: {
    id: "engineer",
    type: "agent",
    name: "Engineer",
    description: "Ships code.",
    version: "1.0.0",
    eve: ">=0.1.0",
    model: "some/model",
    files: ["agent.ts", "instructions.md"],
    includes: [
      { type: "channel", id: "discord" },
      { type: "tool", id: "search" },
    ],
    dependencies: { "search-lib": "^3.0.0", "agent-lib": "^1.0.0" },
    secrets: [
      { name: "SHARED_SECRET", description: "from parent", sandbox: true },
      { name: "AGENT_SECRET", description: "agent only" },
    ],
    connections: ["agent-conn", "discord-gateway"],
    sandbox: {
      bootstrap: ["agent boot"],
      env: { AGENT_ENV: "agent", SHARED_ENV: "parent" },
      revalidationKey: "agent@1",
    },
  },
  files: { "agent.ts": "export default {};\n", "instructions.md": "# Engineer\n" },
};

describe("resolveTemplate — flattening an agent that includes a channel + a tool", () => {
  const source = fakeCatalog([channelTpl, toolTpl, agentTpl]);

  it("unions files, includes-first then parent (order stable)", async () => {
    const resolved = await resolveTemplate(source, "agent", "engineer");
    expect(resolved.manifest.files).toEqual([
      "channels/discord.ts",
      "tools/search.ts",
      "agent.ts",
      "instructions.md",
    ]);
    expect(new Set(Object.keys(resolved.files))).toEqual(
      new Set(resolved.manifest.files),
    );
    expect(resolved.files["channels/discord.ts"]).toBe("export default {};\n");
  });

  it("merges dependencies with the parent winning collisions", async () => {
    const resolved = await resolveTemplate(source, "agent", "engineer");
    expect(resolved.manifest.dependencies).toEqual({
      "discord-lib": "^1.0.0",
      "search-lib": "^3.0.0", // parent's ^3 beats the tool's ^2
      "agent-lib": "^1.0.0",
    });
  });

  it("unions secrets by name — first occurrence keeps its description, sandbox/provisioned OR", async () => {
    const resolved = await resolveTemplate(source, "agent", "engineer");
    expect(resolved.manifest.secrets).toEqual([
      { name: "DISCORD_BOT_TOKEN", description: "bot token" },
      // channel declared it first ("from channel", provisioned); parent re-declares it
      // sandbox:true → both flags OR across occurrences, so neither is lost in the flatten.
      {
        name: "SHARED_SECRET",
        description: "from channel",
        sandbox: true,
        provisioned: true,
      },
      { name: "AGENT_SECRET", description: "agent only" },
    ]);
  });

  it("unions connections, deduped, includes-first then parent", async () => {
    const resolved = await resolveTemplate(source, "agent", "engineer");
    expect(resolved.manifest.connections).toEqual([
      "discord-gateway",
      "agent-conn",
    ]);
  });

  it("merges sandbox: bootstrap includes→parent, env parent-wins, revalidationKey joined", async () => {
    const resolved = await resolveTemplate(source, "agent", "engineer");
    expect(resolved.manifest.sandbox).toEqual({
      bootstrap: ["install discord", "agent boot"],
      env: { DISCORD_ENV: "chan", SHARED_ENV: "parent", AGENT_ENV: "agent" },
      revalidationKey: "discord@1|agent@1",
    });
  });

  it("keeps the parent's model and eve range only", async () => {
    const resolved = await resolveTemplate(source, "agent", "engineer");
    expect(resolved.manifest.model).toBe("some/model");
    expect(resolved.manifest.eve).toBe(">=0.1.0");
  });

  it("removes `includes` from the resolved manifest", async () => {
    const resolved = await resolveTemplate(source, "agent", "engineer");
    expect(resolved.manifest.includes).toBeUndefined();
  });

  it("records provenance with each include's id/type/name/version/own-hash", async () => {
    const resolved = await resolveTemplate(source, "agent", "engineer");
    expect(resolved.includes).toEqual([
      {
        id: "discord",
        type: "channel",
        name: "Discord",
        version: "0.1.0",
        hash: templateContentHash(channelTpl),
      },
      {
        id: "search",
        type: "tool",
        name: "Search",
        version: "0.3.0",
        hash: templateContentHash(toolTpl),
      },
    ]);
  });

  it("the parent hash is the parent's OWN content hash (unresolved)", async () => {
    const resolved = await resolveTemplate(source, "agent", "engineer");
    expect(resolved.hash).toBe(templateContentHash(agentTpl));
  });
});

describe("resolveTemplate — nesting", () => {
  const tool: CatalogTemplate = {
    manifest: {
      id: "t",
      type: "tool",
      name: "T",
      description: "t",
      version: "0.1.0",
      eve: ">=0.1.0",
      files: ["tools/t.ts"],
      dependencies: { tl: "^1.0.0" },
    },
    files: { "tools/t.ts": "export default {};\n" },
  };
  const skill: CatalogTemplate = {
    manifest: {
      id: "s",
      type: "skill",
      name: "S",
      description: "s",
      version: "0.1.0",
      eve: ">=0.1.0",
      files: ["skills/s.md"],
      includes: [{ type: "tool", id: "t" }],
    },
    files: { "skills/s.md": "# S\n" },
  };
  const agent: CatalogTemplate = {
    manifest: {
      id: "a",
      type: "agent",
      name: "A",
      description: "a",
      version: "0.1.0",
      eve: ">=0.1.0",
      files: ["agent.ts"],
      includes: [{ type: "skill", id: "s" }],
    },
    files: { "agent.ts": "export default {};\n" },
  };

  it("resolves transitively (agent → skill → tool)", async () => {
    const source = fakeCatalog([tool, skill, agent]);
    const resolved = await resolveTemplate(source, "agent", "a");
    // The tool's file rode up through the skill into the agent.
    expect(new Set(Object.keys(resolved.files))).toEqual(
      new Set(["tools/t.ts", "skills/s.md", "agent.ts"]),
    );
    expect(resolved.manifest.dependencies).toEqual({ tl: "^1.0.0" });
    // Provenance is the DIRECT include only (the skill), carrying the skill's own hash.
    expect(resolved.includes).toEqual([
      {
        id: "s",
        type: "skill",
        name: "S",
        version: "0.1.0",
        hash: templateContentHash(skill),
      },
    ]);
  });
});

describe("resolveTemplate — a template with no includes resolves to itself", () => {
  it("returns the same manifest/files, own hash, and empty includes", async () => {
    const source = fakeCatalog([toolTpl]);
    const resolved = await resolveTemplate(source, "tool", "search");
    expect(resolved.manifest.files).toEqual(toolTpl.manifest.files);
    expect(resolved.files).toEqual(toolTpl.files);
    expect(resolved.manifest.includes).toBeUndefined();
    expect(resolved.includes).toEqual([]);
    expect(resolved.hash).toBe(templateContentHash(toolTpl));
  });
});

describe("resolveTemplate — guard rails", () => {
  it("throws on a cycle, naming it", async () => {
    const a: CatalogTemplate = {
      manifest: {
        id: "a",
        type: "skill",
        name: "A",
        description: "a",
        version: "0.1.0",
        eve: ">=0.1.0",
        files: ["skills/a.md"],
        includes: [{ type: "skill", id: "b" }],
      },
      files: { "skills/a.md": "# A\n" },
    };
    const b: CatalogTemplate = {
      manifest: {
        id: "b",
        type: "skill",
        name: "B",
        description: "b",
        version: "0.1.0",
        eve: ">=0.1.0",
        files: ["skills/b.md"],
        includes: [{ type: "skill", id: "a" }],
      },
      files: { "skills/b.md": "# B\n" },
    };
    const source = fakeCatalog([a, b]);
    await expect(resolveTemplate(source, "skill", "a")).rejects.toThrow(
      /cycle.*skill\/a.*skill\/b.*skill\/a/is,
    );
  });

  it("throws when include nesting exceeds the depth cap", async () => {
    // A straight chain s0 → s1 → … → s8 (9 templates): resolving trips the cap of 8.
    const chain: CatalogTemplate[] = [];
    for (let i = 0; i <= 8; i++) {
      chain.push({
        manifest: {
          id: `s${i}`,
          type: "skill",
          name: `S${i}`,
          description: "s",
          version: "0.1.0",
          eve: ">=0.1.0",
          files: [`skills/s${i}.md`],
          ...(i < 8 ? { includes: [{ type: "skill", id: `s${i + 1}` }] } : {}),
        },
        files: { [`skills/s${i}.md`]: `# S${i}\n` },
      });
    }
    const source = fakeCatalog(chain);
    await expect(resolveTemplate(source, "skill", "s0")).rejects.toThrow(
      /depth cap/i,
    );
  });

  it("throws on a duplicate file path across two artifacts, naming path + both", async () => {
    const t1: CatalogTemplate = {
      manifest: {
        id: "t1",
        type: "tool",
        name: "T1",
        description: "t1",
        version: "0.1.0",
        eve: ">=0.1.0",
        files: ["shared/x.ts"],
      },
      files: { "shared/x.ts": "// t1\n" },
    };
    const t2: CatalogTemplate = {
      manifest: {
        id: "t2",
        type: "tool",
        name: "T2",
        description: "t2",
        version: "0.1.0",
        eve: ">=0.1.0",
        files: ["shared/x.ts"],
      },
      files: { "shared/x.ts": "// t2\n" },
    };
    const agent: CatalogTemplate = {
      manifest: {
        id: "clash",
        type: "agent",
        name: "Clash",
        description: "clash",
        version: "0.1.0",
        eve: ">=0.1.0",
        files: ["agent.ts"],
        includes: [
          { type: "tool", id: "t1" },
          { type: "tool", id: "t2" },
        ],
      },
      files: { "agent.ts": "export default {};\n" },
    };
    const source = fakeCatalog([t1, t2, agent]);
    await expect(resolveTemplate(source, "agent", "clash")).rejects.toThrow(
      /shared\/x\.ts.*(t1.*t2|t2.*t1)/s,
    );
  });

  it("throws when a template includes an agent", async () => {
    const agentInclude: CatalogTemplate = {
      manifest: {
        id: "bad",
        type: "agent",
        name: "Bad",
        description: "bad",
        version: "0.1.0",
        eve: ">=0.1.0",
        files: ["agent.ts"],
        // Schema rejects this; the resolver defends too (GitHub source parses remote bytes).
        includes: [{ type: "agent", id: "engineer" }],
      } as unknown as TemplateManifest,
      files: { "agent.ts": "export default {};\n" },
    };
    const source = fakeCatalog([agentInclude]);
    await expect(resolveTemplate(source, "agent", "bad")).rejects.toThrow(
      /agent/i,
    );
  });

  it("propagates the source error for a missing reference", async () => {
    const agent: CatalogTemplate = {
      manifest: {
        id: "orphan",
        type: "agent",
        name: "Orphan",
        description: "orphan",
        version: "0.1.0",
        eve: ">=0.1.0",
        files: ["agent.ts"],
        includes: [{ type: "tool", id: "ghost" }],
      },
      files: { "agent.ts": "export default {};\n" },
    };
    const source = fakeCatalog([agent]);
    await expect(resolveTemplate(source, "agent", "orphan")).rejects.toThrow(
      /ghost/,
    );
  });
});
