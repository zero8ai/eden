import { nativeAction } from "~/lib/mobile-resource.server";
import { action as webAction, loader } from "./org.settings";
export { loader };
export const action = nativeAction(webAction);
