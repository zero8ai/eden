import { nativeAction } from "~/lib/mobile-resource.server";
import { action as webAction, loader } from "./connect";
export { loader };
export const action = nativeAction(webAction);
