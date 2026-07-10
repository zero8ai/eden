/** Find the live target that owns a persisted playground session. */
export function findSessionOwnerTarget<T extends { deploymentId: string }>(
  session: { lastDeploymentId: string | null },
  targets: readonly T[],
): T | null {
  if (!session.lastDeploymentId) return null;
  return (
    targets.find(
      (target) => target.deploymentId === session.lastDeploymentId,
    ) ?? null
  );
}

/**
 * An Eve session belongs to the exact deployment that created it. A session that Eve has not
 * created yet is unbound and may start on any target.
 */
export function canContinueSessionOnTarget(
  session: {
    externalSessionId: string | null;
    lastDeploymentId: string | null;
  },
  deploymentId: string,
): boolean {
  if (session.externalSessionId === null) return true;
  return (
    session.lastDeploymentId !== null &&
    session.lastDeploymentId === deploymentId
  );
}
