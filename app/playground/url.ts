export function newPlaygroundSessionPath(url: URL, sessionId: string): string {
  const search = new URLSearchParams();
  const deploymentId = url.searchParams.get("deployment");
  if (deploymentId) search.set("deployment", deploymentId);
  search.set("session", sessionId);
  return `${documentPath(url.pathname)}?${search.toString()}`;
}

function documentPath(pathname: string): string {
  if (pathname.endsWith("/_.data")) {
    return pathname.slice(0, -"/_.data".length) || "/";
  }
  if (pathname.endsWith(".data")) {
    return pathname.slice(0, -".data".length) || "/";
  }
  return pathname;
}
