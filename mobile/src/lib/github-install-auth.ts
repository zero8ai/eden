export type GithubInstallAuthOutcome =
  | { status: "redeem"; handoff: string }
  | { status: "cancelled" }
  | { status: "error"; message: string };

/**
 * Validate the auth-session result and extract only Eden's opaque, one-time handoff. GitHub's
 * installation id is deliberately not part of this parser or its return type.
 */
export function githubInstallAuthOutcome(
  result: { type: string; url?: string },
  redirectUri: string,
): GithubInstallAuthOutcome {
  if (result.type === "cancel" || result.type === "dismiss") {
    return { status: "cancelled" };
  }
  if (result.type !== "success" || !result.url) {
    return {
      status: "error",
      message: "GitHub did not return to Eden. Please try again.",
    };
  }

  try {
    const callback = new URL(result.url);
    const expected = new URL(redirectUri);
    if (
      callback.protocol !== expected.protocol ||
      callback.host !== expected.host ||
      callback.pathname.replace(/\/$/, "") !==
        expected.pathname.replace(/\/$/, "")
    ) {
      return {
        status: "error",
        message: "GitHub returned to an unexpected address.",
      };
    }

    const backendError = callback.searchParams.get("error");
    if (backendError) {
      return {
        status: "error",
        message:
          callback.searchParams.get("error_description") ??
          "GitHub could not authorize this installation.",
      };
    }

    const handoffs = callback.searchParams.getAll("handoff");
    const handoff = handoffs.length === 1 ? handoffs[0].trim() : "";
    if (!handoff) {
      return {
        status: "error",
        message: "GitHub returned without a valid Eden handoff.",
      };
    }
    return { status: "redeem", handoff };
  } catch {
    return {
      status: "error",
      message: "GitHub returned an invalid callback.",
    };
  }
}
