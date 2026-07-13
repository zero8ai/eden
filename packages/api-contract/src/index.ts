/** JSON-safe values returned by Eden resource routes. */
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | JsonValue[] | { [key: string]: JsonValue | undefined };

export type MobileApiError = {
  error: string;
  message: string;
  status: number;
};

export type MobileMutationResult = {
  ok: true;
  redirectTo?: string;
  data?: JsonValue;
};

export type NdjsonEvent<T extends JsonValue = JsonValue> = {
  type: string;
  data?: T;
  error?: string;
};

export const resourceCategories = [
  "tools",
  "skills",
  "subagents",
  "channels",
  "schedules",
  "connections",
] as const;
export type ResourceCategory = (typeof resourceCategories)[number];

const encode = (value: string) => encodeURIComponent(value);

export const mobileApi = {
  dashboard: () => "/api/mobile/dashboard",
  marketplace: () => "/api/mobile/marketplace",
  marketplaceDetail: (type: string, id: string) =>
    `/api/mobile/marketplace/${encode(type)}/${encode(id)}`,
  marketplaceInstall: (type: string, id: string) =>
    `/api/mobile/marketplace/${encode(type)}/${encode(id)}/install`,
  workspaces: () => "/api/mobile/workspaces",
  organizationSettings: () => "/api/mobile/org/settings",
  organizationMembers: () => "/api/mobile/org/members",
  connect: () => "/api/mobile/connect",
  repository: (projectId: string) => `/api/mobile/repos/${encode(projectId)}`,
  repositoryPage: (projectId: string, page: string) =>
    `/api/mobile/repos/${encode(projectId)}/${page}`,
  member: (projectId: string, agentName: string) =>
    `/api/mobile/repos/${encode(projectId)}/agents/${encode(agentName)}`,
  memberPage: (projectId: string, agentName: string, page: string) =>
    `/api/mobile/repos/${encode(projectId)}/agents/${encode(agentName)}/${page}`,
  run: (projectId: string, runId: string, agentName?: string) =>
    agentName
      ? `/api/mobile/repos/${encode(projectId)}/agents/${encode(agentName)}/runs/${encode(runId)}`
      : `/api/mobile/repos/${encode(projectId)}/runs/${encode(runId)}`,
} as const;
