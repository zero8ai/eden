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
 * Membership paths: for a NEW email, Better Auth's acceptInvitation auto-creates the
 * teamMember row when the invitation carries a teamId, so createInvitation({ teamId }) is
 * enough. For an EXISTING org member Better Auth rejects createInvitation outright
 * (USER_IS_ALREADY_A_MEMBER_OF_THIS_ORGANIZATION), so granting them a repo goes through
 * addProjectTeamMember instead — unlike team lifecycle, that call DOES thread the calling
 * admin's session headers, because add-team-member enforces member:update on the caller.
 */
import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "~/db/client.server";
import { member, team, teamMember, user } from "~/db/auth-schema";
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
 * Add an EXISTING org member to a repo's team (the invite dialog's direct-grant path, which
 * is also the admin repair path for pre-team members with no teamMember rows). Requires the
 * calling admin's session headers: Better Auth's add-team-member enforces member:update on
 * the caller, requires the target user to already belong to the org, and is idempotent.
 * Better Auth API errors propagate for the caller to map into a public message.
 */
export async function addProjectTeamMember(input: {
  orgId: string;
  teamId: string;
  userId: string;
  headers: Headers;
}): Promise<void> {
  await auth.api.addTeamMember({
    body: {
      teamId: input.teamId,
      userId: input.userId,
      organizationId: input.orgId,
    },
    headers: input.headers,
  });
}

/**
 * The user id of the org member whose account email matches (case-insensitively), or null.
 * Lets the invite flow decide between a direct team grant and an invitation.
 */
export async function findOrgMemberIdByEmail(
  orgId: string,
  email: string,
): Promise<string | null> {
  const rows = await db
    .select({ userId: member.userId })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(
      and(
        eq(member.organizationId, orgId),
        sql`lower(${user.email}) = ${email.toLowerCase()}`,
      ),
    )
    .limit(1);
  return rows[0]?.userId ?? null;
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
