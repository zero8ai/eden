/**
 * Prettier (standalone) formatting by file path — used by the code editor's Format button and
 * by Save (format-before-stage). Plugins load lazily so Prettier stays out of the main bundle
 * until someone actually formats. Non-code files (markdown prose, unknown extensions) pass
 * through untouched; formatting throws on syntax errors, so callers should fall back to the
 * unformatted source rather than block a save.
 */

function parserFor(path: string): "typescript" | "babel" | "json" | null {
  if (/\.[cm]?tsx?$/.test(path)) return "typescript";
  if (/\.[cm]?jsx?$/.test(path)) return "babel";
  if (/\.json$/.test(path)) return "json";
  return null;
}

/** True when Format/format-on-save applies to this file. */
export function isFormattable(path: string): boolean {
  return parserFor(path) !== null;
}

/** Format `source` per its file type; returns it unchanged for non-code files. */
export async function formatSource(path: string, source: string): Promise<string> {
  const parser = parserFor(path);
  if (!parser) return source;
  const [prettier, estree, typescript, babel] = await Promise.all([
    import("prettier/standalone"),
    import("prettier/plugins/estree"),
    import("prettier/plugins/typescript"),
    import("prettier/plugins/babel"),
  ]);
  return prettier.format(source, {
    parser,
    plugins: [estree.default, typescript.default, babel.default],
  });
}
