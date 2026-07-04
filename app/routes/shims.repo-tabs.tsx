/**
 * Pre-M5.8 tab URLs → the two-level hierarchy, permanently. /changes and /deployments both
 * became the Deployment tab; /secrets became Settings. A legacy ?agent=<name> selector moves
 * into the member path (/repos/:id/agents/:name/...); other query params are preserved.
 */
import { redirect, type LoaderFunctionArgs } from "react-router";

const TAB_MAP: Record<string, string> = {
  changes: "deployment",
  deployments: "deployment",
  secrets: "settings",
};

export function loader({ request, params }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const oldTab = url.pathname.split("/").pop() ?? "";
  const tab = TAB_MAP[oldTab] ?? "deployment";
  const agent = url.searchParams.get("agent");
  url.searchParams.delete("agent");
  const base = agent
    ? `/repos/${params.projectId}/agents/${encodeURIComponent(agent)}`
    : `/repos/${params.projectId}`;
  throw redirect(`${base}/${tab}${url.search}`, 301);
}
