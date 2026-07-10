import { describe, expect, it } from "vitest";

import {
  canContinueSessionOnTarget,
  findSessionOwnerTarget,
} from "~/playground/ownership";

const owner = {
  deploymentId: "dep_original",
  environmentId: "env_preview",
  label: "original",
};

const replacement = {
  deploymentId: "dep_replacement",
  environmentId: "env_preview",
  label: "replacement",
};

describe("playground session deployment ownership", () => {
  it("allows a new, unbound session to start on any target", () => {
    expect(
      canContinueSessionOnTarget(
        {
          externalSessionId: null,
          lastDeploymentId: owner.deploymentId,
        },
        replacement.deploymentId,
      ),
    ).toBe(true);
  });

  it("allows an existing session to continue on its exact owner", () => {
    const session = {
      externalSessionId: "eve_session_1",
      lastDeploymentId: owner.deploymentId,
    };

    expect(findSessionOwnerTarget(session, [replacement, owner])).toBe(owner);
    expect(canContinueSessionOnTarget(session, owner.deploymentId)).toBe(true);
  });

  it("rejects continuing an existing session on a replacement deployment", () => {
    expect(
      canContinueSessionOnTarget(
        {
          externalSessionId: "eve_session_1",
          lastDeploymentId: owner.deploymentId,
        },
        replacement.deploymentId,
      ),
    ).toBe(false);
  });

  it("rejects an existing session whose owner was not recorded", () => {
    expect(
      canContinueSessionOnTarget(
        { externalSessionId: "eve_session_1", lastDeploymentId: null },
        owner.deploymentId,
      ),
    ).toBe(false);
  });

  it("does not select a replacement in the same environment as the owner", () => {
    expect(
      findSessionOwnerTarget({ lastDeploymentId: owner.deploymentId }, [
        replacement,
      ]),
    ).toBeNull();
  });
});
