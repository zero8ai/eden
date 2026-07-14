import {
  githubInstallAuthOutcome,
  mobileApi,
  type MobileMutationResult,
} from "@eden/api-contract";
import { router } from "expo-router";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  FormField,
  Heading,
  Loading,
  Row,
  Screen,
  SectionTitle,
  useNativeTheme,
} from "@/components/native";
import { postForm, useApiResource } from "@/hooks/use-api-resource";

type Repo = {
  fullName: string;
  owner: string;
  repo: string;
  defaultBranch: string;
  private: boolean;
};

type Github =
  | { state: "no-org" }
  | { state: "install"; installUrl: string }
  | { state: "unconfigured"; message: string }
  | {
      state: "pick";
      installationGrantId: string;
      repos: Repo[];
      accountLogin: string | null;
      installUrl: string;
    };

type Data = {
  org: { id: string; name: string } | null;
  github: Github;
};

type InstallStart = { authUrl: string; redirectUrl: string };

export default function ConnectScreen() {
  const theme = useNativeTheme();
  const { data, error, loading, refresh } = useApiResource<Data>(
    mobileApi.connect(),
  );
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [mode, setMode] = useState<"existing" | "create">("existing");
  const [owner, setOwner] = useState("");
  const [name, setName] = useState("");
  const [agentName, setAgentName] = useState("");
  const [layout, setLayout] = useState<"single" | "team">("single");

  useEffect(() => {
    if (data?.github.state === "pick" && data.github.accountLogin && !owner) {
      setOwner(data.github.accountLogin);
    }
  }, [data, owner]);

  if (loading && !data) return <Loading label="Checking GitHub connection…" />;
  if (error && !data) {
    return (
      <Screen>
        <ErrorState message={error} onRetry={refresh} />
      </Screen>
    );
  }

  const github = data!.github;

  const installGithub = async () => {
    if (installing) return;
    setInstalling(true);
    setActionError(null);
    try {
      // createURL registers the native route with Expo's configured `eden` scheme. The server
      // returns its allow-listed equivalent; never send a caller-controlled redirect to it.
      const appRedirectUri = Linking.createURL("connect");
      const start = await postForm<InstallStart>(
        mobileApi.githubInstallStart(),
        { redirectUrl: appRedirectUri },
      );
      if (!start.authUrl || !start.redirectUrl) {
        throw new Error("Eden could not start GitHub authorization.");
      }
      if (start.redirectUrl !== appRedirectUri) {
        throw new Error("Eden returned an unexpected GitHub callback address.");
      }
      const result = await WebBrowser.openAuthSessionAsync(
        start.authUrl,
        start.redirectUrl,
        { preferEphemeralSession: false },
      );
      const outcome = githubInstallAuthOutcome(result, start.redirectUrl);
      if (outcome.status === "cancelled") return;
      if (outcome.status === "error") {
        setActionError(outcome.message);
        return;
      }

      await postForm<{ ok: true }>(mobileApi.githubInstallRedeem(), {
        handoff: outcome.handoff,
      });
      await refresh();
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "Could not connect the GitHub App.",
      );
    } finally {
      setInstalling(false);
    }
  };

  const submit = async (values: Record<string, string>) => {
    setBusy(true);
    setActionError(null);
    try {
      const result = await postForm<MobileMutationResult & { error?: string }>(
        mobileApi.connect(),
        values,
      );
      if (result.error) {
        setActionError(result.error);
        return;
      }
      const match = result.redirectTo?.match(/\/repos\/([^/?]+)/);
      if (match) router.replace(`/(app)/repos/${match[1]}`);
      else router.replace("/(app)/(tabs)");
    } catch (cause) {
      setActionError(
        cause instanceof Error
          ? cause.message
          : "Could not connect repository.",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <Heading
        title="New repository"
        subtitle="Connect an eve repository or create a fresh one on GitHub."
      />
      {actionError ? <ErrorState message={actionError} /> : null}
      {github.state === "no-org" ? (
        <EmptyState
          title="Choose a workspace first"
          message="A repository always belongs to an Eden workspace."
        />
      ) : null}
      {github.state === "unconfigured" ? (
        <ErrorState
          message={`GitHub App is not configured: ${github.message}`}
        />
      ) : null}
      {github.state === "install" ? (
        <Card>
          <Text style={[styles.cardTitle, { color: theme.text }]}>
            Install Eden on GitHub
          </Text>
          <Text style={{ color: theme.muted, lineHeight: 20 }}>
            Choose the GitHub account and repositories Eden can access. You’ll
            return here securely when authorization finishes.
          </Text>
          <Button
            title={installing ? "Connecting GitHub…" : "Continue to GitHub"}
            disabled={installing}
            onPress={installGithub}
          />
        </Card>
      ) : null}
      {github.state === "pick" ? (
        <>
          <View
            accessibilityRole="tablist"
            style={[
              styles.segment,
              { backgroundColor: theme.dark ? "#27272a" : "#e2e8f0" },
            ]}
          >
            {(["existing", "create"] as const).map((value) => (
              <Pressable
                key={value}
                accessibilityRole="tab"
                accessibilityState={{ selected: mode === value }}
                onPress={() => setMode(value)}
                style={[
                  styles.segmentItem,
                  mode === value && { backgroundColor: theme.surface },
                ]}
              >
                <Text style={{ color: theme.text, fontWeight: "600" }}>
                  {value === "existing" ? "Connect existing" : "Create new"}
                </Text>
              </Pressable>
            ))}
          </View>

          {mode === "existing" ? (
            <>
              <SectionTitle>Available repositories</SectionTitle>
              {github.repos.length ? (
                <Card>
                  {github.repos.map((repo) => (
                    <Row
                      key={repo.fullName}
                      title={repo.fullName}
                      detail={`${repo.private ? "Private · " : ""}${repo.defaultBranch}`}
                      meta={busy ? undefined : "Connect"}
                      onPress={() =>
                        submit({
                          installationGrantId: github.installationGrantId,
                          owner: repo.owner,
                          repo: repo.repo,
                          defaultBranch: repo.defaultBranch,
                        })
                      }
                    />
                  ))}
                </Card>
              ) : (
                <EmptyState
                  title="No shared repositories"
                  message="Grant access on GitHub, or create a new eve repository."
                  action={
                    <Button
                      title={
                        installing ? "Opening GitHub…" : "Manage GitHub access"
                      }
                      kind="secondary"
                      disabled={installing}
                      onPress={installGithub}
                    />
                  }
                />
              )}
            </>
          ) : (
            <>
              <SectionTitle>Repository details</SectionTitle>
              <Card>
                <FormField
                  label="Owner"
                  value={owner}
                  onChangeText={setOwner}
                  autoCapitalize="none"
                />
                <FormField
                  label="Repository name"
                  value={name}
                  onChangeText={setName}
                  autoCapitalize="none"
                  placeholder="my-eden-agent"
                />
                <Text style={{ color: theme.text, fontWeight: "600" }}>
                  Layout
                </Text>
                <View style={styles.layoutButtons}>
                  <Button
                    title="Single agent"
                    kind={layout === "single" ? "primary" : "secondary"}
                    onPress={() => setLayout("single")}
                  />
                  <Button
                    title="Team"
                    kind={layout === "team" ? "primary" : "secondary"}
                    onPress={() => setLayout("team")}
                  />
                </View>
                {layout === "single" ? (
                  <FormField
                    label="Agent name"
                    value={agentName}
                    onChangeText={setAgentName}
                    autoCapitalize="none"
                    placeholder="assistant"
                  />
                ) : null}
                <Button
                  title={busy ? "Creating repository…" : "Create on GitHub"}
                  disabled={
                    busy ||
                    !owner ||
                    !name ||
                    (layout === "single" && !agentName)
                  }
                  onPress={() =>
                    submit({
                      intent: "create",
                      installationGrantId: github.installationGrantId,
                      owner,
                      name,
                      layout,
                      agentName,
                    })
                  }
                />
              </Card>
            </>
          )}
          <Button
            title={
              installing ? "Opening GitHub…" : "Add another GitHub account"
            }
            kind="plain"
            disabled={installing}
            onPress={installGithub}
          />
        </>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  cardTitle: { fontSize: 18, fontWeight: "700" },
  segment: { flexDirection: "row", padding: 4, borderRadius: 11 },
  segmentItem: {
    flex: 1,
    minHeight: 40,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 8,
  },
  layoutButtons: { gap: 8 },
});
