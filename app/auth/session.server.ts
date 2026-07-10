import { redirect } from "react-router";

import { auth } from "~/lib/auth.server";

type BetterAuthSession = NonNullable<
  Awaited<ReturnType<typeof auth.api.getSession>>
>;

export type SessionAuth = BetterAuthSession & {
  organizationId: string | null;
  requestHeaders: Headers;
};

export type SessionState =
  | SessionAuth
  | {
      user: null;
      session: null;
      organizationId: null;
    };

type RequestArgs = { request: Request };

function safeReturnTo(request: Request, fallback = "/dashboard"): string {
  const url = new URL(request.url);
  const candidate = `${url.pathname}${url.search}`;
  return candidate.startsWith("/") && !candidate.startsWith("//")
    ? candidate
    : fallback;
}

export function loginPath(
  request: Request,
  returnTo = safeReturnTo(request),
): string {
  return `/login?returnTo=${encodeURIComponent(returnTo)}`;
}

export async function getSessionAuth(
  input: Request | RequestArgs,
): Promise<SessionState> {
  const request = input instanceof Request ? input : input.request;
  const result = await auth.api.getSession({ headers: request.headers });
  if (!result) {
    return { user: null, session: null, organizationId: null };
  }
  return {
    ...result,
    organizationId: result.session.activeOrganizationId ?? null,
    requestHeaders: request.headers,
  };
}

export async function requireSession(
  input: Request | RequestArgs,
): Promise<SessionAuth> {
  const request = input instanceof Request ? input : input.request;
  const session = await getSessionAuth(request);
  if (!session.user) throw redirect(loginPath(request));
  return session;
}

export function sessionLoader(
  args: RequestArgs,
): Promise<{ user: SessionState["user"] }>;
export function sessionLoader<T extends object>(
  args: RequestArgs,
  callback: (context: { auth: SessionAuth }) => T | Promise<T>,
  options?: { ensureSignedIn?: boolean },
): Promise<T & { user: SessionAuth["user"] }>;
export async function sessionLoader<T extends object>(
  args: RequestArgs,
  callback?: (context: { auth: SessionAuth }) => T | Promise<T>,
  options?: { ensureSignedIn?: boolean },
): Promise<
  (T & { user: SessionAuth["user"] }) | { user: SessionState["user"] }
> {
  const session = await getSessionAuth(args);
  if (!session.user) {
    if (options?.ensureSignedIn || callback)
      throw redirect(loginPath(args.request));
    return { user: null };
  }
  if (!callback) return { user: session.user };
  const result = await callback({ auth: session });
  return { ...result, user: session.user };
}
