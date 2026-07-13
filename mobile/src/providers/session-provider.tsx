import { router, useSegments } from "expo-router";
import {
  createContext,
  type PropsWithChildren,
  useContext,
  useEffect,
} from "react";

import { authClient } from "@/lib/auth-client";

type SessionContextValue = ReturnType<typeof authClient.useSession>;
const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: PropsWithChildren) {
  const session = authClient.useSession();
  const segments = useSegments();

  useEffect(() => {
    if (session.isPending) return;
    const routeSegments = segments as readonly string[];
    const inAuthGroup = routeSegments[0] === "(auth)";
    // Invitations are delivered as deep links and need to remain visible after sign-in so the
    // authenticated organization plugin can accept them. Other auth screens leave immediately.
    const acceptingInvitation = inAuthGroup && routeSegments[1] === "accept-invitation";
    if (!session.data && !inAuthGroup) router.replace("/(auth)/login");
    if (session.data && inAuthGroup && !acceptingInvitation) router.replace("/(app)");
  }, [segments, session.data, session.isPending]);

  return (
    <SessionContext.Provider value={session}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const value = useContext(SessionContext);
  if (!value) throw new Error("useSession must be used inside SessionProvider");
  return value;
}
