import { isAPIError } from "better-auth/api";

/**
 * Preserve documented Better Auth client errors without exposing adapter errors or production
 * diagnostics. Better Auth deliberately rethrows non-API failures from direct server API calls.
 */
export function publicAuthErrorMessage(
  error: unknown,
  fallback: string,
): string {
  return isAPIError(error) && error.statusCode < 500 && error.message
    ? error.message
    : fallback;
}
