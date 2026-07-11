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
 * Whether a live target exists, but none of the available targets owns this existing Eve session.
 * With no live target, the original deployment may only be stopped and able to wake in place.
 *
 * The two surfaces read this differently: the assistant BLOCKS on it (its 409 stands, the
 * conversation is dead-ended), while the playground treats it as a "will reseed" hint (#71) —
 * the next turn transparently seeds a fresh eve session on the replacement from the cache.
 */
export function sessionContinuationIsBlocked<
  T extends { deploymentId: string },
>(
  session: {
    externalSessionId: string | null;
    lastDeploymentId: string | null;
  },
  targets: readonly T[],
): boolean {
  return (
    session.externalSessionId !== null &&
    targets.length > 0 &&
    findSessionOwnerTarget(session, targets) === null
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
