/**
 * Shared test-env resolution: read DATABASE_URL from the shell or .env.local and derive the
 * dedicated `eden_test` database URL. Tests never touch the dev database.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

export function adminDatabaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envFile = readFileSync(path.join(process.cwd(), ".env.local"), "utf8");
  const line = envFile.split("\n").find((l) => l.startsWith("DATABASE_URL="));
  if (!line) throw new Error("DATABASE_URL not found in env or .env.local");
  return line.slice("DATABASE_URL=".length).trim();
}

export const TEST_DB_NAME = "eden_test";

export function testDatabaseUrl(): string {
  const url = new URL(adminDatabaseUrl());
  url.pathname = `/${TEST_DB_NAME}`;
  return url.toString();
}
