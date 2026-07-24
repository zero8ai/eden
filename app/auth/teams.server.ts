/**
 * Repo ↔ Better Auth team mapping (FOH invites & roles, D9). One team per connected repo,
 * referenced by `projects.team_id`; a workspace `member` sees a repo in front of house iff
 * they belong to its team, while admins/owners bypass teams entirely.
 *
 * Team creation/removal call Better Auth's server API WITHOUT request headers: a headerless
 * `auth.api.createTeam`/`removeTeam` call is Better Auth's documented server-side form (no
 * session → its role check is skipped), which lets repo lifecycle hooks (connect action,
 * repository teardown, lazy FOH loader) mint teams without threading a privileged session.
 * Callers gate access themselves (requireProject + requireBackOfHouse).
 *
 * There is deliberately no addTeamMember helper: Better Auth's acceptInvitation auto-creates
 * the teamMember row when the invitation carries a teamId, so the invite-to-repo flow only
 * needs createInvitation({ teamId }).
 */
import { and, eq, isNull } from "drizzle-orm";

import { db } from "~/db/client.server";
import { team, teamMember } from "~/db/auth-schema";
import { projects } from "~/db/schema";
import { auth } from "~/lib/auth.server";

type ProjectTeamRef = {
  id: string;
  name: string;
  teamId: string | null;
};

/**
 * Return the project's Better Auth team id, creating the team (named after the repo) and
 * persisting `projects.team_id` on first touch. Concurrency-safe without locks: the column
 * claim is conditional on the teamId this call started from, and the loser removes its
 * just-minted team and adopts the winner's.
 */
export async function ensureProjectTeam(
  orgId: string,
  project: ProjectTeamRef,
): Promise<string> {
  if (project.teamId) {
    // The FK is set-null on team delete, so a non-null id normally proves the team exists;
    // re-check anyway so a stale in-memory project row can't return a dead team.
    const existing = await db
      .select({ id: team.id })
      .from(team)
      .where(and(eq(team.id, project.teamId), eq(team.organizationId, orgId)))
      .limit(1);
    if (existing.length > 0) return project.teamId;
  }

  const created = await auth.api.createTeam({
    body: { name: project.name, organizationId: orgId },
  });

  const claimed = await db
    .update(projects)
    .set({ teamId: created.id })
    .where(
      and(
        eq(projects.id, project.id),
        project.teamId
          ? eq(projects.teamId, project.teamId)
          : isNull(projects.teamId),
      ),
    )
    .returning({ id: projects.id });
  if (claimed.length > 0) return created.id;

  // Lost a concurrent claim — discard our team and use whichever id won.
  await deleteProjectTeam(orgId, created.id);
  const [row] = await db
    .select({ teamId: projects.teamId })
    .from(projects)
    .where(eq(projects.id, project.id))
    .limit(1);
  if (!row?.teamId) {
    throw new Error("Could not associate a team with this repository.");
  }
  return row.teamId;
}

/**
 * Best-effort team removal for the repo lifecycle (project delete). Never throws: a leftover
 * team is invisible (nothing maps to it) and must not block a repository teardown.
 */
export async function deleteProjectTeam(
  orgId: string,
  teamId: string | null | undefined,
): Promise<void> {
  if (!teamId) return;
  try {
    await auth.api.removeTeam({ body: { teamId, organizationId: orgId } });
  } catch (error) {
    console.warn(
      `[teams] Could not remove team ${teamId} (${(error as Error)?.message ?? "unknown error"}); continuing.`,
    );
  }
}

/**
 * The repos a workspace `member` may see in front of house: projects whose team the user
 * belongs to. Admins/owners never call this — they see every org project.
 */
export async function listMemberProjectIds(
  userId: string,
  orgId: string,
): Promise<string[]> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .innerJoin(team, eq(team.id, projects.teamId))
    .innerJoin(teamMember, eq(teamMember.teamId, team.id))
    .where(
      and(
        eq(projects.orgId, orgId),
        eq(team.organizationId, orgId),
        eq(teamMember.userId, userId),
      ),
    );
  return rows.map((row) => row.id);
}
