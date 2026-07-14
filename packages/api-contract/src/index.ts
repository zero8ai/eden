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

export type GithubInstallAuthOutcome =
  | { status: "redeem"; handoff: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };

/** Extract only Eden's opaque handoff from an Expo auth-session result. */
export function githubInstallAuthOutcome(
  result: { type: string; url?: string },
  redirectUri: string,
): GithubInstallAuthOutcome {
  if (result.type === "cancel" || result.type === "dismiss") {
    return { status: "cancelled" };
  }
  if (result.type !== "success" || !result.url) {
    return {
      status: "error",
      message: "GitHub did not return to Eden. Please try again.",
    };
  }

  try {
    const callback = new URL(result.url);
    const expected = new URL(redirectUri);
    if (
      callback.protocol !== expected.protocol ||
      callback.host !== expected.host ||
      callback.pathname.replace(/\/$/, "") !==
        expected.pathname.replace(/\/$/, "")
    ) {
      return {
        status: "error",
        message: "GitHub returned to an unexpected address.",
      };
    }

    if (callback.searchParams.has("error")) {
      return {
        status: "error",
        message:
          callback.searchParams.get("error_description") ??
          "GitHub could not authorize this installation.",
      };
    }

    const handoffs = callback.searchParams.getAll("handoff");
    const handoff = handoffs.length === 1 ? handoffs[0].trim() : "";
    if (!handoff) {
      return {
        status: "error",
        message: "GitHub returned without a valid Eden handoff.",
      };
    }
    return { status: "redeem", handoff };
  } catch {
    return {
      status: "error",
      message: "GitHub returned an invalid callback.",
    };
  }
}

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
  githubInstallStart: () => "/api/mobile/github/install/start",
  githubInstallRedeem: () => "/api/mobile/github/install/redeem",
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
