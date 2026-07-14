import { Stack } from "expo-router";

export default function AuthLayout() {
  return <Stack screenOptions={{ headerBackTitle: "Back" }}>
    <Stack.Screen name="login" options={{ headerShown: false }} />
    <Stack.Screen name="signup" options={{ title: "Create account" }} />
    <Stack.Screen name="forgot-password" options={{ title: "Reset password" }} />
    <Stack.Screen name="reset-password" options={{ title: "Choose a password" }} />
    <Stack.Screen name="accept-invitation/[invitationId]" options={{ title: "Workspace invitation" }} />
  </Stack>;
}
