import { authLoader } from "@workos-inc/authkit-react-router";

// Fallback destination when the sign-in wasn't initiated from a guarded route (e.g. the
// marketing header's "Sign in" link carries no returnTo). Land signed-in users on the
// dashboard, not the public landing page — otherwise a successful login looks like a no-op.
export const loader = authLoader({ returnPathname: "/dashboard" });
