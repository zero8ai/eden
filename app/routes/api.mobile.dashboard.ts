import { nativeAction } from "~/lib/mobile-resource.server";
import { action as webAction, loader } from "./dashboard";
export { loader };
export const action = nativeAction(webAction);
