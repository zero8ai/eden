import { nativeAction } from "~/lib/mobile-resource.server";
import { action as webAction, loader } from "./marketplace.$type.$id.install";
export { loader };
export const action = nativeAction(webAction);
