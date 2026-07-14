import { nativeAction } from "~/lib/mobile-resource.server";
import { action as webAction, loader } from "./workspaces";
export { loader };
export const action = nativeAction(webAction);
