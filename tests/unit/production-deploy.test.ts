import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

const stack = read("docker-stack.production.yml");
const workflow = read(".github/workflows/deploy.yml");
const script = read("deploy/production/deploy.sh");
const dockerignore = read(".dockerignore");
const gitignore = read(".gitignore");

describe("production deployment workflow", () => {
  it("runs after main pushes and by manual dispatch", () => {
    expect(workflow).toMatch(/push:\s*\n\s+branches:\s*\n\s+- main/);
    expect(workflow).toMatch(/^\s{2}workflow_dispatch:\s*$/m);
    expect(workflow).toContain("cancel-in-progress: false");
  });

  it("keeps both image publication and deployment canonical-repo only", () => {
    expect(
      workflow.match(/if: github\.repository == 'zero8ai\/eden'/g),
    ).toHaveLength(2);
    expect(workflow).toContain("packages: write");
    expect(workflow).toContain("environment: production");
  });

  it("publishes runtime and migration images under the short commit SHA", () => {
    expect(workflow).toContain("type=sha,format=short,prefix=");
    expect(workflow).toContain("type=raw,value=latest");
    expect(workflow).toContain("target: build-env");
    expect(workflow).toContain(
      "ghcr.io/zero8ai/eden:${{ steps.image.outputs.tag }}-migrate",
    );
    expect(dockerignore).toMatch(/^\.git$/m);
    expect(dockerignore).toMatch(/^\.env\.\*$/m);
    expect(dockerignore).toMatch(/^\*\.env$/m);
    expect(dockerignore).toMatch(/^\*\.log$/m);
    expect(gitignore).toMatch(/^\/production\.env$/m);
  });

  it("uses only the three production VPS Environment secrets", () => {
    const secretNames = [
      ...workflow.matchAll(/secrets\.([A-Z][A-Z0-9_]*)/g),
    ].map((match) => match[1]);

    expect(new Set(secretNames)).toEqual(
      new Set(["PROD_VPS_HOST", "PROD_VPS_USER", "PROD_VPS_SSH_KEY"]),
    );
    expect(workflow).toContain("GHCR_TOKEN: ${{ github.token }}");
  });
});

describe("production Swarm stack", () => {
  it("deploys one immutable Eden replica with stop-first rollback", () => {
    expect(stack).toContain(
      "image: ghcr.io/zero8ai/eden:${IMAGE_TAG:?set IMAGE_TAG}",
    );
    expect(stack).toContain("replicas: ${EDEN_REPLICAS:-1}");
    expect(stack.match(/order: stop-first/g)).toHaveLength(4);
    expect(stack).toMatch(/failure_action: rollback/);
    expect(stack).toContain("node.role == manager");
  });

  it("keeps Postgres on its fixed data path and exact host addresses", () => {
    expect(stack).toContain(
      "/opt/eden/volumes/postgres:/var/lib/postgresql/data",
    );
    expect(stack).toContain("listen_addresses=127.0.0.1,172.17.0.1");
    expect(stack).toContain("external: true");
    expect(stack).toMatch(/\n\s+name: host\s*$/m);
    expect(stack).not.toMatch(/^\s+ports:/m);
    expect(stack).not.toContain("0.0.0.0");
  });

  it("contains only the Eden and Postgres services", () => {
    const services = stack.slice(
      stack.indexOf("services:\n"),
      stack.indexOf("\nnetworks:\n"),
    );
    const serviceNames = [
      ...services.matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gm),
    ].map((match) => match[1]);
    expect(serviceNames).toEqual(["postgres", "eden"]);
    expect(stack).not.toMatch(/^\s{2}(nginx|certbot):/m);
    expect(stack).not.toMatch(/^\s+build:/m);
  });
});

describe("remote deployment transaction", () => {
  it("is executable Bash with strict error handling", () => {
    expect(script).toMatch(/^#!\/usr\/bin\/env bash\n/);
    expect(script).toContain("set -Eeuo pipefail");
    expect(
      statSync(resolve(root, "deploy/production/deploy.sh")).mode & 0o111,
    ).not.toBe(0);
  });

  it("bootstraps Postgres, migrates, then performs the full rollout", () => {
    const transaction = script.slice(script.lastIndexOf("\nvalidate_inputs\n"));
    const bootstrap = transaction.indexOf("deploy_stack 0");
    const migration = transaction.indexOf("run_migrations");
    const rollout = transaction.indexOf("deploy_stack 1");

    expect(bootstrap).toBeGreaterThan(-1);
    expect(migration).toBeGreaterThan(bootstrap);
    expect(rollout).toBeGreaterThan(migration);
    expect(transaction).toContain("wait_for_postgres");
    expect(transaction).toContain("wait_for_eden");
  });

  it("does not execute the production env file as shell code", () => {
    expect(script).toContain('--env-file "$ENV_FILE"');
    expect(script).not.toMatch(/(?:^|\n)\s*(?:source|\.)\s+["']?\$?ENV_FILE/);
  });

  it("diagnoses failed rollouts and only prunes old dangling images", () => {
    expect(script).toContain(
      "paused|rollback_started|rollback_paused|rollback_completed",
    );
    expect(script).toContain('docker service ps --no-trunc "$service"');
    expect(script).toContain('docker logs --tail 100 "$container_id"');
    expect(script).toContain(
      "docker image prune --force --filter 'until=168h'",
    );
    expect(script).not.toMatch(/docker\s+(?:system|volume)\s+prune/);
    expect(script).not.toMatch(
      /docker\s+image\s+prune[^\n]*(?:--all|-a(?:\s|$))/,
    );
  });
});
