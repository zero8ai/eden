import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createEdenMcpServer } from "~/mcp/server.server";
import type { McpToolService } from "~/mcp/tools.server";

function serviceMock(): McpToolService {
  const result = async () => ({ ok: true });
  return {
    listProjects: vi.fn(result),
    listAgents: vi.fn(result),
    listReleases: vi.fn(result),
    listEnvironments: vi.fn(result),
    getDeployStatus: vi.fn(result),
    deployTeamVersion: vi.fn(result),
    deployHead: vi.fn(result),
    retryDeployment: vi.fn(result),
    clearFailed: vi.fn(result),
  };
}

describe("Eden MCP server", () => {
  const close: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(close.splice(0).map((fn) => fn()));
  });

  async function connected(service: McpToolService) {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const server = createEdenMcpServer(service);
    const client = new Client({ name: "eden-test", version: "1.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    close.push(
      () => client.close(),
      () => server.close(),
    );
    return client;
  }

  it("exposes exactly the slice-one read and deploy tools", async () => {
    const client = await connected(serviceMock());

    const result = await client.listTools();

    expect(result.tools.map(({ name }) => name)).toEqual([
      "list_projects",
      "list_agents",
      "list_releases",
      "list_environments",
      "get_deploy_status",
      "deploy_team_version",
      "deploy_head",
      "retry_deployment",
      "clear_failed",
    ]);
  });

  it("validates tool arguments and forwards them to the injectable service", async () => {
    const service = serviceMock();
    const client = await connected(service);
    const calls = [
      ["list_projects", {}, "listProjects"],
      ["list_agents", { projectId: "project_1" }, "listAgents"],
      [
        "list_releases",
        { projectId: "project_1", agentId: "agent_1" },
        "listReleases",
      ],
      [
        "list_environments",
        { projectId: "project_1", agentId: "agent_1" },
        "listEnvironments",
      ],
      [
        "get_deploy_status",
        { deploymentId: "deployment_1" },
        "getDeployStatus",
      ],
      [
        "deploy_team_version",
        {
          projectId: "project_1",
          gitSha: "abc123",
          environment: "production",
          rebuild: true,
        },
        "deployTeamVersion",
      ],
      [
        "deploy_head",
        { projectId: "project_1", environment: "production" },
        "deployHead",
      ],
      ["retry_deployment", { deploymentId: "deployment_1" }, "retryDeployment"],
      ["clear_failed", { environmentId: "environment_1" }, "clearFailed"],
    ] as const;

    for (const [name, args, method] of calls) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.structuredContent).toEqual({ ok: true });
      if (method === "listProjects") {
        expect(service.listProjects).toHaveBeenCalledWith();
      } else {
        expect(service[method]).toHaveBeenCalledWith(args);
      }
    }
  });

  it("rejects invalid input before calling the service", async () => {
    const service = serviceMock();
    const client = await connected(service);

    const result = await client.callTool({
      name: "list_agents",
      arguments: { projectId: "" },
    });

    expect(result.isError).toBe(true);
    expect(service.listAgents).not.toHaveBeenCalled();
  });
});
