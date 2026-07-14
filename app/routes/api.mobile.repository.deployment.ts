import { nativeAction } from "~/lib/mobile-resource.server";
import { action as webAction, loader } from "./projects.$projectId.deployments";
export { loader };
export const action = nativeAction(webAction);
