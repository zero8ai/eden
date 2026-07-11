import { describe, expect, test } from "vitest";

import {
  allocatePorts,
  applyEnvOverrides,
  parseDatabaseUrl,
  parseEnvFile,
  withDatabaseName,
  withWorktreeAppendix,
} from "../../scripts/worktree-setup.mjs";

describe("withDatabaseName", () => {
  test("replaces the database name, preserving auth/host/port", () => {
    expect(
      withDatabaseName(
        "postgres://eden:eden@localhost:5442/eden",
        "eden_feature_x",
      ),
    ).toBe("postgres://eden:eden@localhost:5442/eden_feature_x");
  });

  test("accepts postgresql:// scheme", () => {
    expect(withDatabaseName("postgresql://u:p@host:5432/db", "db_wt")).toBe(
      "postgresql://u:p@host:5432/db_wt",
    );
  });

  test("preserves query string", () => {
    expect(
      withDatabaseName("postgres://u:p@host:5432/db?sslmode=disable", "db_wt"),
    ).toBe("postgres://u:p@host:5432/db_wt?sslmode=disable");
  });

  test("rejects non-postgres protocol", () => {
    expect(() => withDatabaseName("mysql://host/db", "db_wt")).toThrow();
  });

  test("rejects unexpected database names", () => {
    expect(() =>
      withDatabaseName("postgres://u:p@host:5432/db", "bad-name"),
    ).toThrow();
  });
});

describe("parseDatabaseUrl", () => {
  test("extracts user, password, and db", () => {
    expect(
      parseDatabaseUrl("postgres://eden:eden@localhost:5442/eden"),
    ).toEqual({
      user: "eden",
      password: "eden",
      db: "eden",
    });
  });

  test("decodes percent-encoded credentials", () => {
    expect(parseDatabaseUrl("postgres://us%40er:p%3Aw@host:5432/db")).toEqual({
      user: "us@er",
      password: "p:w",
      db: "db",
    });
  });

  test("throws when user or db is missing", () => {
    expect(() => parseDatabaseUrl("postgres://host:5432/db")).toThrow();
    expect(() => parseDatabaseUrl("postgres://u:p@host:5432")).toThrow();
  });
});

describe("applyEnvOverrides", () => {
  test("replaces existing keys in place and appends missing ones", () => {
    const original = "# comment\nDATABASE_URL=postgres://a\nFOO=bar\n";
    const out = applyEnvOverrides(original, {
      DATABASE_URL: "postgres://b",
      PORT: "5273",
    });
    expect(out).toBe(
      "# comment\nDATABASE_URL=postgres://b\nFOO=bar\n\nPORT=5273\n",
    );
  });

  test("leaves comments and multi-line quoted values untouched", () => {
    const original =
      'KEY="-----BEGIN X-----\nabc=def\n-----END X-----"\nPORT=1\n';
    const out = applyEnvOverrides(original, { PORT: "2" });
    expect(out).toContain('KEY="-----BEGIN X-----');
    // The PEM continuation line contains '=' but its "key" (abc) isn't an
    // override, so it must pass through unchanged.
    expect(out).toContain("abc=def");
    expect(out).toContain("PORT=2");
    expect(out).not.toContain("PORT=1");
  });

  test("only replaces the first occurrence of a duplicated key", () => {
    const out = applyEnvOverrides("A=1\nA=2\n", { A: "3" });
    expect(out).toBe("A=3\nA=2\n");
  });

  test("output is always newline-terminated", () => {
    expect(applyEnvOverrides("A=1", {}).endsWith("\n")).toBe(true);
    expect(applyEnvOverrides("", { B: "2" }).endsWith("\n")).toBe(true);
  });
});

describe("allocatePorts", () => {
  test("first allocation starts at the base ports", () => {
    expect(allocatePorts({}, "feature-x")).toEqual({
      dev: 5273,
      splitter: 8887,
      instance: 3100,
    });
  });

  test("skips ports used by other entries", () => {
    const registry = {
      "feature-a": { dev: 5273, splitter: 8887, instance: 3100 },
    };
    expect(allocatePorts(registry, "feature-b")).toEqual({
      dev: 5274,
      splitter: 8888,
      instance: 3200,
    });
  });

  test("reuses a complete existing entry", () => {
    const entry = { dev: 5280, splitter: 8894, instance: 3800 };
    expect(allocatePorts({ "feature-a": entry }, "feature-a")).toBe(entry);
  });

  test("preserves enriched fields on an existing entry", () => {
    const entry = {
      dev: 5280,
      splitter: 8894,
      instance: 3800,
      tunnelShortId: "abcdef12",
      tunnelHost: "feature-a-abcdef12.dev.zero8.ai",
    };
    expect(allocatePorts({ "feature-a": entry }, "feature-a")).toBe(entry);
  });
});

describe("parseEnvFile", () => {
  test("parses keys, ignores comments and blanks, strips quotes", () => {
    const parsed = parseEnvFile("# c\n\nA=1\nB=\"two\"\nC='three'\n");
    expect(parsed).toEqual({ A: "1", B: "two", C: "three" });
  });
});

describe("withWorktreeAppendix", () => {
  const marker = "# Worktree: feature/x";
  const appendix = `${marker}\n\ncontext here\n`;

  test("appends after the base content with a blank line", () => {
    expect(withWorktreeAppendix("# Eden\n\nbase\n", marker, appendix)).toBe(
      `# Eden\n\nbase\n\n${appendix}`,
    );
  });

  test("replaces a prior appendix instead of double-appending", () => {
    const once = withWorktreeAppendix("# Eden\n", marker, appendix);
    const twice = withWorktreeAppendix(once, marker, appendix);
    expect(twice).toBe(once);
  });

  test("handles a missing/empty AGENTS.md", () => {
    expect(withWorktreeAppendix("", marker, appendix)).toBe(`\n\n${appendix}`);
  });
});
