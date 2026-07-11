export function safeReturnTo(
  value: string | null | undefined,
  fallback = "/dashboard",
): string {
  // Backslashes are treated as slashes by browsers ("/\evil.com" → "//evil.com").
  if (
    !value ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return fallback;
  }
  try {
    const url = new URL(value, "http://eden.local");
    if (url.origin !== "http://eden.local") return fallback;
    // URL normalization removes dot segments, so "/.//evil.com" passes the checks above yet
    // normalizes to the protocol-relative "//evil.com". Re-check the NORMALIZED path before
    // trusting it.
    if (url.pathname.startsWith("//")) return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
