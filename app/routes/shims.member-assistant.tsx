/**
 * The member-level assistant tab was removed (docs/ASSISTANT.md §1/§9): the assistant is a single
 * project-level surface now. Any old /repos/:id/agents/:name/assistant URL 301s to the repo-level
 * Assistant page.
 */
import { redirect, type LoaderFunctionArgs } from "react-router";

export function loader({ params }: LoaderFunctionArgs) {
  throw redirect(`/repos/${params.projectId}/assistant`, 301);
}
