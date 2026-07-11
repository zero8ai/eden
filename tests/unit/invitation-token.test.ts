import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  mintInvitationToken,
  verifyInvitationToken,
} from "~/auth/invitation-token.server";
import { signState } from "~/lib/signed-state.server";

const KEY = Buffer.alloc(32, 7);
const OTHER_KEY = Buffer.alloc(32, 9);
const INVITATION_ID = "invitation-123";
const EMAIL = "invitee@example.com";

describe("invitation delivery tokens", () => {
  it("round-trips the invited email for the matching invitation", () => {
    const token = mintInvitationToken(INVITATION_ID, EMAIL, KEY);
    expect(verifyInvitationToken(token, INVITATION_ID, KEY)).toEqual({
      email: EMAIL,
    });
  });

  it("rejects a token bound to a different invitation", () => {
    const token = mintInvitationToken(INVITATION_ID, EMAIL, KEY);
    expect(verifyInvitationToken(token, "invitation-456", KEY)).toBeNull();
  });

  it("rejects a tampered token", () => {
    const token = mintInvitationToken(INVITATION_ID, EMAIL, KEY);
    const [payload, signature] = token.split(".");
    const forgedPayload = Buffer.from(
      JSON.stringify({
        purpose: "org-invitation-delivery",
        invitationId: INVITATION_ID,
        email: "attacker@example.com",
      }),
      "utf8",
    ).toString("base64url");
    expect(
      verifyInvitationToken(
        `${forgedPayload}.${signature}`,
        INVITATION_ID,
        KEY,
      ),
    ).toBeNull();
    expect(
      verifyInvitationToken(`${payload}.AAAA`, INVITATION_ID, KEY),
    ).toBeNull();
  });

  it("rejects a token signed with a different key", () => {
    const token = mintInvitationToken(INVITATION_ID, EMAIL, OTHER_KEY);
    expect(verifyInvitationToken(token, INVITATION_ID, KEY)).toBeNull();
  });

  it("rejects a same-key token signed for another purpose", () => {
    const token = signState(
      { purpose: "google-connect", invitationId: INVITATION_ID, email: EMAIL },
      KEY,
    );
    expect(verifyInvitationToken(token, INVITATION_ID, KEY)).toBeNull();
  });

  it("rejects malformed input without throwing", () => {
    expect(verifyInvitationToken("", INVITATION_ID, KEY)).toBeNull();
    expect(verifyInvitationToken("not-a-token", INVITATION_ID, KEY)).toBeNull();
    expect(
      verifyInvitationToken(
        randomBytes(48).toString("base64url"),
        INVITATION_ID,
        KEY,
      ),
    ).toBeNull();
  });
});
