import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod/v4";

import type { McpToolService } from "~/mcp/tools.server";

const projectInput = {
  projectId: z.string().min(1).describe("Eden project ID"),
};

const deploymentInput = {
  deploymentId: z.string().min(1).describe("Eden deployment row ID"),
};

function toolResult(value: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

/**
 * Construct one MCP protocol server for an already-authenticated caller.
 *
 * Authentication and organization/user scoping live in the injected service. Keeping those
 * concerns outside the protocol adapter also lets the HTTP route bind one service to one MCP
 * session without sending the caller back through Eden's resource routes.
 */
export function createEdenMcpServer(service: McpToolService): McpServer {
  const server = new McpServer({ name: "eden", version: "0.1.0" });

  server.registerTool(
    "list_projects",
    {
      description:
        "List the Eden projects visible to the authenticated caller.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => toolResult(await service.listProjects()),
  );

  server.registerTool(
    "list_agents",
    {
      description: "List the agents in an Eden project.",
      inputSchema: projectInput,
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => toolResult(await service.listAgents(input)),
  );

  server.registerTool(
    "list_releases",
    {
      description:
        "List releases for a project, optionally limited to one agent.",
      inputSchema: {
        ...projectInput,
        agentId: z
          .string()
          .min(1)
          .optional()
          .describe("Optional Eden agent ID"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => toolResult(await service.listReleases(input)),
  );

  server.registerTool(
    "list_environments",
    {
      description:
        "List deployment environments for a project, optionally limited to one agent.",
      inputSchema: {
        ...projectInput,
        agentId: z
          .string()
          .min(1)
          .optional()
          .describe("Optional Eden agent ID"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async (input) => toolResult(await service.listEnvironments(input)),
  );

  server.registerTool(
    "get_deploy_status",
    {
      description:
        "Get a deployment's current asynchronous status and Git/release/deployment drift.",
      inputSchema: deploymentInput,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) => toolResult(await service.getDeployStatus(input)),
  );

  server.registerTool(
    "deploy_team_version",
    {
      description:
        "Queue a team repository release at an existing Git commit. Returns a deployment row immediately; poll get_deploy_status until it is live or failed.",
      inputSchema: {
        ...projectInput,
        gitSha: z.string().min(1).describe("Git commit SHA to deploy"),
        environment: z.string().min(1).describe("Target environment name"),
        rebuild: z
          .boolean()
          .optional()
          .describe("Force a rebuild of an existing release"),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => toolResult(await service.deployTeamVersion(input)),
  );

  server.registerTool(
    "deploy_head",
    {
      description:
        "Queue the repository's current default-branch head. Returns a deployment row immediately; poll get_deploy_status until it is live or failed.",
      inputSchema: {
        ...projectInput,
        environment: z.string().min(1).describe("Target environment name"),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => toolResult(await service.deployHead(input)),
  );

  server.registerTool(
    "retry_deployment",
    {
      description:
        "Retry a failed deployment asynchronously. Returns its deployment row immediately.",
      inputSchema: deploymentInput,
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (input) => toolResult(await service.retryDeployment(input)),
  );

  server.registerTool(
    "clear_failed",
    {
      description: "Clear the failed deployment state for an environment.",
      inputSchema: {
        environmentId: z.string().min(1).describe("Eden environment ID"),
      },
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input) => toolResult(await service.clearFailed(input)),
  );

  return server;
}
