import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { handleMcpRequest } from "~/mcp/http.server";

export function loader({ request }: LoaderFunctionArgs) {
  return handleMcpRequest(request);
}

export function action({ request }: ActionFunctionArgs) {
  return handleMcpRequest(request);
}
