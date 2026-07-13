import { router, useLocalSearchParams } from "expo-router";
import React, { useRef, useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";

import { apiNdjson, edenFetch } from "@/lib/api";
import { ActionButton, Badge, Card, LoadingState, Screen, styles, submitForm, useRepositoryData, type JsonRecord } from "./foundation";

type StreamEvent =
  | { type: "session"; playgroundSessionId: string }
  | { type: "model"; modelId: string }
  | { type: "thinking" }
  | { type: "action"; toolName: string; summary: string | null }
  | { type: "text"; text: string }
  | { type: "step"; step: JsonRecord }
  | { type: "input"; requests: JsonRecord[] }
  | { type: "done"; reply: string | null; error: string | null; modelId: string | null; playgroundSessionId?: string };

type LiveTurn = { text: string; activity: string | null; error: string | null; steps: JsonRecord[]; done: boolean; sessionId: string | null };
const initialLive = (): LiveTurn => ({ text: "", activity: "Thinking…", error: null, steps: [], done: false, sessionId: null });
export function reduceStream(prev: LiveTurn, evt: StreamEvent): LiveTurn {
  switch (evt.type) {
    case "session": return { ...prev, sessionId: evt.playgroundSessionId };
    case "thinking": return { ...prev, activity: "Thinking…" };
    case "action": return { ...prev, activity: evt.summary ? `${evt.toolName}: ${evt.summary}` : evt.toolName };
    case "text": return { ...prev, text: evt.text };
    case "step": return { ...prev, steps: [...prev.steps, evt.step], activity: "Thinking…" };
    case "input": return { ...prev, activity: null };
    case "done": return { ...prev, text: evt.reply ?? prev.text, error: evt.error, activity: null, done: true, sessionId: evt.playgroundSessionId ?? prev.sessionId };
    default: return prev;
  }
}

function Transcript({ entries, live, prompt }: { entries: JsonRecord[]; live: LiveTurn | null; prompt: string | null }) {
  return <>{entries.map((entry, i) => {
    const role = String(entry.role ?? entry.type ?? "event");
    const body = entry.text ?? entry.content ?? entry.message ?? entry.reply ?? entry.summary;
    if (!body && !entry.error) return null;
    return <Card key={entry.id ?? i} title={role === "user" ? "You" : role === "assistant" ? "Agent" : role}><Text style={styles.body}>{String(body ?? "")}</Text>{entry.error ? <Text style={styles.error}>{String(entry.error)}</Text> : null}</Card>;
  })}{prompt ? <Card title="You"><Text style={styles.body}>{prompt}</Text></Card> : null}{live ? <Card title="Agent">{live.text ? <Text style={styles.body}>{live.text}</Text> : null}{live.activity ? <Text style={styles.muted}>{live.activity}</Text> : null}{live.error ? <Text style={styles.error}>{live.error}</Text> : null}{live.steps.map((step, i) => <Text key={i} style={styles.muted}>{String(step.summary ?? step.name ?? step.type ?? "Completed a step")}</Text>)}</Card> : null}</>;
}

export function PlaygroundScreen() {
  const state = useRepositoryData("playground", useSessionQuery());
  const [message, setMessage] = useState(""); const [prompt, setPrompt] = useState<string | null>(null); const [live, setLive] = useState<LiveTurn | null>(null); const abort = useRef<AbortController | null>(null);
  if (!state.data) return <LoadingState error={state.error} />;
  const send = async () => {
    const value = message.trim(); if (!value || live && !live.done) return;
    setMessage(""); setPrompt(value); setLive(initialLive());
    const form = new FormData(); form.set("message", value); form.set("deploymentId", String(state.data!.lastDeploymentId ?? state.data!.targets?.[0]?.deploymentId ?? state.data!.targets?.[0]?.id ?? "")); form.set("agentName", String(state.data!.activeAgent ?? state.agentName ?? ""));
    if (state.data!.currentSessionId) form.set("playgroundSessionId", state.data!.currentSessionId);
    if (state.data!.currentSessionModelId ?? state.data!.defaultModelId) form.set("modelId", String(state.data!.currentSessionModelId ?? state.data!.defaultModelId));
    abort.current = new AbortController();
    try { for await (const evt of apiNdjson<StreamEvent>(`/api/repos/${encodeURIComponent(state.projectId)}/playground/stream`, { method: "POST", body: form, signal: abort.current.signal })) setLive((old) => old ? reduceStream(old, evt) : old); setLive((old) => old ? { ...old, done: true, activity: null } : old); state.refresh(); }
    catch (e) { if (!abort.current?.signal.aborted) setLive((old) => old ? { ...old, error: (e as Error).message, activity: null, done: true } : old); }
    finally { abort.current = null; }
  };
  const stop = async () => { abort.current?.abort(); const form = new FormData(); form.set("playgroundSessionId", state.data!.currentSessionId ?? live?.sessionId ?? ""); form.set("agentName", state.data!.activeAgent ?? state.agentName ?? ""); try { await edenFetch(`/api/repos/${encodeURIComponent(state.projectId)}/playground/stop`, { method: "POST", body: form }); } finally { setLive(null); setPrompt(null); state.refresh(); } };
  const newSession = async () => { try { const result = await submitForm(state.api("playground"), { intent: "new-session" }); const session = String(result.redirectTo ?? "").match(/[?&]session=([^&]+)/)?.[1]; router.replace({ pathname: `${state.base}/playground` as never, params: session ? { session: decodeURIComponent(session) } : {} } as never); state.refresh(); } catch (e) { Alert.alert("Conversation", (e as Error).message); } };
  return <Screen title="Playground" refreshing={state.refreshing} onRefresh={state.refresh}>
    <View style={{ flexDirection: "row", gap: 8 }}><View style={styles.grow}><ActionButton label="New conversation" secondary onPress={() => void newSession()} /></View>{state.data.currentSessionStatus ? <Badge>{String(state.data.currentSessionStatus)}</Badge> : null}</View>
    {(state.data.sessions ?? []).slice(0, 8).map((session: JsonRecord) => <Pressable key={session.id} onPress={() => router.replace({ pathname: `${state.base}/playground` as never, params: { session: session.id } } as never)}><Text style={styles.muted}>{session.title ?? "Conversation"} · {new Date(session.updatedAt).toLocaleDateString()}</Text></Pressable>)}
    {state.data.historyError ? <Text style={styles.error}>{String(state.data.historyError)}</Text> : null}
    <Transcript entries={state.data.entries ?? []} live={live} prompt={prompt} />
    <TextInput accessibilityLabel="Message" placeholder="Message your agent…" value={message} onChangeText={setMessage} multiline style={[styles.input, { minHeight: 80, paddingTop: 14 }]} />
    {live && !live.done ? <ActionButton label="Stop" secondary onPress={() => void stop()} /> : <ActionButton label="Send" disabled={!message.trim()} onPress={() => void send()} />}
  </Screen>;
}

function useSessionQuery() { const state = useLocalSearchParams<{ session?: string }>(); return state.session ? `?session=${encodeURIComponent(String(state.session))}` : undefined; }

export function AssistantScreen() {
  const state = useRepositoryData("assistant", useAssistantSessionQuery());
  const [message, setMessage] = useState(""); const [prompt, setPrompt] = useState<string | null>(null); const [live, setLive] = useState<LiveTurn | null>(null);
  if (!state.data) return <LoadingState error={state.error} />;
  const send = async () => { const value = message.trim(); if (!value) return; setMessage(""); setPrompt(value); setLive(initialLive()); const form = new FormData(); form.set("message", value); if (state.data!.currentSessionId) form.set("playgroundSessionId", state.data!.currentSessionId); try { for await (const evt of apiNdjson<StreamEvent>(`/api/repos/${encodeURIComponent(state.projectId)}/assistant/stream`, { method: "POST", body: form })) setLive((old) => old ? reduceStream(old, evt) : old); state.refresh(); } catch (e) { setLive((old) => old ? { ...old, error: (e as Error).message, done: true, activity: null } : old); } };
  const action = async (intent: "provision" | "new-session") => { try { const result = await submitForm(state.api("assistant"), { intent }); const session = String(result.redirectTo ?? "").match(/[?&]session=([^&]+)/)?.[1]; if (session) router.replace({ pathname: `${state.base}/assistant` as never, params: { session: decodeURIComponent(session) } } as never); state.refresh(); } catch (e) { Alert.alert("Assistant", (e as Error).message); } };
  return <Screen title="Repository assistant" refreshing={state.refreshing} onRefresh={state.refresh}><View style={{ flexDirection: "row", gap: 8 }}><View style={styles.grow}><ActionButton label="Configure" secondary onPress={() => router.push(`${state.base}/assistant/config` as never)} /></View><View style={styles.grow}><ActionButton label="New conversation" secondary onPress={() => void action("new-session")} /></View></View>{state.data.instanceStatus && state.data.instanceStatus !== "ready" ? <><Badge>{String(state.data.instanceStatus)}</Badge><ActionButton label="Set up assistant" onPress={() => void action("provision")}/></> : null}<Transcript entries={state.data.entries ?? []} live={live} prompt={prompt}/><TextInput accessibilityLabel="Assistant message" placeholder="What should your repository do?" value={message} onChangeText={setMessage} multiline style={[styles.input, { minHeight: 80, paddingTop: 14 }]}/><ActionButton label="Send" disabled={!message.trim() || !!live && !live.done || state.data.instanceStatus !== "ready"} onPress={() => void send()} /></Screen>;
}
function useAssistantSessionQuery() { const state = useLocalSearchParams<{ session?: string }>(); return state.session ? `?session=${encodeURIComponent(String(state.session))}` : undefined; }

export function AssistantConfigScreen() {
  const state = useRepositoryData("assistant/config"); const [instructions, setInstructions] = useState<string | null>(null); const [model, setModel] = useState<string | null>(null); const [name, setName] = useState(""); const [cron, setCron] = useState("0 9 * * *"); const [message, setMessage] = useState("");
  if (!state.data) return <LoadingState error={state.error} />;
  const save = async (fields: Record<string, string>) => { try { const result = await submitForm(state.api("assistant/config"), fields); if (result.error) throw new Error(result.error); state.refresh(); Alert.alert("Saved", "Assistant configuration updated."); } catch (e) { Alert.alert("Assistant config", (e as Error).message); } };
  return <Screen title="Assistant config" refreshing={state.refreshing} onRefresh={state.refresh}><Card title="Instructions"><TextInput multiline textAlignVertical="top" value={instructions ?? state.data.instructions ?? ""} onChangeText={setInstructions} style={[styles.input, { minHeight: 180, paddingTop: 14 }]}/><ActionButton label="Save instructions" onPress={() => void save({ intent: "save-instructions", content: instructions ?? state.data!.instructions ?? "" })}/></Card><Card title="Model"><TextInput value={model ?? state.data.model ?? ""} onChangeText={setModel} style={styles.input} autoCapitalize="none"/><ActionButton label="Save model" onPress={() => void save({ intent: "save-model", model: model ?? state.data!.model ?? "" })}/></Card><Card title="New skill"><TextInput value={name} onChangeText={setName} placeholder="Skill name" style={styles.input}/><ActionButton label="Add skill" disabled={!name.trim()} onPress={() => void save({ intent: "save-skill", name, description: "", body: "" })}/></Card><Card title="New schedule"><TextInput value={name} onChangeText={setName} placeholder="Schedule name" style={styles.input}/><TextInput value={cron} onChangeText={setCron} placeholder="Cron" style={styles.input}/><TextInput value={message} onChangeText={setMessage} placeholder="Task" multiline style={[styles.input, { minHeight: 100 }]}/><ActionButton label="Add schedule" disabled={!name.trim() || !message.trim()} onPress={() => void save({ intent: "save-schedule", name, cron, message })}/></Card></Screen>;
}
