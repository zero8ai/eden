import { Stack } from "expo-router";

export default function ProtectedLayout() {
  return <Stack screenOptions={{ headerBackTitle: "Back" }}>
    <Stack.Screen name="index" options={{ headerShown: false }} />
    <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    <Stack.Screen name="connect" options={{ title: "New repository", presentation: "modal" }} />
    <Stack.Screen name="repos/[projectId]" options={{ headerShown: false }} />
  </Stack>;
}
