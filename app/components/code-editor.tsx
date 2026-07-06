/**
 * Code editor over CodeMirror 6 — syntax highlighting, syntax-error linting (Lezer parse
 * errors in the gutter), and theme-aware colors. Rich-text editors (tiptap et al.) are the
 * wrong tool for source files; CodeMirror is what code editors on the web actually use.
 *
 * Controlled: the route owns `value` (it goes into the staged draft on save). SSR-safe —
 * CodeMirror initializes in an effect, so the server renders an empty shell.
 */
import { json } from "@codemirror/lang-json";
import { javascript } from "@codemirror/lang-javascript";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxTree } from "@codemirror/language";
import { linter, lintGutter, type Diagnostic } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import CodeMirror, { type Extension } from "@uiw/react-codemirror";
import { useSyncExternalStore } from "react";

/** Reactive "is the app in dark mode?" — watches the .dark class the theme toggle sets. */
function subscribeToDark(cb: () => void) {
  const observer = new MutationObserver(cb);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}
function useIsDark(): boolean {
  return useSyncExternalStore(
    subscribeToDark,
    () => document.documentElement.classList.contains("dark"),
    () => false,
  );
}

/** Surface Lezer parse errors as lint diagnostics — catches broken syntax before save. */
const syntaxErrors = linter((view) => {
  const diagnostics: Diagnostic[] = [];
  syntaxTree(view.state)
    .cursor()
    .iterate((node) => {
      if (!node.type.isError) return;
      diagnostics.push({
        from: node.from,
        to: node.to === node.from ? Math.min(node.to + 1, view.state.doc.length) : node.to,
        severity: "error",
        message: "Syntax error",
      });
    });
  return diagnostics;
});

function extensionsFor(path: string, readOnly: boolean): Extension[] {
  // Read-only previews (e.g. the marketplace detail page) want highlighting but not the
  // syntax-error lint gutter — a catalog file isn't something the viewer can fix.
  const lang = (() => {
    if (/\.[cm]?[jt]sx?$/.test(path)) {
      return javascript({ typescript: /tsx?$/.test(path), jsx: /sx$/.test(path) });
    }
    if (/\.json$/.test(path)) return json();
    if (/\.(md|markdown)$/.test(path)) return markdown();
    return null;
  })();
  const lint = lang && !readOnly && !/\.(md|markdown)$/.test(path) ? [syntaxErrors, lintGutter()] : [];
  return [...(lang ? [lang] : []), EditorView.lineWrapping, ...lint];
}

export function CodeEditor({
  path,
  value,
  onChange,
  readOnly = false,
}: {
  /** Repo-relative path — picks the language mode. */
  path: string;
  value: string;
  /** Omit (with `readOnly`) for a static, highlighted preview. */
  onChange?: (next: string) => void;
  /** Render a non-editable, highlighted view — no lint gutter, no forced min height. */
  readOnly?: boolean;
}) {
  const isDark = useIsDark();
  return (
    <div className="max-w-full overflow-hidden rounded-lg border text-sm">
      <CodeMirror
        value={value}
        onChange={onChange}
        editable={!readOnly}
        readOnly={readOnly}
        theme={isDark ? "dark" : "light"}
        extensions={extensionsFor(path, readOnly)}
        minHeight={readOnly ? undefined : "28rem"}
        maxHeight={readOnly ? "24rem" : undefined}
        basicSetup={{
          foldGutter: !readOnly,
          highlightActiveLine: !readOnly,
          lineNumbers: true,
        }}
      />
    </div>
  );
}
