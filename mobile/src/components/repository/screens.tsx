import { router } from "expo-router";
import React, { useState } from "react";
import { Alert, Pressable, Text, TextInput, View } from "react-native";

import { ActionButton, Badge, Card, categories, LoadingState, Screen, styles, submitForm, useRepositoryContext, useRepositoryData, type JsonRecord } from "./foundation";

const text = (value: unknown, fallback = "—") => value == null || value === "" ? fallback : String(value);
const date = (value: unknown) => { const d = new Date(String(value)); return Number.isNaN(d.valueOf()) ? text(value) : d.toLocaleString(); };
const statusTone = (value: unknown) => ["completed", "success", "ready", "running"].includes(String(value)) ? "success" : ["failed", "error"].includes(String(value)) ? "danger" : "accent";

function KeyValues({ value, omit = [] }: { value: JsonRecord; omit?: string[] }) {
  return <View>{Object.entries(value).filter(([key, item]) => !omit.includes(key) && (typeof item === "string" || typeof item === "number" || typeof item === "boolean")).slice(0, 8).map(([key, item]) => <View key={key} style={styles.row}><Text style={[styles.muted, styles.grow]}>{key.replaceAll(/([A-Z])/g, " $1")}</Text><Text style={styles.body}>{text(item)}</Text></View>)}</View>;
}

export function OverviewScreen() {
  const state = useRepositoryData();
  if (!state.data) return <LoadingState error={state.error} />;
  const { data } = state;
  const team = data.view === "team" || (data.teamLayout && !state.agentName);
  return <Screen title={text(data.project?.name, "Repository")} refreshing={state.refreshing} onRefresh={state.refresh}>
    {data.error ? <Text style={styles.error}>{data.error}</Text> : null}
    {team ? <>
      <Text style={styles.muted}>Choose an agent to inspect its configuration, conversations, runs, and deployment state.</Text>
      {(data.members ?? []).map((member: JsonRecord) => <Pressable key={member.name} accessibilityRole="button" onPress={() => router.push(`${state.base}/agents/${encodeURIComponent(member.name)}` as never)}>
        <Card><View style={styles.row}><View style={styles.grow}><Text style={styles.heading}>{member.name}</Text><Text style={styles.muted}>{text(member.model, "Workspace default model")}</Text></View><Text style={styles.heading}>›</Text></View><Text style={styles.muted}>{member.tools ?? 0} tools · {member.skills ?? 0} skills · {member.schedules ?? 0} schedules</Text>{member.secretsMissing ? <Badge tone="danger">{member.secretsMissing} secrets missing</Badge> : <Badge tone="success">Ready</Badge>}</Card>
      </Pressable>)}
    </> : <>
      <Card title={text(data.active?.name ?? data.activeAgent, "Agent")}><Badge>{text(data.config?.model, "Default model")}</Badge><Text style={styles.body}>{data.config?.tools?.length ?? 0} tools · {data.config?.skills?.length ?? 0} skills · {data.config?.schedules?.length ?? 0} schedules · {data.config?.channels?.length ?? 0} channels</Text></Card>
      <Card title="Running environments">{(data.running ?? []).length ? data.running.map((run: JsonRecord, i: number) => <View key={run.environmentId ?? i} style={styles.row}><View style={styles.grow}><Text style={styles.body}>{text(run.environmentName ?? run.name, "Environment")}</Text><Text style={styles.muted}>{text(run.gitSha ?? run.status)}</Text></View><Badge tone={statusTone(run.status)}>{text(run.status, "running")}</Badge></View>) : <Text style={styles.muted}>No deployed environments yet.</Text>}</Card>
    </>}
  </Screen>;
}

const deploymentGroups = ["envs", "teamEnvs", "deployments", "releases", "changes", "drafts"];
export function DeploymentScreen() {
  const state = useRepositoryData("deployment");
  const [busy, setBusy] = useState<string | null>(null);
  if (!state.data) return <LoadingState error={state.error} />;
  const mutate = async (intent: string, fields: Record<string, string>) => { setBusy(intent); try { const result = await submitForm(state.api("deployment"), { intent, ...fields }); if (result.error) throw new Error(result.error); state.refresh(); } catch (e) { Alert.alert("Deployment", (e as Error).message); } finally { setBusy(null); } };
  return <Screen title="Deployment" refreshing={state.refreshing} onRefresh={state.refresh}>
    {state.data.drafts?.length ? <ActionButton label={busy === "publish" ? "Publishing…" : "Publish staged changes"} disabled={!!busy} onPress={() => void mutate("publish", {})} /> : null}
    {deploymentGroups.map((key) => Array.isArray(state.data?.[key]) && state.data[key].length ? <Card key={key} title={key[0].toUpperCase() + key.slice(1)}>{state.data[key].slice(0, 30).map((item: JsonRecord, i: number) => <View key={item.id ?? item.path ?? item.name ?? i} style={{ borderBottomWidth: i < state.data![key].length - 1 ? 1 : 0, borderBottomColor: "#e4e4e7", paddingVertical: 8 }}><View style={styles.row}><View style={styles.grow}><Text style={styles.body}>{text(item.name ?? item.title ?? item.label ?? item.path ?? item.gitSha, "Deployment")}</Text><Text style={styles.muted}>{text(item.updatedAt ?? item.createdAt ?? item.gitSha, "")}</Text></View>{item.status ? <Badge tone={statusTone(item.status)}>{item.status}</Badge> : null}</View>{item.path && key === "drafts" ? <ActionButton label={busy === "discard" ? "Discarding…" : "Discard"} secondary disabled={!!busy} onPress={() => void mutate("discard", { path: item.path })} /> : null}{key === "changes" && (item.pullNumber ?? item.number) ? <View style={{ flexDirection: "row", gap: 8 }}><View style={styles.grow}><ActionButton label="Merge" disabled={!!busy} onPress={() => void mutate("merge", { pullNumber: String(item.pullNumber ?? item.number) })}/></View><View style={styles.grow}><ActionButton label="Delete" secondary disabled={!!busy} onPress={() => void mutate("delete-change", { pullNumber: String(item.pullNumber ?? item.number) })}/></View></View> : null}{item.status === "failed" && item.id ? <ActionButton label="Retry" secondary onPress={() => void mutate("retry", { deploymentId: item.id })} /> : null}</View>)}</Card> : null)}
    {!deploymentGroups.some((key) => state.data?.[key]?.length) ? <Card><Text style={styles.muted}>No deployment activity yet. Use Quick deploy from the repository navigation when you are ready.</Text></Card> : null}
  </Screen>;
}

export function SettingsScreen() {
  const state = useRepositoryData("settings");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);
  if (!state.data) return <LoadingState error={state.error} />;
  const selected = model || state.data.config?.model || state.data.model || "";
  const saveModel = async () => { setSaving(true); try { const result = await submitForm(state.api("settings"), { intent: "set-model", model: selected, ...(state.agentName ? { agent: state.agentName } : {}) }); if (result.error) throw new Error(result.error); state.refresh(); } catch (e) { Alert.alert("Settings", (e as Error).message); } finally { setSaving(false); } };
  return <Screen title="Settings" refreshing={state.refreshing} onRefresh={state.refresh}>
    <Card title="Model"><TextInput accessibilityLabel="Model identifier" value={selected} onChangeText={setModel} autoCapitalize="none" style={styles.input} placeholder="provider/model"/><ActionButton label={saving ? "Saving…" : "Save model"} disabled={saving || !selected} onPress={() => void saveModel()} /></Card>
    {["installs", "members", "sharedSecrets", "memberSecrets", "environments"].map((key) => Array.isArray(state.data?.[key]) && state.data[key].length ? <Card key={key} title={key.replaceAll(/([A-Z])/g, " $1")}>{state.data[key].map((item: JsonRecord, i: number) => <View key={item.id ?? item.name ?? i} style={{ paddingVertical: 6 }}><Text style={styles.body}>{text(item.name ?? item.id ?? item.type)}</Text><KeyValues value={item} omit={["id", "name", "type"]} /></View>)}</Card> : null)}
    <Card title="Repository"><KeyValues value={state.data.project ?? {}} omit={["id", "name"]}/></Card>
  </Screen>;
}

export function RunsScreen() {
  const state = useRepositoryData("runs");
  if (!state.data) return <LoadingState error={state.error} />;
  return <Screen title="Runs" refreshing={state.refreshing} onRefresh={state.refresh}>
    {state.data.stats ? <Card title="Summary"><KeyValues value={state.data.stats} /></Card> : null}
    {(state.data.runs ?? []).map((run: JsonRecord) => <Pressable key={run.id} onPress={() => router.push(`${state.base}/runs/${encodeURIComponent(run.id)}` as never)}><Card><View style={styles.row}><View style={styles.grow}><Text style={styles.heading}>{text(run.trigger ?? run.channel ?? run.id, "Run")}</Text><Text style={styles.muted}>{date(run.startedAt ?? run.createdAt)}</Text></View><Badge tone={statusTone(run.status)}>{text(run.status)}</Badge></View><Text style={styles.muted}>{run.durationMs != null ? `${run.durationMs}ms` : ""}{run.model ? ` · ${run.model}` : ""}</Text></Card></Pressable>)}
    {!state.data.runs?.length ? <Card><Text style={styles.muted}>No runs match the current filters.</Text></Card> : null}
  </Screen>;
}

export function RunDetailScreen() {
  const ctx = useRepositoryContext();
  const state = useRepositoryData(`runs/${encodeURIComponent(String(ctx.runId))}`);
  if (!state.data) return <LoadingState error={state.error} />;
  const run = state.data.run ?? state.data;
  return <Screen title="Run transcript" refreshing={state.refreshing} onRefresh={state.refresh}><Card><View style={styles.row}><Text style={[styles.heading, styles.grow]}>{text(run.trigger ?? run.channel ?? run.id)}</Text><Badge tone={statusTone(run.status)}>{text(run.status)}</Badge></View><KeyValues value={run} omit={["id", "trigger", "channel", "status", "steps", "transcript"]}/></Card>{(state.data.steps ?? run.steps ?? []).map((step: JsonRecord, i: number) => <Card key={step.id ?? i} title={text(step.type ?? step.name, `Step ${i + 1}`)}><Text style={styles.body}>{text(step.text ?? step.content ?? step.output ?? step.summary, "No text output")}</Text>{step.error ? <Text style={styles.error}>{text(step.error)}</Text> : null}</Card>)}</Screen>;
}

export function ResourcesScreen() {
  const ctx = useRepositoryContext(); const category = categories.includes(ctx.category as any) ? String(ctx.category) : "skills";
  const state = useRepositoryData(`resources/${category}`);
  if (!state.data) return <LoadingState error={state.error} />;
  const act = async (row: JsonRecord) => { const intent = row.stagedDelete ? "undo-delete" : "delete-resource"; try { const result = await submitForm(state.api(`resources/${category}`), { intent, path: row.path }); if (result.error) throw new Error(result.error); state.refresh(); } catch (e) { Alert.alert("Resource", (e as Error).message); } };
  return <Screen title={text(state.data.category?.label, category)} refreshing={state.refreshing} onRefresh={state.refresh}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>{categories.map((cat) => <ActionButton key={cat} label={cat} secondary={cat !== category} onPress={() => router.replace(`${state.base}/resources/${cat}` as never)} />)}</View>
    {(state.data.rows ?? []).map((row: JsonRecord) => <Card key={row.path}><Pressable onPress={() => router.push({ pathname: `${state.base}/edit` as never, params: { path: row.path } } as never)}><View style={styles.row}><View style={styles.grow}><Text style={styles.heading}>{text(row.name)}</Text><Text style={styles.muted}>{row.path}</Text></View>{row.staged ? <Badge tone={row.stagedDelete ? "danger" : "accent"}>{row.stagedDelete ? "Delete staged" : "Staged"}</Badge> : null}</View></Pressable><ActionButton secondary label={row.stagedDelete ? "Restore" : "Stage deletion"} onPress={() => void act(row)} /></Card>)}
  </Screen>;
}

export function EditIndexScreen() {
  const query = useEditQuery();
  const state = useRepositoryData(query ? "edit" : "", query);
  const [value, setValue] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!state.data) return <LoadingState error={state.error} />;
  const content = value ?? text(state.data.content, "");
  const path = String(state.data.path ?? state.path ?? "");
  const save = async () => { setSaving(true); try { const result = await submitForm(state.api("edit"), { path, content, ...(state.agentName ? { agent: state.agentName } : {}) }); if (result.error) throw new Error(result.error); Alert.alert("Saved", "The change is staged for deployment."); } catch (e) { Alert.alert("Editor", (e as Error).message); } finally { setSaving(false); } };
  const schedules: JsonRecord[] = state.data.config?.schedules ?? [];
  const newSchedulePath = `${state.agentName ? `agents/${state.agentName}/agent` : "agent"}/schedules/new.md`;
  return <Screen title={path ? path.split("/").pop()! : "Edit agent"}><Card><Text style={styles.muted}>{path || "Edit the agent's source-backed configuration. Saves are staged until deployment."}</Text>{path ? <><TextInput value={content} onChangeText={setValue} multiline textAlignVertical="top" autoCapitalize="none" style={[styles.input, { minHeight: 320, paddingTop: 14, fontFamily: "monospace" }]} /><ActionButton label={saving ? "Saving…" : "Save draft"} disabled={saving} onPress={() => void save()} /></> : null}</Card><ActionButton label="Edit instructions" secondary onPress={() => router.push(`${state.base}/edit/instructions` as never)} />{!path ? <><Text style={styles.heading}>Schedules</Text>{schedules.map((schedule, i) => <Pressable key={schedule.path ?? schedule.name ?? i} onPress={() => router.push({ pathname: `${state.base}/edit/schedule` as never, params: { path: schedule.path } } as never)}><Card><Text style={styles.body}>{text(schedule.name ?? schedule.path, "Schedule")}</Text><Text style={styles.muted}>{text(schedule.cron, "")}</Text></Card></Pressable>)}<ActionButton label="New schedule" secondary onPress={() => router.push({ pathname: `${state.base}/edit/schedule` as never, params: { path: newSchedulePath } } as never)} /></> : null}</Screen>;
}

function useEditQuery() { const { path } = useRepositoryContext(); return path ? `?path=${encodeURIComponent(String(path))}` : undefined; }

export function InstructionsScreen() {
  const state = useRepositoryData("edit/instructions");
  const [value, setValue] = useState<string | null>(null); const [saving, setSaving] = useState(false);
  if (!state.data) return <LoadingState error={state.error} />;
  const content = value ?? text(state.data.instructions, "");
  const save = async () => { setSaving(true); try { const result = await submitForm(state.api("edit/instructions"), { content, ...(state.agentName ? { agent: state.agentName } : {}) }); if (result.error) throw new Error(result.error); Alert.alert("Saved", "Instructions are staged."); } catch (e) { Alert.alert("Instructions", (e as Error).message); } finally { setSaving(false); } };
  return <Screen title="Instructions"><Text style={styles.muted}>Markdown instructions that shape how this agent behaves.</Text><TextInput value={content} onChangeText={setValue} multiline textAlignVertical="top" style={[styles.input, { minHeight: 380, paddingTop: 14 }]} /><ActionButton label={saving ? "Saving…" : "Save instructions"} disabled={saving} onPress={() => void save()} /></Screen>;
}

export function ScheduleScreen() {
  const ctx = useRepositoryContext(); const query = ctx.path ? `?path=${encodeURIComponent(String(ctx.path))}` : "";
  const state = useRepositoryData("edit/schedule", query); const [cron, setCron] = useState<string | null>(null); const [message, setMessage] = useState<string | null>(null); const [saving, setSaving] = useState(false);
  if (!state.data) return <LoadingState error={state.error} />;
  const path = String(state.data.path ?? ctx.path ?? `${state.agentName ? `agents/${state.agentName}/agent` : "agent"}/schedules/new.md`);
  const save = async () => { setSaving(true); try { const result = await submitForm(state.api("edit/schedule"), { path, cron: cron ?? state.data!.cron ?? "0 9 * * *", message: message ?? state.data!.message ?? "" }); if (result.error) throw new Error(result.error); Alert.alert("Saved", "Schedule is staged."); } catch (e) { Alert.alert("Schedule", (e as Error).message); } finally { setSaving(false); } };
  return <Screen title="Schedule"><Card><Text style={styles.heading}>Cron expression</Text><TextInput value={cron ?? state.data.cron ?? "0 9 * * *"} onChangeText={setCron} autoCapitalize="none" style={styles.input}/><Text style={styles.heading}>Task</Text><TextInput value={message ?? state.data.message ?? ""} onChangeText={setMessage} multiline textAlignVertical="top" style={[styles.input, { minHeight: 180, paddingTop: 14 }]}/><ActionButton label={saving ? "Saving…" : "Save schedule"} disabled={saving} onPress={() => void save()} /></Card></Screen>;
}
