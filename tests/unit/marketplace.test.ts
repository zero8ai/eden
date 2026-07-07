/**
 * The marketplace format + catalog seam (PRD §7.8, Milestone 6 phase 1).
 *
 * Three concerns:
 *  - the manifest schema enforces the format — above all it makes path traversal impossible,
 *    since these file paths are materialized into customer repos in phase 2;
 *  - the fixture catalog + the real seed never drift: every index row loads, its files match the
 *    manifest exactly, and the recorded content hash matches an INDEPENDENT recomputation here
 *    (the hash rule is re-implemented, not imported — that's the point of the check);
 *  - the fake catalog behaves like the real seams (round-trip, unknown id throws).
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  parseManifest,
  templateManifestSchema,
  type TemplateManifest,
} from "~/marketplace/manifest";
import { resolveTemplate } from "~/marketplace/compose.server";
import { fixtureCatalog } from "~/seams/oss/catalog.fixture.server";
import type { CatalogTemplate } from "~/seams/types";
import { fakeCatalog } from "../fakes/catalog";

const VALID: TemplateManifest = {
  id: "cloudflare-deploy",
  type: "tool",
  name: "Cloudflare Deploy",
  description: "Deploy a Worker.",
  version: "0.1.0",
  eve: ">=0.1.0",
  files: ["tools/cloudflare-deploy.ts"],
  dependencies: { wrangler: "^3.0.0" },
  secrets: [{ name: "CLOUDFLARE_API_TOKEN" }],
};

describe("manifest schema", () => {
  it("accepts a valid manifest", () => {
    expect(parseManifest(VALID)).toEqual(VALID);
  });

  it.each([
    ["../escape.ts", "parent traversal"],
    ["/etc/passwd", "absolute path"],
    ["a\\b.ts", "backslash"],
  ])("rejects path traversal: %s (%s)", (path) => {
    expect(() => parseManifest({ ...VALID, files: [path] })).toThrow();
  });

  it("rejects an empty files list", () => {
    expect(() => parseManifest({ ...VALID, files: [] })).toThrow();
  });

  it("rejects a non-semver version", () => {
    expect(() => parseManifest({ ...VALID, version: "1.0" })).toThrow();
  });

  it("rejects an unknown type", () => {
    expect(() => parseManifest({ ...VALID, type: "plugin" })).toThrow();
  });

  it("rejects a non-kebab id", () => {
    expect(() => parseManifest({ ...VALID, id: "Not Kebab" })).toThrow();
  });

  it("rejects a non-UPPER_SNAKE secret name", () => {
    expect(() =>
      parseManifest({ ...VALID, secrets: [{ name: "lower_case" }] }),
    ).toThrow();
  });

  it("accepts optional fields via the schema directly", () => {
    const parsed = templateManifestSchema.parse({
      ...VALID,
      dependencies: undefined,
      secrets: undefined,
      connections: ["some-service"],
      model: "anthropic/claude-sonnet-5",
    });
    expect(parsed.connections).toEqual(["some-service"]);
    expect(parsed.model).toBe("anthropic/claude-sonnet-5");
  });
});

/**
 * The content-hash rule, re-implemented from marketplace/scripts/build-index.mjs. If either
 * drifts, the seed test below fails — which is exactly the guarantee we want.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stableStringify(
            (value as Record<string, unknown>)[k],
          )}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function templateHash(t: CatalogTemplate): string {
  const parts = [stableStringify(t.manifest)];
  for (const path of Object.keys(t.files).sort()) {
    parts.push(`${path}\0${t.files[path]}`);
  }
  return createHash("sha1").update(parts.join("\n")).digest("hex");
}

describe("fixture catalog (the real in-repo seed)", () => {
  it("index parses and every entry's template loads, files match, hashes hold", async () => {
    const index = await fixtureCatalog.index();
    expect(index.templates.length).toBeGreaterThan(0);

    for (const entry of index.templates) {
      const template = await fixtureCatalog.template(entry.type, entry.id);

      // The loaded files map is EXACTLY the manifest's declared file set.
      expect(new Set(Object.keys(template.files))).toEqual(
        new Set(template.manifest.files),
      );

      // The recorded hash matches an independent recomputation — the seed hasn't drifted.
      expect(templateHash(template)).toBe(entry.hash);

      // The index row agrees with the manifest.
      expect(entry.name).toBe(template.manifest.name);
      expect(entry.version).toBe(template.manifest.version);

      for (const content of Object.values(template.files)) {
        if (content.includes("defineTool")) {
          expect(content).not.toMatch(/from\s+["']eve["']/);
        }
      }
    }
  });
});

describe("composition against the real seed", () => {
  it("resolves the engineer agent, materializing the bundled Discord channel and send tool", async () => {
    const resolved = await resolveTemplate(fixtureCatalog, "agent", "engineer");

    // The Discord channel and outbound tool are flattened into the agent's file set.
    expect(new Set(Object.keys(resolved.files))).toEqual(
      new Set(resolved.manifest.files),
    );
    expect(Object.keys(resolved.files)).toContain("channels/discord.ts");
    expect(Object.keys(resolved.files)).toContain(
      "tools/discord-send-message.ts",
    );
    expect(resolved.files["channels/discord.ts"]).toContain(
      'from "eve/channels/discord"',
    );
    expect(resolved.files["tools/discord-send-message.ts"]).toContain(
      "sendDiscordChannelMessage",
    );

    // Discord requirements union in alongside the engineer's own GitHub token.
    const secretNames = (resolved.manifest.secrets ?? []).map((s) => s.name);
    expect(secretNames).toEqual(
      expect.arrayContaining([
        "GITHUB_TOKEN",
        "DISCORD_APPLICATION_ID",
        "DISCORD_BOT_TOKEN",
        "DISCORD_PUBLIC_KEY",
      ]),
    );
    expect(secretNames).not.toContain("GITHUB_REPOSITORIES");
    expect(secretNames).not.toContain("GITHUB_DEFAULT_REPOSITORY");

    // Provenance + hash lockstep: the parent's hash is its own index row; the include carries
    // Discord's own index-row hash.
    const index = await fixtureCatalog.index();
    const engineerRow = index.templates.find(
      (t) => t.type === "agent" && t.id === "engineer",
    )!;
    const discordRow = index.templates.find(
      (t) => t.type === "channel" && t.id === "discord",
    )!;
    const discordToolRow = index.templates.find(
      (t) => t.type === "tool" && t.id === "discord-send-message",
    )!;
    expect(resolved.hash).toBe(engineerRow.hash);
    expect(resolved.includes).toEqual([
      {
        id: "discord",
        type: "channel",
        name: "Discord",
        version: discordRow.version,
        hash: discordRow.hash,
      },
      {
        id: "discord-send-message",
        type: "tool",
        name: "Discord Send Message",
        version: discordToolRow.version,
        hash: discordToolRow.hash,
      },
    ]);
  });
});

describe("fakeCatalog", () => {
  const tpl: CatalogTemplate = {
    manifest: VALID,
    files: { "tools/cloudflare-deploy.ts": "export default {};\n" },
  };
  const catalog = fakeCatalog([tpl]);

  it("round-trips index and template", async () => {
    const index = await catalog.index();
    expect(index.templates).toHaveLength(1);
    expect(index.templates[0].id).toBe("cloudflare-deploy");

    const loaded = await catalog.template("tool", "cloudflare-deploy");
    expect(loaded).toEqual(tpl);
  });

  it("throws on an unknown id", async () => {
    await expect(catalog.template("tool", "nope")).rejects.toThrow();
  });
});
