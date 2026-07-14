import { mobileApi, type ResourceCategory } from "@eden/api-contract";
import { router, useLocalSearchParams } from "expo-router";
import React, { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";

import { apiJson, edenFetch } from "@/lib/api";

export type JsonRecord = Record<string, any>;

export const colors = {
  background: "#f7f7f4",
  card: "#ffffff",
  ink: "#18181b",
  muted: "#71717a",
  line: "#e4e4e7",
  accent: "#6d4aff",
  danger: "#b42318",
  success: "#067647",
};

export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  content: { padding: 16, paddingBottom: 48, gap: 12 },
  card: { backgroundColor: colors.card, borderRadius: 16, borderWidth: 1, borderColor: colors.line, padding: 16, gap: 8 },
  title: { color: colors.ink, fontSize: 24, fontWeight: "700" },
  heading: { color: colors.ink, fontSize: 17, fontWeight: "700" },
  body: { color: colors.ink, fontSize: 15, lineHeight: 21 },
  muted: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  row: { minHeight: 52, flexDirection: "row", alignItems: "center", gap: 12 },
  grow: { flex: 1 },
  button: { minHeight: 44, borderRadius: 12, paddingHorizontal: 16, alignItems: "center", justifyContent: "center", backgroundColor: colors.accent },
  buttonText: { color: "white", fontSize: 15, fontWeight: "700" },
  secondary: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.line },
  secondaryText: { color: colors.ink },
  input: { minHeight: 48, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.card, borderRadius: 12, paddingHorizontal: 14, color: colors.ink, fontSize: 15 },
  badge: { alignSelf: "flex-start", borderRadius: 999, backgroundColor: "#eeebff", paddingHorizontal: 9, paddingVertical: 4 },
  badgeText: { color: "#4c2fb8", fontSize: 12, fontWeight: "700" },
  error: { color: colors.danger, fontSize: 14 },
});

export function useRepositoryContext() {
  const params = useLocalSearchParams<{ projectId: string; agentName?: string; category?: string; runId?: string; path?: string; session?: string }>();
  const projectId = String(params.projectId);
  const agentName = params.agentName ? String(params.agentName) : undefined;
  const base = `/repos/${encodeURIComponent(projectId)}${agentName ? `/agents/${encodeURIComponent(agentName)}` : ""}`;
  const api = (page = "") => agentName
    ? (page ? mobileApi.memberPage(projectId, agentName, page) : mobileApi.member(projectId, agentName))
    : (page ? mobileApi.repositoryPage(projectId, page) : mobileApi.repository(projectId));
  return { ...params, projectId, agentName, base, api };
}

export function useRepositoryData(page = "", query?: string) {
  const context = useRepositoryContext();
  const endpoint = `${context.api(page)}${query ?? ""}`;
  const [data, setData] = useState<JsonRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async () => {
    try {
      setError(null);
      setData(await apiJson<JsonRecord>(endpoint));
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setRefreshing(false);
    }
  }, [endpoint]);
  useEffect(() => {
    // Data fetching is the effect's external synchronization target.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);
  return { ...context, data, error, refreshing, refresh: () => { setRefreshing(true); void load(); } };
}

export function Screen({ title, children, refreshing, onRefresh }: { title: string; children: React.ReactNode; refreshing?: boolean; onRefresh?: () => void }) {
  return <ScrollView style={styles.screen} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} /> : undefined}>
    <Text accessibilityRole="header" style={styles.title}>{title}</Text>
    {children}
  </ScrollView>;
}

export function LoadingState({ error }: { error?: string | null }) {
  return <View style={[styles.screen, { alignItems: "center", justifyContent: "center", padding: 24, gap: 12 }]}>{error ? <><Text style={styles.error}>{error}</Text><Text style={styles.muted}>Pull to refresh or go back and try again.</Text></> : <ActivityIndicator color={colors.accent} />}</View>;
}

export function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return <View style={styles.card}>{title ? <Text style={styles.heading}>{title}</Text> : null}{children}</View>;
}

export function Badge({ children, tone = "accent" }: { children: React.ReactNode; tone?: "accent" | "success" | "danger" }) {
  const bg = tone === "success" ? "#dcfae6" : tone === "danger" ? "#fee4e2" : "#eeebff";
  const color = tone === "success" ? colors.success : tone === "danger" ? colors.danger : "#4c2fb8";
  return <View style={[styles.badge, { backgroundColor: bg }]}><Text style={[styles.badgeText, { color }]}>{children}</Text></View>;
}

export function ActionButton({ label, onPress, secondary, disabled }: { label: string; onPress: () => void; secondary?: boolean; disabled?: boolean }) {
  return <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, secondary && styles.secondary, (pressed || disabled) && { opacity: .55 }]}><Text style={[styles.buttonText, secondary && styles.secondaryText]}>{label}</Text></Pressable>;
}

export async function submitForm(path: string, fields: Record<string, string> | FormData) {
  const form = fields instanceof FormData ? fields : new FormData();
  if (!(fields instanceof FormData)) Object.entries(fields).forEach(([key, value]) => form.set(key, value));
  return apiJson<JsonRecord>(path, { method: "POST", body: form });
}

const navItems = [
  ["Overview", ""], ["Playground", "/playground"], ["Runs", "/runs"], ["Deployment", "/deployment"], ["Resources", "/resources/skills"], ["Edit", "/edit"], ["Settings", "/settings"],
] as const;

export function RepositoryNav() {
  const { base, projectId, agentName } = useRepositoryContext();
  const [deploy, setDeploy] = useState<JsonRecord | null>(null);
  const [showDeploy, setShowDeploy] = useState(false);
  const [env, setEnv] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { apiJson<JsonRecord>(`/repos/${encodeURIComponent(projectId)}/quick-deploy`).then((value) => { setDeploy(value); setEnv(value.envNames?.[0] ?? ""); }).catch(() => null); }, [projectId]);
  const quickDeploy = async () => {
    if (!env || !deploy) return;
    setBusy(true);
    const form = new FormData();
    form.set("env", env); form.set("source", deploy.draftCount > 0 ? "staged" : "head");
    if (agentName) form.set("agent", agentName);
    try {
      const response = await edenFetch(`/repos/${encodeURIComponent(projectId)}/quick-deploy`, { method: "POST", body: form, redirect: "manual" });
      const body = await response.json().catch(() => null) as JsonRecord | null;
      if (response.status >= 400 || body?.error) throw new Error(body?.error ?? `Deploy failed (${response.status}).`);
      setShowDeploy(false); router.replace(base as never);
    } catch (cause) { Alert.alert("Quick deploy", (cause as Error).message); } finally { setBusy(false); }
  };
  return <>
    <View style={{ backgroundColor: colors.card, borderBottomWidth: 1, borderBottomColor: colors.line }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ padding: 8, gap: 6 }}>
        {navItems.map(([label, suffix]) => <Pressable key={label} onPress={() => router.push(`${base}${suffix}` as never)} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 12, borderRadius: 10 }}><Text style={{ color: colors.ink, fontWeight: "600" }}>{label}</Text></Pressable>)}
        {!agentName ? <Pressable onPress={() => router.push(`${base}/assistant` as never)} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 12 }}><Text style={{ fontWeight: "600" }}>Assistant</Text></Pressable> : null}
        <Pressable onPress={() => setShowDeploy(true)} disabled={!deploy?.envNames?.length} style={{ minHeight: 44, justifyContent: "center", paddingHorizontal: 12 }}><Text style={{ color: colors.accent, fontWeight: "700" }}>Quick deploy{deploy?.draftCount ? ` · ${deploy.draftCount}` : ""}</Text></Pressable>
      </ScrollView>
    </View>
    <Modal visible={showDeploy} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setShowDeploy(false)}>
      <Screen title="Quick deploy">
        <Card><Text style={styles.body}>{deploy?.draftCount ? `${deploy.draftCount} staged change${deploy.draftCount === 1 ? "" : "s"}` : `Deploy ${deploy?.headBranch ?? "repository HEAD"}`}</Text><Text style={styles.muted}>{(deploy?.members ?? []).join(", ")}</Text></Card>
        <Text style={styles.heading}>Environment</Text>
        {(deploy?.envNames ?? []).map((name: string) => <Pressable key={name} onPress={() => setEnv(name)} style={[styles.card, env === name && { borderColor: colors.accent, borderWidth: 2 }]}><Text style={styles.body}>{name}</Text></Pressable>)}
        <ActionButton label={busy ? "Deploying…" : "Deploy"} disabled={busy || !env} onPress={() => void quickDeploy()} />
        <ActionButton label="Cancel" secondary onPress={() => setShowDeploy(false)} />
      </Screen>
    </Modal>
  </>;
}

export const categories: ResourceCategory[] = ["tools", "skills", "subagents", "channels", "schedules", "connections"];
