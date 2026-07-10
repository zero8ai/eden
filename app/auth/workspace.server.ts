import { redirect } from "react-router";

import { newId } from "~/lib/id";
import { auth } from "~/lib/auth.server";
import type { SessionAuth } from "./session.server";

export type WorkspaceInfo = {
  id: string;
  name: string;
  slug: string;
};

export type ActiveWorkspace = {
  org: WorkspaceInfo;
  member: {
    id: string;
    organizationId: string;
    userId: string;
    role: string;
  };
};

export function chooseWorkspaceEntry(input: {
  membershipOrgIds: string[];
}): { kind: "create" } | { kind: "enter"; orgId: string } | { kind: "choose" } {
  if (input.membershipOrgIds.length === 0) return { kind: "create" };
  if (input.membershipOrgIds.length === 1) {
    return { kind: "enter", orgId: input.membershipOrgIds[0] };
  }
  return { kind: "choose" };
}

export async function listUserWorkspaces(
  session: SessionAuth,
): Promise<WorkspaceInfo[]> {
  const organizations = await auth.api.listOrganizations({
    headers: session.requestHeaders,
  });
  return organizations.map(({ id, name, slug }) => ({ id, name, slug }));
}

export async function resolveActiveWorkspace(
  session: SessionAuth,
): Promise<ActiveWorkspace | null> {
  if (!session.organizationId) return null;
  try {
    const [member, workspaces] = await Promise.all([
      auth.api.getActiveMember({ headers: session.requestHeaders }),
      listUserWorkspaces(session),
    ]);
    const org = workspaces.find(
      (workspace) => workspace.id === session.organizationId,
    );
    if (!member || member.organizationId !== session.organizationId || !org)
      return null;
    return { org, member };
  } catch {
    return null;
  }
}

export async function setActiveWorkspace(
  session: SessionAuth,
  organizationId: string | null,
) {
  return auth.api.setActiveOrganization({
    body: { organizationId },
    headers: session.requestHeaders,
  });
}

function personalWorkspaceName(session: SessionAuth): string {
  const firstName = session.user.name.trim().split(/\s+/)[0];
  const fallback = session.user.email.split("@")[0];
  return `${firstName || fallback || "My"}'s workspace`;
}

function personalWorkspaceSlug(session: SessionAuth): string {
  const stem = session.user.name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32);
  return `${stem || "workspace"}-${newId().toLowerCase()}`;
}

async function createPersonalWorkspace(session: SessionAuth): Promise<string> {
  const organization = await auth.api.createOrganization({
    body: {
      name: personalWorkspaceName(session),
      slug: personalWorkspaceSlug(session),
    },
    headers: session.requestHeaders,
  });
  if (!organization)
    throw new Error("Better Auth did not create an organization.");
  return organization.id;
}

export async function ensureWorkspace(
  request: Request,
  session: SessionAuth,
): Promise<void> {
  if (await resolveActiveWorkspace(session)) return;

  if (session.organizationId) {
    await setActiveWorkspace(session, null);
  }

  const replayTo = `${new URL(request.url).pathname}${new URL(request.url).search}`;
  const workspaces = await listUserWorkspaces(session);
  const decision = chooseWorkspaceEntry({
    membershipOrgIds: workspaces.map((workspace) => workspace.id),
  });

  if (decision.kind === "choose") {
    throw redirect(`/workspaces?returnTo=${encodeURIComponent(replayTo)}`);
  }

  if (decision.kind === "create") {
    await createPersonalWorkspace(session);
  } else {
    await setActiveWorkspace(session, decision.orgId);
  }
  throw redirect(replayTo);
}
