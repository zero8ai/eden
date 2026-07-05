/**
 * Install-wizard secret decisions + the pending-secret lifecycle (§4.4, §9): the pure op
 * planner both install shapes share (shared-attach default, value, skip), the ship-time
 * migration of held sealed values into real agent-scoped rows, and the abandonment sweep.
 */
import crypto from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  cleanupOrphanedPendingSecrets,
  migratePendingSecrets,
  planInstallSecretOps,
} from "~/project/secrets.server";
import { fingerprint, open, seal } from "~/seams/oss/secretbox";
import type { PendingSecretRow, SecretMeta } from "~/seams/oss/secret-store";
import type { SecretRef } from "~/seams/types";
import type { SealedSecret } from "~/seams/oss/secretbox";

const KEY = crypto.randomBytes(32);
const PROJECT = "proj_1";

function formOf(entries: Record<string, string>): Pick<FormData, "get" | "has"> {
  return {
    get: (name: string) => entries[name] ?? null,
    has: (name: string) => name in entries,
  };
}

describe("planInstallSecretOps (§9 three-way choice)", () => {
  const secrets = [
    { name: "CLOUDFLARE_API_TOKEN", sandbox: true },
    { name: "GITHUB_TOKEN" },
  ];

  it("defaults to shared-attach when a shared secret with the name exists", () => {
    const ops = planInstallSecretOps({
      secrets,
      form: formOf({ "secret:CLOUDFLARE_API_TOKEN": "tok" }),
      sharedNames: ["GITHUB_TOKEN"],
    });
    expect(ops).toEqual([
      { kind: "set", name: "CLOUDFLARE_API_TOKEN", value: "tok", sandbox: true },
      { kind: "attach", name: "GITHUB_TOKEN", sandbox: false },
    ]);
  });

  it("honours an explicit per-agent value over the shared default", () => {
    const ops = planInstallSecretOps({
      secrets: [{ name: "GITHUB_TOKEN" }],
      form: formOf({
        "secretmode:GITHUB_TOKEN": "value",
        "secret:GITHUB_TOKEN": "my-own",
      }),
      sharedNames: ["GITHUB_TOKEN"],
    });
    expect(ops).toEqual([
      { kind: "set", name: "GITHUB_TOKEN", value: "my-own", sandbox: false },
    ]);
  });

  it("skip and blank-value both defer to a required-missing row (never gates Continue)", () => {
    const ops = planInstallSecretOps({
      secrets,
      form: formOf({ "secretmode:CLOUDFLARE_API_TOKEN": "skip" }),
      sharedNames: [],
    });
    expect(ops).toEqual([
      { kind: "skip", name: "CLOUDFLARE_API_TOKEN" },
      { kind: "skip", name: "GITHUB_TOKEN" },
    ]);
  });

  it("the sandbox checkbox overrides the manifest pre-check in both directions", () => {
    const ops = planInstallSecretOps({
      secrets,
      form: formOf({
        "secret:CLOUDFLARE_API_TOKEN": "tok",
        "secretsandbox:CLOUDFLARE_API_TOKEN": "0",
        "secret:GITHUB_TOKEN": "gh",
        "secretsandbox:GITHUB_TOKEN": "1",
      }),
      sharedNames: [],
    });
    expect(ops).toEqual([
      { kind: "set", name: "CLOUDFLARE_API_TOKEN", value: "tok", sandbox: false },
      { kind: "set", name: "GITHUB_TOKEN", value: "gh", sandbox: true },
    ]);
  });
});

describe("migratePendingSecrets — the ship point (§4.4)", () => {
  function pendingRow(over: Partial<PendingSecretRow> & { key: string }): PendingSecretRow {
    return {
      sealed: { ciphertext: "", iv: "", authTag: "" },
      fingerprint: null,
      sandboxExposed: false,
      attachShared: false,
      createdBy: "user_1",
      ...over,
    };
  }

  function deps(rows: PendingSecretRow[]) {
    const upserts: Array<{ ref: SecretRef; sealed: SealedSecret; meta?: SecretMeta }> = [];
    const attaches: Array<Record<string, unknown>> = [];
    let deleted: string | null = null;
    return {
      upserts,
      attaches,
      deletedName: () => deleted,
      deps: {
        listPending: async () => rows,
        deletePending: async (_p: string, name: string) => {
          deleted = name;
        },
        upsertSealed: async (ref: SecretRef, sealed: SealedSecret, meta?: SecretMeta) => {
          upserts.push({ ref, sealed, meta });
        },
        attach: async (input: Record<string, unknown>) => {
          attaches.push(input);
        },
      },
    };
  }

  it("moves held sealed values into agent-scoped rows without re-encrypting", async () => {
    const sealed = seal(KEY, "held-value");
    const t = deps([
      pendingRow({
        key: "CLOUDFLARE_API_TOKEN",
        sealed,
        fingerprint: fingerprint("held-value"),
        sandboxExposed: true,
      }),
    ]);
    const n = await migratePendingSecrets(
      { projectId: PROJECT, memberName: "deployer", agentId: "agent_9" },
      t.deps,
    );
    expect(n).toBe(1);
    expect(t.upserts).toHaveLength(1);
    const w = t.upserts[0];
    expect(w.ref).toEqual({
      projectId: PROJECT,
      agentId: "agent_9",
      environmentId: null,
      key: "CLOUDFLARE_API_TOKEN",
    });
    // The sealed payload moves verbatim — same secretbox, still decryptable.
    expect(open(KEY, w.sealed)).toBe("held-value");
    expect(w.meta?.fingerprint).toBe(fingerprint("held-value"));
    expect(w.meta?.sandboxExposed).toBe(true);
    expect(t.deletedName()).toBe("deployer");
  });

  it("turns attach-shared holds into attachment rows, seeding the sandbox flag", async () => {
    const t = deps([
      pendingRow({ key: "GITHUB_TOKEN", attachShared: true, sandboxExposed: true }),
    ]);
    await migratePendingSecrets(
      { projectId: PROJECT, memberName: "deployer", agentId: "agent_9" },
      t.deps,
    );
    expect(t.upserts).toHaveLength(0);
    expect(t.attaches[0]).toMatchObject({
      projectId: PROJECT,
      agentId: "agent_9",
      key: "GITHUB_TOKEN",
      attached: true,
      sandboxExposed: true,
    });
    expect(t.deletedName()).toBe("deployer");
  });

  it("is a no-op (and deletes nothing) when the member holds no pending secrets", async () => {
    const t = deps([]);
    const n = await migratePendingSecrets(
      { projectId: PROJECT, memberName: "deployer", agentId: "agent_9" },
      t.deps,
    );
    expect(n).toBe(0);
    expect(t.deletedName()).toBeNull();
  });
});

describe("cleanupOrphanedPendingSecrets — abandonment (§4.4, §11.8)", () => {
  function deps(held: string[]) {
    const deleted: string[] = [];
    return {
      deleted,
      deps: {
        listPendingMembers: async () => held,
        deletePending: async (_p: string, name: string) => {
          deleted.push(name);
        },
      },
    };
  }

  it("drops holds with no roster row and no staged member drafts", async () => {
    const t = deps(["deployer"]);
    const removed = await cleanupOrphanedPendingSecrets(
      { projectId: PROJECT, rosterNames: ["pm"], draftPaths: ["agent/tools/x.ts"] },
      t.deps,
    );
    expect(removed).toEqual(["deployer"]);
    expect(t.deleted).toEqual(["deployer"]);
  });

  it("keeps holds while the install's drafts are still staged", async () => {
    const t = deps(["deployer"]);
    const removed = await cleanupOrphanedPendingSecrets(
      {
        projectId: PROJECT,
        rosterNames: ["pm"],
        draftPaths: ["agents/deployer/agent/agent.ts"],
      },
      t.deps,
    );
    expect(removed).toEqual([]);
  });

  it("keeps holds once the member exists (migration owns them now)", async () => {
    const t = deps(["deployer"]);
    const removed = await cleanupOrphanedPendingSecrets(
      { projectId: PROJECT, rosterNames: ["pm", "deployer"], draftPaths: [] },
      t.deps,
    );
    expect(removed).toEqual([]);
  });
});
