import { Stack } from "expo-router";
import { View } from "react-native";
import { RepositoryNav } from "@/components/repository/foundation";

export default function RepositoryLayout() {
  return <View style={{ flex: 1 }}><RepositoryNav /><Stack screenOptions={{ headerShown: false }} /></View>;
}
