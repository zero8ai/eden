/**
 * The assistant instance's callback API (docs/ASSISTANT.md §6). The built-in assistant's baked-in
 * tools (and its boot entrypoint) call `POST|GET /api/assistant/<action>` with a Bearer
 * `EDEN_ASSISTANT_TOKEN`. The token authenticates a DEPLOYMENT; everything else (environment →
 * agent → project) is derived from the DB, and the agent must be kind 'assistant'. A bad token is
 * the only 401 — business failures return `{ ok:false, error }` at HTTP 200 so the model reads
 * the text (the ask.server.ts convention). All logic lives in `~/assistant/authoring.server`.
 */
import { data, type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";

import {
  addDependency,
  assembleBundle,
  catalogOp,
  defaultAuthoringDeps,
  deleteFile_,
  listFiles,
  projectContext,
  readFile_,
  resolveAssistantContext,
  runChecks,
  scaffoldMember,
  writeFile_,
  type AuthoringDeps,
} from "~/assistant/authoring.server";
import { bearerToken, verifyAssistantToken } from "~/assistant/token.server";

async function authenticate(request: Request, deps: AuthoringDeps) {
  const token = bearerToken(request);
  const deploymentId = token ? verifyAssistantToken(token) : null;
  if (!deploymentId) return null;
  return resolveAssistantContext(deploymentId, deps.store);
}

/** GET is only for `bundle` (the container entrypoint). */
export async function loader({ request, params }: LoaderFunctionArgs) {
  if (params.action !== "bundle") {
    throw data({ error: "Not found" }, { status: 404 });
  }
  const deps = defaultAuthoringDeps();
  const ctx = await authenticate(request, deps);
  if (!ctx) throw data({ error: "Invalid assistant token" }, { status: 401 });
  const bundle = await assembleBundle(ctx.project, deps);
  return Response.json(bundle);
}

export async function action({ request, params }: ActionFunctionArgs) {
  const deps = defaultAuthoringDeps();
  const ctx = await authenticate(request, deps);
  if (!ctx) throw data({ error: "Invalid assistant token" }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const { project } = ctx;

  switch (params.action) {
    case "list-files":
      return Response.json(await listFiles(project, deps));
    case "read-file":
      return Response.json(await readFile_(project, str(body.path), deps));
    case "write-file":
      return Response.json(await writeFile_(project, str(body.path), str(body.content), deps));
    case "delete-file":
      return Response.json(await deleteFile_(project, str(body.path), deps));
    case "add-dependency":
      return Response.json(
        await addDependency(
          project,
          {
            packages: Array.isArray(body.packages) ? body.packages.map(String) : [],
            agentRoot: str(body.agentRoot) || undefined,
          },
          deps,
        ),
      );
    case "run-checks":
      return Response.json(await runChecks(project, deps));
    case "project-context":
      return Response.json(await projectContext(project, deps));
    case "scaffold-member":
      return Response.json(await scaffoldMember(project, str(body.name), deps));
    case "catalog":
      return Response.json(
        await catalogOp(
          { op: str(body.op), type: str(body.type) || undefined, id: str(body.id) || undefined },
          deps,
        ),
      );
    default:
      throw data({ error: `Unknown action "${params.action}"` }, { status: 404 });
  }
}
