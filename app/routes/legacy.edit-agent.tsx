/**
 * Legacy redirect: the runtime-config editor collapsed into the overview's inline model
 * picker — send old links to the overview (preserving the team member selection).
 */
import { redirect, type LoaderFunctionArgs } from "react-router";

export function loader({ request, params }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  throw redirect(`/repos/${params.projectId}${url.search}`, 301);
}
