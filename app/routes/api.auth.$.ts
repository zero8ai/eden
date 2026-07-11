import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { auth } from "~/lib/auth.server";

async function handle(request: Request): Promise<Response> {
  try {
    return await auth.handler(request);
  } catch {
    // Never log the thrown value: Better Auth endpoint errors may contain reset/verification
    // tokens in their nested route params. Production disables Better Auth's internal logger too.
    return new Response("Internal Server Error", {
      status: 500,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
        "referrer-policy": "no-referrer",
      },
    });
  }
}

export function loader({ request }: LoaderFunctionArgs) {
  return handle(request);
}

export function action({ request }: ActionFunctionArgs) {
  return handle(request);
}
