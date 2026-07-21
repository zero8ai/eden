import { createAuthClient } from "better-auth/react";
import {
  emailOTPClient,
  magicLinkClient,
  organizationClient,
} from "better-auth/client/plugins";

export const authClient = createAuthClient({
  // magicLink is the primary Agent Portal guest sign-in; emailOTP is the code fallback (issue #180).
  plugins: [organizationClient(), emailOTPClient(), magicLinkClient()],
});
