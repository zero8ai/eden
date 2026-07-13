import { expoClient } from "@better-auth/expo/client";
import { createAuthClient } from "better-auth/react";
import { organizationClient } from "better-auth/client/plugins";
import * as SecureStore from "expo-secure-store";

export const edenUrl = (
  process.env.EXPO_PUBLIC_EDEN_URL ?? "http://localhost:5276"
).replace(/\/$/, "");

export const authClient = createAuthClient({
  baseURL: edenUrl,
  plugins: [
    expoClient({
      scheme: "eden",
      storagePrefix: "eden",
      storage: SecureStore,
    }),
    organizationClient(),
  ],
});
