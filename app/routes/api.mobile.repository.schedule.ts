import { nativeAction } from "~/lib/mobile-resource.server";
import {
  action as webAction,
  loader,
} from "./projects.$projectId.edit.schedule";
export { loader };
export const action = nativeAction(webAction);
