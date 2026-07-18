import { createAuthClient } from "better-auth/react";
import { emailOTPClient, organizationClient } from "better-auth/client/plugins";

export const authClient = createAuthClient({
  // emailOTP powers the Agent Portal guest sign-in (issue #180).
  plugins: [organizationClient(), emailOTPClient()],
});
