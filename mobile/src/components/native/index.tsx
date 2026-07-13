import type { PropsWithChildren, ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  useColorScheme,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

export const colors = {
  blue: "#2563eb",
  blueSoft: "#dbeafe",
  red: "#dc2626",
  green: "#15803d",
};

export function useNativeTheme() {
  const dark = useColorScheme() === "dark";
  return {
    dark,
    background: dark ? "#09090b" : "#f8fafc",
    surface: dark ? "#18181b" : "#ffffff",
    text: dark ? "#fafafa" : "#18181b",
    muted: dark ? "#a1a1aa" : "#64748b",
    border: dark ? "#3f3f46" : "#e2e8f0",
    input: dark ? "#27272a" : "#ffffff",
  };
}

export function Screen({ children, scroll = true }: PropsWithChildren<{ scroll?: boolean }>) {
  const t = useNativeTheme();
  const body = <View style={[styles.body, { backgroundColor: t.background }]}>{children}</View>;
  return (
    <SafeAreaView edges={["bottom"]} style={[styles.safe, { backgroundColor: t.background }]}>
      {scroll ? <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.scroll}>{body}</ScrollView> : body}
    </SafeAreaView>
  );
}

export function Heading({ title, subtitle }: { title: string; subtitle?: string }) {
  const t = useNativeTheme();
  return <View style={styles.heading}><Text accessibilityRole="header" style={[styles.title, { color: t.text }]}>{title}</Text>{subtitle ? <Text style={[styles.subtitle, { color: t.muted }]}>{subtitle}</Text> : null}</View>;
}

export function Card({ children, style }: PropsWithChildren<{ style?: object }>) {
  const t = useNativeTheme();
  return <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }, style]}>{children}</View>;
}

export function SectionTitle({ children }: PropsWithChildren) {
  const t = useNativeTheme();
  return <Text style={[styles.sectionTitle, { color: t.muted }]}>{children}</Text>;
}

export function FormField({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  const t = useNativeTheme();
  return <View style={styles.field}><Text style={[styles.label, { color: t.text }]}>{label}</Text><TextInput accessibilityLabel={props.accessibilityLabel ?? label} placeholderTextColor={t.muted} {...props} style={[styles.input, { backgroundColor: t.input, borderColor: t.border, color: t.text }, props.style]} />{hint ? <Text style={[styles.hint, { color: t.muted }]}>{hint}</Text> : null}</View>;
}

export function Button({ title, onPress, disabled, kind = "primary", accessibilityLabel }: { title: string; onPress: () => void; disabled?: boolean; kind?: "primary" | "secondary" | "danger" | "plain"; accessibilityLabel?: string }) {
  const t = useNativeTheme();
  const backgroundColor = kind === "primary" ? colors.blue : kind === "danger" ? colors.red : kind === "plain" ? "transparent" : t.surface;
  const color = kind === "primary" || kind === "danger" ? "#fff" : kind === "plain" ? colors.blue : t.text;
  return <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? title} disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.button, { backgroundColor, borderColor: kind === "secondary" ? t.border : backgroundColor, opacity: disabled ? .45 : pressed ? .75 : 1 }]}><Text style={[styles.buttonText, { color }]}>{title}</Text></Pressable>;
}

export function Row({ title, detail, meta, onPress, leading }: { title: string; detail?: string; meta?: string; onPress?: () => void; leading?: ReactNode }) {
  const t = useNativeTheme();
  const content = <><View style={styles.rowLead}>{leading}<View style={styles.rowCopy}><Text numberOfLines={1} style={[styles.rowTitle, { color: t.text }]}>{title}</Text>{detail ? <Text numberOfLines={2} style={[styles.rowDetail, { color: t.muted }]}>{detail}</Text> : null}</View></View><View style={styles.rowEnd}>{meta ? <Text style={[styles.meta, { color: t.muted }]}>{meta}</Text> : null}{onPress ? <Text style={[styles.chevron, { color: t.muted }]}>›</Text> : null}</View></>;
  return onPress ? <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.row, { borderBottomColor: t.border, opacity: pressed ? .6 : 1 }]}>{content}</Pressable> : <View style={[styles.row, { borderBottomColor: t.border }]}>{content}</View>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return <Card><Text accessibilityRole="alert" style={styles.error}>{message}</Text>{onRetry ? <Button title="Try again" kind="secondary" onPress={onRetry} /> : null}</Card>;
}

export function EmptyState({ title, message, action }: { title: string; message: string; action?: ReactNode }) {
  const t = useNativeTheme();
  return <Card style={styles.empty}><Text style={[styles.emptyTitle, { color: t.text }]}>{title}</Text><Text style={[styles.emptyMessage, { color: t.muted }]}>{message}</Text>{action}</Card>;
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  const t = useNativeTheme();
  return <View style={styles.loading}><ActivityIndicator color={colors.blue} /><Text style={{ color: t.muted }}>{label}</Text></View>;
}

const styles = StyleSheet.create({
  safe: { flex: 1 }, body: { flex: 1, gap: 16, padding: 16 }, scroll: { flexGrow: 1 }, heading: { gap: 5, marginVertical: 4 }, title: { fontSize: 28, fontWeight: "700", letterSpacing: -.5 }, subtitle: { fontSize: 15, lineHeight: 21 }, card: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: "hidden", padding: 16, gap: 12 }, sectionTitle: { fontSize: 12, fontWeight: "700", letterSpacing: .8, marginLeft: 4, marginTop: 4, textTransform: "uppercase" }, field: { gap: 7 }, label: { fontSize: 14, fontWeight: "600" }, input: { minHeight: 48, borderRadius: 11, borderWidth: 1, fontSize: 16, paddingHorizontal: 13, paddingVertical: 11 }, hint: { fontSize: 12, lineHeight: 17 }, button: { minHeight: 48, borderRadius: 11, borderWidth: 1, justifyContent: "center", paddingHorizontal: 16 }, buttonText: { fontSize: 16, fontWeight: "600", textAlign: "center" }, row: { minHeight: 64, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingVertical: 11, gap: 10 }, rowLead: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10 }, rowCopy: { flex: 1, gap: 3 }, rowTitle: { fontSize: 16, fontWeight: "600" }, rowDetail: { fontSize: 13, lineHeight: 18 }, rowEnd: { flexDirection: "row", alignItems: "center", gap: 6 }, meta: { fontSize: 12 }, chevron: { fontSize: 26, fontWeight: "300" }, error: { color: colors.red, fontSize: 14, lineHeight: 20 }, empty: { alignItems: "center", paddingVertical: 30 }, emptyTitle: { fontSize: 18, fontWeight: "700" }, emptyMessage: { textAlign: "center", lineHeight: 20, marginBottom: 4 }, loading: { flex: 1, minHeight: 160, alignItems: "center", justifyContent: "center", gap: 10 },
});
export const nativeStyles = styles;
