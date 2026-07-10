import { describe, expect, it } from "vitest";

import { renderOrganizationInvitationEmail } from "~/email/templates/organization-invitation";
import { renderPasswordResetEmail } from "~/email/templates/password-reset";

describe("transactional email templates", () => {
  it("renders the Better Auth password-reset URL and account context", async () => {
    const resetUrl =
      "https://eden.example.com/api/auth/reset-password/reset-token?callbackURL=https%3A%2F%2Feden.example.com%2Freset-password";
    const html = await renderPasswordResetEmail({
      userEmail: "person@example.com",
      resetUrl,
    });

    expect(html).toContain("Reset your password");
    expect(html).toContain("person@example.com");
    expect(html).toContain("reset-token");
    expect(html).toContain("expires in one hour");
  });

  it("renders the organization invitation with inviter and workspace context", async () => {
    const html = await renderOrganizationInvitationEmail({
      invitationUrl: "https://eden.example.com/accept-invitation/invite-id",
      inviterEmail: "owner@example.com",
      inviterName: "Olivia Owner",
      organizationName: "Eden Team",
    });

    expect(html).toContain("Join Eden Team");
    expect(html).toContain("Olivia Owner");
    expect(html).toContain("owner@example.com");
    expect(html).toContain("/accept-invitation/invite-id");
  });
});
