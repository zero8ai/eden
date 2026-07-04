/**
 * Legacy redirect: /projects/... → /repos/... (the repositories rename). Permanent, and
 * preserves the query string so team deep-links (?agent=<member>) survive.
 */
import { redirect, type LoaderFunctionArgs } from "react-router";

export function loader({ request, params }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const rest = params["*"] ? `/${params["*"]}` : "";
  throw redirect(`/repos/${params.projectId}${rest}${url.search}`, 301);
}
